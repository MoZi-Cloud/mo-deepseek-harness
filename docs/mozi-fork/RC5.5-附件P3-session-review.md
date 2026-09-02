# RC5.5.5 附件 P3 — Session review、named profile 与 repair learning（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；前置：P1、P2；包：`packages/review/session-review`，以及 subagent/LLM 的 planner execution 叶子扩展；日期：2026-09-02。
>
> 本包是唯一 host 级 `SessionReviewService extends Service`。`skill_manage` 仍只挂 authoring preset；planner 使用 fresh child、review-owned complete prompt、runtime-context suppression 与 `toolFilter:{allow:[]}` 隔离普通工具。`outputSchema` 安装的 scoped `structured_output` 是唯一例外，必须可见并恰好成功一次。

## 1. 模块布局

```text
src/types.ts          # plan/outcome/cursor/attempt/provenance/config types
src/config.ts         # config validation + review provider preflight
src/eligibility.ts    # root/session/preset/control predicates
src/learning-view.ts  # event projection、turn fold、outcome signals
src/repair.ts         # RepairEpisode/lesson digest/corroboration projection helpers
src/plan-schema.ts    # discriminated ReviewPlan schema/output schema
src/plan-identity.ts  # canonical JSON、enumeration、digests、ids/version
src/execution-auth.ts # execution scope、authorization、lane selection、request attestation
src/skill-context.ts  # bounded exact managed-skill learning context
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
                 reviewExecutionProfileId,historicalSourceProvenance?,
                 authorizationArtifactDigest?,effectiveThrough?,outcomes?,
                 actualRequestAttestation?,attestationMatched?,immutablePlan?,planDigest?,
                 baseRevisions?,opStates[],terminal?,finalized?,
                 finalizedOutcomeOrdinal?:FinalizedOutcomeOrdinal}
ReviewOpState = {opId,resource:'memory'|'skill',resourceRef,state:'prepared'|'applied'|'duplicate'|'failed'}
FinalizedOutcomePageQuery = {afterOrdinal?:FinalizedOutcomeOrdinal,limit}
FinalizedOutcomePage = {items,nextAfterOrdinal?:FinalizedOutcomeOrdinal,atEnd}
ReviewMemoryOp = AddPlanMemoryOp | UpdatePlanMemoryOp | RemovePlanMemoryOp
LearningKind = user-fact | user-preference | project-fact | verified-procedure | verified-recovery | caution
OutcomeSignal = {kind:'user-authored'|'tool-success'|'tool-failure'|'retry-recovered'|'unresolved'|'transient'|'unknown',
                 sessionId,turnRef,eventSeqs,callIds,invocationFingerprint?}
RepairEpisode = {sessionId,rootTurn,failedCalls,laterSuccessfulCalls,orderedEventSeqs,
                 changedInvocation:true,laterUnresolved:boolean}
RepairLessonDigest = Branded<'RepairLessonDigest'>
RepairSupport = {lessonDigest,distinctSessionIds,
                 candidateConfirmations:[{operationId,ref,revision,digest}],
                 candidateRejections:[{operationId,ref,revision,digest}],
                 lessonRejectionOperationIds:OpId[]}
RepairEvidenceOperation = {opId,sessionId,commandId,lessonDigest,
                           decision:confirm-candidate{ref,revision,digest} |
                                    reject-candidate{ref,revision,digest} | reject-lesson,
                           status:'prepared'|'applied'|'failed'}
ReviewSettlement = committed | empty-plan | user-skip | admission-rejected | stale-state |
                   consolidatable-plan-budget | transient-infrastructure | planner-infrastructure |
                   protocol-failure
ReviewSettlementClass = {kind:'consumed'|'superseded'|'retryable'|'resume'|'manual',reasonCode,scoreAsFalseProposal}
OperationProvenance = review-attempt | governance-command | direct-skill-tool
GovernanceOperation = {opId,sessionId,commandId,action,target,status:'prepared'|'applied'|'failed',result?}
ReviewAuthorizationScope = {reviewProvider,resolvedCallConfig,adapterExecutionProfileDigest,
                            canonicalEpochHeader,outputSchemaDigest,policyVersion,
                            learningViewVersion,opIdentityVersion,evalProtocolVersion}
ReviewExecutionProfileId = Branded<'ReviewExecutionProfileId'>
ReviewExecutionProfile = {id,provider,agentOptions,isolatedPromptVersion,policyVersion}
HistoricalSourceProvenance = {sessionId,lastRequestHeaderSeq?,lastRequestHeaderDigest?,routeSummary?}
ReviewAuthorizationScopeDigest = Branded<'ReviewAuthorizationScopeDigest'>
RolloutAuthorization = {from:'shadow',authorizedScopes:[{scopeDigest,maxLevel:
                        'conservative-draft'|'conservative-auto',capabilities,reportDigest}],
                        versions,approvedBy,approvedAt,signature,artifactDigest}
ReviewLaneSelection = {rolloutLevel:'shadow'|'conservative-draft'|'conservative-auto',
                       scopeDigest,authorizationArtifactDigest?,capabilities}
ReviewRequestAttestation = {scopeDigest,actualEpochHeaderDigest,adapterExecutionProfileDigest,
                            childSessionId}
```

Update/remove memory plan必须有`targetEntryId/expectedEntryDigest`；skill patch必须有`ManagedSkillRef/baseRevision/baseContentDigest`且该base出现在`SkillLearningContext`。Skill create/patch携class-level intent、files与evidence refs；repair-derived op另引用`RepairEpisode` coordinates和structured working/conditioned-avoid path。`targetHint/reason/confidence`可保留说明，但不拥有target、evidence、owner、permit或authorization权力。

## 3. 开发拓扑

