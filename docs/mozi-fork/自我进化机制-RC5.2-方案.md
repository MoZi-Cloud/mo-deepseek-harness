# 自我进化机制方案 RC5.1（协议闭环修订版）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 版本脉络：RC1（`DSH借鉴hermes-开发记忆提炼-自我进化机制.md`）→ 评审（`评审报告.md`，9 S1 + 11 S2）→ RC4（`自我进化机制-RC4-全插件方案.md`）→ 外部第二轮评审 + 核验处置（`RC5-外部建议核验与处置.md`，七硬错误确认）→ RC5 → 第三轮复核（9 S1 + 8 S2，全部核验成立）→ 本 RC5.1
>
> 证据基线：upstream `deepseek-ai/deepseek-harness` master = `cd5ef81`（本 fork 已含其全部历史，无新提交可合并）；fork 侧新增仅为文档与排除清单。每个 API 触点引用本仓已核实 path:line；证据账本 = `评审报告.md` + `RC5-外部建议核验与处置.md`，下文简称 [评审] [核验]
>
> 日期：2026-08-29

## 0. 第三轮复核处置表（RC5 → RC5.1）

上游同步结论先行：upstream master 至今仍为 `cd5ef81`（`git ls-remote` + `rev-list` 计数 0），fork 严格领先且仅增文档——无冲突可合并，同步为 no-op。评审所称"后来 master 上新增的 ignorable 机制"在上游无实体可指，[核验 §2-1] 对 `review/*` 的拒绝在唯一真实基线上终局成立。九条 S1 经源码核验**全部成立**并采纳；八条 S2 采纳（两处实现细节收窄）。

