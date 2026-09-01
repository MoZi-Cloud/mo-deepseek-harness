# 自我进化机制方案 RC5.5.3（第九轮协议闭合与拓扑重排）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 版本脉络：RC5.5.2 → `第九轮评审建议.md` 证据复核版 → `RC5.5.3-第九轮评审核验与处置.md` → 本 RC5.5.3。第九轮初评中被复核撤回的 requestDigest、自引用、当前跨 LLM provider 与 release-before-finalized 结论不进入本版。
>
> 函数级规格：`RC5.5-函数级规格总纲.md` + 附件 P0–P5；文件名保持稳定，内容原位升版，避免并存两套权威规格。
>
> 证据基线：DeepSeek Harness `16bd8323def3178fb6c21e008e9e2c28d2458896`；mozi-hermes-agent `05c248d8a6c7f6d0d26efbb35fba3d6dfeb36a06`；日期：2026-09-01。
>
> 阶段裁定：RC5.5.3 = **Architecture Frozen / Implementation Approved**。P1 已提交的纯函数层保留，但 Service 前先完成 RC5.5.3 对齐批；P2 先叶子函数后 mutation/tool；P3 必须按 canonicalization → admission → durable stores → finalization → live/history orchestration 的拓扑开发；P4 after P3；P5 质量门通过前保持 shadow。

## 0. RC5.5.3 的问题闭合

1. **direct operation 身份与 receipt**：review op 由 attempt/plan 派生并先入 pending；前台 `skill_manage` 与 memory 治理分别由 durable `ToolCallId`/`CommandId` 派生 op id，并在资源提交的同一 RMW 中直接进入 bounded terminal ring。P1/P2 不导入 P3。
2. **planner 隔离与非递归**：review provider 必须支持 `toolFilter/outputSchema/persona/agentOptions`、必须 `inheritsParentContext=false`；请求固定 `toolFilter:{allow:[]}`；只有 root session 可触发。spawn 仍继承 standing composition，本版以真实请求 snapshot 和 Host evidence admission 约束它，不声称绝对空白上下文。
3. **finalization 最后崩溃点**：定序为 mark terminal → apply cursor disposition → mark finalized → assign/index stable outcome ordinal → acknowledge finalized receipts → release cursor；review receipt 在 ledger finalized 前仍处 pending 且不淘汰，启动先修复 unfinalized terminal、缺 ordinal/index 与 finalized+occupied，之后才允许 claim。
4. **memory 精确定位**：update/remove 计划和 Host op 必须携 `targetEntryId/expectedEntryDigest`；`targetHint` 只作说明，不参与选择。
5. **结果证据**：Host 从 durable events 提取 user-authored、tool-success、tool-failure、failure-recovered、unresolved、unknown 等结构信号；turn completed 与 assistant 自称成功均不是任务成功。unresolved 经验不得进入可见 memory/skill。
6. **计划身份协议**：P3 独占 versioned `canonicalPlanOpDigest` 与固定 `enumeratePlanOps`；P1 执行结果摘要改名 `memoryResultDigest`。
7. **重试真相进入 claim**：pre-plan blockedUntil、retry/supersede/manual 与 stored-plan resume gate 持久化在 cursor lane；`ReviewClaimCoordinator` 串行调用 `claimDue(now)`，不能由下一 turn 或历史扫描绕过。确定性 evidence/policy/scan/quota 拒绝以 rejected noChange consumed 并进质量评分；pre-plan 瞬态失败新 attempt retry，plan 落盘后的瞬态失败以同一 attempt/op ids resume。
8. **存储预算蕴含发布预算**：P1 load-time 证明最坏 admitted state 包含 header、id 前缀、围栏、换行及全部启用 scope 后仍可发布；确定性预算矛盾不是 publisher 的正常 fail-open。
9. **冷历史批处理**：P3 改为唯一 host 级 Service；使用 `sessionQuery.listSessions/observeSession`、持久化 scan checkpoint 与 `agents.resume` 枚举 cold root sessions，和实时路径共用 per-session claim。
10. **memory 纠错治理**：Conservative L1 提供 list/show/correct/remove；纠错与删除走 exact digest、direct-terminal receipt，下一 snapshot 不再包含旧内容。是否对全部 inference 做 pending approval 留给 rollout policy，不误写成 Hermes 默认。
11. **scanner 覆盖**：P1/P2 配置必须令一个模型可见文本单元不超过 `MAX_SCAN_CHARS`；skill 每个可见文本文件整文件扫描。
12. **curator 可达状态机**：model load 不等于 verified reuse；user load 持久化 winning provider，top-level model tool 以同条 durable result meta 绑定 provider 与 rendered-content digest；nested PTC 结果不直接进入模型，不计 model load。observer gap 把完整 inactivity 窗口重置到恢复时，而非永久冻结或把 gap 当零；P4 以 ReviewAttempt 上稳定递增的 outcome ordinal 分页，避免 late finalization 漏记和随机 AttemptId 循环扫描的无限去重集；archived 只经用户 restore。
13. **可执行 P5**：固定七类 fixture、baseline/held-out、阈值、失败动作与报告；rollout level 参与 cursor lane identity，shadow proposal 永不直接提升，L1 新 lane 重审历史。
14. **provenance 权威**：review 以永不删除、状态单调且 plan 落定后不可变的 ReviewAttempt 为真相，direct memory 以同样单调保留的 GovernanceOperation 为真相，direct skill tool 以 immutable revision lineage 为真相；op index 是可重建投影，receipt 只负责 replay 去重。
15. **user principal**：`MemoryScope.user` 现在必须携 branded `UserKey`；L2 没有 principal 时 fail-loud，不再保留进程全局 user record。
16. **非 Git identity**：nearest `.git` 未命中时仍按 cwd；这是已声明限制，不假设仓库里不存在的 WorkspaceId。
17. **pending receipt 有界背压**：required `maxConcurrentReviews × maxPlanOps` 给 review pending 数量硬上界；durable inFlight 占用在重启后重建，cleanup 未收敛时禁止新 acquired，但不阻断正常 Agent。
18. **孤儿 revision 数量背压**：P2 除 orphan bytes 外还限制每项目 incomplete+orphan revision count；零字节 partial 也计数，避免“不物理删除”被无限空目录绕过。
19. **usage 重放有界且不重复**：P4 分别以 durable session seq、P2 bounded revision lineage 与 P3 outcome ordinal 扫描；page 结算持有 source mutex，recent receipt 窗口必须覆盖任一整页，避免 crash-before-checkpoint 后重复计数或永久保存所有 signal id。

