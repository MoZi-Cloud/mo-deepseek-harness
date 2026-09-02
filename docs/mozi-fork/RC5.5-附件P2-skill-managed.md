# RC5.5.5 附件 P2 — skill-managed Service、promotion 与 absorption（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；前置：P1；包：`packages/skill/skill-managed`；日期：2026-09-02。
>
> package default export 是 host 级唯一 `ManagedSkillService`；named `skill_manage` 是 authoring preset 的薄工具插件。P2 不导入 `session-review`，review caller 只传结构相同的 branded `OpId` 与 `origin.kind='review'`。

## 1. 模块布局

```text
src/types.ts       # ids/ref/record/receipt/origin/config
src/config.ts      # Config validation（含 scanner cap、receipt window）
src/identity.ts    # project/name/revision/direct-tool op ids + canonical args
src/paths.ts       # revisions/<ManagedRevisionId>/ paths
src/structure.ts   # layout/frontmatter/scan/bundle digest
src/receipts.ts    # pending/direct-terminal placement + finalized cleanup
src/promotion.ts   # owner/evidence/permit based pure promotion policy
src/store.ts       # record/name index/revision I/O/reconcile
src/provider.ts    # storage-only list + verified get + learning inventory
src/authoring.ts   # create/patch/governance/lifecycle/promotion/absorption/quota
src/tool.ts        # skill_manage
src/index.ts       # Service opener/provider assembly + named tool exports
```

## 2. 类型与状态

```text
ProjectKey = Branded<'ProjectKey'>
SkillId = Branded<'SkillId'>
ManagedRevisionId = Branded<'ManagedRevisionId'>
OpId = Branded<'OpId'>
ManagedSkillRef = {projectKey,skillId}
ManagedMutationOrigin = {kind:'review',opId} |
                        {kind:'direct-tool',opId,sessionId,callId} |
                        {kind:'consolidation',opId,attemptId}
ManagedSkillOwner = agent | user
SkillAppliedOps = {pendingReceipts:SkillOpReceipt[],recentTerminalReceipts:BoundedRing}
NameReservation = {skillId,reservedByOpId}
ManagedSkillRecord = {ref,name,owner,autonomousManaged,pinned,state,currentRevision,
                      contentDigest,catalogSummary,pendingRevision?,revisionLineage,
                      activationLineage,absorbedInto?,appliedOps,lifecycleAnchors}
ManagedSkillState = draft | active | stale | archived | rejected
ManagedRevisionLineage = {revisionId,contentDigest,createdByOpId,origin,appliedAt}
PendingRevision = {revisionId,contentDigest,catalogSummary,createdByOpId}
ManagedActivationLineage = {activationOpId,revisionId,contentDigest,activatedAt} &
                           ({actor:'governance'} |
                            {actor:'review-auto'|'consolidator',attemptId,scopeDigest,permitDigest})
ManagedSkillEvent = revision-committed{ref,revisionId,opId,activated:false} |
                    revision-activated{ref,revisionId,opId,activated:true}
SkillPromotionPermit = rollout{scopeDigest,authorizationArtifactDigest,level:'conservative-auto',
                               capabilities:readonly ('skill-auto-promotion'|'skill-consolidation')[]} |
                       evaluation{evalPermitId,scopeDigest,caseId,repeatIndex}
EvaluationPromotionAuthority = process-local opaque capability bound to one disposable eval root
SkillEvidenceClass = user-confirmed | retry-recovered | corroborated-repair |
                     consolidation-admitted | weak-proposal
ConsolidationPromotionEvidence = {kind:'consolidation-admitted',attemptId,destinationRef,
                                  destinationRevision,destinationDigest,sourceBasesDigest,
                                  preflightDigest}
LifecycleRequest =
  | {actor:'curator',from:'active'|'stale',to:'active'|'stale'|'archived',now}
  | {actor:'governance',from:'archived',to:'active',now}
AbsorptionRequest = {actor:'consolidator',sourceRef,sourceRevision,sourceDigest,
                     destinationRef,destinationRevision,destinationDigest,attemptId,opId,now}
```

