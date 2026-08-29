# 评审报告：DSH × Hermes Agent 自我总结 / 自我进化机制 RC5.2

> **评审对象**：`自我进化机制-RC5.2-方案.md`、`RC5.2-函数级规格总纲.md`、`RC5.2-附件P0-evidence-lock.md`、`RC5.2-附件P1-memory.md`、`RC5.2-附件P2-skill-managed.md`、`RC5.2-附件P3-session-review.md`、`RC5.2-附件P4-curator.md`、`RC5.2-第四轮评审核验与处置.md`
>
> **目标**：不是把 Hermes Agent 搬进 DSH，而是组合两者真正经过源码验证的优势，形成一套 **可重放、可恢复、幂等、可审计、有证据、有预算、用户可治理** 的自我总结 / 自我进化机制。
>
> **DSH 证据基线**：`deepseek-ai/deepseek-harness @ cd5ef8148158c3a752a658978873241fdf8e2bbc`。
>
> **Hermes 证据基线**：本评审于 2026-08-29 读取 `NousResearch/hermes-agent` GitHub `main`；RC5.3/P0 应把 Hermes 也锁成一个 commit SHA，避免后续源码漂移。
>
> **评审方法**：所有承重建议均由“RC5.2 规格事实 + DSH/Hermes 源码事实”推出。纯产品偏好不列为硬错误；无法从源码证明的猜测不作为结论。

---

## 0. 总结论

RC5.2 已经不是 RC4/RC5 那种“方向正确但 API 大量写错”的方案。第四轮将 Skill 生命周期从目录移动重构为 **Managed Skill Provider + immutable revision + storageDomain sidecar**，是一次真正 DSH-native 的改造；Memory 的资源级幂等、双闸扫描、ReviewCursor、planned durable boundary、oldest-first 连续 review range、foreground preemption，也都比 RC5.1 成熟很多。

**因此不建议推翻 RC5.2 主轴。**

应继续锁定的核心是：

1. `LLM proposes; Host commits`；
2. 自进化业务不进入 `agent-loop`；
3. 动态模型可见状态走 durable Session source；
4. review child 用 `spawn + outputSchema + 收窄工具面`；
5. Memory / Skill 的 authority 在 Host，而不是模型文本；
6. at-least-once trigger + resource-level idempotency；
7. Managed Skill Provider 独立于人工 skill source；
8. L0 Shadow → L1 Conservative → L2 Autonomous；
9. foreground 永远优先，自进化副作用 fail-open；
10. 首版不新增 `review/*` persistence vocabulary。

但是，**RC5.2 仍不宜直接按现函数签名进入 P2/P3 开发**。本轮找到：

- **14 项 S1：实施前必须修**；
- **12 项 S2：不会立即破坏 correctness，但会显著影响长期质量、治理或可维护性**。

最关键的五项是：

1. `ManagedSkillProvider` 的 `list/get` **签名不符合 DSH `SkillProvider` 契约**；
2. `managedProviderRank=700` **不能保证跨 scope layer 永远输给人工来源**；
3. Managed skill 没有把 `cwd/project` 作为 provider lookup 的一等身份，存在跨项目目录污染风险；
4. foreground 取消 background review 后，现规格可能留下永久 `inFlight`，后续 claim 一直 `busy`；
5. immutable revision 只是“本模块不改”，**外部文件改动仍可绕过 sidecar digest/scan 直接进入 DSH 的 trusted skill instructions**。

换句话说，RC5.2 的主要问题已经从“有没有插件缝”升级为：

> **provider identity、workspace identity、mutation identity、review attempt identity 与 human governance 是否真正闭环。**

---

# 1. 源码证据基线

## 1.1 DSH：本评审实际依赖的源码事实

### D1 — `SkillProvider` 不是 `list(): SkillSummary[] / get(name)`

DSH 固定提交：

`packages/skill/skill/src/index.ts`

- `SkillCandidate` 必须有 `rank`、opaque `locator`；
- `SkillLookupOptions` 包含 `cwd` 和 `signal`；
- `SkillProvider.list(options)` 返回 `SkillCandidate[] | SkillProviderObservation`；
- `SkillProvider.get(candidate, options)` 加载**此前 list 出来的 candidate**；
- registry 会把同一个 candidate/locator 原样传回 provider。

源码：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill/src/index.ts#L64-L106>

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill/src/index.ts#L224-L251>

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill/src/index.ts#L455-L480>

### D2 — rank 只在同一 scope layer 内决定；更近 layer 直接覆盖

`SkillRegistry` 注释与 `collectFresh()` 都明确：

> nearest layer's entry wins a duplicate name outright; rank decides duplicates only within one layer.

源码：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill/src/index.ts#L315-L324>

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill/src/index.ts#L511-L540>

### D3 — Provider 注册在哪一层由调用 Context 的 scope 决定

`registerProvider()` 注册进入 calling context 的 layer；preset standing composition 中注册的 provider 属于相应 scope layer。

源码：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill/src/index.ts#L346-L395>

### D4 — skill body 被作为 trusted local content 原样放进 `<skill_instructions>`

源码注释明确写：

> body is embedded verbatim (skills are trusted local content)

源码：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill/src/index.ts#L145-L195>

这意味着 agent-managed skill 的**读边界完整性**不是“可选加固”，因为一旦 provider 暴露了被外部篡改的正文，DSH 会把它视作可信指令。

### D5 — skill loader 的结果包含 `provider`，而 `/name` sourced message 不包含 provider

model tool 返回：

```text
name
provider
resourceBase?
content
```

用户 `/name` 注入的 source 则只有：

```text
{ kind:'skill-invocation', name, form:'instructions' }
```

源码：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/tool-skill/src/index.ts#L119-L147>

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/tool-skill/src/index.ts#L168-L194>

### D6 — storageDomain：`put` 是覆盖写；`update` 是单 domain write-chain 上的 atomic RMW，缺 key 会报错

源码：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/storage/storage-domain/src/domain.ts#L37-L81>

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/storage/storage-domain/src/domain.ts#L258-L319>

### D7 — `SubagentRun.dispose()` 是强语义：取消剩余工作并等 child quiescence

源码：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/subagent/src/types.ts#L242-L275>

同时 `SubagentStartRequest.signal` 是 canonical cancellation channel：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/subagent/src/types.ts#L94-L149>

---

## 1.2 Hermes：真正值得借鉴的源码事实

### H1 — Memory 明确分为 USER 与 MEMORY 两个语义目标

`tools/memory_tool.py` 文件头明确：

