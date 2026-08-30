# RC5.5 附件 P2 — skill-managed Service（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.5-方案.md`（第六轮 S1-3..S1-5、S1-7..S1-9、S2-1/S2-2；第七轮 S1-1..S1-4）。
>
> 包：`packages/skill/skill-managed`——default export **`ManagedSkillService extends Service`**（唯一 `dsh.skill-managed` 域 opener，拥有 Store/NameIndex/Provider/AuthoringCore）；named export `skill_manage` 工具插件（authoring preset，经 Service 消费）。P3 零搬迁，session-review 直接成为第三消费者。
>
> 依赖：`ctx.fs`（writeText/readText/resolve，无 move/delete——`FsWriteIntent.createIfAbsent` 见 `fs/fs/src/types.ts:123-125`）、`ctx.storageDomain`、`ctx.skills`（`registerProvider`，`skill/src/index.ts:391-400`）、`scanContent`。
>
> 相对 RC5.4-P2（第七轮收口）：一切 API 走 `ManagedSkillRef` 禁止裸 `SkillId`（S1-1）；revision 改 op-derived `ManagedRevisionId` + 完成标记协议（S1-2）；provider 可见谱系 = `active | stale`（S1-3）；`pendingRevision` 四字段 + 未决互斥（S1-4）；get 的 definition summary 取 candidate 冻结字段。
>
> 相对 RC5.5-P2（第八轮收口）：`lastAppliedOpId` 单槽退役——跨 session 窗口（A 落账、B 再写、A 重放）下误报 `stale_base_revision`；改 `appliedOps: SkillAppliedOps` 与 Memory 对称（CAS 同笔落账、查重 pending ∪ recentTerminal、`acknowledgeTerminalOps({ref, opIds}[])`，T65）；`NameIndex` 值改 `NameReservation{skillId, reservedByOpId}`——create 同 op 重入 resume、异 op `name_conflict`（T64）；opId 由 `deriveOpId` 供给（T62/T63）。**开工顺序：先红 T62/T64/T65 三组，再写 mutation path**（第八轮裁定）。RC5.5.2 修补：新增 `transitionManagedSkill` 函数规格（此前总纲/方案/P4/本附件验收名四处引用而零处有签名）；Config `stagingRootName` 更名 `managedRootName`；状态机不变式补 `pinned` L1 无产生点声明。
>
> 日期：2026-08-29（RC5.5.1 增补 2026-08-30；RC5.5.2 修补 2026-08-30）

## 1. 模块布局

```text
src/index.ts          # default export ManagedSkillService；named export skill_manage 插件
src/types.ts          # ProjectKey/SkillId/ManagedSkillRef/ManagedRevisionId/ManagedSkillRecord/NameIndex/CatalogSummary 等
src/provider.ts       # ManagedSkillProvider implements SkillProvider（storage-only list；visible = active|stale）
src/store.ts          # ManagedSkillStore（ManagedSkillRef 定位 + record CAS + ensureNameIndex/reserveName + readRevision + bundleDigest + 完成标记协议）
src/authoring.ts      # AuthoringCore（create/patch/promote/activate/reject/reopen/配额/reconcile；duplicate-before-stale）
src/structure.ts      # validateStructure / validateBundleLayout（纯；完成标记不入 bundleDigest）
src/paths.ts          # bundle 路径（revisions/<ManagedRevisionId>/）+ resolveProjectKey（fs.resolve targetKey hash）
tests/*.spec.ts
```

## 2. 核心不变式

