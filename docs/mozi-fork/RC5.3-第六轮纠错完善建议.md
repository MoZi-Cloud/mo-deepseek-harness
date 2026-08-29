# RC5.3 第六轮纠错完善建议

> 评审基线：DSH `cd5ef8148158c3a752a658978873241fdf8e2bbc`；Hermes Agent `05c248d8`/对应当前源码。
>
> 结论：不推翻 RC5.3 主轴，建议做 RC5.3.1/RC5.4 小修订后再进入 P2/P3。

## 总判断

RC5.3 已正确修复第五轮的 Provider 契约、projectKey、rank、bundle digest、RangeId/AttemptId、取消 settlement、governance 与 orphan 配额等问题。现在剩余风险集中在四类：**多实例 identity、共享 capability ownership、治理状态机、review attempt 时序**。

建议按 **12 项 S1 + 7 项 S2** 继续收口。

---

## S1-1：Memory 不能按“同一个 MemoryService 挂 project/user 两实例”实现

RC5.3 P1 写“同插件两实例 = 双语义记忆”，但 Cordis `Service` 构造器会立即 `ctx.reflect.provide(name, self)`；同一 isolation key 下重复 service name 会直接抛 `service "memory" has been registered ...`。

源码：
- `vendor/cordis/src/service.ts:29-53`
- `vendor/cordis/src/reflect.ts:259-285`
- https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/vendor/cordis/src/service.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/vendor/cordis/src/reflect.ts

**修正**：只保留一个 `ctx.memory` Service，内部管理 `project` / `user` 两个逻辑 scope。现有 `getState(scope)` / `applyOps(scope)` API 已天然适合。

---

## S1-2：两个 MemoryPublisher 会互相把对方当成“自己的上一版 snapshot”

RC5.3 的 `latestPublishedMemory(session)` 只按 `source.kind==='memory'` 找最新 digest。DSH `ContextForm:'snapshot'` 明确定义为“later snapshot **from the same producer** supersedes earlier one”，而 `source.kind` 就是 producer identity。

源码：
- `packages/llm/llm/src/message.ts:30-57`
- https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/message.ts

**修正**：一个 composite `MemoryPublisher`，一次发布 project/user 两个 `ContextSnapshotSection`，计算 combined digest。P1 只启 project section；L2 增 user section，不新增第二 publisher。

---

## S1-3：P2 已有 providerPlugin + authoringPlugin 两个 mount，共享 Store/Domain 的 Service 却推迟到 P3，过晚

`DomainFacility` 明确 single-open per domain name；第二次 `open()` 同名 domain 抛 `already-open`。

源码：
- `packages/storage/storage-domain/src/index.ts:58-95`
- https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/storage/storage-domain/src/index.ts

**修正**：`SkillAuthoringService`/`ManagedSkillService` 提前到 P2，唯一拥有 domain handle、Store、Provider、AuthoringCore。`skill_manage` 只是 scoped consumer。P3 只是新增 session-review 第二消费者，不再“搬 provider”。

---

## S1-4：`project-key-stable-across-alias` 不能靠复刻 `findProjectRoot()` 实现

`findProjectRoot()` 只是 lexical upward walk，没有 realpath/canonicalization。真正承诺 alias 稳定的是 `ctx.fs.resolve()`：same file yields same `targetKey`。

源码：
- `skill-filesystem/src/index.ts:880-889`
- `fs/src/index.ts:100-118`
- `fs/src/types.ts:10-23,50-61`

**修正**：
```text
ProjectRootPath = findProjectRoot(cwd)
ProjectKey = hash((await ctx.fs.resolve(ProjectRootPath)).targetKey)
```
`targetKey` 只做 identity，不解析、不拼路径。Memory project scope 也复用同一 resolver。

---

## S1-5：ManagedSkill `get()` 已有 trust boundary，但 `list()` 仍可被外部 frontmatter 篡改污染 model-visible catalog

DSH `tool-skill` 每个 pre-step 从 `ctx.skills.snapshot()` 直接把 `SkillSummary.name/description` 写入模型可见 durable catalog。若 Managed provider 的 `list()` 从未校验的 revision frontmatter 读取 description，则攻击内容在 `get()` 之前已经进模型。

源码：
- `packages/skill/tool-skill/src/index.ts:203-240,243-307`
- https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/tool-skill/src/index.ts

**修正**：Authoring commit 时将可信 `catalogSummary{name,description,invocation,...}` 写入 `ManagedSkillRecord`；`list()` 只读 sidecar。`get()` 才读 exact revision + full bundle digest + scan。

将原则 #8 改成：**Managed output is untrusted until every model-visible read boundary is verified, including catalog summary.**

---

## S1-6：P4 用 durable `session/event tool/result` 读取 `result.provider` 是错的

`skill` 工具 canonical value 确实有 `provider`，但 durable `tool/result` 不保存 canonical `value`，只保存 rendered message/error/optional meta。`tool-skill` 当前 output 没有 `presentationMeta()`，因此 provider 不会持久化进 meta。