- `MEMORY.md`：环境、项目约定、工具 quirks、learned facts；
- `USER.md`：用户偏好、工作方式、期望；
- 两者都 bounded；
- snapshot 注入与 live durable state 分离。

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py>

### H2 — Memory 满时要求 consolidation，而且有失败次数上限，不能拖死用户回复

`_MAX_CONSOLIDATION_FAILURES_PER_TURN = 3`；超过后明确要求停止 retry，保持 memory 不变并继续用户回复。

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py#L153-L202>

写入超过 limit 时返回现有 entries，要求 replace/remove 后重试：

<https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py#L374-L426>

### H3 — Memory 使用写入扫描 + snapshot 再扫描的双边界

snapshot 构建时被命中的条目替换成 `[BLOCKED: …]`，但 raw state 保留供用户审计/删除。

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py#L227-L240>

### H4 — foreground 抢占 background review 有完整 handshake，而不只是“发个 cancel”

Hermes 当前实现：

- 先给 run 安装唯一 token；
- cancel 会 fence startup；
- request_done 做 acknowledgement；
- 最多等待 2 秒；
- 超时也立即让 foreground 前进；
- ABA-safe 地清理 run token。

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py#L31-L170>

### H5 — Hermes 的 memory review prompt 明确允许 “Nothing to save”

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py#L426-L435>

但是 Hermes skill review prompt 又明确写：

> “Be ACTIVE — most sessions produce at least one skill update”

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py#L436-L440>

这是一个**值得反向借鉴的负面模式**：Memory prompt 的 no-op 中性很好；Skill prompt 的 action bias 容易制造垃圾技能。

### H6 — Hermes 对 skill 的成熟经验不是“一会话一个技能”，而是 class-level umbrella + supporting files + read-before-write

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py#L441-L513>

尤其：

- 先更新当前 loaded skill；
- 再找已有 umbrella；
- 再加 `references/templates/scripts`；
- 最后才创建新的 class-level skill；
- patch 前必须 fresh read。

### H7 — autonomous skill ownership 是 fail-closed

Hermes 后台 reviewer：

- pinned 禁写；
- external / bundled / hub 禁写；
- 非 curator-managed skill 禁写；
- provenance record 缺失也按不可写处理；
- 用户显式 adopt 才进入自治域。

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_manager_tool.py#L2708-L2909>

### H8 — Skills Guard 将危险内容分成 injection / exfiltration / destructive / persistence / network / obfuscation

例如 `rm -rf /`、读取密钥、reverse shell、prompt injection 都有独立 pattern/severity。

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_guard.py#L70-L81>

<https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_guard.py#L159-L318>

### H9 — Write approval 是 durable pending store，而不是一次 UI confirm

background skill/memory write 可以 stage 到磁盘，跨进程重启后继续 approve/reject。

源码：

<https://github.com/NousResearch/hermes-agent/blob/main/tools/write_approval.py#L92-L170>

background / skill write 的 gate：

<https://github.com/NousResearch/hermes-agent/blob/main/tools/write_approval.py#L248-L257>

---

# 2. 本轮评级

| 等级 | 数量 | 含义 |
|---|---:|---|
| **S1** | **14** | 按现规格实现会出现 API 不匹配、隔离错误、并发身份冲突、恢复死锁、安全绕过或不可兑现的验收语义；应在进入对应 Phase 前修规格 |
| **S2** | **12** | correctness 基本可成立，但会削弱自我总结质量、用户治理、长期资源上界或评测可信度 |

总体结论：

> **P0 可以继续做，但 P2/P3 不能按现函数签名直接开工。建议先出 RC5.3 小修订，不需要再做一次大架构推翻。**

---

# 3. S1：实施前必须修

## S1-1 — `ManagedSkillProvider` 的公开签名与 DSH `SkillProvider` 契约不兼容

### RC5.2 现规格

`RC5.2-附件P2-skill-managed.md`：

```text
list(): Promise<SkillSummary[]>
get(name): Promise<SkillBody | undefined>
```

### 源码反证

DSH 要求：

```text
list(options: SkillLookupOptions)
  -> Promise<SkillCandidate[] | SkillProviderObservation>

get(candidate: SkillCandidate, options: SkillLookupOptions)
  -> Promise<SkillDefinition | undefined>
```

且 `SkillCandidate` 必须包含 `rank` 与 `locator`。

证据：D1。

### 为什么严重

这不是类型名小差异，而是 DSH registry 的核心一致性协议：

```text
list
  ↓
选中 winning candidate
  ↓
把原 candidate.locator 原样交回同一 provider.get()
```

RC5.2 的 `get(name)` 会失去：

- `cwd`；
- `signal`；
- list 时锁定的 revision；
- provider-owned locator；
- list→get 的 TOCTOU 语义。

### 建议

定义真正的 provider：

```text
interface ManagedSkillLocator {
  projectKey: string
  skillId: SkillId
  bundleRevision: number
  contentDigest: string
}

class ManagedSkillProvider implements SkillProvider {
  readonly name = 'self-evolution-managed'

  async list(options: SkillLookupOptions):
    Promise<readonly SkillCandidate[] | SkillProviderObservation>

  async get(
    candidate: SkillCandidate,
    options: SkillLookupOptions,
  ): Promise<SkillDefinition | undefined>
}
```

`locator` 必须钉死 exact revision，不要在 `get()` 时重新读取“当前 currentRevision”。

### 必加测试

- `provider-contract-typechecks-against-SkillProvider`
- `list-candidate-locator-pins-revision`
- `revision-changes-between-list-get-loads-listed-revision`
- `abort-signal-stops-list-and-get`

---

## S1-2 — Draft “provider.get 可读但 list 不可见”的验收与 DSH 契约自相矛盾

### RC5.2 现规格

`createDraft()`：

> 写 draft → sidecar → invalidate → readback（provider `get` 可读、`list()` 不可见——draft 语义）

### DSH 源码

`SkillProvider.get()` 的参数被明确描述为：

> “the winning candidate originally returned by this provider” / “previously listed candidate”

证据：D1。

### 问题

如果 draft 永不从 `provider.list()` 产生 candidate，那么正常 registry/provider 协议中根本不存在一个合法 draft candidate 可以传给 `provider.get()`。

### 建议

**不要用 Provider API 做 authoring readback。**

拆清：

```text
ManagedSkillStore.readRevision(skillId, revision)
    = Host authoring/debug capability

ManagedSkillProvider.list/get
    = 只服务 DSH skill discovery
```

Draft readback 应直接走 `ManagedSkillStore`/`AuthoringCore` 的 exact revision reader。

