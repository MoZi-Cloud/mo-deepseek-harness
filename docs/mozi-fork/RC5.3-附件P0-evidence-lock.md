# RC5.3 附件 P0 — Evidence Lock（行为事实钉死，41 活跃 + 2 历史回归）

> 上位：`RC5.3-函数级规格总纲.md`。P0 = **zero behavior change**（允许测试与未来包骨架，不注册生产行为、不改 shipped composition）。
>
> 测试落位：`packages/review/session-review/tests/evidence-lock/*.spec.ts`（本阶段创建该包骨架）。
>
> 相对 RC5.2-P0：T09/T11 移入历史回归区（被拒设计，S2-8）；新增 T34–T41（第五轮处置 §4）；T33 措辞修正（rank 仅同层）。
>
> 日期：2026-08-29

## 1. 测试矩阵（T01–T33 承前，T34–T41 第五轮新增）

| # | 测试 | 钉死事实 | 通过标准 |
|---|---|---|---|
| T01 | `start-provider-contract` | `start(name,…)` 首参按 provider 解析（`subagent/src/index.ts:552`） | 未知 provider 同步抛错；`'spawn'` 可解析 |
| T02 | `allow-empty-inherited-tools` | `allow:[]` 只移除继承全局工具；scoped 注册与 PTC transport 不受影响（`core/tools/src/index.ts:677-679`） | schema 无业务工具；同名执行被拒；protocol 工具存活 |
| T03 | `output-schema-capture` | `structured` 仅成功 capture 存在（`types.ts:236-252`） | capture 失败 → `stopReason:'error'` 且 `structured===undefined` |
| T04 | `child-session-persistence` | spawn 子会话持久化（childSessionMeta） | header 落盘含 `origin/parent_session/agentPreset` |
| T05 | `parent-filter-query` | `{kind:'parent',values:[null]}` 只返回根会话（`session-query/src/types.ts:198`） | 子会话仅显式列名可见 |
| T06 | `standing-preset-singleton` | standing mount 插件为进程级单例（`agent-presets/src/mount.ts`） | 跨 session 同实例；`WeakMap<Agent,…>` 键控隔离 |
| T07 | `storage-update-serial-atomic` | `update` 单进程串行原子（`domain.ts:84,89,332`） | 并发不交错，终态=串行应用 |
| T08 | `skill-rank-shadowing` | rank 100 胜 200——**仅同层内**（`skill/src/index.ts:75,807-811`） | 同层同名只出胜者 |
| T09 | **[历史回归]** `staged-root-undiscovered` | 原 `.drafts` 架构证据；保留为回归：staged/revision 嵌套目录不进 stock discovery（`skill-filesystem/src/index.ts:719-747`） | `.dsh/self-evolution/…` 嵌套 SKILL.md 不出现在 stock list |
| T10 | `ctx-fs-host-write` | 宿主经 `ctx.fs` 写的策略语义（`fs-sandbox/src/index.ts:10-11`） | 行为记录归档 |
| T11 | **[历史回归]** `observer-seam-absent` | 被拒设计（ctx.skillMutationObserver）的 before 证据；仅断言现无该缝，不作为任何活架构依据 | 导出面断言 |
| T12 | `run-result-terminal-states` | 终态枚举 + `structured` 可选 | 各终态 result 形状快照 |
| T13 | `request-header-bytestable` | header.system 逐字节 + 跨 resume 一致（`invariant.ts:45`） | 复用上游断言防回归 |
| T14 | `fail-closed-vocabulary` | 未知事件类型拒绝（`known-event-types.ts`） | 无 ignorable 通道 |
| T15 | `tool-result-durable-surface` | skill 工具结果/`/name` 注入 durable 形状（`tool-skill/src/index.ts:125,148-155,196-203`） | 可提取 `exec.name`/`result.provider`/isError/`source.kind` |
| T16 | `catalog-pre-step-timing` | 目录发布在 awaited pre-step（`tool-skill/src/index.ts:213-251`） | 时序断言 |
| T17 | `compaction-surface-vs-seq` | compaction 改表面不改 seq（`types.ts:357-366`） | replace 后 seq 稳定 |
| T18 | `subagent-start-scoped-events` | `subagent/start\|end` 载荷（`subagent/src/index.ts:169-178`） | 载荷快照 |
| T19 | `sandbox-writable-roots` | 可写根 = workspaceRoot+/tmp（`sandbox/src/roots.ts:52-55`） | dshHome 拒绝 |
| T20 | `storage-domain-open-reject` | version 不匹配拒绝（`spec.ts:38`） | `version-mismatch` 透传 |
| T21 | `pre-step-waterfall-order` | pre-step awaited 瀑布语义 | 监听可延迟 step |
| T22 | `session-event-observe` | `session/event` 载荷与时机 | turn/end 可观测、含 seq |
| T23 | `run-maintenance-claim` | claim-或-throws（`runtime-types.ts:102-110`） | busy 抛、空闲重入成功 |
| T24 | `storage-update-missing-key-first-record` | `update` 缺 key 抛 `missing-key`（`domain.ts:334-338`）；`put` 是覆盖写无 compare-and-put | 首录走初始化协议；占位走 update RMW；Store `ensureInitialized` 原型通过 |
| T25 | `ctx-fs-no-move-contract` | `FileSystem` 12 原语无 rename/move/delete/copy（`fs/src/index.ts:86-256`） | 类型层断言 + 文档记录 |
| T26 | `provider-control-invalidate` | 自定义 Provider `control.invalidate()` 后下一次 `list()/get()` 见新状态（`skill/src/index.ts:271-275,391-400`） | 注册→变更→invalidate→可见 全链 |
| T27 | `flat-and-frontmatter-collision` | 发现接受 `<root>/<f>.md` 且 candidate name 来自 frontmatter `name`（`skill-filesystem/src/index.ts:800-829`） | flat 文件 frontmatter 名冲突可检出 |
| T28 | `truncation-contiguous-high-water` | 预算分片连续性设计约束 | oldest-first 切片原型：effectiveThrough 前无跳段 |
| T29 | `cursor-acquired-busy` | claim 原子语义：acquired/busy/nothing-due + desiredThrough=max | 并发 claim 恰一个 acquired；due 不丢 |
| T30 | `blocking-order-publisher-sees-commit` | blocking 复盘 commit → publisher pre-step 见新 state → 首请求含新 snapshot | 端到端顺序断言 |
| T31 | `background-cancellation-recoverable` | foreground 可取消在飞后台工作（`SubagentRun.dispose`，`types.ts:263-268`） | 取消后 inFlight 可结算（见 T39），恢复重放安全 |
| T32 | `assistant-final-derivation` | `assistant/message` 无 final 标志（`types.ts:262`），turn fold 可推导末条 outcome | 多 step 工具循环只投影末条 |
| T33 | `managed-provider-catalog-visibility` | 自定义 provider rank 生效——**同层内** rank 700 败于人工 rank 100-600（`skill/src/index.ts:807-811`）；active 才出 catalog | 同层同名人工胜；draft/archived 不出目录 |
| **T34** | `managed-provider-interface-contract` | `SkillProvider` 真实契约：`list(options)` 返回 candidates/observation、`get(candidate, options)` 只收 list 产生过的 candidate（`skill/src/index.ts:248-268`） | 原型 provider 过 `validateCandidate` 全套；locator 钉 revision；signal 中止生效 |
| **T35** | `managed-provider-project-isolation` | projectKey 进 record/locator/storage key；list 按 `options.cwd` 过滤（`skill/src/index.ts:528,644-646`；`tool-skill/src/index.ts:133` cwd 传递） | project A 技能不在 project B 可见；candidate.projectKey 失配 → get 返回 undefined |
| **T36** | `cross-layer-shadowing-rank-does-not-protect` | 最近层直接赢、rank 仅同层比较（`skill/src/index.ts:352-354,552-556`） | 三钉：global human + scoped managed → human 胜？反向亦钉；REAL 组合枚举 shipped 各来源所在层 |
| **T37** | `managed-name-reservation-concurrent` | NameIndex 单 `update` RMW 原子占位；确定性 `skillId = hash(projectKey, normalizedName)` | 并发同名 create 恰一个占位成功；另一 create 得 `name_conflict`；crash 占位残留由 reconcile 释放 |
| **T38** | `managed-external-edit-digest-reject` | skill body verbatim 进 `<skill_instructions>`（trusted local content，`skill/src/index.ts:162-184`） | get 时 bundle digest 失配 → undefined + invalidate + 告警；篡改正文/support 文件均检出 |
| **T39** | `cancel-settles-inflight-same-process` | dispose 后宿主侧 saga 存活可结算（`types.ts:263-268`） | planning 取消 → inFlight 清除、下一 turn 可 claim；planned 取消 → resumable 续 stored plan 不重问模型；前台等待有界 |
| **T40** | `planned-attempt-id-replan` | `ReviewRangeId` 与 `ReviewAttemptId` 分离；attempts append-only | stale replan 产生新 attemptId；旧 planned attempt 永不覆盖；recovery 取最新有效 attempt |
| **T41** | `skill-tool-provider-attribution` | 工具结果带 `provider`、`/name` source 不带（`tool-skill/src/index.ts:148-155,196`） | observer 原型仅 `provider==='self-evolution-managed'` 计 managed；同名 human 胜出时不误计 |

