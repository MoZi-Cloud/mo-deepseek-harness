# 自我进化机制方案 RC5（LLM proposes, Host commits）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 版本脉络：RC1（`DSH借鉴hermes-开发记忆提炼-自我进化机制.md`）→ 评审（`评审报告.md`，9 S1 + 11 S2）→ RC4（`自我进化机制-RC4-全插件方案.md`）→ 外部第二轮评审 → 核验处置（`RC5-外部建议核验与处置.md`，七硬错误全确认 + 四处不符实际）→ 本 RC5
>
> 证据基线：本计划每个 API 触点均引用本仓已核实 path:line（fork master @ `8e6411c865`，基于上游 `deepseek-ai/deepseek-harness` @ `cd5ef81`）；证据账本 = `评审报告.md` + `RC5-外部建议核验与处置.md`，下文简称 [评审] [核验]
>
> 日期：2026-08-29

## 0. 七条第一原则

1. **Everything is a plugin, but not every role is a package.** 自进化业务不进 `agent-loop`；只有角色真正需要独立替换/演化时才拆包（glossary："a package may own multiple roles when they are one concern"）。
2. **LLM proposes; Host commits.** 复盘模型只输出结构化 ReviewPlan；一切长期 memory/skill 变更由 host 确定性 capability 执行。
3. **Dynamic model-visible state is replay-authoritative.** 本机制新增的动态模型可见内容必须来自 durable Session source 并可在 resume/fork/compaction 后重建；静态 prompt/tool schema 由 composition revision 与 validated Config 重建。
4. **Model text never owns authority metadata.** owner、state、revision、root、reviewId、opId 均由 host 生成与校验，模型输出不含它们。
5. **At-least-once trigger + idempotent commit.** 不假设 exactly-once；`runMaintenance` 语义即 claim-或-throws（`core/agent/src/runtime-types.ts:102-110`），重试安全由 ReviewLedger 保证。
6. **Project autonomous domain first.** 初版自主写只允许 `<projectRoot>/.dsh` 域；human `.agents` 与 user-home 域不因方便而扩大（`sandbox/src/roots.ts:52-55` 可写根无 dshHome 供给 [评审 S1-5]）。
7. **Learning requires evidence.** 每个自动持久化 proposal 必须引用允许类型的会话证据（`evidenceSeqs`）；无证据的 inference 初期只进 draft/shadow。

## 1. P0 — Evidence Lock（先于一切产品代码）

交付物不是功能，是**钉死的事实与行为测试**：

- 固定 upstream SHA `cd5ef81`、fork SHA，及下文全部 path:line 的当前有效性复核；
- 用 REAL-composition 测试钉死（新建 `tests/` 场景，mock 外部模型）：
  1. `ctx.subagents.start` 的 provider 解析与 request 契约（`subagent/src/index.ts:552` "@param name - the provider to use"）；
  2. `toolFilter.allow: []` 组合下子代理 prompt 与执行面（`core/tools/src/index.ts:683` "stay visible; everything else is removed"——空数组 = 全部移除，合法性待 REAL 钉死）；
  3. `outputSchema` 子代理的结构化返回（`subagent/src/index.ts` `assertObjectJsonSchema`）；
  4. spawn 子会话持久化行为（`child-agent.ts` `childSessionMeta` "durable creation metadata"）与 `parent_session IS NULL` 检索过滤效果；
  5. standing preset 下插件实例共享（`agent-presets/src/mount.ts` standing scope）与 `WeakMap<Agent, …>` 键控；
  6. `storageDomain.update` 单进程串行原子（`storage-domain/src/domain.ts:84,89,332`）；
  7. skill 同名遮蔽 precedence（rank 100 胜 200，`skill/src/index.ts:75`）与 `.draft` staging 根不进发现（发现只扫直接条目，`skill-filesystem/src/index.ts:719-747`）。

## 2. 架构总览

