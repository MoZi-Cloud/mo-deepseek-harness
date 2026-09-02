# RC5.5.4 附件 P3 — Session review（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；前置：P1、P2；包：`packages/review/session-review`，以及 subagent/LLM 的 planner execution 叶子扩展；日期：2026-09-02。
>
> 本包是唯一 host 级 `SessionReviewService extends Service`。`skill_manage` 仍只挂 authoring preset；planner 使用 fresh child、review-owned complete prompt、runtime-context suppression 与 `toolFilter:{allow:[]}` 隔离普通工具。`outputSchema` 安装的 scoped `structured_output` 是唯一例外，必须可见并恰好成功一次。

## 1. 模块布局

```text
src/types.ts          # plan/outcome/cursor/attempt/provenance/config types
src/config.ts         # config validation + review provider preflight
src/eligibility.ts    # root/session/preset/control predicates
src/learning-view.ts  # event projection、turn fold、outcome signals
src/plan-schema.ts    # discriminated ReviewPlan schema/output schema
src/plan-identity.ts  # canonical JSON、enumeration、digests、ids/version
src/execution-auth.ts # execution scope、authorization、lane selection、request attestation
src/targets.ts        # exact memory/skill target resolution
src/admissibility.ts  # evidence/outcome/policy/whole-plan preflight
src/cursor.ts         # lane/due/disposition/release durable store
src/ledger.ts         # attempts/governance/provenance projection
src/finalization.ts   # applied-only grouping + recovery protocol
src/planner.ts        # provider preflight/start/gate
src/runtime.ts        # stored-plan saga
src/history.ts        # corpus enumeration/checkpoint/resume
src/governance.ts     # memory/skill/review human commands
src/index.ts          # host Service、events/effects/maintenance assembly
```

## 2. 核心类型

```text
ReviewCursorLaneId = Branded<'ReviewCursorLaneId'>
ReviewRangeId = Branded<'ReviewRangeId'>
ReviewAttemptId = Branded<'ReviewAttemptId'>
OpId = Branded<'OpId'>
ReviewCursorLane = {laneId,sessionId,reviewedThroughSeq,desiredThroughSeq,nextAttemptNo,
                    inFlight?:{attemptId,resumeRetryCount,resumeBlockedUntil?},
                    retryCountSinceAdvance,supersedeCountSinceAdvance,
                    blockedUntil?,manualHold?}
DispositionDecision =
  | {kind:'consumed'}
  | {kind:'superseded',count}
  | {kind:'retryable',count,blockedUntil}
  | {kind:'manual',reason,heldAt}
FinalizedOutcomeOrdinal = Branded<'FinalizedOutcomeOrdinal'>  # canonical positive decimal string
ReviewAttempt = {attemptId,range,status,opIdentityVersion,claimedScopeDigest,
                 authorizationArtifactDigest?,effectiveThrough?,outcomes?,
                 actualRequestAttestation?,attestationMatched?,immutablePlan?,planDigest?,
                 baseRevisions?,opStates[],terminal?,finalized?,
                 finalizedOutcomeOrdinal?:FinalizedOutcomeOrdinal}
ReviewOpState = {opId,resource:'memory'|'skill',resourceRef,state:'prepared'|'applied'|'duplicate'|'failed'}
FinalizedOutcomePageQuery = {afterOrdinal?:FinalizedOutcomeOrdinal,limit}
FinalizedOutcomePage = {items,nextAfterOrdinal?:FinalizedOutcomeOrdinal,atEnd}
ReviewMemoryOp = AddPlanMemoryOp | UpdatePlanMemoryOp | RemovePlanMemoryOp
LearningKind = user-fact | user-preference | project-fact | verified-procedure | verified-recovery | caution
OutcomeSignal = {kind:'user-authored'|'tool-success'|'tool-failure'|'failure-recovered'|'unresolved'|'transient'|'unknown',
                 sessionId,turnRef,eventSeqs,callIds,invocationFingerprint?}
ReviewSettlement = committed | empty-plan | user-skip | admission-rejected | stale-state |
                   consolidatable-plan-budget | transient-infrastructure | planner-infrastructure |
                   protocol-failure
ReviewSettlementClass = {kind:'consumed'|'superseded'|'retryable'|'resume'|'manual',reasonCode,scoreAsFalseProposal}
OperationProvenance = review-attempt | governance-command | direct-skill-tool
GovernanceOperation = {opId,sessionId,commandId,action,target,status:'prepared'|'applied'|'failed',result?}
ReviewAuthorizationScope = {reviewProvider,resolvedCallConfig,adapterExecutionProfileDigest,
                            canonicalEpochHeader,outputSchemaDigest,policyVersion,
                            learningViewVersion,opIdentityVersion,evalProtocolVersion}
ReviewAuthorizationScopeDigest = Branded<'ReviewAuthorizationScopeDigest'>
RolloutAuthorization = {from:'shadow',to:'conservative',authorizedScopes:[{scopeDigest,
                        reportDigest}],versions,approvedBy,approvedAt,signature,artifactDigest}
ReviewLaneSelection = {rolloutLevel:'shadow'|'conservative',scopeDigest,authorizationArtifactDigest?}
ReviewRequestAttestation = {scopeDigest,actualEpochHeaderDigest,adapterExecutionProfileDigest,
                            childSessionId}
```

Update/remove memory plan 必须有 `targetEntryId/expectedEntryDigest`；skill patch 必须有 `ManagedSkillRef/baseRevision/baseContentDigest`。`targetHint/reason/confidence` 可保留为说明，但不拥有 target、evidence 或 authorization 权力。

## 3. 开发拓扑

