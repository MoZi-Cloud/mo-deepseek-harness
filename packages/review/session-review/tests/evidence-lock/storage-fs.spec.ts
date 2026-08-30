/**
 * Evidence Lock — batch 1: storage and filesystem contracts.
 *
 * Pins T07, T10, T19, T20, T24, T25, T45 of
 * `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md`. Each case names the fact it
 * pins; source anchors live in the matrix. These tests drive the real domain
 * layer over the real JSON medium and the real local filesystem — no fakes.
 * @module evidence-lock/storage-fs
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import Storage from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget,
  FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'

const roots: string[] = []

/** Create one temp root that afterAll removes. */
async function tempRoot(prefix: string, base = tmpdir()): Promise<string> {
  const root = await mkdtemp(join(base, prefix))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Domain harness over the real JSON medium (T07/T20/T24)
// ---------------------------------------------------------------------------

const counterSchema = z.object({ n: z.number().int(), log: z.array(z.string()) })
type Counter = z.infer<typeof counterSchema>

interface DomainHarness {
  readonly ctx: Context
  readonly backend: JsonStorageBackend
  readonly facility: DomainFacility
  readonly spec: ReturnType<typeof makeCounterSpec>
}

function makeCounterSpec(name: string, version: number) {
  return defineDomain({
    name,
    version,
    tables: { items: domainTable<string, Counter>(counterSchema) },
  })
}

/**
 * Boot a context whose storage hub carries one JSON backend, and a facility
 * routed to it. Pass `root` to share one medium across harnesses (T20 reopen).
 */
async function domainHarness(name: string, version: number, root?: string): Promise<DomainHarness> {
  const storeRoot = root ?? await tempRoot('dsh-evlock-store-')
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(storeRoot)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const spec = makeCounterSpec(name, version)
  return { ctx, backend, facility, spec }
}

describe('T07 storage-update-serial-atomic', () => {
  it('applies concurrent updates one at a time on the write chain, so the final record equals serial application', async () => {
    const { ctx, facility, spec } = await domainHarness('evlock_serial', 1)
    const domain = await facility.open(spec)
    const changes: DomainChanged[] = []
    ctx.on('domain/changed', (change) => { changes.push(change) })
    const table = domain.table('items')
    await table.put('k', { n: 0, log: [] })

    await Promise.all(Array.from({ length: 25 }, (_, i) =>
      table.update('k', cur => ({ n: cur.n + 1, log: [...cur.log, `u${i}`] }))))

    const final = table.get('k')
    expect(final?.n).toBe(25)
    expect(final?.log).toHaveLength(25)
    expect(new Set(final?.log ?? []).size).toBe(25)
    // Every write announces the state it committed, in write order; the last
    // announcement equals the authoritative in-memory record.
    expect(changes).toHaveLength(26)
    expect(changes[25]).toMatchObject({ key: 'k', value: final })
    await domain.close()
  })
})

describe('T24 storage-update-missing-key-first-record', () => {
  it('rejects update on a missing key, lets put overwrite unconditionally, and initializes via get→put→update', async () => {
    const { facility, spec } = await domainHarness('evlock_init', 1)
    const domain = await facility.open(spec)
    const table = domain.table('items')

    // update is read-modify-write: on a missing key there is nothing to read.
    await expect(table.update('absent', cur => cur)).rejects.toMatchObject({ code: 'missing-key' })

    // put is insert-or-overwrite; there is no compare-and-put primitive.
    await table.put('k', { n: 1, log: [] })
    await table.put('k', { n: 2, log: ['again'] })
    expect(table.get('k')).toEqual({ n: 2, log: ['again'] })

    // First-record protocol: get→put(initial)→update.
    if (table.get('proto') === undefined) await table.put('proto', { n: 0, log: [] })
    await table.update('proto', cur => ({ ...cur, n: cur.n + 1 }))
    expect(table.get('proto')?.n).toBe(1)

    // Concurrent updates that skip the put both reject missing-key at their
    // chain slot — the reason the initialization protocol puts first.
    const attempts = await Promise.allSettled([
      table.update('concurrent-absent', cur => ({ ...cur, n: cur.n + 1 })),
      table.update('concurrent-absent', cur => ({ ...cur, n: cur.n + 1 })),
    ])
    for (const attempt of attempts) {
      expect(attempt.status).toBe('rejected')
      if (attempt.status === 'rejected') {
        expect(attempt.reason).toMatchObject({ code: 'missing-key' })
      }
    }
    await domain.close()
  })
})

describe('T20 storage-domain-open-reject', () => {
  it('rejects reopening a stored unit under a different domain version', async () => {
    const name = 'evlock_versioned'
    const root = await tempRoot('dsh-evlock-version-')
    {
      const { facility, spec, backend } = await domainHarness(name, 1, root)
      const domain = await facility.open(spec)
      await domain.table('items').put('k', { n: 1, log: [] })
      await domain.close()
      await backend.close()
    }
    // A fresh backend over the same medium; the stored unit carries version 1.
    const { facility: facility2, spec: spec2, backend: backend2 } = await domainHarness(name, 2, root)
    await expect(facility2.open(spec2)).rejects.toMatchObject({ code: 'version-mismatch' })
    await backend2.close()
  })
})

// ---------------------------------------------------------------------------
// Filesystem contracts (T10/T19/T25/T45)
// ---------------------------------------------------------------------------

/**
 * Minimal FileSystem subclass. This declaration is itself the type-level half
 * of T25: the abstract face has exactly the twelve primitives below, so a
 * thirteenth abstract member makes this class fail the host-aggregate
 * typecheck instead of failing a runtime assertion.
 */
class ProbeFileSystem extends FileSystem {
  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(path), displayPath: path }
  }

  override processPath(target: FsTarget): string {
    return target.displayPath
  }

  override fileUrl(target: FsTarget): string {
    return `file://${target.displayPath}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return child.displayPath.startsWith(parent.displayPath)
  }

  override async stat(): Promise<FsInfo | undefined> {
    return undefined
  }

  override async lstat(): Promise<FsPathInfo | undefined> {
    return undefined
  }

  override async readText(): Promise<string> {
    return ''
  }

  override async streamText(): Promise<AsyncIterable<string>> {
    return (async function* () {})()
  }

  override async readBytes(): Promise<Uint8Array> {
    return new Uint8Array()
  }

  override async listDir(): Promise<FsDirEntry[]> {
    return []
  }

  override async writeText(
    target: FsTarget,
    content: string,
    _expected?: FsWriteIntent,
    _signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    void target
    return { operation: 'create', version: FsVersion('probe'), before: null, after: content }
  }

  override async editText(
    _target: FsTarget,
    _edit: FsEditRequest,
    _expected?: { version: FsVersion },
    _signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return { version: FsVersion('probe'), before: '', after: '' }
  }
}

describe('T25 ctx-fs-no-move-contract', () => {
  it('exposes exactly the twelve primitives and no move/rename/delete/copy member', async () => {
    const ctx = new Context()
    await ctx.plugin(ProbeFileSystem)
    const probe = ctx.fs as ProbeFileSystem

    const primitives = [
      'resolve', 'processPath', 'fileUrl', 'contains', 'stat', 'lstat',
      'readText', 'streamText', 'readBytes', 'listDir', 'writeText', 'editText',
    ] as const
    for (const name of primitives) {
      expect(typeof (probe as unknown as Record<string, unknown>)[name]).toBe('function')
    }
    // ctx.fs has no destructive or relocating primitive: bundles are written
    // and completed in place, and nothing can move a revision directory away.
    for (const absent of ['move', 'rename', 'unlink', 'rm', 'delete', 'copy', 'cp', 'mv', 'mkdir']) {
      expect((probe as unknown as Record<string, unknown>)[absent]).toBeUndefined()
    }
  })
})

describe('T45 project-key-uses-fs-target-identity', () => {
  it('derives equal keys for alias paths to one file and distinct keys for distinct files', async () => {
    const dir = await tempRoot('dsh-evlock-fs-')
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    const fs = ctx.fs as LocalFileSystem

    const real = join(dir, 'project')
    await mkdir(real)
    await writeFile(join(real, 'a.txt'), 'x')
    const alias = join(dir, 'alias')
    await symlink(real, alias)

    // Same file through the alias and through the real path → same targetKey,
    // including for files that do not exist yet (nearest-ancestor identity).
    expect((await fs.resolve(join(alias, 'a.txt'))).targetKey)
      .toBe((await fs.resolve(join(real, 'a.txt'))).targetKey)
    expect((await fs.resolve(join(alias, 'missing.txt'))).targetKey)
      .toBe((await fs.resolve(join(real, 'missing.txt'))).targetKey)
    await writeFile(join(real, 'b.txt'), 'y')
    expect((await fs.resolve(join(real, 'a.txt'))).targetKey)
      .not.toBe((await fs.resolve(join(real, 'b.txt'))).targetKey)

    // ProjectKey prototype: hash the whole opaque targetKey. Alias paths hash
    // equal because identity comes from the key, and hashing the PATH instead
    // would have split one project into two — the reason keys are opaque and
    // never spliced into derived identifiers.
    const projectKeyOf = async (path: string): Promise<string> =>
      createHash('sha256').update((await fs.resolve(path)).targetKey).digest('hex')
    expect(await projectKeyOf(join(alias, 'a.txt'))).toBe(await projectKeyOf(join(real, 'a.txt')))
    expect(await projectKeyOf(real)).not.toBe(await projectKeyOf(dir))
    expect(join(alias, 'a.txt')).not.toBe(join(real, 'a.txt'))
  })
})

// ---------------------------------------------------------------------------
// Sandbox policy semantics (T10/T19)
// ---------------------------------------------------------------------------

interface SandboxedHarness {
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly fs: SandboxedFileSystem
}

/** Mount the policy service and a sandboxed local filesystem over `workspace`. */
async function sandboxedHarness(mode: SandboxMode, workspace: string): Promise<SandboxedHarness> {
  const ctx = new Context()
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  const fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  return { ctx, fiber, fs: ctx.fs as SandboxedFileSystem }
}

describe('T19 sandbox-writable-roots', () => {
  it('grants exactly the workspace root plus the platform temp areas, and never the home directory', async () => {
    const workspace = await tempRoot('dsh-evlock-ws-')
    expect(writableRoots({ mode: 'read-only', workspaceRoot: workspace })).toEqual([])

    const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
    const rootsGranted = writableRoots(policy)
    expect(rootsGranted).toContain(canonicalPath(workspace))
    expect(rootsGranted).toContain(canonicalPath('/tmp'))
    expect(rootsGranted).toContain(canonicalPath(tmpdir()))
    expect(new Set(rootsGranted).size).toBe(rootsGranted.length)
    // dshHome (~/.dsh) and every other home location are structurally absent
    // from the grant list — containment checks reject them by construction.
    expect(rootsGranted.some(root => root.startsWith(homedir()))).toBe(false)

    const { fs } = await sandboxedHarness('workspace-write', workspace)
    const dshHomePath = join(homedir(), '.dsh', `evlock-${Date.now()}`, 'x.txt')
    await expect(fs.writeText(await fs.resolve(dshHomePath), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(dshHomePath)).toBe(false)
  })
})

describe('T10 ctx-fs-host-write', () => {
  it('writes through the policy fence: read-only denies all, workspace-write contains, danger-full-access delegates', async () => {
    const workspace = await tempRoot('dsh-evlock-t10-ws-')
    // A sibling of the workspace under HOME, outside every grant (tmpdir would
    // be inside the workspace-write grant).
    const outsideDir = await tempRoot('dsh-evlock-t10-out-', homedir())
    const insidePath = join(workspace, 'in.txt')
    const outsidePath = join(outsideDir, 'out.txt')

    // read-only: every mutation denied, nothing lands.
    {
      const { fs } = await sandboxedHarness('read-only', workspace)
      await expect(fs.writeText(await fs.resolve(insidePath), 'x'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.writeText(await fs.resolve(outsidePath), 'x'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(existsSync(insidePath)).toBe(false)
      expect(existsSync(outsidePath)).toBe(false)
    }
    // workspace-write: canonical containment under the workspace root.
    {
      const { fs } = await sandboxedHarness('workspace-write', workspace)
      await fs.writeText(await fs.resolve(insidePath), 'x')
      expect(existsSync(insidePath)).toBe(true)
      await expect(fs.writeText(await fs.resolve(outsidePath), 'x'))
        .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      expect(existsSync(outsidePath)).toBe(false)
    }
    // danger-full-access: the fence delegates unfenced.
    {
      const { fs } = await sandboxedHarness('danger-full-access', workspace)
      await fs.writeText(await fs.resolve(outsidePath), 'x')
      expect(existsSync(outsidePath)).toBe(true)
    }
  })
})
