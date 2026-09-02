# RC5.5.5 附件 P1 — Memory Service 与 durable recall（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；前置：P0；包：`packages/util/content-scan`、`packages/memory/memory`，以及通用 `agent`/`agent-loop` surface-intent 小扩展；日期：2026-09-02。
>
> 当前代码状态：content-scan、memory types/domain/fold 与第一版 Service/Publisher 已提交。RC5.5.5 不改变RC5.5.4已闭合的P1函数拓扑；Publisher 的 latest-log lookup、append-only 与 stale fail-open 语义必须在 P1-R3 前替换为 current-surface 协议。

## 1. 模块布局

```text
packages/memory/memory/src/
  types.ts       # branded ids、discriminated ops、state/publication/config types
  domain.ts      # domain spec、zod、scope keys、typed errors
  config.ts      # resolve/validate config + worst-case publication bound
  fold.ts        # ids/digests/budget/fold/finalized-receipts/publication pure helpers
  service.ts     # MemoryService（唯一 domain opener）
  publisher.ts   # visible-surface lookup + publication decision + MemoryPublisher
  index.ts       # Service default export、MessageSourceMap、装配/re-export
packages/util/content-scan/src/
  index.ts       # scanContent、MAX_SCAN_CHARS、PATTERN_SET_VERSION
packages/core/agent/src/runtime-types.ts      # PreStepDecision surface intents
packages/core/agent-loop/src/agent.ts         # final decision 的唯一 surface-intent committer
```

## 2. 类型契约

```text
ProjectKey = Branded<'ProjectKey'>
UserKey = Branded<'UserKey'>
MemoryScope = {kind:'project',projectKey:ProjectKey} | {kind:'user',userKey:UserKey}
OpId = Branded<'OpId'>
MemoryEntryId = Branded<'MemoryEntryId'>
MemoryEntry = {id,content,kind?,evidence?,createdAt,updatedAt,createdByOpId,lastAppliedOpId}
AddMemoryOp = {action:'add',opId,entryId,now,content,kind?,evidence?}
UpdateMemoryOp = {action:'update',opId,entryId,expectedEntryDigest,now,content,kind?,evidence?}
RemoveMemoryOp = {action:'remove',opId,entryId,expectedEntryDigest,now,evidence?}
HostMemoryOp = AddMemoryOp | UpdateMemoryOp | RemoveMemoryOp
MemoryPreview = {baseRevision,resultingRevision,results,publication}
AppliedOpReceipts = {pendingReceipts:OpReceipt[],recentTerminalReceipts:BoundedRing}
MemoryState = {schemaVersion:1,revision,entries,appliedOps}
AvailableMemorySnapshot = {kind:'memory',form:'snapshot',status:'available',sections,
                           scopes:[{scope,revision}],publicationProtocolDigest,digest}
MemoryUnavailableSnapshot = {kind:'memory',form:'snapshot',status:'unavailable',
                             sections:[fixedSection],publicationProtocolDigest,reasonCode}
MemorySurfaceSnapshot = AvailableMemorySnapshot | MemoryUnavailableSnapshot
VisibleMemorySnapshot = {seq,snapshot:MemorySurfaceSnapshot}
PreStepSurfaceIntent = {messageId:MessageId,intent:SurfaceIntent}
MemoryConfig = {maxEntries,maxStoredChars,maxEntryChars,maxSnapshotTokens,
                publisherEnabled,receiptWindowSize}
```

`MemoryScope.user` 没有无 key 分支，domain key 必须是 `user/<UserKey>`。P1 shipped pipeline 只启用 project；L2 若没有 principal provider，不得构造 `UserKey`。

## 3. 开发拓扑

