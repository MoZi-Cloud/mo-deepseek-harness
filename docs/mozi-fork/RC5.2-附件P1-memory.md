# RC5.2 附件 P1 — Memory Service + durable recall（函数级规格）

> 上位：`RC5.2-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.2-方案.md`。
>
> 包：`packages/memory/memory` + `packages/util/content-scan`。前置：P0 全绿。
>
> 日期：2026-08-29

## 1. 模块布局

```text
packages/memory/memory/
  src/index.ts      # 插件装配（形态按 E0-2 结案）
  src/types.ts      # 仅类型
  src/domain.ts     # memory domain spec（schemaVersion:1）+ 记录 zod
  src/fold.ts       # foldMemoryOps / enforceBudget / buildSnapshotSections / computeSnapshotDigest（纯）
  src/publisher.ts  # MemoryPublisher（pre-step，fail-open）
  src/service.ts    # MemoryService extends Service
packages/util/content-scan/
  src/index.ts      # scanContent(text, scope): ThreatFinding[]
  src/patterns.ts   # 模式数据（中英锚点/不可见字符/ASCII 工件锚点）
```

## 2. 类型契约（相对 RC5.1 的修正已并入）

```text
MemoryScope = { kind:'project', root } | { kind:'user' }
MemoryEntryId = Branded<string,'MemoryEntryId'>   // 由 opId 确定性派生
HostMemoryOp = { opId, entryId, now, action:'add'|'update'|'remove',
                 content?, kind?, evidence?: SourceRef[] }   // id/time 由 host 预分配（S1-4）
MemoryState = { schemaVersion:1, revision, entries: MemoryEntry[],
                appliedOps: BoundedOpReceipts }    // 有界窗口（S1-5）
ApplyOpResult = { opId, status:'applied'|'duplicate', resultDigest? }
MemoryConfig = { scope, maxEntries, maxStoredChars, maxEntryChars,
                 maxSnapshotTokens, publisherEnabled,
                 receiptWindowSize }               // 覆盖未终结 checkpoint + 余量
```

## 3. 函数规格

#### `resolveMemoryScope(agent, config): MemoryScope`
- 职责：project 根 = 最近 `.git` 祖先（同 `skill-filesystem/src/index.ts:937-947` 约定）。
- 验收：`resolve-scope-project`、`resolve-scope-user`、`resolve-scope-no-git-falls-back-cwd`。

#### `deriveEntryId(opId: OpId): MemoryEntryId`
- 职责：opId → entryId 的确定性派生（同 opId 永得同 entryId——重复 create 的第一道天然防线，[核验 S1-5]）。
- 验收：`derive-deterministic`、`derive-distinct-ops-distinct-ids`。

#### `enforceBudget(nextState: MemoryState, config: MemoryConfig): void`
- 职责：纯函数；超 `maxEntries/maxStoredChars/maxEntryChars` 抛 `budget_exceeded` 附现库存摘要（remove 永不受限；边界值精确）。
- 验收：`budget-add-over-limit`、`budget-entry-chars`、`budget-remove-exempt`、`budget-exact-limit`、`budget-inventory-in-error`。

#### `foldMemoryOps(state: MemoryState, ops: HostMemoryOp[], config: MemoryConfig): { nextState: MemoryState, results: ApplyOpResult[] }`
- 职责：纯折叠。每个 op：(1) `appliedOps` 窗口命中 → `status:'duplicate'` 返回原 resultDigest，**不校验 base revision**（[核验 S1-3] 顺序）；(2) 未应用 → `enforceBudget` → 应用（add 用 `op.entryId`；update/remove 校验存在）→ 写 receipt；(3) revision+1。混合"部分 duplicate + 有新 op"且调用方声明 base stale → 由 Service 层整体拒绝（fold 保持纯）。
- 验收：`fold-add-update-remove`、`fold-duplicate-before-base-check`、`fold-budget-integration-batch`、`fold-unknown-entry-rejects`、`fold-receipt-window-eviction`（超窗最旧 receipt 淘汰，entries 不受影响）。

