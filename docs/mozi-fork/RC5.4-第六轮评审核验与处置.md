# 第六轮评审核验与处置（RC5.3 纠错建议 → RC5.4 修订依据）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 评审对象：`RC5.3-第六轮纠错完善建议.md`（外部第六轮，12 S1 + 7 S2，评审对象为 RC5.3 全套）
>
> 核验方法：源码引用逐条对照本仓库（fork = upstream `cd5ef81` 零漂移）；S1-8..S1-11 为 RC5.3 文档内部矛盾，按方案/附件原文核对成立
>
> 总结论：**12 S1 全部证实**（S1-6 接线细节、S1-4 补充约束按本仓库实际修正后采纳）；7 S2 全部采纳（S2-4 处置细化）。本轮四条最有价值：Service 重名注册抛错与 domain `already-open` 坐实"谁唯一拥有 service/domain"未答；durable `tool/result` 无 canonical value 使 P4 归属规格不可实现；attemptId 公式存在 preclaim 时序矛盾；active patch 绕过治理面。P0/P1 不受影响可先行；P2/P3 前出 RC5.4
>
> 日期：2026-08-29

## 1. S1 逐项核验

### S1-1 Memory 不能同插件挂两实例 — 证实

- 证据：`Service` 构造器立即 `ctx.reflect.provide(name, self, …)`（`vendor/cordis/src/service.ts:37-53`）；`provide` 对同 isolation key 重复注册抛 `service "x" has been registered at <fiber>`（`vendor/cordis/src/reflect.ts:272-285`）；isolation key `ctx.root[symbols.isolate][name]` 全进程按服务名共享——`ctx.memory` 同名第二实例必炸。
- 处置：单一 `MemoryService extends Service`，内部管理 `project` / `user` 两个逻辑 scope；`getState(scope)` / `applyOps(scope)` 现有签名天然适配。P1 的"组合配方"改写为"单实例多 scope"。

### S1-2 双 Publisher 互相顶替 snapshot — 证实（随 S1-1 消解）

- 证据：`ContextForm 'snapshot'` = "a later snapshot from the same producer supersedes an earlier one"（`llm/src/message.ts:52`）；producer 身份 = `MessageSource.kind`，两 publisher 同用 `kind:'memory'` 即互相当成上一版。
- 处置：一个 composite `MemoryPublisher`，一次发布一条消息携带 project/user 两个 `ContextSnapshotSection`，combined digest 做变更检测；P1 只启 project section，L2 加 user section 不新增 producer。

### S1-3 共享 domain 的 Service 推迟到 P3 过晚 — 证实

- 证据：`DomainFacility` "enforces single-open per domain name"，重复 open 抛 `already-open`（`storage-domain/src/index.ts:66-95`）；RC5.3-P2 的 providerPlugin（host）与 authoringPlugin（preset）各自构造 Store 即各自 open `dsh.skill-managed` → 必炸。
- 处置（落法比评审建议更进一步，见 §3-4）：P2 包定形为 `packages/skill/skill-managed`：default export Service（唯一 domain owner，同时拥有 Store/Provider/AuthoringCore），named export `skill_manage` 工具插件（preset overlay，经 Service 消费）；P3 的"抽出"步骤取消，session-review 直接成为第三消费者。

### S1-4 ProjectKey 不能靠复刻 findProjectRoot — 证实

- 证据：`ctx.fs.resolve()` 契约 "the same file yields the same `targetKey`"，local backend normalizes + realpaths（`fs/fs/src/index.ts:100-118`）；`FsTargetKey` 是 Branded 且 "Consumers MUST NOT parse it"（`fs/fs/src/types.ts:8-15`）；findProjectRoot 是 lexical 上行查找，无别名稳定性。
- 处置：`ProjectRootPath = findProjectRoot(cwd)`；`ProjectKey = hash((await ctx.fs.resolve(ProjectRootPath)).targetKey)`——只 hash 整键做身份，不解析不拼路径；Memory project scope 复用同一 resolver。remote backend 的 resolve 语义进 E0 结案。

### S1-5 list() 的 frontmatter 可被外部篡改直入模型可见 catalog — 证实

