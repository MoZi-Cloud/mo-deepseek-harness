# RC5.5 附件 P3 — Session review（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.5-方案.md`（第六轮 S1-10/S1-11、S2-4、S2-7；第七轮 S1-5/S1-6；第八轮 S1-3..S1-6）。
>
> 包：`packages/review/session-review`；消费 `ManagedSkillService`（第三消费者，零搬迁；patch 走 `ManagedSkillRef` + 资源 receipt + ack）与 `MemoryService`（含分组幂等 ack）。前置：P1、P2 全绿。
>
> 相对 RC5.4-P3（第七轮收口）：`effectiveThrough` 随 attempt 持久化；applied-only ack；terminal-recovery。
>
> 相对 RC5.5-P3（第八轮收口）：**opId 分配 = `deriveOpId` 纯派生**（第八轮 S1-3/T62/T63——`OpId = hash(attemptId, resourceKind, stableOpIndex, canonicalOpDigest)`，模型不提供 opId，恢复重放同 op 同 id）；**ack 输入修正**（S1-4/T66）——`opStates` 升格 `ReviewOpState { opId, resource, resourceRef, state: prepared|applied|duplicate|failed }`，ack 只取 `applied|duplicate`（partial-saga / 零 mutation terminal 不再误报 `invalid_structure`）；**finalization 协议**（S1-5/T67）——`terminalAcked` 改名 `finalized`，定序 `markTerminal(status, rangeDisposition) → ack applied receipts（memory + skill）→ advance（仅 consumed，单调 max-guard）→ markFinalized`，recovery 入口 `terminal && !finalized`；**`RangeDisposition`**（S1-6/T68）——consumed 仅 committed/noChange；stale/budget → superseded；拒绝/瞬态/前台取消 → retryable 背退；manual 预留 L2。**骨架与纯函数先行；finalization commit path 前置 T66–T68 三协议**。RC5.5.2 修补：恢复 Config 表（新 §7——RC5.1-P3 §6 的清单按现行机制重组，全套重写时失落；tunables 必须是 validated Config 字段，总纲 §1）；session-query 与验收门顺延为 §8/§9。
>
> 日期：2026-08-29（RC5.5.1 增补 2026-08-30；RC5.5.2 修补 2026-08-30）

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

#### `deriveOpId(attemptId, resourceKind: 'memory'|'skill', stableOpIndex: number, canonicalOpDigest: string): OpId`（第八轮 S1-3，T62/T63）
- 职责：纯；`OpId = hash(attemptId, resourceKind, stableOpIndex, canonicalOpDigest)`——从 immutable attempt + stored plan 纯派生，模型不提供 opId，无持久化分配器；同一 plan 任意次 recovery/resume 同 opId（T62）；payload 变 → opId 变（T63）；两资源 receipt 与 `MemoryEntryId` 的重放稳定性共同 rooted 在此。
- 验收：`op-id-stable-across-planned-recovery`（T62）、`changed-op-payload-changes-op-id`（T63）、`model-supplied-opid-rejected`（T62）。

## 3. 存储规格

#### `class ReviewCursorStore`
- `claim(sessionId, desiredThrough): Promise<ClaimResult>` — 单 RMW：`desiredThroughSeq=max(old,incoming)`；`attemptNo = (上一个 attemptNo ?? 0) + 1` durable 分配；inFlight 缺席 → `{kind:'acquired', attemptId, attemptNo, range}`；resumable → `{kind:'resume', attemptId, range}`；running → busy（不 spawn）；无 due → nothing-due。
- `advance(attemptId, effectiveThrough)` — **单调**：`reviewedThroughSeq = max(old, effectiveThrough)`（第八轮 S1-5：advance-twice-is-noop，T67——crash 于 advance 与 markFinalized 之间时 recovery 可安全重复）；由 `markFinalized` 前的 finalization 序列调用，仅 disposition=consumed。
- `settleRunning(attemptId, 'cancelled'|'committed'|'failed')` — settlement：planning 取消清 inFlight；planned/committing 转 resumable（T39 语义不变）。
- `recover(sessionId)` — 启动期恢复；运行期结算走 settleRunning。
- 验收：`claim-acquired-busy-nothing-due`（T29）、`claim-allocates-attempt-no`（T50）、`claim-desired-through-max`、`claim-resume-resumable`、`settle-cancelled-clears-inflight`、`advance-only-effective-through`、`advance-twice-is-noop`（T67）、`recover-resumes`。