| # | 复核发现 | 核验证据 | RC5.1 处置 |
|---|---|---|---|
| S1-1 | memory 用 `form:'recall'` 是语义反写 | `llm/src/message.ts:54-61`：`'snapshot'` = "a later snapshot from the same producer supersedes an earlier one"；`'recall'` = "Material lifted out of another session's log"；`ContextSnapshotSection`（:63-70）与按 form 判别的必填字段 | memory replacement 改为 `form:'snapshot'` + `sections: ContextSnapshotSection[]` + 自有扩展 `revision`/`digest`；`recall` 保留给跨会话取材（§5.5） |
| S1-2 | mutation→ledger crash gap | storageDomain 仅单 record 原子（`domain.ts:84,89`；README "No cross-table transactions" :152） | 幂等下沉到资源自身：MemoryState 内嵌 `appliedOps[opId]`，mutation 与回执同 record commit；skill 走 digest reconciliation（§5.4）。原则 5 改写为 "resource-level idempotent commit" |
| S1-3 | 无 review 游标：重叠/乱序/重复扫旧证据 | 设计推导（reviewId 只有终点无起点） | 新增 per-session `ReviewCursor`（`reviewedThroughSeq`/`desiredThroughSeq`/`inFlight`）；reviewId = `hash(sessionId, fromExclusive, throughInclusive, policyVersion, learningViewVersion)`；单 session 单有序 review stream（§5.2） |
| S1-4 | `allow: []` ≠ "零工具" | `core/tools/src/index.ts:677-679` 逐字："Per-scope filter over **global tools**. Restrictions **do not affect scoped registrations or the reserved PTC mode transport**"；`outputSchema` 本身注册 child-scoped `structured_output` | 不变式改写为"**零继承的业务 capability 工具**"；P0 快照钉死实际 schema 面与 `structured_output` 协议存活（§1-2） |
| S1-5 | planner 不知道当前状态，无法可靠 update/remove/dedupe/patch | 设计推导（输入只有 LearningView） | 新增 `ReviewInput { evidence, currentMemory{revision,entries}, writableSkills[{skillId,state,revision,digest,summary}] }`；host 记录 base revisions，stale 即 reject/replan 不覆盖（§5.3） |
| S1-6 | `evidenceSeqs` 只证明引用存在，不证明内容支持结论 | 设计推导（seq 42 是"改 TypeScript"也能配"偏好 Rust"） | 原则 7 加强为 "admissible evidence"：evidence 带 `span`/`fieldPath`，L1 自动提交要求 span 存在于 seq 文本（extractive 级）；抽象/归纳自动降级 inference → shadow/draft；`confidence` 仅遥测，不参与授权（§5.4） |
| S1-7 | `observeHostMutation()` 跨包不可达 | `skill-filesystem/src/index.ts` 无 `ctx.provide`/`declare module`；`SkillProviderControl.invalidate` 只经 `registerProvider(create)` 交给注册者（`skill/src/index.ts:271-275,391-400`） | P2 新增最窄宿主失效缝：skill-filesystem 同包暴露 `ctx.skillMutationObserver.observeHostMutation(path)`（provider 特化优化不污染 SkillRegistry）；写成功→同步失效→回读自检成为确定性闭环（§5.6） |
| S1-8 | Memory 丢了硬预算（自进化状态无界增长） | RC5 MemoryState 只有 revision/entries | 恢复 `MemoryConfig { maxEntries, maxStoredChars, maxEntryChars, maxSnapshotTokens }`；预算在 **mutation 边界**强制（超限拒绝/要求 consolidation proposal），render 阶段禁止静默截断——否则破坏"完整快照"的 replay 语义（§4/§5.5） |
| S1-9 | `run.result.structured` 未检查终态 | `subagent/src/types.ts:236-252`：`structured?: unknown` 仅在成功 capture 时存在；失败以 `stopReason:'error'` 终结；`stopReason: SubagentStopReason` 多值 | host 闸门：`stopReason === 'completed'` 且 `structured !== undefined` 且 `ReviewPlanSchema.parse` 通过才进 commit；aborted/max-tokens/error 一律零 mutation（§5.3） |
| S2-1 | async 发布边界未写明 | `tool-skill` 的目录更新在 awaited `agent/pre-step` 内完成（`tool-skill/src/index.ts:213-251`） | 后台复盘只更新权威 MemoryState，**绝不在回合中途碰 model-visible 历史**；下一 `pre-step` 由 MemoryPublisher 读 state → 比对 digest → 发布 replacement（§5.5） |
| S2-2 | LearningView 必须定义在 raw durable log 上 | `SurfaceOp replace + sourceEventSeqs`（`core/session/src/types.ts:357-366`）——compaction 改表面不改 seq | 输入 = raw validated event log，`evidence.seq` 为 raw seq；P0 加 compaction/resume 前后同 range 同投影同 seq 恒等测试（§1-4） |
| S2-3 | 同名人工技能检测超出公开 API（list 只出 winning） | `skill/src/index.ts:350-356` "the nearest layer's entry wins… sorted invocation-neutral summaries" | 初版规则收窄为两条：直接存在性检查 `<project>/.agents/skills/<name>` + winning candidate 非 sidecar-owned 即拒绝；不做全 candidate 检测（未来需要再立 all-candidates seam）（§5.6） |
| S2-4 | usage 观察者"`tool/result` = modelLoads"过宽 | `tool/result` 是全工具系统 surface | 精确条件：`exec.name == 'skill'` 且 `isError == false` 且参数解析出技能名才计 modelLoad；`source.kind === 'skill-invocation'` 计 userLoads；失败调用不延寿（§5.7） |
| S2-5 | token 预算混淆输入与运行 | 设计推导 | 拆 `maxLearningViewTokens`（启动前确定性估算，超则不启动/截窗）/ `maxReviewTotalTokens`（运行中超限 `dispose()` 闸断）/ `maxReviewOutputTokens`（§5.3） |
| S2-6 | UI 摘要混淆状态投影与 durable timeline | 设计推导 | 首版 UI 明确定义为 "Current Self-Evolution Status"（storageDomain + projection 现值），不伪装成 durable transcript 行；将来要 timeline 按全价加事件词表（§5.8） |
| S2-7 | policyVersion 升级重放语义未定 | 设计推导 | 普通 policyVersion/learningViewVersion 变更**不**归零 high-water；重学须经显式 migrate/re-review 命令；两版本号进 reviewId（§5.2） |
| S2-8 | storageDomain schema 升级策略缺失 | `storage-domain/src/spec.ts:38` "a medium stamped with a different version **rejects at open**"；无自动迁移 | P1 即定义 `schemaVersion` + 迁移策略：developer-preview 阶段显式 CLI reset/migrate，绝不 silent clear；禁止等数据积累后发现"加字段即打不开"（§5.5） |

同时把第三轮复核裁定为**架构锁定项**（不再讨论）：自进化业务不进 `agent-loop`；LLM 只 proposes；host 拥有全部权威字段；spawn 复盘；子会话保留持久化审计、不做 `_persist_disabled` 复制；project-dsh 先行、不扩 writableRoots；staging 根承载 draft/archived；禁止自动执行技能自带 shell；session-query 退出主线（独立 Retrieval Track）；L0→L2 rollout；P5 effectiveness；pinned 基线首版无 `review/*` 事件。