- 证据：tool-skill 每个 pre-step 从 `ctx.skills.snapshot()` 取 name/description 写入 durable catalog 消息（`tool-skill/src/index.ts:219-250`）——`get()` 的 digest+scan 之前，篡改的 description 已进模型。
- 处置：authoring commit 时把可信 `catalogSummary{name,description,whenToUse?,invocation}` 写进 `ManagedSkillRecord`；`list()` 只读 sidecar（不读 bundle，即 S2-2）；`get()` 才读 exact revision + 整 bundle digest + 扫描。原则 #8 措辞升级："untrusted until **every model-visible read boundary** is verified, including catalog summary"。

### S1-6 P4 从 durable `tool/result` 读 provider 不可实现 — 证实

- 证据：live `tools/result` 是 "frozen, lossless-JSON final outcome"（`core/tools/src/index.ts:193-198`，派发 `:1662-1665`，按 `exec.agent` scope-filtered、listener 故障被容器化）；tool-skill 无 `presentationMeta`（全文件零命中）；durable surface 可提取字段仅 `exec.name`/`isError`/`source.kind`（P0 T15 在案）——provider 不在 durable 载荷里。
- 处置：usage observer 改监听 live `ctx.on('tools/result', …)`（emit、host 层收全量），判据 `exec.name==='skill' && !result.isError && result.value?.provider === MANAGED_SKILL_PROVIDER_NAME`；语义改为"进程内存活期观测"（HMR dispose 后丢数，best-effort 不变）；不为 telemetry 给 tool-skill 加 persistence fork-diff。`ToolExecutionResult.value` 精确形状进 E0；T41 改名 `skill-live-result-provider-attribution`。

### S1-7 NameIndex 首次 reserve 缺 missing-key 初始化 — 证实

- 证据：`update` 对缺失 key 抛 `missing-key`（`domain.ts`，T24 已钉）；RC5.3-P2 `reserveName` 规格只写"单 update RMW"，未含 ensure——首项目首技能必抛。
- 处置：`ensureNameIndex(projectKey)`（get→缺则 `put(emptyIndex)`→`update`）；并发首 reserve 由域内串行化保证恰一成功；补"全新 project 首次 reserve"与并发 first-reserve 测试（并入 T37/T49）。

### S1-8 reject → archived 造成名称死锁 — 证实

- 证据：RC5.3-P3 "reject = 状态 CAS 归档 draft"，而 NameIndex 永久保留名称、create 同名 `name_conflict`、patch 仅 draft|active、治理无 reopen——reject 后该名称永久不可再用。
- 处置：状态机增 `rejected`：`draft → rejected`（用户拒绝）；`rejected → draft`（显式 reopen，仅用户治理）；`archived` 专属"曾 active 后生命周期归档"。NameIndex 确定性身份不变。curator 永不自动迁移 rejected/draft（S2-5）。

### S1-9 active patch 直切 currentRevision 绕过治理 — 证实

- 证据：RC5.3-P2 允许 `patchDraft` 作用于 `draft|active` 且写后立即 `currentRevision=n+1`；`skill_manage` 是模型可调用工具——新技能要 approve，已 active 的技能却被模型/后台直接改 instructions，治理不对称。
- 处置：active patch 写新 revision 后只记 `pendingRevision{revision,digest}`，`currentRevision` 保持旧值；approve → CAS 切 pointer 并清 pending；reject-pending → 清 pending（该 revision 计 orphan）。draft patch 仍直接推进 currentRevision（本就不可见）。L2 autonomous 走同一 pending→approve→pointer 路径，policy 可自动 approve。

### S1-10 attemptId 公式存在 preclaim 时序矛盾 — 证实

- 证据：RC5.3 方案 §1 `attemptId = hash(RangeId, attemptNo, baseStateDigest)`，而 `claim()` 在读取 base state 之前就要把 `{attemptId}` 写入 cursor inFlight——循环依赖。
- 处置：`attemptId = hash(rangeId, attemptNo)`；`attemptNo` 由 cursor durable 分配（claim 时 +1）；`baseStateDigest` 降为 `ReviewAttempt` 记录字段，claim 后回填。stale replan、crash retry、plan 不可变语义全部保持。

