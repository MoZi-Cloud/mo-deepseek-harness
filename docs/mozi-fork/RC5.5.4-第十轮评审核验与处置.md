# RC5.5.4 第十轮评审核验与处置

> 状态：设计处置记录（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 输入：第十轮四项评审建议；输出：`自我进化机制-RC5.5-方案.md`、`RC5.5-函数级规格总纲.md`、附件 P0–P5、执行进度报告与交接稿的 RC5.5.4 原位修订。
>
> Agent Note：`../../.agents/notes/proposed/architecture/2026-09-02-replay-authoritative-self-evolution.md`。
>
> 核验基线：DeepSeek Harness `16bd8323def3178fb6c21e008e9e2c28d2458896`；mozi-hermes-agent `05c248d8a6c7f6d0d26efbb35fba3d6dfeb36a06`；日期：2026-09-02。

## 1. 总裁定

四项风险中，memory current surface 与 review execution authorization 是 S0，P4 poison checkpoint 是 S1，orphan reclaim 是 S2。前三项进入 RC5.5.4 的函数、状态、调用顺序与验收规格；第四项只固化保守的未来治理前提，不扩大 P2-D01–D16。

评审中的风险判断成立，但三个原始修法不能原样采用：memory 插件不能在 pre-step waterfall 中抢先直接 append/replace session；完整 `EpochHeader` 在继承动态 standing context 时不能作为稳定授权 scope；P4 的普通 quarantine-and-skip 会丢失可能存在的正向 usage。RC5.5.4 分别改为 loop-committed surface intent、isolated prompt + stable scope + actual attestation、stable-coordinate batch + unresolved fault。

RC5.5.4 保留 RC5.5.3 的 Host-authoritative plan、resource receipt、whole-plan admission、forward-recovery、finalization 与 provenance 主架构。完成本轮函数级闭合后，设计状态恢复为 **Architecture Frozen / Implementation Approved**；该状态不表示实现完成。

## 2. 证据复核

### 2.1 `snapshot` form 不拥有真实 session surface

Pinned DSH 的 `ContextForm='snapshot'` 只在 `packages/llm/llm/src/message.ts` 声明 producer 语义。`packages/core/agent-loop/src/agent.ts` 对最终 pre-step `decision.messages` 固定使用 `surfaceOp:'append'`，模型请求随后读取 `session.deriveMessages()`。`packages/core/session/src/types.ts` 和 `surface.ts` 已提供显式 append/replace、shadowed-node provenance 与 `session.surface.nodes`；因此 P0 T43 的 test-tree `Map.set` 不能推出生产请求只有一个 current memory snapshot。

### 2.2 structured output 本身是 scoped tool

Pinned `packages/subagent/subagent-in-process-driver/src/structured.ts` 通过 scoped `structured_output` tool实现 `outputSchema`。`packages/core/tools/src/index.ts` 明确 global restriction不隐藏 scoped registration。因此 `toolFilter:{allow:[]}` 与 `planner-tool-list-is-empty` 不能同时满足；真正不变量是“普通工具为空，`structured_output`唯一可见且恰好成功一次”。

### 2.3 route 与实际 request 不是一个字段

Pinned subagent API允许 agentOptions覆盖 provider/model/reasoning/maxTokens；in-process provider按 parent effective route合并。Pinned `EpochHeader`记录 resolved call config、adapter defaults、system和tools，但继承的 standing/runtime context会随 session变化，且 provider endpoint/implementation不在 header中。authorization必须先固定可复现的 planner composition，再同时绑定 DSH request header与 adapter execution profile。

### 2.4 outcome ordinal 只有项间游标

RC5.5.3 P4只有 `afterOrdinal`，并规定单 outcome signal超限时不推进。ordinal N一旦 oversized，N+1永远不可达。Hermes curator把缺少 usage视为 absence of evidence；丢掉整个 oversized outcome后继续做 stale/archive同样不安全。

### 2.5 orphan 已有有界 fail-closed

RC5.5.3 P2已同时限制 orphan bytes与 incomplete+orphan count，零字节目录计数，同 op partial允许原地 resume，reconciler只记账且不自动删除。长期积累会降低 authoring availability，但不会无限增长或发布错误 skill，故不构成当前 correctness blocker。

## 3. 四项处置

### 3.1 S0 memory current surface：接受风险，修正实现方式

RC5.5.4 新增 P1-D15–D19：

