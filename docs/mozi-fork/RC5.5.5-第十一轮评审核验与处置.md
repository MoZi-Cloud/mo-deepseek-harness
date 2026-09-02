# RC5.5.5 第十一轮评审核验与处置

> 状态：设计处置记录（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 输入：`/home/moyang/Downloads/第11轮评审建议.md`；输出：`自我进化机制-RC5.5-方案.md`、`RC5.5-函数级规格总纲.md`、附件 P0–P5、执行进度报告与交接稿的 RC5.5.5 原位修订。
>
> Agent Note：`../../.agents/notes/proposed/architecture/2026-09-02-bounded-autonomous-skill-evolution.md`。
>
> 核验基线：DeepSeek Harness `16bd8323def3178fb6c21e008e9e2c28d2458896`；mozi-hermes-agent `05c248d8a6c7f6d0d26efbb35fba3d6dfeb36a06`；日期：2026-09-02。

## 1. 总裁定

第十一轮指出的四个目标缺口都存在：production skill 可见性与 P5 评测语义不一致、历史 source route 错误决定 reviewer route、P4 只有 lifecycle 而无 class-level consolidation、changed-method repair 缺少可复用的结构入口。前两项是目标可达性和评测真实性 S0，后两项是长期知识质量与经验召回 S1。

四个建议均为“修正后采纳”，不能原样落地。RC5.5.5 不把 P5 当作每条新技能的事实证明，不允许一个普通时间相邻的 failure/success 直接变成可见经验，不复制 Hermes 无界全库 LLM pass，也不复制其默认直写、best-effort provenance、默认关闭 agent-created scan 或 auxiliary route 失败后回落 parent 的策略。

RC5.5.4 的 memory current-surface、execution attestation、receipt/finalization、outcome batch/fault 与 orphan 取舍继续有效。P1 的函数顺序和当前接手位置不变；P2–P5 按本轮重新编号和扩展。完成函数级闭合后，RC5.5.5 恢复 **Architecture Frozen / Implementation Approved**；该状态不表示实现完成。

| 建议 | 裁定 | RC5.5.5 修正 |
|---|---|---|
| production skill effect 与 P5 不一致 | S0，采纳风险 | 增加 Host-owned owner、promotion policy、activation lineage 与 draft/auto 两级 rollout；P5 用同一 policy/activation，只有 permit 来源不同 |
| historical reviewer 绑定 source route | S0，采纳 | source route 只留摘要 provenance；conservative 只用显式 named review profile，source provider 不参与 scope/lane |
| 缺 class-level consolidation | S1，采纳目标 | 新增 P4b bounded cluster + durable consolidation attempt + destination-first saga；不采用无界 full-list 直写 |
| changed-method recovery 缺失 | S1，采纳 | exact retry 改名，新增非因果 RepairEpisode 与可重建 corroboration projection；拒绝独立第二真相 store |

## 2. 证据复核

### 2.1 Hermes 的自治能力存在，但其安全语义不是 RC5.5 的模板

Pinned Hermes `tools/skill_manager_tool.py` 的 approval gate 默认关闭，background review 创建成功后才以 best-effort sidecar 标记 `created_by: agent`；agent-created skill scanner 也默认关闭。它后来增加了 pinned/bundled/hub/external/user-owned guards、read-before-write 和 recoverable archive，证明“只让 curator-managed 内容自治”值得借鉴，也证明单纯直写目录不能满足 DSH 的 durable authority 要求。

同一文件明确把 `created_by` 解释为 curator-management opt-in，而不是不可变作者事实。RC5.5.5 因而把 `ManagedSkillOwner` 和 `autonomousManaged` 分开：owner 来自 Host origin，用户可关闭自治或 pin，但模型不能把 user-owned skill 改成 agent-owned。

### 2.2 P5 的 evaluator approval 确实比 production 强，但完全取消 eval permit 会形成自举循环

RC5.5.4 production review 只创建 invisible draft/pending，而 P5 D09 用 evaluator approval 令候选可见，因此 repeated-skill-reuse 不能代表现有 production 自动路径。该风险成立。

第十一轮要求 P5 直接调用“与 production 完全相同且已获 P5 授权”的 auto-promotion，会形成循环：promotion 需要尚未签发的 P5 authorization，而 P5 必须先让候选可见才能评估是否签发。RC5.5.5 保留一个窄的 `EvaluationPromotionPermit`，并要求 disposable eval composition 另行建立与 fixture root 绑定、进程内不可序列化的 `EvaluationPromotionAuthority`。二者只代替“authorization 已签发”这一项；owner、exact revision/digest、evidence class、unresolved、scan、quota、pin/conflict、base CAS、activation lineage 与 Provider read 都走同一 P2 policy 和 private activation transaction。Production Service 只接受 rollout permit，P5 不再用直接 governance approval 模拟 production。

