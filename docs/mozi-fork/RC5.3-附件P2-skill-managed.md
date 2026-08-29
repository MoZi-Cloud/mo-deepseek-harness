# RC5.3 附件 P2 — Managed skill provider + authoring（函数级规格）

> 上位：`RC5.3-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.3-方案.md`（第五轮 S1-1..S1-6、S1-14 全面重构）。
>
> 包：`packages/skill/tool-skill-manage`——**ManagedSkillProvider + ManagedSkillStore + AuthoringCore + skill_manage 薄工具**；P3 抽 provider/core 为 skill-authoring Service。
>
> 依赖：`ctx.fs`（只 writeText/readText——seam 无 move/delete，`fs/src/index.ts:86-256`）、`ctx.storageDomain`、`ctx.skills`（`registerProvider` 持 `SkillProviderControl`，`skill/src/index.ts:391-400`）、`scanContent`。
>
> 日期：2026-08-29

## 1. 模块布局

```text
src/index.ts          # 双插件导出：providerPlugin（host cordis.yml，global 层）+ authoringPlugin（authoring preset，工具）
src/types.ts          # ProjectKey/SkillId/ManagedSkillRecord/NameIndex/SkillBundle/Finding 等
src/provider.ts       # ManagedSkillProvider implements SkillProvider（真实契约）
src/store.ts          # ManagedSkillStore（record CAS + NameIndex 原子占位 + readRevision + bundleDigest）
src/authoring.ts      # AuthoringCore（create/patch/promote/reconcile）
src/structure.ts      # validateStructure / validateBundleLayout（纯；severity 扫描）
src/paths.ts          # bundle 路径（<projectRoot>/.dsh/self-evolution/skills/<skillId>/revisions/<n>/…）+ resolveProjectKey
tests/*.spec.ts
```

## 2. 核心不变式

- **Provider 契约（S1-1）**：`list(options): Promise<readonly SkillCandidate[] | SkillProviderObservation>`、`get(candidate, options): Promise<SkillDefinition | undefined>`（`skill/src/index.ts:248-268`）；candidate 过 registry 全套校验（provider 字段 === `self-evolution-managed` `:734-736`、`SKILL_NAME` `:20`、`source` string、rank 数值）；list/get 响应 `options.signal`。
- **Locator 钉死 revision**：`locator = { projectKey, skillId, revision, contentDigest }`；`get` 按 locator 读 exact revision，绝不重读 currentRevision。
- **项目隔离（S1-3）**：`projectKey` 进 record/locator/storage key；`list` 按 `options.cwd` 解析 projectKey 后只出该项目 active 记录；storageDomain 进程级单例（`storage-domain/src/index.ts:200-220`），键编码项目身份。
- **Rank 与挂载（S1-4，撤回恒胜断言）**：registry 是最近层直接赢、rank 仅同层内比较（`skill/src/index.ts:352-354,552-556`）。`managedProviderRank` 默认 700 = **同层纵深**；provider 挂 host 组合（global 层，与 filesystem ranks 100–600 同层 → 人工恒胜成立且被 REAL 测试枚举钉死）；preset 层挂载 = 刻意遮蔽，文档明示不作为缺陷。
- **bundle 目录只增不改**（不可变 revision）；生命周期 = `ManagedSkillRecord` 单 record CAS + `control.invalidate()`；`ctx.fs` 无 delete——首版无任何物理清理（S1-14），配额 fail-loud 代替。
- **draft/非 active 永不出 provider**；authoring 回读走 `ManagedSkillStore.readRevision`（S1-2），provider 协议内不存在 draft candidate。
- 崩溃语义：bundle 写完而 pointer 未更新 = 不可见 orphan revision；NameIndex 已占位而 record 未落 = 占位残留，启动 reconcile 释放。
- 全部文件写经 `ctx.fs.writeText`（text-only；binary/symlink 结构层拒绝）。

## 3. 函数规格

#### `resolveProjectKey(cwd: string | undefined): ProjectKey`
- 职责：项目根解析与 `findProjectRoot` 同源（E0-7）；无 `.git` 回退 cwd；结果 branded。
- 验收：`project-key-git-ancestor`、`project-key-no-git-cwd`、`project-key-stable-across-alias`（同源规则下同根同 key）。

