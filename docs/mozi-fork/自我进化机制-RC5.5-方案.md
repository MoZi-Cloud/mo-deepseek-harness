# 自我进化机制方案 RC5.5.2（第八轮后开工前修补：规格缺口收口，架构零变化）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 版本脉络：RC1 → 评审（`评审报告.md`）→ RC4 → 第二轮核验（`RC5-外部建议核验与处置.md`）→ RC5.1 → 第四轮（`RC5.1-评审报告.md` + `RC5.2-第四轮评审核验与处置.md`）→ RC5.2 → 第五轮（`RC5.2评审报告.md` + `RC5.3-第五轮评审核验与处置.md`）→ RC5.3 → 第六轮（`RC5.3-第六轮纠错完善建议.md` + `RC5.4-第六轮评审核验与处置.md`，12 S1 全部证实）→ RC5.4 → 第七轮（`RC5.4-第七轮收口评审.md` + `RC5.5-第七轮评审核验与处置.md`，6 项全部证实）→ RC5.5 → 第八轮（`RC5.5-第八轮开工评审.md` + `RC5.5.1-第八轮评审核验与处置.md`，6 项全部证实）→ RC5.5.1 → 开工前自查修补（无独立评审轮——第八轮纪律下的 spec-bug 级原位修订）→ 本 RC5.5.2
>
> 函数级规格：`RC5.5-函数级规格总纲.md` + 附件 P0–P4（类名/签名/调用关系/验收标准，TDD）
>
> 证据基线：upstream master = `cd5ef81`（fork 零代码漂移）；Hermes 锚点 = 本地 clone `05c248d8`（第五轮处置 §5）；证据账本 = 历轮评审/处置文档
>
> 阶段裁定（第八轮）：**RC5.5.1 = Architecture Frozen / Implementation Approved**——九原则与包边界冻结；P0/P1 即刻 GO；P2 先红 T62/T64/T65 三组再写 mutation path；P3 骨架与纯函数 GO、finalization commit path 前置 T66–T68 三协议；P4 after P3；P5 按原计划。自此停发 RC5.6 式文档套件：后续发现默认按 bug / invariant test / implementation adjustment 处理，仅当 P0 REAL-composition 反证 DSH API 基础假设时才重开架构。首版 crash model = Host/process crash + restart（`fs-local/src/fsio.ts:546-594` staged + atomic rename），不声称断电/内核崩溃级保证
>
> 日期：2026-08-29（RC5.5.1 增补 2026-08-30；RC5.5.2 修补 2026-08-30）

## 0.0 相对 RC5.4 的增量（第七轮 6 项收口，处置 §1）

1. **定位传递（S1-1）**：任何 API 不裸传 `SkillId`——Store/Authoring/治理一律 `ManagedSkillRef{projectKey, skillId}`；projectKey 由 Service 入口从 `cwd/scope` 解析（同 `resolveMemoryScope` 型），`ResolvedProject` 只做内部中间值不做公共类型。
2. **revision 身份与资源 receipt（S1-2）**：`ManagedRevisionId = hash(skillId, requestedByOpId)`——并发 op 不共路径、同 op 重放同路径；bundle 写入 = 全量重写 + 完成标记末位 `createIfAbsent`（fs 无 move/delete，部分写入靠重放补全，标记在而 digest 异才是 `invalid_structure`）；`lastAppliedOpId` 在 CAS 中激活，patch 先查重（duplicate-before-stale，与 memory 同型）。
3. **可见谱系（S1-3）**：provider 可见 = `active | stale`（stale 是归档倒计时不是隐藏态）；隐藏 = `draft | rejected | archived`——否则 stale 的 meaningful-use 复活是死分支（tool-skill 每次调用先 re-list，`tool-skill/src/index.ts:134-136`）。
4. **pending 四字段（S1-4）**：`pendingRevision{revisionId, contentDigest, catalogSummary, createdByOpId}`，approve 单 record CAS 原子切换；get 的 definition summary 取 candidate 冻结字段（`SkillCandidate extends SkillSummary` 字段齐全），content 取 `locator.revision`。
5. **ack 分组 + 幂等（S1-5）**：`acknowledgeTerminalOps(scopeGroups)`；语义三分——in pending → 迁移、已在环 → duplicate-ack 成功、两无 → `invalid_structure`；P3 terminal-recovery 先重放 `terminal && !terminalAcked` 再接受新 mutation。
6. **`effectiveThrough` 持久化（S1-6）**：进 `ReviewAttempt`，LearningView 完成后、planner 前回填；terminal-recovery 唯一推进依据，禁止恢复期重算。