P5 是 execution/profile/policy 的总体发布门，不是每条未来 skill 的语义 oracle。每条 mutation 仍须通过当前 evidence/admission；只有human-only command确认的exact candidate、exact retry或达到独立会话 corroboration 下限的 repair lesson 可进入 auto-promotion，普通 tool-success 仍只产生 draft。

### 2.3 DSH 已能把 historical source 与 reviewer execution 分离

Pinned DSH `SessionObservation` 可直接取得 cold session 的 immutable header/events/projections，不需要 source provider 在线；`ResumeAgentOptions.agentOptions` 和 subagent `agentOptions` 都允许显式 provider/model/reasoning/token 配置。`foldRequestHeader` 能恢复历史 route，但该 route 是来源证据，不是今天 reviewer 必须使用的执行配置。

RC5.5.4 让 historical route 生成 scope 并决定 conservative lane，导致授权数量随历史模型增长。RC5.5.5 改为显式 `ReviewExecutionProfileId`：conservative 的 live/history 都先选择管理员配置的 named profile，再解析 scope/attestation。live 的 inherit-current 只允许 shadow 实验，不能产生 conservative mutation。这样授权成本由配置 profile 数量决定，不由 source route 数量决定。

Cold path 仍可用 `agents.resume` 恢复 cwd、Session identity 与 projected preset，但必须传 selected profile 的 `agentOptions`；它不要求旧 source provider 存在。Carrier 不运行 source turn、不 append prompt、不生成新 source request，唯一 LLM 请求属 review child。Attempt 只保留 source header event seq/digest 和非敏感 route 摘要，不复制完整 historical system/tools 或会话正文到第二份 provenance。

### 2.4 Hermes consolidation 证明目标价值，也暴露直接复制的风险

Pinned Hermes `agent/curator.py` 明确把 one-session-one-skill 视为失败，并要求 umbrella/support-file consolidation；这证明 RC5.5.4 P4 只有 usage/lifecycle，无法主动控制知识碎片化。

Hermes 同一基线也包含针对“未验证 consolidation 直接 archive”“不存在 destination”“cron reference 断裂”等故障的后补 guards，且部分 classification 依赖模型 summary 或启发式。RC5.5.5 不采用“scan full list 后让 LLM 直接 patch/archive”的执行方式。P4b 先以 catalog/name/trigger token 构造有界 cluster，再持久化 immutable `ConsolidationAttempt`；destination revision 必须先通过正式 P2 mutation 和 promotion，之后 source 才能按 exact base、逐项记录 `absorbedInto` 并 archive。

Host 只能证明所有 source exact bundles 已作为 planner 输入、source bundles 仍保留可恢复、destination 当前可见以及 mutation 顺序正确，不能证明语义上的“所有 unique knowledge 已被保留”。该质量由 P5 oracle stratum 测量，不能伪装成结构校验。

### 2.5 Changed-method repair 是候选信号，不是 Host 可证明因果

RC5.5.4 的 `failure-recovered` 只配对同 root turn、同 tool+canonical args 的 later success，名称过宽但结构信号可靠。参数或工具改变后的成功确实覆盖更有价值的 debugging path，但“先失败、后成功、同一 turn”只能证明顺序和局部任务窗口，不能证明 B 修复了 A。

RC5.5.5 把原信号改名为 `retry-recovered`，并新增 `RepairEpisode`：Host 只记录 bounded root-task window 内失败调用、changed invocation 的 later success、durable coordinates 与 later unresolved 状态。单 episode 只能支持 agent-owned draft，不能直接发布 memory 或自动激活 skill。

不采用独立 `ExperienceCandidateStore` 作为第二权威。Planner 可从 episode 提出结构化 repair lesson，Host 派生 `RepairLessonDigest`；finalized ReviewAttempt 仍是 episode/lesson authority，人类 confirm/reject 另由 CommandId 派生的`RepairEvidenceOperation`对exact lesson/ref/revision/digest负责。`RepairCorroborationProjection` 只按 exact digest 和 distinct source Session 聚合，可从 retained attempts + repair operations 重建。措辞不同导致无法合并是可接受的安全型漏召回，首版不引入向量或 LLM semantic merge 作为 promotion authority。

