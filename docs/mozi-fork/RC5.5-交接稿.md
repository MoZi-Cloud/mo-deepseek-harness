# RC5.5.4 交接稿（冷启动载体）

> 用途：新会话或新执行者的第一份读物。它是时点摘要，不代替 `RC5.5-执行进度报告.md`；交接稿、进度报告与实际 HEAD 冲突时，以进度报告已提交台账 + HEAD 为准。
>
> 方案状态：RC5.5.4 Architecture Frozen / Implementation Approved。这只表示函数级规格、调用图与验收门已闭合，不表示 P1–P5 已实现。P1-R3必须替换批C的 append-only Publisher。

## 1. 任务与读取顺序

目标是在 DSH fork 中以原生插件实现“从 durable 历史会话提炼可纠错 memory、可治理 managed skills 和可追溯经验”，让后续任务少犯重复错误、少走已验证失败的弯路，同时不把模型自述当真相。

冷启动固定读取顺序：

1. `RC5.5-执行进度报告.md`：已提交台账和精确下一节点。
2. `自我进化机制-RC5.5-方案.md`：RC5.5.4 上位原则、数据模型、运行协议和 Phase。
3. `RC5.5-函数级规格总纲.md`：包 DAG、跨包调用图、错误码与 T69–T90。
4. 当前 Phase 附件；现在是 `RC5.5-附件P1-memory.md`。
5. 第十轮四项裁定读 `RC5.5.4-第十轮评审核验与处置.md`；第九轮文件是历史输入/处置，不是最新实现规格。

## 2. 当前代码事实

| 阶段 | 事实 |
|---|---|
| P0 | 68 项 Evidence Lock，实跑 72 tests，已完成 |
| P1 批A | `content-scan` 已于 `1462092cba` 提交 |
| P1 旧批B | memory 骨架/第一版纯函数已于 `00e6658986` 提交；branded OpId 已于 `16bd8323de` 提交 |
| P1 批C | `f8547babfd` 已提交第一版 Service/Publisher；Service 部分保留，append-only/stale fail-open Publisher 待替换 |
| P2–P5 | 未实现 |

现有 memory 代码不是 RC5.5.4 D01–D14 的完成实现：`MemoryScope.user`还没有 `UserKey`，`HostMemoryOp`还不是 discriminated union，update/remove没有 `expectedEntryDigest`，没有 config最坏发布证明、共用 evaluator、`previewOps`或 direct-terminal Service路径。现有 `latestPublishedMemory`倒扫 log，Publisher只 append且失败保留旧 snapshot；它不满足 D15–D18。因此下一步仍是 P1-R1对齐批，不在旧 Publisher上继续补 assembly。

开工前必须先 `git status --short`。工作树里的既有改动属于用户；若与 P1-R1 要改的 `types.ts` 重叠，先理解并保留，不用 checkout/reset 清除。

## 3. 下一批的严格顺序

### P1-R1：只做 D01–D12

1. D01：types/domain/schema tests 先红，然后实现 `UserKey`、keyed user scope、discriminated memory ops、exact digest/created-by fields 和新错误码。
2. D02→D03：先实现并测试 `maxRenderedSnapshotChars`，再让 `validateMemoryConfig` 调它；禁止同节点倒序。
3. D04→D07：先 identity/digest，再 budget、direct/finalized receipt helpers，最后 exact-CAS fold。`memoryResultDigest` 只是执行结果，P3 不得用它派生 plan op id。
4. D08→D12：sanitize → renderer → digests → available/unavailable snapshot builder → 共用 `evaluateMemoryOps`；property test从 admitted state到 rendered snapshot验证预算证明。
5. D01–D12 focused tests、coverage/typecheck/lint/docs 与 README/JSDoc/Agent Note 按 outgoing diff 达标后才结束 P1-R1。

### 只有 P1-R1 结束后才能做

- D13 `resolveMemoryScope`。
- D14 Service：只读 `previewOps` → `applyOps` → `applyDirectOps` → `acknowledgeFinalizedOps`，全部复用 D12 evaluator。
- D15 generic pre-step surface-intent carrier + loop commit，先于任何新 Publisher。
- D16 `findVisibleMemorySnapshot` → D17 `decideMemoryPublication` → D18 `MemoryPublisher` → D19 assembly。Publisher不直接写 session；读失败时 stale available必须被 unavailable替换。
- P1 Phase收尾：REAL/HMR/crash/keyless correction/read-failure/replay snapshot、per-file coverage、architecture/API catalog、README/Agent Note/必要双 SDK。

## 4. 不可破坏的协议

