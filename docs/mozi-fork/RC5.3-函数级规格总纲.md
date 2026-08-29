# RC5.3 函数级规格总纲（TDD）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 上位文档：`自我进化机制-RC5.3-方案.md`；本总纲 + 五份附件把方案落到**类名 / 函数名 / 签名 / 调用关系 / 验收标准**级，按 TDD 实施
>
> 附件索引：`RC5.3-附件P0-evidence-lock.md`、`RC5.3-附件P1-memory.md`、`RC5.3-附件P2-skill-managed.md`、`RC5.3-附件P3-session-review.md`、`RC5.3-附件P4-curator.md`（P5 rollout 无独立代码面，见本文件 §8）
>
> 第五轮评审处置：`RC5.3-第五轮评审核验与处置.md`（14 S1 全部证实，逐条落点见其 §4）
>
> 日期：2026-08-29

## 1. 全局约定

- **包形态**：函数插件命名导出 `name`/`inject`/`Config`/`apply` 无 default export；携带 Service 的包 default export 服务类（`packages/AGENTS.md`）；Service 经 `super(ctx, key)` 注册（先例 `skill/src/index.ts:357,375`；基类 `vendor/cordis/src/service.ts:11`）。
- **Provider 形态**：实现 registry 的 `SkillProvider` 契约（`skill/src/index.ts:248-268`）——`list(options): Promise<readonly SkillCandidate[] | SkillProviderObservation>`、`get(candidate, options)`；candidate 必须通过 `validateCandidate` 全套校验（provider 字段 === provider.name `:734-736`、`SKILL_NAME` `:20`、`source` string `:725`、rank 数值），list/get 响应 `options.signal`。
- **命名**：类名取上游角色表；跨边界 id branded（`ProjectKey`/`SkillId`/`MemoryEntryId`/`OpId`/`ReviewRangeId`/`ReviewAttemptId`，`Branded<B>`）；错误类 `*Error` 带 machine-readable `code`；领域记录 zod、插件 Config schemastery（字段全带 JSDoc，无静默默认）。
- **纯函数优先**：折叠/预算/投影/状态机/digest/transition 全纯函数，I/O 只在壳层——100% per-file 覆盖门的前提。纯函数不得生成 id/时钟：权威字段由 host 预分配并入参。
- **storageDomain 契约**：`update(key,fn)` 对缺失 key 抛 `missing-key`（`domain.ts:85,334-338`）；`put` 是覆盖写、不能做 compare-and-put——占位/竞态一律走单 record `update` RMW；单 Host writer 部署模型。
- **TDD 纪律**：先红后绿；验收即测试名清单；边界值与拒绝路径必测。

## 2. 包与类清单（全量）

| 包（新） | 类 / 顶级构件 | 职责 | Phase |
|---|---|---|---|
| `packages/util/content-scan` | `scanContent()` + `_PATTERNS` + `PATTERN_SET_VERSION` | 纯函数威胁扫描，severity 三档（blocked/caution/safe）；语料化测试 | P1 |
| `packages/memory/memory` | `MemoryService extends Service`；`MemoryPublisher`；`foldMemoryOps`/`enforceBudget`/`sanitizeForPublication`/`buildSnapshotSections`/`computeSnapshotDigest` | 记忆权威状态 + 资源级幂等 + sanitize→render→digest 发布（fail-open） | P1 |
| `packages/skill/tool-skill-manage` | **`ManagedSkillProvider`**（实现 SkillProvider）；`ManagedSkillStore`（含 `readRevision`/NameIndex）；`AuthoringCore`；`skill_manage` 薄工具；`validateStructure`/`bundleDigest`/路径纯函数 | agent 自治技能来源：projectKey 隔离 + 确定性 skillId + 原子占位 + locator 钉 revision/digest + 读边界校验 | P2 |
| `packages/skill/skill-authoring` | `SkillAuthoringService extends Service`（`MANAGED_SKILL_PROVIDER_NAME` 常量；`transitionManagedSkill`/`markStale`/`archive`/`revive`/`promoteDraft`/`commitPlanOps`） | P3 自 tool-skill-manage 抽出的 Host authoring capability + 治理面写通道 | P3 |
| `packages/review/session-review` | `ReviewRuntime`；`ReviewCursorStore`；`ReviewLedgerStore`（RangeId/AttemptId，attempts append-only）；LearningView 投影纯函数组；`ReviewPlanSchema` | 触发/settlement/证据投影/两阶段 planner/admission+saga commit | P3 |
| `packages/skill/skill-curator` | `SkillCurator`；`SkillUsageObserver`（provider 精确归属）；`transition()`；`aggregateOutcomes()` | 生命周期状态机（时间锚点）+ best-effort usage + 配额遥测 | P4 |

