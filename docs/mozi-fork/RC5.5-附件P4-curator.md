# RC5.5.3 附件 P4 — Skill curator、usage coverage 与可恢复 lifecycle（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；前置：P2、P3；包：`packages/skill/skill-curator`；日期：2026-09-01。
>
> P4 不把“技能定义加载成功”写成“任务成功”。它分存 model load、用户显式调用、patch 与 Host 结构可验的 reuse outcome；正信号即使 coverage 不完整也可使 stale 回 active，但“窗口内零活动”只能在完整覆盖时触发 stale/archive。archived 不可见，只能由 P3 人类治理调 P2 governance restore。
>
> 当前 `SkillInvocationSource` 只持久化 name/form，不能在重启后区分同名人工 provider 与 managed provider；model tool 的 execution-local value 虽含 provider，却从 durable tool/result 删除。现有 `output.presentationMeta` 会与 top-level tool/result 同条持久化，并明确不为 nested composite call 生成；后者的结果不直接进入模型请求，不能计作 model load。P4 的第一个叶节点因此为 user source 和 top-level result meta 补 winning provider；没有这两项前不实现 usage 归属。

## 1. 模块布局

```text
src/types.ts          # signal/coverage/usage/config/report types
src/config.ts         # Config resolve/validation
src/signals.ts        # classify/fold/verified-reuse pure helpers
src/coverage.ts       # coverage epoch/gap/heartbeat pure helpers
src/state-machine.ts  # decideLifecycleTransition
src/store.ts          # durable usage/coverage store
src/observer.ts       # live + durable event observation
src/curator.ts        # maintenance pass
src/metrics.ts        # operational aggregation
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
FinalizedOutcomeScanCheckpoint = {afterOrdinal?:FinalizedOutcomeOrdinal}
SessionUsageScanCheckpoint = {sessionId,afterSeq?}
CoverageDecision = complete | incomplete
LifecycleDecision = {to:'active'|'stale'|'archived',reason,at} | undefined
CuratorConfig = {staleAfterDays,archiveAfterDays,zeroUseGraceDays,
                 intervalHours,minIdleHours,coverageHeartbeatMinutes,coverageStaleMinutes,
                 signalReceiptWindowSize,outcomePageSize,maxSignalsPerOutcome,sessionEventPageSize}
SkillInvocationSource = {kind:'skill-invocation',name,provider,form:'instructions'}
SkillLoadPresentationMeta = {kind:'skill-load',name,provider,renderedContentDigest}
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
| P4-D06 | `decideLifecycleTransition` | D02–D04 |
| P4-D07 | `SkillUsageStore` | D02–D04、storage domain |
| P4-D08 | `SkillUsageObserver` + source reconciliation | D03–D05、D07、P2 typed events/lineage/list/provider identity、P3 ordinal outcome pages、durable session events |
| P4-D09 | `SkillCurator.runPass` | D06–D07、P2 transition/list APIs |
| P4-D10 | `aggregateOutcomes` | D02、P3 ledger/P4 store read APIs |
| P4-D11 | package assembly | D07–D10 |

D01 先于 user-invocation classifier，D06 先于 curator，D07 先于 observer；observer 不得自行迁移 skill，curator 不得从“没有 record”推导零使用。

## 4. 纯函数与 coverage

#### durable invocation provider 与 skill-load result meta
- 拓扑：P4-D01。
- 职责：`SkillInvocationSource` 增加 required `provider:string`；`tool-skill` 在 `ctx.skills.get(name)` 成功且 user-invocable 后，把该 loaded `SkillDefinition.provider` 原样写入 source。model tool 的 `output.presentationMeta(args,value)` 从 validated canonical value 生成 exact name/provider，并对 canonical `renderSkillContent(value)` 计算 digest；top-level final tool/result 会同条持久化 meta。P4 只在 `name='skill'`、`isError=false`、meta name 与 durable call arguments 相同且 persisted content digest 与 meta 相同时承认 load；post-execute content replacement因此不会误计。Nested PTC sub-dispatch 没有 presentationMeta，且其 dispatch log 不直接进入模型请求，明确不计 model load。不从 name 事后猜 provider，不把 provider 渲染到 model-facing skill body。P4 在 durable 读边界验证 provider/name/digest；旧的无 provider source/meta 标记 unattributable并造成 coverage gap，不默认归给 managed，也不拒绝整个历史会话。meta projector 失败按现有 tools 语义把调用变成 error，不产生一个“模型已见内容但 durable identity 缺失”的成功结果。
- 验收：`user-invocation-source-records-winning-provider`、`human-and-managed-same-name-source-distinguishes-provider`、`provider-metadata-survives-session-replay`、`provider-not-rendered-as-model-instruction`、`top-level-skill-result-persists-provider-and-content-digest`、`post-execute-content-replacement-is-not-counted-as-load`、`meta-name-must-match-durable-call-arguments`、`ptc-skill-subdispatch-is-not-model-load`、`presentation-meta-failure-produces-tool-error`、`legacy-source-without-provider-marks-gap-and-is-not-attributed`。

#### `validateCuratorConfig(config): ResolvedCuratorConfig`
- 拓扑：P4-D02。
- 职责：所有 duration 为 finite 正数；`coverageStaleMinutes > coverageHeartbeatMinutes`；`archiveAfterDays >= staleAfterDays`；四个容量字段为正 safe integer，且 `signalReceiptWindowSize >= max(outcomePageSize × maxSignalsPerOutcome, sessionEventPageSize)`。该值是 crash-before-checkpoint 时单个 skill 最坏需要吸收的一页 outcome 或 durable session signal；不允许 implementation-only 默认缩小窗口。参数在 schema/README 显式默认或 required，不在 `runPass` 内隐式补默认。
- 验收：`curator-config-valid-exact-boundaries`、`coverage-stale-must-exceed-heartbeat`、`archive-window-not-shorter-than-stale-window`、`nonfinite-duration-fails-load`、`outcome-capacities-must-be-positive-safe-integers`、`signal-receipt-window-covers-whole-outcome-page`。

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
- 职责：按 finalized outcome 的 durable session/turn/event coordinates 回读 exact top-level skill tool/result 与 validated meta；只在 exact root session 中 managed load 之后、同一 completed turn 内有可定位 tool-success 或 failure-recovered，且该 turn 无 later unresolved 时产生结构 `verified-reuse`。不依赖可能已淘汰的 usage receipt 或 aggregate 中的最后时间；assistant 自述、turn completed 单独、transient/unknown 不产生。该信号仍是 Host 可观察 reuse outcome，不声称技能对语义成功具有因果。
- 验收：`load-then-tool-success-derives-structural-reuse`、`failure-recovered-derives-reuse`、`later-unresolved-blocks-verified-reuse`、`assistant-success-claim-never-derives-reuse`、`cross-session-or-turn-outcome-never-correlates`。

#### `decideLifecycleTransition(record,usage,coverage,now,config): LifecycleDecision`
- 拓扑：P4-D06。
- 职责：draft/rejected/archived 与 pinned 返回 undefined；active 的 activity anchor 为 promotion/current-revision activation 与四类 usage 时间的 max，再经 D04 得到 covered inactivity anchor，窗口满足才 active→stale。没有 usage record 不能单独解释为 zero；但从 `max(promotion,completeSince)` 起 heartbeat 连续覆盖完整窗口后，可保守认定该窗口零观测。stale 出现 later model-load/user invocation/activated patch/verified-reuse 均 stale→active；stale→archived 同样从 `max(staleAt,all activity,completeSince)` 计算完整窗口。archived→active 在本函数不可达。
- 验收：`active-stale-after-covered-inactivity`、`never-used-requires-full-window-after-coverage-start`、`missing-usage-without-coverage-is-unknown`、`zero-use-grace-window`、`stale-model-load-reactivates`（T82）、`stale-explicit-use-reactivates`、`stale-verified-reuse-reactivates`、`archive-window-resets-on-any-observed-load`、`observer-gap-restarts-stale-and-archive-window`（T82）、`archived-never-auto-reactivates`（T82）、`pinned-never-transitions`、`boundary-exact`。

## 5. Store、observer 与 curator

#### `class SkillUsageStore`
- 拓扑：P4-D07。
- 职责：唯一 usage domain opener；按 ProjectKey+SkillId 一个 RMW 先查 bounded session/outcome receipt 或 revisionStates，再 fold signal，去重状态与 aggregate 同笔写；coverage、`FinalizedOutcomeScanCheckpoint` 与 per-session `SessionUsageScanCheckpoint` 使用独立 host records RMW；提供 `getUsage/listUsage/getCoverage/recordSignal/heartbeat/markGap/getOutcomeCheckpoint/advanceOutcomeCheckpoint/getSessionCheckpoint/advanceSessionCheckpoint`，不暴露 table。outcome checkpoint 只在整项的全部 signal 成功，或明确无匹配 load后推进到该项 ordinal；session checkpoint 只在同一 durable event 成功或明确无关后推进到 seq。两类 checkpoint 页尾均不回绕。observer 每次启动先重放各 checkpoint 后第一未结算页，结算前禁止另一 source commit 淘汰这些 receipt；窗口容量证明保证 crash 后整页重放仍去重。未存在 usage record 是 unknown，只有 D06 结合完整 covered window才可解释该窗口零观测。
- 验收：`usage-record-first-write`、`signal-identity-idempotent-within-unsettled-page`、`signal-receipt-ring-bounded-after-checkpoint`、`two-projects-isolate`、`coverage-rmw-monotonic`、`missing-usage-is-unknown`、`session-checkpoint-advances-after-whole-event-settlement`、`outcome-checkpoint-advances-after-whole-item-settlement-only`、`outcome-checkpoint-never-rewinds-or-cycles`、`crash-replays-whole-page-without-double-count`、`service-opens-domain-once`。

#### `class SkillUsageObserver`
- 拓扑：P4-D08。
- 职责：host 层监听 `session/event`/durable flush 只唤醒按 session seq 的 scanner；scanner 处理 top-level skill result meta 与 `skill-invocation`，不绕过 D07 session checkpoint直接 fold。P2 typed revision-committed/activated 可低延迟入队，但 startup/maintenance 必须从 P2 immutable lineage/current pointers 补扫并由 revisionStates 吸收重复，从而覆盖 CAS 后、event 前崩溃。另由 maintenance `reconcileFinalizedOutcomes` 先显式调 P3 `reconcileFinalizedOutcomeIndex`，成功后才从 D07 `afterOrdinal` 调无写入的 paged `listFinalizedOutcomeSignals`；D05 按 outcome coordinates 回读 durable load meta。每项产生的 signal 超 `maxSignalsPerOutcome` 时不截断、不推进，记 coverage gap并 fail-loud 诊断。每个 session/outcome page 从首个 signal RMW 到 checkpoint advance 持有同一 host source-settlement mutex，其他 source 只缓冲，不能在 crash window 内淘汰该页 receipt。启动时先注册并缓冲 listener，再完成 P2 revision、session page 与 outcome-index/page reconciliation后才开放普通 queue commit；因此 late finalized outcome 不会漏，任一 durable source 的 crash 重放也不会重复计数。listener 不向 tool/turn/skill CAS 抛错，但 queue overflow、write failure、dispose 丢弃未完成项都必须 `markGap`。heartbeat 只在 listeners、三个 reconciliation source、queue/store 都健康时更新。
- 验收：`count-successful-managed-provider-load-only`（T41）、`stale-load-is-recorded-before-transition`、`durable-result-and-invocation-listeners-only-wake-session-scanner`、`durable-model-load-replays-on-restart`、`durable-user-invocation-replays-on-restart`、`session-event-crash-before-checkpoint-deduplicates-whole-page`、`revision-committed-and-activated-remain-distinct`、`crash-after-revision-cas-before-event-reconciles-from-lineage`、`revision-rescan-does-not-double-count`、`late-finalized-outcome-rereads-durable-load-meta-by-coordinate`、`late-finalized-outcome-discovered-by-ordinal-poll`、`outcome-scan-crash-replay-deduplicates-whole-page`、`late-finalized-outcome-always-appends-after-checkpoint`、`too-many-signals-does-not-truncate-or-advance`、`source-settlement-mutex-prevents-receipt-eviction-before-checkpoint`、`startup-reconciles-all-sources-before-live-commits`、`listener-never-breaks-tool-result-or-skill-cas`、`queue-overflow-marks-coverage-gap`、`write-failure-marks-coverage-gap`、`dispose-stops-observation-and-closes-epoch`、`hmr-does-not-double-listen`。

#### `class SkillCurator`
- 拓扑：P4-D09。
- `runPass(signal)`：在 host maintenance claim 内列 P2 agent-owned managed records → 读 D07 usage/coverage → D06 decision → 调 `ManagedSkillService.transitionManagedSkill(actor:'curator')` → 记录 report。它只可 active↔stale/stale→archived，不得调 governance restore；busy 保留 due，abort 不产生半条 lifecycle write。
- 验收：`pass-managed-agent-owned-only`、`pass-archives-never-deletes`、`pass-never-restores-archived`（T82）、`pass-gap-defers-negative-transition`、`pass-positive-signal-reactivates-stale`、`pass-idempotent-rerun`、`pass-busy-retried`、`pass-abort-no-half-transition`、`pinned-service-gate-unbypassable`。

#### `aggregateOutcomes(range): EffectivenessReport`
- 拓扑：P4-D10。
- 职责：纯聚合 operational 指标：proposal/commit/duplicate/reject/error-code、retry/manual/range lag/tokens/noChange、approve/reject/restore、model-load/user-invocation/patch/verified-reuse 分布、coverage gap duration、stale/archive transition、orphan/bytes/pending。输出分开 load 与 verified reuse，不生成 P5 quality 结论。
- 验收：`aggregate-matches-ledgers`、`aggregate-empty-zeros`、`aggregate-deterministic`、`aggregate-load-and-verified-reuse-separate`、`aggregate-no-quality-claims`。

#### package assembly
- 拓扑：P4-D11。
- 职责：host 级唯一 Store/Observer/Curator；Service ready 且三类 startup reconciliation 完成后才 heartbeat；effects 先停止接收新 source、结算或明确 gap，再注销 listener/timer/queue；只有全部排空并持久化 checkpoints 后可把 epoch 写 closed，未能排空则保持 open 并 mark gap。
- 验收：`host-assembly-single-observer`、`not-covered-before-ready`、`hmr-disposes-listeners-timers-and-queue`、`assembly-misconfiguration-fails-load`。

## 6. Phase 出口

T82 与附件全部测试、per-file 100% coverage、P2+P3+P4 REAL boot 全绿；crash/queue/write/HMR 故障注入证明 gap 延后 stale/archive；keyless snapshot 覆盖 source provider/result meta 重放、top-level load、PTC non-load、同名人工/managed 分离、explicit invocation、late outcome reuse、stale model load 恢复与 archive 后只有 governance restore 再可见；README/Agent Note 说明 load 非 quality、coverage 的保守性、无物理清理与 non-Git cwd 限制；`SkillInvocationSource` 持久字段和 tool-result meta 变化同 Phase 更新 keyless snapshot 与双 SDK expected outputs（若 SDK 投影对应字段）。
