# RC5.5.3 第九轮评审核验与处置

> 状态：设计处置记录（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 输入：`第九轮评审建议.md`（证据复核修订版）；输出：`自我进化机制-RC5.5-方案.md`、`RC5.5-函数级规格总纲.md`、附件 P0–P5 与执行交接文档的 RC5.5.3 原位修订。
>
> 核验基线：DeepSeek Harness `16bd8323def3178fb6c21e008e9e2c28d2458896`；mozi-hermes-agent `05c248d8a6c7f6d0d26efbb35fba3d6dfeb36a06`；日期：2026-09-01。

## 1. 裁定

第九轮复核后的 16 项建议均有价值，但处置方式不同：1–14 进入 P1–P5 的函数、状态或验收规格；15 通过现在引入 `UserKey` 消除全局 user record，但 L2 仍须等待部署提供 principal；16 保留现有 Git-root 规则并把非 Git cwd 分裂写成明确限制，不在 RC5.5.3 发明仓库中不存在的 WorkspaceId。

RC5.5.3 保留 RC5.5 的主架构：LLM 只生成候选计划，Host 保存计划、验证证据并提交；memory/skill 使用资源级幂等 receipt；skill 可见性由独立治理提交；跨资源失败 forward-recover。RC5.5.3 改写的是未闭合的操作身份、结果证据、重试、finalization、历史扫描、治理和质量门，不把 Hermes 的直接后台写入路径搬进 DSH。

原第九轮初评中已撤回的结论不进入方案：不增加 receipt `requestDigest`；不把计划摘要描述为自引用；不声称当前支持跨 LLM provider review；不把 Hermes write approval 误写成默认；不采用 release-before-finalized；不复制整份 evidence 到每个资源记录。

## 2. 逐项处置

| 排名 | 裁定 | RC5.5.3 落点 |
|---:|---|---|
| 1 | 接受 | P2 增加 `deriveDirectToolOpId`、`ManagedMutationOrigin` 与 direct-terminal receipt；review mutation 才进入 pending；Config 增加 `receiptWindowSize`。 |
| 2 | 接受并按现有 API 收口 | P3 load-time 校验 review provider 支持 `toolFilter/outputSchema/persona/agentOptions` 且 `inheritsParentContext=false`；`startPlanner` 固定 `toolFilter:{allow:[]}`；触发器先调用 root-only predicate。standing composition 仍可能存在，真实请求 snapshot 钉死，且不能充当 evidence。 |
| 3 | 接受并在最终拓扑自审后再修正 | 第九轮要求 finalized+occupied recovery 正确，但 ack-before-finalized 会让 receipt 提前进入可淘汰 ring。最终 finalization 固定为 mark terminal → apply cursor disposition → mark finalized → assign/index stable outcome ordinal → acknowledge finalized receipts → release；recovery 处理 unfinalized terminal、缺 ordinal/index 与 finalized+occupied。 |
| 4 | 接受 | ReviewPlan memory 使用判别联合；update/remove 必带 `targetEntryId` 与 `expectedEntryDigest`；P1 fold 也检查 exact digest。 |
| 5 | 接受但收窄“成功”表述 | P3 从 durable events 产生 Host 结构信号，不把 turn completed/tool-success 等同任务成功；unresolved/assistant-only 零可见，单个 tool-success 只支持 project fact 或隐藏 skill draft，procedure/recovery/caution memory 需要 user correction 或 failure+recovery 双证据；语义效果由 P5 硬门与统计门评估。 |
| 6 | 接受 | P3 独占 `enumeratePlanOps`、`canonicalPlanOpDigest`、`REVIEW_OP_IDENTITY_VERSION`；顺序固定 memory 后 skill、各数组原序、全计划零基 index。P1 结果摘要改名 `memoryResultDigest`。 |
| 7 | 接受并改 owner，随后补 partial-saga 分层 | pre-plan retry/manual due 与 planned inFlight resume gate 均进入 `ReviewCursor`；前者新 attempt，后者保留同一 attempt/op ids。host 唯一 claim coordinator 串行容量检查与 lane RMW；已有 applied op 后的 stale/invariant 进入 manual。 |
| 8 | 接受 | P1 增加 `maxRenderedSnapshotChars` 与 `validateMemoryConfig`，在 load 时证明所有 admitted state 可发布；publisher 只对瞬态读取失败 fail-open。 |
| 9 | 接受并调整挂载 | P3 改为唯一 host 级 `SessionReviewService`，使用 `sessionQuery.listSessions/observeSession`、`agents.resume` 与持久化 scan checkpoint 处理冷 root sessions；实时与历史路径共用 per-session cursor claim。 |
| 10 | 接受 | P3 注册 human command，提供 project memory list/show/correct/remove；correct/remove 使用 `CommandId` 派生 direct op id、exact entry digest 与 P1 direct-terminal API。L1 不因此强制所有 inference 先审批。 |
| 11 | 接受 | P1/P2 load-time 校验 `maxEntryChars/maxFileBytes <= MAX_SCAN_CHARS`；skill 的每个模型可见文本文件均整文件扫描。 |
| 12 | 接受并闭合异步观测 | P4 为 durable `skill-invocation` 记录 winning provider，并用 top-level tool/result 同条 `presentationMeta` 持久化 model load provider 与 rendered-content digest；nested PTC 不算 model load。分离 model load、用户调用、patch 与 verified reuse；gap 后重启完整 inactivity 窗口。P2 revision 从 bounded lineage 补扫，durable session 按 seq、P3 late-finalized outcome 按 stable ordinal 补扫；archived 只允许用户 restore。 |
| 13 | 接受并补可执行/统计约束 | 新增附件 P5：固定 fixture strata、manifest、隔离 composition/evaluator approval、baseline/candidate runner、硬门、Wilson unique-case 下限、报告与失败动作。shadow proposal 永不直接提升，L1 使用新 lane 重审。 |
| 14 | 接受并避免双写真相 | review 以永不删除、单调更新且 plan 落定后不可变的 ReviewAttempt 为 authority，direct memory 以 GovernanceOperation 为 authority，direct skill tool 以 P2 immutable revision lineage 为 authority；派生 op index 由各 owner 重建，receipt ring 不承担 provenance 生命周期。 |
| 15 | 提前修正类型，L2 仍有门 | P1 `MemoryScope.user` 改为必须携 `UserKey`，删除进程全局 `'user'` key；RC5.5.3 不提供伪造 principal 的默认值。 |
| 16 | 接受限制说明 | project root 仍为 nearest `.git`、否则 cwd；诊断显示 identity source。非 Git 多子目录共享须以后显式配置 root，不由当前方案猜测。 |

