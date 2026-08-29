# RC5.2 前置：第四轮评审（RC5.1 函数级规格）核验与处置

> 状态：设计备忘（fork 侧工作文档，登记于 translation-pairing 排除清单）
>
> 评审对象：`RC5.1-评审报告.md`（第四轮，9 S1 → 实为 14 S1 + 10 S2 + 3 一致性问题，针对函数级规格五附件 + 总纲 + RC5.1 方案）
>
> 方法：同前三轮——承重断言逐一对照本仓源码（path:line），先核验后裁决
>
> 日期：2026-08-29

## 0. 总判断

第四轮评审是四轮中质量最高的一轮：**14 条 S1 经源码核验全部成立**，其中 S1-1（`ctx.fs` 无 move/rename/delete）直接推翻了 P2/P4 的目录移动设计——这是对 RC5.1 函数级规格最实质的证伪。其提出的 **AgentManagedSkillProvider（不可变 revision + sidecar 状态 + list 只出 active）是全系列四轮评审中最有价值的单条架构建议**，应作为 RC5.2 的核心重构采纳。10 条 S2 全部采纳（三处实现细节收窄/修正，见 §3）。本轮没有需要整体拒绝的建议；不符实际之处为三处小的口径/范围修正（§3）。

同时记录两个事实性结论：

1. **上游同步仍为 no-op**：`git ls-remote` 复确认 upstream master = `cd5ef81` 零新提交（第三次确认）。评审自己"不用后续 master 倒灌、fork SHA 由 P0 在本仓钉死"的基线纪律正确，双方一致。
2. 评审对第三轮的再裁定（ignorable 不存在、`parent_session` 过滤、`observeHostMutation` 机制）与 [核验处置] 一致，无翻案。

## 1. 十四条 S1 逐条核验（全部成立）

