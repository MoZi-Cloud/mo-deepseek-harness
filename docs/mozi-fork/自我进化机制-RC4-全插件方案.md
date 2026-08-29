# 自我进化机制方案 RC4（全插件重构版）

> 状态：设计备忘（working document，fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 版本脉络：RC1 = `DSH借鉴hermes-开发记忆提炼-自我进化机制.md`；评审 = `评审报告.md`（9 S1 + 11 S2，全部源码核实）；本 RC4 = 按评审处置 + DSH"一切皆插件"架构法则的重构版
>
> 日期：2026-08-29

**RC4 第一原则**：自我进化的每个能力都是一个完整 Cordis 插件（或完整能力强缝），零 `agent-loop` 改动，全部挂在已核实的扩展点上；每个部署可调值都是经校验的 `Config` 字段；每条进入模型请求的字节都可从会话日志重建。

## 0. 评审处置表（RC1 → RC4）

判定：**采纳** = 按评审处方执行；**修正采纳** = 诊断成立、处方按插件架构改写；**登记** = 显式决策项，动工前定案。

| # | 评审发现 | 判定 | RC4 处置 |
|---|---|---|---|
| S1-1 | session-end 事件不存在；teardown 5 秒强杀子代理 | **采纳** | 触发重构为三宿主形态（§4.1）：长驻宿主 = `turn/end` + 空闲去抖；headless = `turn/end` 后同步 await（app 层接线）；**默认 = next-resume 复盘上一会话**（零竞速、幂等、可去抖） |
| S1-2 | 子代理只能 join 父 preset | **采纳** | 放弃"换 preset"；复盘子代理 = 父组合之子 + `toolFilter.allow` 收窄；前提是基础组合显式装配 memory/skill-manage 工具（§4.2 前提 P1） |
| S1-3 | 白名单摧毁 fork KV-cache | **修正采纳** | 显式选择**冷缓存路线**：toolFilter 窄化 + `agentOptions` 路由廉价模型补成本；热缓存路线（字节一致 + 运行时拒绝）登记为后续可选，不进 RC4 |
| S1-4 | `origin` 是闭联合集 | **采纳** | 溯源用 `agentPreset` 自由字符串（`self-review` 命名约定）+ descriptor label；不动 `origin`（§4.3） |
| S1-5 | 计量内联 frontmatter 五处连环 | **采纳** | 计量 = `ctx.storageDomain` sidecar 账本（现成 KV 底座）；`skill` 加载保持纯读；frontmatter 只留 `created_by` 低频作者字段（§4.5） |
| S1-6 | 所有权/遮蔽治理缺失 | **采纳** | 写侧 Consumer 内建所有权模型：可写 source 白名单 + `created_by` + 新建默认 `draft`（`disable-model-invocation: true`）+ 与 human-review 提案的领地划分（§4.4） |
| S1-7 | feedback 隔离冲突 | **采纳** | 复盘输入契约写死：唯一输入 = 会话日志普通 user message；feedback 存储对模型侧读者不可见（§4.6） |
| S1-8 | 复盘子会话被 FTS 索引回流 | **采纳** | 复盘子会话默认**不落盘**（进程内运行，对齐 Hermes `_persist_disabled` 的 DSH 等价物）；需要留痕的结论以 log-only 事件写回主会话（§4.6） |
| S1-9 | schedule 不能做宿主调度 | **采纳** | curator 确定性 pass 挂 `Agent.runMaintenance` 空闲边界；LLM 整合 = 驻留部署 + 外部 cron → webhook 根会话，显式声明为 app 层交付（§4.7） |
| S1-10 | 缺 Step 0 | **采纳** | 本方案所有挂点均带 file:line（出处 = 评审报告 §2–§5）；残余未核实项集中登记于 §6 Step 0 清单，核完才进对应 Phase 的实现 |
| S2-1/2/3 | Phase 0 表述、冻结快照类比、fs/observed 接线 | **采纳** | 见 §4.8（检索启用写成产品决策 + 后层覆盖）、§4.9（注入双通道权衡）、§4.4（skill-manage 发 `fs/observed` + 扩展 `mutationToolName`，双向接线） |
| S2-4/5 | 守卫新鲜度、发现侧静默忽略 | **采纳** | 守卫 = 版本化乐观并发（加载记录观测版本，patch 携带匹配）；写入侧与发现侧共用同一解析器，写后回读自检（§4.4） |
| S2-6/7 | 记忆作用域/并发锁、聚合预算 | **采纳** | scope 进 Config（项目域默认）；跨进程互斥用 lockfile；聚合预算 = 复盘插件累计 usage + `SubagentRun.dispose()`（§4.2/§4.10） |
| S2-8 | 威胁扫描英文锚点、技能面漏扫 | **采纳** | 技能写入扫描默认开启（Config 可关），中英双锚点 + 不可见字符 + NFKC，`\w` 语义差异进测试（§4.11） |
| S2-9/10/11 | UI 面、仓库门槛、检索启用面 | **采纳** | 每 Phase 列用户可见面（session-projection + locale 字典）与触发的仓库门槛清单（§5） |

