# RC5.5 第七轮评审核验与处置

> 评审对象：`RC5.4-第七轮收口评审.md`（针对 RC5.4 方案套件的第七轮外部评审，6 项问题）。
>
> 核验基线：DSH `cd5ef8148158c3a752a658978873241fdf8e2bbc`（含 `packages/fs`、`packages/skill/skill`、`packages/skill/tool-skill` 源码）；Hermes Agent 本地克隆 `05c248d8`（`tools/skill_usage.py`）。
>
> 结论：**6 项问题全部确认属实**，逐项均有源码/规格证据；评审给出的修法有 **3 处需修正后采纳**（§2），其余照单采纳。阶段裁定采纳评审的门槛式开工方案：**RC5.4 = 架构批准 / 实现条件批准**——P0 即刻开工，P1、P2 各带前置修补，P3/P4 冻结纯文档推进。

## 总判断

第七轮的性质与前六轮不同：没有任何一条推翻 RC5.4 的架构主轴，全部是**协议闭环缺口**——规格里"承诺了 A 的测试"但"A 的机制"在另一个附件里没有写出来。这正是"架构收敛、协议欠账"的形态。逐项核验结果：

| # | 评审主张 | 判定 | 关键证据 |
|---|---|---|---|
| 1 | Store/Authoring API 只收 `skillId`，无法定位项目 | **确认（P2 blocker）** | `方案` L38/L67；附件 P2 §3 |
| 2 | Skill 资源级幂等未实现 + revision 并发覆盖 | **确认（P2 blocker）** | `方案` L66 死字段；P3 验收测试名；`fs/src/types.ts:118-125` |
| 3 | `stale` 无法 revive（死分支） | **确认** | `tool-skill/src/index.ts:134-136`；`skill/src/index.ts:501-508`；P2/P4 对照 |
| 4 | `pendingRevision` 无 `catalogSummary` + get 读当前 sidecar | **确认（P2 blocker）** | `方案` L63/L85；P2 get/activatePending 流程 |
| 5 | terminal ack 缺 scope 且不可重试 | **确认（P1 小 blocker）** | P1 §3 `splitReceipts`/`acknowledgeTerminalOps`；`方案` L49 |
| 6 | `effectiveThrough` 未持久化 | **确认（P1/P3 小 blocker）** | P3 `projectEvents`/`advance`；`方案` L46-49 ReviewAttempt 字段集 |

---

## 1. 逐项核验与处置

### S1-1 Store/Authoring API 只收 `skillId` —— 确认，采纳（修法修正后采纳）

证据链完整：

- `SkillId = hash(ProjectKey, normalizedName)`（`自我进化机制-RC5.4-方案.md` L38）——单向 hash，无法反推 projectKey。
- Store 键 `skill/<projectKey>/<skillId>`（P2 §3），但 `ensureRecord(skillId)` / `getRecord(skillId)` / `casPutRecord(record, expectedRevision)` / `readRevision(skillId, revision)` 均不携带 project 上下文。`ManagedSkillRecord` 虽有 `projectKey` 字段（`方案` L61），但读记录本身就需先组键——先有鸡还是先有蛋。
- `NameIndex { projectKey, nameToSkillId }`（`方案` L67）只有 name→skillId 正向映射，无反向。
- `createDraft` 带有 `authoring: AuthoringContext`（可从 cwd 解析 projectKey）所以不受影响；`patchDraft({ skillId, baseRevision, baseContentDigest, files, requestedBy })` 与 `skill_manage` 工具的 patch 通路、`readRevision` 主机调试通路全部裸传 skillId。

**处置**：采纳"禁止任何方法裸传 SkillId"。修正评审的形态建议（见 §2-修正二）：`ManagedSkillRef { projectKey, skillId }` 进公共 API；`ResolvedProject { projectKey, rootPath, rootTarget }` 不做公共类型——projectKey 一律由 Service 在入口从 `cwd/scope` 解析（与 `resolveMemoryScope(agent)` 同型），`rootPath/rootTarget` 是解析中间值不是契约。

### S1-2 Skill 资源级幂等缺失 + revision 并发覆盖 —— 确认，采纳（完成协议修正后采纳）

两部分均属实：

**幂等缺失**。P2 `patchDraft` 流程为"owner/state 校验 → CAS 双校验 → 写新 revision n+1 → 记 pending/推进 pointer"，`requestedBy` 全程未使用；`ManagedSkillRecord.lastAppliedOpId?`（`方案` L66）是死字段。而 P3 验收已钉 `skill-committed-ledger-mark-crash-reconciles` 与 `saga-crash-gap-resource-idempotent`——承诺存在、机制缺失，同 S1-12 在第六轮暴露的"JSDoc 不是协议"同型。crash 场景成立：resumable 重放 stored plan 重跑 op X，record 已在 N+1，base=N 校验失败 → `stale_base_revision`。Memory 侧已正确（`applyops-duplicate-before-stale`：receipt 查重先于 base 检查），Skill 侧必须补同型协议。