### S1-11 consolidation "skip memory mutation" 与 whole-plan admission 矛盾 — 证实

- 证据：RC5.3-P3 一边"任一 proposal 不过 admission → 整 plan 不 commit"，一边"`budget_exceeded` → …仍失败 skip memory mutation"——混合 plan（memory+skill op）语义不明。
- 处置：`budget_exceeded` → zero commit；consolidation = 生成**新 attempt**（attemptNo+1）重新走 whole-plan admission；仍失败 → 整 attempt terminal、零 commit。组级独立 admission 留给未来显式 `operationGroups[]`。

### S1-12 receipt 保留策略仍是 JSDoc 非协议 — 证实

- 证据：静态 `receiptWindowSize=N` 无法证明非 terminal 旧 attempt 的 op receipt 不被 FIFO 淘汰；storageDomain 无跨 record 事务，retention 正确性必须显式编码。
- 处置：receipt 二分——`pendingReceipts`（non-terminal attempt 的 op，**永不 FIFO 淘汰**）+ `recentTerminalReceipts`（terminal 后经 `acknowledgeTerminalOps(opIds)` 迁入的有界环，仅此区可 GC）。orchestrator 在 attempt 达 terminal（含 failed/cancelled-with-plan）时 ack；ack 缺失 = 过量保留（安全方向），ack 早于 terminal = 违约（fail-loud）。

## 2. S2 逐项核验

| 编号 | 结论 | 核验要点 | RC5.4 处置 |
|---|---|---|---|
| S2-1 | 采纳 | 正式 lookup 传 `scope: exec.agent`（`tool-skill/src/index.ts:133`）；`checkNameConflict(name, projectKey)` 漏 scoped winner | 签名改 `AuthoringContext { cwd, scope?: Agent }`，create/promote 重查都传真实 agent |
| S2-2 | 采纳 | 随 S1-5 sidecar catalogSummary | `list()` = storage only；`get()` = filesystem exact revision + digest + scan；catalog trust 与 body trust 分层（reconcile 审计仍读 bundle，不属 list 路径） |
| S2-3 | 采纳 | memory source 是 fork 新增 kind，schema 现在定形零成本 | `CompositeMemorySnapshot { kind:'memory', form:'snapshot', sections, scopes:{ project?, user? }, digest }`；P1 只填 project；L2 不换 producer 协议 |
| S2-4 | 采纳（处置细化） | L1 ReviewPlan 已有 `target:'user'` 但 user store L2 才启用 | 双保险：L1 的 ReviewInput/persona 声明启用 scope（不邀请 user proposal）+ admission backstop 命中 `target:'user'` → 记录 + zero commit + `target_scope_disabled`，不静默 drop、不降级写 project（细化理由见 §3-1） |
| S2-5 | 采纳 | 随 S1-8 | `rejected`/`draft` 不进 curator 自动状态机；仅 reopen（用户）与曾 active 的 stale/archive 走自动迁移 |
| S2-6 | 采纳（本方措辞错误） | RC5.3-P0 T36 写 "human 胜？"——registry 真相是最近层恒胜，与人/managed 无关 | T36 钉死：global human + scoped managed → **scoped managed 胜**；scoped human + global managed → scoped human 胜；同层 → 低 rank 胜。shipped 组合"人工恒胜"由挂载位置（host/global）达成，由 REAL 枚举测试钉，不由 rank 宣称 |
| S2-7 | 采纳 | 与仓库既则 "Publish state only at its commit point" 同构 | 新增第一原则 #9：**Visibility is a separate commit**——写入完成 ≠ 模型可见；经 authority/policy gate 后 host 才切换模型可见状态（memory：mutation → 下一 pre-step 发布；skill：revision 写入 → approval → pointer activation） |

## 3. 不符合实际或需修正的建议