| 顺序 | 节点 | 只可调用 |
|---:|---|---|
| P1-D01 | types + domain schema + `initialMemoryState/scopeKeyOf/asProjectKey` | dsh-brand、storage-domain schema API |
| P1-D02 | `maxRenderedSnapshotChars` | D01、content-scan constants |
| P1-D03 | `validateMemoryConfig` | D01–D02、content-scan constants |
| P1-D04 | `deriveEntryId/memoryEntryDigest/memoryResultDigest` | D01、crypto |
| P1-D05 | `enforceBudget` | D01 |
| P1-D06 | `placeDirectReceipts/splitFinalizedReceipts` | D01 |
| P1-D07 | `foldMemoryOps` | D04、D05 |
| P1-D08 | `sanitizeForPublication` | content-scan、D01 |
| P1-D09 | `buildSnapshotSections` | D01、D02 的同一 token estimate |
| P1-D10 | `computeScopePublication/computeCompositeDigest` | D01、D04 canonical helper、D09 output |
| P1-D11 | `buildAvailableMemorySnapshot/buildUnavailableMemorySnapshot` | D10、publication protocol constant |
| P1-D12 | `evaluateMemoryOps` | D04–D11、scanContent |
| P1-D13 | `resolveMemoryScope` | D01、既有 findProjectRoot/fs.resolve |
| P1-D14 | `MemoryService.previewOps/applyOps/applyDirectOps/acknowledgeFinalizedOps` | D03、D06、D12–D13、storage domain |
| P1-D15 | generic `PreStepSurfaceIntent` carrier + agent-loop commit | existing PreStepDecision、Session.SurfaceIntent |
| P1-D16 | `findVisibleMemorySnapshot` | existing `session.surface.nodes`、durable events、message source |
| P1-D17 | `decideMemoryPublication` | D01、D10–D11、D16 |
| P1-D18 | `MemoryPublisher` | D08–D17 |
| P1-D19 | package assembly | D14、D18、MessageSourceMap |

实现与测试必须按 D01→D19。D03 必须复用 D02；D14 不能先手写 budget/digest/receipt 逻辑；D18 不能复制 Service scope 解析或直接调用 `session.append`。D15 是 D18 的提交前置，D16/D17 是 D18 的权威判断前置。

## 4. 叶子与纯函数规格

#### `initialMemoryState(): MemoryState` / `scopeKeyOf(scope): MemoryScopeKey` / `asProjectKey(digest): ProjectKey`
- 拓扑：P1-D01。
- 职责：fresh state；project/user keyed records；brand construction。`scopeKeyOf({kind:'user'})` 在类型层不存在。
- 验收：`initial-state-versioned-empty`、`scope-keys-isolate-projects`、`user-scope-key-requires-user-key`、`two-user-keys-isolate`。

#### `maxRenderedSnapshotChars(config, enabledScopes): number`
- 拓扑：P1-D02。
- 职责：给出 renderer 的可证明上界，包含每 scope 固定 header/name、`maxEntries` 个 id 前缀与换行、`maxStoredChars` 内容、最长可能 backtick fence 两份、blocked placeholder 最大固定文本；两 scope 时分别计入，不能只乘原始内容。
- 验收：`bound-includes-header-id-newlines`、`bound-includes-worst-fence`、`bound-includes-all-enabled-scopes`、`actual-render-never-exceeds-bound-property`。

#### `validateMemoryConfig(config, enabledScopes): ResolvedMemoryConfig`
- 拓扑：P1-D03；调用 D02 `maxRenderedSnapshotChars`。
- 职责：所有整数/布尔字段 fail-loud；`maxEntryChars <= MAX_SCAN_CHARS`；`maxStoredChars >= maxEntryChars`；receipt window 正整数；`maxSnapshotTokens` 不小于同一 token estimator 对最坏字符上界的结果。P1 装配固定 `enabledScopes=['project']`；L2 必须以 project+user 重验。
- 验收：`memory-entry-limit-above-scan-cap-fails-load`（T81）、`invalid-memory-budget-combination-fails-load`（T78）、`snapshot-budget-includes-render-overhead`、`composite-budget-includes-all-enabled-scopes`、`exact-valid-config-passes`。

#### `deriveEntryId(opId): MemoryEntryId`
- 拓扑：P1-D04。
- 职责：domain-separated deterministic hash；只用于 add。
- 验收：`derive-deterministic`、`derive-distinct-ops-distinct-ids`。

#### `memoryEntryDigest(entry): string`
- 拓扑：P1-D04。
- 职责：canonical digest 当前完整 entry record；planner view、fold exact CAS 与 governance 共用。任何可变字段变化都改变 digest。
- 验收：`entry-digest-key-order-stable`、`entry-digest-changes-on-every-mutable-field`、`entry-digest-repeat-stable`。

