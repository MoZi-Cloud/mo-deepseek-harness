# RC5.5 交接稿（接手人冷启动载体）

> 用途：新会话/新执行者接手 RC5.5 自我进化机制开发时的第一份读物。读完后与 `RC5.5-执行进度报告.md`（唯一进度与交接载体，下称"进度报告"）+ 冻结方案文档（`RC5.5-函数级规格总纲.md` + 附件 P0–P4）对账即可开工。
>
> 性质：本稿是**时点快照**，不替代进度报告——进度报告 §3 台账与代码 HEAD 对账后的结论才是当前事实；若两者与本稿冲突，以进度报告 + HEAD 为准。
>
> 状态：Architecture Frozen / Implementation Approved（RC5.5.1 裁定，第八轮开工评审）：九条第一原则与包边界冻结，后续发现默认按 bug / invariant test / implementation adjustment 处理，不再开 RC5.6 式文档套件。首版 crash model = Host/process crash + restart，不声称断电/内核崩溃级保证。

## 1. 任务一句话

在 DSH fork 里按冻结的函数级规格，用 TDD 把"agent 从会话历史自动学习 durable memory 与 managed skill"做成一组原生插件；`RC5.5-执行进度报告.md` 是无人值守开发的唯一进度载体，每阶段完成增补其 §3 台账并 commit+push。

## 2. 总路线与包/阶段口径（精确）

- **代码落点**：P1–P4 共 **4 个新增实现包、5 个代码落点**——
  - P1：`packages/util/content-scan` + `packages/memory/memory`（本 Phase 两个实现包）
  - P2：`packages/skill/skill-managed`
  - P3：`packages/review/session-review`（P0 已建骨架 + Evidence Lock 测试，P3 填充运行时）
  - P4：`packages/skill/skill-curator`
- **P0 不是新包**：Evidence Lock 测试矩阵 + session-review 包骨架，zero behavior change。
- **P5 无独立代码面**：rollout 指标 gate（总纲 §8，L0→L2 + operational/quality 两拆）。

| 阶段 | 内容 | 本稿时点状态 |
|---|---|---|
| P0 | Evidence Lock **68 项验收条目**（66 活跃 + 2 历史回归 T09/T11；实跑 **72 个测试**）+ E0 结案 | 完成 |
| P1 批A | content-scan（三档折叠 + 四语料 + 全注册门） | 完成（`1462092cba`） |
| P1 批B | memory 包骨架 + types/domain/fold 纯函数组 + 单测 | 纯函数层已提交（`00e6658986`，2026-08-31 17:56 +0800），**批 B 尚未完成阶段验收**（缺 MemoryService/Publisher/Service 验收测试/loader 装配/收尾批全部门面） |
| P1 批C | MemoryService + MemoryPublisher + MessageSourceMap 装配 | 未开始（`src/index.ts` 当前仅 re-export） |
| P1 收尾批 | 全验收 + 100% 覆盖 + REAL boot + HMR + snapshot + 双 SDK + README/Agent Note + pre-push | 未开始 |
| P2 | skill-managed（先红 T62–T65 接线，见 §4） | 未开始 |
| P3 | session-review 运行时（finalization path 前置 T66–T68） | 未开始 |
| P4 | skill-curator | 未开始 |
| P5 | rollout 指标 gate | 未开始 |

## 3. 当前精确接手位置

**先做（进度报告 §4.1 前置补账）**：
1. 进度报告 §3/§4 已回填（2026-08-31 17:56 +0800 之后）；接手时核对 §3 台账与 HEAD 一致。
2. **Agent Note**：memory 批B 属非平凡变更，双语 Agent Note 排入 P1 收尾批（进度报告 §4.3）——不能跨批遗忘。
3. ~~OpId 钉 branded~~ **已落地**：`packages/memory/memory/src/types.ts` 现为 `OpId = Branded<'OpId'>`（纯类型零运行时），附件P1 §2 已同步补行。**遗留：P3 `deriveOpId` 必须返回该 branded 类型（P3 验收前核对）。**

**然后（进度报告 §4.2 批C，TDD 按附件P1 §3 验收名）**：
- `MemoryService extends Service`（唯一 memory 域 opener，T42 语义；`getState`/`applyOps` 单 RMW 闭包：receipt 查重先于 base 检查 → 写边界 `scanContent` 闸（blocked → `threat_scan_blocked`）→ 折叠提交；`acknowledgeTerminalOps` 幂等三分）
- `resolveMemoryScope`：`findProjectRoot(cwd, ctx.fs)` → `ctx.fs.resolve(root)` → ProjectKey = sha256(targetKey)；非 local backend fail-loud（E0-12）
- `MemoryPublisher`（pre-step 体内、composite、fail-open：sanitize → render → digest → 比对 `latestPublishedMemory` 倒扫 → 变更才发**一条** `CompositeMemorySnapshot`）
- `MessageSourceMap` 声明合并注册 `'memory'` kind（范例 `packages/skill/tool-skill/src/index.ts:34-47`）