| 顺序 | 节点 | 只可调用 |
|---:|---|---|
| P3-E01 | isolated planner prompt + adapter execution profile + provider request attestation primitives | existing system-prompt/subagent/llm/session APIs |
| P3-D01 | types + Config/authorization schema | P1/P2 public types、E01 types、existing core types |
| P3-D02 | `isRootSession/isReviewEligibleSession` | D01 |
| P3-D03 | `eventKindAdmissible/projectEvents/canonicalToolInvocationFingerprint` | D01、durable session events、crypto |
| P3-D04 | `classifyOutcomeSignals` | D03 projected events |
| P3-D05 | ReviewPlanSchema + `enumeratePlanOps/canonicalPlanOpDigest` | D01 |
| P3-D06 | `resolveReviewAuthorizationScope/verifyRolloutAuthorization/selectReviewLane` | D01、E01、parent route、P5 artifact |
| P3-D07 | lane/range/attempt/review-op/direct-command id derivation | D01、D05 canonical digest、D06 scope digest |
| P3-D08 | `resolveMemoryPlanTargets/resolveSkillPlanTargets` | D01、P1/P2 current views |
| P3-D09 | evidence/outcome/policy checks + `wholePlanAdmission` | D03–D08、P1/P2 preflight APIs |
| P3-D10 | `classifyReviewSettlement` | D01、D09 typed results |
| P3-D11 | `decideResumeGate/decideDisposition` | D01、D10 |
| P3-D12 | cursor pure transitions | D01、D07、D11 |
| P3-D13 | `ReviewCursorStore` | D12、storage domain |
| P3-D14 | `ReviewClaimCoordinator` | D13 |
| P3-D15 | ledger/governance records/outcome + provenance projection | D01、D05、D07、storage domain |
| P3-D16 | finalized-receipt grouping + `finalizeAttempt/reconcileReviewState` | D11、D13–D15、P1/P2 finalized-ack |
| P3-D17 | `resolveReviewProvider/startPlanner/attestPlannerRequest/gatePlannerResult` | D01、D05–D06、E01、subagent service |
| P3-D18 | `ReviewRuntime.runReview/ensureReviewThrough` | D02–D17、P1/P2 mutation APIs |
| P3-D19 | live scheduler/foreground settlement | D02、D06、D14、D16、D18 |
| P3-D20 | history enumeration/checkpoint/route/preset resume | D02、D06、D14、D18、sessionQuery/agents/presets |
| P3-D21 | governance commands + provenance show | D07–D08、D11、D13–D16、P1/P2 direct/governance APIs |
| P3-D22 | `SessionReviewService` assembly | E01、D01–D21 |

不得先写 D18 再回填 execution authorization/identity/admission；不得先 claim conservative lane 再检查 authorization；不得让 history 自建 claim；不得让 governance 绕过 resource direct API。

#### isolated planner prompt + adapter execution profile + provider request attestation primitives
- 拓扑：P3-E01；这是 P3-D01 前完成的既有 capability 小扩展。
- 职责：subagent one-shot request 增加 review 使用的 `isolatedPrompt` capability：child scope 注册一个 complete system section并 suppress 全部 runtime context；global tool restriction仍只限制普通工具，`outputSchema` 安装的 scoped `structured_output` 保留。提供一个 `buildReviewEpochTemplate` 纯 helper，由 D06 的受权 scope 解析和 D17 的 child 组装共用，固定 complete system、canonical structured-output schema 与 resolved call config，禁止两条路径各自拼 header。LLM adapter registration 暴露不含 secret、但覆盖 provider implementation/version、endpoint 与影响执行的 adapter options 的稳定 `executionProfileDigest`；LLM Service 把 resolved call config、adapter defaults 与该 digest作为只读 profile返回。支持 conservative review 的 provider 必须从实际 child request 产生 provider-owned `RequestExecutionAttestation`，包含 exact canonical `EpochHeader` 与 execution profile digest；in-process provider从 durable child `request/header` 读取，remote provider若不能提供则只可用于 shadow。该扩展不把 session input/messages纳入 scope digest，也不记录 credential。
- 验收：`isolated-prompt-suppresses-standing-sections-and-runtime-context`、`isolated-prompt-keeps-structured-output-scoped-tool`（T89）、`authorization-and-child-share-one-epoch-template-builder`、`execution-profile-changes-on-provider-endpoint-or-option-change`、`execution-profile-redacts-credentials`、`inprocess-attestation-matches-durable-request-header`、`provider-without-attestation-is-shadow-only`（T88）。

#### `validateReviewConfig(config): ResolvedReviewConfig`
- 拓扑：P3-D01。
- 职责：fail-closed 解析全部 Config、RolloutAuthorization artifact 与 enum；plan/evidence/token/rate/retry/resume/history 数值必须 finite 正整数或文档允许的零值；`maxPlanOps/maxConcurrentReviews` required，乘积必须为 safe integer 且不超过显式 `maxPendingReviewOps` safety cap。review provider、isolated prompt/schema/policy/learning/eval version、trusted rollout signer 与项目/preset allowlist 在 load-time 固定；conservative 必须提供可验证签名的 authorization，shadow 可省略。不在 runtime 隐式补默认。
- 验收：`review-config-valid-exact-boundaries`、`review-plan-and-concurrency-required`、`pending-product-overflow-fails-load`（T85）、`retry-and-resume-config-distinct`、`unknown-rollout-level-fails-load`、`conservative-requires-signed-authorization`（T88）、`authorization-schema-rejects-secret-or-unknown-fields`、`runtime-does-not-default-config`。

## 4. Eligibility、LearningView 与 outcome

