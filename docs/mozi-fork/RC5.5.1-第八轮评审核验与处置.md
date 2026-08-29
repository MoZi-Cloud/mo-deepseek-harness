# RC5.5.1 第八轮评审核验与处置

> 评审对象：`RC5.5-第八轮开工评审.md`（针对 RC5.5 套件的第八轮外部评审，6 项缺口 + crash model 边界）。
>
> 核验基线：DSH `cd5ef8148158c3a752a658978873241fdf8e2bbc`（`storage-domain`、`fs-local` 源码复核）；RC5.5 全套设计文档逐条比对。
>
> 结论：**6 项缺口全部证实**，其中第四、六项指认的是 RC5.5 文本里的真实错误（ack 按 plan 全量分组；terminal-recovery 对 `failed|cancelled` 一律 advance）；评审给出的修法有 **4 处需修正/补全后采纳**（§2）。阶段裁定采纳：**RC5.5.1 = Architecture Frozen / Implementation Approved**——P0/P1 即刻 GO；P2 先红 receipt/create/opId 三组测试再写 mutation path；P3 骨架与纯函数 GO、finalization commit path 前置三项协议；P4 after P3；P5 按原计划。自此停发 RC5.6 式文档套件，后续发现默认按 bug / invariant test / implementation adjustment 处理。

## 总判断

| # | 评审主张 | 判定 | 关键证据 |
|---|---|---|---|
| 1 | `lastAppliedOpId` 单槽 receipt 挡不住跨 session 窗口 | **确认（S1）** | RC5.5-P2 资源 receipt 条目；cursor per-session（方案 L46）vs Service project 共享 |
| 2 | `createDraft` 同 op 重放撞 `name_conflict` | **确认（S1）** | RC5.5-P2 createDraft 流程；`NameIndex{nameToSkillId}` 无 op 归属 |
| 3 | `OpId` 稳定性无规格 | **确认（S1，波及面比评审所说更大）** | P3 仅"opId 分配"四字；`ManagedRevisionId = hash(skillId, requestedByOpId)`（RC5.5-P2）悬空 |
| 4 | P3 ack 按 plan 全量分组 | **确认（RC5.5 文本错误）** | RC5.5-P3 L53/L66"按 plan memory op 的 target/scope 分组" |
| 5 | `terminalAcked` 无 writer、无 finalization 动作 | **确认** | 全套文档无 `markFinalized`/`markTerminalAcked`；ring 有界 → 延时引爆 |
| 6 | terminal ≠ range consumed | **确认（P3 最重 blocker）** | RC5.5-P3 L68 recovery 对 `committed\|failed\|cancelled` 一律 advance |
| 7 | crash model 应写 Known Limitations | **确认（采纳，内部描述经源码证实）** | `fs-local/src/fsio.ts:546-594` staged temp + atomic rename |

## 1. 逐项核验与处置

### S1-1 Skill 单槽 receipt —— 确认，采纳（与 S1-4 修法互锁）

`lastAppliedOpId` 是单槽：session A 的 op A 落 record（receipt=A）后、ledger mark 前 crash；session B 基于 A 的新 revision 提交 op B（receipt=B）；A 恢复重放 → 单槽已是 B → 落到 base 校验 → `stale_base_revision`。已发生的 op 被当成未发生。cursor per-session（方案 L46）而 ManagedSkillService project 共享——双 session 正常并发即触发，非极端场景。storageDomain `update` 只保证单 record RMW 串行（T07），不构成 Resource+Ledger 跨资源事务——评审对 DSH 语义的判断准确。

**处置**：退役 `lastAppliedOpId`，`ManagedSkillRecord` 改带 `appliedOps: SkillAppliedOps { pendingReceipts, recentTerminalReceipts }`，`SkillOpReceipt { opId, action, revisionId?, resultDigest }` 与 Memory 对称；单 record CAS 同时落 state + pending receipt；重放查重 `pending ∪ recentTerminal` 命中即 duplicate（先于 base 校验）；新增 `ManagedSkillService.acknowledgeTerminalOps(groups: { ref, opIds }[])`（terminal 后 pending → 有界环）。**互锁修正**：ack 输入必须来自 §S1-4 修正后的 applied-only `opStates`——只采纳本项而不采纳第四项，partial-saga 的 ack 会把"从未执行"的 opId 递给 Service，`invalid_structure` 误报依旧。

### S1-2 createDraft 同 op 重放 —— 确认，采纳

两个子场景均成立：(a) record CAS 后 ledger 前 crash，重放 create 重新走 `reserveName` → NameIndex 已占 → `name_conflict` 而非 duplicate；(b) reserve 成功后 bundle 部分写入 crash，同进程 retry 被自己的 reservation 挡死，只能等 reconcile 释放。

