# 自我进化机制 RC5.1 方案兼落地开发计划评审报告

> 评审对象：`自我进化机制-RC5.1-方案.md`、`RC5.1-函数级规格总纲.md`、P0–P4 五份函数级附件
>
> DSH 基线：`deepseek-ai/deepseek-harness @ cd5ef8148158c3a752a658978873241fdf8e2bbc`（严格按方案锁定提交，不用后续 master 行为倒灌）
>
> Hermes 参照：`NousResearch/hermes-agent` GitHub `main`，检索日期 2026-08-29（Hermes 未在方案中固定 commit，因此本报告只把它作为“经验/机制参照”，不作为 DSH API 契约）
>
> 评审原则：**每条承重建议必须能追到 DSH/Hermes 源码事实；设计推论明确标为“由源码约束推出”，不把推论伪装成已有 API。**

---

## 0. 结论先行

RC5.1 已经比 RC4/RC5 成熟很多。尤其以下主轴应继续锁定，不建议再大幅摇摆：

1. **LLM proposes; Host commits**：模型只产结构化 proposal，长期状态 mutation 由可信 Host 执行。
2. **动态模型可见状态以 Session durable source 为 replay authority**，Memory 使用 `form:'snapshot'` 而不是把动态记忆塞进 system prompt。
3. **resource-level idempotency** 而非幻想一次 callback exactly-once。
4. **ReviewCursor + ReviewLedger** 把复盘视为可重试协议，而不是一次后台函数。
5. **project autonomous domain first**，不扩大 user-home writable roots。
6. **Shadow → Conservative → Autonomous** 分级上线，而不是一开始就让后台模型改长期知识。
7. P0 Evidence Lock 先钉行为，再进入产品实现。

这些设计与 DSH 的 Service/Provider/Consumer、Session、storageDomain、Subagent 与 SkillRegistry 能力缝方向一致，也吸收了 Hermes 在有界记忆、自治技能所有权、后台维护和写审批上的实战经验。

但是，**当前 RC5.1 仍不宜直接照规格进入 P1→P4 连续开发**。我认为存在 **14 项 S1（动工前/对应 Phase 前必须修）** 和 **10 项 S2（强烈建议随 RC5.2 一并收敛）**。最重要的新发现是：

> **P2/P4 当前把自治技能 lifecycle 强行实现为 filesystem 目录移动，但 DSH `ctx.fs` 的公开 seam 根本没有 rename/move/delete。与其给现有 `skill-filesystem` 不断打补丁，更 DSH-native 的设计是新增一个“agent-managed SkillProvider”：bundle 采用不可变 revision 路径，draft/active/archive 全部是 sidecar 状态；Provider 只暴露 active。**

这样可以同时消掉目录 move 硬障碍、`ctx.skillMutationObserver` fork-diff、相当一部分 crash-reconciliation 复杂度，并自然继承 DSH `SkillProviderControl.invalidate()` 和 rank 优先级机制；Hermes 的“只有 curator-managed 技能允许自治修改”则作为这个 Provider 的所有权策略。

### 建议决策

**不要推翻 RC5.1。建议做 RC5.2：保留 Memory + Review 主架构，重构 Skill 生命周期落点，并修完下述协议缺口后再实施。**

---

# 1. 源码基线与证据索引

以下编号在正文反复引用。

## DSH（固定 `cd5ef81`）

- **[D-FS]** `packages/fs/fs/src/index.ts`：`FileSystem` Service 的公开原语只有 resolve/stat/read/list/write/edit 等，没有 delete/rename/move/copy。 https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/fs/fs/src/index.ts
- **[D-FS-LOCAL]** `packages/fs/fs-local/src/fsio.ts`：底层实现内部会使用 `rename` 完成**一次 write 的原子发布**，但这不是 `ctx.fs` 暴露给 Consumer 的 rename/move capability。 https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/fs/fs-local/src/fsio.ts
- **[D-SKILL]** `packages/skill/skill/src/index.ts`：`SkillProvider`、`SkillCandidate.rank`、`SkillProviderControl.invalidate()`、`registerProvider()`；lower rank wins。 https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill/src/index.ts
- **[D-SKILL-FS]** `packages/skill/skill-filesystem/src/index.ts`：project-dsh rank=100、project-agents rank=200、custom=300；发现既支持 `<root>/<dir>/SKILL.md`，也支持 `<root>/<file>.md`；`observeHostMutation()` 为 provider 内方法。 https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill-filesystem/src/index.ts
- **[D-STORAGE]** `packages/storage/storage-domain/src/domain.ts`：写串行；`update(key, fn)` 对缺失 key 抛 `missing-key`；`put` 与 `update` 是不同原语。 https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/storage/storage-domain/src/domain.ts
- **[D-SESSION]** `packages/core/session/src/types.ts`：`assistant/message` 是“每个 step 的 assembled message”，字段为 `{turn, step, message, usage?}`，没有 `final: true` 标志；`turn/end` 才关闭 turn。 https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/core/session/src/types.ts
- **[D-AGENT]** `packages/core/agent/src/runtime-types.ts`：`runMaintenance(task)` 是“抢占 true idle phase 执行一个 task”的方法，不是定时任务注册器；busy 时同步拒绝。 https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/core/agent/src/runtime-types.ts
- **[D-SUBAGENT]** `packages/subagent/subagent/src/*` 与 in-process driver：`start(provider, request)`、`outputSchema`、终态 `structured?`；spawn 不继承父历史。 https://github.com/deepseek-ai/deepseek-harness/tree/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent
- **[D-LLM]** `packages/llm/llm/src/message.ts`：`snapshot` 表示同 producer 新快照替换旧快照；`recall` 用于从其他日志取回材料。 https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/message.ts
- **[D-TOOL-SKILL]** `packages/skill/tool-skill/src/index.ts`：catalog/snapshot 在 awaited `agent/pre-step` 边界发布，提供了 MemoryPublisher 可复刻的时序模式。 https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/tool-skill/src/index.ts

## Hermes Agent（`main`，2026-08-29 检索）

