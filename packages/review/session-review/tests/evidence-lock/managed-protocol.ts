/**
 * Evidence Lock batch 4 — in-test reference implementation of the managed
 * skill protocol (name index, record CAS, pending revisions, completion-marker
 * bundle writes, receipt sets). Test-tree only: it exercises the real domain
 * tables and the real `ctx.fs` (twelve primitives, no move/delete) without
 * registering any production behavior; the future P2 package must
 * re-implement these contracts. Nothing in `src/` may import this file.
 * @module evidence-lock/managed-protocol
 */

import { join } from 'node:path'
import { z } from 'zod'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SkillOutcome } from './review-protocol.ts'
import { sha256, TERMINAL_RING_CAPACITY } from './review-protocol.ts'

export const MANAGED_PROVIDER_NAME = 'self-evolution-managed'
/** Managed candidates sit below every human-authored rank inside one layer. */
export const MANAGED_RANK = 700

export const reservationSchema = z.object({
  reserved: z.boolean(),
  skillId: z.string(),
  reservedByOpId: z.string(),
})
export type ReservationRecord = z.infer<typeof reservationSchema>

export const managedRecordSchema = z.object({
  skillId: z.string(),
  projectKey: z.string(),
  name: z.string(),
  status: z.enum(['draft', 'active', 'stale', 'rejected', 'archived']),
  currentRevision: z.object({ revisionId: z.string(), contentDigest: z.string() }).optional(),
  catalogSummary: z.string().optional(),
  pendingRevision: z.object({
    revisionId: z.string(),
    contentDigest: z.string(),
    catalogSummary: z.string(),
    createdByOpId: z.string(),
  }).optional(),
  receipts: z.array(z.object({ opId: z.string(), revisionId: z.string(), outcome: z.enum(['applied', 'duplicate']) })),
  terminalRing: z.array(z.object({ opId: z.string(), revisionId: z.string(), outcome: z.enum(['applied', 'duplicate']) })),
})
export type ManagedRecord = z.infer<typeof managedRecordSchema>

/** Sidecar candidate: the catalog facts live in the domain record, never in bundle files. */
export interface ManagedCandidate {
  readonly name: string
  readonly skillId: string
  readonly projectKey: string
  readonly description: string
  readonly revisionId: string
}

/** Deterministic identity: the same project and name always derive the same skillId. */
export function deriveSkillId(projectKey: string, name: string): string {
  return sha256(`skill\u0000${projectKey}\u0000${name}`)
}

/** The revision path derives from the requesting op — concurrent ops never share a directory. */
export function revisionIdFor(skillId: string, requestedByOpId: string): string {
  return sha256(`revision\u0000${skillId}\u0000${requestedByOpId}`)
}

/** The name-index storage key carries the projectKey, isolating projects at the key level. */
export function nameIndexKey(projectKey: string, name: string): string {
  return `${projectKey}\u0000${name}`
}

export type ReserveOutcome =
  | { kind: 'reserved' | 'held'; skillId: string }
  | { kind: 'name_conflict' }

export class ManagedStore {
  constructor(
    private readonly nameIndex: KvTable<string, ReservationRecord>,
    private readonly records: KvTable<string, ManagedRecord>,
    private readonly fs: FileSystem,
    private readonly bundleRoot: string,
  ) {}

  record(skillId: string): ManagedRecord | undefined {
    return this.records.get(skillId)
  }

  allRecords(): ManagedRecord[] {
    return [...this.records.entries()].map(([, record]) => record)
  }

  /** Provider-visible lineage is `active | stale` only; drafts, rejected, and archived stay private. */
  candidates(projectKey: string): ManagedCandidate[] {
    return this.allRecords()
      .filter(record => record.projectKey === projectKey)
      .filter(record => record.status === 'active' || record.status === 'stale')
      .filter(record => record.currentRevision !== undefined)
      .map(record => ({
        name: record.name,
        skillId: record.skillId,
        projectKey: record.projectKey,
        description: record.catalogSummary ?? '',
        revisionId: record.currentRevision?.revisionId ?? '',
      }))
  }

  /**
   * Single-RMW name reservation on the domain write chain. The T24
   * initialization protocol (get→put(empty)→update) makes the first reserve
   * of a brand-new project safe under concurrency: the put is idempotent,
   * the serialized update picks exactly one winner.
   */
  async reserveName(projectKey: string, name: string, opId: string): Promise<ReserveOutcome> {
    const skillId = deriveSkillId(projectKey, name)
    const key = nameIndexKey(projectKey, name)
    if (this.nameIndex.get(key) === undefined) {
      await this.nameIndex.put(key, { reserved: false, skillId: '', reservedByOpId: '' })
    }
    let outcome: ReserveOutcome = { kind: 'name_conflict' }
    await this.nameIndex.update(key, (cur) => {
      if (!cur.reserved) {
        outcome = { kind: 'reserved', skillId }
        return { reserved: true, skillId, reservedByOpId: opId }
      }
      if (cur.reservedByOpId === opId) {
        outcome = { kind: 'held', skillId: cur.skillId }
        return cur
      }
      outcome = { kind: 'name_conflict' }
      return cur
    })
    return outcome
  }