Provider 可见状态固定为active|stale；draft/rejected/archived隐藏。Review/consolidation origin创建owner=agent，direct-tool创建owner=user；模型不能提供或改变owner。Host Config决定新agent-owned record的`autonomousManaged`初值，模型不能opt in；该字段只对agent owner有效，pinned关闭所有background promotion/consolidation。Curator不得恢复archived；governance restore不伪装成usage。每个成功revision把immutable `ManagedRevisionLineage`与record pointer/receipt同笔CAS；每个activation把immutable `ManagedActivationLineage`与current pointer同笔CAS。Governance lineage以activation OpId链接P3 command authority，不伪造permit；两类background actor必须保存attempt/scope/permit且schema拒绝缺项或跨分支字段。Receipt ring可淘汰，两类lineage不得淘汰。`EvaluationPromotionAuthority`不是durable字段、Config、tool input或production permit；它只由P5 disposable composition建立并绑定一个隔离root。D01同时声明typed host events；D16只在成功CAS后发revision events，事件不是state authority。

## 3. 开发拓扑

| 顺序 | 节点 | 只可调用 |
|---:|---|---|
| P2-D01 | types/schema + `validateManagedConfig` | P1 content-scan constants、既有 types |
| P2-D02 | `resolveProjectKey/normalizeName` + paths | D01、existing fs |
| P2-D03 | skill/revision/direct-tool/background-activation identity + canonical tool args | D01–D02、crypto |
| P2-D04 | `validateStructure/bundleDigest` | D01、D02 paths、scanContent |
| P2-D05 | `placeMutationReceipt/splitFinalizedSkillReceipts` | D01 |
| P2-D06 | `decideSkillPromotion` | D01 |
| P2-D07 | Store record/revision primitives | D01–D05、storage/fs |
| P2-D08 | `ManagedSkillStore.ensureNameIndex` | D07 |
| P2-D09 | Store reservation/provenance/receipt/reconcile methods | D05、D07–D08 |
| P2-D10 | `ManagedSkillProvider` + `readLearningInventory` | D02、D04、D07–D09、skills registry |
| P2-D11 | `checkNameConflict/enforceQuotas` | D01–D03、D07–D10、skills registry |
| P2-D12 | `AuthoringCore.preflightMutations/preflightConsolidation` | D02–D11 |
| P2-D13 | `AuthoringCore.createDraft` | D02–D12 |
| P2-D14 | `AuthoringCore.patchDraft` | D02–D12 |
| P2-D15 | private activation transaction → promotion/governance/lifecycle/absorption/reconcile orchestration → eval-only adapter | D04、D06–D14 |
| P2-D16 | `ManagedSkillService` assembly | D07–D15 |
| P2-D17 | `skill_manage` | D03 direct id、D16 Service、ToolRunContext |

D17 必须最后开发；工具不得临时随机生成requestedBy。D13/D14依赖D05 receipt mode，不能在authoring内另写pending逻辑。D15内部先为private `commitSkillActivation`写失败测试并实现，再写调用它的human/auto wrappers，最后写调用production共用transaction的eval-only adapter；auto promotion必须调用更早的D06。P3/P4不得各写一套promotion判定。

## 4. 叶子、identity 与 validation

#### `validateManagedConfig(config): ResolvedManagedConfig`
- 拓扑：P2-D01。
- 职责：校验 provider rank、文件/总字节/路径/scan 开关、required `autonomousManagedForAgentCreated`布尔值、`maxRevisionsPerSkill/maxManagedBytesPerSkill/maxManagedBytesPerProject/maxOrphanBytesPerProject/maxUncommittedRevisionsPerProject` 五配额；`maxFileBytes <= MAX_SCAN_CHARS`；`receiptWindowSize` 与 revision 数量上限为正 safe integer。该opt-in统一适用review与consolidation创建的agent-owned record，不影响direct-tool创建的user-owned record。每个可能进入 definition 的文本文件都受 maxFileBytes，不能只限制 `SKILL.md`。`maxRevisionsPerSkill` 同时给永久 revision lineage 数量上界；`maxUncommittedRevisionsPerProject` 限制没有成功 record lineage 的 incomplete+orphan revision 目录数量，包括零字节目录。达上界后拒绝新 mutation，不淘汰 provenance，也不以字节配额掩盖数量耗尽。
- 验收：`skill-file-limit-above-scan-cap-fails-load`（T81）、`receipt-window-required-positive`、`agent-created-autonomy-opt-in-is-required-boolean`（T91/T93）、`review-and-consolidation-share-agent-created-opt-in`、`revision-count-caps-required-positive-safe-integers`、`all-model-visible-files-share-limit`、`exact-valid-config-passes`。

