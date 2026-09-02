# RC5.5.4 执行进度报告（无人值守交接载体）

> 用途：本文件是自我进化机制无人值守开发的唯一进度与交接载体。每个实现批次完成后追加 §3 台账，与改动同步提交。
>
> 权威方案已原位升为 RC5.5.4：`RC5.5-函数级规格总纲.md` + 附件 P0–P5 + `RC5.5.4-第十轮评审核验与处置.md`。P0 已完成；P1 批A、旧批B、批C 已提交，P1-R1/R2/R3 仍须按新版闭合。批C 的 append-only Publisher 是待替换实现，不是 P1-R3 完成证据。冷启动另读 `RC5.5-交接稿.md`。

## 1. 常备协议

1. 每次接手先读本文件、总纲和当前 Phase 附件，然后以 `git status --short` 和 `git log --oneline -8` 核对台账；已有未提交改动属于用户，不覆盖。
2. 开发严格按附件拓扑节点执行：若 B 调用 A，先为 A 写失败测试并实现至绿，再开始 B；不得以同一 class/file 为由倒序。
3. 批次完成定义：附件列出的 acceptance paths 及 invalid cases 全绿，按 `.agents/skills/dsh-pre-push-checks/SKILL.md` 选择与 diff 相称的 tests/typecheck/lint/docs/snapshot/REAL boot，非平凡改动同批更新 README/JSDoc/Agent Note，然后 commit、追加 §3、push。不为每个小 diff 默认跑全仓套件。
4. 模型/用户可见改动需 keyless recorded-session snapshot；SessionEventMap/loop/wire 变化需同批更新 TypeScript/Python SDK expected outputs。P5 controlled eval 凭据和真实会话不入库。
5. P0 test-tree 的 `review-protocol.ts`/`managed-protocol.ts` 只是事实样例，生产代码不得 import。首版 crash model 只是 Host/process crash + restart，不扩大为断电、多 Host 或分布式事务保证。
6. 持续执行时遵守当前产品的上下文/压缩机制；不在进度文档里固定外部 UI 自动点击脚本、私有队列或必须提交才可中断的非仓库协议。

## 2. 总路线（P0 → P5）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | Evidence Lock 68 项（66 活跃 + 2 历史回归；实跑 72 tests）+ E0 结案 | **完成** |
| P1 | `content-scan` + `memory` + generic loop surface intent；RC5.5.4 types/config/fold/preflight/Service/current-surface Publisher | **进行中**：批A、旧批B、批C 已提交；R1–R3 未完成 |
| P2 | `skill-managed`；identity/receipt/lineage/preflight/authoring/provider/tool | 未开始 |
| P3 | planner execution primitives + host-level `session-review`；authorization/projection/plan/cursor/ledger/finalization/live/history/governance | 未开始 |
| P4 | `skill-curator`；usage class/coverage/outcome batch/fault/state machine/observer/maintenance | 未开始 |
| P5 | per-scope fixtures/runner/scorer/gate/report + signed shadow→conservative authorization | 未开始；有可执行代码面，无 runtime package |

包 DAG 为 `content-scan + agent/loop surface intent → memory`、`content-scan → skill-managed`、`memory + skill-managed + planner execution primitives → session-review`、`skill-managed + session-review → skill-curator`、`session-review + skill-curator → P5`。实施顺序固定 P0→P1→P2→P3→P4→P5。

## 3. 已提交阶段台账（追加式）

### P0 — Evidence Lock 与 E0：完成

- `39b1f63c2d` + `936c23224c` + `2d44adfeea`：11 spec + 2 test-tree reference modules，72 tests，双语 Agent Note。
- `da9489c02b`：十二项 E0 回填完成；当时核验的 DSH API 事实保留在 P0 附件。

### P1 批A — `content-scan`：完成

- `1462092cba`：`scanContent/scanVerdict/PATTERN_SET_VERSION/MAX_SCAN_CHARS`、NFKC/隐藏 Unicode 检查、四语料、13 tests、per-file 100%、README 与包注册面。
- `d2201dc8ec`：补 session-review 骨架 package files 的 type declaration 出口。

### P1 旧批B — memory 骨架与第一版纯函数：已提交，不等于 P1 完成

- `00e6658986`：`types.ts/domain.ts/fold.ts`、receipt 二分、第一版 fold/publication tests、包骨架；`src/index.ts` 仍只 re-export，没有 Service/Publisher。
- `1228a9720b`：回填台账与交接稿。
- `16bd8323de`：`OpId` 改为 `Branded<'OpId'>` 并同步当时 RC5.5 规格。
- RC5.5.4 复核后，该实现还缺 `UserKey`、discriminated add/update/remove、exact entry digest、`createdByOpId`、`memoryResultDigest`、config/publication proof、read-only preview、direct-terminal API 与 current-surface publication，因此不能把旧批B/批C视为新版节点完成。

### P1 批C — MemoryService、Publisher 与 scope resolution：已提交，不等于 P1 完成

