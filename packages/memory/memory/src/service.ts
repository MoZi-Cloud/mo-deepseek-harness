/**
 * The memory capability's runtime assembly: a single Cordis Service owning
 * the memory domain (T42) and a pure scope resolver over the mounted
 * filesystem. The Service is the only opener of the memory domain; the
 * publisher (in `publisher.ts`) composes on top of it.
 * @module @deepseek-ai/dsh-memory/src/service
 */

import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scanContent } from '@deepseek-ai/dsh-content-scan'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { asProjectKey, MemoryError, initialMemoryState, memoryDomain, scopeKeyOf } from './domain.ts'
import type { MemoryStateRecord } from './domain.ts'
import {
  foldMemoryOps,
  splitReceipts,
} from './fold.ts'
import type {
  ApplyOpResult,
  CompositeMemorySnapshot,
  HostMemoryOp,
  MemoryConfig,
  MemoryEntryId,
  MemoryScope,
  MemoryScopeKey,
  MemoryState,
  OpId,
  TerminalAckGroup,
} from './types.ts'

/** Result of a single `applyOps` batch: the committed next state and per-op outcomes. */
export interface ApplyOpsResult {
  readonly nextState: MemoryState
  readonly results: readonly ApplyOpResult[]
}

/**
 * Memory budgets and switches. All numeric bounds are exact (equality passes).
 */
export interface Config {
  /** Maximum entries per scope state. */
  readonly maxEntries: number
  /** Maximum total entry content characters per scope state. */
  readonly maxStoredChars: number
  /** Maximum content characters of one entry. */
  readonly maxEntryChars: number
  /** Maximum estimated tokens across one composite snapshot's sections. */
  readonly maxSnapshotTokens: number
  /** Whether the publisher pre-step runs at all. Defaults to `true`. */
  readonly publisherEnabled?: boolean
  /** Capacity of the recent-terminal receipt ring. */
  readonly receiptWindowSize: number
}

/** Schemastery config schema for the memory service. */
export const ConfigSchema: z<Config> = z.object({
  maxEntries: z.number().step(1).min(1).required(),
  maxStoredChars: z.number().step(1).min(1).required(),
  maxEntryChars: z.number().step(1).min(1).required(),
  maxSnapshotTokens: z.number().step(1).min(1).required(),
  publisherEnabled: z.boolean().default(true),
  receiptWindowSize: z.number().step(1).min(1).required(),
})

/**
 * Resolve the memory scope for an agent. The project branch walks up from
 * the session cwd to the nearest `.git` ancestor and hashes the resolved
 * target key; the user branch is a process-wide singleton.
 * @param agent - The agent whose session cwd bounds the project lookup.
 * @param fs - The mounted filesystem; `undefined` uses node:fs fallback.
 * @returns the resolved scope.
 */
export async function resolveMemoryScope(agent: Agent, fs: FileSystem | undefined): Promise<MemoryScope> {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) return { kind: 'user' }
  const root = await findProjectRoot(cwd, fs)
  if (fs !== undefined) {
    const target = await fs.resolve(root)
    return { kind: 'project', projectKey: asProjectKey(sha256Hex(String(target.targetKey))) }
  }
  return { kind: 'project', projectKey: asProjectKey(sha256Hex(root)) }
}

/**
 * Walk up from `cwd` to the nearest directory containing `.git`.
 * @param cwd - The starting directory.
 * @param fs - The mounted filesystem; `undefined` uses node:fs.
 * @returns the project root path.
 */