#### `isRootSession(header): boolean` / `isReviewEligibleSession(observation,control,config): Eligibility`
- 拓扑：P3-D02。
- 职责：root 要求 `parentSession===undefined`、`origin!=='subagent'`、`delegationDepth` 缺省或 0；eligible 另要求 cwd、授权 preset、项目/时间范围、session control enabled 与至少一个 completed root turn。projected current preset 优先于 creation header。
- 验收：`review-trigger-root-session-only`（T71）、`review-child-turn-end-never-dispatches-review`、`selected-preset-projection-not-stale-header`、`disabled-session-ineligible`、`empty-session-ineligible`。

#### `eventKindAdmissible(event): boolean` / `projectEvents(events,range,config): LearningProjection` / `canonicalToolInvocationFingerprint(call): string`
- 拓扑：P3-D03。
- 职责：projection oldest-first contiguous；只投影 human user content、tool call/result 与 turn outcome；assistant 只保留每 turn 最终可读摘要但标为 non-authority；compaction 不改 seq；command/review child/synthetic context 不可引用；预算截断返回 persisted `effectiveThrough`。fingerprint 对 typed durable tool name + parsed arguments 做 recursively sorted-key canonical JSON、数组保序，再 domain-separated hash；排除 callId/time/result，不持久化 raw canonical arguments。
- 验收：`project-oldest-first-contiguous`、`project-effective-through-stops-at-budget`、`project-contextonly-not-citable`、`project-turn-fold-final-only`、`project-interrupted-excluded`、`project-compaction-invariant`、`governance-events-not-relearned`、`tool-fingerprint-key-order-stable`、`tool-fingerprint-argument-change-differs`、`tool-fingerprint-excludes-call-id-and-clock`。

#### `classifyOutcomeSignals(projection): readonly OutcomeSignal[]`
- 拓扑：P3-D04。
- 职责：按 durable callId 配 tool call/result；isError true=tool-failure，false=tool-success（仅 execution 成功）。Host 对 validated durable tool name + canonical arguments 计算不含原文的 invocation fingerprint；只有同 root turn 内相同 fingerprint 的 later non-error 才形成 failure-recovered，generic tool name 相同或参数改变均不足。最后未恢复失败形成 unresolved；typed Host transient code 才形成 transient，模型文字不能；user message形成 user-authored evidence source，不自动断言语义正确。每个 signal 保留 session/turn/event seq/call id 坐标；fingerprint 只做结构配对，不证明语义因果。
- 验收：`tool-error-is-not-success`、`turn-completed-is-not-task-success`、`assistant-success-claim-is-insufficient`（T74）、`same-invocation-failure-then-success-pairs-recovery`（T75）、`same-shell-tool-different-arguments-do-not-pair`、`invocation-fingerprint-does-not-store-secret-arguments`、`unrecovered-final-tool-failure-is-unresolved`、`model-cannot-label-transient`、`explicit-user-text-is-user-authored`。

## 5. Plan schema、identity 与 targets

#### `ReviewPlanSchema` / `gatePlanShape(value,config): ReviewPlan`
- 拓扑：P3-D05。
- 职责：object-rooted zod/JSON schema；memory discriminated union；skill create/patch union；字符串/items/files/evidence 全硬上限；reject unknown authority fields `opId/entryId/now/revisionId/receiptMode`（`targetEntryId` 是 planner 从 current view 复制的 opaque target，add entryId 不在 schema）。
- 验收：`plan-memory-union-discriminates`、`update-remove-require-id-and-digest`（T73）、`model-supplied-opid-rejected`、`plan-ops-capped-schema-and-host`、`unknown-authority-fields-rejected`。

#### `enumeratePlanOps(plan): readonly EnumeratedPlanOp[]`
- 拓扑：P3-D05。
- 职责：memory 全部在前、skill 全部在后；数组内部原顺序；全 plan 零基 stable index；不依赖 object property/commit success 顺序。
- 验收：`review-plan-enumeration-order-pinned`（T76）、`empty-plan-enumerates-empty`、`recovery-enumerates-stored-plan-identically`。

#### `canonicalPlanOpDigest(op,identityVersion): string`
- 拓扑：P3-D05。
- 职责：`REVIEW_OP_IDENTITY_VERSION=1`；recursive sorted keys、arrays ordered、undefined properties omitted、Unicode UTF-8 bytes unchanged；编码完整 validated plan op + version；排除 Host fields。旧 planned attempt 按持久化 version dispatch，未知 version fail-loud。
- 验收：`canonical-plan-digest-vectors-match-evidence-lock`（T76）、`canonical-plan-digest-excludes-host-fields`、`identity-version-survives-planned-recovery`、`unknown-identity-version-fails-loud`、`memory-result-digest-not-used-for-op-identity`。

#### `resolveReviewAuthorizationScope(parent,ctx,config)` / `verifyRolloutAuthorization(artifact,config)` / `selectReviewLane(scope,artifact,configuredLevel)`
- 拓扑：P3-D06；调用 E01 resolved execution profile 与 D01 parsed config/artifact。
- 职责：用 `resolveChildAgentOptions`、E01 `buildReviewEpochTemplate`、output schema digest、adapter execution profile digest 与 policy/learning/op/eval versions构造 `ReviewAuthorizationScope`，再 domain-separated canonical hash。`verifyRolloutAuthorization` 验证 artifact digest、trusted signature、版本、from/to 与 authorized scope/report entries，不重算 P5 quality decision。`selectReviewLane` 在 configured shadow 时总选 shadow；configured conservative 且 exact scope获授权时选 conservative；未授权、provider 不可 attestation 或 historical route 不同则只选该 scope 的 shadow lane。签字人、approvedAt、report/artifact digest不进入 scope digest或 lane id。
- 验收：`authorization-scope-canonical-and-stable`、`route-model-reasoning-max-token-change-changes-scope`、`adapter-profile-change-invalidates-scope`、`prompt-schema-or-policy-change-invalidates-scope`、`valid-resign-does-not-change-scope`、`unapproved-route-selects-shadow-before-claim`（T88）、`unapproved-historical-route-selects-shadow`、`bad-signature-or-version-never-selects-conservative`、`authorization-artifact-digest-not-in-lane-identity`。

