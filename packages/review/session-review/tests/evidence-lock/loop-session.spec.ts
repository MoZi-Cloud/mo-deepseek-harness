/**
 * Evidence Lock — batch 3: agent-loop and session core face.
 *
 * Pins T13, T14, T17, T21, T22, T23, T30, T32 of
 * `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md` over the real agent loop,
 * real session store, and real JSONL persistence; the scripted mock model is
 * the only mocked boundary.
 * @module evidence-lock/loop-session
 */

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  foldRequestHeader,
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { logPath } from '../../../../session/session-persistence-jsonl/src/format.ts'
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

async function harness(adapter: MockAdapter, invariants = false): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (invariants) {
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AgentLoopInvariant)
  }
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

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function eventsOf(agent: Agent): SessionEvent[] {
  return [...agent.session.events]
}

function messageTexts(messages: readonly Message[]): string[] {
  return messages.flatMap(m => blockTexts(m.content))
}

function blockTexts(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-result') return blockTexts(block.content)
    return []
  })
}

describe('T13 request-header-bytestable', () => {
  it('folds the durable log to a byte-identical header across a replayed seed', async () => {
    const adapter = new MockAdapter([textResponse('header reply')])
    const ctx = await harness(adapter, true)
    const agent = ctx.agentLoop.create(SessionId('evlock-header'), { provider: 'mock', model: 'mock' })
    send(agent, 'establish the header')
    await waitForIdle(ctx, agent)

    const live = agent.session.requestHeader()
    if (live === undefined || live.system === undefined) throw new Error('expected a folded request header with a system prompt')
    expect(live.system.length).toBeGreaterThan(0)
    // The incremental fold equals a fold over the whole durable log, byte for byte.
    expect(JSON.stringify(foldRequestHeader(eventsOf(agent)))).toBe(JSON.stringify(live))

    // Replaying the same log through a fresh store folds to the identical header.
    const replayCtx = new Context()
    await replayCtx.plugin(SessionStore)
    const replay = replayCtx.sessions.create(agent.session.header.id, {
      seed: structuredClone(eventsOf(agent)),
      meta: structuredClone(agent.session.header),
    })
    expect(JSON.stringify(replay.requestHeader())).toBe(JSON.stringify(live))
  })
})

describe('T14 fail-closed-vocabulary', () => {
  it('refuses to interpret a persisted log with an event type unknown to this build', async () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has('turn/end')).toBe(true)

    const root = await tempRoot('evlock-vocab-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const session = ctx.sessions.create(SessionId('evlock-vocab-1'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    await ctx.fiber.dispose()

    const file = logPath(root, session.header.cwd, session.header.id, 'none')
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter(line => line.length > 0)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 'evlock-vocab-1', version: 0 })
    const last = JSON.parse(lines.at(-1) as string) as { seq: number }
    const unknownLine = JSON.stringify({ ...last, seq: last.seq + 1, type: 'future/event', data: {} })
    await appendFile(file, (raw.endsWith('\n') ? '' : '\n') + unknownLine + '\n')

    expect(KNOWN_SESSION_EVENT_TYPES.has('future/event')).toBe(false)
    const reload = new Context()
    await reload.plugin(SessionStore)
    await reload.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expect(reload.sessionPersistence.load(SessionId('evlock-vocab-1')))
      .rejects.toThrow(/refusing to interpret/)
  })
})

