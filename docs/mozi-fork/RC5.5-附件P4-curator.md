# RC5.5.5 附件 P4 — Skill lifecycle curator 与 class-level consolidation（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；前置：P2、P3；包：`packages/skill/skill-curator`；日期：2026-09-02。
>
> P4 不把“技能定义加载成功”写成“任务成功”。它分存 model load、用户显式调用、patch 与 Host 结构可验的 reuse outcome；正信号即使 coverage 不完整也可使 stale 回 active，但“窗口内零活动”只能在完整覆盖时触发 stale/archive。archived 不可见，只能由 P3 人类治理调 P2 governance restore。
>
> P4a保留RC5.5.4的deterministic usage/lifecycle。P4b是独立的bounded semantic consolidation pipeline：它复用P3 named profile/attestation和P2 exact mutation/promotion/absorption API，但拥有project-level `ConsolidationAttempt`；不把LLM判断混入D07 lifecycle state machine。
>
> 当前 `SkillInvocationSource` 只持久化 name/form，不能在重启后区分同名人工 provider 与 managed provider；model tool 的 execution-local value 虽含 provider，却从 durable tool/result 删除。现有 `output.presentationMeta` 会与 top-level tool/result 同条持久化，并明确不为 nested composite call 生成；后者的结果不直接进入模型请求，不能计作 model load。P4 的第一个叶节点因此为 user source 和 top-level result meta 补 winning provider；没有这两项前不实现 usage 归属。

## 1. 模块布局

```text
src/types.ts          # signal/coverage/usage/config/report types
src/config.ts         # Config resolve/validation
src/signals.ts        # classify/fold/verified-reuse pure helpers
src/coverage.ts       # coverage epoch/gap/heartbeat pure helpers
src/outcome-batch.ts  # outcome digest、stable signal coordinate、deterministic batch
src/state-machine.ts  # decideLifecycleTransition
src/store.ts          # durable usage/coverage store
src/observer.ts       # live + durable event observation
src/curator.ts        # maintenance pass
src/metrics.ts        # operational aggregation
src/consolidation-types.ts    # cluster/plan/attempt/config
src/consolidation-cluster.ts  # bounded deterministic candidates
src/consolidation-plan.ts     # schema/canonical identity/preflight inputs
src/consolidation-store.ts    # durable attempt/claim/recovery
src/consolidation-planner.ts  # named profile + attested structured output
src/consolidation-runtime.ts  # destination-first forward saga
src/index.ts          # host-level assembly/effects
../skill/src/index.ts       # SkillInvocationSource.provider
../tool-skill/src/index.ts  # durable skill-load presentationMeta
```

## 2. 类型与权威

```text
UsageSignal =
  | {kind:'model-load',ref,sessionId,sourceSeq,callId,observedAt}
  | {kind:'explicit-user-invocation',ref,sessionId,sourceSeq,observedAt}
  | {kind:'patch',ref,revisionId,opId,observedAt,activated:boolean}
  | {kind:'verified-reuse',ref,sessionId,loadCallId,outcomeRefs,observedAt}
UsageAggregate = {modelLoads,userInvocations,patches,verifiedReuses,
                  lastModelLoadAt?,lastUserInvocationAt?,lastActivatedPatchAt?,lastVerifiedReuseAt?}
UsageRecord = {aggregate,recentSessionOrOutcomeReceipts:BoundedRing,
               revisionStates:{[revisionId]:{activated:boolean}}}
UsageCoverage = {epoch,status:'open'|'closed',completeSince,lastHeartbeatAt,closedAt?,lastGapAt?,gapReason?}
FinalizedOutcomeScanCheckpoint = {afterOrdinal?:FinalizedOutcomeOrdinal,
  inProgress?:{ordinal,outcomeDigest,signalDerivationVersion,afterSignalCoordinate?}}
OutcomeSignalCoordinate = {sessionId,turnRef,eventSeq,callId?,ref,kind}
UnresolvedOutcomeFault = {ordinal,outcomeDigest?,signalDerivationVersion,reasonCode,
                          status:'unresolved'|'repairing'|'resolved',repairAfterSignalCoordinate?}
SessionUsageScanCheckpoint = {sessionId,afterSeq?}
CoverageDecision = complete | incomplete
LifecycleDecision = {to:'active'|'stale'|'archived',reason,at} | undefined
CuratorConfig = {staleAfterDays,archiveAfterDays,zeroUseGraceDays,
                 intervalHours,minIdleHours,coverageHeartbeatMinutes,coverageStaleMinutes,
                 signalReceiptWindowSize,outcomePageSize,maxSignalsPerOutcomeBatch,sessionEventPageSize}
SkillInvocationSource = {kind:'skill-invocation',name,provider,form:'instructions'}
SkillLoadPresentationMeta = {kind:'skill-load',name,provider,renderedContentDigest}
ConsolidationCluster = {projectKey,clusterId,cursor?,complete,items:[{ref,revision,digest,
                        name,catalogSummary,triggerTokens,owner,pinned,autonomousManaged}]}
ConsolidationPlan = {destination:create|patch,absorbedSources:[{ref,revision,digest}],reason}
ConsolidationAttempt = {attemptId,projectKey,clusterId,profileId,scopeDigest,attestation,
                        authorizationRef:rollout{artifactDigest}|evaluation{evalPermitId},
                        immutablePlan,planDigest,destinationState,sourceStates,
                        promotionEvidence?:ConsolidationPromotionEvidence,
                        status,terminal?,finalized?}
EvaluationConsolidationPermit = {evalPermitId,caseId,repeatIndex,scopeDigest,clusterId,planDigest}
EvaluationConsolidationAuthority = process-local opaque capability bound to one disposable eval root
```

