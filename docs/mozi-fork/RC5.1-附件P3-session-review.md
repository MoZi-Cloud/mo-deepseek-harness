# RC5.1 附件 P3 — Session review（函数级规格）

> 上位：`RC5.1-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.1-方案.md` §4/§5.1–5.4。
>
> 包：`packages/review/session-review`（`@deepseek-ai/dsh-session-review`）；P3 同时抽出 `packages/skill/skill-authoring`（`SkillAuthoringService`，thin 化 tool-skill-manage）并落地 session-query 检索默认过滤（独立 Retrieval Track 前置）。
>
> 前置：P1、P2 全绿。日期：2026-08-29

## 1. 模块布局

```text
packages/review/session-review/
  src/index.ts        # 函数插件：触发器装配（Config.triggerMode）
  src/types.ts        # LearningView/ReviewInput/ReviewPlan/ReviewCursor/错误类型
  src/learning-view.ts# 纯函数：eventAdmissible/projectEvents/estimateTokens
  src/plan-schema.ts  # ReviewPlanSchema（zod）+ OUTPUT_SCHEMA（JSON Schema 常量）
  src/cursor.ts       # ReviewCursorStore（storageDomain 原子 claim/advance）
  src/ledger.ts       # ReviewLedgerStore（checkpoint/opStates）
  src/admissibility.ts# 纯函数：checkEvidenceAdmissibility
  src/runtime.ts      # ReviewRuntime（编排）
tests/*.spec.ts
```

## 2. 类型契约（承 RC5.1 §2 数据模型）

`ReviewCursor`、`ReviewInput`、`ReviewPlan`、`ReviewCheckpoint` 形状照方案 §2；`LearningView = { range: {fromExclusive, throughInclusive}, events: ReadonlyArray<SessionEvent>, estTokens }`。

## 3. 纯函数规格

#### `eventAdmissible(event: SessionEvent): boolean`
- 职责：LearningView 证据过滤（确定性、可重放）。允许：direct-human `user/message`（source 非 plugin）、`tool/result`（含 error）、`assistant/message`（仅 final，作 context）、`user/message` source `skill-invocation`（用户手势）。排除：`source.kind==='skill-catalog'`、`'memory'`、compaction 合成面、其余 plugin 注入（[评审 S1-7] feedback 永不入；[核验] synthetic 可按 source 判别）。
- 验收：`admit-human-user-message`、`admit-tool-result-and-error`、`exclude-memory-catalog-synthetic`、`exclude-plugin-injected`、`deterministic-same-input-same-output`。

#### `projectEvents(events, range, config): LearningView`
- 职责：按 `(fromExclusive, throughInclusive]` 切 raw log（seq 稳定，`types.ts:357-366`），`eventAdmissible` 过滤，超 `maxLearningViewTokens` 截窗（保留靠近 through 侧，截窗在投影中显式记录）。
- 验收：`project-range-bounds-respected`、`project-budget-truncates-from-old-side`、`project-compaction-invariant`（同 raw range 在 compaction/resume 前后同投影同 seq——P0 T17 关联）、`project-empty-range-empty-view`。

#### `estimateTokens(view): number`
- 职责：确定性 token/字符估算（启动前预算闸输入）。验收：`estimate-monotone-in-size`、`estimate-deterministic`。

#### `checkEvidenceAdmissibility(plan, events): AdmissibilityReport`
- 职责：原则 7 的 host 端实现——每条 proposal 的 `evidence[]`：seq 存在于 range、`span` 子串确实存在于该事件文本（explicit-user 要求 extractive 级，否则降级 `inference` → L1 下转 shadow/draft）；`observed-project` 须引用 tool outcome。`confidence` 不参与判定（仅透传落 ledger 遥测）。
- 验收：`admissible-span-present-passes`、`forged-span-rejects`（seq 对但 span 不在文本——**核心防伪**）、`abstract-content-downgraded-to-inference`、`observed-requires-tool-outcome`、`missing-evidence-rejects`。

## 4. 存储规格

#### `class ReviewCursorStore`
- `claim(sessionId, desiredThrough): Promise<Claim>` — `storageDomain.update` 原子：无 inFlight 且 `desiredThrough > reviewedThroughSeq` 时置 `inFlight{reviewId, fromExclusive=reviewedThroughSeq, throughInclusive=desiredThrough, status:'planning'}`；已有 inFlight → 返回现有（at-least-once 下并发派发合一）。
- `advance(reviewId, throughInclusive): Promise<void>` — 校验 inFlight 匹配后推进 `reviewedThroughSeq` 并清 inFlight。
- `recover(sessionId)` — 启动时发现未闭环 inFlight → 触发 reconcile（§5 saga 步骤 10-13）。
- 验收：`claim-serializes-overlapping-dues`（T-80..100 与 80..120 归并为单 range 或排队）、`claim-rejects-nonmonotonic`、`advance-advances-high-water`、`policy-version-change-keeps-high-water`、`recover-resumes-unfinished`。

#### `class ReviewLedgerStore`
- `putCheckpoint / getCheckpoint / markOpState(reviewId, opId, state)` — 全经 `storageDomain.update`。
- 验收：`ledger-checkpoint-roundtrip`、`ledger-op-state-idempotent-mark`。

## 5. ReviewRuntime（编排类）