这样还能让 Provider 严格保持：

> only active skills exist from the model/human discovery perspective.

---

## S1-3 — Managed provider 没有把 workspace/cwd 纳入持久身份，standing preset 下可能跨项目串目录

### RC5.2 现规格

`ManagedSkillRecord` 没有 `projectKey/root`；provider `list/get` 也没有 options 参数。

### DSH 源码

`SkillLookupOptions.cwd` 明确是：

> Workspace selector for the current lookup.

Registry cache key也包含 `cwd`。

证据：D1，及：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/skill/skill/src/index.ts#L481-L525>

### 风险

同一个 standing preset/plugin instance 可能服务多个 Agent/session/workspace。

如果 ownership table 只按 `skillId` 全局列 active，provider 很容易把：

```text
/project-A/.dsh/self-evolution/...
```

里的 skill 暴露给 project B。

### 建议

引入稳定 `ProjectKey`：

```text
ManagedSkillRecord {
  projectKey
  skillId
  ...
}

ManagedSkillLocator {
  projectKey
  skillId
  bundleRevision
  contentDigest
}
```

provider：

```text
options.cwd
  ↓
resolve canonical project root
  ↓
ProjectKey
  ↓
只 list 此 project 的 managed records
```

所有 storage key 也应包含 project identity。

### 测试

- `provider-project-a-never-visible-in-project-b`
- `same-skill-name-two-projects-isolated`
- `candidate-project-mismatch-get-returns-undefined`
- `cwd-realpath-alias-resolves-same-project-key`

---

## S1-4 — `rank=700` 不能实现“任何人工/内置/运行时来源同名恒胜 managed”

### RC5.2 断言

P2 写：

> managedProviderRank 默认 700；任何人工/内置/运行时来源同名恒胜 managed。

### DSH 源码反证

DSH 明确：

```text
nearest layer wins duplicate name outright
rank only decides duplicates within one layer
```

证据：D2、D3。

### 风险

如果 managed provider 注册在更近的 preset scope，而某个 human/bundled provider 在 global/farther layer：

```text
managed rank 700
human rank 100
```

**仍可能 managed 赢**，因为跨 layer 根本不比较 rank。

### 建议

把原则改为：

> `rank=700` 只是 **same-layer defense-in-depth**，不是权限边界。

真正的权限边界必须是：

1. 明确 managed provider **注册在哪一层**；
2. P0 REAL composition 枚举实际 shipped sources 所在 layer；
3. Authoring Host 在 promote 时继续做 human conflict fail-loud；
4. 如产品要求“managed 永远不能遮蔽任意人工层”，必须在 registry consumer/policy 层解决，而不能靠 rank 宣称。

### P0 新测试

不是只测“rank 700 vs rank 200”，而是：

```text
global human + scoped managed
scoped human + scoped managed
global managed + scoped human
```

分别钉死 winner。

---

## S1-5 — 同名 managed skill 缺少原子 name reservation；两个 draft 可以并发占同一名称

### 现规格

`createDraft()`：

```text
checkNameConflict
→ 分配随机/新 skillId
→ 写 revision
→ sidecar
```

而 draft 不进入 provider list。

### 源码与设计推导

DSH registry 只能看到 provider 实际 `list()` 产生的 candidates（D1）。RC5.2 又规定 draft 不 list。

因此两个并发 create：

```text
A: check "foo" → 无
B: check "foo" → 无
A: skillId=A
B: skillId=B
```

都能产生合法 draft。

之后两者 promote 时，“own managed provider”又不被 `winning_not_managed` 规则拒绝，最终同一 provider 可返回两个 `foo` candidate，registry 只会按内部顺序留下一个，不等于数据层没有冲突。

### 建议

最简单、最稳：

```text
skillId = hash(projectKey, normalizedName)
```

即 name 本身成为 project 内 managed identity。

或者单独一张原子 NameIndex record：

```text
(projectKey, name) -> skillId
```

创建必须 CAS reserve。

我更推荐**确定性 skillId**，因为它天然把：

- 同名 create；
- crash retry；
- background/foreground race

统一成同一个 identity。

### 测试

- `concurrent-same-name-create-one-identity`
- `same-name-draft-retry-reconciles`
- `same-name-second-create-is-patch-or-conflict`

---

## S1-6 — “immutable revision”目前只是约定；外部修改 bundle 可绕过 sidecar digest 与扫描，直接变成 trusted instructions

### RC5.2

bundle 放在项目目录：

```text
.dsh/self-evolution/skills/<skillId>/revisions/<n>/
```

sidecar 保存 `contentDigest`。

但 provider `get()` 规格只说读取 currentRevision 的 `SKILL.md`，没有要求：

- 重新计算 bundle digest；
- 与 sidecar digest 比对；
- 读边界 threat scan。

### DSH 源码

DSH `renderSkillContent()` 会把 skill body **verbatim** 放到 `<skill_instructions>`，并明确称其为 trusted local content（D4）。

### 风险

用户、Git 操作、其他进程、恶意工具都可以改 workspace 文件。

那么：

```text
sidecar: digest = safe-v1
file: 被改成恶意内容
provider.get():
    直接 readText
    ↓
DSH 把它当 trusted skill instructions
```

这完全绕过 AuthoringCore 的 scan。

### Hermes 可借鉴点

Hermes Memory 在 snapshot/build read boundary 会再次扫描磁盘内容（H3），正是为了防：

> supply chain / compromised tool / sister-session write。

### 建议

Managed provider `get(candidate)` 必须：

1. 根据 locator 读取 exact revision；
2. 对**整个 bundle**做 canonical digest；
3. digest != locator/sidecar → `undefined` + invalidate + loud diagnostic；
4. active skill 在 load boundary 再执行至少 high-confidence scan；
5. `resourceBase` 指向 exact revision dir。

如果不想每次全 bundle hash，可缓存：

```text
(candidate revision, stat fingerprint) -> verified result
```

但正确性依据仍是 digest。

### 测试

- `external-edit-active-skill-refused-on-get`
- `external-edit-support-file-breaks-bundle-digest`
- `load-boundary-threat-rescan`
- `candidate-digest-mismatch-invalidates`

---

## S1-7 — `BoundedOpReceipts` 的淘汰条件没有形成可证明的安全水位

### RC5.2

P1：

> FIFO receipt window；保证窗口 ≥ 在飞 checkpoint 的 op 集合（由调用方以 ledger 信息约束 windowSize）。

### DSH 源码

