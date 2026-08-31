# RC5.5 函数级规格总纲（TDD）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 上位文档：`自我进化机制-RC5.5-方案.md`；本总纲 + 五份附件把方案落到**类名 / 函数名 / 签名 / 调用关系 / 验收标准**级，按 TDD 实施
>
> 附件索引：`RC5.5-附件P0-evidence-lock.md`、`RC5.5-附件P1-memory.md`、`RC5.5-附件P2-skill-managed.md`、`RC5.5-附件P3-session-review.md`、`RC5.5-附件P4-curator.md`（P5 rollout 无独立代码面，见本文件 §8）
>
> 第七轮评审处置：`RC5.5-第七轮评审核验与处置.md`（6 项全部证实；RC5.5 = 增量补丁：ack 分组幂等、effectiveThrough 持久化、ManagedSkillRef、op-derived RevisionId + 完成标记、可见谱系 active|stale、pending 四字段）
>
> 第八轮评审处置：`RC5.5.1-第八轮评审核验与处置.md`（6 项全部证实；RC5.5.1 = 开工补丁：SkillAppliedOps 对称 receipt、NameReservation op-aware 占位、deriveOpId 纯派生、applied-only ack 输入、markTerminal(disposition)/markFinalized finalization 协议、仅 consumed 可 advance。阶段裁定 = **Architecture Frozen / Implementation Approved**：P0/P1 即刻，P2 先红 T62/T64/T65，P3 finalization path 前置 T66–T68，停发 RC5.6 式套件）
>
> RC5.5.2 开工前修补（2026-08-30，无评审轮）：P1 ack 措辞对齐第八轮 S1-4、P3 恢复 Config 表（新 §7）、P2 补 `transitionManagedSkill` 规格、P0 计数更正（68 项 = 66 活跃 + 2 历史回归）、`pinned` L1 无产生点、命名残留清理（方案 §0.0.2）
>
> 日期：2026-08-29（RC5.5.1 增补 2026-08-30；RC5.5.2 修补 2026-08-30）

## 1. 全局约定

- **包形态**：函数插件命名导出 `name`/`inject`/`Config`/`apply` 无 default export；携带 Service 的包 default export 服务类（`packages/AGENTS.md`）；Service 经 `super(ctx, key)` 注册（基类 `vendor/cordis/src/service.ts:37-53`——**同名服务同 isolation key 重复注册抛错，故每个共享资源唯一 owner**）。
- **唯一所有权**：一个 domain 名恰有一个 opener（`storage-domain/src/index.ts:66-95` `already-open`）；`skill-managed` Service 是 `dsh.skill-managed` 域的唯一 opener 与写通道；memory Service 是 memory 域唯一 opener。
- **Provider 形态**：实现 registry `SkillProvider` 契约（`skill/src/index.ts:248-268`）并通过 `validateCandidate` 全套校验（provider 字段一致 `:734-736`、`SKILL_NAME` `:20`、`source` string、rank 数值）；list/get 响应 `options.signal`。
- **身份规则**：`ProjectKey = hash(ctx.fs.resolve(root).targetKey)`（键 branded 禁解析，`fs/fs/src/types.ts:8-15`）；`SkillId = hash(ProjectKey, normalizedName)`；`OpId = hash(attemptId, resourceKind, stableOpIndex, canonicalOpDigest)`（`deriveOpId` 纯派生，模型不提供 opId，重放同 id——第八轮 S1-3/T62/T63）；`ManagedRevisionId = hash(skillId, requestedByOpId)`；`ReviewRangeId`/`ReviewAttemptId = hash(rangeId, attemptNo)`——全部纯函数可推导，不解析不拼路径。
- **定位传递**：一切 Store/Authoring/治理 API 走 `ManagedSkillRef{projectKey, skillId}`，禁止裸传 `SkillId`（单向 hash 无法反推 projectKey，第七轮 S1-1）；projectKey 由 Service 入口从 `cwd/scope`（`AuthoringContext`）解析，解析中间值不做公共类型。
- **finalization 规则**（第八轮 S1-5/S1-6）：`markTerminal(status, rangeDisposition)` → ack **applied-only** receipts（输入 = `opStates`，非 plan）→ `advance(effectiveThrough)` 仅 `disposition === 'consumed'`（单调 `max` guard）→ `markFinalized`；recovery 只重放 `terminal && !finalized`。首版 crash model = process crash + restart，不断言断电/内核崩溃级保证。
- **命名**：跨边界 id branded（`Branded<B>`）；错误类 `*Error` 带 machine-readable `code`；领域记录 zod、插件 Config schemastery（字段全带 JSDoc，无静默默认）。
- **纯函数优先**：折叠/预算/投影/状态机/digest/transition 全纯，I/O 只在壳层；纯函数不得生成 id/时钟。
- **storageDomain 契约**：`update(key,fn)` 缺 key 抛 `missing-key`（`domain.ts`，T24）；`put` 是覆盖写、无 compare-and-put——初始化协议 = get→缺则 put→update，占位/竞态一律单 record `update` RMW。
- **TDD 纪律**：先红后绿；验收即测试名清单；边界值与拒绝路径必测。

