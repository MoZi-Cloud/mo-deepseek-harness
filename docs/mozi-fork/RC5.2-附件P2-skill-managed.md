# RC5.2 附件 P2 — Managed skill provider + authoring（函数级规格）

> 上位：`RC5.2-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.2-方案.md`（第四轮 S1-1/S2-1 重构）。
>
> 包：`packages/skill/tool-skill-manage`（`@deepseek-ai/dsh-tool-skill-manage`）——P2 内含 **ManagedSkillProvider + AuthoringCore + skill_manage 薄工具**三角色一体；P3 抽 provider/core 为 skill-authoring Service。
>
> 依赖：`ctx.fs`（**只 writeText**——seam 无 move/delete，`fs/src/index.ts:86-256`）、`ctx.storageDomain`、`ctx.skills`（`registerProvider` 持 `SkillProviderControl`，`skill/src/index.ts:391-400`）、`scanContent`。
>
> 日期：2026-08-29

## 1. 模块布局

```text
src/index.ts        # 插件装配：provider 注册（rank 配置）+ 工具注册
src/types.ts        # ManagedSkillRecord/SkillBundle/Finding 等
src/provider.ts     # ManagedSkillProvider（list 只出 active；get 读 currentRevision）
src/authoring.ts    # AuthoringCore（create/patch/promote/reconcile）
src/ownership.ts    # ManagedSkillOwnershipStore（storageDomain CAS；ensureInitialized）
src/structure.ts    # validateStructure / validateBundleLayout（纯；severity 扫描）
src/paths.ts        # bundle 路径（<projectRoot>/.dsh/self-evolution/skills/<skillId>/revisions/<n>/…）
tests/*.spec.ts
```

## 2. 核心不变式

- bundle 目录**只增不改**（不可变 revision）；生命周期 = `ManagedSkillRecord` 单 record CAS（`storageDomain.update`）+ `control.invalidate()`（缓存刷新，非 correctness authority）。
- provider `list()` 只返回 `state==='active'` 的 `currentRevision`；draft/stale/archived 永不出目录（结构性，非调用旗标）。
- `managedProviderRank` 默认 **700**（低于 bundled 600）；不变式：任何人工/内置/运行时来源同名恒胜 managed（`skill/src/index.ts:75` lower rank wins）。
- 崩溃语义：revision bundle 写完而 sidecar pointer 未更新 = 不可见 orphan revision，零危害；启动 reconcile 只做账（orphan 计数/清理进 P4 范围）。
- 全部文件写经 `ctx.fs.writeText`（text-only；binary/symlink 结构层拒绝）。

## 3. 函数规格

#### `class ManagedSkillProvider`
- `list(): Promise<SkillSummary[]>` — 读 ownership domain，过滤 `state==='active'`，出 name/description（frontmatter）。
- `get(name): Promise<SkillBody | undefined>` — 读 `currentRevision` 的 SKILL.md 正文（经 `ctx.fs.readText`）。
- 注册：`ctx.skills.registerProvider(control => { this.control = control; return provider })`；sidecar 变更后 `control.invalidate()`（P0 T26 钉时序）。
- 验收：`provider-list-active-only`、`provider-draft-invisible`、`provider-promote-appears-after-invalidate`、`provider-rank-loses-to-human`（rank 700 vs rank 200 同名，人工恒胜）、`provider-hmr-disposal`。

#### `buildRevisionPath(root, skillId, revision, relative): string`
- 职责：确定性路径（纯）。验收：`paths-deterministic`、`paths-reject-escape`（`..`/绝对路径/出 bundle 根 → `invalid_structure`）。

#### `class ManagedSkillOwnershipStore`
- `ensureInitialized(skillId)` / `get(skillId)` / `casPut(record, expectedRevision)` — `storageDomain.update` CAS（`stale_base_revision`）；首录走 `missing-key` 初始化协议（P0 T24）。
- 验收：`ownership-cas-conflict`、`ownership-first-record`、`ownership-crash-reread`。

#### `checkNameConflict(name, ctx, ownership): Promise<NameConflict | undefined>`
- 职责：两条规则（[核验 S2-3/S2-4]）：(1) `<projectRoot>/.agents/skills/<name>` 或 `<projectRoot>/.agents/skills/<name>.md` 直接存在；(2) `ctx.skills.list()` winning 同名（按 **frontmatter name**，flat/目录两形态）且非本 provider active 条目。输出 reason → 工具层 `name_conflict_with_human_source`。managed rank 700 下这是 fail-loud 提示而非遮蔽防线（结构性已最低优先）。
- 验收：`conflict-agents-dir`、`conflict-agents-flat-md`、`conflict-frontmatter-name-vs-filename`、`conflict-winning-not-managed`、`no-conflict-own-active-update`。