## 0.0.1 相对 RC5.5 的增量（第八轮 6 项开工补丁，处置 §1）

1. **Skill receipt 对称化（S1-1，T65）**：退役 `lastAppliedOpId` 单槽——跨 session 窗口（A 落账、B 再写、A 重放）下已发生的 op 被误判 `stale_base_revision`。`ManagedSkillRecord.appliedOps = SkillAppliedOps { pendingReceipts, recentTerminalReceipts }` 与 Memory 对称；单 record CAS 同时落 state + receipt；重放查重 `pending ∪ recentTerminal` 先于 base 校验；`ManagedSkillService.acknowledgeTerminalOps({ref, opIds}[])` terminal 后入有界环。
2. **create 幂等（S1-2，T64）**：`NameIndex` 值改 `NameReservation { skillId, reservedByOpId }`——同 op 重入 resume、异 op `name_conflict`；create 流程重排为 receipt 查重 → op-aware reserve → 完成标记写 bundle → record CAS + receipt。
3. **`OpId` 派生钉死（S1-3，T62/T63）**：`OpId = hash(attemptId, resourceKind, stableOpIndex, canonicalOpDigest)`（`deriveOpId` 纯派生，模型不提供 opId，恢复重放同 op 同 id）——`ManagedRevisionId`、两资源 receipt、`MemoryEntryId` 的重放稳定性共同 rooted 在此。
4. **ack 输入修正（S1-4，T66）**：ack 权威输入 = `ReviewAttempt.opStates[]` 中 `state ∈ {applied, duplicate}` 的 op（非 plan 全量——partial-saga 与零 mutation terminal 不再误报 `invalid_structure`）；`opStates` 升格正式类型 `ReviewOpState`。
5. **finalization 协议（S1-5，T67）**：`terminalAcked?` 改名 `finalized`（"字段存在 ≠ 协议存在"再现）；定序 `markTerminal(status, rangeDisposition) → ack applied receipts（memory + skill）→ advance（仅 consumed，单调 max-guard）→ markFinalized`；recovery 入口 `terminal && !finalized`。
6. **`RangeDisposition`（S1-6，T68，P3 最重 blocker）**：`consumed | superseded | retryable | manual` 随 markTerminal 落账；**仅 consumed 允许 advance(effectiveThrough)**，其余 disposition 恢复时清 inFlight 不推进（下次触发重 claim，宁重审不跳审）。L1 映射修正评审提案：consumed 仅 committed/noChange；stale/budget → superseded；拒绝类（含 admission/policy/planner 瞬态）→ retryable 背退——评审的"policy rejected → consumed"自带"若产品决定不再重试"括号，L1 不采纳：零 commit 拒绝的 range 重审合法（base state 可能已变），advance 即违反 `saga-range-never-skips`；manual 预留 L2。

## 0.0.2 相对 RC5.5.1 的增量（开工前自查修补，六项，全部规格级）

1. **P1 ack 措辞对齐（第八轮 S1-4 残留）**：`RC5.5-附件P1` §3 `acknowledgeTerminalOps` 正文仍写"按 plan memory op 的 target/scope 分组"——即第八轮已证伪并改正的表述，与同文件头部声明自相矛盾；改为 applied-only `opStates` 分组。
2. **P3 Config 表恢复**：全套重写时 RC5.1-P3 §6 的 Config 清单失落，triggerMode/预算/persona/rolloutLevel 等散落正文无集中表——违反"tunables 必须是 validated Config 字段"与总纲 §1 自身约定；按现行机制重组为 P3 §7。
3. **`transitionManagedSkill` 补规格**：总纲调用图、本文件 §3、P4 runPass、P2 验收名四处引用而零处有签名（"字段存在 ≠ 协议存在"残留）；补入 P2 §3（单 record CAS + 时间锚点同笔落账 + Service 层 pinned 门）。
4. **P0 计数更正**：矩阵实为 68 项，其中 T09/T11 为历史回归（活跃 66）；"68 活跃 + 2 历史"的写法合计 70，各处更正为"68 项（66 活跃 + 2 历史回归）"。
5. **`pinned` L1 无产生点声明**：治理命令面（list/show/approve/reject/reopen）无 pin/unpin，L1 恒 false——照 `manual` disposition 先例声明"L2 预留、L1 无产生点"；Service 层 pinned 门不可绕过（P4 `pinned-user-gate-unbypassable` 语义锚点）。
6. **命名残留清理**：P2 Config `stagingRootName` → `managedRootName`（staging 概念已随目录方案消亡，该字段实为 revisions 根）；总纲调用图 "SkillAuthoring=" 旧包名标签删除。

