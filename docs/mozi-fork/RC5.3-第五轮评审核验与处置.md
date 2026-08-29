# 第五轮评审核验与处置（RC5.2 外部评审 → RC5.3 修订依据）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 评审对象：`RC5.2评审报告.md`（外部第五轮，14 S1 + 12 S2，评审对象为 RC5.2 全套文档）
>
> 核验方法：每条承重建议对照本仓库源码逐行验证（fork 代码 = upstream `cd5ef81`，零代码漂移，引用均为本仓库实测 path:line）；Hermes 引文对照本地 clone `05c248d8`（2026-08-29 与上游 main 同步的 fork，行号与 GitHub main 可能有 ±差）
>
> 总结论：14 S1 全部证实（其中 S1-7 / S1-13 / S1-14 的处置方式按本仓库实际修正）；12 S2 中 9 项直接采纳、3 项修正后采纳。RC5.2 主轴不推翻；P0 可先行，P2 / P3 开工前出 RC5.3 小修订。本轮最重的两条：S1-4 推翻了 RC5.2 的 rank 断言（本方引用错位），S1-3 的跨项目污染风险被 storageDomain 进程级单例坐实
>
> 日期：2026-08-29

## 1. S1 逐项核验

### S1-1 ManagedSkillProvider 签名与 SkillProvider 契约不符 — 证实

- 证据：`list(options): Promise<readonly SkillCandidate[] | SkillProviderObservation>`（`skill/src/index.ts:260`）；`get(candidate, options)` 的参数注释即 "previously listed candidate"（`skill/src/index.ts:263-267`）；registry 把选中 candidate 原样传回同一 provider（`skill/src/index.ts:507-508`）；`SkillCandidate` 必带 `rank` 与 opaque `locator`（`skill/src/index.ts:74-83`）。
- 处置：P2 provider 改为真实 `SkillProvider` 实现；locator 钉死 `projectKey + skillId + revision + contentDigest`，`get` 按 locator 读 exact revision，绝不重读 currentRevision。
- 对评审建议的补充修正：其 interface 草稿漏了 registry 校验面——candidate.provider 必须等于 provider.name（`skill/src/index.ts:734-736`）、name 过 `SKILL_NAME` 文法（`:20`）、`source` 必填 string（`:725`）、list/get 须响应 signal（`:604` 经 waitWithAbort）。RC5.3 签名按完整校验面写。

### S1-2 draft 经 provider.get 回读与契约自相矛盾 — 证实

- 证据：get 只接受 list 产生过的 candidate（S1-1 证据）；draft 永不进 list，则协议上不存在合法 draft candidate。
- 处置：authoring readback 改走 `ManagedSkillStore.readRevision(skillId, revision)`（host/debug 通道）；provider 严格 active-only，P2 的 "provider get 可读、list 不可见" 验收措辞删除。

### S1-3 缺 workspace 身份，standing preset 下跨项目串目录 — 证实

- 证据：registry cache key 含 cwd（`skill/src/index.ts:528,644-646`）；模型 skill 工具已按 `cwd: exec.agent?.session.header.cwd` 查询（`tool-skill/src/index.ts:133`）；storageDomain facility 是进程级单例、按名开域（`storage-domain/src/index.ts:200-220,165-167`）——多项目的 ownership 记录会落同一域，仅按 skillId 全局列 active 必然串项目。
- 处置：`ManagedSkillRecord` / locator / storage key 全部携带 `projectKey`；provider list 按 `options.cwd` 解析项目根（与 `findProjectRoot` 同源，E0-7 已立项）后只出本项目记录；ownership 域名或键编码 project 身份。

### S1-4 “rank=700 恒胜人工” 断言错误 — 证实（RC5.2 引用错位）

- 证据：registry 明文 "nearest layer's entry wins a duplicate name outright, and the rank order decides duplicates only within one layer"（`skill/src/index.ts:352-354` 与 `:552-556` 实现：逐层 `merged.set` 就地覆盖）；`registerProvider` 落调用 context 的层（`:381-385,412`）；shipped 组合中 skill-filesystem 挂 host 顶层 → global 层（如 `snapshots/sdk/text-turn/cordis.yml:6`）。RC5.2-P2 把该断言错引到 `:75` 的字段注释上。
- 处置：撤回"任何人工/内置来源同名恒胜 managed"不变式；改为：rank=700 仅同层纵深；managed provider 挂 host 组合（global 层，与全部 filesystem ranks 同层，rank 落败成立）；P0 REAL 组合测试枚举各来源所在层并钉 winner；preset 层挂载 = 刻意遮蔽（DSH 作用域特性），文档明示。评审修复菜单第 4 条（registry consumer/policy 层改造）不采纳——见 §3。