#### `deriveCursorLaneId/deriveRangeId/deriveAttemptId/deriveReviewOpId/deriveCommandOpId`
- 拓扑：P3-D07；review op 调 D05 digest，lane id 调 D06 scope digest。
- 职责：lane hash 包含 rollout level 与稳定 authorization scope digest，不含 artifact/report/signature digest；attemptNo 由 cursor durable 分配；review op=`attempt/resource/stableIndex/planDigest/version`；command op=`memory-governance/v1/sessionId/CommandId/canonical action`。模型不提供。
- 验收：`rollout-level-changes-cursor-lane`（T83）、`execution-scope-changes-cursor-lane`（T88）、`authorization-resign-keeps-same-cursor-lane`、`attempt-id-derivable-at-claim`、`op-id-stable-across-planned-recovery`、`changed-plan-payload-changes-op-id`、`command-op-id-derived-from-durable-command`（T80）。

#### `resolveMemoryPlanTargets(plan,currentMemory): ResolvedMemoryOps` / `resolveSkillPlanTargets(plan,currentSkills): ResolvedSkillOps`
- 拓扑：P3-D08。
- 职责：memory add 由 review op id 派生 entry id；update/remove exact id+digest；同 plan 同 entry 重复触及拒绝；skill patch exact ref/revision/digest，create 做 managed overlap/name intent check。targetHint 不参与解析。
- 验收：`memory-update-targets-exact-entry-id`（T73）、`memory-remove-targets-exact-entry-id`、`memory-target-stale-digest-zero-commit`、`memory-target-unknown-zero-commit`、`memory-plan-duplicate-target-zero-commit`、`skill-patch-exact-ref-and-base`。

## 6. Admission

#### `checkEvidenceAndOutcome(plan,projection,outcomes,config): AdmissibilityReport`
- 拓扑：P3-D09；调用 D03/D04。
- 职责：seq/range/span/fieldPath 精确；current resource state 可用于 target/去重但不可作 evidence。user-fact/preference 需要 user-authored；project-fact 需要 user-authored 或 tool-success source。可见 memory 的 verified-procedure/verified-recovery/caution 必须由明确 user correction 或 D04 同-fingerprint failure-recovered 支持，单个 non-error、同工具名不同参数或模型自称“已修复”均不足。参数改变的 repair sequence 可支持不可见 skill draft，但仍需治理 approve。unresolved/transient/assistant-only 不得产生任何可见 mutation，也不得借 `caution` 绕过。confidence 不授权。
- 验收：`span-present-passes`、`forged-span-rejects`、`current-state-not-citable`、`explicit-user-correction-is-admissible`、`single-tool-success-cannot-publish-procedure-memory`、`tool-success-can-only-propose-hidden-skill-draft`、`unresolved-failure-produces-zero-visible-learning`（T74）、`unresolved-cannot-hide-in-caution`（T74）、`failure-fix-verification-saves-only-working-path`（T75）、`missing-binary-is-not-durable-rule`、`evidence-refs-capped`。

#### `wholePlanAdmission(plan,resolved,currentState,config): Promise<AdmissionDecision>`
- 拓扑：P3-D09；调用 D08、evidence check、`MemoryService.previewOps`、`ManagedSkillService.preflightMutations`。
- 职责：所有 evidence/target/scope/ownership/conflict/scan/quota/publication preview 在第一个 mutation 前完成；任一拒绝整 plan zero commit。preflight 后 race 由 resource expected base 捕获并转 superseded；L1 user target `target_scope_disabled`；shadow 永远返回 audit-only。
- 验收：`admission-all-or-nothing-no-partial-commit-start`、`preflight-covers-both-resources-before-write`、`user-target-backstop-l1`、`plan-duplicate-target-zero-commit`、`shadow-admission-never-mutates`。

## 7. Cursor、ledger 与 finalization

#### `classifyReviewSettlement(settlement): ReviewSettlementClass`
- 拓扑：P3-D10。
- 职责：只读取 typed phase、attempt 是否已 planned、applied|duplicate opState 数与 machine code，不解析 message。committed、planner empty、用户 skip 与 D09 返回的确定性 evidence/outcome/policy/scan/quota rejection → consumed；其中 rejection 原样保留 code 且 `scoreAsFalseProposal=true`。immutable plan 尚未落盘时的 stale base/target 或可缩小 plan budget → superseded，typed 瞬态/provider/planner failure 与 planning cancel → retryable。actual request attestation mismatch 无论是否已有 plan 都是 manual 且 zero mutation/zero advance；immutable plan 已落盘后的 typed 瞬态或 planned cancel → resume，同一 attempt/op ids 续跑；若已有 applied op，后续 stale、确定性 apply rejection或 protocol failure 不能重规划掩盖部分提交，直接 manual/fail-loud。未知 code 与 impossible phase/code 组合同样 manual。apply 阶段若在已通过同一 config/state preflight 后返回确定性 scan/quota code，属于 protocol failure；并发资源变化应先表现为 stale CAS。
- 验收：`settlement-classification-exhaustive`、`classification-never-parses-error-message`、`deterministic-admission-rejection-classifies-consumed-and-scored`（T86）、`preplan-transient-classifies-retryable`、`planned-transient-classifies-resume`、`partial-saga-stale-classifies-manual`、`post-preflight-deterministic-rejection-is-protocol-failure`、`unknown-code-classifies-manual`。