## 2. Hermes 参考锚点（S2-10；本地 clone `05c248d8`，2026-08-29）

| 锚点 | file:line | 借用的机制 |
|---|---|---|
| H-MEMORY | `tools/memory_tool.py:174,214` | consolidation 失败上限 3 次；超限停试、保持 memory、继续用户回复 |
| H-BG-REVIEW | `agent/background_review.py:42,89,112,179` | run token + `request_done` acknowledgement + 有界等待的前台抢占 handshake |
| H-BG-REVIEW-PROMPTS | `agent/background_review.py:473,601-611` | memory "Nothing to save."（好）；skill 侧 no-op 压制（反模式，不学） |
| H-SKILL-MANAGER | `tools/skill_manager_tool.py:294-303` | `_pinned_guard`；external/bundled/非 managed fail-closed 禁写 |
| H-SKILLS-GUARD | `tools/skills_guard.py:70-81` | 类别 × severity 矩阵；`guard_agent_created` 默认关——本 fork 不沿用该默认 |
| H-WRITE-APPROVAL | `tools/write_approval.py:110-170` | durable pending store（stage/list/get；本 fork 首版不复制，L2） |

## 3. E0 结案流程

总纲 §7 的 10 项随对应 T 结案回填（T07→E0-1、T12→E0-3、T22→E0-4、T34→E0-8、T26→E0-8 关联等）。结案与 RC5.3 假设不符时，先修订总纲/附件签名再进 P1。

## 4. 验收门

41 项活跃全绿（2 项历史回归记录在案）；E0 全结案回填；`git diff` 仅新增测试与包骨架（zero behavior change）；Agent Note 一篇记录结论与被修正的假设（含撤回的 rank 断言）。
