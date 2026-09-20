# Coding-Agent-Observatory 方案 v2.3

> 状态：v2.2 经批判复审后的修正裁定与 Phase 0 开工基线；v2.2 作为常驻协议基线，经本文修正后继续有效。后续修订只追加修正条款与节点状态，不再全量重写。
>
> 日期：2026-09-21
>
> 输入：[Coding-Agent-Observatory方案-v2.0-架构复审稿.md](Coding-Agent-Observatory方案-v2.0-架构复审稿.md)、[Coding-Agent-Observatory方案-v2.1.md](Coding-Agent-Observatory方案-v2.1.md)、[Coding-Agent-Observatory方案-v2.2.md](Coding-Agent-Observatory方案-v2.2.md)
>
> 目标系统：fork-DSH
>
> 适用范围：Observatory 协议规格宿主、对 v2.0–v2.2 的批判性裁定、Phase 0 执行节点与验收映射。

## 摘要

三份前序文档把 Observatory 从功能清单收敛成了协议基线，但都停在同一类缺陷上：规则越写越严，可执行物始终为零，且每一版都以全量重写取代上一版，语义变化不可审阅。v2.3 不再重写基线，只做三件事：裁定 v2.0–v2.2 中仍然错误或不可执行的条款；确定协议规格在仓库中的落地宿主与全部 Phase 0 技术选型；给出立即可开工、逐节点可验收的执行计划，并随实施更新节点状态。

## 目录