1. D15 为所有 pre-step producer增加通用 `surfaceIntents` carrier。intent按 message id关联，并与最终 enter messages形成完整一对一映射；普通 message 也显式携 append intent，缺失不默认。agent-loop只在最终 waterfall decision被接受、`step/start`已记录后统一调用 `Session.append`。插件不得提前写 session。
2. D16 只从 `session.surface.nodes`读取 current memory。历史 log中已被 replacement或 compaction shadow的 event不参与判断。
3. D17 纯函数决定 no-op/append/replace/unavailable。replace必须引用被 shadow的 exact memory seq；compaction后即使 digest相同也 append。
4. D18 Publisher只生成 message + intent。read/scan/render失败且存在 visible available memory时，必须 replace为固定 unavailable snapshot；它不含旧 sections、旧正文或旧 digest。
5. D19负责 assembly与通用 API/architecture/expected-output同步。

不采用 runtime-only `publicationDirty`，因为 memory CAS后、dirty写前 crash会丢状态。available snapshot直接持久化 scope revision与 publication protocol digest；durable MemoryState + durable surface足以回放判断。

也不采用“旧字符串必须从整份 provider request消失”的验收。用户 correction本身可以引用旧事实，assistant history也可能讨论它。T80/T87检查的是最终 request中恰有一个 current memory authority，且该 memory-source contribution不再主张旧事实。

### 3.2 S0 execution authorization：接受风险，拆成 scope 与 attestation

P3-E01先扩展既有 DSH capability：fresh child支持 review-owned complete prompt、runtime-context suppression、adapter `executionProfileDigest`与provider actual request attestation。P3-D06随后构造和验证 `ReviewAuthorizationScopeDigest`；D07才用它派生 lane id，D14才允许 claim，D17/D18在任何 plan/mutation前持久化并核对 actual attestation。

授权 scope绑定 review provider、resolved call config、adapter execution profile、canonical isolated `EpochHeader`、output schema与 policy/learning/op/eval versions。它不含 session input，也不含 signature/report identity。P5 artifact持有 `{scopeDigest,reportDigest}` entries并签署整个 artifact；相同 scope重新评测或重新签字不制造新 lane。

未授权 route、historical route漂移、provider不可 attestation时，系统从 claim前就只选择该 scope的 shadow lane。不能先 claim conservative再降级。actual request mismatch进入 manual，零 resource mutation且不 advance conservative high-water。

不原样采用“直接 hash 当前完整 EpochHeader”：若 standing/runtime context仍继承，system随 session变化，授权无法复用。RC5.5.4先隔离 prompt/context，使 header成为稳定受测输入，再以 actual header作 attestation。adapter profile补足 header未覆盖的实现、endpoint和非 secret执行选项；credential永不进入 digest或报告。

### 3.3 S1 P4 poison checkpoint：接受 batch，拒绝单纯 index 与普通 skip

P4-D06定义 outcome digest、`SIGNAL_DERIVATION_VERSION`和稳定 `OutcomeSignalCoordinate`，按 strict-after coordinate产生有界 batch，不先物化整 outcome数组。P4-D08的 checkpoint持久化 `{ordinal,outcomeDigest,signalDerivationVersion,afterSignalCoordinate}`；每批 signal结算后 CAS子游标，全部完成才推进 `afterOrdinal`。receipt window只需覆盖一个 batch。

`nextSignalIndex`不够稳定：未来 derivation版本改变或排序重构会让同一整数指向不同 signal。ordinal也不能证明 outcome内容未变，因此 checkpoint必须同时固定 outcome digest与 derivation version。

oversized outcome是正常多批工作，不记 coverage gap。真正的 item-level schema/provenance corruption进入 durable `UnresolvedOutcomeFault`，主 checkpoint可越过以处理 later positive signals；active→stale和 stale→archived在 fault修复前关闭。人工 repair从 P3 retained outcome authority按独立 fault cursor补算，完成后重启完整 coverage window。P3 domain整体无法解析时仍 fail-closed，不能伪造 dead-letter后跳过。

### 3.4 S2 orphan reclaim：不进入核心 Phase，保留治理前提

P2-D01–D16继续使用 byte+count配额、exact inventory诊断、same-op resume与无自动删除。达到上限时 authoring fail-closed；该行为比未经引用证明的 GC安全。