- **唯一所有权（S1-3，T44）**：Service 是域唯一 opener；provider/工具/session-review 一律经 Service；第二 open 即 `already-open` fail-loud。
- **定位传递（S1-1，T55 关联）**：Store/Authoring/治理一切 API 走 `ManagedSkillRef{projectKey, skillId}`，**禁止裸传 `SkillId`**（单向 hash 无法反推 projectKey，storage 键 `skill/<projectKey>/<skillId>` 无从组键）；authoring 入口（create/patch/工具）从 `AuthoringContext{cwd, scope}` 解析 projectKey（同 `resolveMemoryScope` 型），治理/curator 从 record 携带的 projectKey 组 ref；projectKey 解析中间值是 Service 内部实现细节，不做公共类型。
- **Provider 契约**（T34）：`list(options)` / `get(candidate, options)` 全套校验面 + signal 响应。
- **list storage-only（S1-5/S2-2，T46）**：candidate 全字段取自 sidecar `catalogSummary`——不读 bundle；外部篡改 revision frontmatter 不影响模型可见 catalog。单条记录损坏 → last-good + `complete:false` + telemetry；整体故障 throw（registry warn+skip）。
- **可见谱系（S1-3 第七轮，T33/T54）**：provider 可见 = `state ∈ {active, stale}`——stale 是归档倒计时不是隐藏态（tool-skill 每次调用先 re-list，`tool-skill/src/index.ts:134-136`，不可见即无法载入即无法 meaningful-use 复活）；隐藏 = `draft | rejected | archived`。
- **revision 身份（S1-2 第七轮，T55/T56）**：`ManagedRevisionId = hash(skillId, requestedByOpId)`（requestedByOpId 由 `deriveOpId` 纯派生，第八轮 S1-3/T62——恢复重放同 op 同 id，revision 身份才有可靠根基），目录 `revisions/<revisionId>/`——并发 op 永不共路径（顺序 `n+1` 下败者文件穿插覆盖胜者 bundle）；同 op 重放同路径。写入协议：bundle 文件**全量重写**（同 op 重放内容确定相同，覆写同字节无害）→ **完成标记**末位 `createIfAbsent`（首写者胜）。标记在 → bundleDigest 对比计划：符 → duplicate-continue（重放续走 CAS/ledger），异 → `invalid_structure`（异物路径 fail-loud）；标记缺 → 部分写入（crash 所致），重写补标。fs 无 move/delete（T25），部分写入靠重放补全——禁止裸 createIfAbsent 逐文件判 corruption（会把合法重试砖死，第七轮修正一）。
- **资源 receipt（第八轮 S1-1，T65/T57）**：`ManagedSkillRecord.appliedOps: SkillAppliedOps { pendingReceipts, recentTerminalReceipts }` 与 Memory 对称——单槽 `lastAppliedOpId` 已退役（跨 session 窗口：A 落账、B 再写、A 重放 → 单槽已被 B 覆盖 → 已发生的 op 误报 `stale_base_revision`；storageDomain 只保证单 record RMW 串行，无跨资源事务）。`SkillOpReceipt { opId, action, revisionId?, resultDigest }` 在 draft 推进/pending 写入/首次 create 的**同一 record CAS** 内入 `pendingReceipts`；patch/create 先查重——`requestedBy ∈ pending ∪ recentTerminal` → 返回已落结果（duplicate），**先于** base revision/digest 校验；attempt terminal 后经 `acknowledgeTerminalOps` 入有界环（ack 输入 = P3 applied-only opStates，第八轮 S1-4）。
- **create 幂等（第八轮 S1-2，T64）**：`NameIndex` 值 = `NameReservation { skillId, reservedByOpId }`——`reserve(name, skillId, opId)`：不存在 → 占位；同 opId → resume（幂等重入，吸收 reserve 后 bundle 前 crash）；异 opId → `name_conflict`。create 重排：derive 确定性 ref → record receipt 命中 requestedBy → duplicate → op-aware reserve → `writeRevisionBundle`（完成标记吸收部分写入）→ record CAS + receipt。
- **get = trust transition**（T38/T61）：projectKey 校验 → exact revision（`candidate.locator.revision`）→ 整 bundle canonical digest 对比 locator/sidecar → 失配 `undefined` + invalidate + 告警 → 读边界重扫（blocked 拒）→ definition：**summary/invocation 字段取 candidate 冻结值**（registry 契约即"provider 先前返回的 candidate"，`skill/src/index.ts:262-263`；`SkillCandidate extends SkillSummary` 携带 name/description/whenToUse/invocation，RC5.5 S1-4——并发 approve+invalidate 落在 get 内也不产生 body=N/summary=N+1 错配），content 取 revision。
- **可见性分离（原则 #9）**：revision 写入 ≠ 可见。draft/pending/rejected/archived 不出 provider；active（及 stale）才出 catalog。
- **状态机**：`draft | active | stale | archived | rejected`；`draft → rejected`（用户拒绝）；`rejected → draft`（显式 reopen，仅用户）；`archived` 专属曾 active。NameIndex 确定性身份永在（`skillId = hash(projectKey, normalizedName)`）。`pinned` 为用户治理预留位，L1 无产生点（治理命令面无 pin/unpin，恒 false，照 `manual` disposition 先例）；L2 接入用户 pin 命令——Service 层 pinned 门不可绕过（见 `transitionManagedSkill`）。
- **pendingRevision 四字段 + 互斥（S1-4/S1-9 第七轮，T49/T60）**：`pendingRevision{revisionId, contentDigest, catalogSummary, createdByOpId}`——patch 阶段 record 级 `catalogSummary` 不动（改 description 的 patch 不泄漏进 catalog），approve 单 record CAS 四字段原子切换（pointer/digest/summary/清 pending）；active 且 pending 未决再 patch → `pending_pending_conflict`。draft patch 直接推进 currentRevision（不可见面）。
- **项目隔离（S1-4 第六轮，T45）**：`resolveProjectKey = hash(ctx.fs.resolve(findProjectRoot(cwd)).targetKey)`；record/locator/storage key 全携带；非 local backend fail-loud（E0-12）。
- bundle 目录只增不改；`ctx.fs` 无 delete——配额 fail-loud 代替清理；无完成标记的 revision 目录（crash 残留）由重放补全或计 orphan，reconcile 只计数不删除。
- rank=700 仅同层纵深；provider 挂 host 组合（global 层）；跨层真相由 T36 钉。

