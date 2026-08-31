/**
 * Evidence Lock — batch 4: terminal ack and finalization ordering.
 *
 * Pins T58, T66, T67, T68 of
 * `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md`: grouped idempotent terminal
 * acks, applied-only ack input, crash-injection at every finalization
 * boundary, and disposition-gated high-water advance. Everything runs on real
 * storage-domain write chains through the in-test reference implementations.
 * @module evidence-lock/finalization
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'
import { ManagedStore, managedRecordSchema, reservationSchema } from './managed-protocol.ts'
import type { ManagedRecord, ReservationRecord } from './managed-protocol.ts'
import {
  MemoryOps, ReviewCursor, ReviewLedger, TERMINAL_RING_CAPACITY, canonicalJson, finalizeTerminal,
  recoverTerminal, runSaga, sha256,
} from './review-protocol.ts'
import type { AckGroup, AttemptRecord, PlanOp, SagaDeps, ViewEvent } from './review-protocol.ts'

const cursorSchema = z.object({
  reviewedThroughSeq: z.number().int(),
  desiredThroughSeq: z.number().int(),
  lastAttemptNo: z.number().int(),
  inFlight: z.discriminatedUnion('occupied', [
    z.object({ occupied: z.literal(false) }),
    z.object({
      occupied: z.literal(true),
      attemptId: z.string(),
      attemptNo: z.number().int(),
      rangeId: z.string(),
      phase: z.enum(['planning', 'planned', 'committing', 'resumable']),
    }),
  ]),
})
const attemptSchema = z.object({
  attemptId: z.string(),
  attemptNo: z.number().int(),
  rangeId: z.string(),
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
  phase: z.enum(['planning', 'planned', 'committing', 'terminal']),
  plan: z.unknown().optional(),
  baseStateDigest: z.string().optional(),
  effectiveThrough: z.number().int().optional(),
  opStates: z.array(z.object({
    opId: z.string(),
    resource: z.enum(['memory', 'skill']),
    resourceRef: z.string(),
    state: z.enum(['prepared', 'applied', 'duplicate', 'failed']),
  })),
  terminalStatus: z.string().optional(),
  rangeDisposition: z.enum(['consumed', 'superseded', 'retryable', 'manual']).optional(),
  finalized: z.boolean(),
  failureCode: z.string().optional(),
  recordedProposals: z.array(z.unknown()),
})
const memoryScopeSchema = z.object({
  scope: z.string(),
  entries: z.array(z.object({ id: z.string(), text: z.string() })),
  pendingReceipts: z.array(z.object({ opId: z.string() })),
  terminalRing: z.array(z.object({ opId: z.string() })),
})

const roots: string[] = []
const harnesses: FinalizationHarness[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const harness of harnesses) {
    await harness.reviewDomain.close()
    await harness.backend.close()
  }
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

/** Counting ack spies over the real reference stores. */
interface AckSpies {
  readonly memoryGroups: AckGroup[]
  readonly skillRefs: { skillId: string; opIds: string[] }[]
}

interface FinalizationHarness {
  readonly cursor: ReviewCursor
  readonly ledger: ReviewLedger
  readonly memory: MemoryOps
  readonly store: ManagedStore
  readonly reviewDomain: Awaited<ReturnType<DomainFacility['open']>>
  readonly backend: JsonStorageBackend
  readonly spies: AckSpies
  readonly deps: SagaDeps
}

