/**
 * The memory domain declaration and the value vocabulary the fold layer and
 * (later) the Service share: the typed error, the zod record schemas that
 * validate state at the durable boundary, and the scope-to-key mapping. The
 * spec is the single source of the domain's identity and layout; `defineDomain`
 * fails loud at module load on a malformed declaration.
 * @module @deepseek-ai/dsh-memory/src/domain
 */

import { z } from 'zod'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryScope, MemoryScopeKey, MemoryState, ProjectKey } from './types.ts'

/** Storage domain name; doubles as the backend unit name. */
export const MEMORY_DOMAIN_NAME = 'memory'

/** Domain format version; a medium stamped with another version rejects at open. */
export const MEMORY_DOMAIN_VERSION = 1

/** Record-level format version inside each state record. */
export const MEMORY_STATE_SCHEMA_VERSION = 1

/** Error codes the memory capability throws. */
export type MemoryErrorCode = 'budget_exceeded' | 'invalid_structure'

/** Typed error carrying a stable code the callers (and tests) branch on. */
export class MemoryError extends Error {
  /** Stable error category for caller branching. */
  readonly code: MemoryErrorCode

  constructor(code: MemoryErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'MemoryError'
    this.code = code
  }
}

const opReceiptSchema = z.object({
  opId: z.string(),
  resultDigest: z.string(),
})

const memoryEntrySchema = z.object({
  id: z.string(),
  content: z.string(),
  kind: z.string().optional(),
  evidence: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastAppliedOpId: z.string(),
})

/** zod schema validating every stored state record at the durable boundary. */
export const memoryStateSchema = z.object({
  schemaVersion: z.literal(MEMORY_STATE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  entries: z.array(memoryEntrySchema),
  appliedOps: z.object({
    pendingReceipts: z.array(opReceiptSchema),
    recentTerminalReceipts: z.array(opReceiptSchema),
  }),
})

/** Inferred durable record type validated by {@link memoryStateSchema}. */
export type MemoryStateRecord = z.infer<typeof memoryStateSchema>

/**
 * The memory domain: one `state` table holding one record per scope key.
 * `layout` stays `single` — the two scope records are small bounded documents.
 */
export const memoryDomain = defineDomain({
  name: MEMORY_DOMAIN_NAME,
  version: MEMORY_DOMAIN_VERSION,
  tables: {
    state: domainTable<MemoryScopeKey, MemoryStateRecord>(memoryStateSchema),
  },
})

/**
 * Fresh empty state for one scope, as served before the first write.
 * @returns a versioned empty memory state.
 */
export function initialMemoryState(): MemoryState {
  return {
    schemaVersion: MEMORY_STATE_SCHEMA_VERSION,
    revision: 0,
    entries: [],
    appliedOps: { pendingReceipts: [], recentTerminalReceipts: [] },
  }
}

/**
 * Map a scope to its state-record key. The project branch embeds the project
 * key hash so distinct roots never share a record; the user scope is a single
 * process-wide record.
 * @param scope - The project or user scope to map.
 * @returns the durable record key for the scope.
 */
export function scopeKeyOf(scope: MemoryScope): MemoryScopeKey {
  const key = scope.kind === 'project' ? `project/${scope.projectKey}` : 'user'
  return key as MemoryScopeKey
}

/**
 * Cast a resolved-and-hashed root digest into a {@link ProjectKey}. The
 * caller owns hashing (`sha256` over the fs resolution `targetKey`); this is
 * the only construction site.
 * @param digest - The already computed project-root digest.
 * @returns the branded project key.
 */
export function asProjectKey(digest: string): ProjectKey {
  return digest as ProjectKey
}