- **[H-MEMORY]** `tools/memory_tool.py`：有界 Memory；批量操作 all-or-nothing；写入前 scan；加载/快照时二次 scan；多次 consolidation 失败后终止重试，保证副作用失败不阻塞用户回复。 https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py
- **[H-SKILL-MANAGER]** `tools/skill_manager_tool.py`：自治后台写只允许 curator-managed skills；缺 provenance fail-closed；background review 修改已有技能前要求先读取确切目标内容。 https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_manager_tool.py
- **[H-SKILL-USAGE]** `tools/skill_usage.py`：usage/provenance sidecar；`created_at`、last-used/viewed/patched、state、pinned；telemetry 写失败为 best-effort，不破坏主工具调用。 https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_usage.py
- **[H-CURATOR]** `agent/curator.py`：idle/inactivity 驱动；确定性 lifecycle pass；LLM consolidation 默认关闭；never auto-delete；use=0 有 grace anchor。 https://github.com/NousResearch/hermes-agent/blob/main/agent/curator.py
- **[H-BG]** `agent/background_review.py`：后台 review 是非关键工作；新 live turn 到来时主动取消 background review，并只有限等待，前台优先；另有 aggregate input token budget。 https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py
- **[H-GUARD]** `tools/skills_guard.py`：结构扫描包含 file count / total size / per-file size / binary / symlink / invisible Unicode；扫描 `.sh/.bash` 等脚本，而不是“一律禁止脚本”。 https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_guard.py
- **[H-GUARD-TEST]** `tests/tools/test_skills_guard.py`：专门测试 benign env config read 不应误报，反映扫描器必须控制 false positive。 https://github.com/NousResearch/hermes-agent/blob/main/tests/tools/test_skills_guard.py
- **[H-APPROVAL]** `tools/write_approval.py`：memory/skill 的 write approval gate；后台写不能阻塞交互，改为 durable pending staging，用户之后 approve/reject。 https://github.com/NousResearch/hermes-agent/blob/main/tools/write_approval.py

---

# 2. S1 — 必须修改的问题

## S1-1：P2 `promoteDraft()` 与 P4 archive/revive 依赖 `ctx.fs` 不存在的目录 move

### 现方案

P2 规定：

```text
staging/.drafts/<name> → active/<name>
```

且 `promoteDraft()` 明写“目录移动（ctx.fs）”；P4 又依赖 active/stale/archived 的目录移动完成归档和复活。

### 源码反证

[D-FS] 的 `FileSystem` 抽象类公开的是 12 个能力原语，终点是 `writeText()` / `editText()`；没有 `rename`、`move`、`delete`、`copy`。`fs-local` 内部虽然用 Node `rename` 完成**单次 write 的原子替换**，[D-FS-LOCAL] 也没有把 rename 暴露成 Consumer API。

因此当前函数级规格不是“实现有点难”，而是**按已锁定 DSH capability seam 无法调用**。

### 建议（优先采用）

不要给 `ctx.fs` 添通用 move/delete，也不要继续给 `skill-filesystem` 堆生命周期特例。改成一个 DSH-native 的 **AgentManagedSkillProvider**：

```text
<project>/.dsh/self-evolution/skills/<skillId>/revisions/<revision>/SKILL.md
                                                     /references/...

storageDomain ManagedSkillRecord:
  skillId
  name
  owner
  state = draft|active|stale|archived
  currentRevision
  contentDigest
  revision
  ...
```

- patch：写一个**新 immutable revision**；
- promote：只 CAS 更新 sidecar `state/currentRevision`；
- archive：只 CAS `state=archived`；
- revive：只 CAS `state=active`；
- Provider `list()` **只返回 active**；
- Provider 注册时持有 [D-SKILL] `SkillProviderControl.invalidate()`，sidecar pointer/state 更新后直接 invalidate；
- crash 在“bundle 写完、sidecar pointer 未更新”之间，只留下一个不可见 orphan revision，不会产生半 active skill。

这同时借鉴 Hermes [H-SKILL-MANAGER]/[H-SKILL-USAGE] 的“自治技能必须明确 opt-in/owned”原则，但用 DSH Provider seam 表达，而不是复制 Hermes 的 `.archive` 目录移动。

### 额外收益

可以删除当前计划对 `skill-filesystem` 增加 `ctx.skillMutationObserver` 的 fork-diff；生命周期不再依赖 chokidar/observer；P4 的 archive/revive 也不再碰文件树。

**优先级：S1 / 架构阻塞。**

---

## S1-2：所有 `storageDomain.update()` 首写路径都遗漏了 `missing-key`

### 现方案

P1 `MemoryService.getState()` 规定“key 不存在返回空态”，但 `applyOps()` 直接 `storageDomain.update`；P2 `OwnershipStore.put()`、P3 `ReviewCursorStore.claim()` 也都把 `update` 当成“若无则创建”。

### 源码证据

[D-STORAGE] 明确：`update(key, fn)` 在队列槽位看到 key 不存在时抛 `DomainError('missing-key')`。创建是 `put()` 的职责。

### 后果

最先出现的真实写入很可能直接失败：

- 第一个 project MemoryState；
- 第一个 SkillOwnershipRecord；
- 一个 session 的第一个 ReviewCursor；
- 第一个 ReviewCheckpoint（取决于 ledger 布局）。

### 建议

P0 必须增加 **first-record creation contract** 测试。RC5.2 明确一种方案，而不是让每个 Store 自己猜：

1. 单 Host 前提下，在 Store 内实现 keyed initialization queue；
2. `get → 若无 put(empty) → update` 必须由该 Store 的 per-key serializer 包起来，避免两个首次写者互相覆盖；
3. 或把频繁更新的 state 设计成预先初始化的固定 record（如果 scope 生命周期允许）。

不要伪造一个 DSH 并不存在的 `updateOrCreate()`。

**优先级：S1。**

---

## S1-3：P1 声称的 crash-gap 幂等测试按当前 `expectedBaseRevision` 顺序无法通过

### 现方案

`applyOps(scope, ops, expectedBaseRevision)`：

1. 先校验 `state.revision === expectedBaseRevision`；
2. 再逐 op 查看 `appliedOps[opId]`。

### 反例

```text
base revision = 0
op X 成功 → state revision = 1，appliedOps[X] 已写
进程在 ReviewLedger mark 之前 crash
重启重试 X，仍携带原 base revision = 0
```

当前实现先看到 `1 != 0`，抛 `stale_base_revision`，根本走不到 `appliedOps[X]` 的 duplicate 判断。