源码：
- `tool-skill/src/index.ts:79-147`
- `core/tools/src/index.ts:181-186,1748-1764`
- `core/tools/src/index.ts:199-207,1703-1725`
- `packages/core/session/README.md`（canonical value execution-local）

**修正**：usage 既然是 best-effort，就监听 live Cordis `tools/result`：
```text
ctx.on('tools/result', (exec, result) => {
  if (exec.name === 'skill'
      && !result.isError
      && result.value?.provider === MANAGED_SKILL_PROVIDER_NAME) {
    ...
  }
})
```
T41 改成 `skill-live-result-provider-attribution`。不要为 telemetry 增加 tool-skill persistence fork-diff。

---

## S1-7：NameIndex 第一次 reserve 仍缺 `missing-key` 初始化

`reserveName()` 直接对 `index/<projectKey>` 做 `update()`，但 DSH `KvTable.update()` 对缺失 key 明确抛 `missing-key`。

源码：
- `storage-domain/src/domain.ts:75-81,306-319`
- https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/storage/storage-domain/src/domain.ts

**修正**：增加 `ensureNameIndex(projectKey)`，首次 `put(emptyIndex)` 后再 `update`。加“全新 project 第一次 reserve”和并发 first-reserve 测试。

---

## S1-8：governance `reject -> archived` 会把 name 变成不可恢复死状态

当前 NameIndex 保留名称；create 同名会 conflict；patch 仅允许 draft/active；治理无 reopen。于是一次 reject 后永远无法重新创建或修改该 skill。

**修正**：不要混用 `archived` 与“用户拒绝”。建议新增：
```text
draft -> rejected
rejected -> explicit reopen -> draft
```
`archived` 只表示“曾 active 后生命周期归档”。NameIndex 保留 deterministic identity。

---

## S1-9：active skill 的 patch 直接切 `currentRevision`，绕过了治理面

RC5.3 P2 允许 `patchDraft` 对 `draft | active`；active patch 写新 revision 后立即 `currentRevision=n+1`。这意味着“新 skill 要 approve，但已经 active 的 skill 可以被模型/后台直接改 instructions”。

Hermes write approval 在启用时明确规定 **skills always stage**，包括 edit/patch。

源码：
- `tools/write_approval.py:226-258`
- https://github.com/NousResearch/hermes-agent/blob/main/tools/write_approval.py

**修正**：
```text
draft patch:
  currentRevision 可前进（仍不可见）

active patch:
  写 pendingRevision
  currentRevision 保持旧值
  approve 后 CAS 切 pointer
```
L2 autonomous 也走同一 candidate→approve→pointer transition，只是 policy 可自动 approve。

---

## S1-10：ReviewCursor claim 时要求 attemptId，但 AttemptId 的 baseStateDigest 此时尚未生成

RC5.3 定义：
```text
attemptId = hash(rangeId, attemptNo, baseStateDigest)
```
但 `claim()` 已写 `{attemptId,status:'running'}`；而 baseStateDigest 只有 claim 后读取 current memory/skills 才能得到。

这是内部时序矛盾。

**修正**：简化为：
```text
attemptId = hash(rangeId, attemptNo)
```
`baseStateDigest` 作为 `ReviewAttempt` 字段保存，不参与 ID。`attemptNo` 由 cursor durable allocation。

这样 stale replan、crash retry、immutable plan 都仍成立，并消除循环依赖。

---

## S1-11：`budget_exceeded -> consolidation 失败后 skip memory mutation` 与 whole-plan admission 自相矛盾

同一规格一边说“任一 proposal 不过 admission → 整 plan 零 commit”，一边又说 consolidation 失败“skip memory mutation”。若同 plan 还有 skill op，就不知道是否继续 skill。

**修正**：
```text
原 plan budget fail -> zero commit
consolidation -> 生成新的整个 ReviewAttempt
重新 whole-plan admission
仍 fail -> 整 attempt reject/terminal，zero commit
```
只有未来引入显式 `operationGroups[]` 后才允许组级独立 admission。

---

## S1-12：receipt “窗口必须覆盖所有可重放 opId”仍只是 JSDoc，不是可执行 protocol

静态 `receiptWindowSize=N` 不能证明一个仍 non-terminal 的旧 attempt op 不会被 FIFO 淘汰。

DSH storageDomain 只提供资源自身单 record RMW，不提供跨 ReviewLedger/MemoryState 事务，因此 retention correctness 必须显式编码。

**修正建议**：
```text
pendingReceipts       // non-terminal attempt，永不 FIFO 淘汰
recentTerminalReceipts // terminal 后才进入 bounded ring
```
ReviewAttempt durable terminal 后，orchestrator 调 `acknowledgeTerminalOps(opIds)` 将 pending → recentTerminal。只有 recentTerminal 可 GC。

---

# S2：重要完善项

## S2-1 checkNameConflict 应使用真实 Agent scope