## 1. 第一原则

1. Everything is a plugin, but not every role is a package.
2. LLM proposes; Host commits.
3. Dynamic model-visible state is replay-authoritative；进入模型请求的动态内容必须能从 durable session 重建。
4. Model text never owns authority metadata；id、scope、clock、base revision、digest、receipt mode 与 lifecycle actor 均由 Host 构造。
5. Trigger at least once；资源提交幂等；仍可能恢复的 op receipt 不得淘汰。
6. Project autonomous domain first；L1 只写 project，user scope 等待 principal。
7. Learning requires admissible evidence and admissible outcome；引用存在只是必要条件。
8. Managed output 在每个模型可见读入口完成 digest、结构和内容检查前不可信。
9. Visibility is a separate commit；resource write、governance approval 与 model publication 是不同步骤。

## 2. 数据模型

```text
ProjectKey                 = Branded<'ProjectKey'> = hash(ctx.fs.resolve(projectRoot).targetKey)
UserKey                    = Branded<'UserKey'>，仅由未来 principal provider 给出；RC5.5.3 不生成默认值
MemoryScope                = {kind:'project', projectKey} | {kind:'user', userKey}
OpId                       = Branded<'OpId'>；各包可声明同一 brand，不建立反向 package dependency
ReviewOperationOrigin      = {kind:'review', opId}
DirectMemoryOrigin         = {kind:'direct-command', opId, sessionId, commandId}

MemoryEntry                = {id, content, kind, evidence, createdAt, updatedAt,
                              createdByOpId, lastAppliedOpId}
MemoryEntryDigest          = canonical digest of the exact current entry record
HostMemoryOp               = add{opId,entryId,now,content,...}
                            | update/remove{opId,entryId,expectedEntryDigest,now,...}
MemoryState                = {schemaVersion, revision, entries,
                              appliedOps:{pendingReceipts,recentTerminalReceipts}}

ManagedSkillRef            = {projectKey, skillId}
ManagedRevisionId          = hash(skillId, requestedByOpId)
ManagedMutationOrigin      = {kind:'review',opId} |
                             {kind:'direct-tool',opId,sessionId,callId}
ManagedSkillRecord         = {projectKey,skillId,name,owner,state,currentRevision,contentDigest,
                              catalogSummary,pendingRevision?,appliedOps,revisionLineage,
                              pinned,lifecycle anchors}
NameReservation            = {skillId,reservedByOpId}

ReviewCursorLaneId         = hash(sessionId, policyVersion, learningViewVersion, rolloutLevel)
ReviewCursorLane           = {reviewedThroughSeq,desiredThroughSeq,
                              inFlight?:{attemptId,resumeRetryCount,resumeBlockedUntil?},nextAttemptNo,
                              retryCountSinceAdvance,supersedeCountSinceAdvance,
                              blockedUntil?,manualHold?}
ReviewRangeId              = hash(laneId,fromExclusive,throughInclusive)
ReviewAttemptId            = hash(rangeId,attemptNo)
ReviewAttempt              = retained monotonic {attemptId,range,opIdentityVersion,status,effectiveThrough,
                              immutablePlan?,planDigest?,baseRevisions?,opStates[],outcomes,
                              rangeDisposition?,finalized?,failure?}
ReviewOpState              = {opId,resource,resourceRef,state:prepared|applied|duplicate|failed}
RangeDisposition           = consumed | superseded | retryable | manual

ReviewPlan.memory          = add{target,content,kind,evidence,...}
                            | update{target,targetEntryId,expectedEntryDigest,content,kind,evidence,...}
                            | remove{target,targetEntryId,expectedEntryDigest,evidence,...}
ReviewPlan.skills          = create-draft | patch-draft（patch 携 exact ref/revision/digest）
OutcomeSignal              = user-authored | tool-success | tool-failure | failure-recovered
                            | unresolved | transient | unknown
HistoricalScanCheckpoint   = {cycle, after?:{createdAt,sessionId}, notBefore?}
```

