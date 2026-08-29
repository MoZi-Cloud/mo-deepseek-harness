# RC5.1 附件 P0 — Evidence Lock（行为事实钉死）

> 上位：`RC5.1-函数级规格总纲.md`。P0 零产品代码；产出 = 测试 + 结案记录。
>
> 测试落位：`packages/review/session-review/tests/evidence-lock/*.spec.ts`（本阶段创建该包骨架：`package.json`/`tsconfig`/`src/index.ts` 最小插件 + `./invariant` + README），因其是全部被钉行为的编排消费者。
>
> 日期：2026-08-29

## 1. 测试矩阵（23 项；每项给断言要点）

| # | 测试文件 `.spec.ts` | 钉死事实 | 通过标准 |
|---|---|---|---|
| T01 | `start-provider-contract` | `ctx.subagents.start(name,…)` 首参按 provider 解析（`subagent/src/index.ts:552`） | 未知 provider 名同步抛错；`'spawn'` 可解析；request 携带 label/prompt/parent/signal |
| T02 | `allow-empty-inherited-tools` | `allow: []` 移除全部**继承全局**工具；scoped 注册与 PTC transport 不受影响（`core/tools/src/index.ts:677-679`） | 子代理可见 schema 中无 memory/skill_manage/write/edit/session_search；同名调用执行被拒；`structured_output`（如存在）仍可用 |
| T03 | `output-schema-capture` | `outputSchema` 经 `assertObjectJsonSchema` 校验；成功 capture 才有 `structured`（`subagent/src/types.ts:236-252`） | 合法 JSON Schema 接受；capture 失败 → `stopReason:'error'` 且 `structured === undefined` |
| T04 | `child-session-persistence` | spawn 子会话持久化（`child-agent.ts` childSessionMeta） | 子会话 header 落盘含 `origin:'subagent'`、`parent_session`、`agentPreset` |
| T05 | `parent-filter-query` | session-query 服务层 `{kind:'parent',values:[null]}` 过滤行为（`session-query/src/types.ts:198`） | 该 filter 只返回根会话；子会话仅显式列名可见 |
| T06 | `standing-preset-singleton` | 插件在 standing mount 下为进程级单例（`agent-presets/src/mount.ts`） | 两个 session 加入同一 preset 时插件实例为同一对象；`WeakMap<Agent,…>` 键控互不串扰 |
| T07 | `storage-update-serial-atomic` | `update(key,fn)` 单进程串行原子（`storage-domain/src/domain.ts:84,89,332`） | 并发 update 不交错、最终态等于串行应用 |
| T08 | `skill-rank-shadowing` | rank 100 胜 200（`skill/src/index.ts:75`） | 同名时 `.dsh/skills/<n>` 胜 `.agents/skills/<n>`，list 只出胜者 |
| T09 | `draft-staging-undiscovered` | 嵌套目录不进发现（`skill-filesystem/src/index.ts:719-747`） | `<root>/.drafts/<n>/SKILL.md` 不出现在 list；`/name` 调用报未知 |
| T10 | `ctx-fs-host-write` | 宿主代码经 `ctx.fs` 写不受工具层 writableRoots 之外限制的精确行为（`fs-sandbox/src/index.ts:10-11` "policy check in TRUSTED code"） | 拼清 ctx.fs 对宿主调用的策略语义并记录（E0-1 关联） |
| T11 | `observer-seam-missing` | 现状：外部包不可达 `observeHostMutation`（无 ctx provide，[核验 S1-7]） | 断言当前包导出面（作为 P2 缝的 before 证据） |
| T12 | `run-result-terminal-states` | 终态枚举与 `structured` 可选性 | aborted/error/max-tokens 各路径的 result 形状快照 |
| T13 | `request-header-bytestable` | `request/header.system` 逐字节含完整 prompt；同文本跨 resume 一致（`invariant.ts:45`、`request-reconstruction.spec.ts:657-660`） | 复用上游既有断言，纳入本套件防回归 |
| T14 | `fail-closed-vocabulary` | 未知事件类型拒绝解释（`known-event-types.ts`） | 构造未知类型日志 → 拒绝；确认无 ignorable 通道 |
| T15 | `tool-result-durable-surface` | skill 工具结果与 `/name` 注入的 durable 形状（`tool-skill/src/index.ts:125,196-203`） | 事件内可提取 `exec.name`、isError、`source.kind==='skill-invocation'` |
| T16 | `catalog-pre-step-timing` | 目录发布在 awaited pre-step 内（`tool-skill/src/index.ts:213-251`） | 时序断言：publisher 模式复刻依据 |
| T17 | `compaction-surface-vs-seq` | compaction 改表面不改 raw seq（`core/session/src/types.ts:357-366`） | replace 后原事件 seq 仍稳定可定位 |
| T18 | `subagent-start-scoped-events` | `subagent/start`/`subagent/end` 事件形状（`subagent/src/index.ts:169-178`） | 派发/终结的事件载荷快照 |
| T19 | `sandbox-writable-roots` | `writableRoots` = workspaceRoot+/tmp（`sandbox/src/roots.ts:52-55`） | dshHome 路径被拒（作为"user 域暂缓"的行为依据） |
| T20 | `storage-domain-open-reject` | version 不匹配拒绝打开（`spec.ts:38`） | 错误码 `version-mismatch` 透传 |
| T21 | `pre-step-waterfall-order` | pre-step 瀑布 await 语义与多插件顺序 | 自定义监听可延迟 step（resume-blocking 闸的依据） |
| T22 | `session-event-observe` | `ctx.on('session/event',…)` 载荷与时机（`agent-instructions/src/index.ts:305` 用法） | turn/end 可观测、含 seq |
| T23 | `run-maintenance-claim` | claim-或-throws + 稍后重试（`runtime-types.ts:102-110`） | busy 时同步抛；空闲后重入成功 |

## 2. E0 待锁项结案流程

总纲 §8 的 7 项，每项在对应 T 中顺带结案并回填本附件（如 T12 结案 E0-3，T07 结案 E0-1）。**结案记录 = 测试断言 + 结论一行**；任何与 RC5.1 假设不符的结案（如 stopReason 联合不同、`get` 不存在）必须先修订总纲/附件签名再进 P1。

## 3. 验收门

- 23 项全绿；E0 七项全部结案并回填；
- 无产品代码、无上游行为变更（`git diff` 仅新增测试与包骨架）；
- Agent Note 一篇：Evidence Lock 结论与任何被修正的方案假设（仓规：非平凡变更同 PR 附 Agent Note）。