| 顺序 | 节点 | 只可调用 |
|---:|---|---|
| P3-E01 | isolated planner prompt + adapter execution profile + provider request attestation primitives | existing system-prompt/subagent/llm/session APIs |
| P3-D01 | types + Config/authorization schema | P1/P2 public types、E01 types、existing core types |
| P3-D02 | `isRootSession/isReviewEligibleSession` | D01 |
| P3-D03 | `eventKindAdmissible/projectEvents/canonicalToolInvocationFingerprint` | D01、durable session events、crypto |
| P3-D04 | `classifyOutcomeSignals` | D03 projected events |
| P3-D05 | ReviewPlanSchema + `enumeratePlanOps/canonicalPlanOpDigest` | D01 |
| P3-D06 | `resolveReviewExecutionProfile/selectReviewExecutionProfile` | D01、parent metadata、Config |
| P3-D07 | `resolveReviewAuthorizationScope/verifyRolloutAuthorization/selectReviewLane` | D01 P3-owned artifact schema、D06、E01 |
| P3-D08 | lane/range/attempt/review-op/direct-command id derivation | D01、D05 canonical digest、D07 scope digest |
| P3-D09 | `resolveMemoryPlanTargets/resolveSkillPlanTargets` | D01、P1/P2 current views |
| P3-D10 | `buildSkillLearningContext/deriveRepairLessonDigest` | D03–D04、D09、P2 learning inventory |
| P3-D11 | evidence/outcome/repair/policy checks + `wholePlanAdmission` | D03–D10、P1/P2 preflight APIs |
| P3-D12 | `classifyReviewSettlement` | D01、D11 typed results |
| P3-D13 | `decideResumeGate/decideDisposition` | D01、D12 |
| P3-D14 | cursor pure transitions | D01、D08、D13 |
| P3-D15 | `ReviewCursorStore` | D14、storage domain |
| P3-D16 | `ReviewClaimCoordinator` | D15 |
| P3-D17 | ledger/governance records/outcome/provenance + repair corroboration projection | D01、D05、D08、storage domain |
| P3-D18 | finalized-receipt grouping + `finalizeAttempt/reconcileReviewState` | D13、D15–D17、P1/P2 finalized-ack |
| P3-D19 | `resolveReviewProvider/startPlanner/attestPlannerRequest/gatePlannerResult` | D01、D05–D07、D10、E01、subagent service |
| P3-D20 | `ReviewRuntime.runReview/ensureReviewThrough` | D02–D19、P1/P2 mutation/promotion APIs |
| P3-D21 | live scheduler/foreground settlement | D02、D06–D07、D16、D18、D20 |
| P3-D22 | history enumeration/checkpoint/source provenance/profile resume | D02、D06–D07、D16、D20、sessionQuery/agents/presets |
| P3-D23 | governance commands + provenance show | D08–D09、D13、D15–D18、P1/P2 direct/governance APIs |
| P3-D24 | `SessionReviewService` assembly | E01、D01–D23 |

不得先写D20再回填profile/authorization/identity/admission；不得先从source route构造scope再选profile；不得先claim conservative lane再检查authorization；不得让history自建claim；不得让governance或auto promotion绕过P2 public policy API。

#### isolated planner prompt + adapter execution profile + provider request attestation primitives
- 拓扑：P3-E01；这是 P3-D01 前完成的既有 capability 小扩展。
- 职责：subagent one-shot request 增加 review 使用的 `isolatedPrompt` capability：child scope 注册一个 complete system section并 suppress 全部 runtime context；global tool restriction仍只限制普通工具，`outputSchema` 安装的 scoped `structured_output` 保留。提供一个 `buildReviewEpochTemplate` 纯 helper，由 D06 的受权 scope 解析和 D17 的 child 组装共用，固定 complete system、canonical structured-output schema 与 resolved call config，禁止两条路径各自拼 header。LLM adapter registration 暴露不含 secret、但覆盖 provider implementation/version、endpoint 与影响执行的 adapter options 的稳定 `executionProfileDigest`；LLM Service 把 resolved call config、adapter defaults 与该 digest作为只读 profile返回。支持 conservative review 的 provider 必须从实际 child request 产生 provider-owned `RequestExecutionAttestation`，包含 exact canonical `EpochHeader` 与 execution profile digest；in-process provider从 durable child `request/header` 读取，remote provider若不能提供则只可用于 shadow。该扩展不把 session input/messages纳入 scope digest，也不记录 credential。
- 验收：`isolated-prompt-suppresses-standing-sections-and-runtime-context`、`isolated-prompt-keeps-structured-output-scoped-tool`（T89）、`authorization-and-child-share-one-epoch-template-builder`、`execution-profile-changes-on-provider-endpoint-or-option-change`、`execution-profile-redacts-credentials`、`inprocess-attestation-matches-durable-request-header`、`provider-without-attestation-is-shadow-only`（T88）。

#### `validateReviewConfig(config): ResolvedReviewConfig`
- 拓扑：P3-D01。
- 职责：fail-closed解析全部Config、named `reviewExecutionProfiles`、deterministic profile selector、RolloutAuthorization artifact与enum；plan/evidence/context/token/rate/retry/resume/history/corroboration数值必须finite正整数或文档允许的零值；`minIndependentRepairSessions>=2`。`maxPlanOps/maxConcurrentReviews` required，乘积为safe integer且不超过显式`maxPendingReviewOps`。Provider、isolated prompt/schema/policy/learning/eval version、trusted signer与项目/preset allowlist在load-time固定；RC5.5.5 只接受`evalProtocolVersion=2`与v2 authorization artifact。`conservative-draft|conservative-auto`必须提供可验证authorization，inherit-current policy只能配置给shadow。不在runtime隐式补默认，profile entry不记录credential。
- 验收：`review-config-valid-exact-boundaries`、`eval-protocol-version-two-required`、`v1-authorization-rejected-by-v2-runtime`、`named-review-profile-ids-unique`、`profile-selector-total-for-enabled-projects`、`inherit-current-rejected-for-conservative`（T92）、`repair-corroboration-minimum-at-least-two`、`review-plan-and-concurrency-required`、`pending-product-overflow-fails-load`（T85）、`retry-and-resume-config-distinct`、`unknown-rollout-level-fails-load`、`conservative-level-requires-signed-authorization`（T88/T91）、`authorization-schema-rejects-secret-or-unknown-fields`、`runtime-does-not-default-config`。

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
- 职责：按durable callId配tool call/result；isError true=tool-failure，false=tool-success（仅execution成功）。Host对validated durable tool name+canonical arguments计算不含原文的fingerprint；只有同root turn相同fingerprint的later non-error形成`retry-recovered`。另一个纯helper `deriveRepairEpisodes` 在同root turn的bounded repair window中枚举failure之后changed fingerprint/tool的later non-error与ordered coordinates，并标记later unresolved；它只声明结构候选，不声明B修复A。最后未恢复failure形成unresolved；typed Host transient code才形成transient；user message形成user-authored source但不自动断言语义正确。
- 验收：`tool-error-is-not-success`、`turn-completed-is-not-task-success`、`assistant-success-claim-is-insufficient`（T74）、`same-invocation-failure-then-success-is-retry-recovered`（T75/T94）、`changed-arguments-never-mislabelled-exact-retry`（T94）、`changed-method-success-produces-noncausal-repair-episode`（T94）、`repair-episode-retains-ordered-durable-coordinates`、`later-unresolved-marks-episode-ineligible`、`invocation-fingerprint-does-not-store-secret-arguments`、`unrecovered-final-tool-failure-is-unresolved`、`model-cannot-label-transient`、`explicit-user-text-is-user-authored`。