这与 P1 写的 `applyops-crash-gap-no-duplicate` 验收目标相冲突。

### 建议

在 **同一个 [D-STORAGE] `update` 回调**里顺序改成：

```text
A. 先判 incoming ops 是否全部已有 receipt
   → 全部已有：直接返回 duplicate results，不受 base revision 影响
B. 仍有未应用 op
   → 再校验 expectedBaseRevision
C. fold 新 op + receipt，同 record commit
```

混合“部分 duplicate + 部分 new”而 base stale 时应整体 reject/replan，避免把旧计划的一部分接到新 state 上。

**优先级：S1。**

---

## S1-4：`applyMemoryOpPure()` 目前并不纯，签名也无法表达文档声称的结果

### 现方案

函数签名是：

```text
applyMemoryOpPure(state, op, config): MemoryState
```

但规格同时要求它：

- add 时“生成新 MemoryEntryId”；
- 设置 `updatedAt`；
- duplicate 时“返回原 resultDigest 的标记”。

### 问题

如果函数内部生成 UUID/读取当前时钟，就不是纯函数；而返回 `MemoryState` 也无法同时承载 per-op result。

这违反总纲“fold/digest/state transition 全为纯函数”的 TDD 纪律。

### 建议

把 Host 权威字段提前生成：

```text
HostMemoryOp {
  opId,
  entryId,        // add 时 Host 先分配，最好由 opId 确定性派生
  now,
  ...
}
```

纯 fold 改成：

```text
foldMemoryOps(state, ops, config): {
  nextState: MemoryState
  results: ApplyOpResult[]
}
```

storage `update` 只负责把 `nextState` commit。

这也更符合 RC5.1 原则 4“模型不拥有权威字段”。

**优先级：S1。**

---

## S1-5：`appliedOps: Record<OpId,...>` 会无限增长，Memory“有界”实际上没有闭环

### 现方案

Memory 对 entries/characters/snapshot tokens 都有硬预算，但 `appliedOps` 不计入任何预算，也没有淘汰策略。

### 源码参照

Hermes [H-MEMORY] 的 Memory 明确是有界长期状态；这不是只控制 prompt，而是防止自我进化状态无限积累。DSH [D-STORAGE] 又是完整 record JSON 持久化，`appliedOps` 每增加一项就永久放大该 record。

### 建议

不要无限保存所有 op receipt。可采用两层防重：

- add 的 `MemoryEntryId` 由 `opId` 确定性派生，天然防重复 create；
- entry 保留 `lastAppliedOpId` / desired digest；
- 另保留一个**有界 recent receipt window**，长度至少覆盖所有未终结 ReviewCheckpoint + 安全余量；
- 只有当 ReviewCursor/ledger 已证明旧 review 永远不会自动重放后才清理 receipt。

P1 增加“1 万次 mutation 后 state 大小有上界”的测试。

**优先级：S1。**

---

## S1-6：`scanContent()` 已写规格，但没有真正接入 Memory 写入和发布的两道边界

### 现方案

P1 定义 `packages/util/content-scan`，但 `MemoryService.applyOps()` 和 `MemoryPublisher.buildSnapshotSections()` 的函数级流程都没有强制调用它。

### Hermes 源码证据

[H-MEMORY] 同时做两层：

1. add/replace/batch **落盘前**扫描；
2. 从磁盘构建注入快照时**再次扫描**，命中条目以 blocked placeholder 进入 prompt，而原存储仍保留以便用户审计/删除。

这是很值得借鉴的 defense-in-depth：即使旁路写、旧版本数据或文件被污染，也不能直接进入模型上下文。

### 建议

RC5.2 把 Memory 安全路径写死：

```text
HostMemoryOp add/update
  → scanContent(strict-memory)
  → reject on blocking finding
  → storage commit

MemoryPublisher
  → read state
  → secondary scan each entry
  → suspicious entry renders [BLOCKED: reason]
  → snapshot
```

同时 `MemoryPublisher` 自己必须 **fail-open for user turn**：snapshot 构建/scan/persistence 异常时记录错误并继续当前模型请求，保留最后一个已发布 snapshot，不能让自我进化副作用卡住主对话。Hermes [H-MEMORY] 明确把“memory side effect 不得压住用户回复”当成运行原则。

**优先级：S1。**

---

## S1-7：P3 “预算超限从旧侧截窗 + cursor 直接 advance 到 throughInclusive”会永久跳过证据

### 现方案

`projectEvents()` 对 `(fromExclusive, throughInclusive]` 超预算时：

> 保留靠近 through 侧，丢旧侧。

而 `runReview()` 完成后 `advance(reviewId, throughInclusive)`。

### 反例

```text
cursor = 80
claim 到 120
预算只容纳 105..120
review 成功
advance 到 120
```

81..104 从未被 reviewer 看过，但 cursor 已把它们永久标为 reviewed。

### 建议

**review high-water 必须只推进连续已审区间。**

优先设计：

```text
cursor 80..120
预算切片 = 81..95（oldest-first）
实际 effectiveThrough = 95
advance → 95
下一轮 = 96..110
...
```

如果希望给模型最近上下文，可以把 111..120 作为 `contextOnly`，明确禁止 evidence 引用，也不影响 high-water。

P0/P3 增加 `truncation-never-skips-evidence-range`。

**优先级：S1。**

---

## S1-8：`ReviewCursor.claim()` 没有“谁取得执行权”的返回语义，且新 desiredThrough 可能丢失

### 现方案

已有 `inFlight` 时“返回现有”。

### 问题 1：重复执行

两个 caller 都拿到同一个 Claim，如果 `runReview()` 没区分 acquired/busy，两边都可能启动 planner。

### 问题 2：后续 due 丢失

inFlight=(80,100] 时又来了 desired=120；若只“返回现有”却没原子 `desiredThroughSeq=max(old,120)`，100 完成后可能不知道还欠 101..120。

### 建议

```text
type ClaimResult =
  | { kind:'acquired', cursor: InFlight }
  | { kind:'busy', inFlight: InFlight, desiredThroughSeq: number }
  | { kind:'nothing-due' }
```

同一次 [D-STORAGE] atomic update 内：

- 永远先 `desiredThroughSeq = max(old, incoming)`；
- 只有从 `inFlight=undefined` → 有值的 caller 得 `acquired`；
- busy caller 不启动 LLM。

