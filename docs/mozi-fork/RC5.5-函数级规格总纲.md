# RC5.5.3 函数级规格总纲（TDD 与调用拓扑）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 上位：`自我进化机制-RC5.5-方案.md`；处置：`RC5.5.3-第九轮评审核验与处置.md`；日期：2026-09-01。
>
> 附件：P0 Evidence Lock、P1 memory、P2 skill-managed、P3 session-review、P4 curator、P5 rollout。RC5.5.3 新增 P5 附件；P5 无独立 runtime package，但有 fixture/runner/gate 代码面。

## 1. 全局约定

- 包/Service/Provider 形态、typed events、JSDoc、Config、Service 唯一 owner、storage domain 单 opener、branded id、fail-loud misconfiguration、Waterfall `next()` 与 model-visible ⟺ logged 均服从仓库根 `AGENTS.md`。
- 纯函数不读时钟、不生成随机 id、不做 I/O；Host clock/id 在壳层生成后显式传入。跨包 `OpId` 统一为 `Branded<'OpId'>`，各资源包只声明结构相同的 type，不为共享 type 建立反向依赖。
- typed same-process 边界信任 TypeScript；parser/config、model JSON、durable storage、filesystem、worker/process/wire 边界验证。模型不提供 opId、entryId、revisionId、scope key、receipt mode、actor 或 clock。
- receipt 分为 pending 与 recent-terminal：review op 提交后一直留 pending，直到 ledger `markFinalized` 后才经 `acknowledgeFinalizedOps` 进 ring；direct tool/command op 在资源 RMW/CAS 中直接进 ring；pending 不淘汰，terminal ring 容量由各资源 Config 显式给出。P3 以 `maxConcurrentReviews × maxPlanOps` 限制 review pending 硬上界，cleanup 未收敛时关闭新 acquired。
- 永不删除、单调迁移且 plan 落定后不可变的 ReviewAttempt 是 review plan/evidence/provenance 权威；同样保留的 GovernanceOperation 是 direct memory command 权威；P2 immutable revision lineage 是 direct skill tool 权威。可重建 op 索引不是第二权威，Resource receipt 只是 replay 去重数据。
- finalized outcome 的递增 ordinal 单调写在 ReviewAttempt；counter 分配后、attempt 写入前崩溃只允许留下 gap。ordinal 查询索引可从 retained attempt 重建且不得改号，因此 P4 checkpoint 无需循环回扫随机 AttemptId。
- `REVIEW_OP_IDENTITY_VERSION` 是协议常量。canonicalization 修改必须 bump 版本并保留 planned attempt 的原版本分派；不得把它做成部署 Config。
- 首版只保证 process crash + restart；不声称 power loss、kernel crash、多 Host 或分布式事务保证。

## 2. 包 DAG 与开发总顺序

```text
existing DSH APIs + P0 facts
            │
            ├───────────────┐
            v               v
      content-scan      dsh-brand/core ids
          │   │              │
          v   └─────────┐    │
       memory            v    v
          │         skill-managed
          └──────┬──────┘
                 v
          session-review
                 │
                 v
          skill-curator
                 │
                 v
           P5 quality gate
```

全局实施顺序固定为 P0 → P1 → P2 → P3 → P4 → P5。`content-scan` 是 memory 和 skill-managed 的已完成共同叶子；在它之后 memory 与 skill-managed 之间没有 package edge，但当前仓库按 Phase 顺序先闭合 P1 再开 P2。P3 同时调用 P1/P2，必须等待二者 Phase 出口。P2 不得导入 session-review；P1 不得导入 session-review。

附件中的“拓扑序”是开发顺序而非目录展示顺序。若 B 的实现调用 A，则 A 必须位于 B 之前、先有失败测试、先变绿；调用既有仓库 API 的行可直接以 P0/E0 事实为叶节点。

## 3. 顶级构件

| Phase | 包/代码面 | 顶级构件 | 主要消费者 |
|---|---|---|---|
| P0 | `packages/review/session-review/tests/evidence-lock` | 68 项事实矩阵与 test-tree reference | P1–P4 规格；生产代码禁止 import |
| P1 | `content-scan`、`memory` | `MemoryService`、`MemoryPublisher`、fold/publication/config 纯函数 | P3、所有 Agent pre-step |
| P2 | `skill-managed` | `ManagedSkillService`、Provider/Store/Authoring、`skill_manage` | P3、P4、authoring Agent |
| P3 | `session-review` | **host 级** `SessionReviewService`、Cursor/Ledger/Planner/Runtime/Historical/Governance | root Agents、P4、P5 |
| P4 | `skill-curator` + existing skill source/emitter | durable invocation provider、`SkillUsageObserver`、`SkillCurator`、coverage/transition/metrics | Managed skills、P5 |
| P5 | review eval surface + repository script | manifest/runner/scorer/gate/report | rollout owner/CI |

## 4. 跨包调用关系