### S1-5 同名 draft 并发缺原子占位 — 证实

- 证据：createDraft 冲突检查只覆盖 `.agents` 直存与 winning 候选（P2:48），draft 不进 list 则检查天然漏 draft；promote 的 own-active 豁免使第二个同名 promote 通过；同名双 active 时 registry 仅按层内顺序留下一个并 warn（`skill/src/index.ts:571-581`），数据层冲突静默。
- 处置：采纳评审推荐——`skillId = hash(projectKey, normalizedName)` 确定性身份（与 P1 `deriveEntryId` 同思路）；create 经 per-project NameIndex record 的单条 `storageDomain.update` RMW 原子占位（`put` 是覆盖写不能做 compare-and-put，`domain.ts`）；同名第二 create 显式 `name_conflict`（patch 是模型显式动作）；占位与 record 落盘间的崩溃由 reconcile 清孤儿占位。

### S1-6 外部篡改 bundle 可绕过 digest 与扫描直入 trusted instructions — 证实

- 证据：renderSkillContent 注释 "the body is embedded verbatim (skills are trusted local content …)"（`skill/src/index.ts:162-184`）；P2 provider.get 现规格只读 currentRevision 正文，无 digest 校验、无读边界扫描。
- 处置：`get(candidate)` 按 locator 读 exact revision → 整 bundle canonical digest 对比 locator/sidecar → 失配返回 `undefined` + invalidate + 告警；active 加载边界 high-confidence 重扫（复用 scanContent）；`(revision, stat fingerprint)` 缓存允许，正确性以 digest 为准；resourceBase 指向 exact revision 目录（并 S2-7）。

### S1-7 receipt FIFO 窗口无可证明的安全水位 — 证实（处置方式修正）

- 证据：storageDomain 只保证单 record RMW 原子；replay 的两个来源（cursor inFlight 恢复、ledger 非 terminal checkpoint 重放）都是 host 可见状态；FIFO 静态窗口无法证明被淘汰的 update/remove receipt 不会在延迟恢复时重放。
- 处置修正：评审方案 A 的 P1 空档期其实安全——review runtime 是 P3 才存在，P1 阶段 receipts 无任何 replay 源。落法：P1 窗口语义 = 空间上界 + JSDoc 契约 "窗口必须覆盖一切可能重放的 opId，P3 由 ledger/cursor 派生"（Config `receiptWindowSize` 保留、加容量告警）；P3 接线 watermark 派生并加 3 项测试（old-planned-checkpoint-survives、gc-never-resurrects-update/remove）。方案 B（tombstone）否决——为未到场的 replay 源预建机制违反 current-need。

### S1-8 前台取消后 inFlight 无同进程 settlement，可能永久 busy — 证实

- 证据：dispose 契约 "must always dispose to cancel remaining work and reach quiescence"（`subagent/src/types.ts:263-268` 区域）；P3 只写 "cursor inFlight 保留、之后 recover 重放安全"，`recover()` 未指明运行期调用点；claim busy 不 spawn（P3:42）+ inFlight 永留 = 重启前死锁路径成立。
- 处置：明确 settlement：planning（尚无 durable plan）取消 → 标 cancelled-for-foreground → 清 inFlight、不推进 high-water；planned / committing 取消 → plan 仍 durable，inFlight 转 resumable，下一空闲 claim 直接续 stored plan（不重问模型）；同进程下一 turn 必须可 claim；前台有限等待后放行。实现锚点：runReview 宿主侧 saga 不随 child dispose 死亡，settlement 在其取消路径内完成。

### S1-9 plan 不可变与 stale replan 共用同一 reviewId 冲突 — 证实

- 证据：reviewId 公式（方案 §3：hash(sessionId, from, through, policyVersion, learningViewVersion)）在 replan 时不等值不变；planned plan 定义不可变（P3:48）；失败分类又允许限次 replan（P3:65）。
- 处置：分离 `ReviewRangeId = hash(session, from, through, policyVersion, learningViewVersion)` 与 `ReviewAttemptId = hash(RangeId, attemptNo, baseStateDigest)`；cursor 指 range，ledger 下挂 immutable attempts；stale replan = 新 attempt；recovery 取最新有效 attempt。

