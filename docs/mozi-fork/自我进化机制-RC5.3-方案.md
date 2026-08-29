# 自我进化机制方案 RC5.3（Provider 契约 + 项目身份 + 取消结算）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 版本脉络：RC1 → 评审（`评审报告.md`）→ RC4 → 第二轮核验（`RC5-外部建议核验与处置.md`）→ RC5.1 → 第四轮复核 + 处置（`RC5.1-评审报告.md` + `RC5.2-第四轮评审核验与处置.md`）→ RC5.2 → 第五轮复核 + 处置（`RC5.2评审报告.md` + `RC5.3-第五轮评审核验与处置.md`，14 S1 全部证实）→ 本 RC5.3
>
> 函数级规格：`RC5.3-函数级规格总纲.md` + 附件 P0–P4（类名/签名/调用关系/验收标准，TDD）
>
> 证据基线：upstream master = `cd5ef81`（fork 零代码漂移）；Hermes 引用锚点 = 本地 clone `05c248d8`（2026-08-29，见处置文档 §5）；证据账本 = 历轮评审/处置文档
>
> 日期：2026-08-29

## 0. 相对 RC5.2 的三组实质变化

1. **Managed skill 成为真实 DSH Provider（第五轮 S1-1..S1-6）**：`SkillProvider.list(options)` 返回 `SkillCandidate[] | SkillProviderObservation`、`get(candidate, options)` 只收 list 产生过的 candidate（`skill/src/index.ts:248-268`）。locator 钉死 `{ projectKey, skillId, revision, contentDigest }`；`get` 按 locator 读 exact revision、整 bundle digest 校验 + 读边界重扫后才返回（skill body 是 verbatim trusted content，`skill/src/index.ts:162-184`，managed 来源不继承该信任）。draft 回读走 `ManagedSkillStore.readRevision`（host 通道），不冒充 provider 协议。`projectKey` 进入 record/locator/storage key（registry cache key 含 cwd、storageDomain 进程级单例——无项目身份必串域，`skill/src/index.ts:528,644-646`、`storage-domain/src/index.ts:200-220`）。`skillId = hash(projectKey, normalizedName)` 确定性身份 + per-project NameIndex 单 RMW 原子占位。**撤回 "rank 700 恒胜人工" 断言**：registry 是最近层直接赢、rank 仅同层内比较（`skill/src/index.ts:352-354,552-556`）；rank=700 只是同层纵深，managed provider 挂 host 组合（global 层），P0 REAL 组合枚举钉 winner。
2. **协议闭环补齐（S1-7..S1-10）**：`ReviewRangeId` / `ReviewAttemptId` 分离（planned plan 不可变 + stale replan 不再共用身份）；前台取消的 settlement 明确（planning 取消清 inFlight；planned/committing 转 resumable 续 stored plan，同进程下一 turn 必可 claim，消除永久 busy）；术语改 **whole-plan admission; forward-recovering saga commit**（memory=storageDomain、skill=文件系统，无跨两者事务）；receipt 窗口 = 空间上界 + "必须覆盖一切可重放 opId" 契约，P3 由 ledger/cursor 派生安全水位。
3. **归属、治理与信任边界（S1-11..S1-14、§5）**：usage 只按 `result.provider === 'self-evolution-managed'` 精确归属（`/name` 首版不计，漏计优于误计）；publisher 顺序改 sanitize → render → digest（渲染后置换需重解析自身输出，废除）；P3 落最小用户治理面（list/show/approve/reject 宿主命令，promote 不可被模型触达，PendingChange store 仍排 L2）；P4 = orphan telemetry + 硬配额 fail-loud（`ctx.fs` 无 delete，不承诺 cleanup，窄删除 capability 推迟）；**新第一原则 #8：managed 产物在 read-boundary 验证前一律不可信**。

锁定项（不再讨论）：自进化业务不进 `agent-loop`；LLM 只 proposes；host 拥有全部权威字段；spawn 复盘；子会话持久化保留 + 检索面隔离；project 自治域先行；L0→L2 rollout；首版无 `review/*` 事件；LLM curator consolidation 默认关；不改 registry 消费侧（最近层遮蔽是作用域特性）。

## 0.1 八条第一原则（终稿）