架构、数据模型、阶段裁定零变化——按第八轮纪律属 implementation-adjustment 级，不构成新的评审轮次。

## 0. 相对 RC5.3 的四组实质变化

1. **唯一所有权（第六轮 S1-1..S1-3、S1-7）**：Cordis Service 同名注册即抛（`vendor/cordis/src/service.ts:37-53`、`reflect.ts:272-285`）、`DomainFacility` 单开域名（`storage-domain/src/index.ts:66-95`）——一切共享资源必须有一个唯一 owner。Memory = 单一 `MemoryService` 内部管 project/user 两逻辑 scope（一个 composite Publisher 发一条消息）；Skill = P2 一步到位的 `packages/skill/skill-managed` Service（唯一 domain owner，同包 named export `skill_manage` 工具插件挂 authoring preset），P3 的抽出步骤取消。NameIndex 首次 reserve 走 `ensureNameIndex` 初始化协议。
2. **身份与可见性（S1-4..S1-6、S2-2、S2-6）**：`ProjectKey = hash((await ctx.fs.resolve(findProjectRoot(cwd))).targetKey)`（realpath 身份，`fs/fs/src/index.ts:100-118`；`FsTargetKey` 禁止解析，`types.ts:8-15`）；authoring commit 固化 `catalogSummary` 进 sidecar，**`list()` 只读 storage、`get()` 才读 filesystem + bundle digest + 扫描**——模型可见 catalog 的信任与 body 信任分层（tool-skill 每 pre-step 把 summary 写进 durable catalog 消息，`tool-skill/src/index.ts:219-250`）；usage 归属改监听 live `tools/result`（durable `tool/result` 无 canonical value，`core/tools/src/index.ts:193-198`）；T36 钉死 registry 真相（最近层恒胜，与人/managed 无关），shipped"人工恒胜"由挂载位置 + REAL 枚举达成。
3. **治理状态机闭环（S1-8、S1-9、S2-5）**：新增 `rejected` 状态（draft → rejected → 显式 reopen；`archived` 专属曾 active 生命周期）；active patch 改 `pendingRevision`——写新 revision 不切 `currentRevision`，治理 approve 才 CAS 切 pointer；draft patch 仍直接推进（本就不可见）。模型自此在 L1 无任何路径改动模型可见技能。
4. **attempt 与 receipt 协议化（S1-10..S1-12、S1-11）**：`attemptId = hash(rangeId, attemptNo)`（attemptNo 由 cursor durable 分配；`baseStateDigest` 降为 attempt 字段，消除 preclaim 循环）；`budget_exceeded` → zero commit → consolidation 生成**新 attempt** 重走 whole-plan admission；receipt 二分 `pendingReceipts`（non-terminal 永不淘汰）+ `recentTerminalReceipts`（terminal 后 ack 入有界环才可 GC）——保留正确性显式编码，ack 缺失=过量保留（安全方向）。

锁定项（不再讨论）：自进化业务不进 `agent-loop`；LLM 只 proposes；host 拥有全部权威字段；spawn 复盘；子会话持久化保留 + 检索面隔离；project 自治域先行；L0→L2 rollout；首版无 `review/*` 事件；LLM curator consolidation 默认关；不改 registry 消费侧；不改 durable 事件面（telemetry 走 live 事件）；不声称断电/内核崩溃级 crash 保证（首版 crash model = process crash + restart）。

## 0.1 九条第一原则（终稿）

