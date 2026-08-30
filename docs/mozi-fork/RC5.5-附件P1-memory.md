# RC5.5 附件 P1 — Memory Service + durable recall（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.5-方案.md`（第六轮 S1-1/S1-2/S1-4/S1-12、S2-3；第七轮 S1-5）。
>
> 包：`packages/memory/memory` + `packages/util/content-scan`。前置：P0 全绿。
>
> 相对 RC5.3-P1：单一 Service 内部双逻辑 scope（不再双实例组合）；composite Publisher 单消息双节；receipt 二分 + ack 协议；project 身份走 `ctx.fs.resolve().targetKey`。相对 RC5.4-P1（第七轮 S1-5）：`acknowledgeTerminalOps` 改 scope 分组签名且幂等——in pending 迁移、已在环 duplicate-ack 成功、两无 `invalid_structure`。相对 RC5.5-P1（第八轮）：opId 由 P3 `deriveOpId` 纯派生供给（T62/T63）——`HostMemoryOp.opId` 与 `deriveEntryId(opId)` 由此获得跨恢复稳定性，receipt 查重在 crash/recovery 后成立；ack 调用输入来自 P3 的 applied-only `opStates`（第八轮 S1-4），P1 侧签名不变。RC5.5.2 修补：§3 正文一处残留的"按 plan memory op 分组"措辞更正为 applied-only opStates（与本行一致，消除文件内自相矛盾）。
>
> 日期：2026-08-29（RC5.5.1 增补 2026-08-30；RC5.5.2 修补 2026-08-30）

## 1. 模块布局

```text
packages/memory/memory/
  src/index.ts      # 插件装配（单一 Service；域内存 project/user 两逻辑 scope）
  src/types.ts      # 仅类型
  src/domain.ts     # memory domain spec（schemaVersion:1）+ 记录 zod + receipt 二分记录
  src/fold.ts       # foldMemoryOps / enforceBudget / splitReceipts / sanitizeForPublication /
                    # buildSnapshotSections / computeSnapshotDigest（纯）
  src/publisher.ts  # MemoryPublisher（composite，pre-step，fail-open）
  src/service.ts    # MemoryService extends Service
packages/util/content-scan/
  src/index.ts      # scanContent(text, scope)；导出 PATTERN_SET_VERSION
  src/patterns.ts   # 模式数据
tests/corpus/       # positive / benign / 中文改写 / code-block-vs-imperative 四语料
```

## 2. 类型契约

```text
MemoryScope = { kind:'project', projectKey: ProjectKey } | { kind:'user' }
MemoryEntryId = Branded<string,'MemoryEntryId'>
HostMemoryOp = { opId, entryId, now, action:'add'|'update'|'remove', content?, kind?, evidence? }
AppliedOpReceipts = { pendingReceipts: OpReceipt[],       // non-terminal attempt 的 op，永不 FIFO
                      recentTerminalReceipts: BoundedRing // terminal ack 后入环，仅此区可 GC
                    }
TerminalAckGroup = { scope: MemoryScope, opIds: readonly OpId[] }  // ack 分组定位（S1-5）
MemoryState = { schemaVersion:1, revision, entries: MemoryEntry[], appliedOps: AppliedOpReceipts }
ApplyOpResult = { opId, status:'applied'|'duplicate', resultDigest? }
PublicationEntry = { kind:'safe', entry } | { kind:'blocked', entryId, reason }
CompositeMemorySnapshot = { kind:'memory', form:'snapshot', sections: ContextSnapshotSection[],
                            scopes:{ project?:{revision,digest}, user?:{revision,digest} },
                            digest }                          // 一个 producer，P1 只填 project
MemoryConfig = { maxEntries, maxStoredChars, maxEntryChars, maxSnapshotTokens,
                 publisherEnabled, receiptWindowSize }         // 只约束 recentTerminal 环
```

## 3. 函数规格

#### `resolveMemoryScope(agent, config): Promise<MemoryScope>`
- 职责：project 分支 = `findProjectRoot(cwd)` → `ctx.fs.resolve(root)` → `ProjectKey = hash(targetKey)`（S1-4；键整 hash 不解析，E0-12：非 local backend fail-loud）；user 分支无 root。
- 验收：`resolve-scope-project`、`resolve-scope-user`、`resolve-scope-alias-same-key`、`resolve-scope-remote-backend-fail-loud`。

#### `deriveEntryId(opId): MemoryEntryId`
- 验收：`derive-deterministic`、`derive-distinct-ops-distinct-ids`。

#### `enforceBudget(nextState, config): void`
- 职责：超 `maxEntries/maxStoredChars/maxEntryChars` 抛 `budget_exceeded` 附现库存（remove 豁免；边界精确）。
- 验收：`budget-add-over-limit`、`budget-entry-chars`、`budget-remove-exempt`、`budget-exact-limit`、`budget-inventory-in-error`。

#### `foldMemoryOps(state, ops, config): { nextState, results }`
- 职责：纯折叠。receipt 查重（pending ∪ recentTerminal 命中 → duplicate 返回原 digest，不查 base）；未应用 → budget → 应用 → 写入 **pendingReceipts**（新 op 一律先 pending，S1-12）；revision+1。
- 验收：`fold-add-update-remove`、`fold-duplicate-before-base-check`、`fold-budget-integration-batch`、`fold-unknown-entry-rejects`、`fold-new-op-goes-pending`。

