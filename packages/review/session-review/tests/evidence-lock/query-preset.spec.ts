/**
 * Evidence Lock — batch 3: session query filter and standing preset mount.
 *
 * Pins T05, T06 of `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md` over the
 * real session query engine and the real agent-presets standing mount
 * machinery.
 * @module evidence-lock/query-preset
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionQueryEngine, { filterSessionResults } from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionRecord,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import AgentPresets, { livePresetMounts, type Config } from '@deepseek-ai/dsh-agent-presets'

/** Test-only concrete query service for backend-independent behavior. */
class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return {
      session: (await this.readSurface(request.sessionId)).session,
      items: [],
    }
  }
}

function header(id: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 0, ...overrides }
}

function record(id: string, overrides: Partial<SessionHeader>): SessionRecord {
  return { header: header(id, overrides), live: true, persisted: false }
}

describe('T05 parent-filter-query', () => {
  it('[null] matches only root sessions; children surface only under an explicit parent id', () => {
    const parentId = SessionId('evlock-root')
    const records = [
      record('evlock-child', { parentSession: parentId }),
      record('evlock-root-record', {}),
    ]
    expect(filterSessionResults(records, [{ kind: 'parent', values: [null] }]))
      .toEqual([records[1]])
    expect(filterSessionResults(records, [{ kind: 'parent', values: [parentId] }]))
      .toEqual([records[0]])
  })

  it('the live query engine applies the same parent filter over the session store', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(TestSessionQueryEngine)
    ctx.sessions.create(SessionId('evlock-engine-root'))
    ctx.sessions.create(SessionId('evlock-engine-child'), { meta: { parentSession: SessionId('evlock-engine-root') } })

    const roots = await ctx.sessionQuery.filterSessions([{ kind: 'parent', values: [null] }])
    expect(roots.map(r => r.header.id)).toEqual([SessionId('evlock-engine-root')])
    const children = await ctx.sessionQuery.filterSessions([{ kind: 'parent', values: [SessionId('evlock-engine-root')] }])
    expect(children.map(r => r.header.id)).toEqual([SessionId('evlock-engine-child')])
  })
})

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../preset/agent-presets/tests/fixtures')
const ROOTS = [
  { path: join(FIXTURES, 'system'), trust: 'system' as const },
  { path: join(FIXTURES, 'user'), trust: 'user' as const },
]

async function presetHarness(roster: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: ROOTS,
    includeShippedRoot: false,
    includeUserRoot: false,
    ...roster,
  })
  return ctx
}

describe('T06 standing-preset-singleton', () => {
  it('mounts one standing composition per preset that outlives its agents and is shared across sessions', async () => {
    const ctx = await presetHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('evlock-preset-a'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })

    const mountFor = (): ReturnType<typeof livePresetMounts> =>
      livePresetMounts().filter(mount => mount.presetId === 'standard')
    const first = mountFor()
    expect(first).toHaveLength(1)

    // The standing mount survives its agents: a session ending must not strip
    // the composition the next session will join.
    await handle.dispose()
    expect(mountFor()).toHaveLength(1)

    // The second session joins the SAME standing instance instead of adding one.
    await ctx.agents.create({
      sessionId: SessionId('evlock-preset-b'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const second = mountFor()
    expect(second).toHaveLength(1)
    expect(second[0]?.key).toEqual(first[0]?.key)
    expect(second[0]?.tree).toBe(first[0]?.tree)

    // Whole-tree teardown is the boundary that does reclaim it.
    await ctx.fiber.dispose()
    expect(livePresetMounts().some(mount => mount.presetId === 'standard')).toBe(false)
  })
})