**优先级：S1。**

---

## S1-9：ReviewCheckpoint 没有持久化“已验证的不可变 ReviewPlan”，crash 后可能对同一 reviewId 重新问模型得到不同方案

### 现方案

Ledger 保存 status/opStates，但数据模型没有明确保存 canonical plan 本体或 plan digest/payload。

### 后果

如果 planner 已成功输出、Host 已做 admissibility，随后进程在第一项 mutation 前 crash：

- cursor 仍是同一 range；
- recover 若重新 spawn planner，LLM 可能产生另一套 plan；
- 相同 `reviewId` 于是对应两种语义，opId 也可能变化。

### 建议

`planned` 必须成为 durable boundary：

```text
planner output
→ schema parse
→ admissibility/preflight
→ Host canonicalize
→ 写 ReviewCheckpoint.plan + planDigest + base revisions
→ status='planned'
→ 才进入 commit
```

recover：

- `planning` 且无 plan：允许重新 planning；
- `planned/committing`：**只能恢复已保存 plan，禁止再调用模型**。

这是“LLM proposes; Host commits”真正完整的含义：proposal 一旦越过 Host 验证边界，就变成 immutable command plan。

**优先级：S1。**

---

## S1-10：`writableSkills` 只有 summary/digest，无法安全执行 `patch-draft`

### 现方案

ReviewInput 给 planner：

```text
skillId, name, state, revision, digest, summary
```

但 ReviewPlan 又允许模型返回某 skill 的 `files[{path,content}]` patch/replacement。

### Hermes 源码证据

[H-SKILL-MANAGER] 专门增加 background-review read-before-write guard：后台代理修改一个已有 skill 文件前，必须在**当前 review turn 读过确切目标内容**。原因正是不能根据 transcript/摘要猜现状。

### 建议

两种安全方案二选一：

**A. 小 bundle：** ReviewInput 对“允许 patch 的候选”提供受预算约束的 exact current file content；

**B. 更推荐：两阶段 planner：**

1. planner-1 只选择 `patchTarget(skillId)`；
2. Host 加载该 revision 的精确 bundle；
3. planner-2 在 exact content 上输出结构化 replacement/patch。

对于 dedicated AgentManagedSkillProvider，读取 current immutable revision 会更自然。

**优先级：S1。**

---

## S1-11：`saga-partial-plan-commits-admissible-only` 会破坏语义耦合操作

### 现方案

P3 测试要求：一个 plan 内有些 proposal inadmissible 时，仍提交其余 admissible proposal。

### 风险

典型 consolidation：

```text
remove old memory A
add consolidated memory B
```

如果 B 因证据不合格被拒，A 却被单独执行，结果反而丢知识。Skill “先创建 umbrella、再归档旧 skill”也同理。

[D-STORAGE] 又明确没有跨表事务，因此不能假装不同资源天然原子。

### 建议

RC5.2 初版最安全：**preflight 任一 proposal 失败 → 整个 ReviewPlan 不进入 commit**。把拒绝原因写 ledger，让下一次 replan。

未来真需要部分提交，再让模型显式产：

```text
operationGroups[]
```

每组声明 semantic dependency，Host 以 group 为最小 preflight 单位；跨资源仍用 saga/reconciliation，不宣称数据库事务。

Hermes [H-MEMORY] 的 batch 是 all-or-nothing，这里值得借其“先验证最终结果再写”的思想，而不是照搬其文件实现。

**优先级：S1。**

---

## S1-12：`eventAdmissible(event)` 无法判断“assistant/message 仅 final”

### 现方案

P3 写：`assistant/message` “仅 final，作 context”；同时把 `eventAdmissible` 定义为只接收一个 `SessionEvent` 的纯函数。

### DSH 源码证据

[D-SESSION] 的 `assistant/message` 是**每个 step**的 assembled message，数据只有 turn/step/message/usage；没有 `final` 布尔字段。是否是一个 turn 的最后 assistant step，必须结合后续 step/turn 边界判断。

### 建议

不要让单 event predicate 承担上下文性质：

```text
eventKindAdmissible(event)   // 只判类型/source
projectEvents(events, range) // 在完整 range 上识别每 turn 的 final assistant outcome
```

或者直接把 assistant context 构造为 turn fold。

新增测试：多-step tool loop 中只保留真正 turn 结束前最后一个 assistant message 作为 outcome context。

**优先级：S1。**

---

## S1-13：P4 状态机缺少时间锚点，按现有 `OwnershipRecord` 无法计算 zero-use grace / stale→archive

### 现方案

`OwnershipRecord` 只有 owner/state/revision/digest 等；`SkillUsageRecord` 只有 lastModelLoad/lastUserLoad。

但 `transition()` 又需要：

- 从创建多久后才允许 never-used skill stale；
- stale 以后过多久 archive；
- archive/revive 状态变化时间。

### Hermes 源码证据

[H-SKILL-USAGE] 的 sidecar 明确保存 `created_at`、last_used/viewed/patched、state、archived_at；[H-CURATOR] 对 never-used skill 用 creation/activity anchor，而不是把“无 usage timestamp”解释为远古时间。

### 建议

ManagedSkillRecord/OwnershipRecord 增加：

```text
createdAt
promotedAt?
stateChangedAt
staleAt?
archivedAt?
```

并写死 transition anchor：

- active + never used：`max(promotedAt, createdAt)`；
- active + used：`lastMeaningfulUseAt`；
- stale → archived：以 `staleAt` 还是 lastMeaningfulUseAt 为准必须明确；建议以 staleAt 计二次窗口，避免 staleAfter=30、archiveAfter=90 语义混乱。

**优先级：S1。**

---

## S1-14：P4 声称“单迁移原子性由 SkillAuthoringService CAS 保证”不成立；而且 Service 还没有 archive/revive API

### 现方案

P4 `pass-respects-signal` 要求 abort 后无半迁移，并把原因归给 Service CAS；但 P3 的 SkillAuthoringService 只明确了 create/patch plan ops，没有定义 `markStale/archive/revive`。

### 源码约束

- [D-STORAGE] 的 CAS 只能原子提交一个 storage record；不能原子覆盖“文件系统 + sidecar”。
- [D-FS] 又没有 directory move。

