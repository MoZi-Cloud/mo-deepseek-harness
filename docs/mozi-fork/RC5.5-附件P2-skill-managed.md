# RC5.5.3 附件 P2 — skill-managed Service（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；前置：P1；包：`packages/skill/skill-managed`；日期：2026-09-01。
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
src/store.ts       # record/name index/revision I/O/reconcile
src/provider.ts    # storage-only list + verified get
src/authoring.ts   # create/patch/governance/lifecycle/quota
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
                        {kind:'direct-tool',opId,sessionId,callId}
SkillAppliedOps = {pendingReceipts:SkillOpReceipt[],recentTerminalReceipts:BoundedRing}
NameReservation = {skillId,reservedByOpId}
ManagedSkillState = draft | active | stale | archived | rejected
ManagedRevisionLineage = {revisionId,contentDigest,createdByOpId,origin,appliedAt}
PendingRevision = {revisionId,contentDigest,catalogSummary,createdByOpId}
ManagedSkillEvent = revision-committed{ref,revisionId,opId,activated:false} |
                    revision-activated{ref,revisionId,opId,activated:true}
LifecycleRequest =
  | {actor:'curator',from:'active'|'stale',to:'active'|'stale'|'archived',now}
  | {actor:'governance',from:'archived',to:'active',now}
