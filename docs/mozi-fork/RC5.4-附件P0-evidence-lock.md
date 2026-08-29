# RC5.4 附件 P0 — Evidence Lock（行为事实钉死，53 活跃 + 2 历史回归）

> 上位：`RC5.4-函数级规格总纲.md`。P0 = **zero behavior change**（允许测试与未来包骨架，不注册生产行为、不改 shipped composition）。
>
> 测试落位：`packages/review/session-review/tests/evidence-lock/*.spec.ts`（本阶段创建该包骨架）。
>
> 相对 RC5.3-P0：T36 期望值改写（S2-6）；T41 改 live 事件（S1-6）；新增 T42–T53（第六轮处置 §4）。
>
> 日期：2026-08-29

## 1. 测试矩阵（T01–T41 承前修订，T42–T53 第六轮新增）

| # | 测试 | 钉死事实 | 通过标准 |
|---|---|---|---|
| T01 | `start-provider-contract` | `start(name,…)` 首参按 provider 解析（`subagent/src/index.ts:552`） | 未知 provider 同步抛错；`'spawn'` 可解析 |
| T02 | `allow-empty-inherited-tools` | `allow:[]` 只移除继承全局工具；scoped 注册与 PTC transport 不受影响（`core/tools/src/index.ts:677-679`） | schema 无业务工具；同名执行被拒；protocol 工具存活 |
| T03 | `output-schema-capture` | `structured` 仅成功 capture 存在（`types.ts:236-252`） | capture 失败 → `stopReason:'error'` 且 `structured===undefined` |
| T04 | `child-session-persistence` | spawn 子会话持久化 | header 落盘含 `origin/parent_session/agentPreset` |
| T05 | `parent-filter-query` | `{kind:'parent',values:[null]}` 只返回根会话（`session-query/src/types.ts:198`） | 子会话仅显式列名可见 |
| T06 | `standing-preset-singleton` | standing mount 插件为进程级单例（`agent-presets/src/mount.ts`） | 跨 session 同实例 |
| T07 | `storage-update-serial-atomic` | `update` 单进程串行原子（`domain.ts:84,89,332`） | 并发不交错，终态=串行应用 |
| T08 | `skill-rank-shadowing` | rank 100 胜 200——仅同层内（`skill/src/index.ts:75,807-811`） | 同层同名只出胜者 |
| T09 | **[历史回归]** `staged-root-undiscovered` | 嵌套 staged/revision 目录不进 stock discovery | `.dsh/self-evolution/…` 不出现在 stock list |
| T10 | `ctx-fs-host-write` | 宿主经 `ctx.fs` 写的策略语义（`fs-sandbox/src/index.ts:10-11`） | 行为记录归档 |
| T11 | **[历史回归]** `observer-seam-absent` | 被拒设计的 before 证据 | 导出面断言 |
| T12 | `run-result-terminal-states` | 终态枚举 + `structured` 可选 | 各终态 result 形状快照 |
| T13 | `request-header-bytestable` | header.system 逐字节 + 跨 resume 一致（`invariant.ts:45`） | 复用上游断言 |
| T14 | `fail-closed-vocabulary` | 未知事件类型拒绝（`known-event-types.ts`） | 无 ignorable 通道 |
| T15 | `tool-result-durable-surface` | durable `tool/result` 可提取 `exec.name`/`isError`/`source.kind`；**无 canonical value/provider**（`tool-skill/src/index.ts:125,148-155,196`） | durable 载荷字段快照（S1-6 before 证据） |
| T16 | `catalog-pre-step-timing` | 目录发布在 awaited pre-step（`tool-skill/src/index.ts:213-251`） | 时序断言 |
| T17 | `compaction-surface-vs-seq` | compaction 改表面不改 seq（`types.ts:357-366`） | replace 后 seq 稳定 |
| T18 | `subagent-start-scoped-events` | `subagent/start\|end` 载荷 | 载荷快照 |
| T19 | `sandbox-writable-roots` | 可写根 = workspaceRoot+/tmp（`sandbox/src/roots.ts:52-55`） | dshHome 拒绝 |
| T20 | `storage-domain-open-reject` | version 不匹配拒绝（`spec.ts:38`） | `version-mismatch` 透传 |
| T21 | `pre-step-waterfall-order` | pre-step awaited 瀑布语义 | 监听可延迟 step |
| T22 | `session-event-observe` | `session/event` 载荷与时机 | turn/end 可观测、含 seq |
| T23 | `run-maintenance-claim` | claim-或-throws（`runtime-types.ts:102-110`） | busy 抛、空闲重入成功 |
| T24 | `storage-update-missing-key-first-record` | `update` 缺 key 抛 `missing-key`；`put` 是覆盖写无 compare-and-put | 初始化协议 = get→put(empty)→update；Store 原型通过 |
| T25 | `ctx-fs-no-move-contract` | `FileSystem` 12 原语无 rename/move/delete/copy（`fs/src/index.ts:86-256`） | 类型层断言 + 文档记录 |
| T26 | `provider-control-invalidate` | `control.invalidate()` 后下一次 list/get 见新状态（`skill/src/index.ts:271-275,391-400`） | 注册→变更→invalidate→可见 |
| T27 | `flat-and-frontmatter-collision` | flat `.md` candidate name 来自 frontmatter（`skill-filesystem/src/index.ts:800-829`） | frontmatter 名冲突可检出 |
| T28 | `truncation-contiguous-high-water` | 预算分片连续性 | oldest-first 切片：effectiveThrough 前无跳段 |
| T29 | `cursor-acquired-busy` | claim 原子：acquired/busy/nothing-due + desiredThrough=max | 并发恰一 acquired；due 不丢 |
| T30 | `blocking-order-publisher-sees-commit` | commit → publisher 见新 state → 首请求含新 snapshot | 端到端顺序 |
| T31 | `background-cancellation-recoverable` | dispose 语义（`types.ts:263-268`） | 取消后 inFlight 可结算（T39） |
| T32 | `assistant-final-derivation` | `assistant/message` 无 final 标志（`types.ts:262`） | turn fold 只投影末条 |
| T33 | `managed-provider-catalog-visibility` | 同层内 rank 700 败于人工 100-600；active 才出 catalog | 同层同名人工胜；draft/archived 不出目录 |
| T34 | `managed-provider-interface-contract` | 真实 `SkillProvider` 契约（`skill/src/index.ts:248-268`） | 原型过 `validateCandidate` 全套；locator 钉 revision；signal 中止 |
| T35 | `managed-provider-project-isolation` | projectKey 进 record/locator/storage key；list 按 cwd 过滤 | A 不在 B 可见；candidate 失配 → get undefined |
| T36 | `cross-layer-shadowing-rank-does-not-protect` | 最近层恒胜，与人/managed 无关（`skill/src/index.ts:352-354,552-556`） | **钉死三向**：global human + scoped managed → **scoped managed 胜**；scoped human + global managed → scoped human 胜；同层 → 低 rank 胜。REAL 组合枚举 shipped 各来源层与 winner |
| T37 | `managed-name-reservation-concurrent` | NameIndex 单 RMW 原子占位；确定性 skillId | 并发同名恰一占位；余者 `name_conflict`；crash 占位 reconcile 释放 |
| T38 | `managed-external-edit-digest-reject` | body verbatim trusted（`skill/src/index.ts:162-184`） | get 时 digest 失配 → undefined + invalidate + 告警；正文/support 均检出 |
| T39 | `cancel-settles-inflight-same-process` | dispose 后宿主 saga 存活（`types.ts:263-268`） | planning 取消清 inFlight；planned 转 resumable 续 plan；前台等待有界 |
| T40 | `planned-attempt-id-replan` | RangeId/AttemptId 分离；attempts append-only | replan 新 attemptId；旧 planned 永不覆盖；recovery 取最新有效 |
| T41 | `skill-live-result-provider-attribution` | live `tools/result` 是 lossless final outcome（`core/tools/src/index.ts:193-198,1662-1665`）；durable 无 provider（T15） | live 监听原型：仅 `result.value.provider === 'self-evolution-managed'` 计 managed；human 胜出不误计 |
| **T42** | `memory-service-single-registration` | Service 同名重复注册抛错（`service.ts:37-53`；`reflect.ts:272-285`） | 单 `MemoryService` 双逻辑 scope 可用；第二实例注册失败即暴露 |
| **T43** | `memory-composite-snapshot-no-cross-scope-churn` | `snapshot` 同 producer 顶替（`message.ts:52`） | 单 publisher 一条消息双节；combined digest 变更检测；project 变更不产生第二条 user 消息 |
| **T44** | `managed-domain-opened-exactly-once` | 域单开（`storage-domain/src/index.ts:66-95`） | Service 唯一 opener；provider/工具经 Service 消费；双 open 即 `already-open` |
| **T45** | `project-key-uses-fs-target-identity` | `resolve()` 同文件同 `targetKey`（`fs/fs/src/index.ts:100-118`）；key 禁解析（`types.ts:8-15`） | 别名/符号链接同根 → 同 ProjectKey；hash 整键、不拼路径 |
| **T46** | `managed-catalog-sidecar-not-file-trust` | catalog 每 pre-step 进 durable 消息（`tool-skill/src/index.ts:219-250`） | list 只读 sidecar；篡改 revision frontmatter description 不影响 catalog；get 才校验 bundle |
| **T47** | `name-index-first-record-initialization` | 首项目首技能：ensureNameIndex（T24 协议） | 全新 project reserve 成功；并发 first-reserve 恰一成功 |
| **T48** | `rejected-draft-can-be-reopened` | rejected 专属用户拒绝 | draft→rejected→reopen→draft 全链；NameIndex 身份保持；rejected 不出 provider |
| **T49** | `active-patch-stays-pending-until-approve` | active patch 只进 pendingRevision | currentRevision 不变、catalog 不变；approve 切 pointer；reject-pending 清 pending 计 orphan |
| **T50** | `attempt-id-does-not-require-preclaim-base-state` | attemptId=hash(rangeId,attemptNo) 可在 claim 时算出 | claim 写 inFlight 无循环依赖；baseStateDigest 事后回填字段 |
| **T51** | `consolidation-failure-keeps-whole-attempt-zero-commit` | consolidation 是新 whole attempt | budget_exceeded → 零 commit；新 attempt 重走 admission；仍败 → terminal 零 commit；skill op 不被"顺带"提交 |
| **T52** | `nonterminal-op-receipt-never-evicted` | pending/recentTerminal 二分 | non-terminal attempt 的 op receipt 在任意多新 mutation 后仍在；ack 后入环可淘汰；ack 早于 terminal fail-loud |
| **T53** | `user-target-backstop-l1` | L1 scope backstop（S2-4） | `target:'user'` proposal 记录 + 整 plan zero commit + `target_scope_disabled`；不写 project、不静默 |