1. **Everything is a plugin, but not every role is a package.**
2. **LLM proposes; Host commits.**
3. **Dynamic model-visible state is replay-authoritative**（动态内容来自 durable Session source；静态面由 composition revision + validated Config 重建）。
4. **Model text never owns authority metadata.**
5. **At-least-once trigger; resource-level idempotent commit.**
6. **Project autonomous domain first.**
7. **Learning requires admissible evidence.** 证据引用是必要条件非充分条件；模型自报 confidence 不构成授权。
8. **Managed output is untrusted until every model-visible read boundary is verified.** 不止 body：catalog summary 同样经 sidecar 固化后才行（trust transition：Untrusted proposal → Host validation → immutable revision → digest+scan（body）/ sidecar（summary）→ registry）。
9. **Visibility is a separate commit.** 写入完成 ≠ 模型可见；经 authority/policy gate 后 Host 才切换模型可见状态（memory：权威 mutation → 下一 pre-step 发布；skill：revision 写入 → approval → pointer activation）。

## 1. 数据模型

```text
ProjectKey（branded）        = hash(ctx.fs.resolve(findProjectRoot(cwd)).targetKey)
SkillId（branded）           = hash(ProjectKey, normalizedName)——确定性，同名并发天然串行
ManagedSkillRef（branded）   { projectKey, skillId }——一切 Store/Authoring/治理 API 的定位单位，
                               禁止裸传 SkillId（单向 hash 无法反推 projectKey，第七轮 S1-1）
OpId（branded）              = hash(attemptId, resourceKind, stableOpIndex, canonicalOpDigest)
                               ——deriveOpId 纯派生（第八轮 S1-3，T62/T63）：模型不提供 opId；
                               同一 immutable plan 任意次 recovery 同 opId；payload 变 → id 变；
                               ManagedRevisionId/两资源 receipt/MemoryEntryId 的重放稳定性共同 rooted 在此
ManagedRevisionId（branded） = hash(skillId, requestedByOpId)——op-derived：并发 op 不共路径，
                               同 op 重放同路径（第七轮 S1-2）
ReviewCursor（per-session）  { sessionId, reviewedThroughSeq, desiredThroughSeq, policyVersion,
                               learningViewVersion, rangeId,
                               inFlight? { attemptId, attemptNo, fromExclusive,
                               throughInclusive, status: running|resumable } }
ReviewRangeId                = hash(sessionId, fromExclusive, throughInclusive, policyVersion,
                               learningViewVersion)
ReviewAttemptId              = hash(rangeId, attemptNo)——attemptNo cursor durable 分配
ReviewOpState                { opId, resource: 'memory'|'skill', resourceRef,
                               state: prepared|applied|duplicate|failed }——ledger 缺席 = not-started；
                               saga recovery authority（第八轮 S1-4）：ack 只取 applied|duplicate
ReviewAttempt（append-only） { attemptId, attemptNo, status: planning|planned|committing|
                               committed|failed|cancelled, baseStateDigest?, plan?, planDigest?,
                               baseRevisions?, opStates: ReviewOpState[], attemptCount,
                               lastFailureCode?, nextRetryAt?, finalized?, effectiveThrough?,
                               rangeDisposition?: consumed|superseded|retryable|manual }
                               ——plan 永不可变；effectiveThrough 在 LearningView 完成后、planner 前
                               回填（第七轮 S1-6，禁止恢复期重算）；rangeDisposition 随 markTerminal
                               落账，仅 consumed 允许 advance（第八轮 S1-6，T68）；finalized = 本
                               terminal attempt 全部恢复义务完成（第八轮 S1-5，T67）
ReviewPlan（模型数据）       { memory[{ action, target:'project'|'user', targetHint?, content?,
                               kind, evidence[{seq, span?, fieldPath?}], reason, confidence }],
                               skills[{ action:'create-draft'|'patch-draft', skillName,
                               patchTarget?: skillId, candidateSearchSummary?,
                               whyNoExistingManagedSkillFits?, classLevelRationale?,
                               evidence[], files[] }], noChangeReason? }
MemoryState                  { schemaVersion, revision, entries[],
                               appliedOps: { pendingReceipts, recentTerminalReceipts } }
CompositeMemorySnapshot      { kind:'memory', form:'snapshot', sections,
                               scopes:{ project?:{revision,digest}, user?:{revision,digest} },
                               digest }——一个 producer，P1 只填 project
ManagedSkillRecord           { projectKey, skillId, name, owner,
                               state: draft|active|stale|archived|rejected,
                               currentRevision: ManagedRevisionId, contentDigest,
                               pendingRevision?{ revisionId, contentDigest, catalogSummary,
                               createdByOpId }——四字段随 approve 单 CAS 原子切换（第七轮 S1-4），
                               catalogSummary{ name, description, whenToUse?, invocation },
                               revision, createdAt, promotedAt?, stateChangedAt?, staleAt?,
                               archivedAt?, createdByAttemptId?,
                               appliedOps: SkillAppliedOps, pinned }
SkillAppliedOps              { pendingReceipts: SkillOpReceipt[],       // non-terminal 永不淘汰
                               recentTerminalReceipts: BoundedRing }    // 与 Memory 对称（第八轮 S1-1）
SkillOpReceipt               { opId, action, revisionId?, resultDigest }——CAS 内与 state 同笔落账；
                               重放查重 pending ∪ recentTerminal 先于 base 校验（T65）
NameIndex（per-project）     { projectKey, nameToReservation }——ensureNameIndex + 单 RMW；
                               NameReservation { skillId, reservedByOpId }：同 op 重入 resume、
                               异 op name_conflict（第八轮 S1-2，T64）
```