## 3. 函数规格

#### `resolveProjectKey(cwd, ctx): Promise<ProjectKey>`
- 职责：`findProjectRoot(cwd)`（无 `.git` 回退 cwd）→ `ctx.fs.resolve(root)` → `hash(targetKey)`；remote backend 抛 fail-loud（E0-12）。
- 验收：`project-key-git-ancestor`、`project-key-alias-same-key`（T45）、`project-key-remote-fail-loud`。

#### `class ManagedSkillStore`（Service 内部）
- `ensureRecord(ref)` / `getRecord(ref)` / `casPutRecord(ref, record, expectedRevision)` — 一律 `ManagedSkillRef` 定位（S1-1）；单 record CAS；首录走 missing-key 协议（T24）；键 `skill/<ref.projectKey>/<ref.skillId>`。
- `ensureNameIndex(projectKey)` — get → 缺则 `put(emptyIndex)` → 可 update（T24 协议，T47）。
- `reserveName(projectKey, normalizedName, skillId, requestedBy: OpId): SkillId` — ensure 后单 `update` RMW 写 `NameReservation{skillId, reservedByOpId}`（第八轮 S1-2/T64）：不存在 → 占位；同 opId → resume；异 opId → `name_conflict`；返回 `hash(projectKey, normalizedName)`。
- `releaseName(projectKey, name)` — reconcile 释放占位残留。
- `readRevision(ref, revisionId: ManagedRevisionId, relative?)` — host authoring/debug 读通道（draft 回读不经 provider）。
- `acknowledgeTerminalOps(groups: readonly { ref: ManagedSkillRef, opIds: readonly OpId[] }[]): Promise<void>` — 第八轮 S1-1：逐 ref 读改写 record 的 `SkillAppliedOps`（`splitReceipts` 同型三分，幂等——已入环 duplicate-ack 成功、两无 `invalid_structure`）；输入来自 P3 finalization 的 applied-only opStates（T65/T66）。
- `writeRevisionBundle(ref, revisionId, files, { retry })` — S1-2 写入协议：`revisions/<revisionId>/` 下 bundle 文件全量重写（覆写同字节无害）→ 完成标记末位 `createIfAbsent`；标记在且 digest 符合预期 → duplicate-continue；标记在而 digest 异 → `invalid_structure`；标记缺 → 重写补标（T56）。
- `bundleDigest(revisionDir): Promise<string>` — 文件名排序 + 内容 canonical digest（**排除完成标记**）。
- 验收：`record-cas-conflict`、`record-first-record`、`reserve-concurrent-one-wins`、`reserve-deterministic-id`、`reserve-first-project-initialized`（T47）、`reserve-same-op-resumes`（T64）、`reserve-different-op-conflicts`（T64）、`release-orphan-reservation`、`read-revision-exact`、`revision-path-op-derived-exclusive`（T55）、`partial-bundle-crash-retry-completes`（T56）、`foreign-revision-content-fails-loud`（T56）、`skill-receipt-survives-later-same-skill-op`（T65）、`skill-ack-scoped-and-idempotent`（T65/T66）。