## 2. 包与类清单（全量）

| 包（新） | 类 / 顶级构件 | 职责 | Phase |
|---|---|---|---|
| `packages/util/content-scan` | `scanContent()` + `_PATTERNS` + `PATTERN_SET_VERSION` | 纯函数威胁扫描，severity 三档；语料化测试 | P1 |
| `packages/memory/memory` | **单一** `MemoryService extends Service`（`getState(scope)`/`applyOps(scope)`/`acknowledgeTerminalOps(scopeGroups)`）；composite `MemoryPublisher`；`foldMemoryOps`/`enforceBudget`/`splitReceipts`/`sanitizeForPublication`/`buildSnapshotSections`/`computeSnapshotDigest` | 双逻辑 scope 权威状态 + receipt 二分保留 + 分组幂等 ack + sanitize→render→digest 发布（fail-open） | P1 |
| `packages/skill/skill-managed` | **`ManagedSkillService extends Service`**（唯一 domain owner：ManagedSkillStore/NameIndex/ManagedSkillProvider/AuthoringCore + `MANAGED_SKILL_PROVIDER_NAME` 常量）；named export `skill_manage` 工具插件 | agent 自治技能：`ManagedSkillRef` 定位、storage-only catalog（visible = active|stale）、locator 钉 revision/digest、op-derived revision + 完成标记、`SkillAppliedOps` 对称 receipt + `NameReservation` op-aware 占位、`acknowledgeTerminalOps`、pendingRevision 四字段治理、rejected/reopen、配额 | P2 |
| `packages/review/session-review` | `ReviewRuntime`；`ReviewCursorStore`（attemptNo 分配 + resumable + 单调 advance）；`ReviewLedgerStore`（RangeId/AttemptId append-only；`ReviewOpState` + markTerminal(disposition)/markFinalized）；`deriveOpId` + LearningView 纯函数组；`ReviewPlanSchema`；治理命令 | 触发/settlement/两阶段 planner/admission+saga/finalization 协议（applied-only ack + disposition-gated advance）/治理双语义 approve | P3 |
| `packages/skill/skill-curator` | `SkillCurator`；`SkillUsageObserver`（live `tools/result`）；`transition()`（active 谱系）；`aggregateOutcomes()` | 生命周期（时间锚点）+ 精确归属 usage + 遥测 | P4 |

**fork-diff 台账**（对上游包的修改仅此一处，PR 逐行说明）：`packages/session-query/tool-session-query` 模型面默认附加 `{kind:'parent', values:[null]}`（`session-query/src/types.ts:198`）+ `includeChildSessions` 逃生参数；`ctx.sessionQuery` 服务能力不改。

## 3. 跨包调用图

