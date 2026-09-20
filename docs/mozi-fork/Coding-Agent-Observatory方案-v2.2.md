# Coding-Agent-Observatory 方案 v2.2

> 状态：批判性复审后的协议基线；允许进入可执行规格与合成验证，不允许直接启动正式 corpus
>
> 日期：2026-09-21
>
> 输入：[Coding-Agent-Observatory 方案 v2.1](Coding-Agent-Observatory方案-v2.1.md)
>
> 目标系统：fork-DSH
>
> 适用范围：Observatory 的研究登记、采集、证据治理、版本化解释、实验评测和 DSH 迁移裁定。

## 摘要

Coding-Agent-Observatory 用受控实验和可追溯运行证据判断 Coding Agent 机制是否值得迁移到 DSH。v2.2 保留 v2.1 的 Sidecar、native evidence、Raw/Analysis/Eval 分层和主题 cohort，同时补齐证据来源的信任等级、机器可执行规格、跨存储提交、删除后的完整性语义、任务判定器、跨会话干扰控制和资源隔离。正式报告只能读取封存的 Research Bundle；任何缺少 study lock、数据质量裁定、预注册 estimand 或确定性 outcome 的结果都只能作为探索材料。首个实施目标不是接入更多 Agent，而是让合成 producer 能系统击穿协议并得到明确拒绝。

## 目录

