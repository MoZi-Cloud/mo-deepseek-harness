# RC5.3 附件 P4 — Skill curator（函数级规格）

> 上位：`RC5.3-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.3-方案.md`（第五轮 S1-11、S1-14、S2-9）。
>
> 包：`packages/skill/skill-curator`；写通道唯一 = `SkillAuthoringService.transitionManagedSkill`（单 record CAS + invalidate，无文件移动、无半迁移状态）。
>
> 前置：P3 全绿。日期：2026-08-29

## 1. 模块布局

```text
src/index.ts         # 装配：自有触发器（上次运行时间 + Config 间隔）→ runMaintenance 取 idle ownership
src/state-machine.ts # transition() 纯函数（唯一家）
src/curator.ts       # SkillCurator
src/usage.ts         # SkillUsageObserver（best-effort 串行队列；provider 精确归属）+ usage domain
src/metrics.ts       # aggregateOutcomes()（operational 指标，纯）
tests/*.spec.ts
```

## 2. 类型契约

```text
CuratorConfig = { staleAfterDays, archiveAfterDays, zeroUseGraceDays,
                  intervalHours, minIdleHours }        // 全部 required
SkillUsageRecord = { projectKey, skillId, modelLoads, userLoads,
                     lastMeaningfulUseAt? }            // 键含 projectKey（S1-3 同源隔离）
// ManagedSkillRecord 时间锚点（P2 定义，此处消费）：
// createdAt, promotedAt?, stateChangedAt, staleAt?, archivedAt?
Transition = { to: 'active'|'stale'|'archived',
               reason: 'went-stale'|'meaningful-use'|'went-archived'|'revived',
               now, staleAt? }
```

## 3. 函数规格

#### `transition(record, usage, now, config): Transition | undefined`
- 职责：纯状态机，锚点写死：
- active never-used：锚 = `max(promotedAt ?? createdAt, createdAt)`，超 `staleAfterDays` → stale；
- active used：锚 = `lastMeaningfulUseAt`，超 `staleAfterDays` → stale；`zeroUseGraceDays` 内的零使用不转（宽限公式：`now - anchor < zeroUseGraceDays` 时 used-but-zero-record 不转 stale）；
- stale → active：`lastMeaningfulUseAt > stateChangedAt`（meaningful use）；
- stale → archived：自 `staleAt` 起 ≥ `archiveAfterDays`（二次窗口独立计时）；
- archived → active：仅显式 revive（不在本函数）；`pinned: true` 一律不迁移（pin 只由用户治理写，curator 只读）。
- 验收：`active-stale-after-days`、`never-used-anchored-at-promotion`、`stale-archived-from-staleAt`、`meaningful-use-revives`、`zero-use-grace-window`、`pinned-never-transitions`、`boundary-exact`、`no-op-returns-undefined`。

#### `class SkillUsageObserver`（best-effort；S1-11 精确归属）
- `onSessionEvent(event): void` — 同步入队即返回（不抛、不 await）；内部单工作串行队列 drain 到 usage domain `update`；HMR dispose 时 drain 或有意丢弃并记日志。
- **modelLoads 判据**：`tool/result` 成功（`isError===false`）且 `exec.name==='skill'` 且 `result.provider === MANAGED_SKILL_PROVIDER_NAME`（常量自 skill-authoring 导入）→ 按 candidate locator 的 `skillId`（可从结果 digest/名 + projectKey 重建）计 managed；**同名 human 胜出时不误计**（T41）。
- **userLoads**：`source.kind==='skill-invocation'` → 计 `userLoads`（source 无 provider 字段，`tool-skill/src/index.ts:196`——managed 归属不可判，首版只作聚合遥测不进 curator 锚点，漏计优于误计）。
- 失败 load / catalog 出现不计；usage 丢失只影响 curator 质量，绝不影响 skill 正确性。
- 验收：`count-successful-managed-provider-load-only`（T41）、`human-winner-load-not-misattributed`（T41）、`failed-load-not-counted`、`slash-invocation-aggregate-only`、`catalog-presence-not-counted`、`listener-never-throws`、`dispose-drains-or-drops-with-log`。

#### `class SkillCurator`
- `async runPass(signal): Promise<CuratorReport>` — runMaintenance 槽任务体：`listManaged(projectKey)`（sidecar `owner==='agent'` 全量，**领地 = 模型自治域**）→ 逐条 `transition`（含 usage/锚点）→ 迁移经 `transitionManagedSkill`（archive = 状态 CAS + invalidate，bundle 原位保留——只归档永不删除）→ **配额遥测**（S1-14：orphan revision 数、orphan bytes、各配额水位——P2 已 fail-loud 拦新增，此处只报数）→ 报告落 ledger。
- 触发器：插件自带 session/event + 时间检查（距上次 ≥ `intervalHours`）→ `agent.runMaintenance(pass)` 取 idle ownership；busy 保留 due。
- 验收：`pass-archives-not-deletes`、`pass-territory-zero-contact`（`.agents` 与 human-owned 记录零修改——P0 级持久回归）、`pass-managed-only`、`pass-idempotent-rerun`、`pass-respects-signal-no-half-state`、`pass-busy-retried`、`pass-quota-telemetry-reported`（S1-14）、`pinned-user-gate-unbypassable`。

#### `aggregateOutcomes(range): EffectivenessReport`
- 职责：纯函数——**operational 指标**（S2-9：ledger/usage 可得）：proposals 按 kind/action、committed/duplicate/rejected（按错误码）、`review_cancelled_for_foreground`、retry/terminal 计数、stale replan 率、memory blocked-on-publish、orphan revisions/bytes、provider conflict 率、range lag、tokens、noChange 率、draft approval/reject 率。**quality 指标（precision/false memory/repeated-task success 等）不在本函数**——需 eval harness（P5，总纲 §8）。
- 验收：`aggregate-matches-ledger`、`aggregate-empty-zeros`、`aggregate-deterministic`、`aggregate-no-quality-claims`。

## 4. Config（schemastery，required）

`staleAfterDays`、`archiveAfterDays`、`zeroUseGraceDays`、`intervalHours`、`minIdleHours`。

## 5. 验收门（Phase 出口）

附件测试全绿 + 100% 覆盖（状态机全迁移路径 + 观察者故障注入 + 归属决策表）；REAL boot：curator + skill-authoring + managed provider 全组合（归档→复活→active 全链 + 领地零接触持久回归 + human 同名胜出不误计端到端）；README（Known Limitations：LLM consolidation 未实现且默认关、仅 project 自治域、usage 为 best-effort 且 `/name` 不计入 stale 锚点、orphan 无物理清理）+ Agent Note；doc-sync。