```
HOST PLANE（trusted code，一切 mutation 在此）
  MemoryService extends Service ──── ctx.storageDomain（单 Host writer）
  SessionReview ── ReviewLedger（storageDomain）
       ├─ LearningView projector（读会话日志，确定性过滤）
       ├─ ctx.subagents.start('spawn', { label:'self-review', …, allow:[], outputSchema })
       └─ deterministic commit saga ──► MemoryService / SkillAuthoring(host stage)
  SkillCurator（runMaintenance 槽）──► SkillAuthoring / usage ledger
AGENT PLANE（standing preset composition）
  memory durable replacement recall（sourced user message，skill-catalog 模式）
  tool-memory（可选，P1 暂不交付）／ tool-skill-manage（仅 authoring preset）
        │
        ▼
  Review child：provider=spawn，inheritsParentContext=false
  （subagent-spawn-in-process/src/index.ts:50），只吃 LearningView
```

核心链路：`Session → LearningView → spawn ReviewPlanner → ReviewPlan(结构化) → host evidence/ownership/revision 校验 → 幂等 commit saga → MemoryService / SkillAuthoring → ReviewLedger → durable replacement recall`。不碰 `agent-loop`，不新建持久化框架，全部复用 Cordis Service、subagent、toolFilter、outputSchema、storageDomain、ctx.fs、session source、runMaintenance。

**架构不变式**：(a) standing preset 插件实例为进程级单例，可变状态按 `Agent`/`SessionId` 键控并在 disposal 清理；(b) 动态学习内容只走 durable sourced message 通道（`llm/src/message.ts:101-106` merged kind；`snapshot`/`recall` ContextForm :54-61）；(c) `request/header.system` 逐字节记录完整 prompt 并被 `invariant.ts:45` 强制（`request-reconstruction.spec.ts:657-660` 证实跨 resume 字节一致）——静态面由此重建，本机制不往 prompt 塞动态内容。

## 3. 插件与包规划

| 包 | 角色 | 引入 Phase |
|---|---|---|
| `packages/memory/memory` | `MemoryService extends Service`（`super(ctx,'memory')`，先例 `skill/src/index.ts:357,375`、`goal/src/index.ts:194`）+ storageDomain 默认实现 + snapshot/digest/replacement renderer 内聚 | P1 |
| `packages/memory/tool-memory` | 可选 model-facing consumer | 缓后（P1 不交付，缩小模型工具面） |
| `packages/skill/tool-skill-manage` | 模型面 authoring 工具，内聚 authoring 模块（所有权/CAS/扫描/ctx.fs） | P2 |
| `packages/skill/skill-authoring` | Host Service（P3 出现第二个消费者时从 tool-skill-manage 抽出） | P3 |
| `packages/review/session-review` | 触发器 + LearningView + planner 派发 + ReviewLedger + commit saga | P3 |
| `packages/skill/skill-curator` | 生命周期状态机 + usage 观察者（起步内聚） | P4 |

每包标准件：`src/index.ts` 函数插件 `name`/`inject`/`Config`/`apply`（无 default export）或服务 default export 服务类；`src/types.ts` 仅类型；`./invariant` 登记；包级 `tests/` per-file 100% 覆盖；README（`kind` frontmatter + Model Experience + Known Limitations）；产品可见插件 REAL boot 测试。

## 4. 核心数据契约

```text
ReviewPlan（模型输出；不含任何权威字段）
  memory: [{ action: 'add'|'update'|'remove', targetHint?, content?,
             kind: 'explicit-user'|'observed-project'|'inference',
             evidenceSeqs: number[], reason, confidence }]
  skills: [{ action: 'create-draft'|'patch-draft', skillName,
             evidenceSeqs: number[], reason,
             files: [{ path, content }] }]        // path 相对技能目录
  noChangeReason?

MemoryEntry（host 权威，storageDomain 持久）
  { id, kind: 'explicit-user'|'observed-project'|'inference',
    content, evidence: SourceRef[], createdAt, updatedAt }
MemoryState = { revision, entries }                // scope 级 CAS 基准

SkillOwnership（sidecar 权威；SKILL.md 的 created_by 仅为人读元数据）
  { skillId, root, owner: 'agent'|'human',
    state: 'draft'|'active'|'archived', revision, createdByReviewId? }

ReviewCheckpoint（ReviewLedger 行，storageDomain）
  { reviewId = hash(sessionId, throughSeq, reviewPolicyVersion),
    sessionId, throughSeq, reviewPolicyVersion,
    status: 'planning'|'planned'|'committing'|'committed'|'failed',
    committedOpIds }                               // opId = host 计算，非模型指定
```

