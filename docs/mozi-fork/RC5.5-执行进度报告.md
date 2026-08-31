# RC5.5 执行进度报告（无人值守交接载体）

> 用途：本文件是自我进化机制（RC5.5）无人值守开发的**唯一**进度与交接载体。每个阶段完成后增补 §3 阶段台账，与其余改动一起提交推送。唤醒消息只发一条简短指令指向本文件；全部上下文以本文件 + 下方方案文档为准。
>
> 方案文档（冻结于 RC5.5.2）：`RC5.5-函数级规格总纲.md` + 附件 P0-evidence-lock / P1-memory / P2-skill-managed / P3-session-review / P4-curator（同目录）。P0 已全绿；P1 进行中（批A/批B 纯函数层完成，批C 待做）。冷启动交接另读 `RC5.5-交接稿.md`（同目录）。

## 1. 常备协议（每次唤醒先执行）

1. **上下文自检**：`node /home/moyang/Documents/a88/zcode-cdp/meter.mjs`（纯 DOM，禁用 context-popover.mjs 鼠标合成）。已用 >120000 → `setsid nohup /home/moyang/Documents/a88/zcode-cdp/auto-compact.sh >> /tmp/zcode-cdp/watchdog.log 2>&1 &` 后结束回合（结束回合前必须已 commit+push）；<120000 → 继续开发。
2. **阶段完成定义**：该批验收测试 + `pnpm run typecheck` + `npx oxlint <改动包>` + `pnpm run test:docs` 全绿 → commit → 增补本文件 §3 台账（与改动同一或紧随提交）→ push。
3. **push 前复现 pre-push 序列**：`npm run build:lib:host && npm run typecheck:contracts-ready`（fresh `tsc -b` 能抓到增量 typecheck 漏掉的错）。
4. **压缩闭环**（v4 规则）：阶段收尾若 meter >120k：先 commit+push，再跑 watchdog，再结束回合。**唤醒/心跳只发一条消息**（多条例会排队、阻塞下一轮阈值检查与压缩）；不要用 composer 排队；不要 pkill 点击序列中间的进程。watchdog 提交时才 `cat wake-message.txt`，因此改文件即可改消息内容。
5. 只有需求不明确或需人类决策的卡点才停下来等用户；其余一律自行推进。
6. 遵守仓库根 `AGENTS.md` 全部规则（新增包的注册机械面见 §5；生产代码不得引用测试树参照实现；凭据绝不入库）。

## 2. 总路线（P0 → P5）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | Evidence Lock 68 项验收条目（66 活跃 + 2 历史回归；实跑 72 测试）+ E0 结案 | **完成** |
| P1 | `packages/memory/memory` + `packages/util/content-scan`（本 Phase 两个实现包） | **进行中**（批A/批B 纯函数层完成，批C + 收尾批待做） |
| P2 | `packages/skill/skill-managed`（ManagedSkillService + skill_manage 工具） | 未开始（先红 T62/T63/T64/T65 接线，见 §4.4） |
| P3 | `packages/review/session-review` 运行时（ReviewRuntime 全链 + 治理双语义） | 未开始（finalization path 前置 T66–T68） |
| P4 | `packages/skill/skill-curator`（active 谱系 + live usage 归属） | 未开始 |
| P5 | rollout 指标 gate（总纲 §8，无独立代码面） | 未开始 |

> 包与阶段口径：P1–P4 共 **4 个新增实现包、5 个代码落点**（`packages/review/session-review` P0 已建骨架，P3 填充运行时）；P0 是测试与骨架阶段、P5 是指标 gate，均非新包落地。

## 3. 阶段台账（追加式，新阶段写在最下）

### P0 — Evidence Lock 套件：完成

- 断点提交：`39b1f63c2d`（四个批次，11 spec + 2 参照模块，72 测试全绿）+ `936c23224c`（Agent Note 收尾）+ `2d44adfeea`（前序修复）。
- 位置：`packages/review/session-review/tests/evidence-lock/`；矩阵与验收：`RC5.5-附件P0-evidence-lock.md`。参照实现 `review-protocol.ts` / `managed-protocol.ts` **仅存在于测试树，运行时落地时不得晋升为生产代码**。
- 双语 Agent Note：`.agents/notes/implemented/feature/2026-08-31-session-review-p0-skeleton.md`（含被修正假设清单）。

### E0 结案回填：完成

- `da9489c02b`：总纲 §7 十二项 E0 全部回填实测结论（各项标注结案用例号）；附件P0 §3 记录结案。**与 RC5.4/RC5.5 假设零冲突，未改任何签名**。三处精化：E0-3 终态联合本 build 恰五成员（merge-extensible）；E0-10 模型可见 catalog 行恰 `{name,description}` 而 sidecar `catalogSummary` 取 candidate 全字段集（两层不混）；E0-11 live 归属判据 `result.value?.provider` 中 stock 人工 provider 名为 `'filesystem'`。

### P1 批A — `packages/util/content-scan`：完成