| # | 指控 | 本仓核验 | RC5.2 处置 |
|---|---|---|---|
| S1-1 | promote/archive 依赖的目录 move 在 `ctx.fs` 不存在 | **逐字证实**。`FileSystem` 抽象类公开原语恰 12 个：resolve/processPath/fileUrl/contains/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText（`fs/src/index.ts:86-256`）——无 rename/move/delete/copy；fs-local 的 rename 只用于单次 write 内部原子发布，非 Consumer API | 采纳 **AgentManagedSkillProvider**（§2）：patch = 写新不可变 revision（`writeText` 可达），promote/archive/revive = sidecar 单 record CAS；**删除** staging 目录 move 与 `ctx.skillMutationObserver` fork-diff |
| S1-2 | `update` 对缺失 key 抛 `missing-key`，首写路径全错 | **逐字证实**。`domain.ts:334-338` `DomainError('missing-key', …'has no record…')`；JSDoc :85 明示 | 各 Store 实现 `ensureInitialized()`（同一域队列内 get→无则 put(初始态)→update；单 Host writer + 域级串行下安全）；P0 新增 first-record creation contract 测试；E0 补 `put` 覆盖语义（覆盖 vs create-only） |
| S1-3 | 幂等检查在 base-revision 检查之后，crash 重试必然 `stale_base_revision` | **成立**（RC5.1 自身规格顺序缺陷：先校验 revision 后查 appliedOps） | `applyOps` 单个 update 闭包内改为：A 全部 ops 已有 receipt → 直接返回 duplicate（不受 base revision 影响）；B 有未应用 op → 再校验 base revision；C 折叠提交；混合部分 duplicate + stale → 整体 reject/replan |
| S1-4 | `applyMemoryOpPure` 不纯且签名无法承载 per-op 结果 | **成立**（add 内生成 id/时钟 = 非纯；返回单 state 无法表达 results） | host 预分配权威字段：`HostMemoryOp { opId, entryId(由 opId 确定性派生), now }`；fold 改为 `foldMemoryOps(state, ops, config): { nextState, results }` |
| S1-5 | `appliedOps` 无界增长 | **成立**（无预算无淘汰；storageDomain 整 record JSON 持久化） | `MemoryEntryId` 由 opId 确定性派生（天然防重复 create）+ entry 留 `lastAppliedOpId` + **有界 recent receipt window**（长度覆盖未终结 checkpoint + 余量，仅当 cursor 证明永不重放才清理）；P1 加"万次 mutation 后 state 有上界"测试 |
| S1-6 | `scanContent` 已定义未接线；Publisher 无失败语义 | **成立**（P1 规格两条写入/发布路径均未调扫描；Hermes [H-MEMORY] 双层扫描在案） | 写边界：add/update → `scanContent` → 命中即拒；发布边界：Publisher 二次扫描，命中条目渲染 `[BLOCKED: reason]` 占位、原文留存可审计；**Publisher fail-open**：scan/持久化异常记错误并放行当前用户请求，保留最后已发布快照——自进化副作用永不压住主对话 |
| S1-7 | 截窗丢旧侧 + advance 到 throughInclusive = 永久跳过证据 | **成立**（RC5.1 自述"保留靠近 through 侧"与 advance 语义组合即丢证据） | 分片改 **oldest-first 连续切片**，high-water 只推进实际审毕的 `effectiveThrough`；最近尾部作 `contextOnly`（禁止 evidence 引用、不影响 high-water）；P0/P3 加 `truncation-never-skips-evidence-range` |
| S1-8 | `claim` 无 acquired/busy 语义；新 due 可能丢失 | **成立**（"已有 inFlight 返回现有"两义） | `ClaimResult = acquired \| busy \| nothing-due`；同一原子 update 内 `desiredThroughSeq = max(old, incoming)`；仅 `inFlight undefined→有值` 的 caller 得 acquired 并启动 LLM；busy caller 不 spawn |
| S1-9 | validated plan 未持久化：crash 后同 reviewId 重问模型可能得到不同方案 | **成立**（ledger 只有 status/opStates） | `planned` 成为 durable 边界：schema parse + admissibility + canonicalize 后**先写 `ReviewCheckpoint.plan + planDigest + base revisions` 再 commit**；recover 规则：`planning` 无 plan 可重新 planning；`planned/committing` 只能恢复已存 plan，禁止再调模型 |
| S1-10 | `writableSkills` 只有 summary/digest，模型无法安全 patch | **成立**（Hermes [H-SKILL-MANAGER] read-before-write guard 同因） | 采纳方案 B **两阶段 planner**：planner-1 只选 `patchTarget(skillId)` → host 加载该 revision 精确 bundle → planner-2 在精确内容上产出 replacement；ManagedSkillProvider 的不可变 revision 使"精确读取"天然成立 |
| S1-11 | partial commit 破坏语义耦合（remove A + add B，B 被拒则 A 白删） | **成立** | 初版 **whole-plan preflight 全有或全无**；拒绝原因落 ledger 供 replan；未来需要部分提交时由模型显式产 `operationGroups[]` 声明依赖，Host 以组为最小 preflight 单位 |
| S1-12 | 单 event 谓词无法判 "assistant/message 仅 final" | **逐字证实**。`types.ts:262` `'assistant/message': { turn, step, message, usage?, interrupted?: true }`——每 step 一条，无 final 标志 | 拆 `eventKindAdmissible(event)`（只判类型/source）+ `projectEvents` 在完整 range 上做 **turn fold** 推导每 turn 的 final assistant outcome；`interrupted:true` 的 step 排除；新增多 step 工具循环只保留末个 assistant outcome 的测试 |
| S1-13 | 状态机缺时间锚点，grace/stale→archive 无数据可算 | **成立**（OwnershipRecord 无 createdAt/promotedAt/stateChangedAt；Hermes [H-SKILL-USAGE] 有 created_at 等） | ManagedSkillRecord 增 `createdAt/promotedAt?/stateChangedAt/staleAt?/archivedAt?`；锚点规则写死：active never-used 以 `max(promotedAt, createdAt)` 计、used 以 `lastMeaningfulUseAt` 计；stale→archive 以 **staleAt** 计二次窗口 |
| S1-14 | "单迁移原子性由 CAS 保证"不成立；Service 无 archive/revive API | **成立**（storageDomain CAS 只覆盖单 record；[D-FS] 无 move） | 采纳 Provider 方案后自然消解：`transitionManagedSkill(skillId, from, to, expectedRevision, opId)` = 单 sidecar record CAS，bundle 不移动，`invalidate()` 只是缓存刷新非 correctness authority；Service 补 `markStale/archive/revive` |