  /**
   * Crash reconciliation: a reservation with no record and no applied receipt
   * is an orphan from an interrupted create and is released for the next op.
   */
  async reconcileReservation(projectKey: string, name: string): Promise<boolean> {
    const key = nameIndexKey(projectKey, name)
    const cur = this.nameIndex.get(key)
    if (cur === undefined || !cur.reserved) return false
    const record = this.records.get(cur.skillId)
    const applied = record?.receipts.some(receipt => receipt.outcome === 'applied') ?? false
    if (record !== undefined && applied) return false
    await this.nameIndex.update(key, () => ({ reserved: false, skillId: '', reservedByOpId: '' }))
    return true
  }

  /**
   * Create: receipt check first (record-CAS crash replays are duplicates, not
   * name conflicts), then reservation, then a full idempotent bundle write,
   * then the record CAS.
   */
  async createSkill(request: {
    opId: string
    projectKey: string
    name: string
    body: string
    catalogSummary: string
  }): Promise<SkillOutcome> {
    const skillId = deriveSkillId(request.projectKey, request.name)
    const existing = this.records.get(skillId)
    const known = (revisions: ManagedRecord['receipts']): boolean => revisions.some(receipt => receipt.opId === request.opId)
    if (existing !== undefined && (known(existing.receipts) || known(existing.terminalRing))) {
      return { state: 'duplicate', ref: skillId }
    }
    const reservation = await this.reserveName(request.projectKey, request.name, request.opId)
    if (reservation.kind === 'name_conflict') return { state: 'failed', code: 'name_conflict' }
    const revisionId = revisionIdFor(skillId, request.opId)
    const contentDigest = await this.writeRevision(skillId, revisionId, request.body)
    if (this.records.get(skillId) === undefined) {
      await this.records.put(skillId, {
        skillId,
        projectKey: request.projectKey,
        name: request.name,
        status: 'draft',
        receipts: [],
        terminalRing: [],
      })
    }
    let duplicate = false
    await this.records.update(skillId, (cur) => {
      if (cur.receipts.some(receipt => receipt.opId === request.opId)) {
        duplicate = true
        return cur
      }
      return {
        ...cur,
        status: 'draft',
        currentRevision: { revisionId, contentDigest },
        catalogSummary: request.catalogSummary,
        receipts: [...cur.receipts, { opId: request.opId, revisionId, outcome: 'applied' as const }],
      }
    })
    return duplicate ? { state: 'duplicate', ref: skillId } : { state: 'applied', ref: skillId }
  }

  /**
   * Patch: receipt check BEFORE stale (a crash replay hits the receipt set),
   * stale base check, pending conflict check, then the bundle write and the
   * record CAS that only fills the pending slot — current content and the
   * record-level catalog summary stay untouched until approval.
   */
  async patchSkill(request: {
    opId: string
    projectKey: string
    name: string
    body: string
    catalogSummary: string
    expectRevisionId: string
  }): Promise<SkillOutcome> {
    const skillId = deriveSkillId(request.projectKey, request.name)
    const record = this.records.get(skillId)
    if (record === undefined) return { state: 'failed', code: 'skill_absent' }
    if (record.projectKey !== request.projectKey) return { state: 'failed', code: 'ref_mismatch' }
    const acked = (revisions: ManagedRecord['receipts']) => revisions.some(receipt => receipt.opId === request.opId)
    if (acked(record.receipts) || acked(record.terminalRing)) return { state: 'duplicate', ref: skillId }
    if (record.currentRevision?.revisionId !== request.expectRevisionId) {
      return { state: 'failed', code: 'stale_base_revision' }
    }
    if (record.pendingRevision !== undefined) return { state: 'failed', code: 'pending_pending_conflict' }
    const revisionId = revisionIdFor(skillId, request.opId)
    const contentDigest = await this.writeRevision(skillId, revisionId, request.body)
    let conflict = false
    await this.records.update(skillId, (cur) => {
      if (cur.pendingRevision !== undefined) {
        conflict = true
        return cur
      }
      return {
        ...cur,
        pendingRevision: {
          revisionId,
          contentDigest,
          catalogSummary: request.catalogSummary,
          createdByOpId: request.opId,
        },
        receipts: [...cur.receipts, { opId: request.opId, revisionId, outcome: 'applied' as const }],
      }
    })
    if (conflict) return { state: 'failed', code: 'pending_pending_conflict' }
    return { state: 'applied', ref: skillId }
  }

  /** Governance approve: ONE CAS switches pointer, digest, summary, and clears pending atomically. */
  async approvePending(skillId: string): Promise<{ revisionId: string } | { error: 'no_pending' }> {
    let out: { revisionId: string } | { error: 'no_pending' } = { error: 'no_pending' }
    await this.records.update(skillId, (cur) => {
      const pending = cur.pendingRevision
      if (pending === undefined) return cur
      const next: ManagedRecord = { ...cur }
      next.currentRevision = { revisionId: pending.revisionId, contentDigest: pending.contentDigest }
      next.catalogSummary = pending.catalogSummary
      delete next.pendingRevision
      out = { revisionId: pending.revisionId }
      return next
    })
    return out
  }