#### `memoryResultDigest(op, resultingEntry?): string`
- 拓扑：P1-D04。
- 职责：receipt 的资源执行结果摘要；不是 ReviewPlan identity。原 `canonicalOpDigest(HostMemoryOp)` 在 RC5.5.5 对齐前已改名，禁止 P3 调用。
- 验收：`memory-result-digest-stable`、`memory-result-digest-not-plan-identity`（T76）。

#### `enforceBudget(nextState, config): void`
- 拓扑：P1-D05。
- 职责：严格检查 maxEntries/maxStoredChars/maxEntryChars；相等通过；remove 不增长但最终 state 仍合法。publication 可达性由 load-time config 证明，不在每 op 重做最坏证明。
- 验收：`budget-add-over-limit`、`budget-entry-chars`、`budget-remove-exempt`、`budget-exact-limit`、`budget-inventory-in-error`。

#### `placeDirectReceipts(appliedOps,opIds,windowSize): AppliedOpReceipts` / `splitFinalizedReceipts(appliedOps,finalizedOpIds,windowSize): AppliedOpReceipts`
- 拓扑：P1-D06。
- 职责：`placeDirectReceipts` 只处理同一 RMW 刚应用的 direct op：new pending→terminal ring；已在 terminal→幂等；此前已在 pending 的 op 表示误用 review identity，`invalid_structure`。`splitFinalizedReceipts` 只接受 P3 ledger 已 finalized 且 opState 为 applied|duplicate 的 review op：pending→ring；already ring→幂等；两无也是幂等 no-op，因为 finalized 后的旧 ring receipt 可能已合法淘汰。空 op id、无效 scope/group 仍拒绝。未 finalized review op 不调 finalized split，故一直留 pending且不淘汰；ring FIFO 有界。
- 验收：`direct-new-pending-moves-to-ring-same-fold`、`direct-existing-review-pending-fails`、`direct-terminal-replay-idempotent`、`split-finalized-moves-pending-to-ring`、`split-unfinalized-pending-never-evicted`、`split-ring-evicts-oldest`、`split-10k-finalized-mutations-bounded-ring`、`split-finalized-reack-idempotent`、`split-finalized-after-ring-eviction-is-noop`（T85）、`split-empty-opid-fails`。

#### `foldMemoryOps(state, ops, config): {nextState,results}`
- 拓扑：P1-D07；调用 D04/D05。
- 职责：整 batch 纯折叠；pending∪terminal receipt duplicate 检查先于 base/target；add 要求 `entryId===deriveEntryId(opId)` 且不存在，写 `createdByOpId=lastAppliedOpId=opId`；update 保留 `createdByOpId/createdAt`、只更新 `lastAppliedOpId/updatedAt`；update/remove 要求 target 存在且 `memoryEntryDigest(current)===expectedEntryDigest`；未知为 `unknown_entry`，digest 失配为 `stale_entry_digest`；新 op 暂入 pending，Service 决定是否同 RMW terminalize；有实际应用才 revision+1。
- 验收：`fold-add-update-remove`、`fold-add-id-must-be-derived`、`fold-add-records-created-by-op`、`fold-update-preserves-creation-provenance`、`fold-duplicate-before-entry-digest`、`fold-update-exact-digest`（T73）、`fold-remove-exact-digest`（T73）、`fold-unknown-entry-rejects`、`fold-stale-entry-digest-rejects`、`fold-budget-integration-batch`、`fold-new-op-goes-pending`。

#### `sanitizeForPublication(entries): PublicationEntry[]`
- 拓扑：P1-D08。
- 职责：每 entry 读边界重扫；blocked 只输出不含原文的固定 placeholder；caution 放行；不修改 state。
- 验收：`sanitize-safe-passthrough`、`sanitize-blocked-placeholder`、`sanitize-caution-passes`、`sanitize-pure-no-state`、`attack-at-last-allowed-character-is-scanned`（T81）。

