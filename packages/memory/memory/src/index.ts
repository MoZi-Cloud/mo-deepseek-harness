/**
 * Memory capability: per-scope durable recall with anti-replay receipts and a
 * sanitized, digest-gated composite snapshot publication. Exports the type
 * surface, the domain declaration, the pure fold layer, the `MemoryService`
 * (sole memory-domain opener, T42), and the `MemoryPublisher` pre-step
 * registration.
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

export {
  ConfigSchema,
  latestPublishedMemory,
  MemoryService,
  resolveMemoryScope,
  type ApplyOpsResult,
  type Config,
} from './service.ts'

export {
  registerMemoryPublisher,
} from './publisher.ts'

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

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory': import('./types.ts').CompositeMemorySnapshot
  }
}