storageDomain 只保证单 record RMW 原子性，不替业务判断“某 op 永不再 replay”（D6）。

### 问题

Memory P1 在 ReviewLedger P3 之前就存在，且 project memory 可能被多个 session 的 review 修改。

单纯：

```text
receiptWindowSize = N
```

无法证明被 FIFO 淘汰的某个旧 op 不会因为：

- 某 session 的 planned checkpoint 延迟恢复；
- crash 后旧 review replay；
- 显式 re-review/migrate

再次出现。

如果 receipt 已被淘汰：

- add 虽可用 deterministic entryId 再挡一次；
- update/remove 则不天然安全；
- remove 后原 entry 已不存在，更没有 per-entry receipt 可检查。

### 建议

RC5.3 初版不要把 correctness 绑在“一个猜出来的窗口大小”上。

两个可选方案：

**方案 A（优先，简单）**

P1 暂不 GC receipts；只加硬容量告警。等 P3 ReviewLedger 到位后引入：

```text
safeReplayWatermark
```

只有所有相关 checkpoint 均 terminal/越过该 watermark，才允许删 receipt。

**方案 B**

为 remove/update 设计 durable resource tombstone/result identity，使 receipt 可安全压缩。

### 必加测试

- `old-planned-checkpoint-survives-many-newer-ops`
- `receipt-gc-never-resurrects-update`
- `receipt-gc-never-resurrects-remove`

现有“10k mutations bounded”只能证明空间有界，**不能证明重放安全**。

---

## S1-8 — foreground 取消后保留 `inFlight`，但没有同进程 settlement 路径，可能永久 busy

### RC5.2

P3：

> foreground turn 到来 → `run.dispose()` → cursor `inFlight` 保留 → 之后 recover 重放安全。

Cursor `claim()` 又规定：

> 已有 inFlight → `busy`；busy caller 不 spawn。

### DSH 源码

`dispose()` 会：

> cancel remaining work, reach child quiescence, release resources

证据：D7。

### Hermes 对照

Hermes 不只 cancel；它还有：

- run token；
- `request_done` acknowledgement；
- 结束时 ABA-safe 清 run token；
- bounded wait 后 foreground 放行。

证据：H4。

### 死锁路径

```text
background claim → inFlight set
foreground cancel → child quiescent
inFlight 保留
下一 turn maybeDispatch → claim = busy
再下一 turn → busy
...
```

如果 `recover()` 只在进程启动执行，就只能靠重启解锁。

### 建议

明确 cancellation settlement：

#### planning 阶段，还没有 durable plan

```text
dispose await quiescence
→ mark cancelled-for-foreground
→ clear inFlight
→ 不 advance high-water
```

下次正常 claim 同 range。

#### planned / committing 阶段

不能扔 plan：

```text
dispose
→ plan 仍 durable
→ inFlight 改为 resumable
→ foreground 放行
→ next idle/maintenance 直接 resume stored plan
```

不要重新问模型。

### 测试

- `cancel-before-planned-clears-inflight`
- `cancel-after-planned-resumes-stored-plan`
- `same-process-next-turn-not-permanently-busy`
- `foreground-wait-bounded`

---

## S1-9 — “plan immutable”与 `stale_base_revision → replan` 使用同一 review identity，语义冲突

### RC5.2

- `reviewId = hash(session/range/policy/learningViewVersion)`
- planned plan 被定义为 immutable；
- stale revision 又允许有限 replan。

### 问题

同一个 reviewId：

```text
attempt 1 → plan A → durable planned
stale
attempt 2 → plan B
```

到底：

- 覆盖 plan A？违反 immutable；
- 仍保存 plan A？无法表达 plan B；
- 新 reviewId？现公式又不会变。

### 建议

分离：

```text
ReviewRangeId
  = hash(session, from, through, policyVersion, learningViewVersion)

ReviewAttemptId
  = hash(ReviewRangeId, attemptNo, baseStateDigest)
```

每个 attempt 的 plan 永远 immutable。

Cursor 只指向当前 `ReviewRangeId`；Ledger 下挂 attempts。

stale replan = 新 attempt，不是改旧 plan。

### 测试

- `stale-replan-creates-new-attempt-id`
- `old-planned-attempt-never-overwritten`
- `recovery-picks-latest-valid-attempt`

---

## S1-10 — “whole-plan all-or-none”目前只做到 admission 原子，不可能做到跨 Memory + filesystem 的 commit 原子

### RC5.2

P3 叫：

> whole-plan preflight 全有或全无。

这个方向本身正确，但当前验收名容易让实现者误以为：

> plan commit 也 all-or-none。

### DSH 源码

Memory state 是 storageDomain record；Skill bundle 是 filesystem；DSH 没有跨两者事务（D6）。

### 真实失败路径

```text
preflight 全通过
memory.applyOps 成功
skill revision write 失败 / CAS stale / I/O error
```

此时世界已经部分改变。

### 建议

文档统一改名：

> **Whole-plan admission; forward-recovering saga commit**

规则：

1. preflight 全 plan；
2. plan durable；
3. 每个 op 都有独立 durable state；
4. commit 过程中失败不 rollback 已落地资源；
5. recover/reconcile 继续完成或进入 explicit conflicted terminal；
6. UI 能展示“plan partial-at-storage-level but saga pending”，不能假装事务。

### 新测试

- `memory-committed-skill-write-fails-recovery-finishes`
- `skill-committed-ledger-mark-crash-reconciles`
- `cross-resource-failure-never-rolls-back-by-guess`

---

## S1-11 — Skill usage 按 name 计数会把人工 winner 的使用错误记到 managed skill

### RC5.2

P4：

```text
tool/result
+ exec.name === 'skill'
+ 成功
+ 解析技能名
→ modelLoads
```

### DSH 源码

model `skill` tool 的**结果明确带 `provider`**（D5）。

而 `/name` source 只有 `name`，没有 provider。

### 风险

同名情况下 DSH 可能实际加载：

```text
human skill foo
```

但 usage observer 仅看到：

```text
name=foo
```

若 managed sidecar 也有 `foo`，就可能错误给 managed foo 延寿，使 curator 永远不 stale。

### 建议

#### model tool load

只在：

```text
result.provider === MANAGED_PROVIDER_NAME
```

时计 managed usage。

#### `/name`

现 source 不足以可靠归属 provider。

三个方案：

1. 最干净：在 managed provider `get()` 成功时发一个**非 session correctness** 的 host observation，直接计 exact skillId；
2. 或扩 `SkillInvocationSource` 增 provider/locator，但这要付双 SDK / vocabulary 周边成本；
3. 首版可以不把 `/name` 计 managed usage，宁可漏计，不要误计。

