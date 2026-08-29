# RC5.4 附件 P3 — Session review（函数级规格）

> 上位：`RC5.4-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.4-方案.md`（第六轮 S1-10/S1-11、S2-4、S2-7）。
>
> 包：`packages/review/session-review`；消费 `ManagedSkillService`（第三消费者，零搬迁）与 `MemoryService`（含 ack）。前置：P1、P2 全绿。
>
> 日期：2026-08-29

## 1. 模块布局

```text
packages/review/session-review/
  src/index.ts         # 触发器装配（triggerMode + foreground 抢占 + settlement）
  src/types.ts         # LearningView/ReviewPlan/Cursor/RangeId/AttemptId/错误
  src/learning-view.ts # eventKindAdmissible / projectEvents（turn fold）/ estimateTokens（纯）
  src/plan-schema.ts   # ReviewPlanSchema（zod + maxItems/maxStringLength）+ OUTPUT_SCHEMA
  src/cursor.ts        # ReviewCursorStore（claim 分配 attemptNo；settlement）
  src/ledger.ts        # ReviewLedgerStore（attempts append-only；terminal ack 回调）
  src/admissibility.ts # checkEvidenceAdmissibility（纯）
  src/governance.ts    # 治理命令（list/show/approve/reject/reopen）
  src/runtime.ts       # ReviewRuntime
tests/*.spec.ts
```

## 2. 纯函数规格

#### `eventKindAdmissible(event): boolean`
- 验收：`kind-admit-human-tool-invocation`、`kind-exclude-synthetic`、`kind-exclude-assistant-deferred-to-fold`。

#### `projectEvents(events, range, config): { view, effectiveThrough, contextOnly? }`
- 验收：`project-oldest-first-contiguous`、`project-effective-through-stops-at-budget`、`project-contextonly-not-citable`、`project-turn-fold-final-only`、`project-interrupted-excluded`、`project-compaction-invariant`。

#### `checkEvidenceAdmissibility(plan, events): AdmissibilityReport`
- 职责：seq 在 range、span 存在；`explicit-user` extractive；`observed-project` tool outcome；抽象降级 inference；上限 `maxEvidenceRefsPerProposal`/`maxSpanBytes`。
- 验收：`span-present-passes`、`forged-span-rejects`、`abstract-downgraded-to-inference`、`observed-requires-tool-outcome`、`missing-evidence-rejects`、`current-state-not-citable`、`evidence-refs-capped`。

#### `deriveRangeId(...) / deriveAttemptId(rangeId, attemptNo): ReviewAttemptId`（S1-10）
- 职责：纯；`attemptId = hash(rangeId, attemptNo)`——claim 时即可算出（T50）；`baseStateDigest` 是 attempt 字段、claim 后回填、不参与 id。
- 验收：`attempt-id-derivable-at-claim`（T50）、`attempt-distinct-no-per-attempt-input`。

## 3. 存储规格

#### `class ReviewCursorStore`
- `claim(sessionId, desiredThrough): Promise<ClaimResult>` — 单 RMW：`desiredThroughSeq=max(old,incoming)`；`attemptNo = (上一个 attemptNo ?? 0) + 1` durable 分配；inFlight 缺席 → `{kind:'acquired', attemptId, attemptNo, range}`；resumable → `{kind:'resume', attemptId, range}`；running → busy（不 spawn）；无 due → nothing-due。
- `advance(attemptId, effectiveThrough)` / `settleRunning(attemptId, 'cancelled'|'committed'|'failed')` — settlement：planning 取消清 inFlight；planned/committing 转 resumable（T39 语义不变）。
- `recover(sessionId)` — 启动期恢复；运行期结算走 settleRunning。
- 验收：`claim-acquired-busy-nothing-due`（T29）、`claim-allocates-attempt-no`（T50）、`claim-desired-through-max`、`claim-resume-resumable`、`settle-cancelled-clears-inflight`、`advance-only-effective-through`、`recover-resumes`。

#### `class ReviewLedgerStore`
- `putAttempt(attempt)` — append-only；`baseStateDigest` 在 ReviewInput 构建后回填（`recordBaseState(attemptId, digest)`）。
- `markOpState(attemptId, opId, state)` / `markFailed(attemptId, code, meta)` / `latestValidAttempt(rangeId)` / `markTerminal(attemptId, status)` — terminal 时回调 orchestrator 执行 `memory.acknowledgeTerminalOps(opIds)`（S1-12 闭环）。
- 验收：`attempt-append-only`（T40）、`base-state-digest-postclaim`（T50）、`planned-boundary-persists-plan`、`recover-from-planned-never-recalls-model`、`recover-from-planning-allows-replan`、`latest-valid-attempt-picked`、`terminal-ack-invoked`（T52）。

## 4. ReviewRuntime（编排）

#### `maybeDispatch(agent)` / `onForegroundTurn(agent)`
- 抢占 + settlement 同 RC5.3（T39 语义不变）：planning 取消清 inFlight；planned/committing 转 resumable 续 stored plan。
- 验收：`async-dispatch-no-mid-turn-append`、`foreground-preempts-background`、`cancel-before-planned-clears-inflight`、`cancel-after-planned-resumes-stored-plan`、`same-process-next-turn-not-permanently-busy`、`foreground-wait-bounded`。