#### `decideResumeGate(inFlight,classification,now,config): ResumeDecision` / `decideDisposition(cursor,classification,now,config): DispositionDecision`
- 拓扑：P3-D11；调用 D10，不重复解释错误。
- 职责：resume 分类只由 `decideResumeGate` 转成同一 inFlight 的 persisted exponential `resumeBlockedUntil/resumeRetryCount`，未达时不得执行 stored plan，达到 `maxResumeAttempts` 转 manual terminal。其余分类由 `decideDisposition` 转成 durable consumed/superseded/retryable/manual；pre-plan retry 写 lane `blockedUntil`，superseded 与 retry 各有 exact cap。两个函数相同输入纯且 exact boundary 一致；reasonCode 与 false-proposal 标记写入 terminal attempt，供 P5 读取。
- 验收：`resume-backoff-exact-values`、`resume-cap-becomes-manual`、`planned-transient-keeps-same-attempt-and-opids`（T77）、`retry-backoff-exact-values`、`retry-cap-becomes-manual`、`superseded-cap-becomes-manual`、`deterministic-admission-rejection-consumes-nochange`（T86）、`admission-rejection-retains-code-for-quality-score`、`transient-admission-read-failure-retries`、`stale-target-supersedes-before-first-write`、`user-skip-consumes`。

#### `transitionClaim/transitionResumeDeferral/transitionDisposition/transitionRelease/transitionManualRelease`
- 拓扑：P3-D12；调用 D11 的 durable decisions。
- 职责：在一个 immutable lane 输入上计算 next lane 与 typed result；不读时钟、storage 或 ledger。claim 更新 desired=max 并按 manual/blocked/inFlight/due 顺序判定；resume deferral 只更新匹配 inFlight；consumed 以 max advance；release 只清匹配 attempt；manual retry/skip 需要 durable CommandId。所有 exact boundary 先在纯函数层钉死。
- 验收：`transition-claim-priority-pinned`、`transition-resume-deferral-keeps-attempt`、`transition-consumed-advance-max`、`transition-release-mismatch-noop`、`transition-manual-release-requires-command-id`。

#### `class ReviewCursorStore`
- 拓扑：P3-D13；每个写方法只在 storage update 内调用 D12 对应 transition。
- `claimDue(sessionId,desiredThrough,now,laneKey)`：一个 RMW 更新 desired=max；manual→held；blocked→deferred；running→busy；resumable→resume；无 due→nothing；否则分配 attemptNo/inFlight acquired。
- `deferResume(attemptId,resumeDecision)`：只更新匹配 inFlight 的 resume gate；不 terminal、不 release、不分配新 attempt。
- `applyDisposition(attemptId,decision,effectiveThrough)`：idempotent；consumed 用 max advance 并清 since-advance gates；retry/supersede/manual 写 exact durable gate但保留 inFlight。
- `releaseAttempt(attemptId)`：只清匹配 inFlight，重复 no-op；不得自行判断 finalized。
- `releaseManualHold(sessionId,commandId,retry|skipThrough)`：用户命令；skip 记录 consumed through，retry 清 gate但不 advance。
- 验收：`claim-acquired-busy-resume-nothing`、`resume-not-runnable-before-resume-blocked-until`、`resume-runnable-at-boundary-with-same-attempt`（T77）、`retry-not-claimable-before-blocked-until`（T77）、`retry-claimable-at-blocked-until`、`retry-and-resume-backoff-survive-restart`、`manual-hold-requires-governance-release`、`desired-through-growth-does-not-bypass-block`、`advance-twice-is-noop`、`release-mismatched-attempt-noop`。

#### `class ReviewClaimCoordinator`
- 拓扑：P3-D14；调用 D13 `ReviewCursorStore`。
- 职责：host 内唯一 claim 入口，串行执行 durable lane scan 与 `claimDue`。已有 inFlight 的 resume 不占新容量；新 acquired 只有在 durable occupied lane 数小于 required `maxConcurrentReviews` 时允许。startup 从 lane records 重建占用数；cleanup/finalization reconciliation 未完成时关闭新 acquired，但允许既有 attempt resume/cleanup。一个 attempt 的 plan op 数受 schema `maxPlanOps` 限制，因此 P1/P2 review pending receipt 总量上界为 `occupied lanes × maxPlanOps`；不依赖淘汰未完成 receipt。首版不支持多 Host，不能把本协调器宣称为分布式 semaphore。
- 验收：`claim-coordinator-serializes-live-and-history`、`durable-inflight-count-enforces-cap`（T85）、`resume-at-cap-does-not-consume-new-slot`、`restart-rebuilds-capacity-from-lanes`、`cleanup-failure-closes-new-acquisitions`、`pending-review-receipts-bounded-by-inflight-and-plan-cap`（T85）。