第十一轮列出的“P5 repeated-task 证明”不能作为单candidate evidence，否则population-level rollout gate会被误当成未见proposal的真值证明。“特定工具的Host-verifiable postcondition”目标有价值，但pinned DSH没有generic verifier capability seam，本方案也未定义durable result identity、replay、注册权和冲突协议。RC5.5.5因此不接受一个只有名字的`Host verifier`作为强证据；它必须在未来以Service Definition/Provider/Consumer和durable exact-result协议单独立项。

## 3. RC5.5.5 协议修改

### 3.1 P2：owner、promotion 与 absorption

`ManagedSkillOwner` 为 `agent|user`，由 review/direct-tool origin 固定。Record 另有 `autonomousManaged` 和 `pinned`；只有 owner=agent、autonomousManaged=true、未 pinned 的 exact revision 可进入自治 policy。Bundled、hub、external 或 registry 人工来源不进入 managed auto-promotion target。

Rollout level 改为 `shadow|conservative-draft|conservative-auto`。Draft lane 可以提交 memory 和 agent-owned skill draft/pending，但不自动改变 catalog current；auto lane 还要求 exact scope authorization 含 `skill-auto-promotion` capability。Background activation OpId 由Host从actor/attempt/exact candidate稳定派生，不含artifact digest，因而重签不改变replay identity。每次成功 activation 与 record CAS 同笔写 immutable `ManagedActivationLineage`，保存 activation id、actor、revision/digest、review attempt、scope 与 permit digest；重放先查exact lineage duplicate。

`decideSkillPromotion` 是纯函数，production 和 P5 共用。普通 tool-success、单个 changed-method episode、存在 later unresolved、用户拒绝/pin/ownership conflict 或 stale base 都拒绝 auto；拒绝不影响 draft 的审计与人工 approve。

Consolidation destination 不能借用普通review的证据类。Host 只能在 immutable `ConsolidationAttempt` 已持久化且 exact preflight 成功后派生`ConsolidationPromotionEvidence`，并先将它写回 attempt。P4 mutation caller在promotion前重读attempt并核对plan/source/preflight权威；P2不反向导入P4 Store，只重验evidence与candidate origin/exact destination及自身current/permit facts。Production permit 必须在同一 signed scope entry 同时含`skill-auto-promotion`与`skill-consolidation`。该 evidence 只表示结构与授权准入，不表示语义保真。

P2 还增加 consolidation read/preflight/absorb API。Absorb 只能在 destination exact revision 已 active 后执行，source exact base 不变，且 durable `ConsolidationAttempt` 已 planned；它记录 destination ref/revision/digest 后把 source archive。Source revision bundles 与 lineage 保留，governance restore 仍可恢复。

### 3.2 P3：named reviewer profile、SkillLearningContext 与 repair projection

`ReviewExecutionProfile` 是管理员配置的 named profile。Profile selector 在 scope 和 lane 之前运行；conservative 只接受 named profile，profile unavailable 不 fallback 到 source route或另一个 profile。Source provenance 不参与 scope、lane、attempt id 或 P5样本分组。

P3 从 P2 的 read-only inventory 构造 bounded `SkillLearningContext`：loaded/consulted managed refs、exact revision/digest、current body/support-file manifest、相关 umbrella 候选、owner/pin/autonomous state与已有 agent-owned draft。Planner patch 只能指向 context 中精确读到的 base；新 skill 必须声明 class-level trigger intent，session id、日期、具体错误字符串等窄命名由 Host policy拒绝，语义是否真正 class-level 由 P5计分。

`classifyOutcomeSignals` 输出 `retry-recovered` 并并行产生 `RepairEpisode`。Planner 的 repair lesson 必须引用 episode coordinates；Host 只接受 working path 作为推荐步骤，failed path只能作为有条件 avoid/caution，不得伪装成推荐 workflow。普通用户文本不能被planner自行升格为confirmation；只有human-only command产生的durable `RepairEvidenceOperation`可确认/拒绝exact candidate，或拒绝project-level exact lesson digest。`RepairCorroborationProjection` 从 finalized attempts与repair operations聚合exact lesson digest与distinct sessions；projection 缺失可重建，冲突 fail-loud。

### 3.3 P4：保留 lifecycle，新增 bounded consolidation

P4a 保持 RC5.5.4 D01–D12 的 usage、coverage、batch outcome、fault 与 lifecycle 语义。P4b 在其后增加 cluster、plan、attempt、planner、destination-first saga 与 assembly 节点。