```

provider 可见状态固定为 active|stale；draft/rejected/archived 隐藏。curator 不得恢复 archived；governance restore 不得伪装成 usage。`pinned` 阻止 curator 迁移，不阻止用户显式 restore。每个成功 revision 把 immutable `ManagedRevisionLineage` 与 record 指针/receipt 放在同一 record CAS；receipt ring 可淘汰，lineage 不得淘汰，因而 direct tool 的 session/call 来源不依赖 receipt。D01 同时声明 typed host events；D15 只在成功 CAS 后发 revision-committed/activated，事件不是 state authority，P4 观测失败由 coverage gap 保守处理。

## 3. 开发拓扑

| 顺序 | 节点 | 只可调用 |
|---:|---|---|
| P2-D01 | types/schema + `validateManagedConfig` | P1 content-scan constants、既有 types |
| P2-D02 | `resolveProjectKey/normalizeName` + paths | D01、existing fs |
| P2-D03 | `deriveSkillId/deriveRevisionId/canonicalManagedToolArguments/deriveDirectToolOpId` | D01–D02、crypto |
| P2-D04 | `validateStructure/bundleDigest` | D01、D02 paths、scanContent |
| P2-D05 | `placeMutationReceipt/splitFinalizedSkillReceipts` | D01 |
| P2-D06 | Store record/revision primitives | D01–D05、storage/fs |
| P2-D07 | `ManagedSkillStore.ensureNameIndex` | D06 |
| P2-D08 | Store reservation/provenance/receipt/reconcile methods | D05–D07 |
| P2-D09 | `ManagedSkillProvider` | D02、D04、D06–D08、skills registry |
| P2-D10 | `checkNameConflict/enforceQuotas` | D01–D03、D06–D09、skills registry |
| P2-D11 | `AuthoringCore.preflightMutations` | D02–D10 |
| P2-D12 | `AuthoringCore.createDraft` | D02–D11 |
| P2-D13 | `AuthoringCore.patchDraft` | D02–D11 |
| P2-D14 | governance/lifecycle/reconcile orchestration | D04–D13 |
| P2-D15 | `ManagedSkillService` assembly | D06–D14 |
| P2-D16 | `skill_manage` | D03 direct id、D15 Service、ToolRunContext |

D16 必须最后开发；工具不得临时随机生成 requestedBy。D12/D13 依赖 D05 receipt mode，不能在 authoring 内另写一套 pending 逻辑。

## 4. 叶子、identity 与 validation

#### `validateManagedConfig(config): ResolvedManagedConfig`
- 拓扑：P2-D01。
- 职责：校验 provider rank、文件/总字节/路径/scan 开关、`maxRevisionsPerSkill/maxManagedBytesPerSkill/maxManagedBytesPerProject/maxOrphanBytesPerProject/maxUncommittedRevisionsPerProject` 五配额；`maxFileBytes <= MAX_SCAN_CHARS`；`receiptWindowSize` 与 revision 数量上限为正 safe integer。每个可能进入 definition 的文本文件都受 maxFileBytes，不能只限制 `SKILL.md`。`maxRevisionsPerSkill` 同时给永久 revision lineage 数量上界；`maxUncommittedRevisionsPerProject` 限制没有成功 record lineage 的 incomplete+orphan revision 目录数量，包括零字节目录。达上界后拒绝新 mutation，不淘汰 provenance，也不以字节配额掩盖数量耗尽。
- 验收：`skill-file-limit-above-scan-cap-fails-load`（T81）、`receipt-window-required-positive`、`revision-count-caps-required-positive-safe-integers`、`all-model-visible-files-share-limit`、`exact-valid-config-passes`。

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

#### `validateStructure(bundle,config): StructuralReport` / `bundleDigest(files): string`
- 拓扑：P2-D04。
- 职责：relative paths、无 `..`/absolute/symlink/binary、唯一 `SKILL.md`、file count/bytes；每个模型可见 text file 整文件 scan，blocked 拒绝、caution 记录；frontmatter 的所有模型可见字段包含在受 cap 的原文件；digest 排序文件名并排除 completion marker。
- 验收：`structure-path-escape`、`structure-skill-md-required`、`structure-file-count-cap`、`structure-total-bytes-cap`、`structure-binary-rejected`、`structure-severity-caution-passes`、`structure-severity-blocked-rejects`、`every-model-visible-skill-field-is-within-scanned-file`（T81）、`bundle-digest-order-stable`。

#### `placeMutationReceipt(appliedOps,receipt,origin,windowSize): SkillAppliedOps`
- 拓扑：P2-D05。
- 职责：review origin 加入 pending；direct-tool origin 直接加入 terminal ring 并有界；已知 op 返回原 receipt；同 op 在另一区域出现时按 origin 校验，direct-tool 不得迁移一个 review pending。
- 验收：`review-receipt-enters-pending`、`foreground-skill-receipt-enters-terminal-ring`（T69）、`foreground-receipts-remain-bounded`、`direct-cannot-terminalize-review-pending`、`known-op-placement-idempotent`。

#### `splitFinalizedSkillReceipts(appliedOps,finalizedOpIds,windowSize): SkillAppliedOps`
- 拓扑：P2-D05。
- 职责：只供 P3 ledger 已 finalized 后的 review receipt cleanup；pending→ring、ring no-op、两无 no-op（已 finalized receipt 可已从 ring 淘汰）；空 id/无效 ref 仍 invalid_structure。未 finalized review pending 永不淘汰。
- 验收：`skill-finalized-ack-moves-pending`、`skill-finalized-ack-retry-idempotent`、`skill-finalized-ack-after-eviction-noop`（T85）、`skill-unfinalized-pending-never-evicted`、`skill-terminal-ring-bounded`、`skill-finalized-ack-empty-id-fails`。

## 5. Store 与 Provider

#### `ManagedSkillStore` record/revision primitives
- 拓扑：P2-D06。
- `getRecord/casPutRecord(ref,expectedRevision)`：只接 ManagedSkillRef。
- `writeRevisionBundle(ref,revisionId,files)`：全量重写，completion marker 最后 createIfAbsent；marker 已在且 digest 同则续跑，异则 invalid_structure；无 marker 的 partial bundle 重放补全。
- 验收：`record-first-record`、`record-cas-conflict`、`partial-bundle-crash-retry-completes`、`foreign-revision-content-fails-loud`。

#### `ManagedSkillStore.ensureNameIndex(projectKey)`
- 拓扑：P2-D07；调用 D06 storage primitives。
- 职责：get→missing put empty→update；并发 first initialization 收敛为一个合法 index，不以覆盖 put 充当 CAS。
- 验收：`name-index-first-record`、`concurrent-name-index-initialization-converges`。

#### `ManagedSkillStore` reservation/provenance/receipt/reconcile methods
- 拓扑：P2-D08；调用 D05–D07。
- `reserveName(projectKey,name,skillId,opId)`：先 D07 ensure；不存在占位，同 op resume，异 op name_conflict。
- `resolveMutationProvenance(opId)`：从 record 中的 immutable revision lineage 查找 review op 指针或 direct-tool session/call；允许重建的 op index 只是加速投影，缺失时扫 lineage 补回，冲突 fail-loud。
- `findAppliedMutation(opId)`：在 receipt duplicate 检查后查 immutable lineage；terminal receipt 已淘汰但 lineage 已有该 op 时仍返回 duplicate，必须早于 base/state/pending 检查。
- `acknowledgeFinalizedOps(groups)`：调用 D05 finalized split；输入仅 ledger 已 finalized 的 review applied/duplicate opStates；P2 不导入 P3，前置由 host 调用顺序保证。
- `rebuild/reconcile`：释放 reservation-without-record；记录 incomplete/orphan 的 path、byte count 与 count，不物理删除；同一目录重扫不得重复计数。
- 验收：`reserve-first-project-initialized`、`reserve-same-op-resumes`、`reserve-different-op-conflicts`、`skill-receipt-survives-later-same-skill-op`、`skill-finalized-ack-scoped-and-idempotent`、`revision-lineage-written-with-successful-record-cas`、`direct-tool-provenance-survives-receipt-eviction`、`evicted-direct-receipt-still-duplicates-via-lineage`、`provenance-index-rebuilds-from-lineage`、`reconcile-releases-orphan-reservation`、`reconcile-identifies-zero-byte-uncommitted-revision`、`reconcile-rescan-does-not-double-count-orphan`。

#### `class ManagedSkillProvider implements SkillProvider`
- 拓扑：P2-D09。
- `list(options)`：project resolve；只读 storage sidecar；active|stale；candidate locator 钉 project/ref/revision/digest；单 record 损坏 → skip + complete:false，整体失败 throw。
- `get(candidate,options)`：project/ref 校验 → exact revision → whole bundle digest → 每个可见文件 read-boundary re-scan → definition body；summary/invocation 取 candidate 冻结字段，避免并发 approve 混代。
- 验收：`provider-contract-typechecks`、`provider-list-visible-lineage`、`provider-list-reads-sidecar-not-files`、`stale-remains-discoverable-and-loadable`、`get-uses-candidate-frozen-summary`、`external-edit-active-skill-refused-on-get`、`load-boundary-threat-rescan-all-files`、`provider-project-isolation`、`abort-signal-stops-list-and-get`、`provider-hmr-disposal`。

## 6. Authoring、Service 与工具

#### `checkNameConflict(authoring,name)` / `enforceQuotas(projectKey,pendingInventory)`
- 拓扑：P2-D10。
- 职责：人工直存与 registry winning candidate 双检查；managed 同名指向 patch/reopen；按 current records + completed/incomplete/orphan revisions + pending batch 聚合上述五项库存配额，fail-loud 返回 bytes/count/path 分类 inventory。尚无内容或 completion marker 的 revision 也占一个 uncommitted count；成功进入 immutable lineage 后从 uncommitted 转入 per-skill revision count，不得两边重复计数。同 op 重放已存在的 partial revision 时，count delta 为零，bytes 以“用完整目标 bundle 替换现有 partial bytes”的 projected inventory 计算；因此达到 count 上限仍允许该 op 原地完成，但不得借 resume 写另一个 revision 或突破 bytes 上限。
- 验收：`conflict-human-direct-source`、`conflict-winning-nonmanaged-provider`、`managed-same-name-suggests-patch`、`quota-exact-boundary`、`quota-error-inventory`、`revision-cap-bounds-immutable-lineage`、`orphan-bytes-participate-in-quota`、`zero-byte-orphan-participates-in-count-quota`、`completed-lineage-not-double-counted-as-uncommitted`、`pending-batch-aggregates-uncommitted-count`、`same-op-partial-resume-at-count-cap-is-allowed`、`partial-resume-projects-full-target-bytes`、`different-op-at-count-cap-is-rejected`。

#### `AuthoringCore.preflightMutations(inputs): Promise<ManagedPreflight>`
- 拓扑：P2-D11；调用 D02–D10；create/patch 只复用这些更早的 validation/store helpers，不复制规则。
- 职责：**review admission 专用的只读 batch 预检**；在一组一致 storage/provider views 上执行 duplicate-before-base、project/owner/state/pending、name conflict、plan 内重复 name/ref、structure/full-file scan 与聚合 quota 检查。不 reserve name、不写 bundle/record/receipt/lineage。预检后的竞态由 create/patch 的 reservation/CAS 捕获并返回 stale 给 P3 supersede；preflight 不假装跨 storage 和 filesystem 事务。
- 验收：`preflight-matches-create-and-patch-validation`、`preflight-never-reserves-name-or-writes`、`preflight-detects-existing-pending-conflict`、`preflight-detects-intra-plan-name-and-ref-conflict`、`preflight-aggregates-whole-plan-quota`、`preflight-race-still-fails-mutation-cas`。

#### `AuthoringCore.createDraft(input,origin)`
- 拓扑：P2-D12；调用 D02–D11。
- 职责：resolve project/name/ref → existing receipt/lineage duplicate → human conflict → op-aware reservation → structure/quota → op-derived revision bundle → record CAS 同笔写 state+receipt+immutable lineage。review receipt pending；direct-tool receipt terminal ring。模型不能选择 origin。
- 验收：`create-draft-lands-invisible`、`create-conflict-rejects`、`create-same-op-reservation-and-record-retry`、`create-threat-blocked-rejects`、`create-caution-passes`、`create-review-receipt-pending`、`create-direct-receipt-terminal`、`concurrent-authors-cas-one-wins`。

#### `AuthoringCore.patchDraft(input,origin)`
- 拓扑：P2-D13；调用 D02–D11，不调用 createDraft。
- 职责：record receipt/lineage duplicate-before-base → owner/state/pending gate → exact revision+digest CAS → structure/quota → bundle → draft current pointer 或 active pending 四字段 + receipt + immutable lineage 同笔 CAS。active current catalog 不变直到 approve。
- 验收：`patch-draft-advances-current`、`patch-active-stays-pending`、`patch-active-pending-conflict-rejects`、`skill-op-retry-duplicate-before-stale`、`skill-receipt-survives-later-same-skill-op`、`pending-catalog-switches-only-on-approve`、`patch-review-vs-direct-receipt-mode`。

#### `promoteDraft/activatePending/reject/reopen/transitionManagedSkill/reconcileStartup`
- 拓扑：P2-D14；调用 D04–D13。
- 职责：治理 CAS 全重验；approve pending 原子切 pointer/digest/summary/clear；reject draft→rejected 或 clear pending；reopen rejected→draft。`transitionManagedSkill` 检查 actor：curator 仅 active↔stale、stale→archived，pinned no-op；governance 仅 archived→active，允许用户 restore；时间锚点同 CAS。
- 验收：`promote-conflict-recheck`、`activate-pending-four-field-cas`、`reject-draft-then-reopen`、`rejected-never-visible`、`curator-cannot-restore-archived`（T82）、`archived-skill-requires-governance-restore`（T82）、`restore-makes-skill-visible`、`transition-pinned-curator-noop`、`transition-from-mismatch-cas-rejects`、`reconcile-incomplete-and-orphan-counted`。

#### `class ManagedSkillService extends Service`
- 拓扑：P2-D15。
- 职责：唯一 `dsh.skill-managed` opener，持有 Store/Provider/Authoring；validate Config 后注册 provider；公开 preflight/create/patch/governance/transition/finalized-ack/list/provenance methods，不暴露 domain handle。create/patch 成功 CAS 后发 typed `revision-committed`；promote/activate 成功切 current 后发 `revision-activated`。事件 payload 来自 committed result，不预发；observer 失败不回滚资源 CAS。
- 验收：`managed-domain-opened-exactly-once`、`service-is-only-write-owner`、`provider-and-authoring-share-store`、`revision-event-only-after-successful-cas`、`activation-event-identifies-exact-current-revision`、`observer-failure-does-not-rollback-skill`、`service-hmr-closes-domain-and-provider`。

#### `skill_manage` named tool plugin
- 拓扑：P2-D16。
- 职责：actions 仅 create-draft|patch-draft；要求 `exec.agent`，从 `agent.session.header.id + exec.callId + parsed args` 调 D03 canonicalizer/derive op id；传 `origin:{kind:'direct-tool',opId,sessionId,callId}`；无 requestedBy schema，无 approve/reject/restore。工具 inject host Service，默认 preset 不挂。
- 验收：`tool-thin-delegates`、`tool-op-id-derived-from-session-and-call`（T69）、`tool-without-agent-fails-loud`、`same-tool-call-retry-does-not-create-second-revision`、`tool-result-surfaces-error-codes`、`tool-absent-from-default-preset`、`tool-has-no-governance-action`、`p2-does-not-import-session-review`。

## 7. Config 与 Phase 出口

Config 至少包含 `managedProviderRank`、`maxFiles/maxTotalBytes/maxFileBytes`、`scanAgentCreatedSkills`、`managedRootName`、`writableRoot`、`maxRevisionsPerSkill/maxManagedBytesPerSkill/maxManagedBytesPerProject/maxOrphanBytesPerProject/maxUncommittedRevisionsPerProject` 与 required `receiptWindowSize`。默认全部在 schema/README 声明；不得依靠 implementation-only constant。因为首版不物理删除 incomplete/orphan，数量配额触发时诊断必须列出 operator 可检查的 exact paths；服务不得静默放宽上限或自动删除。

Phase 出口：T69/T81 与原 P2 矩阵全绿；per-file 100%；REAL boot 覆盖 create→draft→approve→visible、active patch→pending→activate、direct/review receipt、same-call crash retry、人工同名层级与 restore；snapshot 更新工具结果/错误码；README/Agent Note 说明 storage-only catalog、read revalidation、direct/review receipt、无物理 GC、non-Git cwd 与 archived restore。