`REVIEW_OP_IDENTITY_VERSION = 1` 是协议常量，不是部署 tunable。`enumeratePlanOps` 固定先 memory、后 skills，各数组保持模型输出顺序，`stableOpIndex` 是合并序列的零基索引；canonical digest 编码完整 validated plan op 与 identity version，排除 Host 后加的 opId/entryId/clock/resolved ref。

## 3. 包、角色与挂载

| 包 | 角色 | 挂载 |
|---|---|---|
| `packages/util/content-scan` | `scanContent`、pattern/version/cap 常量 | 纯工具包 |
| `packages/memory/memory` | 唯一 `MemoryService`、composite `MemoryPublisher`、memory 纯函数 | host composition，一次 |
| `packages/skill/skill-managed` | 唯一 `ManagedSkillService`、Provider/Store/Authoring；named `skill_manage` | Service/provider 在 host；tool 在 authoring preset |
| `packages/review/session-review` | 唯一 `SessionReviewService`、cursor/ledger、live scheduler、historical coordinator、governance commands | **host composition，一次**；不再按 session 重复挂载 |
| `packages/skill/skill-curator` + 既有 `skill`/`tool-skill` source 小扩展 | durable invocation provider、usage coverage、状态机、maintenance、指标投影 | host composition，一次 |
| P5 eval surface | fixture manifest、runner、score/gate/report | 无 runtime package；进入 repository gate |