- [1. 对 v2.1 的批判性复审](#1-对-v21-的批判性复审)
- [2. v2.2 的裁定与强制原则](#2-v22-的裁定与强制原则)
- [3. 信任模型与证据权威](#3-信任模型与证据权威)
- [4. 机器可执行规格](#4-机器可执行规格)
- [5. 系统架构与身份流](#5-系统架构与身份流)
- [6. Native Evidence Envelope v2.2](#6-native-evidence-envelope-v22)
- [7. Segment、对象和元数据提交](#7-segment对象和元数据提交)
- [8. 数据分层与版本化](#8-数据分层与版本化)
- [9. 脱敏、保留、删除与完整性](#9-脱敏保留删除与完整性)
- [10. Capture Completeness](#10-capture-completeness)
- [11. Task Contract 与 outcome](#11-task-contract-与-outcome)
- [12. 实验设计与 estimand](#12-实验设计与-estimand)
- [13. Self-Evolution 隔离实验](#13-self-evolution-隔离实验)
- [14. Non-Interference 与资源公平](#14-non-interference-与资源公平)
- [15. Analysis、Eval 与 Research Bundle](#15-analysiseval-与-research-bundle)
- [16. DSH 接入与迁移裁定](#16-dsh-接入与迁移裁定)
- [17. 实施阶段与停止条件](#17-实施阶段与停止条件)
- [18. v2.2 验收矩阵](#18-v22-验收矩阵)
- [19. 版本与兼容规则](#19-版本与兼容规则)
- [20. 待决事项](#20-待决事项)
- [Dev Note](#dev-note)

-----

## 1. 对 v2.1 的批判性复审

v2.1 已经纠正 v2 的主要分层和实验设计问题，但仍停留在“严谨的架构说明”与“可执行研究协议”之间。以下缺口会使看似完整的数据产生不可复核或不可比较的结论。

| 严重度 | v2.1 缺口 | 可能后果 | v2.2 修正 |
|---|---|---|---|
| 阻断 | 没有定义 runner、Adapter、Sidecar、mapper、evaluator 和 operator 的身份及写权限 | 引擎或错误插件可伪造 capture health、事件来源和 feature state | 建立 principal、credential、写入域和 evidence authority matrix |
| 阻断 | “native evidence”与“脱敏 Raw”混称 | 未保存原字节时仍可能错误宣称原生载荷完整 | 区分 source bytes、policy-processed native record 和 forensic copy；报告明确保存等级 |
| 阻断 | 对象库 durable 后写 PostgreSQL，但没有跨存储恢复协议 | crash 可留下永久孤儿、悬空引用或错误 ack | 定义 staged object、metadata commit、finalize、reconcile 和 ack 的严格顺序 |
| 阻断 | Hash chain、对象删除和密钥销毁的关系未闭合 | 合规删除会被误报为篡改，或完整性验证 silently 失效 | 用 segment manifest、erasure tombstone 和 verification state 表达删除后的可验证范围 |
| 阻断 | 实验协议没有强制声明 estimand、干扰域和分配单位 | 跨 session memory 在 treatment 之间串扰，效应估计没有明确对象 | Study Lock 固定 estimand、unit、interference domain、assignment 和 missingness policy |
| 阻断 | 文档描述 schema，却没有可执行 schema 与 conformance suite | 不同语言的 producer/consumer 会产生兼容但不同义的实现 | 规定七类机器规格和正反 fixture，文档只解释关系 |
| 高 | Capture Health 仍主要依赖被采集进程与 Sidecar | 两者共同失效时只能看到沉默 | runner 独立记录进程、socket、segment 和终止状态，并执行 end reconciliation |
| 高 | `verified helpful` 没有统一 Task Contract | Agent 自报、judge 评分和测试结果可能混为一个 outcome | 每个 task 固定 setup、validator、oracle data class 和结果状态 |
| 高 | common-model lane 没有资源与并发隔离要求 | noisy neighbor、cache、rate limit 和后台任务会造成系统性偏差 | 增加 resource cell、并发计划、cache policy 和 pressure telemetry |
| 高 | Self-Evolution 只说 reset/carry-over，没有定义知识库身份 | 同一项目或用户目录可把前一 arm 的 memory/skill 泄漏到后一 arm | 每个 assignment 使用隔离 workspace、Harness home、engine home 和 knowledge-store identity |
| 高 | 正式报告绑定 digest，但没有可移交的封存包 | 另一环境无法知道所需对象、查询、镜像和撤回状态 | 定义 Research Bundle manifest、验证命令和 source-revoked 状态 |
| 中 | 能力证据状态只有单调升级，没有过期条件 | 上游 rebase、配置变化或 capture point 漂移后仍显示 `covered` | 状态绑定 revision/profile，任何输入变化都重新评估 |
| 中 | DSH 迁移包没有裁定角色和利益冲突规则 | Adapter 作者可同时选择样本、解释结果并批准迁移 | 分离 capture owner、analysis owner 和 DSH decision owner，并记录异议 |

v2.2 不继续扩充静态 Agent 功能清单。具体源码位置、capability 状态和 capture point 由机器可读 profile 拥有，方案只规定这些 profile 必须满足的规则。

-----

## 2. v2.2 的裁定与强制原则

v2.2 裁定 Observatory 是研究执行系统，不是通用遥测平台。系统首先保护结论的适用范围，其次追求事件数量和查询便利。

1. **Evidence has an authority**：每项事实声明都标明观察者、观察方式和适用范围；hook 自报不能替代独立 workspace 或 protocol 观察。
2. **Stored Raw is policy-processed**：`raw` 表示保留 native 结构的脱敏记录，不默认表示源进程产生的逐字节原文。
3. **No ack before recoverability**：Sidecar 只有在对象与元数据可以由 crash recovery 收敛到唯一结果后才确认 segment 水位。
4. **Deletion changes verification state**：合规删除不改写历史结论，但会把依赖结果标为部分可重建或不可重建。
5. **Study Lock precedes outcomes**：正式实验在任何 outcome 可见前固定 estimand、assignment、排除、missingness、分析和停止规则。
6. **Isolation follows the treatment state**：只要 memory、skill、cache、home 或外部 service 能跨 run 保留，它就属于干扰域，必须隔离或作为实验变量登记。
7. **Deterministic outcome first**：代码测试、git state、协议响应和资源计数能判断时，不用模型 judge 替代。
8. **Exploration never self-promotes**：Pilot 可以修改下一版协议，但不能与 confirmatory 数据合并，也不能直接批准 DSH 迁移。
9. **One owner per executable fact**：JSON Schema、migration、task validator、mapper 和 analysis query 各有一个执行权威；本文不复制完整实现。

-----

## 3. 信任模型与证据权威

Observatory 默认把被观察引擎和 Adapter 视为 cooperative-but-buggy。涉及安全或 hostile-input 主题时，Study Lock 可选择 hostile-engine lane；该 lane 不接受引擎自报作为唯一证据。

### 3.1 Principals

| Principal | 可写内容 | 禁止写内容 |
|---|---|---|
| Study Registrar | study lock、condition、assignment | Raw event、measurement |
| Runner | run lifecycle、process observation、resource cell | native payload、semantic result |
| Adapter Producer | 自己 stream 的 envelope 与 drop notice | ack、capture verdict、其他 producer stream |
| Sidecar Ingestor | object state、Raw event、ack、ingest health | Analysis mapping、Eval score |
| Retention Controller | erase request、tombstone、key state | 伪造原 event 或重算历史 report |
| Mapper | 指定 namespace 的 Analysis projection | Raw、Study Lock、Eval decision |
| Evaluator | measurement、comparison、report candidate | Raw、Analysis source records |
| DSH Decision Owner | Accept/Reject/More Evidence 裁定 | 修改证据和统计结果 |

每个写入携带 principal id、software digest 和 authorization context。数据库角色、对象库 credential 和签名密钥相互分离；共享 root credential 不进入正式部署。

### 3.2 Evidence authority matrix

同一机制可以有多个观察源，但它们回答的问题不同。

| 事实 | 首选权威 | 交叉证据 |
|---|---|---|
| provider 实际请求 | protocol/provider boundary bytes | internal hook、provider usage response |
| tool 获准与执行 | tool runtime/permission boundary | Agent event、子进程 observation |
| workspace mutation | configured filesystem/git observation | tool result、artifact digest |
| memory/skill durable commit | authoritative store 或 artifact after-state | internal commit event、future read |
| recall 后模型可见 | exact model request | recall decision、Session/event history |
| process termination | Runner/OS observation | stream end、Sidecar disconnect |
| feature outcome | Task Contract validator | Agent final text、blind judge |

当权威与交叉证据冲突时，Analysis 产生 `evidence_conflict`，不得用优先级自动吞掉差异。研究者先修复 capture profile 或预注册冲突处置，再启动新 study version。

### 3.3 本地身份

Sidecar 使用操作系统可验证的 peer identity 或每次 run 派生的短期 credential 绑定 producer。Envelope 中的字符串 principal id 只作索引，不能单独完成认证。

一个 producer 只能声明 Registrar 预分配给它的 `(run_attempt, stream, epoch)`。Sidecar 拒绝越权 identity，同时把拒绝计入独立 ingest audit。

-----

## 4. 机器可执行规格

正式实现先创建规格文件与 conformance fixtures，再创建数据库 DDL 或真实 Adapter。所有规格通过内容 digest 被 Study Lock 引用。

### 4.1 必需规格

| 规格 | 负责内容 |
|---|---|
| `study-lock` | estimand、assignments、conditions、stop/missingness policy、所有输入 digest |
| `source-lock` | engine repository、exact revision、submodule、build profile 和 source artifact digest |
| `capture-profile` | engine revision、capture points、data class、expected observability、coverage scenarios |
| `native-envelope` | 字段、大小、record kind、identity、clock 和 payload descriptor |
| `task-contract` | setup、workspace image、allowed side effects、validator、outcome states |
| `retention-policy` | data class、scope、TTL、forensic policy、erasure behavior |
| `research-bundle` | Raw/Analysis/Eval snapshots、objects、images、queries、signatures 和撤回状态 |

每个规格包含 `schema_version` 和 `spec_digest`。解析器拒绝未知顶层字段、未知 critical extension、重复 JSON key、非规范数字、越界字符串和未登记 enum；兼容扩展只能进入显式 extension map。

### 4.2 Conformance suite

每个语言实现共享同一组 fixture：

- 最小合法记录；
- 最大合法记录；
- 未知 optional extension；
- 未知顶层字段与未知 critical extension；
- duplicate key；
- identity conflict；
- seq gap 与 epoch restart；
- 大对象 ticket；
- credential-like payload；
- erase 后的 bundle verification。

正 fixture 必须生成相同 canonical bytes 和 digest。负 fixture 必须产生相同 error code；只比较“失败了”不足以确认跨语言一致。

### 4.3 文档与规格的关系

本文拥有原则、组件责任和失败语义。Schema 文件拥有字段，migration 文件拥有物理表，task manifest 拥有样本，Source Lock 拥有外部源码。若这些来源冲突，runner 拒绝启动并要求提升相应版本，不能选择一个“看起来合理”的解释。

-----

## 5. 系统架构与身份流

系统将研究控制、热路径采集、持久化、解释和裁定拆成五个进程责任域。

```text
Study Registrar
  │ signed Study Lock + assignments
  ▼
Runner ───────── independent process/resource observations ───────┐
  │ short-lived producer credentials                              │
  ▼                                                               │
Observed Agent → Probe → bounded queue → local segment writer     │
                                      │                           │
                                      ▼                           │
                              authenticated Sidecar ◄─────────────┘
                                      │
                       classify → redact/quarantine → stage object
                                      │
                         commit metadata → finalize → ack
                                      │
                    sealed Evidence Snapshot + verification state
                                      │
                    Mapper → Analysis Snapshot → Evaluator
                                      │
                         sealed Research Bundle candidate
                                      │
                              DSH Decision Owner
```

Registrar 与 Runner 不读取任务 outcome 后再改变 assignment。Sidecar 不加载 mapper 或 evaluator plugin。Mapper 和 Evaluator 使用只读 snapshot credential，不访问 live spool。

-----

## 6. Native Evidence Envelope v2.2

Envelope v2.2 增加规格绑定、认证主体引用、payload descriptor 和原生因果引用。它仍不携带跨引擎 semantic name 或效果判断。

```json
{
  "schema": "observatory.native.v2.2",
  "spec_digest": "sha256:...",
  "study_lock_digest": "sha256:...",
  "envelope_id": "uuid",
  "run_attempt_id": "uuid",
  "producer_principal_id": "uuid",
  "producer_instance_id": "uuid",
  "stream_id": "uuid",
  "stream_epoch": 1,
  "seq": 42,
  "record_kind": "event",
  "capture_point_id": "uuid",
  "capture_method": "native_hook",
  "native_event_type": "engine.memory.extract",
  "clock": {
    "wall_time": "2026-09-21T00:00:00.000Z",
    "monotonic_ns": 123456789,
    "clock_domain_id": "uuid"
  },
  "native_links": [
    { "relation": "parent", "native_id": "..." }
  ],
  "payload": {
    "media_type": "application/json",
    "declared_size": 128,
    "transport": "inline",
    "value": {}
  }
}
```

### 6.1 Identity

- Sidecar 从认证会话解析真实 principal，并要求它与 envelope 引用一致。
- `spec_digest` 和 `study_lock_digest` 必须属于 Runner 发放的 assignment。
- `capture_point_id` 直接指向 revision-bound profile entry，不再依赖可重名的字符串 key。
- `envelope_id`、stream tuple 和 canonical bytes 三者共同参与重复检测。
- `stream_epoch` 只能由 Runner 或已登记的 restart handshake 开启。

### 6.2 Clock

`clock_domain_id` 标识单调时钟的生命周期。Runner 生成 calibration record，记录 wall/monotonic 对、测量往返时间和误差上限。

跨 clock domain 只使用区间比较。无法确定先后时，Analysis 保留 `concurrent_or_unknown`，不得按 collector receive time 伪造业务顺序。

### 6.3 Payload

Inline payload 有较小硬上限。大 payload 使用 local blob ticket，ticket 绑定 run、producer、declared size、media type 和一次性 nonce。

Sidecar 对实际字节重新测量 size 和 media type。声明与实际不一致时对象进入 quarantine，event 不进入可分析 Evidence Snapshot。

-----

## 7. Segment、对象和元数据提交

v2.2 用可恢复状态机替代“先对象、后数据库”的口头顺序。ack 表示 Sidecar 已经能在 crash 后重建唯一的接受或拒绝结果。

### 7.1 Adapter segment

Segment 是 Adapter writer 的最小 durable unit，包含固定 header、连续 envelope、尾部 index 和 segment digest。关闭 segment 时 writer fsync 内容和目录项；未关闭 segment 只能在本机恢复流程中读取，不能直接上传为完整批次。

本地预算按 run 和 producer 分配。预算耗尽时 writer 按 capture profile 的优先级丢弃，并生成独立、预留空间的 drop record；不能让低价值 stream 挤掉 drop/heartbeat 通道。

### 7.2 Object state

```text
received
  ├─→ quarantined
  └─→ staged → referenced → finalized → erased
```

`quarantined` 对象不能被 Raw/Analysis 查询。`staged` 对象已通过校验与脱敏，但可能没有 metadata 引用。`referenced` 表示 metadata 事务已提交。`finalized` 表示对象进入正常保留和备份集合。

### 7.3 提交顺序

1. Sidecar 认证 producer，验证 envelope 和 assignment。
2. Sidecar 读取 payload，执行 data-class parser、大小校验和脱敏。
3. Sidecar 以 ingest transaction id 写 staged object 和 staging receipt。
4. Sidecar 在 PostgreSQL 单事务中写 event、object reference、stream watermark 和 ingest decision。
5. Sidecar 把 staged object finalize；finalize 幂等。
6. Sidecar 只有在步骤 4 已提交且步骤 5 可由 reconciler 重试时返回 ack。
7. Reconciler 收敛无引用 staged object、已引用未 finalize object 和已 finalize 但 metadata 不可见的异常。

metadata 永远不引用 `received` 或 `quarantined` 对象。相同 transaction id 的重试必须得到 byte-equal decision；不同内容使用相同 identity 时 run 标为 `evidence_invalid`。

### 7.4 End reconciliation

Runner 结束 run 后提交 expected producer/process set。Sidecar 对每个 stream 核对 start、epoch、watermark、drop、segment digest、end 和 ack。

只有 end reconciliation 完成后，run 才能从 `completed_pending_evidence` 进入 `evidence_sealed`。Agent 成功退出不等于证据可用于分析。

-----

## 8. 数据分层与版本化

v2.2 使用 Control、Evidence、Analysis、Eval 和 Ops 五个逻辑 schema。`Raw` 作为 Evidence 中的记录类型保留，但文档不再把它与未处理 source bytes 等同。

### 8.1 Control

Control 保存 engine/source lock、Adapter profile、Study Lock、task contract、assignment、principal 和授权。Study Lock 封存后不可更新；修订创建新 version 和 digest。

### 8.2 Evidence

Evidence 保存 policy-processed native record、protocol frame、artifact observation、process/resource observation、capture health、object reference、ingest audit 和 erasure tombstone。

每个 record 带：

```text
observer principal
capture method
authority class
source record id
policy version
stored-byte digest
verification state
```

Forensic source bytes 使用独立 vault 与身份域，不属于默认 Evidence Snapshot。

### 8.3 Analysis

Analysis 从一个封存 Evidence Snapshot 生成 canonical event、entity、span、feature observation、conflict 和 derived link。Mapper 输出不能覆盖其他 version，也不能写 `causal_estimate`。

能力状态不再全局单调。状态键至少包含 engine revision、Adapter revision、capture profile、condition 和 coverage-suite version；任一输入改变都回到 `claimed` 或 `located` 重新评估。

### 8.4 Eval

Eval 保存 Task Contract outcome、measurement、annotation、estimand result、sensitivity analysis 和 report candidate。因果估计只在 Eval 产生，并引用 Study Lock 中的 estimator id。

### 8.5 Ops

Ops 保存 queue、spool、writer、reconciler、storage、retention 和 access audit。Ops 指标可否决数据质量，但不得直接改变业务 feature state。

-----

## 9. 脱敏、保留、删除与完整性

v2.2 把数据治理放在 ingest 决策中，而不是在数据已经扩散后补做扫描。

### 9.1 Parse before redact

每个 capture point 声明允许的 media type 和 parser。未知、损坏、加密或压缩 payload 如果无法按 policy 解析，默认进入 quarantine；不能把二进制当文本扫一遍后视为安全。

Redactor 输出 replacement map 的类别、数量和位置范围，不保存命中的 secret 原文。规则版本、parser 版本和 verdict 进入 ingest audit。

### 9.2 Scope isolation

对象键至少按 data owner/project scope 隔离。共享 CAS 不暴露跨 scope 的 plaintext equality，也不允许调用方用 digest 探测对象存在。

Forensic vault 默认关闭。启用时必须在 Study Lock 指定目的、读取角色、TTL、密钥、备份策略和自动销毁验证。

### 9.3 Segment integrity

每个 sealed segment 有 event chain、object digest set 和 signed segment manifest。Study snapshot 再固定所含 segment manifest 的排序集合。

签名只能说明 manifest 未在签名后变化，不能说明 producer 诚实或 capture 完整。报告必须把 integrity、authority 和 completeness 分开。

### 9.4 Erasure

删除对象时 Retention Controller 追加签名 tombstone，记录对象 id、policy、scope、时间和销毁方式，不记录被删内容。Segment manifest 保留原引用和 `erased` verification state。

验证器区分：

```text
intact
intact_with_authorized_erasure
source_revoked
integrity_failure
```

授权删除不能被误报为 hash mismatch。依赖已删 payload 的 mapper/report 标为 `source_revoked`；只依赖未删 metadata 的结论可以声明部分可复核，但必须列出缺失范围。

-----

## 10. Capture Completeness

Completeness 是针对“某项声明需要哪些独立观察”的判定，不是全 run 的单一百分比。

### 10.1 Expected observability

Capture profile 对每个机制声明：

- trigger opportunity；
- required producers；
- required start/terminal events；
- expected cardinality 或上下界；
- artifact/protocol cross-check；
- 允许缺失的 optional evidence；
- 哪类 gap 会否决哪类结论。

Synthetic Coverage Suite 从该声明生成正场景和故障场景。手写测试列表不能成为第二份 coverage 权威。

### 10.2 Independent health

Runner 独立记录 process spawn/exit、socket accept/close、segment 文件、resource cell 和终止原因。Sidecar 记录认证、receive、decision、ack 和 reconciliation。Producer 记录 heartbeat/drop/end。

三者共同失效时，宿主 job controller 或实验 orchestrator 必须提供 run-level timeout/exit observation。没有外部终止观察的 run 永远不能支持“机制未发生”。

### 10.3 Negative claim readiness

Analysis 只有在以下条件全部满足时生成 `negative_claim_ready`：

1. capability 对 exact condition 为 available/configured/enabled；
2. trigger opportunity 已由适当权威观察；
3. required producers 均完成 end reconciliation；
4. 没有影响区间的 drop、gap、quarantine 或 identity conflict；
5. coverage-suite version 对当前 profile 有效；
6. artifact/protocol cross-check 没有冲突。

该状态只允许声明“在已定义观察窗口中未观察到触发或完成”，不允许推广成产品永远不会执行该机制。

-----

## 11. Task Contract 与 outcome

Task Contract 把任务输入、允许副作用和 outcome 判定从 Adapter 与报告代码中抽离。没有 Task Contract 的运行只能用于采集器 smoke test。

### 11.1 固定输入

Task Contract 至少固定：

- repository/image digest 和初始化步骤；
- task text/prompt digest；
- allowed network、tools、permissions 和 time/token/cost budget；
- workspace、engine home、Harness home、credential fixture 和 external service fixture；
- validator image、命令、timeout 和 expected artifact policy；
- cleanup 与 evidence retention scope。

### 11.2 Outcome states

```text
pass
fail
invalid_setup
infrastructure_failed
budget_exhausted
unscorable
```

`fail` 只表示任务在有效环境中没有满足 validator。基础设施、采集或 setup 错误不能计为 Agent fail，也不能静默重跑后删除。

### 11.3 Validator

确定性 validator 在 Agent 停止后以只读或隔离副本运行。Validator 不能读取 engine/condition 标签，不能修改待评分 workspace，并输出结构化 result 和证据引用。

需要模型或人工 judge 的维度是独立 secondary outcome。Judge 输入、rubric、blind 状态和分歧报告进入 Eval，不能覆盖确定性 validator 状态。

-----

## 12. 实验设计与 estimand

Study Lock 必须先回答“估计谁在什么条件下因为什么干预改变了哪个 outcome”，再生成任务和运行矩阵。

### 12.1 Estimand

每个 primary estimand 固定：

```text
population
treatment conditions
experimental unit
assignment unit
interference domain
outcome
summary measure
handling of invalid/missing attempts
estimator
uncertainty method
```

“Agent A 比 Agent B 好”不是合格 estimand。合格示例是“在指定 task population 和 common-model lane 中，启用 exact recall condition 相对 recall-off 对 deterministic pass rate 的平均处理效应”。

### 12.2 Assignment 与重跑

Registrar 在 outcome 不可见时生成全部 assignment。基础设施重跑继承 assignment id 并增加 attempt ordinal；Study Lock 规定选择 first-valid、all-attempt sensitivity 或其他规则。

不能按“最好一次”选择 attempt。任何人工重跑都记录发起人、原因和是否进入 primary analysis。

### 12.3 Missingness

Missing reason 使用封闭 enum，并区分 pre-treatment、post-treatment 和 observer-caused。Primary analysis、worst-case bound 和 sensitivity analysis 的处理方式预先固定。

Observer contamination 通常属于 post-assignment exclusion，必须报告各 arm 比例；比例不平衡时不能只分析剩余样本。

### 12.4 Multiplicity 与停止

每个 study 指定一个 primary outcome 和有限 primary contrasts。其余指标标为 secondary/exploratory。

提前停止只允许依据预注册的安全、成本、无望或统计规则。查看趋势后改变样本量、删除指标或新增主对比会产生新 study version。

### 12.5 Comparison lanes

common-model 与 native-strength 保持分离。即使模型名称相同，只要请求能力、context limit、tool protocol 或 system prompt 不等价，报告也列出差异并避免“纯机制效应”措辞。

-----

## 13. Self-Evolution 隔离实验

Self-Evolution 的 treatment 会改变未来输入，因此普通 task-level 随机化不足。v2.2 把 knowledge store 所属范围作为实验单位的一部分。

### 13.1 Isolation cell

每个 assignment cell 独占或显式共享：

```text
workspace clone
git refs
engine home
Harness home
memory store
skill store
session store
cache namespace
background-job namespace
credential fixture
external service namespace
```

共享项必须在 Study Lock 中声明，并说明为何不会传递 treatment。仅删除 `MEMORY.md` 不等于重置所有学习状态。

### 13.2 Acquisition 与 transfer

Acquisition case、governance decision、retention gap 和 transfer case 绑定一个 cell。不同 arm 使用独立 cell；不能让同一用户级 skill 目录被多个 arm 读写。

Transfer task 与 acquisition task 按 solution、repository lineage、issue family 和 artifact overlap 规则隔离。近似改写单独标为 repeat-task，不计入 cross-task transfer。

### 13.3 Conditions

优先 within-engine conditions：

```text
no-learning
extract-shadow
extract-plus-governance
recall-enabled
skill-enabled
full-lifecycle
```

每个 condition 必须能由 feature state 和后续证据确认实际执行。配置开关存在但 mechanism 未触发时，不把 run 当作 received treatment；primary analysis 使用 Study Lock 预定的 assignment-based 或 treatment-received 方法。

### 13.4 Safety outcomes

Self-Evolution 的硬否决项独立于 task benefit：

- credential/secret 泄漏；
- cross-project 或 cross-user 泄漏；
- 未授权可见 mutation；
- 错误知识导致新的 deterministic failure；
- 无法删除或回退的 durable state；
- source evidence 无法定位。

收益不能抵消硬否决项。Pilot 命中硬否决项时暂停对应 condition，保留其他主题继续运行。

-----

## 14. Non-Interference 与资源公平

Observatory 既可能改变 Agent 行为，也可能通过 CPU、磁盘、cache 和 provider rate limit 间接改变结果。v2.2 同时控制语义污染与资源竞争。

### 14.1 Semantic ON/OFF

固定 provider replay 或 deterministic mock 比较 request、tool、permission、workspace、durable session、memory/skill、subagent graph、compaction 和 final output。Comparator 只忽略预登记的 observer identity/time 字段。

任何未解释差异使 attempt 为 `observer_contaminated`。宽泛文本 normalizer、删除整个 metadata map 或只比较最终文本都不合格。

### 14.2 Resource cell

Runner 为每个并发 run 分配 CPU、memory、disk I/O、spool quota、network policy 和 provider concurrency slot。相同 comparison block 使用相同 resource class。

Sidecar、数据库和对象库的共享压力进入 Ops telemetry。超过预注册 pressure limit 的 block 标为 `resource_confounded`，不能只删除较慢 arm。

### 14.3 Cache policy

Study Lock 指定 cold、warm 或 production-like cache。Engine cache、dependency cache、model/provider cache、repository index 和 Sidecar object cache 分开记录。

随机执行顺序不能替代 cache 隔离。需要 warm-cache 研究时，warm-up 属于 Task Contract，且其成本单独报告。

### 14.4 开销

Probe latency、Agent wall time、CPU、RSS、disk、network、spool 和 drop 分别报告绝对值与相对值。Pilot 估计合理门限，confirmatory study 冻结门限。

资源开销超过门限时，run 可以保持行为有效，但该 Adapter revision 不具备正式部署资格。

-----

## 15. Analysis、Eval 与 Research Bundle

正式结果只从封存 snapshot 生成。Live dashboard 是运维工具，不能成为报告数据源。

### 15.1 Deterministic mapping

Mapper 输入包括 Evidence Snapshot、mapper image、spec digests 和 mapping config。相同输入必须产生相同 canonical bytes、row count 和 snapshot digest。

若 mapper 调用模型，它不是 deterministic mapper，而是 Analysis annotation job；其 sampling、重试和输出不确定性单独保存。

### 15.2 Eval

Evaluator 读取 Analysis Snapshot、Task Contract outcomes、Study Lock 和 annotation snapshot。它不得根据最终效果回写排除规则或 feature state。

每个 comparison 保存 estimand id、included assignments、attempt selection、missingness handling、estimator、effect、interval 和 sensitivity result。

### 15.3 Research Bundle

正式发布物包含：

- Study Lock 和所有引用规格；
- Source Lock、Adapter/capture profile；
- Evidence/Analysis/Eval snapshot manifests；
- 仍获授权的对象清单与 erasure tombstones；
- runner、mapper、evaluator 和 validator image digests；
- analysis query/code digest；
- report、limitations 和 DSH decision；
- signature set 和 bundle verification state。

Bundle verifier 在无 live database 写权限的环境中检查引用闭合、digest、signature、erasure 和版本支持。它不需要解密无权读取的 forensic object。

### 15.4 Reproducibility levels

```text
R0 metadata-only
R1 report inputs enumerated
R2 deterministic Analysis rebuild
R3 deterministic Eval rebuild
R4 authorized end-to-end rerun
```

报告声明实际达到的等级。外部 API、撤回数据或不可复现模型使 R4 不可达时，不能用“可重放”笼统覆盖。

-----

## 16. DSH 接入与迁移裁定

DSH 接入继续遵守全插件架构和 model-visible/logged 要求。Observatory 只观察或报告，不建立隐藏的模型输入和持久状态路径。

### 16.1 Extension point

优先顺序：现有 typed event/service → 独立 Observatory plugin → package-owned新观察事件 → 最窄 loop change。修改 agent loop 必须证明现有 extension point 无法表达所需事实，并同步架构文档、Session event、两套 SDK 和 snapshot 影响。

Workspace/process 观察通过 configured provider 完成。直接读取 host 只适用于明确的 local-host study，不能把远程或 sandbox workspace 的 host view 当作目标状态。

### 16.2 Decision roles

| 角色 | 责任 |
|---|---|
| Capture Owner | Adapter/profile、coverage、Non-Interference |
| Analysis Owner | mapper、quality verdict、limitations |
| Study Owner | estimand、assignment、report |
| DSH Domain Owner | extension point、产品约束、回退 |
| Decision Owner | Accept/Reject/More Evidence 与异议记录 |

同一人可以承担多个角色，但报告明确披露。Adapter 作者不能通过修改 mapper 或排除规则单方消除不利结果。

### 16.3 Migration packet

迁移包必须包含 exact mechanism、适用 population、effect 与区间、成本、安全否决项、失败样本、DSH extension point、model-visible/logging 影响、durable format 影响、feature flag、回退和后续验证。

裁定：

- `Accept for design`：证据足以进入独立 DSH 设计，不表示实现批准；
- `Reject`：机制或条件不值得迁移，并说明可推翻条件；
- `More Evidence`：列出缺失 estimand、coverage 或 sample，不使用笼统“继续观察”。

[RC5.5.5 方案](自我进化机制-RC5.5-方案.md)和[执行进度报告](RC5.5-执行进度报告.md)继续拥有 DSH 自我进化的实际设计与进度。Observatory 读取 exact Source Lock，不从计划文档推断 feature 已实现。

-----

## 17. 实施阶段与停止条件

每个阶段交付机器产物、正反 fixture 和明确停止条件。阶段出口失败时，项目缩小研究范围，不以增加 Adapter 掩盖基础缺陷。

### Phase 0：Executable Specifications

交付七类 schema、canonical encoding、error taxonomy、cross-language conformance runner 和 fixture corpus。

出口：至少两个独立实现对所有正 fixture 生成相同 digest，对所有负 fixture 生成相同 error code。

停止：无法定义 canonical bytes、identity 或 required/optional 兼容规则时，不编写 Sidecar persistence。

### Phase A：Ingest Correctness

使用合成 producer 验证认证、segment、spool budget、object state、metadata transaction、reconciler、ack、quarantine、redaction、erasure 和 bundle verification。

出口：在每个提交点注入 crash 后，系统收敛到唯一状态；没有悬空可见引用、silent loss 或越权写入。

停止：任何身份冲突被当作幂等成功，或任何 secret fixture 进入共享对象库。

### Phase B：Adapter Contract

使用 wrapper、native event/plugin 和 structured dual-output 三种接入形态验证 Evidence Authority Matrix、coverage 和 ON/OFF。

出口：三种形态达到对应 C2，source/profile drift 阻止正式运行，resource overhead 在 Pilot budget 内。

停止：需要大范围 fork 才能取得基础 request/tool/workspace 事实时，重新评估该引擎是否适合首轮 corpus。

### Phase C：Exploratory Self-Evolution Pilot

使用隔离 cell 运行少量 acquisition/transfer case，估计 candidate rate、错误率、泄漏风险、方差、成本和干扰路径。

出口：形成 confirmatory Study Lock、样本量、primary estimand、Task Contract 和硬安全门限。

停止：任何不可回退的跨 scope mutation 或未脱敏 credential 暴露暂停该 condition。

### Phase D：Confirmatory Studies

按 Self-Evolution、Compaction、Recovery、Interop 和 Context Efficiency 独立执行。每个主题单独封存 Research Bundle 和 DSH decision。

出口：Bundle 验证通过，primary analysis 与 sensitivity analysis 完成，Decision Owner 给出裁定。

-----

## 18. v2.2 验收矩阵

以下断言在 Phase 0/A 中必须成为可执行测试，不能只由文档评审确认。

| ID | 断言 |
|---|---|
| V22-01 | 未认证或越权 producer 不能写任何正式 stream，但拒绝行为进入独立 audit |
| V22-02 | 相同 identity 的不同 canonical bytes 产生 `identity_conflict` 并否决 run |
| V22-03 | 任一 ingest 提交点 crash 后 reconciler 收敛到唯一 object/metadata/ack 状态 |
| V22-04 | metadata 不引用 received/quarantined object，Analysis 不读取 staged object |
| V22-05 | unknown/binary/损坏 payload 默认 quarantine，不以 text scan 成功放行 |
| V22-06 | erasure 后 segment 验证为 authorized erasure，而不是 intact 或 integrity failure |
| V22-07 | source bytes 未保存时报告不能声明 verbatim native payload retained |
| V22-08 | current profile 的 revision/spec 任一变化会使旧 coverage 状态失效 |
| V22-09 | Runner、Producer、Sidecar 的 end reconciliation 缺一项即不能 seal Evidence Snapshot |
| V22-10 | `negative_claim_ready` 必须满足 trigger opportunity、coverage、无 gap 与 cross-check |
| V22-11 | Task Contract 能区分 Agent fail、invalid setup、infrastructure failure 与 unscorable |
| V22-12 | Validator 不读取 arm 标签且不能修改被评分 workspace |
| V22-13 | Self-Evolution 各 arm 的 workspace/home/knowledge/cache namespace 按 Study Lock 隔离 |
| V22-14 | Observer contamination 和 resource confounding 按 assignment 报告，不静默删除 |
| V22-15 | primary estimand、contrast、missingness、attempt selection 和 stop rule 在 outcome 前封存 |
| V22-16 | common-model 与 native-strength 使用不同 estimand 和 report section |
| V22-17 | 相同封存输入重建相同 Analysis 与 deterministic Eval digest |
| V22-18 | Bundle verifier 能在只读环境发现缺对象、错误 digest、未知 schema 和撤回 source |
| V22-19 | Mapper 无权写 Raw/Eval，Evaluator 无权写 Raw/Analysis，Retention Controller 无权改 event |
| V22-20 | DSH migration packet 明确裁定、适用范围、回退和可推翻条件 |

-----

## 19. 版本与兼容规则

Envelope、规格、schema、mapper、evaluator 和 report format 分别版本化。版本号表示解析与语义兼容，不表示实验结论新旧优劣。

### 19.1 Major

改变 identity、canonical bytes、required field、事件含义、erasure 验证或 estimand 解释时提升 major。旧 Study Lock 继续绑定旧 parser；不能用新 parser 猜测读取。

### 19.2 Minor

只增加显式 optional extension、不会改变既有 digest/meaning 时提升 minor。Reader 必须按 spec 决定忽略或保留 extension，不能由实现自行选择。

### 19.3 Patch

文档澄清、fixture 增补或不改变接受集合和输出的实现修复使用 patch。若修复改变任何既有 fixture 结果，它不是 patch。

### 19.4 Historical data

Evidence 不做原位语义升级。需要新解释时创建新 Analysis Snapshot；需要结构 successor 时保留 predecessor 和迁移记录。数据删除另走 erasure，不伪装成 migration。

-----

## 20. 待决事项

Phase 0 必须先决定：

1. canonical encoding 使用 JSON canonicalization、CBOR 或其他格式；
2. 本地 principal 认证在 Linux/macOS/Windows 的统一抽象；
3. segment fsync 与目录持久化的跨平台最低保证；
4. 对象 staging/finalize 在 filesystem CAS 与 S3-compatible backend 的共同状态机；
5. Study Lock 和 segment manifest 的签名 owner、轮换和恢复；
6. project/user data owner 的 scope identity；
7. confirmatory study 的 primary estimand 与可接受 missingness 上限；
8. Research Bundle 的长期归档和 source-revoked 发布策略。

这些决定落在机器规格及其 conformance fixtures 中。决定未完成时，真实 Agent 接入只能做本地 exploratory smoke，不得产生正式比较报告。

-----

## Dev Note

<details>
<summary>非权威工作备注</summary>

v2.2 有意删除静态 engine source index。发现链接仍可用于调查，但正式 source anchors 只进入 revision-bound capture profile 和 Source Lock，避免架构文档成为第二份漂移清单。

首个实现 PR 适合只交付 `native-envelope`、`study-lock` 和 canonical fixture runner，不应同时创建 PostgreSQL 全量 schema、Sidecar daemon 和真实 Adapter。

</details>