- [1. 对 v2.0–v2.2 的批判性复审](#1-对-v20v22-的批判性复审)
- [2. 对 v2.2 的条款级修正](#2-对-v22-的条款级修正)
- [3. 落地决定](#3-落地决定)
- [4. Phase 0 执行节点](#4-phase-0-执行节点)
- [5. 验收映射与节点状态](#5-验收映射与节点状态)
- [6. 残余待决事项](#6-残余待决事项)
- [Dev Note](#dev-note)

-----

## 1. 对 v2.0–v2.2 的批判性复审

### 1.1 跨版本的共同缺陷

| 缺陷 | 后果 | v2.3 裁定 |
|---|---|---|
| 三版都是全量重写基线，关键规则无稳定条款号 | 无法引用、无法 diff 语义变化、每版都引入无意漂移 | v2.3 起改为“常驻基线 + 修正条款”；引用一律指向 v2.2 章节号加本文修正号 |
| 规则严格度单调上升，可执行物始终为零 | 协议在没有任何实现检验的情况下继续加严，规则间的矛盾无法暴露 | Phase 0 交付可执行规格与 conformance runner 后，新规则必须随正反 fixture 一起提交 |
| 文档没有进度载体，实施进度与方案脱节 | 完成状态只能靠 git 考古，接手者无法判断节点状态 | 本文 §5 节点表是唯一进度载体，随提交更新 |
| 主题与引擎清单随版本膨胀又收缩 | 阅读者无法判断哪些是承诺、哪些是候选 | 引擎与主题清单全部降为候选调查输入；承诺只存在于冻结的 Study Lock |

### 1.2 对 v2.0 的裁定

v2.0 的价值是候选调查面（引擎清单、主题清单、逐引擎观察点）与四条不变原则。其 PostgreSQL 全量 DDL、17 个主题、逐引擎 Adapter 章节已在 v2.1/v2.2 中被裁掉，v2.0 降级为历史调查输入，不再维护。v2.0 遗留的“DB-only blob → PG metadata + CAS”等结构裁定继续有效，但其物理选型随本文 §3 重定。

### 1.3 对 v2.1 的裁定

v2.1 的分层、传输幂等、Capture Health 与实验协议框架成立，被 v2.2 继承的部分不再重复裁定。v2.1 遗留两个问题：其一是版本文件形态（见 1.1，已修正）；其二是 §17 的分阶段计划把“协议验证”与“基础设施建成”绑在一起，没有先于数据库与 Sidecar 的可执行物，该缺口由本文 §4 的 Phase 0 节点补上。

### 1.4 对 v2.2 的批判

| 严重度 | v2.2 缺陷 | 后果 | v2.3 修正 |
|---|---|---|---|
| 阻断 | envelope 必填 `spec_digest` 与 `study_lock_digest`（v2.2 §6），而 Phase 0/C 阶段按定义不存在 Study Lock | 协议自相矛盾：合成验证与探索性采集永远产生不出“合法” envelope；任何一次本地诊断采集都是违规 | 绑定改为 capture context 字段：`binding` 取 `study` 或 `exploratory`；`study` 时三 digest 必填且校验归属，`exploratory` 时禁止进入正式 Evidence Snapshot，envelope 其余校验不变 |
| 阻断 | §7.3 把 metadata 提交绑定到 PostgreSQL 单事务 | 没有 PG 集群就无法开工；本仓库与单机研究环境被排除；选型被伪装成协议 | 协议只要求“支持单事务提交与崩溃收敛的 metadata store”抽象；Phase 0/A 以 `node:sqlite` 本地实现落地，PostgreSQL 降为后续替代 owner（§3.4） |
| 高 | 七类机器规格没有宿主、语言与运行时决定 | “先建规格”无任何开工含义；每个实现者自选语言自建目录 | 全部落入本仓库 `packages/experimental/observatory-protocol`，TypeScript + zod；详见 §3 |
| 高 | canonical encoding 列为待决（§20.1），而 conformance 出口依赖 canonical bytes | Phase 0 出口无法判定，被待决事项阻塞 | 裁定 RFC 8785（JCS）+ SHA-256；wire 层拒绝重复键与非规范数字，字符串转义差异在 canonical bytes 归一；幂等按 canonical bytes 判定（§3.2） |
| 高 | `capture_point_id` 只保留 UUID（v2.2 §6.1），丢弃了 v2.1 的可读 key | 事故诊断与 fixture 审阅必须反查 registry 才知道事件来自哪里 | 双轨：`capture_point_key` 为 profile revision 内唯一稳定字符串，`capture_point_id` 为对该 entry 的引用；两者必须同时匹配 |
| 中 | Phase 0 出口“至少两个独立实现”未指名第二实现及其交付物 | 出口永远无法判定；或被解释为随手写一个玩具 parser | TS 为权威实现；第二实现为 Python 只读校验器（复用本仓库 python 家族运行时），读同一 fixture corpus 并比对 digest 与 error code（§3.5、§4 P0-G） |
| 中 | V22 验收矩阵没有 owner 与执行序 | 断言只能靠文档评审确认，与“必须成为可执行测试”的自身要求冲突 | §5 把 V22 断言映射到 Phase 0 节点；协议层子集随 P0 节点落地为测试 |
| 低 | v2.2 §16.2 允许同一人兼多角色但要求披露，单人研究场景下披露沦为形式 | 无实质危害 | 保留原条款；单人研究时报告注明“roles consolidated”即可 |

## 2. 对 v2.2 的条款级修正

以下修正按 v2.2 章节号引用。未列出的条款继续有效。

1. **修正 §6（Envelope）**：顶层增加 `binding`（`study` | `exploratory`）与 `capture_point_key`；`spec_digest`、`study_lock_digest`、`run_attempt_id` 在 `binding: "study"` 时必填，`exploratory` 时省略。schema 字符串升为 `observatory.native.v2.3`。v2.2 示例中的 `capture_point_id` 保留，与 `capture_point_key` 同时校验。
2. **修正 §7.3（提交顺序）**：步骤 4 的“PostgreSQL 单事务”改为“metadata store 单事务”；步骤其余顺序（staged object → metadata commit → finalize → ack → reconcile）不变。
3. **修正 §4.2（Conformance suite）**：正 fixture 的“相同 canonical bytes”判定函数为本文 §3.2 的 canonical encoder；负 fixture 的 error code 词表由 `observatory-protocol` 包的 error taxonomy 拥有。
4. **补充 §4.1（规格清单）**：七类规格的 Phase 0 交付物为三个（`native-envelope`、`study-lock`、`capture-profile`）；`task-contract`、`retention-policy`、`research-bundle`、`source-lock` 的 schema 在 Phase A/B 按需交付，交付前由本条豁免其“必需”状态。
5. **补充 §10（Capture Completeness）**：`negative_claim_ready` 在 Phase 0 仅为状态词表，不要求实现；其判定逻辑属于 Analysis 层，随 Phase B 交付。
6. **维持 §17（阶段与停止条件）**全部出口与停止条件；Phase 0 的执行分解以本文 §4 为准。

## 3. 落地决定

### 3.1 宿主

`packages/experimental/observatory-protocol`，npm 名 `@deepseek-ai/dsh-experimental-observatory-protocol`，`private: true` 并登记进 `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`。理由：协议是 fork 内部研究资产，不进入发布家族；experimental 组要求不放宽工程与文档门禁，与 §1.1“规则随 fixture 提交”的裁定一致。

### 3.2 Canonical encoding

- 编码：RFC 8785（JCS）。对象键按 UTF-16 码元排序；数字、字符串、空白遵循 JCS；输出 UTF-8。
- 摘要：`sha256` 的 hex（`sha256:` 前缀），输入为 canonical bytes。
- 解析（strict scan）：先以严格扫描器检查输入——重复键、非规范数字字面量（以该字面量重序列化后与原文逐字节比对判定）、顶层之后的尾随内容；任何命中给出 taxonomy 中的确切 error code。通过后 `JSON.parse`，再经 zod schema 校验字段、enum 与范围；canonical bytes 由解析结果重序列化生成，与输入转义风格无关。
- 幂等与冲突：v2.2 §7.3 的 byte-equal 一律指 canonical bytes 相等。

### 3.3 Error taxonomy

错误码命名空间为 `observatory.error.v1`，Phase 0 覆盖解析与 schema 层：`duplicate_key`、`non_canonical_number`、`trailing_content`、`unknown_field`、`missing_field`、`invalid_type`、`invalid_enum`、`out_of_range`、`size_limit`、`binding_conflict`。Ingest 与身份类码（`identity_conflict`、`seq_gap`、`epoch_restart`、`quarantine` 等）在本期仅声明占位并标注 `reserved`，其语义随 Phase A fixture 交付。错误对象携带 code、spec path（JSON Pointer）与 detail；同一违规集合产生稳定的排序输出。

### 3.4 Metadata store 与对象库

Phase 0/A 的 metadata store 用 `node:sqlite`（零外部依赖，仓库 engines 范围内可用），对象库用文件系统 CAS（按 scope 分目录，对象名用 content digest）。二者都藏在 `MetadataStore` / `ObjectStore` 接口之后；PostgreSQL 与 S3-compatible 后端以后作为新的 store owner 引入，不修改协议。

### 3.5 第二实现

Python 只读校验器：读取同一 fixture corpus（JSON 文件与期望结果清单），以独立实现的 strict scan + canonical 序列化复算每个正 fixture 的 digest、每个负 fixture 的 error code，与清单逐项比对。它不依赖 TypeScript 包的任何产物。位于 `python/observatory-conformance/`，随 P0-G 交付；其不阻塞 P0-A…P0-F 的出口，但阻塞 Phase A 开工。

## 4. Phase 0 执行节点

节点按拓扑排序；A 调用的能力先于 B 完成。除 P0-G 外全部在 `observatory-protocol` 包内交付，测试进入仓库默认 vitest 工程，src 覆盖率受每文件 100% 门禁约束。

| 节点 | 交付 | 验收 | 状态 |
|---|---|---|---|
| P0-A | 包骨架：package.json（private）、tsconfig、paths 注册、双语 README、policy 登记 | 仓库门禁（hygiene、doc 注册面、pairing）全绿 | done |
| P0-B | `canonical.ts`：JCS 编码器、strict scanner（重复键/非规范数字/尾随内容）、digest 函数 | RFC 8785 附录语料 + 自有正反语料全绿；每类违规返回确切 error code | done |
| P0-C | `errors.ts`：error taxonomy、错误对象、稳定排序 | 词表封闭；同输入产出同序错误集合 | done |
| P0-D | `envelope.ts`：native envelope v2.3 schema 与校验（binding、身份字段、record kind、clock、payload descriptor、大小上限、key+id 双轨） | 合法 envelope 通过；每条 v2.2 §4.1 拒绝规则各有负测试 | done |
| P0-E | `study-lock.ts` + `capture-profile.ts`：两类 spec 的 schema 与 digest | 合法/负样本；digest 对空白与键序不敏感、对内容敏感 | done |
| P0-F | `synthetic.ts`：合成 producer——生成合法 envelope 流，并按违规类别系统变异；`fixtures/` 语料与 `conformance.spec.ts` runner | 语料文件 + 清单逐项比对：正 fixture digest 稳定、负 fixture error code 精确匹配；v2.2 §4.2 的最小/最大/未知扩展/重复键/上限/凭据类负 fixture 各就位；身份冲突与 seq/epoch 类是 ingest 语义，随 Phase A 补语料 | done |
| P0-G | Python 只读校验器（`python/observatory-conformance/`） | 对同一 corpus 复算全部 digest 与 error code，与清单一致 | pending |

Phase 0 出口（v2.2 §17 + 本文修正）：P0-A…P0-G 全部 done；两实现对所有 fixture 的判定一致。未达出口前，不编写 Sidecar 持久化与真实 Adapter。

## 5. 验收映射与节点状态

| 断言 | 映射 |
|---|---|
| V22-02（identity 冲突 fail-closed） | 协议层子集：同 identity 不同 canonical bytes 的检测函数随 P0-F 交付；ingest 侧行为属 Phase A |
| V22-04（metadata 不引用未授权对象） | Phase A（reconciler） |
| V22-05（unknown/binary payload 默认 quarantine） | 协议层子集：payload descriptor 校验与 size_limit 随 P0-D；quarantine 状态机属 Phase A |
| V22-07（未存 source bytes 不得声明 verbatim） | 报告规则，随 `research-bundle` spec 交付（Phase B） |
| V22-08（profile/spec 变化使 coverage 状态失效） | 状态键已入 capture-profile schema（P0-E）；状态机属 Phase B |
| V22-17/V22-18（封存输入重建、只读校验） | P0-G + Phase A bundle verifier |
| 其余 V22 断言 | Phase A–D 各阶段出口复检 |

§4 节点表的“状态”列是唯一进度记录；节点完成即在同一提交内更新该表，不另建台账文件。

## 6. 残余待决事项

1. 签名 owner 与外部 checkpoint（v2.2 §20.5）：Phase A 引入 segment manifest 前决定；
2. scope identity 的具体格式（v2.2 §20.6）：Phase A 对象 CAS 分目录前决定；
3. confirmatory study 的 primary estimand 与 missingness 上限（v2.2 §20.7）：Phase C 前决定；
4. `task-contract`、`retention-policy`、`research-bundle`、`source-lock` 四类 schema 的字段：Phase A/B 交付时确定。

## Dev Note

<details>
<summary>非权威工作备注</summary>

本文有意不重述 v2.2 的任何未修正条款；引用以“v2.2 §N”为准。三份历史文档不再更新，其事实性错误以本文修正为准。

P0-B 的 JCS 编码器为自有实现（不引第三方依赖）：核心是键排序加宿主 `JSON.stringify` 的数字与转义行为，单测直接收录 RFC 8785 附录语料；若宿主行为与 RFC 冲突，以语料测试为准并在此记录。

</details>
