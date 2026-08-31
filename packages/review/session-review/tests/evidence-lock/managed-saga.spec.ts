/**
 * Evidence Lock — batch 4: managed-skill saga protocol.
 *
 * Pins T51, T53, T55, T56, T57, T64, T65 of
 * `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md`. The reference saga runs the
 * real write chains: storage-domain CAS for records and receipts, the real
 * `ctx.fs` completion-marker protocol for bundles, and the reference cursor /
 * ledger / memory stores. Reference implementations only — never production
 * code.
 * @module evidence-lock/managed-saga
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
import { ManagedStore, deriveSkillId, managedRecordSchema, reservationSchema, revisionIdFor } from './managed-protocol.ts'
import type { ManagedRecord, ReservationRecord } from './managed-protocol.ts'
import {
  MemoryOps, ReviewCursor, ReviewLedger, admitPlan, canonicalJson, consolidatePlan, estimateTokens,
  recoverTerminal, runSaga, sha256,
} from './review-protocol.ts'
import type { AttemptRecord, PlanOp, SagaDeps, SagaResult, ViewEvent } from './review-protocol.ts'

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

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

interface SagaHarness {
  readonly ctx: Context
  readonly cursor: ReviewCursor
  readonly ledger: ReviewLedger
  readonly memory: MemoryOps
  readonly store: ManagedStore
  readonly recordsDomain: Awaited<ReturnType<DomainFacility['open']>>
  readonly backend: JsonStorageBackend
  readonly bundleRoot: string
  readonly deps: SagaDeps
}

async function sagaHarness(sessionId: string): Promise<SagaHarness> {
  const bundleRoot = await tempRoot('dsh-evlock-saga-bundles-')
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(LocalFileSystem, { cwd: bundleRoot })
  const backend = new JsonStorageBackend(await tempRoot('dsh-evlock-saga-store-'))
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
  const cursor = new ReviewCursor(reviewDomain.table('cursors'), {
    sessionId,
    policyVersion: 'p1',
    learningViewVersion: 'lv1',
  })
  const ledger = new ReviewLedger(reviewDomain.table('attempts'))
  const memory = new MemoryOps(memoryDomain.table('scopes'))
  const store = new ManagedStore(managedDomain.table('name_index'), managedDomain.table('records'), ctx.fs, bundleRoot)
  return {
    ctx,
    cursor,
    ledger,
    memory,
    store,
    recordsDomain: reviewDomain,
    backend,
    bundleRoot,
    deps: {
      cursor,
      ledger,
      memory,
      skills: {
        create: request => store.createSkill(request),
        patch: request => store.patchSkill(request),
        acknowledgeTerminalOps: (skillId, opIds) => store.acknowledgeTerminalOps(skillId, opIds),
      },
    },
  }
}

const harnesses: SagaHarness[] = []

async function freshHarness(sessionId: string): Promise<SagaHarness> {
  const harness = await sagaHarness(sessionId)
  harnesses.push(harness)
  return harness
}

afterAll(async () => {
  for (const harness of harnesses) {
    await harness.recordsDomain.close()
    await harness.backend.close()
  }
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

const EVENTS: ViewEvent[] = [
  { seq: 1, type: 'user/message', text: 'evidence'.repeat(20) },
  { seq: 2, type: 'assistant/message', text: 'response'.repeat(20) },
]

/** Drive one claim + saga run with a fixed plan. */
async function drive(
  harness: SagaHarness,
  plan: readonly PlanOp[],
  budgetTokens: number,
): Promise<{ claim: Extract<Awaited<ReturnType<ReviewCursor['claim']>>, { kind: 'acquired' }>; result: SagaResult }> {
  const claim = await harness.cursor.claim(EVENTS.at(-1)?.seq ?? 0, 10)
  if (claim.kind !== 'acquired') throw new Error('expected the claim to acquire')
  const result = await runSaga(harness.deps, {
    attemptId: claim.attemptId,
    attemptNo: claim.attemptNo,
    rangeId: claim.rangeId,
    fromSeq: claim.fromSeq,
    toSeq: 10,
    budgetTokens,
    enabledScopes: ['project'],
    events: EVENTS,
  }, {
    buildPlan: () => plan,
    baseStateDigest: () => sha256(canonicalJson({
      memories: harness.memory.read('project'),
      records: harness.store.allRecords(),
    })),
  })
  return { claim, result }
}