```text
MemoryPublisher
  ├─ MemoryService.getState
  ├─ sanitizeForPublication → buildSnapshotSections → computeCompositeDigest
  └─ latestPublishedMemory → append one CompositeMemorySnapshot

skill_manage
  ├─ deriveDirectToolOpId(sessionId, callId, canonical args)
  └─ ManagedSkillService.createDraft/patchDraft(origin.kind='direct-tool')

SessionReviewService.runReview
  ├─ ReviewClaimCoordinator → ReviewCursorStore.claimDue
  ├─ projectEvents → classifyOutcomeSignals
  ├─ startPlanner(toolFilter.allow=[]; fresh provider) → gatePlannerResult
  ├─ persist plan → enumeratePlanOps → canonicalPlanOpDigest → deriveReviewOpId
  ├─ resolveMemoryPlanTargets + resolveSkillPlanTargets + checkEvidenceAndOutcome
  ├─ wholePlanAdmission
  │    ├─ MemoryService.previewOps (read-only)
  │    └─ ManagedSkillService.preflightMutations (read-only)
  ├─ MemoryService.applyOps(review origin)
  ├─ ManagedSkillService.createDraft/patchDraft(review origin)
  └─ finalizeAttempt
       ├─ ledger.markTerminal
       ├─ cursor.applyDisposition
       ├─ ledger.markFinalized
       ├─ ledger.ensureFinalizedOutcomeIndexed
       ├─ resource acknowledgeFinalizedOps(applied/duplicate opStates only)
       └─ cursor.releaseAttempt

HistoricalReviewCoordinator
  ├─ sessionQuery.listSessions/observeSession(projectionMode='all')
  ├─ enumerateHistoricalReviewWork + checkpoint store
  ├─ agents.get OR agents.resume(setup: agentPresets.mount(projected preset))
  └─ SessionReviewService.ensureReviewThrough → owned AgentHandle.dispose

memory governance command
  ├─ deriveCommandOpId(sessionId, commandId, canonical action)
  ├─ GovernanceOperation prepared
  ├─ MemoryService.applyDirectOps(exact id/digest)
  ├─ GovernanceOperation applied
  └─ resolveOperationProvenance for show

resolveOperationProvenance
  ├─ ReviewLedgerStore attempts/governance operations
  └─ ManagedSkillService immutable revision lineage

SkillCurator.runPass
  ├─ durable SkillInvocationSource.provider + top-level skill result meta
  ├─ SkillUsageObserver checkpointed durable session/P2 lineage/outcome-ordinal pages
  ├─ usage classification + coverage + transition
  └─ ManagedSkillService.transitionManagedSkill(actor='curator')

skill restore command
  └─ ManagedSkillService.transitionManagedSkill(actor='governance')
```

## 5. finalization 与 cursor 权威

ReviewCursorLane 的 key 包含 session、policyVersion、learningViewVersion 与 rolloutLevel。Lane 自己拥有 `reviewedThroughSeq/desiredThroughSeq/inFlight/blockedUntil/manualHold/retryCount/supersedeCount`；inFlight 另有 stored-plan resume count/blockedUntil。因此 `claimDue(now)` 可以在单 lane RMW 内返回 acquired/resume/busy/nothing-due/deferred/manual，不读取一个可能不同步的 ledger gate。host 内唯一 ReviewClaimCoordinator 串行做全 lane occupied 计数和单 lane claim；resume 不占新 slot，新 acquired 受 `maxConcurrentReviews` 限制，首版明确不支持多 Host。

Ledger 拥有 immutable plan、op identity version、opStates、terminal disposition、finalized 与 assigned outcome ordinal。Cursor release 是可重建清理，不是 finalized 的含义。Review receipt 在 finalized 前始终 pending；`acknowledgeFinalizedOps` 后可进有界 ring。recovery 顺序固定：先 terminal && !finalized 重放 disposition/mark；再给全部 finalized attempt 补 stable ordinal/derived index；再 finalized+occupied 重放 receipt cleanup/release；再 planned/committing 按 persisted resume gate 续同一 attempt；最后才接新 acquired。immutable plan 后的 transient 不创建新 attempt，已有 applied op 后的 stale/invariant 进入 manual。

## 6. plan 与 outcome 约定

Memory plan 是判别联合。add 由 Host 派生新 entry id；update/remove 必须携模型从 currentMemory view 复制的 opaque `targetEntryId/expectedEntryDigest`，Host 解析 exact current entry。目标不存在、digest 失配、plan 内重复触及同一 entry 或 state base 变化均 whole-plan zero commit。

OutcomeSignal 是 Host 可观察结构，不是“任务语义成功”的万能判定器。`tool-success` 只表示 execution 非 error；`failure-recovered` 只配对同 root turn 内相同 Host invocation fingerprint（工具名 + canonical durable arguments）的失败与 later success，同为 shell 但参数不同不算。单个 tool-success 或参数改变的 repair sequence 可支持 project fact/不可见 skill draft，不能单独发布 procedure memory。可见 procedure/recovery/caution 必须由明确 user correction 或该结构 recovery 支持；unresolved/transient 零可见 mutation。