#### `class ManagedSkillStore`
- `ensureRecord(skillId)` / `getRecord(skillId)` / `casPutRecord(record, expectedRevision)` — `storageDomain.update` 单 record CAS（`stale_base_revision`）；首录走 `missing-key` 初始化协议（T24）；键 = `skill/<projectKey>/<skillId>`。
- `reserveName(projectKey, normalizedName): SkillId` — per-project NameIndex（键 = `index/<projectKey>`）单 `update` RMW 原子占位（`put` 是覆盖写不能做 compare-and-put，T24/T37）；已占位 → `name_conflict`；返回确定性 `SkillId = hash(projectKey, normalizedName)`。
- `releaseName(projectKey, name)` — reconcile 用（占位残留）。
- `readRevision(skillId, revision, relative?)` — **host authoring/debug 读通道**（S1-2）：读 exact revision 的单文件或 bundle 清单，不经 provider 协议。
- `bundleDigest(revisionDir): Promise<string>` — 整 bundle canonical digest（文件名排序 + 内容），digest 是正确性依据。
- 验收：`record-cas-conflict`、`record-first-record`、`reserve-concurrent-one-wins`、`reserve-deterministic-id`、`release-orphan-reservation`、`read-revision-exact`。

#### `class ManagedSkillProvider implements SkillProvider`
- `readonly name = 'self-evolution-managed'`。
- `list(options): Promise<readonly SkillCandidate[] | SkillProviderObservation>`
  - 流程：`resolveProjectKey(options.cwd)` → 读该项目的 active 记录 → 逐条构造 candidate：`{ name, description（frontmatter）, invocation, source:'self-evolution', provider:'self-evolution-managed', rank: managedProviderRank, locator:{ projectKey, skillId, revision, contentDigest }, path, resourceBase:{ kind:'directory', path: exactRevisionDir } }`（S2-7：resourceBase 恒指 exact revision 目录）。
  - 单条记录损坏（pointer 指缺失 bundle 等）：跳过该条 + `complete:false` 返回 last-good candidates + telemetry warn（S2-6；registry 对 incomplete 不缓存，`skill/src/index.ts:612`）；整存储故障 throw（registry warn+skip+不缓存，`:603-609`）。不静默当空目录。
- `get(candidate, options): Promise<SkillDefinition | undefined>`
  - 流程：`resolveProjectKey(options.cwd)` ≠ `candidate.locator.projectKey` → `undefined`（跨项目 candidate 拒绝）→ 按 locator.revision 读 exact revision → `bundleDigest` ≠ `locator.contentDigest` → `undefined` + `control.invalidate()` + loud 告警（外部篡改检出，T38）→ SKILL.md 正文读边界重扫（blocked → `undefined` + 告警；caution 放行）→ 返回 definition（content/path/metadata 同步自该 revision）。
  - signal：读与 digest 计算检查 `options.signal`。
- 注册：host 组合 `ctx.skills.registerProvider(control => { this.control = control; return provider })`；sidecar 变更后 `control.invalidate()`（T26）。
- 验收：`provider-contract-typechecks-against-skill-provider`（T34）、`list-candidate-locator-pins-revision`、`revision-changes-between-list-get-loads-listed-revision`、`abort-signal-stops-list-and-get`、`provider-list-active-only`、`provider-project-a-never-visible-in-project-b`（T35）、`candidate-project-mismatch-get-returns-undefined`、`external-edit-active-skill-refused-on-get`（T38）、`external-edit-support-file-breaks-bundle-digest`、`load-boundary-threat-rescan`、`corruption-yields-incomplete-observation`（S2-6）、`provider-promote-appears-after-invalidate`、`same-layer-rank-loses-to-human`（T33）、`cross-layer-shadowing-enumerated`（T36，REAL）、`provider-hmr-disposal`。

#### `validateStructure(bundle: SkillBundle, config): StructuralReport`
- 职责：纯函数，两级——结构层（blocking）：`files[].path` bundle 相对、禁 `..`/绝对、`SKILL.md` 唯一特权入口、max files/max total bytes/max single file bytes（Config）、UTF-8 text only；内容层（severity）：`scanContent` → blocked 阻断（`threat_scan_blocked`）、caution 附警告放行。无语法禁令（`${…}`/shell 片段为惰性文本）。
- 验收：`structure-path-escape`、`structure-skill-md-required`、`structure-file-count-cap`、`structure-total-bytes-cap`、`structure-binary-rejected`、`structure-severity-caution-passes`、`structure-severity-blocked-rejects`、`structure-shell-snippet-caution-not-block`、`structure-clean-passes`。

#### `class AuthoringCore`
- `createDraft(input: { name, files, requestedBy: OpId }): Promise<CreateDraftResult>`
  - 流程：name 过 `SKILL_NAME` → `checkNameConflict`（human 面）→ `store.reserveName`（原子占位；同名 managed 已存在 → `name_conflict`，提示走 patch）→ `validateStructure` → revision=1 写 bundle → record CAS put（draft）→ invalidate → readback 经 `store.readRevision`（**不经 provider**，S1-2）。