describe('T51 consolidation-failure-keeps-whole-attempt-zero-commit', () => {
  it('commits nothing from a budget-failed attempt, re-admits a new whole attempt, and never half-commits skill ops', async () => {
    const harness = await freshHarness('evlock-t51')
    const memoryOp: PlanOp = { kind: 'memory', scope: 'project', text: 'm'.repeat(800) }
    const skillOp: PlanOp = {
      kind: 'skill-create', projectKey: 'pk', name: 'consolidated', body: 'b'.repeat(400), catalogSummary: 'made by review',
    }
    const planCost = estimateTokens(canonicalJson(memoryOp)) + estimateTokens(canonicalJson(skillOp))

    // Leg A: the budget rejects the whole plan; consolidation builds a NEW
    // whole attempt that re-admits and commits only what fits.
    const budgetA = planCost - 1
    const first = await drive(harness, [skillOp, memoryOp], budgetA)
    expect(first.result.status).toBe('budget')
    expect(first.result.disposition).toBe('superseded')
    expect(admitPlan([skillOp, memoryOp], { budgetTokens: budgetA, enabledScopes: ['project'] }).kind).toBe('rejected')
    // Zero commit from the failed attempt.
    expect(harness.memory.read('project')?.entries ?? []).toHaveLength(0)
    expect(harness.store.allRecords()).toHaveLength(0)

    const consolidated = consolidatePlan([skillOp, memoryOp], budgetA)
    expect(consolidated).toEqual([skillOp])
    const second = await drive(harness, consolidated, budgetA)
    expect(second.result.status).toBe('committed')
    expect(harness.store.record(deriveSkillId('pk', 'consolidated'))?.status).toBe('draft')
    // The dropped memory op was not committed "incidentally" either.
    expect(harness.memory.read('project')?.entries ?? []).toHaveLength(0)
    expect(harness.ledger.attemptsOfRange(first.claim.rangeId)).toHaveLength(2)

    // Leg B: consolidation still over budget → terminal, and STILL zero
    // commit — the skill op is never carried through a failed attempt. A
    // fresh session isolates the leg from leg A's high-water advance.
    const legB = await freshHarness('evlock-t51-b')
    const budgetB = estimateTokens(canonicalJson(skillOp)) - 1
    const third = await drive(legB, [skillOp, memoryOp], budgetB)
    expect(third.result.status).toBe('budget')
    const stillTooBig: PlanOp = { kind: 'memory', scope: 'project', text: 'm'.repeat(800) }
    expect(admitPlan([stillTooBig], { budgetTokens: budgetB, enabledScopes: ['project'] }).kind).toBe('rejected')
    const fourth = await drive(legB, [stillTooBig], budgetB)
    expect(fourth.result.status).toBe('budget')
    expect(legB.store.allRecords()).toHaveLength(0)
    expect(legB.memory.read('project')?.entries ?? []).toHaveLength(0)
  })
})

describe('T53 user-target-backstop-l1', () => {
  it('records the user-target proposal, commits nothing, and fails loud with target_scope_disabled', async () => {
    const harness = await freshHarness('evlock-t53')
    const proposal: PlanOp = { kind: 'user-proposal', target: 'user', text: 'rewrite the user profile' }
    const projectOp: PlanOp = { kind: 'memory', scope: 'project', text: 'innocent project fact' }

    const { claim, result } = await drive(harness, [projectOp, proposal], 10_000)
    expect(result.status).toBe('rejected')
    expect(result.disposition).toBe('retryable')
    expect(admitPlan([projectOp, proposal], { budgetTokens: 10_000, enabledScopes: ['project'] }))
      .toMatchObject({ kind: 'rejected', code: 'target_scope_disabled' })

    // The proposal is retained in the ledger — never silently dropped — and
    // the ENTIRE plan committed nothing, including the project-scope op.
    const attempt = harness.ledger.get(claim.attemptId)
    expect(attempt?.failureCode).toBe('target_scope_disabled')
    expect(attempt?.recordedProposals).toEqual([proposal])
    expect(attempt?.finalized).toBe(true)
    expect(harness.memory.read('project')?.entries ?? []).toHaveLength(0)
    expect(harness.store.allRecords()).toHaveLength(0)
    // Retryable terminal finalization releases the slot without advancing
    // the high-water, and recovery has nothing further to replay.
    expect(await recoverTerminal(harness.deps)).toBe(0)
    const cursorRecord = harness.cursor.read('evlock-t53')
    expect(cursorRecord?.reviewedThroughSeq).toBe(0)
    expect(cursorRecord?.inFlight.occupied).toBe(false)
  })
})

