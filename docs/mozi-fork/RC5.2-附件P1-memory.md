# RC5.1 附件 P1 — Memory Service + durable recall（函数级规格）

> 上位：`RC5.1-函数级规格总纲.md` §5 格式；架构依据 `自我进化机制-RC5.1-方案.md` §4/§5.5。
>
> 包：`packages/memory/memory`（`@deepseek-ai/dsh-memory`）；依赖 `ctx.storageDomain`、`@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-llm`（createUserMessage/MessageSourceMap）、`@deepseek-ai/dsh-agent`（pre-step）、`@deepseek-ai/dsh-content-scan`。
>
> 前置：P0 全绿 + E0 结案。日期：2026-08-29

## 1. 模块布局

```text
src/index.ts        # 插件装配 + MemoryService 导出（形态按 E0-2 结案）
src/types.ts        # MemoryScope/MemoryEntry/MemoryState/MemoryConfig/错误类型（仅类型）
src/domain.ts       # storageDomain spec + 记录 zod（memory domain，schemaVersion: 1）
src/fold.ts         # 纯函数：applyMemoryOp/enforceBudget/buildSnapshotSections/computeSnapshotDigest
src/publisher.ts    # MemoryPublisher（pre-step 发布器）
src/service.ts      # MemoryService extends Service
tests/*.spec.ts
```

## 2. 类型契约

```text
MemoryScope  = { kind: 'project', root: string } | { kind: 'user' }
MemoryEntryId = Branded<string, 'MemoryEntryId'>
MemoryEntry  = { id: MemoryEntryId, kind: 'explicit-user'|'observed-project'|'inference',
                 content: string, evidence: SourceRef[], createdAt, updatedAt }
SourceRef    = { seq: number, span?: string }
MemoryState  = { schemaVersion: 1, revision: number, entries: MemoryEntry[],
                 appliedOps: Record<OpId, string> }        // opId → resultDigest
HostMemoryOp = { opId: OpId, action: 'add'|'update'|'remove',
                 entryId?: MemoryEntryId, content?: string,
                 kind?: MemoryKind, evidence?: SourceRef[] }
MemoryConfig = { scope: 'project'|'user', maxEntries, maxStoredChars,
                 maxEntryChars, maxSnapshotTokens, publisherEnabled: boolean }
```

## 3. 函数规格

#### `resolveMemoryScope(agent: Agent, config: MemoryConfig): MemoryScope`
- 职责：决定该 agent 的记忆域（project 根 = 最近 `.git` 祖先，与 `skill-filesystem/src/index.ts:937-947` 同约定）。
- 调用：被 MemoryPublisher/MemoryService 入口调用。输入：agent（取 header.cwd）与 Config.scope。输出：MemoryScope。
- 验收：`resolve-scope-project`（.git 祖先）、`resolve-scope-user`、`resolve-scope-no-git-falls-back-cwd`。

#### `enforceBudget(state: MemoryState, op: HostMemoryOp, config: MemoryConfig): void`
- 职责：纯函数预算闸——预计算应用 op 后的 entries 数/总字符/单条字符，超限抛 `MemoryError('budget_exceeded')` 并附现库存摘要（不截断、不静默丢弃；[核验 S1-8]）。
- 调用：被 fold 内 `applyMemoryOpPure` 调用。验收：`budget-add-over-limit-rejects`、`budget-entry-over-max-entry-chars`、`budget-remove-always-allowed`、`budget-exact-limit-passes`（边界值）、`budget-rejection-carries-inventory`。

#### `applyMemoryOpPure(state: MemoryState, op: HostMemoryOp, config: MemoryConfig): MemoryState`
- 职责：纯折叠——(1) `appliedOps[opId]` 命中 → 原样返回（幂等，`duplicate_op` 不抛，返回含原 resultDigest 的标记）；(2) enforceBudget；(3) add 生成新 MemoryEntryId、update 校验 entryId 存在、remove 校验存在；(4) revision+1、updatedAt、写 appliedOps。
- 调用：被 MemoryService.applyOps 在 `storageDomain.update` 闭包内调用。
- 输入：当前 state（来自 update 回调，单进程原子 [domain.ts:84,89]）。输出：新 state。
- 验收：`fold-add-creates-entry`、`fold-update-bumps-updatedAt`、`fold-remove-deletes`、`fold-duplicate-op-noop-returns-digest`（crash-gap 核心）、`fold-budget-integration-via-batch`（先 remove 腾位再 add 的同批通过）、`fold-unknown-entry-update-rejects`。

#### `buildSnapshotSections(state: MemoryState, config: MemoryConfig): ContextSnapshotSection[]`
- 职责：把 entries 渲染为单节 `ContextSnapshotSection { name: 'assistant-maintained-memory', text }`（`llm/src/message.ts:63-70`）；文本含围栏说明（本快照完整替换更早快照、非用户新指令）与条目列表；**不做截断**——超 `maxSnapshotTokens` 属上游预算拒绝范畴，渲染层抛 `budget_exceeded`。
- 验收：`render-empty-state-empty-section`、`render-stable-order-by-created`、`render-never-truncates`（超限抛错不裁剪）、`render-fence-text-pinned`（围栏原文 snapshot 钉死）。