## 2. 包规划与挂载

| 包 | 内容 | Phase | 挂载层 |
|---|---|---|---|
| `packages/util/content-scan` | `scanContent()` + `PATTERN_SET_VERSION` + 四语料 | P1 | — |
| `packages/memory/memory` | **单一** `MemoryService extends Service`（project/user 两逻辑 scope + `acknowledgeTerminalOps(scopeGroups)`）；composite `MemoryPublisher`（pre-step，fail-open） | P1 | host 组合 |
| `packages/skill/skill-managed` | **`ManagedSkillService extends Service`**（唯一 domain owner：Store/NameIndex/Provider/AuthoringCore；`ManagedSkillRef` 定位 + op-derived `ManagedRevisionId` + 完成标记协议）；named export `skill_manage` 工具插件 | P2 | Service+provider 挂 host cordis.yml（global 层）；工具挂 authoring preset |
| `packages/review/session-review` | `ReviewRuntime` + RangeId/Attempt ledger + 两阶段 planner + admission/saga + 治理命令 | P3 | authoring preset（session-query 默认过滤先行） |
| `packages/skill/skill-curator` | 生命周期状态机（active 谱系）+ live `tools/result` usage | P4 | host 组合 |

**fork-diff 台账**（对上游包的修改仅此一处，PR 逐行说明）：`packages/session-query/tool-session-query` 模型面默认附加 `{kind:'parent', values:[null]}`（`session-query/src/types.ts:198`）+ `includeChildSessions` 逃生参数；`ctx.sessionQuery` 服务不改。**不**为 telemetry 修改 tool-skill 持久化面。

## 3. 机制要点（细节见附件）