#### `buildSnapshotSections(perScope, config): ContextSnapshotSection[]`
- 拓扑：P1-D09。
- 职责：稳定 scope/entry 顺序；模型可见 entry 行只渲染 id prefix + content，kind/evidence/provenance 留给治理与 planner current view，因而 D02 字符上界与真实 renderer 字段一致；动态 fence；不截断；实际 token 超限是 `budget_exceeded` invariant failure。普通 admitted state 在 D02 load proof 下不应走此失败。
- 验收：`render-empty`、`render-stable-order`、`render-never-truncates`、`render-fence-pinned`、`render-blocked-placeholder-no-raw-payload`、`render-two-scopes-two-sections`、`every-admitted-memory-state-is-publishable`（T78 property）。

#### `computeScopePublication(state, entries): ScopePublication` / `computeCompositeDigest(sections, scopes): string`
- 拓扑：P1-D10。
- 职责：scope coordinate digest 覆盖 revision 与 sanitized publication projection；composite digest 覆盖有序 sections/scopes。
- 验收：`scope-digest-changes-with-publication`、`digest-order-sensitive`、`digest-identical-state-identical`、`digest-scope-field-participates`。

#### `buildAvailableMemorySnapshot(sections,scopes): AvailableMemorySnapshot` / `buildUnavailableMemorySnapshot(reasonCode): MemoryUnavailableSnapshot`
- 拓扑：P1-D11；调用 D10 `computeCompositeDigest`。
- 职责：available 只组 immutable payload，digest 必须由 exact 输出 sections/scopes 计算，不接受 caller 提供 digest，并持久化每个 scope revision 与 `PUBLICATION_PROTOCOL_DIGEST`。unavailable 使用固定 section 与固定 protocol digest，只接受 typed reason code，不接受旧 payload、caller text 或旧 digest。
- 验收：`snapshot-build-computes-own-digest`、`snapshot-build-does-not-mutate-input`、`available-snapshot-binds-scope-revisions-and-protocol`、`unavailable-snapshot-is-fixed-and-payload-free`（T87）。

#### `evaluateMemoryOps(state,ops,expectedBaseRevision,mode,config): MemoryEvaluation`
- 拓扑：P1-D12；调用 D04–D11 与 `scanContent`。
- 职责：Service 的唯一 mutation evaluator：duplicate-before-base → write-boundary full scan → D07 fold/budget → resulting publication reachability；review mode 保留新 receipt pending，direct mode调用 D06 `placeDirectReceipts`。返回 next state/result/preview，不做 I/O。preview 与正式 RMW 必须调用同一函数，禁止各自复制判断。
- 验收：`evaluate-duplicate-before-base`、`evaluate-scan-before-fold`、`evaluate-review-keeps-pending`、`evaluate-direct-terminalizes-same-result`、`evaluate-resulting-state-publishable`、`evaluate-pure-no-input-mutation`。

## 5. I/O 壳规格

#### `resolveMemoryScope(agent, requestedKind): Promise<MemoryScope>`
- 拓扑：P1-D13。
- 职责：project = `findProjectRoot(cwd,ctx.fs)` → `ctx.fs.resolve(root)` → hash whole targetKey；local backend only；诊断返回 identity source `git-root|cwd-fallback`。user 必须显式传 `UserKey` 的未来入口，P1 调用 user 直接 `principal_required`。
- 验收：`resolve-scope-project`、`resolve-scope-alias-same-key`、`resolve-scope-remote-backend-fail-loud`、`resolve-scope-non-git-diagnoses-cwd-fallback`、`resolve-user-without-principal-fails-loud`。

