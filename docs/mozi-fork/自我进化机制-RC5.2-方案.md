# 自我进化机制方案 RC5.2（协议闭环 + Managed Skill Provider）

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 版本脉络：RC1（`DSH借鉴hermes-开发记忆提炼-自我进化机制.md`）→ 评审（`评审报告.md`）→ RC4 → 外部第二轮评审 + 核验（`RC5-外部建议核验与处置.md`）→ RC5.1（函数级规格五附件）→ 第四轮复核 + 处置（`RC5.1-评审报告.md` + `RC5.2-第四轮评审核验与处置.md`，14 S1 全部证实）→ 本 RC5.2
>
> 函数级规格：`RC5.2-函数级规格总纲.md` + 附件 P0–P4（类名/签名/调用关系/验收标准，TDD）
>
> 证据基线：upstream master = `cd5ef81`（三次 `git ls-remote` 确认零新提交；本 fork 已含全部上游历史）；每个 API 触点引用已核实 path:line，证据账本 = `评审报告.md` + `RC5-外部建议核验与处置.md` + `RC5.2-第四轮评审核验与处置.md`
>
> 日期：2026-08-29

## 0. 相对 RC5.1 的两处实质变化

1. **Skill 生命周期落点重做（第四轮 S1-1 + S2-1）**：`ctx.fs` 公开原语仅 12 个、无 rename/move/delete（`fs/src/index.ts:86-256`）——RC5.1 的 staging 目录移动不可实现。改为 **AgentManagedSkillProvider**：bundle 为不可变 revision 目录（`<projectRoot>/.dsh/self-evolution/skills/<skillId>/revisions/<n>/`），生命周期全部是 sidecar（storageDomain `ManagedSkillRecord`）单 record CAS；provider `list()` 只返回 active；自持 `SkillProviderControl.invalidate()`。删除 `ctx.skillMutationObserver` fork-diff——对上游包的修改只剩 tool-session-query 默认过滤。
2. **协议闭环补齐（第四轮 S1-2..S1-14）**：storage 首录 `missing-key` 初始化协议；幂等检查先于 base-revision 且下沉到资源自身（`appliedOps` 有界窗口 + reconciliation）；per-session ReviewCursor（acquired/busy、连续切片、high-water 只推进实审区间）；`planned` 持久化边界（validated plan 不可变，recover 禁止重问模型）；两阶段 patch planner；whole-plan preflight；LearningView 定义在 raw log + turn fold 推导 final；时间锚点补齐；Memory 扫描双闸 + fail-open + 硬预算。

锁定项（不再讨论）：自进化业务不进 `agent-loop`；LLM 只 proposes；host 拥有全部权威字段；spawn 复盘；子会话持久化保留 + 检索面隔离；project 自治域先行；L0→L2 rollout；首版无 `review/*` 事件（词表 fail-closed 无 ignorable 通道）；LLM curator consolidation 默认关。

## 0.1 七条第一原则（终稿）

1. **Everything is a plugin, but not every role is a package.**
2. **LLM proposes; Host commits.**
3. **Dynamic model-visible state is replay-authoritative**（动态内容来自 durable Session source；静态面由 composition revision + validated Config 重建）。
4. **Model text never owns authority metadata.**
5. **At-least-once trigger; resource-level idempotent commit.** Ledger 负责编排；去重在资源自身 commit/reconciliation 边界成立。
6. **Project autonomous domain first.**
7. **Learning requires admissible evidence.** 证据引用是必要条件非充分条件；自动持久化必须验证证据内容支持 proposal；模型自报 confidence 不构成授权。

## 1. P0 — Evidence Lock

33 项行为钉死测试（RC5.1 的 23 项 + 新增 10 项：first-record `missing-key`、`ctx.fs` no-move 契约、Provider `control.invalidate()`、flat `.md`/frontmatter 同名冲突、截窗连续高水位、cursor acquired/busy、blocking 顺序（commit → publisher 见新 state → 首请求含新 snapshot）、后台取消可恢复、assistant final 推导、managed provider 目录可见性）。全清单见附件 P0；全绿前不进 P1。