P4 usage store 是 lifecycle 输入权威；P2 managed record 是 skill state/anchor 权威；P3 finalized outcome 是结构 outcome 权威。`model-load` 只表示 exact managed provider 返回了定义，可作可见 stale 技能的活动信号，但不增加 `verifiedReuses`、不证明任务成功，P5 不得用 modelLoads 替代 quality score。

## 3. 开发拓扑

| 顺序 | 节点 | 只可调用 |
|---:|---|---|
| P4-D01 | durable invocation provider + skill-load result meta | existing skill registry/tool-skill/tools |
| P4-D02 | types/schema + `validateCuratorConfig` | D01、P2/P3 public types |
| P4-D03 | `classifyUsageSignal/foldUsageRecord` | D01–D02 |
| P4-D04 | coverage transitions + `resolveCoveredInactivityAnchor` | D02 |
| P4-D05 | `deriveVerifiedReuse` | D02–D03、P3 finalized outcome classifier |
| P4-D06 | `canonicalOutcomeDigest/compareSignalCoordinate/deriveOutcomeSignalBatch` | D02–D05、P3 finalized outcome projection |
| P4-D07 | `decideLifecycleTransition` | D02–D04、unresolved fault summary |
| P4-D08 | `SkillUsageStore` | D02–D04、D06、storage domain |
| P4-D09 | `SkillUsageObserver` + source reconciliation/fault repair | D03–D06、D08、P2 typed events/lineage/list/provider identity、P3 ordinal outcome pages、durable session events |
| P4-D10 | `SkillCurator.runPass` | D07–D08、P2 transition/list APIs |
| P4-D11 | `aggregateOutcomes` | D02、P3 ledger/P4 store read APIs |
| P4-D12 | package assembly | D08–D11 |
| P4-D13 | consolidation types/schema + `validateConsolidationConfig` | P2/P3 public types、D02 |
| P4-D14 | `buildBoundedSkillClusters` | D13、P2 learning inventory |
| P4-D15 | plan schema + `canonicalConsolidationPlanDigest/deriveConsolidationIds` | D13–D14、crypto |
| P4-D16 | `preflightConsolidationAttempt` | D14–D15、P2 `preflightConsolidation` |
| P4-D17 | `ConsolidationAttemptStore` | D13、D15、storage domain |
| P4-D18 | `startConsolidationPlanner/attestConsolidationPlanner` | D13–D15、P3 named profile/execution APIs |
| P4-D19 | `SkillConsolidator.runPass/resumeAttempt/createEvaluationConsolidationAdapter` | D16–D18、P2 mutation/promotion/absorption APIs |
| P4-D20 | consolidation assembly + metrics extension | D13–D19、D12 host assembly |

D01先于user-invocation classifier，D06先于checkpoint Store/observer，D07先于curator，D08先于observer；observer不得自行迁移skill，curator不得从“没有record”或unresolved fault推导零使用。P4b严格位于P4a与P3 Phase出口之后：D14 cluster先于D18 planner，D15 identity先于D17 Store，D16 read-only preflight先于D19 mutation caller；任何source archive都晚于destination exact activation。

## 4. 纯函数与 coverage