## 7. 错误码

| code | owner | 语义 |
|---|---|---|
| `budget_exceeded` | memory/skill/review | 存储、publication 或 plan 配额拒绝；whole-plan 规则按附件执行 |
| `stale_base_revision` | memory/skill/review | state/revision/digest CAS 失配，需新 attempt 或用户刷新 |
| `stale_entry_digest` | memory | exact entry 存在但 digest 失配 |
| `unknown_entry` | memory/review | update/remove 目标不存在 |
| `name_conflict_with_human_source` | skill | 同名人工来源 |
| `name_conflict` | skill | managed reservation 被其他 op 占有 |
| `pending_pending_conflict` | skill | active skill 已有 pending revision |
| `invalid_structure` | all durable owners | schema、bundle、receipt ack、派生索引冲突或协议不可能状态 |
| `threat_scan_blocked` | memory/skill | 写闸命中 blocked finding |
| `unadmissible_evidence` | review | evidence span/source/outcome 不满足规则 |
| `planner_terminal_failure` | review | child 非 completed 或 structured output 不合法 |
| `target_scope_disabled` | review | L1 命中 user target；整 plan zero commit |
| `review_deferred` | review | pre-plan/reuse blockedUntil 未到、容量已满或 reconciliation 未收敛；带 typed reason 的正常 claim result，不是异常 |
| `review_manual_hold` | review | 达 cap 或用户 hold；只有治理命令释放 |
| `unsupported_review_provider` | review | provider 不 fresh 或缺必需能力；load-time fail-loud |
| `principal_required` | memory/review | user scope 无 `UserKey`；L2 fail-loud |
| `missing-key` / `version-mismatch` / `already-open` | storage | 既有错误原样透传 |

`duplicate` 是结果状态，不是错误码。Direct operation 与 review operation 使用 domain-separated op id，不能因 hash 输入巧合互撞。

## 8. Evidence Lock 与 RC5.5.3 新验收

P0 68 项（66 活跃 + T09/T11 两项历史回归）已完成，已测 DSH API 结论保持权威，test-tree protocol reference 不是生产实现。T69–T86 在对应生产 Phase 先红后绿；T85/T86 明确取代 T67/T68 reference 的生产 finalization 顺序与 admission 分类。

| 新编号 | Phase | 核心断言 |
|---:|---|---|
| T69 | P2 | ToolCall-derived op id；direct terminal ring 有界 |
| T70 | P3 | fresh planner、工具为空、standing request snapshot |
| T71 | P3 | root-only、child turn/end 不递归 |
| T72 | P3 | after-finalized/before-release 恢复 |
| T73 | P1/P3 | exact memory entry id+digest |
| T74 | P3 | unresolved/assistant-only 零可见 mutation |
| T75 | P3 | failure→recovery 只保存可支持路径 |
| T76 | P3 | enumeration/digest/version 稳定向量 |
| T77 | P3 | pre-plan retry 与 stored-plan same-attempt resume 的 durable backoff/cap/manual |
| T78 | P1 | every admitted memory state publishable |
| T79 | P3 | cold history/checkpoint/live mutual exclusion |
| T80 | P1/P3 | correction/remove 与下一 snapshot |
| T81 | P1/P2 | scanner cap config invariant |
| T82 | P4 | signal/coverage/restore 可达性 |
| T83 | P5 | quality gate 与 shadow 新 lane |
| T84 | P3 | provenance index 可重建、receipt eviction 无影响 |
| T85 | P1/P2/P3 | review receipt finalized 前不可淘汰，cleanup 可重放，pending 受 inFlight×plan cap 限制 |
| T86 | P3/P5 | 确定性 admission 拒绝 consumed+scored，仅瞬态失败 retry |

## 9. 每函数规格格式

```text
#### `函数签名`
- 拓扑：Dxx；只调用 Dxx 之前的本 Phase 节点与已完成 Phase/API。
- 职责：唯一 owner、输入、返回、持久化或失败语义。
- 调用：谁调用它；它调用哪些更早节点。
- 验收：全部行为测试名；缺一不算完成。
```

附件函数正文必须与顶部拓扑表同序。一个 class 若后列方法调用前列 helper，先完成 helper 测试，再实现 method；不得以“同一文件”绕过顺序。

## 10. Phase 出口

每 Phase 运行与 diff 相称的 focused tests、`pnpm run typecheck`、目标包 lint、`pnpm run test:docs`；代码面达到 per-file 100% coverage。模型/用户可见变化更新 keyless recorded-session snapshot；SessionEventMap/loop projection 变化更新双 SDK expected outputs；REAL composition 验证唯一 Service、loader、HMR disposal 与 crash injections；非平凡变化同 PR 提交 Agent Note 和 README/JSDoc。

P5 是 L1 准入而不是“代码写完后的可选统计”。任何 hard gate 失败都保持 shadow；人工签字不能覆盖 unresolved-visible、纠正后旧内容仍发布、隔离泄漏或跨项目泄漏等 correctness gate。