## 3. RC5.5.3 新增协议验收编号

T69–T86 是 P1–P5 的生产验收，不追记成已经完成的 P0 Evidence Lock。P0 仍是 68 项 test-tree 记录；T85/T86 是新版最终拓扑自审对 T67/T68 生产顺序/分类的替代，各新测试在所属 Phase 按 TDD 先红后绿。

| 编号 | 所属 | 协议 |
|---:|---|---|
| T69 | P2 | direct tool op identity 与 direct-terminal receipt |
| T70 | P3 | planner 空工具、fresh child 与 inherited standing snapshot |
| T71 | P3 | root-only/non-recursive review |
| T72 | P3 | finalized+occupied reconciliation |
| T73 | P1/P3 | exact memory target id+digest |
| T74 | P3 | unresolved 与 assistant-only 零可见学习 |
| T75 | P3 | failure→recovery 的结果约束 |
| T76 | P3 | plan enumeration、canonical digest 与 identity version |
| T77 | P3 | pre-plan retry 与 stored-plan same-attempt resume 的 durable backoff/cap/manual hold |
| T78 | P1 | admitted memory state 必可发布 |
| T79 | P3 | 冷历史枚举、checkpoint 与实时互斥 |
| T80 | P1/P3 | memory 纠错/删除治理与下一 snapshot |
| T81 | P1/P2 | 可见单元不超过 scanner 覆盖 |
| T82 | P4 | usage signal、coverage 与显式 restore |
| T83 | P5 | 可执行质量门与 shadow 新 lane 重审 |
| T84 | P3 | provenance 重建与 receipt eviction 解耦 |
| T85 | P1/P2/P3 | finalized 前 receipt 不可淘汰，cleanup 可重放，pending 有 inFlight×plan cap |
| T86 | P3/P5 | 确定性 admission 拒绝 consumed 且计分，瞬态失败才 retry |

## 4. 调用图与开发顺序自审

RC5.5.3 的 package DAG 为 `content-scan → memory`、`content-scan → skill-managed`、`memory + skill-managed → session-review`、`skill-managed + session-review → skill-curator`、`session-review + skill-curator → P5 gate`。共同叶子 content-scan 完成后，memory 与 skill-managed 之间无 edge；P2 不导入 P3；共享 `OpId` 只使用同一 `Branded<'OpId'>` 类型，不建立反向 package edge。