#### durable invocation provider 与 skill-load result meta
- 拓扑：P4-D01。
- 职责：`SkillInvocationSource` 增加 required `provider:string`；`tool-skill` 在 `ctx.skills.get(name)` 成功且 user-invocable 后，把该 loaded `SkillDefinition.provider` 原样写入 source。model tool 的 `output.presentationMeta(args,value)` 从 validated canonical value 生成 exact name/provider，并对 canonical `renderSkillContent(value)` 计算 digest；top-level final tool/result 会同条持久化 meta。P4 只在 `name='skill'`、`isError=false`、meta name 与 durable call arguments 相同且 persisted content digest 与 meta 相同时承认 load；post-execute content replacement因此不会误计。Nested PTC sub-dispatch 没有 presentationMeta，且其 dispatch log 不直接进入模型请求，明确不计 model load。不从 name 事后猜 provider，不把 provider 渲染到 model-facing skill body。P4 在 durable 读边界验证 provider/name/digest；旧的无 provider source/meta 标记 unattributable并造成 coverage gap，不默认归给 managed，也不拒绝整个历史会话。meta projector 失败按现有 tools 语义把调用变成 error，不产生一个“模型已见内容但 durable identity 缺失”的成功结果。
- 验收：`user-invocation-source-records-winning-provider`、`human-and-managed-same-name-source-distinguishes-provider`、`provider-metadata-survives-session-replay`、`provider-not-rendered-as-model-instruction`、`top-level-skill-result-persists-provider-and-content-digest`、`post-execute-content-replacement-is-not-counted-as-load`、`meta-name-must-match-durable-call-arguments`、`ptc-skill-subdispatch-is-not-model-load`、`presentation-meta-failure-produces-tool-error`、`legacy-source-without-provider-marks-gap-and-is-not-attributed`。

#### `validateCuratorConfig(config): ResolvedCuratorConfig`
- 拓扑：P4-D02。
- 职责：所有 duration 为 finite 正数；`coverageStaleMinutes > coverageHeartbeatMinutes`；`archiveAfterDays >= staleAfterDays`；四个容量字段为正 safe integer，且 `signalReceiptWindowSize >= max(maxSignalsPerOutcomeBatch, sessionEventPageSize)`。outcome page 可含多个 outcome，但 D06/D08 每次只开放一个 batch 的 receipt crash window；不再以 `outcomePageSize × 单 outcome 总 signal` 预留无界窗口。参数在 schema/README 显式默认或 required，不在 `runPass` 内隐式补默认。
- 验收：`curator-config-valid-exact-boundaries`、`coverage-stale-must-exceed-heartbeat`、`archive-window-not-shorter-than-stale-window`、`nonfinite-duration-fails-load`、`outcome-capacities-must-be-positive-safe-integers`、`signal-receipt-window-covers-one-outcome-batch`（T90）、`outcome-page-size-does-not-multiply-batch-receipt-window`。

#### `classifyUsageSignal(input): UsageSignal | undefined` / `foldUsageRecord(current,signals,windowSize): UsageRecord`
- 拓扑：P4-D03。
- 职责：durable top-level skill tool/result 的 meta provider 必须为 managed 且 name/content digest 绑定通过，再以 session cwd/name 解 exact ref → 带 source seq 的 model-load；durable `skill-invocation` 的 provider 必须为 managed，再以 session cwd 解 ProjectKey 并由 project+name 派生 exact ref → explicit-user-invocation；其他 provider 忽略。P2 `revision-committed` → patch activated:false，随后同 revision 的 `revision-activated` 把同一 `revisionStates` 项单调升级为 activated:true，不把一次 revision 计成两次 patch；D05 admitted record → verified-reuse。session/outcome signal 由 source checkpoint + bounded recent receipt 去重；revision signal 由每个 skill 保留的全量 revisionStates 去重，该集合受 P2 `maxRevisionsPerSkill` 硬上界约束。各类计数/时间独立，不在 fold 内把 model-load 升级为 verified-reuse。
- 验收：`successful-managed-load-classified`（T41）、`human-provider-load-not-attributed`（T41）、`explicit-user-invocation-refreshes-activity`（T82）、`patch-and-activation-distinguished`、`activation-upgrades-same-revision-without-double-count`、`model-load-is-not-verified-success`（T82）、`signal-replay-deduplicates`、`signals-remain-project-isolated`。

#### `startCoverageEpoch/recordCoverageGap/heartbeatCoverage/resolveCoveredInactivityAnchor`
- 拓扑：P4-D04。
- 职责：Service ready 后开 epoch 并持久化 heartbeat；正常 dispose 只有在 listener 已停、queue 与 checkpoints 均结算后写 status closed。启动看到 previous status open 即判定非正常中断并记 gap，不因 heartbeat 尚未超时而假装完整；旧 heartbeat 超 `coverageStaleMinutes`、listener/queue/store 失败或 HMR 未正常闭合也记 gap，将 `completeSince` 重置为恢复正常观测的时刻。heartbeat healthy 且 epoch open 时，`resolveCoveredInactivityAnchor(activityAnchor,coverage)` 返回 `max(activityAnchor,completeSince)`；因此 gap 令完整 inactivity 窗口从恢复时重新计时，而不是永久阻止迁移，也不把 gap 内未知活动当作零。heartbeat stale/closed 时返回 incomplete。任何已观测正信号不因 gap 被丢弃。
- 验收：`fresh-epoch-uses-coverage-start-as-effective-anchor`、`continuous-heartbeats-become-queryable`、`observer-gap-resets-inactivity-clock`（T82）、`gap-does-not-block-inactivity-forever`、`unclean-open-epoch-marks-gap-even-with-fresh-heartbeat`、`clean-closed-epoch-does-not-invent-gap`、`stale-heartbeat-records-gap-on-restart`、`store-failure-resets-complete-since`、`positive-signal-survives-coverage-gap`。