`tool-session-query` 模型工具仍默认 root-only，`ctx.sessionQuery` Host 服务不改。P3 的历史枚举直接使用 Host `listSessions/observeSession`，不通过模型工具。

## 4. 运行链

```text
live root trigger ─┐
                   ├─ isReviewEligibleSession ── ReviewClaimCoordinator ── claimDue(cursor lane)
cold-root scan ────┘                                  │
                                                     v
                                    projectEvents + classifyOutcomeSignals
                                                     │
                                                     v
                                      tool-free fresh ReviewPlanner
                                                     │
                                                     v
                         persist immutable plan → enumerate/canonicalize/derive op ids
                                                     │
                                                     v
                 exact targets + evidence/outcome + policy + read-only whole-plan preflight
                                       │                             │
                                       v                             v
                         MemoryService.previewOps   ManagedSkillService.preflightMutations
                                       │                             │
                                       └──── zero write until all admit ────┘
                                                     │
                                                     v
                               MemoryService                 ManagedSkillService
                               pending review receipt        pending review receipt
                                       └────────── saga opStates ──────────┘
                                                     │
                                                     v
    markTerminal → cursor disposition → markFinalized → outcome ordinal/index → finalized ack → release
                                                     │
                                                     v
                          next pre-step memory snapshot / user skill approval and catalog
```

Review child 的工具目录为空且执行也被拒；它没有父 conversation seed。继承的 standing prompt、host context publisher 与 current resource summaries 均不拥有 evidence authority。Host 只接受 `LearningView` 中可定位的 durable seq/span 和 outcome signal。

`tool-success` 只证明 execution 非 error：它可支持 project fact 或仍不可见的 managed skill draft，不能单独让 procedure/caution memory 上线。Host recovery 只配对同 root turn、同 invocation fingerprint（工具名 + canonical durable arguments）的失败与 later success；同为 generic shell 但参数不同不算。可见 procedure、recovery 与 caution 需要明确 user correction 或该结构 recovery；参数改变的 repair sequence 只能先形成隐藏 draft。unresolved/transient/assistant-only 一律零可见 mutation。

## 5. finalization、retry 与恢复

`consumed` 仅用于 committed、planner empty noChange、确定性 admission rejected noChange 或用户显式 skip；确定性 rejection 保留 machine code 并进入 P5 false-proposal 计分。在 immutable plan 和任何 resource write 之前，typed stale/可缩小 plan budget 是 `superseded`，typed 瞬态/provider/planner failure 是 terminal `retryable`，下一 attempt 受 persisted backoff/cap。plan 落盘后的瞬态失败不 terminal，而是在同一 inFlight 写 `resumeBlockedUntil/resumeRetryCount`，到期以 stored plan/op ids 续跑；已有 op applied 后出现 stale 或 invariant failure 转 manual，不能重规划掩盖部分提交。未知或不可能的 phase/code 组合 fail-loud/manual，不解析错误文字猜测瞬态。`manual` 只有用户 `/learning retry|skip` 可释放；下一 turn 不能自动重领。

只有 terminal decision 才进入六步 durable protocol：`markTerminal` → `applyCursorDisposition` → `markFinalized` → `ensureFinalizedOutcomeIndexed` → 只对 applied/duplicate opState 调 `acknowledgeFinalizedOps` → `releaseAttempt`。ordinal 由 ledger durable counter 分配并单调写入 ReviewAttempt；counter 先写的崩溃只留下 gap，已分配 ordinal 永不改变，查询索引可从 attempt 重建。在 `markFinalized` 之前 review receipt 不离开 pending，因而不会被 terminal ring 淘汰；在 outcome 已可分页发现且 cleanup 成功前 cursor 不 release。每次启动和每次新 acquired 前先 `reconcileReviewState`：unfinalized terminal 重放 disposition/mark；finalized attempt 补 ordinal/index；finalized+occupied 重放 cleanup 后 release，绝不 resume；planned/committing 按 resume gate 续同一 attempt。host 协调器以 durable occupied lane 数限制 `maxConcurrentReviews`，plan schema 限制 `maxPlanOps`；index/cleanup 未收敛时关闭新 acquired，因此 pending 不淘汰也有硬上界，正常前台 Agent 仍继续。