**revision 路径并发覆盖**。顺序编号 `revisions/n+1` 下，两个并发作者先读 N、都写 `revisions/N+1`、后 CAS record：败者的文件写入会穿插覆盖胜者的 bundle，record 指向内容被污染的 revision，digest 失配 → fail-closed 但技能被砖。评审对 fs 语义的引用准确：`writeText` 省略 intent 即无条件 create-or-overwrite（`packages/fs/fs/src/types.ts:120-121`），`{ kind: 'createIfAbsent' }` 存在（`types.ts:124`）。并发真实存在：ReviewCursor 按 session 隔离，同项目双 session 可并发 patch 同一技能。

**处置**：采纳 `ManagedRevisionId = hash(skillId, requestedByOpId)` + 资源 receipt（`lastAppliedOpId` duplicate-before-stale）。修正评审的完成判定协议（见 §2-修正一）：不能裸用 createIfAbsent 做"digest 相同 → duplicate / 不同 → corruption"，部分写入的 crash 重试会被误判 corruption 并永久砖死——改为"完成标记"协议（文件先全量重写、createIfAbsent 标记最后写）。

### S1-3 `stale` 死分支 —— 确认，采纳

证据：

- P2 provider list 只读 `state==='active'`；不变式行明写"draft/pending/rejected/archived 不出 provider；**active 才出 catalog**"——stale 不在可见谱系。
- `tool-skill` execute **每次调用先 re-list**：`(await ctx.skills.list(lookup)).find(...)` 找不到即抛 `skill "x" is unknown or no longer available`（`packages/skill/tool-skill/src/index.ts:134-136`）；`ctx.skills.get(name, lookup)` 内部同样 re-collect（`packages/skill/skill/src/index.ts:501-508` get→collect→winner）。不在 winning catalog 的技能没有任何加载通路。
- P4 `meaningful-use-revives`（stale → active 需 `lastMeaningfulUseAt > stateChangedAt`）依赖成功的模型载入，而载入依赖 listing——**死分支成立**。
- Hermes 锚点准确：`tools/skill_usage.py:19-21` "stale -> unused > stale_after_days (config)；archived -> ... moved to .archive/"；`_archive_dir()`（`:125-126`）只有 archive 挪文件，stale 原地保留。

**处置**：可见谱系改为 `active | stale`（stale = 归档倒计时，不是隐藏态）；隐藏 = `draft | rejected | archived`。连带修订：P2 验收 `provider-list-active-only` 更名 `provider-list-visible-lineage` 并改断言；不变式行同步改写；`/name` 人工载入不计 modelLoads 的 P4 判据不变。

### S1-4 `pendingRevision` 缺 `catalogSummary` + get 读当前 sidecar —— 确认，采纳

第一半：`pendingRevision?{revision,digest}`（`方案` L63）无 summary；`activatePending` 规格 = "CAS 切 `currentRevision = pendingRevision` 并清除"（P2 §3），approve 后 catalog 无新 summary 可切。patch 时提前更新 record 级 `catalogSummary` 则 pending 内容提前进模型 catalog，违反原则 #9——评审的"二选一都错"论证成立。

第二半：P2 get 流程"definition（summary 取 sidecar、content 取 revision）"。机制精确化：registry `get(name)` 是 re-collect 后把"the winning candidate originally returned by this provider"交回 provider（`skill/src/index.ts:262-263,501-508`），且转型必 `invalidate()` 清 collect cache——所以常见路径 candidate 与 sidecar 已一致；残余竞态是 approve+invalidate 恰落在"cache 命中的旧 candidate"与"provider.get 内部读 sidecar"之间，产生 body=N / summary=N+1 的错配 definition。评审的机制描述（"list 时的 candidate 原样交回"）在缓存命中间接成立、契约层正确，结论不变。

**处置**：双采。`pendingRevision{revisionId, contentDigest, catalogSummary, createdByOpId}`，approve 单 record CAS 四字段原子切换（currentRevision/contentDigest/catalogSummary/清 pending）；get 的 definition summary 一律取 candidate 冻结值（registry 契约本来就把 candidate 定位为 provider 自己先前返回的冻结物），content 取 `locator.revision`。补充：frozen summary 在 patch 时由 `validateStructure` 的 frontmatter 解析产出（E0-10 字段集已有），approve 侧 P3 重验（digest/scan/conflict）不新增解析面。

### S1-5 terminal ack 缺 scope 且不可重试 —— 确认，采纳