证据规则：`explicit-user` 必须引用至少一条 direct-human `user/message`；`observed-project` 必须引用 tool outcome；`inference` 初期只进 draft/shadow（L0/L1）。

## 5. 逐机制规格

### 5.1 LearningView（确定性证据投影）

会话日志 → 受控复盘材料的纯函数投影。允许：direct-human user message、explicit user correction、tool call/result/error、final assistant outcome（仅作 context）。排除：memory/skill-catalog 类 synthetic 消息（按 `source.kind`/plugin 名过滤——`skill-invocation`、`skill-catalog` 均为已登记 source kind，`tool-skill/src/index.ts:196-203,34-47`）、其他子会话（`parent_session` 非空）、feedback 存储（`feedback/README.md:11` "signals about the output, never input"）。预算进 Config；投影结果确定可重放（同日志同输出）。

### 5.2 触发器（三模式，Config `triggerMode`）

| 模式 | 机制 | 语义（诚实版） |
|---|---|---|
| `resume-async`（默认） | resume 后派发复盘，学习产物下一回合生效 | 无 teardown 竞速（不碰 5 秒退出窗，`apps/cli/src/process-shutdown.ts:4`）；**不宣称零竞速** |
| `resume-blocking` | 首个 `agent/pre-step`（awaited waterfall，`runtime-types.ts` 'agent/pre-step' 返回 `Promise<PreStepDecision>`）内 `ensureReviewThrough(lastCompletedSeq)` → await → `next()` | 真零竞速；代价 = resume 首请求被复盘阻塞 |
| `maintenance` | `session/event` 观察 `turn/end` 只标 due → 去抖 → `runMaintenance`（claim-或-throws，`runtime-types.ts:102-110`）；busy 则 due 保留、下次 idle 重试 | at-least-once |

禁止在 `session/disposed`（teardown、监听不被等待，`core/session/src/index.ts:1000-1001`）与 headless 退出路径（`bundle/headless/src/index.ts:198-204`）触发；headless 专属形态 = 最终 `turn/end` 后由应用退出序列显式 await（app 层交付，P3 计入）。

### 5.3 Review planner 执行（消费既有 subagent 缝）

```text
const run = await ctx.subagents.start(config.reviewProvider ?? 'spawn', {
  parent: agent,
  label: 'self-review',            // 溯源进 descriptor；agentPreset 由框架自动记录实际组合
  prompt: renderLearningView(view),
  persona: REVIEW_PERSONA,
  toolFilter: { allow: [] },       // 模型面零工具
  outputSchema: ReviewPlanSchema,
  agentOptions: { model: config.reviewModel },
})
const plan = (await run.result).structured
// host commit（§5.4），finally: await run.dispose()   (types.ts:289)
```

选择 spawn 的依据：`inheritsParentContext = false`（`subagent-spawn-in-process/src/index.ts:50`），子代理只吃 LearningView；fork 的前缀复用会被任何 delta 打断（`subagent-fork-in-process/src/index.ts:84-89` TODO）。聚合预算：累计子会话 usage，超 `Config.maxReviewInputTokens` 即 `run.dispose()`（记账底座 `ctx.tokenMeter`）。

### 5.4 Commit saga（幂等）

`plan → preflight 全部 proposal（evidence 核验、ownership、revision、同名冲突）→ 逐 op CAS + commit → ledger mark committedOpIds → checkpoint 置 committed`。崩溃/重试后：已 committed 的 opId 跳过、剩余继续。ctx.fs 只保证单 mutation 原子性与版本守卫，不承诺跨文件事务——多 op 一律经 ledger saga，不做伪回滚。