- `patchDraft(input: { skillId, baseRevision, baseContentDigest, files, requestedBy }): Promise<PatchResult>`
  - 流程：record 须 `owner:'agent'` 且 `state:'draft' | 'active'`（对齐 Hermes "先更新 loaded skill"，H6）→ CAS 双校验（revision + `baseContentDigest`，失配 `stale_base_revision` 强制重载）→ 写**新** revision `n+1` → record `currentRevision=n+1, revision+1` → invalidate → readback。旧 revision 原位保留。
- `promoteDraft(skillId, expectedRevision): Promise<PromoteResult>`
  - 流程：`state:'draft'` → 再跑 `checkNameConflict`（active 位）→ 纯 record CAS `state:'active' + promotedAt` → invalidate → readback 经 provider list（此刻才可见）。零目录移动。
- `checkNameConflict(name, projectKey): Promise<NameConflict | undefined>`
  - 两条规则：(1) `<projectRoot>/.agents/skills/<name>` 或 `<name>.md` 直接存在；(2) `ctx.skills.list({cwd})` winning 同名且 provider ≠ `self-evolution-managed`（按 frontmatter name，flat/目录两形态，T27）。输出 reason → 工具层 `name_conflict_with_human_source`。
- `enforceQuotas(projectKey, pendingBytes): void`（S1-14 新增）
  - 职责：create/patch preflight——超 `maxRevisionsPerSkill` / `maxManagedBytesPerSkill` / `maxManagedBytesPerProject` / `maxOrphanBytesPerProject` 抛 `budget_exceeded` 附现库存；达限 fail-loud 停止自主 patch，不偷删历史。
- `reconcileStartup(): Promise<ReconcileReport>` — 启动记账（**只记账不清理**，S1-14）：orphan revision（无 pointer）计数保留；pointer 指缺失 bundle → `invalid_structure` 报告；NameIndex 占位无 record → 释放占位。
- 验收（核心组）：`create-draft-lands-invisible`、`create-conflict-rejects`、`create-same-managed-name-suggests-patch`、`create-threat-blocked-rejects`、`create-caution-passes-with-warning`、`patch-writes-new-revision-old-retained`、`patch-cas-mismatch-rejects`、`patch-external-edit-detected`、`patch-non-agent-owned-rejects`、`patch-active-allowed-loaded-first`、`promote-pure-sidecar-cas`（断言无文件移动）、`promote-conflict-recheck`、`promote-makes-visible-after-invalidate`、`quota-revisions-fail-loud`、`quota-bytes-fail-loud`、`reconcile-orphan-counted-not-deleted`、`reconcile-releases-orphan-reservation`、`concurrent-authors-cas-one-wins`、`transition-stale-archive-revive-single-record`、`crash-between-bundle-and-pointer-reconciles`。

#### `skill_manage` 工具（defineTool 薄壳）
- actions：`create-draft` | `patch-draft`；patch 必带 `baseContentDigest`（来自会话日志中加载/创建记录，可重建）；错误码透传（含 `name_conflict` 与 `name_conflict_with_human_source` 分列）；结果 `{ skillId, state, revision, digest }`。**无 promote**——模型工具面永不可触达上架（治理面在 P3）。
- 仅 authoring preset 组合可见（组合级测试）。
- 验收：`tool-thin-delegates`、`tool-error-codes-surface`、`tool-absent-from-default-preset`、`tool-has-no-promote-action`。

## 4. Config（schemastery）

`managedProviderRank`（默认 700，JSDoc 明示"仅同层纵深"）、`maxFiles`/`maxTotalBytes`/`maxFileBytes`、`scanAgentCreatedSkills`（默认 true，强于 Hermes 默认关）、`stagingRootName`（默认 `.dsh/self-evolution/skills`）、`writableRoot`（默认 'project-dsh'）、配额四项：`maxRevisionsPerSkill`/`maxManagedBytesPerSkill`/`maxManagedBytesPerProject`/`maxOrphanBytesPerProject`。

## 5. 验收门（Phase 出口）

- 附件测试全绿 + 100% 覆盖（AuthoringCore 状态×digest×冲突决策表；provider 可见性矩阵；配额边界值）；
- REAL boot：**挂载层枚举**（host 组合中各来源所在层逐一钉 winner，含同层 rank 与跨层遮蔽两向，T36）+ create→draft 不可见→治理 promote→目录可见→`/name` 可调→patch 出新 revision 全链；provider 挂 host、工具挂 authoring preset 的组合断言（E0-9）；
- HMR disposal（provider + 工具）；snapshot（工具结果/错误码/persona 无关面）；
- README（Model Experience：provider 引入的 catalog 语义 + rank 同层纵深声明；Known Limitations：无 delete、无物理 GC、orphan 由配额约束、user 域暂缓、窄删除 capability 推迟）+ Agent Note（领地关系：模型自治域 = managed provider；`.agents/skills` 人工域永不触碰；read-boundary 信任转换）。
