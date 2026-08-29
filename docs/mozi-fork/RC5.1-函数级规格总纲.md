# RC5.1 函数级规格总纲（TDD）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 上位文档：`自我进化机制-RC5.1-方案.md`（架构与处置）；本总纲 + 五份附件把方案落到**类名 / 函数名 / 签名 / 调用关系 / 验收标准**级，按 TDD 实施
>
> 附件索引：`RC5.1-附件P0-evidence-lock.md`、`RC5.1-附件P1-memory.md`、`RC5.1-附件P2-skill-authoring.md`、`RC5.1-附件P3-session-review.md`、`RC5.1-附件P4-curator.md`（P5 rollout 无独立代码面，见本文件 §7）
>
> 日期：2026-08-29

## 1. 全局约定（每个函数都受这些约束）

- **包形态**：函数插件命名导出 `name`/`inject`/`Config`/`apply` 且无 default export；携带 Service 的包 default export 服务类（`packages/AGENTS.md`）。`MemoryService` 等经 `super(ctx, key)` 自动入 Context（先例 `skill/src/index.ts:357,375`、`goal/src/index.ts:194`；基类 `vendor/cordis/src/service.ts:11`）。
- **命名**：类名取上游角色表（Service/Store/Runtime/Policy/Registry/Provider）；跨边界 id 一律 branded（`MemoryEntryId`、`ReviewId`、`OpId`、`SkillOwnershipRevision`，`Branded<B>` from `dsh-brand`）；错误类 `*Error` 带 machine-readable `code`（先例 `GoalError`）；领域记录 schema 用 zod（storageDomain 契约），插件 Config 用 schemastery 且字段全带 JSDoc。
- **纯函数优先**：状态迁移、预算、投影、digest 全部为纯函数（先例 goal `fold.ts`），I/O 只在 Runtime/Service 壳层——这是 100% per-file 覆盖率门可达成的前提。
- **测试位置**：包级 `tests/*.spec.ts`；REAL-composition boot 测试挂 boot 场景（`cordis.yml` 经 Loader）；注册贡献配 HMR disposal 测试；模型可见文案钉 snapshot。
- **TDD 纪律**：附件里每个函数按"先红后绿"实施；验收标准即测试名清单，全部绿才算该函数完成；一个函数的验收含边界值与拒绝路径，不含仅成功路径。
- **证据纪律**：凡引用既有仓内 API 处标 path:line（本会话已核实）；新代码内部调用不标。E0 待锁项（总纲 §8）核完前不得写对应函数。

## 2. 包与类清单（全量）

| 包（新） | 类 / 顶级构件 | 职责一句话 | Phase |
|---|---|---|---|
| `packages/util/content-scan` | `scanContent()` + `_PATTERNS` 数据模块 | 纯函数威胁扫描（中英锚点/不可见字符/NFKC） | P1 |
| `packages/memory/memory` | `MemoryService extends Service`；`MemoryPublisher`；fold/renderer 纯函数组 | 记忆权威状态、资源级幂等 mutation、durable replacement 发布 | P1 |
| `packages/skill/tool-skill-manage` | `skill_manage` 工具；`AuthoringCore`（内聚模块） | 模型面 authoring 工具 + 结构验证/CAS/冲突检查 | P2 |
| `packages/skill/skill-authoring` | `SkillAuthoringService extends Service` | P3 自 tool-skill-manage 抽出的 Host authoring capability | P3 |
| `packages/review/session-review` | `ReviewRuntime`；`ReviewLedgerStore`；`ReviewCursorStore`；LearningView 投影纯函数组；`ReviewPlanSchema` | 触发、证据投影、planner 派发、admissibility、幂等 commit | P3 |
| `packages/skill/skill-curator` | `SkillCurator`；`SkillUsageObserver`；`transition()` 纯状态机 | 生命周期状态机 + usage 观察者 | P4 |

**对上游包的修改（fork-diff 台账，保持最小并在 PR 中逐行说明）**：

| 上游文件 | 修改 | Phase |
|---|---|---|
| `packages/skill/skill-filesystem/src/index.ts` | 同包新增 `ctx.skillMutationObserver` 宿主服务（`{ observeHostMutation(path) }`，转发 provider 既有方法 `skill-filesystem/src/index.ts:139-142`） | P2 |
| `packages/session-query/tool-session-query/src/operations.ts` | 模型面默认附加 `{ kind:'parent', values:[null] }` 过滤（服务层类型已存在，`session-query/src/types.ts:198`）+ `includeChildSessions` 显式逃生参数 | P3 |
| `scripts/translation-pairing.manifest.json` | 已登记 fork 文档排除（已完成） | — |

## 3. 跨包调用图

