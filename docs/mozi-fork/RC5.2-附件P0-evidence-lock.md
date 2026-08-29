# RC5.2 附件 P0 — Evidence Lock（行为事实钉死，33 项）

> 上位：`RC5.2-函数级规格总纲.md`。P0 = **zero behavior change**（允许测试与未来包骨架，不注册生产行为、不改 shipped composition）。
>
> 测试落位：`packages/review/session-review/tests/evidence-lock/*.spec.ts`（本阶段创建该包骨架）。
>
> 日期：2026-08-29

## 1. 测试矩阵（T01–T23 承 RC5.1；T24–T33 为第四轮新增）

| # | 测试 | 钉死事实 | 通过标准 |
|---|---|---|---|
| T01 | `start-provider-contract` | `start(name,…)` 首参按 provider 解析（`subagent/src/index.ts:552`） | 未知 provider 同步抛错；`'spawn'` 可解析 |
| T02 | `allow-empty-inherited-tools` | `allow:[]` 只移除继承全局工具；scoped 注册与 PTC transport 不受影响（`core/tools/src/index.ts:677-679`） | schema 无业务工具；同名执行被拒；protocol 工具存活 |
| T03 | `output-schema-capture` | `structured` 仅成功 capture 存在（`types.ts:236-252`） | capture 失败 → `stopReason:'error'` 且 `structured===undefined` |
| T04 | `child-session-persistence` | spawn 子会话持久化（childSessionMeta） | header 落盘含 `origin/parent_session/agentPreset` |
| T05 | `parent-filter-query` | `{kind:'parent',values:[null]}` 只返回根会话（`session-query/src/types.ts:198`） | 子会话仅显式列名可见 |
| T06 | `standing-preset-singleton` | standing mount 插件为进程级单例（`agent-presets/src/mount.ts`） | 跨 session 同实例；`WeakMap<Agent,…>` 键控隔离 |
| T07 | `storage-update-serial-atomic` | `update` 单进程串行原子（`domain.ts:84,89,332`） | 并发不交错，终态=串行应用 |
| T08 | `skill-rank-shadowing` | rank 100 胜 200（`skill/src/index.ts:75`） | 同名只出胜者 |
| T09 | `draft-staging-undiscovered` | 嵌套目录不进发现（`skill-filesystem/src/index.ts:719-747`） | `.drafts/<n>/SKILL.md` 不出现在 list |
| T10 | `ctx-fs-host-write` | 宿主经 `ctx.fs` 写的策略语义（`fs-sandbox/src/index.ts:10-11`） | 行为记录归档 |
| T11 | `observer-seam-missing` | 现状无跨包失效缝（[核验 S1-7]） | 导出面断言（before 证据） |
| T12 | `run-result-terminal-states` | 终态枚举 + `structured` 可选 | 各终态 result 形状快照 |
| T13 | `request-header-bytestable` | header.system 逐字节 + 跨 resume 一致（`invariant.ts:45`） | 复用上游断言防回归 |
| T14 | `fail-closed-vocabulary` | 未知事件类型拒绝（`known-event-types.ts`） | 无 ignorable 通道 |
| T15 | `tool-result-durable-surface` | skill 工具结果/`/name` 注入 durable 形状（`tool-skill/src/index.ts:125,196-203`） | 可提取 `exec.name`/isError/`source.kind` |
| T16 | `catalog-pre-step-timing` | 目录发布在 awaited pre-step（`tool-skill/src/index.ts:213-251`） | 时序断言 |
| T17 | `compaction-surface-vs-seq` | compaction 改表面不改 seq（`types.ts:357-366`） | replace 后 seq 稳定 |
| T18 | `subagent-start-scoped-events` | `subagent/start|end` 载荷（`subagent/src/index.ts:169-178`） | 载荷快照 |
| T19 | `sandbox-writable-roots` | 可写根 = workspaceRoot+/tmp（`sandbox/src/roots.ts:52-55`） | dshHome 拒绝 |
| T20 | `storage-domain-open-reject` | version 不匹配拒绝（`spec.ts:38`） | `version-mismatch` 透传 |
| T21 | `pre-step-waterfall-order` | pre-step awaited 瀑布语义 | 监听可延迟 step |
| T22 | `session-event-observe` | `session/event` 载荷与时机 | turn/end 可观测、含 seq |
| T23 | `run-maintenance-claim` | claim-或-throws（`runtime-types.ts:102-110`） | busy 抛、空闲重入成功 |
| **T24** | `storage-update-missing-key-first-record` | `update` 缺 key 抛 `missing-key`（`domain.ts:334-338`）；创建是 `put` 职责 | 首录必须走初始化协议；Store `ensureInitialized` 原型通过 |
| **T25** | `ctx-fs-no-move-contract` | `FileSystem` 12 原语无 rename/move/delete/copy（`fs/src/index.ts:86-256`） | 类型层断言 + 文档记录（防实现者绕 seam 用 node:fs） |
| **T26** | `provider-control-invalidate` | 自定义 Provider `control.invalidate()` 后下一次 `list()/get()` 见新状态（`skill/src/index.ts:271-275,391-400`） | 注册→变更→invalidate→可见 全链 |
| **T27** | `flat-and-frontmatter-collision` | 发现接受 `<root>/<f>.md` 且 candidate name 来自 frontmatter `name`（`skill-filesystem/src/index.ts:800-829`） | flat 文件 frontmatter 名冲突可检出 |
| **T28** | `truncation-contiguous-high-water` | 预算分片连续性设计约束 | oldest-first 切片原型：effectiveThrough 前无跳段 |
| **T29** | `cursor-acquired-busy` | claim 原子语义：acquired/busy/nothing-due + desiredThrough=max | 并发 claim 恰一个 acquired；due 不丢 |
| **T30** | `blocking-order-publisher-sees-commit` | blocking 复盘 commit → publisher pre-step 见新 state → 首请求含新 snapshot | 端到端顺序断言 |
| **T31** | `background-cancellation-recoverable` | foreground 到来可取消在飞后台工作且 cursor 可恢复（`SubagentRun.dispose`，`types.ts:289`） | 取消后 inFlight 保留/恢复重放安全 |
| **T32** | `assistant-final-derivation` | `assistant/message` 无 final 标志（`types.ts:262`），turn fold 可推导末条 outcome | 多 step 工具循环只投影末条 |
| **T33** | `managed-provider-catalog-visibility` | 自定义 provider rank 生效：active 才出 catalog；managed 恒败于人工同名（原型 Provider + rank 700） | 同名时人工胜；draft/archived 不出目录 |

## 2. E0 结案流程

总纲 §7 的 8 项随对应 T 结案回填（T07→E0-1、T12→E0-3、T22→E0-4、T02→E0-6 关联等）。结案与 RC5.2 假设不符时，先修订总纲/附件签名再进 P1。

## 3. 验收门

33 项全绿；E0 全结案回填；`git diff` 仅新增测试与包骨架（zero behavior change）；Agent Note 一篇记录结论与被修正的假设。