DSH `tool-skill` 正式 lookup 传 `scope: exec.agent`。RC5.3 `checkNameConflict(name, projectKey)` 只按 cwd 查，会漏掉 authoring agent 当前 scoped winner。

源码：
- `tool-skill/src/index.ts:123-133`

建议传 `AuthoringContext { cwd, scope?: Agent }`。

---

## S2-2 `list()` 最好完全不读 bundle

将 catalog metadata 固化 sidecar 后：
- list = storage only；
- get = filesystem exact revision + digest + scan。

这既降低 pre-step I/O，也让 catalog trust 与 body trust 分层清楚。

---

## S2-3 现在就定义 CompositeMemorySnapshot schema

避免 L2 开 user memory 时再改 MessageSourceMap：

```text
{
  kind:'memory',
  form:'snapshot',
  sections,
  scopes:{
    project?:{revision,digest},
    user?:{revision,digest},
  },
  digest
}
```

P1 只填 project；L2 多 user，不换 producer 协议。

---

## S2-4 L1 已允许 ReviewPlan `target:'user'`，但 user store 到 L2 才启用

Host admission 必须明确：
```text
rollout < L2 && target==='user'
-> proposal 可记录
-> zero commit
-> target_scope_disabled
```
不能 silent drop，也不能降级写入 project memory。

---

## S2-5 rejected 不应进入 curator 自动状态机

若新增 `rejected`：
- curator 永远不自动 transition；
- 只有 user governance 可 reopen；
- archive/stale 仍专属于曾 active 的技能。

---

## S2-6 T36 的通过标准不要保留“human 胜？”问号

DSH 源码已明确：
```text
global human + scoped managed -> scoped managed wins
scoped human + global managed -> scoped human wins
same layer -> lower rank wins
```
Evidence Lock 应直接钉期望值，不留开放问题。

---

## S2-7 把“Visibility is a separate commit”加入第一原则

这是本轮最值得新增的统一原则：

> **Visibility is a separate commit.**
>
> Learned artifact 写入完成不等于对模型生效；只有通过 authority/policy gate 后，Host 才能发布/切换模型可见状态。

它统一 Memory 与 Skill：

```text
Memory:
  authoritative MemoryState mutation
  -> next pre-step snapshot publication

Skill:
  immutable revision write
  -> approval/policy
  -> currentRevision pointer activation
```

---

# 建议新增 P0 测试

1. `memory-service-single-registration`
2. `memory-composite-snapshot-no-cross-scope-churn`
3. `managed-domain-opened-exactly-once`
4. `project-key-uses-fs-target-identity`
5. `managed-catalog-sidecar-not-file-trust`
6. `skill-live-result-provider-attribution`
7. `name-index-first-record-initialization`
8. `rejected-draft-can-be-reopened`
9. `active-patch-stays-pending-until-approve`
10. `attempt-id-does-not-require-preclaim-base-state`
11. `consolidation-failure-keeps-whole-attempt-zero-commit`
12. `nonterminal-op-receipt-never-evicted`

---

# Phase 微调

## P1 Memory
- 一个 MemoryService；
- 一个 composite Publisher；
- multi logical scopes；
- pending/terminal receipt retention；
- P1 只启 project section。

## P2 Skill
- SkillAuthoring/ManagedSkill Service 提前到 P2；
- 唯一 domain owner；
- sidecar catalog summary；
- NameIndex first-record init；
- active patch → pendingRevision；
- rejected state 预留。

## P3 Review
- `attemptId = hash(rangeId, attemptNo)`；
- consolidation 产生新的 whole-plan attempt；
- governance 同时处理 new-draft promotion 与 active pending revision approval；
- reject/reopen 明确。

## P4 Curator
- usage 改 live `tools/result`；
- rejected/draft 不进自动生命周期；
- telemetry 仍 best-effort。

---

# 优先整改顺序

1. P2 Service 提前，禁止 provider/tool 各自 open 同一 domain；
2. Memory single Service + composite Publisher；
3. ProjectKey 改用 `ctx.fs.resolve(...).targetKey` identity；
4. Provider list 改 sidecar catalog metadata；
5. active patch 改 pendingRevision + approve 后 activation；
6. P4 usage 改 live `tools/result`；
7. AttemptId 去除 preclaim 尚不存在的 baseStateDigest；
8. NameIndex first-record 初始化；
9. reject 改 rejected/reopen；
10. receipt 改 pending-never-evict / terminal-bounded。

## 最终判断

RC5.3 的中心结构已经足够稳定，不需要再推翻 `LLM proposes; Host commits`、Managed Provider、immutable revisions、ReviewCursor/Ledger 或 durable Memory snapshot。

剩余工作本质上是在回答：

- 谁唯一拥有 service/domain？
- identity 在什么时候产生？
- “写入了 artifact”和“模型开始看见它”是不是同一个 commit？
- live event 与 durable event 哪个携带哪些字段？
- cancel/reject/retry 后是否仍有合法下一状态？

把这些补完，RC5.3 才真正从“架构正确”进入可长期运行的 self-evolution protocol。