#### `deriveVerifiedReuse(load,finalizedOutcome): UsageSignal | undefined`
- 拓扑：P4-D05；只读 P3 finalized Host outcomes。
- 职责：按finalized outcome的durable session/turn/event coordinates回读exact top-level skill tool/result与validated meta；只在exact root session中managed load之后、同一completed turn内有可定位tool-success或`retry-recovered`，且该turn无later unresolved时产生结构`verified-reuse`。RepairEpisode单独不算reuse，只有其working call同时满足tool-success条件时可计结构活动；不依赖可能淘汰的usage receipt。Assistant自述、turn completed单独、transient/unknown不产生。该信号不声称skill对语义成功有因果。
- 验收：`load-then-tool-success-derives-structural-reuse`、`retry-recovered-derives-reuse`、`repair-episode-alone-is-not-reuse`、`later-unresolved-blocks-verified-reuse`、`assistant-success-claim-never-derives-reuse`、`cross-session-or-turn-outcome-never-correlates`。

#### `canonicalOutcomeDigest(outcome)` / `compareSignalCoordinate(version,a,b)` / `deriveOutcomeSignalBatch(outcome,version,afterCoordinate,limit)`
- 拓扑：P4-D06；调用 D05 对单个 load/outcome 配对，不做 I/O。
- 职责：digest 只覆盖 finalized outcome 的 immutable durable coordinates 与分类字段；`SIGNAL_DERIVATION_VERSION` 作为 checkpoint 的独立协议维度，不在 digest 中重复编码。coordinate 固定按 `{sessionId,turnRef,eventSeq,callId?,ref,kind}` 比较，字段和顺序由传入 version 锁定。新 outcome 捕获当前 version，恢复 in-progress 或 fault repair 必须按持久化 version dispatch 同一派生实现；尚有对应 checkpoint/fault 时不得删除该已支持版本，真正未知 version fail-loud。batch 按 coordinate strict-after 产生最多 `limit=maxSignalsPerOutcomeBatch` 个 deterministic signals 与 `{lastCoordinate,atEnd}`，不先物化整 outcome signal 数组。恢复时 outcome digest 与 derivation version 必须分别与 checkpoint 相同；同 coordinate 产生不同 signal 是 `outcome_coverage_fault`。oversized outcome 只表现为 `atEnd=false`，不是 gap。
- 验收：`outcome-digest-and-coordinate-vectors-pinned`、`outcome-batch-stable-order-and-limit`、`outcome-batch-resumes-strictly-after-coordinate`、`supported-older-derivation-version-resumes-identically`、`unknown-derivation-version-fails-loud`、`oversized-outcome-requires-multiple-batches-not-gap`（T90）、`digest-or-derivation-version-mismatch-fails-loud`、`batch-does-not-materialize-unbounded-signal-list`。

#### `decideLifecycleTransition(record,usage,coverage,now,config): LifecycleDecision`
- 拓扑：P4-D07。
- 职责：draft/rejected/archived 与 pinned 返回 undefined；active 的 activity anchor 为 promotion/current-revision activation 与四类 usage 时间的 max，再经 D04 得到 covered inactivity anchor，窗口满足才 active→stale。没有 usage record 不能单独解释为 zero；但从 `max(promotion,completeSince)` 起 heartbeat 连续覆盖完整窗口后，可保守认定该窗口零观测。任何 unresolved outcome fault 都禁止 active→stale 与 stale→archived，不影响 later model-load/user invocation/activated patch/verified-reuse 使 stale→active；fault resolved 后 `completeSince` 从 repair completion 重新开始。archived→active 在本函数不可达。
- 验收：`active-stale-after-covered-inactivity`、`never-used-requires-full-window-after-coverage-start`、`missing-usage-without-coverage-is-unknown`、`zero-use-grace-window`、`stale-model-load-reactivates`（T82）、`stale-explicit-use-reactivates`、`stale-verified-reuse-reactivates`、`archive-window-resets-on-any-observed-load`、`observer-gap-restarts-stale-and-archive-window`（T82）、`unresolved-outcome-fault-forbids-negative-transition`（T90）、`unresolved-fault-allows-positive-reactivation`、`resolved-fault-restarts-complete-window`、`archived-never-auto-reactivates`（T82）、`pinned-never-transitions`、`boundary-exact`。

## 5. Store、observer 与 curator