- `1462092cba`：`scanContent(text, scope)` + `scanVerdict`（三档折叠）+ `PATTERN_SET_VERSION`；模式集锚定攻击词汇（blocked=高置信注入/密钥外传/持久化/隐藏 Unicode；caution=普通 shell/凭证路径/env 名），NFKC 归一 + 原始文本不可见字符检测 + 65,536 字符前缀上限；四语料（positive/benign 零命中/中文改写/code-block-vs-imperative）+ invariant spec；13 测试，per-file 100% 覆盖；README 三件套 + 全部注册门（tsconfig.base paths、tsconfig.host 引用、doc-standard.spec.ts、verify-package-readme-model-experience、constraints）。
- `d2201dc8ec`：附带修复 P0 骨架包 session-review 的 `files` 缺 `lib/types/**/*.d.ts`（constraints 门）。
- Hermes 扫描器参照：本地 clone `/home/moyang/Documents/a88/mozi-hermes-agent/tools/threat_patterns.py`（范围 all/context/strict、有界 filler、INVISIBLE_CHARS、64k 上限），已内化为 `src/patterns.ts`。

### P1 批B — `packages/memory/memory` 包骨架 + 纯函数组：完成（2026-08-31 17:56 +0800 提交，本台账回填时点）

- `00e6658986`：`src/types.ts`（仅类型，附件P1 §2 全量契约）+ `src/domain.ts`（memory domain spec `schemaVersion:1` + zod 记录 + receipt 二分）+ `src/fold.ts` 纯函数组（`deriveEntryId`/`enforceBudget`/`foldMemoryOps`/`splitReceipts`/`sanitizeForPublication`/`buildSnapshotSections`/`computeCompositeDigest`/`buildCompositeSnapshot`）+ `src/index.ts`（当前**仅 re-export**，运行时装配属批C）+ 单测（`tests/memory-fold.spec.ts` + `tests/memory-publish.spec.ts`，覆盖全部纯函数验收名）+ 包注册面（tsconfig.base paths、tsconfig.host 引用、vitest.config、README 三件套、verify 门）。
- 语义对照 P0 参照实现（`review-protocol.ts` 的 MemoryOps/TERMINAL_RING_CAPACITY），签名与记录按附件P1 全量契约（参照是简化版，仅存测试树，不得晋升生产代码）。
- 规格缺口记录（批C 前处置，见 §4.1）：`OpId` 现为裸 `string`（`src/types.ts:31`）——附件P1 §2 未钉 branded、P0 参照实现同为裸 string，故非违规而是**规格未钉**；按仓库"跨边界 opaque id 必须 branded"总规则，OpId 跨 memory/skill/review 三资源边界，应在批C 一次性钉成 `Branded<'OpId'>` 并同步规格。
- 注意：本批为批内中间提交，按 §1 规则 2 协议，阶段验收（完整门槛）在 P1 收尾批统一走（§4.3）。

## 4. 下一步工作（接手人从这里开始）

### 4.1 P1 批C 前置补账（先做，与批C 同提交或紧随提交）

1. **本文件 §3 台账回填**（本条即完成项，提交即闭环）。
2. **Agent Note**：memory 批B 属非平凡变更，双语 Agent Note 排入 P1 收尾批（§4.3）——不能跨批遗忘；批C 完成时若批B note 仍未落，与批C 同批补交。
3. **OpId 钉 branded**：`src/types.ts` 改 `export type OpId = Branded<'OpId'>`（纯类型、零运行时）；`deriveEntryId` 入参/`HostMemoryOp.opId`/receipt/ack 输入面同步；附件P1 §2 原位补一行 `OpId = Branded<'OpId'>`；P3 `deriveOpId` 返回该 branded 类型。若拖到 P3，P2 skill-managed 会先带裸 string 跨包边界。

### 4.2 P1 批C：MemoryService + MemoryPublisher + 装配

- `MemoryService extends Service`：唯一 memory 域 opener（T42 语义：同名重复注册抛错）。`static inject=['storageDomain']`；`[Service.init]` 开域 + `ctx.effect(close)`；`static Config`（schemastery：部署可变参数全部显式声明并验证，无未声明隐式默认；唯一规格钉死默认 = `publisherEnabled: true`）。方法：`getState(scope)`（ensureInitialized 后读）、`applyOps(scope, ops, expectedBaseRevision)`（单 RMW 闭包：receipt 查重先于 base 检查 → 写边界 `scanContent` blocked→抛 `threat_scan_blocked` → 折叠提交）、`acknowledgeTerminalOps(groups)`（逐组 RMW；splitReceipts 幂等三分；unknown scope/两无 opId → `invalid_structure`）。`resolveMemoryScope(agent, config)`：`findProjectRoot(cwd, ctx.fs)`（skill-filesystem:937-947 经挂载 fs 探测）→ `ctx.fs.resolve(root)` → ProjectKey=sha256(targetKey)；非 local backend fail-loud（E0-12）。
- `MemoryPublisher`（composite、fail-open）：pre-step 体内（仿 time-context:198-208：await next() 后追加消息）；读两 scope state → sanitize → buildSnapshotSections → digest → 比对 `latestPublishedMemory(session)`（仿 tool-skill catalogHistory:361-377 倒扫）→ 变更才发布**一条** `CompositeMemorySnapshot` 消息（T43：单 producer 顶替、无跨 scope churn）；任何异常记日志放行 `next()`（fail-open，保留最后已发布快照）。
- 装配 `src/index.ts`：`MessageSourceMap` 声明合并注册 `'memory'` kind（仿 tool-skill SkillCatalogSource：`packages/skill/tool-skill/src/index.ts:34-47`，`source:{kind:'memory', form:'snapshot', sections, scopes, digest}`）。
- P1 只填 `scopes.project`；user scope 节与本启用排 L2（类型与管线就位、恒缺省）。