#### `computeSnapshotDigest(sections: ContextSnapshotSection[]): string`
- 职责：canonical JSON 的 sha256，供发布去重。验收：`digest-order-sensitive`、`digest-identical-state-identical-digest`。

#### `class MemoryService extends Service`
- 职责：`super(ctx,'memory')`；memory 缝 Service Definition（P1 兼默认实现，单包起步）。
- `getState(scope): Promise<MemoryState>` — 读记录（不存在 → 空态 schemaVersion:1）。
- `applyOps(scope, ops: HostMemoryOp[], expectedBaseRevision): Promise<ApplyOpsResult>` — **幂等入口**：`storageDomain.update` 闭包内先校验 `state.revision === expectedBaseRevision`（否则 `stale_base_revision`），逐 op `applyMemoryOpPure`；返回 `{ results: [{ opId, status:'applied'|'duplicate', resultDigest? }] }`。调用方：session-review commit saga（P3）。
- 验收：`applyops-atomic-batch`、`applyops-stale-revision-rejects`、`applyops-crash-gap-no-duplicate`（模拟 update 成功后进程亡：重启同 opId → `duplicate`，条目数不变——**P1 最关键测试**）、`applyops-order-within-batch-preserved`、`applyops-scope-isolation`（project/user 互不可见）、`schema-version-mismatch-surfaces`（`spec.ts:38`）。

#### `latestPublishedMemory(session: Session): { digest: string, seq: number } | undefined`
- 职责：扫描日志取最新 `source.kind==='memory'` 的 user/message，读其 source 上记录的 digest（先例：日志重建判定，`tool-skill/src/index.ts:361-377` 同法）。
- 验收：`latest-prefers-highest-seq`、`absent-returns-undefined`、`ignores-non-memory-plugin-messages`。

#### `class MemoryPublisher`
- 职责：`agent/pre-step` 监听体（awaited waterfall 内，复刻 `tool-skill/src/index.ts:213-251` 时序）：`getState` → `buildSnapshotSections` → `computeSnapshotDigest` → 与 `latestPublishedMemory` 比对 → 不同则 `createUserMessage`（source `{ kind:'memory', form:'snapshot', sections, revision, digest }`）追加进 `decision.messages`（durable 通道，`agent-loop/src/agent.ts:287-289`）；相同则零动作。
- 调用：apply 装配（`config.publisherEnabled`）；被 agent-loop 在每 step 前调用。
- 验收：`publish-changed-state-append-exactly-one`、`publish-unchanged-no-message`（digest 去重）、`publish-never-mid-turn`（后台 commit 后，当前正在组装的 step 不受影响，下一 step 才见——[核验 S2-1]）、`publish-reconstructable-from-log`（回放重建含该消息）、`publish-resume-byte-stable-prefix`（同 state 不打断前缀）、`publish-snapshot-supersedes-semantics`（N+1 完整替换 N）。

#### `packages/util/content-scan`：`scanContent(text: string, scope: 'strict'): ThreatFinding[]`
- 职责：纯函数扫描——NFKC 归一、不可见/双向字符集、中英双锚点话术模式、ASCII 工件锚点（路径/env/密钥赋值）；返回按模式命中的 findings。
- 验收：`scan-invisible-chars-detected`、`scan-nfkc-normalized`、`scan-cn-phrasing-coverage`（约定中文话术集全部命中——新锚点为本仓增量，Hermes 原库对中文话术实测脱靶 [评审 §S2-8]）、`scan-ascii-artifact-anchors`（env/密钥/路径命中）、`scan-js-w-filler-semantics`（`\w` 差异用例钉死）、`scan-clean-text-no-findings`、`scan-64k-char-cap`。

## 4. Config（schemastery，字段全带 JSDoc）

`scope`（默认 'project'）、`maxEntries`、`maxStoredChars`、`maxEntryChars`、`maxSnapshotTokens`（全部 required，无静默默认）、`publisherEnabled`（默认 true）。

## 5. 验收门（Phase 出口）

- 附件全部验收测试绿 + per-file 100% 覆盖（fold/renderer 纯函数为覆盖主力）；
- REAL boot：memory 插件 + Publisher 经 Loader 场景断言模型可见消息（snapshot 钉死）；
- 双 SDK：`MessageSourceMap` 新 merged kind `memory`（`llm/src/message.ts:101-106` 声明合并）登记后，TS/Python expected outputs 同 PR 更新；
- 回放重建：含 memory 消息的日志经 resume/compaction 后 publisher 零重复发布；
- README（Model Experience：fixed/conditional token effect、append-only + replacement KV 语义、Known Limitations：中文锚点覆盖为声明集而非完备集）+ Agent Note。