#### `async ensureReviewThrough(agent, seq): Promise<void>`
- 验收：`blocking-completes-before-first-request`（T30）、`blocking-failure-still-calls-next`。

#### `async runReview(cursor): Promise<void>`
- claim/resume → LearningView → ReviewInput（**含 `enabledScopes`（L1=`['project']`）与 currentMemory/writableSkills；state 不可作 evidence**）→ `baseStateDigest` 回填 → 预算闸 → `startPlanner`（两阶段 patch；create 门）→ `gateResult` → admissibility → **whole-plan admission**（不可 admissible/冲突/超预算/超 plan 上限/`target:'user'` 命中 L1 backstop → 整 plan zero commit，原因落 ledger）→ stale 重读检查（失配 → 新 attempt replan）→ opId 分配 → **forward-recovering saga commit**（memory `applyOps`；skill 经 ManagedSkillService；失败不回滚）→ `markOpState` → `markTerminal` + `memory.acknowledgeTerminalOps`（S1-12）→ `advance` → 释放 inFlight。
- 失败分类：拒绝类不重试；`stale_base_revision` → 限次新 attempt；**`budget_exceeded` → zero commit → consolidation 生成新 whole attempt 重走 admission（`maxConsolidationAttempts` 默认 2），仍败 terminal 零 commit——skill op 绝不"顺带"提交（S1-11，T51）**；transient backoff；foreground 取消 settlement 不计失败；超限 failed-terminal。
- 验收：`saga-happy-path`、`admission-all-or-nothing-no-partial-commit-start`、`memory-committed-skill-write-fails-recovery-finishes`、`skill-committed-ledger-mark-crash-reconciles`、`cross-resource-failure-never-rolls-back-by-guess`、`saga-planned-boundary-recovers-without-model`、`saga-crash-gap-resource-idempotent`、`saga-stale-replan-new-attempt`、`saga-budget-consolidation-new-whole-attempt`（T51）、`consolidation-failure-keeps-whole-attempt-zero-commit`（T51）、`saga-two-phase-patch-uses-exact-content`、`saga-range-never-skips`、`terminal-acks-memory-receipts`（T52）。

#### `startPlanner(input, config)` / `gateResult(result)`
- `agentOptions` 携 `{model?, maxTokens}`；gate：completed + structured + schema parse；plan 六项硬上限（schema + host 双层）；persona 不变式（no-op 中性 + `enabledScopes` 声明，S2-4 输入侧）。
- 验收：`planner-request-shape-pinned`、`output-tokens-wired`、`gate-terminal-zero-mutation`、`plan-ops-capped-schema`、`plan-ops-capped-host`、`persona-noop-invariant-pinned`、`input-declares-enabled-scopes`（S2-4）。

## 5. 治理命令（`src/governance.ts`；双语义 approve，S1-9）

- `list` — draft + active-pending 全量（含 diff 基准）；`show <id>` — base vs draft / current vs pending。
- `approve <id>` — 双语义：draft → `promoteDraft`；active+pending → `activatePending`；二者全重验（revision/ownership/digest/scan/conflict/policy）后走 Service CAS。
- `reject <id>` — draft → `rejected`；pending → 清除。`reopen <id>` — rejected → draft。全部仅用户治理；模型工具面无治理动作。
- 验收：`governance-list-shows-drafts-and-pending`、`governance-approve-draft-promotes`、`governance-approve-pending-activates`（T49）、`governance-approve-revalidates-all`、`governance-approve-stale-base-fails-loud`、`governance-reject-draft-and-pending`、`governance-reopen-rejected`（T48）、`governance-absent-from-model-tool-surface`。

## 6. user-target backstop（S2-4，T53）

- 输入侧：L1 ReviewInput `enabledScopes=['project']` + persona 声明——planner 不被邀请投 user proposal。
- backstop：admission 命中 `target:'user'`（rollout < L2）→ proposal 落 ledger + **整 plan zero commit** + `target_scope_disabled`；不静默 drop、不降级写 project。
- 验收：`user-target-backstop-l1`（T53）、`user-target-not-invited-at-l1`（输入侧断言）。

## 7. session-query 默认过滤（上游包 fork 修改）

`tool-session-query` 未显式 `includeChildSessions: true` 时默认附加 `{kind:'parent', values:[null]}`；`ctx.sessionQuery` 服务不改。验收：`tool-default-root-only`、`tool-explicit-optin`、`host-unfiltered`。

## 8. 验收门（Phase 出口）

附件测试全绿 + 100% 覆盖；REAL boot 全链（双 mock 模型；blocking 顺序、settlement 恢复、planned 崩溃恢复、跨资源失败 saga 续完、consolidation 新 attempt、治理双语义 approve/reject/reopen）；snapshot（child 终请求逐字节、persona、schema 拒绝文案）；doc-sync + Agent Note + 双 SDK；Known Limitations：child 继承父 standing prompt 环境、治理为最小宿主命令面、L1 不邀请 user proposal。