describe('T55 op-derived-revision-path-exclusive', () => {
  it('gives concurrent patches disjoint revision directories, lets the record CAS pick one winner, and orphans the loser', async () => {
    const harness = await freshHarness('evlock-t55')
    const { store } = harness
    const skillId = deriveSkillId('pk', 'contested-patch')
    const created = await store.createSkill({
      opId: 'op-seed', projectKey: 'pk', name: 'contested-patch', body: 'base body', catalogSummary: 'base',
    })
    expect(created).toEqual({ state: 'applied', ref: skillId })
    await store.transition(skillId, 'active')
    const baseRevision = store.record(skillId)?.currentRevision?.revisionId
    if (baseRevision === undefined) throw new Error('expected the base revision')

    // Two ops patch the same base concurrently; their revision directories
    // derive exclusively from (skillId, requestedByOpId).
    const [left, right] = await Promise.all([
      store.patchSkill({ opId: 'op-left', projectKey: 'pk', name: 'contested-patch', body: 'left body', catalogSummary: 'left summary', expectRevisionId: baseRevision }),
      store.patchSkill({ opId: 'op-right', projectKey: 'pk', name: 'contested-patch', body: 'right body', catalogSummary: 'right summary', expectRevisionId: baseRevision }),
    ])
    const applied = [left, right].find(outcome => outcome.state === 'applied')
    const conflicted = [left, right].find(outcome => outcome.state === 'failed')
    if (applied?.state !== 'applied' || conflicted?.state !== 'failed' || conflicted.code !== 'pending_pending_conflict') {
      throw new Error('expected exactly one CAS winner')
    }
    const winnerOp = left.state === 'applied' ? 'op-left' : 'op-right'
    const loserOp = winnerOp === 'op-left' ? 'op-right' : 'op-left'
    const winnerBody = winnerOp === 'op-left' ? 'left body' : 'right body'
    const loserBody = loserOp === 'op-left' ? 'left body' : 'right body'

    // The record carries only the winner; the loser's revision is an orphan.
    const pending = store.record(skillId)?.pendingRevision
    expect(pending?.revisionId).toBe(revisionIdFor(skillId, winnerOp))
    expect(pending?.createdByOpId).toBe(winnerOp)

    // No interleaved files: each directory holds exactly its own op's body.
    const winnerState = await store.revisionState(skillId, revisionIdFor(skillId, winnerOp))
    expect(winnerState).toMatchObject({ complete: true, body: winnerBody })
    const loserState = await store.revisionState(skillId, revisionIdFor(skillId, loserOp))
    expect(loserState).toMatchObject({ complete: true, body: loserBody })
    expect(revisionIdFor(skillId, 'op-left')).not.toBe(revisionIdFor(skillId, 'op-right'))
  })
})

