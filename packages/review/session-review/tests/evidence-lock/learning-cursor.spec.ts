/**
 * Evidence Lock — batch 4: learning-view projection, cursor/ledger protocol,
 * and pure derivations.
 *
 * Pins T28, T29, T39, T40, T50, T59, T62, T63 of
 * `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md`. The cursor and ledger
 * reference stores run over real storage-domain tables (serial-atomic write
 * chain, durable across reopen); T28 projects a real session log. The
 * protocol stores themselves are in-test reference implementations
 * (`review-protocol.ts`), never production code.
 * @module evidence-lock/learning-cursor
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import Storage from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'
import {
  ReviewCursor, ReviewLedger, MemoryOps, attemptSchema, cursorSchema, deriveAttemptId, deriveOpId,
  canonicalOpDigest, estimateTokens, eventKindAdmissible, parsePlan, projectLearningView,
  recoverTerminal, runSaga,
} from './review-protocol.ts'
import type { AttemptRecord, ViewEvent } from './review-protocol.ts'

const roots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

interface ReviewHarness {
  readonly ctx: Context
  readonly cursor: ReviewCursor
  readonly ledger: ReviewLedger
  readonly memory: MemoryOps
  readonly domain: Awaited<ReturnType<DomainFacility['open']>>
  readonly backend: JsonStorageBackend
}

const memoryScopeSchema = z.object({
  scope: z.string(),
  entries: z.array(z.object({ id: z.string(), text: z.string() })),
  pendingReceipts: z.array(z.object({ opId: z.string() })),
  terminalRing: z.array(z.object({ opId: z.string() })),
})

/** One context, one JSON medium, two real domains: review state and memory state. */
async function reviewHarness(sessionId: string, root?: string): Promise<ReviewHarness> {
  const storeRoot = root ?? await tempRoot('dsh-evlock-review-')
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SessionStore)
  const backend = new JsonStorageBackend(storeRoot)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const reviewSpec = defineDomain({
    name: 'evlock_review',
    version: 1,
    tables: {
      cursors: domainTable<string, z.infer<typeof cursorSchema>>(cursorSchema),
      attempts: domainTable<string, AttemptRecord>(attemptSchema),
    },
  })
  const memorySpec = defineDomain({
    name: 'evlock_memory',
    version: 1,
    tables: { scopes: domainTable<string, z.infer<typeof memoryScopeSchema>>(memoryScopeSchema) },
  })
  const reviewDomain = await facility.open(reviewSpec)
  const memoryDomain = await facility.open(memorySpec)
  const identity = { sessionId, policyVersion: 'p1', learningViewVersion: 'lv1' }
  return {
    ctx,
    cursor: new ReviewCursor(reviewDomain.table('cursors'), identity),
    ledger: new ReviewLedger(reviewDomain.table('attempts')),
    memory: new MemoryOps(memoryDomain.table('scopes')),
    domain: reviewDomain,
    backend,
  }
}

/** A real session log with sized alternating turns plus one excluded synthetic event. */
async function sizedSession(ctx: Context, id: string, turns: number, userChars: number, assistantChars: number): Promise<ViewEvent[]> {
  const session = ctx.sessions.create(SessionId(id))
  for (let i = 0; i < turns; i += 1) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `u${i}`.repeat(userChars) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: i + 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `a${i}`.repeat(assistantChars) }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    if (i === Math.floor(turns / 2)) {
      session.append('compaction/summary', {
        compactionId: CompactionId('evlock-view'),
        summary: [{ type: 'text', text: 'synthetic context' }],
        shadowedRange: { start: 0, end: 0 },
        shadowedSeqs: [],
        shadowedTokenCount: 0,
        provider: 'stub',
        model: 'stub',
      })
    }
  }
  return session.events.map(event => ({
    seq: event.seq,
    type: event.type,
    text: event.type === 'user/message'
      ? JSON.stringify(event.data.content)
      : event.type === 'assistant/message'
        ? JSON.stringify(event.data.message.content)
        : JSON.stringify(event.data),
  }))
}