1. **Everything is a plugin, but not every role is a package.**
2. **LLM proposes; Host commits.**
3. **Dynamic model-visible state is replay-authoritative**（动态内容来自 durable Session source；静态面由 composition revision + validated Config 重建）。
4. **Model text never owns authority metadata.**
5. **At-least-once trigger; resource-level idempotent commit.** Ledger 负责编排；去重在资源自身 commit/reconciliation 边界成立。
6. **Project autonomous domain first.**
7. **Learning requires admissible evidence.** 证据引用是必要条件非充分条件；模型自报 confidence 不构成授权。
8. **Managed output is untrusted until read-boundary verified.** agent 产物不继承 "trusted local content" 假设：immutable revision → bundle digest + 读边界扫描通过才成为 Trusted SkillDefinition（trust transition：Untrusted proposal → Host validation → immutable revision → digest+scan → registry）。

## 1. 数据模型（七概念）

```text
ProjectKey（branded）        = resolveProjectRoot(cwd) 的稳定身份（与 findProjectRoot 同源）
SkillId（branded）           = hash(ProjectKey, normalizedName)——name 即 project 内身份，同名并发天然串行
ReviewCursor（per-session）  { sessionId, reviewedThroughSeq, desiredThroughSeq, policyVersion,
                               learningViewVersion, rangeId, inFlight? { attemptId, fromExclusive,
                               throughInclusive, status: running|resumable } }
ReviewPlan（模型数据）       { memory[{ action, target:'project'|'user', targetHint?, content?, kind,
                               evidence[{seq, span?, fieldPath?}], reason, confidence }],
                               skills[{ action:'create-draft'|'patch-draft', skillName,
                               patchTarget?: skillId, candidateSearchSummary?,
                               whyNoExistingManagedSkillFits?, classLevelRationale?,
                               evidence[], files[] }], noChangeReason? }
ReviewRangeId                = hash(sessionId, fromExclusive, throughInclusive, policyVersion,
                               learningViewVersion)
ReviewAttempt（append-only） { attemptId = hash(RangeId, attemptNo, baseStateDigest), status:
                               planning|planned|committing|committed|failed|cancelled,
                               plan?, planDigest?, baseRevisions?, opStates[], attemptCount,
                               lastFailureCode?, nextRetryAt? }——plan 永不可变
MemoryState                  { schemaVersion, revision, entries[], appliedOps }（appliedOps 有界窗口）
ManagedSkillRecord           { projectKey, skillId, name, owner, state: draft|active|stale|archived,
                               currentRevision, contentDigest, revision, createdAt, promotedAt?,
                               stateChangedAt, staleAt?, archivedAt?, createdByAttemptId?,
                               lastAppliedOpId?, pinned }
NameIndex（per-project）     { projectKey, nameToSkillId }——create 的原子占位点
```

## 2. 包规划与挂载

| 包 | 内容 | Phase | 挂载层 |
|---|---|---|---|
| `packages/util/content-scan` | `scanContent()` 纯函数 + 语料化测试（patternSetVersion） | P1 | — |
| `packages/memory/memory` | `MemoryService extends Service` + `MemoryPublisher`（pre-step，fail-open；sanitize→render→digest） | P1 | host 组合；user store = L2 同插件双实例 |
| `packages/skill/tool-skill-manage` | **ManagedSkillProvider**（真实 SkillProvider；host 层）+ `ManagedSkillStore` + `AuthoringCore` + `skill_manage` 薄工具 | P2 | provider 挂 host cordis.yml（global 层）；工具挂 authoring preset |
| `packages/skill/skill-authoring` | `SkillAuthoringService extends Service`（含 `MANAGED_SKILL_PROVIDER_NAME` 常量） | P3 | host 组合 |
| `packages/review/session-review` | `ReviewRuntime` + RangeId/AttemptId ledger + 两阶段 planner + admission/saga | P3 | authoring preset（含 session-query 默认过滤先行） |
| `packages/skill/skill-curator` | 生命周期状态机 + provider 精确归属 usage | P4 | host 组合 |

**fork-diff 台账**（对上游包的修改仅此一处，PR 逐行说明）：`packages/session-query/tool-session-query` 模型面默认附加 `{kind:'parent', values:[null]}`（`session-query/src/types.ts:198`）+ `includeChildSessions` 逃生参数；`ctx.sessionQuery` 服务不改。

## 3. 机制要点（细节见附件）