#### `maybeDispatch(agent: Agent): void`
- 职责：resume-async / maintenance 入口（`session/event` 观察 `turn/end` 标 due → 去抖 → `runMaintenance` claim，busy 保留 due；`runtime-types.ts:102-110`）。fire-and-forget；**绝不 mid-turn 碰模型可见历史**（发布只在下一 pre-step，[核验 S2-1]）。
- 验收：`async-dispatch-no-mid-turn-append`、`maintenance-busy-keeps-due`。

#### `async ensureReviewThrough(agent: Agent, seq: number): Promise<void>`
- 职责：resume-blocking 闸体——`agent/pre-step` 内 `claim → runReview → await → next()`（pre-step 为 awaited waterfall，`runtime-types.ts` 'agent/pre-step'）。
- 验收：`blocking-review-completes-before-first-request`、`blocking-failure-still-calls-next`（复盘失败不阻塞用户请求，落 ledger failed）。

#### `async runReview(cursor): Promise<void>`（十三步 saga，方案 §4）
编排：`buildLearningView` → `estimateTokens` 预算闸（超 → `planner_terminal_failure`-类不启动记录）→ `startPlanner` → `gateResult` → `checkEvidenceAdmissibility` → 重读权威状态 + stale 检查 → 分配 opId → commit（memory 经 `ctx.memory.applyOps`；skills 经 `SkillAuthoringService.commitPlanOps`）→ `markOpState` → `advance`。
- 验收：`saga-happy-path-commits-all`、`saga-crash-gap-no-duplicate`（commit 后 ledger 未 mark 重启 → appliedOps/reconciliation 去重）、`saga-skill-reconciliation-paths`（目标缺失执行/digest 相同补账/digest 不同 conflict）、`saga-old-review-cannot-overwrite-new`（游标乱序防护）、`saga-budget-prestart-no-spawn`、`saga-partial-plan-commits-admissible-only`。

#### `startPlanner(input: ReviewInput, config): Promise<SubagentRun>`
- 职责：`ctx.subagents.start(config.reviewProvider ?? 'spawn', { parent, label:'self-review', prompt: render(input), persona: REVIEW_PERSONA, toolFilter:{allow:[]}, outputSchema: OUTPUT_SCHEMA, agentOptions:{ model: config.reviewModel? } })`（契约：`subagent/src/index.ts:552`；spawn `inheritsParentContext=false` :50）。
- 验收：`planner-request-shape-pinned`（request 字段 snapshot——P0 T02/T12 关联）、`planner-route-fallback-default-spawn`。

#### `gateResult(result: SubagentResult): ReviewPlan`
- 职责：`stopReason==='completed'` 且 `structured !== undefined` 且 `ReviewPlanSchema.parse` 通过；否则 `planner_terminal_failure` 落 ledger，零 mutation（`types.ts:236-252`）。
- 验收：`gate-aborted-zero-mutation`、`gate-max-tokens-zero-mutation`、`gate-invalid-structured-zero-mutation`、`gate-valid-parses`。

#### `buildReviewInput(view, memoryState, writableSkills): ReviewInput`
- 职责：拼 Evidence + Current state（严格分区：current state 可用于 dedupe/patch 目标解析，不可作 evidence 引用——admissibility 拒绝引用 current state 的 seq）。
- 验收：`input-carries-current-memory-revision`、`input-current-state-not-citable-as-evidence`、`input-writable-skills-lists-agent-owned-only`。

## 6. 触发装配与 Config

`Config.triggerMode: 'resume-async'（默认）| 'resume-blocking' | 'maintenance'`；`reviewProvider`（默认 'spawn'）、`reviewModel?`、`maxLearningViewTokens/maxReviewTotalTokens/maxReviewOutputTokens`、`debounceMs`、`policyVersion`、`learningViewVersion`、`persona`（静态文本，snapshot 钉死）、`rolloutLevel: 'shadow'|'conservative'|'autonomous'`（默认 'shadow'；shadow 下 saga 第 10 步零 mutation，proposal 全落 ledger）。

## 7. SkillAuthoringService 抽出 + session-query 默认过滤

- `skill-authoring`：`SkillAuthoringService extends Service`（`super(ctx,'skillAuthoring')`）承接 tool-skill-manage 的 AuthoringCore；新增 `commitPlanOps(ops): Promise<OpResults>`（create-draft/patch-draft 批量、逐 op CAS + reconciliation）；tool-skill-manage 改为 thin consumer。验收：`service-two-consumers-parity`（工具与 review 同 API 同错误码）、`tool-thin-after-extraction`。
- `tool-session-query`（上游包 fork 修改）：请求未显式带 `includeChildSessions: true` 时默认附加 `{kind:'parent', values:[null]}`（服务层既有 filter 类型，`session-query/src/types.ts:198`）；Host 层 `ctx.sessionQuery` 不改。验收：`tool-default-root-only`、`tool-explicit-children-optin`、`host-capability-unfiltered`。

## 8. 验收门（Phase 出口）

- 附件全部验收绿 + 100% 覆盖（纯函数为主力；Runtime 以 fake planner/假 subagent 驱动状态机，REAL boot 另测）；
- REAL boot：完整链路（真实 Loader 组合 + mock 模型双角色：主 agent 与 review child）——含 resume-blocking 首请求顺序断言；
- snapshot：review child 终请求快照（P0 T02 产品化复验）、`<assistant-maintained-memory>` 围栏、persona 文本；
- session-query 默认过滤落地 + Retrieval Track 独立文档说明；
- 双 SDK（若有类型面变更）、doc-sync、Agent Note；已知限制登记：planner 继承父 standing prompt 环境（persona+prompt 收窄，[核验 §六]）。