## 5. Plan schema、identity 与 targets

#### `ReviewPlanSchema` / `gatePlanShape(value,config): ReviewPlan`
- 拓扑：P3-D05。
- 职责：object-rooted zod/JSON schema；memory discriminated union；skill create/patch union；skill op含bounded class intent/files/evidence和optional repair lesson，字符串/items/files/evidence全硬上限；reject unknown authority fields`opId/entryId/now/revisionId/receiptMode/owner/promotionPermit/autoPromote`（`targetEntryId`是planner从current view复制的opaque target）。
- 验收：`plan-memory-union-discriminates`、`update-remove-require-id-and-digest`（T73）、`skill-plan-class-intent-and-files-bounded`、`repair-lesson-requires-episode-coordinates`（T94）、`model-supplied-opid-owner-or-permit-rejected`（T91）、`plan-ops-capped-schema-and-host`、`unknown-authority-fields-rejected`。

#### `enumeratePlanOps(plan): readonly EnumeratedPlanOp[]`
- 拓扑：P3-D05。
- 职责：memory 全部在前、skill 全部在后；数组内部原顺序；全 plan 零基 stable index；不依赖 object property/commit success 顺序。
- 验收：`review-plan-enumeration-order-pinned`（T76）、`empty-plan-enumerates-empty`、`recovery-enumerates-stored-plan-identically`。

#### `canonicalPlanOpDigest(op,identityVersion): string`
- 拓扑：P3-D05。
- 职责：`REVIEW_OP_IDENTITY_VERSION=1`；recursive sorted keys、arrays ordered、undefined properties omitted、Unicode UTF-8 bytes unchanged；编码完整 validated plan op + version；排除 Host fields。旧 planned attempt 按持久化 version dispatch，未知 version fail-loud。
- 验收：`canonical-plan-digest-vectors-match-evidence-lock`（T76）、`canonical-plan-digest-excludes-host-fields`、`identity-version-survives-planned-recovery`、`unknown-identity-version-fails-loud`、`memory-result-digest-not-used-for-op-identity`。

#### `resolveReviewExecutionProfile(profileId,ctx,config)` / `selectReviewExecutionProfile(input,config)`
- 拓扑：P3-D06；调用D01 parsed named profiles、parent/session metadata与existing LLM resolution，不构造scope或lane。
- 职责：selector按project/preset/trigger选择一个load-time named profile；同一输入确定且全覆盖。Conservative live/history只接受named profile。Historical source provider/model/reasoning不参与selection；live inherit-current仅在configured shadow实验时生成ephemeral shadow profile。Named profile unavailable返回`review_profile_unavailable`并defer/shadow，不fallback到source/parent或另一个profile。Resolved result包含non-secret agentOptions与profile id。
- 验收：`historical-profile-independent-of-source-model`（T92）、`retired-source-provider-does-not-block-profile-resolution`、`one-configured-profile-bounds-profile-set`、`live-conservative-never-inherits-current-route`、`shadow-may-explicitly-inherit-live-route`、`unavailable-profile-never-falls-back`、`profile-resolution-redacts-credentials`。

#### `resolveReviewAuthorizationScope(profile,ctx,config)` / `verifyRolloutAuthorization(artifact,config)` / `selectReviewLane(scope,artifact,configuredLevel)`
- 拓扑：P3-D07；调用D06 resolved profile、E01 execution profile与D01 parsed config/artifact。
- 职责：用named profile agent options、E01 `buildReviewEpochTemplate`、output schema digest、adapter execution profile digest与policy/learning/op/eval versions构造`ReviewAuthorizationScope`并hash。Historical source provenance不进入。`verifyRolloutAuthorization`验证artifact digest/signature/version和每个scope的max level/capabilities/report，不重算P5 quality。`selectReviewLane`在shadow时总选shadow；draft/auto必须由exact scope授权到至少该level，auto另要求`skill-auto-promotion`。未授权或provider不可attest只选shadow。签字人、approvedAt、report/artifact digest不进入scope/lane id。
- 调用：P3-D01拥有authorization parser/schema，D07只消费该类型；后续P5-D15产出符合它的artifact，P3不导入P5 runtime代码。
- 验收：`authorization-scope-canonical-and-stable`、`profile-route-model-reasoning-max-token-change-changes-scope`、`historical-source-route-change-does-not-change-scope`（T92）、`adapter-profile-change-invalidates-scope`、`prompt-schema-or-policy-change-invalidates-scope`、`valid-resign-does-not-change-scope`、`draft-authorization-cannot-select-auto-lane`（T91）、`unapproved-route-selects-shadow-before-claim`（T88）、`bad-signature-or-version-never-selects-conservative`、`authorization-artifact-digest-not-in-lane-identity`。

#### `deriveCursorLaneId/deriveRangeId/deriveAttemptId/deriveReviewOpId/deriveCommandOpId`
- 拓扑：P3-D08；review op调D05 digest，lane id调D07 scope digest。
- 职责：lane hash 包含 rollout level 与稳定 authorization scope digest，不含 artifact/report/signature digest；attemptNo 由 cursor durable 分配；review op=`attempt/resource/stableIndex/planDigest/version`；command op=`memory-governance/v1/sessionId/CommandId/canonical action`。模型不提供。
- 验收：`rollout-level-changes-cursor-lane`（T83）、`execution-scope-changes-cursor-lane`（T88）、`authorization-resign-keeps-same-cursor-lane`、`attempt-id-derivable-at-claim`、`op-id-stable-across-planned-recovery`、`changed-plan-payload-changes-op-id`、`command-op-id-derived-from-durable-command`（T80）。