- `acknowledgeTerminalOps(opIds)`（P1 §3；总纲 L29/L42/L55）无 scope 维度。MemoryState 按 scope 分记录（per-projectKey + user），opIds 无法定位目标记录。措辞修正：并非"无法实现"——可全 scope 扫描命中，但那是隐式边界、跨记录非原子，违反仓库"Explicit > implicit at package boundaries"约定；分组签名是正确修法。
- `splitReceipts`：`terminalOpIds ⊄ pending → invalid_structure`（P1 §3）。协议要求的恢复重放（`terminal && !terminalAcked` 再 ack）第二次必然命中此错误——与 at-least-once 恢复原则冲突，评审判断成立。
- `terminalAcked?` 字段已留（`方案` L49 ReviewAttempt）但 P3 无恢复协议条目——第六轮 S1-12 的"字段不是协议"再现。

**处置**：签名改 `acknowledgeTerminalOps(groups: readonly { scope, opIds }[])`（P3 按 plan op 的 target/scope 分组，信息现成）；ack 语义改幂等三分：in pending → 迁移；已在 recentTerminal → duplicate-ack 成功；两处皆无 → `invalid_structure`（启动恢复期无中间 ack，环不可能已淘汰该 op，corruption 判定安全）；P3 增加 terminal-recovery 协议条目：启动恢复先重放 `status ∈ terminal && !terminalAcked`（幂等 ack → advance → 清 inFlight），完成后才接受新 review mutation。

### S1-6 `effectiveThrough` 未持久化 —— 确认，采纳（后果加严）

`effectiveThrough` 仅存在于 `projectEvents` 返回值与 `advance(attemptId, effectiveThrough)` 参数（P3 §2/§3），ReviewAttempt 字段集（`方案` L46-49）无此字段。P3 提交序为 `markTerminal → ack → advance → 释放 inFlight`，markTerminal 与 advance 之间存在 crash 窗：inFlight 未清、cursor 未进、attempt 已 terminal。后果比评审所述更重：恢复若续跑 stored plan，memory op 靠同 opId receipt 挡住，skill op 在 S1-2 修复前会 `stale_base_revision`；若放弃续跑改重 claim，同区间生成新 attempt 新 opId，memory 条目**重复写入**（无跨 attempt 去重）；而"advance 到 200"则永久跳过未审 evidence——三条路都需要 attempt 自带答案。

**处置**：ReviewAttempt 增加 `effectiveThrough`，在 LearningView 完成后、planner 启动前随 `putAttempt` 持久化；terminal-recovery（S1-5 协议）用持久化值 `advance(effectiveThrough)`，禁止恢复期重算。

---

## 2. 评审中需修正后采纳的部分

1. **修正一（S1-2 完成协议）**：评审的"已存在且 digest 相同 → duplicate；不同 → corruption"在 createIfAbsent 下会砖死合法重试。fs 12 原语无 move/rename/delete，crash 落在 bundle 部分写入后，重试既不能补写（createIfAbsent 拒绝）也不能清除（无 delete）——部分 bundle 被永久判为 corruption。修正协议：op-derived 目录内**文件全量重写**（同 op 重放内容确定性相同，覆写同字节无害），末尾写**完成标记**（`createIfAbsent`，首写者胜）：标记在 → 校验 digest，符则 duplicate-continue、不符则真 corruption fail-loud；标记缺 → 重写文件后补标记。评审的全部不变式（并发不共路径、同 op 同 revisionId、record CAS 决胜、败者 orphan）全部保留。
2. **修正二（S1-1 形态）**：`ResolvedProject{projectKey, rootPath, rootTarget}` 不进公共 API。DSH 惯例是入口从 `cwd/scope` 解析身份（`resolveMemoryScope(agent)` 同型），`targetKey` 语义按 `fs/src/types.ts` 只做 identity 不外借；公共面变化收敛为 `ManagedSkillRef`。
3. **修正三（S1-4 机制）**：list→get 竞态的机理如 §S1-4 所述——re-collect + invalidate 使常见路径已一致，缺陷是 get 内残余竞态；修法（definition summary 取 candidate 冻结值）不变且是 registry 契约（"the winning candidate originally returned by this provider"）的正面应用。
4. **措辞修正（S1-5）**："API 本身缺信息"过强——可全 scope 扫描实现；采纳分组签名的理由是显式边界与跨记录原子性，不是可实现性。
5. **补充事实**：`FsWriteIntent` 还有 `{ kind: 'replaceIfVersion' }` 臂（`fs/src/types.ts:125`，版本守护覆写），评审未提及；完成标记协议仍选 createIfAbsent（首写者胜语义无需版本先读）。

---

## 3. 阶段门裁定（采纳评审框架）