## 0.1 七条第一原则（RC5.1 终稿）

1. **Everything is a plugin, but not every role is a package.** 自进化业务不进 `agent-loop`；只有角色真正需要独立替换/演化时才拆包。
2. **LLM proposes; Host commits.** 复盘模型只输出结构化 ReviewPlan；一切长期变更由 host 确定性 capability 执行。
3. **Dynamic model-visible state is replay-authoritative.** 本机制新增的动态模型可见内容必须来自 durable Session source 并可在 resume/fork/compaction 后重建；静态 prompt/tool schema 由 composition revision 与 validated Config 重建。
4. **Model text never owns authority metadata.** owner、state、revision、root、reviewId、opId 均由 host 生成与校验。
5. **At-least-once trigger; resource-level idempotent commit.** ReviewLedger 只负责编排；去重必须在被修改资源自身的 commit/reconciliation 边界上成立。
6. **Project autonomous domain first.** 初版自主写只允许 `<projectRoot>/.dsh` 域；human `.agents` 与 user-home 域不因方便而扩大。
7. **Learning requires admissible evidence.** 证据引用是必要条件而非充分条件；自动持久化必须验证证据内容确实支持 proposal，模型自报 confidence 不构成授权。

## 1. P0 — Evidence Lock（含第三轮新增 8 项测试）

在 RC5 §1 七项之上新增，钉死后 RC5.1 才进 P1：

1. Review child 终请求快照：实际 system prompt、user messages、tool schemas 逐字节；
2. `allow:[] + outputSchema`：无继承业务工具、`structured_output` 协议存活（`core/tools/src/index.ts:677-679` 的 scoped/PTC 例外面）；
3. Memory snapshot 语义：`form:'snapshot' + sections` 经 replay/projection 正确（`llm/src/message.ts:54-70`）；
4. 异步发布边界：后台复盘不 mid-turn append model-visible memory；
5. Review cursor 竞态：两个 due 只形成单有序 range；
6. Crash-gap 恢复：mutation 成功而 ledger 未 mark 时，重启不重复 effect；
7. Skill invalidation seam：host mutation 后下一次同步 snapshot 即见新技能；
8. LearningView compaction 恒等：同 raw range 在 compaction/resume 前后投影与 evidence seq 相同。

## 2. 架构总览与数据模型

Host/Agent 平面划分与核心链路沿用 RC5（`评审`/`核验` 证据不变）。数据模型按"证据 / 当前状态 / 模型提案 / host 权威 / 变更回执 / 模型可见快照"六个概念分离：

```text
ReviewCursor（storageDomain，per-session 单 record）
  sessionId, reviewedThroughSeq, desiredThroughSeq,
  policyVersion, learningViewVersion,
  inFlight? { reviewId, fromExclusive, throughInclusive, status }

ReviewInput（host 构建，只读）
  evidence: LearningView                       // 可被 evidence[] 引用
  currentMemory { revision, entries[{id,kind,content}] }
  writableSkills[{ skillId, name, state, revision, digest, summary }]

ReviewPlan（模型数据；无权威字段）
  memory[{ action, targetHint?, content?, kind,
           evidence[{ seq, span?, fieldPath? }], reason, confidence }]
  skills[{ action: 'create-draft'|'patch-draft', skillName,
           evidence[], files[{ path, content }] }]
  noChangeReason?

ReviewCheckpoint（host 权威；ReviewLedger 行）
  reviewId = hash(sessionId, fromExclusive, throughInclusive,
                  policyVersion, learningViewVersion)
  status: 'planning'|'planned'|'committing'|'committed'|'failed'
  opStates[]

MemoryState（storageDomain record；mutation 与回执同 commit point）
  { revision, entries[], appliedOps: { [opId]: resultDigest },
    schemaVersion }

MemorySnapshotSource（模型可见面）
  { kind:'memory', form:'snapshot',
    sections: ContextSnapshotSection[], revision, digest }

SkillOwnership（sidecar 权威）
  { skillId, root, owner, state, revision,
    createdByReviewId?, lastAppliedOpId?, contentDigest? }
```

## 3. 插件与包规划（不变）

`memory/memory`（P1）、`memory/tool-memory`（缓后）、`skill/tool-skill-manage`（P2，内聚 AuthoringCore）、`skill/skill-authoring`（P3 抽出）、`review/session-review`（P3）、`skill/skill-curator`（P4，含 usage 观察者）。P2 新增 `SkillMutationObserver` 宿主缝由 skill-filesystem 同包暴露（`ctx.skillMutationObserver`），保证 P2 的"写成功→同步失效→回读"不等 P3。