#### `resolveMemoryPlanTargets(plan,currentMemory): ResolvedMemoryOps` / `resolveSkillPlanTargets(plan,currentSkills): ResolvedSkillOps`
- 拓扑：P3-D09。
- 职责：memory add 由 review op id 派生 entry id；update/remove exact id+digest；同 plan 同 entry 重复触及拒绝；skill patch exact ref/revision/digest，create 做 managed overlap/name intent check。targetHint 不参与解析。
- 验收：`memory-update-targets-exact-entry-id`（T73）、`memory-remove-targets-exact-entry-id`、`memory-target-stale-digest-zero-commit`、`memory-target-unknown-zero-commit`、`memory-plan-duplicate-target-zero-commit`、`skill-patch-exact-ref-and-base`。

#### `buildSkillLearningContext(input): SkillLearningContext` / `deriveRepairLessonDigest(lesson,policyVersion): RepairLessonDigest`
- 拓扑：P3-D10；调用D03–D04、D09 resolved targets与P2 verified learning inventory，不做I/O。
- 职责：构造有硬字符/文件/candidate上限的planner view，包含loaded/consulted managed exact refs/revisions/digests、完整current body/support manifest、related umbrella candidates、owner/pin/autonomous state和可继续patch的agent-owned hidden draft。Patch target必须证明其base出现在该context；new skill输出需有class-level trigger intent，Host拒绝session id/date/单次error literal等明确窄name。Repair lesson只接受D04 episode coordinates，canonical digest覆盖problem class、working path、conditioned avoid path与policy version；failed invocation不得出现在recommended steps。Host不做semantic equivalence。
- 验收：`patch-target-must-have-been-read-in-learning-context`、`loaded-managed-skill-first-patch-candidate`、`existing-umbrella-preferred-in-context`、`support-file-manifest-bounded-and-exact`、`hidden-agent-draft-can-receive-corroborating-patch`、`protected-skill-never-becomes-mutation-target`、`session-specific-new-skill-name-rejected`、`repair-lesson-digest-vector-stable`、`failed-path-not-in-recommended-steps`（T94）、`semantic-paraphrases-do-not-host-merge`。

## 6. Admission

#### `checkEvidenceOutcomeAndRepair(plan,projection,outcomes,episodes,repairSupport,config): AdmissibilityReport`
- 拓扑：P3-D11；调用D03–D10 pure helpers。
- 职责：seq/range/span/fieldPath精确；current resource state只用于target/去重。User fact/preference需要user-authored；project fact需要user-authored或tool-success。可见memory的verified-procedure/recovery/caution必须由明确user correction或D04 exact `retry-recovered`支持。普通non-error、same tool changed args或模型自称不足。Changed-method lesson必须引用exact RepairEpisode；单episode只允许invisible agent-owned skill draft。Auto-promotion evidence只在D17 projection证明durable human command已确认exact lesson/ref/revision/digest，或exact lesson digest达到`minIndependentRepairSessions`个distinct finalized source sessions，且无human rejection/later unresolved时成立。普通user message可作evidence span，但planner不能把它自行标记为`userConfirmed`。P5 authorization本身不提升单candidate evidence。首版不接受没有独立Service定义、durable exact result与replay协议的generic Host verifier。Failed path只能作conditioned avoid，不得作recommended workflow。
- 拒绝优先级：exact candidate rejection阻止该revision，exact lesson rejection阻止项目内同`RepairLessonDigest`的所有candidate；二者都压过confirmation与corroboration。首版拒绝记录不撤销；用户可对修正后不同digest的lesson/revision重新确认，不覆盖历史。
- 验收：`span-present-passes`、`forged-span-rejects`、`current-state-not-citable`、`explicit-user-correction-is-admissible`、`ordinary-user-text-cannot-self-assert-repair-confirmation`（T94）、`single-tool-success-cannot-publish-procedure-memory`、`tool-success-can-only-propose-hidden-skill-draft`、`single-repair-episode-can-only-propose-hidden-draft`（T94）、`distinct-finalized-sessions-corroborate-exact-lesson`（T94）、`same-session-repeats-do-not-increase-corroboration`、`exact-user-confirmation-supports-only-bound-revision`（T94）、`user-rejection-blocks-repair-promotion`、`p5-scope-pass-does-not-prove-individual-repair`、`unresolved-failure-produces-zero-visible-learning`（T74）、`unresolved-cannot-hide-in-caution`（T74）、`failure-fix-verification-saves-only-working-path`（T75/T94）、`missing-binary-is-not-durable-rule`、`evidence-refs-capped`。

#### `wholePlanAdmission(plan,resolved,currentState,config): Promise<AdmissionDecision>`
- 拓扑：P3-D11；调用D09 targets、同节点evidence check、`MemoryService.previewOps`、`ManagedSkillService.preflightMutations`。
- 职责：所有 evidence/target/scope/ownership/conflict/scan/quota/publication preview 在第一个 mutation 前完成；任一拒绝整 plan zero commit。preflight 后 race 由 resource expected base 捕获并转 superseded；L1 user target `target_scope_disabled`；shadow 永远返回 audit-only。
- 验收：`admission-all-or-nothing-no-partial-commit-start`、`preflight-covers-both-resources-before-write`、`user-target-backstop-l1`、`plan-duplicate-target-zero-commit`、`shadow-admission-never-mutates`。

## 7. Cursor、ledger 与 finalization

#### `classifyReviewSettlement(settlement): ReviewSettlementClass`
- 拓扑：P3-D12。
- 职责：只读取 typed phase、attempt 是否已 planned、applied|duplicate opState 数与 machine code，不解析 message。committed、planner empty、用户 skip 与 D09 返回的确定性 evidence/outcome/policy/scan/quota rejection → consumed；其中 rejection 原样保留 code 且 `scoreAsFalseProposal=true`。immutable plan 尚未落盘时的 stale base/target 或可缩小 plan budget → superseded，typed 瞬态/provider/planner failure 与 planning cancel → retryable。actual request attestation mismatch 无论是否已有 plan 都是 manual 且 zero mutation/zero advance；immutable plan 已落盘后的 typed 瞬态或 planned cancel → resume，同一 attempt/op ids 续跑；若已有 applied op，后续 stale、确定性 apply rejection或 protocol failure 不能重规划掩盖部分提交，直接 manual/fail-loud。未知 code 与 impossible phase/code 组合同样 manual。apply 阶段若在已通过同一 config/state preflight 后返回确定性 scan/quota code，属于 protocol failure；并发资源变化应先表现为 stale CAS。
- 验收：`settlement-classification-exhaustive`、`classification-never-parses-error-message`、`deterministic-admission-rejection-classifies-consumed-and-scored`（T86）、`preplan-transient-classifies-retryable`、`planned-transient-classifies-resume`、`partial-saga-stale-classifies-manual`、`post-preflight-deterministic-rejection-is-protocol-failure`、`unknown-code-classifies-manual`。