#### `resolveProjectKey(cwd,ctx): Promise<ProjectKey>`
- 拓扑：P2-D02。
- 职责：nearest `.git`，否则 cwd → fs.resolve whole targetKey hash；local backend only；诊断 identity source。
- 验收：`project-key-git-ancestor`、`project-key-alias-same-key`、`project-key-remote-fail-loud`、`project-key-non-git-cwd-diagnostic`。

#### `deriveSkillId(projectKey,normalizedName)` / `deriveRevisionId(skillId,opId)`
- 拓扑：P2-D03；name 必须先经 D02 normalize。
- 职责：domain-separated deterministic ids；revision 目录由 op 决定，并发 op 不共路径。
- 验收：`skill-id-project-isolated`、`revision-id-op-derived`、`revision-path-op-derived-exclusive`。

#### `canonicalManagedToolArguments(args): string` / `deriveDirectToolOpId(sessionId,callId,canonicalArguments): OpId`
- 拓扑：P2-D03；derive 只接同节点先完成并测试的 canonical 字符串。
- 职责：canonicalizer 对已解析 discriminated tool args recursively key-sort、数组保序、拒绝 undefined/unknown action fields；derive hash `skill-managed/direct-tool/v1` + durable session id + branded call id + canonical arguments；模型 schema 不含该 id。相同 durable call 重放同 id，不同 session/call 不碰撞。
- 验收：`canonical-argument-key-order-stable`、`canonical-argument-arrays-preserve-order`、`canonical-argument-unknown-field-rejected-at-parser`、`tool-op-id-derived-from-session-and-call`（T69）、`tool-op-id-not-model-supplied`、`same-tool-call-same-id`、`same-callid-different-session-distinct`。

#### `deriveBackgroundActivationOpId(actor,attemptId,ref,revision,digest): OpId`
- 拓扑：P2-D03；只调用D01 branded types与crypto。
- 职责：仅接受`review-auto|consolidator`与Host已解析的exact attempt/candidate，以`skill-managed/background-activation/v1`做domain-separated hash。Permit/artifact digest不进identity，因而同scope重签后重放仍得同id；actual permit digest仍写lineage。Human governance activation使用P3从CommandId派生的op id，不调该helper。模型不能提供activation id。
- 验收：`background-activation-op-id-replay-stable`、`activation-op-id-binds-actor-attempt-and-exact-candidate`、`authorization-resign-does-not-change-activation-op-id`、`human-activation-does-not-use-background-id-domain`、`activation-op-id-not-model-supplied`（T91/T93）。

#### `validateStructure(bundle,config): StructuralReport` / `bundleDigest(files): string`
- 拓扑：P2-D04。
- 职责：relative paths、无 `..`/absolute/symlink/binary、唯一 `SKILL.md`、file count/bytes；每个模型可见 text file 整文件 scan，blocked 拒绝、caution 记录；frontmatter 的所有模型可见字段包含在受 cap 的原文件；digest 排序文件名并排除 completion marker。
- 验收：`structure-path-escape`、`structure-skill-md-required`、`structure-file-count-cap`、`structure-total-bytes-cap`、`structure-binary-rejected`、`structure-severity-caution-passes`、`structure-severity-blocked-rejects`、`every-model-visible-skill-field-is-within-scanned-file`（T81）、`bundle-digest-order-stable`。

#### `placeMutationReceipt(appliedOps,receipt,origin,windowSize): SkillAppliedOps`
- 拓扑：P2-D05。
- 职责：review/consolidation origin加入pending；direct-tool origin直接加入terminal ring并有界；已知op返回原receipt；同op在另一区域出现时按origin校验，direct-tool不得迁移background pending。Consolidation receipt直到`ConsolidationAttempt.finalized`后才可cleanup。
- 验收：`review-receipt-enters-pending`、`consolidation-receipt-enters-pending`（T93）、`foreground-skill-receipt-enters-terminal-ring`（T69）、`foreground-receipts-remain-bounded`、`direct-cannot-terminalize-background-pending`、`known-op-placement-idempotent`。