## 1. 设计总纲：一切皆插件

- **零 loop 改动**：全部行为挂在已核实扩展点——`agent/pre-step`、`agent/turn-stopping`、`agent/status` + `Agent.runMaintenance`、`session/event`、`ctx.subagents.start()`、`ctx.jobs`、`ctx.webhookRuntime`（出处：评审报告 §2，全部带 file:line）。
- **能力强缝三角色**：新建持久化能力（memory）必须 Service Definition + Provider + Consumer 三包齐备；已有缝（skill）只补缺失角色（写侧 Consumer），不另起缝。单一职责插件（session-review、skill-curator）保持单包（cookbook："A single-purpose plugin stays one package"）。
- **角色命名**从上游角色表取词：记忆 = `MemoryStore`（Store：单一数据集 + CRUD/快照/订阅）；文件后端 = `...FileProvider`（Provider + 机制限定词）；复盘编排 = `ReviewRuntime`（Runtime：跨调度的活跃工作与生命周期）；生命周期清理 = `SkillCurator`（Policy/Executor 混合职责，取维护者语义）。
- **一切 tunables 进 Config**：预算、间隔、阈值、白名单、开关全部 `interface Config` + `z.object` 校验，load 时 fail-loud。
- **Model-visible ⟺ logged**：学习产物注入只走两条已核实合法通道——sourced durable user message（新增 `MessageSourceMap` merged kind）或 agent 作用域冻结 section（字节进 `request/header.system`，不变量强制重建）。

## 2. 插件清单（包组规划）

```
packages/memory/
  memory/            Service Definition：ctx.memory（MemoryStore 抽象类）
  memory-file/       Provider：文件后端（<projectRoot>/.dsh/memory + <dshHome>/memory，Config scope）
  tool-memory/       Consumer：memory 工具（add|replace|remove|operations[]）

packages/skill/
  tool-skill-manage/ Consumer：skill_manage 工具（create|patch|delete|write_file|remove_file，
                     所有权模型 + 版本化守卫 + fs/observed 接线）——补 skill 缝缺失的写侧角色

packages/review/
  session-review/    复盘编排插件：触发器 + ReviewRuntime + 子代理派发 + 结果折叠
                     （消费 ctx.subagents / ctx.memory / ctx.skills；产出 log-only review/* 事件
                       + session-projection 注册单元）

packages/skill/
  skill-curator/     慢速维护插件：确定性生命周期 pass（runMaintenance 槽）+ 可选 LLM 整合（驻留宿主）
```

依赖方向（无环）：`tool-memory → memory ← memory-file`；`tool-skill-manage → skill（既有缝）`；`session-review → memory / skill / subagent（既有缝）`；`skill-curator → skill / memory`。

每个包的标准件（上游硬性要求）：`src/index.ts`（函数插件 name/inject/Config/apply，无 default export；或服务包 default export 服务类）、`src/types.ts`（仅类型）、`./invariant`（登记 manifest 名或给出包级 `No runtime invariant:` 理由）、包级 `tests/`（per-file 100% 覆盖率门）、README（四选一 `kind` frontmatter + Model Experience 三段式 + Known Limitations 章节）、产品可见插件配 REAL-composition boot 测试、注册贡献配 HMR disposal 测试。

## 3. 插件骨架（上游 idiom 实形）

以 `tool-memory` 为例（照 `time-context`/`tool-skill` 的已核实形状）：