#### `decideResumeGate(inFlight,classification,now,config): ResumeDecision` / `decideDisposition(cursor,classification,now,config): DispositionDecision`
- 拓扑：P3-D13；调用D12，不重复解释错误。
- 职责：resume 分类只由 `decideResumeGate` 转成同一 inFlight 的 persisted exponential `resumeBlockedUntil/resumeRetryCount`，未达时不得执行 stored plan，达到 `maxResumeAttempts` 转 manual terminal。其余分类由 `decideDisposition` 转成 durable consumed/superseded/retryable/manual；pre-plan retry 写 lane `blockedUntil`，superseded 与 retry 各有 exact cap。两个函数相同输入纯且 exact boundary 一致；reasonCode 与 false-proposal 标记写入 terminal attempt，供 P5 读取。
- 验收：`resume-backoff-exact-values`、`resume-cap-becomes-manual`、`planned-transient-keeps-same-attempt-and-opids`（T77）、`retry-backoff-exact-values`、`retry-cap-becomes-manual`、`superseded-cap-becomes-manual`、`deterministic-admission-rejection-consumes-nochange`（T86）、`admission-rejection-retains-code-for-quality-score`、`transient-admission-read-failure-retries`、`stale-target-supersedes-before-first-write`、`user-skip-consumes`。

#### `transitionClaim/transitionResumeDeferral/transitionDisposition/transitionRelease/transitionManualRelease`
- 拓扑：P3-D14；调用D13的durable decisions。
- 职责：在一个 immutable lane 输入上计算 next lane 与 typed result；不读时钟、storage 或 ledger。claim 更新 desired=max 并按 manual/blocked/inFlight/due 顺序判定；resume deferral 只更新匹配 inFlight；consumed 以 max advance；release 只清匹配 attempt；manual retry/skip 需要 durable CommandId。所有 exact boundary 先在纯函数层钉死。
- 验收：`transition-claim-priority-pinned`、`transition-resume-deferral-keeps-attempt`、`transition-consumed-advance-max`、`transition-release-mismatch-noop`、`transition-manual-release-requires-command-id`。

#### `class ReviewCursorStore`
- 拓扑：P3-D15；每个写方法只在storage update内调用D14对应transition。
- `claimDue(sessionId,desiredThrough,now,laneKey)`：一个 RMW 更新 desired=max；manual→held；blocked→deferred；running→busy；resumable→resume；无 due→nothing；否则分配 attemptNo/inFlight acquired。
- `deferResume(attemptId,resumeDecision)`：只更新匹配 inFlight 的 resume gate；不 terminal、不 release、不分配新 attempt。
- `applyDisposition(attemptId,decision,effectiveThrough)`：idempotent；consumed 用 max advance 并清 since-advance gates；retry/supersede/manual 写 exact durable gate但保留 inFlight。
- `releaseAttempt(attemptId)`：只清匹配 inFlight，重复 no-op；不得自行判断 finalized。
- `releaseManualHold(sessionId,commandId,retry|skipThrough)`：用户命令；skip 记录 consumed through，retry 清 gate但不 advance。
- 验收：`claim-acquired-busy-resume-nothing`、`resume-not-runnable-before-resume-blocked-until`、`resume-runnable-at-boundary-with-same-attempt`（T77）、`retry-not-claimable-before-blocked-until`（T77）、`retry-claimable-at-blocked-until`、`retry-and-resume-backoff-survive-restart`、`manual-hold-requires-governance-release`、`desired-through-growth-does-not-bypass-block`、`advance-twice-is-noop`、`release-mismatched-attempt-noop`。

#### `class ReviewClaimCoordinator`
- 拓扑：P3-D16；调用D15 `ReviewCursorStore`。
- 职责：host 内唯一 claim 入口，串行执行 durable lane scan 与 `claimDue`。已有 inFlight 的 resume 不占新容量；新 acquired 只有在 durable occupied lane 数小于 required `maxConcurrentReviews` 时允许。startup 从 lane records 重建占用数；cleanup/finalization reconciliation 未完成时关闭新 acquired，但允许既有 attempt resume/cleanup。一个 attempt 的 plan op 数受 schema `maxPlanOps` 限制，因此 P1/P2 review pending receipt 总量上界为 `occupied lanes × maxPlanOps`；不依赖淘汰未完成 receipt。首版不支持多 Host，不能把本协调器宣称为分布式 semaphore。
- 验收：`claim-coordinator-serializes-live-and-history`、`durable-inflight-count-enforces-cap`（T85）、`resume-at-cap-does-not-consume-new-slot`、`restart-rebuilds-capacity-from-lanes`、`cleanup-failure-closes-new-acquisitions`、`pending-review-receipts-bounded-by-inflight-and-plan-cap`（T85）。