#### `class ReviewLedgerStore`
- `putAttempt(attempt)` — append-only；`baseStateDigest` 在 ReviewInput 构建后回填（`recordBaseState(attemptId, digest)`）；**`effectiveThrough` 在 LearningView 完成后、planner 启动前随 attempt 持久化**（S1-6：terminal-recovery 唯一推进依据，禁止恢复期按当前 budget/projection 配置重算）。
- `markOpState(attemptId, state: ReviewOpState)` — saga 落账（`{ opId, resource: 'memory'|'skill', resourceRef, state: prepared|applied|duplicate|failed }`；ledger 缺席 = not-started，第八轮 S1-4）——Ledger 自此是 saga recovery authority。
- `markFailed(attemptId, code, meta)` / `latestValidAttempt(rangeId)`。
- `markTerminal(attemptId, status, rangeDisposition: consumed|superseded|retryable|manual)` — terminal + 处置落账（第八轮 S1-6/T68）。L1 映射：committed（含 noChange）→ consumed；stale-base/budget → superseded；admission/policy 拒绝、planner 瞬态、前台取消 → retryable（attemptCount/nextRetryAt 背退）；manual 预留 L2。
- `markFinalized(attemptId)` — **本 terminal attempt 全部恢复义务完成的 durable 终点**（第八轮 S1-5/T67）：finalization 序列（ack applied receipts → disposition=consumed 时 advance → 清 inFlight）成功后落账；此后 recovery 不再重放该 attempt。
- finalization ack：orchestrator 从 `opStates` 取 `resource=memory && state ∈ {applied, duplicate}` 按 scope 分组调 `memory.acknowledgeTerminalOps`，`resource=skill` 同规则按 ref 分组调 `skillManaged.acknowledgeTerminalOps`（**applied-only，非 plan 全量**——partial-saga 与零 mutation terminal 不误报 `invalid_structure`，T66）。
- 验收：`attempt-append-only`（T40）、`base-state-digest-postclaim`（T50）、`effective-through-persisted-pre-planner`（T59）、`opstate-review-type-pinned`（T66）、`terminal-disposition-mapping-l1`（T68）、`planned-boundary-persists-plan`、`recover-from-planned-never-recalls-model`、`recover-from-planning-allows-replan`、`latest-valid-attempt-picked`、`terminal-ack-invoked-scoped`（T52/T58）、`terminal-ack-only-applied-opstates`（T66）、`terminal-finalization-is-idempotent`（T67）。

## 4. ReviewRuntime（编排）

#### `maybeDispatch(agent)` / `onForegroundTurn(agent)`
- 抢占 + settlement 同 RC5.3（T39 语义不变）：planning 取消清 inFlight；planned/committing 转 resumable 续 stored plan。
- 验收：`async-dispatch-no-mid-turn-append`、`foreground-preempts-background`、`cancel-before-planned-clears-inflight`、`cancel-after-planned-resumes-stored-plan`、`same-process-next-turn-not-permanently-busy`、`foreground-wait-bounded`。

#### `async ensureReviewThrough(agent, seq): Promise<void>`
- 验收：`blocking-completes-before-first-request`（T30）、`blocking-failure-still-calls-next`。