## 2. Hermes 参考锚点（本地 clone `05c248d8`，2026-08-29）

| 锚点 | file:line | 借用的机制 |
|---|---|---|
| H-MEMORY | `tools/memory_tool.py:174,214` | consolidation 失败上限；超限停试继续回复 |
| H-BG-REVIEW | `agent/background_review.py:42,89,112,179` | 前台抢占 handshake（token + ack + 有界等待） |
| H-BG-REVIEW-PROMPTS | `agent/background_review.py:473,601-611` | memory no-op 中性（好）；skill action bias（反模式） |
| H-SKILL-MANAGER | `tools/skill_manager_tool.py:294-303` | `_pinned_guard` fail-closed 禁写 |
| H-SKILLS-GUARD | `tools/skills_guard.py:70-81` | 类别 × severity 矩阵（`guard_agent_created` 默认关，不沿用） |
| H-WRITE-APPROVAL | `tools/write_approval.py:110-170,226-258` | durable pending；skills always stage（含 patch）——RC5.4 pendingRevision 同构 |

## 3. E0 结案流程

总纲 §7 的 12 项随对应 T 结案回填（T42→E0 双面注入形态关联、T41→E0-11、T45→E0-7/12、T34→E0-8 等）。结案与 RC5.4 假设不符时，先修订总纲/附件签名再进 P1。

## 4. 验收门

53 项活跃全绿（2 项历史回归记录在案）；E0 全结案回填；`git diff` 仅新增测试与包骨架（zero behavior change）；Agent Note 记录结论与被修正假设（含 T36 期望值改写、T15/T41 durable-vs-live 对照）。