#### `splitFinalizedSkillReceipts(appliedOps,finalizedOpIds,windowSize): SkillAppliedOps`
- 拓扑：P2-D05。
- 职责：只供P3 `ReviewAttempt`或P4 `ConsolidationAttempt`已finalized后的background receipt cleanup；pending→ring、ring no-op、两无no-op；空id/无效ref仍invalid_structure。未finalized background pending永不淘汰，caller authority kind与origin必须匹配。
- 验收：`skill-finalized-ack-moves-pending`、`skill-finalized-ack-retry-idempotent`、`skill-finalized-ack-after-eviction-noop`（T85）、`consolidation-finalized-ack-scoped`（T93）、`skill-unfinalized-pending-never-evicted`、`skill-terminal-ring-bounded`、`skill-finalized-ack-empty-id-fails`。

#### `decideSkillPromotion(candidate,evidence,permit,current): SkillPromotionDecision`
- 拓扑：P2-D06；只调用D01 types/config，不做I/O。
- 职责：production与P5 eval共用的唯一pure promotion policy。要求owner=agent、`autonomousManaged=true`、未pinned、candidate exact revision/digest仍为draft current或active pending、structure/scan/quota已通过、无human conflict/rejection与later unresolved。普通review candidate的evidence必须是user-confirmed/retry-recovered/corroborated-repair之一；consolidation candidate只接受P4从durable planned `ConsolidationAttempt`和成功exact preflight派生并重读验证的`ConsolidationPromotionEvidence`。P2不导入P4 Store；本纯函数只核对evidence与candidate origin/attempt及exact destination相等，并检查当前skill facts与permit双capability，source bases/preflight对durable attempt的相等性由P4 mutation caller拥有。该evidence只证明合并执行已admit，不声称语义完整。Rollout permit必须是`conservative-auto`且exact scope获授权；普通promotion要求`skill-auto-promotion`，consolidation destination同时要求`skill-auto-promotion`与`skill-consolidation`。Evaluation permit使用独立brand，纯函数只将它分类为“需对应eval authorities”，不声称caller已有authority。Weak proposal、单RepairEpisode或普通tool-success返回typed denied且保留draft；首版不接受未定义durable protocol的generic Host-verifier evidence。
- 验收：`authorized-agent-owned-strong-evidence-promotes`（T91）、`user-owned-never-auto-promotes`、`pinned-or-auto-disabled-never-promotes`、`weak-or-unresolved-evidence-remains-draft`、`single-repair-episode-remains-draft`（T94）、`stale-revision-denies-promotion`、`consolidation-evidence-matches-candidate-origin-and-exact-destination`（T93）、`p2-promotion-has-no-p4-store-dependency`（T93）、`consolidation-destination-requires-both-auto-and-consolidation-capabilities`（T93）、`consolidation-admission-never-claims-semantic-preservation`、`evaluation-and-rollout-permit-produce-same-candidate-decision`、`evaluation-permit-rejected-by-production-caller`、`model-cannot-supply-owner-permit-or-consolidation-evidence`。

## 5. Store 与 Provider

#### `ManagedSkillStore` record/revision primitives
- 拓扑：P2-D07。
- `getRecord/casPutRecord(ref,expectedRevision)`：只接 ManagedSkillRef。
- `writeRevisionBundle(ref,revisionId,files)`：全量重写，completion marker 最后 createIfAbsent；marker 已在且 digest 同则续跑，异则 invalid_structure；无 marker 的 partial bundle 重放补全。
- 验收：`record-first-record`、`record-cas-conflict`、`partial-bundle-crash-retry-completes`、`foreign-revision-content-fails-loud`。

#### `ManagedSkillStore.ensureNameIndex(projectKey)`
- 拓扑：P2-D08；调用 D07 storage primitives。
- 职责：get→missing put empty→update；并发 first initialization 收敛为一个合法 index，不以覆盖 put 充当 CAS。
- 验收：`name-index-first-record`、`concurrent-name-index-initialization-converges`。