```text
/** Model-facing memory store tool. @module @deepseek-ai/dsh-tool-memory */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-memory' // ctx.memory 类型解析

export const name = 'tool-memory'
export const inject = ['tools', 'memory']

/** Memory tool behavior. Invalid values fail plugin load. */
export interface Config {
  /** Per-store character budget. Required: no silent default. */
  memoryCharLimit: number
  /** Per-store character budget for the user-preference store. */
  userCharLimit: number
  /** Consecutive failed consolidations before a terminal skip in one turn. */
  maxConsolidationFailuresPerTurn: number
}

export const Config: z<Config> = z.object({
  memoryCharLimit: z.number().min(1),
  userCharLimit: z.number().min(1),
  maxConsolidationFailuresPerTurn: z.number().min(0),
})

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({ /* memory 工具 schema；从模型视角写描述 */ }))
  // 拒绝/终态/成功不回显语义全部在 execute 内实现（在做出决定的操作里强制决定）
}
```

Service Definition（`memory` 包，照 `skill` 的 `declare module` 合并形状）：

```text
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** One memory store engine. Singular key: one store per scope pair. */
    memory: MemoryStore
  }
}

/** Owns the memory entry set: CRUD, snapshots, subscriptions. */
export abstract class MemoryStore {
  abstract add(scope: MemoryScope, entry: MemoryEntry): Promise<AddResult>
  abstract replace(scope: MemoryScope, oldText: UniqueSubstring, content: string): Promise<ReplaceResult>
  abstract snapshot(scope: MemoryScope): Promise<MemorySnapshot>
  // 预算强制整合、终态失败、威胁扫描钩子在抽象契约层定义，Provider 实现
}
```

## 4. 逐机制规格（每条挂点已核实）

### 4.1 触发器（`session-review` 内部）

| 宿主 | 机制 | 依据 |
|---|---|---|
| 常驻（web/gateway，默认） | `session/event` 观察 `turn/end` + Config 空闲去抖窗口 | 事件点存在；idle 相位有 `runMaintenance` 先例（compaction-basic、schedule 在用） |
| headless 一次性 | 最终 `turn/end` 后、exit 前同步 await 一次（boot 接线，app 层交付，RC4 明确计入） | 5 秒强退窗口（`process-shutdown.ts:4`）不允许 teardown 触发 |
| 冷会话补学 | next-resume：恢复会话时复盘上一段日志（幂等、零竞速） | resume 是 DSH 会话常态（`SessionStartSource 'resume'`） |

谁保证复盘跑完：常驻 = 派发后宿主存活即完成；headless = exit 序列 await；next-resume = 天然无竞速。三选一由 Config `triggerMode` 决定，默认 next-resume。

### 4.2 复盘执行（消费既有 subagent 缝）

- `ctx.subagents.start('self-review', …)` 程序化派发（`subagent/src/index.ts:552`，无需模型工具调用）。
- 工具面 = 父组合 + `toolFilter.allow: [memory, skill-manage, session-query 读]`；**接受冷缓存**，用 `agentOptions.model` 路由廉价模型（S1-3 处置）。
- 聚合预算：插件累计子会话消息事件自带 usage，超 `Config.maxReviewInputTokens` 即 `SubagentRun.dispose()`（S2-7 处置；`ctx.tokenMeter` 为记账底座）。
- 前提 P1：base 组合须装配 memory/skill-manage/session-query——这是新的基础组合决策，随 Phase 2/3 PR 落地（S1-2 处置）。
- 复盘提示词：移植 RC1 §1.4 的更新优先序与反迷信清单（三模板归一为 fork 单模板 + `focus` 转向参数）；"没什么可学"是正常终局。

### 4.3 溯源

- 复盘子代理 preset 命名 `self-review`（`agentPreset` 自由字符串，已入 sqlite 索引列）；不用 `origin`（闭联合集，动它是词表变更）。
- 写入产物带 `created_by: 'agent'` + 复盘会话引用（storageDomain 账本行内，不进 frontmatter）。

### 4.4 技能写侧（`tool-skill-manage`）