#### `class SkillUsageStore`
- 拓扑：P4-D08。
- 职责：唯一 usage domain opener；按 ProjectKey+SkillId 一个 RMW 先查 bounded session/outcome receipt 或 revisionStates，再 fold signal，去重状态与 aggregate 同笔写。coverage、`FinalizedOutcomeScanCheckpoint`、`UnresolvedOutcomeFault` 与 per-session `SessionUsageScanCheckpoint` 使用独立 host records RMW；提供 typed read/record/beginOutcome/advanceOutcomeBatch/completeOutcome/recordOutcomeFault/beginFaultRepair/completeFaultRepair/session-checkpoint APIs，不暴露 table。`beginOutcome` 固定 ordinal/digest/version；每批 signals 全部成功后 CAS `afterSignalCoordinate`；`atEnd` 时原子清 inProgress并推进 afterOrdinal。crash-before-subcursor 重放同 batch 由 receipt 去重，crash-after-subcursor 从 strict-after 继续。corrupt outcome 先 durable 记录 unresolved fault及当时的 signal derivation version/repair cursor，再允许 main afterOrdinal 越过，不能标 coverage complete；人工 repair按 exact ordinal从 retained P3 authority以 fault 锁定的 derivation version分批补信号，版本不可用时 fail-loud 而不改释历史 fault；完成后置 resolved并重置 `completeSince`。session checkpoint只在同一 durable event成功或明确无关后推进到 seq。未存在 usage record是 unknown，只有 D07 结合完整 coverage且无 unresolved fault才可解释零观测。
- 验收：`usage-record-first-write`、`signal-identity-idempotent-within-unsettled-batch`、`signal-receipt-ring-bounded-after-batch-checkpoint`、`two-projects-isolate`、`coverage-rmw-monotonic`、`missing-usage-is-unknown`、`session-checkpoint-advances-after-whole-event-settlement`、`outcome-batch-subcursor-cas-monotonic`（T90）、`crash-after-batch-before-subcursor-replays-idempotently`、`crash-after-subcursor-does-not-repeat-settled-batch`、`outcome-after-oversized-item-eventually-observed`（T90）、`outcome-checkpoint-never-rewinds-or-cycles`、`unresolved-fault-durable-before-main-checkpoint-advance`、`fault-repair-uses-persisted-derivation-version`、`fault-repair-settles-retained-outcome-before-resolve`、`service-opens-domain-once`。

#### `class SkillUsageObserver`
- 拓扑：P4-D09。
- 职责：host 层监听 `session/event`/durable flush只唤醒按 session seq 的 scanner；scanner处理 top-level skill result meta 与 `skill-invocation`，不绕过 D08 session checkpoint直接 fold。P2 typed revision-committed/activated可低延迟入队，但 startup/maintenance必须从 P2 immutable lineage/current pointers补扫并由 revisionStates吸收重复。maintenance `reconcileFinalizedOutcomes` 先显式调 P3 `reconcileFinalizedOutcomeIndex`，成功后从 D08 checkpoint调用无写入 paged `listFinalizedOutcomeSignals`；每个 ordinal按 D06 batch结算。oversized outcome跨多轮 maintenance继续，不截断、不记 gap，全部 batch 结算后必须推进到下一 ordinal，不得永久 head-block。只有已由 P3 page 定位到 exact ordinal 的 item-level schema/digest/provenance 不可能状态，才先写 D08 unresolved fault再越过主 checkpoint；later positive signals继续，negative lifecycle由 D07关闭，人工 repair从 P3 retained outcome authority按 fault cursor补算。P3 domain/table/page 整体无法解析、ordinal 索引不能建立或 source identity 不可定位时必须 fail-closed，不得伪造 item fault 后跳过。每个 session event/outcome batch从首个 signal RMW到 subcursor/checkpoint advance持有同一 host source-settlement mutex，其他 source只缓冲，不能在 crash window内淘汰该 batch receipt。启动时先注册并缓冲 listener，再完成 P2 revision、session page、outcome index/batch/fault reconciliation后才开放普通 queue commit。listener不向 tool/turn/skill CAS抛错；queue overflow、write failure、dispose丢弃未完成项必须 `markGap`。heartbeat只在 listeners、普通 sources、queue/store健康时更新；unresolved fault由独立 fault summary关闭负向 transition，不伪装成可自动恢复的普通 gap。
- 验收：`count-successful-managed-provider-load-only`（T41）、`stale-load-is-recorded-before-transition`、`durable-result-and-invocation-listeners-only-wake-session-scanner`、`durable-model-load-replays-on-restart`、`durable-user-invocation-replays-on-restart`、`session-event-crash-before-checkpoint-deduplicates-whole-page`、`revision-committed-and-activated-remain-distinct`、`crash-after-revision-cas-before-event-reconciles-from-lineage`、`revision-rescan-does-not-double-count`、`late-finalized-outcome-rereads-durable-load-meta-by-coordinate`、`late-finalized-outcome-discovered-by-ordinal-poll`、`oversized-outcome-settles-in-deterministic-batches`（T90）、`outcome-after-oversized-item-is-eventually-observed`（T90）、`outcome-digest-mismatch-records-fault-not-silent-skip`、`corrupt-outcome-fault-does-not-head-block-later-positive-signals`（T90）、`domain-level-outcome-corruption-fails-closed-without-checkpoint-advance`、`unresolved-fault-forbids-negative-lifecycle-transition`、`late-finalized-outcome-always-appends-after-checkpoint`、`source-settlement-mutex-prevents-receipt-eviction-before-batch-checkpoint`、`startup-reconciles-all-sources-and-faults-before-live-commits`、`listener-never-breaks-tool-result-or-skill-cas`、`queue-overflow-marks-coverage-gap`、`write-failure-marks-coverage-gap`、`dispose-stops-observation-and-closes-epoch`、`hmr-does-not-double-listen`。

