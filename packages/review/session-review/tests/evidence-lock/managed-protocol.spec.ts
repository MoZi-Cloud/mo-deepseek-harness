/**
 * Evidence Lock — batch 4: managed skill protocol face.
 *
 * Pins T33, T35, T37, T44, T46, T47, T48, T49, T60 of
 * `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md`. The reference
 * `ManagedStore` runs over a real storage-domain (serial-atomic CAS writes,
 * `already-open` single-open) and the real `ctx.fs` bundle writes; the real
 * skill registry supplies the same-layer rank contest in T33. The store is an
 * in-test reference implementation (`managed-protocol.ts`), never production
 * code.
 * @module evidence-lock/managed-protocol
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import {
  MANAGED_PROVIDER_NAME, MANAGED_RANK, ManagedStore, deriveSkillId, managedRecordSchema,
  nameIndexKey, reservationSchema, revisionIdFor,
} from './managed-protocol.ts'
import type { ManagedRecord, ReservationRecord } from './managed-protocol.ts'
import { sha256 } from './review-protocol.ts'

const managedSpec = defineDomain({
  name: 'evlock_managed',
  version: 1,
  tables: {
    name_index: domainTable<string, ReservationRecord>(reservationSchema),
    records: domainTable<string, ManagedRecord>(managedRecordSchema),
  },
})

const roots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

interface ManagedHarness {
  readonly ctx: Context
  readonly facility: DomainFacility
  readonly domain: Domain<typeof managedSpec>
  readonly store: ManagedStore
  readonly bundleRoot: string
  readonly backend: JsonStorageBackend
}

async function managedHarness(): Promise<ManagedHarness> {
  const bundleRoot = await tempRoot('dsh-evlock-bundles-')
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(LocalFileSystem, { cwd: bundleRoot })
  const backend = new JsonStorageBackend(await tempRoot('dsh-evlock-managed-'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const domain = await facility.open(managedSpec)
  const store = new ManagedStore(domain.table('name_index'), domain.table('records'), ctx.fs, bundleRoot)
  return { ctx, facility, domain, store, bundleRoot, backend }
}

const harnesses: ManagedHarness[] = []

async function freshHarness(): Promise<ManagedHarness> {
  const harness = await managedHarness()
  harnesses.push(harness)
  return harness
}

afterAll(async () => {
  for (const harness of harnesses) {
    await harness.domain.close()
    await harness.backend.close()
  }
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

/** Create one skill and promote it to active; returns its deterministic id. */
async function createActiveSkill(
  store: ManagedStore,
  opId: string,
  projectKey: string,
  name: string,
  body: string,
  summary: string,
): Promise<string> {
  const skillId = deriveSkillId(projectKey, name)
  const created = await store.createSkill({ opId, projectKey, name, body, catalogSummary: summary })
  expect(created).toEqual({ state: 'applied', ref: skillId })
  await store.transition(skillId, 'active')
  return skillId
}

describe('T44 managed-domain-opened-exactly-once', () => {
  it('opens the domain once: a second open on the same facility is already-open and a second facility hits the live-handle guard', async () => {
    const harness = await freshHarness()
    // The reference service is the only opener; any further open of the same
    // domain name fails loud instead of silently sharing a second handle.
    await expect(harness.facility.open(managedSpec)).rejects.toMatchObject({ code: 'already-open' })
    const second = new DomainFacility(harness.ctx, { backend: 'json', routes: {} })
    await expect(second.open(managedSpec)).rejects.toThrow(/unit 'evlock_managed' is already open/)

    // Concurrent opens of one name are rejected as well — the reservation is
    // claimed at open start, not only at completion.
    const racers = await Promise.allSettled([
      harness.facility.open(managedSpec),
      harness.facility.open(managedSpec),
    ])
    for (const racer of racers) expect(racer.status).toBe('rejected')

    // Consumers read through the one store handle: the provider and tool
    // faces call the store, which holds the only opened domain.
    expect(harness.store.record(deriveSkillId('pk', 'none'))).toBeUndefined()
    expect(harness.store.allRecords()).toHaveLength(0)
  })
})