async function findProjectRoot(cwd: string, fs: FileSystem | undefined): Promise<string> {
  let current = cwd
  while (true) {
    if (await pathExists(join(current, '.git'), fs)) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

/**
 * Check whether a path exists, using the mounted fs when available.
 * @param path - The absolute path to probe.
 * @param fs - The mounted filesystem; `undefined` uses node:fs.
 * @returns whether the path exists.
 */
async function pathExists(path: string, fs: FileSystem | undefined): Promise<boolean> {
  if (fs !== undefined) {
    try {
      const target = await fs.resolve(path)
      return await fs.stat(target) !== undefined
    } catch {
      return false
    }
  }
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** SHA-256 hex digest over a UTF-8 string. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * The single memory-domain Service. One instance per application (T42);
 * it serves every logical scope through the same domain tables.
 */
export class MemoryService extends Service {
  static inject = ['storageDomain']
  static Config = ConfigSchema

  private table?: KvTable<MemoryScopeKey, MemoryStateRecord>
  private readonly config: MemoryConfig

  constructor(ctx: Context, config: Config) {
    super(ctx, 'memory')
    this.config = {
      maxEntries: config.maxEntries,
      maxStoredChars: config.maxStoredChars,
      maxEntryChars: config.maxEntryChars,
      maxSnapshotTokens: config.maxSnapshotTokens,
      publisherEnabled: config.publisherEnabled ?? true,
      receiptWindowSize: config.receiptWindowSize,
    }
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(memoryDomain)
    this.ctx.effect(() => async () => {
      await domain.close()
    }, 'memory.domainClose')
    this.table = domain.table('state')
  }

  /**
   * Read the current state of one scope. Missing records return the empty
   * initial state without creating a record.
   * @param scope - The project or user scope to read.
   * @returns the current memory state.
   */
  // oxlint-disable-next-line typescript/require-await -- async keeps an uninitialized Service access as a rejected provider call.
  async getState(scope: MemoryScope): Promise<MemoryState> {
    const record = this.requireTable().get(scopeKeyOf(scope))
    if (record === undefined) return initialMemoryState()
    return toState(record)
  }

  /**
   * Apply a batch of ops to one scope in a single RMW closure. Receipt
   * deduplication runs before the base-revision check; a blocked write
   * rejects the whole batch. The new state is committed atomically.
   * @param scope - The target scope.
   * @param ops - The ops to apply, in order.
   * @param expectedBaseRevision - The revision the caller observed; a mismatch rejects the batch.
   * @returns the committed next state and per-op results.
   */
  async applyOps(
    scope: MemoryScope,
    ops: readonly HostMemoryOp[],
    expectedBaseRevision?: number,
  ): Promise<ApplyOpsResult> {
    const table = this.requireTable()
    const key = scopeKeyOf(scope)
    const current = table.get(key)
    const state = current === undefined ? initialMemoryState() : toState(current)
    const { nextState, results } = foldMemoryOps(state, ops, this.config)
    const allDuplicates = results.every(r => r.status === 'duplicate')
    if (!allDuplicates && expectedBaseRevision !== undefined && state.revision !== expectedBaseRevision) {
      throw new MemoryError(
        'stale_base_revision',
        `expected base revision ${expectedBaseRevision}, found ${state.revision}`,
      )
    }
    for (const result of results) {
      if (result.status !== 'applied') continue
      const op = ops.find(o => o.opId === result.opId)
      if (op === undefined || op.content === undefined) continue
      const blocked = scanContent(op.content, 'memory').find(f => f.severity === 'blocked')
      if (blocked !== undefined) {
        throw new MemoryError(
          'threat_scan_blocked',
          `entry ${op.entryId} blocked by ${blocked.patternId} (${blocked.category})`,
        )
      }
    }
    if (allDuplicates) {
      return { nextState: state, results }
    }
    await table.put(key, toRecord(nextState))
    return { nextState, results }
  }

  /**
   * Acknowledge terminal ops in one or more scope groups. Idempotent: ops
   * already in the ring are no-ops; ops in neither pending nor ring reject
   * the whole call with `invalid_structure`.
   * @param groups - One or more scope-grouped ack batches.
   */
  async acknowledgeTerminalOps(groups: readonly TerminalAckGroup[]): Promise<void> {
    const table = this.requireTable()
    for (const group of groups) {
      const key = scopeKeyOf(group.scope)
      const record = table.get(key)
      if (record === undefined) {
        throw new MemoryError('invalid_structure', `no memory state for scope ${group.scope.kind} to acknowledge`)
      }
      const state = toState(record)
      const nextReceipts = splitReceipts(state.appliedOps, group.opIds, this.config.receiptWindowSize)
      await table.put(key, toRecord({ ...state, appliedOps: nextReceipts }))
    }
  }

  private requireTable(): KvTable<MemoryScopeKey, MemoryStateRecord> {
    if (this.table === undefined) throw new Error('memory domain not initialized')
    return this.table
  }
}

/**
 * Scan the session event log in reverse for the latest published memory
 * snapshot. Returns `undefined` when no memory snapshot has been published.
 * @param session - The session to scan.
 * @returns the digest and seq of the latest memory snapshot, or `undefined`.
 */
export function latestPublishedMemory(session: Session): { digest: string; seq: number } | undefined {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type !== 'user/message') continue
    const data = event.data as { source?: { kind?: string } }
    if (data.source?.kind !== 'memory') continue
    const snapshot = data.source as unknown as CompositeMemorySnapshot
    return { digest: snapshot.digest, seq: event.seq }
  }
  return undefined
}

/**
 * Cast a durable record into the branded in-memory state. The cast is safe
 * because the durable boundary validated the record against the zod schema.
 * @param record - The validated durable record.
 * @returns the branded in-memory state.
 */
function toState(record: MemoryStateRecord): MemoryState {
  return {
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    entries: record.entries.map(e => ({
      id: e.id as MemoryEntryId,
      content: e.content,
      ...(e.kind === undefined ? {} : { kind: e.kind }),
      ...(e.evidence === undefined ? {} : { evidence: e.evidence }),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      lastAppliedOpId: e.lastAppliedOpId as OpId,
    })),
    appliedOps: {
      pendingReceipts: record.appliedOps.pendingReceipts.map(r => ({
        opId: r.opId as OpId,
        resultDigest: r.resultDigest,
      })),
      recentTerminalReceipts: record.appliedOps.recentTerminalReceipts.map(r => ({
        opId: r.opId as OpId,
        resultDigest: r.resultDigest,
      })),
    },
  }
}

/**
 * Cast a branded in-memory state into the durable record form. Branded
 * strings are plain strings at runtime, so this is a structural identity
 * map with no runtime work.
 * @param state - The in-memory state to persist.
 * @returns the durable record.
 */
function toRecord(state: MemoryState): MemoryStateRecord {
  return {
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    entries: state.entries.map(e => ({
      id: e.id,
      content: e.content,
      ...(e.kind === undefined ? {} : { kind: e.kind }),
      ...(e.evidence === undefined ? {} : { evidence: e.evidence }),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      lastAppliedOpId: e.lastAppliedOpId,
    })),
    appliedOps: {
      pendingReceipts: state.appliedOps.pendingReceipts.map(r => ({ opId: r.opId, resultDigest: r.resultDigest })),
      recentTerminalReceipts: state.appliedOps.recentTerminalReceipts.map(r => ({ opId: r.opId, resultDigest: r.resultDigest })),
    },
  }
}
