# RC5.5 第八轮开工评审

> 评审基线：DSH `cd5ef8148158c3a752a658978873241fdf8e2bbc`；Hermes Agent 本地克隆。
>
> 结论：RC5.5 已经到了"应该开工"的程度。不建议再继续做 RC5.6、RC5.7 式的大规模纯文档迭代。但仍发现 3 组、6 个需要在相应代码落地前补掉的协议缺口。它们不再推翻架构，但其中 Skill 幂等和 Review terminal finalization 两组属于真正的 S1，不能带着现规格直接把 P2/P3 commit path 写到底。

RC5.5 已经把 RC5.4 的六项问题全部正面修入设计：`ManagedSkillRef`、op-derived revision、stale 可见、pending 四字段、scope-aware idempotent Memory ack、`effectiveThrough` 持久化都已经进入正式模型。P0 也已经扩成 61 个活跃 Evidence Lock 测试。

## 一、最重要的新问题：Skill 的 resource receipt 仍未真正达到 Memory 同等级别

RC5.5 现在用：

```text
lastAppliedOpId
```

作为 Skill 的资源 receipt，而且 patch 确实已经实现 duplicate-before-stale。

这解决了最简单的：

```text
A commit
→ crash
→ A 立刻 retry
```

但没有解决真实的跨 session 场景：

```text
Session A:
op A
→ Skill record CAS 成功
→ ledger 尚未来得及完成

Session B:
基于 A 的新 revision
→ op B 又成功
→ lastAppliedOpId = B

Session A 恢复:
→ lastAppliedOpId 已不是 A
→ base revision 已变化
→ stale_base_revision
```

DSH 的 `storageDomain.update()` 确实保证同一 domain write-chain 上的 record RMW 不交错，但它只保证**当前 record mutation 的串行原子性**，不会把 Skill record 与 ReviewLedger 跨资源组成事务。

而 RC5.5 的 ReviewCursor 是 per-session，ManagedSkillService 又是 project/shared，因此这个场景不是理论上的分布式极端情况，而是正常双 session 就可能发生。

### 修法

不要再用：

```text
lastAppliedOpId?: OpId
```

改成和 Memory 对称：

```text
SkillAppliedOps = {
  pendingReceipts: SkillOpReceipt[]
  recentTerminalReceipts: BoundedRing
}
```

例如：

```text
SkillOpReceipt {
  opId
  action
  revisionId?
  resultDigest
}
```

Skill mutation 的单 record CAS 中同时：

```text
修改 current/pending state
+
加入 pending receipt
```

重放：

```text
pending ∪ recentTerminal 命中 opId
→ duplicate
→ 在 base revision 校验之前返回
```

Review attempt terminal 后：

```text
ManagedSkillService.acknowledgeTerminalOps(...)
```

再把 pending → bounded recentTerminal。

**Memory 已经证明了这套模型，Skill 没必要再发明一个弱化版 `lastAppliedOpId`。**

---

## 二、`createDraft()` 仍然没有真正的 same-op crash retry

这是上一个问题的 create 分支。

当前 create 流程是：

```text
checkNameConflict
→ reserveName
→ validate
→ write revision
→ record CAS
```

并把 `lastAppliedOpId=requestedBy` 写进新 record。

但同一个 create op 如果：

```text
record CAS 已成功
→ ledger crash
→ 重放相同 create op
```

会重新进入：

```text
reserveName()
```

而 NameIndex 已经占用，所以得到：

```text
name_conflict
```

而不是：

```text
duplicate
```

更早一点：

```text
reserveName 成功
→ bundle 写一部分
→ crash
```

同进程 retry 也会被 reservation 自己挡住；只有以后 startup reconcile 才可能释放。

### NameIndex 需要知道"谁预留了这个名称"

目前：

```text
name -> skillId
```

不够。

建议：

```text
NameReservation {
  skillId
  reservedByOpId
}
```

所以：

```text
不存在
→ reserve(name, skillId, opId)

已存在 + same opId
→ resume/duplicate-safe

已存在 + different opId
→ name_conflict
```

create 的顺序则改成：

```text
derive deterministic skillId/ref
↓
existing record contains requestedBy receipt?
  yes → duplicate
↓
reserveName(name, requestedBy)
  same op → resume
  other op → conflict
↓
writeRevisionBundle
↓
record CAS + pending receipt
```

这样 create 和 patch 才真正共享同一个：

> **resource-level at-least-once protocol。**

---

## 三、`OpId` 自己还没有被规格钉成稳定 identity

这是我认为 RC5.5 里最容易被实现者忽略的一处。

现在 P3 只写：

```text
stale check
→ opId 分配
→ saga commit
```

但没有任何函数规格说明：

> **相同 immutable ReviewAttempt 在 crash/recovery 后如何得到完全相同的 opId？**

这非常关键，因为 RC5.5 现在把：

```text
ManagedRevisionId
= hash(skillId, requestedByOpId)
```