#### `validateStructure(bundle: SkillBundle, config): StructuralReport`
- 职责：纯函数，两级——结构层（blocking）：`files[].path` bundle 相对、禁 `..`/绝对、`SKILL.md` 唯一特权入口、max files/max total bytes/max single file bytes（Config）、UTF-8 text only（binary/symlink 拒）；内容层（severity）：`scanContent` → blocked 阻断（`threat_scan_blocked`）、caution 附警告放行。**无语法禁令**（`${…}`/shell 片段为惰性文本；[核验 §3-1]）。
- 验收：`structure-path-escape`、`structure-skill-md-required`、`structure-file-count-cap`、`structure-total-bytes-cap`、`structure-binary-rejected`、`structure-severity-caution-passes`、`structure-severity-blocked-rejects`、`structure-shell-snippet-caution-not-block`、`structure-clean-passes`。

#### `class AuthoringCore`
- `createDraft(input: { name, files, requestedBy: OpId }): Promise<CreateDraftResult>`
  - 流程：`checkNameConflict` → `validateStructure` → 分配 `skillId`/`revision=1` → `ctx.fs.writeText` 写 `revisions/1/` → ownership CAS put（draft）→ `invalidate` → readback（provider `get` 可读、`list()` 不可见——draft 语义）。
- `patchDraft(input: { skillId, baseRevision, baseContentDigest, files, requestedBy: OpId }): Promise<PatchResult>`
  - 流程：sidecar 须 `owner:'agent'` + `state:'draft'`；CAS 双校验（revision + `baseContentDigest`，失配 `stale_base_revision` 强制重载）→ 写 **新** revision 目录 `n+1` → sidecar `currentRevision=n+1, revision+1` → invalidate → readback。旧 revision 保留（不可变、可回溯）。
- `promoteDraft(skillId, expectedRevision): Promise<PromoteResult>`
  - 流程：`state:'draft'` → 再跑 `checkNameConflict`（active 位）→ **纯 sidecar CAS** `state:'active' + promotedAt` → invalidate → readback 断言已进目录。零目录移动。
- `reconcileStartup(): Promise<ReconcileReport>` — 扫 revision 目录 vs sidecar：orphan revision（无 pointer）计数保留不删；pointer 指向缺失 bundle → `invalid_structure` 报告。
- （P3/P4 增补，经 SkillAuthoringService 暴露）`transitionManagedSkill(skillId, from, to, expectedRevision, opId)` — 单 sidecar record CAS 状态迁移（stale/archive/revive；锚点时间戳由调用方传 `now` 写入 `stateChangedAt/staleAt/archivedAt`）+ invalidate。
- 验收（核心组）：`create-draft-lands-invisible`、`create-conflict-rejects`、`create-threat-blocked-rejects`、`create-caution-passes-with-warning`、`patch-writes-new-revision-old-retained`、`patch-cas-mismatch-rejects`、`patch-external-edit-detected`（digest 失配）、`patch-non-agent-owned-rejects`、`patch-active-rejects`、`promote-pure-sidecar-cas`（断言无文件移动：旧 revision 目录原位）、`promote-conflict-recheck`、`promote-makes-visible-after-invalidate`、`reconcile-orphan-counted-not-promoted`、`reconcile-missing-bundle-loud`、`concurrent-authors-cas-one-wins`、`transition-stale-archive-revive-single-record`、`crash-between-bundle-and-pointer-reconciles`。

#### `skill_manage` 工具（defineTool 薄壳）
- actions：`create-draft` | `patch-draft`；patch 必带 `baseContentDigest`（来自会话日志中加载/创建记录，可重建——[评审 S2-4]）；错误码透传；结果 `{ skillId, state, revision, digest }`。
- 仅 authoring preset 组合可见（组合级测试）。
- 验收：`tool-thin-delegates`、`tool-error-codes-surface`、`tool-absent-from-default-preset`。

## 4. Config（schemastery）

`managedProviderRank`（默认 700）、`maxFiles`/`maxTotalBytes`/`maxFileBytes`、`scanAgentCreatedSkills`（默认 true）、`stagingRootName`（默认 `.dsh/self-evolution/skills`）、`writableRoot`（默认 'project-dsh'）。

## 5. 验收门（Phase 出口）

- 附件测试全绿 + 100% 覆盖（AuthoringCore 状态×digest×冲突决策表；provider 可见性矩阵）；
- REAL boot：provider 注册 + create→draft 不可见→promote→目录可见→`/name` 可调→patch 出新 revision 全链（含 rank 700 恒败于人工同名的端到端断言）；
- HMR disposal（provider + 工具）；snapshot（工具结果/错误码/persona 无关面）；
- README（Model Experience：provider 引入的 catalog 语义；Known Limitations：无 delete、user 域暂缓、orphan revision 由 P4 清理）+ Agent Note（领地关系：模型自治域 = managed provider；`.agents/skills` 人工域永不触碰，human-review 提案为提权通道）。