describe('T56 partial-bundle-crash-retry-completes', () => {
  it('repairs a body-without-marker crash by rewriting the same op, and fails loud on a mismatched marker', async () => {
    const harness = await freshHarness('evlock-t56')
    const { store, ctx } = harness
    const skillId = deriveSkillId('pk', 'crash-repair')
    const revisionId = revisionIdFor(skillId, 'op-crash')
    const body = 'the verbatim bundle body'

    // Crash after the body write, before the completion marker.
    await ctx.fs.writeText(await ctx.fs.resolve(join(harness.bundleRoot, skillId, revisionId, 'SKILL.md')), body)
    await expect(store.revisionState(skillId, revisionId)).resolves.toMatchObject({ complete: false })

    // Retry of the SAME op rewrites the body verbatim and completes.
    expect(await store.writeRevision(skillId, revisionId, body)).toBe(sha256(body))
    await expect(store.revisionState(skillId, revisionId)).resolves.toMatchObject({ complete: true, body })

    // A marker whose digest does not match the body is foreign content:
    // fail loud instead of silently trusting either.
    await ctx.fs.writeText(await ctx.fs.resolve(join(harness.bundleRoot, skillId, revisionId, 'complete')), sha256('something else'))
    await expect(store.revisionState(skillId, revisionId)).rejects.toThrow(/invalid_structure/)

    // A marker without a body is equally invalid.
    const orphanRevision = revisionIdFor(skillId, 'op-orphan')
    await ctx.fs.writeText(await ctx.fs.resolve(join(harness.bundleRoot, skillId, orphanRevision, 'complete')), sha256(body))
    await expect(store.revisionState(skillId, orphanRevision)).rejects.toThrow(/invalid_structure/)
  })
})

describe('T57 skill-op-retry-duplicate-before-stale', () => {
  it('resolves a crash replay through the receipt set before any stale-base check', async () => {
    const harness = await freshHarness('evlock-t57')
    const { store } = harness
    const skillId = deriveSkillId('pk', 'receipt-first')
    const created = await store.createSkill({
      opId: 'op-1', projectKey: 'pk', name: 'receipt-first', body: 'body one', catalogSummary: 'one',
    })
    expect(created).toEqual({ state: 'applied', ref: skillId })
    const baseRevision = store.record(skillId)?.currentRevision?.revisionId
    if (baseRevision === undefined) throw new Error('expected the first revision')

    // A later op moves the base forward.
    const patched = await store.patchSkill({
      opId: 'op-2', projectKey: 'pk', name: 'receipt-first', body: 'body two', catalogSummary: 'two', expectRevisionId: baseRevision,
    })
    expect(patched).toEqual({ state: 'applied', ref: skillId })
    await store.approvePending(skillId)

    // Replay op-1 (bundle+CAS long since succeeded, ledger mark lost in the
    // crash): the receipt set answers DUPLICATE — never name_conflict and
    // never stale_base_revision, even though the base has moved.
    await expect(store.createSkill({
      opId: 'op-1', projectKey: 'pk', name: 'receipt-first', body: 'body one', catalogSummary: 'one',
    })).resolves.toEqual({ state: 'duplicate', ref: skillId })
    await expect(store.patchSkill({
      opId: 'op-2', projectKey: 'pk', name: 'receipt-first', body: 'body two', catalogSummary: 'two', expectRevisionId: baseRevision,
    })).resolves.toEqual({ state: 'duplicate', ref: skillId })

    // Control: an op that was never applied with the stale base is stale.
    await expect(store.patchSkill({
      opId: 'op-3', projectKey: 'pk', name: 'receipt-first', body: 'body three', catalogSummary: 'three', expectRevisionId: baseRevision,
    })).resolves.toEqual({ state: 'failed', code: 'stale_base_revision' })
  })
})

describe('T64 create-same-op-reservation-and-record-retry', () => {
  it('returns duplicate after the record CAS, resumes from a bare reservation, and conflicts foreign ops', async () => {
    const harness = await freshHarness('evlock-t64')
    const { store } = harness
    const skillId = deriveSkillId('pk', 'created-once')

    // Record CAS committed, then crash: the replay is a duplicate.
    await expect(store.createSkill({
      opId: 'op-1', projectKey: 'pk', name: 'created-once', body: 'body', catalogSummary: 'summary',
    })).resolves.toEqual({ state: 'applied', ref: skillId })
    await expect(store.createSkill({
      opId: 'op-1', projectKey: 'pk', name: 'created-once', body: 'body', catalogSummary: 'summary',
    })).resolves.toEqual({ state: 'duplicate', ref: skillId })

    // Only the reservation landed, then crash: the replay completes the create.
    expect(await store.reserveName('pk', 'resumed', 'op-resume')).toMatchObject({ kind: 'reserved' })
    await expect(store.createSkill({
      opId: 'op-resume', projectKey: 'pk', name: 'resumed', body: 'resumed body', catalogSummary: 'resumed',
    })).resolves.toEqual({ state: 'applied', ref: deriveSkillId('pk', 'resumed') })

    // A different op racing for the committed name conflicts.
    await expect(store.createSkill({
      opId: 'op-2', projectKey: 'pk', name: 'created-once', body: 'other body', catalogSummary: 'other',
    })).resolves.toEqual({ state: 'failed', code: 'name_conflict' })
  })
})