## 2. 核心架构采纳：AgentManagedSkillProvider（评审 S2-1，本轮最有价值建议）

RC5.2 的 Skill 生命周期落点从"文件目录移动 + skill-filesystem 打补丁"改为：

```text
<project>/.dsh/self-evolution/skills/<skillId>/revisions/<revision>/SKILL.md | references/…
ManagedSkillRecord（storageDomain 权威）
  { skillId, name, owner, state: draft|active|stale|archived,
    currentRevision, contentDigest, revision,
    createdAt, promotedAt?, stateChangedAt, staleAt?, archivedAt? }
AgentManagedSkillProvider（注册进 ctx.skills，经 registerProvider 持 SkillProviderControl）
  list() 只返回 state === 'active' 的 currentRevision
  control.invalidate() 在 sidecar pointer/state 变更后调用
```

- **DSH-native 依据**：registry 本就接受任意 Provider（`skill/src/index.ts:391` `registerProvider`；README "the registry accepts any provider"）；`SkillProviderControl.invalidate` 为 provider 自有确定性失效通道（:271-275,391-400）。
- **crash 语义**：bundle 写完而 pointer 未更新只留不可见 orphan revision，永不产生半 active 技能。
- **fork-diff 净减**：删除对 `skill-filesystem` 的 `ctx.skillMutationObserver` 修改（对上游包的 fork 修改从 2 个降为 1 个：仅 tool-session-query）。
- **rank 修正（本处置对评审的唯一实质性加严）**：评审建议 rank ">200" 即可；本处置加严为 **managed provider 取最低优先级（默认 rank 700，低于 bundled 600），不变式测试钉死"任何人工/内置/运行时来源在同名时恒胜 managed"**——自治来源结构性不可能遮蔽任何人写来源，同名冲突检查从安全机制降级为 fail-loud 提示（仍保留）。
- Hermes 治理策略（autonomous 只写 managed、缺 provenance fail-closed、用户技能不可碰）收进 Provider/AuthoringService 的所有权策略，而非复制其 `.archive` 目录动作。

## 3. 采纳但修正/收窄的细节（评审口径 vs 本仓现实）