## 6. 历史会话与 rollout

HistoricalReviewCoordinator 稳定枚举授权的 persisted root sessions，过滤 child、无 cwd、禁用 session、时间/项目范围与当前 preset；每处理一项后更新 checkpoint。冷 session 用 all-projections observation 读取最新 `agentPreset`，以 `agents.resume(setup: presets.mount(...))` 恢复，review 到 observation cursor 后释放 handle。若 session 已 live，直接使用 live Agent；两条路径最终都由同一 cursor RMW 决胜。

cursor lane identity 包含 rollout level。shadow lane 可以 advance 自己的 high-water，但 proposal 永远是 audit-only；升级 conservative 产生新 lane，由实时触发和历史 coordinator 重审，不修改旧 lane、不直接提交 shadow plan。P5 gate 失败保持 shadow，成功也只授权 composition/config 切换，不绕过新 lane admission。

## 7. 治理与 provenance

L1 memory 命令提供 list/show/correct/remove；skill 命令提供 list/show/approve/reject/reopen/restore；review 命令提供 retry/skip/enable/disable。命令处理器使用已写入 `command/run` 的 `CommandId`，模型工具不拥有治理动作。

ReviewAttempt immutable plan 与 opStates 是 review provenance authority；GovernanceOperation 是 direct memory command authority；P2 record 中与 revision 成功 CAS 同笔写入的 immutable lineage 是 direct skill tool authority。`opId → source/resourceRef` 索引是派生缓存：先写 authority，索引后写；启动扫描 attempts、governance operations 与 skill lineage 补缺，冲突 fail-loud。Memory current entry 以 opId 链接来源；skill revision/pending 以 createdByOpId 链接。receipt ring 淘汰不得破坏 show/history。

## 8. Phase 与开发顺序

1. **P0**：现有 68 项 Evidence Lock 保持为 test-tree 历史记录；T69–T86 是后续生产测试，其中 T85/T86 取代 T67/T68 的生产 finalization 顺序/admission 分类，不伪装成 P0 已完成。
2. **P1 对齐批**：先改 types/domain 与 pure helpers，再写 Service，再写 Publisher/assembly；具体拓扑见附件 P1。
3. **P2**：types/config（含 orphan byte+count caps）→ identity/structure → receipt helpers → store/provider/conflict/quota → batch preflight/authoring → governance/Service → tool；具体拓扑见附件 P2。
4. **P3**：types/projection/outcome/canonical/targets/admission → settlement/cursor/claim coordinator → ledger/finalization → planner/runtime → live/history/governance；具体拓扑见附件 P3。
5. **P4**：durable invocation provider → usage classification/coverage/transition → usage/checkpoint Store → session/revision/outcome source reconciliation → curator → metrics；具体拓扑见附件 P4。
6. **P5**：manifest/fixtures → keyless replay → disposable eval-domain materialization → controlled runner → scorer → gate/report；具体拓扑见附件 P5。

每个 Phase 出口需要 focused behavior tests、per-file 100% coverage、REAL composition、HMR/teardown、必要的 keyless session snapshot、双 SDK projection（事件/wire 面变化时）、README/Agent Note 与仓库文档门。调用者的开发不得早于被调用函数的测试通过。

## 9. 非目标与限制

不改 `agent-loop`；不让 planner 调 mutation tools；不做向量检索、跨设备同步、多 Host 共享存储或断电级分布式事务；不把 scanner 宣称为完备安全证明；不在 L1 启用 user scope；不提供无 principal 的 user fallback；不物理删除 orphan skill bundles；不把 best-effort usage absence 当作归档证据；不直接提升 shadow proposal。

首版 crash model 是 Host/process crash + restart。Git 项目按 nearest `.git` 聚合；非 Git 项目按创建 session 的 cwd 分 scope，子目录可能分裂，诊断必须显示该 identity source。
