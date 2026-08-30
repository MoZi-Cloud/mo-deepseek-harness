/**
 * Evidence Lock — batch 2: skill registry and provider contracts.
 *
 * Pins T08, T09, T11, T26, T27, T34, T36, T38, T61 of
 * `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md`. The managed-skill provider
 * is a reference implementation inside these tests: it exercises the real
 * registry contract the review design relies on (rank shadowing, layer
 * precedence, candidate validation, digest fail-closed loading) without
 * registering any production behavior.
 * @module evidence-lock/skill-registry
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillLookupOptions, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

const homes: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  homes.push(dir)
  return dir
}

afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true })
})

/** Both-invocable candidate fields every provider candidate must carry. */
function baseCandidate(
  name: string,
  description: string,
  rank: number,
  locator: unknown,
  provider: string,
  source = 'managed',
): SkillCandidate {
  return {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider,
    source,
    rank,
    locator,
  }
}

/** A trivial provider whose catalog is fixed at construction. */
function fixedProvider(name: string, candidates: SkillCandidate[]): SkillProvider {
  return {
    name,
    list: async () => candidates,
    get: async candidate => ({ ...candidate, content: `body of ${candidate.name}` }),
  }
}

/** The registry visible from `ctx` — scoped contexts re-instantiate it, so route through get(). */
function skillsOf(ctx: Context): SkillRegistry {
  const skills = ctx.get('skills')
  if (skills === undefined) throw new Error('skills service missing')
  return skills
}

describe('T08 skill-rank-shadowing', () => {
  it('rank 100 beats 200 within one layer, in either registration order', async () => {
    for (const [first, second] of [[100, 200], [200, 100]] as const) {
      const ctx = new Context()
      await ctx.plugin(SkillRegistry)
      ctx.skills.registerProvider(() => fixedProvider('p-first', [baseCandidate('shared', `first is rank ${first}`, first, {}, 'p-first', 'p-first')]))
      ctx.skills.registerProvider(() => fixedProvider('p-second', [baseCandidate('shared', `second is rank ${second}`, second, {}, 'p-second', 'p-second')]))
      const skills = await ctx.skills.list()
      expect(skills).toHaveLength(1)
      expect(skills[0]?.description).toBe(first === 100 ? 'first is rank 100' : 'second is rank 100')
    }
  })
})

describe('T26 provider-control-invalidate', () => {
  it('publishes new state to the next list/get after control.invalidate(), and goes inert after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let version = 1
    let control: SkillProviderControl | undefined
    const changes = 0
    void changes

    const dispose = ctx.skills.registerProvider((registered) => {
      control = registered
      return {
        name: 'prototype',
        list: async () => [baseCandidate('evolving', `version ${version}`, 100, { version }, 'prototype', 'prototype')],
        get: async candidate => ({ ...candidate, content: `body ${version}` }),
      }
    })
    expect((await ctx.skills.list())[0]?.description).toBe('version 1')

    const observed: number[] = []
    ctx.on('skills/change', () => { observed.push(version) })

    version = 2
    control?.invalidate()
    // Invalidation bumps the revision, clears the cached catalog, and emits
    // exactly one change notification for the consumer's refetch.
    expect(observed).toEqual([2])
    expect((await ctx.skills.list())[0]?.description).toBe('version 2')
    expect((await ctx.skills.get('evolving'))?.content).toBe('body 2')

    dispose()
    const beforeInert = observed.length
    control?.invalidate()
    expect(observed.length).toBe(beforeInert)
  })
})

