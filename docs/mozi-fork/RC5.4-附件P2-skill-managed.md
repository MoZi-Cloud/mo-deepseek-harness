# RC5.4 附件 P2 — skill-managed Service（函数级规格）

> 上位：`RC5.4-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.4-方案.md`（第六轮 S1-3..S1-5、S1-7..S1-9、S2-1/S2-2）。
>
> 包：`packages/skill/skill-managed`——default export **`ManagedSkillService extends Service`**（唯一 `dsh.skill-managed` 域 opener，拥有 Store/NameIndex/Provider/AuthoringCore）；named export `skill_manage` 工具插件（authoring preset，经 Service 消费）。P3 零搬迁，session-review 直接成为第三消费者。
>
> 依赖：`ctx.fs`（writeText/readText/resolve，无 move/delete）、`ctx.storageDomain`、`ctx.skills`（`registerProvider`，`skill/src/index.ts:391-400`）、`scanContent`。
>
> 日期：2026-08-29

## 1. 模块布局

```text
src/index.ts          # default export ManagedSkillService；named export skill_manage 插件
src/types.ts          # ProjectKey/SkillId/ManagedSkillRecord/NameIndex/CatalogSummary 等
src/provider.ts       # ManagedSkillProvider implements SkillProvider（storage-only list）
src/store.ts          # ManagedSkillStore（record CAS + ensureNameIndex/reserveName + readRevision + bundleDigest）
src/authoring.ts      # AuthoringCore（create/patch/promote/activate/reject/reopen/配额/reconcile）
src/structure.ts      # validateStructure / validateBundleLayout（纯）
src/paths.ts          # bundle 路径 + resolveProjectKey（fs.resolve targetKey hash）
tests/*.spec.ts
```

## 2. 核心不变式

- **唯一所有权（S1-3，T44）**：Service 是域唯一 opener；provider/工具/session-review 一律经 Service；第二 open 即 `already-open` fail-loud。
- **Provider 契约**（T34）：`list(options)` / `get(candidate, options)` 全套校验面 + signal 响应。
- **list storage-only（S1-5/S2-2，T46）**：candidate 全字段取自 sidecar `catalogSummary`——不读 bundle；外部篡改 revision frontmatter 不影响模型可见 catalog。单条记录损坏 → last-good + `complete:false` + telemetry；整体故障 throw（registry warn+skip）。
- **get = trust transition**（T38）：projectKey 校验 → exact revision → 整 bundle canonical digest 对比 locator/sidecar → 失配 `undefined` + invalidate + 告警 → 读边界重扫（blocked 拒）→ definition（summary 取 sidecar、content 取 revision）。
- **可见性分离（原则 #9）**：revision 写入 ≠ 可见。draft/pending/rejected/archived 不出 provider；active 才出 catalog。
- **状态机**：`draft | active | stale | archived | rejected`；`draft → rejected`（用户拒绝）；`rejected → draft`（显式 reopen，仅用户）；`archived` 专属曾 active。NameIndex 确定性身份永在（`skillId = hash(projectKey, normalizedName)`）。
- **pendingRevision（S1-9，T49）**：active patch 写新 revision 只记 `pendingRevision{revision,digest}`，`currentRevision` 不动；approve 才 CAS 切 pointer。draft patch 直接推进 currentRevision（不可见面）。
- **项目隔离（S1-4，T45）**：`resolveProjectKey = hash(ctx.fs.resolve(findProjectRoot(cwd)).targetKey)`；record/locator/storage key 全携带；非 local backend fail-loud（E0-12）。
- bundle 目录只增不改；`ctx.fs` 无 delete——配额 fail-loud 代替清理。
- rank=700 仅同层纵深；provider 挂 host 组合（global 层）；跨层真相由 T36 钉。

## 3. 函数规格

#### `resolveProjectKey(cwd, ctx): Promise<ProjectKey>`
- 职责：`findProjectRoot(cwd)`（无 `.git` 回退 cwd）→ `ctx.fs.resolve(root)` → `hash(targetKey)`；remote backend 抛 fail-loud（E0-12）。
- 验收：`project-key-git-ancestor`、`project-key-alias-same-key`（T45）、`project-key-remote-fail-loud`。

