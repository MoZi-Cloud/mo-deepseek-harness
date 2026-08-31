/**
 * Evidence Lock — batch 3: tool restriction, durable tool-result surface, and
 * skill catalog/provider attribution.
 *
 * Pins T02, T15, T16, T41 of `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md`
 * over the real tool runtime, real skill registry, real filesystem skill
 * discovery, and the real agent loop (mock model is the only mocked boundary).
 * The managed-provider attribution fold is an in-test reference
 * implementation: it reads the live `tools/result` channel the review design
 * relies on without registering any production behavior.
 * @module evidence-lock/tools-skill
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'

const homes: string[] = []
const toolSignal = new AbortController().signal

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  homes.push(dir)
  return dir
}

afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true })
})

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

/** Mount the tool runtime with its systemPrompt dependency on a fresh context. */
async function toolsMount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Mint a scope whose key doubles as a minimal Agent-like subject. */
async function mintAgentScope(ctx: Context, name: string): Promise<{ scope: ReturnType<typeof createScope>; key: Agent }> {
  const key = { id: SessionId(name) } as Agent
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  return { scope, key }
}

function simpleTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve(`ran:${name}`),
  }
}

async function run(ctx: Context, name: string, agent?: Agent): Promise<string> {
  const result = await ctx.tools.execute({
    signal: toolSignal,
    callId: ToolCallId('c1'),
    name,
    arguments: {},
    ...agent ? { agent } : {},
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

describe('T02 allow-empty-inherited-tools', () => {
  it('allow:[] strips every inherited tool, keeps scoped registrations and the reserved PTC transport', async () => {
    const ctx = await toolsMount()
    const { scope, key } = await mintAgentScope(ctx, 'evlock-allow-empty')
    ctx.tools.register(simpleTool('evlock-read'))
    ctx.tools.register(simpleTool('evlock-bash'))

    scope.ctx.tools.restrict({ allow: [] })
    expect(ctx.tools.schemas(key)).toEqual([])

    // Same-name execution is rejected for the masked global tool.
    expect(await run(ctx, 'evlock-bash', key)).toBe('Error: unknown tool "evlock-bash"')

    // Scoped registration is unaffected by the inherited-tools filter.
    scope.ctx.tools.register(simpleTool('evlock-local'))
    expect(ctx.tools.schemas(key).map(t => t.name)).toEqual(['evlock-local'])
    expect(await run(ctx, 'evlock-local', key)).toBe('ran:evlock-local')

    // The reserved PTC presentation transport survives: it cannot be
    // registered, shadowed, or named by a restriction.
    expect(() => ctx.tools.register(simpleTool('run_code')))
      .toThrow(/reserved for the PTC mode presentation transport/)
    expect(() => scope.ctx.tools.restrict({ allow: ['run_code'] }))
      .toThrow(/cannot name reserved PTC mode presentation transport/)
    expect(() => scope.ctx.tools.restrict({ deny: ['run_code'] }))
      .toThrow(/cannot name reserved PTC mode presentation transport/)
  })
})

async function loopHarness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('T15 tool-result-durable-surface', () => {
  it('persists exec identity via call pairing and isError, with no canonical value or provider', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'evlock-note', { text: 'durable fact' }),
      toolCallResponse('c2', 'evlock-boom', {}),
      textResponse('done'),
    ])
    const ctx = await loopHarness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'evlock-note',
      description: 'records a fact',
      parameters: { text: { type: 'string', required: true } },
      execute: async args => [{ type: 'text', text: `noted:${args.text}` }],
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'evlock-boom',
      description: 'always fails',
      parameters: {},
      execute: async () => { throw new Error('evlock boom') },
    }))
    const agent = ctx.agentLoop.create(SessionId('evlock-durable'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const calls = new Map(agent.session.events
      .filter((event): event is SessionEvent & { type: 'tool/call' } => event.type === 'tool/call')
      .map(event => [event.data.callId, event.data.name]))
    expect(calls.get(ToolCallId('c1'))).toBe('evlock-note')
    expect(calls.get(ToolCallId('c2'))).toBe('evlock-boom')

    const durableResults = agent.session.events
      .filter((event): event is SessionEvent & { type: 'tool/result' } => event.type === 'tool/result')
    expect(durableResults).toHaveLength(2)
    for (const event of durableResults) {
      // Exec identity is recoverable ONLY through the tool/call pairing.
      expect(Object.keys(event.data).filter(key => key === 'name' || key === 'value' || key === 'provider')).toEqual([])
      expect(Object.keys(event.data).every(key => ['turn', 'step', 'message', 'error', 'meta'].includes(key))).toBe(true)
      expect(event.data.message.source.kind).toBe('tool')
      const block = event.data.message.content[0]
      expect(block?.type).toBe('tool-result')
    }
    const ok = durableResults.find(event => event.data.message.source.callId === ToolCallId('c1'))
    const failed = durableResults.find(event => event.data.message.source.callId === ToolCallId('c2'))
    expect(ok?.data.message.content[0]).toMatchObject({ isError: false })
    expect(failed?.data.message.content[0]).toMatchObject({ isError: true })
  })
})