直接建立在 OpId 稳定性上。

如果实现者用：

```text
crypto.randomUUID()
```

现场分配 opId，那么：

```text
资源 commit
→ crash before markOpState
→ resume stored plan
→ 又生成一个新 opId
```

整个：

```text
revision identity
receipt
duplicate-before-stale
```

一起失效。

### 应正式增加

```text
deriveOpId(
  attemptId,
  resourceKind,
  stableOpIndex,
  canonicalOpDigest
): OpId
```

推荐：

```text
OpId =
hash(
  attemptId,
  resourceKind,
  stableOperationIndex,
  canonicalOperationDigest
)
```

模型**不能**提供 opId。

同一个 immutable plan：

```text
任何次数 recovery
→ 相同 opId
```

最好不依赖额外持久化分配；从 attempt+plan 纯派生即可。

增加 Evidence/TDD：

```text
T62 op-id-stable-across-planned-recovery
T63 changed-op-payload-changes-op-id
```

这一项补完后，op-derived filesystem revision 才真正有可靠的根。

---

# 四、Memory terminal ack 的 P1 已经基本正确，但 P3 现在"ack 哪些 op"写错了

P1 当前协议我认为已经很好：

```text
pending → recentTerminal
already recentTerminal → duplicate ack
nowhere → invalid_structure
```

并且按 `MemoryScope` 分组。

问题出在 P3。

当前写：

> scopeGroups 按 **plan memory op** 的 target/scope 分组。

这个范围太大。

考虑：

```text
plan:
  memory op M1
  memory op M2
```

运行：

```text
M1 commit
M2 尚未执行
→ 后续发生永久失败
→ attempt terminal
```

如果 terminal 时按照 **plan 全量** ack：

```text
ack M1 → 正常
ack M2 → receipt 中不存在
       → invalid_structure
```

这反而把正常 partial-saga terminal 当成 corruption。

同理：

```text
admission rejected
```

的 plan 根本没有任何资源 mutation，更不能 ack plan 中的 op。

### 应改为

ack 的权威输入不是：

```text
ReviewPlan.memory[]
```

而是：

```text
ReviewAttempt.opStates[]
```

只取：

```text
resource == memory
AND state ∈ {
  applied,
  duplicate-confirmed
}
```

的 op。

同理，如果采纳前面的 Skill receipts：

```text
resource == skill
AND applied/duplicate
```

才 ack Skill receipt。

建议把 `opStates` 从现在这个没有正式契约的数组，变成明确类型：

```text
ReviewOpState {
  opId
  resource: 'memory' | 'skill'
  resourceRef
  state:
    | 'prepared'
    | 'applied'
    | 'duplicate'
    | 'failed'
    | 'not-started'
}
```

这样 Ledger 才真的能作为 saga recovery authority。

---

# 五、`terminalAcked` 仍然只是一个字段，没有真正的"完成 finalization"动作

这个问题和前几轮出现过的模式很像：

> **字段存在 ≠ 协议存在。**

RC5.5 数据模型有：

```text
terminalAcked?
```

恢复又依赖：

```text
terminal && !terminalAcked
```

但我全文查了 P3，没有：

```text
markTerminalAcked()
markFinalized()
```

之类的函数或 durable transition。

所以如果严格按当前函数规格实现：

```text
terminalAcked 永远是 false
```

每次启动都会重新 recovery 历史 terminal attempts。

近期还能靠：

```text
duplicate-ack
```

挡住，但 recentTerminal 是 bounded ring；足够久之后旧 receipt 被淘汰，再次 recovery 就会：

```text
neither pending nor recent
→ invalid_structure
```

### 正确做法

我建议干脆把字段改名：

```text
finalized
```

因为真正要表达的不是：

> "Memory receipt ack 过了"

而是：

> "这个 terminal attempt 的所有恢复义务都完成了。"

协议：

```text
markTerminal(status, disposition)
↓
ack only actually-applied resource receipts
↓
idempotent cursor.advance(effectiveThrough) if required
↓
markFinalized(attemptId)
```

Recovery：

```text
terminal && !finalized
→ ack applied receipts
→ idempotent advance
→ markFinalized
```

同时必须增加：

```text
advance-twice-is-noop
```

测试。

否则 crash 在：

```text
advance 成功
→ markFinalized 前
```

时，recovery 仍需安全重复 advance。

---

# 六、这是当前最大的 P3 状态机问题：`terminal` 和"这个 range 可以推进"被错误地混成了一回事

RC5.5 当前 terminal recovery 写：

```text
committed | failed | cancelled
        ↓
全部 advance(effectiveThrough)
```

这个是不成立的。

### 最明显的反例：budget consolidation

当前协议：

```text
attempt A
→ budget_exceeded
→ zero commit
→ 新 attempt B 做 consolidation
```

如果 A 被记录为：

```text
failed
```

然后进程恰好在 B 建立之前 crash：

```text
restart
→ recovery 看 A = failed
→ advance(effectiveThrough)
```