P4b 不扫描无界全文集合。Host 先按 normalized name、catalog summary/trigger token、loaded/related refs 构造每个有硬上限的 candidate cluster；超限稳定分页，不能截断后声称全库已检查。Planner 只能读该 cluster 的 exact bundles，并输出一个 destination 与零个或多个 absorbed sources。

`ConsolidationAttempt` 是项目级 durable authority，记录 profile/scope/attestation、rollout artifact或eval permit引用、immutable plan、destination/source exact bases、Host-derived promotion evidence、op states 与 terminal/finalized；process authority不落盘。执行顺序固定 plan 持久化 → exact preflight → promotion evidence 持久化 → destination mutation → destination manual/dual-capability auto activation → source absorption/archive。Destination 尚不可见时 attempt 保持 waiting-approval，不 archive source；crash 重放同 op ids 和 byte-equal evidence，eval resume先重验case/scope/cluster/plan-bound permits并重建两类current-root authorities。任何 source stale 只跳过该 source并保留可见，不回滚已安全发布的 destination。

### 3.4 P5：production-equivalent policy、九层 corpus 与分级 authorization

Manifest 从七层扩为九层，新增 `changed-method-recovery` 与 `skill-consolidation`，并将 eval protocol/manifest 从 v1 升为 v2。一般层至少30个独立held-out case，但changed-method的错误promotion rate upper bound≤0.10和consolidation的quality lower bound≥0.90在30个case时均不可达，因此两层各至少35，每个named review scope的总下限从263调整为333。V1 report/artifact 不得被 v2 loader 接受，也不按历史 source route复制 scope。

P5 D09 不再调用 human governance approval。它向同一 `decideSkillPromotion` 提供一次性 `EvaluationPromotionPermit`，并在 D07 composition 的 process-local promotion authority 验证后调用 eval-only adapter；adapter 与 production 共用 private activation transaction，再通过正式 Provider读取。Permit id绑定 case/repeat/scope/ref/revision/digest/policy version，authority 绑定 fixture root；二者都不能进入 production authorization或被 runtime接受；除“待签 authorization”外的任何检查都不得绕过。P4b eval 另用同root的 process-local consolidation authority只替代待签`skill-consolidation` capability，不与promotion authority混用。

`RolloutAuthorization` 的 scope entry 同时绑定最高获准 level/capabilities。`conservative-draft` 报告只能声称 proposal/draft质量与人工批准后的潜在效用；只有 production-equivalent promotion、repeated reuse、changed-method 与 consolidation 门全部通过，才可签发 `conservative-auto` 和对应 capabilities。P5仍不批准任何具体未来 plan。

## 4. 调用关系与开发顺序

```text
P2: types/config/owner
      → path + identity + structure + receipt
      → pure promotion policy
      → Store/index/Provider/conflict/quota
      → read inventory + mutation/consolidation preflight
      → create/patch
      → activation/governance/absorb
      → Service
      → skill_manage

P3: planner execution primitives
      → types/config
      → eligibility/projection/outcome + RepairEpisode
      → plan schema/identity
      → review profile selection
      → execution scope/authorization/lane
      → ids/targets/context/evidence pure helpers
      → settlement/cursor/claim
      → ledger + repair corroboration projection
      → finalization
      → planner/runtime
      → live/history/governance/Service

P4a: durable usage source → usage/coverage/reuse → outcome batch
       → lifecycle → Store → observer → curator/metrics/assembly

P4b: consolidation types/config → bounded cluster → plan identity
       → preflight → attempt store → planner → destination-first saga → assembly

P5: schema/Wilson/promotion+consolidation eval permit ids → manifest/digest/split → fixture/redaction
      → isolated composition/replay → production-policy eval materialization
      → controlled run → score/aggregate/gate → report → authorization → commands
```

每个调用者只调用同 Phase 更早节点、已完成 Phase API 或 pinned existing API。P4b 调 P2/P3 的公开 API，因此位于 P3 后；P5 调 P4b，故仍是最后 Phase。P1 没有被本轮反向依赖，当前 P1-R1 可继续。

## 5. 新顶级验收

| 编号 | Phase | 核心断言 |
|---:|---|---|
| T91 | P2/P3/P5 | auto scope 的 eval 与 production 共用 promotion policy/activation；activation id重放幂等；非 agent-owned、pinned、弱证据和 stale base 永不自动可见 |
| T92 | P3/P5 | historical source provider/model 只作 provenance；named reviewer profile 决定 scope/lane，退役 source provider 不阻断 conservative learning |
| T93 | P2/P4/P5 | bounded class cluster 进入 durable destination-first consolidation；Host admission evidence 先持久化且要求双capability；destination 未 active 不 archive，source bundle 可恢复且语义保留由 oracle 计分 |
| T94 | P3/P5 | exact retry 与 changed-method 分型；单 RepairEpisode 不直接可见，distinct-session corroboration/exact human command 才允许 promotion |

