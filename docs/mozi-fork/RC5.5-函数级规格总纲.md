# RC5.5.5 函数级规格总纲（TDD 与调用拓扑）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 上位：`自我进化机制-RC5.5-方案.md`；处置：`RC5.5.5-第十一轮评审核验与处置.md`；日期：2026-09-02。
>
> 附件：P0 Evidence Lock、P1 memory、P2 skill-managed、P3 session-review、P4 curator、P5 rollout。P5 无独立 runtime package，但有 fixture/runner/gate/authorization 代码面。

## 1. 全局约定

- 包/Service/Provider 形态、typed events、JSDoc、Config、Service 唯一 owner、storage domain 单 opener、branded id、fail-loud misconfiguration、Waterfall `next()` 与 model-visible ⟺ logged 均服从仓库根 `AGENTS.md`。
- 纯函数不读时钟、不生成随机 id、不做 I/O；Host clock/id 在壳层生成后显式传入。跨包 `OpId` 统一为 `Branded<'OpId'>`，各资源包只声明结构相同的 type，不为共享 type 建立反向依赖。
- typed same-process 边界信任 TypeScript；parser/config、model JSON、durable storage、filesystem、worker/process/wire 边界验证。模型不提供 opId、entryId、revisionId、scope key、receipt mode、actor 或 clock。
- receipt 分为 pending 与 recent-terminal：review op 提交后一直留 pending，直到 ledger `markFinalized` 后才经 `acknowledgeFinalizedOps` 进 ring；direct tool/command op 在资源 RMW/CAS 中直接进 ring；pending 不淘汰，terminal ring 容量由各资源 Config 显式给出。P3 以 `maxConcurrentReviews × maxPlanOps` 限制 review pending 硬上界，cleanup 未收敛时关闭新 acquired。
- 永不删除、单调迁移且 plan 落定后不可变的 ReviewAttempt 是 review plan/evidence/provenance 权威；同样保留的 GovernanceOperation 是 direct memory command 权威；P2 immutable revision lineage 是 direct skill tool 权威。可重建 op 索引不是第二权威，Resource receipt 只是 replay 去重数据。
- finalized outcome 的递增 ordinal 单调写在 ReviewAttempt；counter 分配后、attempt 写入前崩溃只允许留下 gap。ordinal 查询索引可从 retained attempt 重建且不得改号，因此 P4 checkpoint 无需循环回扫随机 AttemptId。
- 当前模型可见 memory 由 durable session surface 而非 message log 中“最新一条”决定。pre-step producer 只能在最终 decision 中声明按 message id 关联的 `SurfaceIntent`；enter decision 的 final messages 与 intents 必须一对一，不存在缺失后默认 append。agent-loop 在最终 decision 被接受后统一 append/replace，插件不得抢先直接写 session。
- conservative review 的受测 execution scope 必须在 claim 前获 P5 authorization，实际 child request 必须在任何资源 mutation 前完成 attestation。planner 只允许 scoped `structured_output`；普通工具与 runtime context 均不可见。
- Conservative scope 由load-time named `ReviewExecutionProfile`决定；historical source route只作provenance，不参与scope/lane。Rollout分`shadow|conservative-draft|conservative-auto`；只有auto level可对强证据agent-owned revision调用P2 promotion policy。
- P5授权execution/profile/policy的统计适用性，不证明每条未来proposal正确。每次auto activation仍重验owner、opt-in、pin、evidence class、unresolved、scan/quota、exact base和CAS。Host从actor/attempt/exact candidate派生background activation OpId；成功activation把id与lineage/current pointer同笔CAS，crash重放先查exact lineage duplicate。
- P5 九分层corpus和draft/auto capability属eval protocol v2；v1 report/artifact不能通过v2 loader。`EvaluationPromotionPermit`必须与fixture-root-bound、进程内不可序列化的promotion authority组合，只允许eval-only adapter进入与production共用的private activation transaction；P4b另用root-bound consolidation authority替代待签能力。Production P2/P4/runtime parser拒绝所有eval permit/authority。
- P4 outcome checkpoint 可以停在一个 outcome 内；每批 signal 用稳定 durable coordinate 继续。未解决的 corrupt-outcome fault 允许后续正信号继续，但关闭 active→stale 与 stale→archived。
- P4 semantic consolidation使用独立durable attempt并固定destination-first；source exact bundle在archive后仍保留。Destination auto activation只接受Host从immutable attempt与成功exact preflight派生的`consolidation-admitted`证据，并要求同一scope的auto-promotion与consolidation双capability。Host不声称能结构化证明unique knowledge语义完整，P5 oracle拥有该质量判断。
- `REVIEW_OP_IDENTITY_VERSION` 是协议常量。canonicalization 修改必须 bump 版本并保留 planned attempt 的原版本分派；不得把它做成部署 Config。
- 首版只保证 process crash + restart；不声称 power loss、kernel crash、多 Host 或分布式事务保证。
- 拓扑表的节点编号是跨节点硬顺序；同一节点列出多个函数时，正文必须给出callee-first内部顺序。若B调用A，先让A的失败测试与实现转绿，再为B写失败测试；不得以同文件或private helper为由同批倒序。

