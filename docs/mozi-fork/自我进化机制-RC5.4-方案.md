# 自我进化机制方案 RC5.4（唯一所有权 + 可见性分离 + 状态机闭环）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 版本脉络：RC1 → 评审（`评审报告.md`）→ RC4 → 第二轮核验（`RC5-外部建议核验与处置.md`）→ RC5.1 → 第四轮（`RC5.1-评审报告.md` + `RC5.2-第四轮评审核验与处置.md`）→ RC5.2 → 第五轮（`RC5.2评审报告.md` + `RC5.3-第五轮评审核验与处置.md`）→ RC5.3 → 第六轮（`RC5.3-第六轮纠错完善建议.md` + `RC5.4-第六轮评审核验与处置.md`，12 S1 全部证实）→ 本 RC5.4
>
> 函数级规格：`RC5.4-函数级规格总纲.md` + 附件 P0–P4（类名/签名/调用关系/验收标准，TDD）
>
> 证据基线：upstream master = `cd5ef81`（fork 零代码漂移）；Hermes 锚点 = 本地 clone `05c248d8`（第五轮处置 §5）；证据账本 = 历轮评审/处置文档
>
> 日期：2026-08-29

## 0. 相对 RC5.3 的四组实质变化

1. **唯一所有权（第六轮 S1-1..S1-3、S1-7）**：Cordis Service 同名注册即抛（`vendor/cordis/src/service.ts:37-53`、`reflect.ts:272-285`）、`DomainFacility` 单开域名（`storage-domain/src/index.ts:66-95`）——一切共享资源必须有一个唯一 owner。Memory = 单一 `MemoryService` 内部管 project/user 两逻辑 scope（一个 composite Publisher 发一条消息）；Skill = P2 一步到位的 `packages/skill/skill-managed` Service（唯一 domain owner，同包 named export `skill_manage` 工具插件挂 authoring preset），P3 的抽出步骤取消。NameIndex 首次 reserve 走 `ensureNameIndex` 初始化协议。
2. **身份与可见性（S1-4..S1-6、S2-2、S2-6）**：`ProjectKey = hash((await ctx.fs.resolve(findProjectRoot(cwd))).targetKey)`（realpath 身份，`fs/fs/src/index.ts:100-118`；`FsTargetKey` 禁止解析，`types.ts:8-15`）；authoring commit 固化 `catalogSummary` 进 sidecar，**`list()` 只读 storage、`get()` 才读 filesystem + bundle digest + 扫描**——模型可见 catalog 的信任与 body 信任分层（tool-skill 每 pre-step 把 summary 写进 durable catalog 消息，`tool-skill/src/index.ts:219-250`）；usage 归属改监听 live `tools/result`（durable `tool/result` 无 canonical value，`core/tools/src/index.ts:193-198`）；T36 钉死 registry 真相（最近层恒胜，与人/managed 无关），shipped"人工恒胜"由挂载位置 + REAL 枚举达成。
3. **治理状态机闭环（S1-8、S1-9、S2-5）**：新增 `rejected` 状态（draft → rejected → 显式 reopen；`archived` 专属曾 active 生命周期）；active patch 改 `pendingRevision`——写新 revision 不切 `currentRevision`，治理 approve 才 CAS 切 pointer；draft patch 仍直接推进（本就不可见）。模型自此在 L1 无任何路径改动模型可见技能。
4. **attempt 与 receipt 协议化（S1-10..S1-12、S1-11）**：`attemptId = hash(rangeId, attemptNo)`（attemptNo 由 cursor durable 分配；`baseStateDigest` 降为 attempt 字段，消除 preclaim 循环）；`budget_exceeded` → zero commit → consolidation 生成**新 attempt** 重走 whole-plan admission；receipt 二分 `pendingReceipts`（non-terminal 永不淘汰）+ `recentTerminalReceipts`（terminal 后 ack 入有界环才可 GC）——保留正确性显式编码，ack 缺失=过量保留（安全方向）。

锁定项（不再讨论）：自进化业务不进 `agent-loop`；LLM 只 proposes；host 拥有全部权威字段；spawn 复盘；子会话持久化保留 + 检索面隔离；project 自治域先行；L0→L2 rollout；首版无 `review/*` 事件；LLM curator consolidation 默认关；不改 registry 消费侧；不改 durable 事件面（telemetry 走 live 事件）。

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
ReviewCursor（per-session）  { sessionId, reviewedThroughSeq, desiredThroughSeq, policyVersion,
                               learningViewVersion, rangeId,
                               inFlight? { attemptId, attemptNo, fromExclusive,
                               throughInclusive, status: running|resumable } }
ReviewRangeId                = hash(sessionId, fromExclusive, throughInclusive, policyVersion,
                               learningViewVersion)
ReviewAttemptId              = hash(rangeId, attemptNo)——attemptNo cursor durable 分配
ReviewAttempt（append-only） { attemptId, attemptNo, status: planning|planned|committing|
                               committed|failed|cancelled, baseStateDigest?, plan?, planDigest?,
                               baseRevisions?, opStates[], attemptCount, lastFailureCode?,
                               nextRetryAt?, terminalAcked? }——plan 永不可变
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
                               currentRevision, contentDigest, pendingRevision?{revision,digest},
                               catalogSummary{ name, description, whenToUse?, invocation },
                               revision, createdAt, promotedAt?, stateChangedAt?, staleAt?,
                               archivedAt?, createdByAttemptId?, lastAppliedOpId?, pinned }