**处置**：`NameIndex` 值改 `NameReservation { skillId, reservedByOpId }`——`reserve(name, skillId, opId)`：不存在 → 占位；同 opId → resume（幂等重入）；异 opId → `name_conflict`。create 流程重排：derive 确定性 skillId/ref → record 存在且 receipt 命中 requestedBy → duplicate → `reserveName(…, requestedBy)`（同 op resume / 异 op conflict）→ `writeRevisionBundle`（完成标记协议吸收部分写入）→ record CAS + pending receipt。create 与 patch 自此共享同一资源级 at-least-once 协议。

### S1-3 OpId 稳定性 —— 确认，采纳（波及面补全）

P3 仅写"opId 分配"，无任何派生规格；而 RC5.5 的 `ManagedRevisionId = hash(skillId, requestedByOpId)`、receipt 查重、`deriveEntryId(opId)` 全部悬在其上。若实现者现场 `randomUUID()`：资源 commit → markOpState 前 crash → resume stored plan → 新 opId → revision identity / receipt / duplicate-before-stale **一起失效**。**评审未点破的补充**：Memory 同样中招——P1 的 receipt 查重与 `deriveEntryId(opId)` 隐含 opId 重放稳定；随机 opId 下 memory 重放不是 duplicate 而是**重复写入条目**。修复是全局的，不只救 Skill。

**处置**：新增纯函数规格 `deriveOpId(attemptId, resourceKind, stableOpIndex, canonicalOpDigest): OpId = hash(四元组)`——从 immutable attempt + plan 纯派生，不依赖持久化分配器，模型不提供 opId；同一 plan 任意次 recovery 同 opId；payload 变化 → opId 变化（T63 钉 canonicalOpDigest 参与）。副作用修正：`MemoryEntryId` 随之跨恢复稳定。

### S1-4 ack 输入按 plan 全量 —— 确认（RC5.5 文本错误），采纳

RC5.5-P3 两处（§3 markTerminal、§4 runReview）写"按 **plan memory op** 的 target/scope 分组"。partial-saga（M1 applied、M2 未执行 → terminal）按 plan 全量 ack → M2 两无 → `invalid_structure`，把正常 partial terminal 误判 corruption；admission 拒绝的 plan 零 mutation，更无可 ack 之物。

**处置**：ack 权威输入改为 `ReviewAttempt.opStates[]`，仅取 `state ∈ {applied, duplicate}` 的 op（resource=memory → MemoryService 分组 ack；resource=skill → ManagedSkillService 按 ref 分组 ack）；`opStates` 升格为正式类型 `ReviewOpState { opId, resource: 'memory'|'skill', resourceRef, state: prepared|applied|duplicate|failed }`（ledger 缺席 = not-started，不入枚举）——Ledger 自此是 saga recovery authority。

### S1-5 terminalAcked 无 finalization —— 确认，采纳（改名 finalized）

全套文档确无 `markFinalized`/`markTerminalAcked`：字段无 writer，recovery 每次启动都重放全部历史 terminal attempt；近期靠 duplicate-ack 挡住，ring 有界——足够久后旧 receipt 被淘汰，重放命中"两无"→ `invalid_structure`，恢复永久失败（延时引爆）。

**处置**：字段改名 `finalized`（语义 = 本 terminal attempt 的全部恢复义务完成，非"memory ack 过"）；协议定序 `markTerminal(status, rangeDisposition) → ack applied receipts（memory + skill）→ advance（仅 disposition=consumed，见 S1-6）→ markFinalized(attemptId)`；recovery 入口改 `terminal && !finalized`；`advance` 钉单调 `reviewedThroughSeq = max(old, effectiveThrough)`（advance-twice-is-noop，T67 覆盖 crash 于 advance 与 markFinalized 之间的重放）。

### S1-6 terminal ≠ consumed —— 确认（P3 最重 blocker），采纳（L1 映射修正）

RC5.5-P3 L68 recovery 对 `committed|failed|cancelled` 一律 advance——三个反例全部成立：budget consolidation 的 attempt A（failed）在 B 建立前 crash → advance 吞掉 range → consolidation 永不发生；stale replan 同理消耗 B 待复盘 evidence；foreground cancellation 的既有钉死语义（planning cancel 清 inFlight 不推进，T39）与"cancelled 即 consume"直接矛盾。

**处置**：`ReviewAttempt` 增加 `rangeDisposition: consumed | superseded | retryable | manual`（`markTerminal` 时落账）；**只有 `consumed` 允许 advance(effectiveThrough)**；terminal-recovery 对非 consumed：ack applied receipts + 清 inFlight + markFinalized，**不推进**——range 由下次触发重 claim（at-least-once，宁重审不跳审）。**映射修正（L1 保守定向）**：consumed 仅限 committed（含 noChange）；stale-base / budget → superseded；其余失败（含 planner 瞬态、admission/policy 拒绝）→ retryable（`attemptCount`/`nextRetryAt` 背退）——评审把"policy/admissibility rejected → consumed"挂了"若产品决定不再重试"括号，L1 不采纳该分支：零 commit 的拒绝重审可能因 base state 变化产出不同 plan，静默 advance 有跳过 evidence 风险，与 `saga-range-never-skips` 冲突；`manual` 预留（L2/governance 生产者，L1 无产生点）。