正式记录：**RC5.4 = 架构批准 / 实现条件批准**。九原则（含 #8 read-boundary、#9 Visibility is a separate commit）冻结不动。

- **P0：即刻开工**，零行为变更 Evidence Lock，53 项 + 本轮新增 T54–T61（§4）。发现事实不符先改规格再进 P1（既有规则不变）。
- **P1：前置 = S1-5 分组幂等 ack + S1-6 effectiveThrough 持久化/terminal-recovery 协议**；其余结构（单 Service、composite Publisher、sanitize→render、hard budget、receipt 二分）冻结。
- **P2：前置 = S1-1 ManagedSkillRef + S1-2 op-derived RevisionId/资源 receipt/完成标记协议 + S1-3 可见谱系 active|stale + S1-4 pending 四字段 CAS**；并采纳评审补充的"pending 未处理时拒绝再次 patch"（`pending_pending_conflict` 错误码）。
- **P3/P4：冻结纯文档前推**，剩余问题改由 REAL composition / crash injection / concurrency injection / HMR disposal / snapshot 在代码中发现。RC5.5 以**增量补丁**形式落地（附件原位修订 + 变更记录），不再整套重写。

---

## 4. P0 新增证据测试（T54–T61）

| 测试 | 钉住的事实 | 来源 |
|---|---|---|
| T54 `stale-skill-remains-discoverable` | stale 在 provider 可见谱系；tool list→get 可达；meaningful use 可复活 | S1-3 |
| T55 `op-derived-revision-path-exclusive` | 并发 op 不共享 revision 目录；record CAS 决胜；败者 orphan 计数 | S1-2 |
| T56 `partial-bundle-crash-retry-completes` | 完成标记协议：部分写入重试补全而非 corruption；真异物才 fail-loud | S1-2 + 修正一 |
| T57 `skill-op-retry-duplicate-before-stale` | `lastAppliedOpId` 命中先于 base 校验，重放成功不报 `stale_base_revision` | S1-2 |
| T58 `memory-terminal-ack-scoped-and-idempotent` | 分组签名定位 scope；重 ack 成功；孤儿 opId 报 `invalid_structure` | S1-5 |
| T59 `terminal-recovery-advances-persisted-effective-through` | 恢复用 attempt 持久化值推进，不重算、不跳 evidence | S1-6 |
| T60 `pending-catalog-switches-only-on-approve` | patch 不动 record 级 summary；approve 单 CAS 四字段原子切换 | S1-4 |
| T61 `provider-get-uses-listed-candidate-summary` | definition summary 取 candidate 冻结值；并发转型不产生 body/summary 错配 | S1-4 |

---

## 5. 证据锚点表

| 评审主张 | 源码/规格证据 |
|---|---|
| SkillId 单向、Store 键含 projectKey 而 API 裸传 skillId | `自我进化机制-RC5.4-方案.md` L38/L61/L67；`RC5.4-附件P2-skill-managed.md` §3 |
| `lastAppliedOpId?` 死字段、patch 流程未用 `requestedBy` | `方案` L66；P2 §3 `patchDraft` |
| P3 幂等承诺 | P3 §4 验收 `skill-committed-ledger-mark-crash-reconciles`、`saga-crash-gap-resource-idempotent` |
| writeText 无 intent = 无条件覆盖；createIfAbsent/replaceIfVersion 存在 | `packages/fs/fs/src/types.ts:118-125` |
| skill tool 每次调用先 list，缺失即 unknown | `packages/skill/tool-skill/src/index.ts:134-136`（get 检查 `:141-143`） |
| registry get re-collect、candidate 契约 | `packages/skill/skill/src/index.ts:262-263,501-508` |
| provider list 仅 active、get summary 取 sidecar、activatePending 不切 summary | P2 §2/§3；`方案` L85 |
| ack 无 scope、splitReceipts 拒绝二次 ack、terminalAcked 字段空悬 | P1 §3；`方案` L46-49 |
| effectiveThrough 仅运行时 | P3 §2 `projectEvents`、§3 `advance`；`方案` L46-49 无此字段 |
| Hermes stale 原地保留、archive 才挪 `.archive/` | `mozi-hermes-agent/tools/skill_usage.py:19-21,54-56,125-126` |

## 6. 后续

待"继续"后产出 RC5.5 增量补丁：附件 P0（+T54–T61）、P1（ack 签名/语义、terminal-recovery、`effectiveThrough`）、P2（ManagedSkillRef、op-derived RevisionId + 完成标记、可见谱系、pending 四字段、pending 互斥）、P3（terminal-recovery 协议条目、ReviewAttempt 字段）、方案（数据模型三处字段修订）与总纲同步，附变更记录；随后进入 P0 代码实现。
