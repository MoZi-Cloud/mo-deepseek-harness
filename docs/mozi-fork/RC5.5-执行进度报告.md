# RC5.5.3 执行进度报告（无人值守交接载体）

> 用途：本文件是自我进化机制无人值守开发的唯一进度与交接载体。每个实现批次完成后追加 §3 台账，与改动同步提交。
>
> 权威方案已原位升为 RC5.5.3：`RC5.5-函数级规格总纲.md` + 附件 P0–P5 + `RC5.5.3-第九轮评审核验与处置.md`。P0 已完成；P1 实现进行中，但当前代码仍停在 RC5.5.2 纯函数层，必须先做 RC5.5.3 对齐批。冷启动另读 `RC5.5-交接稿.md`。

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
| P1 | `content-scan` + `memory`；RC5.5.3 types/config/fold/preflight/Service/Publisher | **进行中**：批A和旧批B已提交，对齐批未实现 |
| P2 | `skill-managed`；identity/receipt/lineage/preflight/authoring/provider/tool | 未开始 |
| P3 | host-level `session-review`；projection/outcome/plan/cursor/ledger/finalization/live/history/governance | 未开始 |
| P4 | `skill-curator`；usage class/coverage/state machine/observer/maintenance | 未开始 |
| P5 | fixtures/runner/scorer/gate/report + shadow→conservative 授权 | 未开始；有可执行代码面，无 runtime package |

包 DAG 为 `content-scan → memory`、`content-scan → skill-managed`、`memory + skill-managed → session-review`、`skill-managed + session-review → skill-curator`、`session-review + skill-curator → P5`。实施顺序固定 P0→P1→P2→P3→P4→P5。

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
- RC5.5.3 复核后，该实现还缺 `UserKey`、discriminated add/update/remove、exact entry digest、`createdByOpId`、`memoryResultDigest`、config/publication proof、read-only preview、direct-terminal API 与 Service/Publisher，因此不能直接从旧“批C”开始。

## 4. 当前精确接手位置

### 4.1 P1-R1：RC5.5.3 类型、domain 与纯函数对齐

1. P1-D01 先红：`UserKey`、keyed user scope、discriminated HostMemoryOp、`expectedEntryDigest`、`createdByOpId`、preview/result types 和 domain schema；pre-release 不加旧格式 shim。
2. P1-D02 先红 `maxRenderedSnapshotChars`，再由 D03 `validateMemoryConfig` 调它，证明 scanner cap 和最坏可发布预算；不得把 bound helper 后补进 validator。
3. P1-D04→D07：`memoryEntryDigest`、`memoryResultDigest`、budget、direct/finalized receipt helper、exact-CAS `foldMemoryOps`；duplicate 仍先于 base/target。
4. P1-D08→D12：sanitize → renderer → scope/composite digest → snapshot builder → 共用 `evaluateMemoryOps`；property test 证明 every admitted state publishable，preview/apply 尚不做 I/O。

P1-R1 只在 D01–D12 全绿后结束。现有 memory tests 要随已变更行为替换，不保留 RC5.5.2 可选字段的兼容分支。

### 4.2 P1-R2：scope I/O、Service 与 whole-plan preview

1. P1-D13 `resolveMemoryScope`：`findProjectRoot` → `ctx.fs.resolve` → full targetKey hash；remote backend fail-loud；L1 user 无 principal 返回 `principal_required`。
2. P1-D14 `MemoryService`：只调用已完成 D12 `evaluateMemoryOps`，依次实现 `previewOps`、review `applyOps`、direct-command `applyDirectOps` 与 `acknowledgeFinalizedOps`。preview 必须零写入，apply 必须在单 record RMW 中重验；review receipt 保持 pending 至 ledger finalized，预检后竞态由 expected base 捕获。

### 4.3 P1-R3：Publisher、assembly 与 Phase 收尾

1. P1-D15 `latestPublishedMemory`，再 D16 `MemoryPublisher`，最后 D17 Service/provider/MessageSourceMap/pre-step assembly；publisher 不重复 scope/config/digest 逻辑，Waterfall 成功与失败都必须 `next()`。
2. 收尾包含 P1 附件全验收、per-file 100%、REAL boot/HMR/crash cases、keyless memory correction/replay snapshot、README/JSDoc/双语 Agent Note，以及事件/wire 面变化时的双 SDK expected outputs。P1 未出 Phase 门前不进 P2。