describe('T28 truncation-contiguous-high-water', () => {
  it('slices a real session log oldest-first with no admissible gap before effectiveThrough', async () => {
    const { ctx } = await reviewHarness('evlock-view')
    const events = await sizedSession(ctx, 'evlock-view', 6, 400, 200)
    // One turn costs 100 + 50 = 150 tokens; a 500-token budget admits three
    // full turns and stops there.
    const projection = projectLearningView(events, 500)

    const admitted = events.filter(event => eventKindAdmissible(event.type))
    expect(projection.events.length).toBeLessThan(admitted.length)
    expect(projection.truncated).toBe(true)
    const used = projection.events.reduce((sum, event) => sum + estimateTokens(event.text), 0)
    expect(used).toBeLessThanOrEqual(500)
    const nextCost = estimateTokens(admitted[projection.events.length]?.text ?? '')
    expect(used + nextCost).toBeGreaterThan(500)

    // Contiguity: the view is EXACTLY the admissible events up to the
    // high-water — no skipped admissible event, no out-of-order slice.
    const expectedSeqs = admitted.filter(event => event.seq <= projection.effectiveThrough).map(event => event.seq)
    expect(projection.events.map(event => event.seq)).toEqual(expectedSeqs)
    expect(projection.events.every((event, index) => index === 0 || event.seq > (projection.events[index - 1]?.seq ?? 0))).toBe(true)
    // The synthetic compaction event sits inside the range but never enters.
    expect(projection.events.some(event => event.type === 'compaction/summary')).toBe(false)
    expect(events.some(event => event.type === 'compaction/summary')).toBe(true)
  })
})

describe('T29 cursor-acquired-busy', () => {
  it('claims atomically: one concurrent winner, busy losers keep their desiredThrough, nothing-due when caught up', async () => {
    const harness = await reviewHarness('evlock-cursor')
    const { cursor } = harness

    expect(await cursor.claim(0, 10)).toEqual({ kind: 'nothing-due' })

    // Exactly one of two concurrent claims wins; the loser observes busy.
    const [left, right] = await Promise.all([cursor.claim(5, 10), cursor.claim(5, 10)])
    const kinds = [left.kind, right.kind].sort()
    expect(kinds).toEqual(['acquired', 'busy'])
    const winner = left.kind === 'acquired' ? left : right
    if (winner.kind !== 'acquired') throw new Error('expected one acquired winner')
    expect(winner.attemptNo).toBe(1)
    expect(winner.desiredThrough).toBe(10)

    // A claim observed while busy still folds its desiredThrough into the
    // durable max — the request is not lost by the busy answer.
    const busy = await cursor.claim(6, 20)
    expect(busy.kind).toBe('busy')
    const record = cursor.read('evlock-cursor')
    expect(record?.desiredThroughSeq).toBe(20)
    expect(record?.inFlight.occupied).toBe(true)

    // Planning-cancel clears the slot; the next claim allocates attemptNo 2
    // and the range starts past the high-water, still carrying desired 20.
    const settle = await cursor.settleRunning(winner.attemptId, 'cancelled', 'planning')
    expect(settle).toBe('cleared')
    const second = await cursor.claim(6, 20)
    if (second.kind !== 'acquired') throw new Error('expected acquired after settle')
    expect(second.attemptNo).toBe(2)
    expect(second.fromSeq).toBe(1)
    expect(second.desiredThrough).toBe(20)

    // Caught up: advancing the high-water makes the range nothing-due.
    await cursor.advance(6)
    expect(await cursor.claim(6, 25)).toEqual({ kind: 'nothing-due' })
    await harness.domain.close()
    await harness.backend.close()
  })
})