## 4. Commit 流程（RC5.1 十三步）

```text
 1. 原子 claim ReviewCursor（storageDomain 单 record）
 2. 构建不可变 ReviewInput
 3. spawn planner（label:'self-review'，allow:[]，outputSchema，agentOptions.model）
 4. 终态闸门：stopReason === 'completed' 且 structured 存在
    （types.ts:236-252；aborted/max-tokens/error → 零 mutation）
 5. ReviewPlanSchema 边界再 parse
 6. evidence admissibility：span 存在于 seq 文本；kind 分级放行
 7. 重读当前权威状态（MemoryState revision / sidecar revisions）
 8. stale-revision 检查：过期即 reject/replan，不覆盖
 9. host 分配 opId
10. 逐资源幂等 commit/reconcile：
      memory  → domain.update 内 appliedOps 去重，同 record commit
      skill   → 确定性目标路径 + 期望 digest + sidecar revision；
                重试时：目标缺失→执行；digest 相同→补 sidecar/ledger；
                digest 不同→conflict 禁止覆盖
11. checkpoint op 状态
12. 推进 reviewedThroughSeq
13. 释放 inFlight
```

崩溃恢复：重启发现未完成 cursor/checkpoint → 逐资源 reconcile → 继续。单 Host writer 前提下只需进程内 per-session 队列 + durable cursor，不做分布式租约。

## 5. 机制修正明细（相对 RC5 的差异面）

- **5.1 LearningView**：定义在 raw durable event log 上（非模型表面）；`evidence.seq` = raw seq；compaction/resume 恒等进 P0。
- **5.2 触发/游标**：三模式不变（resume-async 默认 / resume-blocking pre-step 闸 / maintenance claim）；全部经 ReviewCursor 串行化为单有序 review stream；policyVersion 变更不归零 high-water。
- **5.3 planner**：输入 = LearningView + ReviewInput.currentMemory/writableSkills；二者严格区分（state 可用于 dedupe/patch，不可当证据）；token 预算三分（`maxLearningViewTokens` 启动前估算、`maxReviewTotalTokens` 运行闸断、`maxReviewOutputTokens`）。
- **5.4 commit**：§4 十三步；memory 资源级幂等（appliedOps），skill 走 digest reconciliation；`confidence` 只入遥测。
- **5.5 memory 发布**：后台只写权威 MemoryState；下一 `agent/pre-step` 由 MemoryPublisher 走 digest→完整 `form:'snapshot'` replacement（复刻 `tool-skill/src/index.ts:213-251` 的时序）；硬预算在 mutation 边界强制；domain `schemaVersion` + 显式 reset/migrate 策略随 P1 交付。
- **5.6 skill authoring**：`ctx.skillMutationObserver` 缝（P2）；同名冲突初版两规则（直接路径存在性 + winning 非 sidecar-owned）；结构验证 host 侧、行为验证未来封闭 adapter；威胁扫描默认开。
- **5.7 usage 观察者**：`exec.name === 'skill'` 且成功且解析出技能名 → modelLoads；`skill-invocation` source → userLoads；失败不延寿。
- **5.8 UI**："Current Self-Evolution Status" 状态投影（storageDomain 现值 + projection），不伪装 durable timeline；timeline 需求出现时按全价加事件。

## 6. P1–P5 门槛增量

P1 在 RC5 验收外必须同时交付：Memory 硬预算、资源级幂等、`form:'snapshot'`、pre-step publisher、domain schemaVersion/reset 策略——缺一不进 P2。P2 增加：失效缝、filesystem reconciliation 重试测试、`.agents` 直接同名冲突测试。P3 增加：ReviewCursor、ReviewInput、终态闸门、evidence admissibility、崩溃恢复（而非只测"重复派发零 mutation"）。P4 不变（curator 一切写继续走 SkillAuthoringService，不另开通道）。P5 增加 confidence calibration 指标（校准完成前 confidence 不参与任何自动授权）。

## 7. 非目标（承 RC5，无变化）

不改 `agent-loop`；不新增模型工具面以外的动态模型可见通道；不做语义/向量检索；不做跨设备同步；不扩 `writableRoots`；不做 user-dsh 自主写；不做多 Host 共享 storage root；不做热缓存 fork 复盘；不翻转 shipped 检索默认；首版不加 `review/*` 会话事件。