#### `class ManagedSkillStore`（Service 内部）
- `ensureRecord(skillId)` / `getRecord(skillId)` / `casPutRecord(record, expectedRevision)` — 单 record CAS；首录走 missing-key 协议（T24）；键 `skill/<projectKey>/<skillId>`。
- `ensureNameIndex(projectKey)` — get → 缺则 `put(emptyIndex)` → 可 update（T24 协议，T47）。
- `reserveName(projectKey, normalizedName): SkillId` — ensure 后单 `update` RMW 占位；已占位 → `name_conflict`；返回 `hash(projectKey, normalizedName)`。
- `releaseName(projectKey, name)` — reconcile 释放占位残留。
- `readRevision(skillId, revision, relative?)` — host authoring/debug 读通道（draft 回读不经 provider）。
- `bundleDigest(revisionDir): Promise<string>` — 文件名排序 + 内容 canonical digest。
- 验收：`record-cas-conflict`、`record-first-record`、`reserve-concurrent-one-wins`、`reserve-deterministic-id`、`reserve-first-project-initialized`（T47）、`release-orphan-reservation`、`read-revision-exact`。

#### `class ManagedSkillProvider implements SkillProvider`（Service 持有并注册）
- `readonly name = 'self-evolution-managed'`（常量 `MANAGED_SKILL_PROVIDER_NAME` 随 Service 导出）。
- `list(options): Promise<readonly SkillCandidate[] | SkillProviderObservation>`
  - 流程：`resolveProjectKey(options.cwd)` → 读该项目 `state==='active'` 记录 → candidate 全字段取 `catalogSummary`：`{ name, description, whenToUse?, invocation, source:'self-evolution', provider:'self-evolution-managed', rank, locator:{ projectKey, skillId, revision: currentRevision, contentDigest }, path, resourceBase:{ kind:'directory', path: exactRevisionDir } }`。单条损坏 → 跳过 + `complete:false` + warn。
- `get(candidate, options): Promise<SkillDefinition | undefined>`
  - 流程：`resolveProjectKey(options.cwd)` ≠ `candidate.locator.projectKey` → `undefined` → 读 `candidate.locator.revision` → `bundleDigest` ≠ `locator.contentDigest` → `undefined` + invalidate + 告警 → 正文读边界重扫（blocked → `undefined`+告警；caution 放行）→ definition（summary=sidecar，content=revision）。
- 验收：`provider-contract-typechecks-against-skill-provider`（T34）、`list-candidate-locator-pins-revision`、`revision-changes-between-list-get-loads-listed-revision`、`abort-signal-stops-list-and-get`、`provider-list-active-only`、`provider-list-reads-sidecar-not-files`（T46）、`external-frontmatter-tamper-catalog-unaffected`（T46）、`provider-project-a-never-visible-in-project-b`（T35）、`candidate-project-mismatch-get-returns-undefined`、`external-edit-active-skill-refused-on-get`（T38）、`load-boundary-threat-rescan`、`corruption-yields-incomplete-observation`、`provider-promote-appears-after-invalidate`、`same-layer-rank-loses-to-human`（T33）、`cross-layer-shadowing-enumerated`（T36）、`provider-hmr-disposal`。

#### `validateStructure(bundle, config): StructuralReport`
- 结构层（blocking）：路径 bundle 相对、禁 `..`/绝对、`SKILL.md` 唯一特权入口、三向字节/数量上限、UTF-8 text only；内容层：`scanContent` severity（blocked 阻断 / caution 警告放行）。frontmatter 解析产出 `CatalogSummary`（E0-10 字段集）。
- 验收：`structure-path-escape`、`structure-skill-md-required`、`structure-file-count-cap`、`structure-total-bytes-cap`、`structure-binary-rejected`、`structure-severity-caution-passes`、`structure-severity-blocked-rejects`、`structure-shell-snippet-caution-not-block`、`structure-clean-passes`、`structure-summary-extracted`。

#### `class AuthoringCore`（Service 内部；写通道唯一）
- `createDraft(input: { name, files, authoring: AuthoringContext, requestedBy: OpId })`
  - 流程：name 过 `SKILL_NAME` → `checkNameConflict(authoring)` → `store.ensureNameIndex + reserveName`（原子占位；同名存在 → `name_conflict`，提示 patch/reopen）→ `validateStructure` → 写 revision 1 → record CAS put（draft + `catalogSummary`）→ invalidate → readback 经 `store.readRevision`。