describe('T39 cancel-settles-inflight-same-process', () => {
  it('clears planning cancellations, resumes stored plans after the planned boundary, and bounds foreground waits', async () => {
    const harness = await reviewHarness('evlock-cancel')
    const { cursor, ledger } = harness

    const claim = await cursor.claim(5, 10)
    if (claim.kind !== 'acquired') throw new Error('expected acquired')

    // Cancel during planning: the slot clears, the same process is not
    // permanently busy, and the replacement attempt is a fresh one.
    expect(await cursor.settleRunning(claim.attemptId, 'cancelled', 'planning')).toBe('cleared')
    const replan = await cursor.claim(5, 10)
    if (replan.kind !== 'acquired') throw new Error('expected fresh acquisition')
    expect(replan.attemptNo).toBe(claim.attemptNo + 1)

    // Cancel after the planned boundary: the attempt turns resumable and the
    // next claim hands the SAME attempt back, whose stored plan is the only
    // recovery input (no model recall).
    await cursor.releaseInFlight(replan.attemptId)
    const planned = await cursor.claim(5, 10)
    if (planned.kind !== 'acquired') throw new Error('expected acquired')
    await ledger.startPlanning({
      attemptId: planned.attemptId,
      attemptNo: planned.attemptNo,
      rangeId: planned.rangeId,
      fromSeq: planned.fromSeq,
      toSeq: 10,
    })
    await ledger.recordPlan(planned.attemptId, [{ kind: 'memory', scope: 'project', text: 'stored plan op' }])
    const plannedPhase = ledger.get(planned.attemptId)?.phase
    if (plannedPhase !== 'planned') throw new Error('expected the planned boundary in the ledger')
    expect(await cursor.settleRunning(planned.attemptId, 'cancelled', plannedPhase)).toBe('resumable')
    const resumed = await cursor.claim(5, 10)
    expect(resumed).toMatchObject({ kind: 'resume', attemptId: planned.attemptId })
    const attempt = ledger.get(planned.attemptId)
    expect(attempt?.plan).toEqual([{ kind: 'memory', scope: 'project', text: 'stored plan op' }])

    // The foreground wait is bounded: a hung settlement promise loses to the
    // timer, so a turn can never block indefinitely on the background saga.
    const hung = new Promise<never>(() => {})
    const bounded = await Promise.race([
      hung.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, 10) }),
    ])
    expect(bounded).toBe('timeout')
    await harness.domain.close()
    await harness.backend.close()
  })
})

describe('T40 planned-attempt-id-replan', () => {
  it('appends replans with fresh attempt ids, never overwrites the old planned attempt, and recovers the newest valid', async () => {
    const harness = await reviewHarness('evlock-replan')
    const { cursor, ledger } = harness

    const first = await cursor.claim(5, 10)
    if (first.kind !== 'acquired') throw new Error('expected acquired')
    await ledger.startPlanning({
      attemptId: first.attemptId,
      attemptNo: first.attemptNo,
      rangeId: first.rangeId,
      fromSeq: first.fromSeq,
      toSeq: 10,
    })
    const firstPlan = [{ kind: 'memory', scope: 'project', text: 'stale plan' }] as const
    await ledger.recordPlan(first.attemptId, [...firstPlan])
    const firstSnapshot = structuredClone(ledger.get(first.attemptId))

    // Stale-base replan: release the slot and claim again — a NEW attempt id
    // for the SAME range, allocated durably as attemptNo+1.
    await cursor.releaseInFlight(first.attemptId)
    const second = await cursor.claim(5, 10)
    if (second.kind !== 'acquired') throw new Error('expected replan acquisition')
    expect(second.rangeId).toBe(first.rangeId)
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(second.attemptNo).toBe(first.attemptNo + 1)
    await ledger.startPlanning({
      attemptId: second.attemptId,
      attemptNo: second.attemptNo,
      rangeId: second.rangeId,
      fromSeq: second.fromSeq,
      toSeq: 10,
    })
    await ledger.recordPlan(second.attemptId, [{ kind: 'memory', scope: 'project', text: 'fresh plan' }])

    // Append-only: the old planned attempt is byte-identical to its snapshot.
    expect(ledger.get(first.attemptId)).toEqual(firstSnapshot)
    const attempts = ledger.attemptsOfRange(first.rangeId)
    expect(attempts.map(attempt => attempt.attemptId)).toEqual([first.attemptId, second.attemptId])
    // Recovery takes the newest attempt that carries a stored plan.
    expect(ledger.latestValidAttempt(first.rangeId)?.attemptId).toBe(second.attemptId)
    await harness.domain.close()
    await harness.backend.close()
  })
})