```text
session-review.ReviewRuntime
  ├─ ReviewCursorStore / ReviewLedgerStore ── ctx.storageDomain
  ├─ buildLearningView（纯）◄── agent.session.events（raw log）
  ├─ ctx.subagents.start(config.reviewProvider ?? 'spawn', {…})
  ├─ ctx.memory.applyOps（memory 包）
  └─ SkillAuthoringService.commitPlanOps（skill-authoring 包）
memory.MemoryPublisher（agent/pre-step）
  ├─ ctx.memory.getState ── ctx.storageDomain
  ├─ computeSnapshotDigest / buildSnapshotSections（纯）
  └─ createUserMessage(source { kind:'memory', form:'snapshot', sections }) → decision.messages
tool-skill-manage.skill_manage（defineTool）
  └─ AuthoringCore ── ctx.fs / ctx.skillMutationObserver / ctx.storageDomain / scanContent
skill-curator.SkillCurator（runMaintenance）
  ├─ SkillUsageObserver ── session/event（只读）
  └─ SkillAuthoringService（唯一写通道）
```

## 4. 阶段函数索引

| 阶段 | 附件 | 函数/类数 | 核心交付 |
|---|---|---|---|
| P0 | 附件P0 | 0（23 项证据测试） | 行为事实钉死；E0 待锁项结案 |
| P1 | 附件P1 | 3 类/服务 + 12 函数 | MemoryService + appliedOps 幂等 + snapshot 发布 + 硬预算 + content-scan |
| P2 | 附件P2 | 2 类 + 9 函数 + 1 工具 | AuthoringCore + skill_manage + 失效缝 + 同名冲突 P0 不变式 |
| P3 | 附件P3 | 4 类 + 14 函数 | ReviewRuntime 全链路 + ReviewInput + admissibility + saga + session-query 默认过滤 |
| P4 | 附件P4 | 2 类 + 4 函数 | 生命周期状态机 + usage 观察者 |
| P5 | 本文件 §7 | 指标 gate | L0→L2 rollout 与 effectiveness |

## 5. 每函数规格格式（附件遵循）

```text
#### `函数名(参数: 类型): 返回类型`
职责：一句话。
调用：被 X 调用；调用 Y/Z。
输入：参数语义与不变式。输出：返回值语义与错误码。
验收：`test 名`（断言要点）——全部列出，缺一不算完成。
```

## 6. 错误码总表（跨包 machine-readable，`*Error.code`）

| 错误码 | 抛出点 | 语义 |
|---|---|---|
| `budget_exceeded` | memory fold / authoring preflight | 超记忆硬预算；拒绝并附现库存与整合建议 |
| `stale_base_revision` | memory applyOps / authoring CAS | base revision 不匹配；reject/replan |
| `duplicate_op` | memory fold（appliedOps 命中） | 幂等命中；返回原 resultDigest |
| `name_conflict_with_human_source` | authoring checkNameConflict | 人工来源同名（P0 安全不变式） |
| `invalid_structure` | authoring validateStructure | frontmatter/字节上限/模板令牌/内联 shell |
| `threat_scan_blocked` | scanContent 消费方 | 命中威胁模式 |
| `unadmissible_evidence` | session-review admissibility | span 不存在/kind 放行规则不满足 |
| `planner_terminal_failure` | session-review gateResult | stopReason ≠ completed 或 structured 缺失/不合法 |
| `schema_version_mismatch` | storageDomain open（`spec.ts:38` 既有行为） | 需显式 reset/migrate |

## 7. P5 — Rollout 与 effectiveness（无独立代码面）

- L0 Shadow：`commitSaga` 以 `Config.rolloutLevel: 'shadow'` 运行时跳过第 10 步（逐资源 commit），proposal 与 evidence 全量落 ReviewLedger。
- 指标采集：全部从 ReviewLedger 与 usage 账本聚合（`aggregateOutcomes(range)` 纯函数，P4 附件），无新事件、无新存储。
- 升级 gate（人工评审，数值进 Config/PR 说明）：proposal precision 抽样、false durable memory、duplicate/superseded 率、learned 后人工纠正率、repeated-task success、draft acceptance、post-curation regression、review tokens/session、新增 prompt tokens、resume-blocking P95、confidence calibration。
- `confidence` 在 calibration 完成前不参与任何自动授权（核验处置 S1-6）。

## 8. E0 证据待锁项（写对应函数前必须结案）

1. storageDomain 读/写 API 精确签名（`get`/`put`/`update`，`domain.ts:89` 已证 update）；
2. 携带 Service 的包如何同时声明 Config 与 pre-step 监听（对照 schedule/goal 的实际挂载形态）；
3. `SubagentStopReason` 完整联合（已证 `'max-tokens'`/`'error'`，`types.ts:215-217,280`）与 `SubagentRun.result` 类型形状；
4. `session/event` 监听 payload 形状（`agent-instructions/src/index.ts:305` 用法在案）；
5. `dsh-brand` 包导出名与 `Branded<B>` 用法；
6. `PreStepDecision` 构造方式（`@deepseek-ai/dsh-agent` 导出，`time-context` 用法在案）；
7. 项目根解析：与 `skill-filesystem` `findProjectRoot`（:937-947）同源或复用。