describe('T34 managed-provider-interface-contract', () => {
  it('accepts a full-fidelity managed candidate and races an uncooperative provider against the signal', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const bundle = {
      name: 'managed-skill',
      revision: 7,
      digest: createHash('sha256').update('managed body').digest('hex'),
    }
    let seenOptions: SkillLookupOptions | undefined
    ctx.skills.registerProvider(() => ({
      name: 'self-evolution-managed',
      list: async (options) => {
        seenOptions = options
        return [{
          ...baseCandidate(bundle.name, 'A curated managed skill', 700, { revision: bundle.revision, digest: bundle.digest }, 'self-evolution-managed'),
          whenToUse: 'When a managed skill applies',
          resourceBase: { kind: 'directory', path: '/managed/managed-skill' },
          path: '/managed/managed-skill/SKILL.md',
        }]
      },
      get: async (candidate) => {
        // The locator pins the revision: the definition is rebuilt from the
        // listed revision, never from current live state.
        const locator = candidate.locator as { revision: number }
        if (locator.revision !== bundle.revision) return undefined
        return { ...candidate, content: 'managed body' }
      },
    }))
    const skills = await ctx.skills.list({ signal: new AbortController().signal })
    // The candidate clears the registry's full validation suite (kebab name,
    // description, invocation, typed optionals, finite rank, provider match).
    expect(skills).toHaveLength(1)
    expect(skills[0]?.whenToUse).toBe('When a managed skill applies')
    expect(seenOptions?.signal).toBeInstanceOf(AbortSignal)

    // An uncooperative provider cannot hang get(): the registry races the
    // load against the caller's signal.
    const controller = new AbortController()
    ctx.skills.registerProvider(() => ({
      name: 'prototype-hanging',
      list: async () => [baseCandidate('hanging', 'hangs on load', 700, {}, 'prototype-hanging', 'prototype')],
      get: () => new Promise<SkillCandidate & { content: string }>(() => {
        controller.abort()
      }),
    }))
    await expect(ctx.skills.get('hanging', { signal: controller.signal })).rejects.toThrow()
  })
})

describe('T36 cross-layer-shadowing-rank-does-not-protect', () => {
  it('lets the nearest layer win regardless of rank, and rank decide only within one layer', async () => {
    // Same layer: rank decides — 100 beats 700 whichever provider holds it.
    {
      const ctx = new Context()
      await ctx.plugin(SkillRegistry)
      ctx.skills.registerProvider(() => fixedProvider('human', [baseCandidate('shared', 'human 700', 700, {}, 'human', 'human')]))
      ctx.skills.registerProvider(() => fixedProvider('managed', [baseCandidate('shared', 'managed 100', 100, {}, 'managed', 'managed')]))
      expect((await ctx.skills.list())[0]?.description).toBe('managed 100')
    }
    // Cross layer: the scoped layer wins outright, rank irrelevant — in both
    // directions (global human vs scoped managed, global managed vs scoped
    // human). This is why rank 700 cannot protect a managed skill from a
    // nearer human layer.
    for (const [globalDescription, scopedDescription] of [
      ['global human 100', 'scoped managed 700'],
      ['global managed 700', 'scoped human 100'],
    ] as const) {
      const ctx = new Context()
      await ctx.plugin(SkillRegistry)
      ctx.skills.registerProvider(() => fixedProvider('global-layer', [baseCandidate('shared', globalDescription, 100, {}, 'global-layer', 'global')]))
      const preset = createScope(ctx, { preset: 'evlock' })
      skillsOf(preset.ctx).registerProvider(() => fixedProvider('scoped-layer', [baseCandidate('shared', scopedDescription, 700, {}, 'scoped-layer', 'scoped')]))
      const scoped = await ctx.skills.list({ scope: scopeOf(preset.ctx) })
      expect(scoped).toHaveLength(1)
      expect(scoped[0]?.description).toBe(scopedDescription)
    }
  })

  it('enumerates the shipped filesystem layers: the lowest REAL rank wins within the provider', async () => {
    const home = await tempDir('dsh-evlock-t36-home-')
    const project = await tempDir('dsh-evlock-t36-project-')
    await mkdir(join(project, '.git'))
    const custom = join(home, 'custom-skills')
    const writeSkill = async (root: string, body: string): Promise<void> => {
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'SKILL.md'), `---\nname: same-name\ndescription: ${body}\n---\n\n${body}\n`)
    }
    // REAL ranks: project-dsh 100, custom 300, user-dsh 400, bundled 600.
    await writeSkill(join(project, '.dsh', 'skills'), 'project copy')
    await writeSkill(custom, 'custom copy')
    await writeSkill(join(home, '.dsh', 'skills'), 'user copy')

    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      customSkillDirs: [custom],
      watch: false,
    })
    const skills = await ctx.skills.list({ cwd: join(project, 'src') })
    const same = skills.filter(skill => skill.name === 'same-name')
    expect(same).toHaveLength(1)
    expect(same[0]?.description).toBe('project copy')
  })
})

