/**
 * Evidence Lock — batch 4: memory-domain facts over existing infrastructure.
 *
 * Pins T42 and T43 of `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md`. T42 is
 * a real Cordis `Service` fact (vendor/cordis/src/service.ts:37-53,
 * reflect.ts:272-285): a reference `MemoryService` registers once, serves
 * every logical scope, and a second instance fails loud. T43 is the composite
 * snapshot publisher fold (`snapshot` replaces by producer over the real
 * domain tables that hold per-scope memory state). Both reference
 * implementations are test-tree only.
 * @module evidence-lock/memory-facts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'
import { createScope } from '@deepseek-ai/dsh-scope'
import { MemoryOps, canonicalJson, sha256 } from './review-protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryRef: MemoryServiceRef
  }
}

/** Reference memory service: the registration mechanics are the pinned fact. */
class MemoryServiceRef extends Service {
  /** Shared instance state makes the single-instance property observable. */
  public openedScopes: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'memoryRef')
  }

  openScope(scope: string): void {
    this.openedScopes.push(scope)
  }
}

const memoryScopeSchema = z.object({
  scope: z.string(),
  entries: z.array(z.object({ id: z.string(), text: z.string() })),
  pendingReceipts: z.array(z.object({ opId: z.string() })),
  terminalRing: z.array(z.object({ opId: z.string() })),
})

const roots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

interface MemoryHarness {
  readonly ctx: Context
  readonly memory: MemoryOps
  readonly backend: JsonStorageBackend
}

async function memoryHarness(): Promise<MemoryHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(await tempRoot('dsh-evlock-memory-'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const domain = await facility.open(defineDomain({
    name: 'evlock_memory',
    version: 1,
    tables: { scopes: domainTable<string, z.infer<typeof memoryScopeSchema>>(memoryScopeSchema) },
  }))
  return { ctx, memory: new MemoryOps(domain.table('scopes')), backend }
}

describe('T42 memory-service-single-registration', () => {
  it('registers once, serves two logical scopes from one instance, and fails loud on a second registration', async () => {
    const ctx = new Context()
    // One MemoryService instance for the whole application…
    new MemoryServiceRef(ctx)
    expect(ctx.memoryRef).toBeDefined()

    // …serving both logical scopes: state written through one scope context
    // is visible through the other, because there is exactly one instance.
    const scopeA = createScope(ctx, { name: 'agent-a' })
    const scopeB = createScope(ctx, { name: 'agent-b' })
    scopeA.ctx.memoryRef.openScope('project')
    expect(scopeB.ctx.memoryRef.openedScopes).toEqual(['project'])
    expect(ctx.memoryRef.openedScopes).toEqual(['project'])

    // …and a second instance for the same service name fails loud at
    // registration instead of silently shadowing the first.
    expect(() => new MemoryServiceRef(ctx)).toThrow(/service "memoryRef" has been registered/)
    await scopeA.dispose()
    await scopeB.dispose()
  })
})

describe('T43 memory-composite-snapshot-no-cross-scope-churn', () => {
  it('publishes one producer-replaced message with two sections and only on a combined-digest change', async () => {
    const { memory, backend } = await memoryHarness()

    // Per-scope state lives in the real domain tables.
    await memory.applyOps('project', [{ opId: 'op-p1', text: 'project fact one' }])
    await memory.applyOps('user', [{ opId: 'op-u1', text: 'user preference' }])

    /**
     * Reference of the composite publisher: at most ONE message per producer;
     * a publish replaces its sections in place; the combined digest gates the
     * write, so an unchanged state is silent and a single scope's change
     * never spawns a second message.
     */
    class CompositeSnapshotPublisher {
      private lastDigest: string | undefined
      private readonly messages = new Map<string, { id: string; sections: { scope: string; digest: string }[] }>()

      private sections(): { scope: string; digest: string }[] {
        const out: { scope: string; digest: string }[] = []
        for (const scope of ['project', 'user']) {
          const record = memory.read(scope)
          out.push({ scope, digest: sha256(canonicalJson(record?.entries ?? [])) })
        }
        return out
      }

      publish(producer: string): 'published' | 'silent' {
        const sections = this.sections()
        const combined = sha256(canonicalJson(sections))
        if (combined === this.lastDigest) return 'silent'
        this.lastDigest = combined
        this.messages.set(producer, { id: `${producer}:composite`, sections })
        return 'published'
      }

      snapshot(producer: string): { id: string; sections: { scope: string; digest: string }[] } | undefined {
        return this.messages.get(producer)
      }

      get messageCount(): number {
        return this.messages.size
      }
    }

    const publisher = new CompositeSnapshotPublisher()
    // Initial publish: ONE message carrying BOTH scope sections.
    expect(publisher.publish('review')).toBe('published')
    const initial = publisher.snapshot('review')
    expect(publisher.messageCount).toBe(1)
    expect(initial?.sections).toHaveLength(2)
    expect(initial?.sections.map(section => section.scope)).toEqual(['project', 'user'])

    // A project-only change replaces the SAME message in place — no second
    // user message is spawned by the cross-scope fold.
    await memory.applyOps('project', [{ opId: 'op-p2', text: 'project fact two' }])
    expect(publisher.publish('review')).toBe('published')
    expect(publisher.messageCount).toBe(1)
    const replaced = publisher.snapshot('review')
    expect(replaced?.id).toBe(initial?.id)

    // An unchanged combined state is silent (digest change detection).
    expect(publisher.publish('review')).toBe('silent')
    expect(publisher.messageCount).toBe(1)
    await backend.close()
  })
})