**批C 之后必须走完 P1 收尾批才能进 P2**（进度报告 §4.3）：全验收测试 + per-file 100% 覆盖 + REAL boot + HMR disposal + 双 SDK expected outputs（wire 面变化时）+ snapshot 免钥回放 + README 三件套 + 双语 Agent Note + pre-push 序列（`npm run build:lib:host && npm run typecheck:contracts-ready`）。**批C 完成 ≠ P1 完成。**

## 4. P2"先红"的准确语义

T62–T68 已在 P0 Evidence Lock 矩阵落位（附件P0 §3）。P2/P3 所谓"先红"：
- **不是**重定义一套测试，**不是**把 P0 测试树参照实现（`review-protocol.ts`/`managed-protocol.ts`）晋升为生产代码（进度报告 §3 P0 条明确禁止）；
- **是**让生产实现对已存在的不变量先失败再实现。接线面：T62/T63（`deriveOpId` 纯函数）落 P3；T64/T65（skill receipt 生产路径：create 同 op 重放、receipt 集非单槽）落 P2；T66–T68（finalization 协议：applied-only ack、幂等 finalization、disposition 门控 advance）是 P3 finalization commit path 的前置。

## 5. 纪律要点（接手人必读）

1. **阶段完成定义**（进度报告 §1 规则 2）：该批验收测试 + `pnpm run typecheck` + `npx oxlint <改动包>` + `pnpm run test:docs` 全绿 → commit → 增补进度报告 §3 → push。
2. **TDD**：先红后绿；验收即测试名清单（附件各 §3 逐条列死）；边界值与拒绝路径必测。
3. **Config**：部署可变参数必须由 Config 显式声明并验证（schemastery，字段全带 JSDoc）；**只有规格钉死的默认值可以存在**（P1 唯一：`publisherEnabled: true`）——不是"禁止一切默认值"，而是"禁止未声明的隐式默认"。
4. **纯函数纪律**：折叠/预算/投影/digest/状态机全纯，I/O 只在壳层；纯函数不得生成 id/读时钟。
5. **branded id**：跨边界 opaque id 一律 `Branded<B>`（`dsh-brand`）；OpId 补钉见 §3。
6. **错误码**：`*Error` 带 machine-readable `code`（总纲 §6 总表）；`duplicate` 是 `ApplyOpStatus` 不是错误。
7. **参照实现不晋升**：P0 测试树的 `review-protocol.ts`/`managed-protocol.ts` 仅存在于测试树，运行时落地时不得晋升为生产代码（签名对照即可）。
8. **上下文 meter**（无人值守）：唤醒先 `node /home/moyang/Documents/a88/zcode-cdp/meter.mjs`；>120000 → 先 commit+push 再跑 auto-compact watchdog 并结束回合；唤醒/心跳只发一条消息。
9. **仓库规则**：遵守根 `AGENTS.md` 全部规则；非平凡变更含 Agent Note（双语）；README 三件套（Model Experience + Known Limitations）；生产代码不得引用测试树参照实现；凭据绝不入库。

## 6. 时点核对清单（接手时逐项过）

| 项 | 核对方式 |
|---|---|
| 进度报告 §3 台账与 HEAD 一致 | `git log --oneline -8` 对照 §3 断点提交 |
| memory 纯函数层目标测试绿 | `npx vitest run packages/memory packages/util/content-scan` |
| P0 回归绿 | `npx vitest run packages/review/session-review/tests` |
| 批B 完成定义未走完 | `packages/memory/memory/src/` 无 `service.ts`/`publisher.ts`；`src/index.ts` 仅 re-export |
| OpId 仍裸 string | `grep -n "OpId" packages/memory/memory/src/types.ts` |
| 收尾批欠账 | `.agents/notes/` 无 memory 批B/批C note；`snapshots/session/` 无 memory 案例 |

## 7. 文档地图

| 文档 | 角色 |
|---|---|
| `RC5.5-执行进度报告.md` | 唯一进度与交接载体（常备协议/总路线/阶段台账/下一步/基础设施锚点/常用命令） |
| `RC5.5-函数级规格总纲.md` | 冻结规格：全局约定/包与类清单/跨包调用图/阶段函数索引/错误码总表/E0 结案/P5 |
| `RC5.5-附件P0-evidence-lock.md` | 68 项验收条目矩阵（66 活跃 + 2 历史回归）+ E0 结案记录 |
| `RC5.5-附件P1-memory.md` | memory + content-scan 函数级规格（模块布局/类型契约/函数规格+验收名/Config/验收门） |
| `RC5.5-附件P2-skill-managed.md` / `P3-session-review.md` / `P4-curator.md` | P2–P4 函数级规格 |
| `自我进化机制-RC5.5-方案.md` | 上位方案（九原则/数据模型/包规划/机制要点/Phase 门槛/非目标），RC5.5.2 版 |
| `RC5.5-第八轮开工评审.md` + `RC5.5.1-第八轮评审核验与处置.md` | T62–T68 六项协议补丁的评审与处置（开工裁定来源） |
| `RC5.5-交接稿.md`（本文件） | 时点快照，冷启动第一读 |