- LLM 只 proposes，Host 提供 id/scope/base/digest/clock/receipt mode/actor 并 commits。
- Review mutation 进 pending receipt；direct command/tool mutation 在资源提交的同一 RMW/CAS 终结。P1/P2 不反向导入 P3。
- P3 的 canonical plan identity 固定 memory 后 skills、合并序列零基 index、identity version 1；模型不提供 OpId。
- Whole-plan admission 先调 P1 `previewOps` 和 P2 `preflightMutations`，两者零写入；全部通过后才按 memory→skill forward saga 提交，并发竞态转 superseded。
- finalization 固定 `markTerminal → applyDisposition → markFinalized → ensureFinalizedOutcomeIndexed → acknowledgeFinalizedOps(applied/duplicate) → release`；稳定递增 ordinal 单调写在 ReviewAttempt，counter crash gap 合法但不得改号；review receipt 在 finalized 前留 pending，启动先修 terminal-unfinalized、缺 ordinal/index 和 finalized-occupied，再接 claim。
- `consumed` 才 advance；pre-plan retry 与 immutable-plan same-attempt resume 是两套持久化 gate，partial saga 不新建 attempt。manual/supersede cap 与 rollout level 都在 cursor lane；host claim coordinator 以 `maxConcurrentReviews × maxPlanOps` 给 pending review receipt 硬上界。
- unresolved、assistant-only 和 Host 不能验证的结论不得产生可见 memory/skill；tool-success 仅是 execution 成功，不是任务语义成功。
- memory current authority只从 `session.surface.nodes`判定；`ContextForm='snapshot'`不自动 replace。最终 pre-step enter decision必须为每条 message携带唯一、按 message id关联的 `SurfaceIntent`，缺失不默认 append，loop统一提交；compaction shadow后同 digest也重新 append，无法重建时用无旧正文 unavailable。
- ReviewAttempt、GovernanceOperation 和 P2 immutable revision lineage 分别是 review、direct memory、direct skill 的 provenance authority；receipt 淘汰不得破坏 show/history/duplicate detection。
- conservative review在 claim前重算并验证 `ReviewAuthorizationScopeDigest`，未授权 route只进 shadow；actual child request attestation在 plan/mutation前验证。planner只见 scoped `structured_output`且恰好成功一次，普通工具与 inherited runtime context为零。
- P4 model load不等于 verified reuse；outcome以 stable coordinate分批结算，oversized不 head-block。corrupt outcome记 durable unresolved fault；later正信号继续，active→stale/stale→archived在修复前关闭。
- P5 hard gate不得被人工豁免；每个 execution scope独立评测并签署，pass也不拷贝 shadow plan，而是新 conservative lane重审。重新签署同一 scope不制造新 lane。

## 5. 验收与文档地图

P0继续保持 T01–T68 test-tree事实回归；RC5.5.4生产验收为 T69–T90，T85/T86取代 T67/T68 reference的生产顺序/分类，T87–T90闭合第十轮协议。验收名是待实现的行为清单，不是测试数量上限；每个 parser/config/durable/filesystem/model/tool/wire边界都要有 invalid case。

| 文档 | 角色 |
|---|---|
| `RC5.5-执行进度报告.md` | 唯一已提交进度台账与下一步 |
| `自我进化机制-RC5.5-方案.md` | RC5.5.4 上位方案 |
| `RC5.5-函数级规格总纲.md` | 全局 DAG、调用图、错误码、T69–T90、Phase 门 |
| `RC5.5-附件P0-evidence-lock.md` | 既有 API 事实与 68 项 P0 矩阵 |
| `RC5.5-附件P1-memory.md` | 当前 Phase 的 D01–D19 函数级规格 |
| `RC5.5-附件P2-skill-managed.md` | identity/lineage/preflight/authoring/provider/tool |
| `RC5.5-附件P3-session-review.md` | Host review、history、governance、provenance |
| `RC5.5-附件P4-curator.md` | signal/coverage/lifecycle |
| `RC5.5-附件P5-rollout.md` | executable corpus/runner/scorer/gate/report |
| `RC5.5.4-第十轮评审核验与处置.md` | 四项裁定、修复取舍与新版自审 |

## 6. 开工核对

```sh
git status --short
git log --oneline -8
rg -n "HostMemoryOp|MemoryScope|canonicalOpDigest" packages/memory/memory/src packages/memory/memory/tests
npx vitest run packages/util/content-scan packages/memory
npx vitest run packages/review/session-review/tests/evidence-lock
```

接手后只对当前拓扑节点开红测试；R1未绿前不同时铺开 generic loop intent、Publisher或 P2，也不在一个巨型提交中混合多个尚未被调用的层。