### S1-7 crash model Known Limitations —— 确认，采纳

`fs-local` 写路径经源码证实为 staged temp file + atomic rename 发布（`fs-local/src/fsio.ts:546-594`），`createIfAbsent` no-overwrite 语义在案（`fs/fs/src/types.ts:118-125`）。首版 crash model = Host/process crash + restart；不声称 power loss / kernel crash / storage 故障下的分布式事务保证。写入 P3 README Known Limitations 与方案非目标。

## 2. 评审中需修正/补全后采纳的部分

1. **修正一（S1-6 映射）**："policy/admissibility rejected → consumed"不进 L1 映射（评审自带"若产品决定不再重试"前提）。L1 只有 committed/noChange → consumed；拒绝类 → retryable 背退。理由：零 commit 拒绝的 range 重审合法，advance 即违反 `saga-range-never-skips`。
2. **修正二（T 编号）**：评审两处清单对 T63 定义冲突（§三 = changed-op-payload；最终清单 = create-retry）。取全集 **T62–T68 七项**：op-id 稳定、payload 敏感、create 重放、skill receipt 存活、applied-only ack、finalization 幂等（含 advance-twice）、disposition 不误 advance。P0 = **68 活跃 + 2 历史**。
3. **修正三（互锁）**：S1-1 的 skill ack 与 S1-4 的 applied-only 输入必须一并落地（见 §S1-1 处置）。
4. **补全（S1-3 波及面）**：deriveOpId 同时是 Memory receipt/EntryId 重放稳定性的根——评审只点了 Skill；本补丁把两资源统一钉在同一派生规则下。

## 3. P0 新增证据测试（T62–T68）

| 测试 | 钉住的事实 | 来源 |
|---|---|---|
| T62 `op-id-stable-across-planned-recovery` | 同一 immutable plan 任意次 recovery → 相同 opId（deriveOpId 纯派生） | S1-3 |
| T63 `changed-op-payload-changes-op-id` | canonicalOpDigest 参与 hash；payload 变 → opId 变 | S1-3 |
| T64 `create-same-op-reservation-and-record-retry` | create 同 op 重放：record receipt 命中 → duplicate；仅 reservation → resume；异 op → `name_conflict` | S1-2 |
| T65 `skill-receipt-survives-later-same-skill-op` | op A 落账后 op B 同技能落账，A 重放仍 duplicate 不报 `stale_base_revision`（receipt 集非单槽） | S1-1 |
| T66 `terminal-ack-only-applied-opstates` | ack 输入 = opStates applied/duplicate；partial-saga 与零 mutation terminal 均不误报 `invalid_structure` | S1-4 |
| T67 `terminal-finalization-is-idempotent` | ack → advance（单调 max-guard）→ markFinalized 全链各边界 crash 注入重放安全 | S1-5 |
| T68 `terminal-status-does-not-imply-range-consumption` | superseded/retryable/manual 一律不 advance；仅 consumed 推进且用持久化 effectiveThrough | S1-6 |

## 4. 阶段门裁定（采纳评审框架）

**RC5.5.1 = Architecture Frozen / Implementation Approved**：九原则与包边界冻结；本补丁（§5）落地后按 TDD 开工——P0/P1 即刻；P2 先红 T62/T64/T65 三组再写 mutation path；P3 骨架与纯函数先行、finalization commit path 前置 T66–T68 三协议；P4 after P3；P5 按原计划。**停止 RC5.6 式文档套件**：后续发现默认 bug / invariant test / implementation adjustment，仅当 P0 REAL-composition 反证 DSH API 基础假设时才重开架构。

## 5. RC5.5.1 补丁落点

方案（数据模型：`OpId` 派生式、`ReviewOpState`、`rangeDisposition`、`finalized`、`SkillAppliedOps`、`NameReservation`；机制要点与门槛同步）；总纲（全局约定 + OpId/RangeDisposition 规则、调用图、P0=68）；P0（T62–T68）；P1（opId 由 deriveOpId 供给的重放稳定注记）；P2（SkillAppliedOps receipt、NameReservation、create/patch 重排、skill ack）；P3（deriveOpId、ReviewOpState、markTerminal(+disposition)/markFinalized、advance 单调、terminal-recovery 重写、crash model Known Limitations）；P4 无涉。均原位修订于 RC5.5- 命名文件，内部版本标注 RC5.5.1。
