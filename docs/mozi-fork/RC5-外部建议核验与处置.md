# RC5 前置：外部建议逐条核验与处置

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 评审对象：外部第二轮评审（31 节，针对 RC4）；对照物：本仓 master @ `04df54e2a8`（基于上游 deepseek-ai/deepseek-harness @ `cd5ef81`）
>
> 方法：与上一轮评审报告相同——每条承重断言先对本仓源码核验（file:line），再下"确认 / 修正后采纳 / 不符实际"结论
>
> 日期：2026-08-29

## 0. 总判断

外部评审的**七条"硬错误"指控经逐一核验全部成立**——RC4 在 subagent/preset/Service/持久化/竞速/生命周期/原子性七个 API 与架构触点上确实写错了。同时，外部评审有**四处建议与本仓实际不符或机制描述不准**，其中最关键的一条（#19 "ignorable 事件"）所引用的机制在本仓根本不存在。总体：**采纳其"LLM proposes, Host commits"核心重构，拒绝其持久化词表假设，修正其过滤与失效通知的实现细节**。RC4 的教训也照实记录：它写快了、没核够——七条硬错误里有三条的答案在上一轮评审报告已核实的证据里就有。

## 1. 七条硬错误指控：逐条核验（全部成立）

| # | 外部评审指控 | 本仓核验 | RC5 处置 |
|---|---|---|---|
| 1 | `start('self-review', …)` 首参不是角色名 | **成立**。`subagent/src/index.ts:552` JSDoc："@param name - **the provider to use**"，内部 `expectProvider(name)` 按 provider 名解析；`label/persona/toolFilter/outputSchema/agentOptions` 都在 request 里 | 改为 `ctx.subagents.start(config.reviewProvider ?? 'spawn', { label: 'self-review', parent, prompt: learningView, persona, toolFilter, outputSchema, agentOptions })` |
| 2 | `agentPreset='self-review'` 污染组合身份 | **成立**。`child-agent.ts:144` `agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)`——写入的是父组合的**实际** preset；`types.ts:92-98` JSDoc 明言 durable 是因为 "a resume that restored a different composition would replay history the model can no longer act on" | 溯源 = `request.label: 'self-review'`（进 descriptor）+ ReviewLedger 元数据（producer/policyVersion/reviewId）；`agentPreset` 保持自动记录，不手写 |
| 3 | `MemoryStore` 不是完整 Cordis Service | **成立**。声明合并只给 TypeScript 类型；运行时注册要 `extends Service` + `super(ctx, key)`——仓内先例：`SkillRegistry extends Service`（`skill/src/index.ts:357,375` `super(ctx, 'skills')`）、goal（`goal/src/index.ts:194` `super(ctx, 'goals')`）、基类在 `vendor/cordis/src/service.ts:11` | Definition 骨架改为 `export class MemoryService extends Service { constructor(ctx) { super(ctx, 'memory') } }`（抽象基类或带默认实现均可，注册契约不可省） |
| 4 | "review 子会话默认不落盘"无依据 | **成立**。`child-agent.ts` `childSessionMeta` JSDoc："Build the child session's **durable creation metadata**… Recording it is what makes a child's history reconstructable"；仓内无 `_persist_disabled` 等价开关。（注：RC4 此处还与上一轮评审 S1-8"子会话持久化后会被 FTS 索引"的自家证据自相矛盾——写 RC4 时丢了已核实事实） | 撤回"不落盘"；改为"**持久化保留（有审计价值），从检索面隔离**"：model-facing 检索默认排除子代理（见 §2-2 的更优实现） |
| 5 | next-resume"天然零竞速"不成立 | **成立**。`agent/session-start` 是启动通知（"the first startup-driving extension point"，`runtime-types.ts:158,224`），不是首请求前的异步闸；而 `agent/pre-step` 是 awaited waterfall（`runtime-types.ts` pre-step 签名返回 `Promise<PreStepDecision>`），可以真闸 | 触发模式重写（§4）：`resume-blocking`（首 `pre-step` 内 `ensureReviewThrough(seq)` → await → `next()`）提供真零竞速；async 模式诚实标注"学习晚一回合生效"。默认模式的选择是产品权衡不是正确性要求——见 §3-4 |
| 6 | `disable-model-invocation` 冒充 draft 生命周期 | **成立**。`skill-filesystem/README.md`：两个 frontmatter 键是**调用面策略**（model catalog/loader vs 用户命令），不是生命周期；且 `user-invocable` 默认 true——RC4 的"draft"连用户 `/name` 调用都挡不住，漏洞比评审说的还大 | 生命周期状态（`draft/active/archived` + `owner` + `revision`）放 storageDomain sidecar 为权威；落盘位置放发现不可达的 staging 根（发现只扫直接条目：`<root>/<name>/SKILL.md`，嵌套 `.draft/<name>/SKILL.md` 不会被扫描，`skill-filesystem/src/index.ts:719-747`）；调用策略键只管调用面 |
| 7 | "账本写入自带域级原子性"过度声明 | **成立**。`storage-domain/src/domain.ts:84,89,332` `update(key, fn)` 单进程域内串行原子（"concurrent updates never interleave"）；README Known Limitations 白纸黑字："**Single-process change visibility**… a second host process… observes no changes until the cross-process revision pattern lands" | 声明单 Host writer 部署模型；跨进程写不做（需要时再上 lock/DB CAS）。RC4 §6 Step-0 第 2 项就此结案 |