- `patchDraft(input: { skillId, baseRevision, baseContentDigest, files, requestedBy })`
  - 流程：record `owner:'agent'` 且 `state:'draft'|'active'` → CAS 双校验（revision + digest）→ 写新 revision `n+1` → **draft：CAS 推进 currentRevision；active：CAS 只记 `pendingRevision{n+1,digest}`，currentRevision 不动**（T49）→ invalidate → readback。
- `promoteDraft(skillId, expectedRevision)` — 治理面专用：`draft` → `checkNameConflict` 重查 → CAS `active + promotedAt` → invalidate。
- `activatePending(skillId, expectedRevision)` — 治理面专用：`active && pendingRevision` → CAS 切 `currentRevision = pendingRevision` 并清除（T49）。
- `reject(skillId, expectedRevision)` — 治理面专用：draft → `rejected`；active+pending → 清 pending（该 revision 计 orphan）。
- `reopen(skillId, expectedRevision)` — 治理面专用：`rejected → draft`（S1-8，T48）。
- `checkNameConflict(authoring: AuthoringContext): Promise<NameConflict | undefined>` — (1) `<projectRoot>/.agents/skills/<name>[.md]` 直存；(2) `ctx.skills.list({ cwd, scope: authoring.scope })` winning 同名且 provider ≠ managed（S2-1）。
- `enforceQuotas(projectKey, pendingBytes): void` — 四配额 fail-loud（`budget_exceeded` 附库存）。
- `reconcileStartup(): Promise<ReconcileReport>` — 只记账：orphan revision 计数；pointer/pendingRevision 指缺失 revision → `invalid_structure` 报告；占位无 record → 释放。
- 验收（核心组）：`create-draft-lands-invisible`、`create-conflict-rejects`、`create-same-managed-name-suggests-patch-or-reopen`、`create-threat-blocked-rejects`、`create-caution-passes-with-warning`、`patch-draft-advances-current`、`patch-active-stays-pending`（T49）、`activate-pending-switches-pointer`（T49）、`reject-pending-clears-and-counts-orphan`、`reject-draft-then-reopen`（T48）、`rejected-never-in-provider`（T48）、`patch-cas-mismatch-rejects`、`patch-external-edit-detected`、`patch-non-agent-owned-rejects`、`promote-pure-sidecar-cas`、`promote-conflict-recheck`、`promote-makes-visible-after-invalidate`、`quota-revisions-fail-loud`、`quota-bytes-fail-loud`、`reconcile-orphan-counted-not-deleted`、`reconcile-releases-orphan-reservation`、`concurrent-authors-cas-one-wins`、`crash-between-bundle-and-pointer-reconciles`、`transition-stale-archive-revive-single-record`。

#### `skill_manage` 工具插件（named export；authoring preset 挂载）
- actions：`create-draft` | `patch-draft`；错误码透传；结果 `{ skillId, state, revision, digest }`（active patch 返回 `state:'active', pending:true` 语义字段）；**无 promote/activate/reject/reopen**。
- 经 `inject:['skillManaged']` 消费 host 层 Service（E0-9 形态）。
- 验收：`tool-thin-delegates`、`tool-error-codes-surface`、`tool-absent-from-default-preset`、`tool-has-no-governance-action`。

## 4. Config（schemastery）

`managedProviderRank`（默认 700，JSDoc"仅同层纵深"）、`maxFiles`/`maxTotalBytes`/`maxFileBytes`、`scanAgentCreatedSkills`（默认 true）、`stagingRootName`（默认 `.dsh/self-evolution/skills`）、`writableRoot`、配额四项 `maxRevisionsPerSkill`/`maxManagedBytesPerSkill`/`maxManagedBytesPerProject`/`maxOrphanBytesPerProject`。

## 5. 验收门（Phase 出口）

- 附件测试全绿 + 100% 覆盖（状态机全迁移×pending 决策表；provider 可见性矩阵；配额边界）；
- REAL boot：Service 唯一 opener（双挂载即 `already-open` 暴露，T44）+ 挂载层枚举（T36 三向）+ create→draft→治理 approve→可见→`/name`→active patch pending→治理 activate→新 revision 生效全链；
- HMR disposal（Service + provider + 工具）；snapshot（工具结果/错误码）；E0-9/E0-12 结案回填；
- README（Model Experience：storage-only catalog 语义 + 可见性分离；Known Limitations：无 delete、无物理 GC、usage 活期观测、user 域暂缓、窄删除推迟）+ Agent Note（唯一所有权、trust transition、pendingRevision 与 Hermes write-approval 同构）。