describe('T35 managed-provider-project-isolation', () => {
  it('keys records and the name index by projectKey so project B never sees project A', async () => {
    const harness = await freshHarness()
    const { store } = harness
    const skillId = await createActiveSkill(store, 'op-a', 'proj-A', 'shared-name', 'body A', 'summary A')

    expect(store.candidates('proj-A')).toHaveLength(1)
    expect(store.candidates('proj-B')).toHaveLength(0)
    // A candidate carried across projects fails the ref check at get.
    const candidate = store.candidates('proj-A')[0]
    if (candidate === undefined) throw new Error('expected one candidate')
    await expect(store.getSummary(candidate, 'proj-B')).resolves.toBeUndefined()
    await expect(store.getSummary(candidate, 'proj-A')).resolves.toMatchObject({ summary: 'summary A', body: 'body A' })

    // projectKey is inside the storage key: same name, disjoint keys and ids.
    expect(nameIndexKey('proj-A', 'shared-name')).not.toBe(nameIndexKey('proj-B', 'shared-name'))
    expect(deriveSkillId('proj-A', 'shared-name')).toBe(skillId)
    expect(deriveSkillId('proj-B', 'shared-name')).not.toBe(skillId)
    expect(store.record(deriveSkillId('proj-B', 'shared-name'))).toBeUndefined()
  })
})

describe('T37 managed-name-reservation-concurrent', () => {
  it('reserves through one serialized RMW: deterministic ids, one concurrent winner, reconcilable crash orphans', async () => {
    const harness = await freshHarness()
    const { store } = harness
    // Deterministic identity: the same project+name derives the same id.
    expect(deriveSkillId('pk', 'n')).toBe(deriveSkillId('pk', 'n'))
    expect(deriveSkillId('pk', 'n')).not.toBe(deriveSkillId('pk2', 'n'))
    expect(deriveSkillId('pk', 'n')).not.toBe(deriveSkillId('pk', 'other'))

    // Five concurrent reservations of one name: exactly one wins.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.reserveName('pk', 'contested', `op-${i}`)),
    )
    const won = outcomes.filter(outcome => outcome.kind !== 'name_conflict')
    expect(won).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.kind === 'name_conflict')).toHaveLength(4)
    if (won[0]?.kind !== 'reserved') throw new Error('expected the winner to hold the fresh reservation')
    expect(won[0].skillId).toBe(deriveSkillId('pk', 'contested'))

    // A crash after reservation leaves an orphan reservation; reconcile
    // releases it and the next op reserves the name cleanly.
    expect(await store.reserveName('pk2', 'orphaned', 'op-crashed')).toMatchObject({ kind: 'reserved' })
    expect(await store.reserveName('pk2', 'orphaned', 'op-next')).toMatchObject({ kind: 'name_conflict' })
    expect(await store.reconcileReservation('pk2', 'orphaned')).toBe(true)
    expect(await store.reserveName('pk2', 'orphaned', 'op-next')).toMatchObject({ kind: 'reserved' })
  })
})

describe('T47 name-index-first-record-initialization', () => {
  it('initializes a brand-new project through the get→put→update protocol with one concurrent winner', async () => {
    const harness = await freshHarness()
    const { store } = harness
    // No name-index record exists for the fresh project; the first reserve
    // both initializes the record and wins the reservation.
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.reserveName('fresh-project', 'first-skill', `op-first-${i}`)),
    )
    const won = outcomes.filter(outcome => outcome.kind === 'reserved')
    expect(won).toHaveLength(1)
    if (won[0]?.kind !== 'reserved') throw new Error('unreachable')
    expect(won[0].skillId).toBe(deriveSkillId('fresh-project', 'first-skill'))
    // The losers see a held reservation, not a missing record.
    expect(outcomes.filter(outcome => outcome.kind === 'name_conflict')).toHaveLength(4)
  })
})

describe('T48 rejected-draft-can-be-reopened', () => {
  it('walks draft→rejected→reopen→draft keeping identity, and keeps rejected invisible to the provider', async () => {
    const harness = await freshHarness()
    const { store } = harness
    const skillId = deriveSkillId('pk', 'rejected-path')
    const created = await store.createSkill({
      opId: 'op-create', projectKey: 'pk', name: 'rejected-path', body: 'body', catalogSummary: 'summary',
    })
    expect(created).toEqual({ state: 'applied', ref: skillId })
    expect(store.record(skillId)?.status).toBe('draft')
    expect(store.candidates('pk')).toHaveLength(0)

    // Rejection is a user governance action on a draft.
    await store.transition(skillId, 'rejected')
    expect(store.record(skillId)?.status).toBe('rejected')
    expect(store.candidates('pk')).toHaveLength(0)

    // Reopen returns the SAME record (same skillId, name-index identity intact).
    await store.transition(skillId, 'draft')
    expect(store.record(skillId)?.status).toBe('draft')
    expect(store.record(skillId)?.currentRevision?.revisionId).toBe(revisionIdFor(skillId, 'op-create'))
    // The name index keeps pointing at the same skillId; another op that
    // wants the name conflicts instead of stealing it.
    expect(harness.domain.table('name_index').get(nameIndexKey('pk', 'rejected-path'))).toMatchObject({
      reserved: true,
      skillId,
    })
    expect(await store.reserveName('pk', 'rejected-path', 'op-other')).toMatchObject({ kind: 'name_conflict' })

    await store.transition(skillId, 'active')
    expect(store.candidates('pk')).toHaveLength(1)
  })
})