- **memory**（P1）：单 Service 双 scope；发布 = `sanitizeForPublication → buildSnapshotSections（含两 scope 节）→ combined digest → 比对 → 发布 CompositeMemorySnapshot`；receipt 二分 + `acknowledgeTerminalOps(scopeGroups)`（幂等三分：pending 迁移 / 已入环 duplicate-ack / 两无 `invalid_structure`，S1-5；输入来自 P3 的 applied-only opStates，第八轮 S1-4）；opId 由 `deriveOpId` 供给 → `MemoryEntryId` 与 receipt 跨恢复稳定（第八轮 S1-3）；双闸扫描 + fail-open 不变。
- **skill-managed**（P2）：一切 API 走 `ManagedSkillRef`，禁止裸 `SkillId`；`list()` storage-only、可见谱系 = `active | stale`（S1-3；单条损坏 → last-good + `complete:false`）；`get()` = projectKey 校验 → exact revision → 整 bundle digest → 读边界重扫 → definition（summary/invocation 取 candidate 冻结字段、content 取 `locator.revision`，S1-4）；revision 目录 op-derived（`revisions/<ManagedRevisionId>/`）+ 全量重写 + 完成标记 `createIfAbsent`（S1-2）；**资源 receipt 与 Memory 对称**（`SkillAppliedOps`，CAS 内同笔落账，重放查重先于 base 校验，第八轮 S1-1/T65）；create = receipt 查重 → `checkNameConflict(AuthoringContext)` → `ensureNameIndex + reserveName(…, requestedBy)`（NameReservation：同 op resume / 异 op conflict，第八轮 S1-2/T64）→ `validateStructure` → 写 revision → record(draft, catalogSummary, receipt)；patch 先查重、active 且 pending 未决 → `pending_pending_conflict`，draft 直进 currentRevision、active 只进 pendingRevision 四字段；promote/activate/reject/reopen = 治理面 CAS（activatePending 四字段原子切换）；`acknowledgeTerminalOps({ref, opIds}[])`；配额 fail-loud。
- **触发与取消**（P3）：三触发模式 + settlement（planning 取消清 inFlight；planned/committing 转 resumable 续 stored plan）——RC5.3 已定，不变；**finalization 协议**（第八轮 S1-5/S1-6，T66–T68）：opId = `deriveOpId` 纯派生 → saga commit（`markOpState` 落 `ReviewOpState`）→ `markTerminal(status, rangeDisposition)` → ack **applied-only** receipts（memory + skill）→ `advance(effectiveThrough)` **仅 disposition=consumed**（单调 max-guard）→ `markFinalized`；启动 recovery 重放 `terminal && !finalized`，非 consumed disposition 清 inFlight 不推进。
- **admission + saga**（P3）：whole-plan admission；`stale_base_revision` → 新 attempt replan；`budget_exceeded` → zero commit → consolidation 新 attempt（`maxConsolidationAttempts` 默认 2）→ 仍败 terminal 零 commit；L1 启用 scope = project（ReviewInput/persona 声明）+ `target:'user'` backstop 拒绝（记录 + `target_scope_disabled`）。
- **治理面**（P3）：宿主命令 list/show/approve/reject/reopen——approve 双语义（draft 上架；active pending 切 pointer），全部全重验后走 Service CAS；模型工具面无任何治理动作。
- **usage**（P4）：live `ctx.on('tools/result')`——`exec.name==='skill' && !result.isError && result.value?.provider === MANAGED_SKILL_PROVIDER_NAME`，按确定性 `skillId = hash(projectKey, name)` 归属（无需查表）；`/name` 只作聚合遥测；进程内存活期观测，HMR dispose 即止。
- **生命周期**（P4）：`transition()` 只迁移 active 谱系（active/stale/archived）；draft/rejected 永不自动迁移；orphan/配额遥测；一切写经 `transitionManagedSkill`。
- **rollout**（P5）：L0 Shadow → L1 Conservative → L2 Autonomous（user scope section、PendingChange durable store、inference 门）；operational/quality 指标两拆不变。

## 4. Phase 门槛（P0–P5）

P0 = Evidence Lock 68 项（66 活跃 + 2 历史回归；附件 P0，含第七轮 T54–T61、第八轮 T62–T68）。P1 = 单 Service 双 scope + composite 发布 + receipt 二分 + ack 分组幂等协议（opId 由 deriveOpId 供给）。P2 = skill-managed Service 一步到位（ManagedSkillRef 定位、storage-only list、visible = active|stale、op-derived RevisionId + 完成标记、**SkillAppliedOps 资源 receipt + NameReservation op-aware 占位**、pendingRevision 四字段 + 互斥、rejected/reopen、NameIndex ensure、配额、跨层 REAL 枚举）；**先红 T62/T64/T65 三组再写 mutation path**。P3 = review 全链（attempt 简化、consolidation 新 attempt、治理双语义、scope backstop、effectiveThrough 持久化、deriveOpId + ReviewOpState + markTerminal(disposition)/markFinalized finalization 协议）+ session-query 默认过滤；**骨架/纯函数先行，finalization commit path 前置 T66–T68**。P4 = curator（active 谱系状态机 + live usage 归属；stale 可见可复活）。P5 = rollout + 指标两拆。

每 Phase 固定门槛：per-file 100% 覆盖、REAL-composition boot、HMR disposal、snapshot、双 SDK（类型面变更时）、doc-sync、Agent Note。

## 5. 非目标

不改 `agent-loop`；不改 registry 消费侧语义；不新增模型工具面以外的动态模型可见通道；不做语义/向量检索；不做跨设备同步；不扩 `writableRoots`；不做 user-dsh 自主写；首版不做 user scope section 与 PendingChange durable store（L2）；不实现窄删除 capability 与 orphan 物理清理；不修改 tool-skill 持久化面（telemetry 用 live 事件）；不做多 Host 共享 storage root；首版不加 `review/*` 会话事件；不给 `ctx.fs` 加通用 move/delete。