#### `ManagedSkillStore` reservation/provenance/receipt/reconcile methods
- 拓扑：P2-D09；调用 D05、D07–D08。
- `reserveName(projectKey,name,skillId,opId)`：先 D08 ensure；不存在占位，同 op resume，异 op name_conflict。
- `resolveMutationProvenance(opId)`：从record中的immutable revision/activation lineage查找review attempt、consolidation attempt或direct-tool session/call；允许重建的op index只是加速投影，缺失时扫lineage补回，冲突fail-loud。
- `findAppliedMutation(opId)`：在 receipt duplicate 检查后查 immutable lineage；terminal receipt 已淘汰但 lineage 已有该 op 时仍返回 duplicate，必须早于 base/state/pending 检查。
- `findAppliedActivation(activationOpId,expected)`：按immutable activation lineage查exact actor/attempt/ref/revision/digest；完全一致返回duplicate，同id不同内容fail-loud。该查找早于current state与新permit验证，但不允许以不匹配的caller input命中一条旧lineage。
- `acknowledgeFinalizedOps(groups)`：调用 D05 finalized split；输入仅 ledger 已 finalized 的 review applied/duplicate opStates；P2 不导入 P3，前置由 host 调用顺序保证。
- `rebuild/reconcile`：释放 reservation-without-record；记录 incomplete/orphan 的 path、byte count 与 count，不物理删除；同一目录重扫不得重复计数。
- 验收：`reserve-first-project-initialized`、`reserve-same-op-resumes`、`reserve-different-op-conflicts`、`skill-receipt-survives-later-same-skill-op`、`skill-finalized-ack-scoped-and-idempotent`、`revision-lineage-written-with-successful-record-cas`、`direct-tool-provenance-survives-receipt-eviction`、`evicted-direct-receipt-still-duplicates-via-lineage`、`activation-lineage-exact-match-returns-duplicate`、`activation-op-id-content-conflict-fails-loud`、`provenance-index-rebuilds-from-lineage`、`reconcile-releases-orphan-reservation`、`reconcile-identifies-zero-byte-uncommitted-revision`、`reconcile-rescan-does-not-double-count-orphan`。

#### `class ManagedSkillProvider implements SkillProvider`
- 拓扑：P2-D10。
- `list(options)`：project resolve；只读 storage sidecar；active|stale；candidate locator 钉 project/ref/revision/digest；单 record 损坏 → skip + complete:false，整体失败 throw。
- `get(candidate,options)`：project/ref 校验 → exact revision → whole bundle digest → 每个可见文件 read-boundary re-scan → definition body；summary/invocation 取 candidate 冻结字段，避免并发 approve 混代。
- 验收：`provider-contract-typechecks`、`provider-list-visible-lineage`、`provider-list-reads-sidecar-not-files`、`stale-remains-discoverable-and-loadable`、`get-uses-candidate-frozen-summary`、`external-edit-active-skill-refused-on-get`、`load-boundary-threat-rescan-all-files`、`provider-project-isolation`、`abort-signal-stops-list-and-get`、`provider-hmr-disposal`。

#### `readLearningInventory(projectKey,request): Promise<ManagedLearningInventory>`
- 拓扑：P2-D10；复用同节点Provider verified bundle read与D07–D09 Store。
- 职责：供P3/P4 Host读取有界authoring view，不进入模型tool。按exact ref/revision/digest返回loaded/consulted managed skills、bounded related catalog candidates、agent-owned hidden draft/pending、support-file manifest与owner/pin/autonomous/absorption state；每个返回bundle仍执行D04 structure/digest/full-file scan。Caller提供硬上限和稳定cursor；超限返回incomplete+next cursor，不截断后声称全量。User/external/bundled候选只返回保护摘要，不变成managed mutation target。
- 验收：`learning-inventory-binds-exact-revision-and-digest`、`hidden-agent-draft-visible-only-to-host-learning-context`、`user-and-external-content-remains-protected`、`support-manifest-and-body-share-verified-bundle`、`bounded-inventory-reports-incomplete-and-cursor`、`tampered-bundle-never-enters-learning-context`。

## 6. Authoring、Service 与工具