### S1-10 whole-plan “全有或全无” 只有 admission 原子 — 证实

- 证据：memory 状态在 storageDomain、skill bundle 在文件系统，无跨两者事务；RC5.2 的验收名 `saga-whole-plan-preflight-no-partial` 易被读成 commit 原子。
- 处置：术语统一改 "whole-plan admission; forward-recovering saga commit"；补 3 测试：memory-committed-skill-write-fails-recovery-finishes、skill-committed-ledger-mark-crash-reconciles、cross-resource-failure-never-rolls-back-by-guess。

### S1-11 usage 按 name 计数误归属 — 证实

- 证据：模型 skill 工具结果带 `provider`（`tool-skill/src/index.ts:148-155`）；`/name` 注入 source 只有 `{ kind:'skill-invocation', name, form:'instructions' }`（`:196`）。
- 处置：modelLoads 仅当 `result.provider === 'self-evolution-managed'` 计 managed；`/name` 首版不计 managed（宁可漏计不误计）；provider-get 成功时发 host observation 的精确归属留作后续增强。

### S1-12 publisher “先渲染后按条目置换” 不可直接实现 — 证实

- 证据：`buildSnapshotSections` 已把 entries 合成单节 text（P1:61-63），其后 "[BLOCKED] 置换"（P1:82）需重解析自身输出，分隔符/转义歧义。
- 处置：顺序改 `sanitizeForPublication(entries) → buildSnapshotSections(sanitized) → digest → publish`；`PublicationEntry = { kind:'safe', entry } | { kind:'blocked', entryId, reason }`；raw MemoryState 不变保审计；digest 对发布后内容计算（比对语义不变）。

### S1-13 L1 draft 无真实用户 promote 入口 — 证实（范围修正后采纳）

- 证据：`promoteDraft` 存在于 AuthoringCore（P2:60）但 L1 无任何调用面；`skill_manage` 只暴露 create/patch（P2:67）；approvalMode 排 L2（方案 §4）。
- 处置修正：P3（SkillAuthoringService 就位时）落最小用户治理面——list / show / approve / reject，走宿主命令面而非模型工具（promote 不能是模型可调用动作，否则违反 L1 "skill 只 draft"）；approve 时重验 revision / ownership / digest / scan / name conflict / 当前 policy，不批准旧快照；PendingChange durable store 仍排 L2（见 §3 对 S2-11 的修正）。

### S1-14 orphan 清理承诺在现 seam 下无法兑现 — 证实

- 证据：P2:29 承诺 "orphan 清理进 P4 范围"，P4 实际只有指标（P4:56）；`ctx.fs` 12 原语无 delete（`fs/src/index.ts:86-256`）。
- 处置：P2 措辞改为 "reconcile 只记账"；P4 = orphan telemetry + 硬配额（`maxRevisionsPerSkill` / `maxManagedBytesPerSkill` / `maxManagedBytesPerProject` / `maxOrphanBytesPerProject`，达限 fail-loud 停止自主 patch，不偷删历史）；窄删除 capability 推迟到真实 GC 需求出现，且仅对 managed root 授权。

## 2. S2 逐项核验