**fork-diff 台账**（对上游包的修改仅此一处，PR 逐行说明）：`packages/session-query/tool-session-query` 模型面默认附加 `{kind:'parent', values:[null]}`（`session-query/src/types.ts:198` 既有 filter 类型）+ `includeChildSessions` 逃生参数；`ctx.sessionQuery` 服务能力不改。

## 3. 跨包调用图

```text
session-review.ReviewRuntime
  ├─ ReviewCursorStore / ReviewLedgerStore ── ctx.storageDomain（range + attempts）
  ├─ buildLearningView（纯）◄── agent.session.events（raw log）
  ├─ ctx.subagents.start(config.reviewProvider ?? 'spawn', {…})   [两阶段 patch]
  ├─ ctx.memory.applyOps（memory 包，appliedOps 幂等；budget_exceeded → bounded consolidation）
  └─ SkillAuthoringService.commitPlanOps / transitionManagedSkill
memory.MemoryPublisher（agent/pre-step，fail-open）
  ├─ ctx.memory.getState ── ctx.storageDomain
  ├─ sanitizeForPublication → buildSnapshotSections → computeSnapshotDigest
  └─ createUserMessage(source { kind:'memory', form:'snapshot', sections })
tool-skill-manage（provider 挂 host 组合 global 层；工具挂 authoring preset）
  ├─ ManagedSkillProvider.list/get ◄── ctx.skills registry（options.cwd/signal 借用传递）
  │     └─ ManagedSkillStore ── ctx.storageDomain（NameIndex + record CAS） / ctx.fs.readText
  ├─ AuthoringCore ── ctx.fs.writeText / scanContent / store.readRevision / control.invalidate
skill-authoring.SkillAuthoringService（P3）
  └─ 治理命令（list/show/approve/reject）→ promoteDraft（全重验）
skill-curator.SkillCurator（runMaintenance 取 idle ownership）
  ├─ SkillUsageObserver ── session/event（result.provider === MANAGED_SKILL_PROVIDER_NAME）
  └─ SkillAuthoringService.transitionManagedSkill（唯一写通道）
```

## 4. 阶段函数索引

| 阶段 | 附件 | 规模 | 核心交付 |
|---|---|---|---|
| P0 | 附件P0 | 41 项活跃 + 2 项历史回归 + Hermes 锚点 | 行为事实钉死 + E0 结案 |
| P1 | 附件P1 | 2 类 + 12 函数 + content-scan 包 | MemoryService 幂等 + 预算 + sanitize→render 发布（fail-open） |
| P2 | 附件P2 | 3 类 + 12 函数 + 1 工具 | ManagedSkillProvider 契约符合 + 项目隔离 + 原子占位 + 读边界校验 + 配额 |
| P3 | 附件P3 | 4 类 + 17 函数 | ReviewRuntime 全链 + RangeId/AttemptId + settlement + 治理面 + session-query 默认过滤 + skill-authoring 抽出 |
| P4 | 附件P4 | 2 类 + 4 函数 | 生命周期状态机 + provider 精确归属 usage |
| P5 | 本文件 §8 | 指标 gate | L0→L2 rollout + operational/quality 指标拆分 |

## 5. 每函数规格格式（附件遵循）

```text
#### `函数名(参数: 类型): 返回类型`
- 职责：一句话。
- 调用：被 X 调用；调用 Y/Z。
- 输入/输出：参数语义、不变式、错误码。
- 验收：`test 名`（断言要点）——全部列出，缺一不算完成。
```

