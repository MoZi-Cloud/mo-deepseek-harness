# RC5.5 附件 P4 — Skill curator（函数级规格）

> 上位：`RC5.5-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.5-方案.md`（第六轮 S1-6、S2-5；第七轮 S1-3）。
>
> 包：`packages/skill/skill-curator`；写通道唯一 = `ManagedSkillService.transitionManagedSkill`；usage 改 live `tools/result`（S1-6）；状态机只迁移 active 谱系（S2-5）。
>
> 相对 RC5.4-P4（第七轮 S1-3）：provider 可见谱系 = `active | stale`（P2）——stale 保持可发现、可载入，meaningful-use 复活通路闭合；`/name` 人工手势走 pre-step 注入（`tool-skill/src/index.ts:177-199`），不产生 `tools/result` 事件，天然不入 modelLoads 锚点。
>
> 前置：P3 全绿。日期：2026-08-29

## 1. 模块布局

```text
src/index.ts         # 装配：触发器 + live usage 监听注册
src/state-machine.ts # transition() 纯函数（唯一家）
src/curator.ts       # SkillCurator
src/usage.ts         # SkillUsageObserver（live tools/result；best-effort）+ usage domain
src/metrics.ts       # aggregateOutcomes()（operational，纯）
tests/*.spec.ts
```

## 2. 类型契约

```text
CuratorConfig = { staleAfterDays, archiveAfterDays, zeroUseGraceDays,
                  intervalHours, minIdleHours }        // 全部 required
SkillUsageRecord = { projectKey, skillId, modelLoads, userLoads,
                     lastMeaningfulUseAt? }            // 键含 projectKey
// 状态机只迁移 active 谱系：active | stale | archived
// draft / rejected 永不自动迁移（S2-5）；archived 专属曾 active（S1-8）
Transition = { to: 'active'|'stale'|'archived',
               reason: 'went-stale'|'meaningful-use'|'went-archived'|'revived',
               now, staleAt? }
```

## 3. 函数规格

#### `transition(record, usage, now, config): Transition | undefined`
- 职责：纯状态机（record.state 非 active 谱系 → `undefined`，S2-5）。锚点：never-used = `max(promotedAt ?? createdAt, createdAt)`；used = `lastMeaningfulUseAt`；`zeroUseGraceDays`：`now - anchor < zeroUseGraceDays` 的零使用不转；stale → active 需 `lastMeaningfulUseAt > stateChangedAt`；stale → archived 自 `staleAt` ≥ `archiveAfterDays`；`pinned` 不迁移。
- 验收：`active-stale-after-days`、`never-used-anchored-at-promotion`、`stale-archived-from-staleAt`、`meaningful-use-revives`、`zero-use-grace-window`、`pinned-never-transitions`、`draft-and-rejected-never-transition`（S2-5）、`boundary-exact`、`no-op-returns-undefined`。

#### `class SkillUsageObserver`（live 事件，S1-6）
- 注册：`ctx.on('tools/result', (exec, result) => { enqueue(...) })`（emit、host 层收全量、listener 故障被容器化；`core/tools/src/index.ts:193-198,1662-1665`）。
- **modelLoads 判据**：`exec.name==='skill'` 且 `!result.isError` 且 `result.value?.provider === MANAGED_SKILL_PROVIDER_NAME`（E0-11 钉字段路径）→ 按 `skillId = hash(resolveProjectKey(exec.agent.session.header.cwd), result.value.name)` 确定性归属（无需查表）；human 胜出不误计（T41）。
- **userLoads**：session `skill-invocation` source 聚合遥测（无 provider 字段，不进 stale 锚点）。
- 语义：进程内存活期观测——插件未挂载/HMR dispose 后的载入不计（best-effort，README Known Limitations 声明）；usage 丢失只影响 curator 质量。stale 技能仍在 provider 可见谱系（S1-3），其模型载入照常计入 modelLoads 并驱动复活（T54）。
- 验收：`count-successful-managed-provider-load-only`（T41）、`human-winner-load-not-misattributed`（T41）、`stale-load-feeds-revival-anchor`（T54）、`listener-never-throws`、`dispose-stops-observation-with-log`、`durable-event-not-used`（对照 T15：durable 面无 provider，S1-6 before/after 断言）。

#### `class SkillCurator`
- `async runPass(signal): Promise<CuratorReport>` — runMaintenance 槽：`listManaged(projectKey)`（`owner==='agent'` 全量）→ 逐条 `transition` → 迁移经 `transitionManagedSkill`（CAS + invalidate；bundle 原位）→ 遥测（orphan revision/bytes、配额水位、pending 积压数）→ 报告落 ledger。
- 触发器：session/event + 时间检查（≥ `intervalHours`）→ `runMaintenance` claim；busy 保留 due。
- 验收：`pass-archives-not-deletes`、`pass-territory-zero-contact`、`pass-managed-only`、`pass-idempotent-rerun`、`pass-respects-signal-no-half-state`、`pass-busy-retried`、`pass-quota-and-pending-telemetry`、`pinned-user-gate-unbypassable`。

#### `aggregateOutcomes(range): EffectivenessReport`
- 职责：纯函数——operational 指标（proposals 分布、committed/duplicate/rejected 按错误码、cancellation、retry/terminal、stale replan 率、blocked-on-publish、orphan/bytes、provider conflict 率、range lag、tokens、noChange 率、approve/reject/reopen/pending-activation 率、`target_scope_disabled` 命中数）。quality 指标不在本函数（P5 harness）。
- 验收：`aggregate-matches-ledger`、`aggregate-empty-zeros`、`aggregate-deterministic`、`aggregate-no-quality-claims`。

## 4. Config（schemastery，required）

`staleAfterDays`、`archiveAfterDays`、`zeroUseGraceDays`、`intervalHours`、`minIdleHours`。

## 5. 验收门（Phase 出口）

附件测试全绿 + 100% 覆盖（状态机全迁移 + live 归属决策表 + 故障注入）；REAL boot：curator + skill-managed 全组合（归档→复活→active + 领地零接触持久回归 + human 同名胜出不误计 + draft/rejected 不被自动迁移端到端）；README（Known Limitations：consolidation 默认关、仅 project 自治域、usage 为存活期 best-effort 且 `/name` 不入锚点、无物理清理）+ Agent Note；doc-sync。
