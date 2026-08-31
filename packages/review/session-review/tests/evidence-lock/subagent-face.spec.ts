/**
 * Evidence Lock — batch 3: subagent family face.
 *
 * Pins T01, T03, T04, T12, T18, T31 of
 * `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md` over the real SubagentRuntime
 * and the real in-process spawn backend; the scripted mock model is the only
 * mocked boundary. Persistence uses the real JSONL backend over a temp root so
 * the child header fact is proven against the raw artifact on disk.
 * @module evidence-lock/subagent-face
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import SubagentRuntime, {
  type SubagentStopReason,
  childSessionMeta,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentRunEndInfo,
  type SubagentRunInfo,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { logPath } from '../../../../session/session-persistence-jsonl/src/format.ts'
import * as spawn from '../../../../subagent/subagent-spawn-in-process/src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'

const roots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

function fakeParent(id = 'evlock-parent'): Agent {
  return {
    id: SessionId(id),
    session: { header: { id: SessionId(id) } },
    ctx: { get: () => undefined },
  } as unknown as Agent
}

function baseRequest(overrides: Partial<SubagentStartRequest> = {}): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'do a thing' }],
    parent: fakeParent(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

class StubProvider implements SubagentProvider {
  readonly inheritsParentContext = false
  startCount = 0
  lastRequest: ResolvedSubagentStartRequest | undefined

  constructor(
    readonly name: string,
    readonly capabilities: SubagentCapabilities = {
      agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true,
    },
    private readonly outcome: SubagentResult = {
      output: [{ type: 'text', text: 'ok' }],
      stopReason: 'completed',
    },
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.startCount += 1
    this.lastRequest = request
    return {
      id: SessionId(`child:${this.name}:${request.parent.id}`),
      localAgent: undefined,
      result: Promise.resolve(this.outcome),
      async dispose() {},
    }
  }
}

async function service(): Promise<{ ctx: Context; subagents: SubagentRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  return { ctx, subagents: ctx.subagents }
}

/** Real spawn backend end to end plus real JSONL persistence over a temp root. */
async function spawnSetup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  const root = await tempRoot('evlock-child-')
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('evlock-parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter, root }
}

function start(
  ctx: Context,
  provider: string,
  request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal },
): Promise<SubagentRun> {
  return ctx.subagents.start(provider, { signal: new AbortController().signal, ...request })
}

describe('T01 start-provider-contract', () => {
  it('resolves the first start() argument by provider name; unknown names reject with NO_PROVIDER', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('spawn')
    subagents.registerProvider(provider)

    const run = await subagents.start('spawn', baseRequest())
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(provider.startCount).toBe(1)
    // The resolved request records the provider it was routed to.
    expect(provider.lastRequest?.descriptor).toMatchObject({ provider: 'spawn' })
    await run.dispose()

    await expect(subagents.start('missing', baseRequest()))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    // Registration itself rejects duplicate names synchronously.
    expect(() => { subagents.registerProvider(new StubProvider('spawn')) })
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_PROVIDER' }))
  })
})