每份附件新增拓扑表。表中某行只能调用更早行或既有仓库 API；类内方法也按 helper → store → orchestration → assembly 排序。跨 Phase 调用者只能出现在被调用 Phase 验收全绿之后。

历史处理要求 P3 在 host plane 唯一注册：若仍挂每会话 preset，就无法在没有 live Agent 时拥有全局 checkpoint，也会重复打开 review domain。新版因此把 `SessionReviewService` 挂 host composition；它恢复 cold Agent 时按 observation 的 `agentPreset` projection 重新 mount，并在完成后释放自己持有的 `AgentHandle`。

planner 不能获得“只含 ReviewInput”的绝对空白上下文，因为 spawn child 会继承父 preset standing composition，host pre-step 插件也可能作用于 child。新版不作虚假承诺：provider 必须 fresh（无父 conversation），工具固定为空，真实最终请求逐字节 snapshot；只有 LearningView 中可定位的 durable evidence 能通过 Host admission，standing/current state 只可用于去重和目标解析。

## 5. 新缺陷防回归自审

- 增加 memory 治理后，若仍让所有资源 receipt 先 pending，会产生第二个无 finalizer 路径；P1 因此与 P2 同样增加 direct-terminal 单 RMW API。
- 增加 historical resume 后，若只按 header 选择 preset，会忽略会话内 `agent-preset/selected`；规范要求 `observeSession({projectionMode:'all'})` 的 `agentPreset` projection。
- 增加 provenance index 后，若 authority record 与 index 被视为双权威，跨记录崩溃会制造矛盾；规范按 operation origin 分别以 attempt、governance operation 或 skill revision lineage 为唯一权威，index 只可重建。
- 增加 retry gate 后，若 gate 只在 ledger，cursor claim 仍可绕过；规范把 blocked/manual 计数放进 claim 自己读取的 cursor record。
- 增加 shadow 重验后，若倒退同一 high-water 会破坏单调性；规范按 rollout/policy 建新 cursor lane，旧 lane 永不回退。
- 增加 user key 后，若 P1 自行生成默认 principal，会重新产生跨用户混用；规范禁止默认 user key，L2 无 principal fail-loud。
- 增加 curator coverage 后，若“未观测到事件”仍自动解释成零使用，旧缺陷会复发；规范只让已知连续覆盖窗口参与 archive，未知或写入失败延后迁移。
- direct tool/command receipt 使用有界环后，只有仍可能恢复的 review op 才留在 pending；finalized review 与已完成 direct operation 不依赖永久 receipt。receipt 淘汰不删除 attempt/governance/skill-lineage provenance，P2 的 duplicate-before-base 也必须查 lineage。
- P2 原 Config 声称 terminal receipt 有界却没有容量字段；RC5.5.3 增加 required `receiptWindowSize`，并验证正整数。
- P2 只限制 orphan bytes 时，反复留下零字节 incomplete revision 可无限增长；最终增加 required `maxUncommittedRevisionsPerProject`，按目录 count 计入 pending/incomplete/orphan inventory，且不与成功 lineage 重复计数。
- P1 预算证明必须包含最坏 fence 长度、固定 header、entry id 前缀、换行和全部启用 scope；仅比较原始 content chars 不算通过 T78。
- 跨文档故障注入证明 ack-before-finalized 会在 bounded ring 中丢失未完成 finalization 所需 receipt；T85 使 review receipt 留 pending 至 ledger finalized，再 cleanup 并 release cursor。
- 当 admission 拒绝由 immutable plan/evidence/policy/scan/quota 决定时，无条件 retry 会浪费成本并进 manual；T86 将它终结为 rejected noChange/consumed 且保留质量惩罚，只有瞬态和 provider infrastructure 失败进 backoff。
- P5 原先若沿用每层 30 case，则 `no-learning-signal` 即使 30/30 全对，95% Wilson 下界仍约 0.886，不可能达到 0.95；同理 repeated-skill 30 case 零重犯的 Wilson 上界仍高于 0.10。新版由阈值反推 unique-case 下限（no-learning 73、user-correction 35、repeated-skill 35，总计至少 263），并禁止把同 case 的 provider repeats 当独立样本。
- managed draft 在 production approve 前不可见；P5 重复任务评测若直接注入正文会绕过真实 Provider。新版只在一次性 eval composition 中记录 evaluator-only approval，并调用正式 P2 governance CAS/Provider；该记录不能进入生产 provenance 或 rollout authorization。
- immutable plan 落盘后若把 transient 终结成新 attempt，会丢失 stored-plan/op-id 续跑，并可能在 memory 已提交后把 partial saga 伪装成重规划。新版把 plan 前 retry 与 plan 后 resume 分开；后者持久化在同一 inFlight，已有 applied op 后的 stale/invariant 只可 manual。
- pending review receipt 不可淘汰但也不能无限增长；新版用 host 唯一 claim coordinator、required `maxConcurrentReviews/maxPlanOps` 和 cleanup-failure acquisition gate 建立硬上界，重启从 durable lanes 重建占用。
- 总纲曾允许 unresolved/transient 形成 caution，却又在 P3 要求零可见，属于自相矛盾；最终以安全侧收敛为零可见。单个 tool-success 只可支持 project fact 或不可见 skill draft；procedure/recovery/caution memory 需要 user correction 或 failure+recovery 双证据。
- P5 的 0.80 proposal-clean case rate 包含 rejected proposal 和不可见 draft，TP/FP/FN micro precision 只作诊断；该门不能解释为允许错误 memory 发布，oracle-forbidden/opposite/unsupported memory 一旦进入 candidate snapshot 即 correctness hard breach。
- 普通 case bootstrap 在全成功样本上会退化为 `[1,1]` 并低估不确定性；新版对 proposal-clean/learning-complete 等独立 case 二元指标统一使用 Wilson，只对 baseline/candidate 配对差使用 case-paired bootstrap。
- coverage gap 后若仍要求从最初 activity 起全程覆盖，状态机会永久不再 stale/archive；新版改用 `max(activityAnchor,completeSince)` 作为新 inactivity 起点，既不把 gap 当零，也能在恢复后的完整窗口结束后迁移。
- 只在 live `tools/result.value` 读取 provider 时，late outcome 到来前进程重启会丢掉 exact load identity。源码的 `output.presentationMeta` 与 top-level result 同条持久化，nested composite 则明确没有 meta；进一步核对 PTC 后确认 nested dispatch log 不直接给模型，不能计作 model load。最终由 `tool-skill` meta 持久化 provider/name/canonical rendered-content digest，P4 复算 persisted content 后承认 top-level load；post-execute 内容替换和 nested PTC 均不误计。
- P3 review 可能晚于 root turn settlement 才 finalized；按随机 AttemptId 循环分页会迫使 P4 永久保存全部 signal identity，否则下一 cycle 重复计数。最终给 finalized ReviewAttempt 分配稳定递增 ordinal：counter-before-attempt 崩溃只留 gap，attempt 上 ordinal 永不改写，查询 index 可重建；P4 只向前分页。durable session signal、P2 bounded revision lineage 与 P3 outcome ordinal 分源 reconciliation，session/outcome 整页在 source mutex 内结算，recent receipt Config 必须覆盖任一整页。
- failure/recovery 若只按 tool name 配对，会把任意两次 shell 调用误关联；最终只允许 Host 对相同 canonical invocation fingerprint 配对。参数改变的 repair 可提隐藏 skill draft，但没有 user correction 时不能自动发布 procedure memory。

## 6. 放行结论

P1 当前纯函数提交可以保留，但批 C 前必须先完成 RC5.5.3 对齐批：判别式 Host op、entry digest、`UserKey`、`memoryResultDigest` 改名、scanner/config 与 publication-budget 验证、direct-terminal receipt。完成这组被调用函数后才能写 Service 和 Publisher。

P2 依附件拓扑开发，先完成类型、identity、structure、store 与 receipt helper，再实现 AuthoringCore，最后实现 `skill_manage`；不能让工具层先生成临时随机 id。

P3 在 P1/P2 全绿后开发，按 D01–D21 先完成投影/outcome/canonicalization/target/admission，再完成 settlement decision、cursor/claim coordinator、ledger/finalization，最后接 planner、live/historical orchestration 与 governance。P4 依 coverage/outcome scan 状态机开发；P5 gate 通过前 rollout 保持 shadow。

RC5.5.3 经上述修订后重新获得 Implementation Approved，但该裁定只表示函数规格闭合，不表示 P1–P5 已实现或质量已达标。