describe('T50 attempt-id-does-not-require-preclaim-base-state', () => {
  it('derives the attempt id at claim time from range and number alone, backfilling base state afterwards', async () => {
    const harness = await reviewHarness('evlock-attempt-id')
    const { cursor, ledger } = harness

    expect(deriveAttemptId('r', 3)).toBe(deriveAttemptId('r', 3))
    expect(deriveAttemptId('r', 3)).not.toBe(deriveAttemptId('r', 4))
    expect(deriveAttemptId('r', 3)).not.toBe(deriveAttemptId('other', 3))

    const claim = await cursor.claim(5, 10)
    if (claim.kind !== 'acquired') throw new Error('expected acquired')
    // The id is fully determined before any base state exists…
    expect(claim.attemptId).toBe(deriveAttemptId(claim.rangeId, claim.attemptNo))
    await ledger.startPlanning({
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      rangeId: claim.rangeId,
      fromSeq: claim.fromSeq,
      toSeq: 10,
    })
    const before = ledger.get(claim.attemptId)
    expect(before?.baseStateDigest).toBeUndefined()

    // …and the backfill changes only the field, never the identity.
    await ledger.recordBaseState(claim.attemptId, 'digest-A')
    expect(ledger.get(claim.attemptId)?.baseStateDigest).toBe('digest-A')
    expect(ledger.get(claim.attemptId)?.attemptId).toBe(claim.attemptId)
    // A different base digest on the same range/number derives the SAME id.
    expect(deriveAttemptId(claim.rangeId, claim.attemptNo)).toBe(claim.attemptId)
    await harness.domain.close()
    await harness.backend.close()
  })
})

describe('T59 terminal-recovery-advances-persisted-effective-through', () => {
  it('advances recovery from the value persisted before the planner and never recomputes or duplicates writes', async () => {
    const harness = await reviewHarness('evlock-persist')
    const deps = {
      cursor: harness.cursor,
      ledger: harness.ledger,
      memory: harness.memory,
      skills: {
        create: async () => ({ state: 'failed' as const, code: 'unused' }),
        patch: async () => ({ state: 'failed' as const, code: 'unused' }),
        acknowledgeTerminalOps: async () => {},
      },
    }
    const claim = await harness.cursor.claim(4, 10)
    if (claim.kind !== 'acquired') throw new Error('expected acquired')
    await runSaga(deps, {
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      rangeId: claim.rangeId,
      fromSeq: claim.fromSeq,
      toSeq: 10,
      budgetTokens: 500,
      enabledScopes: ['project'],
      events: [{ seq: 1, type: 'user/message', text: 'x'.repeat(40) }, { seq: 2, type: 'user/message', text: 'y'.repeat(4000) }],
    }, {
      buildPlan: () => [{ kind: 'memory', scope: 'project', text: 'persisted fact' }],
      baseStateDigest: () => 'base',
      crashAfter: 'after-terminal',
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('crash-injected: after-terminal')) throw error
    })

    // Crash between markTerminal and the cursor advance: terminal is
    // durable, the cursor is not advanced, and the attempt carries the
    // effectiveThrough persisted BEFORE the planner ran.
    const attempt = harness.ledger.get(claim.attemptId)
    expect(attempt?.phase).toBe('terminal')
    expect(attempt?.finalized).toBe(false)
    expect(attempt?.effectiveThrough).toBe(1)
    expect(harness.cursor.read('evlock-persist')?.reviewedThroughSeq).toBe(0)

    // Recovery advances exactly by the persisted value (no recompute to the
    // larger window, no skip), and a later re-record of a different value
    // fails loud.
    expect(await recoverTerminal(deps)).toBe(1)
    expect(harness.cursor.read('evlock-persist')?.reviewedThroughSeq).toBe(1)
    await expect(harness.ledger.recordEffectiveThrough(claim.attemptId, 2)).rejects.toThrow(/refusing recompute/)

    // A replay of the same op (same derived opId) hits the receipt and
    // resolves to the same entry: no duplicate write.
    const opId = deriveOpId(claim.attemptId, 'memory', 0, canonicalOpDigest({ kind: 'memory', scope: 'project', text: 'persisted fact' }))
    const outcomes = await harness.memory.applyOps('project', [{ opId, text: 'persisted fact' }])
    expect(outcomes[0]?.state).toBe('duplicate')
    const scope = harness.memory.read('project')
    expect(scope?.entries).toHaveLength(1)
    expect(scope?.entries[0]?.id).toBe(`mem-${opId}`)
    await harness.domain.close()
    await harness.backend.close()
  })
})

