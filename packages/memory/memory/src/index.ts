/**
 * Memory capability: per-scope durable recall with anti-replay receipts and a
 * sanitized, digest-gated composite snapshot publication. This module
 * re-exports the type surface, the domain declaration, and the pure fold
 * layer; the `MemoryService`/`MemoryPublisher` assembly mounts in the same
 * package (P1 批C).
 * @module @deepseek-ai/dsh-memory
 */

export {
  MEMORY_DOMAIN_NAME,
  MEMORY_DOMAIN_VERSION,
  MEMORY_STATE_SCHEMA_VERSION,
  MemoryError,
  asProjectKey,
  initialMemoryState,
  memoryDomain,
  memoryStateSchema,
  scopeKeyOf,
  type MemoryStateRecord,
  type MemoryErrorCode,
} from './domain.ts'

export {
  buildCompositeSnapshot,
  buildSnapshotSections,
  canonicalOpDigest,
  computeCompositeDigest,
  deriveEntryId,
  enforceBudget,
  foldMemoryOps,
  sanitizeForPublication,
  splitReceipts,
} from './fold.ts'

export type {
  AppliedOpReceipts,
  ApplyOpResult,
  CompositeMemorySnapshot,
  HostMemoryOp,
  MemoryConfig,
  MemoryEntry,
  MemoryEntryId,
  MemoryOpAction,
  MemoryScope,
  MemoryScopeKey,
  MemoryState,
  OpId,
  ProjectKey,
  PublicationEntry,
  ReceiptRing,
  ScopePublication,
  TerminalAckGroup,
} from './types.ts'
