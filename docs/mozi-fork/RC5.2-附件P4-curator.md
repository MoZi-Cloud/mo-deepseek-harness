# RC5.1 附件 P4 — Skill curator（函数级规格）

> 上位：`RC5.1-函数级规格总纲.md`；架构依据 `自我进化机制-RC5.1-方案.md` §5.8。
>
> 包：`packages/skill/skill-curator`（`@deepseek-ai/dsh-skill-curator`）；写通道唯一 = `SkillAuthoringService`（P3），不另开任何文件系统写入。
>
> 前置：P3 全绿。日期：2026-08-29

## 1. 模块布局

```text
src/index.ts        # 函数插件装配：Config + runMaintenance pass 注册 + SkillUsageObserver 挂 session/event
src/state-machine.ts# transition() 纯函数（状态机唯一家）
src/curator.ts      # SkillCurator（编排：list → transition → 经 SkillAuthoringService apply）
src/usage.ts        # SkillUsageObserver + usage 账本（storageDomain）
src/metrics.ts      # aggregateOutcomes() 纯函数（P5 指标聚合，零新存储）
tests/*.spec.ts
```

## 2. 类型契约

```text
CuratorConfig = { staleAfterDays, archiveAfterDays, zeroUseGraceDays,
                  intervalHours, minIdleHours }            // 全部 required，无静默默认
SkillUsageRecord = { skillId, modelLoads, userLoads,
                     lastModelLoadAt?, lastUserLoadAt? }
lastMeaningfulUseAt(record) = max(lastModelLoadAt, lastUserLoadAt)
Transition = { to: 'active'|'stale'|'archived', reason:
               'promoted'|'went-stale'|'meaningful-use'|'went-archived'|'revived' }
```

## 3. 函数规格

#### `transition(record: OwnershipRecord, usage: SkillUsageRecord | undefined, now: number, config: CuratorConfig): Transition | undefined`
- 职责：纯状态机——`draft` 只经显式提升（不在本函数）；`active → stale`（距 `lastMeaningfulUseAt` ≥ staleAfterDays；`use==0` 走 zeroUseGraceDays 宽限——"use=0 是证据缺失不是陈旧证据"）；`stale → active`（meaningful use）；`stale → archived`（≥ archiveAfterDays）；`archived → active` 仅显式复活。数字全部来自 Config。
- 调用：被 SkillCurator.runPass 调用；不触碰 I/O。
- 验收：`active-goes-stale-after-days`、`stale-archived-after-days`、`meaningful-use-revives-stale`、`zero-use-grace-delays-stale`、`boundary-day-exact`（天数边界值）、`no-transition-returns-undefined`、`draft-never-auto-transitions`。

#### `class SkillUsageObserver`
- `onSessionEvent(event: SessionEvent): void` — **精确计数**（[核验 S2-4]）：`tool/result` 且 `exec.name === 'skill'` 且 `isError === false` 且参数解析出技能名 → `modelLoads+1, lastModelLoadAt=event.time`；失败调用不计数；`user/message` 且 `source.kind === 'skill-invocation'` → `userLoads+1`。写经 `usage` domain `update`（单进程原子）。
- 验收：`count-successful-model-load-only`、`failed-load-does-not-count`、`count-slash-invocation`、`catalog-presence-does-not-count`（出现在 prompt 不算 use）、`concurrent-observer-updates-serialize`。

#### `class SkillCurator`
- `async runPass(signal: AbortSignal): Promise<CuratorReport>` — `runMaintenance` 槽任务体（claim-或-throws，`runtime-types.ts:102-110`；busy 由装配层保留 due 稍后重试）。流程：`listManagedSkills()`（**只**列 sidecar `owner:'agent'` 条目——领地 = 模型自治域）→ 逐条 `transition` → 有迁移则经 `SkillAuthoringService` 执行（staging/不可达根移动 + sidecar 状态，**只归档永不删除**）→ 产出 `CuratorReport { transitions[], examinedAt }` 落 ledger。
- `listManagedSkills(): Promise<OwnershipRecord[]>` — 读 skill-ownership domain，按 `root==='project-dsh' && owner==='agent'` 过滤。
- 验收：`pass-archives-not-deletes`（归档后文件仍在不可达根，可显式复活）、`pass-territory-zero-contact`（构造 `.agents/skills/<n>` 与 human-owned sidecar 记录，跑 pass 断言零修改——**P0 级领地测试**）、`pass-owned-only`（human-owned 条目即使最旧也不迁移）、`pass-idempotent-rerun`（连续两跑第二次零迁移）、`pass-respects-signal`（abort 中止且无半迁移状态——单迁移原子性由 SkillAuthoringService CAS 保证）、`pass-busy-throws-retried-later`。

#### `aggregateOutcomes(range: {from,to}): EffectivenessReport`
- 职责：纯函数（P5）——从 review-ledger 与 usage 账本聚合：proposals（按 kind/action）、committed、duplicate、rejected（按错误码）、precision 抽样输入清单、tokens。无新事件、无新存储。
- 验收：`aggregate-tallies-match-ledger`、`aggregate-empty-range-zeros`、`aggregate-deterministic`。

## 4. 装配与 Config

`apply(ctx)`：`inject = ['agents','storageDomain','skillAuthoring']`；注册 `runMaintenance` 周期 pass（`intervalHours` 距上次 + `minIdleHours` 空闲阈值；上次运行时间存 curator domain 记录）+ `session/event` 观察者；HMR disposal 注销两者。

## 5. 验收门（Phase 出口）

- 附件全部验收绿 + 100% 覆盖（状态机与观察者全决策表；Curator 编排以 fake AuthoringService 驱动）；
- REAL boot：curator + skill-authoring + skill-filesystem 全组合，归档→复活→active 全链；
- 领地测试进 REAL 场景（`.agents` 零接触为持久回归用例）；
- README（Known Limitations：LLM 整合未实现、仅 project 自治域、P5 指标经 aggregateOutcomes 供外部面板）+ Agent Note；doc-sync。