## 6. 新缺陷防回归自审

- **没有把 P5 误写成单条知识证明**：authorization 只覆盖 execution/profile/policy 的统计发布资格；candidate-specific evidence、ownership、CAS 与 unresolved 检查每次重跑。
- **eval 自举口没有进入 production**：`EvaluationPromotionPermit` 使用独立 brand/domain/version，并必须与 root-bound process-local promotion authority 组合才能调 eval-only adapter；P4b的consolidation authority与之分离。Runtime parser和 P2/P4 production API拒绝所有eval permit/authority。
- **eval crash 后仍可审计**：promotion lineage和ConsolidationAttempt只持久化exact permit id，不持久化process authority；恢复必须先重验verified fixture与permit再给当前root新建authority。
- **评测升版没有混用旧证据**：九分层、新门槛和draft/auto capability属eval protocol v2，v1 report/artifact fail-closed。
- **新分层的样本下限数学可达**：changed-method和consolidation均为35，九层每scope总下限333；不会出现门槛永远无法通过的30-case manifest。
- **owner 与 opt-in 没有混为一谈**：origin 固定 owner，治理只切 `autonomousManaged`/pin；模型不能接管 user-owned 内容。
- **auto activation crash 重放有稳定identity**：Background activation OpId绑定actor/attempt/exact candidate而不绑定可重签artifact；lineage duplicate早于current state与新permit检查，同id内容冲突fail-loud。
- **governance lineage不伪造permit**：Activation lineage为actor判别联合；human command分支由activation OpId链接治理权威，只有review-auto/consolidator分支必须携带attempt/scope/permit。
- **historical provenance 没有复制敏感正文**：Attempt 引用 source header seq/digest与摘要；完整 request header仍由原 Session log拥有。
- **profile 数量真正有界**：conservative 只从 load-time validated named profiles选；live inherit-current只进 shadow，不制造需要发布授权的动态 scope集合。
- **consolidation 不会先删后写**：destination active是 source absorb 的前置；source exact base改变则保留 source，attempt记录partial settlement并可重放。
- **consolidation destination 的 auto 路径可达且不冒充语义证明**：Review 证据不能用于 consolidation；Host-derived evidence 只从 stored plan + exact preflight 派生并先入 attempt，P2 还重验 exact destination/origin 与同 scope 双capability。
- **“unique knowledge preserved”没有伪装成 Host invariant**：Host只证明输入完整、旧 bundle retained、destination结构有效；语义质量由 P5 oracle和人工 restore纠错。
- **repair 没有假因果**：RepairEpisode名称和字段只声明顺序/窗口；单 episode不能可见，exact digest corroboration宁可漏合并也不做语义猜测。
- **没有新增第二 candidate 真相**：corroboration index从 retained finalized attempts与durable human repair operations重建；前者拥有lesson，后者只拥有exact human confirm/reject。P2 lineage和P4 ConsolidationAttempt分别拥有 revision/absorption authority。
- **Phase DAG 无环**：P2 policy不导入P3/P5；P3传入已验证 permit facts；P4b只调用已完成的P2/P3；P5最后评测所有路径。
- **consolidation attempt核验没有制造P2→P4反向依赖**：P4在mutation caller中重读其durable attempt并核对source/preflight，P2只执行managed-skill与permit不变量；typed evidence沿既有P4→P2方向传递。

## 7. 放行结论

第十一轮四项建议经修正后已进入 RC5.5.5 的数据模型、函数拓扑、失败语义与 T91–T94。P1-R1继续获准；P2必须先完成 owner/promotion policy再写 authoring caller；P3必须先选择 named profile再解析 scope/claim；P4b必须先有 durable attempt和destination-first preflight再允许 archive；P5必须区分 draft与auto报告，不得再以 human evaluator approval证明 production自治效果。

RC5.5.5 的目标是受控自治，而不是无条件自治：强证据和授权下，agent-owned skill能实际改变未来行为；弱证据保留为可审计 draft；user-owned与外部技能继续由人治理。该取舍同时保留 RC5.5.4 的 Host/replay authority，并补齐 Hermes 值得学习的 class-level、working-path 和 autonomous managed knowledge能力。
