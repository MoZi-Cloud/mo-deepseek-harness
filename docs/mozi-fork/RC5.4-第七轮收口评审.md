# RC5.4 第七轮收口评审

> 评审基线：DSH `cd5ef8148158c3a752a658978873241fdf8e2bbc`；Hermes Agent `05c248d8`/对应当前源码。
>
> 结论先说：RC5.4 已经非常接近可以开工，但我还不建议把它直接冻结成完整 implementation candidate。它已经越过"架构反复推翻"的阶段；现在我只看到 6 个仍应在正式写 P1/P2/P3 前修掉的承重问题，其中 4 个集中在 P2 Skill，2 个在 Memory/Review crash recovery。

RC5.4 已经正确落下了第六轮的核心修复：Memory 单 Service + composite publisher、Skill 唯一 domain owner、storage-only catalog、pendingRevision、rejected/reopen、live usage、AttemptId 简化、receipt 二分等。当前 TDD 总纲也已经把唯一 ownership 与 P0→P5 阶段门写得比较完整。

## 还剩下的 6 个严重问题

### 1. **P2 的 ProjectKey 有了，但很多 Store/Authoring API 仍然只收 `skillId`，实际上无法定位项目**

这是我认为当前**最直接的实现阻塞**。

RC5.4 已经规定 storage key 是：

```text
skill/<projectKey>/<skillId>
```

但 Store API 却还是：

```text
getRecord(skillId)
readRevision(skillId, revision)
```

而 patch 又是：

```text
patchDraft({ skillId, ... })
```

问题在于：

```text
SkillId = hash(ProjectKey, normalizedName)
```

是单向 hash，你拿着 `skillId` **无法反推出 projectKey**；同时 filesystem revision 又位于具体 project root 下。

所以：

```text
getRecord(skillId) 到底查哪个 skill/<projectKey>/<skillId>？
```

现在规格没有答案。

### 建议

不要到处只传裸 `SkillId`，定义：

```text
type ManagedSkillRef = {
  projectKey: ProjectKey
  skillId: SkillId
}
```

以及运行时：

```text
type ResolvedProject = {
  projectKey: ProjectKey
  rootPath: string
  rootTarget: FsTarget
}
```

然后：

```text
getRecord(ref)
readRevision(project, skillId, revisionId)

patchDraft({
  project,
  skillId,
  ...
})
```

Provider 已经有 `options.cwd + locator.projectKey`，这个方向与 DSH 原生 workspace-sensitive lookup 完全一致。DSH `SkillRegistry.get()` 本来就是用 `cwd + scope` 重新 collect，再把选中的 opaque candidate 交回 provider。

这个必须在 P2 开工前修。

---

### 2. **Skill 的 resource-level idempotency 事实上还没有实现**

RC5.4 的 P3 已经承诺：

```text
skill-committed-ledger-mark-crash-reconciles
```

以及：

```text
resource-level idempotent commit
```

但 P2 的 `requestedBy: OpId` 目前只是参数，流程里根本没使用；主数据模型虽然还留着 `lastAppliedOpId?`，P2 的函数规格却没有任何 duplicate-before-stale 逻辑。

于是：

```text
patch(base=N, op=X)
  ↓
bundle + record CAS 成功
  ↓
进程在 ledger mark 前 crash
  ↓
恢复后重跑 op=X
  ↓
record 已经不是 base=N
  ↓
stale_base_revision
```

这并不是幂等恢复。

Memory 已经正确做了：

```text
duplicate receipt check
→ before stale-base check
```

Skill 也需要类似的资源边界 receipt。

### 更严重的是 revision 路径还有并发覆盖风险

目前 patch：

```text
读取 N
→ 写 revisions/N+1
→ 最后才 CAS record
```

两个并发作者可能都先写 `N+1`，然后才由 record CAS 决出 winner。

而 DSH `ctx.fs.writeText()` 在不提供 intent 时明确是：

> **unconditional create-or-overwrite**。

它已经提供真正需要的：

```text
{ kind: 'createIfAbsent' }
```

用于拒绝覆盖现有 immutable target。

### 我更推荐彻底解决

不要再把 immutable bundle revision identity 设计成简单的 `N+1`。

改成：

```text
ManagedRevisionId =
hash(skillId, requestedByOpId)
```

例如：

```text
revisions/<revisionId>/SKILL.md
```

这样：

- 并发 op → 不同目录；
- crash retry 同 op → 同一 revisionId；
- `createIfAbsent` 防覆盖；
- 已存在且 digest 相同 → reconcile 为 duplicate；
- 已存在但 digest 不同 → fail-loud corruption；
- record CAS 决定哪个 revision 真正成为 current/pending；
- loser 自然只是 orphan。

这会让 RC5.4 的"immutable revision"真正成立。

这是第二个 **P2 blocker**。

---

### 3. **`stale` 状态现在实际上无法 revive**

RC5.4 Provider 明确：

```text
只 list state === 'active'
```

但 Curator 又设计：

```text
active → stale
stale → active
条件：stale 后重新 meaningful use
```

这两者不能同时成立。

DSH `skill` tool 每次调用前都会重新：