describe('T09 staged-root-undiscovered (historical regression)', () => {
  it('keeps .dsh/self-evolution revision trees and deep-nested skills out of stock discovery', async () => {
    const home = await tempDir('dsh-evlock-t09-home-')
    const project = await tempDir('dsh-evlock-t09-project-')
    await mkdir(join(project, '.git'))
    const staged = join(project, '.dsh', 'self-evolution', 'skills', 'staged-one')
    await mkdir(staged, { recursive: true })
    await writeFile(join(staged, 'SKILL.md'), '---\nname: staged-one\ndescription: staged revision\n---\n\nbody\n')
    const deep = join(project, '.dsh', 'skills', 'nested', 'deeper')
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'SKILL.md'), '---\nname: deep-one\ndescription: too deep\n---\n\nbody\n')
    const visible = join(project, '.dsh', 'skills', 'visible-one')
    await mkdir(visible, { recursive: true })
    await writeFile(join(visible, 'SKILL.md'), '---\nname: visible-one\ndescription: discovered\n---\n\nbody\n')

    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: false,
    })
    const names = (await ctx.skills.list({ cwd: join(project, 'src') })).map(skill => skill.name)
    expect(names).toContain('visible-one')
    expect(names).not.toContain('staged-one')
    expect(names).not.toContain('deep-one')
  })
})

describe('T11 observer-seam-absent (historical regression)', () => {
  it('keeps the rejected observer seam absent: skills/change is the only registry channel', async () => {
    const surface = Object.keys(await import('@deepseek-ai/dsh-skill'))
    expect(surface.filter(name => /observe|seam/i.test(name))).toEqual([])

    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const registry = ctx.skills as unknown as Record<string, unknown>
    for (const absent of ['observe', 'subscribe', 'onSkillChange', 'observer']) {
      expect(registry[absent]).toBeUndefined()
    }
    // The one invalidation channel that exists: an unfiltered notification
    // whose consumers refetch; it carries no catalog payload.
    const changes: number[] = []
    ctx.on('skills/change', () => { changes.push(1) })
    ctx.skills.registerProvider(() => ({
      name: 'prototype',
      list: async () => [],
      get: async () => undefined,
    }))
    expect(changes).toHaveLength(1)
  })
})

describe('T27 flat-and-frontmatter-collision', () => {
  it('takes flat .md skill names from frontmatter and collapses frontmatter-name collisions inside one root', async () => {
    const home = await tempDir('dsh-evlock-t27-home-')
    const project = await tempDir('dsh-evlock-t27-project-')
    await mkdir(join(project, '.git'))
    const skillsRoot = join(project, '.dsh', 'skills')
    await mkdir(skillsRoot, { recursive: true })
    // The candidate name comes from frontmatter, not the filename.
    await writeFile(join(skillsRoot, 'odd-filename.md'), '---\nname: frontmatter-name\ndescription: flat skill\n---\n\nbody\n')
    // Two flat files claiming one frontmatter name: same layer, same provider
    // — exactly one winner survives discovery.
    await writeFile(join(skillsRoot, 'first.md'), '---\nname: dup-name\ndescription: first copy\n---\n\nbody\n')
    await writeFile(join(skillsRoot, 'second.md'), '---\nname: dup-name\ndescription: second copy\n---\n\nbody\n')

    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: false,
    })
    const skills = await ctx.skills.list({ cwd: join(project, 'src') })
    expect(skills.map(skill => skill.name)).toContain('frontmatter-name')
    expect(skills.map(skill => skill.name)).not.toContain('odd-filename')
    const dups = skills.filter(skill => skill.name === 'dup-name')
    expect(dups).toHaveLength(1)
    expect(dups[0]?.description).toBe('first copy')
  })
})

/** Bundle files for one managed skill plus the digest helper over them. */
async function managedBundle(prefix: string): Promise<{
  readonly dir: string
  readonly skillPath: string
  readonly supportPath: string
  write(body: string, support: string): Promise<void>
  read(path: string): Promise<string>
  digest(content: string): string
}> {
  const project = await tempDir(prefix)
  await mkdir(join(project, '.git'))
  const dir = join(project, '.dsh', 'self-evolution', 'skills', 'curated')
  const skillPath = join(dir, 'SKILL.md')
  const supportPath = join(dir, 'reference.md')
  const write = async (body: string, support: string): Promise<void> => {
    await mkdir(dir, { recursive: true })
    await writeFile(skillPath, `---\nname: curated\ndescription: curated managed skill\n---\n\n${body}\n`)
    await writeFile(supportPath, support)
  }
  return {
    dir,
    skillPath,
    supportPath,
    write,
    read: path => readFile(path, 'utf8'),
    digest: content => createHash('sha256').update(content).digest('hex'),
  }
}