建议优先 **provider-load observation**，因为它天然拿到 candidate locator → exact skillId。

---

## S1-12 — MemoryPublisher 的“先 buildSnapshotSections，再二次扫描并按 entry 替换”函数顺序不可直接实现

### RC5.2

P1：

```text
读 state
→ buildSnapshotSections
→ 二次扫描
→ blocked 条目渲染 [BLOCKED]
```

但是 `buildSnapshotSections()` 已经把 entries 合成 `ContextSnapshotSection.text`。

### Hermes 源码

Hermes 的做法正好相反：

```text
raw entries
→ sanitize each entry
→ render snapshot block
```

证据：H3。

### 问题

如果先 render，再要把某个 entry 替换为 `[BLOCKED]`：

- 要重新解析自己刚生成的文本；
- entry 分隔符/escaping 可能歧义；
- 会破坏“renderer 是纯函数”的清晰边界。

### 建议

改成：

```text
state.entries
→ sanitizeForPublication(entries)
→ buildSnapshotSections(sanitizedEntries)
→ digest
→ publish
```

保持 raw MemoryState 不变。

类型：

```text
PublicationEntry =
  | { kind:'safe', entry }
  | { kind:'blocked', entryId, reason }
```

### 测试

- `sanitize-before-render`
- `blocked-placeholder-never-contains-raw-payload`
- `raw-state-remains-auditable`

---

## S1-13 — L1 的 skill draft 没有真正的用户 promotion / approve 产品入口，闭环停在“草稿永远不可用”

### RC5.2

- L1：skill 只创建 draft；
- `skill_manage` 明确无 promote；
- promote 被描述为“用户/host 动作”；
- 但 P0–P4 没有定义任何真正的用户命令、UI action 或 Host consumer。

### Hermes 源码

Hermes 把审批做成 durable pending store，并提供：

- pending list；
- diff；
- approve；
- reject；

且 background write 必须 stage 时不会等待 interactive thread。

证据：H9。

### 问题

“存在 `promoteDraft()` 方法”不等于用户能使用它。

如果 L1 是正式 rollout 阶段，那么用户必须有一条可达路径把高质量 draft 变 active，否则：

```text
review -> draft -> 永久 invisible
```

不是完整产品。

### 建议

最晚 P3 前增加 `SkillDraftGovernanceService` 的一个用户面 consumer，例如：

```text
/skills pending
/skills diff <id>
/skills approve <id>
/skills reject <id>
/skills pin <name>
```

Web/UI 可以随后做，但至少 CLI/command 必须真实可走。

approve 时重新验证：

- base revision；
- ownership；
- content digest；
- threat scan；
- name conflict；
- current policy。

不要“批准旧快照后直接写”。

---

## S1-14 — immutable revision / orphan revision 永久只增，但 P4 并没有真正 cleanup；文档与实现能力矛盾

### RC5.2

P2：

> old revision 保留；orphan revision 清理进 P4 范围。

P4 实际只：

- transition sidecar；
- aggregate `orphan revisions` 指标；
- 不 delete bundle。

而 DSH `ctx.fs` 又没有 delete API（这是 RC5.2 已承认的固定事实）。

### 结果

每次 patch 都会永久增加：

```text
revisions/1
revisions/2
...
```

每次 crash 还可能多 orphan。

所谓“P4 清理”在当前 seam 下无法兑现。

### 建议

首版诚实改为：

> **P4 只 report orphan，不 cleanup。**

并马上增加硬上界：

```text
maxRevisionsPerSkill
maxManagedBytesPerSkill
maxManagedBytesPerProject
maxOrphanBytesPerProject
```

到达上限：

> fail-loud 阻止继续自主 patch，不得偷偷删历史。

真正需要 GC 时，再设计一个**只对 managed root 有权限的窄删除 capability**，不要为了垃圾回收扩通用 `ctx.fs`。

---

# 4. S2：重要改进项

## S2-1 — Memory 只有一个 `Config.scope`，没有真正吸收 Hermes 的 USER / project-memory 双目标

RC5.2：

```text
scope: 'project' | 'user'
```

意味着一个插件实例一次选择一个 authority scope。

Hermes 则明确同时维护：

```text
USER.md
MEMORY.md
```

并给它们不同语义（H1）。

### 建议

DSH-native 版本不要照搬两个 Markdown 文件，但应保留**两个语义 Store**：

```text
UserProfileMemory
ProjectMemory
```

MemoryPublisher 可以发布两个 `ContextSnapshotSection`：

```text
assistant-user-profile
assistant-project-memory
```

Host 根据 evidence/type 决定目标：

- 用户偏好 / 稳定交互习惯 → user；
- 项目事实 / 环境 / 工具约定 → project；
- inference 写 user scope 在 L1 默认 stage，不自动 commit。

否则：
- 只用 project：用户偏好跨项目丢失；
- 只用 user：项目细节跨项目泄漏。

---

## S2-2 — Memory 硬预算已有，但“满了以后如何继续学习”的 consolidation protocol 仍缺

Hermes 在满容量时会：

1. 返回当前 inventory；
2. 要求 replace/remove consolidate；
3. 最多失败 3 次；
4. 之后停止学习但继续回复用户。

证据：H2。

RC5.2 当前 `budget_exceeded` 主要是 reject。

### 建议

在 review planner 加显式 bounded consolidation retry：

```text
budget_exceeded
→ 给 planner 当前 inventory + proposed new fact
→ 允许一次 consolidation plan
→ 最多 Config.maxConsolidationAttempts（建议 2~3）
→ 仍失败则 skip memory mutation
```

**不要**在 MemoryService 内部偷偷调用 LLM；仍坚持 Host/Planner 分层。

---

## S2-3 — Review persona 必须明确 “No change is a successful outcome”，不要继承 Hermes skill prompt 的 action bias

Hermes memory prompt：

> If nothing is worth saving, say “Nothing to save.”

这是好设计（H5）。

Hermes skill prompt：

> “Be ACTIVE — most sessions produce at least one skill update”

则会系统性提高 false-positive skill creation。

### 建议

RC5.2 review persona 加一条 snapshot-pinned invariant：

> Most sessions may require no durable change. Prefer no-op over weak, redundant, session-specific, or unverified learning.

P5 应单独统计：

```text
noChange rate
draft creation rate
false-positive create rate
```

不能把“每轮学到东西”当成功指标。

---

## S2-4 — Skill proposal 应把“更新 existing umbrella 优先，新建 class-level skill 最后”升级为 Host policy