- **所有权**：可写 source 白名单 Config 化（默认仅 `project-dsh`）；patch 目标解析写死——非白名单来源的 winning candidate 拒绝或显式 copy-on-patch（结果中明示遮蔽）；新建默认 `draft`（frontmatter `disable-model-invocation: true`），用户提升 `active` 后入目录；后台复盘 fork 写面收窄到 `created_by === 'agent'` 条目。
- **守卫**：`skill` 加载时记录观测版本（size/mtime/hash），patch 必须携带匹配版本，失配拒绝并强制重载；"已加载 + 版本"从会话日志可重建（工具结果与 `/name` 注入都是 durable 消息）。
- **失效接线**：工具写入后发出 `fs/observed`（真实 exec actor）**且**扩展 `mutationToolName` 成员（两半缺一都被静默丢弃）；同步 skill-filesystem README 成员清单与行为钉死测试。
- **fail-loud**：写入侧与发现侧共用同一 frontmatter 解析器；校验失败拒绝工具调用；写成功后回读断言条目已入目录。
- **与 human-review 提案的关系**：模型自治域 = 排除清单中的 `.dsh/skills`；`.agents/skills` 人工域永不自主写；提权进人工域走该提案的双评审 + adoption-evidence 流程。
- 明确负面决策：不支持 Hermes 的 `${HERMES_SKILL_DIR}` 模板令牌与内联 shell（RCE 面）。

### 4.5 计量（storageDomain sidecar）

- 账本 = `ctx.storageDomain` KV（base bundle 已挂载，message-feedback 先例），键 `skill-usage/<name>`，字段对齐 Hermes `.usage.json` + `created_by`。
- `skill`/`/name` 加载递增计数**只写账本不写技能文件**；frontmatter 只留 `created_by` 等低频作者字段。
- 账本写入自带域级原子性；跨进程并发语义在 Phase 2 用例中钉死（两会话同时 bump 不丢更新）。

### 4.6 复盘隔离与输入契约

- 复盘子会话默认**不落盘**（进程内执行、结束时丢弃），FTS 无从索引——Hermes `_persist_disabled` 事故防线的结构性等价物；需要留痕的结论由插件以 log-only `review/*` 事件写回**主**会话（fail-closed 词表需 `gen-persistence-catalog` 再生 + 双 SDK expected outputs，计入 Phase 3）。
- 输入契约：复盘唯一输入 = 会话日志普通 user message；`messageFeedback`/`command-feedback` 存储对模型侧读者不可见；翻转需先改 feedback 政策文档。
- 注入回放：复盘结论作为 sourced durable user message（`MessageSourceMap` merged kind `memory`，ContextForm `recall`——词表已存在）进入后续会话；摘要陈旧性由 snapshot 语义（后者覆盖前者）承担。

### 4.7 curator（`skill-curator`）

- 确定性生命周期 pass（无 LLM）：30 天 stale / 90 天归档（只归档永不删除）、pinned 保护、use=0 宽限、复用复活；挂 `Agent.runMaintenance` 空闲边界（Config `intervalHours`/`minIdleHours`）。
- 领地边界写死：只管辖模型自治域（`.dsh/skills` + `<dshHome>/skills` 账本）；永不触碰 `.agents/skills`、`.agents/notes`、bundled 根。
- LLM 整合 pass：默认关；开启 = 驻留部署 + 外部 cron → webhook 规则创建带 curator 组合的根会话（app 层交付，显式声明）；产出 `consolidations: [{from,into,reason}]` + 报告 + 目录快照。

### 4.8 检索启用（Phase 0，产品决策非开关）

- 启用路径照上游预留注释：部署的 profile `cordis.patch.yml` / `--patch` 后层覆盖 `openAt: never` → `first-search`，配持久 `path`（后层覆盖不触发任何钉死测试，web e2e scaffold 已在走）。
- 组合 `tool-session-query` 即自带 prompt 节（`PROMPT_TEXT` + 槽位 `TOOL_SESSION_QUERY: 2300` 已预留）——RC1 的"新增一节"删除，改为评估现有措辞。
- 同场 Config：`maxSearchResults` 调低（默认 100）并记录与 `tool-result-pruner` 8192 字符预算的关系。
- 每个 shipped profile 的工具去留逐个写明；shipped 默认翻转作为独立产品决策另议（触发 roster 钉死测试 + 2026-08-02 决策反转）。

### 4.9 记忆注入（Phase 2）

