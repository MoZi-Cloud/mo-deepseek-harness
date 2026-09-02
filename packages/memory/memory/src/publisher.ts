/**
 * The memory publisher: a prepended pre-step listener that reads both
 * logical scopes, sanitizes, renders, computes the composite digest, and
 * publishes one `CompositeMemorySnapshot` message only when the digest
 * changed since the last publication in the session log. All failures are
 * swallowed (fail-open) so a storage error never blocks the agent loop.
 * @module @deepseek-ai/dsh-memory/src/publisher
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  buildCompositeSnapshot,
  buildSnapshotSections,
  computeCompositeDigest,
  sanitizeForPublication,
} from './fold.ts'
import type { MemoryConfig, MemoryScope, MemoryState, PublicationEntry, ScopePublication } from './types.ts'
import { latestPublishedMemory } from './service.ts'
import type { MemoryService } from './service.ts'

/**
 * Register the memory publisher pre-step listener.
 * @param ctx - The plugin context; the listener is disposed with it.
 * @param service - The memory service to read state from.
 * @param config - Budgets and switches.
 * @param resolveScope - Resolves the project scope for an agent; `undefined`
 *   when no project scope is available.
 */
export function registerMemoryPublisher(
  ctx: Context,
  service: MemoryService,
  config: MemoryConfig,
  resolveScope: (agent: Agent) => Promise<MemoryScope | undefined>,
): void {
  ctx.on('agent/pre-step', async (
    { agent },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      const message = await maybePublish(agent, service, config, resolveScope)
      if (message === undefined) return decision
      return { ...decision, messages: [...decision.messages, message] }
    } catch {
      // Fail-open: a storage or render error must not block the agent loop.
      // The last published snapshot remains visible in the session log.
      return decision
    }
  }, { prepend: true })
}

/**
 * Read both scopes, render the composite snapshot, compare with the last
 * published digest in the session log, and build one message on change.
 * @param agent - The agent whose session log is scanned for the last digest.
 * @param service - The memory service.
 * @param config - Budgets.
 * @param resolveScope - Resolves the project scope; `undefined` for user-only.
 * @returns the snapshot message, or `undefined` when the digest is unchanged.
 */
async function maybePublish(
  agent: Agent,
  service: MemoryService,
  config: MemoryConfig,
  resolveScope: (agent: Agent) => Promise<MemoryScope | undefined>,
): Promise<UserMessage | undefined> {
  const projectScope = await resolveScope(agent)
  const userScope: MemoryScope = { kind: 'user' }

  const scopes: MemoryScope[] = projectScope === undefined ? [userScope] : [projectScope, userScope]
  const perScope: { scope: MemoryScope; entries: PublicationEntry[]; state: MemoryState }[] = []
  for (const scope of scopes) {
    const state = await service.getState(scope)
    perScope.push({ scope, entries: sanitizeForPublication(state.entries), state })
  }

  const sections = buildSnapshotSections(perScope, config)
  const scopePublications: ScopePublication[] = perScope.map(item => ({
    revision: item.state.revision,
    digest: computeCompositeDigest(sections, {}),
  }))
  const scopeMap: { project?: ScopePublication; user?: ScopePublication } = {}
  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i]
    if (scope === undefined) continue
    const kind = scope.kind
    const pub = scopePublications[i]
    if (pub !== undefined) scopeMap[kind] = pub
  }
  const digest = computeCompositeDigest(sections, scopeMap)
  const snapshot = buildCompositeSnapshot(sections, scopeMap, digest)

  const lastPublished = latestPublishedMemory(agent.session)
  if (lastPublished !== undefined && lastPublished.digest === digest) return undefined

  return createUserMessage({
    content: sections.flatMap(section => [{ type: 'text' as const, text: section.text }]),
    source: {
      kind: 'memory' as const,
      form: 'snapshot' as const,
      sections: [...snapshot.sections],
      scopes: snapshot.scopes,
      digest: snapshot.digest,
    },
  })
}