## 2. 不符本仓实际的外部建议（拒绝或改写）

### 2-1 【拒绝】#19 "review/* 做成 ignorable audit event"——本仓不存在 ignorable 机制

`known-event-types.ts` 头注释（生成物，`gen-persistence-catalog` 产出）："The persistence read path **refuses** to interpret a log containing a type outside this set… **silently skipping the event could reconstruct a wrong session**." 全仓 grep 无 `ignorable` 概念；其引用的 persistence-catalog.md 里也没有。fail-closed 词表正是本 fork 独有的耐久性地基，外部评审把自己的 Hermes 式容错假设带了进来。

**改写**：早期 Phase **不新增任何 `review/*` 会话事件**——正确性/幂等权威放 ReviewLedger（storageDomain）；用户可见的 💾 摘要由 memory replacement 的 sourced user message（词表已有 `user/message` + `MessageSourceMap` merged kind，goal/skill-catalog 先例）承载；将来若确需 `review/*`，按全价流程走（词表登记 + `gen-persistence-catalog` 再生 + 双 SDK expected outputs），RC4 §5 已为此计价，维持。

### 2-2 【修正后采纳】#18 检索排除子代理——实现比 origin 过滤更便宜

评审假设需要 origin 过滤，但 sqlite 索引**没有 origin 列**（`session-query-sqlite/src/index.ts:577`），加 origin 列是 schema 变更。而索引**已有** `parent_session` 与 `delegation_depth` 列（:163-172）。

**改写**：model-facing 检索默认条件 `parent_session IS NULL`（只搜根会话），子代理经显式 debug/inspection 参数才可见——零 schema 变更，且一并解决所有子代理历史污染（不止 self-review）。落点是 session-query 插件层，仍零 loop 改动。

### 2-3 【修正后采纳】#13/#14 fs 通道与失效通知的机制精确化

方向正确（所有 mutation 走 `ctx.fs`，不手写 realpath/startsWith；`fs/observed` 是事后观察通知不是守卫），但两处机制要修正：
- `fs/observed` 由**工具层**发出（`tool-fs/src/write.ts:121` 带 `exec`），host service 经 `ctx.fs` 写**不会**自动发此事件。SkillAuthoringService 这类 host 侧写入应直接调用 `provider.observeHostMutation()`（`skill-filesystem/src/index.ts:139-142` 的既有宿主变更入口），或接受 chokidar 0–300ms 兜底。
- `mutationToolName` 扩成员（`skill_manage`）**只在写路径走模型工具层时需要**；若模型面只产出 proposal、由 host commit，则该接线整体消失——这是 "LLM proposes, Host commits" 的又一红利，RC4 未意识到。

### 2-4 【部分拒绝】#5 的默认触发 = resume-blocking

blocking 机制本身成立（pre-step 可闸），但**把它设为默认是产品权衡不是正确性要求**：每次 resume 的首请求被一次 LLM 复盘阻塞（秒到分钟级），对交互式用户是显著回归。async 模式没有正确性违反，只有新鲜度延迟。

**改写**：两模式都进 Config（`triggerMode: 'resume-blocking' | 'resume-async' | 'maintenance'`）；默认 `resume-async` 并诚实标注"新学习晚一回合生效"；需要同回合新鲜度的部署自行选 blocking。拒绝任何"天然零竞速"类措辞。

### 2-5 【登记为产品决策】#8 storageDomain 做记忆主持久化 vs 人类可读文件

