# RC5.2 附件 P4 — Skill curator（函数级规格）

> 上位：`RC5.2-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.2-方案.md`。
>
> 包：`packages/skill/skill-curator`（`@deepseek-ai/dsh-skill-curator`）；写通道唯一 = `SkillAuthoringService.transitionManagedSkill`（单 record CAS + invalidate，[核验 S1-14]——无文件移动、无半迁移状态）。
>
> 前置：P3 全绿。日期：2026-08-29

## 1. 模块布局

```text
src/index.ts         # 装配：自有触发器（上次运行时间 + Config 间隔）→ runMaintenance 取 idle ownership
src/state-machine.ts # transition() 纯函数（唯一家）
src/curator.ts       # SkillCurator
src/usage.ts         # SkillUsageObserver（best-effort 串行队列）+ usage domain
src/metrics.ts       # aggregateOutcomes()（P5，纯）
tests/*.spec.ts
```

## 2. 类型契约

```text
CuratorConfig = { staleAfterDays, archiveAfterDays, zeroUseGraceDays,
                  intervalHours, minIdleHours }        // 全部 required
SkillUsageRecord = { skillId, modelLoads, userLoads,
                     lastModelLoadAt?, lastUserLoadAt? }
// ManagedSkillRecord 时间锚点（P2 定义，此处消费）：
// createdAt, promotedAt?, stateChangedAt, staleAt?, archivedAt?
Transition = { to: 'active'|'stale'|'archived',
               reason: 'went-stale'|'meaningful-use'|'went-archived'|'revived',
               now, staleAt? }
```

## 3. 函数规格

#### `transition(record: ManagedSkillRecord, usage: SkillUsageRecord | undefined, now, config): Transition | undefined`
- 职责：纯状态机，锚点写死（[核验 S1-13]）：
- active never-used：锚 = `max(promotedAt ?? createdAt, createdAt)`，超 `staleAfterDays` → stale（never-used 的宽限 = 锚本身从提升起算）；
- active used：锚 = `lastMeaningfulUseAt`，超 `staleAfterDays` → stale；`zeroUseGraceDays` 内的零使用不转；
- stale → active：`lastMeaningfulUseAt > stateChangedAt`（meaningful use）；
- stale → archived：**自 `staleAt` 起** ≥ `archiveAfterDays`（二次窗口独立计时，避免 30/90 语义混淆）；
- archived → active：仅显式 revive（不在本函数）；`pinned: true` 一律不迁移。
- 验收：`active-stale-after-days`、`never-used-anchored-at-promotion`、`stale-archived-from-staleAt`、`meaningful-use-revives`、`zero-use-grace-window`、`pinned-never-transitions`、`boundary-exact`、`no-op-returns-undefined`。

#### `class SkillUsageObserver`（best-effort，[核验 S2-9]）
- `onSessionEvent(event): void` — 同步入队即返回（不抛、不 await）；内部单工作串行队列 drain 到 usage domain `update`；HMR dispose 时 drain 或有意丢弃并记日志。精确计数：`tool/result` 且 `exec.name==='skill'` 且 `isError===false` 且参数解析出技能名 → `modelLoads`；`source.kind==='skill-invocation'` → `userLoads`；失败/目录出现不计。
- 语义：usage 丢失只影响 curator 质量，绝不影响 skill 正确性。
- 验收：`count-successful-model-load-only`、`failed-load-not-counted`、`slash-invocation-counted`、`catalog-presence-not-counted`、`listener-never-throws`（存储故障注入下 session 路径不受影响）、`dispose-drains-or-drops-with-log`。

#### `class SkillCurator`
- `async runPass(signal: AbortSignal): Promise<CuratorReport>` — runMaintenance 槽任务体：`listManaged()`（sidecar `owner==='agent'` 全量，**领地 = 模型自治域**）→ 逐条 `transition`（含 usage/锚点）→ 迁移经 `SkillAuthoringService.transitionManagedSkill`（archive = 状态 CAS + invalidate，bundle 不可变目录原位保留——只归档永不删除）→ 报告落 ledger。
- 触发器（措辞按 [核验 S2-9] 修正）：插件自带 session/event + 时间检查（距上次 ≥ `intervalHours`）→ 调用 `agent.runMaintenance(pass)` 取 idle ownership；busy 保留 due。
- 验收：`pass-archives-not-deletes`（bundle 原位 + state=archived + 不出目录）、`pass-territory-zero-contact`（`.agents` 与 human-owned sidecar 零修改——P0 级持久回归）、`pass-managed-only`、`pass-idempotent-rerun`、`pass-respects-signal-no-half-state`（CAS 保证：未完成的 transition 不产生状态变化）、`pass-busy-retried`、`pinned-user-gate-unbypassable`。

#### `aggregateOutcomes(range): EffectivenessReport`
- 职责：纯函数——review-ledger + usage 聚合：proposals 按 kind/action、committed/duplicate/rejected（按错误码）、`review_cancelled_for_foreground`、retry/terminal 计数、memory blocked-on-publish、orphan revisions、provider conflict 率、range lag（`desiredThrough - reviewedThrough`）、tokens。
- 验收：`aggregate-matches-ledger`、`aggregate-empty-zeros`、`aggregate-deterministic`。

## 4. Config（schemastery，required）

`staleAfterDays`、`archiveAfterDays`、`zeroUseGraceDays`、`intervalHours`、`minIdleHours`。

## 5. 验收门（Phase 出口）

附件测试全绿 + 100% 覆盖（状态机全迁移路径 + 观察者故障注入）；REAL boot：curator + skill-authoring + managed provider 全组合（归档→复活→active 全链 + 领地零接触持久回归）；README（Known Limitations：LLM consolidation 未实现且默认关、仅 project 自治域、usage 为 best-effort）+ Agent Note；doc-sync。