Hermes 当前 skill review 的成熟部分（H6）明确：

1. loaded skill；
2. existing umbrella；
3. support file；
4. 最后才新建 class-level skill。

RC5.2 虽有 two-stage patch，但没有把：

> “new skill 必须证明没有现有归宿”

变成 Host gate。

### 建议

create-draft proposal 增：

```text
candidateSearchSummary
whyNoExistingManagedSkillFits
classLevelRationale
```

Host preflight 至少要求 planner-1 已看到当前 managed summaries。

首版可加保守上限：

```text
maxNewSkillsPerReview = 1
```

---

## S2-5 — ReviewPlan JSON Schema 需要 operation 数量/字节级硬上限，不能只靠 output token ceiling

DSH `outputSchema` 只是结构化 capture；`maxTokens` 只限制模型输出总量。

### 建议

Schema/Host 双层限：

```text
maxMemoryOpsPerPlan
maxSkillOpsPerPlan
maxFilesPerSkillProposal
maxPlanTextBytes
maxEvidenceRefsPerProposal
maxSpanBytes
```

否则一个合法 JSON plan 仍可能构造数百个 op，使 Host preflight/ledger 体积异常。

源码依据：DSH `SubagentStartRequest.outputSchema` 只是 schema contract，`agentOptions` 是单独资源控制，二者不是业务上界：

<https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/subagent/src/types.ts#L114-L149>

---

## S2-6 — Managed provider 应利用 `SkillProviderObservation.complete`，区分“空目录”和“发现失败”

DSH Provider 支持：

```text
{ candidates, complete }
```

registry 对 incomplete observation 不缓存，下一请求可重试（D1）。

### 建议

Managed provider 读取 storage / bundle 时：

- 某个 active record pointer 损坏：不要把整个 provider 静默当“没有 skill”；
- 可返回 last-good candidates + `complete:false`，或 fail-loud 让 registry 本轮不缓存；
- 对 corruption 记录 telemetry。

这比永远返回 `SkillCandidate[]` 更符合 DSH provider semantics。

---

## S2-7 — `resourceBase` 应指向 exact immutable revision 目录

DSH 的 `SkillResourceBase.directory` 会进入模型提示，告诉模型如何解析 supporting files（D1/D4）。

Managed skill 本来就有：

```text
revisions/<n>/SKILL.md
references/
templates/
scripts/
```

### 建议

candidate/definition 都带：

```text
resourceBase: {
  kind: 'directory',
  path: exactRevisionDirectory,
}
```

不能指向：

```text
.../<skillId>/current
```

之类会漂移的逻辑路径。

这样 skill body 和 supporting resources 才是同一不可变 revision。

---

## S2-8 — P0 仍保留 RC5.1 已废弃的 T09/T11，容易把历史架构重新带回实现

P0 当前还有：

- `draft-staging-undiscovered`
- `observer-seam-missing`

但 RC5.2 已经明确：

- 不再用 `.drafts` 目录 lifecycle；
- 删除 `ctx.skillMutationObserver` 方案。

### 建议

不要把它们作为 RC5.2 的 active Evidence Lock。

改为：

```text
Historical regression / rejected-design evidence
```

真正 P0 应增加本轮新关键测试：

- Provider interface contract；
- cross-layer rank；
- project isolation；
- deterministic name reservation；
- external bundle tamper rejection；
- cancellation same-process settlement。

---

## S2-9 — P5 声称“ledger + usage 聚合”不足以产生真正 effectiveness 指标

RC5.2 列：

- proposal precision；
- false durable memory；
- repeated-task success；
- post-curation regression；
- confidence calibration。

这些不是只靠运行 ledger/usage 就能知道“真/假”。

### 建议

P5 拆成两类：

### Operational metrics（ledger 可得）

- retry；
- cancellation；
- conflict；
- range lag；
- token cost；
- draft approval rate；
- orphan bytes。

### Quality metrics（必须有 eval harness / 人工标签）

- proposal precision；
- false memory；
- repeated-task task success；
- skill usefulness；
- regression；
- confidence calibration。

需要：

```text
gold / human-reviewed sample
before-vs-after replay harness
held-out task set
```

否则“effectiveness”只是 activity telemetry。

---

## S2-10 — Hermes 源码也应在 P0 锁 commit SHA

DSH 已严格 pin `cd5ef81`，这是正确纪律。

但 RC5.2 的 Hermes 借鉴仍是“当前 main”。

Hermes 的 background review、skill guards、approval 近来显然持续演进；例如 current source 已经有复杂 foreground cancellation handshake。

### 建议

P0 Evidence Lock 增：

```text
Hermes reference SHA
H-MEMORY
H-BG-REVIEW
H-SKILL-MANAGER
H-SKILLS-GUARD
H-WRITE-APPROVAL
```

每个只记录：

```text
commit + path:line + 我们借的机制
```

以后 upstream Hermes 变化不自动改变本项目设计依据。

---

## S2-11 — approvalMode 不应拖到 L2 前才实现；至少 L1 必须有 durable governance skeleton

RC5.2 已写：

```text
approvalMode = auto | stage-background | stage-all
```

但“实现排 L2 前”。

Hermes 源码证明 durable pending 的价值不仅是“安全模式”，还解决：

- background 无交互通道；
- 进程重启；
- 大 skill 无法在对话中完整 eyeball；
- approve/reject audit。

证据：H9。

### 建议

P2/P3 至少落一个最小 PendingChange store + list/reject/approve skeleton。

L1 skill draft 本身就可以直接复用 PendingChange/approval surface，不必等 L2 再造第二套治理概念。

---

## S2-12 — Content scanner 需要版本化评测语料，不应只测“我们写的 pattern 都能命中”

Hermes `skills_guard.py` 已经展示现实复杂度：

- secret read 有时是正常 config read；
- destructive/network/persistence 需要分 severity；
- 注释/docstring 会造成误报；
- 同一个字符串在说明文档与 imperative instruction 中语义不同。

证据：H8。

### 建议

`content-scan` 增：

```text
patternSetVersion
positive corpus
benign corpus
Chinese paraphrase corpus
code-block vs imperative corpus
```

P5 统计：

```text
false positive rate
false negative sample rate
blocked/caution distribution
```

不要把 scanner 的单元测试通过率等同于安全质量。

---

# 5. 一个需要特别强调的安全边界：不要把“本地 skill”默认当可信，Managed Provider 应成为 trust boundary

这是 DSH 与 Hermes 两个项目最值得结合的一点。

DSH 当前核心假设是：

