/**
 * Evidence Lock batch 4 — in-test reference implementations of the session
 * review protocol (P3 §2 pure functions, §3 cursor/ledger stores, §4 saga and
 * finalization). Test-tree only: these pin the behavioral facts the review
 * design relies on over real storage-domain tables and real session logs
 * without registering any production behavior. The future P1/P3 packages must
 * re-implement these contracts; nothing in `src/` may import this file.
 * @module evidence-lock/review-protocol
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

/** Hex SHA-256 over a UTF-8 string — the only hash used by the references. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Canonical JSON: recursively key-sorted objects, arrays in order, `undefined` props dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

// ---------------------------------------------------------------------------
// Pure derivations (P3 §2) — no store reads, no allocator state.
// ---------------------------------------------------------------------------

export type RangeId = string
export type AttemptId = string
export type OpId = string
export type ResourceKind = 'memory' | 'skill'

export function deriveRangeId(
  sessionId: string,
  fromSeq: number,
  policyVersion: string,
  learningViewVersion: string,
): RangeId {
  return sha256(canonicalJson({ fromSeq, kind: 'range', learningViewVersion, policyVersion, sessionId }))
}

export function deriveAttemptId(rangeId: RangeId, attemptNo: number): AttemptId {
  return sha256(canonicalJson({ attemptNo, kind: 'attempt', rangeId }))
}

export function canonicalOpDigest(op: unknown): string {
  return sha256(canonicalJson(op))
}

export function deriveOpId(
  attemptId: AttemptId,
  resourceKind: ResourceKind,
  stableOpIndex: number,
  digest: string,
): OpId {
  return sha256(canonicalJson({ attemptId, canonicalOpDigest: digest, kind: 'op', resourceKind, stableOpIndex }))
}

// ---------------------------------------------------------------------------
// Learning view projection (P3 §2 projectEvents reference).
// ---------------------------------------------------------------------------

export interface ViewEvent {
  readonly seq: number
  readonly type: string
  readonly text: string
}

export interface Projection {
  readonly events: readonly ViewEvent[]
  readonly effectiveThrough: number
  readonly truncated: boolean
}

/** Kinds the learning view admits; synthetic and context-only kinds are excluded. */
const ADMISSIBLE_KINDS: ReadonlySet<string> = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