所以当前“无半迁移”既没有 API，也没有事务基础。

### 建议

如果采纳 S1-1 的 AgentManagedSkillProvider，问题会大幅简化：

```text
transitionManagedSkill(skillId, from, to, expectedRevision, opId)
```

只更新一个 sidecar record，Provider 是否暴露 skill 由 state 决定；bundle revision 不移动。

这样 active→stale→archived 可以真正成为 storageDomain 单 record CAS，`control.invalidate()` 只是 cache refresh，不是 correctness authority。

**优先级：S1。**

---

# 3. S2 — 强烈建议改进

## S2-1：把 P2 从“改 skill-filesystem”改成独立 AgentManagedSkillProvider

这是本轮最重要的建设性改进，建议直接作为 RC5.2 架构调整，而不是临时 workaround。

### 为什么符合 DSH

[D-SKILL] 已经明确把 skill 来源抽象成 Provider：

- `list()` 返回 candidates；
- `get()` 加载 winning skill body；
- `control.invalidate()` 是 provider 自己的确定性失效通道；
- `rank` 决定同名 precedence。

也就是说，“agent 自治生成的 skill 集合”本来就是一个独立数据源，非常适合成为 Provider，而不是伪装成普通 `.dsh/skills` 文件。

### 推荐 rank

[D-SKILL-FS] 当前：

```text
project-dsh    100
project-agents 200
custom         300
user-dsh       400
...
```

[D-SKILL] lower rank wins。若希望人工 project skill 永远压过自治 skill，可给 managed provider 一个**显式、测试钉死的低优先级 rank（例如 >200）**。具体值不要随口定死，需把 custom/runtime/bundled 的产品优先级一起写表；但核心原则应是：**自治来源绝不比人工 project source 更高优先级。**

### 与 Hermes 的融合

[H-SKILL-MANAGER] 的优点不是“文件放哪”，而是：

- autonomous curation 只写 managed skills；
- provenance/management 标记缺失时 fail-closed；
- 用户拥有的技能不被后台模型碰。

把这个 ownership policy 放在 ManagedSkillProvider/SkillAuthoringService，正好把 Hermes 的治理优点和 DSH 的 Provider seam 结合起来。

---

## S2-2：Skill bundle 结构扫描不应只扫 SKILL.md/文本内容；补齐文件级边界

P2 `files[{path,content}]` 目前主要验证 skill name 和 `validateStructure(bundle)`，但每个 supporting file 的 path、数量、总大小、二进制/符号链接策略没有完整合同。

Hermes [H-GUARD] 的 `scan_skill()` 明确先做 structural checks：file count、total size、binary、symlink，再做文本威胁扫描；这比单纯 regex 更成熟。

建议：

- `files[].path` 必须是 bundle-relative、不可 absolute、不可 `..`；
- 保留 `SKILL.md` 为唯一特权入口，禁止 supporting file 覆盖内部 sidecar/manifest；
- max files / max total bytes / max single file bytes 进 Config；
- 首版只支持 UTF-8 text bundle，binary 明确拒绝（也符合 [D-FS] text-only mutation seam）；
- dedicated provider 路径下用 `ctx.fs.contains(root,target)` 做最终 containment assertion。

---

## S2-3：删除“`${…}` 与 inline shell 一律拒绝”的语法级禁令，改成分级 threat policy

P2 当前把 `${…}` 模板令牌和“内联 shell”整体判 invalid。这个规则安全感强，但会显著误伤真实可复用技能。

Hermes [H-GUARD] **主动扫描 `.sh/.bash`**，说明成熟策略不是“脚本即恶意”；[H-GUARD-TEST] 还专门修正普通 `os.environ.get("MYAPP_CONFIG_DIR")` 之类 benign config read 的误报。

建议将 scanner 输出变成：

```text
Finding { id, severity, category, evidence }
Verdict = safe | caution | blocked
```

- 高置信 prompt injection / exfiltration / hidden unicode → block；
- ordinary shell snippet / `${VAR}` /普通路径 → 不应按语法直接 block；
- 自动生成 skill 本身又**不会被自动执行**，行为 verifier 仍是封闭 adapter，这已经提供第二层安全边界。

Memory scanner 同理：项目事实经常包含路径、环境变量名和命令，不能把这些本身当威胁。

---

## S2-4：同名人工技能冲突测试必须覆盖 flat `.md` 和 frontmatter name

P2 的直接存在检查只写：

```text
<project>/.agents/skills/<name>
```

但 [D-SKILL-FS] 的 discovery 同时接受：

```text
<root>/<dir>/SKILL.md
<root>/<anything>.md
```

且真正 candidate name 来自 parsed content，而不是只来自目录名。

因此至少测试：

- `.agents/skills/foo/SKILL.md`；
- `.agents/skills/foo.md`；
- 文件名与 frontmatter `name:` 不一致但 semantic name 冲突；
- winning candidate 非 managed owner。

若采用 ManagedSkillProvider + rank，shadowing 风险显著下降，但 create 时仍应 fail-loud 提示冲突，而不是默默创建一个永远赢不了/永远遮蔽别人的技能。

---

## S2-5：resume-async / maintenance review 应借鉴 Hermes 的“foreground priority + cancel”

RC5.1 明确 background review 不 mid-turn 改 model-visible memory，这是对的；但 `maybeDispatch()` fire-and-forget 没定义新 live turn 到来时怎么办。

Hermes [H-BG] 已经实现一条很有价值的产品不变式：

> background self-improvement 是非关键工作；新用户 turn 到来时请求取消 review，只有限等待 acknowledgement，超时也立即让 foreground 继续。

DSH 有 `Agent.cancel`、SubagentRun dispose/abort 等 seam。RC5.2 应增加：

- 每 Agent 只允许一个 background review run；
- 新 foreground turn 开始前，取消/终止该 review；
- Cursor 保留未完成 inFlight，之后 recover/retry；
- 取消不算 terminal failure，不推进 high-water；
- `resume-blocking` 模式例外，因为用户明确选择 fresh-before-first-request。

新增 `foreground-preempts-background-review` REAL test。

---

## S2-6：加入 Hermes 式可选 Write Approval/Stage Gate，尤其适合 L1→L2

RC5.1 已有 rollout level，但缺少“这个 deployment/user 是否要求每次自治写先批准”的运行策略。