#### `class SkillCurator`
- 拓扑：P4-D10。
- `runPass(signal)`：在 host maintenance claim 内列 P2 agent-owned managed records → 读 D08 usage/coverage/fault summary → D07 decision → 调 `ManagedSkillService.transitionManagedSkill(actor:'curator')` → 记录 report。它只可 active↔stale/stale→archived，不得调 governance restore；busy 保留 due，abort 不产生半条 lifecycle write。
- 验收：`pass-managed-agent-owned-only`、`pass-archives-never-deletes`、`pass-never-restores-archived`（T82）、`pass-gap-defers-negative-transition`、`pass-positive-signal-reactivates-stale`、`pass-idempotent-rerun`、`pass-busy-retried`、`pass-abort-no-half-transition`、`pinned-service-gate-unbypassable`。

#### `aggregateOutcomes(range): EffectivenessReport`
- 拓扑：P4-D11。
- 职责：纯聚合 operational 指标：proposal/commit/duplicate/reject/error-code、retry/manual/range lag/tokens/noChange、approve/reject/restore、model-load/user-invocation/patch/verified-reuse 分布、coverage gap duration、stale/archive transition、orphan/bytes/pending。输出分开 load 与 verified reuse，不生成 P5 quality 结论。
- 验收：`aggregate-matches-ledgers`、`aggregate-empty-zeros`、`aggregate-deterministic`、`aggregate-load-and-verified-reuse-separate`、`aggregate-no-quality-claims`。

#### package assembly
- 拓扑：P4-D12。
- 职责：host 级唯一 Store/Observer/Curator；Service ready 且三类 startup reconciliation 完成后才 heartbeat；effects 先停止接收新 source、结算或明确 gap，再注销 listener/timer/queue；只有全部排空并持久化 checkpoints 后可把 epoch 写 closed，未能排空则保持 open 并 mark gap。
- 验收：`host-assembly-single-observer`、`not-covered-before-ready`、`hmr-disposes-listeners-timers-and-queue`、`assembly-misconfiguration-fails-load`。

## 6. P4b class-level consolidation

#### `validateConsolidationConfig(config): ResolvedConsolidationConfig`
- 拓扑：P4-D13；调用P4-D02基础duration/cap helper与P2/P3 public types。
- 职责：校验enabled、interval、min cluster size、max cluster items/files/chars、page size、max concurrent attempts、retry/resume caps、allowed named review profiles与production required authorization capability=`skill-consolidation`。所有容量为正safe integer；`maxClusterItems`至少2。配置不允许inherit-current conservative profile，不在runPass内补默认。Eval-only adapter不通过Config伪造已签capability，而是另验P5创建的root-bound process authority。
- 验收：`consolidation-config-exact-boundaries`、`cluster-cap-at-least-two`、`consolidation-profile-must-be-named`、`consolidation-capability-required`、`runtime-does-not-default-consolidation-config`。

#### `buildBoundedSkillClusters(inventory,cursor,config): ConsolidationClusterPage`
- 拓扑：P4-D14；调用D13 config与P2 verified learning inventory。
- 职责：只纳入owner=agent、autonomousManaged、未pinned、active|stale的exact records；按normalized name、catalog summary/trigger token与已记录loaded/related refs生成deterministic候选边，连通分量按stable ref排序并分页。每个cluster受item/files/chars硬上限；超限返回continuation而非截断后声称complete。Usage count不参与overlap判断。首版不调用embedding/vector/LLM semantic search。
- 验收：`cluster-order-and-cursor-stable`、`prefix-and-trigger-token-form-bounded-candidates`、`usage-zero-never-proves-overlap-or-pruning`、`protected-user-external-and-pinned-excluded`、`oversized-cluster-pages-without-completeness-claim`、`no-vector-or-llm-call-in-clustering`、`unrelated-token-class-remains-separate`。