NameIndex（per-project）     { projectKey, nameToSkillId }——ensureNameIndex + 单 RMW 原子占位
```

## 2. 包规划与挂载

| 包 | 内容 | Phase | 挂载层 |
|---|---|---|---|
| `packages/util/content-scan` | `scanContent()` + `PATTERN_SET_VERSION` + 四语料 | P1 | — |
| `packages/memory/memory` | **单一** `MemoryService extends Service`（project/user 两逻辑 scope + `acknowledgeTerminalOps`）；composite `MemoryPublisher`（pre-step，fail-open） | P1 | host 组合 |
| `packages/skill/skill-managed` | **`ManagedSkillService extends Service`**（唯一 domain owner：Store/NameIndex/Provider/AuthoringCore）；named export `skill_manage` 工具插件 | P2 | Service+provider 挂 host cordis.yml（global 层）；工具挂 authoring preset |
| `packages/review/session-review` | `ReviewRuntime` + RangeId/Attempt ledger + 两阶段 planner + admission/saga + 治理命令 | P3 | authoring preset（session-query 默认过滤先行） |
| `packages/skill/skill-curator` | 生命周期状态机（active 谱系）+ live `tools/result` usage | P4 | host 组合 |

**fork-diff 台账**（对上游包的修改仅此一处，PR 逐行说明）：`packages/session-query/tool-session-query` 模型面默认附加 `{kind:'parent', values:[null]}`（`session-query/src/types.ts:198`）+ `includeChildSessions` 逃生参数；`ctx.sessionQuery` 服务不改。**不**为 telemetry 修改 tool-skill 持久化面。

## 3. 机制要点（细节见附件）

- **memory**（P1）：单 Service 双 scope；发布 = `sanitizeForPublication → buildSnapshotSections（含两 scope 节）→ combined digest → 比对 → 发布 CompositeMemorySnapshot`；receipt 二分 + `acknowledgeTerminalOps`；双闸扫描 + fail-open 不变。
- **skill-managed**（P2）：`list()` storage-only（sidecar `catalogSummary`；单条损坏 → last-good + `complete:false`）；`get()` = projectKey 校验 → exact revision → 整 bundle digest → 读边界重扫 → definition（summary 取 sidecar、content 取 revision）；create = `checkNameConflict(AuthoringContext) → ensureNameIndex+reserveName → validateStructure → 写 revision → record(draft, catalogSummary)`；patch：draft 直进 currentRevision、active 只进 `pendingRevision`；promote/activate/reject/reopen = 治理面 CAS；配额 fail-loud。
- **触发与取消**（P3）：三触发模式 + settlement（planning 取消清 inFlight；planned/committing 转 resumable 续 stored plan）——RC5.3 已定，不变。
- **admission + saga**（P3）：whole-plan admission；`stale_base_revision` → 新 attempt replan；`budget_exceeded` → zero commit → consolidation 新 attempt（`maxConsolidationAttempts` 默认 2）→ 仍败 terminal 零 commit；L1 启用 scope = project（ReviewInput/persona 声明）+ `target:'user'` backstop 拒绝（记录 + `target_scope_disabled`）。
- **治理面**（P3）：宿主命令 list/show/approve/reject/reopen——approve 双语义（draft 上架；active pending 切 pointer），全部全重验后走 Service CAS；模型工具面无任何治理动作。
- **usage**（P4）：live `ctx.on('tools/result')`——`exec.name==='skill' && !result.isError && result.value?.provider === MANAGED_SKILL_PROVIDER_NAME`，按确定性 `skillId = hash(projectKey, name)` 归属（无需查表）；`/name` 只作聚合遥测；进程内存活期观测，HMR dispose 即止。
- **生命周期**（P4）：`transition()` 只迁移 active 谱系（active/stale/archived）；draft/rejected 永不自动迁移；orphan/配额遥测；一切写经 `transitionManagedSkill`。
- **rollout**（P5）：L0 Shadow → L1 Conservative → L2 Autonomous（user scope section、PendingChange durable store、inference 门）；operational/quality 指标两拆不变。

## 4. Phase 门槛（P0–P5）

P0 = Evidence Lock 53 活跃 + 2 历史回归（附件 P0）。P1 = 单 Service 双 scope + composite 发布 + receipt 二分 + ack 协议。P2 = skill-managed Service 一步到位（storage-only list、pendingRevision、rejected/reopen、NameIndex ensure、配额、跨层 REAL 枚举）。P3 = review 全链（attempt 简化、consolidation 新 attempt、治理双语义、scope backstop）+ session-query 默认过滤。P4 = curator（active 谱系状态机 + live usage 归属）。P5 = rollout + 指标两拆。

每 Phase 固定门槛：per-file 100% 覆盖、REAL-composition boot、HMR disposal、snapshot、双 SDK（类型面变更时）、doc-sync、Agent Note。

## 5. 非目标

不改 `agent-loop`；不改 registry 消费侧语义；不新增模型工具面以外的动态模型可见通道；不做语义/向量检索；不做跨设备同步；不扩 `writableRoots`；不做 user-dsh 自主写；首版不做 user scope section 与 PendingChange durable store（L2）；不实现窄删除 capability 与 orphan 物理清理；不修改 tool-skill 持久化面（telemetry 用 live 事件）；不做多 Host 共享 storage root；首版不加 `review/*` 会话事件；不给 `ctx.fs` 加通用 move/delete。