| 编号 | 结论 | 核验要点 | RC5.3 处置 |
|---|---|---|---|
| S2-1 | 修正后采纳 | 事实成立（P1 Config 单 scope）；但 "新建两个 Store 类" 非必要 | DSH-native 落法 = 同一插件按不同 scope Config 组合两实例（domain 名 / section 名参数化）；ReviewPlan.memory 增 `target:'project'\|'user'` 判别；user store 按锁定原则 6（project first）排 L2，P1 只保证类型缝可组合并在 README 记组合配方 |
| S2-2 | 采纳 | `budget_exceeded` 现为纯拒绝（P1:50） | review planner 侧 bounded consolidation retry：携带现库存 + 新提案再规划一次，`maxConsolidationAttempts` Config（默认 2）；MemoryService 不内嵌 LLM |
| S2-3 | 采纳（引文勘误） | 本地 clone 无逐字 "Be ACTIVE"；等价偏置在 `background_review.py:601-611`（no-op "should NOT be the [default]"） | review persona 增 snapshot-pinned 不变式 "多数会话可以零持久变更；宁 no-op 不弱学习"；P5 单列 noChange / draft creation / false-positive create 率 |
| S2-4 | 采纳 | RC5.2 two-stage patch 只覆盖 patch，不含 create 门 | create-draft proposal 增 `candidateSearchSummary` / `whyNoExistingManagedSkillFits` / `classLevelRationale`；preflight 断言 planner-1 已见当前 managed summaries；`maxNewSkillsPerReview = 1` |
| S2-5 | 采纳 | outputSchema 只是结构化 capture、maxTokens 只是模型输出上界（`subagent/src/types.ts:236-252` 区域） | schema（maxItems / maxStringLength）+ host 字节双封顶：maxMemoryOpsPerPlan、maxSkillOpsPerPlan、maxFilesPerSkillProposal、maxPlanTextBytes、maxEvidenceRefsPerProposal、maxSpanBytes |
| S2-6 | 采纳 | `SkillProviderObservation.complete` 存在（`skill/src/index.ts:239-245`）；incomplete 不缓存（`:612`）；provider throw → warn + skip + 不缓存（`:603-609`） | managed provider 存储损坏时返回 last-good candidates + `complete:false`（或 throw），损坏计数进 telemetry；不静默当空目录 |
| S2-7 | 采纳 | `SkillResourceBase.directory` 的 path 经 renderResourceHint 直进提示（`skill/src/index.ts:186-215`） | candidate/definition 的 resourceBase 恒指 exact revision 目录，禁 `current` 类漂移路径（与 S1-1/S1-6 同一 revision 锚） |
| S2-8 | 采纳 | T09 的 `.drafts` 架构与 T11 的 observer seam 均为 RC5.2 已废弃设计 | 两项移入 "历史 / 被拒设计证据" 区（T09 底层保证改述为 "staged root 不被 stock discovery 发现" 作回归保留）；P0 增 8 项：provider-interface-contract、project-isolation、cross-layer-rank、name-reservation-concurrent、external-edit-digest-reject、cancel-settles-inflight-same-process、planned-attempt-id-replan、skill-tool-provider-attribution |
| S2-9 | 采纳 | P5 现列表混两类（总纲 §8：precision 已注 "人工抽样"，未成体系） | P5 拆 operational（ledger/usage 可得：retry、cancellation、conflict、range lag、tokens、draft approval、orphan bytes）与 quality（需 eval harness：gold 样本、before/after 重放、held-out 任务集）；无 harness 前不得声称 quality 指标已测量 |
| S2-10 | 采纳 | DSH 已 pin `cd5ef81`；Hermes 引用未 pin | 锚点 = 本地 clone `05c248d8`（2026-08-29 与上游 main 同步的 fork；GitHub main 引文可能有 ±行差）；五锚点 H-MEMORY / H-BG-REVIEW / H-SKILL-MANAGER / H-SKILLS-GUARD / H-WRITE-APPROVAL 进 P0（行号见 §5） |
| S2-11 | 修正后采纳 | H9 证实 durable pending 的价值（`write_approval.py:110-170` stage/list/get） | 并入 S1-13 处置：L1 治理直接复用 SkillAuthoringService + 最小命令面；PendingChange durable store 仍 L2——避免两套治理概念并存 |
| S2-12 | 采纳 | `skills_guard.py:70-81` 证实现实复杂度（类别 × severity 矩阵）；注意其 `guard_agent_created` 默认关，RC5.2 的强制扫描比 Hermes 默认更严，保持 | content-scan 增 `patternSetVersion` + positive / benign / 中文改写 / code-block-vs-imperative 四语料；P5 统计 FP 率、FN 抽样率、blocked/caution 分布 |

## 3. 不符合本项目实际或需修正的建议

