# Agent Note：会话评审 P0 骨架与 Evidence Lock 套件

Status: implemented

[English](2026-08-31-session-review-p0-skeleton.md) | 中文

## Problem

会话评审运行时（自我进化：把已完成会话区间沉淀为记忆记录与受管技能）已在设计 RC5.5.2 冻结，并规定了强制的 P0 阶段：在任何运行时代码落地之前，钉死设计所依赖的跨包行为事实，且零行为变化。这些事实横跨存储、文件系统、技能注册表与工具面契约，而设计自身的协议（回执、名称预留、待定目录修订、终结定序）必须被证明能在真实基础设施上运行。当时没有任何包能承载这套套件。

## Decision

新建 `review/` 组，内含一个包 `@deepseek-ai/dsh-session-review` 作为 P0 骨架：保留 Cordis 插件名 `session-review`，拥有一个解释性为空的 invariant companion，不注册任何运行时行为。Evidence Lock 套件位于 `tests/evidence-lock/`，实现 `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md` 的 68 例 P0 矩阵（66 活跃 + 2 项历史回归重放）。各用例直接驱动真实基础设施；描述运行时未来协议的用例，以测试内的参照实现跑在同一批真实基础设施上。这些原型刻意只存在于测试：不承担覆盖义务，运行时落地时也不得晋升为生产代码——运行时包将拥有自己的实现与 invariant。

注册足迹保持机械性：subsystem-pages 门新增 `review` 豁免（尚无运行时子系统），组加入 `packages/README.md` 表，聚合 tsconfig 引用本包。

矩阵现已全部钉死：10 个 spec 共 72 条测试覆盖全部 68 例——storage/fs 契约、技能注册表、session/tools/subagent/query/preset 面，以及评审协议本身：游标 claim 与结算、append-only ledger attempt、名称预留、带回执集的 record CAS、完成标记 bundle 协议、saga 终结定序、分组 terminal ack。协议用例以两个参照模块（`review-protocol.ts`、`managed-protocol.ts`）跑在真实 storage-domain 写链与真实 `ctx.fs` bundle 上；memory 域用例跑在真实 Cordis 服务注册表上。

## Consequences

评审设计的假设现在败于一条测试，而非运行时事故：改动任一被钉死契约，都会在 `packages/review/session-review/tests/evidence-lock/` 浮现确切的矩阵用例。代价是维护——套件会重复钉死所属包已测的契约，同一契约变更可能要求一个 PR 内同步两个套件。套件的依赖面也远宽于包在运行时真正会 import 的范围；devDependencies 必须与测试 import 保持一致，否则 knip 会响亮失败。

## 套件修正的假设

- T01：未知 provider 是异步 `NO_PROVIDER` rejection，不是同步抛错；重复 provider 注册才是同步抛错。
- T04：子会话持久化 header 键为驼峰（`parentSession`、`delegationDepth`）；矩阵写作 `parent_session`。
- T05：`session-query` 位于 `packages/session-query/session-query`，不在 `packages/session/` 下。
- T28/T29/T42/T43 指向尚无生产实现的未来 P1/P3 机制。游标、claim、memory service、composite snapshot 事实由测试树内参照实现钉死。T42/T43 在早前批次计划中缺席；因验收门要求 68 例全覆盖而归入本批。
- T12：`SubagentStopReasonMap` 是纯类型导出；终态集合以类型化数组钉死，而非枚举运行时对象。
- T15：durable `tool/result` 事件不携带 exec 身份——名称只能经 callId 与 `tool/call` 配对恢复；provider 归因在 live `tools/result` 通道（T41）。
- T44：域单开分两层。同一 facility 二开拒绝为 `already-open` 域错误；第二个 facility 打开同一 backend 命中 backend 的"unit is already open"活句柄守卫。
- T16：pre-step 瀑布注册顺序使先注册者在外层，内层监听的 `next()` 观察不到外层产物。目录事实经被 await 的 decision 钉死，而非嵌套监听。
- 内置文件系统技能 provider 名为 `filesystem`；`self-evolution-managed` 保留给进化产物。
- `defineContentToolFixture` 接收属性映射方言（`{ text: { type: 'string', required: true } }`），不是裸 JSON schema。
- pre-push 钩子的全新 `tsc -b tsconfig.host.json` 能抓到增量 `pnpm run typecheck` 漏掉的 spec 类型错误；每次 push 前先复现钩子序列。

## Alternatives considered

把套件分散到各所属包（skill、storage、fs）被否决：矩阵的价值在于跨包并置、单一归属，以及设计文档可引用的单一编号，分散会同时丢掉这三者。推迟到运行时存在后再写被设计本身否决——P0 的意义正是在运行时把意外固化之前发现基础设施的意外。

套件依赖的两个 harness 事实记录在此，因为它们消耗了调试时间：测试 invariant 宿主按已解析 callback 合并重复插件挂载，因此 companion 的注册只能通过对其 `apply` 直呼已挂载服务来证明；companion 的 `apply` 是同步抛出（注册发生在求值 `Promise.resolve` 实参时），想要拿到 rejection 的调用方必须延迟调用。

## Verification

`npx vitest run packages/review/session-review/tests`（72 条测试）跑套件；`npm run build:lib:host && npm run typecheck:contracts-ready`（pre-push 序列——不是增量 `pnpm run typecheck`）；`verify-package-invariants`、`verify-subsystem-pages`、`verify-package-readme-limitations`、`verify-tsconfig-paths`、`verify-translation-pairing`。
