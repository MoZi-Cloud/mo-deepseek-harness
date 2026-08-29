# RC5.3 附件 P1 — Memory Service + durable recall（函数级规格）

> 上位：`RC5.3-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.3-方案.md`。
>
> 包：`packages/memory/memory` + `packages/util/content-scan`。前置：P0 全绿。
>
> 相对 RC5.2-P1（第五轮 S1-7/S1-12/S2-1/S2-2/S2-12）：发布管线改 sanitize→render→digest；receipt 窗口改"空间上界 + 可重放覆盖契约"；双 scope 走组合配方；consolidation 协议落 planner 侧（P3 接线）；扫描语料版本化。
>
> 日期：2026-08-29

## 1. 模块布局

```text
packages/memory/memory/
  src/index.ts      # 插件装配（形态按 E0-2 结案；domain 名/section 名由 Config.scope 参数化）
  src/types.ts      # 仅类型
  src/domain.ts     # memory domain spec（schemaVersion:1）+ 记录 zod
  src/fold.ts       # foldMemoryOps / enforceBudget / sanitizeForPublication / buildSnapshotSections / computeSnapshotDigest（纯）
  src/publisher.ts  # MemoryPublisher（pre-step，fail-open）
  src/service.ts    # MemoryService extends Service
packages/util/content-scan/
  src/index.ts      # scanContent(text, scope): ThreatFinding[]；导出 PATTERN_SET_VERSION
  src/patterns.ts   # 模式数据（中英锚点/不可见字符/ASCII 工件锚点）
tests/corpus/       # positive / benign / 中文改写 / code-block-vs-imperative 四语料（S2-12）
```

## 2. 类型契约

```text
MemoryScope = { kind:'project', root } | { kind:'user' }   // 同插件两实例 = 双语义记忆（S2-1 修正版）
MemoryEntryId = Branded<string,'MemoryEntryId'>            // 由 opId 确定性派生
HostMemoryOp = { opId, entryId, now, action:'add'|'update'|'remove',
                 content?, kind?, evidence?: SourceRef[] } // id/time 由 host 预分配
MemoryState = { schemaVersion:1, revision, entries: MemoryEntry[],
                appliedOps: BoundedOpReceipts }
ApplyOpResult = { opId, status:'applied'|'duplicate', resultDigest? }
PublicationEntry = { kind:'safe', entry } | { kind:'blocked', entryId, reason }   // S1-12
MemoryConfig = { scope, maxEntries, maxStoredChars, maxEntryChars,
                 maxSnapshotTokens, publisherEnabled,
                 receiptWindowSize }   // 契约见 §3 boundedReceipts
```

## 3. 函数规格

#### `resolveMemoryScope(agent, config): MemoryScope`
- 职责：project 根 = 最近 `.git` 祖先（同 `skill-filesystem/src/index.ts:937-947` 约定，E0-7）。
- 验收：`resolve-scope-project`、`resolve-scope-user`、`resolve-scope-no-git-falls-back-cwd`。

#### `deriveEntryId(opId: OpId): MemoryEntryId`
- 职责：opId → entryId 确定性派生（同 opId 永得同 entryId——重复 create 第一道防线）。
- 验收：`derive-deterministic`、`derive-distinct-ops-distinct-ids`。

#### `enforceBudget(nextState, config): void`
- 职责：纯函数；超 `maxEntries/maxStoredChars/maxEntryChars` 抛 `budget_exceeded` 附现库存摘要（remove 永不受限；边界值精确）。
- 验收：`budget-add-over-limit`、`budget-entry-chars`、`budget-remove-exempt`、`budget-exact-limit`、`budget-inventory-in-error`。

#### `foldMemoryOps(state, ops, config): { nextState, results }`
- 职责：纯折叠。每 op：(1) `appliedOps` 窗口命中 → `status:'duplicate'` 返回原 resultDigest，不校验 base revision；(2) 未应用 → `enforceBudget` → 应用（add 用 `op.entryId`；update/remove 校验存在）→ 写 receipt；(3) revision+1。混合"部分 duplicate + 新 op"且 base stale → Service 层整体拒绝（fold 保持纯）。
- 验收：`fold-add-update-remove`、`fold-duplicate-before-base-check`、`fold-budget-integration-batch`、`fold-unknown-entry-rejects`、`fold-receipt-window-eviction`。

#### `boundedReceipts(appliedOps, windowSize): BoundedOpReceipts`
- 职责：纯函数——receipt 窗口淘汰（FIFO）。**契约（S1-7 修正版）**：窗口是空间上界；窗口必须覆盖一切可能重放的 opId——重放源只有 cursor inFlight 恢复与 ledger 非 terminal attempt 重放，两者都是 host 可见状态，P3 在派发时以 ledger/cursor 信息约束 `receiptWindowSize`；P1 阶段无 replay 源（review runtime 尚不存在），窗口仅作容量上界 + 容量告警遥测。万次 mutation 上界测试保留（证空间，不证重放安全）。
- 验收：`receipts-evict-oldest`、`receipts-10k-mutations-bounded-state-size`、`receipts-capacity-warning-emitted`。

