# RC5.1 附件 P2 — Skill authoring（函数级规格）

> 上位：`RC5.1-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.1-方案.md` §5.6。
>
> 包：`packages/skill/tool-skill-manage`（`@deepseek-ai/dsh-tool-skill-manage`，模型面工具 + 内聚 AuthoringCore）；上游包修改：`packages/skill/skill-filesystem` 新增 `ctx.skillMutationObserver` 宿主服务。
>
> 前置：P1 全绿。日期：2026-08-29

## 1. 模块布局

```text
packages/skill/skill-filesystem/（上游包，fork 修改）
  src/index.ts        # + ctx.skillMutationObserver 服务（转发 provider.observeHostMutation）
packages/skill/tool-skill-manage/
  src/index.ts        # 函数插件：name/inject/Config/apply；defineTool('skill_manage')
  src/authoring.ts    # AuthoringCore（内聚模块；P3 抽出为 skill-authoring Service）
  src/ownership.ts    # storageDomain 读写（skill-ownership domain，schemaVersion 1）
  src/structure.ts    # validateStructure 纯函数（与发现侧同规则）
  src/paths.ts        # 确定性路径构建（staging/active 根）
tests/*.spec.ts
```

## 2. 路径与所有权契约

```text
staging 根： <projectRoot>/.dsh/skills/.drafts/<name>/…   （发现只扫直接条目：不可达，:719-747）
active  根： <projectRoot>/.dsh/skills/<name>/…           （rank 100；提升后进目录）
SkillOwnershipRecord（storageDomain 权威）
  { skillId, root: 'project-dsh', owner: 'agent'|'human',
    state: 'draft'|'active'|'archived', revision,
    contentDigest, createdByReviewId?, lastAppliedOpId? }
```

`disable-model-invocation`/`user-invocable` 只在 active 技能上作调用面策略（`skill-filesystem/README.md` 语义），不承载生命周期。

## 3. skill-filesystem 修改（fork-diff）

`SkillMutationObserver`：`{ observeHostMutation(path: string): void }`——实现转发既有 `provider.observeHostMutation`（:139-142 同款失效逻辑）；经 `declare module` 合并为 `ctx.skillMutationObserver`。验收：`observer-forwards-invalidation`（调用后下一次 `ctx.skills.list()` 同步见新条目——确定性，不依赖 chokidar 0–300ms）、`observer-unknown-path-noop`。

## 4. 函数规格

#### `buildDraftPath(root: string, name: string): string` / `buildActivePath(root: string, name: string): string`
- 职责：确定性路径（纯）。验收：`paths-deterministic`、`paths-reject-name-traversal`（含 `..`/绝对路径/非法 kebab → `invalid_structure`）。

#### `checkNameConflict(name: string, root: string, ctx): Promise<NameConflict | undefined>`
- 职责：P0 安全不变式。两规则（[核验 S2-3] 收窄版）：(1) 直接存在性 `<projectRoot>/.agents/skills/<name>`；(2) `ctx.skills.list()`（:350-356 只出 winning）同名且非本 sidecar `owner:'agent'` 条目。
- 输出：`{ reason: 'human_path_exists'|'winning_not_agent_owned' }` → 工具层转 `name_conflict_with_human_source`。
- 验收：`conflict-human-path-rejects`、`conflict-winning-human-skill-rejects`、`conflict-own-draft-allows`（sidecar 内自己同名草稿是合法 patch 目标）、`conflict-no-shadow-of-curated`（构造 rank 200 同名，create 被拒，list 无遮蔽发生）。

#### `validateStructure(bundle: SkillBundle, config: SkillManageConfig): StructuralReport`
- 职责：纯函数——frontmatter 必填（name kebab `^[a-z0-9]+(?:-[a-z0-9]+)*$`、description）、与发现侧同规则（`skill-filesystem/src/index.ts:812-819`）；字节上限（Config）；**拒绝模板令牌 `${…}` 与内联 shell**（fork 负面决策）；`scanContent` 威胁扫描（Config 默认开）。
- 验收：`structure-missing-description-rejects`、`structure-bad-name-rejects`、`structure-template-token-rejects`（`${HERMES_SKILL_DIR}` 类）、`structure-inline-shell-rejects`、`structure-oversize-rejects`、`structure-threat-hit-rejects`、`structure-clean-passes`。