describe('T65 skill-receipt-survives-later-same-skill-op', () => {
  it('keeps earlier op receipts queryable across later ops and inside the bounded terminal ring', async () => {
    const harness = await freshHarness('evlock-t65')
    const { store } = harness
    const skillId = deriveSkillId('pk', 'receipt-ring')
    const created = await store.createSkill({
      opId: 'op-1', projectKey: 'pk', name: 'receipt-ring', body: 'body one', catalogSummary: 'one',
    })
    expect(created).toEqual({ state: 'applied', ref: skillId })
    let base = store.record(skillId)?.currentRevision?.revisionId
    if (base === undefined) throw new Error('expected the first revision')

    // Ops 2 and 3 apply later (each approved, so each becomes the new base).
    const applyPatch = async (opId: string, body: string, fromBase: string): Promise<string> => {
      const outcome = await store.patchSkill({
        opId, projectKey: 'pk', name: 'receipt-ring', body, catalogSummary: opId, expectRevisionId: fromBase,
      })
      if (outcome.state !== 'applied') throw new Error(`patch ${opId} did not apply: ${outcome.state}`)
      const approved = await store.approvePending(skillId)
      if (!('revisionId' in approved)) throw new Error('expected the approve to switch the pointer')
      return approved.revisionId
    }
    base = await applyPatch('op-2', 'body two', base)
    base = await applyPatch('op-3', 'body three', base)

    // op-2's base is long stale, yet its replay is a duplicate — the receipt
    // SET retains it (a single lastAppliedOpId slot would have reported stale).
    await expect(store.patchSkill({
      opId: 'op-2', projectKey: 'pk', name: 'receipt-ring', body: 'body two', catalogSummary: 'op-2', expectRevisionId: 'stale-base',
    })).resolves.toEqual({ state: 'duplicate', ref: skillId })

    // Terminal ack moves op-2 into the bounded ring and it stays queryable.
    await store.acknowledgeTerminalOps(skillId, ['op-2'])
    await expect(store.patchSkill({
      opId: 'op-2', projectKey: 'pk', name: 'receipt-ring', body: 'body two', catalogSummary: 'op-2', expectRevisionId: 'stale-base',
    })).resolves.toEqual({ state: 'duplicate', ref: skillId })

    // Fill and overflow the ring (capacity 4): the oldest receipt — op-2 —
    // is evicted, and only then does its replay report stale.
    await store.acknowledgeTerminalOps(skillId, ['op-1', 'op-3'])
    base = await applyPatch('op-4', 'body four', base)
    base = await applyPatch('op-5', 'body five', base)
    await store.acknowledgeTerminalOps(skillId, ['op-4', 'op-5'])
    const ring = store.record(skillId)?.terminalRing.map(receipt => receipt.opId)
    expect(ring).toHaveLength(4)
    expect(ring).not.toContain('op-2')
    await expect(store.patchSkill({
      opId: 'op-2', projectKey: 'pk', name: 'receipt-ring', body: 'body two', catalogSummary: 'op-2', expectRevisionId: 'stale-base',
    })).resolves.toEqual({ state: 'failed', code: 'stale_base_revision' })
    // The still-ringmed receipts keep answering duplicate.
    await expect(store.createSkill({
      opId: 'op-4', projectKey: 'pk', name: 'receipt-ring', body: 'body four', catalogSummary: 'op-4',
    })).resolves.toEqual({ state: 'duplicate', ref: skillId })
  })
})