#### `class ReviewLedgerStore`
- 拓扑：P3-D17。
- 职责：attempt record永不删除，字段通过原子RMW单调增补；创建时固定selected profile id、claimed scope digest、可选authorization artifact digest与`HistoricalSourceProvenance`引用，source route不进入identity。LearningView后、planner前写effectiveThrough/outcomes/RepairEpisodes/base digest；planner返回后、immutable plan前写actual request attestation及match verdict。Validated result以immutable plan+identity version+plan digest进入planned；attestation mismatch不得进入planned/committing。`markOpState`单调，terminal/finalized幂等。Finalized attempt保留validated repair lessons与exact episode coordinates。`RepairEvidenceOperation`由D23 human command以CommandId派生，prepared→applied|failed单调；confirm/reject-candidate exact绑定lesson/ref/revision/digest，reject-lesson对project内exact lesson digest生效，模型不可创建。`rebuildRepairCorroborationIndex`按`RepairLessonDigest`聚合distinct finalized source Session、已applied human candidate confirmation/rejection与lesson rejection；index只在authority后写，缺失可从attempt+repair operations重建，冲突fail-loud。Outcome ordinal/counter/index/page语义保持RC5.5.4：正十进制BigInt单调分配，crash gap合法，ordinal→attempt为可重建投影，page只读finalized Host outcomes。
- provenance：attempt是review op/repair evidence authority；`GovernanceOperation`是direct memory与skill governance authority。同CommandId先查authority status，applied重放、prepared reconcile、failed重放同一失败，均早于current target/base。Derived op/corroboration index在authority后写并可重建。
- 验收：`attempt-record-retained-and-transitions-monotonic`、`profile-and-source-provenance-persisted-separately`（T92）、`source-route-not-in-attempt-identity`、`effective-through-and-claimed-scope-persisted-pre-planner`、`repair-episodes-persisted-pre-planner`（T94）、`actual-attestation-persisted-before-plan`（T88）、`attestation-mismatch-never-reaches-planned`、`planned-boundary-persists-immutable-plan`、`recover-from-planned-never-recalls-model`、`opstate-monotonic`、`terminal-decision-immutable`、`finalized-outcomes-retain-turn-and-event-coordinates`、`repair-corroboration-counts-distinct-finalized-sessions-only`（T94）、`repair-index-rebuilds-from-retained-attempts`（T94）、`repair-index-conflict-fails-loud`、`unfinalized-outcomes-not-exported-to-curator`、`outcome-ordinal-schema-rejects-zero-negative-leading-zero`、`counter-record-initialized-before-claims`、`counter-increments-beyond-max-safe-integer`、`concurrent-finalized-attempts-get-distinct-ordinals`、`finalized-outcome-pages-append-by-ordinal`、`counter-crash-before-attempt-write-leaves-safe-gap`、`assigned-outcome-ordinal-never-changes`、`duplicate-outcome-ordinal-fails-loud`、`outcome-index-rebuild-preserves-checkpoints`、`late-finalized-attempt-appends-after-checkpoint`、`opid-resolves-source-attempt-after-restart`（T84）、`receipt-eviction-does-not-break-provenance-query`、`provenance-index-crash-gap-rebuilds`、`provenance-conflict-fails-loud`。

#### `groupFinalizedReceipts(opStates): {memoryGroups,skillGroups}`
- 拓扑：P3-D18。
- 职责：只选 ledger 已 finalized attempt 的 applied|duplicate opState；memory 按 scope、skill 按 ref；prepared/failed/not-started 不 cleanup。
- 验收：`finalized-ack-only-applied-opstates`（T66/T85）、`zero-mutation-finalized-has-no-ack-call`、`groups-never-cross-resource-or-scope`。

#### `finalizeAttempt(attemptId)` / `reconcileReviewState(sessionId)`
- 拓扑：P3-D18；调用D13、D15–D17与P1/P2 finalized-ack。
- finalization：ledger markTerminal 已持久化 decision → cursor applyDisposition → ledger markFinalized → `ensureFinalizedOutcomeIndexed` → 以 finalized attempt 的 applied|duplicate opStates 调 P1/P2 `acknowledgeFinalizedOps` → cursor releaseAttempt。Review receipt 在 `markFinalized` 成功前一直留在不淘汰 pending；cursor 在 outcome 可分页发现且 cleanup 成功前一直 occupied。
- reconciliation：先扫描terminal&&!finalized，重放persisted disposition并mark finalized；再为全部finalized attempt补齐stable outcome/op/repair-corroboration derived indexes；再检查cursor occupied：ledger finalized且已indexed→重放finalized receipt cleanup→release，绝不resume plan；planned/committing按persisted resume gate续同一attempt，planning crash走pre-plan retry。D17 outcome mutex串行`markFinalized→ensure index`、显式reconcile与page read，query不观察finalized-but-unindexed，也不暗藏修复写。P4每次outcome page scan前显式调用reconciliation；失败不读page、不推进checkpoint并记coverage gap。全部lane分类完成前不接受新acquired；index/cleanup失败保持gate closed，但正常前台Agent继续。
- 验收：`terminal-finalization-is-idempotent`、`review-receipt-stays-pending-until-ledger-finalized`（T85）、`crash-after-finalized-before-index-recovers`、`index-failure-keeps-cursor-occupied-and-acquisition-closed`、`crash-after-index-before-ack-recovers`（T72/T85）、`crash-after-ack-before-release-recovers-after-ring-eviction`（T85）、`finalized-occupied-cleans-receipts-then-releases-not-resumes`、`startup-reconciles-before-new-claim`、`outcome-mutex-hides-finalized-before-index`、`outcome-page-read-performs-no-durable-write`、`cleanup-failure-blocks-new-review-not-foreground-agent`、`finalization-crash-injected-after-every-durable-write`、`terminal-status-does-not-imply-range-consumption`、`terminal-recovery-uses-persisted-effective-through`。

## 8. Planner 与 runtime

#### `resolveReviewProvider(ctx,config): ReviewProvider`
- 拓扑：P3-D19。
- 职责：load-time按D06 named profile取得provider；要求`inheritsParentContext=false`，capabilities的agentOptions/outputSchema/depthLimit/toolFilter/isolatedPrompt/requestAttestation全true；否则conservative为`unsupported_review_provider`，不fallback到另一个provider。缺isolated/attestation的fresh provider只可由D07选择shadow。
- 验收：`review-provider-must-be-fresh`（T70）、`conservative-provider-must-support-isolation-and-attestation`（T88/T89）、`missing-provider-fails-load`、`authorized-provider-unavailable-never-falls-back`。