## 2. 包 DAG 与开发总顺序

```text
existing DSH APIs + P0 facts
            │
            ├──────────────────────┐
            v                      v
      content-scan       dsh-brand/core ids
          │   │             + loop surface intent
          v   └─────────┐          │
       memory            v         v
          │         skill-managed  planner isolation/execution profile
          │        owner/promotion           + named profile
          └──────┬──────┘
                 v
      session-review + repair projection
                 │
                 v
       skill-curator P4a + P4b
                 │
                 v
           P5 quality gate
```

全局实施顺序固定为 P0 → P1 → P2 → P3 → P4 → P5。P1 在 Publisher 前先实现 agent `PreStepDecision` 的通用 surface-intent carrier 与 loop commit；P3 在 review 代码前先实现 subagent isolated-prompt 与 LLM execution-profile 叶节点。`content-scan` 是 memory 和 skill-managed 的已完成共同叶子；在它之后 memory 与 skill-managed 之间没有 package edge。P3 同时调用 P1/P2，必须等待二者 Phase 出口。P2 不得导入 session-review；P1 不得导入 session-review。

附件中的“拓扑序”是开发顺序而非目录展示顺序。若 B 的实现调用 A，则 A 必须位于 B 之前、先有失败测试、先变绿；调用既有仓库 API 的行可直接以 P0/E0 事实为叶节点。

## 3. 顶级构件

| Phase | 包/代码面 | 顶级构件 | 主要消费者 |
|---|---|---|---|
| P0 | `packages/review/session-review/tests/evidence-lock` | 68 项事实矩阵与 test-tree reference | P1–P4 规格；生产代码禁止 import |
| P1 | `content-scan`、`memory` + agent/agent-loop 小扩展 | `MemoryService`、`MemoryPublisher`、visible-surface/publication/config 纯函数、loop-committed surface intent | P3、所有 Agent pre-step |
| P2 | `skill-managed` | `ManagedSkillService`、owner/promotion/absorption、Provider/Store/Authoring、`skill_manage` | P3、P4、authoring Agent |
| P3 | `session-review` | **host 级** `SessionReviewService`、Profile/Auth、Cursor/Ledger/Planner/Runtime/Historical/Repair/Governance | root Agents、P4、P5 |
| P4 | `skill-curator` + existing skill source/emitter | P4a usage/lifecycle；P4b bounded consolidation attempt/runtime | Managed skills、P5 |
| P5 | review eval surface + repository script | nine-stratum manifest/runner/scorer/draft-auto gate/report | rollout owner/CI |

## 4. 跨包调用关系