#### `splitReceipts(appliedOps, terminalOpIds, windowSize): AppliedOpReceipts`
- 职责：纯函数，逐 `terminalOpId` 三分（S1-5 幂等语义）：在 pending → 迁入 recentTerminal 环（FIFO 淘汰超窗最旧）；已在环 → duplicate-ack no-op（crash 后重放安全）；两处皆无 → `invalid_structure`（ack 早于 terminal 或 op 从未应用，fail-loud）。非 terminal 的 pending **永不迁出、永不淘汰**（T52）。
- 验收：`split-ack-moves-to-ring`、`split-pending-never-evicted`（T52）、`split-ring-evicts-oldest`、`split-10k-mutations-bounded-ring`、`split-reack-idempotent`（T58）、`split-orphan-opid-fails`。

#### `sanitizeForPublication(entries): PublicationEntry[]`
- 验收：`sanitize-safe-passthrough`、`sanitize-blocked-placeholder`、`sanitize-caution-passes`、`sanitize-pure-no-state`。

#### `buildSnapshotSections(perScope: { scope, entries: PublicationEntry[] }[], config): ContextSnapshotSection[]`
- 职责：**composite**——project（P1）与 user（L2）各渲染一节（节名按 scope 参数化）；blocked 渲 `[BLOCKED: reason]`；围栏钉死；不截断，超 `maxSnapshotTokens` 抛 `budget_exceeded`。
- 验收：`render-empty`、`render-stable-order`、`render-never-truncates`、`render-fence-pinned`、`render-blocked-placeholder-no-raw-payload`、`render-two-scopes-two-sections`。

#### `computeCompositeDigest(sections, scopes): string`
- 验收：`digest-order-sensitive`、`digest-identical-state-identical`、`digest-scope-field-participates`。

#### `scanContent(text, scope): ThreatFinding[]`
- 验收：`scan-invisible`、`scan-nfkc`、`scan-cn-phrasing-corpus`、`scan-ascii-artifacts`、`scan-benign-corpus-zero-hit`、`scan-codeblock-vs-imperative-corpus`、`scan-cap-64k`、`scan-clean`。

#### `class MemoryService extends Service`（唯一 memory 域 opener，T42）
- `getState(scope): Promise<MemoryState>` — `ensureInitialized` 后读。
- `applyOps(scope, ops, expectedBaseRevision): Promise<ApplyOpsResult>` — 单 RMW 闭包：receipt 查重先于 base 检查；写边界扫描（blocked → `threat_scan_blocked`）；折叠提交（新 op 入 pending）。
- `acknowledgeTerminalOps(groups: readonly TerminalAckGroup[]): Promise<void>` — S1-12 + S1-5：逐组读改写对应 scope 的 appliedOps（`splitReceipts` 幂等三分）；由 session-review 在 attempt 达 terminal 时调用（分组输入 = `ReviewAttempt.opStates[]` 中 `state ∈ {applied, duplicate}` 的 memory op 按 target/scope 分组——applied-only，非 plan 全量，第八轮 S1-4/T66），terminal-recovery 重放时重复调用安全（T58）；ack 缺失 = 过量保留（安全方向），无早 ack 路径（两无 opId 仍 `invalid_structure`）。
- 验收：`applyops-first-record-creates`、`applyops-duplicate-before-stale`、`applyops-mixed-duplicate-stale-rejects-whole`、`applyops-scan-blocks-write`、`applyops-atomic-batch`、`applyops-scope-isolation-project-user`（T42 关联）、`schema-version-mismatch-passthrough`、`ack-terminal-ops-moves-receipts`（T52）、`ack-scoped-groups-isolate`、`ack-retry-idempotent`（T58）、`ack-orphan-group-invalid-structure`。

#### `latestPublishedMemory(session): { digest, seq } | undefined`
- 验收：`latest-prefers-highest-seq`、`absent-undefined`、`ignores-non-memory`。

#### `class MemoryPublisher`（composite，fail-open）
- `maybePublish(agent, decision): Promise<void>` — pre-step 体内：读两 scope state → sanitize → buildSnapshotSections → `computeCompositeDigest` → 比对 `latestPublishedMemory` → 变更才发布**一条** `CompositeMemorySnapshot` 消息（T43：无跨 scope churn）；任何异常记日志放行 `next()`。
- 验收：`publish-changed-exactly-one`、`publish-unchanged-silent`、`publish-project-only-change-one-message`（T43）、`publish-secondary-scan-blocked-placeholder`、`publish-secondary-scan-original-retained`、`publish-sanitize-before-render`、`publish-fail-open-on-storage-error`、`publish-never-mid-turn`、`publish-reconstructable-from-log`、`publish-resume-byte-stable-prefix`。

## 4. Config（schemastery，required 无静默默认；`publisherEnabled` 默认 true）

user scope section 与其启用排 L2——本 Phase 类型与发布管线就位、`scopes.user` 恒缺省；bounded consolidation 的 planner 侧接线在 P3（`maxConsolidationAttempts` 默认 2），MemoryService 不内嵌 LLM。

## 5. 验收门（Phase 出口）

附件测试全绿 + per-file 100% 覆盖；REAL boot（Loader 场景断言 composite snapshot 消息 + fail-open + 单 Service 双 scope）；`MessageSourceMap` 登记 `memory` kind（`CompositeMemorySnapshot`）+ 双 SDK expected outputs；回放重建零重复发布；schemaVersion + 显式 reset/migrate 入口；README（Model Experience + Known Limitations：中文锚点声明集非完备集、caution 不阻断、user 节 L2、receipt 保留协议）+ Agent Note。