采纳 storageDomain 为主（原生、原子、零 git 噪声、§1-7 已定案单进程语义）。但登记一笔：RC1/RC2 借鉴 Hermes 的原意包含**用户可读可修**的记忆文件（威胁扫描 `[BLOCKED]` 的可见性设计依赖它）。RC5 以 storageDomain 为权威存储，"Markdown 导出视图"（只读渲染）作为后续产品决策，不进首个实现。

### 2-6 【修正后采纳】#11 拆包时机

"两个消费者出现后才抽 Service"的原则本身正确（glossary："a package may own multiple roles when they are one concern"）。但本计划里两个消费者（P2 的模型工具、P3 的复盘 commit stage）在同一计划内先后落地——预拆有现行依据，不算投机。**改写**：P2 将 authoring 逻辑实现为 `tool-skill-manage` 包内的内聚模块；P3 落地时抽 `skill-authoring` Host Service（届时两个真实消费者都在），不在 P2 提前拆包。

### 2-7 【备注】引用路径失真不影响结论

外部评审引用的部分路径（`docs/user/develop/framework/service.md`、`docs/user/develop/practice/index.md` 等）在仓内不存在（是 website 投影源或外部改写），但其结论均可由仓内证据独立证实（§1 已给）。引用这类评审时以仓内 path:line 为准。

## 3. 直接采纳（核验通过或属设计判断，无需修正）

