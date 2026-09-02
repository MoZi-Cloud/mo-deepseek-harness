# Agent Note: Bounded autonomous skill evolution

Status: proposed

English | [中文](2026-09-02-bounded-autonomous-skill-evolution.zh.md)

## Problem

The RC5.5 self-evolution design can create managed-skill drafts from durable Session evidence, but production requires human approval before those drafts affect a later task. Its quality evaluation makes a draft visible through an evaluator-only approval, so the measured repeated-task benefit is not reachable by the production autonomous path.

Historical review also derives the reviewer route from the source Session's last request. This makes authorization cost and availability depend on every provider and model that appears in retained history, even though the old route is evidence about the task rather than a requirement for the model that summarizes it today.

Usage-based lifecycle maintenance does not prevent one-session skills from fragmenting the library, and exact-invocation retry detection omits repair episodes where a changed command, argument, ordering, or tool produced the working path. Directly copying Hermes' background mutation would give up the Host-owned identity, replay, admission, and crash guarantees that RC5.5 already established.

## Proposal

Managed skills will record a Host-derived `agent` or `user` owner separately from an operator-controlled autonomous-management opt-in. Only unpinned agent-owned revisions with strong admitted evidence may use an authorized auto-promotion path. Rollout will distinguish shadow, conservative draft, and conservative auto levels. Production and evaluation will call one pure promotion policy and one private activation transaction. A Host-derived background activation identifier will bind the actor, attempt, and exact candidate, while its immutable lineage and current pointer will commit together for replay. Evaluation will require both a domain-separated one-case permit and a non-serializable process-local authority bound to its disposable root; together they replace only the authorization that the evaluation is deciding whether to issue. Production services will accept neither evaluation input.

Conservative live and historical reviews will select a load-time validated named execution profile before deriving the authorization scope or cursor lane. Historical request routes will remain source provenance by event coordinate and digest, but will not select the reviewer, enter lane identity, or multiply evaluation scopes. Inheriting a live task route will remain a shadow-only experiment.

The planner will receive a bounded skill-learning context containing exact managed revisions, support-file manifests, ownership state, loaded skills, related umbrella candidates, and eligible hidden drafts. It may patch only a base included in that context. New skills will target a class-level trigger; narrow session-specific material will prefer support files.

Lifecycle curation will remain deterministic and separate from semantic consolidation. A second bounded consolidation pass will form deterministic candidate clusters, attest a planner execution, and persist an immutable project-level attempt. After exact preflight, the Host will persist consolidation-promotion evidence that binds the attempt, destination, every source base, and preflight digest. The P4 mutation caller will reread that attempt before promotion; P2 will validate its own destination, current-state, policy, and permit facts without importing the P4 store. Automatic destination activation will require both auto-promotion and consolidation capabilities for the same scope; evaluation will replace them with separate root-bound promotion and consolidation authorities. It will commit and activate the destination before archiving any exact-base source, retain every source bundle for restore, and record the destination revision in each absorption. This evidence proves execution admission, not semantic preservation; controlled evaluation will own the latter judgment.

Exact same-invocation recovery will be named `retry-recovered`. Changed-invocation sequences will produce non-causal `RepairEpisode` records that prove only durable ordering, a bounded root-task window, later execution success, and unresolved status. A single episode may create an invisible agent-owned draft. Automatic visibility will require a durable human-only command that confirms the exact lesson and revision or exact lesson-digest corroboration across a configured minimum of distinct source Sessions. Ordinary conversation text cannot let the planner assert this confirmation. The corroboration index will be rebuildable from retained finalized review attempts and exact human repair operations instead of becoming a second candidate authority. A generic Host verifier is deferred until it has a complete capability seam and a durable exact-result protocol.

The [replay-authoritative publication and execution proposal](2026-09-02-replay-authoritative-self-evolution.md) remains the owner of memory surface publication, request attestation, outcome batching, and orphan-reclamation deferral. This proposal extends its execution scope with named profile selection and adds the skill-specific ownership, promotion, repair, and consolidation decisions. Evaluation protocol v2 owns the nine-stratum corpus and rejects reports or authorizations produced by the former seven-stratum protocol. The complete function order and acceptance matrix are recorded in the [RC5.5.5 disposition](../../../../docs/mozi-fork/RC5.5.5-第十一轮评审核验与处置.md).