#### `async runReview(cursor): Promise<void>`
- claim/resume → LearningView → **`effectiveThrough` 随 attempt 持久化（S1-6，planner 前）** → ReviewInput（**含 `enabledScopes`（L1=`['project']`）与 currentMemory/writableSkills；state 不可作 evidence**）→ `baseStateDigest` 回填 → 预算闸 → `startPlanner`（两阶段 patch；create 门）→ `gateResult` → admissibility → **whole-plan admission**（不可 admissible/冲突/超预算/超 plan 上限/plan 内重复触及同一 skillId/`target:'user'` 命中 L1 backstop → 整 plan zero commit，原因落 ledger）→ stale 重读检查（失配 → 新 attempt replan）→ **opId = `deriveOpId(attemptId, resourceKind, stableOpIndex, canonicalOpDigest)`（第八轮 S1-3，模型不提供 opId）** → **forward-recovering saga commit**（memory `applyOps`；skill 经 ManagedSkillService：`ManagedSkillRef` 定位 + receipt 查重 + 完成标记协议，失败不回滚）→ `markOpState`（`ReviewOpState` 落账）→ **finalization 序列（第八轮 S1-5/S1-6）**：`markTerminal(status, rangeDisposition)` → ack applied-only receipts（memory 按 scope 分组 + skill 按 ref 分组，T66）→ `advance(effectiveThrough)` **仅 disposition=consumed**（单调 max-guard）→ `markFinalized` → 释放 inFlight。
- 失败分类：拒绝类不重试（disposition=retryable 背退）；`stale_base_revision` → 限次新 attempt（superseded）；**`budget_exceeded` → zero commit → consolidation 生成新 whole attempt 重走 admission（`maxConsolidationAttempts` 默认 2），仍败 terminal 零 commit——skill op 绝不"顺带"提交（S1-11，T51）**；transient backoff；foreground 取消 settlement 不计失败（retryable）；超限 failed-terminal。
- **terminal-recovery（第八轮 S1-5/S1-6，T66–T68）**：`recover(sessionId)` 先重放全部 `terminal && !finalized` 的 attempt——ack applied-only receipts（幂等）→ disposition=consumed 时 `advance(effectiveThrough)`（单调，重复安全）→ 清 inFlight → `markFinalized`；**superseded/retryable/manual 一律不推进 high-water**——range 由下次触发重 claim（at-least-once，宁重审不跳审；budget consolidation 的 attempt A 在 B 建立前 crash 时 A=superseded，恢复不吞 range，B 语义由重 claim 的新 whole attempt 承接）。完成前不接受新 review mutation。
- 验收：`saga-happy-path`、`admission-all-or-nothing-no-partial-commit-start`、`plan-duplicate-skill-target-zero-commit`、`memory-committed-skill-write-fails-recovery-finishes`、`skill-committed-ledger-mark-crash-reconciles`、`cross-resource-failure-never-rolls-back-by-guess`、`saga-planned-boundary-recovers-without-model`、`saga-crash-gap-resource-idempotent`、`saga-stale-replan-new-attempt`、`saga-budget-consolidation-new-whole-attempt`（T51）、`consolidation-failure-keeps-whole-attempt-zero-commit`（T51）、`saga-two-phase-patch-uses-exact-content`、`saga-range-never-skips`、`terminal-acks-memory-receipts`（T52）、`op-id-stable-across-planned-recovery`（T62）、`terminal-ack-only-applied-opstates`（T66）、`terminal-recovery-replays-unacked`（T58）、`terminal-recovery-advances-persisted-effective-through`（T59）、`terminal-finalization-is-idempotent`（T67）、`terminal-status-does-not-imply-range-consumption`（T68）。

#### `startPlanner(input, config)` / `gateResult(result)`
- `agentOptions` 携 `{model?, maxTokens}`；gate：completed + structured + schema parse；plan 六项硬上限（schema + host 双层）；persona 不变式（no-op 中性 + `enabledScopes` 声明，S2-4 输入侧）。
- 验收：`planner-request-shape-pinned`、`output-tokens-wired`、`gate-terminal-zero-mutation`、`plan-ops-capped-schema`、`plan-ops-capped-host`、`persona-noop-invariant-pinned`、`input-declares-enabled-scopes`（S2-4）。

## 5. 治理命令（`src/governance.ts`；双语义 approve，S1-9）