| 外部建议 | 采纳依据 |
|---|---|
| **LLM proposes, Host commits**：review child `toolFilter.allow: []` + `outputSchema`（ReviewPlanSchema），只产结构化 proposal；mutation 全在 host 确定性 commit stage | `start()` JSDoc 证实 request 携带 outputSchema（`assertObjectJsonSchema` 校验）；ToolRestriction `allow` 语义"stay visible; everything else is removed"（`core/tools/src/index.ts:683`）；`allow: []` 合法性列入 P0 REAL 测试钉死。顺带消除 RC4 的一个内在矛盾：P3 把子代理工具收空后，P4"由复盘 fork 执行 Verification"已不成立——评审 #20 的结构/行为验证拆分随之采纳（结构验证 = host 侧解析/schema/字节上限/威胁签名；行为验证 = 未来封闭 verifier adapter，绝不执行新生成 SKILL.md 里的任意 shell） |
| **spawn 而非 fork**：`spawn-in-process` `inheritsParentContext = false`（`subagent-spawn-in-process/src/index.ts:50`），子代理只吃 LearningView 这份受控材料 | 冷缓存已被 RC4 接受；LearningView（确定性 projector：direct-human user message、user correction、tool call/result/error、final outcome 为 context；排除 memory/skill-catalog synthetic 消息、review/*、其他子会话、feedback sidecar——全部可按 `source.kind`/plugin 名从日志确定性过滤）替代跨会话检索 |
| **ReviewLedger + 幂等 saga**：`reviewId = hash(sessionId, throughSeq, policyVersion)`、`opId` 由 host 计算、at-least-once + committed-opIds 跳过重放 | `runMaintenance` 语义即 claim-或-throws（"throws synchronously when turn-driving or another maintenance task already owns the agent"，`runtime-types.ts:102-110`）——本仓 maintenance 就是 at-least-once，幂等必须自己建 |
| **模型不拥有权威字段**：ReviewPlan 不含 reviewId/owner/revision/root/绝对路径；host 收到后填 | 与 "Enforce a decision in the operation that makes it"、"模型面只含任务概念" 同构 |
| **standing preset 状态键控不变式**：插件实例是 standing mount 单例，可变状态按 Agent/SessionId 键控（`WeakMap<Agent,…>`），经 disposal 清理 | preset roster 每 preset 只 standing mount 一次、session 按 scope parentage 加入（`agent-presets/src/mount.ts`，上一轮已核） |
| **skill usage 观察者**：不改 `tool-skill` 内部；观察者插件读会话事件（`tool/result` + `user/message` source `skill-invocation` 都是 durable 面）计 modelLoads/userLoads/lastMeaningfulUseAt | 两个 durable 面均已核实（`tool-skill/src/index.ts:125,196-203`）；零工具改动 |
| **project-dsh 自治域先行**：user-dsh 写入整体暂缓，不为它扩 `writableRoots`；同 layer 遮蔽升 P0 安全不变式——低权限/人工 source 存在同名 candidate 时 autonomous create 默认拒绝（`name_conflict_with_human_source`） | `writableRoots` 无 dshHome 供给（`sandbox/src/roots.ts:52-55`，上轮已核）；rank 100 遮蔽 rank 200（`skill/src/index.ts:75`，上轮已核） |
| **单 mutation 原子性 + 多 proposal 走 ledger saga**；模型工具初版删 `operations[]` | ctx.fs 提供 per-mutation 原子性 + version guard，不提供多文件事务（fs 语义边界） |
| **session-query 退出自进化主线**：LearningView 替代子代理检索需求；检索独立成 track（先做子代理排除，再议默认启用） | 缩小 MVP；且在排除落地前启用检索只会放大 S1-8 回流面 |
| **L0 Shadow → L1 Conservative → L2 Autonomous** 三级 rollout + P5 effectiveness 指标（proposal precision、false durable memory、重复/覆盖率、人工拒绝率、repeated-task success、token 预算、resume-blocking P95） | 无架构争议；L0 shadow 零 mutation，是校准 review prompt 的唯一诚实方式 |
| **P0 = Evidence Lock**（钉死 upstream/fork SHA + path:line + REAL 测试，不写产品代码）；P0–P5 重排 | RC4 的教训（§0）正是缺了这一步 |
| **七条第一原则**（§31）整体采纳，其中第 3 条用其精炼版（"本机制新增的动态 model-visible payload 以 Session log 为 replay authority；静态 prompt/tool schema 由 composition revision 与 validated Config 重建"） | RC4 的"每条字节都可从日志重建"过度绝对——静态面本就不由普通 session events 承载（由 `request/header` 的 header 快照与 composition 承载，上轮对抗复核已证实其逐字节入日志，但这与"动态学习内容必须 log-authoritative"是两回事） |

## 4. RC5 修订动作清单（由此裁定直接产生）

1. §4.1 触发器：改写为 maintenance（mark due → debounce → `runMaintenance`，busy 保留 due）/ resume-blocking（pre-step 闸）/ resume-async（默认，明示延迟）三模式；删除"天然零竞速"。
2. §4.2 执行：`start(provider, request)` 正确形态 + `label: 'self-review'` + `allow: []` + `outputSchema` + spawn；LearningView projector 章节新增；ReviewPlan schema 按 #26（无权威字段）；ReviewLedger/saga 章节新增。
3. §4.3 溯源：撤 `agentPreset='self-review'`；改 label + ledger 元数据。
4. §4.4 技能写侧：生命周期入 sidecar；staging 根不进发现；`name_conflict_with_human_source` P0 不变式；authoring 逻辑 P2 内聚、P3 抽 `skill-authoring` Service；`fs/observed`/`mutationToolName` 按 §2-3 精确化；验证拆结构/行为两档。
5. §4.5 计量：改"单 Host 原子"；单 writer 部署模型入架构决策；usage 观察者替代工具内计数。
6. §4.6 隔离：撤"不落盘"；改持久化保留 + `parent_session IS NULL` 检索默认排除；不新增 `review/*` 事件（拒 ignorable）。
7. §2 包规划：`memory`（Service + storageDomain 默认实现，单包起步）+ `tool-memory`（可选、缓后）；`tool-skill-manage`（P2）+ `skill-authoring`（P3 抽出）；`session-review`；`skill-curator`（含 usage 观察者起步）；`mutation gate` 不预拆（外部评审撤回项，同意）。
8. §5 重排 P0–P5（P0 Evidence Lock；P1 Memory；P2 Skill Authoring；P3 Review Planner；P4 Curator；P5 Rollout/Effectiveness）。
9. 第一原则替换为七条版。
10. Step 0 清单按外部评审 §30 更新：storageDomain、runMaintenance、writableRoots 三项结案；新增待钉死项（local child persistence 实测、`parent_session IS NULL` 检索行为、`allow: []` REAL 组合、standing-preset 共享实例实测、skill shadow precedence、LearningView 的 source 过滤完备性）。

## 5. 元结论

这一轮的外部评审证明了上上轮评审报告立的方法论：**七条硬错误中有三条（#1 的 API 签名、#2 的 agentPreset 语义、#4 的子会话持久化）在上一轮报告的已核实证据里本来就有答案**——RC4 写作时没有回头对表，属于"自己核过的事实自己没用"。RC5 的写作纪律因此定为：每一个 API 触点先引 path:line（P0 Evidence Lock 的产出物），没有证据的句子不进方案。