- `f8547babfd`：`service.ts`（`MemoryService extends Service`，唯一 memory domain opener；`applyOps` 顺序为 fold 内 receipt 去重 → base-revision 检查 → write-boundary `scanContent` → 原子 `put`；`acknowledgeTerminalOps` 经 `splitReceipts` 幂等）、`resolveMemoryScope`（`findProjectRoot` → `fs.resolve` targetKey sha256 → `ProjectKey`，无 cwd 回 user scope）、`latestPublishedMemory`（session events 逆扫 `user/message` + `source.kind === 'memory'`）、`publisher.ts`（prepend pre-step，sanitize → sections → composite digest，digest 变化时发布一条 `CompositeMemorySnapshot`，全 fail-open）、`MessageSourceMap` 'memory' merge、`invariant.ts`（durable 记录 schemaVersion/revision 检查）、28 条 service/publisher acceptance tests；`MemoryErrorCode` 扩 `threat_scan_blocked`/`stale_base_revision`；package 依赖补 cordis/dsh-agent/dsh-session/dsh-fs/schemastery/dsh-invariants。
- `117ea368dd`：同步 `pnpm-lock.yaml` 中 memory 包新增依赖。
- 已知未达 RC5.5.4 附件项：D01–D11 的类型对齐（`UserKey`、discriminated HostMemoryOp、exact entry digest、`createdByOpId`、`memoryResultDigest`、available/unavailable snapshot、`maxRenderedSnapshotChars`、`validateMemoryConfig`）未做；D14 的 `previewOps`、`applyDirectOps`、`acknowledgeFinalizedOps` 未实现，`applyOps` 当前直接 fold 而非调共用 `evaluateMemoryOps`；E0-12 remote-backend fail-loud 仅有测试占位；D15 generic loop surface intent、D16 visible lookup、D17 publication decision、D19 assembly 未做。现有 `latestPublishedMemory`/Publisher 是 append-only + stale fail-open，必须由 D16–D18 替换。

### RC5.5.4 第十轮协议修订：设计已形成

- 以 pinned DSH/Hermes 基线裁定四项：memory current surface 与 unavailable fail-safe 采纳；review authorization 改为 pre-claim stable scope + actual request attestation，structured output是唯一 planner 工具；P4 oversized outcome改为 stable-coordinate batch resume，corrupt item另设 unresolved fault；orphan reclaim降为不阻断 P2 的后续人工治理能力。
- 总纲和附件 P0–P5 已重排调用拓扑；P1-R1/R2 可保留方向，P1-R3、P3、P4、P5 必须按 RC5.5.4 新节点实施。

## 4. 当前精确接手位置

### 4.1 P1-R1：RC5.5.4 类型、domain 与纯函数对齐（未开始，批C 未触碰）

1. P1-D01 先红：`UserKey`、keyed user scope、discriminated HostMemoryOp、`expectedEntryDigest`、`createdByOpId`、preview/result types 和 domain schema；pre-release 不加旧格式 shim。
2. P1-D02 先红 `maxRenderedSnapshotChars`，再由 D03 `validateMemoryConfig` 调它，证明 scanner cap 和最坏可发布预算；不得把 bound helper 后补进 validator。
3. P1-D04→D07：`memoryEntryDigest`、`memoryResultDigest`、budget、direct/finalized receipt helper、exact-CAS `foldMemoryOps`；duplicate 仍先于 base/target。
4. P1-D08→D12：sanitize → renderer → scope/composite digest → available/unavailable snapshot builder → 共用 `evaluateMemoryOps`；property test证明 every admitted state publishable，preview/apply尚不做 I/O。

P1-R1 只在 D01–D12 全绿后结束。现有 memory tests 要随已变更行为替换，不保留 RC5.5.2 可选字段的兼容分支。

### 4.2 P1-R2：scope I/O、Service 与 whole-plan preview（批C 已部分交付）

1. P1-D13 `resolveMemoryScope`：**已实现**（`findProjectRoot` → `fs.resolve` targetKey sha256，无 cwd 回 user scope）；剩余：remote backend fail-loud guard 目前是测试占位，需对非 local fs 真正 throw；L1 user 无 principal 返回 `principal_required` 未做。
2. P1-D14 `MemoryService`：**已实现** `getState`/`applyOps`/`acknowledgeTerminalOps`，且 applyOps 已满足 duplicate 先于 base 的验收顺序；剩余：`previewOps`（零写入）、`applyDirectOps`、`acknowledgeFinalizedOps` 未实现；`applyOps` 直接调 `foldMemoryOps`，待 D12 完成后改调共用 `evaluateMemoryOps`。

### 4.3 P1-R3：Publisher、assembly 与 Phase 收尾（批C 已部分交付）