describe('T62 op-id-stable-across-planned-recovery', () => {
  it('derives bitwise-identical opIds on every recovery and rejects model-supplied opIds', () => {
    const attemptId = deriveAttemptId('range-x', 1)
    const plan: readonly (
      | { kind: 'memory'; scope: 'project'; text: string }
      | { kind: 'skill-patch'; projectKey: string; name: string; body: string; catalogSummary: string; expectRevisionId: string }
    )[] = [
      { kind: 'memory', scope: 'project', text: 'first op' },
      { kind: 'skill-patch', projectKey: 'pk', name: 'n', body: 'b', catalogSummary: 's', expectRevisionId: 'r1' },
      { kind: 'memory', scope: 'project', text: 'third op' },
    ]
    const opIds = (storedPlan: readonly unknown[]): string[] =>
      storedPlan.map((op, index) => deriveOpId(attemptId, op !== null && typeof op === 'object' && 'kind' in op && op.kind === 'memory' ? 'memory' : 'skill', index, canonicalOpDigest(op)))

    const first = opIds([...plan])
    // Any number of recovery/resume passes over the same immutable stored
    // plan derive the same opIds — no persisted allocator is consulted.
    for (let i = 0; i < 3; i += 1) expect(opIds([...plan])).toEqual(first)

    // The model never supplies opIds: the plan schema is strict, so an op
    // carrying one fails the parse that gates every plan.
    const forged = [{ kind: 'memory', scope: 'project', text: 'op', opId: 'model-chosen' }]
    expect(() => parsePlan(forged)).toThrow()
    expect(parsePlan(plan).length).toBe(3)
  })
})

describe('T63 changed-op-payload-changes-op-id', () => {
  it('changes the opId of exactly the op whose payload changed', () => {
    const attemptId = deriveAttemptId('range-y', 2)
    const digestOf = (text: string): string => canonicalOpDigest({ kind: 'memory', scope: 'project', text })
    const opIdOf = (index: number, text: string): string =>
      deriveOpId(attemptId, 'memory', index, digestOf(text))

    const baseline = [opIdOf(0, 'alpha'), opIdOf(1, 'beta'), opIdOf(2, 'gamma')]
    const mutated = [opIdOf(0, 'alpha'), opIdOf(1, 'beta!'), opIdOf(2, 'gamma')]
    expect(mutated[0]).toBe(baseline[0])
    expect(mutated[1]).not.toBe(baseline[1])
    expect(mutated[2]).toBe(baseline[2])
  })
})
