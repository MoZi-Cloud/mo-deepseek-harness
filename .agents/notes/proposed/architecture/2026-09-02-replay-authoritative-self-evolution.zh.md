# Agent Note: 可重放权威的自我进化发布与执行

Status: proposed

[English](2026-09-02-replay-authoritative-self-evolution.md) | 中文

## Problem

RC5.5 自我进化设计把历史 Session 证据转化为持久 memory 与 managed-skill proposal。当前 memory publisher 从 `agent/pre-step` 返回 snapshot message，但 Agent Loop 会把每条被接受的 pre-step message append 到 Session surface。因此，标记为 snapshot 的 message source 并不会替换先前的模型可见 memory 权威。

Durable learning 还需要证明 rollout 准入的 planner 执行就是产生 plan 的执行。provider/model allowlist 漏掉已解析的 adapter defaults、隔离 system 与 tool assembly、schema version 以及 provider 执行选项。在完成该证明前 claim conservative cursor，可能让未受测执行消耗该 lane。

Curator 的 ordinal-only checkpoint 无法越过一个产生信号数超过单次配置上限的 finalized outcome。跳过该 outcome 会丢失正向 usage 证据，之后可能把活跃 skill 误判为 stale。Managed-skill orphan storage 存在另一个可用性问题，但现有 byte 和 count quota 已经限制增长并 fail closed。

## Proposal

每个进入的 pre-step decision 都将携带 final message id 到 surface intent 的完整一对一映射。普通 message 获得显式 append intent；intent 缺失永不默认为 append。Agent Loop 只在 `step/start` 之后为最终被接受的 decision 提交这些已映射 intent；producer 不直接 append。Memory publication 从 `session.surface.nodes` 派生唯一的 current memory node，再选择 append、精确单节点 replace、no-op 或不含 payload 的固定 unavailable snapshot。这会扩展现有 [Session surface](../../implemented/architecture/2026-06-18-session-surface.zh.md) 与 [可重建请求](../../implemented/architecture/2026-07-05-reconstructable-requests.zh.md) 决策，但不取代它们的 event-log 权威。

Review rollout 将授权一个由单一共用 isolated Epoch template、resolved call configuration、adapter execution-profile digest、output-schema digest 与 policy version 构成的稳定 execution scope。Lane selection 在 claim 前完成。Planner provider 将证明实际 request header 与 adapter profile；ledger 在存储 immutable plan 或修改 resource 之前持久化并比较该 attestation。未授权或无法 attestation 的执行只使用 shadow lane。

Review child 将使用完整的 review-owned system prompt，抑制 standing/runtime context，且不具有普通 global tool。Output-schema 实现安装的 scoped `structured_output` tool 仍是唯一可见 tool，且必须恰好成功一次。这会特化现有 [subagent composition controls](../../implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.zh.md)，但不取代该决策。

Curator checkpoint 将保留 outcome ordinal、immutable outcome digest、signal-derivation version 与稳定的 strict-after signal coordinate。Oversized outcome 将以有界且确定的 batch 结算。可定位的 corrupt item 在主 checkpoint 前进前将先创建 durable unresolved fault；之后的正向证据可继续处理，而负向 lifecycle transition 在修复前保持禁用。无法定位 item 的 domain-level corruption 仍然 fail closed。

Physical orphan reclamation 将继续留在核心 managed-skill authoring Phase 之外。未来 operator protocol 只能在 project mutation maintenance lock 下，经 durable preparation、完整 authority-reference 重验、quarantine 和 crash-safe settlement 后回收 branded revision identity。Raw-path deletion 与自动 garbage collection 不受支持。

[RC5.5.4 处置](../../../../docs/mozi-fork/RC5.5.4-第十轮评审核验与处置.md)记录这四项机制的函数顺序。Named reviewer selection 以及 managed-skill ownership、promotion、repair 与 consolidation 由后续的 [有界自治技能进化提案](2026-09-02-bounded-autonomous-skill-evolution.zh.md)拥有。已实现的 [P0 Evidence Lock note](../../implemented/feature/2026-08-31-session-review-p0-skeleton.zh.md) 仍是已发布 test-only reference suite 的 owner；本提案不会把这些 reference 晋升为生产实现。

## Protocol ownership

| 事实 | 权威 |
|---|---|
| 当前模型可见 memory | Durable Session surface 与可见 memory event |
| Memory 内容与 revision | memory storage domain 中的 `MemoryState` |
| Conservative planner 准入资格 | 覆盖稳定 execution-scope digest 的已签署 rollout authorization |
| 产生 plan 的 planner 执行 | `ReviewAttempt` 保留的 provider request attestation |
| Curator 在单个 outcome 中的进度 | Durable ordinal、outcome digest、derivation version 与 signal coordinate |
| Corrupt-outcome coverage 状态 | Durable unresolved fault 及其 repair cursor |

## Alternatives considered

**让 memory plugin 在 `agent/pre-step` 期间 append 或 replace。** 这可能在后续 waterfall listener reject 或重写 decision 前写入 Session event。Loop 必须继续是被准入 pre-step message 的唯一 committer。

**跟踪 publication-dirty flag。** Memory CAS 之后、flag 写入之前的 crash 会丢失警告。比较 durable memory revision 与 durable visible snapshot 可以派生 staleness，无需另一权威。

**只授权 provider/model，或按 signed artifact 建 lane key。** 前者遗漏执行相关 request field；后者会在报告重新签署但受测执行未改时创建新 lane。Stable scope 拥有 lane identity，signed artifact 则证明已批准。

**跳过每个 oversized 或 corrupt outcome。** Oversized outcome 是有效的有界工作，并可能含正向证据。只有可定位的 corrupt item 可在记录 fault 后越过，且该 fault 会在修复前禁用基于 inactivity 的负向 transition。

**现在增加自动 orphan garbage collection。** 当前 quota 已防止无界增长。在 lineage、pending、reservation、review-attempt、quarantine 与 replay 语义完成规定前删除，会把有界 authoring unavailability 换成不可逆的 corruption 风险。

## Acceptance criteria

- 每个 request 至多包含一个 current memory-source authority；correction、removal、compaction、publication failure 与 replay 均保持该规则。
- Conservative claim 只能存在于已授权的稳定 execution scope，actual-attestation mismatch 不产生 immutable plan、cursor advance 或 resource mutation。
- Planner 看不到普通 tool，并在 isolated prompt 下恰好完成一次 scoped `structured_output` 调用。
- Oversized finalized outcome 最终结算所有确定 batch，且不阻塞下一 ordinal。
- 已记录的 corrupt-item fault 允许后续正向证据，但在 exact repair 完成前阻止 active-to-stale 和 stale-to-archived transition。
- P2 authoring 在不引入受支持 physical-delete path 的前提下保持有界并 fail closed。

## Risks

Generic surface-intent carrier 扩大了 Agent Loop API，并要求每个重写已准入 message 的 listener 在同一 decision 中保留、替换或删除相关 intent。缺失映射、孤立映射，或无效/重复 message identity 必须在 model request 前失败，而不是静默弱化 replacement provenance。

一些 remote planner provider 可能无法 attest 实际 request envelope 或暴露稳定 execution-profile digest。这些 provider 仍可用于 shadow evaluation，但不能执行 conservative durable learning。

未解决的 curator fault 可能无限期推迟 archival，而延后 orphan reclamation 可能最终让新 skill revision 在 quota 处停止。两种结果都会保留证据并 fail closed；operator diagnostics 必须指明需要人工介入的 exact fault 或 inventory。