#### `sanitizeForPublication(entries): PublicationEntry[]`（S1-12 新增，纯）
- 职责：逐条目过 `scanContent`——safe 原样；blocked → `{ kind:'blocked', entryId, reason }`（caution 不阻塞）；渲染前置换，杜绝渲染后重解析自身输出。
- 验收：`sanitize-safe-passthrough`、`sanitize-blocked-placeholder`、`sanitize-caution-passes`、`sanitize-pure-no-state`。

#### `buildSnapshotSections(entries: PublicationEntry[], config): ContextSnapshotSection[]`
- 职责：渲染单节 `{ name:'assistant-maintained-memory', text }`（section 名由 scope 参数化，双实例组合不撞名）；blocked 条目渲染 `[BLOCKED: reason]`；含"完整替换更早快照/非用户新指令"围栏（snapshot 钉死）；不截断，超 `maxSnapshotTokens` 抛 `budget_exceeded`。
- 验收：`render-empty`、`render-stable-order`、`render-never-truncates`、`render-fence-pinned`、`render-blocked-placeholder-no-raw-payload`。

#### `computeSnapshotDigest(sections): string`
- 验收：`digest-order-sensitive`、`digest-identical-state-identical`。

#### `scanContent(text, scope): ThreatFinding[]`（`packages/util/content-scan`）
- 职责：NFKC + 不可见/双向字符 + 中英话术锚点 + ASCII 工件锚点；输出 `Finding{ severity:'blocked'|'caution', id, evidence }`。语料化测试（S2-12）：四语料夹具 + `PATTERN_SET_VERSION` 进遥测。
- 验收：`scan-invisible`、`scan-nfkc`、`scan-cn-phrasing-corpus`、`scan-ascii-artifacts`、`scan-benign-corpus-zero-hit`、`scan-codeblock-vs-imperative-corpus`、`scan-cap-64k`、`scan-clean`。

#### `class MemoryService extends Service`
- `getState(scope): Promise<MemoryState>` — `ensureInitialized` 后读。
- `applyOps(scope, ops, expectedBaseRevision): Promise<ApplyOpsResult>`
  - 单个 `storageDomain.update` 闭包内：先逐 op 查 receipt（全 duplicate → 直接返回）；有新 op 且 base stale → `stale_base_revision`；写边界扫描（add/update content 过 `scanContent`，blocked → `threat_scan_blocked`）；再折叠提交。首录经 `ensureInitialized`。
- 验收：`applyops-first-record-creates`、`applyops-duplicate-before-stale`、`applyops-mixed-duplicate-stale-rejects-whole`、`applyops-scan-blocks-write`、`applyops-atomic-batch`、`applyops-scope-isolation`、`schema-version-mismatch-passthrough`。

#### `latestPublishedMemory(session): { digest, seq } | undefined`
- 验收：`latest-prefers-highest-seq`、`absent-undefined`、`ignores-non-memory`。

#### `class MemoryPublisher`（fail-open）
- `maybePublish(agent, decision): Promise<void>` — pre-step 体内：读 state → **`sanitizeForPublication` → `buildSnapshotSections` → `computeSnapshotDigest`**（顺序钉死，渲染前置换）→ digest 比对 `latestPublishedMemory` → 变更才 `createUserMessage`（source `{kind:'memory', form:'snapshot', sections, revision, digest}`）追加 `decision.messages`；任何异常（scan/存储/渲染）捕获记日志后放行 `next()`——保留最后已发布快照，自进化副作用永不阻塞用户回合。
- 验收：`publish-changed-exactly-one`、`publish-unchanged-silent`、`publish-secondary-scan-blocked-placeholder`、`publish-secondary-scan-original-retained`、`publish-sanitize-before-render`（S1-12 顺序断言）、`publish-fail-open-on-storage-error`、`publish-never-mid-turn`、`publish-reconstructable-from-log`、`publish-resume-byte-stable-prefix`。

## 4. Config（schemastery，required 无静默默认；`publisherEnabled` 默认 true）

双 scope 组合配方（S2-1 修正版，README 记录）：同插件按 `{kind:'project'}` 与 `{kind:'user'}` 各挂一实例，domain 名与 section 名由 scope 参数化；user store 的 shipped 默认排 L2（锁定原则 6）。bounded consolidation（S2-2）：`budget_exceeded` 时 planner 携现库存 + 新提案重规划，`maxConsolidationAttempts`（默认 2）在 P3 ReviewRuntime 接线，MemoryService 不内嵌 LLM。

## 5. 验收门（Phase 出口）

附件测试全绿 + per-file 100% 覆盖；REAL boot（Loader 场景断言 snapshot 消息 + fail-open 行为；含 sanitize→render 顺序）；`MessageSourceMap` merged kind `memory` 登记 + 双 SDK expected outputs；回放重建（resume/compaction 后零重复发布）；schemaVersion + 显式 reset/migrate 命令入口；README（Model Experience + Known Limitations：中文锚点为声明集非完备集、caution 级不阻断、user store 组合配方）+ Agent Note。