> skill 是 trusted local content，因此 body 可以 verbatim 进入 `<skill_instructions>`。

这对**人工 authored / bundled** skill 是合理的。

但 RC5.2 的 managed skill 来源实际上是：

```text
LLM proposal
→ Host validation
→ project filesystem
→ future model instructions
```

它已经不是传统“可信人工本地文件”。

因此本项目必须人为建立一层：

```text
Untrusted learned proposal
        ↓
Host validation
        ↓
ManagedSkill immutable revision
        ↓
read-boundary digest + scan
        ↓
Trusted SkillDefinition
        ↓
DSH SkillRegistry
```

这才是正确的 trust transition。

Hermes 的 autonomous ownership fail-closed、skills guard、pending approval 正好补足 DSH 原生“trusted local content”假设；而 DSH 的 Provider/locator/scope/invalidation 又比 Hermes 直接扫目录更适合把这条边界形式化。

---

# 6. 推荐的 RC5.3 目标架构

```text
                         DSH durable Session log
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │ Deterministic LearningView
                    │ raw seq / turn fold
                    └───────────┬─────────────┘
                                │ evidence
                                ▼
                    ┌─────────────────────────┐
                    │ Review Planner (spawn)
                    │ no mutation capabilities
                    │ no-op is first-class
                    └───────────┬─────────────┘
                                │ structured proposal
                                ▼
                    ┌─────────────────────────┐
                    │ Host Admission
                    │ evidence / budget / scan
                    │ ownership / conflicts
                    │ class-level skill policy
                    └───────────┬─────────────┘
                                │
                      immutable ReviewAttempt
                                │
             ┌──────────────────┴──────────────────┐
             ▼                                     ▼
┌─────────────────────────┐             ┌─────────────────────────┐
│ MemoryService           │             │ SkillAuthoringService   │
│                         │             │                         │
│ UserProfile scope       │             │ deterministic name ID   │
│ ProjectMemory scope     │             │ immutable revisions     │
│ resource idempotency    │             │ sidecar CAS             │
│ bounded consolidation   │             │ pending approval        │
└───────────┬─────────────┘             └────────────┬────────────┘
            │                                        │
            ▼                                        ▼
┌─────────────────────────┐             ┌─────────────────────────┐
│ MemoryPublisher         │             │ ManagedSkillProvider    │
│ pre-step snapshot       │             │ DSH exact interface     │
│ sanitize → render       │             │ cwd/project scoped      │
│ fail-open               │             │ locator pins revision   │
└─────────────────────────┘             │ digest+scan on get      │
                                        └────────────┬────────────┘
                                                     │
                                                     ▼
                                            DSH SkillRegistry
```

外部治理：

```text
PendingChange / Draft Governance
    ├─ list
    ├─ diff
    ├─ approve
    ├─ reject
    ├─ pin
    └─ adopt（未来人工 skill 显式纳入自治域）
```

---

# 7. DSH 与 Hermes：应该各借什么

## 7.1 应坚持 DSH 的部分

| DSH 机制 | 为什么比直接复制 Hermes 更适合本项目 |
|---|---|
| Cordis Service / Provider / Consumer | 能把长期能力做成正式 seam，不把业务逻辑塞 agent-loop |
| SkillProvider + opaque locator | 非常适合 immutable managed revision |
| scoped registry + cwd lookup | 可做 project isolation |
| storageDomain | 比散落 JSON sidecar 更适合 Host authority/CAS |
| durable Session source | 可重放、可 resume、可 projection |
| `form:'snapshot'` | 天然表达最新 Memory replacement |
| subagent `outputSchema` | planner 可以只输出数据，不直接写世界 |
| `toolFilter` / scoped tools | 比 Hermes runtime whitelist 更靠近 composition-level capability reduction |
| `SubagentRun.dispose()` | 可把 cancellation 与 quiescence 做成正式生命周期 |
| `agent/pre-step` | 正好作为 model-visible Memory 发布边界 |

## 7.2 应吸收 Hermes 的部分

| Hermes 机制 | 建议吸收方式 |
|---|---|
| USER / MEMORY 双目标 | DSH 中实现 UserProfile + ProjectMemory 双 scope |
| 小而有硬预算的 memory | 保留 RC5.2 budget，并加 bounded consolidation |
| write scan + snapshot scan | RC5.2 已采纳，但顺序改 sanitize→render |
| foreground 抢占 background | 保留，并补 cancellation settlement |
| no-change 是正常结果 | 写入 Review persona，不学 Hermes skill 的 active bias |
| class-level umbrella | 变成 create skill 的 Host policy/gate |
| fresh read-before-write | RC5.2 两阶段 patch 是更 DSH-native 的实现，继续保留 |
| autonomous ownership fail-closed | Managed Provider + sidecar owner/pinned，继续保留 |
| write approval / pending | 提前到 L1 governance skeleton |
| pin/adopt | pin 已有；建议未来 adopt 作为显式提权 |
| curator archive recoverable | sidecar state 优于 Hermes 目录移动，保留 RC5.2 方案 |

## 7.3 不应复制 Hermes 的部分

### 1. 不复制 background reviewer 直接拿 memory/skill 写工具

Hermes current background review 仍是：

> fork agent + memory/skill management tools → direct writes

源码：`background_review.py:L0-L11`。

本项目的：

> **LLM proposes; Host commits**

更安全，应坚持。

### 2. 不复制 “most sessions should update a skill”

Hermes `_SKILL_REVIEW_PROMPT` 的 active bias 是生成垃圾沉淀的明显风险。

应采用：

> no-op first-class + evidence threshold + class-level threshold。

### 3. 不复制 Hermes 文件目录 archive/move 作为 correctness authority

DSH `ctx.fs` 本身没有通用 move/delete；RC5.2 sidecar lifecycle 更合适。

### 4. 不复制只靠 runtime tool whitelist 的安全模型

DSH 能在 child composition/tool restriction 层收窄 inherited business tools，再由 Host mutation boundary 做真正授权，层次更清楚。

---

# 8. 建议重排后的开发计划

不需要把 P0–P5 全推翻，只需改各 Phase 出口。

## P0 — Evidence Lock：33 项改为“当前架构证据集”

### 删除/移到历史回归区

- 原 T09 `.drafts` staging undiscovered；
- 原 T11 observer seam missing。

它们已经是被 RC5.2 淘汰的架构。

### 新增至少 8 项