#### `class MemoryService extends Service`
- 拓扑：P1-D14；唯一 memory domain opener；构造先调用 D03 config 验证；所有 mutation path 调 D12。
- `getState(scope)`：ensure first record 后读 immutable state。
- `previewOps(scope, ops, expectedBaseRevision)`：**review admission 专用的只读预检**；在同一 state snapshot 上执行 duplicate-before-base、写边界 scan、fold、budget 与 publication reachability，返回 `MemoryPreview`，不写 state/receipt/publication。它与 `applyOps` 共用一个内部 `evaluateOps` helper，不允许复制验证逻辑。预检后的并发竞态仍由正式写的 expected base 捕获，返回 stale 给 P3 supersede；preview 不是预留或事务锁。
- `applyOps(scope, ops, expectedBaseRevision)`：**review path**；一个 table.update RMW 内 duplicate-before-base、write scan、fold，保留新 receipt pending。
- `applyDirectOps(scope, ops, expectedBaseRevision)`：**tool/command path**；同一 RMW 内完成 apply + terminalize；调用前若 direct op id 已在 pending，报 `invalid_structure`，防止误终结 review op；已在 terminal ring 的重放返回 duplicate。
- `acknowledgeFinalizedOps(groups)`：只供 P3 ledger 已 finalized 后的 receipt cleanup；按 scope 调 `splitFinalizedReceipts`，输入只有 applied|duplicate opStates；重复 cleanup 和 ring 已淘汰都成功。未 finalized 的 caller 不得调用；P1 不导入 P3，该前置由 host service 的调用顺序保证。
- 验收：`memory-service-single-registration`（T42）、`previewops-matches-apply-validation`、`previewops-never-writes-state-or-receipt`、`previewops-includes-publication-reachability`、`previewops-race-still-fails-apply-base`、`applyops-first-record-creates`、`applyops-duplicate-before-stale`、`applyops-scan-blocks-write`、`applyops-atomic-batch`、`applyops-scope-isolation-project-user`、`direct-op-enters-terminal-ring-same-rmw`（T80）、`direct-op-never-leaves-pending`、`direct-op-cannot-terminalize-review-pending`、`finalized-ack-moves-receipts`、`finalized-ack-scoped-groups-isolate`、`finalized-ack-retry-after-eviction-idempotent`（T85）、`schema-version-mismatch-passthrough`。

#### generic `PreStepSurfaceIntent` carrier + agent-loop commit
- 拓扑：P1-D15；只调用既有 `Session.append(..., SurfaceIntent)`。
- 职责：`PreStepDecision.kind='enter'` 必须携 `surfaceIntents: readonly {messageId,intent}[]`，与 final `messages` 按 `MessageId` 构成完整一对一映射；loop 的 base decision 为每条 claimed message 显式生成 append intent，不存在“缺失即默认 append”的兼容语义。agent-loop 在最终 waterfall decision、abort check 与 `step/start` 之后，按 message id 为每条 admitted message 取 exact intent 并调用 `session.append`。缺失 intent、同一 id 重复 intent、intent 引用 final messages 中不存在的 id、同一 id 出现两条 final message 或非法 replacement 都在任何 model request 前 fail-loud。reject 不产生 surface event；pre-step listener 删除 message 时必须同时删除其 intent，保留 message 时必须保留或显式替换其 intent。该扩展只负责原子提交位置，不知道 memory producer。
- 验收：`prestep-surface-intent-replaces-current-node`（T87）、`base-prestep-decision-assigns-explicit-append-intents`、`missing-intent-for-final-message-fails-before-request`、`rejected-final-decision-commits-no-surface-intent`、`removed-message-cannot-leave-orphan-intent`、`unknown-or-duplicate-intent-message-id-fails-before-request`、`outer-waterfall-preserves-or-explicitly-replaces-surface-intents`、`replacement-append-reconstructs-identically-on-replay`。

#### `findVisibleMemorySnapshot(session): VisibleMemorySnapshot | undefined`
- 拓扑：P1-D16。
- 职责：只遍历 `session.surface.nodes` 并读取对应 durable event；只认 source kind memory + form snapshot + RC5.5.5 publication schema，校验 available/unavailable discriminant、protocol digest、scope revision 与 payload digest。历史 log 中已被 replacement/compaction shadow 的 memory event不算 visible。零项返回 undefined；两项及以上是 pre-release incompatible state，返回 `invalid_structure`，不得用跨非连续 range 的 replacement 擦除中间会话消息。
- 验收：`visible-memory-derived-from-session-surface`（T87）、`shadowed-log-memory-is-not-visible`、`compaction-shadowed-memory-returns-undefined`、`malformed-visible-memory-fails-loud`、`multiple-visible-memory-nodes-fail-loud`、`non-memory-surface-nodes-ignored`。