  /** Governance reject of a pending patch: clear the slot; the written revision becomes an orphan. */
  async rejectPending(skillId: string): Promise<{ revisionId?: string; error?: 'no_pending' }> {
    let orphan: string | undefined
    await this.records.update(skillId, (cur) => {
      const pending = cur.pendingRevision
      if (pending === undefined) return cur
      const next: ManagedRecord = { ...cur }
      orphan = pending.revisionId
      delete next.pendingRevision
      return next
    })
    return orphan === undefined ? { error: 'no_pending' } : { revisionId: orphan }
  }

  /** Governance transitions; the caller owns the legal-transition check. */
  async transition(skillId: string, to: ManagedRecord['status']): Promise<void> {
    await this.records.update(skillId, cur => ({ ...cur, status: to }))
  }

  /**
   * Completion-marker bundle protocol over ctx.fs (no move/delete exists):
   * the body is rewritten in full, then the marker with its digest lands. A
   * crash mid-write leaves body-without-marker, which a retry of the SAME op
   * repairs by rewriting; a marker whose digest mismatches the body is
   * foreign content and fails loud.
   */
  async writeRevision(skillId: string, revisionId: string, body: string): Promise<string> {
    const contentDigest = sha256(body)
    await this.fs.writeText(await this.fs.resolve(join(this.bundleRoot, skillId, revisionId, 'SKILL.md')), body)
    await this.fs.writeText(await this.fs.resolve(join(this.bundleRoot, skillId, revisionId, 'complete')), contentDigest)
    return contentDigest
  }

  async revisionState(skillId: string, revisionId: string): Promise<{ complete: boolean; body?: string }> {
    const body = await this.readOptional(join(this.bundleRoot, skillId, revisionId, 'SKILL.md'))
    const marker = await this.readOptional(join(this.bundleRoot, skillId, revisionId, 'complete'))
    if (marker !== undefined && body === undefined) {
      throw new Error(`invalid_structure: revision ${skillId}/${revisionId} has a completion marker but no body`)
    }
    if (body === undefined || marker === undefined) return { complete: false }
    if (sha256(body) !== marker) {
      throw new Error(`invalid_structure: revision ${skillId}/${revisionId} marker digest does not match the body`)
    }
    return { complete: true, body }
  }

  /**
   * Provider get: the candidate's projectKey must match the requesting
   * project, and only here is the bundle validated — the catalog summary
   * comes from the sidecar record, never from the file.
   */
  async getSummary(candidate: ManagedCandidate, projectKey: string): Promise<{ summary: string; body: string } | undefined> {
    if (candidate.projectKey !== projectKey) return undefined
    const record = this.records.get(candidate.skillId)
    if (record?.currentRevision === undefined) return undefined
    let state: { complete: boolean; body?: string }
    try {
      state = await this.revisionState(record.skillId, record.currentRevision.revisionId)
    } catch {
      return undefined
    }
    if (!state.complete || state.body === undefined) return undefined
    if (sha256(state.body) !== record.currentRevision.contentDigest) return undefined
    return { summary: record.catalogSummary ?? '', body: state.body }
  }

  /**
   * Grouped idempotent terminal ack over record receipts: same rules as the
   * memory side — orphan refs and opId-less entries are `invalid_structure`,
   * replays are idempotent, the ring is bounded.
   */
  async acknowledgeTerminalOps(skillId: string, opIds: readonly string[]): Promise<void> {
    for (const opId of opIds) {
      if (opId === '') throw new Error('invalid_structure: ack entry without opId')
    }
    if (this.records.get(skillId) === undefined) {
      throw new Error(`invalid_structure: ack group references unknown skill '${skillId}'`)
    }
    await this.records.update(skillId, (cur) => {
      const ringed = new Set(cur.terminalRing.map(receipt => receipt.opId))
      const pending = new Set(cur.receipts.map(receipt => receipt.opId))
      const moved: string[] = []
      for (const opId of opIds) {
        if (ringed.has(opId)) continue
        if (!pending.has(opId)) throw new Error(`invalid_structure: no receipt for op ${opId} on skill '${skillId}'`)
        moved.push(opId)
      }
      if (moved.length === 0) return cur
      const ring = [
        ...cur.terminalRing,
        ...cur.receipts.filter(receipt => moved.includes(receipt.opId)).map(receipt => ({
          opId: receipt.opId,
          revisionId: receipt.revisionId,
          outcome: receipt.outcome,
        })),
      ]
      return {
        ...cur,
        receipts: cur.receipts.filter(receipt => !moved.includes(receipt.opId)),
        terminalRing: ring.length > TERMINAL_RING_CAPACITY ? ring.slice(ring.length - TERMINAL_RING_CAPACITY) : ring,
      }
    })
  }

  private async readOptional(path: string): Promise<string | undefined> {
    try {
      return await this.fs.readText(await this.fs.resolve(path))
    } catch {
      return undefined
    }
  }
}