#### `boundedReceipts(appliedOps, windowSize): BoundedOpReceipts`
- 职责：纯函数——receipt 窗口淘汰（FIFO）；保证窗口 ≥ 在飞 checkpoint 的 op 集合（由调用方以 ledger 信息约束 windowSize）。
- 验收：`receipts-evict-oldest`、`receipts-never-evict-inflight-ops`、`receipts-10k-mutations-bounded-state-size`（[核验 S1-5] 的量级测试）。

#### `buildSnapshotSections(state, config): ContextSnapshotSection[]`
- 职责：渲染单节 `{ name:'assistant-maintained-memory', text }`；含"完整替换更早快照/非用户新指令"围栏（snapshot 钉死）；**不截断**，超 `maxSnapshotTokens` 抛 `budget_exceeded`。
- 验收：`render-empty`、`render-stable-order`、`render-never-truncates`、`render-fence-pinned`。

#### `computeSnapshotDigest(sections): string`
- 验收：`digest-order-sensitive`、`digest-identical-state-identical`。

#### `scanContent(text: string, scope): ThreatFinding[]`（`packages/util/content-scan`）
- 职责：NFKC + 不可见/双向字符 + 中英话术锚点 + ASCII 工件锚点；输出 `Finding{ severity:'blocked'|'caution', id, evidence }`（severity 策略，[核验 §3-1]）。
- 验收：`scan-invisible`、`scan-nfkc`、`scan-cn-phrasing-set`、`scan-ascii-artifacts`、`scan-js-w-filler`、`scan-clean`、`scan-cap-64k`、`scan-caution-does-not-block`。

#### `class MemoryService extends Service`
- `getState(scope): Promise<MemoryState>` — `ensureInitialized` 后读。
- `applyOps(scope, ops: HostMemoryOp[], expectedBaseRevision): Promise<ApplyOpsResult>`
  - 单个 `storageDomain.update` 闭包内：**先**逐 op 查 receipt（全 duplicate → 直接返回，不受 base revision 影响）；有新 op 且 `state.revision !== expectedBaseRevision` → `stale_base_revision`；写边界扫描：add/update 的 content 过 `scanContent`，`blocked` 命中 → `threat_scan_blocked`；再折叠提交。首录经 `ensureInitialized`（S1-2）。
- 验收：`applyops-first-record-creates`（missing-key 协议）、`applyops-duplicate-before-stale`（**crash-gap 关键**：revision 已 +1 的重试返回 duplicate）、`applyops-mixed-duplicate-stale-rejects-whole`、`applyops-scan-blocks-write`、`applyops-atomic-batch`、`applyops-scope-isolation`、`schema-version-mismatch-passthrough`。

#### `latestPublishedMemory(session): { digest, seq } | undefined`
- 验收：`latest-prefers-highest-seq`、`absent-undefined`、`ignores-non-memory`。

#### `class MemoryPublisher`（fail-open）
- `maybePublish(agent, decision): Promise<void>` — pre-step 体内：读 state → `buildSnapshotSections` → **二次扫描**（blocked 条目渲染 `[BLOCKED: reason]`，原文留存审计）→ digest 比对 `latestPublishedMemory` → 变更才 `createUserMessage`（source `{kind:'memory', form:'snapshot', sections, revision, digest}`）追加 `decision.messages`；**任何异常（scan/存储/渲染）捕获记日志后放行 `next()`**——保留最后已发布快照，自进化副作用永不阻塞用户回合（[核验 S1-6]）。
- 验收：`publish-changed-exactly-one`、`publish-unchanged-silent`、`publish-secondary-scan-blocked-placeholder`、`publish-secondary-scan-original-retained`、`publish-fail-open-on-storage-error`、`publish-never-mid-turn`、`publish-reconstructable-from-log`、`publish-resume-byte-stable-prefix`。

## 4. Config（schemastery，required 无静默默认；`publisherEnabled` 默认 true）

## 5. 验收门（Phase 出口）

附件测试全绿 + per-file 100% 覆盖；REAL boot（Loader 场景断言 snapshot 消息 + fail-open 行为）；`MessageSourceMap` merged kind `memory` 登记 + 双 SDK expected outputs；回放重建（resume/compaction 后零重复发布）；schemaVersion + 显式 reset/migrate 命令入口（`spec.ts:38` 拒绝语义的配套）；README（Model Experience + Known Limitations：中文锚点为声明集非完备集、caution 级不阻断）+ Agent Note。