- 主通道：sourced durable user message（skill-catalog / agent-instructions 模式）——冻结快照 = 会话首请求前注入，digest-vs-log 决定重发布；append-only 不动前缀。
- 备选（登记不实施）：agent 作用域冻结 section（静态文本注册时一次解析，`request/header.system` 逐字节入日志、不变量强制、resume 稳定）——适合需要与身份同位的极小记忆摘要；动态内容走 PromptContext 会被 `suppressRuntimeContext` 抑制，注明。
- 作用域 Config：项目域默认 + 用户域可配 + 两域合并规则；跨项目隔离进验收。
- 并发：lockfile + 锁内 re-read（Hermes fcntl 模板）；失败策略 = 拒绝本次写入不自动重试。

### 4.10 质量门（反超点）

- agent 创建技能默认 `draft`；提升 `active` 前跑轻量验证：SKILL.md 须含可执行 `Verification` 章节，由复盘 fork 的受限工具面执行，失败回 `draft`。
- 内容威胁扫描默认开启（Config `scanAgentCreatedSkills: true`，对 Hermes `guard_agent_created` 默认关的刻意反转）；中英双锚点 + 不可见字符 + NFKC；Python/JS `\w` 语义差异进测试；"已知绕过不拦"进 README Known Limitations。
- 记忆写入同扫描（strict scope）+ `[BLOCKED]` 替换保留用户可见性。

### 4.11 用户可见面

- 复盘结论/技能计量经 `session-projection` 注册单元（todo/goal/stats 先例）供 client 投影；新工具配 host presenter + Web 卡片 + locale 字典（`verify-client-ui-i18n`）；评审报告的 💾 摘要形态作为投影行文案参照。

## 5. Phase 划分与验收（含强制门槛）

| Phase | 交付（插件） | 关键验收 | 触发的仓库门槛 |
|---|---|---|---|
| P0 | 无新包：后层 patch 启用检索 + tool-session-query 组合 + `maxSearchResults` 配置 | 后层覆盖后五工具可见、SESSION_QUERY_SEARCH_DISABLED 消失；profile 范围决策成文 | recorded-session snapshot（模型可见面变化）；tool/config 目录再生 |
| P1 | `tool-skill-manage` + 计量账本（storageDomain） | 原子性/回滚/版本守卫/所有权拒绝单测；创建→draft→提升→目录自刷新（含 fs/observed 接线并行用例）；写后回读自检 | 新包全套（invariant/README/coverage/REAL boot/HMR）；Agent Note；UI presenter + i18n |
| P2 | `memory` 三包（缝齐备） | 预算强制整合/失败终态/并发锁/作用域隔离单测；注入可从日志重建（invariant 已强制）；双 SDK expected outputs | 新包全套 ×3；SessionEventMap/MessageSourceMap 词表登记 + `gen-persistence-catalog`；snapshot tier 全列（headless/sdk/python） |
| P3 | `session-review` | 触发三形态各一测试；受限工具面 + 不落盘断言（FTS 不可检索）；聚合预算 dispose；provenance=agentPreset | REAL-composition boot；snapshot tier；webhook/cron 路径的 app 层说明文档 |
| P4 | `skill-curator` | 只归档不删除、pinned/宽限规则、领地边界（人工域零接触）单测；报告与快照落盘 | 新包全套；app 层声明（webhook 根会话路线） |

## 6. Step 0 残余核查清单（动工前逐项核完）

1. `MessageSourceMap` merged kind 的声明点与 SDK 投影面（评审已定位 `message.ts:101-106`，需确认 python/ 侧投影生成机制）。
2. `ctx.storageDomain` 的跨进程并发语义（两进程同时写同键的行为；若弱保证则账本加 lockfile）。
3. `ctx.subagents.start` 在无模型回合（插件自主触发）时的可用性与 fiber 归属（评审已定位 API，需 boot 测试验证）。
4. `writableRoots` 策略是否为 dshHome 增加供给（技能用户域写入的前置策略变更；不供给则用户域写入走账本外通道并明示）。
5. `runMaintenance` 在 `turn/end` 去抖触发形态下的重入/排队语义。

## 7. 非目标

- 不改 `agent-loop`；不新增模型工具面以外的模型可见通道；不做语义/向量检索；不做跨设备同步；RC4 不实现热缓存 fork（字节一致 + 运行时拒绝），登记为后续可选；不在本 fork 内翻转 shipped 检索默认。