1. `managed-provider-interface-contract`
2. `managed-provider-project-isolation`
3. `cross-layer-shadowing-rank-does-not-protect`
4. `managed-name-reservation-concurrent`
5. `managed-external-edit-digest-reject`
6. `cancel-settles-inflight-same-process`
7. `planned-attempt-id-replan`
8. `skill-tool-provider-attribution`

### P0 额外产物

锁定 Hermes commit SHA + 五个 evidence anchor。

---

## P1 — Memory

现 RC5.2 主体基本可保留，但出口增加：

1. 双 scope 数据模型是否一次到位——建议是；
2. publication pipeline 改 `sanitize → render → digest`；
3. receipt GC 暂不做，或必须有可证明 safe watermark；
4. `budget_exceeded` 的 bounded consolidation protocol；
5. write/read threat scan corpus；
6. MemoryState 与 op receipt 的 schema migration test。

P1 的核心价值应该是：

> **先把“安全、可重放、有界的长期 declarative memory”做好，再谈 review 自动化。**

---

## P2 — Managed Skill Provider

这是当前最需要先修规格再编码的一 phase。

进入代码前必须先把：

```text
SkillProvider interface
ProjectKey
ManagedSkillLocator
deterministic name identity
ManagedSkillStore
bundle read verification
```

写死。

建议包内部先是：

```text
tool-skill-manage/
  managed-store.ts
  managed-provider.ts
  authoring-core.ts
  governance.ts
```

而不是让 Provider 承担 authoring readback。

P2 同时至少提供一个最小用户治理入口：

```text
draft list/show/approve/reject
```

---

## P3 — Session Review

保持：

- ReviewCursor；
- oldest-first contiguous window；
- two-stage patch；
- planned durable boundary；
- whole-plan preflight；
- foreground preemption；
- resource-level idempotent commit。

新增：

1. `ReviewRangeId` / `ReviewAttemptId` 分离；
2. cancellation settlement；
3. “whole-plan admission, saga commit”术语；
4. no-op neutral persona；
5. create-skill class-level gate；
6. plan semantic size caps；
7. planned attempt recovery 不重新问模型。

---

## P4 — Curator

现 sidecar state machine 大方向正确。

修：

1. usage 按 exact managed identity/provider 计，不按 name 猜；
2. orphan = telemetry，不承诺 cleanup；
3. project storage quota；
4. `zeroUseGraceDays` 与 `staleAfterDays` 写成一个明确公式；
5. pin 永远由 user governance 写，curator 只读。

---

## P5 — Effectiveness

拆成：

```text
Operational telemetry
+
Quality evaluation harness
```

没有人工标注/held-out task 的“precision / false memory / repeated-task success”都不能声称已经测量。

推荐 gate：

### Memory

- false durable memory rate；
- user/project scope misclassification；
- correction-after-memory rate；
- token overhead；
- blocked-at-publication rate。

### Skill

- draft accept rate；
- unnecessary new-skill rate；
- patch-existing vs create-new 比；
- class-level reuse rate；
- learned skill caused regression；
- external tamper refusal rate。

### Review

- no-op rate；
- cost/session；
- cancellation rate；
- range lag；
- stale replan rate；
- crash recovery success。

---

# 9. 最优先整改清单

如果只允许先改 12 项，顺序建议：

1. **把 `ManagedSkillProvider` 改成真实 DSH `SkillProvider` 签名**
2. **locator 钉死 projectKey + skillId + exact revision + digest**
3. **把 workspace/cwd isolation 写进 provider/storage identity**
4. **撤回“rank 700 跨层绝对保护”的断言，并做 cross-layer REAL test**
5. **给 managed name 建原子 reservation / deterministic ID**
6. **provider.get 加 bundle digest + read-boundary scan**
7. **修 foreground cancellation settlement，消除永久 busy**
8. **分离 ReviewRangeId 与 ReviewAttemptId**
9. **receipt GC 不得靠静态 FIFO window 猜安全水位**
10. **usage 改成 exact provider/skillId attribution**
11. **补真实 draft approve/reject/pin 用户入口**
12. **把 P4 orphan cleanup 改成 telemetry + quota，禁止承诺当前 seam 做不到的 delete**

完成这 12 项后，RC5.2 的大架构无需再变；可形成 **RC5.3 implementation candidate**。

---

# 10. 最终判断

RC5.2 已经成功吸收了前四轮最关键的修正：

- 不再让 LLM 直接 mutation；
- 不再伪造文件系统事务；
- 不再拿 invocation flag 冒充生命周期；
- 不再假设 child session 不持久化；
- 不再拿 `agentPreset` 冒充 provenance；
- 不再用目录 move 做 Skill lifecycle；
- 不再让截窗永久跳过 evidence；
- 不再在 crash 后无条件重问模型；
- 不再让 background work 压住 foreground；
- 不再让 Memory 无界增长。

这说明整体设计已经从“概念方案”进入了“协议工程”。

但真正把 Hermes 和 DSH 的优点结合起来，最后还需要完成三件事：

### 第一，使用 DSH 的 Provider 契约，而不是只借 Provider 这个名字

真正使用：

```text
cwd
candidate
locator
scope layer
rank
complete/incomplete
invalidate
```

才能让 Managed Skill 成为 DSH 原生能力，而不是一个挂在 registry 外面的私有文件系统。

### 第二，吸收 Hermes 的治理经验，而不是只吸收“后台会总结”

Hermes 最有价值的不是 background LLM 本身，而是它在真实使用后逐渐补出的：

```text
bounded memory
dual memory target
double scan
foreground preemption
read-before-write
ownership fail-closed
class-level skills
pin/adopt
durable approval
recoverable archive
```

这些都是“自我进化长期跑起来以后才会暴露的问题”。

### 第三，坚持 RC5.2 已经比 Hermes 更先进的核心安全边界

即：

```text
LLM proposal
    ≠
permission to mutate
```

而是：

```text
LLM proposal
→ deterministic Host validation
→ immutable command attempt
→ resource-level idempotent commit
→ durable replay / recovery
```

这条不要退回 Hermes 的“review fork 拿写工具直接改”模式。

---

## 最终推荐架构一句话

> **用 DSH 的 Cordis/Session/Provider/storageDomain/subagent 作为可靠性骨架，用 Hermes 的 bounded memory、双语义记忆、foreground-first、ownership/pin/approval、class-level skill 经验作为自我进化治理策略；模型只负责提出有证据的学习提案，Host 才负责把它变成可恢复、可审计、受预算约束的长期状态。**

这将比“复制 Hermes 自我总结”或“只给 DSH 加一个 memory tool”都更稳健，也更符合本项目最终要实现的长期自主进化目标。