1. **S2-3（废除 `${…}`/内联 shell 语法级禁令）——采纳，理由重述**：评审以 Hermes [H-GUARD] 扫描而非禁脚本为据，正确但没说到根上：**DSH 根本没有模板展开/脚本执行引擎**，`${…}` 在技能正文里是惰性文本，语法级禁令拒绝的是无害内容。RC5.2 规则：`validateStructure` 删除语法禁令；扫描器输出 `Finding{severity}` 三档（safe/caution/blocked）——高置信注入/外传/隐藏 Unicode → blocked；普通 shell 片段/路径/env 名 → caution（不阻塞，human promote 是第二道门）；结构层仍拒绝 binary/symlink/超限（`ctx.fs` 文本写缝本来也写不了 binary）。Memory 正文同理（项目事实本就含路径与命令）。
2. **S2-6（write approval）——采纳形态，缓实现**：`approvalMode: 'auto'|'stage-background'|'stage-all'` 进 Config、`PendingChange` 落 storageDomain、approve 时重验 revision/ownership/scan/conflict/policy（approval 是 policy gate 非 correctness authority）——全部写进 RC5.2 规范，但实现排在 L2 接近时；L0/L1 阴影+草稿阶段无此需要。
3. **S2-1 的 rank（见 §2）**：">200" 加严为最低优先级 + 不变式测试。
4. 其余 S2 全量照单采纳：S2-2（结构扫描：path 相对/禁 `..`/数量与字节上限/UTF-8 text only/`ctx.fs.contains`（:157 已证存在）最终 containment 断言）、S2-4（**candidate name 来自 frontmatter `name` 而非文件名**——`skill-filesystem/src/index.ts:800-829` 逐字证实，冲突测试必须覆盖 flat `.md` + frontmatter 名不一致两形态）、S2-5（foreground preemption：每 Agent 单 background run、新 foreground turn 取消并有限等待、取消 ≠ 失败不推进 high-water、resume-blocking 例外；`foreground-preempts-background-review` REAL 测试）、S2-7（attemptCount/lastFailureCode/nextRetryAt + 终态分类：proposal 拒绝不重试、stale 限次 replan、transient backoff、超限 failed-terminal）、S2-8（`maxReviewOutputTokens` 真接线 `agentOptions.maxTokens`——`runtime-types.ts:32-33` 已证该字段；`maxReviewTotalTokens` 指明由 usage 观察累计并在超限时 `run.dispose()`）、S2-9（usage 观察者 best-effort：内部串行队列、异常不抛回 session 路径、dispose 时 drain 或有意丢弃；`runMaintenance` 措辞改为"插件自带触发器，调用 runMaintenance 取得 idle ownership"——它不是定时注册器）、S2-10（P0 措辞改 "zero behavior change"）。
5. §4 一致性三条全采纳：`duplicate_op` 移出错误码表（改 `ApplyOpStatus`）；storage 版本错误码**透传上游原值 `version-mismatch`**（`storage-domain/src/error.ts:11` 逐字证实，删除自造的 `schema_version_mismatch`）；Shadow 升级不自动 backfill——high-water 照常推进，历史重学仅显式 re-review/migrate，写进 rollout 规格。

## 4. 锁定项确认

第三轮锁定的 14 项 + 本轮新增锁定：`LLM proposes; Host commits` 之完整含义 = **proposal 越过 host 验证边界即成为 immutable command plan**（S1-9）；skill 生命周期 = Provider 状态表达而非目录拓扑；autonomous 来源结构上永居最低优先级；usage telemetry 永远 best-effort；自进化副作用永远 fail-open 不阻塞用户回合。

## 5. RC5.2 文档动作清单

1. 方案主文档：§2 包规划改（AgentManagedSkillProvider 取代 staging 目录方案；删 skillMutationObserver fork-diff；新增 content-scan 与 skill-ownership 的 domain spec）；§4 数据模型按评审 §21 对齐（Cursor/ReviewInput/Plan/Checkpoint/MemoryState/ManagedSkillRecord 六概念分离 + 时间锚点）；§5 机制按本处置 S1-2..S1-14 重写；§6 P0–P5 门槛按评审 §6 增补（P0 扩至 33 项）。
2. 总纲：错误码表修（删 `duplicate_op`、`schema_version_mismatch`→`version-mismatch` 透传）；包清单更新（+AgentManagedSkillProvider 归属包；-ctx.skillMutationObserver）；fork-diff 台账更新（上游包修改仅剩 tool-session-query）。
3. 附件 P0：测试矩阵 23→33 项；附件 P1/P2/P3/P4 按上表重写签名与验收。
4. 原则 5 终稿："At-least-once trigger; resource-level idempotent commit——ledger 负责编排，去重在资源自身 commit/reconciliation 边界成立。"

（本处置即为 RC5.2 修订的完整依据；下一版方案文档据此产出。）