describe('T12 run-result-terminal-states', () => {
  it('passes each terminal stop reason through losslessly; structured stays absent unless captured', async () => {
    // Type-level pin: the merge-extensible terminal vocabulary holds exactly
    // these five reasons in this build (the host typecheck rejects a typo).
    const knownReasons: SubagentStopReason[] = ['completed', 'aborted', 'error', 'max-tokens', 'refusal']
    expect(knownReasons).toHaveLength(5)

    const outcomes: SubagentResult[] = [
      { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' },
      { output: [{ type: 'text', text: 'cut off' }], stopReason: 'max-tokens' },
      { output: [], stopReason: 'error', diagnostic: 'child failed' },
      { output: [{ type: 'text', text: 'I will not' }], stopReason: 'refusal' },
      { output: [], stopReason: 'aborted' },
    ]
    for (const outcome of outcomes) {
      const { subagents } = await service()
      subagents.registerProvider(new StubProvider('stub', undefined, outcome))
      const run = await subagents.start('stub', baseRequest())
      await expect(run.result).resolves.toEqual(outcome)
      expect('structured' in outcome).toBe(false)
      await run.dispose()
    }
    expect(new Set(outcomes.map(outcome => outcome.stopReason))).toEqual(new Set(knownReasons))
  })
})

describe('T18 subagent-start-scoped-events', () => {
  it('pairs subagent/start and subagent/end with runId, provider, child id, and stop reason', async () => {
    const { ctx, subagents } = await service()
    const starts: SubagentRunInfo[] = []
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/start', info => void starts.push({ ...info }))
    ctx.on('subagent/end', info => void ends.push({ ...info }))

    subagents.registerProvider(new StubProvider('stub'))
    const run = await subagents.start('stub', baseRequest())
    await run.result
    await run.dispose()

    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    const startInfo = starts[0] as SubagentRunInfo & { runId: unknown }
    const endInfo = ends[0] as SubagentRunEndInfo & { runId: unknown; stopReason: string }
    expect(startInfo.provider).toBe('stub')
    expect(startInfo.id).toBe(run.id)
    expect(startInfo.local).toBe(false)
    expect(endInfo.runId).toEqual(startInfo.runId)
    expect(endInfo.provider).toBe('stub')
    expect(endInfo.stopReason).toBe('completed')
  })
})

describe('T03 output-schema-capture', () => {
  it('captures structured output only when the child satisfies the schema', async () => {
    const success = await spawnSetup([toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 42 })])
    const okRun = await start(success.ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'answer' }],
      parent: success.parent,
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    })
    const okResult = await okRun.result
    expect(okResult.stopReason).toBe('completed')
    expect(okResult.structured).toEqual({ answer: 42 })
    await okRun.dispose()

    // The child never emits a valid capture: structured stays undefined and
    // the run ends in the error terminal state.
    const failure = await spawnSetup([textResponse('plain answer')])
    const failedRun = await start(failure.ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'answer' }],
      parent: failure.parent,
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    })
    const failedResult = await failedRun.result
    expect(failedResult.structured).toBeUndefined()
    expect(failedResult.stopReason).toBe('error')
    await failedRun.dispose()
  })
})

describe('T04 child-session-persistence', () => {
  it('persists the child header with origin, parentSession, and delegation depth to disk', async () => {
    const { ctx, parent, root } = await spawnSetup([textResponse('child answer')])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'spawn me' }], parent })
    await run.result
    const child = ctx.agents.get(run.id)
    expect(child).toBeDefined()
    expect(child?.session.header.parentSession).toBe(parent.session.header.id)
    await ctx.sessions.flush(child?.session as NonNullable<typeof child>['session'])

    const file = logPath(root, child?.session.header.cwd, child?.session.header.id as SessionId, 'none')
    const lines = (await readFile(file, 'utf8')).split('\n').filter(line => line.length > 0)
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      id: run.id,
      version: 0,
      origin: 'subagent',
      parentSession: parent.session.header.id,
      delegationDepth: 1,
    })
    await run.dispose()
  })

  it('maps a composed preset into the child header meta; no preset leaves no agentPreset key', () => {
    const presetParent = {
      id: SessionId('preset-parent'),
      session: { header: { id: SessionId('preset-parent') } },
      ctx: { get: (name: string) => name === 'agentPresets' ? { composedPreset: () => 'standard' } : undefined },
    } as unknown as Agent
    expect(childSessionMeta(presetParent, 2, 0)).toMatchObject({
      origin: 'subagent',
      parentSession: SessionId('preset-parent'),
      delegationDepth: 2,
      agentPreset: 'standard',
    })
    expect('agentPreset' in childSessionMeta(fakeParent(), 1, 0)).toBe(false)
  })
})

describe('T31 background-cancellation-recoverable', () => {
  it('dispose() cancels the in-flight child while result still settles, idempotently', async () => {
    const { ctx, parent } = await spawnSetup(['hang'])
    const run = await start(ctx, 'spawn', { prompt: [{ type: 'text', text: 'hang forever' }], parent })
    await new Promise(resolve => setTimeout(resolve, 30))

    await run.dispose()
    // The run does NOT hang: disposal settles the in-flight child result.
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    await expect(run.dispose()).resolves.toBeUndefined()
  })
})
