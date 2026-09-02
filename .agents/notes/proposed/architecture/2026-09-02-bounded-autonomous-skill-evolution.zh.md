# Agent Note: 有界自治的技能进化

Status: proposed

[English](2026-09-02-bounded-autonomous-skill-evolution.md) | 中文

## Problem

RC5.5 自我进化设计可以从 durable Session 证据创建 managed-skill draft，但 production 要求人类批准后，这些 draft 才能影响后续任务。质量评测通过 evaluator-only approval 让 draft 可见，因此其测得的重复任务收益无法由 production 自治路径到达。

Historical review 还从来源 Session 的最后 request 派生 reviewer route。这让 authorization 成本和可用性取决于持久历史中出现过的每个 provider 与 model，尽管旧 route 是任务来源证据，而不是今天负责总结任务的模型所必须满足的条件。

基于 usage 的 lifecycle maintenance 无法阻止 one-session skill 让知识库碎片化，exact-invocation retry 检测也会遗漏通过更换 command、argument、ordering 或 tool 得到 working path 的 repair episode。直接复制 Hermes 的 background mutation 会放弃 RC5.5 已建立的 Host-owned identity、replay、admission 与 crash 保证。

## Proposal

Managed skill 将记录由 Host 派生的 `agent` 或 `user` owner，并与 operator 控制的 autonomous-management opt-in 分离。只有具有强 admitted evidence、未 pinned 的 agent-owned revision 可以进入已授权 auto-promotion 路径。Rollout 将区分 shadow、conservative draft 与 conservative auto。Production 和 evaluation 调用同一个纯 promotion policy 与同一个 private activation transaction。Host派生的background activation identifier绑定actor、attempt和exact candidate，其immutable lineage与current pointer为replay同笔提交。Evaluation 必须同时提供 domain-separated 的单 case permit 与绑定 disposable root、不可序列化的进程内 authority；二者一起只替代评测正在决定是否签发的 authorization。Production service 不接受任何一项 eval input。

Conservative live 与 historical review 将在派生 authorization scope 或 cursor lane 前选择一个 load-time validated named execution profile。Historical request route 仍以 event coordinate 与 digest 作为 source provenance，但不选择 reviewer、不进入 lane identity，也不增加 evaluation scope 数量。继承 live task route 只保留为 shadow-only 实验。

Planner 将接收有界 skill-learning context，其中包含 exact managed revision、support-file manifest、ownership state、loaded skill、相关 umbrella candidate 与符合条件的 hidden draft。它只能 patch context 中包含的 base。新 skill 面向 class-level trigger；窄的 session-specific material 优先进入 support file。

Lifecycle curation 保持确定性，并与 semantic consolidation 分离。第二个有界 consolidation pass 将形成确定性 candidate cluster、attest planner execution，并持久化 immutable project-level attempt。Exact preflight 后，Host 持久化绑定attempt、destination、每个source base和preflight digest的consolidation-promotion evidence。P4 mutation caller在promotion前重读该attempt；P2不导入P4 Store，只验证自己拥有的destination、current-state、policy与permit facts。Destination自动激活要求同一scope的auto-promotion与consolidation两项capability；evaluation用彼此独立的root-bound promotion与consolidation authorities替代它们。它先提交并激活 destination，之后才能 archive 任一 exact-base source；所有 source bundle 都保留用于 restore，每条 absorption 都记录 destination revision。该evidence只证明执行准入，不证明语义保真；后一判断由 controlled evaluation 拥有。

Exact same-invocation recovery 命名为 `retry-recovered`。Changed-invocation sequence 产生非因果 `RepairEpisode` record，只证明 durable ordering、有界 root-task window、later execution success 与 unresolved status。单个 episode 可以创建 invisible agent-owned draft。自动可见还需要仅人类可用的 durable command 对 exact lesson 与 revision 进行确认，或达到配置下限的 distinct source Session exact lesson-digest corroboration。普通会话文本不能让 planner 自行声称已确认。Corroboration index 可从 retained finalized review attempts 与 exact human repair operations 重建，不成为第二 candidate authority。Generic Host verifier 延后到它具备完整capability seam与durable exact-result协议之后。

[可重放权威的发布与执行提案](2026-09-02-replay-authoritative-self-evolution.zh.md)继续拥有 memory surface publication、request attestation、outcome batching 与 orphan-reclamation deferral。本提案以 named profile selection 扩展其 execution scope，并增加 skill-specific ownership、promotion、repair 与 consolidation 决策。Evaluation protocol v2 拥有九分层 corpus，并拒绝前一个七分层协议生成的 report 或 authorization。完整函数顺序和验收矩阵记录于 [RC5.5.5 处置](../../../../docs/mozi-fork/RC5.5.5-第十一轮评审核验与处置.md)。