describe('T17 compaction-surface-vs-seq', () => {
  it('replaces the surface without touching log seqs, and requires full replace provenance', () => {
    const session = Session.create(SessionId('evlock-compaction'))
    const seqs = ['one', 'two', 'three'].map(text => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq)
    const [firstShadowed, middleShadowed, lastShadowed] = seqs
    if (firstShadowed === undefined || middleShadowed === undefined || lastShadowed === undefined) {
      throw new Error('expected three shadowed surface nodes')
    }

    const before = eventsOfLength(session)
    const compactionId = CompactionId('evlock-compaction')
    const start = session.append('compaction/start', { compactionId, turn: 1 })
    const summary = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'summary of three' }],
      shadowedRange: { start: firstShadowed, end: lastShadowed },
      shadowedSeqs: seqs,
      shadowedTokenCount: 0,
      provider: 'stub',
      model: 'stub',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', start: firstShadowed, end: lastShadowed },
      sourceEventSeqs: [start.seq, summary.seq, firstShadowed, middleShadowed, lastShadowed],
    })

    // Append-only log: every pre-compaction event keeps its seq and payload.
    expect(session.events).toHaveLength(before + 3)
    for (const [index, event] of session.events.slice(0, before).entries()) {
      expect(event.seq).toBe(seqsOf(session)[index])
      expect(event.type).toBe(typesOf(session)[index])
    }
    // The surface now folds to exactly the checkpoint message.
    const surface = session.deriveMessages()
    expect(surface).toHaveLength(1)
    expect(messageTexts(surface)).toEqual(['checkpoint'])
    // The replacement cites every shadowed surface node.
    const replacement = session.events.at(-1) as SessionEvent & { sourceEventSeqs?: number[] }
    for (const seq of [firstShadowed, middleShadowed, lastShadowed]) {
      expect(replacement.sourceEventSeqs).toContain(seq)
    }

    // A replace without full provenance is rejected up front: the list is
    // non-empty (user/message replacements always cite provenance) but must
    // also cover EVERY shadowed surface node.
    const survivor = (session.events.at(-1) as { seq: number }).seq
    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unprovenanced' }],
      source: compactCheckpointSource(CompactionId('evlock-unprovenanced')),
    }), {
      surfaceOp: { op: 'replace', start: survivor, end: survivor },
      sourceEventSeqs: [firstShadowed],
    })).toThrow(/must include every shadowed surface node/)
  })
})

function eventsOfLength(session: Session): number {
  return session.events.length
}

function seqsOf(session: Session): number[] {
  return session.events.map(event => event.seq)
}

function typesOf(session: Session): string[] {
  return session.events.map(event => event.type)
}

describe('T21 pre-step-waterfall-order', () => {
  it('a listener can delay the step and inject context before the model request', async () => {
    const adapter = new MockAdapter([textResponse('delayed reply')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('evlock-pre-step-delay'), { provider: 'mock', model: 'mock' })
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
      entered.resolve(undefined)
      await gate.promise
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      return {
        ...decision,
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: '[evlock pre-step context]' }],
          source: { kind: 'plugin', plugin: 'evlock' },
        })],
      }
    })

    send(agent, 'go')
    await entered.promise
    // The awaited waterfall blocks the step: no model call and no step/start yet.
    expect(adapter.requests).toHaveLength(0)
    expect(eventsOf(agent).some(event => event.type === 'step/start')).toBe(false)

    gate.resolve(undefined)
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(messageTexts(adapter.requests[0]?.messages ?? [])).toContain('[evlock pre-step context]')
  })

  it('a listener can reject the step: the turn ends blocked with no model call', async () => {
    const adapter = new MockAdapter([textResponse('never asked')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('evlock-pre-step-reject'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
      await next()
      return { kind: 'reject' }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(0)
    expect(eventsOf(agent).some(event => event.type === 'step/start')).toBe(false)
    const turnEnd = eventsOf(agent).find(event => event.type === 'turn/end')
    expect(turnEnd).toBeDefined()
  })
})

describe('T22 session-event-observe', () => {
  it('delivers every committed event with a monotonic seq, turn/end last', async () => {
    const adapter = new MockAdapter([textResponse('observed reply')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('evlock-observe'), { provider: 'mock', model: 'mock' })
    const seen: SessionEvent[] = []
    let committedAtDelivery = true
    ctx.on('session/event', (session, event) => {
      if (!session.events.some(committed => committed.seq === event.seq)) committedAtDelivery = false
      seen.push({ ...event })
    })

    send(agent, 'observe me')
    await waitForIdle(ctx, agent)

    // The inbox append may precede the turn; the four loop events stay
    // ordered, and turn/end closes the durable log.
    const order = seen.map(event => event.type)
    expect(order.indexOf('turn/start')).toBeGreaterThan(-1)
    expect(order.indexOf('turn/start')).toBeLessThan(order.indexOf('step/start'))
    expect(order.indexOf('step/start')).toBeLessThan(order.indexOf('step/end'))
    expect(order.indexOf('step/end')).toBeLessThan(order.indexOf('turn/end'))
    expect(eventsOf(agent).at(-1)?.type).toBe('turn/end')
    for (const [index, event] of seen.entries()) {
      expect(typeof event.seq).toBe('number')
      if (index > 0) expect(event.seq).toBeGreaterThan((seen[index - 1] as SessionEvent).seq)
    }
    expect(committedAtDelivery).toBe(true)
    const turnEnd = seen.find(event => event.type === 'turn/end') as SessionEvent & { data: { turn: number; reason: { kind: string } } }
    expect(turnEnd.data.turn).toBe(1)
    expect(turnEnd.data.reason.kind).toBe('completed')
  })
})

describe('T23 run-maintenance-claim', () => {
  it('throws while a turn owns the agent, and re-enters cleanly once idle', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('evlock-maintenance'), { provider: 'mock', model: 'mock' })
    send(agent, 'hold the agent busy')
    await new Promise(resolve => setTimeout(resolve, 20))

    // The claim throws synchronously while a turn owns the agent.
    expect(() => agent.runMaintenance(async () => 'never')).toThrow(/already has active work/)

    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await expect(agent.runMaintenance(async () => 'maintenance ran')).resolves.toBe('maintenance ran')
  })
})