1. P1-D15 generic `PreStepSurfaceIntent` carrier + agent-loop commit：未实现；先红真实 final waterfall/replace/replay tests，并要求 final enter messages 与 intents 完整一对一，不保留缺失后默认 append 的兼容语义；loop只拥有提交机制，不写 memory 分支。
2. P1-D16 `findVisibleMemorySnapshot` → D17 `decideMemoryPublication`：未实现；必须基于 `session.surface.nodes`，不能倒扫 log。compaction shadow 后重新 append；多 visible memory在 pre-release fail-loud。
3. P1-D18 `MemoryPublisher`：现有批C实现仅可作为待替换代码。新实现不得直接 append；storage/read/render失败时由 D17把 visible available替换为不含旧正文的 unavailable，不能保留旧 snapshot。
4. P1-D19 assembly与收尾：真实 composition/Loader、architecture/API catalog、per-file 100%、REAL boot/HMR/crash、keyless correction/read-failure/replay snapshot、README/JSDoc/双语 Agent Note及必要双 SDK expected outputs。P1未出 Phase门前不进 P2。

### 4.4 P2–P5 后续顺序

- P2 按 D01→D16：types/config → project/name/path → canonical identity → structure → receipt → Store primitives/index/orchestration → provider/conflict/quota → read-only batch preflight → create → patch → governance → Service → `skill_manage`。orphan byte+count配额继续 fail-closed；物理 reclaim是后续 S2治理，不进入本 Phase。
- P3 按 E01→D01→D22：先做 isolated planner prompt、adapter execution profile和provider actual attestation；再做 eligibility/projection/outcome/schema → D06 authorization scope/lane selection → identity/target/admission → settlement/cursor/claim → ledger/finalization → planner attestation/runtime → live/history/governance/Service。authorization在 claim前；actual attestation在 plan/mutation前。普通工具为空，scoped `structured_output`恰好一次。
- P4 按 D01→D12：durable provider/meta → signal/coverage/reuse → D06 outcome digest+stable-coordinate batch → lifecycle → Store subcursor/fault → observer reconciliation → curator/metrics/assembly。oversized正常多批；corrupt outcome durable fault不 head-block later positive，但 fault修复前关闭负向 lifecycle。
- P5 按 D01→D16：types/threshold math → per-scope manifest/digest/split/sample validation → fixture load/redaction → isolated composition → keyless replay → eval materialization → per-scope controlled runner/actual attestation → scorer/aggregation → gate/report → signed authorization → repository commands。每个 scope独立达到样本与阈值；Gate通过也只授权新 conservative lane重审，不执行 shadow plan。

## 5. 验收编号与迁移规则

P0 的 T01–T68 保留原已测事实，但 test-tree reference不是生产实现。RC5.5.4的 T69–T90分别落 P1–P5，不追记为 P0已完成；T85/T86取代 T67/T68 reference的生产 finalization顺序/admission分类，T87–T90覆盖 current-surface、execution authorization、structured-output-only和outcome batch/fault。旧 T62–T66中的 op identity/receipt/applied-only不变量在生产 Phase仍需重新证明，生产命名与最终分层以附件为准。

任何规格调整若修改 canonical identity，必须 bump protocol version 并保留已 planned attempt 的旧版 dispatch；修改 durable schema 按 pre-release stance 提升 owner schema version 并拒绝旧格式，不加 compatibility shim。

## 6. 已核验基础设施锚点

| 事实 | 代码锚点 |
|---|---|
| snapshot semantic form、真实 surface 与 message projection | `packages/llm/llm/src/message.ts`；`packages/core/session/src/surface.ts`；`packages/core/agent-loop/src/agent.ts` |
| Waterfall pre-step 和 `next()` | `packages/context/time-context/src/index.ts`；`docs/cordis-primer.md` |
| storage domain/table/RMW/version errors | `packages/storage/storage-domain/src/spec.ts`；P0 T07/T20/T24/T44 |
| Service 唯一 opener/effect disposal | `packages/session/session-projection-cache/src/index.ts`；`vendor/cordis/src/service.ts` |
| root/cold session 枚举与 projection | `packages/session-query/session-query/src/index.ts` |
| cold Agent resume 和 projected preset mount | `packages/core/agent/src/index.ts`；`packages/preset/agent-preset/src/index.ts` |
| 历史 request provider/model route | `foldRequestHeader` in `@deepseek-ai/dsh-session` |
| fresh subagent、structured output scoped tool 与 capabilities | `packages/subagent/subagent/src/index.ts`；`packages/subagent/subagent-in-process-driver/src/structured.ts`；spawn provider |
| durable CommandId / ToolCallId | command/session event types；`ToolRunContext` |
| REAL/keyless replay | `packages/test-support/loader-smoke`；`snapshots/session/compaction-recovery/` |

## 7. 常用核验命令

```sh
git status --short
git log --oneline -8
npx vitest run packages/util/content-scan packages/memory
npx vitest run packages/review/session-review/tests/evidence-lock
pnpm run test:docs
git diff --check
```

真正 push 前按 `dsh-pre-push-checks` 从 diff 选择目标 package typecheck/lint/test/coverage/snapshot/REAL boot；只在该变更确实是全仓面或用于 CI 诊断时跑全套。