/** Full tool-skill stack over real skill files under a temp home. */
async function skillHarness(home: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    watch: false,
  })
  await ctx.plugin(toolSkill, {})
  return ctx
}

function sessionAgent(name: string): Agent {
  const id = SessionId(name)
  const session = Session.create(id)
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('step-boundary catalog must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function catalogEvents(session: Session): SessionEvent[] {
  return session.events.filter((event): event is SessionEvent & { type: 'user/message' } => event.type === 'user/message'
    && event.data.source.kind === 'skill-catalog')
}

describe('T16 catalog-pre-step-timing', () => {
  it('publishes the skill catalog inside the awaited pre-step waterfall', async () => {
    const home = await tempDir('evlock-catalog-')
    await writeSkill(join(home, '.dsh/skills'), 'evlock-skill', 'Catalogued skill', 'Body.')
    const ctx = await skillHarness(home)
    const agent = sessionAgent('evlock-catalog')

    // The catalog travels in the awaited waterfall's decision: dispatching the
    // pre-step with a bare enter base yields messages the plugin listener
    // wrapped around it — a fire-and-forget append could not do that.
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages.some(m => m.source.kind === 'skill-catalog')).toBe(true)
      for (const message of decision.messages) {
        agent.session.append('user/message', message, { surfaceOp: 'append' })
      }
    }

    const initial = catalogEvents(agent.session)
    expect(initial).toHaveLength(1)
    const source = (initial[0] as SessionEvent & { data: { source: { entries: { name: string; description: string }[] } } }).data.source
    expect(source.entries.some(entry => entry.name === 'evlock-skill' && entry.description === 'Catalogued skill')).toBe(true)
    // The catalog lives on the message surface.
    expect(agent.session.deriveMessages().some(m => m.source.kind === 'skill-catalog')).toBe(true)
  })
})

describe('T41 skill-live-result-provider-attribution', () => {
  it('the live tools/result channel carries the winning provider; attribution counts managed wins only', async () => {
    const home = await tempDir('evlock-attribution-')
    await writeSkill(join(home, '.dsh/skills'), 'evlock-human', 'Human skill', 'Human body.')
    const ctx = await skillHarness(home)

    const managed: SkillCandidate = {
      name: 'evlock-evolved',
      description: 'Evolved skill',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'self-evolution-managed',
      source: 'managed',
      rank: 100,
      locator: { revision: 1 },
    }
    const evolvedProvider: SkillProvider = {
      name: 'self-evolution-managed',
      list: async () => [managed],
      get: async candidate => ({ ...candidate, content: 'Evolved body.' }),
    }
    ctx.skills.registerProvider(() => evolvedProvider)

    interface LiveResult { name: string; provider: unknown; frozenExec: boolean }
    const live: LiveResult[] = []
    ctx.on('tools/result', (exec, result) => {
      live.push({
        name: exec.name,
        provider: (result.value as { provider?: unknown } | undefined)?.provider,
        frozenExec: Object.isFrozen(exec),
      })
    })

    const agent = sessionAgent('evlock-attribution')
    for (const [callId, skillName] of [['t1', 'evlock-evolved'], ['t2', 'evlock-human']] as const) {
      const result = await ctx.tools.execute({
        signal: toolSignal,
        callId: ToolCallId(callId),
        name: 'skill',
        arguments: { name: skillName },
        agent,
      })
      expect(result.isError).toBe(false)
      expect((result.value as { content?: string }).content).toContain(skillName === 'evlock-evolved' ? 'Evolved body.' : 'Human body.')
    }

    // Lossless final outcomes: frozen executions, one per invocation, each
    // carrying the winning provider.
    expect(live).toHaveLength(2)
    expect(live.every(entry => entry.name === 'skill' && entry.frozenExec)).toBe(true)
    const byProvider = live.map(entry => String(entry.provider)).sort()
    expect(byProvider).toEqual(['filesystem', 'self-evolution-managed'])

    // Reference attribution fold over the live channel: only
    // self-evolution-managed wins count as managed work.
    const managedWins = live.filter(entry => entry.provider === 'self-evolution-managed')
    expect(managedWins).toHaveLength(1)
    expect(live.filter(entry => entry.provider === 'filesystem')).toHaveLength(1)
  })
})
