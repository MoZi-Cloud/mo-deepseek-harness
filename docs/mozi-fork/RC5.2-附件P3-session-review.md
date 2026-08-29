# RC5.2 附件 P3 — Session review（函数级规格）

> 上位：`RC5.2-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.2-方案.md`。
>
> 包：`packages/review/session-review`；P3 同时抽出 `packages/skill/skill-authoring` 并落地 session-query 默认过滤（Retrieval Track 前置）。
>
> 前置：P1、P2 全绿。日期：2026-08-29

## 1. 模块布局

```text
packages/review/session-review/
  src/index.ts         # 触发器装配（Config.triggerMode + foreground 抢占）
  src/types.ts         # LearningView/ReviewInput/ReviewPlan/Cursor/Checkpoint/错误
  src/learning-view.ts # eventKindAdmissible / projectEvents（turn fold）/ estimateTokens（纯）
  src/plan-schema.ts   # ReviewPlanSchema（zod）+ OUTPUT_SCHEMA（JSON Schema 常量）
  src/cursor.ts        # ReviewCursorStore
  src/ledger.ts        # ReviewLedgerStore（含 planned 边界持久化）
  src/admissibility.ts # checkEvidenceAdmissibility（纯）
  src/runtime.ts       # ReviewRuntime
packages/skill/skill-authoring/   # SkillAuthoringService（自 tool-skill-manage 抽出）
tests/*.spec.ts
```

## 2. 纯函数规格

#### `eventKindAdmissible(event: SessionEvent): boolean`
- 职责：只判类型/source（单 event 可判定的一切）。允许：direct-human `user/message`、`tool/call`、`tool/result`（含 error）、`user/message` source `skill-invocation`。排除：`skill-catalog`/`memory`/其余 plugin 合成消息、`assistant/message`（final 由 range fold 推导，见下）、`interrupted:true` 的 step。
- 验收：`kind-admit-human-tool-invocation`、`kind-exclude-synthetic`、`kind-exclude-assistant-deferred-to-fold`。

#### `projectEvents(events, range, config): { view: LearningView, effectiveThrough: number, contextOnly?: LearningView }`
- 职责：raw log 按 `(fromExclusive, throughInclusive]` 切片 → **oldest-first 连续分片**至预算内，`effectiveThrough` = 实际纳入的最后 seq；超出预算的最近尾部作为 `contextOnly`（禁止 evidence 引用、不参与 high-water）；**turn fold 推导每 turn 的 final assistant outcome**（`types.ts:262` 无 final 标志：末个未中断 assistant step；`interrupted:true` 排除）。
- 验收：`project-oldest-first-contiguous`（T28 关联）、`project-effective-through-stops-at-budget`、`project-contextonly-not-citable`、`project-turn-fold-final-only`（多 step 工具循环只留末条 outcome）、`project-interrupted-excluded`、`project-compaction-invariant`（T17 关联）。

#### `checkEvidenceAdmissibility(plan, events): AdmissibilityReport`
- 职责：每 proposal 的 `evidence[{seq, span?}]`——seq 在 range 内、span 子串确实存在于该事件文本；`explicit-user` 须引用 direct-human 消息且内容 extractive 级；`observed-project` 须引用 tool outcome；抽象/归纳自动降级 inference（L1 下转 shadow/draft）。`confidence` 仅遥测。
- 验收：`span-present-passes`、`forged-span-rejects`、`abstract-downgraded-to-inference`、`observed-requires-tool-outcome`、`missing-evidence-rejects`、`current-state-not-citable`。

## 3. 存储规格

#### `class ReviewCursorStore`
- `claim(sessionId, desiredThrough): Promise<ClaimResult>` — 单原子 `update`：`desiredThroughSeq = max(old, incoming)` 永不丢 due；`inFlight` 缺席 → 置入并返回 `{kind:'acquired', range:(reviewedThrough, desiredThrough]}`；在飞 → `{kind:'busy', inFlight}`；无 due → `{kind:'nothing-due'}`。busy caller **不 spawn**（[核验 S1-8]）。
- `advance(reviewId, effectiveThrough)` — 只推进实审连续区间；`completeInFlight(reviewId)`。
- `recover(sessionId)` — 未闭环 inFlight 恢复。
- 验收：`claim-acquired-busy-nothing-due`（T29）、`claim-desired-through-max`、`advance-only-effective-through`、`recover-resumes`。

#### `class ReviewLedgerStore`
- `putCheckpoint(c)` / `markPlanned(reviewId, plan, planDigest, baseRevisions)` — **planned durable 边界**：validated canonical plan 整体持久化（[核验 S1-9]）；`markOpState` / `markFailed(code, {attemptCount, nextRetryAt?})`。
- 验收：`planned-boundary-persists-plan`、`recover-from-planned-never-recalls-model`、`recover-from-planning-allows-replan`、`op-state-idempotent-mark`。