## Authority map

| 事实 | 权威 |
|---|---|
| Skill owner 与 exact revision lineage | Managed-skill record transaction |
| Autonomous activation | Managed activation lineage与已验证rollout permit facts；consolidation还要求Host从attempt/preflight派生的evidence |
| Historical task route | 原 Session request-header event |
| Reviewer execution | Named review profile、authorization scope 与 actual request attestation |
| Repair evidence | Finalized ReviewAttempt 与其 durable event coordinates |
| Human repair confirmation 或 rejection | Human command 派生、绑定 exact candidate 或 lesson digest 的 operation |
| Repair corroboration | Finalized attempts 与 repair operations 上的可重建 projection |
| Consolidation progress 与 absorption intent | Durable ConsolidationAttempt |
| Archived source contents | Retained managed revision bundles 与 lineage |

## Alternatives considered

**让 skill 保持 proposal-only。** 这保留了最小 mutation surface，但无法满足历史学习在不让用户成为永久审批队列的前提下改变未来行为这一产品目标。

**把通过 P5 的 profile 当成每条未来 skill 都正确的证明。** P5 建立 execution 与 policy 的统计适用性，不证明尚未出现的未来 proposal 为真。每次 activation 仍必须检查 candidate evidence、unresolved state、ownership、scan 与 exact CAS。

**要求 evaluation 提供已经签发的 production authorization。** Authorization 是 evaluation 的输出，因此会形成循环。只有在同时存在 root-bound process authority，且每项 candidate-specific production check 与 activation transaction 保持相同时，独立 evaluation permit 才可接受。

**让 historical review 使用每个 source Session 的旧 provider 与 model。** 原 route 是有用的 provenance，但把它与 reviewer 绑定，会让 retired provider 与历史 route 多样性决定学习可用性和 evaluation 成本。

**复制 Hermes 的 full-library consolidation loop。** 使用直接 filesystem write 的无界 model pass 无法提供 exact source baseline、destination-first settlement、crash replay 或 partial absorption 的 durable explanation。

**提升任意 failure 后出现 success 的序列。** 时间接近不能证明修复因果。Changed-method episode 在存在独立权威支持前保持 candidate。

**创建独立 experience-candidate database。** 第二 durable authority 还需要自己的 identity、transaction、recovery、retention 与 conflict protocol。Finalized attempt 已保留所需证据；可重建 index 已足够。

## Acceptance criteria

- Authorized auto scope 可通过 evaluation 所执行的相同 policy 与 activation path 让符合条件的 agent-owned revision 可见；activation重放幂等，user-owned、pinned、弱证据、unresolved 或 stale-base revision 不能 auto-promote。
- Retained Session 在 source provider 不可用后仍可由 authorized named reviewer profile 学习，source-route 变化不创建 reviewer lane 或 evaluation scope。
- Destination exact revision active 前 consolidation 不能 archive source，每个 archived source 都可按 exact absorption provenance restore。
- Exact retry 与 changed-method episode 保持不同；单个 repair episode 永不发布 visible memory 或 auto-activate skill。
- Cross-Session repair support 从 distinct finalized source Session 与 exact human repair operations 派生，并可在不改变 promotion decision 的前提下重建。
- P5 分开报告 proposal-only benefit 与 production-reachable autonomous skill effect。

## Risks

Auto-promotion 接受有界的剩余语义错误风险，因为 Host check 无法证明 model-authored instruction 在所有情形都正确。强 evidence class、exact ownership、conservative rollout、quality evaluation、provenance、correction、rejection、pinning、archival 与 restore 会降低并限制风险，但不能消除风险。

Exact-digest repair corroboration 会漏掉措辞不同但语义等价的 lesson。首版接受该 false-negative 偏向，不让 semantic clustering 成为 publication authority。

Destination-first consolidation 在 crash 或 stale source base 后可能让 destination 与部分 source 同时可见。该临时重复比 replacement active 前隐藏知识更安全；replay 与后续 attempt 可在无 rollback 的情况下收敛。

Named review profile 要求 operator 配置稳定 reviewer route。Profile 不可用时，learning 会 defer 或进入 shadow，而不会 fallback 到未受测 execution。