```text
ctx.skills.list(...)
ctx.skills.get(...)
```

skill 不在当前 winning catalog 就直接：

```text
"unknown or no longer available"
```

因此一旦：

```text
active → stale
→ invalidate()
→ provider 不再 list stale
```

这个 skill 就基本没有正常路径再次被调用。

于是：

```text
stale → active on meaningful use
```

成了死分支。

Hermes 的实现这里反而值得直接借鉴：**stale 只是 telemetry/lifecycle sidecar 状态，skill 文件仍留在正常位置；真正 archive 时才移到 `.archive/`。** 它因此还能检测 stale 后重新发生使用并 re-activate。（GitHub 脚注 [1]）

### 建议

Provider 可见规则改成：

```text
visible:
  active
  stale

hidden:
  draft
  rejected
  archived
```

即：

```text
record.state === 'active' || record.state === 'stale'
```

`stale` 只是"进入归档倒计时"，不是隐藏状态。

这个修改很小，但必须在 P2/P4 定义时改掉。

---

### 4. **`pendingRevision` 没有自己的 `catalogSummary`，可见性分离还没有真正闭环**

现在数据模型：

```text
currentRevision
contentDigest
pendingRevision?: {
  revision,
  digest
}
catalogSummary
```

问题来了。

active skill patch 新 revision 时，新的 SKILL.md 可能同时修改：

```text
description:
when-to-use:
invocation:
```

即新的 catalog metadata。

但 pending 只有：

```text
revision
digest
```

没有：

```text
pendingCatalogSummary
```

那么只能二选一：

#### 如果 patch 时更新 `catalogSummary`

就违反：

> pending 未 approve 前模型不可见。

catalog 已经提前变化。

#### 如果 patch 时不更新

approve 时：

```text
activatePending()
```

规格只写：

```text
currentRevision = pendingRevision
clear pending
```

新的 catalog summary 没有数据可以原子切换。

### 建议

直接改：

```text
pendingRevision?: {
  revisionId: ManagedRevisionId
  contentDigest: string
  catalogSummary: CatalogSummary
  createdByOpId: OpId
}
```

approve 的单 record CAS：

```text
currentRevision = pending.revisionId
contentDigest = pending.contentDigest
catalogSummary = pending.catalogSummary
pendingRevision = undefined
```

这才真正符合 RC5.4 新增的：

> **Visibility is a separate commit.**

另外还有一个 list→get race：

DSH 会把 **list 时的 candidate** 原样交回 `provider.get(candidate)`。

所以 `get(candidate)` 不应再读取"当前 sidecar catalogSummary"来组成旧 candidate 对应的 definition。

否则：

```text
list 得到 revision N
approve N+1
get(old candidate N)
```

会变成：

```text
body = revision N
summary = revision N+1
```

推荐：

> definition 的 summary/invocation 字段直接使用 `candidate` 中已经冻结的值；filesystem 只提供 candidate.locator 对应的 body。

这是第三个 **P2 blocker**。

---

### 5. **Memory receipt 的 terminal ack 缺少 scope，而且 ack 本身还不是可重试的**

当前：

```text
acknowledgeTerminalOps(opIds)
```

但 MemoryState 是按：

```text
project A
project B
user
```

分别存储的。

即使现在 L1 只有 project，也可能同时有多个 project memory record。

只给：

```text
opIds
```

MemoryService 怎么知道应该修改：

```text
projectKey A 的 MemoryState
```

还是：

```text
projectKey B？
```

所以当前 API 本身缺信息。

### 应改成

```text
acknowledgeTerminalOps(
  groups: readonly {
    scope: MemoryScope
    opIds: readonly OpId[]
  }[],
)
```

P3 本来就知道每个 memory proposal 的 target/scope，因此可以按 scope 分组。

#### 还有第二层 crash gap

当前：

```text
markTerminal
→ acknowledgeTerminalOps
```

如果 ack 成功：

```text
pending → recentTerminal
```

然后在 ledger 记录 `terminalAcked=true` 前 crash，恢复时必须能够再次 ack。

但现在 `splitReceipts()` 规定：

```text
terminalOpIds ⊄ pending
→ invalid_structure
```

也就是说**第二次 ack 反而会失败**。

这违反了整个系统最核心的 at-least-once 恢复原则。

### 正确语义应该是

```text
op in pending
→ move to recentTerminal

op already in recentTerminal
→ duplicate ack, success

op nowhere
→ corruption / invalid_structure
```

然后 ReviewAttempt：

```text
status = terminal
terminalAcked = false
  ↓
ack
  ↓
terminalAcked = true
```

启动 recovery 必须优先重放：

```text
terminal && !terminalAcked
```

之后才能接受新的 review mutation。

RC5.4 主数据模型已经留了 `terminalAcked?` 字段，但 P3 函数规格目前还没有把这条恢复协议真正写出来。

这个是 **P1/P3 小 blocker**，但很好修。

---

### 6. **`effectiveThrough` 没有持久化，terminal 后、cursor.advance 前 crash 时 high-water 恢复不完整**

当前：

```text
projectEvents()
→ effectiveThrough
```

只有运行时值。