#### `class ReviewLedgerStore`
- 拓扑：P3-D15。
- 职责：attempt record 永不删除，字段通过原子 RMW 单调增补；创建时固定 claimed scope digest 与可选 authorization artifact digest，LearningView 后、planner 前写 effectiveThrough/outcomes/base digest；planner 返回后、immutable plan 前写 actual request attestation 及 match verdict。validated planner result以落定后 immutable 的 plan + identity version + plan digest 进入 planned boundary；attestation mismatch 不得进入 planned/committing。`markOpState` 单调；`markTerminal(attemptId,decision)` 持久化 exact decision；`markFinalized` 幂等。Service ready 前先建立 ledger domain 的 singleton counter table record `{next:'1'}`，此时尚不开放 claim；counter/ordinal 是无前导零的正十进制 branded string，durable schema fail-closed，`KvTable.update` 内取当前 next 作为本次 ordinal、用 `BigInt` 加一并立即转回 string，不受 JavaScript safe-integer 上限影响。`ensureFinalizedOutcomeIndexed(attemptId)` 只接受 finalized attempt：先原子分配 ordinal，再用 attempt RMW 仅在字段缺失时写入。counter 已递增而 attempt 尚未写入，或同 attempt 并发分配败方，只留下 gap；重试不得改写已存在 ordinal。ordinal→attempt 表只是查询投影，`rebuildFinalizedOutcomeIndex` 从 attempt 的 retained ordinal 补缺、检测重复 ordinal，并保证 counter.next 严格大于已见最大 ordinal；它不是第二 outcome authority，也不改变已分配 ordinal。`listFinalizedOutcomeSignals({afterOrdinal,limit})` 按 ordinal 数值升序分页，只投影 finalized attempt 中的 Host outcome 及原 durable 坐标，不重新运行 planner；后续 finalized attempt 只能追加在 checkpoint 之后，无需全表 cycle，也不要求 P4 永久保存所有历史 signal id。
- provenance：attempt 是 review op authority；`GovernanceOperation` 是 direct memory governance authority。同 CommandId 先查 authority status，applied 直接重放结果、prepared 先 reconcile、failed 重放同一失败，均早于 current target/base 检查。派生 index 在 authority record 后写；`rebuildProvenanceIndex` 扫 authority records补缺，冲突 invalid_structure。
- 验收：`attempt-record-retained-and-transitions-monotonic`、`effective-through-and-claimed-scope-persisted-pre-planner`、`actual-attestation-persisted-before-plan`（T88）、`attestation-mismatch-never-reaches-planned`、`planned-boundary-persists-immutable-plan`、`recover-from-planned-never-recalls-model`、`opstate-monotonic`、`terminal-decision-immutable`、`finalized-outcomes-retain-turn-and-event-coordinates`、`unfinalized-outcomes-not-exported-to-curator`、`outcome-ordinal-schema-rejects-zero-negative-leading-zero`、`counter-record-initialized-before-claims`、`counter-increments-beyond-max-safe-integer`、`concurrent-finalized-attempts-get-distinct-ordinals`、`finalized-outcome-pages-append-by-ordinal`、`counter-crash-before-attempt-write-leaves-safe-gap`、`assigned-outcome-ordinal-never-changes`、`duplicate-outcome-ordinal-fails-loud`、`outcome-index-rebuild-preserves-checkpoints`、`late-finalized-attempt-appends-after-checkpoint`、`opid-resolves-source-attempt-after-restart`（T84）、`receipt-eviction-does-not-break-provenance-query`、`provenance-index-crash-gap-rebuilds`、`provenance-conflict-fails-loud`。

#### `groupFinalizedReceipts(opStates): {memoryGroups,skillGroups}`
- 拓扑：P3-D16。
- 职责：只选 ledger 已 finalized attempt 的 applied|duplicate opState；memory 按 scope、skill 按 ref；prepared/failed/not-started 不 cleanup。
- 验收：`finalized-ack-only-applied-opstates`（T66/T85）、`zero-mutation-finalized-has-no-ack-call`、`groups-never-cross-resource-or-scope`。

#### `finalizeAttempt(attemptId)` / `reconcileReviewState(sessionId)`
- 拓扑：P3-D16；调用 D11、D13–D15 与 P1/P2 finalized-ack。
- finalization：ledger markTerminal 已持久化 decision → cursor applyDisposition → ledger markFinalized → `ensureFinalizedOutcomeIndexed` → 以 finalized attempt 的 applied|duplicate opStates 调 P1/P2 `acknowledgeFinalizedOps` → cursor releaseAttempt。Review receipt 在 `markFinalized` 成功前一直留在不淘汰 pending；cursor 在 outcome 可分页发现且 cleanup 成功前一直 occupied。
- reconciliation：先扫描 terminal&&!finalized，重放 persisted disposition 并 mark finalized；再为全部 finalized attempt 补齐 stable ordinal/derived index；再检查 cursor occupied：ledger finalized 且已 indexed→重放 finalized receipt cleanup（receipt 两无也可表示已 cleanup 后合法淘汰）→release，绝不 resume plan；planned/committing→按 persisted resume gate 续同一 attempt，planning crash→pre-plan retry policy。D15 outcome mutex 串行 `markFinalized→ensure index`、显式 `reconcileFinalizedOutcomeIndex` 与 page read，query 不会观察 finalized-but-unindexed 中间态，也不以 read 方法暗藏修复写入。P4 每次 outcome page scan 前显式调用 reconciliation；失败时不读 page、不推进 checkpoint并记 coverage gap。全部 lane 分类完成前不接受新 acquired；index/cleanup 失败保持 gate closed并告警，但正常前台 Agent 不受阻。
- 验收：`terminal-finalization-is-idempotent`、`review-receipt-stays-pending-until-ledger-finalized`（T85）、`crash-after-finalized-before-index-recovers`、`index-failure-keeps-cursor-occupied-and-acquisition-closed`、`crash-after-index-before-ack-recovers`（T72/T85）、`crash-after-ack-before-release-recovers-after-ring-eviction`（T85）、`finalized-occupied-cleans-receipts-then-releases-not-resumes`、`startup-reconciles-before-new-claim`、`outcome-mutex-hides-finalized-before-index`、`outcome-page-read-performs-no-durable-write`、`cleanup-failure-blocks-new-review-not-foreground-agent`、`finalization-crash-injected-after-every-durable-write`、`terminal-status-does-not-imply-range-consumption`、`terminal-recovery-uses-persisted-effective-through`。