async function freshHarness(sessionId: string): Promise<FinalizationHarness> {
  const bundleRoot = await tempRoot('dsh-evlock-final-bundles-')
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(LocalFileSystem, { cwd: bundleRoot })
  const backend = new JsonStorageBackend(await tempRoot('dsh-evlock-final-store-'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const reviewDomain = await facility.open(defineDomain({
    name: 'evlock_review',
    version: 1,
    tables: {
      cursors: domainTable<string, z.infer<typeof cursorSchema>>(cursorSchema),
      attempts: domainTable<string, AttemptRecord>(attemptSchema),
    },
  }))
  const memoryDomain = await facility.open(defineDomain({
    name: 'evlock_memory',
    version: 1,
    tables: { scopes: domainTable<string, z.infer<typeof memoryScopeSchema>>(memoryScopeSchema) },
  }))
  const managedDomain = await facility.open(defineDomain({
    name: 'evlock_managed',
    version: 1,
    tables: {
      name_index: domainTable<string, ReservationRecord>(reservationSchema),
      records: domainTable<string, ManagedRecord>(managedRecordSchema),
    },
  }))
  const cursor = new ReviewCursor(reviewDomain.table('cursors'), { sessionId, policyVersion: 'p1', learningViewVersion: 'lv1' })
  const ledger = new ReviewLedger(reviewDomain.table('attempts'))
  const memory = new MemoryOps(memoryDomain.table('scopes'))
  const store = new ManagedStore(managedDomain.table('name_index'), managedDomain.table('records'), ctx.fs, bundleRoot)
  const spies: AckSpies = { memoryGroups: [], skillRefs: [] }
  const harness: FinalizationHarness = {
    cursor,
    ledger,
    memory,
    store,
    reviewDomain,
    backend,
    spies,
    deps: {
      cursor,
      ledger,
      memory: {
        applyOps: (scope, ops) => memory.applyOps(scope, ops),
        acknowledgeTerminalOps: async (groups) => {
          spies.memoryGroups.push(...groups)
          await memory.acknowledgeTerminalOps(groups)
        },
      },
      skills: {
        create: request => store.createSkill(request),
        patch: request => store.patchSkill(request),
        acknowledgeTerminalOps: async (skillId, opIds) => {
          spies.skillRefs.push({ skillId, opIds: [...opIds] })
          await store.acknowledgeTerminalOps(skillId, opIds)
        },
      },
    },
  }
  harnesses.push(harness)
  return harness
}

const EVENTS: ViewEvent[] = [{ seq: 1, type: 'user/message', text: 'e'.repeat(80) }]

async function drive(harness: FinalizationHarness, plan: readonly PlanOp[]): Promise<Extract<Awaited<ReturnType<ReviewCursor['claim']>>, { kind: 'acquired' }>> {
  const claim = await harness.cursor.claim(5, 10)
  if (claim.kind !== 'acquired') throw new Error('expected the claim to acquire')
  await runSaga(harness.deps, {
    attemptId: claim.attemptId,
    attemptNo: claim.attemptNo,
    rangeId: claim.rangeId,
    fromSeq: claim.fromSeq,
    toSeq: 10,
    budgetTokens: 10_000,
    enabledScopes: ['project'],
    events: EVENTS,
  }, {
    buildPlan: () => plan,
    baseStateDigest: () => sha256(canonicalJson({ records: harness.store.allRecords() })),
  })
  return claim
}

const memoryOp = (text: string): PlanOp => ({ kind: 'memory', scope: 'project', text })
const skillOp = (body: string): PlanOp => ({
  kind: 'skill-create', projectKey: 'pk', name: 'finalized-skill', body, catalogSummary: 'made at finalize',
})

describe('T58 memory-terminal-ack-scoped-and-idempotent', () => {
  it('moves receipts per scope group, replays idempotently, rejects malformed groups, and bounds the ring', async () => {
    const bundleRoot = await tempRoot('dsh-evlock-t58-')
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(bundleRoot)
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
    const memoryDomain = await facility.open(defineDomain({
      name: 'evlock_memory',
      version: 1,
      tables: { scopes: domainTable<string, z.infer<typeof memoryScopeSchema>>(memoryScopeSchema) },
    }))
    const memory = new MemoryOps(memoryDomain.table('scopes'))

    await memory.applyOps('project', [{ opId: 'op-p1', text: 'p1' }, { opId: 'op-p2', text: 'p2' }])
    await memory.applyOps('user', [{ opId: 'op-u1', text: 'u1' }])

    // Scoped groups land in their own scope records and do not crosstalk.
    await memory.acknowledgeTerminalOps([{ scope: 'project', opIds: ['op-p1'] }, { scope: 'user', opIds: ['op-u1'] }])
    expect(memory.read('project')?.pendingReceipts.map(receipt => receipt.opId)).toEqual(['op-p2'])
    expect(memory.read('project')?.terminalRing.map(receipt => receipt.opId)).toEqual(['op-p1'])
    expect(memory.read('user')?.pendingReceipts).toHaveLength(0)
    expect(memory.read('user')?.terminalRing.map(receipt => receipt.opId)).toEqual(['op-u1'])

    // A crash replay of the same ack is an idempotent success.
    await memory.acknowledgeTerminalOps([{ scope: 'project', opIds: ['op-p1'] }, { scope: 'user', opIds: ['op-u1'] }])
    expect(memory.read('project')?.terminalRing).toHaveLength(1)
    expect(memory.read('user')?.terminalRing).toHaveLength(1)

    // Entries without an opId, unknown scopes, and unknown receipts all fail loud.
    await expect(memory.acknowledgeTerminalOps([{ scope: 'project', opIds: [''] }]))
      .rejects.toThrow(/invalid_structure/)
    await expect(memory.acknowledgeTerminalOps([{ scope: 'no-such-scope', opIds: ['op-x'] }]))
      .rejects.toThrow(/invalid_structure/)
    await expect(memory.acknowledgeTerminalOps([{ scope: 'project', opIds: ['op-never-applied'] }]))
      .rejects.toThrow(/invalid_structure/)

    // The terminal ring is bounded: oldest receipts fall off after capacity.
    await memory.applyOps('project', Array.from({ length: 5 }, (_, i) => ({ opId: `op-fill-${i}`, text: `t${i}` })))
    await memory.acknowledgeTerminalOps([{
      scope: 'project',
      opIds: ['op-p2', 'op-fill-0', 'op-fill-1', 'op-fill-2', 'op-fill-3', 'op-fill-4'],
    }])
    const ring = memory.read('project')?.terminalRing.map(receipt => receipt.opId)
    expect(ring).toHaveLength(TERMINAL_RING_CAPACITY)
    expect(ring?.at(-1)).toBe('op-fill-4')
    expect(ring).not.toContain('op-p1')
    await backend.close()
  })
})

describe('T66 terminal-ack-only-applied-opstates', () => {
  it('acks only applied and duplicate receipts, skips never-executed ops, and skips ack entirely for zero-mutation terminals', async () => {
    // Partial saga: M1 applied, M2 never executed. Finalization acks M1
    // only and does NOT misreport invalid_structure over the missing M2.
    {
      const harness = await freshHarness('evlock-t66-partial')
      const claim = await harness.cursor.claim(5, 10)
      if (claim.kind !== 'acquired') throw new Error('expected acquired')
      const m1 = 'mem-op-1'
      await harness.ledger.startPlanning({
        attemptId: claim.attemptId,
        attemptNo: claim.attemptNo,
        rangeId: claim.rangeId,
        fromSeq: claim.fromSeq,
        toSeq: 10,
      })
      await harness.ledger.recordEffectiveThrough(claim.attemptId, 1)
      await harness.ledger.recordPlan(claim.attemptId, [memoryOp('one'), memoryOp('two')])
      const outcomes = await harness.memory.applyOps('project', [{ opId: m1, text: 'one' }])
      expect(outcomes[0]?.state).toBe('applied')
      await harness.ledger.markOpState(claim.attemptId, { opId: m1, resource: 'memory', resourceRef: 'project', state: 'applied' })
      await harness.ledger.markTerminal(claim.attemptId, 'committed', 'consumed')
      await finalizeTerminal(harness.deps, claim.attemptId)
      expect(harness.spies.memoryGroups).toEqual([{ scope: 'project', opIds: [m1] }])
      expect(harness.spies.skillRefs).toHaveLength(0)
    }
    // Zero-mutation terminal (admission rejected): no ack call at all.
    {
      const harness = await freshHarness('evlock-t66-zero')
      const rejected: PlanOp = { kind: 'user-proposal', target: 'user', text: 'nope' }
      await drive(harness, [rejected])
      expect(harness.spies.memoryGroups).toHaveLength(0)
      expect(harness.spies.skillRefs).toHaveLength(0)
      const attempt = harness.ledger.unfinalizedTerminal()
      expect(attempt).toHaveLength(0)
    }
    // Applied skill receipts group by ref and ack through the same rule.
    {
      const harness = await freshHarness('evlock-t66-skill')
      const claim = await drive(harness, [skillOp('skill body')])
      const attempt = harness.ledger.get(claim.attemptId)
      const skillState = attempt?.opStates.find(state => state.resource === 'skill')
      if (skillState === undefined || skillState.state !== 'applied') throw new Error('expected an applied skill opState')
      expect(harness.spies.skillRefs).toEqual([{ skillId: skillState.resourceRef, opIds: [skillState.opId] }])
      expect(harness.spies.memoryGroups).toHaveLength(0)
      const record = harness.store.record(skillState.resourceRef)
      expect(record?.receipts).toHaveLength(0)
      expect(record?.terminalRing.map(receipt => receipt.opId)).toEqual([skillState.opId])
    }
  })
})

describe('T67 terminal-finalization-is-idempotent', () => {
  it('converges from a crash injected at every finalization boundary and never replays a finalized attempt', async () => {
    for (const crashAfter of ['after-terminal', 'after-ack', 'after-advance', undefined] as const) {
      const harness = await freshHarness(`evlock-t67-${crashAfter ?? 'none'}`)
      const claim = await harness.cursor.claim(5, 10)
      if (claim.kind !== 'acquired') throw new Error('expected acquired')
      const run = runSaga(harness.deps, {
        attemptId: claim.attemptId,
        attemptNo: claim.attemptNo,
        rangeId: claim.rangeId,
        fromSeq: claim.fromSeq,
        toSeq: 10,
        budgetTokens: 10_000,
        enabledScopes: ['project'],
        events: EVENTS,
      }, {
        buildPlan: () => [memoryOp('fact'), skillOp('skill body')],
        baseStateDigest: () => sha256(canonicalJson({})),
        ...(crashAfter === undefined ? {} : { crashAfter }),
      })
      if (crashAfter !== undefined) {
        await expect(run).rejects.toThrow(/crash-injected/)
      } else {
        await run
      }

      // Recovery replays the un-finalized terminal attempt once (the
      // no-crash run already finalized inline) and converges.
      expect(await recoverTerminal(harness.deps)).toBe(crashAfter === undefined ? 0 : 1)
      const attempt = harness.ledger.get(claim.attemptId)
      expect(attempt?.finalized).toBe(true)
      expect(harness.cursor.read(`evlock-t67-${crashAfter ?? 'none'}`)?.reviewedThroughSeq).toBe(attempt?.effectiveThrough)
      expect(harness.memory.read('project')?.entries).toHaveLength(1)
      expect(harness.memory.read('project')?.pendingReceipts).toHaveLength(0)
      const record = harness.store.allRecords()[0]
      expect(record?.receipts).toHaveLength(0)
      expect(record?.terminalRing).toHaveLength(1)

      // A second recovery pass finds nothing left, and advance is monotonic.
      expect(await recoverTerminal(harness.deps)).toBe(0)
      await harness.cursor.advance(0)
      expect(harness.cursor.read(`evlock-t67-${crashAfter ?? 'none'}`)?.reviewedThroughSeq).toBe(attempt?.effectiveThrough)
    }
  })
})

describe('T68 terminal-status-does-not-imply-range-consumption', () => {
  it('advances the high-water only for consumed ranges and re-claims superseded, retryable, and manual ones', async () => {
    // committed → consumed: the high-water advances by the persisted value.
    {
      const harness = await freshHarness('evlock-t68-consumed')
      const claim = await drive(harness, [memoryOp('kept fact')])
      const attempt = harness.ledger.get(claim.attemptId)
      expect(attempt?.rangeDisposition).toBe('consumed')
      expect(harness.cursor.read('evlock-t68-consumed')?.reviewedThroughSeq).toBe(attempt?.effectiveThrough)
      expect(harness.cursor.read('evlock-t68-consumed')?.inFlight.occupied).toBe(false)
      // Only a range at or below the new high-water is nothing-due.
      expect(await harness.cursor.claim(1, 10)).toEqual({ kind: 'nothing-due' })
    }
    // budget → superseded: no advance, slot released, range re-claimable.
    {
      const harness = await freshHarness('evlock-t68-superseded')
      const claim = await harness.cursor.claim(5, 10)
      if (claim.kind !== 'acquired') throw new Error('expected acquired')
      await runSaga(harness.deps, {
        attemptId: claim.attemptId,
        attemptNo: claim.attemptNo,
        rangeId: claim.rangeId,
        fromSeq: claim.fromSeq,
        toSeq: 10,
        budgetTokens: 1,
        enabledScopes: ['project'],
        events: EVENTS,
      }, {
        buildPlan: () => [memoryOp('never fits')],
        baseStateDigest: () => 'base',
      })
      expect(harness.ledger.get(claim.attemptId)?.rangeDisposition).toBe('superseded')
      expect(harness.cursor.read('evlock-t68-superseded')?.reviewedThroughSeq).toBe(0)
      expect(harness.cursor.read('evlock-t68-superseded')?.inFlight.occupied).toBe(false)
      const reclaim = await harness.cursor.claim(5, 10)
      expect(reclaim.kind === 'acquired' && reclaim.fromSeq).toBe(claim.fromSeq)
    }
    // rejection → retryable: same no-advance, re-claim semantics.
    {
      const harness = await freshHarness('evlock-t68-retryable')
      const claim = await drive(harness, [{ kind: 'user-proposal', target: 'user', text: 'nope' }])
      const attempt = harness.ledger.get(claim.attemptId)
      expect(attempt?.rangeDisposition).toBe('retryable')
      expect(harness.cursor.read('evlock-t68-retryable')?.reviewedThroughSeq).toBe(0)
      const reclaim = await harness.cursor.claim(5, 10)
      expect(reclaim.kind === 'acquired' && reclaim.attemptNo).toBe(claim.attemptNo + 1)
    }
    // manual (L2 reserved): terminal finalization neither advances nor acks.
    {
      const harness = await freshHarness('evlock-t68-manual')
      const claim = await harness.cursor.claim(5, 10)
      if (claim.kind !== 'acquired') throw new Error('expected acquired')
      await harness.ledger.startPlanning({
        attemptId: claim.attemptId,
        attemptNo: claim.attemptNo,
        rangeId: claim.rangeId,
        fromSeq: claim.fromSeq,
        toSeq: 10,
      })
      await harness.ledger.recordEffectiveThrough(claim.attemptId, 2)
      await harness.ledger.recordPlan(claim.attemptId, [memoryOp('manual case')])
      await harness.ledger.markTerminal(claim.attemptId, 'manual-override', 'manual')
      await finalizeTerminal(harness.deps, claim.attemptId)
      expect(harness.ledger.get(claim.attemptId)?.finalized).toBe(true)
      expect(harness.spies.memoryGroups).toHaveLength(0)
      expect(harness.cursor.read('evlock-t68-manual')?.reviewedThroughSeq).toBe(0)
      expect(harness.cursor.read('evlock-t68-manual')?.inFlight.occupied).toBe(false)
      expect((await harness.cursor.claim(5, 10)).kind).toBe('acquired')
    }
  })
})