describe('T33 managed-provider-catalog-visibility', () => {
  it('publishes only active and stale records to the catalog, keeps stale loadable, and loses the same-layer rank contest to humans', async () => {
    const harness = await freshHarness()
    const { store } = harness
    await createActiveSkill(store, 'op-1', 'pk', 'visible', 'body', 'visible summary')
    const staleId = await createActiveSkill(store, 'op-2', 'pk', 'stale-one', 'stale body', 'stale summary')
    await createSkillOnly(store, 'op-3', 'pk', 'draft-one')
    await createSkillOnly(store, 'op-4', 'pk', 'rejected-one', 'rejected')
    await createSkillOnly(store, 'op-5', 'pk', 'archived-one', 'archived')
    await store.transition(staleId, 'stale')

    const names = store.candidates('pk').map(candidate => candidate.name).sort()
    expect(names).toEqual(['stale-one', 'visible'])
    // Stale stays loadable through get — discovery is the revival path.
    const staleCandidate = store.candidates('pk').find(candidate => candidate.name === 'stale-one')
    if (staleCandidate === undefined) throw new Error('expected the stale candidate to be discoverable')
    await expect(store.getSummary(staleCandidate, 'pk')).resolves.toMatchObject({ body: 'stale body' })

    // Same layer, same name: the managed reference provider ranks 700 and
    // loses to the human 600 through the REAL registry merge.
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const managedCandidate = (): SkillCandidate => ({
      name: 'shared',
      description: 'managed catalog entry',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: MANAGED_PROVIDER_NAME,
      source: 'managed',
      rank: MANAGED_RANK,
      locator: {},
    })
    const managedProvider: SkillProvider = {
      name: MANAGED_PROVIDER_NAME,
      list: async () => [managedCandidate()],
      get: async candidate => ({ ...candidate, content: 'managed body' }),
    }
    ctx.skills.registerProvider(() => managedProvider)
    ctx.skills.registerProvider(() => ({
      name: 'human-layer',
      list: async () => [{ ...managedCandidate(), description: 'human catalog entry', provider: 'human-layer', source: 'user', rank: 600 }],
      get: async candidate => ({ ...candidate, content: 'human body' }),
    }))
    const listed = await ctx.skills.list()
    const shared = listed.filter(entry => entry.name === 'shared')
    expect(shared).toHaveLength(1)
    expect(shared[0]?.description).toBe('human catalog entry')
  })
})

/** Create a skill record left in a non-visible status. */
async function createSkillOnly(
  store: ManagedStore,
  opId: string,
  projectKey: string,
  name: string,
  status: ManagedRecord['status'] = 'draft',
): Promise<string> {
  const skillId = deriveSkillId(projectKey, name)
  const created = await store.createSkill({ opId, projectKey, name, body: `body of ${name}`, catalogSummary: `${name} summary` })
  expect(created).toEqual({ state: 'applied', ref: skillId })
  if (status !== 'draft') await store.transition(skillId, status)
  return skillId
}

describe('T46 managed-catalog-sidecar-not-file-trust', () => {
  it('serves catalog summaries from the record sidecar, ignores file tampering at list, and validates the bundle only at get', async () => {
    const harness = await freshHarness()
    const { store, ctx } = harness
    const skillId = await createActiveSkill(
      store, 'op-1', 'pk', 'sidecar',
      '---\nname: sidecar\ndescription: File description\n---\n\nBody.\n',
      'Sidecar description',
    )
    const candidate = store.candidates('pk')[0]
    if (candidate === undefined) throw new Error('expected one candidate')
    expect(candidate.description).toBe('Sidecar description')

    // Tamper with the revision file's frontmatter description in place.
    const revisionId = revisionIdFor(skillId, 'op-1')
    const bundlePath = join(harness.bundleRoot, skillId, revisionId, 'SKILL.md')
    await ctx.fs.writeText(await ctx.fs.resolve(bundlePath), '---\nname: sidecar\ndescription: Tampered\n---\n\nTampered body.\n')
    expect(store.candidates('pk')[0]?.description).toBe('Sidecar description')

    // get is the validation point: the tampered body fails the digest check.
    await expect(store.getSummary(candidate, 'pk')).resolves.toBeUndefined()
  })
})

