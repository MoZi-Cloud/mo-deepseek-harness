/**
 * Evidence for the P1 fold-layer acceptance rows (`derive-*`, `budget-*`,
 * `fold-*`, `split-*` in `docs/mozi-fork/RC5.5-附件P1-memory.md` §3) plus the
 * domain declaration: deterministic ids, exact budgets, receipt-bisected
 * replay convergence, and the bounded terminal ring.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  asProjectKey,
  deriveEntryId,
  enforceBudget,
  foldMemoryOps,
  initialMemoryState,
  memoryDomain,
  MEMORY_DOMAIN_NAME,
  MEMORY_DOMAIN_VERSION,
  memoryStateSchema,
  MemoryError,
  scopeKeyOf,
  splitReceipts,
  canonicalOpDigest,
  type HostMemoryOp,
  type MemoryConfig,
  type MemoryState,
  type OpId,
} from '@deepseek-ai/dsh-memory'

const CONFIG: MemoryConfig = {
  maxEntries: 4,
  maxStoredChars: 200,
  maxEntryChars: 50,
  maxSnapshotTokens: 400,
  publisherEnabled: true,
  receiptWindowSize: 4,
}

/** Test-side cast for op ids minted in this file; production never mints one. */
function opId(raw: string): OpId {
  return raw as OpId
}

/** Host-authoritative op construction: entryId derived from opId, host clock. */
function op(rawOpId: string, action: HostMemoryOp['action'], fields: Partial<HostMemoryOp> = {}): HostMemoryOp {
  const id = opId(rawOpId)
  return { opId: id, entryId: deriveEntryId(id), now: 1_000, action, ...fields }
}

function folded(state: MemoryState, ops: HostMemoryOp[]): MemoryState {
  return foldMemoryOps(state, ops, CONFIG).nextState
}

describe('memory domain declaration', () => {
  it('declares the memory domain at version 1 with one state table', () => {
    expect(memoryDomain.name).toBe(MEMORY_DOMAIN_NAME)
    expect(memoryDomain.version).toBe(MEMORY_DOMAIN_VERSION)
    expect(Object.keys(memoryDomain.tables)).toEqual(['state'])
  })

  it('maps scope to key without parsing the key back', () => {
    const projectKey = asProjectKey('a'.repeat(64))
    expect(scopeKeyOf({ kind: 'project', projectKey })).toBe(`project/${projectKey}`)
    expect(scopeKeyOf({ kind: 'user' })).toBe('user')
  })

  it('serves a fresh empty state and validates a folded state round-trip', () => {
    const state = folded(initialMemoryState(), [op('op-1', 'add', { content: 'Uses pnpm.' })])
    expect(state.revision).toBe(1)
    expect(memoryStateSchema.parse(state)).toEqual(state)
    expect(() => memoryStateSchema.parse({ ...state, schemaVersion: 2 })).toThrow()
  })
})

describe('deriveEntryId', () => {
  it('derive-deterministic: the same op id derives the same entry id', () => {
    expect(deriveEntryId(opId('op-1'))).toBe(deriveEntryId(opId('op-1')))
  })

  it('derive-distinct-ops-distinct-ids: distinct op ids derive distinct entry ids', () => {
    expect(deriveEntryId(opId('op-1'))).not.toBe(deriveEntryId(opId('op-2')))
  })
})