### 5.5 Memory durable recall（复制 skill-catalog 成熟模式）

生成当前记忆快照 → 算 digest → 与日志中最新 `source.kind='memory'` 消息比对（`tool-skill/src/index.ts:361-377` 同法）→ 未变不重复，变了 append **完整 replacement** sourced user message（source `{ kind:'memory', form:'recall' }`，`llm/src/message.ts:54-61` 既有 form）。正文围栏明示"本快照完整替换更早的 assistant-maintained memory 快照、非用户新指令"。语义上 #N+1 替换 #N，前缀仍可复用。威胁扫描（strict + 中英双锚点 + 不可见字符 + NFKC，`\w` 差异进测试）在写入与快照构建两端执行，命中条目替换为 `[BLOCKED]` 保留用户可见性。RC4 的"冻结 system section"备选**删除**：动态自进化状态一律走 durable source（核验处置 §2）。

### 5.6 Skill authoring（P2 内聚 → P3 抽 Service）

- 权威生命周期在 sidecar（`SkillOwnership`）；落盘位置 = 发现不可达 staging 根（嵌套目录不被扫描，`skill-filesystem/src/index.ts:719-747`）；`disable-model-invocation`/`user-invocable` 只作 active 技能的调用面策略。
- **P0 安全不变式**：任何人工 source（rank 200 `.agents/skills` 等）存在同名 candidate 时，autonomous create 默认拒绝并返回 `name_conflict_with_human_source`（rank 100 胜 200，`skill/src/index.ts:75`）。
- 全部 mutation 经 `ctx.fs`（写策略/版本守卫/canonical target 复用，不自写 realpath/startsWith）；host 写入后调用 `provider.observeHostMutation()`（`skill-filesystem/src/index.ts:139-142` 既有宿主变更入口；chokidar 0–300ms 兜底）。模型面只产 proposal、由 host commit 的前提下，`mutationToolName` 扩成员接线整体不需要。
- 验证两档：结构验证自动执行（frontmatter 解析、name/description schema、字节上限、威胁签名、同名冲突、bundle 完整性——host 侧）；行为验证 = 未来封闭 verifier adapter（`verification: { type: 'adapter', id }`），**绝不执行新生成 SKILL.md 里的任意 shell**（权限反转）。
- 初版边界：project-dsh only、无 delete、无 user-dsh；`tool-skill-manage` 仅进 authoring preset，不进普通 Agent preset。

### 5.7 检索隔离（独立 Retrieval Track，退出自进化主线）

model-facing 检索默认条件 `parent_session IS NULL`（索引已有该列，`session-query-sqlite/src/index.ts:163-172`，无 origin 列 :577——零 schema 变更），子代理会话仅显式 inspection 参数可见。先落此排除，再独立决定哪些 profile 启用内容检索（启用路径照 base patch 注释的后层覆盖，`cordis.patch.yml:120-133`；roster 钉死测试 `apps/web/tests/shipped-composition.e2e.ts:37-62` 只约束 shipped 默认）。

### 5.8 Curator（`skill-curator`）

状态机：`draft →(显式提升) active →(staleAfterDays) stale →(meaningful use) active｜(archiveAfterDays) archived →(显式复活) active`；全部数字进 `Config`（`staleAfterDays/archiveAfterDays/zeroUseGraceDays/intervalHours/minIdleHours`）。draft/archive = 移入发现不可达根；只归档永不删除；领地 = 模型自治域，永不触碰 `.agents/skills`、`.agents/notes`、bundled 根。usage 观察者读会话事件（`tool/result` = modelLoads、`user/message` source `skill-invocation` = userLoads，两个 durable 面见 `tool-skill/src/index.ts:125,196-203`），不改 `tool-skill` 内部；curator 依据用 `lastMeaningfulUseAt`。LLM 整合默认关；若开，复用 ReviewPlan → host commit 通道，不让 curator LLM 直接写文件系统。