#### `checkNameConflict(authoring,name)` / `enforceQuotas(projectKey,pendingInventory)`
- 拓扑：P2-D11。
- 职责：人工直存与 registry winning candidate 双检查；managed 同名指向 patch/reopen；按 current records + completed/incomplete/orphan revisions + pending batch 聚合上述五项库存配额，fail-loud 返回 bytes/count/path 分类 inventory。尚无内容或 completion marker 的 revision 也占一个 uncommitted count；成功进入 immutable lineage 后从 uncommitted 转入 per-skill revision count，不得两边重复计数。同 op 重放已存在的 partial revision 时，count delta 为零，bytes 以“用完整目标 bundle 替换现有 partial bytes”的 projected inventory 计算；因此达到 count 上限仍允许该 op 原地完成，但不得借 resume 写另一个 revision 或突破 bytes 上限。
- 验收：`conflict-human-direct-source`、`conflict-winning-nonmanaged-provider`、`managed-same-name-suggests-patch`、`quota-exact-boundary`、`quota-error-inventory`、`revision-cap-bounds-immutable-lineage`、`orphan-bytes-participate-in-quota`、`zero-byte-orphan-participates-in-count-quota`、`completed-lineage-not-double-counted-as-uncommitted`、`pending-batch-aggregates-uncommitted-count`、`same-op-partial-resume-at-count-cap-is-allowed`、`partial-resume-projects-full-target-bytes`、`different-op-at-count-cap-is-rejected`。

#### `AuthoringCore.preflightMutations(inputs): Promise<ManagedPreflight>`
- 拓扑：P2-D12；调用 D02–D11；create/patch 只复用这些更早的 validation/store helpers，不复制规则。
- 职责：**review admission 专用的只读 batch 预检**；在一组一致 storage/provider views 上执行 duplicate-before-base、project/owner/state/pending、name conflict、plan 内重复 name/ref、structure/full-file scan 与聚合 quota 检查。不 reserve name、不写 bundle/record/receipt/lineage。预检后的竞态由 create/patch 的 reservation/CAS 捕获并返回 stale 给 P3 supersede；preflight 不假装跨 storage 和 filesystem 事务。
- 验收：`preflight-matches-create-and-patch-validation`、`preflight-never-reserves-name-or-writes`、`preflight-detects-existing-pending-conflict`、`preflight-detects-intra-plan-name-and-ref-conflict`、`preflight-aggregates-whole-plan-quota`、`preflight-race-still-fails-mutation-cas`。

#### `AuthoringCore.preflightConsolidation(input): Promise<ConsolidationPreflight>`
- 拓扑：P2-D12；调用D02–D11，不写record/bundle/reservation。
- 职责：验证destination create/patch与每个source exact ref/revision/digest；所有source必须owner=agent、autonomousManaged、未pinned、当前可见且互不重复，destination不得在sources中。检查每个source exact bundle已出现在调用者证明的planner context、destination完整bundle结构/scan/quota/name conflict与plan内聚合预算。该函数只证明结构与基线，不声称destination语义保留了unique knowledge。
- 验收：`consolidation-preflight-is-read-only`、`destination-cannot-be-source`、`all-sources-require-exact-verified-bundles`、`protected-or-pinned-source-rejected`、`destination-bundle-runs-normal-structure-and-quota`、`preflight-does-not-claim-semantic-preservation`（T93）。

#### `AuthoringCore.createDraft(input,origin)`
- 拓扑：P2-D13；调用 D02–D12。
- 职责：resolve project/name/ref → existing receipt/lineage duplicate → human conflict → op-aware reservation → structure/quota → op-derived revision bundle → record CAS 同笔写 state+receipt+immutable lineage。Review/consolidation origin固定owner=agent，`autonomousManaged`由resolved Host Config固定；direct-tool固定owner=user且`autonomousManaged=false`。Review/consolidation receipt pending；direct-tool receipt terminal ring。模型不能选择origin/owner/opt-in，consolidation planner不能构造admission evidence。
- 验收：`create-draft-lands-invisible`、`create-conflict-rejects`、`create-same-op-reservation-and-record-retry`、`create-threat-blocked-rejects`、`create-caution-passes`、`create-review-receipt-pending`、`create-consolidation-owner-agent-and-pending-receipt`（T93）、`create-direct-receipt-terminal`、`concurrent-authors-cas-one-wins`。

