# RC5.3 附件 P3 — Session review（函数级规格）

> 上位：`RC5.3-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.3-方案.md`（第五轮 S1-8..S1-10、S1-13、S2-3..S2-5）。
>
> 包：`packages/review/session-review`；P3 同时抽出 `packages/skill/skill-authoring` 并落地 session-query 默认过滤（Retrieval Track 前置）。
>
> 前置：P1、P2 全绿。日期：2026-08-29

## 1. 模块布局

```text
packages/review/session-review/
  src/index.ts         # 触发器装配（Config.triggerMode + foreground 抢占 + settlement）
  src/types.ts         # LearningView/ReviewPlan/Cursor/RangeId/AttemptId/错误
  src/learning-view.ts # eventKindAdmissible / projectEvents（turn fold）/ estimateTokens（纯）
  src/plan-schema.ts   # ReviewPlanSchema（zod，含 maxItems/maxStringLength）+ OUTPUT_SCHEMA
  src/cursor.ts        # ReviewCursorStore（claim 含 resumable 结算态）
  src/ledger.ts        # ReviewLedgerStore（RangeId 下挂 append-only attempts）
  src/admissibility.ts # checkEvidenceAdmissibility（纯）
  src/governance.ts    # 治理命令（list/show/approve/reject，宿主命令面）
  src/runtime.ts       # ReviewRuntime
packages/skill/skill-authoring/   # SkillAuthoringService（自 tool-skill-manage 抽出；MANAGED_SKILL_PROVIDER_NAME 常量）
tests/*.spec.ts
```

## 2. 纯函数规格

#### `eventKindAdmissible(event): boolean`
- 职责：只判类型/source。允许：direct-human `user/message`、`tool/call`、`tool/result`（含 error）、`user/message` source `skill-invocation`。排除：`skill-catalog`/`memory`/其余 plugin 合成消息、`assistant/message`（final 由 range fold 推导）、`interrupted:true` 的 step。
- 验收：`kind-admit-human-tool-invocation`、`kind-exclude-synthetic`、`kind-exclude-assistant-deferred-to-fold`。

#### `projectEvents(events, range, config): { view, effectiveThrough, contextOnly? }`
- 职责：raw log 按 `(fromExclusive, throughInclusive]` 切片 → oldest-first 连续分片至预算内，`effectiveThrough` = 实际纳入的最后 seq；超出预算的最近尾部作 `contextOnly`（禁止 evidence 引用、不参与 high-water）；turn fold 推导每 turn 的 final assistant outcome（末个未中断 assistant step；`interrupted:true` 排除）。
- 验收：`project-oldest-first-contiguous`（T28 关联）、`project-effective-through-stops-at-budget`、`project-contextonly-not-citable`、`project-turn-fold-final-only`、`project-interrupted-excluded`、`project-compaction-invariant`。

#### `checkEvidenceAdmissibility(plan, events): AdmissibilityReport`
- 职责：每 proposal 的 `evidence[{seq, span?}]`——seq 在 range 内、span 确实存在于该事件文本；`explicit-user` 须引用 direct-human 消息且 extractive 级；`observed-project` 须引用 tool outcome；抽象/归纳自动降级 inference（L1 下转 shadow/draft）。`confidence` 仅遥测。上限：`maxEvidenceRefsPerProposal` / `maxSpanBytes`（S2-5）。
- 验收：`span-present-passes`、`forged-span-rejects`、`abstract-downgraded-to-inference`、`observed-requires-tool-outcome`、`missing-evidence-rejects`、`current-state-not-citable`、`evidence-refs-capped`。

## 3. 存储规格（RangeId / AttemptId，S1-9）

#### `deriveRangeId(sessionId, from, through, policyVersion, learningViewVersion): ReviewRangeId`
- 职责：纯函数；`hash(sessionId, fromExclusive, throughInclusive, policyVersion, learningViewVersion)`——range 身份，replan 不变。

#### `deriveAttemptId(rangeId, attemptNo, baseStateDigest): ReviewAttemptId`
- 职责：纯函数；attempt 身份——每次 replan/重试产生新 attempt，plan 永不可变。