#### `ConsolidationPlanSchema` / `canonicalConsolidationPlanDigest(plan,version)` / `deriveConsolidationIds(projectKey,clusterId,attemptNo,planDigest)`
- 拓扑：P4-D15；调用D13–D14和crypto，不做I/O。
- 职责：planner输出恰好一个destination create/patch与零个或多个absorbed sources；destination patch和sources都复制cluster中的opaque exact ref/revision/digest，files为全量bundle。模型不提供owner、opId、attemptId、clock、permit、state或archive actor。Canonical plan固定destination在前、sources按ref排序，versioned digest派生attempt/resource op ids；stored attempt按原version重放。
- 验收：`consolidation-plan-one-destination`、`source-exact-bases-required`、`source-must-belong-to-cluster`、`authority-fields-rejected`、`canonical-plan-and-opid-vectors-stable`、`source-order-canonical`、`unknown-plan-version-fails-loud`。

#### `preflightConsolidationAttempt(cluster,plan,current,config): Promise<ConsolidationAdmission>`
- 拓扑：P4-D16；调用D14–D15与P2 `preflightConsolidation`，零写入。
- 职责：验证cluster/context digests、execution authorization capability、destination/source exact bases与plan hard caps，再委托P2执行owner/pin/structure/scan/conflict/quota检查。所有source exact bundles必须完整出现在attested planner input；任一确定性拒绝整attempt zero mutation。成功返回`structurallyAdmitted`与绑定cluster/context/plan/destination/source bases的canonical `preflightDigest`，不得命名为knowledgePreserved；D16本身不创建promotion evidence。
- 验收：`whole-consolidation-preflight-before-write`、`all-source-bundles-were-in-attested-input`、`one-stale-source-preflight-zero-mutation`、`unapproved-scope-is-shadow-only`、`preflight-digest-binds-plan-destination-and-all-source-bases`、`admission-never-claims-semantic-preservation`（T93）。

#### `class ConsolidationAttemptStore`
- 拓扑：P4-D17；调用D13、D15与storage domain。
- 职责：project级单opener；claim按project+cluster串行分配attemptNo并受`maxConcurrentConsolidations`限制。Attempt永不删除，profile/scope/actual attestation、不可变rollout artifact或evaluation permit引用、immutable plan/digest、destination/source exact bases、Host派生的promotion evidence、op states、waiting-approval、terminal/finalized单调持久化。Promotion evidence只能在immutable plan已写且D16 exact preflight成功后create-if-absent；同attempt内重放必须byte-equal，任一identity/digest不等fail-loud。Evaluation authority永不持久化；crash后只有P5重验fixture/permit并为同root新建process authority后才可resume eval attempt。Pending P2 receipts在attempt finalized前不cleanup；finalization先terminal→finalized→applied/duplicate receipt ack→release。Startup先恢复planned/committing/waiting-approval/finalized+occupied，再接新claim；derived op index可从attempt重建。
- 验收：`consolidation-attempt-retained-and-monotonic`、`profile-and-attestation-before-plan`、`attempt-retains-rollout-or-eval-permit-reference-not-authority`、`promotion-evidence-requires-stored-plan-and-successful-preflight`（T93）、`promotion-evidence-create-if-absent-is-idempotent`、`planned-recovery-never-recalls-model`、`eval-restart-revalidates-permit-and-reissues-root-authority`（T93）、`waiting-approval-survives-restart`、`receipt-pending-until-attempt-finalized`、`crash-after-finalized-before-ack-recovers`、`op-index-rebuilds-from-attempt`、`project-concurrency-cap-rebuilt-on-startup`。

#### `startConsolidationPlanner(cluster,profile,config)` / `attestConsolidationPlanner(run,scope)`
- 拓扑：P4-D18；调用D13–D15与P3 named profile/execution/structured-output APIs。
- 职责：production只使用获`skill-consolidation`授权的named profile；shadow可生成audit plan但不mutate。P5 eval-only adapter可以exact named scope + `EvaluationConsolidationAuthority`代替尚未签发的该capability，但不能代替profile resolution或actual attestation。Planner使用complete consolidation prompt、runtime-context suppression、普通tool空、scoped `structured_output`恰好一次；input仅为D14 bounded cluster的exact bundles和protection state。Actual attestation在immutable plan前持久化并核对；profile unavailable/mismatch不fallback，零mutation。Prompt要求优先patch existing umbrella、再support file、最后new class-level umbrella，但Host只把exact target和结构规则当authority。
- 验收：`consolidator-uses-authorized-named-profile`、`planner-sees-one-bounded-cluster-not-full-library`、`ordinary-tools-unavailable`、`structured-output-exactly-once`、`actual-attestation-before-plan`、`profile-mismatch-zero-mutation`、`existing-umbrella-preference-scored-not-host-invented`。