describe('T38 managed-external-edit-digest-reject', () => {
  it('fails closed on external edits — get returns undefined, the provider invalidates and warns, for body and support alike', async () => {
    for (const variant of ['body', 'support'] as const) {
      const bundle = await managedBundle(`dsh-evlock-t38-${variant}-`)
      await bundle.write('original body', 'support v1')
      const ctx = new Context()
      await ctx.plugin(SkillRegistry)
      const warn = vi.fn()
      let control: SkillProviderControl | undefined
      ctx.skills.registerProvider((registered) => {
        control = registered
        return {
          name: 'self-evolution-managed',
          list: async () => {
            const [body, support] = await Promise.all([bundle.read(bundle.skillPath), bundle.read(bundle.supportPath)])
            return [{
              ...baseCandidate('curated', 'curated managed skill', 700, {
                bodyDigest: bundle.digest(body),
                supportDigest: bundle.digest(support),
              }, 'self-evolution-managed'),
            }]
          },
          get: async (candidate) => {
            const [body, support] = await Promise.all([bundle.read(bundle.skillPath), bundle.read(bundle.supportPath)])
            const locator = candidate.locator as { bodyDigest: string; supportDigest: string }
            if (bundle.digest(body) !== locator.bodyDigest || bundle.digest(support) !== locator.supportDigest) {
              warn('managed bundle digest mismatch for curated')
              control?.invalidate()
              return undefined
            }
            return { ...candidate, content: body }
          },
        }
      })
      // Baseline discovery records the pristine digests in the locator.
      expect(await ctx.skills.list()).toHaveLength(1)
      const changes: number[] = []
      ctx.on('skills/change', () => { changes.push(1) })

      // External edit: the file changes without any registry revision bump,
      // so the cached candidate is stale and only the provider can detect it.
      if (variant === 'body') {
        await bundle.write('tampered body', 'support v1')
      } else {
        await bundle.write('original body', 'tampered support')
      }
      expect(await ctx.skills.get('curated')).toBeUndefined()
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/digest mismatch/))
      expect(changes).toHaveLength(1)

      // Repairing the bundle restores loadability without re-registration.
      await bundle.write('original body', 'support v1')
      expect((await ctx.skills.get('curated'))?.content).toContain('original body')
    }
  })
})

describe('T61 provider-get-uses-listed-candidate-summary', () => {
  it('keeps definition body and summary on the listed revision when approval lands inside get', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const bundles = new Map<number, { description: string; body: string }>([
      [1, { description: 'summary v1', body: 'body v1' }],
    ])
    let currentRevision = 1
    let control: SkillProviderControl | undefined
    ctx.skills.registerProvider((registered) => {
      control = registered
      return {
        name: 'self-evolution-managed',
        list: async () => [
          baseCandidate('approved', bundles.get(currentRevision)?.description ?? '', 700, { revision: currentRevision }, 'self-evolution-managed'),
        ],
        get: async (candidate) => {
          const revision = (candidate.locator as { revision: number }).revision
          // Simulate approve(N+1)+invalidate landing mid-load, exactly once:
          // the catalog switches underneath, but THIS load already holds the
          // revision-1 candidate.
          if (currentRevision === 1) {
            currentRevision = 2
            bundles.set(2, { description: 'summary v2', body: 'body v2' })
            control?.invalidate()
          }
          const listed = bundles.get(revision)
          if (listed === undefined) return undefined
          return { ...candidate, description: listed.description, content: listed.body }
        },
      }
    })
    expect((await ctx.skills.list())[0]?.description).toBe('summary v1')
    const definition = await ctx.skills.get('approved')
    // The definition is coherent at revision 1: body v1 with summary v1 — no
    // N body + N+1 summary mismatch can leak out of the in-flight load.
    expect(definition?.description).toBe('summary v1')
    expect(definition?.content).toBe('body v1')
    // The invalidation applies from the next lookup onward.
    const next = await ctx.skills.get('approved')
    expect(next?.description).toBe('summary v2')
    expect(next?.content).toBe('body v2')
    void control
  })
})