#### `AuthoringCore.patchDraft(input,origin)`
- 拓扑：P2-D14；调用 D02–D12，不调用 createDraft。
- 职责：record receipt/lineage duplicate-before-base → owner/state/pending gate → exact revision+digest CAS → structure/quota → bundle → draft current pointer 或 active pending 四字段 + receipt + immutable lineage 同笔 CAS。active current catalog 不变直到 approve。
- 验收：`patch-draft-advances-current`、`patch-active-stays-pending`、`patch-active-pending-conflict-rejects`、`skill-op-retry-duplicate-before-stale`、`skill-receipt-survives-later-same-skill-op`、`pending-catalog-switches-only-on-approve`、`patch-review-vs-direct-receipt-mode`。

#### `commitSkillActivation` → `promoteDraft/activatePending/promoteAutonomously` → `createEvaluationPromotionAdapter`；`reject/reopen/transitionManagedSkill/absorbSkill/reconcileStartup`
- 拓扑：P2-D15；调用D04、D06–D14。
- 职责：D15的activation chain严格按标题箭头开发；private `commitSkillActivation`先实现exact duplicate-before-state、four-field CAS与lineage/current-pointer同笔提交，后续activation caller不得复制transaction，eval-only adapter最后开发。Reject/reopen/lifecycle/absorption/reconcile不调用activation transaction，只需各自在所调用的D04/D07–D14 helper转绿后开发。Human governance approve全重验并以`actor:'governance'`写无permit分支，activation OpId链接P3 command authority；reject draft→rejected或clear pending；reopen rejected→draft。`promoteAutonomously`公开production方法只接受从已验签rollout artifact派生的permit，先以D03派生background activation op id并按immutable activation lineage做duplicate-before-state，新activation再调D06。成功background activation把activation op id、exact decision、actor、revision/digest、attempt/scope/permit写入lineage；consolidation evidence还要求permit中的两个capability均可回验到同一signed scope entry。P4在调用前重读D17 attempt，要求stored evidence与plan/preflight/source bases byte-equal；P2只重验destination origin/current和自己拥有的policy/permit facts，不导入P4。P3/P4不能直接调用低层approve绕过policy。`createEvaluationPromotionAdapter`只为P5 disposable composition构造host面，同时验证root-bound process-local authority与exact evaluation permit后调同一private activation transaction；consolidation eval caller还必须先由P4 adapter验证独立consolidation permit/authority。Production Service/runtime parser不接受任一eval input，adapter dispose后旧authority失效。`transitionManagedSkill`允许curator仅active↔stale/stale→archived，governance仅archived→active；pinned对background no-op。`absorbSkill`只接受durable consolidation attempt origin，先重验destination exact revision已active、source exact base与ownership/pin，再把source archived并记录`absorbedInto`；destination未active或source stale时零source state变化。Restore保留absorption history但清current absorbed marker，使source重新可见。
- 验收：`activation-lineage-schema-discriminates-governance-from-background`、`governance-activation-does-not-invent-permit`、`promote-conflict-recheck`、`activate-pending-four-field-cas`、`authorized-agent-owned-draft-auto-promotes`（T91）、`authorized-agent-owned-patch-auto-activates`（T91）、`auto-promotion-replay-is-idempotent`（T91）、`activation-duplicate-precedes-current-state-and-new-permit-checks`、`auto-activation-lineage-same-cas-as-current-pointer`、`auto-promotion-stale-base-zero-activation`、`consolidation-attempt-revalidated-by-p4-before-p2-call`（T93）、`consolidation-permit-capabilities-reverify-same-signed-scope`（T93）、`evaluation-permit-cannot-enter-production-method`、`eval-adapter-requires-root-bound-process-authority`、`eval-consolidation-requires-both-domain-authorities`（T93）、`eval-and-production-share-private-activation-transaction`、`reject-draft-then-reopen`、`rejected-never-visible`、`curator-cannot-restore-archived`（T82）、`archived-skill-requires-governance-restore`（T82）、`restore-makes-skill-visible`、`transition-pinned-curator-noop`、`absorb-requires-active-exact-destination`（T93）、`absorb-source-stale-keeps-source-visible`（T93）、`absorbed-source-bundle-and-lineage-retained`、`absorbed-source-governance-restore`、`transition-from-mismatch-cas-rejects`、`reconcile-incomplete-and-orphan-counted`。