## Authority map

| Fact | Authority |
|---|---|
| Skill owner and exact revision lineage | Managed-skill record transaction |
| Autonomous activation | Managed activation lineage plus verified rollout permit facts; consolidation also requires Host-derived attempt/preflight evidence |
| Historical task route | Original Session request-header event |
| Reviewer execution | Named review profile, authorization scope, and actual request attestation |
| Repair evidence | Finalized ReviewAttempt and its durable event coordinates |
| Human repair confirmation or rejection | Command-derived operation over an exact candidate or lesson digest |
| Repair corroboration | Rebuildable projection over finalized attempts and repair operations |
| Consolidation progress and absorption intent | Durable ConsolidationAttempt |
| Archived source contents | Retained managed revision bundles and lineage |

## Alternatives considered

**Keep skills proposal-only.** This preserves the smallest mutation surface but does not meet the product goal that historical learning changes future behavior without turning the user into a permanent approval queue.

**Treat a passing P5 profile as proof that every future skill is correct.** P5 establishes statistical fitness of an execution and policy, not the truth of an unseen future proposal. Candidate evidence, unresolved state, ownership, scan, and exact CAS checks must still run for every activation.

**Require evaluation to present an already-issued production authorization.** The authorization is the output of the evaluation, so this creates a cycle. A separate evaluation permit is acceptable only with a root-bound process authority and when every candidate-specific production check and the activation transaction remain identical.

**Run historical review on each source Session's old provider and model.** The original route is useful provenance, but coupling it to the reviewer makes retired providers and historical route diversity determine learning availability and evaluation cost.

**Copy Hermes' full-library consolidation loop.** An unbounded model pass with direct filesystem writes cannot provide exact source baselines, destination-first settlement, crash replay, or a durable explanation of partial absorption.

**Promote any failure followed by a success.** Temporal proximity does not prove repair causality. Changed-method episodes remain candidates until independent authoritative support exists.

**Create an independent experience-candidate database.** A second durable authority would need its own identity, transaction, recovery, retention, and conflict protocol. Finalized attempts already retain the necessary evidence; a rebuildable index is sufficient.

## Acceptance criteria

- An authorized auto scope can make an eligible agent-owned revision visible through the same policy and activation path exercised by evaluation; activation replay is idempotent, and user-owned, pinned, weak-evidence, unresolved, or stale-base revisions cannot auto-promote.
- A retained Session remains learnable through an authorized named reviewer profile after its source provider is unavailable, and source-route changes do not create reviewer lanes or evaluation scopes.
- Consolidation cannot archive a source before the exact destination revision is active, and every archived source remains restorable with exact absorption provenance.
- Exact retries and changed-method episodes are distinct; one repair episode never publishes visible memory or auto-activates a skill.
- Cross-Session repair support is derived from distinct finalized source Sessions and exact human repair operations, and can be rebuilt without changing promotion decisions.
- P5 reports proposal-only benefit separately from production-reachable autonomous skill effect.

## Risks

Auto-promotion accepts a bounded residual semantic-error risk because Host checks cannot prove that model-authored instructions are universally correct. Strong evidence classes, exact ownership, conservative rollout, quality evaluation, provenance, correction, rejection, pinning, archival, and restore reduce and contain that risk but do not eliminate it.

Exact-digest repair corroboration will miss semantically equivalent lessons phrased differently. The first version accepts this false-negative bias instead of making semantic clustering an authority for publication.

Destination-first consolidation can leave both the destination and some sources visible after a crash or stale source base. This temporary duplication is safer than hiding knowledge before the replacement is active; replay and later attempts converge without rollback.

Named review profiles require operators to provision a stable reviewer route. An unavailable profile defers or shadows learning rather than falling back to an untested execution.