#### `class ReviewCursorStore`
- `claim(sessionId, desiredThrough): Promise<ClaimResult>` — 单原子 `update`：`desiredThroughSeq = max(old, incoming)`；`inFlight` 缺席 → 置入 `{attemptId, status:'running'}` 返回 `{kind:'acquired', range}`；`inFlight.status === 'resumable'` → 返回 `{kind:'resume', attemptId, range}`（续 stored plan，不重问模型，T39）；在飞 running → `{kind:'busy', inFlight}`（busy 不 spawn）；无 due → `{kind:'nothing-due'}`。
- `advance(attemptId, effectiveThrough)` — 只推进实审连续区间；`settleRunning(attemptId, 'cancelled'|'committed'|'failed')` — **同进程 settlement**（S1-8）：planning 阶段取消 → 清 inFlight（不推进 high-water）；planned/committing 取消 → inFlight 改 `status:'resumable'`。
- `recover(sessionId)` — 进程启动时未闭环 inFlight 恢复（启动外的结算走 settleRunning，T39）。
- 验收：`claim-acquired-busy-nothing-due`（T29）、`claim-desired-through-max`、`claim-resume-resumable`、`settle-cancelled-clears-inflight`（T39）、`advance-only-effective-through`、`recover-resumes`。

#### `class ReviewLedgerStore`
- `putAttempt(attempt)` — **append-only**（S1-9）：同 attemptId 重复写拒绝；旧 planned attempt 永不覆盖（T40）。
- `markOpState(attemptId, opId, state)` / `markFailed(attemptId, code, {attemptCount, nextRetryAt?})` / `latestValidAttempt(rangeId)` — recovery 取最新有效 attempt。
- planned durable 边界：validated canonical plan 整体随 attempt 持久化（planning 崩溃允许重问模型；planned 之后崩溃**禁止**重问）。
- 验收：`attempt-append-only`（T40）、`planned-boundary-persists-plan`、`recover-from-planned-never-recalls-model`、`recover-from-planning-allows-replan`、`latest-valid-attempt-picked`、`op-state-idempotent-mark`。

## 4. ReviewRuntime（编排）

#### `maybeDispatch(agent)` / `onForegroundTurn(agent)`
- 前者：resume-async / maintenance 派发（fire-and-forget；maintenance 经 `runMaintenance` claim，busy 保留 due；acquired/resume/nothing-due 语义见 cursor）。
- 后者：**foreground 抢占 + settlement**（S1-8）——每 Agent 至多一个后台 review run；新 foreground turn → `run.dispose()`（`types.ts:263-268`）+ 有限等待 acknowledgement，超时立即放行；宿主侧 runReview saga 不随 child 死亡，在其取消路径内调 `settleRunning`：无 durable plan → 清 inFlight；有 → 转 resumable。取消 ≠ 失败：不推进 high-water、不计失败。
- 验收：`async-dispatch-no-mid-turn-append`、`foreground-preempts-background`、`cancel-before-planned-clears-inflight`（T39）、`cancel-after-planned-resumes-stored-plan`（T39）、`same-process-next-turn-not-permanently-busy`（T39）、`foreground-wait-bounded`、`maintenance-busy-keeps-due`。

#### `async ensureReviewThrough(agent, seq): Promise<void>`
`pre-step` 闸体：claim（或 resume）→ runReview → await → `next()`；失败不阻塞用户请求（落 ledger failed）。
- 验收：`blocking-completes-before-first-request`（T30）、`blocking-failure-still-calls-next`。

#### `async runReview(cursor): Promise<void>`（十四步）
- claim/resume → LearningView（连续切片）→ ReviewInput（含 currentMemory/writableSkills 当前状态；state 不可作 evidence 引用）→ 预算启动闸 → `startPlanner`（patch 两阶段：planner-1 选 `patchTarget(skillId)` → host 经 `store.readRevision` 读精确 revision → planner-2 于精确内容上出 replacement；create 门见 §5）→ `gateResult` → admissibility → **whole-plan admission 全有或全无**（任一 proposal 不可 admissible/冲突/超预算/超 plan 上限 → 整 plan 不 commit，原因落 ledger）→ 重读权威状态 stale 检查（失配 → 新 attempt replan，`stale_base_revision` 限次）→ host 分配 opId → **forward-recovering saga commit**（逐资源：memory `applyOps`；skills 经 `SkillAuthoringService`；任何资源失败不回滚已落地资源，recover/reconcile 续完或入显式 conflicted terminal）→ `markOpState` → `advance(effectiveThrough)` → 释放 inFlight。
- 失败分类：proposal 拒绝类（threat/conflict/unadmissible）→ 记录不重试同 plan；`stale_base_revision` → 限次新 attempt replan；`budget_exceeded` → **bounded consolidation**（S2-2：携现库存 + 新提案重规划一次，`maxConsolidationAttempts` 默认 2，仍失败 skip memory mutation）；transient → backoff 重试；foreground 取消 → settlement，不计失败；超限 → `failed-terminal` 需显式 re-review。
- 术语（S1-10）：**whole-plan admission; forward-recovering saga commit**——admission 原子，commit 无跨资源事务（memory=storageDomain record、skill=文件系统）。
- 验收：`saga-happy-path`、`admission-all-or-nothing-no-partial-commit-start`、`memory-committed-skill-write-fails-recovery-finishes`（S1-10）、`skill-committed-ledger-mark-crash-reconciles`、`cross-resource-failure-never-rolls-back-by-guess`、`saga-planned-boundary-recovers-without-model`、`saga-crash-gap-resource-idempotent`、`saga-stale-replan-new-attempt`（T40）、`saga-budget-consolidation-bounded`（S2-2）、`saga-two-phase-patch-uses-exact-content`、`saga-range-never-skips`。