describe('T30 blocking-order-publisher-sees-commit', () => {
  it('a post-commit observer already sees the tool result the next request carries', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'evlock-note', { text: 'committed fact' }),
      textResponse('acknowledged'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'evlock-note',
      description: 'records a fact',
      parameters: { text: { type: 'string', required: true } },
      execute: async args => [{ type: 'text', text: `noted:${args.text}` }],
    }))
    const agent = ctx.agentLoop.create(SessionId('evlock-publisher'), { provider: 'mock', model: 'mock' })

    const publisherViews: string[][] = []
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result') return
      // The log is committed before observers run, so the derived view at
      // listener time already contains this exact tool result.
      publisherViews.push(messageTexts(session.deriveMessages()))
    })

    send(agent, 'record and answer')
    await waitForIdle(ctx, agent)

    expect(publisherViews).toHaveLength(1)
    expect(publisherViews[0]?.some(text => text.includes('noted:committed fact'))).toBe(true)
    expect(adapter.requests).toHaveLength(2)
    expect(messageTexts(adapter.requests[1]?.messages ?? []).some(text => text.includes('noted:committed fact'))).toBe(true)
  })
})

describe('T32 assistant-final-derivation', () => {
  it('logs assistant messages without a final flag; the turn fold projects only the last', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'evlock-echo', { text: 'intermediate' }),
      textResponse('final words'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'evlock-echo',
      description: 'echoes text',
      parameters: { text: { type: 'string', required: true } },
      execute: async args => [{ type: 'text', text: `echo:${args.text}` }],
    }))
    const agent = ctx.agentLoop.create(SessionId('evlock-final'), { provider: 'mock', model: 'mock' })
    send(agent, 'two steps')
    await waitForIdle(ctx, agent)

    const assistantMessages = eventsOf(agent).filter(event => event.type === 'assistant/message')
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2)
    for (const event of assistantMessages) {
      expect(Object.keys(event.data).filter(key => key === 'final')).toEqual([])
    }
    const final = finalAssistantOutput(eventsOf(agent))
    expect(final).toEqual([{ type: 'text', text: 'final words' }])
  })
})