```text
memory.MemoryService（唯一 memory 域 opener）
  ├─ applyOps(scope, ops, expectedBase, {ackRequired?}) ── storageDomain RMW（opId = deriveOpId）
  │     └─ receipts：pendingReceipts（non-terminal 永不淘汰）/ recentTerminalReceipts（有界环）
  ├─ acknowledgeTerminalOps(scopeGroups) ◄── session-review finalization（applied-only opStates，S1-4；幂等三分，S1-5）
  └─ MemoryPublisher（pre-step，fail-open）
        └─ sanitize → buildSnapshotSections（project[+user] 节）→ combined digest
        → CompositeMemorySnapshot 发布
skill-managed.ManagedSkillService（唯一 dsh.skill-managed 域 opener；provider 注册 global 层）
  ├─ ManagedSkillProvider.list/get ◄── ctx.skills registry（options.cwd/signal/scope 借用）
  │     ├─ list：sidecar catalogSummary（storage only；visible = active|stale；损坏 → complete:false）
  │     └─ get：projectKey 校验 → exact revision → bundleDigest → 读边界重扫
  │             → definition（summary 取 candidate 冻结字段、content 取 locator.revision，S1-4）
  ├─ AuthoringCore（create/patch/promote/activate/reject/reopen/acknowledgeTerminalOps/配额/reconcile）
  │     ├─ create：receipt 查重 → NameReservation(same-op resume / 异 op conflict) → 完成标记 bundle → CAS+receipt
  │     └─ patch：SkillAppliedOps 查重（对称 receipt）→ pending 互斥 → 全量重写 + 完成标记 → CAS+receipt
  └─ skill_manage 工具插件（authoring preset；create-draft|patch-draft，无治理动作）
session-review.ReviewRuntime
  ├─ ReviewCursorStore（claim 分配 attemptNo；resumable settlement；advance 单调 max-guard）
  ├─ ReviewLedgerStore（ReviewOpState 落账；markTerminal(status, disposition)；markFinalized）
  │     └─ recover：重放 terminal && !finalized —— ack applied-only receipts
  │             → advance(effectiveThrough) 仅 disposition=consumed → 清 inFlight → markFinalized
  ├─ ctx.subagents.start(config.reviewProvider ?? 'spawn', {…})   [两阶段 patch]
  ├─ ctx.memory.applyOps / acknowledgeTerminalOps（memory 分组）
  └─ ManagedSkillService.commitPlanOps / acknowledgeTerminalOps（skill 按 ref 分组）/ transitionManagedSkill
session-review.governance（宿主命令：list/show/approve/reject/reopen）
  └─ approve 双语义：draft→active；active pending→四字段 CAS（全重验）
skill-curator.SkillCurator（runMaintenance）
  ├─ SkillUsageObserver ◄── ctx.on('tools/result')（live；provider 精确归属）
  └─ ManagedSkillService.transitionManagedSkill（唯一写通道；规格见附件 P2 §3）
```

## 4. 阶段函数索引

| 阶段 | 附件 | 规模 | 核心交付 |
|---|---|---|---|
| P0 | 附件P0 | 68 项（66 活跃 + 2 历史回归）+ Hermes 锚点 | 行为事实钉死（含第七轮 T54–T61、第八轮 T62–T68）+ E0 结案 |
| P1 | 附件P1 | 1 Service + 1 Publisher + 12 函数 + content-scan | 双 scope 幂等 + receipt 二分/分组幂等 ack + composite 发布 |
| P2 | 附件P2 | 1 Service（含 Provider/Store/AuthoringCore）+ 12 函数 + 1 工具 | skill-managed 一步到位：ManagedSkillRef + op-derived revision/完成标记 + visible=active\|stale + pending 四字段 + rejected/reopen + 配额 |
| P3 | 附件P3 | 3 类 + 15 函数 | ReviewRuntime 全链（attempt 简化/consolidation 新 attempt/scope backstop/effectiveThrough + terminal-recovery）+ 治理双语义 + session-query 默认过滤 |
| P4 | 附件P4 | 2 类 + 4 函数 | active 谱系状态机 + live usage 归属 |
| P5 | 本文件 §8 | 指标 gate | L0→L2 + operational/quality 两拆 |

## 5. 每函数规格格式（附件遵循）

```text
#### `函数名(参数: 类型): 返回类型`
- 职责：一句话。
- 调用：被 X 调用；调用 Y/Z。
- 输入/输出：参数语义、不变式、错误码。
- 验收：`test 名`（断言要点）——全部列出，缺一不算完成。
```

## 6. 错误码总表（`*Error.code`；`duplicate_op` 不是错误——是 `ApplyOpStatus`）