export function eventKindAdmissible(type: string): boolean {
  return ADMISSIBLE_KINDS.has(type)
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Oldest-first contiguous slice under a token budget: every admissible event
 * up to `effectiveThrough` is included, the first event that would overflow
 * the budget stops the slice, and excluded kinds never enter the view.
 */
export function projectLearningView(events: readonly ViewEvent[], maxTokens: number): Projection {
  const admitted = [...events].sort((left, right) => left.seq - right.seq).filter(event => eventKindAdmissible(event.type))
  const view: ViewEvent[] = []
  let used = 0
  for (const event of admitted) {
    const cost = estimateTokens(event.text)
    if (used + cost > maxTokens) break
    used += cost
    view.push(event)
  }
  const last = view.at(-1)
  return { events: view, effectiveThrough: last?.seq ?? 0, truncated: view.length < admitted.length }
}

// ---------------------------------------------------------------------------
// ReviewCursorStore (P3 §3) over a real domain table.
// ---------------------------------------------------------------------------

const inFlightPlanning = z.object({
  occupied: z.literal(true),
  attemptId: z.string(),
  attemptNo: z.number().int(),
  rangeId: z.string(),
  phase: z.enum(['planning', 'planned', 'committing', 'resumable']),
})
export const cursorSchema = z.object({
  reviewedThroughSeq: z.number().int(),
  desiredThroughSeq: z.number().int(),
  lastAttemptNo: z.number().int(),
  inFlight: z.discriminatedUnion('occupied', [z.object({ occupied: z.literal(false) }), inFlightPlanning]),
})
export type CursorRecord = z.infer<typeof cursorSchema>
export type InFlight = Extract<CursorRecord['inFlight'], { occupied: true }>

export type ClaimResult =
  | { kind: 'acquired'; attemptId: AttemptId; attemptNo: number; rangeId: RangeId; fromSeq: number; desiredThrough: number }
  | { kind: 'resume'; attemptId: AttemptId; rangeId: RangeId }
  | { kind: 'busy'; attemptId: AttemptId }
  | { kind: 'nothing-due' }

export interface ReviewIdentity {
  readonly sessionId: string
  readonly policyVersion: string
  readonly learningViewVersion: string
}

export class ReviewCursor {
  constructor(
    private readonly table: KvTable<string, CursorRecord>,
    private readonly identity: ReviewIdentity,
  ) {}

  private initial(): CursorRecord {
    return { reviewedThroughSeq: 0, desiredThroughSeq: 0, lastAttemptNo: 0, inFlight: { occupied: false } }
  }

  /** T24 first-record protocol: get→put(empty)→update; the put is idempotent, the update is the RMW. */
  async ensure(sessionId: string): Promise<void> {
    if (this.table.get(sessionId) === undefined) await this.table.put(sessionId, this.initial())
  }

  read(sessionId: string): CursorRecord | undefined {
    return this.table.get(sessionId)
  }

  /**
   * Single RMW claim: due check, busy check, resumable handout, or durable
   * attemptNo allocation. `desiredThroughSeq` folds to max in every branch,
   * so a request observed while busy is never lost.
   */
  async claim(dueThrough: number, desiredThrough: number): Promise<ClaimResult> {
    const sessionId = this.identity.sessionId
    await this.ensure(sessionId)
    let result: ClaimResult = { kind: 'nothing-due' }
    await this.table.update(sessionId, (cur) => {
      const desired = Math.max(cur.desiredThroughSeq, desiredThrough)
      const next: CursorRecord = { ...cur, desiredThroughSeq: desired }
      if (dueThrough <= cur.reviewedThroughSeq) {
        result = { kind: 'nothing-due' }
        return next
      }
      if (next.inFlight.occupied) {
        if (next.inFlight.phase === 'resumable') {
          result = { kind: 'resume', attemptId: next.inFlight.attemptId, rangeId: next.inFlight.rangeId }
          next.inFlight = { ...next.inFlight, phase: 'planned' }
          return next
        }
        result = { kind: 'busy', attemptId: next.inFlight.attemptId }
        return next
      }
      const attemptNo = cur.lastAttemptNo + 1
      const rangeId = deriveRangeId(sessionId, cur.reviewedThroughSeq + 1, this.identity.policyVersion, this.identity.learningViewVersion)
      const attemptId = deriveAttemptId(rangeId, attemptNo)
      next.lastAttemptNo = attemptNo
      next.inFlight = { occupied: true, attemptId, attemptNo, rangeId, phase: 'planning' }
      result = { kind: 'acquired', attemptId, attemptNo, rangeId, fromSeq: cur.reviewedThroughSeq + 1, desiredThrough: desired }
      return next
    })
    return result
  }

  /** Monotonic high-water advance: the max-guard makes crash replays no-ops. */
  async advance(effectiveThrough: number): Promise<void> {
    const sessionId = this.identity.sessionId
    await this.ensure(sessionId)
    await this.table.update(sessionId, cur => ({
      ...cur,
      reviewedThroughSeq: Math.max(cur.reviewedThroughSeq, effectiveThrough),
    }))
  }

  /**
   * Foreground-cancellation settlement: cancel before the planned boundary
   * clears the slot (nothing durable to resume); cancel after it turns the
   * attempt resumable so the stored plan continues. The attempt phase lives
   * in the ledger, so the caller passes it from `ledger.get(attemptId)`.
   */
  async settleRunning(attemptId: AttemptId, outcome: 'cancelled', attemptPhase: 'planning' | 'planned' | 'committing'): Promise<'cleared' | 'resumable'> {
    if (outcome !== 'cancelled') throw new Error(`unsupported settlement outcome '${outcome}'`)
    let settle: 'cleared' | 'resumable' = 'cleared'
    await this.table.update(this.identity.sessionId, (cur) => {
      if (!cur.inFlight.occupied || cur.inFlight.attemptId !== attemptId) return cur
      if (attemptPhase === 'planning') {
        settle = 'cleared'
        return { ...cur, inFlight: { occupied: false } }
      }
      settle = 'resumable'
      return { ...cur, inFlight: { ...cur.inFlight, phase: 'resumable' } }
    })
    return settle
  }

  /** Release the in-flight slot; the finalization sequence and recovery call this. */
  async releaseInFlight(attemptId: AttemptId): Promise<void> {
    await this.table.update(this.identity.sessionId, cur =>
      cur.inFlight.occupied && cur.inFlight.attemptId === attemptId
        ? { ...cur, inFlight: { occupied: false } }
        : cur)
  }

  /** Startup recovery: an interrupted planning attempt is lost, a planned one survives as resumable. */
  async recover(): Promise<{ kind: 'idle' } | { kind: 'lost-planning'; attemptId: AttemptId } | { kind: 'resumable'; attemptId: AttemptId }> {
    const sessionId = this.identity.sessionId
    await this.ensure(sessionId)
    let out: { kind: 'idle' } | { kind: 'lost-planning'; attemptId: AttemptId } | { kind: 'resumable'; attemptId: AttemptId } = { kind: 'idle' }
    await this.table.update(sessionId, (cur) => {
      if (!cur.inFlight.occupied) return cur
      if (cur.inFlight.phase === 'planning') {
        out = { kind: 'lost-planning', attemptId: cur.inFlight.attemptId }
        return { ...cur, inFlight: { occupied: false } }
      }
      out = { kind: 'resumable', attemptId: cur.inFlight.attemptId }
      return { ...cur, inFlight: { ...cur.inFlight, phase: 'resumable' } }
    })
    return out
  }
}

// ---------------------------------------------------------------------------
// ReviewLedgerStore (P3 §3) over a real domain table.
// ---------------------------------------------------------------------------

export const opStateSchema = z.object({
  opId: z.string(),
  resource: z.enum(['memory', 'skill']),
  resourceRef: z.string(),
  state: z.enum(['prepared', 'applied', 'duplicate', 'failed']),
})
export type ReviewOpState = z.infer<typeof opStateSchema>

export type RangeDisposition = 'consumed' | 'superseded' | 'retryable' | 'manual'

export const attemptSchema = z.object({
  attemptId: z.string(),
  attemptNo: z.number().int(),
  rangeId: z.string(),
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
  phase: z.enum(['planning', 'planned', 'committing', 'terminal']),
  plan: z.unknown().optional(),
  baseStateDigest: z.string().optional(),
  effectiveThrough: z.number().int().optional(),
  opStates: z.array(opStateSchema),
  terminalStatus: z.string().optional(),
  rangeDisposition: z.enum(['consumed', 'superseded', 'retryable', 'manual']).optional(),
  finalized: z.boolean(),
  failureCode: z.string().optional(),
  recordedProposals: z.array(z.unknown()),
})
export type AttemptRecord = z.infer<typeof attemptSchema>

export class ReviewLedger {
  constructor(private readonly table: KvTable<string, AttemptRecord>) {}

  get(attemptId: string): AttemptRecord | undefined {
    return this.table.get(attemptId)
  }

  /** Append-only: one attemptId is written exactly once, never overwritten. */
  async putAttempt(attempt: AttemptRecord): Promise<void> {
    if (this.table.get(attempt.attemptId) !== undefined) {
      throw new Error(`attempt ${attempt.attemptId} already exists; attempts are append-only`)
    }
    await this.table.put(attempt.attemptId, attempt)
  }

  async startPlanning(attempt: {
    attemptId: AttemptId
    attemptNo: number
    rangeId: RangeId
    fromSeq: number
    toSeq: number
  }): Promise<void> {
    await this.putAttempt({ ...attempt, phase: 'planning', opStates: [], finalized: false, recordedProposals: [] })
  }

  /** Post-claim backfill; the digest never participates in the attempt id. */
  async recordBaseState(attemptId: AttemptId, digest: string): Promise<void> {
    await this.table.update(attemptId, cur => ({ ...cur, baseStateDigest: digest }))
  }

  /** Planned boundary: the stored plan is the only recovery input. */
  async recordPlan(attemptId: AttemptId, plan: unknown): Promise<void> {
    await this.table.update(attemptId, cur => ({ ...cur, phase: 'planned', plan }))
  }

  /** Persisted pre-planner; a different re-record is a loud error — recovery must not recompute. */
  async recordEffectiveThrough(attemptId: AttemptId, effectiveThrough: number): Promise<void> {
    await this.table.update(attemptId, (cur) => {
      if (cur.effectiveThrough !== undefined && cur.effectiveThrough !== effectiveThrough) {
        throw new Error(
          `attempt ${attemptId} effectiveThrough already persisted as ${cur.effectiveThrough};`
          + ` refusing recompute to ${effectiveThrough}`,
        )
      }
      return { ...cur, effectiveThrough }
    })
  }

  /** Saga log; the ledger is the recovery authority and ledger absence means not started. */
  async markOpState(attemptId: AttemptId, state: ReviewOpState): Promise<void> {
    await this.table.update(attemptId, cur => ({
      ...cur,
      opStates: cur.opStates.filter(entry => entry.opId !== state.opId).concat(state),
    }))
  }

  /** Backstop recording: a proposal is retained even when the whole plan commits nothing. */
  async recordProposal(attemptId: AttemptId, proposal: unknown): Promise<void> {
    await this.table.update(attemptId, cur => ({ ...cur, recordedProposals: [...cur.recordedProposals, proposal] }))
  }

  async markTerminal(
    attemptId: AttemptId,
    terminalStatus: string,
    rangeDisposition: RangeDisposition,
    failureCode?: string,
  ): Promise<void> {
    await this.table.update(attemptId, (cur) => {
      const next: AttemptRecord = { ...cur, phase: 'terminal', terminalStatus, rangeDisposition }
      if (failureCode !== undefined) next.failureCode = failureCode
      return next
    })
  }

  async markFinalized(attemptId: AttemptId): Promise<void> {
    await this.table.update(attemptId, cur => ({ ...cur, finalized: true }))
  }

  attemptsOfRange(rangeId: RangeId): AttemptRecord[] {
    return [...this.table.entries()]
      .map(([, record]) => record)
      .filter(record => record.rangeId === rangeId)
      .sort((left, right) => left.attemptNo - right.attemptNo)
  }

  /** Newest attempt that reached the planned boundary — the only recovery input. */
  latestValidAttempt(rangeId: RangeId): AttemptRecord | undefined {
    return this.attemptsOfRange(rangeId).filter(record => record.plan !== undefined).at(-1)
  }

  /** Terminal attempts whose recovery obligations are still open. */
  unfinalizedTerminal(): AttemptRecord[] {
    return [...this.table.entries()].map(([, record]) => record).filter(record => record.phase === 'terminal' && !record.finalized)
  }
}

// ---------------------------------------------------------------------------
// Reference memory capability (P1 surface): applyOps receipts + grouped ack.
// ---------------------------------------------------------------------------

export const memoryScopeSchema = z.object({
  scope: z.string(),
  entries: z.array(z.object({ id: z.string(), text: z.string() })),
  pendingReceipts: z.array(z.object({ opId: z.string() })),
  terminalRing: z.array(z.object({ opId: z.string() })),
})
export type MemoryScopeRecord = z.infer<typeof memoryScopeSchema>

/** Bounded recent-terminal receipt ring; acked receipts stay queryable within the ring. */
export const TERMINAL_RING_CAPACITY = 4

export interface AckGroup {
  readonly scope: string
  readonly opIds: readonly string[]
}

export interface MemoryOpInput {
  readonly opId: OpId
  readonly text: string
  readonly expectEntryId?: string
}

export type MemoryApplyOutcome =
  | { state: 'applied'; opId: OpId; entryId: string }
  | { state: 'duplicate'; opId: OpId; entryId: string }

export class MemoryOps {
  constructor(private readonly table: KvTable<string, MemoryScopeRecord>) {}

  async ensureScope(scope: string): Promise<void> {
    if (this.table.get(scope) === undefined) {
      await this.table.put(scope, { scope, entries: [], pendingReceipts: [], terminalRing: [] })
    }
  }

  read(scope: string): MemoryScopeRecord | undefined {
    return this.table.get(scope)
  }

  /**
   * Atomic batch: receipt lookup first (duplicate before stale), then base
   * expectations; any failure throws and commits nothing. Entry ids derive
   * from opIds, so replays resolve to the same entry.
   */
  async applyOps(scope: string, ops: readonly MemoryOpInput[]): Promise<MemoryApplyOutcome[]> {
    await this.ensureScope(scope)
    const outcomes: MemoryApplyOutcome[] = []
    await this.table.update(scope, (cur) => {
      const known = new Set([...cur.pendingReceipts, ...cur.terminalRing].map(receipt => receipt.opId))
      const next = { ...cur, entries: [...cur.entries], pendingReceipts: [...cur.pendingReceipts] }
      for (const op of ops) {
        const entryId = `mem-${op.opId}`
        if (known.has(op.opId)) {
          outcomes.push({ state: 'duplicate', opId: op.opId, entryId })
          continue
        }
        if (op.expectEntryId !== undefined && !cur.entries.some(entry => entry.id === op.expectEntryId)) {
          throw new Error(`stale_base_revision: memory op ${op.opId} expects missing entry ${op.expectEntryId}; zero commits`)
        }
        outcomes.push({ state: 'applied', opId: op.opId, entryId })
        next.entries.push({ id: entryId, text: op.text })
        next.pendingReceipts.push({ opId: op.opId })
      }
      return next
    })
    return outcomes
  }

  /**
   * Grouped idempotent terminal ack: moves pending receipts into the bounded
   * ring per scope. Groups must locate scope records (orphans fail loud),
   * entries without an opId are `invalid_structure`, and already-moved
   * receipts succeed silently so crash replays converge.
   */
  async acknowledgeTerminalOps(groups: readonly AckGroup[]): Promise<void> {
    for (const group of groups) {
      for (const opId of group.opIds) {
        if (opId === '') throw new Error('invalid_structure: ack entry without opId')
      }
    }
    for (const group of groups) {
      if (this.table.get(group.scope) === undefined) {
        throw new Error(`invalid_structure: ack group references unknown scope '${group.scope}'`)
      }
      await this.table.update(group.scope, (cur) => {
        const ringed = new Set(cur.terminalRing.map(receipt => receipt.opId))
        const pending = new Set(cur.pendingReceipts.map(receipt => receipt.opId))
        const moved: string[] = []
        for (const opId of group.opIds) {
          if (ringed.has(opId)) continue
          if (!pending.has(opId)) throw new Error(`invalid_structure: no receipt for op ${opId} in scope '${group.scope}'`)
          moved.push(opId)
        }
        if (moved.length === 0) return cur
        const ring = [...cur.terminalRing, ...moved.map(opId => ({ opId }))]
        return {
          ...cur,
          pendingReceipts: cur.pendingReceipts.filter(receipt => !moved.includes(receipt.opId)),
          terminalRing: ring.length > TERMINAL_RING_CAPACITY ? ring.slice(ring.length - TERMINAL_RING_CAPACITY) : ring,
        }
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Plan schema, admission, and consolidation (P3 §4 references).
// ---------------------------------------------------------------------------

export const planOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('memory'),
    scope: z.enum(['project', 'user']),
    text: z.string(),
    expectEntryId: z.string().optional(),
  }).strict(),
  z.object({
    kind: z.literal('skill-create'),
    projectKey: z.string(),
    name: z.string(),
    body: z.string(),
    catalogSummary: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('skill-patch'),
    projectKey: z.string(),
    name: z.string(),
    body: z.string(),
    catalogSummary: z.string(),
    expectRevisionId: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('user-proposal'),
    target: z.literal('user'),
    text: z.string(),
  }).strict(),
])
export type PlanOp = z.infer<typeof planOpSchema>

export function parsePlan(plan: unknown): readonly PlanOp[] {
  return z.array(planOpSchema).parse(plan)
}

export function resourceKindOf(op: PlanOp): ResourceKind {
  return op.kind === 'memory' ? 'memory' : 'skill'
}

export interface AdmissionLimits {
  readonly budgetTokens: number
  readonly enabledScopes: readonly string[]
}

export type AdmissionResult =
  | { kind: 'admitted' }
  | { kind: 'rejected'; code: 'target_scope_disabled' | 'budget_exceeded' | 'plan_duplicate_skill_target'; proposal?: PlanOp }

/**
 * Whole-plan admission: a user-target proposal at L1, a repeated skill
 * target, or a budget overflow rejects the ENTIRE plan — nothing commits.
 */
export function admitPlan(plan: readonly PlanOp[], limits: AdmissionLimits): AdmissionResult {
  for (const op of plan) {
    if (op.kind === 'user-proposal') return { kind: 'rejected', code: 'target_scope_disabled', proposal: op }
    if (op.kind === 'memory' && !limits.enabledScopes.includes(op.scope)) {
      return { kind: 'rejected', code: 'target_scope_disabled', proposal: op }
    }
  }
  const skillTargets = plan
    .filter((op): op is Extract<PlanOp, { kind: 'skill-create' | 'skill-patch' }> => op.kind === 'skill-create' || op.kind === 'skill-patch')
    .map(op => `${op.projectKey}/${op.name}`)
  if (new Set(skillTargets).size !== skillTargets.length) {
    return { kind: 'rejected', code: 'plan_duplicate_skill_target' }
  }
  const cost = plan.reduce((sum, op) => sum + estimateTokens(canonicalJson(op)), 0)
  if (cost > limits.budgetTokens) return { kind: 'rejected', code: 'budget_exceeded' }
  return { kind: 'admitted' }
}

/** Consolidation yields a NEW whole plan: oldest-first ops while they fit the budget. */
export function consolidatePlan(plan: readonly PlanOp[], budgetTokens: number): readonly PlanOp[] {
  const kept: PlanOp[] = []
  let used = 0
  for (const op of plan) {
    const cost = estimateTokens(canonicalJson(op))
    if (used + cost > budgetTokens) break
    used += cost
    kept.push(op)
  }
  return kept
}

// ---------------------------------------------------------------------------
// Saga execution and terminal finalization (P3 §4 runReview reference).
// ---------------------------------------------------------------------------

export type SkillOutcome =
  | { state: 'applied'; ref: string }
  | { state: 'duplicate'; ref: string }
  | { state: 'failed'; code: string }

/** The managed-skill resource face the saga commits through; the ManagedStore implements it. */
export interface SkillSink {
  create(request: { opId: OpId; projectKey: string; name: string; body: string; catalogSummary: string }): Promise<SkillOutcome>
  patch(request: {
    opId: OpId
    projectKey: string
    name: string
    body: string
    catalogSummary: string
    expectRevisionId: string
  }): Promise<SkillOutcome>
  acknowledgeTerminalOps(skillId: string, opIds: readonly string[]): Promise<void>
}

/** The memory face the saga commits and finalizes through. */
export interface MemorySink {
  applyOps(scope: string, ops: readonly MemoryOpInput[]): Promise<MemoryApplyOutcome[]>
  acknowledgeTerminalOps(groups: readonly AckGroup[]): Promise<void>
}

export interface SagaDeps {
  readonly cursor: ReviewCursor
  readonly ledger: ReviewLedger
  readonly memory: MemorySink
  readonly skills: SkillSink
}

export interface SagaRequest {
  readonly attemptId: AttemptId
  readonly attemptNo: number
  readonly rangeId: RangeId
  readonly fromSeq: number
  readonly toSeq: number
  readonly budgetTokens: number
  readonly enabledScopes: readonly string[]
  readonly events: readonly ViewEvent[]
}

/** Injectable failure points on the finalization chain, for T67/T59 crash replays. */
export type CrashPoint = 'after-effective-through' | 'after-plan' | 'after-terminal' | 'after-ack' | 'after-advance'

export interface SagaHooks {
  /** The planner; invoked only on a fresh plan, never on a resumed one. */
  readonly buildPlan: (input: { attemptId: AttemptId; view: Projection }) => readonly PlanOp[]
  /** Canonical digest over the current memory + skill base state. */
  readonly baseStateDigest: () => string
  readonly crashAfter?: CrashPoint
}

export type SagaStatus = 'committed' | 'no-change' | 'rejected' | 'budget' | 'stale-base' | 'failed-op'

export interface SagaResult {
  readonly status: SagaStatus
  readonly disposition: RangeDisposition
  readonly admission: AdmissionResult
  readonly opStates: readonly ReviewOpState[]
}

/**
 * One whole attempt: plan (or stored-plan resume) → persisted effectiveThrough
 * (pre-planner) → base-state backfill → whole-plan admission → per-op commit
 * with derived opIds → terminal with disposition → finalization sequence.
 */
export async function runSaga(deps: SagaDeps, request: SagaRequest, hooks: SagaHooks): Promise<SagaResult> {
  const { attemptId } = request
  await deps.ledger.startPlanning({
    attemptId,
    attemptNo: request.attemptNo,
    rangeId: request.rangeId,
    fromSeq: request.fromSeq,
    toSeq: request.toSeq,
  })
  const inWindow = request.events.filter(event => event.seq >= request.fromSeq && event.seq <= request.toSeq)
  const view = projectLearningView(inWindow, request.budgetTokens)
  await deps.ledger.recordEffectiveThrough(attemptId, view.effectiveThrough)
  if (hooks.crashAfter === 'after-effective-through') throw new Error('crash-injected: after-effective-through')

  const plan = hooks.buildPlan({ attemptId, view })
  await deps.ledger.recordPlan(attemptId, plan)
  if (hooks.crashAfter === 'after-plan') throw new Error('crash-injected: after-plan')
  await deps.ledger.recordBaseState(attemptId, hooks.baseStateDigest())

  const admission = admitPlan(plan, { budgetTokens: request.budgetTokens, enabledScopes: request.enabledScopes })
  if (admission.kind === 'rejected') {
    if (admission.proposal !== undefined) await deps.ledger.recordProposal(attemptId, admission.proposal)
    if (admission.code === 'budget_exceeded') {
      await deps.ledger.markTerminal(attemptId, 'budget', 'superseded', admission.code)
      await finalizeTerminal(deps, attemptId)
      return { status: 'budget', disposition: 'superseded', admission, opStates: [] }
    }
    await deps.ledger.markTerminal(attemptId, 'rejected', 'retryable', admission.code)
    await finalizeTerminal(deps, attemptId)
    return { status: 'rejected', disposition: 'retryable', admission, opStates: [] }
  }

  const opStates: ReviewOpState[] = []
  let staleFailure = false
  for (const [index, op] of plan.entries()) {
    const opId = deriveOpId(attemptId, resourceKindOf(op), index, canonicalOpDigest(op))
    if (op.kind === 'memory') {
      const opInput = op.expectEntryId === undefined
        ? { opId, text: op.text }
        : { opId, text: op.text, expectEntryId: op.expectEntryId }
      let outcome: MemoryApplyOutcome | undefined
      try {
        outcome = (await deps.memory.applyOps(op.scope, [opInput]))[0]
      } catch (error: unknown) {
        if (String(error).includes('stale_base_revision')) {
          await deps.ledger.markOpState(attemptId, { opId, resource: 'memory', resourceRef: op.scope, state: 'failed' })
          staleFailure = true
          break
        }
        throw error
      }
      if (outcome === undefined) throw new Error('memory applyOps returned no outcome')
      const state: ReviewOpState = {
        opId,
        resource: 'memory',
        resourceRef: op.scope,
        state: outcome.state === 'applied' ? 'applied' : 'duplicate',
      }
      await deps.ledger.markOpState(attemptId, state)
      opStates.push(state)
      continue
    }
    if (op.kind === 'skill-create' || op.kind === 'skill-patch') {
      const outcome = op.kind === 'skill-create'
        ? await deps.skills.create({
          opId,
          projectKey: op.projectKey,
          name: op.name,
          body: op.body,
          catalogSummary: op.catalogSummary,
        })
        : await deps.skills.patch({
          opId,
          projectKey: op.projectKey,
          name: op.name,
          body: op.body,
          catalogSummary: op.catalogSummary,
          expectRevisionId: op.expectRevisionId,
        })
      if (outcome.state === 'failed') {
        await deps.ledger.markOpState(attemptId, { opId, resource: 'skill', resourceRef: skillRefOf(op), state: 'failed' })
        if (outcome.code === 'stale_base_revision') {
          staleFailure = true
          break
        }
        await deps.ledger.markTerminal(attemptId, 'failed-op', 'retryable', outcome.code)
        await finalizeTerminal(deps, attemptId)
        return { status: 'failed-op', disposition: 'retryable', admission, opStates }
      }
      const state: ReviewOpState = {
        opId,
        resource: 'skill',
        resourceRef: outcome.ref,
        state: outcome.state === 'applied' ? 'applied' : 'duplicate',
      }
      await deps.ledger.markOpState(attemptId, state)
      opStates.push(state)
      continue
    }
    throw new Error('unreachable: user-proposal op survived admission')
  }

  if (staleFailure) {
    await deps.ledger.markTerminal(attemptId, 'stale-base', 'superseded', 'stale_base_revision')
    await finalizeTerminal(deps, attemptId)
    return { status: 'stale-base', disposition: 'superseded', admission, opStates }
  }
  const status: SagaStatus = opStates.length === 0 ? 'no-change' : 'committed'
  await deps.ledger.markTerminal(attemptId, status, 'consumed')
  if (hooks.crashAfter === 'after-terminal') throw new Error('crash-injected: after-terminal')
  await finalizeTerminal(deps, attemptId, hooks.crashAfter === 'after-ack' || hooks.crashAfter === 'after-advance' ? { crashAfter: hooks.crashAfter } : {})
  return { status, disposition: 'consumed', admission, opStates }
}

function skillRefOf(op: Extract<PlanOp, { kind: 'skill-create' | 'skill-patch' }>): string {
  return `${op.projectKey}/${op.name}`
}

export interface FinalizeOptions {
  readonly crashAfter?: 'after-ack' | 'after-advance'
}

/**
 * Idempotent terminal finalization: ack applied-only receipts (memory by
 * scope, skill by ref) → advance (consumed only, monotonic) → markFinalized →
 * release in-flight. Every step is replay-safe, so recovery converges from
 * any crash point.
 */
export async function finalizeTerminal(deps: SagaDeps, attemptId: AttemptId, options: FinalizeOptions = {}): Promise<void> {
  const attempt = deps.ledger.get(attemptId)
  if (attempt === undefined || attempt.phase !== 'terminal' || attempt.finalized) return
  const ackable = attempt.opStates.filter(state => state.state === 'applied' || state.state === 'duplicate')
  const memoryGroups = new Map<string, string[]>()
  const skillGroups = new Map<string, string[]>()
  for (const state of ackable) {
    const groups = state.resource === 'memory' ? memoryGroups : skillGroups
    const opIds = groups.get(state.resourceRef) ?? []
    opIds.push(state.opId)
    groups.set(state.resourceRef, opIds)
  }
  for (const [scope, opIds] of memoryGroups) await deps.memory.acknowledgeTerminalOps([{ scope, opIds }])
  for (const [skillId, opIds] of skillGroups) await deps.skills.acknowledgeTerminalOps(skillId, opIds)
  if (options.crashAfter === 'after-ack') throw new Error('crash-injected: after-ack')
  if (attempt.rangeDisposition === 'consumed') {
    if (attempt.effectiveThrough === undefined) {
      throw new Error(`attempt ${attemptId} is consumed without a persisted effectiveThrough`)
    }
    await deps.cursor.advance(attempt.effectiveThrough)
    if (options.crashAfter === 'after-advance') throw new Error('crash-injected: after-advance')
  }
  await deps.ledger.markFinalized(attemptId)
  await deps.cursor.releaseInFlight(attemptId)
}

/**
 * Terminal recovery: replay every terminal attempt whose recovery obligations
 * are still open. Superseded/retryable/manual dispositions never advance the
 * high-water — the range is re-claimed by the next trigger (at-least-once).
 */
export async function recoverTerminal(deps: SagaDeps): Promise<number> {
  let replayed = 0
  for (const attempt of deps.ledger.unfinalizedTerminal()) {
    await finalizeTerminal(deps, attempt.attemptId)
    replayed += 1
  }
  return replayed
}