#### `startPlanner(input, config): Promise<SubagentRun>` / `gateResult(result): ReviewPlan`
- `agentOptions` 携 `{ model: config.reviewModel?, maxTokens: config.maxReviewOutputTokens }`；gate：`stopReason==='completed'` + `structured` + `ReviewPlanSchema.parse`。
- plan 硬上限（S2-5，schema + host 双层）：`maxMemoryOpsPerPlan` / `maxSkillOpsPerPlan` / `maxFilesPerSkillProposal` / `maxPlanTextBytes` / `maxEvidenceRefsPerProposal` / `maxSpanBytes`——合法 JSON 也不能带数百 op 进 preflight/ledger。
- persona 不变式（S2-3，snapshot-pinned）："多数会话可以零持久变更；宁 no-op 不弱学习/冗余/会话特定/未验证的学习"——不继承 Hermes skill 侧 action bias（`background_review.py:601-611` 反模式）。
- 验收：`planner-request-shape-pinned`、`output-tokens-wired`、`gate-terminal-zero-mutation`、`plan-ops-capped-schema`、`plan-ops-capped-host`、`persona-noop-invariant-pinned`（snapshot）。

## 5. create 门与治理面

#### create-draft Host gate（S2-4）
- proposal 必带 `candidateSearchSummary` / `whyNoExistingManagedSkillFits` / `classLevelRationale`；admission 断言 planner-1 已见当前 managed summaries（ReviewInput.patchCandidates 完整注入）；`maxNewSkillsPerReview = 1`（Config）。
- 验收：`create-gate-fields-required`、`create-gate-saw-managed-summaries`、`max-new-skills-per-review`。

#### 治理命令（S1-13 修正版；`src/governance.ts`）
- 宿主命令面四动作：`list`（draft 全量）、`show <id>`（diff：base revision vs draft revision）、`approve <id>`、`reject <id>`；locale 字典（`verify-client-ui-i18n`）。
- `approve` → `SkillAuthoringService.promoteDraft` 前全重验：revision / ownership / contentDigest / threat scan / name conflict / 当前 policy——不批准旧快照；`reject` → 状态 CAS 归档 draft。
- 模型工具面无 promote（P2 `tool-has-no-promote-action` 对偶断言）；PendingChange durable store 排 L2。
- 验收：`governance-list-show-drafts`、`governance-approve-revalidates-all`、`governance-approve-stale-base-fails-loud`、`governance-reject-archives`、`governance-absent-from-model-tool-surface`。

## 6. SkillAuthoringService 抽出（P3）

`SkillAuthoringService extends Service`（`super(ctx,'skillAuthoring')`）：承接 AuthoringCore + ManagedSkillStore/Provider，新增 `commitPlanOps(skillOps)` 与 `transitionManagedSkill/markStale/archive/revive`（单 record CAS + invalidate）；导出 `MANAGED_SKILL_PROVIDER_NAME` 常量（P4 usage 归属唯一来源）；tool-skill-manage 与 session-review 为两个 thin consumer。验收：`service-parity-two-consumers`、`tool-thin-after-extraction`、`provider-moved-with-service`。

## 7. session-query 默认过滤（Retrieval Track 前置，上游包 fork 修改）

`tool-session-query` 请求未显式 `includeChildSessions: true` 时默认附加 `{kind:'parent', values:[null]}`（`session-query/src/types.ts:198`）；`ctx.sessionQuery` 服务不改。验收：`tool-default-root-only`、`tool-explicit-optin`、`host-unfiltered`。

## 8. 验收门（Phase 出口）

附件测试全绿 + 100% 覆盖；REAL boot 全链（双 mock 模型：主 agent + review child；含 blocking 顺序、抢占 settlement 恢复、planned-boundary 崩溃恢复、admission 后跨资源失败 saga 续完）；snapshot（child 终请求逐字节、persona、ReviewPlan schema 拒绝文案）；doc-sync + Agent Note + 双 SDK（类型面变更）；Known Limitations：child 继承父 standing prompt 环境（persona/prompt 收窄，非纯净）、治理面为最小宿主命令（PendingChange/富 UI 排 L2）。