#### `startPlanner(parent,input,scope,config)` / `attestPlannerRequest(run,scope)` / `gatePlannerResult(result)`
- 拓扑：P3-D19；调用D05 schema、D06–D07 profile/scope、D10 context与E01 provider primitives。
- 职责：D19内部先完成并转绿`resolveReviewProvider`，再实现调用它的`startPlanner`，最后实现attestation/result gates。请求固定`toolFilter:{allow:[]}`、`maxDepth:1`、output schema、review-owned isolated complete prompt、runtime-context suppression与D06 selected profile agent options；不得按parent/historical source route重新解析。普通业务工具不可见/不可执行，scoped `structured_output`唯一且恰好成功一次。Input包含D10 bounded SkillLearningContext与RepairEpisodes/Support，但不含oracle。`attestPlannerRequest`从provider-owned actual attestation重算epoch/profile digest并与claim scope constant-time比较，在immutable plan/admission/mutation前写ledger；缺失或失配manual、零advance。Gate另要求completed+structured+schema与context target引用合法。
- 验收：`planner-only-visible-tool-is-structured-output`（T70/T89）、`planner-structured-output-succeeds-exactly-once`（T89）、`planner-ordinary-tool-execution-is-denied`、`planner-has-no-parent-conversation-history`、`planner-standing-sections-and-runtime-context-absent`、`planner-request-header-matches-authorized-scope`（T88）、`adapter-default-change-invalidates-attestation`、`attestation-mismatch-zero-resource-mutation-and-zero-advance`（T88）、`remote-run-without-attestation-is-not-conservative`、`gate-terminal-zero-mutation`、`output-tokens-wired`。

#### `class ReviewRuntime`
- 拓扑：P3-D20。
- `ensureReviewThrough(agent,seq)`：在`agent.runMaintenance` owner下reconciliation → D06 select profile → D07 resolve scope/select lane → D16 claim → run；blocking caller失败仍delegate。未授权level从一开始只访问shadow lane。
- `runReview(claim)`：create attempt并分别写profile/source provenance → projection/outcome/RepairEpisodes/effectiveThrough+claimed scope durable → current resource views/P2 learning inventory/D17 repair support → D10 context → planner → actual attestation durable/verify → gate/store immutable plan → enumerate/derive IDs → whole-plan admission → shadow/noChange/rejected noChange或fixed-order forward saga（memory后skill）→ conservative-auto对每个eligible skill调用P2 `promoteAutonomously`并记录activation result → each resource result mark opState → persisted disposition → finalization。Draft level永不调用auto promotion；P5 scope pass本身不能替代candidate evidence。
- recovery：planned/committing 使用 stored plan/op ids，绝不召回模型；resource success/ledger crash由 receipt duplicate吸收。immutable plan 后的瞬态故障 defer 同一 inFlight，partial saga 不回滚也不新建 attempt；在任何 op applied 前出现 stale 可 supersede，新 whole attempt 重规划；已有 applied op 后的 stale/invariant failure 进入 manual，等待用户 retry/skip，不能把部分提交伪装成 zero-commit。只有 terminal decision 才进入 finalization。
- 验收：`saga-happy-path`、`profile-and-authorization-selected-before-claim`（T88/T92）、`no-resource-write-before-plan-and-attestation-persisted`、`memory-committed-skill-write-fails-recovery-finishes-same-attempt`、`partial-saga-transient-never-replans`（T77/T85）、`partial-saga-stale-enters-manual`、`resource-success-ledger-crash-duplicates`、`auto-activation-ledger-crash-replays-same-id`（T91）、`saga-planned-boundary-recovers-without-model`、`saga-range-never-skips`、`saga-stale-before-first-write-replans-new-attempt`、`saga-budget-consolidation-new-whole-attempt`、`draft-lane-never-auto-promotes`（T91）、`auto-lane-rechecks-candidate-evidence-and-base`（T91/T94）、`unresolved-failure-zero-visible-learning`、`unresolved-false-proposal-consumes-rejected-nochange`、`no-signal-empty-plan-consumes-nochange`、`rollout-lanes-never-promote-shadow-plan`。

#### live trigger 与 foreground settlement
- 拓扑：P3-D21。
- 职责：resume-async/resume-blocking/maintenance 三模式；每个入口先 D02 root predicate；planning foreground cancel→retry settlement，planned/committing→resumable stored plan；bounded wait；child lifecycle不触发。
- 验收：`async-dispatch-no-mid-turn-append`、`foreground-preempts-background`、`cancel-before-planned-clears-inflight`、`cancel-after-planned-resumes-stored-plan`、`same-process-next-turn-not-permanently-busy`、`review-child-never-dispatches`（T71）。

## 9. 冷历史协调器

#### `enumerateHistoricalReviewWork(records,checkpoint,config): HistoricalPage`
- 拓扑：P3-D22。
- 职责：稳定按 `{createdAt desc,id}`；root/persisted/cwd/project/time/preset/control 过滤；bounded page；checkpoint 在每项成功或明确跳过后推进，到尾新 cycle；列表变化最迟下一 cycle 发现，per-session cursor 才是完成真相。
- 验收：`maintenance-discovers-cold-root-sessions`（T79）、`maintenance-excludes-child-sessions`、`maintenance-honors-project-time-and-rate-limits`、`maintenance-checkpoint-survives-restart`、`new-session-behind-checkpoint-found-next-cycle`、`maintenance-opt-out-stops-new-claims`。

#### `deriveHistoricalSourceProvenance(observation)` / `resolveHistoricalAgentOptions(observation,profile): AgentOptions`
- 拓扑：P3-D22；调用D06 selected named profile与existing `foldRequestHeader` only for source provenance。
- 职责：从最后`request/header`取得event seq、canonical digest与non-secret provider/model/reasoning摘要；不复制system/tools/body到attempt。Agent resume options来自selected profile，不来自source route。存在历史request但source provider已unregistered仍可resume carrier并启动review child；profile不可用按D06 fail-closed，不回落source。真正无request的空session不eligible。
- 验收：`source-route-retained-as-provenance-only`（T92）、`historical-resume-uses-selected-review-profile`（T92）、`retired-source-provider-history-remains-learnable`（T92）、`source-model-change-does-not-create-review-lane`、`historical-provenance-does-not-duplicate-system-tools-or-body`、`profile-unavailable-does-not-fallback-cross-provider`。