## 6. 错误码总表（`*Error.code`；`duplicate_op` 不是错误——是 `ApplyOpStatus`）

| 错误码 | 抛出点 | 语义 |
|---|---|---|
| `budget_exceeded` | memory fold / authoring 配额 preflight / 快照渲染 | 超硬预算或配额上限（`maxRevisionsPerSkill` 等四项同用此码）；拒绝并附现库存与整合建议 |
| `stale_base_revision` | memory applyOps / record CAS / authoring | base revision/digest 不匹配；reject/replan（新 attempt） |
| `name_conflict_with_human_source` | authoring checkNameConflict | 人工来源同名（P0 安全不变式） |
| `name_conflict` | authoring NameIndex 占位 | 同名 managed 记录已存在（create 应转 patch；与 human 冲突码分开计） |
| `invalid_structure` | authoring validateStructure | frontmatter/字节上限/路径越界/binary/symlink |
| `threat_scan_blocked` | scanContent 消费方（severity=blocked） | 命中高危模式（写入闸 + 读边界闸共用） |
| `unadmissible_evidence` | session-review admissibility | span 不存在 / kind 放行规则不满足 |
| `planner_terminal_failure` | session-review gateResult | stopReason ≠ completed 或 structured 缺失/不合法 |
| `missing-key` / `version-mismatch` | storageDomain 既有错误**原样透传**（`domain.ts:336`、`error.ts:11`） | 首录未初始化 / domain 版本不匹配 |

## 7. E0 证据待锁项（写对应函数前结案）

1. storageDomain 读 API 精确签名（`get`/`put`/`update`；update 已证 `domain.ts:332-338`，put 覆盖语义已证 README/D6——无 compare-and-put，占位走 update RMW）；
2. 携带 Service 的包如何同时声明 Config 与 pre-step 监听（对照 schedule/goal 挂载形态）；
3. `SubagentStopReason` 完整联合与 `SubagentRun.result` 形状（已证部分：`types.ts:215-217,236-252,263-268`）；
4. `session/event` 监听 payload（`agent-instructions/src/index.ts:305` 用法在案）；
5. `dsh-brand` 导出名与 `Branded<B>` 用法；
6. `PreStepDecision` 构造（`time-context` 用法在案）；
7. 项目根解析与 `skill-filesystem` `findProjectRoot`（:937-947）同源——`ProjectKey` 唯一解析规则；
8. 自定义 Provider `invalidate()` 到下一次 `ctx.skills.list()` 的可见性时序（P0 T26）；
9. tool-skill-manage 双插件导出（provider 挂 host / 工具挂 authoring preset）的 Loader 组合形态（对照 bundle 包先例）；
10. `SkillCandidate.metadata`/`whenToUse` 在 managed frontmatter 的解析来源（P2 结构验证一并钉）。

## 8. P5 — Rollout 与 effectiveness（两拆）

- L0 Shadow：saga commit 步零 mutation，proposal 全落 ledger；`reviewedThroughSeq` 照常推进（升级 L1 不自动 backfill，重学仅显式 re-review/migrate）。
- **Operational 指标（ledger/usage 直接可得，`aggregateOutcomes` 纯函数）**：retry/terminal 计数、`review_cancelled_for_foreground`、provider conflict 率、review range lag（`desiredThrough - reviewedThrough`）、review tokens/session、新增 prompt tokens、resume-blocking P95、draft approval/reject 率、orphan revision 数与 orphan bytes、memory blocked-on-publish 次数、stale replan 率、crash recovery 成功率、noChange 率、budget_exceeded→consolidation 成功率。
- **Quality 指标（需 eval harness，无 harness 不得声称已测量）**：proposal precision（人工抽样）、false durable memory 率、learned 后人工纠正率、repeated-task success、draft 接受后无用率、post-curation regression、confidence calibration、scope 误分类率（L2）。harness 要求：gold/人工标注样本、before-vs-after 重放、held-out 任务集。
- 升级 gate 人工评审，数值进 Config/PR 说明；`confidence` 校准前不参与任何自动授权。