Hermes [H-APPROVAL] 已经证明一个实用模式：

- memory 小，可 inline review；
- skill 大，stage 后看摘要/diff；
- background thread 不能阻塞交互，所以必须 durable pending。

建议在 **Host validation 之后、resource commit 之前**增加可选 policy：

```text
approvalMode:
  auto
  stage-background
  stage-all
```

PendingChange 存 storageDomain，不需要新 session event。用户 approve 时必须重新检查：

- base revision；
- ownership；
- threat scan；
- conflict；
- current policy version。

这比让审批本身成为 correctness authority 更稳；approval 只是“是否允许执行已验证 plan”的 policy gate。

---

## S2-7：Review failure 需要分类 + bounded retry，避免同一 range 热循环

RC5.1 目前有 `planner_terminal_failure`，但 commit/reconciliation 失败后怎么处理没有完整表。

Hermes [H-MEMORY] 对 consolidation 明确设置 per-turn failure cap，超过后停止 memory 重试，继续用户任务；[H-BG] 也有 review aggregate token budget。

建议 ReviewCheckpoint 增加：

```text
attemptCount
lastFailureCode
nextRetryAt?
```

错误分级：

- **terminal proposal rejection**：`threat_scan_blocked`、`name_conflict...`、inadmissible evidence → 记录 rejected，不无穷重试同一 plan；
- **stale_base_revision**：最多 bounded replan N 次；
- **transient IO/provider**：保留 cursor，指数/固定 backoff；
- **cancelled by foreground**：不计失败，稍后重启；
- 超总次数：`failed-terminal`，不阻塞用户，需显式 re-review 才重启。

---

## S2-8：`maxReviewOutputTokens` 当前是死配置，必须真正接到 AgentOptions

P3 Config 列了：

```text
maxLearningViewTokens
maxReviewTotalTokens
maxReviewOutputTokens
```

但 `startPlanner()` 只传 `agentOptions.model`。

DSH AgentOptions 支持 `maxTokens`（见 [D-AGENT] 相关接口/README）。因此要么：

```text
agentOptions: {
  model,
  maxTokens: config.maxReviewOutputTokens
}
```

要么删除该 Config。`maxReviewTotalTokens` 也必须在函数级规格中明确由哪个 usage observer/controller 累计并在何处 dispose；不能只在配置表存在。

---

## S2-9：P4 usage observer 应明确为 best-effort telemetry，并有异步排队/drain 策略

Hermes [H-SKILL-USAGE] 很值得照抄的是**故障隔离原则**：usage sidecar 写坏不能让真实 skill tool 失败。

RC5.1 的 `onSessionEvent(event): void` 内部却要调用异步 storage update。应明确：

- listener 不把 telemetry Promise 异常抛回 session path；
- 内部 serial queue；
- HMR/dispose 时 drain 或有意丢弃并记录；
- usage 丢失只影响 curator 质量，不影响 skill correctness。

同时 P4 的 `runMaintenance` wording 要改：`runMaintenance()` 不是 scheduler registry，[D-AGENT] 只提供“当前 idle 时运行一个 task”。插件仍需自己的 timer/status/session-event 触发，然后调用它取得 idle ownership。

---

## S2-10：P0 “零产品代码”与“创建完整新包骨架”措辞矛盾

P0 一边说零产品代码，一边要求创建 `session-review` package skeleton（package.json、src/index、README、invariant）。这会触发真实仓库 package/doc/coverage 门槛，本质不是“只有测试文件”。

建议改成：

> P0 **zero behavior change**；允许测试 harness 与未来包骨架，但不得注册任何生产行为/修改 shipped composition。

或者把 Evidence Lock 放到现有 integration/architecture tests 目录，P3 再创建正式 package。

这不影响技术正确性，但会减少 PR 审核歧义。

---

# 4. 其他规格一致性问题

## 4.1 `duplicate_op` 不应列为 ErrorCode

总纲把 `duplicate_op` 放进 `*Error.code` 表；P1 又明确 duplicate 不抛错，而是 `status:'duplicate'` 正常返回。

建议删除 error table 中的 `duplicate_op`，改为 `ApplyOpStatus`。

## 4.2 storage version 错误码命名漂移

P0 T20 期望 upstream `version-mismatch`；总纲统一码又写 `schema_version_mismatch`。

两种都可以，但必须明确：

- 若 Service 直接透传 DomainError：统一使用 `version-mismatch`；
- 若要领域包装：写 `mapDomainError()` 并测试 `version-mismatch → schema_version_mismatch`。

不能文档两种都算“源码已有”。

## 4.3 Shadow 模式推进 high-water 的含义要明确

如果 L0 shadow review 完成后推进 `reviewedThroughSeq`，以后切到 L1 不会自动把历史 proposal 再提交。

这其实可以是正确选择，但必须在 rollout 规格写明：

> **升级不自动 backfill；历史重学只能显式 re-review/migrate。**

否则用户会误以为 Shadow 阶段学到的内容在升级后会自动生效。

---

# 5. 推荐的目标架构：DSH 的 Provider/Session/Service + Hermes 的治理机制

建议 RC5.2 目标图改为：

```text
                         ┌──────────────────────────┐
                         │      Session raw log      │
                         └─────────────┬────────────┘
                                       │
                               deterministic
                                LearningView
                                       │
                                       ▼
                         ┌──────────────────────────┐
                         │   Review Planner (spawn) │
                         │ no inherited business    │
                         │ mutation capability      │
                         └─────────────┬────────────┘
                                       │ ReviewPlan
                                       ▼
                         ┌──────────────────────────┐
                         │ Host validation/preflight│
                         │ evidence / ownership /   │
                         │ version / security       │
                         └─────────────┬────────────┘
                                       │
                            optional Approval Gate
                                       │
                      ┌────────────────┴────────────────┐
                      ▼                                 ▼
          ┌──────────────────────┐          ┌──────────────────────────┐
          │    MemoryService      │          │ SkillAuthoringService    │
          │ storageDomain state   │          │ immutable bundle revision│
          │ resource idempotency  │          │ + sidecar CAS            │
          └───────────┬──────────┘          └────────────┬─────────────┘
                      │                                  │
            next agent/pre-step                          │ invalidate
                      │                                  ▼
                      ▼                     ┌──────────────────────────┐
          durable memory snapshot           │ AgentManagedSkillProvider│
                                            │ list active only          │
                                            │ human skills outrank it   │
                                            └──────────────────────────┘
```