### 4.3 P1 收尾批

README（Model Experience + Known Limitations：中文锚点声明集非完备集、caution 不阻断、user 节 L2、receipt 保留协议）+ README.zh + i18n 记录；双语 Agent Note（含 §4.1 补账的批B note，若未落则同批补交）；REAL boot（Loader 场景断言 composite snapshot 消息 + fail-open + 单 Service 双 scope）；HMR disposal 测试（dispose 后发布链路移除）；双 SDK expected outputs（`packages/sdk/protocol/src/types.ts` 通知面 + `python/sdk/src/deepseek_harness/api.py` 镜像，若 wire 面变化）；snapshot 场景（`snapshots/session/` 加 memory 案例：cordis.snapshot.yml 用 llm-replay 免钥，断言 composite snapshot 消息 + fail-open + 单 Service 双 scope + 回放重建零重复发布）；`pnpm run test:coverage` 核对 per-file 100%；按 §1 规则 3 复现 pre-push 序列后 push。**批C 完成 ≠ P1 完成：收尾批全绿之前不得进入 P2。**

### 4.4 P1 之后

P2 skill-managed（附件P2；**"先红"语义**：T62–T68 已在 P0 Evidence Lock 矩阵落位，P2 开工 = 让生产实现对 T62/T63（`deriveOpId` 纯函数，P3 落地面）与 T64/T65（skill receipt 生产路径）先失败再实现——不是重定义测试，也不是把 P0 参照实现晋升为生产代码；P2 接线面 = T64/T65）；P3 session-review 运行时（附件P3；finalization path 前置 T66–T68；`deriveOpId`/`ReviewOpState`/`markTerminal`/`markFinalized` 落此；session-query fork-diff 台账落 `packages/session-query/tool-session-query`）；P4 curator；P5 指标 gate。**每阶段完成后增补本文件 §3。**

## 5. 基础设施锚点（已核验，接手免重查）

| 事实 | 锚点 |
|---|---|
| `ContextSnapshotSection = {name, text}`；`form:'snapshot'` 走 ContextFormed | `packages/llm/llm/src/message.ts:64-69,80-95` |
| MessageSourceMap 声明合并注册新 kind（skill-catalog 范例） | `packages/skill/tool-skill/src/index.ts:34-47` |
| latest-published 倒扫 + digest + surface.nodes | `packages/skill/tool-skill/src/index.ts:361-377` |
| pre-step 发布消息（await next 后追加） | `packages/context/time-context/src/index.ts:198-208` |
| PreStepDecision 二元联合 + waterfall payload 五字段 | `packages/core/agent/src/runtime-types.ts:56-62,238` |
| domain spec `defineDomain/domainTable(zod)` + 消费范例 | `packages/storage/storage-domain/src/spec.ts`；`packages/feedback/message-feedback/src/spec.ts:84-90` |
| Service 唯一 opener + init + ctx.effect 关域 | `packages/session/session-projection-cache/src/index.ts:77-95` |
| Cordis Service 构造/注册/config 静态 | `vendor/cordis/src/service.ts:42-59`；session-projection-cache:55-58 |
| 双面注入先例（host Service + 工具包 `export const inject`） | `packages/goal/tool-goal/src/index.ts:22-36,187`；acp:61,97-98 |
| subagent 终态五成员 + result 形状 | evidence-lock T03/T12/T31（`subagent-face.spec.ts`） |
| storage table 读 API / already-open / version-mismatch | evidence-lock T07/T20/T24/T44 |
| REAL/replay 免钥场景机制（llm-replay + loader-smoke） | `snapshots/session/compaction-recovery/`；`packages/test-support/loader-smoke` |
| 新包注册清单 | 见 `docs/cookbook/adding-a-package.md:29-39`；照批A content-scan 的提交逐项 |

## 6. 常用命令

```sh
npx vitest run packages/util/content-scan packages/memory   # 本阶段测试
npx vitest run packages/review/session-review/tests          # P0 回归
pnpm run typecheck && npx oxlint packages/<改动包>
pnpm run test:docs            # 15 项文档门
npm run build:lib:host && npm run typecheck:contracts-ready   # push 前复现 pre-push
node /home/moyang/Documents/a88/zcode-cdp/meter.mjs           # 上下文 meter（纯 DOM）
setsid nohup /home/moyang/Documents/a88/zcode-cdp/auto-compact.sh >> /tmp/zcode-cdp/watchdog.log 2>&1 &   # >120k 时
```
