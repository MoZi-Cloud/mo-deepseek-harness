/**
 * Type contracts of the memory capability (RC5.5 附件P1 §2). Values and
 * schemas live in `domain.ts`/`fold.ts`; this module is types only.
 *
 * The capability keeps per-scope durable state in one storage domain and
 * folds `HostMemoryOp` batches over it with pure functions. Receipts are
 * split in two: pending receipts (ops whose review attempt has not reached a
 * terminal state — never evicted) and the bounded recent-terminal ring (ops
 * acked terminal — the only region garbage collection may reclaim). Replay
 * detection consults pending ∪ ring before any base check, so crash/recovery
 * replays converge to `duplicate` instead of double-writing.
 *
 * @module @deepseek-ai/dsh-memory
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'

/**
 * Hash of the resolved project root (`sha256` over `ctx.fs.resolve(root)`
 * `targetKey`). The key is the full hash — never parsed back into a path.
 */
export type ProjectKey = Branded<'ProjectKey'>

/**
 * Identifier of one review-protocol mutation. Supplied by the session-review
 * saga's `deriveOpId` (pure derivation over attemptId/resourceKind/opIndex/
 * canonical-op-digest), so the same logical op carries the same id across
 * crash and recovery replays; this package never mints one.
 */
export type OpId = string

/** Logical scope of one memory state inside the single Service. */
export type MemoryScope =
  | { readonly kind: 'project'; readonly projectKey: ProjectKey }
  | { readonly kind: 'user' }

/** Record key of one scope's state in the memory domain's `state` table. */
export type MemoryScopeKey = Branded<'MemoryScopeKey'>

/** Stable entry identity, derived from the creating op's id. */
export type MemoryEntryId = Branded<'MemoryEntryId'>

/** One durable memory fact. */
export interface MemoryEntry {
  /** Derived from the `add` op's id, so replays resolve to the same entry. */
  readonly id: MemoryEntryId
  /** The fact's content; the scanned payload at both gates. */
  readonly content: string
  /** Free-form classifier the review planner may attach. */
  readonly kind?: string
  /** Provenance note (where in the session the fact came from). */
  readonly evidence?: string
  /** `now` of the creating op. */
  readonly createdAt: number
  /** `now` of the most recent applied op touching this entry. */
  readonly updatedAt: number
  /** Op id of the most recent applied mutation of this entry. */
  readonly lastAppliedOpId: OpId
}

/** Mutation action carried by a {@link HostMemoryOp}. */
export type MemoryOpAction = 'add' | 'update' | 'remove'

/**
 * One memory mutation with every host-authoritative field pre-allocated:
 * `opId` comes from the review saga, `entryId` is derived from it, and `now`
 * is the host clock. The fold never mints ids or reads the clock — that is
 * what keeps it pure and replays deterministic.
 */
export interface HostMemoryOp {
  readonly opId: OpId
  /** Target entry; derived from `opId` for `add` via `deriveEntryId`. */
  readonly entryId: MemoryEntryId
  readonly now: number
  readonly action: MemoryOpAction
  /** Content for `add`/`update`; absent on `remove`. */
  readonly content?: string
  readonly kind?: string
  readonly evidence?: string
}

/** One applied op's anti-replay record. */
export interface OpReceipt {
  readonly opId: OpId
  /** Digest recorded when the op first applied; duplicates return it. */
  readonly resultDigest: string
}

/**
 * Bounded FIFO window of terminal-acked receipts. The bound is
 * `MemoryConfig.receiptWindowSize`, enforced by `splitReceipts`; only this
 * region may evict.
 */
export type ReceiptRing = readonly OpReceipt[]

/** The receipt biseciton of one scope's anti-replay state. */
export interface AppliedOpReceipts {
  /** Ops applied but not yet acked terminal; never migrated or evicted (T52). */
  readonly pendingReceipts: readonly OpReceipt[]
  /** Terminal-acked ops, bounded FIFO; the only GC-eligible region. */
  readonly recentTerminalReceipts: ReceiptRing
}

/** One scope-grouped terminal acknowledgement (S1-5). */
export interface TerminalAckGroup {
  readonly scope: MemoryScope
  readonly opIds: readonly OpId[]
}

/** Full durable state of one scope. One record in the memory domain. */
export interface MemoryState {
  /** Record format version; a mismatching stored record is rejected. */
  readonly schemaVersion: 1
  /** State version; +1 per fold that applied at least one op. */
  readonly revision: number
  readonly entries: readonly MemoryEntry[]
  readonly appliedOps: AppliedOpReceipts
}

/** Per-op fold outcome. */
export interface ApplyOpResult {
  readonly opId: OpId
  readonly status: 'applied' | 'duplicate'
  /** Digest of the op's first application; duplicates carry the original. */
  readonly resultDigest?: string
}

/** One entry after the read-boundary scan: kept, or replaced by a placeholder. */
export type PublicationEntry =
  | { readonly kind: 'safe'; readonly entry: MemoryEntry }
  | { readonly kind: 'blocked'; readonly entryId: MemoryEntryId; readonly reason: string }

/** Per-scope publication coordinates inside a composite snapshot. */
export interface ScopePublication {
  readonly revision: number
  readonly digest: string
}

/**
 * The one model-visible memory message: a `snapshot`-form context carrying
 * every scope's section plus the composite digest. A single producer
 * republishes only when the digest changes.
 */
export interface CompositeMemorySnapshot {
  readonly kind: 'memory'
  readonly form: 'snapshot'
  readonly sections: readonly ContextSnapshotSection[]
  readonly scopes: { readonly project?: ScopePublication; readonly user?: ScopePublication }
  readonly digest: string
}

/** Memory budgets and switches. All numeric bounds are exact (equality passes). */
export interface MemoryConfig {
  /** Maximum entries per scope state. */
  readonly maxEntries: number
  /** Maximum total entry content characters per scope state. */
  readonly maxStoredChars: number
  /** Maximum content characters of one entry. */
  readonly maxEntryChars: number
  /** Maximum estimated tokens across one composite snapshot's sections. */
  readonly maxSnapshotTokens: number
  /** Whether the publisher pre-step runs at all. */
  readonly publisherEnabled: boolean
  /** Capacity of the recent-terminal receipt ring. */
  readonly receiptWindowSize: number
}