### 这里“借 Hermes”的部分

1. 有界 memory；
2. 写前 scan + model-visible snapshot 二次 scan；
3. 后台 review 不得阻塞 foreground；
4. background autonomous write 必须明确 managed ownership，缺 provenance fail-closed；
5. existing skill 修改前先拿精确当前内容；
6. skill lifecycle：usage / stale / archive / pin / never-delete；
7. LLM consolidation 默认关闭；
8. 可选 write approval + pending staging；
9. telemetry best-effort；
10. retry/token budget 必须有终态。

### 这里“坚持 DSH，不照搬 Hermes”的部分

1. 不让 review LLM 直接调用 memory/skill mutation tools；Hermes 当前 background review 仍会直接写 stores，[H-BG] 明确如此，RC5.1 的 Host commit 更好。
2. 不复制 Hermes `_persist_disabled`/daemon-thread session 模型；使用 DSH durable child session +检索隔离。
3. 不把动态 memory 冻结进 system prompt；使用 DSH `form:'snapshot'` durable source。
4. 不复制 Hermes 的 `.archive` 文件移动；生命周期由 ManagedSkillProvider state 表达。
5. 不把 frontmatter `created_by` 当授权真相；授权元数据在 storageDomain sidecar。
6. 不给 `agent-loop` 加业务逻辑；继续走 Cordis plugin/service/provider seam。
7. 不用正则扫描代替权限边界；scanner 只是 defense-in-depth。

---

# 6. 对 P0–P5 开发计划的建议修订

## P0 — Evidence Lock（扩大到 30+ 项）

保留现有 23 项，再至少增加：

1. **storage `update` missing-key**：证明首 record 不能直接 update；钉死初始化协议。
2. **ctx.fs no-move contract**：明确当前 seam 无 rename/move/delete，防以后实现者误用底层 Node API 绕 seam。
3. **SkillProvider invalidate**：自定义 provider state 改变后 `control.invalidate()` 能让下一次 `ctx.skills.list/get` 看到新状态。
4. **flat skill collision**：`.agents/skills/foo.md` 与 frontmatter name 冲突。
5. **Review truncation contiguous high-water**：预算分片绝不跳 seq。
6. **Cursor acquired/busy**：只有一个 caller 得执行权，后续 desiredThrough 不丢。
7. **blocking order**：resume-blocking review commit 完成 → MemoryPublisher pre-step 看到新 state → 第一次 provider request 含新 snapshot。
8. **background cancellation**：foreground 到来时 review 可取消且 cursor 可恢复。
9. **assistant final derivation**：多 step turn 只投影最终 outcome。
10. 若采用 ManagedSkillProvider：draft/stale/archive 不出 catalog；active 才出；人工同名 winner precedence 固定。

P0 的产物不是“证明我们的方案一定对”，而是**允许测试推翻规格**。这一点现文档已经有很好的纪律，应保留。

## P1 — Memory

在现有 RC5.1 基础上必须补：

- first-record initialization；
- duplicate-before-base-revision 的 retry 语义；
- deterministic entryId/time；
- bounded receipt strategy；
- scanContent 真正接入 write + publish；
- Publisher fail-open；
- storage schema migration/reset command 的实际入口，而不只写政策。

Hermes [H-MEMORY] 的 batch all-or-nothing 和 failure terminalization 可以作为测试案例来源，但持久化仍使用 DSH storageDomain。

## P2 — Skill Authoring

建议改 Phase 目标：

> 从“tool-skill-manage + 修改 skill-filesystem”改为“AgentManagedSkillProvider + AuthoringCore + tool thin consumer”。

删除：

- staging→active directory move；
- `ctx.skillMutationObserver` fork seam；
- archived root move。

新增：

- immutable bundle revision；
- ManagedSkillRecord CAS；
- provider list active only；
- provider invalidate；
- supporting file structural limits；
- flat `.md`/frontmatter conflict tests；
- scanner severity policy。

P2 仍可以先把 AuthoringCore 内聚在 tool package；但 Provider 本身是真实第二个角色，包怎么拆按仓库 package 规则再定，不应为了“少包”把 provider 逻辑埋进工具。

## P3 — Session Review

必须补完：

- contiguous chunking；
- acquired/busy cursor claim；
- immutable persisted validated plan；
- exact current skill content 两阶段 read-before-write；
- whole-plan preflight，而不是随意 partial commit；
- foreground cancellation；
- retry/error taxonomy；
- output token cap 真接线；
- final assistant outcome 的 turn-aware fold。

`session-query` root-only consumer filter仍然可以作为独立 Retrieval Track 前置，但不要把它和 Review correctness 耦合。

## P4 — Curator

如果 P2 改成 ManagedSkillProvider，P4 会明显变简单：

```text
list managed sidecars
→ deterministic transition()
→ SkillAuthoringService.transitionManagedSkill()
→ provider.invalidate()
```

补：

- createdAt/promotedAt/stateChangedAt/staleAt/archivedAt；
- pinned（建议现在就纳入 Record，Hermes 已证明它是必要人工保留阀门）；
- usage telemetry best-effort queue；
- timer/status 触发器 + `agent.runMaintenance(task)`，不要写“注册 runMaintenance 周期 pass”；
- LLM consolidation 继续默认关。

## P5 — Rollout / Effectiveness

现有指标方向好，建议再增加：

- `review_cancelled_for_foreground` 次数；
- retry attempts / terminal failures；
- pending approval accept/reject rate（若启 approval）；
- memory blocked-on-publish 次数；
- orphan skill bundle revisions 数；
- skill provider conflict rate；
- review range lag（`desiredThrough - reviewedThrough`），这是 async 模式是否追得上的核心运营指标。

---

# 7. 建议锁定、不再反复讨论的设计

下列项目已经同时得到 DSH 源码结构和 Hermes 实战经验支持，建议直接进入 Architecture Decision，不再每轮重新辩论：