| 错误码 | 抛出点 | 语义 |
|---|---|---|
| `budget_exceeded` | memory fold / authoring 配额 preflight / 快照渲染 | 超硬预算或配额上限；拒绝并附现库存与整合建议 |
| `stale_base_revision` | memory applyOps / record CAS / authoring | base revision/digest 不匹配；reject/replan（新 attempt） |
| `name_conflict_with_human_source` | authoring checkNameConflict | 人工来源同名（P0 安全不变式） |
| `name_conflict` | authoring reserveName | 同名 managed 记录已存在（create 应转 patch/reopen；与 human 冲突码分列） |
| `invalid_structure` | authoring validateStructure / reconcile | frontmatter/字节上限/路径越界/binary/symlink/pointer 指缺失 revision；revision 完成标记在而 bundle digest 与计划不符（异物路径，S1-2 修正一） |
| `pending_pending_conflict` | authoring patchDraft | active 记录已有未决 `pendingRevision` 时再 patch（先治理 approve/reject，第七轮 S1-4） |
| `threat_scan_blocked` | scanContent 消费方 | 命中高危模式（写入闸 + 读边界闸共用） |
| `unadmissible_evidence` | session-review admissibility | span 不存在 / kind 放行规则不满足 |
| `planner_terminal_failure` | session-review gateResult | stopReason ≠ completed 或 structured 缺失/不合法 |
| `target_scope_disabled` | session-review admission backstop | L1 命中 `target:'user'`（记录 + 整 plan zero commit；不静默不降级） |
| `missing-key` / `version-mismatch` / `already-open` | storageDomain/既有错误**原样透传** | 首录未初始化 / 版本不匹配 / 域重复打开（唯一所有权违约即刻暴露） |

## 7. E0 证据待锁项（已随 P0 Evidence Lock 全部结案，2026-08-31）

逐项结论由 `packages/review/session-review/tests/evidence-lock/` 实测钉死（用例号 = 附件P0 矩阵行）；全部与 RC5.4/RC5.5 假设一致，无需修订任何签名。