## 8. Planner 与 runtime

#### `resolveReviewProvider(ctx,config): ReviewProvider`
- 拓扑：P3-D17。
- 职责：load-time 取得 provider；要求 `inheritsParentContext=false`，capabilities 的 agentOptions/outputSchema/depthLimit/toolFilter/isolatedPrompt/requestAttestation 全 true；否则 conservative 为 `unsupported_review_provider`，不 fallback 到另一个 provider。缺 isolated/attestation 的 fresh provider只可由 D06 选择 shadow。
- 验收：`review-provider-must-be-fresh`（T70）、`conservative-provider-must-support-isolation-and-attestation`（T88/T89）、`missing-provider-fails-load`、`authorized-provider-unavailable-never-falls-back`。

#### `startPlanner(parent,input,scope,config)` / `attestPlannerRequest(run,scope)` / `gatePlannerResult(result)`
- 拓扑：P3-D17；调用 D05 schema、D06 scope 与 E01 provider primitives。
- 职责：请求固定 `toolFilter:{allow:[]}`、`maxDepth:1`、output schema、review-owned isolated complete prompt、runtime-context suppression 与 D06 已解析 agent options。普通业务工具不可见/不可执行；`outputSchema` 的 scoped `structured_output` 是唯一 tool schema，成功 result 必须恰好一次。provider route仍可按 parent/historical route解析，但 exact resolved scope须在 claim 前已选。`attestPlannerRequest` 从 provider-owned actual attestation重算 epoch/profile digest并与 claim scope constant-time 比较，在 immutable plan、admission 与任何 resource mutation 前把结果写 ledger；缺失或失配为 `review_execution_mismatch` manual，零 advance。gate 另要求 completed+structured+schema；run token total 超限 dispose。
- 验收：`planner-only-visible-tool-is-structured-output`（T70/T89）、`planner-structured-output-succeeds-exactly-once`（T89）、`planner-ordinary-tool-execution-is-denied`、`planner-has-no-parent-conversation-history`、`planner-standing-sections-and-runtime-context-absent`、`planner-request-header-matches-authorized-scope`（T88）、`adapter-default-change-invalidates-attestation`、`attestation-mismatch-zero-resource-mutation-and-zero-advance`（T88）、`remote-run-without-attestation-is-not-conservative`、`gate-terminal-zero-mutation`、`output-tokens-wired`。

#### `class ReviewRuntime`
- 拓扑：P3-D18。
- `ensureReviewThrough(agent,seq)`：在 `agent.runMaintenance` owner 下 reconciliation → D06 resolve scope/select lane → D14 claim → run；blocking caller失败仍 delegate。未授权 conservative route从一开始只访问 shadow lane。
- `runReview(claim)`：create attempt → projection/outcome/effectiveThrough + claimed scope durable → current resource views/base durable → planner → actual attestation durable/verify → gate/store immutable plan → enumerate/derive IDs → whole-plan admission → shadow/noChange/rejected noChange 或 fixed-order forward saga（memory 后 skill）→ each resource result mark opState → persisted disposition → finalization。
- recovery：planned/committing 使用 stored plan/op ids，绝不召回模型；resource success/ledger crash由 receipt duplicate吸收。immutable plan 后的瞬态故障 defer 同一 inFlight，partial saga 不回滚也不新建 attempt；在任何 op applied 前出现 stale 可 supersede，新 whole attempt 重规划；已有 applied op 后的 stale/invariant failure 进入 manual，等待用户 retry/skip，不能把部分提交伪装成 zero-commit。只有 terminal decision 才进入 finalization。
- 验收：`saga-happy-path`、`authorization-selected-before-claim`（T88）、`no-resource-write-before-plan-and-attestation-persisted`、`memory-committed-skill-write-fails-recovery-finishes-same-attempt`、`partial-saga-transient-never-replans`（T77/T85）、`partial-saga-stale-enters-manual`、`resource-success-ledger-crash-duplicates`、`saga-planned-boundary-recovers-without-model`、`saga-range-never-skips`、`saga-stale-before-first-write-replans-new-attempt`、`saga-budget-consolidation-new-whole-attempt`、`unresolved-failure-zero-visible-learning`、`unresolved-false-proposal-consumes-rejected-nochange`、`no-signal-empty-plan-consumes-nochange`、`rollout-lanes-never-promote-shadow-plan`。

#### live trigger 与 foreground settlement
- 拓扑：P3-D19。
- 职责：resume-async/resume-blocking/maintenance 三模式；每个入口先 D02 root predicate；planning foreground cancel→retry settlement，planned/committing→resumable stored plan；bounded wait；child lifecycle不触发。
- 验收：`async-dispatch-no-mid-turn-append`、`foreground-preempts-background`、`cancel-before-planned-clears-inflight`、`cancel-after-planned-resumes-stored-plan`、`same-process-next-turn-not-permanently-busy`、`review-child-never-dispatches`（T71）。

## 9. 冷历史协调器

#### `enumerateHistoricalReviewWork(records,checkpoint,config): HistoricalPage`
- 拓扑：P3-D20。
- 职责：稳定按 `{createdAt desc,id}`；root/persisted/cwd/project/time/preset/control 过滤；bounded page；checkpoint 在每项成功或明确跳过后推进，到尾新 cycle；列表变化最迟下一 cycle 发现，per-session cursor 才是完成真相。
- 验收：`maintenance-discovers-cold-root-sessions`（T79）、`maintenance-excludes-child-sessions`、`maintenance-honors-project-time-and-rate-limits`、`maintenance-checkpoint-survives-restart`、`new-session-behind-checkpoint-found-next-cycle`、`maintenance-opt-out-stops-new-claims`。

