# RC5.2 函数级规格总纲（TDD）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 上位文档：`自我进化机制-RC5.2-方案.md`；本总纲 + 五份附件把方案落到**类名 / 函数名 / 签名 / 调用关系 / 验收标准**级，按 TDD 实施
>
> 附件索引：`RC5.2-附件P0-evidence-lock.md`、`RC5.2-附件P1-memory.md`、`RC5.2-附件P2-skill-managed.md`、`RC5.2-附件P3-session-review.md`、`RC5.2-附件P4-curator.md`（P5 rollout 无独立代码面，见本文件 §8）
>
> 日期：2026-08-29

## 1. 全局约定

- **包形态**：函数插件命名导出 `name`/`inject`/`Config`/`apply` 无 default export；携带 Service 的包 default export 服务类（`packages/AGENTS.md`）；Service 经 `super(ctx, key)` 注册（先例 `skill/src/index.ts:357,375`、`goal/src/index.ts:194`；基类 `vendor/cordis/src/service.ts:11`）。
- **命名**：类名取上游角色表；跨边界 id branded（`MemoryEntryId`/`OpId`/`ReviewId`，`Branded<B>`）；错误类 `*Error` 带 machine-readable `code`；领域记录 zod、插件 Config schemastery（字段全带 JSDoc，无静默默认）。
- **纯函数优先**：折叠/预算/投影/状态机/digest 全纯函数，I/O 只在壳层——100% per-file 覆盖门的前提。纯函数不得生成 id/时钟（[核验 S1-4]）：权威字段由 host 预分配并入参。
- **storageDomain 契约**：`update(key,fn)` 对缺失 key 抛 `missing-key`（`domain.ts:85,334-338`）；创建用 `put`；单 record 原子、无跨表事务（README:152）；单 Host writer 部署模型。
- **TDD 纪律**：先红后绿；验收即测试名清单；边界值与拒绝路径必测。

## 2. 包与类清单（全量）

| 包（新） | 类 / 顶级构件 | 职责 | Phase |
|---|---|---|---|
| `packages/util/content-scan` | `scanContent()` + `_PATTERNS` | 纯函数威胁扫描，severity 三档（blocked/caution/safe） | P1 |
| `packages/memory/memory` | `MemoryService extends Service`；`MemoryPublisher`；`foldMemoryOps`/`enforceBudget`/`buildSnapshotSections`/`computeSnapshotDigest` | 记忆权威状态 + 资源级幂等 + durable replacement 发布（fail-open） | P1 |
| `packages/skill/tool-skill-manage` | **`ManagedSkillProvider`**（list 只出 active）；`AuthoringCore`；`skill_manage` 薄工具；`ManagedSkillOwnershipStore` | agent 自治技能来源（不可变 revision + sidecar CAS）+ 模型面入口 | P2 |
| `packages/skill/skill-authoring` | `SkillAuthoringService extends Service`（`transitionManagedSkill`/`markStale`/`archive`/`revive`/`commitPlanOps`） | P3 自 tool-skill-manage 抽出的 Host authoring capability | P3 |
| `packages/review/session-review` | `ReviewRuntime`；`ReviewCursorStore`；`ReviewLedgerStore`；LearningView 投影纯函数组；`ReviewPlanSchema` | 触发/证据投影/两阶段 planner/admissibility/幂等 commit | P3 |
| `packages/skill/skill-curator` | `SkillCurator`；`SkillUsageObserver`；`transition()`；`aggregateOutcomes()` | 生命周期状态机（时间锚点）+ best-effort usage | P4 |

**fork-diff 台账**（对上游包的修改仅此一处，PR 逐行说明）：`packages/session-query/tool-session-query` 模型面默认附加 `{kind:'parent', values:[null]}`（`session-query/src/types.ts:198` 既有 filter 类型）+ `includeChildSessions` 逃生参数；`ctx.sessionQuery` 服务能力不改。

## 3. 跨包调用图