## 2. 包规划

| 包 | 内容 | Phase |
|---|---|---|
| `packages/util/content-scan` | `scanContent()` 纯函数（中英锚点/不可见字符/NFKC/severity 三档） | P1 |
| `packages/memory/memory` | `MemoryService extends Service`（storageDomain 状态 + `appliedOps` 有界幂等）+ `MemoryPublisher`（pre-step 快照发布，fail-open） | P1 |
| `packages/skill/tool-skill-manage` | **AgentManagedSkillProvider**（list 只出 active；自持 invalidate）+ `AuthoringCore` + `skill_manage` 薄工具；P3 时 provider/core 抽出为 skill-authoring | P2（P3 拆分） |
| `packages/skill/skill-authoring` | `SkillAuthoringService extends Service`（两个真实消费者到位后抽出） | P3 |
| `packages/review/session-review` | `ReviewRuntime` + LearningView + ReviewCursor/Ledger + 两阶段 planner + commit saga | P3 |
| `packages/skill/skill-curator` | 生命周期状态机（时间锚点）+ usage 观察者（best-effort） | P4 |

**fork-diff 台账**（对上游包的修改，全部在 PR 中逐行说明）：仅 `packages/session-query/tool-session-query`——模型面默认附加 `{kind:'parent', values:[null]}`（服务层既有 filter 类型，`session-query/src/types.ts:198`），`includeChildSessions` 显式逃生参数；`ctx.sessionQuery` 服务能力不改。

## 3. 数据模型（六概念分离）

```text
ReviewCursor（storageDomain，per-session）
  { sessionId, reviewedThroughSeq, desiredThroughSeq, policyVersion,
    learningViewVersion, inFlight? { reviewId, fromExclusive,
    throughInclusive, status } }
ReviewInput（host 只读）
  { evidence: LearningView,
    currentMemory { revision, entries[{id,kind,content}] },
    patchCandidates[{ skillId, name, state, revision, digest, summary }] }
ReviewPlan（模型数据；无权威字段）
  { memory[{ action, targetHint?, content?, kind,
             evidence[{seq, span?, fieldPath?}], reason, confidence }],
    skills[{ action: 'create-draft'|'patch-draft', skillName,
             patchTarget?: skillId, evidence[], files[] }],
    noChangeReason? }
ReviewCheckpoint（host 权威；planned 边界持久化不可变 plan）
  { reviewId = hash(sessionId, fromExclusive, throughInclusive,
      policyVersion, learningViewVersion),
    status: planning|planned|committing|committed|failed,
    plan?, planDigest?, baseRevisions?, opStates[], attemptCount,
    lastFailureCode?, nextRetryAt? }
MemoryState（storageDomain；mutation 与回执同 commit point）
  { schemaVersion, revision, entries[], appliedOps }   // appliedOps 有界窗口
ManagedSkillRecord（storageDomain 权威；bundle 不可变）
  { skillId, name, owner, state: draft|active|stale|archived,
    currentRevision, contentDigest, revision,
    createdAt, promotedAt?, stateChangedAt, staleAt?, archivedAt?,
    createdByReviewId?, lastAppliedOpId?, pinned }
```

## 4. 机制要点（细节见附件）