#### `class OwnershipStore`
- `get(skillId): Promise<OwnershipRecord | undefined>`
- `put(record, expectedRevision): Promise<void>` — `storageDomain.update` CAS；`stale_base_revision`。
- 验收：`ownership-cas-conflict`、`ownership-crash-then-reread`。

#### `class AuthoringCore`
- 职责：authoring 内聚模块（P3 抽为 Service）。全部写经 `ctx.fs`（复用其写策略/版本守卫/canonical target）；写成功即 `ctx.skillMutationObserver.observeHostMutation(path)`；随后 `readbackAssert`。
- `createDraft(input: { name, files, requestedBy: OpId }): Promise<CreateDraftResult>`
  - 流程：`checkNameConflict` → `validateStructure` → 写 staging → `OwnershipStore.put(owner:'agent', state:'draft', revision:1, contentDigest)` → observe → readback。
- `patchDraft(input: { skillId, files, baseContentDigest, baseRevision }): Promise<PatchResult>`
  - 流程：sidecar 必须存在且 `owner:'agent'`、`state:'draft'`；CAS 双校验（sidecar revision + `baseContentDigest`——digest 对不上 = 文件被外部改过 → `stale_base_revision`，强制重载）；写、bump revision、observe、readback。
- `promoteDraft(skillId, expectedRevision): Promise<PromoteResult>`
  - 流程：仅 `state:'draft'` 可提升；再跑 `checkNameConflict`（active 位置同名人工技能 = 拒绝）；staging → active 目录移动（ctx.fs）；sidecar `state:'active'`；observe 两侧路径；readback 断言 active 条目已入目录且 model-invocable 按文件策略。
- `readbackAssert(name, expectState): Promise<void>` — `ctx.skills.list()` 断言；失败 `invalid_structure`（"写成功≠进目录"的 fail-loud，[核验 S2-5 类比]）。
- 验收（AuthoringCore 全部）：`create-happy-path-lands-in-staging`、`create-conflict-rejects-with-code`、`create-threat-rejects`、`patch-cas-digest-mismatch-rejects`、`patch-after-external-edit-rejects`（外部改动后旧 digest 拒绝——读后才写的新鲜级语义）、`patch-non-agent-owned-rejects`、`patch-active-rejects`（active 只能经 promote 流转）、`promote-moves-to-active-and-discovered`、`promote-conflict-rechecks`、`promote-non-draft-rejects`、`readback-failure-fails-loud`、`concurrent-two-authors-one-wins`（双 saga 同 skillId，revision CAS 保证一胜一 `stale_base_revision`）、`crash-after-write-before-sidecar-reconciles`（重试：目标存在且 digest 相同 → 补 sidecar；不同 → conflict——filesystem reconciliation，[核验 S1-2]）。

#### `skill_manage` 工具（defineTool，模型面薄壳）
- actions：`create-draft` | `patch-draft`（首版；无 delete、无 promote——提升是用户/host 动作）。
- 描述从模型视角写；错误码透传上表；结果含 `{ skillId, state:'draft', digest }`（不含 host 内部绝对路径细节）。
- 版本守卫：patch 必带 `baseContentDigest`（= 会话日志中加载/创建记录里的 digest；日志可重建，[评审 S2-4]）。
- 验收：`tool-thin-delegates-core`（除参数整形外零逻辑）、`tool-error-codes-surface`、`tool-not-in-default-preset`（仅 authoring preset 组合可见——组合级决策测试）。

## 5. 验收门（Phase 出口）

- 附件全部验收绿 + 100% 覆盖（AuthoringCore 决策表全覆盖：状态 × digest × conflict 矩阵）；
- REAL boot：skill-filesystem（含 fork 修改）+ tool-skill-manage 经 Loader；create→draft 不可见→promote→目录可见→`/name` 可调全链；
- HMR disposal：observer 服务与工具注销干净；
- snapshot：工具结果/错误码文案钉死；README（含 Known Limitations：初版无 delete、user 域暂缓、staging 根为 fork 约定）+ Agent Note（含与 human-review-skill-maintenance 提案的领地关系，[评审 S1-6]）。