1. **已结案（T07/T20/T24/T44）**：`KvTable` 读 API = `get(key): V | undefined`（内存快照同步读）、`put(key, value): Promise<void>`（insert-or-overwrite，无 compare-and-put）、`update(key, fn): Promise<V>`（写链单穿串行原子 RMW；缺 key 抛 `DomainError 'missing-key'`）、`delete(key): Promise<boolean>`；初始化协议 = get→缺则 put→update；重开 version 不符抛 `version-mismatch`，域名双开抛 `already-open`（同 facility DomainError，跨 facility 裸 Error）。
2. **已结案（compaction-basic / goal-round-driver 先例，T16/T21 佐证）**：模块面声明 `Config` 接口 + schemastery `Config` schema；Service 构造器内 `resolveConfig(config)` 解析校验（`compaction-basic/src/index.ts:126-129`），再由 Service 注册 `ctx.on('agent/pre-step', async ({agent, messages, turn, step, signal}, next) => PreStepDecision)`（`compaction-basic:147`、`goal-round-driver:349`）；misconfig 在 load 时 fail-loud（`jobs/src/index.ts:66`）。
3. **已结案（T03/T12/T31）**：`SubagentStopReason` 本 build 恰五成员 `'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'`（merge-extensible，host typecheck 拒错拼）；`SubagentResult = { output, stopReason, diagnostic?, structured? }`——`structured` 仅 schema 满足的 capture 存在，否则 absent 且 stopReason 落 `'error'`；`dispose()` 幂等且使 in-flight result 以 `'aborted'` 结算。
4. **已结案（T22）**：`ctx.on('session/event', (session, event) => …)` 在事件已提交后投递（回调内 `session.events` 已含该 seq）、seq 单调、loop 事件序 `turn/start → step/start → step/end → turn/end`，`turn/end` 携 `{turn, reason:{kind}}` 并收口 durable log。
5. **已结案（`packages/util/brand/src/index.ts`）**：`dsh-brand` 唯一导出 `export type Branded<B extends string>`（纯类型，零运行时）；具体 id 工厂归属主包（`SessionId` dsh-session、`ToolCallId` dsh-llm、`JobId` dsh-jobs、`FsTargetKey`/`FsVersion` dsh-fs），包内 plain cast 构造。
6. **已结案（T16/T21 + `agent/src/runtime-types.ts:56-62,238`）**：`PreStepDecision = { kind:'reject' } | { kind:'enter', messages: UserMessage[], startsRequestSeries?: true }`；waterfall payload = `{ agent, messages, turn, step, signal }`；base enter 在 claimed 消息上追加 projected context（`agent-loop/src/agent.ts:243-247`）；监听可 await 延迟整步或 reject（无模型请求，turn 以 reject 收口）。
7. **已结案（T45 + `skill-filesystem/src/index.ts:937-947`）**：`findProjectRoot(cwd, fs)` 逐级上溯找最近 `.git` 祖先，候选路径全部经挂载 FileSystem 的 `fs.resolve` 探测（`pathExistsInFileSystem`），到根未中回落 cwd；组合调用序 = `findProjectRoot(cwd, ctx.fs)` → `ctx.fs.resolve(projectRoot).targetKey` → sha256 整键 → ProjectKey。
8. **已结案（T26/T34）**：`control.invalidate()` 即刻 bump revision、清缓存 catalog、恰发一次 `skills/change`——下一次 `list()`/`get()` 即见新状态；provider dispose 后 invalidate 变惰性（无通知）；`get` 与调用方 signal 竞速，不配合的 provider 无法挂死加载。
9. **已结案（T42 + tool-goal/acp 先例）**：跨层注入 = 工具面包模块导出 `export const name` / `export const inject: string[]`（`tool-goal/src/index.ts:22-23` `inject = ['agents','goals','tools','systemPrompt']`）+ Config schema + `export function apply(ctx, config)`；loader 将 host 层 Service 名解析进 apply 作用域，apply 期间捕获实例、回调内不惰性取（`acp/src/index.ts:61,97-98`）；skill-managed 照此 `inject:['skillManaged']`；Service 同名重复注册在注册时抛错即暴露（T42）。
10. **已结案（T16/T34/T61 + `skill/src/index.ts:56-77`）**：`SkillSummary = { name, description, whenToUse?, invocation, source, provider, resourceBase? }`，candidate 增 `rank/locator/path?/metadata?`（`metadata` 为 provider 侧 frontmatter 解析产物，非 SkillSummary 成员、永不模型可见）；模型可见 catalog 行恰 `{name, description}`（description 定长截断，`tool-skill:40,50-56`）；sidecar `catalogSummary` 取 candidate 全字段集（P2 附件 ：66），`whenToUse` 为其中 typed 可选成员；managed frontmatter 具体字段集仍由 P2 `validateStructure` 钉。
11. **已结案（T15/T41）**：live `tools/result` 监听签名 `(exec, result)`，`exec` 冻结、每调用恰一条；归属判据字段路径 = `result.value?.provider`（`value` 为胜出工具返回值，skill 工具返回值携带 `provider`；stock 人工 provider 名为 `'filesystem'`）；durable `tool/result` 事件 data 恰 `{turn, step, message, error?, meta?}`——无 name/value/provider，exec 身份仅经 `tool/call` callId 配对恢复，`isError` 在 content block 上。
12. **已结案（T45，约束照旧）**：仅 local backend 的 `targetKey` 语义已证——别名/符号链接同根 → 同 key（最近祖先 realpath 身份，尚不存在的文件亦然），异文件异 key；远端 backend 身份稳定性仍无证据，**ProjectKey 在其结案前仅支持 local backend，否则 fail-loud**（P2 实施时按此守门）。

## 8. P5 — Rollout 与 effectiveness（两拆）

- L0 Shadow：saga commit 步零 mutation，proposal 全落 ledger；`reviewedThroughSeq` 照常推进（升级 L1 不自动 backfill）。
- **Operational 指标（ledger/usage 可得，`aggregateOutcomes` 纯函数）**：retry/terminal 计数、`review_cancelled_for_foreground`、provider conflict 率、review range lag、review tokens/session、新增 prompt tokens、resume-blocking P95、draft approval/reject/reopen 率、pending activation 率、orphan revision 数与 bytes、memory blocked-on-publish 次数、stale replan 率、crash recovery 成功率、noChange 率、consolidation 成功率、`target_scope_disabled` 命中数。
- **Quality 指标（需 eval harness，无 harness 不得声称已测量）**：proposal precision、false durable memory 率、learned 后人工纠正率、repeated-task success、draft 接受后无用率、post-curation regression、confidence calibration、scope 误分类率（L2）。harness 要求：gold/人工标注样本、before-vs-after 重放、held-out 任务集。
- 升级 gate 人工评审；`confidence` 校准前不参与任何自动授权。