- **S2-4 处置细化**：只加 admission backstop 会让 L1 每个 user-target 误投 proposal 炸掉整 plan（zero commit 全体）。细化：L1 在 ReviewInput 与 persona 层声明启用 scope = project，planner 不被邀请投 user proposal；backstop 仅作 fail-loud 兜底，命中即整 plan zero commit + `target_scope_disabled` 记录。
- **S1-6 接线细节**：`tools/result` 是 emit 模式且按 `exec.agent` scope-filtered，host 层监听收全量、listener 故障被容器化（`:193-198,1662-1665`）；评审样例的 `result.value?.provider` 字段名按 E0 结案钉（`ToolExecutionResult` 精确形状）。usage 语义从"读会话日志"改为"进程内存活期观测"需在 Known Limitations 声明：插件未挂载/卸载期间的载入不计。
- **S1-4 补充约束**：`FsTargetKey` branded 且禁止解析（`fs/fs/src/types.ts:10-11`）——ProjectKey 只允许 `hash(targetKey)` 整键身份，不得截取/拼接/落路径；reviewer 的 `cwd-realpath-alias` 测试由 `project-key-uses-fs-target-identity` 取代。
- **S1-3 落法更进一步**：不是"Service 提前到 P2、P3 再搬 provider"——直接把 P2 包定形 `packages/skill/skill-managed`（default export Service + named export 工具插件），P3 的抽出步骤整体取消。比评审方案少一次包间搬迁，Service 从第一天就有两个消费者（provider、工具）。
- **S1-9 边界钉死**：评审表述隐含但未写明——draft patch 仍直接推进 currentRevision（不可见面，无治理需求）；`pendingRevision` 只约束 active 态。落规格时显式分开。
- **S1-12 安全方向**：ack 协议的不变量是"ack 缺失 = 过量保留（安全），ack 早于 terminal = 违约（fail-loud）"；terminal 集合含 committed/failed/failed-terminal/cancelled-with-plan，planning 阶段取消无 receipts 无需 ack。

## 4. RC5.4 修订落点

- 评审"优先整改顺序"10 项全部接受，映射：1→P2（包定形 skill-managed）、2→P1、3→P1+P2（同一 resolver）、4→P2、5→P2、6→P4、7→P3、8→P2、9→P3、10→P1+P3。
- 原则 #9（Visibility is a separate commit）入方案 §0.1；原则 #8 措辞升级（S1-5）。
- 包清单变更：`packages/skill/tool-skill-manage` → `packages/skill/skill-managed`；`skill-authoring` 包取消（Service 在 P2 一步到位）；P3 规模相应缩减。
- 数据模型变更：`ManagedSkillRecord` 增 `catalogSummary` 与 `pendingRevision?`；状态机增 `rejected`（reopen 仅用户治理）；`ReviewAttempt.attemptId = hash(rangeId, attemptNo)`、`baseStateDigest` 降字段；`MemoryState.appliedOps` 二分 pending/recentTerminal。
- P0 新增 T42–T53（12 项）：`memory-service-single-registration`、`memory-composite-snapshot-no-cross-scope-churn`、`managed-domain-opened-exactly-once`、`project-key-uses-fs-target-identity`、`managed-catalog-sidecar-not-file-trust`、`skill-live-result-provider-attribution`、`name-index-first-record-initialization`、`rejected-draft-can-be-reopened`、`active-patch-stays-pending-until-approve`、`attempt-id-does-not-require-preclaim-base-state`、`consolidation-failure-keeps-whole-attempt-zero-commit`、`nonterminal-op-receipt-never-evicted`；T36 期望值改写（S2-6）；T41 改名并改 live 事件（S1-6）。活跃测试 41 → 53。
- E0 新增：`ToolExecutionResult.value` 精确形状（live 归属判据）；remote/filesystem backend 下 `ctx.fs.resolve().targetKey` 语义。

## 5. 最终判断

评审的四问（谁唯一拥有 service/domain；identity 何时产生；写入与可见是否同一 commit；live 与 durable 事件各携带什么）全部成立，且与仓库既有规则同构（single-open domain、publish-at-commit-point、fail-closed durable surface）。RC5.4 后方案核心结构（LLM proposes; Host commits、Managed Provider、immutable revisions、Cursor/Ledger、durable snapshot）不动；剩余风险收敛为协议细节。第六轮未发现任何需要推翻 RC5.3 主轴的结论。