- **S2-1 的落地形态**：评审建议新建 `UserProfileMemory` / `ProjectMemory` 两个 Store 类——过度设计。DSH 一切皆组合：同一插件按不同 scope Config 挂两实例即得双语义记忆，需要的是 domain 名 / section 名参数化与 ReviewPlan 目标判别字段，不是新类。
- **S1-13 / S2-11 的 `/skills` CLI 面**：产品命令面未在本 fork 计划立项，直接照搬 Hermes 命令集超范围。修正为 P3 最小宿主命令面（list/show/approve/reject），且 promote 必须不可被模型工具触达；PendingChange store 维持 L2 排期，避免 L1 就造两套治理概念。
- **S1-4 修复菜单第 4 条**（改 registry consumer/policy 层实现跨层保护）：不采纳。上游 registry 的最近层遮蔽是作用域特性而非缺陷；正确的闭环 = 挂载位置选型（host 组合）+ P0 REAL 组合枚举 + promote 时冲突重查 fail-loud，不需要为 managed 单独改 registry 消费侧。
- **H5 引文精度**：本地 clone 无逐字 "Be ACTIVE — most sessions produce at least one skill update"；实际偏置措辞在 `background_review.py:601-611`。结论（不要继承 action bias）不受影响，RC5.3 引文以本地锚点为准。
- **S1-7 方案 B（tombstone）**：否决。P1 阶段不存在 replay 源（review runtime 是 P3），为假设性需求预建 durable 机制违反 current-need；方案 A + P1 空档期安全性论证已足够。
- **S1-1 建议签名的完备性**：评审 interface 草稿未含 registry 校验面（provider 字段一致性、SKILL_NAME、source、signal 响应），照抄会再吃一轮校验错误；RC5.3 按 §1-S1-1 补全。
- **S1-3 的 `cwd-realpath-alias` 测试**：canonical 化规则沿用 `findProjectRoot` 既有约定（E0-7），不新增 realpath 承诺；测试保留但断言源是同源规则而非泛化 realpath 语义。

## 4. RC5.3 修订落点

- 评审 §9 的 12 项优先清单全部接受，映射：1→P2、2→P2、3→P2、4→P2+P0、5→P2、6→P2、7→P3、8→P3、9→P1+P3、10→P4、11→P3、12→P4+P2。
- P0 变更：T09 / T11 移历史区（S2-8）；新增 8 项测试；新增 Hermes 五锚点（S2-10）；T33 增加 cross-layer 维度（global managed + scoped human / scoped human + scoped managed / global human + scoped managed 三钉）。
- P1 变更：publication 顺序 sanitize→render→digest（S1-12）；receipt 窗口契约 + 容量告警（S1-7）；双 scope 组合配方入 README（S2-1 修正版）；bounded consolidation（S2-2）。
- P2 变更：真实 SkillProvider 签名 + locator 钉 revision/digest（S1-1/6）；projectKey 身份 + NameIndex 原子占位 + 确定性 skillId（S1-3/5）；ManagedSkillStore.readRevision 读通道（S1-2）；rank 断言改写 + 挂载层选型（S1-4）；orphan 措辞改记账（S1-14）；plan 体积硬上限（S2-5）；corruption → complete:false（S2-6）。
- P3 变更：RangeId/AttemptId 分离（S1-9）；cancellation settlement（S1-8）；术语改 admission + saga（S1-10）；no-op persona（S2-3）；create 门（S2-4）；最小用户治理面（S1-13 修正版）。
- P4 变更：usage 按 provider 精确归属（S1-11）；orphan = telemetry + 配额（S1-14）。
- §5 信任边界与 §6 目标架构：采纳为 RC5.3 主不变式与参考架构——managed skill 不继承 "trusted local content" 假设，trust transition = Untrusted proposal → Host validation → immutable revision → read-boundary digest+scan → Trusted SkillDefinition → registry。
- §7 借鉴表与 RC5.2 锁定项一致，无冲突；§10 三件事（真用 Provider 契约、吸收治理经验、坚持 LLM proposal ≠ permission）与第一原则重合，纳入 RC5.3 前言。

## 5. Hermes 锚点（本地 clone `05c248d8`，2026-08-29）

- H-MEMORY：`tools/memory_tool.py:174`（`_MAX_CONSOLIDATION_FAILURES_PER_TURN = 3`）、`:214`（超限停止重试、保持 memory 不变继续回复）。
- H-BG-REVIEW：`agent/background_review.py:42,89,112,179`（run token + `request_done` acknowledgement + 有界等待的前台抢占 handshake）。
- H-BG-REVIEW-PROMPTS：`agent/background_review.py:473`（memory "Nothing to save."）、`:601-611`（skill 侧 no-op 压制，反模式）。
- H-SKILL-MANAGER：`tools/skill_manager_tool.py:294-303`（`_pinned_guard`；external/bundled/非 curator-managed fail-closed 禁写）。
- H-SKILLS-GUARD：`tools/skills_guard.py:70-81`（类别 × severity 矩阵；`guard_agent_created` 默认关——本 fork 不沿用该默认）。
- H-WRITE-APPROVAL：`tools/write_approval.py:110-170`（`stage_write` / `list_pending` / `get_pending` durable pending store）。