### 4.4 P2–P5 后续顺序

- P2 按 D01→D16：types/config → project/name/path → canonical identity → structure → receipt → Store primitives/index/orchestration → provider/conflict/quota → read-only batch preflight → create → patch → governance → Service → `skill_manage`。Direct tool 先 canonicalize parsed args，再由 session+ToolCallId 派生 op id；成功 revision 同 CAS 写 immutable lineage，terminal receipt 淘汰后仍以 lineage duplicate-before-base；orphan bytes 与 incomplete+orphan count 双上限覆盖零字节 partial。
- P3 按 D01→D21：eligibility/projection/outcome → schema/enumeration/identity/target/admission → settlement classification/decision → cursor transitions/Store → host claim coordinator → ledger/finalization → planner/runtime → live/history/governance → host Service。pre-plan transient 才创建 retry attempt；immutable plan 后以同一 attempt/op ids durable resume。finalized 后先把 stable outcome ordinal 写入 attempt并补 derived index，再 ack/release；required `maxConcurrentReviews × maxPlanOps` 限制不可淘汰 pending receipt。P3 调 P1 preview 和 P2 preflight，因此必须后于 P1/P2。
- P4 按 D01→D11：durable user provider + top-level skill result meta → signal → coverage/effective inactivity anchor → verified structural reuse → lifecycle → Store/session+outcome checkpoints → observer + P2 lineage/P3 ordinal-page reconciliation → curator/metrics/assembly。Model load 必须通过 provider/name/rendered-content digest 绑定；nested PTC 不计；可使 visible stale skill 回 active但不等于 verified success。coverage gap 从恢复时重启完整 inactivity 窗口；source mutex 与整页 receipt-window 证明限制 crash replay 去重状态；archived 只经用户 restore。
- P5 按 D01→D16：types/threshold math → manifest parse → digest/split/sample validation → fixture load/redaction → isolated composition → keyless replay → eval materialization → controlled runner → scorer/aggregation → gate → report → authorization → repository commands。Gate 通过也只授权新 conservative lane 重审，不执行 shadow plan。

## 5. 验收编号与迁移规则

P0 的 T01–T68 保留原已测事实，但 test-tree reference 不是生产实现。RC5.5.3 新增 T69–T86 分别落 P1–P5，不追记为 P0 已完成；T85/T86 取代 T67/T68 reference 的生产 finalization 顺序/admission 分类。旧 T62–T66 中的 op identity/receipt/applied-only 不变量在生产 Phase 仍需重新证明，生产命名与最终分层以附件为准。

任何规格调整若修改 canonical identity，必须 bump protocol version 并保留已 planned attempt 的旧版 dispatch；修改 durable schema 按 pre-release stance 提升 owner schema version 并拒绝旧格式，不加 compatibility shim。

## 6. 已核验基础设施锚点

| 事实 | 代码锚点 |
|---|---|
| snapshot section/source 和 message projection | `packages/llm/llm/src/message.ts`；`packages/skill/tool-skill/src/index.ts` |
| Waterfall pre-step 和 `next()` | `packages/context/time-context/src/index.ts`；`docs/cordis-primer.md` |
| storage domain/table/RMW/version errors | `packages/storage/storage-domain/src/spec.ts`；P0 T07/T20/T24/T44 |
| Service 唯一 opener/effect disposal | `packages/session/session-projection-cache/src/index.ts`；`vendor/cordis/src/service.ts` |
| root/cold session 枚举与 projection | `packages/session-query/session-query/src/index.ts` |
| cold Agent resume 和 projected preset mount | `packages/core/agent/src/index.ts`；`packages/preset/agent-preset/src/index.ts` |
| 历史 request provider/model route | `foldRequestHeader` in `@deepseek-ai/dsh-session` |
| fresh subagent 及 capabilities | `packages/subagent/subagent/src/index.ts`；spawn provider |
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