#### `HistoricalReviewCoordinator.runPass(signal)`
- 拓扑：P3-D22。
- 职责：`sessionQuery.listSessions/observeSession({projectionMode:'all'})`；读取projected latest preset；先D06选择profile并D22派生source provenance，live Agent只作source/carrier且conservative child仍使用profile，cold Agent用`agents.resume({agentOptions:profile.agentOptions}) + agentPresets.mount`；review到observation cursor；只dispose自己创建的handle；live/history共用claim，busy留待下一pass；cost/rate/token cap和abort。
- 验收：`historical-resume-mounts-projected-preset`、`historical-review-does-not-require-source-provider-availability`（T92）、`one-profile-produces-one-authorization-scope`（T92）、`maintenance-and-live-review-do-not-double-claim`（T79）、`historical-disposes-owned-agent-only`、`historical-abort-preserves-checkpoint-at-last-settled`、`historical-budget-stops-before-next-resume`。

Cold carrier 只用于建立 review child 所需的 Host context：它不调 source `run()`、不 append prompt、不生成新的 source `request/header`。唯一 LLM 请求属 P3-D19 review child；`agents.resume({agentOptions:profile.agentOptions}) + agentPresets.mount` 不得被使用成 historical source turn。增补验收：`historical-carrier-emits-no-source-model-request`（T92）、`historical-carrier-never-runs-source-turn`（T92）。

## 10. 人类治理与 provenance

#### memory/skill/review command handlers
- 拓扑：P3-D23；全局commands registry，模型无同名工具。
- memory：list/show/correct/remove；correct/remove先写 GovernanceOperation prepared，以 CommandId 派生 op id，exact state revision+entry digest，调用 `MemoryService.applyDirectOps`，再 mark applied；如 mark applied 失败，该 memory scope 立即进入 governance-blocked，P3 不再接受该 scope 的 direct command 或 review memory commit，直到 `reconcileGovernanceOperations` 以 terminal receipt 重放资源调用并写 applied。启动在新 command/review claim 前处理全部 prepared，因而 bounded receipt 不会在权威记录落定前被任何后续 terminal receipt 淘汰。可确认的验证失败写 failed；show解析 review/governance provenance与 evidence spans。
- skill：list/show/approve/reject/reopen/restore/pin/unpin/enable-auto/disable-auto/confirm-repair/reject-repair；approve全重验。Confirm-repair必须向用户展示exact structured lesson与target revision，以CommandId派生D17 candidate-bound `RepairEvidenceOperation`。Reject-repair允许用户明选exact candidate或project-level exact lesson digest，不允许含混的文本target hint；两者都不是模型工具、不直接改skill current pointer。普通Reject一个repair-derived revision只写candidate-bound authoritative rejection，不自动扩大为全project lesson rejection；pin和disable-auto立即阻止background activation/consolidation，但不改owner。Show通过P2 lineage解析direct-tool session/call、review attempt、activation permit与absorption destination；restore调用P2 governance actor。Review：enable/disable、retry、skip；skip明确记录用户授权consumed through。
- 验收：`memory-show-resolves-source-attempt`、`memory-correction-uses-id-and-digest`（T80）、`memory-correction-removes-old-content-from-next-snapshot`、`memory-remove-is-user-governance-only`、`governance-operation-crash-reconciles`、`governance-authority-duplicate-before-current-target`、`governance-ledger-failure-blocks-direct-and-review-scope-until-reconciled`、`prepared-remove-reconciles-before-any-receipt-eviction`、`governance-show-renders-source-spans`（T84）、`skill-show-resolves-direct-tool-after-receipt-eviction`、`skill-show-resolves-review-attempt-and-activation`、`repair-confirmation-command-binds-exact-lesson-and-revision`（T94）、`repair-confirmation-does-not-directly-activate-skill`、`repair-evidence-operation-crash-reconciles`、`model-cannot-call-repair-confirmation`、`skill-reject-records-repair-contradiction`（T94）、`pin-or-disable-auto-does-not-change-owner`（T91）、`skill-restore-user-only`（T82/T93）、`manual-hold-requires-governance-release`、`governance-absent-from-model-tool-surface`。

## 11. Config 与 Service assembly

Config fields全JSDoc：`triggerMode`；named `reviewExecutionProfiles`与project/preset selector；shadow-only `inheritCurrent`；token/context budgets；debounce；`policyVersion/learningViewVersion/rolloutLevel/evalProtocolVersion`（RC5.5.5固定为2）；isolated planner prompt；rollout authorization path/trusted signer；`maxPlanOps/maxConcurrentReviews`与plan/evidence/SkillLearningContext hard caps；`minIndependentRepairSessions`；pre-plan retry、stored-plan resume backoff/max attempts、max supersede/max consolidation；eligible presets/projects/time；historical enabled/batch/interval/rate/token cap；control defaults。`maxPlanOps × maxConcurrentReviews`为safe integer并受明确上限。Named provider capability在load-time验证；每个session先选profile、再在claim前解析scope，不能首次mutation才发现。

#### `class SessionReviewService extends Service`
- 拓扑：P3-D24。
- 职责：唯一review domain opener；持有profile selector、authorization verifier、cursor/ledger/repair projection/claim coordinator/runtime/history；注册host lifecycle listeners、commands与maintenance；向P4公开named profile execution helper、显式`reconcileFinalizedOutcomeIndex`与无写入paged `listFinalizedOutcomeSignals`，它们和finalization共用D17 outcome mutex。启动完成D18 review reconciliation、D23 governance reconciliation、authorization/profile检查、outcome/op/repair indexes rebuild与durable inFlight capacity rebuild后才允许新acquired；故障只关闭review acquisition，不阻断正常Agent；所有effect/disposer HMR-safe。
- 验收：`review-service-single-registration`、`review-domain-opened-once`、`not-ready-before-reconciliation`、`named-profiles-validated-before-claims`（T92）、`repair-index-ready-before-auto-promotion`（T94）、`host-mount-observes-multiple-root-agents`、`hmr-stops-live-and-history-work`。

Phase出口：T70–T80/T83–T89/T91–T92/T94中属P3的全部测试、原P3 tests、100% coverage；REAL boot注入每个durable finalization边界、finalized ack后ring淘汰、live/history竞态、retired source provider+named reviewer、未授权level、actual attestation mismatch、planner structured-only request、memory correction、single/corroborated RepairEpisode、draft→authorized-auto activation；keyless snapshot覆盖纠错旧memory、exact retry、changed-method single-draft/corroborated reuse、unresolved零可见、historical route decoupling与isolated planner；E01更新对应architecture/subsystem/API catalog/必要双SDK expected outputs，README/Agent Note与doc gates全绿。