```text
session-review.ReviewRuntime
  ├─ ReviewCursorStore / ReviewLedgerStore ── ctx.storageDomain
  ├─ buildLearningView（纯）◄── agent.session.events（raw log）
  ├─ ctx.subagents.start(config.reviewProvider ?? 'spawn', {…})   [两阶段 patch]
  ├─ ctx.memory.applyOps（memory 包，appliedOps 幂等）
  └─ SkillAuthoringService.commitPlanOps / transitionManagedSkill
memory.MemoryPublisher（agent/pre-step，fail-open）
  ├─ ctx.memory.getState ── ctx.storageDomain
  ├─ buildSnapshotSections / computeSnapshotDigest / scanContent（二次闸）
  └─ createUserMessage(source { kind:'memory', form:'snapshot', sections })
tool-skill-manage.skill_manage（defineTool 薄壳）
  └─ AuthoringCore ── ctx.fs（只 writeText） / ManagedSkillProvider.invalidate
                     / ctx.storageDomain / scanContent
skill-curator.SkillCurator（自带触发器 → runMaintenance 取 idle ownership）
  ├─ SkillUsageObserver ── session/event（只读，best-effort）
  └─ SkillAuthoringService.transitionManagedSkill（唯一写通道）
```

## 4. 阶段函数索引

| 阶段 | 附件 | 规模 | 核心交付 |
|---|---|---|---|
| P0 | 附件P0 | 33 项证据测试 | 行为事实钉死 + E0 结案 |
| P1 | 附件P1 | 2 类 + 11 函数 + content-scan 包 | MemoryService 幂等 + 预算 + snapshot 发布（fail-open） |
| P2 | 附件P2 | 3 类 + 10 函数 + 1 工具 | ManagedSkillProvider + AuthoringCore + 冲突不变式 |
| P3 | 附件P3 | 4 类 + 16 函数 | ReviewRuntime 全链 + 两阶段 patch + session-query 默认过滤 + skill-authoring 抽出 |
| P4 | 附件P4 | 2 类 + 4 函数 | 生命周期状态机 + best-effort usage |
| P5 | 本文件 §8 | 指标 gate | L0→L2 rollout + effectiveness |

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
| `budget_exceeded` | memory fold / authoring preflight | 超硬预算；拒绝并附现库存与整合建议 |
| `stale_base_revision` | memory applyOps / ownership CAS / authoring | base revision/digest 不匹配；reject/replan |
| `name_conflict_with_human_source` | authoring checkNameConflict | 人工来源同名（P0 安全不变式） |
| `invalid_structure` | authoring validateStructure | frontmatter/字节上限/路径越界/binary/symlink |
| `threat_scan_blocked` | scanContent 消费方（severity=blocked） | 命中高危模式 |
| `unadmissible_evidence` | session-review admissibility | span 不存在 / kind 放行规则不满足 |
| `planner_terminal_failure` | session-review gateResult | stopReason ≠ completed 或 structured 缺失/不合法 |
| `missing-key` / `version-mismatch` | storageDomain 既有错误**原样透传**（`domain.ts:336`、`error.ts:11`） | 首录未初始化 / domain 版本不匹配 |

## 7. E0 证据待锁项（写对应函数前结案）

1. storageDomain 读 API 精确签名（`get`/`put`/`update`/`delete`；update 已证 `domain.ts:332-338`，put 覆盖语义待钉）；
2. 携带 Service 的包如何同时声明 Config 与 pre-step 监听（对照 schedule/goal 挂载形态）；
3. `SubagentStopReason` 完整联合与 `SubagentRun.result` 形状（已证部分：`types.ts:215-217,236-252,280`）；
4. `session/event` 监听 payload（`agent-instructions/src/index.ts:305` 用法在案）；
5. `dsh-brand` 导出名与 `Branded<B>` 用法；
6. `PreStepDecision` 构造（`time-context` 用法在案）；
7. 项目根解析与 `skill-filesystem` `findProjectRoot`（:937-947）同源；
8. 自定义 Provider 经 `registerProvider` 持 `SkillProviderControl` 后，`invalidate()` 到下一次 `ctx.skills.list()` 的可见性时序（P0 T-新增）。

## 8. P5 — Rollout 与 effectiveness

- L0 Shadow：saga 第 10 步零 mutation，proposal 全落 ledger；`reviewedThroughSeq` 照常推进（**升级 L1 不自动 backfill**，重学仅显式 re-review/migrate）。
- 指标（`aggregateOutcomes` 纯函数，ledger + usage 聚合，零新存储）：proposal precision（人工抽样）、false durable memory 率、duplicate/superseded 率、learned 后人工纠正率、repeated-task success、draft acceptance、post-curation regression、review tokens/session、新增 prompt tokens、resume-blocking P95、confidence calibration、`review_cancelled_for_foreground`、retry/terminal 计数、approval accept/reject 率（若启用）、memory blocked-on-publish 次数、orphan revision 数、provider conflict 率、review range lag（`desiredThrough - reviewedThrough`）。
- 升级 gate 人工评审，数值进 Config/PR 说明；`confidence` 校准前不参与任何自动授权。