- `list` — draft + active-pending 全量（含 diff 基准）；`show <id>` — base vs draft / current vs pending。
- `approve <id>` — 双语义：draft → `promoteDraft`；active+pending → `activatePending`（四字段原子切换，S1-4）；二者全重验（revision/ownership/digest/scan/conflict/policy）后走 Service CAS。
- 定位：命令从 session cwd 解析 projectKey + skillId 组 `ManagedSkillRef`（S1-1），不裸传 id。
- `reject <id>` — draft → `rejected`；pending → 清除。`reopen <id>` — rejected → draft。全部仅用户治理；模型工具面无治理动作。
- 验收：`governance-list-shows-drafts-and-pending`、`governance-approve-draft-promotes`、`governance-approve-pending-activates`（T49）、`governance-approve-revalidates-all`、`governance-approve-stale-base-fails-loud`、`governance-reject-draft-and-pending`、`governance-reopen-rejected`（T48）、`governance-absent-from-model-tool-surface`。

## 6. user-target backstop（S2-4，T53）

- 输入侧：L1 ReviewInput `enabledScopes=['project']` + persona 声明——planner 不被邀请投 user proposal。
- backstop：admission 命中 `target:'user'`（rollout < L2）→ proposal 落 ledger + **整 plan zero commit** + `target_scope_disabled`；不静默 drop、不降级写 project。
- 验收：`user-target-backstop-l1`（T53）、`user-target-not-invited-at-l1`（输入侧断言）。

## 7. Config（schemastery）

字段全带 JSDoc；除标注默认者外全部 required（无静默默认，总纲 §1）。plan 硬上限 schema 与 host 双层同源取本表（`startPlanner` 验收 `plan-ops-capped-schema`/`plan-ops-capped-host`）。

| 字段 | 语义 |
|---|---|
| `triggerMode` | `'resume-async'`（默认）\| `'resume-blocking'` \| `'maintenance'`——触发装配入口 |
| `reviewProvider` / `reviewModel?` | 子代理 provider（默认 `'spawn'`）/ 可选模型路由 |
| `maxLearningViewTokens` / `maxReviewOutputTokens` / `maxReviewTotalTokens` | LearningView 预算 / 接线 `agentOptions.maxTokens` / usage 观察累计上限（超限 `run.dispose()`） |
| `debounceMs` | turn/end 去抖 |
| `policyVersion` / `learningViewVersion` | 游标与 RangeId 身份参与者（hash 入参） |
| `persona` | 静态文本（snapshot 钉死；no-op 中性 + `enabledScopes` 声明，S2-4） |
| `rolloutLevel` | `'shadow'`（默认）\| `'conservative'` \| `'autonomous'`——shadow 下 saga commit 步零 mutation、proposal 全落 ledger、high-water 照常推进 |
| `maxConsolidationAttempts` | budget consolidation 新 attempt 上限（默认 2） |
| `maxAttemptsPerRange` / `retryBackoffBaseMs` | retryable 背退上限与基时（超限 failed-terminal） |
| `maxPlanMemoryOps` / `maxPlanSkillOps` / `maxFilesPerSkill` / `maxFileBytes` / `maxEvidenceRefsPerProposal` / `maxSpanBytes` | plan 六项硬上限（schema + host 双层）与证据上限 |

## 8. session-query 默认过滤（上游包 fork 修改）

`tool-session-query` 未显式 `includeChildSessions: true` 时默认附加 `{kind:'parent', values:[null]}`；`ctx.sessionQuery` 服务不改。验收：`tool-default-root-only`、`tool-explicit-optin`、`host-unfiltered`。

## 9. 验收门（Phase 出口）

附件测试全绿 + 100% 覆盖；REAL boot 全链（双 mock 模型；blocking 顺序、settlement 恢复、planned 崩溃恢复、**finalization 链各边界 crash 注入**、跨资源失败 saga 续完、consolidation 新 attempt、治理双语义 approve/reject/reopen）；snapshot（child 终请求逐字节、persona、schema 拒绝文案）；doc-sync + Agent Note + 双 SDK；Known Limitations：child 继承父 standing prompt 环境、治理为最小宿主命令面、L1 不邀请 user proposal、**首版 crash model = Host/process crash + restart（`fs-local/src/fsio.ts:546-594` staged + atomic rename；不断言 power loss / kernel crash / storage 故障下的分布式事务保证）**、manual disposition 在 L1 无产生点。