#### `class ManagedSkillProvider implements SkillProvider`（Service 持有并注册）
- `readonly name = 'self-evolution-managed'`（常量 `MANAGED_SKILL_PROVIDER_NAME` 随 Service 导出）。
- `list(options): Promise<readonly SkillCandidate[] | SkillProviderObservation>`
  - 流程：`resolveProjectKey(options.cwd)` → 读该项目 `state ∈ {active, stale}` 记录（可见谱系，S1-3 第七轮——stale 保持可发现，meaningful-use 才有复活通路，T54）→ candidate 全字段取 `catalogSummary`：`{ name, description, whenToUse?, invocation, source:'self-evolution', provider:'self-evolution-managed', rank, locator:{ projectKey, skillId, revision: currentRevision, contentDigest }, path, resourceBase:{ kind:'directory', path: exactRevisionDir } }`。单条损坏 → 跳过 + `complete:false` + warn。
- `get(candidate, options): Promise<SkillDefinition | undefined>`
  - 流程：`resolveProjectKey(options.cwd)` ≠ `candidate.locator.projectKey` → `undefined` → 读 `candidate.locator.revision` → `bundleDigest` ≠ `locator.contentDigest` → `undefined` + invalidate + 告警 → 正文读边界重扫（blocked → `undefined`+告警；caution 放行）→ definition（**summary/invocation 取 candidate 冻结字段，content 取 revision**——S1-4 第七轮/T61；registry 契约 candidate 即 provider 先前返回物，`skill/src/index.ts:262-263`）。
- 验收：`provider-contract-typechecks-against-skill-provider`（T34）、`list-candidate-locator-pins-revision`、`revision-changes-between-list-get-loads-listed-revision`、`get-uses-candidate-frozen-summary`（T61）、`abort-signal-stops-list-and-get`、`provider-list-visible-lineage`（S1-3/T54；原 `provider-list-active-only` 改名改断言）、`stale-remains-discoverable-and-loadable`（T54）、`provider-list-reads-sidecar-not-files`（T46）、`external-frontmatter-tamper-catalog-unaffected`（T46）、`provider-project-a-never-visible-in-project-b`（T35）、`candidate-project-mismatch-get-returns-undefined`、`external-edit-active-skill-refused-on-get`（T38）、`load-boundary-threat-rescan`、`corruption-yields-incomplete-observation`、`provider-promote-appears-after-invalidate`、`same-layer-rank-loses-to-human`（T33）、`cross-layer-shadowing-enumerated`（T36）、`provider-hmr-disposal`。

#### `validateStructure(bundle, config): StructuralReport`
- 结构层（blocking）：路径 bundle 相对、禁 `..`/绝对、`SKILL.md` 唯一特权入口、三向字节/数量上限、UTF-8 text only；内容层：`scanContent` severity（blocked 阻断 / caution 警告放行）。frontmatter 解析产出 `CatalogSummary`（E0-10 字段集）。
- 验收：`structure-path-escape`、`structure-skill-md-required`、`structure-file-count-cap`、`structure-total-bytes-cap`、`structure-binary-rejected`、`structure-severity-caution-passes`、`structure-severity-blocked-rejects`、`structure-shell-snippet-caution-not-block`、`structure-clean-passes`、`structure-summary-extracted`。