未来 reclaim若立项，必须由人工治理命令接收 branded revision identity和 expected digest，不接受 raw path；在 project mutation maintenance lock下重验 current/pending/reservation/retained lineage及 P3 planned/committing/manual引用；先写 durable prepared operation，再 rename到 managed quarantine，重验后删除并记录 terminal/tombstone。quarantine计入配额，crash和same-op replay语义必须有验收。Hermes的 root/path/symlink删除 guard只能作为文件系统安全参考，不能替代这些 durable引用规则。

## 4. 调用关系与开发顺序

```text
P1: D01–D14 mutation/service
      → D15 generic surface-intent commit
      → D16 visible lookup
      → D17 publication decision
      → D18 Publisher
      → D19 assembly

P3: E01 isolated/profile/attestation primitives
      → D01 types/config
      → D02–D05 evidence/plan leaves
      → D06 authorization scope/lane selection
      → D07 lane/op identity
      → D08–D09 targets/admission
      → D10–D16 settlement/cursor/ledger/finalization
      → D17 planner attestation
      → D18 runtime
      → D19–D22 live/history/governance/assembly

P4: D01–D05 durable sources/signal/coverage/reuse
      → D06 outcome batch
      → D07 lifecycle decision
      → D08 store/subcursor/fault
      → D09 observer/repair
      → D10–D12 curator/metrics/assembly

P5: D01–D09 corpus/protocol/eval domain
      → D10 per-scope controlled run + actual attestation
      → D11–D13 score/aggregate/gate
      → D14 report
      → D15 signed authorization
      → D16 repository commands
```

每个箭头右侧节点只能调用左侧已完成节点或 pinned existing API。P1-R1/R2方向可继续；P1-R3不得沿用 latest-log/append-only实现。P2核心可在 P1 Phase出口后按原拓扑开发。P3-E01/D06、P4-D06/D08与P5 per-scope schema都必须在各自调用者前先红后绿。

## 5. 新缺陷防回归自审

- **插件所有权未丢失**：loop只解释通用 message-id surface intent，不识别 memory source；publication策略仍在 P1。
- **waterfall ordering闭合**：intent随最终 decision提交；外层 reject不会写事件，删除 message 必须同时删除其 intent。final message 缺失 intent、孤立 intent、未知/重复 message id都在 request前失败，因此不能把丢失 replace intent静默降级为 append。
- **旧日志不误擦除**：首版未发布，不提供 append-only memory日志迁移。发现多个 current memory node时fail-loud；不以覆盖非连续 range的方式删除中间用户历史。
- **unavailable可恢复**：failure snapshot不含旧正文；下次成功 publication replace unavailable。无 visible snapshot时读取失败不注入噪声。
- **授权没有双重 lane真相**：lane key使用稳定 scope digest，不使用会随签字变化的 artifact/report digest；attempt另存 artifact与actual attestation用于审计。
- **授权在正确时点**：intended scope在 claim前检查；actual request在 immutable plan和mutation前检查。两次检查分别防止污染 high-water与adapter/request-time漂移。
- **structured output不再被误判**：P5 hard gate只禁止普通工具，并要求 `structured_output`唯一、恰好成功一次。
- **P4正负语义分离**：unresolved fault不丢 later positive signal，也不允许未知历史被解释为长期零活动。
- **batch receipt有界**：source mutex只覆盖一个 batch到subcursor CAS；Config容量证明不乘无界的单 outcome signal总量。
- **corruption没有被静默吞掉**：只有可定位的 item-level fault可被 durable记录后越过；domain整体解析失败仍关闭 source。
- **reclaim没有偷渡进核心**：P2配额与provenance生命周期不因未来maintenance设想而改变；手工删除仍不属于支持协议。
- **Hermes只作能力与保守性参考**：不复制其 session-start frozen memory、aux provider fallback或直接目录删除语义到 DSH。

## 6. 放行结论

RC5.5.4 的四项裁定已进入总案、总纲、P0–P5附件与执行交接文档。P1-R1可以继续；P1-R3必须先实现 D15通用 surface intent再替换 Publisher。P3 conservative路径必须等待 E01/D06/D17；P4 observer必须等待 D06/D08；P5只授权独立通过的 exact execution scopes。

上述前置、状态、失败与验收关系闭合后，RC5.5.4 恢复 Architecture Frozen / Implementation Approved。P5 authorization通过前，所有 route只具有 shadow写权限；未授权或attestation不匹配的执行永远不能产生 durable learning mutation。