#### `resolveHistoricalAgentOptions(observation): AgentOptions`
- 拓扑：P3-D20。
- 职责：用既有 `foldRequestHeader(events)` 恢复最后 provider/model/reasoning route；有历史 turn 却无可恢复 route则 fail-loud，不回落到另一个 provider；真正无 request 的空 session本就不 eligible。恢复后先调用 D06；route 未授权时只进入其 shadow lane，不得占 parent/默认 conservative lane。
- 验收：`historical-resume-uses-recorded-provider-route`、`unavailable-recorded-route-does-not-fallback-cross-provider`、`unapproved-historical-route-remains-shadow`（T88）、`reasoning-effort-restored-when-user-owned`。

#### `HistoricalReviewCoordinator.runPass(signal)`
- 拓扑：P3-D20。
- 职责：`sessionQuery.listSessions/observeSession({projectionMode:'all'})`；读取 projected latest preset；live Agent 复用，cold Agent 用 `agents.resume` + `agentPresets.mount`；review 到 observation cursor；只 dispose 自己创建的 handle；live/history 共用 claim，busy 留待下一 pass；cost/rate/token cap 和 abort。
- 验收：`historical-resume-mounts-projected-preset`、`maintenance-and-live-review-do-not-double-claim`（T79）、`historical-disposes-owned-agent-only`、`historical-abort-preserves-checkpoint-at-last-settled`、`historical-budget-stops-before-next-resume`。

## 10. 人类治理与 provenance

#### memory/skill/review command handlers
- 拓扑：P3-D21；全局 commands registry，模型无同名工具。
- memory：list/show/correct/remove；correct/remove先写 GovernanceOperation prepared，以 CommandId 派生 op id，exact state revision+entry digest，调用 `MemoryService.applyDirectOps`，再 mark applied；如 mark applied 失败，该 memory scope 立即进入 governance-blocked，P3 不再接受该 scope 的 direct command 或 review memory commit，直到 `reconcileGovernanceOperations` 以 terminal receipt 重放资源调用并写 applied。启动在新 command/review claim 前处理全部 prepared，因而 bounded receipt 不会在权威记录落定前被任何后续 terminal receipt 淘汰。可确认的验证失败写 failed；show解析 review/governance provenance与 evidence spans。
- skill：list/show/approve/reject/reopen/restore；approve全重验；show 通过 P2 `resolveMutationProvenance` 解析 direct-tool session/call，或用 review opId 回到 ReviewAttempt；restore调用 P2 actor governance。review：enable/disable、retry、skip；skip明确记录用户授权 consumed through。
- 验收：`memory-show-resolves-source-attempt`、`memory-correction-uses-id-and-digest`（T80）、`memory-correction-removes-old-content-from-next-snapshot`、`memory-remove-is-user-governance-only`、`governance-operation-crash-reconciles`、`governance-authority-duplicate-before-current-target`、`governance-ledger-failure-blocks-direct-and-review-scope-until-reconciled`、`prepared-remove-reconciles-before-any-receipt-eviction`、`governance-show-renders-source-spans`（T84）、`skill-show-resolves-direct-tool-after-receipt-eviction`、`skill-show-resolves-review-attempt`、`skill-restore-user-only`（T82）、`manual-hold-requires-governance-release`、`governance-absent-from-model-tool-surface`。

## 11. Config 与 Service assembly

Config fields 全 JSDoc：`triggerMode`；`reviewProvider` 默认 spawn、`reviewModel?`；token budgets；debounce；`policyVersion/learningViewVersion/rolloutLevel/evalProtocolVersion`；isolated planner prompt；rollout authorization path/trusted signer；`maxPlanOps/maxConcurrentReviews` 与 plan/evidence hard caps；pre-plan retry、stored-plan resume backoff/max attempts、max supersede/max consolidation；eligible presets/projects/time；historical enabled/batch/interval/rate/token cap；control defaults。`maxPlanOps × maxConcurrentReviews` 的乘积必须为 safe integer 并受明确上限，防止配置本身取消 pending bound。review provider capability在 load-time 验证；每个 session 的 route scope在 claim 前解析，不能首次 mutation 才发现。

#### `class SessionReviewService extends Service`
- 拓扑：P3-D22。
- 职责：唯一 review domain opener；持有 authorization verifier、cursor/ledger/claim coordinator/runtime/history；注册 host lifecycle listeners、commands 与 maintenance；向 P4 公开显式 maintenance `reconcileFinalizedOutcomeIndex` 与无写入 paged `listFinalizedOutcomeSignals`，两者和 finalization 共用 D15 outcome mutex；启动完成 D16 review reconciliation、D21 governance reconciliation、authorization signature/version check、outcome/provenance index rebuild 与 durable inFlight capacity rebuild 后才允许新 acquired；reconciliation 故障只关闭 review acquisition，不阻断正常 Agent；所有 effect/disposer HMR-safe。
- 验收：`review-service-single-registration`、`review-domain-opened-once`、`not-ready-before-reconciliation`、`host-mount-observes-multiple-root-agents`、`hmr-stops-live-and-history-work`。

Phase 出口：T70–T80/T83–T89 中属 P3 的全部测试、原 P3 tests、100% coverage；REAL boot 注入每个 durable finalization 边界、finalized ack 后 ring 淘汰、live/history竞态、未授权 route、actual attestation mismatch、planner structured-only final request、memory correction、unresolved failure、shadow→conservative新 lane；四条 keyless snapshot：纠错旧 memory、failure→recovery、unresolved 零可见、review child isolated prompt + structured output only；E01 更新对应 architecture/subsystem/API catalog/必要双 SDK expected outputs，README/Agent Note 与 doc gates 全绿。