```text
MemoryPublisher
  ├─ findVisibleMemorySnapshot(session.surface.nodes)
  ├─ MemoryService.getState
  ├─ sanitizeForPublication → buildSnapshotSections → computeCompositeDigest
  ├─ decideMemoryPublication(available | unavailable)
  └─ final PreStepDecision(total surfaceIntents keyed by message id)
       └─ agent-loop validates intent → session.append(user/message, intent)

skill_manage
  ├─ deriveDirectToolOpId(sessionId, callId, canonical args)
  └─ ManagedSkillService.createDraft/patchDraft(origin.kind='direct-tool', owner='user')

SessionReviewService.runReview
  ├─ selectReviewExecutionProfile
  │    ├─ conservative live/history → configured named profile
  │    └─ inherit-current → shadow only
  ├─ resolveReviewAuthorizationScope(profile) → selectReviewLane
  │    ├─ unapproved/unattestable → shadow lane
  │    └─ approved → conservative-draft/auto lane keyed by scope digest
  ├─ ReviewClaimCoordinator → ReviewCursorStore.claimDue(selected lane)
  ├─ projectEvents → classifyOutcomeSignals + deriveRepairEpisodes
  ├─ ManagedSkillService.readLearningInventory
  │    └─ buildSkillLearningContext(exact revisions/support manifests/hidden drafts)
  ├─ startPlanner(isolated prompt; ordinary tool allow=[]; scoped structured_output only)
  ├─ attestPlannerRequest(actual child request/header) → gatePlannerResult
  ├─ persist plan → enumeratePlanOps → canonicalPlanOpDigest → deriveReviewOpId
  ├─ resolveMemoryPlanTargets + resolveSkillPlanTargets + checkEvidenceOutcomeAndRepair
  ├─ wholePlanAdmission
  │    ├─ MemoryService.previewOps (read-only)
  │    └─ ManagedSkillService.preflightMutations (read-only)
  ├─ MemoryService.applyOps(review origin)
  ├─ ManagedSkillService.createDraft/patchDraft(review origin, owner='agent')
  ├─ conservative-auto only: decideSkillPromotion → promoteAutonomously
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
  ├─ retain source header event seq/digest as provenance only
  ├─ select configured ReviewExecutionProfile
  ├─ agents.get OR agents.resume(agentOptions=profile, setup: agentPresets.mount(projected preset))
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
  ├─ SkillUsageObserver checkpointed durable session/P2 lineage/outcome-ordinal batches
  │    └─ settleOutcomeSignalBatch(ordinal,digest,version,afterCoordinate)
  ├─ usage classification + coverage + transition
  └─ ManagedSkillService.transitionManagedSkill(actor='curator')

SkillConsolidator.runPass
  ├─ buildBoundedSkillClusters(read-only catalog/inventory)
  ├─ startConsolidationPlanner(named profile + actual attestation)
  ├─ persist immutable ConsolidationAttempt
  ├─ ManagedSkillService.preflightConsolidation(exact destination/sources)
  ├─ persist Host-derived ConsolidationPromotionEvidence
  ├─ createDraft/patchDraft(destination)
  ├─ governance approval OR dual-capability decideSkillPromotion/activation
  └─ for each unchanged source: absorbSkill(destination active first)

skill restore command
  └─ ManagedSkillService.transitionManagedSkill(actor='governance')
```

## 5. finalization 与 cursor 权威

ReviewCursorLane 的 key 包含 session、policyVersion、learningViewVersion、`shadow|conservative-draft|conservative-auto` level 与稳定 `ReviewAuthorizationScopeDigest`。Scope只由selected named profile解析，不含historical source route；source provenance单独留在attempt。Lane拥有`reviewedThroughSeq/desiredThroughSeq/inFlight/blockedUntil/manualHold/retryCount/supersedeCount`，inFlight另有stored-plan resume gate。`claimDue(now)`在单lane RMW内返回acquired/resume/busy/nothing-due/deferred/manual；host内唯一ReviewClaimCoordinator串行做全lane occupied计数，新acquired受`maxConcurrentReviews`限制。authorization report/signature identity不进入lane key；相同scope和level重新签字不重置high-water。

Ledger 拥有 immutable plan、op identity version、opStates、terminal disposition、finalized 与 assigned outcome ordinal。Cursor release 是可重建清理，不是 finalized 的含义。Review receipt 在 finalized 前始终 pending；`acknowledgeFinalizedOps` 后可进有界 ring。recovery 顺序固定：先 terminal && !finalized 重放 disposition/mark；再给全部 finalized attempt 补 stable ordinal/derived index；再 finalized+occupied 重放 receipt cleanup/release；再 planned/committing 按 persisted resume gate 续同一 attempt；最后才接新 acquired。immutable plan 后的 transient 不创建新 attempt，已有 applied op 后的 stale/invariant 进入 manual。

## 6. plan 与 outcome 约定

Memory plan 是判别联合。add 由 Host 派生新 entry id；update/remove 必须携模型从 currentMemory view 复制的 opaque `targetEntryId/expectedEntryDigest`，Host 解析 exact current entry。目标不存在、digest 失配、plan 内重复触及同一 entry 或 state base 变化均 whole-plan zero commit。