#### `class AuthoringCore`（Service 内部；写通道唯一）
- `createDraft(input: { name, files, authoring: AuthoringContext, requestedBy: OpId })`
  - 流程：`resolveProjectKey(authoring.cwd)` + derive 确定性 `skillId`/ref → name 过 `SKILL_NAME` → **record receipt 查重（第八轮 S1-2/T64）：record 存在且 `requestedBy ∈ appliedOps` → 返回已落结果（duplicate）** → `checkNameConflict(authoring)` → `store.ensureNameIndex + reserveName(…, skillId, requestedBy)`（同 op resume / 异 op `name_conflict`，T64）→ `validateStructure` → revision 1 = `hash(skillId, requestedBy)`，`writeRevisionBundle` → record CAS put（draft + `catalogSummary` + `SkillOpReceipt` 入 pendingReceipts，同笔落账）→ invalidate → readback 经 `store.readRevision`。
- `patchDraft(input: { ref: ManagedSkillRef, baseRevision, baseContentDigest, files, requestedBy })`
  - 流程：`getRecord(ref)`（无 record → unknown）→ **duplicate-before-stale（第八轮 S1-1/T65/T57）：`requestedBy ∈ record.appliedOps（pending ∪ recentTerminal）` → 返回已落结果（duplicate），先于一切 base 校验——receipt 集非单槽，跨 session 窗口安全** → record `owner:'agent'` 且 `state:'draft'|'active'` 校验 → **pending 互斥（S1-4）：active 且 `pendingRevision` 未决 → `pending_pending_conflict`** → CAS 双校验（revision + digest）→ `validateStructure` → revision = `hash(skillId, requestedBy)`，`writeRevisionBundle` → **draft：CAS 推进 currentRevision/contentDigest/catalogSummary + receipt 入 pending；active：CAS 记 `pendingRevision{revisionId, contentDigest, catalogSummary, createdByOpId}` + receipt 入 pending，currentRevision/record 级 catalogSummary 不动**（T49/T60）→ invalidate → readback。
- `promoteDraft(ref, expectedRevision)` — 治理面专用：`draft` → `checkNameConflict` 重查 → CAS `active + promotedAt` → invalidate。
- `activatePending(ref, expectedRevision)` — 治理面专用：`active && pendingRevision` → **单 record CAS 四字段原子切换：`currentRevision ← pending.revisionId`、`contentDigest ← pending.contentDigest`、`catalogSummary ← pending.catalogSummary`、清 `pendingRevision`**（S1-4/T60）→ invalidate。
- `reject(ref, expectedRevision)` — 治理面专用：draft → `rejected`；active+pending → 清 pending（该 revision 计 orphan）。
- `reopen(ref, expectedRevision)` — 治理面专用：`rejected → draft`（S1-8，T48）。
- `transitionManagedSkill(ref, from: 'active'|'stale'|'archived', to: 'active'|'stale'|'archived', expectedRevision): Promise<TransitionOutcome>` — 治理/curator 迁移唯一写通道（P4 `runPass` 经此；方案 §3"一切写经 transitionManagedSkill"的落点，RC5.5.2 补规格）：仅 active 谱系；`pinned` 记录 Service 层一律拒绝迁移（no-op + 计入报告——用户门不可绕过，P4 `pinned-user-gate-unbypassable`）；单 record CAS（`from` 或 revision 失配 → `stale_base_revision`）；时间锚点随迁移同笔落账（`stateChangedAt=now`；入 stale 写 `staleAt`、复活清 `staleAt`、入 archived 写 `archivedAt`）；bundle 原位不动；成功后 `invalidate()`。draft/rejected 的流转走 promoteDraft/reject/reopen，不经本方法。
- `checkNameConflict(authoring: AuthoringContext): Promise<NameConflict | undefined>` — (1) `<projectRoot>/.agents/skills/<name>[.md]` 直存；(2) `ctx.skills.list({ cwd, scope: authoring.scope })` winning 同名且 provider ≠ managed（S2-1）。
- `enforceQuotas(projectKey, pendingBytes): void` — 四配额 fail-loud（`budget_exceeded` 附库存）。
- `reconcileStartup(): Promise<ReconcileReport>` — 只记账：orphan revision 计数；**无完成标记的 revision 目录 → `incompleteRevisions` 计数（重放补全或 orphan 化，不删除）**；pointer/pendingRevision 指缺失 revision → `invalid_structure` 报告；占位无 record → 释放。
- 验收（核心组）：`create-draft-lands-invisible`、`create-conflict-rejects`、`create-same-managed-name-suggests-patch-or-reopen`、`create-same-op-reservation-and-record-retry`（T64）、`create-threat-blocked-rejects`、`create-caution-passes-with-warning`、`patch-draft-advances-current`、`patch-active-stays-pending`（T49）、`patch-active-pending-conflict-rejects`（S1-4）、`skill-op-retry-duplicate-before-stale`（T57）、`skill-receipt-survives-later-same-skill-op`（T65）、`activate-pending-four-field-cas`（T60）、`pending-catalog-switches-only-on-approve`（T60）、`reject-pending-clears-and-counts-orphan`、`reject-draft-then-reopen`（T48）、`rejected-never-in-provider`（T48）、`patch-cas-mismatch-rejects`、`patch-external-edit-detected`、`patch-non-agent-owned-rejects`、`promote-pure-sidecar-cas`、`promote-conflict-recheck`、`promote-makes-visible-after-invalidate`、`quota-revisions-fail-loud`、`quota-bytes-fail-loud`、`reconcile-orphan-counted-not-deleted`、`reconcile-incomplete-revision-counted`、`reconcile-releases-orphan-reservation`、`concurrent-authors-cas-one-wins`、`op-derived-revision-path-exclusive`（T55）、`crash-between-bundle-and-pointer-reconciles`、`transition-stale-archive-revive-single-record`、`transition-pinned-service-level-noop`、`transition-from-mismatch-cas-rejects`。