describe('enforceBudget', () => {
  it('budget-exact-limit: a state at exactly every bound passes', () => {
    const state = folded(initialMemoryState(), [op('op-1', 'add', { content: 'x'.repeat(50) })])
    expect(() => { enforceBudget(state, { ...CONFIG, maxEntries: 1, maxStoredChars: 50, maxEntryChars: 50 }) }).not.toThrow()
  })

  it('budget-entry-chars: one entry over maxEntryChars fails with the entry inventory', () => {
    const state: MemoryState = {
      ...initialMemoryState(),
      entries: [{
        id: deriveEntryId(opId('op-1')),
        content: 'x'.repeat(51),
        createdAt: 1_000,
        updatedAt: 1_000,
        lastAppliedOpId: opId('op-1'),
      }],
    }
    expect(() => { enforceBudget(state, CONFIG) }).toThrow(MemoryError)
    expect(() => { enforceBudget(state, CONFIG) }).toThrow(/holds 51 chars over maxEntryChars 50/)
  })

  it('budget-add-over-limit: entries over maxEntries fail with the full inventory', () => {
    const ops = [1, 2, 3, 4, 5].map(n => op(`op-${n}`, 'add', { content: 'fact' }))
    expect(() => folded(initialMemoryState(), ops)).toThrow(/entries 5\/4, storedChars 20\/200/)
  })

  it('budget-remove-exempt: removal is admitted at the entry bound', () => {
    const state = folded(initialMemoryState(), [1, 2, 3, 4].map(n => op(`op-${n}`, 'add', { content: 'fact' })))
    expect(() => { enforceBudget(state, CONFIG) }).not.toThrow()
    const removed = folded(state, [op('op-5', 'remove', { entryId: deriveEntryId(opId('op-1')) })])
    expect(removed.entries).toHaveLength(3)
    expect(() => { enforceBudget(removed, CONFIG) }).not.toThrow()
  })

  it('budget-inventory-in-error: the rejection names current and maximum for every exceeded bound', () => {
    const ops = [1, 2, 3].map(n => op(`op-${n}`, 'add', { content: 'x'.repeat(40) }))
    const config = { ...CONFIG, maxStoredChars: 100 }
    try {
      foldMemoryOps(initialMemoryState(), ops, config)
      expect.unreachable('fold should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryError)
      expect((error as MemoryError).code).toBe('budget_exceeded')
      expect((error as MemoryError).message).toContain('storedChars 120/100')
    }
  })
})

describe('foldMemoryOps', () => {
  it('fold-add-update-remove: applies the three actions in one batch', () => {
    const target = { entryId: deriveEntryId(opId('op-1')) }
    const first = folded(initialMemoryState(), [
      op('op-1', 'add', { content: 'v1', kind: 'tooling', evidence: 'session 1' }),
      op('op-2', 'update', { ...target, content: 'v2', kind: 'process', evidence: 'session 2' }),
    ])
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]).toEqual({
      id: deriveEntryId(opId('op-1')),
      content: 'v2',
      kind: 'process',
      evidence: 'session 2',
      createdAt: 1_000,
      updatedAt: 1_000,
      lastAppliedOpId: opId('op-2'),
    })
    expect(first.revision).toBe(1)

    const second = folded(first, [op('op-3', 'remove', target)])
    expect(second.entries).toHaveLength(0)
    expect(second.revision).toBe(2)
  })

  it('fold-new-op-goes-pending: every newly applied op lands in pendingReceipts first', () => {
    const state = folded(initialMemoryState(), [op('op-1', 'add', { content: 'fact' })])
    expect(state.appliedOps.pendingReceipts).toEqual([
      { opId: opId('op-1'), resultDigest: canonicalOpDigest(op('op-1', 'add', { content: 'fact' })) },
    ])
    expect(state.appliedOps.recentTerminalReceipts).toEqual([])
  })

  it('fold-duplicate-before-base-check: a replayed op is a duplicate even when its entry is gone', () => {
    const target = { entryId: deriveEntryId(opId('op-1')) }
    const state = folded(initialMemoryState(), [
      op('op-1', 'add', { content: 'fact' }),
      op('op-2', 'update', { ...target, content: 'fact v2' }),
      op('op-3', 'remove', target),
    ])
    expect(state.entries).toHaveLength(0)

    const { results, nextState } = foldMemoryOps(state, [op('op-2', 'update', { ...target, content: 'fact v2' })], CONFIG)
    expect(results).toEqual([
      { opId: opId('op-2'), status: 'duplicate', resultDigest: canonicalOpDigest(op('op-2', 'update', { ...target, content: 'fact v2' })) },
    ])
    expect(nextState).toEqual(state)
  })

  it('returns the originally recorded digest even when the replayed op differs', () => {
    let state = folded(initialMemoryState(), [op('op-1', 'add', { content: 'original' })])
    const originalDigest = canonicalOpDigest(op('op-1', 'add', { content: 'original' }))
    state = folded(state, [op('op-2', 'add', { content: 'other' })])

    const replayed = foldMemoryOps(state, [op('op-1', 'add', { content: 'original' })], CONFIG)
    expect(replayed.results[0]).toEqual({ opId: opId('op-1'), status: 'duplicate', resultDigest: originalDigest })
  })

  it('detects duplicates through the terminal ring after an ack', () => {
    const state = folded(initialMemoryState(), [op('op-1', 'add', { content: 'fact' })])
    const acked: MemoryState = {
      ...state,
      appliedOps: splitReceipts(state.appliedOps, [opId('op-1')], CONFIG.receiptWindowSize),
    }
    const replayed = foldMemoryOps(acked, [op('op-1', 'add', { content: 'fact' })], CONFIG)
    expect(replayed.results[0]).toEqual({
      opId: opId('op-1'),
      status: 'duplicate',
      resultDigest: canonicalOpDigest(op('op-1', 'add', { content: 'fact' })),
    })
  })

  it('an add without content stores empty content; an update without fields keeps prior values', () => {
    const state = folded(initialMemoryState(), [
      op('op-1', 'add', { kind: 'tooling', evidence: 'session 1' }),
      op('op-2', 'update', { entryId: deriveEntryId(opId('op-1')), now: 2_000 }),
    ])
    expect(state.entries[0]).toEqual({
      id: deriveEntryId(opId('op-1')),
      content: '',
      kind: 'tooling',
      evidence: 'session 1',
      createdAt: 1_000,
      updatedAt: 2_000,
      lastAppliedOpId: opId('op-2'),
    })
  })

  it('keeps the revision unchanged when a fold applies nothing', () => {
    const state = folded(initialMemoryState(), [op('op-1', 'add', { content: 'fact' })])
    const replayed = foldMemoryOps(state, [op('op-1', 'add', { content: 'fact' })], CONFIG)
    expect(replayed.nextState.revision).toBe(state.revision)
  })

  it('fold-unknown-entry-rejects: update and remove against an unknown entry fail loud', () => {
    expect(() => folded(initialMemoryState(), [op('op-1', 'update', { content: 'v2' })]))
      .toThrow(/update op-1 targets unknown entry/)
    expect(() => folded(initialMemoryState(), [op('op-1', 'remove')]))
      .toThrow(/remove op-1 targets unknown entry/)
    try {
      folded(initialMemoryState(), [op('op-1', 'update')])
      expect.unreachable('fold should have thrown')
    } catch (error) {
      expect((error as MemoryError).code).toBe('invalid_structure')
    }
  })

  it('rejects an add whose derived entry already exists', () => {
    const state = folded(initialMemoryState(), [op('op-1', 'add', { content: 'fact' })])
    expect(() => folded(state, [op('op-9', 'add', { entryId: deriveEntryId(opId('op-1')), content: 'fact' })]))
      .toThrow(/add op-9 collides with existing entry/)
  })

  it('fold-budget-integration-batch: a batch member over budget rejects the whole fold and mutates nothing', () => {
    const state = initialMemoryState()
    const ops = [
      op('op-1', 'add', { content: 'small fact' }),
      op('op-2', 'add', { content: 'x'.repeat(60) }),
    ]
    expect(() => foldMemoryOps(state, ops, CONFIG)).toThrow(/holds 60 chars/)
    expect(state.entries).toHaveLength(0)
    expect(state.appliedOps.pendingReceipts).toHaveLength(0)
  })
})