### 5.9 用户可见面

复盘摘要（"💾 学到 2 条记忆 / 🧩 1 个技能草稿"）由 memory replacement sourced 消息与 storageDomain 账本派生，经 `session-projection` 注册单元供 client 投影（todo/goal/stats 先例）；新工具配 host presenter + Web 卡片 + locale 字典（`verify-client-ui-i18n`）。不新增会话事件——词表 fail-closed、无 ignorable 通道（`known-event-types.ts:1-20`），将来确需 `review/*` 按全价流程（词表登记 + `gen-persistence-catalog` 再生 + 双 SDK expected outputs）。

### 5.10 权限阶梯（rollout）

| Level | Memory | Skill |
|---|---|---|
| L0 Shadow | 仅 proposal，落 ledger，零 mutation | 仅 proposal |
| L1 Conservative | explicit-user / observed-project 自动 commit | 只建 draft |
| L2 Autonomous | 过质量门的 inference 可 commit | 过 verifier/质量门可 auto-promote |

## 6. P1–P5 阶段与验收

| Phase | 交付 | 验收核心 | 触发的仓库门槛 |
|---|---|---|---|
| P0 | Evidence Lock（§1） | 事实账本 + REAL 测试钉死清单全绿 | 测试基建 |
| P1 | `memory/memory`（Service + storageDomain + recall renderer）；**不含 tool-memory** | 同 digest 零重复 / 变更即完整 replacement / resume 重建一致 / project 域隔离 / 单 Host 并发 update | 新包全套（invariant/README/coverage/REAL boot）；MessageSourceMap merged kind 登记 + 双 SDK expected outputs；snapshot tier（headless/sdk/python） |
| P2 | `tool-skill-manage`（内聚 authoring 模块） | 所有权拒绝（含 `name_conflict_with_human_source`）/ CAS 版本守卫 / draft 不进发现且不可 `/name` / 威胁扫描默认开 / 写后回读自检 | 新包全套；Agent Note；presenter + i18n |
| P3 | `session-review` + `skill-authoring` Service 抽出 + 三触发器 + LearningView + ReviewLedger | allow:[]+outputSchema REAL 组合；提案证据核验（伪造 evidenceSeq 拒绝）；saga 幂等（重复派发零重复 mutation）；`parent_session IS NULL` 检索排除先行落地 | REAL-composition boot；app 层退出接线的架构说明；snapshot tier |
| P4 | `skill-curator`（含 usage 观察者） | 状态机全迁移路径单测；只归档不删除；领地边界（人工域零接触）；`lastMeaningfulUseAt` 驱动 | 新包全套 |
| P5 | Rollout（L0→L2）+ effectiveness | Shadow 先行；指标 gate：proposal precision（人工抽样）、false durable memory、duplicate/superseded 率、learned 后人工纠正率不升、repeated-task success 提升、draft acceptance 阈值、post-curation regression≈0、review tokens/session 与新增 prompt tokens 预算、resume-blocking P95 | 指标采集面板（storageDomain + projection） |

## 7. Evidence Lock 残余清单（P0 内结案）

已结案（不再待核）：storageDomain 跨进程（README:151 明示单进程可见性）；`runMaintenance` 重入（claim-或-throws）；writableRoots（不扩 dshHome，user 域暂缓）；`subagents.start` 契约（provider 名）。

待钉死：local spawn child 持久化的实测边界；`parent_session IS NULL` 过滤的检索行为与 UI 投影；`allow: []` REAL 组合；standing preset 共享实例下 `WeakMap<Agent,…>` 生命周期；skill shadow precedence 的 REAL 复现；LearningView source 过滤完备性（枚举全部 synthetic source kind）。

## 8. 非目标

不改 `agent-loop`；不新增模型工具面以外的动态模型可见通道；不做语义/向量检索；不做跨设备同步；不扩 `writableRoots`；不做 user-dsh 自主写；不做多 Host 共享 storage root；不做热缓存 fork 复盘；不在本 fork 翻转 shipped 检索默认。