## 4. ReviewRuntime（编排）

#### `maybeDispatch(agent)` / `onForegroundTurn(agent)`
- 前者：resume-async / maintenance 派发（fire-and-forget；maintenance 经 `runMaintenance` claim，busy 保留 due）。
- 后者：**foreground 抢占**——每 Agent 至多一个后台 review run；新 foreground turn 开始时 `run.dispose()` 并有限等待 acknowledgement，超时立即放行；取消 ≠ 失败：cursor inFlight 保留、之后 recover 重放安全（[核验 S2-5]；`SubagentRun.dispose`，`types.ts:289`）。
- 验收：`async-dispatch-no-mid-turn-append`、`foreground-preempts-background`、`cancellation-preserves-cursor`、`maintenance-busy-keeps-due`。

#### `async ensureReviewThrough(agent, seq): Promise<void>`
`pre-step` 闸体：claim → runReview → await → `next()`；失败不阻塞用户请求（落 ledger failed）。
- 验收：`blocking-completes-before-first-request`（T30）、`blocking-failure-still-calls-next`。

#### `async runReview(cursor): Promise<void>`（十三步 + 修订）
- claim → LearningView（连续切片，effectiveThrough）→ ReviewInput（**含 currentMemory/writableSkills 当前状态**；state 不可作 evidence 引用）→ 预算启动闸 → `startPlanner`（patch 走**两阶段**：planner-1 选 `patchTarget(skillId)` → host 经 provider 读精确 revision bundle → planner-2 于精确内容上出 replacement——[核验 S1-10]）→ `gateResult` → admissibility → **whole-plan preflight 全有或全无**（任一 proposal 不可 admissible/冲突/超预算 → 整 plan 不 commit，原因落 ledger，[核验 S1-11]）→ 重读权威状态 stale 检查 → host 分配 opId → 逐资源 commit（memory `applyOps`；skills 经 `SkillAuthoringService`）→ `markOpState` → `advance(effectiveThrough)` → 释放 inFlight。

失败分类（[核验 S2-7]）：proposal 拒绝类（threat/conflict/unadmissible）→ 记录不重试同 plan；`stale_base_revision` → 限次 replan（Config）；transient → backoff 重试；foreground 取消 → 不计失败；超限 → `failed-terminal` 需显式 re-review。
- 验收：`saga-happy-path`、`saga-whole-plan-preflight-no-partial`、`saga-planned-boundary-recovers-without-model`、`saga-crash-gap-resource-idempotent`、`saga-stale-replan-bounded`、`saga-two-phase-patch-uses-exact-content`、`saga-range-never-skips`。

#### `startPlanner(input, config): Promise<SubagentRun>` / `gateResult(result): ReviewPlan`
`agentOptions` 携带 `{ model: config.reviewModel?, maxTokens: config.maxReviewOutputTokens }`（[核验 S2-8] 真接线）；`maxReviewTotalTokens` 由 usage 累计超限 `run.dispose()`。gate：`stopReason==='completed'` + `structured` + `ReviewPlanSchema.parse`（[核验 S1-9]）。
- 验收：`planner-request-shape-pinned`、`output-tokens-wired`、`gate-terminal-zero-mutation`。

## 5. SkillAuthoringService 抽出（P3）

`SkillAuthoringService extends Service`（`super(ctx,'skillAuthoring')`）：承接 AuthoringCore + ManagedSkillProvider，新增 `commitPlanOps(skillOps)` 与 `transitionManagedSkill/markStale/archive/revive`（单 record CAS + invalidate，[核验 S1-14]）；tool-skill-manage 与 session-review 为两个 thin consumer。验收：`service-parity-two-consumers`、`tool-thin-after-extraction`、`provider-moved-with-service`。

## 6. session-query 默认过滤（Retrieval Track 前置，上游包 fork 修改）

`tool-session-query` 请求未显式 `includeChildSessions: true` 时默认附加 `{kind:'parent', values:[null]}`（`session-query/src/types.ts:198`）；`ctx.sessionQuery` 服务不改。验收：`tool-default-root-only`、`tool-explicit-optin`、`host-unfiltered`。

## 7. 验收门（Phase 出口）

附件测试全绿 + 100% 覆盖；REAL boot 全链（双 mock 模型：主 agent + review child；含 blocking 顺序、抢占恢复、planned-boundary 崩溃恢复）；snapshot（child 终请求逐字节、persona、ReviewPlan schema 拒绝文案）；doc-sync + Agent Note + 双 SDK（如类型面变更）；Known Limitations：child 继承父 standing prompt 环境（persona/prompt 收窄，非纯净）。