OutcomeSignal 是 Host 可观察结构，不是“任务语义成功”的万能判定器。`tool-success`只表示execution非error；`retry-recovered`只配对同root turn内相同Host invocation fingerprint的failure与later success。参数或tool改变的序列形成`RepairEpisode`，只证明durable顺序、有界root-task window、later non-error和unresolved状态，不证明因果。单episode或单tool-success只能支持project fact/不可见agent-owned skill draft，不能单独发布procedure memory或auto-activate。Changed-method skill只有在durable人类命令对exact lesson/ref/revision/digest确认，或exact `RepairLessonDigest`的distinct-session corroboration达到required Config下限且无authoritative rejection时，才具备strong evidence；普通会话文本不能被planner自行升格为确认。P5报告不是单candidate evidence，未定义durable exact result协议的generic Host verifier不进首版。可见memory的procedure/recovery/caution仍要求user correction或exact retry。Unresolved/transient零可见mutation。

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
| `review_execution_unauthorized` | review | conservative execution scope 未在有效 rollout authorization 中；改走 shadow lane |
| `review_execution_mismatch` | review | 实际 child request attestation 与 claim scope 不同；零 mutation、manual hold |
| `review_profile_unavailable` | review/curator | selected named profile不可解析或不可attest；不得fallback到source/parent/其他profile |
| `skill_auto_promotion_denied` | skill/review | owner、opt-in、pin、evidence、unresolved、permit level或exact base不满足；draft保留不可见 |
| `repair_evidence_insufficient` | review | changed-method lesson只有单episode或distinct-session/confirmation不足；不得auto-promotion |
| `consolidation_source_stale` | skill/curator | source exact revision/digest已变；保留source可见并记录该项未absorb |
| `memory_publication_unavailable` | memory | 当前 memory authority 无法安全重建；只发布不含旧正文的 fixed unavailable snapshot |
| `outcome_coverage_fault` | curator | durable outcome 无法解析或 provenance 不可能；负向 lifecycle 关闭至人工修复 |
| `target_scope_disabled` | review | L1 命中 user target；整 plan zero commit |
| `review_deferred` | review | pre-plan/reuse blockedUntil 未到、容量已满或 reconciliation 未收敛；带 typed reason 的正常 claim result，不是异常 |
| `review_manual_hold` | review | 达 cap 或用户 hold；只有治理命令释放 |
| `unsupported_review_provider` | review | provider 不 fresh 或缺必需能力；load-time fail-loud |
| `principal_required` | memory/review | user scope 无 `UserKey`；L2 fail-loud |
| `missing-key` / `version-mismatch` / `already-open` | storage | 既有错误原样透传 |

`duplicate` 是结果状态，不是错误码。Direct operation 与 review operation 使用 domain-separated op id，不能因 hash 输入巧合互撞。

## 8. Evidence Lock 与 RC5.5.5 新验收

P0 68 项（66 活跃 + T09/T11 两项历史回归）已完成，已测 DSH API 结论保持权威，test-tree protocol reference 不是生产实现。T69–T94 在对应生产 Phase 先红后绿；T85/T86 明确取代 T67/T68 reference 的生产 finalization 顺序与 admission 分类。

| 新编号 | Phase | 核心断言 |
|---:|---|---|
| T69 | P2 | ToolCall-derived op id；direct terminal ring 有界 |
| T70 | P3 | fresh planner、isolated prompt、普通工具为空、structured output only |
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
| T87 | P1 | memory current surface replace/republish/unavailable 与 replay authority |
| T88 | P3/P5 | authorized execution scope pre-claim selection、actual request attestation 与 lane identity |
| T89 | P3/P5 | planner 只见并恰好调用一次 `structured_output`，普通工具零可见/零执行 |
| T90 | P4 | oversized outcome 分批恢复、corrupt fault 隔离与负向 lifecycle 保守关闭 |
| T91 | P2/P3/P5 | production/eval共用promotion policy与activation；background activation id可重放；agent owner、strong evidence、pin、permit和exact base不可绕过 |
| T92 | P3/P5 | historical source route只作provenance；named profile决定scope/lane，source provider退役仍可学习 |
| T93 | P2/P4/P5 | bounded class cluster、durable destination-first consolidation、Host-derived admission evidence、dual-capability activation、source retention/restore与semantic oracle |
| T94 | P3/P5 | exact retry与changed-method分型；单RepairEpisode不可见，distinct-session/exact human command才可promotion |

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