describe('T49 active-patch-stays-pending-until-approve', () => {
  it('holds patches in the four-field pending slot, rejects double patches, and switches atomically on approve', async () => {
    const harness = await freshHarness()
    const { store } = harness
    const skillId = await createActiveSkill(store, 'op-1', 'pk', 'patched', 'body one', 'summary one')
    const baseRevision = store.record(skillId)?.currentRevision?.revisionId
    if (baseRevision === undefined) throw new Error('expected a current revision')

    const patched = await store.patchSkill({
      opId: 'op-2', projectKey: 'pk', name: 'patched', body: 'body two', catalogSummary: 'summary two', expectRevisionId: baseRevision,
    })
    expect(patched).toEqual({ state: 'applied', ref: skillId })
    const pending = store.record(skillId)
    expect(pending?.currentRevision?.revisionId).toBe(baseRevision)
    expect(pending?.catalogSummary).toBe('summary one')
    expect(pending?.pendingRevision).toEqual({
      revisionId: revisionIdFor(skillId, 'op-2'),
      contentDigest: sha256('body two'),
      catalogSummary: 'summary two',
      createdByOpId: 'op-2',
    })

    // A second patch while one is pending fails loud instead of queueing.
    const second = await store.patchSkill({
      opId: 'op-3', projectKey: 'pk', name: 'patched', body: 'body three', catalogSummary: 'summary three', expectRevisionId: baseRevision,
    })
    expect(second).toEqual({ state: 'failed', code: 'pending_pending_conflict' })

    // Approve: one CAS switches pointer, digest, and summary, and clears pending.
    await expect(store.approvePending(skillId)).resolves.toEqual({ revisionId: revisionIdFor(skillId, 'op-2') })
    const approved = store.record(skillId)
    expect(approved?.currentRevision).toEqual({ revisionId: revisionIdFor(skillId, 'op-2'), contentDigest: sha256('body two') })
    expect(approved?.catalogSummary).toBe('summary two')
    expect(approved?.pendingRevision).toBeUndefined()

    // Reject-pending clears the slot and orphans the written revision.
    const revisedBase = approved?.currentRevision?.revisionId
    if (revisedBase === undefined) throw new Error('expected the approved base')
    await store.patchSkill({ opId: 'op-4', projectKey: 'pk', name: 'patched', body: 'body four', catalogSummary: 'summary four', expectRevisionId: revisedBase })
    const orphanRevision = revisionIdFor(skillId, 'op-4')
    await expect(store.rejectPending(skillId)).resolves.toEqual({ revisionId: orphanRevision })
    expect(store.record(skillId)?.pendingRevision).toBeUndefined()
    // The orphan is complete on disk but referenced by nothing.
    await expect(store.revisionState(skillId, orphanRevision)).resolves.toMatchObject({ complete: true })
  })
})

describe('T60 pending-catalog-switches-only-on-approve', () => {
  it('keeps the record-level catalog summary stable during a pending patch and switches everything in one CAS on approve', async () => {
    const harness = await freshHarness()
    const { store } = harness
    const skillId = await createActiveSkill(store, 'op-1', 'pk', 'catalog', 'body one', 'catalog one')
    const baseRevision = store.record(skillId)?.currentRevision?.revisionId
    if (baseRevision === undefined) throw new Error('expected a current revision')

    // A patch whose only visible change is the description must not leak
    // into the catalog while pending.
    await store.patchSkill({
      opId: 'op-2', projectKey: 'pk', name: 'catalog', body: 'body two', catalogSummary: 'catalog two', expectRevisionId: baseRevision,
    })
    expect(store.candidates('pk')[0]?.description).toBe('catalog one')

    // The approve CAS is one durable write: a single records-table change
    // event carrying the whole new state.
    const changes: { table: string; key: string }[] = []
    const listener = (change: { table: string; key: string }): void => { changes.push({ table: change.table, key: change.key }) }
    harness.ctx.on('domain/changed', listener)
    await store.approvePending(skillId)
    const recordsChanges = changes.filter(change => change.table === 'records' && change.key === skillId)
    expect(recordsChanges).toHaveLength(1)

    expect(store.candidates('pk')[0]?.description).toBe('catalog two')
    const approved = store.record(skillId)
    expect(approved?.currentRevision?.revisionId).toBe(revisionIdFor(skillId, 'op-2'))
    expect(approved?.currentRevision?.contentDigest).toBe(sha256('body two'))
    expect(approved?.pendingRevision).toBeUndefined()
  })
})