describe('splitReceipts', () => {
  it('split-ack-moves-to-ring: a terminal ack migrates the pending receipt into the ring', () => {
    const state = folded(initialMemoryState(), [op('op-1', 'add', { content: 'fact' })])
    const split = splitReceipts(state.appliedOps, [opId('op-1')], CONFIG.receiptWindowSize)
    expect(split.pendingReceipts).toEqual([])
    expect(split.recentTerminalReceipts).toEqual(state.appliedOps.pendingReceipts)
  })

  it('split-reack-idempotent: re-acking terminal op ids is a no-op (T58)', () => {
    const state = folded(initialMemoryState(), [op('op-1', 'add', { content: 'fact' })])
    const once = splitReceipts(state.appliedOps, [opId('op-1')], CONFIG.receiptWindowSize)
    const twice = splitReceipts(once, [opId('op-1')], CONFIG.receiptWindowSize)
    expect(twice).toEqual(once)
  })

  it('split-pending-never-evicted: un-acked pending receipts survive any number of acks (T52)', () => {
    const state = folded(initialMemoryState(), [
      op('op-1', 'add', { content: 'fact' }),
      op('op-2', 'add', { content: 'fact' }),
    ])
    let appliedOps = state.appliedOps
    for (let round = 0; round < 5; round += 1) {
      appliedOps = splitReceipts(appliedOps, [opId('op-2')], CONFIG.receiptWindowSize)
    }
    expect(appliedOps.pendingReceipts.map(receipt => receipt.opId)).toEqual([opId('op-1')])
    expect(appliedOps.recentTerminalReceipts.map(receipt => receipt.opId)).toEqual([opId('op-2')])
  })

  it('split-ring-evicts-oldest: the ring FIFO-evicts beyond the window', () => {
    const state = folded(initialMemoryState(), [
      op('op-1', 'add', { content: 'fact' }),
      op('op-2', 'add', { content: 'fact' }),
      op('op-3', 'add', { content: 'fact' }),
    ])
    const split = splitReceipts(state.appliedOps, [opId('op-1'), opId('op-2'), opId('op-3')], 2)
    expect(split.recentTerminalReceipts.map(receipt => receipt.opId)).toEqual([opId('op-2'), opId('op-3')])
    expect(split.pendingReceipts).toEqual([])
  })

  it('split-10k-mutations-bounded-ring: ten thousand mutations leave a bounded record', () => {
    const pendingReceipts = Array.from({ length: 10_000 }, (_, index) => ({
      opId: opId(`op-${index}`),
      resultDigest: `digest-${index}`,
    }))
    const opIds: OpId[] = pendingReceipts.map(receipt => receipt.opId)
    const split = splitReceipts({ pendingReceipts, recentTerminalReceipts: [] }, opIds, 4)
    expect(split.pendingReceipts).toEqual([])
    expect(split.recentTerminalReceipts).toHaveLength(4)
    expect(split.recentTerminalReceipts[0]).toEqual({ opId: opId('op-9996'), resultDigest: 'digest-9996' })
  })

  it('split-orphan-opid-fails: an ack naming an unknown op fails loud', () => {
    expect(() => splitReceipts(initialMemoryState().appliedOps, [opId('op-unknown')], CONFIG.receiptWindowSize))
      .toThrow(/terminal ack names op op-unknown/)
    try {
      splitReceipts(initialMemoryState().appliedOps, [opId('op-unknown')], CONFIG.receiptWindowSize)
      expect.unreachable('split should have thrown')
    } catch (error) {
      expect((error as MemoryError).code).toBe('invalid_structure')
    }
  })

  it('fails loud on a non-positive window size', () => {
    expect(() => splitReceipts(initialMemoryState().appliedOps, [], 0))
      .toThrow(/window size must be a positive integer, got 0/)
  })
})