1. 自我进化业务不进 `agent-loop`。
2. Review LLM 只 proposals；Host commits。
3. Review child 使用 spawn + 受控 input，而不是依赖 parent full-history fork。
4. 模型不能生成 owner/revision/opId/root 等 authority 字段。
5. 动态 Memory 使用 durable `snapshot` source，在 pre-step 发布。
6. Review trigger 是 at-least-once；幂等在 resource boundary。
7. 子代理 session 持久化保留，model-facing session search 默认 root-only。
8. project autonomous first；user-home autonomous write 暂缓。
9. Skill 自动生成先 draft；自动 delete 禁止。
10. 行为验证绝不执行新 skill 自己携带的任意 shell。
11. L0 Shadow 是第一上线级别。
12. LLM curator consolidation 默认关闭。
13. pinned/approval 属于用户治理层，不能由后台模型绕过。

---

# 8. 最终优先级清单

如果只允许在 RC5.1 上做 12 个修改再开工，建议按此顺序：

| 顺序 | 修改 | 原因 |
|---:|---|---|
| 1 | Skill lifecycle 改成 AgentManagedSkillProvider + immutable revisions | 当前 ctx.fs move 方案不可实现，同时一次解决 P2/P4 crash/observer 问题 |
| 2 | 所有 storage Store 增加 missing-key 初始化协议 | 否则首写直接失败 |
| 3 | Memory duplicate 判断移到 stale base check 前 | 否则 crash retry 验收自相矛盾 |
| 4 | 修正 Memory pure fold：Host 分配 id/time，fold 返回 state+results | TDD/幂等契约闭环 |
| 5 | `appliedOps` 有界化 | 防 durable state 无界增长 |
| 6 | Memory scan 接入 write + publish，Publisher fail-open | 防长期 prompt 污染且不阻塞用户 |
| 7 | Review token 分片改为连续 oldest-first，高水位只推进实际 reviewed range | 防永久跳过历史证据 |
| 8 | Cursor `acquired/busy` + desiredThrough max | 防双 planner/丢 due |
| 9 | 把 validated canonical ReviewPlan 持久化在 `planned` boundary | 防 crash 后同 reviewId 重新抽样模型 |
| 10 | patch skill 改为 exact-content read-before-write / 两阶段 planner | 防 summary 基础上盲 patch |
| 11 | P4 补 timestamps + lifecycle Service API | 当前 transition 无数据可算 |
| 12 | foreground 可抢占 background review + bounded retries | 确保 self-improvement 永远次于用户交互 |

---

# 9. 总体评价

RC5.1 已经不再是“概念方案”，而是接近真正可开发的协议/TDD 计划；它最重要的进步，是把长期 mutation 从 LLM tool execution 中剥离出来，把 replay、evidence、idempotency 和 rollout 变成一等概念。

但当前最大的风险也因此发生了变化：

- 不再主要是“模型会不会乱写”；
- 而是**我们为防乱写设计的 Host protocol，是否真的与 DSH 的能力 seam 一致，是否能在 crash/cancel/retry/compaction 下闭环**。

本轮源码复核显示，Memory/Review 方向基本正确，但 Skill lifecycle 仍有明显“Hermes 文件目录思维残留”：`.drafts → active → archive` 很像 Hermes 的文件型 curator，而 DSH 已经提供了更适合表达独立来源与生命周期的 `SkillProvider` seam。**结合两个项目优点的最佳方式，不是复制 Hermes 的物理目录动作，而是把 Hermes 的治理策略放进 DSH 的 Provider/Service 架构。**

因此，本报告建议的 RC5.2 核心不是再造更多 abstraction，而是反过来减少特殊接线：

> **Memory：DSH storageDomain + durable snapshot，借 Hermes 的有界/双重扫描/失败不阻塞。**
>
> **Review：DSH spawn/Session/Cursor，保留 RC5.1 Host commit，并借 Hermes 的 foreground priority 与 bounded budget。**
>
> **Skill：DSH AgentManagedSkillProvider + immutable revisions，借 Hermes 的 managed ownership、pin/archive/approval。**
>
> **Curator：DSH runMaintenance 取得 idle ownership，借 Hermes deterministic lifecycle + LLM consolidation opt-in。**

做到这一步，才是真正“结合 Hermes Agent 与 DSH 的优点”，而不是把两个项目的实现细节拼接在一起。

---

# 10. 源码证据与方案文档对应关系（审阅索引）

| 方案面 | RC5.1 当前规格 | 主要源码证据 | 本报告判定 |
|---|---|---|---|
| Memory snapshot | P1 `form:'snapshot'` + pre-step publisher | [D-LLM] [D-TOOL-SKILL] | 保留 |
| Memory idempotency | P1 `appliedOps` | [D-STORAGE] | 思路保留，修 stale-check 顺序与 receipt 上界 |
| Memory safety | P1 定义 content-scan | [H-MEMORY] | 未接线，必须补 write+publish 双闸 |
| Skill staging/promote | P2 `.drafts → active` move | [D-FS] | 硬错误，当前 seam 不支持 |
| Skill lifecycle storage | P2 sidecar | [H-SKILL-USAGE] [D-STORAGE] | 保留，升级为 managed provider authority |
| Skill invalidation | P2 新 `skillMutationObserver` | [D-SKILL] [D-SKILL-FS] | 可被自有 Provider `control.invalidate()` 替代 |
| Skill ownership | sidecar owner | [H-SKILL-MANAGER] | 保留并 fail-closed |
| Skill scan | P2 blanket syntax reject | [H-GUARD] [H-GUARD-TEST] | 改 severity-based + structural scan |
| Review evidence | LearningView + span | [D-SESSION] | 保留，但 final assistant 要 turn fold |
| Review cursor | per-session high-water | [D-STORAGE] | 保留，修 chunking/claim ownership |
| Review recovery | ledger + resource idempotency | [D-STORAGE] | 保留，需持久化 immutable plan |
| Review background | fire-and-forget | [H-BG] | 增 foreground preemption |
| Curator lifecycle | deterministic transition | [H-CURATOR] | 保留，补时间锚点/Service API |
| Curator scheduling | `runMaintenance` 周期 pass | [D-AGENT] | wording/装配修正：外部触发后调用 runMaintenance |
| Usage telemetry | storageDomain observer | [H-SKILL-USAGE] | 保留，明确 best-effort |
| Write approval | 未实现 | [H-APPROVAL] | 建议作为可选 governance layer |