但：

```text
ReviewAttempt
```

的数据模型并没有它。

考虑 crash：

```text
claimed range = (100, 200]
budget 实际只审到 effectiveThrough=143
↓
所有 mutation commit
↓
markTerminal
↓
crash
↓
还没 cursor.advance(143)
```

恢复后必须回答：

> high-water 应推进到 143 还是 200？

推进 200 会重新引入之前已经修过的：

```text
永久跳过 144–200 evidence
```

问题。

可以重新计算 LearningView，但这又依赖当时：

```text
budget Config
projection config
token estimator
context policy
```

而 Attempt 已经是一个 durable execution artifact，没必要重新猜。

### 建议

ReviewAttempt 持久化：

```text
effectiveThrough: number
```

在 LearningView 确定以后、planner 开始以前记录。

恢复 terminal attempt：

```text
terminal
+ effectiveThrough
→ finish ack
→ cursor.advance(effectiveThrough)
→ clear inFlight
```

这是一项很小但必要的 crash recovery 补丁。

---

# 所以：到底能不能开工？

我的判断是：

## **P0：可以，现在就开工**

而且我反而建议**不要再停下来写一版完整 RC5.5 再开始 P0**。

P0 的定位本来就是 zero behavior change Evidence Lock。现在已经有 53 项活跃测试，而且明确规定发现事实不符就先改规格再进入 P1。

可以直接开始。

我建议给 P0 再补 6–8 个测试：

```text
T54 stale-skill-remains-discoverable
T55 immutable-revision-create-if-absent
T56 concurrent-patch-never-shares-revision-path
T57 skill-op-retry-duplicate-before-stale
T58 memory-terminal-ack-scope-and-retry
T59 terminal-recovery-uses-effective-through
T60 pending-catalog-switches-only-on-approve
T61 provider-get-uses-listed-candidate-summary
```

---

## **P1：基本可以开工，但先改两个签名**

只需先定：

```text
acknowledgeTerminalOps(scopeGroups)
```

以及：

```text
effectiveThrough / terminalAcked recovery protocol
```

Memory 本身的主体：

- 单 Service；
- composite Publisher；
- snapshot；
- sanitize→render；
- hard budget；
- pending/recent receipt；

我已经没有看到需要推翻的结构性问题。

所以：

> **P1 可以视为 Ready after minor spec patch。**

---

## **P2：暂缓几小时级别的规格修补后再开**

不是重构，只要先解决四件事：

1. `ManagedSkillRef / ResolvedProject`，不要裸 skillId；
2. revision path 改为 op-derived immutable RevisionId + `createIfAbsent`；
3. provider 显示 `active | stale`；
4. pending revision 一并保存 catalogSummary，并阻止 pending 未处理时再次 patch。

另外给 Skill resource 自己补 op receipt / duplicate-before-stale。

完成后：

> **P2 可以正式开工。**

---

## **P3/P4：不需要现在继续设计到更深**

等 P1/P2 的真实代码和 P0 REAL tests 出来再做。

这是现在非常重要的转折。

前几轮继续静态评审收益很高，因为一直能发现 API 契约硬错误；RC5.4 到这里已经不一样了——剩余大量问题，应该通过：

```text
REAL composition
crash injection
concurrency injection
HMR disposal
snapshot
```

在代码里发现，而不是继续把文档从 RC5.4 推到 RC5.9。

---

# 我会把 RC5.4 的成熟度这样评价

| 维度 | 评价 |
|---|---|
| 插件边界 | **成熟** |
| DSH Service/Provider 适配 | **成熟** |
| Memory 架构 | **接近冻结** |
| Skill trust boundary | **成熟** |
| Skill lifecycle | **还有 stale 可见性错误** |
| Skill crash/idempotency | **还有一个重要缺口** |
| Review ordering | **成熟** |
| Review crash recovery | **差 effectiveThrough/terminal ack 两个小闭环** |
| 用户治理 | **方向成熟，pending metadata 要补** |
| Curator | **修 stale 后可实施** |
| Rollout/P5 | **足够开工** |

### 最终结论

**我现在会批准项目开工，但不是"全 Phase 一起写"。**

建议正式把决策写成：

> **RC5.4 = Architecture Approved / Implementation Conditionally Approved.**
>
> P0 立即开始；P1 在修 terminal-ack scope/recovery 后开始；P2 在修 ManagedSkillRef、immutable RevisionId、stale visibility、pending catalog + skill op idempotency 后开始。P3/P4 必须等待 P0–P2 的 REAL behavior tests，不再继续纯文档前推。

这是与前几轮最大的区别：**现在已经到了"代码比继续写设计文档更能发现问题"的阶段。**

RC5.4 的核心九原则已经足够稳定，尤其 `LLM proposes; Host commits`、read-boundary trust 和 `Visibility is a separate commit`，我不建议再动。

如果把上面 6 个问题先打一个小补丁，不用大改，成为 5.5 版本，我会认为它达到了真正可以按 TDD 全面进入实现的程度。

[1]: https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_usage.py "hermes-agent/tools/skill_usage.py at main · NousResearch/hermes-agent · GitHub"