#### `class ManagedSkillService extends Service`
- 拓扑：P2-D16。
- 职责：唯一`dsh.skill-managed` opener，持有Store/Provider/Authoring/promotion policy；validate Config后注册provider；公开readLearningInventory、mutation/consolidation preflight、create/patch、human governance、仅rollout-permit的`promoteAutonomously`、absorb/transition/finalized-ack/list/provenance methods，不暴露domain handle或低层unchecked activation。Eval-only adapter是P5隔离composition中的独立host面，不注册为production Service方法。Create/patch成功CAS后发typed `revision-committed`；human/auto promotion成功切current后发`revision-activated`。事件payload来自committed result，不预发；observer失败不回滚resource CAS。
- 验收：`managed-domain-opened-exactly-once`、`service-is-only-write-owner`、`provider-and-authoring-share-store`、`unchecked-activation-not-public`、`production-service-rejects-evaluation-permit`（T91）、`revision-event-only-after-successful-cas`、`activation-event-identifies-exact-current-revision`、`observer-failure-does-not-rollback-skill`、`service-hmr-closes-domain-and-provider`。

#### `skill_manage` named tool plugin
- 拓扑：P2-D17。
- 职责：actions仅create-draft|patch-draft；要求`exec.agent`，从`agent.session.header.id + exec.callId + parsed args`调D03 canonicalizer/derive op id；传`origin:{kind:'direct-tool',opId,sessionId,callId}`并由Service固定owner=user；无requestedBy/owner/permit schema，无approve/reject/restore/pin/auto action。工具inject host Service，默认preset不挂。
- 验收：`tool-thin-delegates`、`tool-op-id-derived-from-session-and-call`（T69）、`tool-without-agent-fails-loud`、`same-tool-call-retry-does-not-create-second-revision`、`tool-result-surfaces-error-codes`、`tool-absent-from-default-preset`、`tool-has-no-governance-action`、`p2-does-not-import-session-review`。

## 7. Config 与 Phase 出口

Config 至少包含`managedProviderRank`、`maxFiles/maxTotalBytes/maxFileBytes`、`scanAgentCreatedSkills`、`managedRootName`、`writableRoot`、`autonomousManagedForAgentCreated`、`maxRevisionsPerSkill/maxManagedBytesPerSkill/maxManagedBytesPerProject/maxOrphanBytesPerProject/maxUncommittedRevisionsPerProject`与required `receiptWindowSize`。Repair corroboration门槛属P3 Config，P2只接收Host已分类的evidence class，不保留第二份`minIndependentRepairSessions`。Promotion evidence class和允许的rollout level在schema/README声明，不得隐藏在implementation constant。因为首版不物理删除incomplete/orphan，数量配额触发时诊断必须列出operator可检查的exact paths；服务不得静默放宽上限或自动删除。

RC5.5.5 不把 orphan reclaim 加入 P2-D01–D17。当前 byte+count 配额已使故障积累有界并 fail-closed；自动删除会引入 lineage、pending、reservation 与 review/consolidation-attempt 引用竞态。未来人工治理 reclaim 若立项，输入必须是 branded revision identity + expected bundle/inventory digest，不接受 caller raw path；Host 在 project mutation maintenance lock 下重验 current/pending/reservation/retained lineage 以及 P3 review、P4 consolidation 的 planned/committing/manual/waiting-approval 引用，先写 durable prepared operation，再 rename 到 managed quarantine，重验后删除并记录 terminal/tombstone。quarantine 仍计配额，crash recovery 与 same-op replay 语义必须先钉死。该后续能力不阻断本 Phase，也不能由管理员手删路径替代协议。

Phase 出口：T69/T81/T91/T93/T94中属P2的矩阵全绿；per-file 100%；REAL boot覆盖review create→agent draft→manual/authorized-auto visible、direct create→user draft且永不auto、active patch→pending→activate、destination-first absorb/restore、direct/review receipt、same-call crash retry、人工同名层级；snapshot更新工具结果/错误码；README/Agent Note说明owner与autonomous opt-in分离、storage-only catalog、read revalidation、promotion evidence、activation/absorption lineage、无物理GC、non-Git cwd与restore。