#### `decideMemoryPublication(visible,outcome): MemoryPublicationDecision`
- 拓扑：P1-D17；调用 D10/D11 输出并消费 D16 typed visible value，不做 I/O。
- 职责：outcome 是 available snapshot 或 typed unavailable failure。无 visible + available → append；有 visible + 不同 available authority → replace exact visible seq，并令 `sourceEventSeqs` 包含该 seq；相同 status/protocol/scope revisions/digest → no-op。无 visible + failure → no-op；visible available + failure → replace 为 fixed unavailable snapshot；visible unavailable + failure → no-op；visible unavailable + available → replace 恢复。unavailable sections 是版本固定文本，只含 reason code，不含旧 sections/content/digest。被 compaction shadow 后 visible 为 undefined，available digest 即使等于历史值也 append。
- 验收：`first-memory-publication-appends`、`changed-memory-replaces-visible-node`（T87）、`replacement-cites-shadowed-memory-node`、`unchanged-authority-is-noop`、`compaction-shadowed-memory-republishes-even-if-digest-equal`（T87）、`visible-memory-failure-replaces-with-unavailable`、`no-visible-memory-failure-is-noop`、`unavailable-never-contains-stale-payload`、`available-replaces-unavailable-on-recovery`。

#### `class MemoryPublisher`
- 拓扑：P1-D18；依次调用 D16 visible lookup → D14 getState → D08 sanitize → D09 sections → D10/D11 available snapshot → D17 publication decision，并用 D15 carrier 返回最终 pre-step decision。
- `maybePublish(agent,decision)`：只在 pre-step body生成 project-only P1 publication。它不直接 append session。available snapshot 持久化 exact scope revision 与 `PUBLICATION_PROTOCOL_DIGEST`；storage/read/scan/render failure 记录 typed operational failure并把 D17 unavailable decision交给 loop，Agent 可继续但旧 memory authority不得保留。`budget_exceeded` 若源于已验证 config/state 是 invariant alert；同样先清除无法证明为 current 的 visible authority。若 final decision 被 reject 或外层删除该 message，loop 不提交 intent。
- 验收：`publish-changed-returns-one-replacement-intent`、`publish-unchanged-silent`、`publish-project-only-change-one-message`、`publish-secondary-scan-blocked-placeholder`、`publisher-read-failure-invalidates-visible-memory`（T87）、`deterministic-publication-failure-surfaces-invariant-and-invalidates-stale`（T78/T87）、`publish-never-mid-turn-or-direct-appends`、`publish-reconstructable-from-log`、`publish-resume-byte-stable-prefix`、`correction-next-derived-request-has-one-current-memory-authority`（T80/T87）、`remove-next-provider-request-memory-source-omits-old-assertion`（T80）。旧事实可能作为 user correction 原文存在于会话 history；测试只断言 memory source authority 不再主张它，不对整份 request 做错误的字符串零出现断言。

#### `default MemoryService` + publisher assembly
- 拓扑：P1-D19。
- 职责：Service/provider effect-scoped 注册、MessageSourceMap 合并 `'memory'` available/unavailable union、pre-step listener 始终调用 `next()`；P1 配置启用 project scope一项。agent-loop 通用扩展同步更新 architecture、API catalog 与受影响 expected outputs，不把 memory policy写进 loop。
- 验收：`loader-registers-memory-source-kind`、`loader-opens-domain-once`、`waterfall-delegates-on-success-and-failure`、`hmr-disposes-service-and-publisher`、`loop-has-no-memory-specific-branch`。

## 6. Config 与 Phase 出口

Config 数值全带 JSDoc、显式默认或 required；禁止在 `run()` 内 `??` 隐式默认。`publisherEnabled` 的既定默认为 true；其余默认若需要必须在 schema 与 README 同一处声明。`receiptWindowSize` 只约束 finalized/direct terminal ring，不得用于尚未 finalized 的 review pending。

Phase 出口：RC5.5.5 对齐测试 + 原附件测试全绿；per-file 100%；REAL boot 证明单 Service、current-surface append/replace、compaction 后 republish、读失败 unavailable 与 direct governance；keyless snapshot 覆盖 correction/remove 后 memory authority 消失、replay 恰一个 current authority；README/Agent Note 说明 scanner 非完备、non-Git cwd、user principal、receipt 生命周期、surface ownership 与 unavailable 语义。D15 的 agent/loop API 变更同步更新 `docs/architecture.md`、生成 API catalog、必要双 SDK expected outputs；P1 未完成前不得进入 P2。