#### `SkillConsolidator.runPass(signal)` / `resumeConsolidationAttempt(attemptId)` / `createEvaluationConsolidationAdapter(authority)`
- 拓扑：P4-D19；调用D16–D18与P2 create/patch/promotion/absorption/finalized-ack APIs。
- 职责：D19先实现production `runPass/resumeConsolidationAttempt`，再实现调用同一runtime的eval adapter。Cluster→claim→attested plan→immutable plan→whole preflight后，Host从stored attempt和D16的exact result派生P2 `ConsolidationPromotionEvidence`并先持久化，再按固定forward saga执行：destination create/patch draft/pending；若human approve已使exact destination active则继续，若scope同时获`skill-auto-promotion`与`skill-consolidation`授权，则在每次promotion调用前重读D17 attempt，验证stored evidence与immutable plan、destination/source exact bases及preflight digest byte-equal，再把typed evidence传给P2唯一promotion policy。P2重验destination origin/current与自身policy/permit facts，不读取P4 Store。其他情况写waiting-approval并停止。Destination exact revision active后才逐source调用`absorbSkill`。每个source stale时记录skipped-stale并保持可见，其他source继续；不回滚已active destination。Crash按stored plan/op ids续跑。全部applied/duplicate/skipped-safe后finalize/ack/release。Archived source bundle/lineage不删除，governance可restore。`createEvaluationConsolidationAdapter`只由P5 disposable composition调用，它需要exact eval permit + current-root process authority，其他调用与production runtime相同；adapter dispose后authority失效。
- 验收：`destination-commit-precedes-any-source-archive`（T93）、`destination-not-active-waits-with-all-sources-visible`（T93）、`authorized-agent-destination-uses-p2-promotion-policy`（T91/T93）、`consolidation-promotion-evidence-persists-before-destination-write`（T93）、`consolidation-attempt-revalidated-immediately-before-promotion`（T93）、`p2-remains-independent-of-p4-store`（T93）、`crash-after-evidence-before-destination-reuses-identical-evidence`、`missing-or-mismatched-consolidation-evidence-never-activates`、`manual-destination-resumes-after-governance-approval`、`source-stale-is-kept-visible-and-recorded`、`crash-at-every-write-resumes-same-attempt`、`partial-absorption-never-rolls-back-destination`、`source-bundle-retained-and-restorable`（T93）、`shadow-consolidation-never-mutates`。

P5 的 `skill-consolidation` stratum 只在 disposable eval composition 中以exact `EvaluationConsolidationPermit` + root-bound `EvaluationConsolidationAuthority` 替代尚未签发的 rollout capability；cluster、planner attestation、whole preflight、destination mutation、P2 promotion policy及其独立 permit/authority、absorption、receipt 与 attempt finalization 均走同一 D14–D19 路径。Production P4b 不解析任何 eval authority/permit。增补验收：`eval-consolidation-permit-binds-case-scope-cluster-and-plan`、`eval-consolidation-authority-substitutes-rollout-capability-only`、`production-consolidator-rejects-eval-authority-or-permit`（T93）。

#### consolidation assembly + metrics extension
- 拓扑：P4-D20；调用D13–D19并挂入D12 host composition。
- 职责：host级唯一consolidation Store/runner/timer；P4a ready、P2/P3 reconciliation与P5 authorization验证完成后才开放conservative claim。HMR先停新claim，再settle/defer active attempt；metrics追加cluster/plan/admit/destination/absorbed/skipped-stale/waiting-approval/restore，不把cluster count或LLM summary当质量结论。
- 验收：`one-consolidator-per-host`、`not-ready-before-p2-p3-reconciliation`、`hmr-drains-or-durably-defers-attempts`、`metrics-separate-structural-and-quality-facts`、`assembly-profile-or-authorization-error-fails-loud`。

## 7. Phase 出口

T82/T90/T91/T93与附件全部测试、per-file 100% coverage、P2+P3+P4 REAL boot全绿；P4a crash/queue/write/HMR证明batch resume不重复、oversized不head-block、fault延后negative lifecycle且不阻止正信号；P4b在每个durable write注入crash，证明destination-first、waiting approval、partial absorption、source stale与restore。Keyless snapshot覆盖provider meta重放、PTC non-load、late/oversized/corrupt outcome、bounded cluster、umbrella/support-file destination、auto/manual destination和source restore；README/Agent Note说明load非quality、lifecycle与semantic consolidation分离、Host不证明semantic preservation、无物理清理与non-Git cwd限制；持久字段变化更新snapshot与双SDK expected outputs（若投影对应字段）。