#### `skill_manage` 工具插件（named export；authoring preset 挂载）
- actions：`create-draft` | `patch-draft`；`exec` 取 cwd/scope 组 `AuthoringContext`，Service 内解析 ref（S1-1）；错误码透传（含 `pending_pending_conflict`）；结果 `{ skillId, state, revision, digest }`（active patch 返回 `state:'active', pending:true` 语义字段）；**无 promote/activate/reject/reopen**。
- 经 `inject:['skillManaged']` 消费 host 层 Service（E0-9 形态）。
- 验收：`tool-thin-delegates`、`tool-error-codes-surface`、`tool-pending-conflict-surfaces`、`tool-absent-from-default-preset`、`tool-has-no-governance-action`。

## 4. Config（schemastery）

`managedProviderRank`（默认 700，JSDoc"仅同层纵深"）、`maxFiles`/`maxTotalBytes`/`maxFileBytes`、`scanAgentCreatedSkills`（默认 true）、`managedRootName`（默认 `.dsh/self-evolution/skills`——revisions 根；RC5.5.2 更名自 `stagingRootName`，staging 概念已消亡）、`writableRoot`、配额四项 `maxRevisionsPerSkill`/`maxManagedBytesPerSkill`/`maxManagedBytesPerProject`/`maxOrphanBytesPerProject`。

## 5. 验收门（Phase 出口）

- 附件测试全绿 + 100% 覆盖（状态机全迁移×pending 决策表；provider 可见谱系矩阵 active|stale；配额边界；**T62/T64/T65 三组红测试先于 mutation path 落地**）；
- REAL boot：Service 唯一 opener（双挂载即 `already-open` 暴露，T44）+ 挂载层枚举（T36 三向）+ create→draft→治理 approve→可见→`/name`→active patch pending（catalog 不变）→治理 activate（四字段原子切换，新 revision+summary 生效）全链 + create/patch 同 op crash-retry 幂等链；
- HMR disposal（Service + provider + 工具）；snapshot（工具结果/错误码）；E0-9/E0-12 结案回填；
- README（Model Experience：storage-only catalog 语义 + 可见性分离 + stale 可发现；Known Limitations：无 delete、无物理 GC、usage 活期观测、user 域暂缓、窄删除推迟）+ Agent Note（唯一所有权、ManagedSkillRef 定位传递、op-derived revision 幂等、trust transition、pendingRevision 与 Hermes write-approval 同构）。