- **provider**（P2）：`list(options)` 按 `options.cwd` 解析 projectKey，只出该项目的 active 记录；存储损坏返回 last-good + `complete:false`（不静默空目录）；`get(candidate, options)` 校验 locator.projectKey 与 cwd 同源 → 读 exact revision → bundle digest 对比 → 失配 `undefined` + invalidate + 告警 → 读边界重扫（blocked 拒）→ definition 携 `resourceBase = exact revision 目录`。
- **authoring**（P2）：create = NameIndex 原子占位（同名第二 create 显式 conflict）→ 结构/severity 验证 → 写 revision bundle → record CAS；patch = 双校验（revision + baseContentDigest）写新 revision，draft/active 皆可 patch（对齐 Hermes "先更新 loaded skill"）；promote = 状态 CAS + 冲突重查；全链无目录移动、无 delete。
- **触发与取消**（P3）：`resume-async` / `resume-blocking` / `maintenance`；foreground 到来 `run.dispose()` + settlement：planning 取消 → 清 inFlight（不推进 high-water）；planned/committing → inFlight 转 resumable，下一空闲 claim 续 stored plan 不重问模型；前台有限等待后放行。
- **admission + saga**（P3）：whole-plan admission 全有或全无（admissible/冲突/预算任一不过 → 整 plan 不 commit，原因落 ledger）；commit 逐资源 forward-recovering，失败不回滚已落地资源；`stale_base_revision` → 限次新 attempt replan；`budget_exceeded` → bounded consolidation（携现库存重规划一次，`maxConsolidationAttempts` 默认 2）。
- **memory 发布**（P1）：`sanitizeForPublication(entries) → buildSnapshotSections → computeSnapshotDigest → 比对 latestPublished → 发布 form:'snapshot' + sections`；blocked 条目渲染 `[BLOCKED: reason]` 原文留存审计；fail-open；硬预算在 mutation 边界。
- **usage 归属**（P4）：modelLoads 仅 `tool/result` 成功且 `result.provider === MANAGED_SKILL_PROVIDER_NAME`；`/name`（`skill-invocation` source 无 provider 字段）首版不计 managed；观察者 best-effort。
- **生命周期**（P4）：`transition()` 纯状态机（时间锚点：never-used 从 `max(promotedAt, createdAt)`、used 从 `lastMeaningfulUseAt`、stale→archive 自 `staleAt`）；一切写经 `transitionManagedSkill` 单 record CAS；orphan = telemetry + 配额（`maxRevisionsPerSkill` / `maxManagedBytesPerSkill` / `maxManagedBytesPerProject` / `maxOrphanBytesPerProject`）达限 fail-loud 停新增。
- **治理面**（P3）：宿主命令 list/show/approve/reject 四动作；approve 重验 revision/ownership/digest/scan/conflict/policy 后走 `promoteDraft`；reject = 状态 CAS 归档；模型工具面无 promote。
- **review persona**（P3）：snapshot-pinned 不变式 "多数会话可以零持久变更；宁 no-op 不弱学习"（不学 Hermes skill 侧 action bias）；P5 单列 noChange 率。
- **rollout**（P5）：L0 Shadow → L1 Conservative（explicit-user/observed-project 自动 commit；skill 只 draft，经治理面上架）→ L2 Autonomous（inference 门 + calibration；user store 双实例；PendingChange durable store）；approvalMode 排 L2 前。

## 4. Phase 门槛（P0–P5）

P0 = Evidence Lock 41 项活跃 + 2 项历史回归（附件 P0，含 Hermes 五锚点）。P1 = memory（sanitize→render 管线、receipt 契约、双闸扫描、fail-open、schemaVersion + 显式 reset/migrate、语料化扫描测试）。P2 = ManagedSkillProvider 契约符合 + projectKey 隔离 + NameIndex 原子占位 + digest 读边界 + 配额（无 delete、无 user 域）。P3 = review 全链（RangeId/AttemptId、settlement、admission+saga、no-op persona、create 门、plan 硬上限）+ 治理面 + skill-authoring 抽出 + session-query 默认过滤。P4 = curator（锚点状态机 + provider 精确归属 usage + 配额遥测）。P5 = rollout + 指标拆分（operational：ledger/usage 可得；quality：需 eval harness——gold 样本、before/after 重放、held-out 任务集，无 harness 不得声称已测量）。

每 Phase 固定门槛：per-file 100% 覆盖、REAL-composition boot（P2 须含跨层 rank 枚举）、HMR disposal、snapshot（模型可见文本）、双 SDK（类型面变更时）、doc-sync、Agent Note。

## 5. 非目标

不改 `agent-loop`；不改 registry 消费侧语义；不新增模型工具面以外的动态模型可见通道；不做语义/向量检索；不做跨设备同步；不扩 `writableRoots`；不做 user-dsh 自主写；首版不做 user memory store 与 PendingChange durable store（L2）；不实现窄删除 capability 与 orphan 物理清理（telemetry + 配额代替）；不做多 Host 共享 storage root；首版不加 `review/*` 会话事件；不给 `ctx.fs` 加通用 move/delete。
