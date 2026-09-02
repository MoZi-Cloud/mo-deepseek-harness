# Agent Note: Replay-authoritative self-evolution publication and execution

Status: proposed

English | [中文](2026-09-02-replay-authoritative-self-evolution.zh.md)

## Problem

The RC5.5 self-evolution design turns historical Session evidence into durable memory and managed-skill proposals. The current memory publisher returns a snapshot message from `agent/pre-step`, but the Agent Loop appends every admitted pre-step message to the Session surface. A message source marked as a snapshot therefore does not replace the prior model-visible memory authority.

Durable learning also needs to prove that the planner execution admitted by rollout is the execution that produced a plan. A provider and model allowlist omits resolved adapter defaults, the isolated system and tool assembly, schema versions, and provider execution options. Claiming a conservative cursor before this proof can consume that lane with an untested execution.

The curator's ordinal-only checkpoint cannot make progress past one finalized outcome that yields more signals than a configured pass limit. Skipping that outcome would discard positive usage evidence and could later misclassify an active skill as stale. Managed-skill orphan storage has a separate availability concern, but its byte and count quotas already bound growth and fail closed.

## Proposal

Every entered pre-step decision will carry a complete one-to-one mapping from final message ids to surface intents. Ordinary messages receive an explicit append intent; a missing intent never defaults to append. The Agent Loop will commit the mapped intents only for the final accepted decision after `step/start`; producers will not append directly. Memory publication will derive the one current memory node from `session.surface.nodes`, then choose append, exact single-node replace, no-op, or a fixed payload-free unavailable snapshot. This extends the existing [Session surface](../../implemented/architecture/2026-06-18-session-surface.md) and [reconstructable-request](../../implemented/architecture/2026-07-05-reconstructable-requests.md) decisions without replacing their event-log authority.

Review rollout will authorize a stable execution scope built from one shared isolated Epoch template, resolved call configuration, adapter execution-profile digest, output-schema digest, and policy versions. Lane selection will happen before claim. The planner provider will attest the actual request header and adapter profile; the ledger will persist and compare that attestation before storing an immutable plan or mutating a resource. Unapproved or unattestable executions will use shadow lanes only.

The review child will have a complete review-owned system prompt, suppressed standing and runtime context, and no ordinary global tools. The scoped `structured_output` tool installed by the output-schema implementation remains the sole visible tool and must succeed exactly once. This specializes, but does not supersede, the existing [subagent composition controls](../../implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md).

Curator checkpoints will retain an outcome ordinal, immutable outcome digest, signal-derivation version, and stable strict-after signal coordinate. Oversized outcomes will settle in bounded deterministic batches. A locatable corrupt item will create a durable unresolved fault before the main checkpoint advances; later positive evidence may continue, while negative lifecycle transitions remain disabled until repair. Domain-level corruption that cannot identify an item will remain fail closed.

Physical orphan reclamation will remain outside the core managed-skill authoring phase. A later operator protocol may reclaim only a branded revision identity under a project mutation maintenance lock after durable preparation, complete authority-reference revalidation, quarantine, and crash-safe settlement. Raw-path deletion and automatic garbage collection are not supported.

The [RC5.5.4 disposition](../../../../docs/mozi-fork/RC5.5.4-第十轮评审核验与处置.md) records the function order for these four mechanisms. Named reviewer selection and managed-skill ownership, promotion, repair, and consolidation are owned by the later [bounded autonomous skill evolution proposal](2026-09-02-bounded-autonomous-skill-evolution.md). The implemented [P0 Evidence Lock note](../../implemented/feature/2026-08-31-session-review-p0-skeleton.md) remains the owner of its shipped test-only reference suite; this proposal does not promote those references into production.

## Protocol ownership

| Fact | Authority |
|---|---|
| Current model-visible memory | Durable Session surface plus the visible memory event |
| Memory contents and revision | `MemoryState` in the memory storage domain |
| Conservative planner eligibility | Signed rollout authorization over a stable execution-scope digest |
| Planner execution that produced a plan | Provider request attestation retained by `ReviewAttempt` |
| Curator progress within one outcome | Durable ordinal, outcome digest, derivation version, and signal coordinate |
| Corrupt-outcome coverage status | Durable unresolved fault and its repair cursor |

## Alternatives considered

**Let the memory plugin append or replace during `agent/pre-step`.** This can write a Session event before a later waterfall listener rejects or rewrites the decision. The loop must remain the single committer of admitted pre-step messages.

**Track a publication-dirty flag.** A crash after the memory CAS and before the flag write loses the warning. Comparing durable memory revisions with the durable visible snapshot derives staleness without another authority.

**Authorize only provider and model, or key lanes by the signed artifact.** The former omits execution-relevant request fields; the latter creates new lanes when a report is re-signed without changing the tested execution. The stable scope owns lane identity, while the signed artifact proves approval.

**Skip every oversized or corrupt outcome.** Oversized outcomes are valid bounded work and may contain positive evidence. Only a locatable corrupt item may be faulted past, and that fault disables inactivity-based negative transitions until repaired.

**Add automatic orphan garbage collection now.** Current quotas already prevent unbounded growth. Deletion before lineage, pending, reservation, review-attempt, quarantine, and replay semantics are specified would trade bounded authoring unavailability for irreversible corruption risk.

## Acceptance criteria

- Each request contains at most one current memory-source authority; correction, removal, compaction, publication failure, and replay preserve that rule.
- A conservative claim exists only for an authorized stable execution scope, and an actual-attestation mismatch produces no immutable plan, cursor advance, or resource mutation.
- The planner sees no ordinary tool and completes exactly one scoped `structured_output` call under an isolated prompt.
- An oversized finalized outcome eventually settles all deterministic batches and does not block the next ordinal.
- A recorded corrupt-item fault permits later positive evidence but prevents active-to-stale and stale-to-archived transitions until exact repair completes.
- P2 authoring remains bounded and fail closed without introducing a supported physical-delete path.

## Risks

The generic surface-intent carrier broadens Agent Loop API and requires every listener that rewrites admitted messages to preserve, replace, or remove the associated intents in the same decision. A missing mapping, orphan mapping, or invalid or duplicate message identity must fail before a model request rather than silently weakening replacement provenance.

Some remote planner providers may not be able to attest the actual request envelope or expose a stable execution-profile digest. Those providers remain useful for shadow evaluation but cannot perform conservative durable learning.

An unresolved curator fault can postpone archival indefinitely, and deferring orphan reclamation can eventually stop new skill revisions at quota. Both outcomes deliberately preserve evidence and fail closed; operator diagnostics must identify the exact fault or inventory that requires intervention.