这个 range 就被当成已经学习完成。

B 可能永远没有机会建立。

### stale replan 同理

```text
attempt A stale
→ 应该创建 attempt B 重审相同 range
```

如果 A 的 failed terminal 被 recovery advance：

> 直接把 B 需要复盘的 evidence 消耗掉。

### foreground cancellation 更明显

你此前已经钉死：

```text
planning cancel
→ 清 inFlight
→ 不推进 high-water
```

那么：

```text
cancelled
```

不能天然等于：

```text
consume range
```

---

## 应增加 `RangeDisposition`

例如：

```text
rangeDisposition:
  | 'consumed'
  | 'superseded'
  | 'retryable'
  | 'manual'
```

典型映射：

```text
successful committed
noChange
policy/admissibility rejected（若产品决定不再重试）
    → consumed

stale-base → 新 attempt
budget → consolidation 新 attempt
    → superseded

transient planner failure
foreground planning cancellation
    → retryable

permanent/conflicted terminal
    → manual
```

只有：

```text
rangeDisposition === consumed
```

才能：

```text
advance(effectiveThrough)
```

`superseded/retryable/manual` 都不能由 terminal-recovery 自动推进 high-water。

**这一条我会列为 P3 最后一个真正的 blocker。**

---

# 七、还有一个我建议写进 Known Limitations、但不阻塞开工的边界

RC5.5 的 crash recovery 最好明确写：

> 首版 crash model = **Host/process crash + restart**。

DSH 固定 commit 的 local FS 写入确实是：

```text
private staged file
→ write
→ fsync file
→ atomic rename / no-replace publication
```

`createIfAbsent` 本身也有明确 no-overwrite 语义。

但不要进一步把 RC5.5 的测试结论宣传成：

> power loss / kernel crash / storage-controller failure 下的完整分布式事务保证。

这不是当前项目需要解决的问题，写清 crash model 即可，不应因此拖延 P0–P4。

---

# 最终裁定

与 RC5.4 不同，这次我的结论是：

## **可以正式开工。**

而且建议**停止继续做 RC5.6 大版设计评审**。

但不是说"RC5.5 逐字冻结"。

我建议把状态写成：

> **RC5.5 = Architecture Frozen / Implementation Approved, with six mandatory protocol patches.**

也就是：

| Phase | 裁定 |
|---|---|
| **P0 Evidence Lock** | **GO，立即开工** |
| **P1 Memory** | **GO** |
| **P2 Managed Skill** | **GO，但先写 receipt/create/opId 三组红测试，再写 mutation path** |
| **P3 Review** | **GO 做骨架/纯函数；finalization commit path 必须先补上述 3 个 P3 协议** |
| **P4 Curator** | **GO after P3** |
| **P5** | 按原计划 |

P0 目前 61 个测试已经足以成为实际源码探索的入口。

---

## 我建议把最后 6 项直接变成 T62–T67

这样**不要再出 RC5.6 文档套件**，而是直接在代码里红灯：

```text
T62 op-id-stable-across-planned-recovery

T63 create-same-op-reservation-and-record-retry

T64 skill-receipt-survives-later-same-skill-op
     // A receipt 不会被 B 覆盖

T65 terminal-ack-only-applied-opstates

T66 terminal-finalization-is-idempotent
     // ack + advance + finalized
     // crash injection at every boundary

T67 terminal-status-does-not-imply-range-consumption
     // stale/budget/cancel 不得错误 advance
```

其中 **T64 最重要**。

因为 DSH 的 storageDomain 确实给你的是"一个 domain 上按 write chain 串行的 record update"，而不是"Resource + ReviewLedger 的跨资源事务"。所以长期运行时必须由 receipt protocol 自己承受跨 session / crash gap，而不能靠"当前 record 最后是谁写的"推断历史是否已经发生。

---

## 成熟度判断

| 维度 | RC5.5 |
|---|---|
| 总体架构 | **9.5/10** |
| DSH 原生插件契合度 | **9.5/10** |
| Memory 协议 | **9/10** |
| Managed Skill trust/visibility | **9/10** |
| Skill crash 幂等 | **7.5/10 → 补 receipt 后约 9.5** |
| Review saga/recovery | **8/10 → 补 finalization/disposition 后约 9.5** |
| Hermes 优点吸收 | **9/10** |
| 开工准备度 | **是** |

核心的九条原则、包边界、数据流、Provider 模型、Memory snapshot、Skill visibility、治理面已经不值得继续推翻。

**所以我这轮的建议不是"再完善方案再开工"，而是"现在开工，用 T62–T67 把最后六个协议问题变成代码级红测试"。**

从这个版本开始，后续发现的问题默认应该进入：

```text
bug / invariant test / implementation adjustment
```

而不再自动升级成：

```text
RC5.6 / RC5.7 架构重写
```

除非 P0 REAL-composition 测试真的反证了某个 DSH API 基础假设。