- **触发**（P3）：`resume-async`（默认，学习下一回合生效）/ `resume-blocking`（`agent/pre-step` awaited 闸）/ `maintenance`（turn/end 标 due → 去抖 → `runMaintenance` claim-或-throws）；foreground turn 到来时取消在飞后台 review（cancel ≠ 失败，不推进 high-water，cursor 保留恢复）。
- **planner**（P3）：`ctx.subagents.start(config.reviewProvider ?? 'spawn', { label:'self-review', toolFilter:{allow:[]}, outputSchema, agentOptions:{ model, maxTokens } })`；patch 走两阶段（planner-1 选 `patchTarget` → host 加载精确 revision → planner-2 出 replacement）；终态闸门 `stopReason==='completed' && structured` + host 边界再 parse。
- **commit**（P3）：whole-plan preflight 全有或全无（拒绝原因落 ledger 供 replan；`operationGroups[]` 留待将来）；memory 资源级幂等（`appliedOps` 窗口命中先于 base-revision 检查）；skill 走 ManagedSkillRecord CAS + digest reconciliation。
- **memory 发布**（P1）：后台只写权威 MemoryState；下一 `agent/pre-step` 由 MemoryPublisher digest 比对后发布 `form:'snapshot'` + `sections` 的完整 replacement（`llm/src/message.ts:54-70` 语义）；扫描双闸（写入拒 + 发布 `[BLOCKED]` 占位留审计）；publisher fail-open；硬预算在 mutation 边界强制。
- **skill authoring**（P2）：create-draft/patch-draft = 写新不可变 revision + ManagedSkillRecord CAS + `control.invalidate()`；promote = 状态 CAS；`name_conflict_with_human_source` 检查（直接 `.agents` 路径 + frontmatter-name winning 候选，flat/目录两形态都测）；结构验证（路径相对/禁 `..`/SKILL.md 唯一特权入口/数量字节上限/UTF-8 text）+ severity 扫描（blocked 阻断、caution 放行——DSH 无模板展开/执行引擎，语法禁令废除）。
- **curator**（P4）：`transition()` 纯状态机（锚点：active never-used 从 `max(promotedAt, createdAt)`、used 从 `lastMeaningfulUseAt`；stale→archive 从 `staleAt`）；一切写经 `SkillAuthoringService.transitionManagedSkill`（单 record CAS）；usage 观察者 best-effort（`exec.name==='skill'` 且成功且解析出名字 → modelLoads；`skill-invocation` → userLoads）；pinned 由用户设置、后台不可绕过。
- **UI**（P3/P4）：`session-projection` 状态投影（"Current Self-Evolution Status"），不伪装 durable timeline；locale 字典；`verify-client-ui-i18n`。
- **rollout**（P5）：L0 Shadow（proposal 落 ledger，零 mutation）→ L1 Conservative（explicit-user/observed-project 自动 commit；skill 只 draft）→ L2 Autonomous（inference 过质量门 + confidence calibration 完成）；升级不自动 backfill，重学仅显式 re-review/migrate；可选 approvalMode（`auto|stage-background|stage-all`，PendingChange 落 storageDomain，实现排 L2 前）。

## 5. Phase 门槛（P0–P5）

P0 = 33 项 Evidence Lock 全绿（附件 P0）。P1 = memory（含 first-record 初始化、bounded receipts、双闸扫描、fail-open publisher、`form:'snapshot'`、schemaVersion + 显式 reset/migrate）。P2 = managed provider + AuthoringCore + skill_manage（冲突不变式、CAS、severity 扫描、readback 自检；无 delete、无 user 域）。P3 = review 全链（cursor/两阶段/整计划 preflight/planned 边界/前台抢占/终态闸门）+ session-query 默认过滤先行 + skill-authoring 抽出。P4 = curator（时间锚点状态机 + best-effort usage）。P5 = L0→L2 + effectiveness 指标（含 `review_cancelled_for_foreground`、retry/terminal 计数、approval accept/reject 率、memory blocked-on-publish、orphan revisions、provider conflict 率、review range lag）。

每 Phase 固定门槛：per-file 100% 覆盖、REAL-composition boot、HMR disposal、snapshot（模型可见文本）、双 SDK（类型面变更时）、doc-sync、Agent Note。

## 6. 非目标

不改 `agent-loop`；不新增模型工具面以外的动态模型可见通道；不做语义/向量检索；不做跨设备同步；不扩 `writableRoots`；不做 user-dsh 自主写；不做多 Host 共享 storage root；不做热缓存 fork 复盘；不翻转 shipped 检索默认；首版不加 `review/*` 会话事件；不给 `ctx.fs` 加通用 move/delete。
