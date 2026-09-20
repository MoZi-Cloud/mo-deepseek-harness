# Coding-Agent-Observatory 方案 v2.1

> 状态：架构复审后的实施基线草案
>
> 日期：2026-09-21
>
> 输入：`Coding-Agent-Observatory方案-v2.0-架构复审稿.md`
>
> 目标系统：fork-DSH
>
> 适用范围：Observatory 采集、证据存储、版本化分析、评测设计和 DSH 迁移决策；不定义各外部 Agent 的产品路线。

## 摘要

Coding-Agent-Observatory 用可重放的运行证据研究 Coding Agent 机制，而不是制作 Agent 排名。v2.1 把不可变的 native evidence 与可升级的语义解释彻底分开，以 Sidecar 接收本地事件，以受控对象库保存载荷，并以版本化 Analysis/Eval 任务重建结论。正式实验必须固定源码、补丁、模型策略、任务、环境和分析协议，并报告采集缺口、观察开销与不确定性。任何 DSH 迁移建议都必须能回到已登记的证据、对照实验和失败样本，不能由功能清单或单次成功直接推出。

## 目录

- [1. 复审结论与 v2.1 改进](#1-复审结论与-v21-改进)
- [2. 目标、非目标与强制原则](#2-目标非目标与强制原则)
- [3. 系统分层与组件职责](#3-系统分层与组件职责)
- [4. 研究登记与源码锁定](#4-研究登记与源码锁定)
- [5. Native Evidence Envelope v2.1](#5-native-evidence-envelope-v21)
- [6. 本地传输、幂等与乱序](#6-本地传输幂等与乱序)
- [7. 数据模型](#7-数据模型)
- [8. Capture Health 与缺失证据](#8-capture-health-与缺失证据)
- [9. 载荷、保密数据与保留策略](#9-载荷保密数据与保留策略)
- [10. Probe 与 Adapter 规范](#10-probe-与-adapter-规范)
- [11. Engine Registry 与候选能力](#11-engine-registry-与候选能力)
- [12. 实验协议](#12-实验协议)
- [13. Self-Evolution 主题协议](#13-self-evolution-主题协议)
- [14. 指标、归因与报告规则](#14-指标归因与报告规则)
- [15. Non-Interference](#15-non-interference)
- [16. DSH 接入和迁移决策](#16-dsh-接入和迁移决策)
- [17. 分阶段实施计划](#17-分阶段实施计划)
- [18. 验收矩阵](#18-验收矩阵)
- [19. 版本、迁移与运维](#19-版本迁移与运维)
- [20. 2026-09-21 发现基线](#20-2026-09-21-发现基线)
- [21. 待决事项](#21-待决事项)
- [Dev Note](#dev-note)

-----

## 1. 复审结论与 v2.1 改进

v2 的总体方向成立，但它还不能直接作为实施规格。以下问题会影响证据可信度、数据安全或项目收敛速度，v2.1 将其改为明确规则。

| v2 问题 | 风险 | v2.1 处理 |
|---|---|---|
| Raw 表同时保存 `semantic_name`、canonical payload 和解释性 edge | 新 mapper 会改变“原始事实”，且不同解释无法并存 | Raw 只保存 native envelope、载荷引用和采集元数据；语义事件、实体和关系全部进入带版本的 Analysis projection |
| Sidecar 同时采集、redact、canonicalize、评测 | Sidecar 变成不可独立升级的大单体，故障会阻塞采集 | Sidecar 只做接收、校验、脱敏、落 spool/CAS 和写 Raw；mapper 与 evaluator 是离线作业 |
| `run` 直接连接实验与源码版本 | 重试、崩溃续跑、随机分配和同一条件重复无法表达 | 增加 `study_protocol → assignment → run_attempt → process/stream` 层级 |
| 仅用 `stream_id + seq` 描述顺序 | 进程重启、序号复位、重复发送和多进程时钟无法判定 | 增加 producer instance、stream epoch、clock domain、ack watermark 和 byte-equal 幂等规则 |
| Capture Health 与业务事件走同一失败路径 | 采集器完全失效时无法自证失效 | 增加独立 heartbeat、进程退出观察、终止标记和 sidecar 接收水位；“无事件”必须同时满足触发机会与完整性条件 |
| Hash chain 被当作“不可篡改” | 有写权限的主体可重算整条链 | 只声明篡改可检测；批次根需由独立签名密钥或外部 append-only checkpoint 固定 |
| 原始 secret 长期进入 CAS | 内容寻址、访问日志、备份和模型分析都可能扩大泄漏 | 未脱敏副本进入隔离 forensic vault，默认关闭或短保留；Analysis 只读脱敏投影；删除与密钥销毁有明确流程 |
| 同任务同模型被视为充分公平 | Agent 的工具协议、上下文格式和原生模型支持不同 | 分开 common-model lane 与 native-strength lane；只在同 lane 内比较，并报告不可控差异 |
| `caused_by` 等关系可直接写 Raw | 时间相邻被误写成因果 | Raw 只保留 native link；Analysis 使用 `observed_link`、`derived_link`、`causal_estimate` 三种声明并记录方法版本 |
| Pilot 同时接入十二个引擎 | 采集器尚未验证就扩大 Adapter 面，难以及时发现协议缺陷 | 先做无 Agent 合成验证，再覆盖三种接入形态，最后扩展主题 cohort |
| 外部源码索引使用 `main`/`dev` 浮动链接 | 文档与实验随上游移动 | 发现链接可浮动；正式 source lock 必须记录 exact commit、文件 blob digest 和 patch digest |
| 固定 p95 与 2% 开销阈值没有测量依据 | 任意阈值可能过严或掩盖高频累积开销 | Pilot 先测空载和压力基线；正式协议预注册绝对预算、相对预算和统计方法 |
| DSH 目标形态重复 RC5 文档中的细节 | Observatory 方案容易与 fork 的实际进度和决策漂移 | 本文只规定证据到迁移决策的接口；DSH 自我进化行为由 RC5.5.5 方案、附件和进度报告拥有 |

v2.1 的首要变化不是增加 schema 字段，而是定义哪些内容永远属于采集事实，哪些内容必须允许重算。

-----

## 2. 目标、非目标与强制原则

Observatory 的产出是可以复核的机制结论和 DSH 迁移建议。它不以接入引擎数量、事件数量或生成报告数量作为成功标准。

### 2.1 目标

1. 说明某个机制在什么条件下触发、执行、失败和产生后续影响。
2. 用相同 Raw 证据重建不同版本的语义投影和评测结果。
3. 区分“没有触发”“触发后失败”“探针没有覆盖”“采集链不完整”。
4. 测量观察系统的时延、资源、丢失和行为污染。
5. 为 DSH 形成带收益、成本、风险、适用范围和回退条件的机制迁移包。

### 2.2 非目标

- 不制作跨所有场景的单一 Agent 排名。
- 不采集隐藏 chain-of-thought，不推断未由 provider 暴露的推理内容。
- 不为外部 Agent 补齐其缺失的机制。
- 不在第一阶段建设通用数据湖、在线 BI 平台或自动迁移代码生成器。
- 不把模型 judge 的输出当作 Raw 事实或唯一质量结论。

### 2.3 强制原则

1. **Native first**：保存引擎原生事件和原生标识；canonical 含义必须可重建。
2. **Raw append-only under normal operation**：普通采集身份只能追加或封存，不能更新既有事件。受控删除另走数据治理流程。
3. **Analysis is disposable**：语义投影、实体图和指标可删除并从 Raw 重建。
4. **Exact inputs**：正式结论绑定源码、Adapter、capture policy、模型策略、任务、环境、redactor、mapper 和 evaluator 版本。
5. **No clean absence without coverage**：没有触发机会或采集完整性证据时，不得把事件缺失解释为机制未发生。
6. **Observer fail-open, evidence fail-closed**：观察故障不得阻塞被观察 Agent；证据不完整的 run 不得进入正式效果结论。
7. **No causal words without a design**：只有随机化、受控消融或预先声明的准实验设计才能产生因果估计。

-----

## 3. 系统分层与组件职责

系统将热路径采集、持久化和解释拆成独立组件。每个组件只有一个主要故障责任域。

```text
Observed Agent
  ├─ native protocol mirror
  ├─ observer hook
  └─ surgical read-only probe
             │ native envelope
             ▼
Adapter runtime
  bounded queue → local segment spool → local IPC
             │                         │ heartbeat / ack
             ▼                         ▼
Observatory Sidecar
  validate → classify data → deterministic redact → durable ingest
             │                         │
             ├─ isolated forensic vault (optional, short retention)
             └─ redacted object store + Raw metadata
                                      │
                         versioned Analysis mapper
                                      │
                         semantic events/entities/links
                                      │
                           versioned Eval pipeline
                                      │
                         report + DSH migration packet
```

### 3.1 Adapter runtime

Adapter runtime 读取引擎事实，构造小型 envelope，并写入有界的本地队列。独立 writer 将队列追加到本地 segment spool，再通过本地 IPC 发送给 Sidecar。

Adapter runtime 不连接 PostgreSQL，不执行模型调用，不做语义映射，不等待远端网络，也不把采集错误传播到 Agent 控制流。

### 3.2 Sidecar

Sidecar 负责 envelope 校验、重复检测、确定性脱敏、对象持久化、Raw 元数据追加、ack watermark、capture health 和批次完整性固定。Sidecar 不决定 `memory.extract` 是否成功，不创建跨引擎统一实体，也不计算实验结论。

### 3.3 Analysis mapper

Mapper 读取指定 Raw snapshot，以版本化规则生成 canonical event、entity 和 link。多个 mapper 版本可以同时存在；新版本不能修改旧 projection。

### 3.4 Eval pipeline

Evaluator 读取固定的 Analysis snapshot、study protocol 和人工标注版本，输出指标、区间估计、失败分层和报告。Evaluator 的模型调用、prompt、sampling 参数和重试策略都是实验输入。

-----

## 4. 研究登记与源码锁定

正式运行开始前必须生成一份不可变的 Study Manifest。人工可读说明不是执行权威，runner 只接受 manifest digest。

### 4.1 登记层级

```text
theme
  └─ study_protocol@version
       ├─ task_set@version
       ├─ condition definitions
       ├─ assignment plan
       ├─ analysis plan
       └─ stopping rule
            └─ assignment
                 └─ run_attempt
                      ├─ process_instance
                      └─ capture_stream
```

`assignment` 表示一个预先分配的 engine、condition、task、repeat 和随机化单元。`run_attempt` 表示一次实际启动；基础设施失败可以产生新的 attempt，但不得覆盖失败 attempt。

### 4.2 Source Lock

每个正式 engine revision 必须记录：

- 上游仓库规范化 URL 和 exact commit；
- fork commit；
- submodule、lockfile 和 dependency digest；
- dirty 状态；dirty 时保存排序后的 diff digest 和受影响文件清单；
- build/runtime image digest、操作系统、架构和关键工具版本；
- source evidence manifest：每个 capture point 的文件 blob digest、symbol 和定位策略；
- Adapter commit、patch manifest、capture policy digest 和 envelope 版本。

`main`、`dev`、release 页面和产品文档只用于发现候选能力。它们不能直接成为正式实验的 Source Lock。

### 4.3 能力证据状态

每个 engine capability 使用下列单调状态，报告不得把低级状态写成已观测行为。

| 状态 | 含义 | 允许用途 |
|---|---|---|
| `claimed` | 上游文档或 issue 声明存在 | 形成候选，不进入正式 cohort |
| `located` | exact commit 中定位到实现或协议定义 | 设计 capture point |
| `covered` | Synthetic Coverage Suite 命中预期事件和失败路径 | 允许试运行 |
| `observed` | 正式条件下采到完整事实 | 进入机制分析 |
| `evaluated` | 预注册实验完成并通过数据质量条件 | 支撑效果结论 |

-----

## 5. Native Evidence Envelope v2.1

Envelope 描述生产者观察到的事实和传输身份，不携带跨引擎语义判断。

```json
{
  "schema": "observatory.native.v2.1",
  "envelope_id": "uuid",
  "run_attempt_id": "uuid",
  "producer_instance_id": "uuid",
  "stream_id": "uuid",
  "stream_epoch": 1,
  "seq": 42,
  "record_kind": "event",
  "capture_point_key": "qwen.memory.extract.return",
  "capture_method": "native_hook",
  "native_event_type": "qwen-code.memory.extract",
  "clock": {
    "wall_time": "2026-09-21T00:00:00.000Z",
    "monotonic_ns": 123456789,
    "clock_domain": "process"
  },
  "native_ids": {
    "session": "...",
    "tool_call": "..."
  },
  "payload": {
    "encoding": "application/json",
    "inline": {}
  }
}
```

### 5.1 必填规则

- `envelope_id` 在创建时固定，重发不得改变。
- `(stream_id, stream_epoch, seq)` 在一个 epoch 内唯一且从 1 单调递增。
- 进程重启或 writer 丢失连续状态时必须增加 `stream_epoch`，不能猜测旧 seq。
- `record_kind` 只允许 `stream_start`、`event`、`heartbeat`、`drop_notice`、`stream_end`。
- `capture_point_key` 解析到 Source Lock 中的 exact capture point；未知 key 使 run 失去正式资格，但 envelope 仍进入 quarantine 供诊断。
- `native_event_type` 保留引擎命名。跨引擎的 `semantic_name` 只能由 mapper 生成。
- 大载荷由 Adapter writer 先写本地 segment/blob ticket；probe 热路径不得同步压缩或上传大对象。

### 5.2 禁止字段

Native envelope 不包含以下字段：

```text
semantic_name
canonical_payload
caused_by
evaluation_score
feature_completed
memory_quality
```

如果引擎原生事件包含同名字段，它们只存在于 native payload 中，并标明 producer 是引擎而不是 Observatory。

-----

## 6. 本地传输、幂等与乱序

传输协议必须在 Sidecar 崩溃、Adapter 重启和重复发送时保持可诊断。它不承诺零丢失，而是承诺所有可检测丢失都形成显式证据。

### 6.1 写入流程

1. Probe 尝试写入有界内存队列。
2. 队列满时 Probe 增加进程内 drop counter，并尽快返回。
3. Adapter writer 把队列批量追加到本地 segment，持久化后才可向 Probe 释放对应缓冲。
4. Sidecar 接收 segment frame，校验 envelope 和 payload，完成 Raw 事务后返回 `accepted_through` 水位。
5. Adapter 仅在 ack 后回收已确认 segment。
6. Sidecar 重启后从最后水位请求重发；重发必须 byte-equal。

### 6.2 幂等规则

- 相同 `envelope_id` 或相同 `(stream_id, epoch, seq)` 且存储字节一致：返回既有结果。
- 身份相同但字节不同：标记 `identity_conflict`，封存双方，run 为 `evidence_invalid`。
- payload 先到而 metadata 未提交：对象可暂存为未引用对象，由保留任务清理。
- metadata 不得引用尚未 durable 的 payload。

### 6.3 顺序规则

同一 stream 的 `seq` 给出全序。不同进程或 stream 之间只建立偏序，依据 native correlation id、父子进程关系、显式 link 和 Sidecar 接收时间；不得用 wall clock 强行生成全局精确顺序。

需要比较跨进程时序的实验必须执行时钟校准，并报告误差上限。超出误差上限的事件只能标为 concurrent/unknown order。

### 6.4 完整性链

Sidecar 对脱敏后实际存储的 envelope bytes 和 payload digest 建立 stream hash chain。每个封存批次生成 root，并由独立密钥签名或写入另一个 append-only checkpoint。

Hash chain 只支持“修改可检测”声明。它不替代数据库权限、对象锁、备份、删除审计或签名密钥管理。

-----

## 7. 数据模型

数据模型分为 Registry、Raw、Analysis、Eval 和 Ops 五个 schema。只有 Registry 与 Raw 是重建输入；Analysis 和 Eval 是可丢弃投影。

### 7.1 Registry

| 表 | 关键内容 |
|---|---|
| `registry.engine` | engine id、仓库、lineage parent、维护状态 |
| `registry.engine_revision` | source lock、依赖和运行环境 digest |
| `registry.adapter_revision` | Adapter commit、envelope/capture policy 版本 |
| `registry.capture_point` | exact revision 下的 key、symbol、blob digest、预期 cardinality |
| `registry.theme` | 研究问题，不保存效果结论 |
| `registry.study_protocol` | protocol version、manifest digest、状态、冻结时间 |
| `registry.condition` | feature、observer、model、policy 等实验变量 |
| `registry.task` | task content digest、origin、污染/许可标签 |
| `registry.assignment` | condition × task × repeat 的随机分配 |

`lineage_parent` 只表示已登记的源码血缘，不自动支持因果推断。

### 7.2 Raw

| 表 | 关键内容 |
|---|---|
| `raw.run_attempt` | assignment、engine/adapter revision、状态、开始/结束、失败类 |
| `raw.process_instance` | 父进程、角色、可执行文件/argv/env 的安全 digest、生命周期 |
| `raw.capture_stream` | producer、epoch、stream kind、开始/结束和最终水位 |
| `raw.native_event` | envelope identity、seq、native type、capture point、stored payload ref、hash chain |
| `raw.native_link` | 仅保存 producer 原生给出的 source/destination id 和 relation |
| `raw.artifact_observation` | 路径的安全逻辑名、before/after digest、exists、采集点 |
| `raw.protocol_frame` | protocol、direction、connection/request id、payload ref |
| `raw.capture_observation` | heartbeat、drop、gap、ack、queue、spool 和 writer lag |
| `raw.observer_intervention` | hook 时延、返回控制、输入/输出修改声明 |
| `raw.object_ref` | data class、media type、size、encryption、locator、storage digest |

Raw 不保存 canonical entity、canonical span、feature success 或 `caused_by`。

### 7.3 Analysis

| 表 | 关键内容 |
|---|---|
| `analysis.run` | mapper version、Raw snapshot、完成状态和重建 digest |
| `analysis.event` | canonical name、source event、规范化字段和 mapping confidence |
| `analysis.entity` | canonical entity kind、native identity bindings |
| `analysis.link` | source/destination、relation、claim class、支持事件和规则 id |
| `analysis.span` | 从事件重建的区间；允许 incomplete/open-ended |
| `analysis.feature_observation` | available/configured/trigger-opportunity/triggered/completed 的逐项证据 |
| `analysis.coverage` | capture point 和 scenario 的覆盖判断 |

`analysis.link.claim_class` 只允许：

- `observed_link`：producer 明确提供；
- `derived_link`：确定性 mapper 从已列证据推导；
- `causal_estimate`：由登记的实验模型计算，不得由普通 mapper 创建。

### 7.4 Eval

| 表 | 关键内容 |
|---|---|
| `eval.run` | evaluator、Analysis snapshot、rubric 和 judge 配置 |
| `eval.measurement` | metric、unit、value、missing reason、支持证据 |
| `eval.annotation` | rubric version、blinding 状态、annotator/judge identity |
| `eval.comparison` | effect size、区间、样本数、排除数和统计方法 |
| `eval.report` | 输入 digests、结论等级、限制和生成物引用 |

### 7.5 约束要求

- 所有 payload/ref 字段必须有可验证的对象外键或明确的 tombstone 状态，不能使用无类型 `bytea` 猜测引用含义。
- 循环关系通过后置约束或 Analysis 投影表达；Raw ingest 事务不得依赖尚未创建的 canonical entity/span。
- `attributes jsonb` 只承载引擎特有或低频字段。任何查询、完整性或权限规则依赖的字段必须升级为显式列并迁移版本。
- ID 在跨进程、持久化或 wire 上必须有域类型；数据库和实现不得把不同类别 UUID 当作可互换字符串。

-----

## 8. Capture Health 与缺失证据

Capture Health 不是一个百分比，而是一组能够否决结论的条件。正式分析必须对每个核心机制给出状态和原因。

### 8.1 独立观察源

每个 run 至少使用两类健康信号：

1. Adapter 自报：heartbeat、drop counter、queue high-water、stream end。
2. Sidecar/runner 外部观察：进程启动退出、IPC 连接、ack watermark、segment 残留、runner 终止原因。

高级主题再增加 artifact 或 protocol cross-check。业务 event 与 heartbeat 同时消失时，外部 runner 必须把该区间标为 unknown，不得视为 clean。

### 8.2 缺失解释条件

只有同时满足以下条件，才能写“机制有触发机会但未触发”：

- Source Lock 声明该能力在此 condition 可用且已启用；
- protocol 定义了本任务中的 trigger opportunity；
- trigger opportunity 的独立事件已观察到；
- 相关 capture points 已通过对应 Synthetic Coverage 场景；
- stream 没有 seq gap、drop、未确认 segment 或异常结束；
- Agent 进程和 Sidecar 都有可解释的终止状态；
- 交叉证据没有显示机制已经发生。

否则状态必须是 `not_applicable`、`no_trigger_opportunity`、`evidence_incomplete` 或 `unknown`。

### 8.3 Coverage 等级

| 等级 | 含义 | 可支持结论 |
|---|---|---|
| C0 Broken | 身份、顺序或载荷不可重建 | 仅诊断采集器 |
| C1 Interaction | request/tool/result/session lifecycle 可重建 | 基础交互描述 |
| C2 State | workspace、artifact、恢复边界可重建 | 状态机制描述 |
| C3 Theme | 主题生命周期的输入、决策、写入和后续读取可重建 | 主题机制比较 |
| C4 Forensic | provider attempt、关键 before/after、完整性和独立交叉证据齐全 | 失败调查，不自动代表效果可信 |

正式主题结果要求核心路径 C3，影响结论的失败样本也不得低于 C2。C4 是取证深度，不是质量分数。

-----

## 9. 载荷、保密数据与保留策略

证据完整性不能成为长期保存凭据和用户源码的理由。每个 capture point 在启用前必须声明 data class、脱敏规则、保留期和允许读取者。

### 9.1 数据类别

| 类别 | 示例 | 默认处理 |
|---|---|---|
| Public metadata | engine id、版本、事件计数 | Raw 可长期保存 |
| Project confidential | prompt、源码片段、patch、memory/skill 正文 | 确定性脱敏后进入受控 Raw/CAS |
| Credential-like | token、私钥、cookie、authorization header | 入库前删除或替换；不得进入分析模型 |
| Forensic restricted | 未脱敏原始 payload | 默认关闭；确需时单独授权、短保留、隔离密钥 |
| Prohibited | 隐藏 chain-of-thought、未获许可的个人数据 | 不采集 |

### 9.2 脱敏与对象寻址

脱敏器必须在 Sidecar 写共享 CAS 前运行。Analysis 只能读取脱敏对象。

未脱敏内容不得使用公开的 plaintext SHA-256 作为跨项目对象键，以免形成相等性 oracle。Forensic vault 使用独立命名空间、随机化加密、ciphertext digest 和受控 keyed digest；密钥与数据库分离。

### 9.3 删除与可复现性

普通写入 append-only 不等于永久保留。到期或授权撤回时，治理作业删除对象或销毁密钥，并追加 erasure record。引用该对象的 Analysis/Eval 被标为 `source_revoked`，后续报告不得宣称可完全重建。

备份、日志、临时 segment 和未引用对象都必须遵守同一保留策略。访问 forensic vault 的每次读取都产生不可由读取者修改的审计记录。

-----

## 10. Probe 与 Adapter 规范

Probe 选择遵循最低侵入原则，但“低级别”不自动代表“高质量”。正式选择依据是能否覆盖研究问题并通过 Non-Interference。

### 10.1 优先级

```text
L0 native structured protocol / export / event log
L1 documented observer hook
L2 wrapper or supported subclass
L3 surgical read-only source seam
L4 invasive fork
```

同一事实已有通过覆盖验证的 L0/L1 证据时，不增加 L3/L4。需要权威 commit point 或内部 decision 时，可以组合 native hook、artifact observation 和窄 L3 seam。

### 10.2 Surgical probe

每个 patch 必须满足：

- 只对应一个 semantic question；
- 不根据 collector 状态改变 Agent 分支；
- 不连接网络或数据库；
- 不等待 Sidecar；
- 捕获失败不向 Agent 抛出异常；
- 分配和序列化有硬上限；
- 队列满时记录 drop，不阻塞 Agent；
- patch manifest 记录 before blob、after blob、symbol、expected events 和 Non-Interference scenario。

Source Lock 中的 before blob 不匹配时，Adapter 状态为 `invalid_for_revision`，runner 拒绝正式 corpus。

### 10.3 Adapter Profile

每个 Adapter 由机器可读 profile 声明，而不是由本文中的大段源码路径充当执行配置。Profile 至少包含：

```yaml
engine_revision: <digest>
adapter_revision: <digest>
capture_policy: <digest>
capabilities:
  memory_extract:
    evidence_state: covered
    capture_points: [memory.extract.start, memory.extract.commit]
    coverage_scenarios: [extract-success, extract-error, extract-noop]
data_classes:
  provider_request: project-confidential
formal_theme_eligibility:
  self_evolution: true
```

-----

## 11. Engine Registry 与候选能力

Registry 可容纳任意引擎，但 cohort 只选择能回答某个研究问题的最小样本。`Core Corpus` 不再意味着所有主题都必须运行所有引擎。

### 11.1 候选层级

| 层级 | 引擎 | 当前候选问题 |
|---|---|---|
| Core methods | DSH、Hermes、Codex、OpenCode、OpenHands、mini-SWE-agent | durable session、memory、compaction、event runtime、最小 loop、采集形态 |
| P0 discovery | Qwen Code、Gemini CLI、MiMo Code | extract/dream/recall/forget、review inbox、history learning、lineage comparison |
| P1 theme-specific | Cline、SWE-agent、Goose | restore safety、reproducible harness、ACP/MCP interoperability |
| P2 theme-specific | Aider | RepoMap、context efficiency、git-centric accounting |

候选层级只决定调查顺序。只有能力达到 `covered`，引擎才可进入正式主题 cohort。

### 11.2 首批主题

v2.1 首批只保留能形成明确干预和后续结果的主题：

```text
T01 collection_integrity
T02 self_evolution_memory
T03 self_evolution_skill
T04 compaction_context_fidelity
T05 checkpoint_recovery_safety
T06 protocol_interop
```

v2 的其他 Theme 进入 backlog。每个新增 Theme 必须先定义 intervention、unit、outcome、coverage requirement 和停止规则，不能只添加名字。

### 11.3 Cohort 规则

- cohort 有版本，成员、condition 和排除理由冻结在 Study Manifest 中。
- `No-learning baseline` 是同一 engine 的 condition，不是一个 engine。
- 一个引擎可以只参加一个 Theme，不要求笛卡尔积。
- OpenCode 与 MiMo 的源码血缘只支持准实验分层，不允许写成天然随机对照。
- 产品功能、默认设置或源码血缘改变后必须创建新 cohort version。

-----

## 12. 实验协议

每个正式实验必须在首个结果可见前冻结分析计划。Pilot 可以探索，但其数据与正式确认数据分开报告。

### 12.1 实验单位与条件

Study Manifest 明确：

- experimental unit：session、task、repository 或 project history；
- treatment：单一 feature state 或明确的组合；
- baseline：同 engine feature-off、固定历史为空或其他可解释条件；
- carry-over：memory/skill 是否跨 task 保留，何时 reset；
- blocking：按 task、repo、model 和 engine revision 分块；
- randomization：condition 顺序和 task 分配的种子与算法；
- repeats：数量、基础设施失败的重跑规则和提前停止规则；
- exclusions：在看结果前定义，且报告所有被排除 attempt。

### 12.2 Comparison lanes

`common-model` lane 只在各引擎能使用同一模型、相同 reasoning effort、相同 token budget 和等价工具权限时成立。请求格式或模型能力不等价时必须列为限制。

`native-strength` lane 允许每个引擎使用推荐配置，回答“完整产品在其原生条件下表现如何”。它不能分离 Agent 机制与模型、prompt、工具或默认策略的贡献。

两种 lane 不合并排名，也不共享 effect estimate。

### 12.3 重复与统计

首个 Pilot 用于估计失败率、方差、开销和可测效应，不宣称一般性优胜。正式样本量由预注册的最小相关效应、功效或区间宽度目标决定。

报告至少包含样本数、attempt 数、排除数、缺失原因、effect size 和不确定区间。二元成功率、重尾时延/成本和人工评分使用各自适合的方法，不用一个平均分覆盖。

### 12.4 Judge

能由确定性 runner、测试、git diff 或协议结果判断的指标不得交给模型 judge。需要 judge 时：

- rubric 和 prompt 版本固定；
- 输入删除 engine/condition 标识以实现可行的 blind；
- 使用多个顺序随机的样本或多个 judge 检查稳定性；
- 人工抽样校准并报告分歧；
- judge 输出保存在 Eval，不回写 Raw 或 Analysis 事实。

### 12.5 污染控制

任务必须记录公开时间、仓库 commit、许可和可能的训练/benchmark 污染标签。Self-Evolution 的学习任务与 transfer 任务按 repository、issue family 和 solution artifact 隔离，不能把同一修复的轻微改写当作跨任务迁移。

-----

## 13. Self-Evolution 主题协议

Self-Evolution 研究的单位不是“是否生成了 memory/skill”，而是候选知识从来源到未来使用的完整生命周期。

### 13.1 生命周期

```text
source evidence
  → eligibility
  → extraction attempt
  → candidate
  → deterministic safety scan
  → validation
  → governance decision
  → durable commit
  → visibility
  → recall / skill selection
  → actual use
  → future outcome
  → consolidation / aging / removal
```

不存在的阶段标为 `not_applicable`。没有证据的阶段标为 `unknown`，不能由邻近事件补齐。

### 13.2 实验分期

每个 case 分成互不混用的时期：

1. **Acquisition**：引擎处理学习任务并可能产生 candidate。
2. **Governance**：按 condition 自动、人工或禁止发布。
3. **Retention gap**：关闭 session；需要时重启进程，以验证 durable 状态。
4. **Transfer**：在 held-out task 中观察 recall/selection/use。
5. **Outcome**：确定性验证任务结果，并测量成本和新失败。
6. **Aging**：在多轮后检查重复、过期、错误和跨项目泄漏。

### 13.3 核心条件

DSH 和支持开关的引擎优先采用 within-engine ablation：

```text
feature-off
extract-only
extract-plus-governance
extract-plus-recall
full-lifecycle
```

不支持细粒度开关时，只报告实际可执行条件。禁止用 Observatory patch 给引擎补出原本不存在的 treatment。

### 13.4 关键指标

候选质量：precision、错误率、重复率、secret 命中率、治理拒绝原因。

使用漏斗：candidate → committed → visible → selected → used → verified helpful。

长期结果：repeat error、held-out success、time-to-correct-path、tool waste、token/cost、stale knowledge、cross-project leakage。

`useful_reuse / generated_candidates` 是重要效率指标，但必须与漏召回和错误知识率同时报告。

### 13.5 归因限制

“记忆被召回且任务成功”不等于“记忆导致成功”。强归因至少需要同 engine feature-off 或 recall-off 的随机化对照。只有时序和内容匹配时，报告使用 `associated_with`，不使用 `caused_by`。

-----

## 14. 指标、归因与报告规则

报告以研究问题组织，不按引擎堆功能清单。每个结论都携带结论等级和可定位的证据引用。

### 14.1 结论等级

| 等级 | 所需条件 | 可用措辞 |
|---|---|---|
| Descriptive | 完整运行证据 | “观察到”“未观察到” |
| Associational | 对齐任务和协变量，未随机化 | “相关”“同时出现” |
| Quasi-experimental | 预声明的 lineage、时间或匹配设计 | “估计影响”，并列限制 |
| Experimental | 随机化或可信受控消融 | “在此协议和样本中产生了估计效应” |

### 14.2 报告必须包含

- study、source lock、Raw snapshot、mapper、evaluator 和 rubric digest；
- condition、样本与 attempt 流程图；
- capture coverage、缺口和 observer contamination；
- 主指标、次指标、效应和区间；
- 失败模式与反例，而不只列平均收益；
- common-model 与 native-strength 的分开结果；
- 数据撤回、缺失和无法重建的影响；
- 可执行的 DSH 建议、拒绝建议或下一项实验。

### 14.3 禁止聚合

下列内容不得压成一个 Observatory 总分：task success、证据完整性、观察开销、安全、成本、长期迁移和代码复杂度。它们是独立决策轴，任何硬性否决项都不能被平均收益抵消。

-----

## 15. Non-Interference

Non-Interference 同时检查语义等价与资源开销。只比较最终文本不足以发现工具顺序、权限、workspace 或 memory 的污染。

### 15.1 ON/OFF 条件

在固定 provider replay 或确定性 mock 下比较 Observatory OFF 与 ON：

```text
provider request semantics
provider output
tool call identity and arguments
permission decision
workspace/index/HEAD mutation
memory and skill mutation
subagent graph
compaction point
durable session events
final output
```

原生事件中合法的 observer timestamp/id 差异从比较器中明确排除。其他差异必须有字段级解释；不能使用宽泛 normalizer 吞掉。

### 15.2 Observer contamination

以下任一情况使 attempt 标为 `observer_contaminated`：

- hook 修改输入或输出；
- hook 返回控制动作；
- collector 错误改变 Agent 分支或退出码；
- queue/spool 竞争改变超时、重试或并发顺序；
- 采集到禁止数据；
- Observatory ON/OFF 出现未解释的语义差异。

污染 attempt 保留用于诊断，但不得进入效果估计。

### 15.3 开销门限

Pilot 记录空载和压力条件下的 per-hook p50/p95/p99、Agent wall time、CPU、RSS、磁盘写入、spool 峰值和 dropped events。正式 Study Manifest 根据主题频率和任务时长预注册绝对与相对门限。

v2 的 `hot-path p95 < 500us`、`script hook p95 < 5ms`、`wall-time < 2%` 保留为初始工程目标，不在完成 Pilot 前作为普遍通过标准。

-----

## 16. DSH 接入和迁移决策

DSH 是全插件 Cordis harness。Observatory 接入优先使用已有 Session、Agent、tool、LLM、filesystem、subagent 和 telemetry 扩展点；没有证据表明扩展点不足时，不修改 agent loop。

### 16.1 DSH 采集规则

- 必须长期重放的事实使用新的 Session event，并遵守 released Session format 和两套 SDK 投影要求。
- 只在进程内有意义的观察使用 typed Agent/capability event。
- 模型可见输入必须可从 Session log 重建；Observatory 不能建立第二条隐藏 prompt 注入路径。
- Observatory 插件的注册和监听都是 effect，卸载时必须完整回收。
- process、filesystem 和 workspace 观察通过其拥有的服务完成，不直接绕过 configured provider 读取 host。
- 新能力必须包含 Service Definition、Provider 和 Consumer；不能只添加一个孤立 registry 或工具。

### 16.2 与 RC5.5.5 的关系

DSH 自我进化的 authority、memory、managed skill、review、curator 和 rollout 行为由以下文档拥有：

- [`RC5.5-交接稿.md`](RC5.5-交接稿.md)：当前接手状态；
- [`RC5.5-执行进度报告.md`](RC5.5-执行进度报告.md)：唯一实现进度台账；
- [`RC5.5-函数级规格总纲.md`](RC5.5-函数级规格总纲.md)：Phase DAG 和验收；
- [`RC5.5.5-第十一轮评审核验与处置.md`](RC5.5.5-第十一轮评审核验与处置.md)：当前设计处置。

Observatory 不把该设计计划描述成已实现功能。DSH condition 必须根据 Source Lock 的实际代码和进度生成 feature state。

### 16.3 迁移包

一个机制只有在以下材料齐全后才能进入 DSH feature design：

1. 机制定义和 exact source anchors；
2. Capture Coverage 与 Non-Interference 结果；
3. 至少一个受控 baseline 或充分说明为何只能做描述研究；
4. 收益、成本、安全和失败样本；
5. 对 DSH 现有 extension point 的映射；
6. model-visible/logging、Session format、SDK 和 snapshot 影响；
7. feature-off 回退路径和停止条件；
8. Accept、Reject 或 More Evidence 的明确裁定。

外部实现的文件格式、目录结构和默认自动写策略不作为迁移目标。迁移对象是经实验支持的机制及其约束。

-----

## 17. 分阶段实施计划

实施按“先否决基础设施，再扩展研究面”的顺序推进。任何阶段未达到出口条件时，不开始大规模 Adapter 开发。

### Phase A：Protocol and Storage Validation

不运行真实 Agent，使用合成 producer 验证：

- envelope parser、大小上限和 invalid cases；
- segment spool、ack、重发、重复、identity conflict；
- Sidecar crash/restart 和 bounded disk behavior；
- payload 先持久化、metadata 后提交；
- redaction、forensic isolation、retention/erasure；
- Raw snapshot 和两个 mapper 版本并存重建；
- hash checkpoint 和签名验证；
- heartbeat 消失、seq gap、drop 和异常退出分类。

出口：所有故障注入产生预期状态，且没有 silent loss。

### Phase B：三种接入形态

只选择最小样本验证 Adapter contract：

| 引擎 | 形态 | 目标 |
|---|---|---|
| mini-SWE-agent | wrapper | 最小 loop、provider/parser/environment 事实 |
| OpenCode | plugin/native event | plugin observer 与 durable event 对照 |
| Qwen Code | structured dual output + hook | 多 stream、background memory 和 sidecar health |

每个引擎只运行 Synthetic Coverage Suite 和少量 smoke tasks，不做优胜结论。

出口：三种形态均达到 C2，核心测试场景无污染，source rebase mismatch 能阻止正式运行。

### Phase C：Self-Evolution Pilot

首轮 cohort：Qwen Code、Gemini CLI、DSH 与各自可执行的 no-learning/feature-off condition。Hermes、Codex 和 MiMo 在 Adapter 达到 C3 后加入下一版 cohort，不阻塞首轮协议验证。

Pilot 目标是估计 candidate rate、错误/secret 风险、recall/use 漏斗、成本、方差和可行样本量。Pilot 结果不签发 DSH 自动迁移结论。

出口：冻结正式 study protocol、held-out 生成规则、样本量与主指标。

### Phase D：Confirmatory Themes

按主题独立推进：

- Self-Evolution confirmatory cohort；
- Compaction fidelity；
- Cline/DSH recovery safety；
- Goose/OpenCode/DSH protocol interop；
- Aider/DSH context efficiency。

每个主题都有独立 budget 和 stop decision。一个主题失败不阻塞其他主题，也不要求所有引擎常驻 Core Corpus。

-----

## 18. 验收矩阵

验收项是可执行的行为断言。正式实现需把每项映射到 owner、测试或运行产物。

| ID | 断言 |
|---|---|
| O01 | Raw 中不存在 mapper 生成的 semantic event、entity 或 causal link |
| O02 | 相同 stream identity 的 byte-equal 重发幂等，不同内容 fail-closed |
| O03 | Sidecar 在 payload durable 前不能提交引用它的 Raw event |
| O04 | Sidecar crash 后从 ack watermark 重发，不覆盖失败 attempt |
| O05 | Probe 队列满时 Agent 继续运行，drop 可由独立健康信号识别 |
| O06 | producer 与 heartbeat 同时消失时，区间状态为 unknown/evidence_incomplete |
| O07 | mapper v1/v2 可从同一 Raw snapshot 生成并存且可复核的 projection |
| O08 | Analysis 删除后可从 manifest 与 Raw snapshot 重建相同 digest |
| O09 | 未脱敏 credential fixture 不进入共享 CAS、Analysis 或 judge 输入 |
| O10 | 到期删除/密钥销毁使依赖报告显式变为 source_revoked |
| O11 | Source Lock blob mismatch 使 runner 拒绝正式 run |
| O12 | Observatory ON/OFF 比较覆盖 request、tool、workspace、session 和最终输出 |
| O13 | observer_contaminated attempt 不进入效果估计但仍保留诊断记录 |
| O14 | formal report 列出所有 assignment、attempt、排除与缺失原因 |
| O15 | common-model 和 native-strength 结果不能被同一 effect estimate 聚合 |
| O16 | `causal_estimate` 只能由登记的 Eval 方法创建 |
| O17 | no-learning baseline 作为 condition 登记，不伪装成 engine |
| O18 | Self-Evolution transfer task 与 acquisition artifact 按规则隔离 |
| O19 | DSH feature state 从 exact source 生成，不从 RC 计划文档推断已实现 |
| O20 | 每个迁移建议包含 extension point、回退、风险和 Accept/Reject/More Evidence |

-----

## 19. 版本、迁移与运维

Observatory 的每个数据解释组件都独立版本化。版本升级不能静默改变既有报告的含义。

### 19.1 版本对象

```text
envelope schema
source lock format
capture policy
redactor ruleset
Raw schema
object format
mapper
coverage suite
study protocol
task set
rubric
evaluator
report format
```

结构不兼容时提升 major。规则或映射变化创建新版本和新 Analysis/Eval run，不更新既有结果。

### 19.2 Raw migration

Raw schema migration 只允许：

- 添加不改变既有记录含义的字段或索引；
- 创建版本化 successor 并保留 predecessor；
- 记录逐批校验、行数、对象引用和 hash checkpoint 结果。

禁止原位重写 native payload 来“修正”旧映射。若脱敏缺陷需要删除内容，执行数据治理删除并标记依赖结果，而不是伪装成普通 migration。

### 19.3 Run 状态

```text
planned
running
completed
infrastructure_failed
evidence_incomplete
observer_contaminated
evidence_invalid
source_revoked
```

状态转换有 owner 和原因。重跑创建新 attempt；不得把失败 attempt 改写成成功。

### 19.4 最小运维视图

运维只需要优先回答：Sidecar 是否接收、spool 是否增长、是否丢事件、writer 是否落后、对象是否持久、哪个 run 被否决。机制效果和跨引擎对比不进入在线告警路径。

-----

## 20. 2026-09-21 发现基线

本节记录复审时可读取的候选锚点，便于后续生成 Source Lock；它不是正式实验的源码清单。复审实际解析了各仓库的 HEAD 并检查了下列路径，但长期文档不复制 commit id，runner 必须在每次正式运行前把 exact commit 和 blob digest 写入机器 manifest。

| 引擎 | 已检查的候选锚点 |
|---|---|
| Hermes Agent | hooks、memory 文档 |
| OpenAI Codex | `codex-rs/memories`、App Server 文档 |
| OpenCode | session runner |
| OpenHands Agent SDK | Agent Server 文档 |
| mini-SWE-agent | runner/model/environment 包装候选 |
| Qwen Code | memory、memory design、dual output 文档 |
| Gemini CLI | auto-memory 文档 |
| MiMo Code | builtin guide 中的 memory/dream/compose |
| Cline | checkpoint restore transaction 和 post-checkpoint commit guard |
| SWE-agent | `RunSingle` |
| Goose | architecture/ACP/MCP 文档 |
| Aider | RepoMap 文档 |

维护中的发现链接：

- [Qwen memory](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/memory.md)
- [Qwen memory design](https://github.com/QwenLM/qwen-code/blob/main/docs/design/auto-memory/memory-system.md)
- [Qwen dual output](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/dual-output.md)
- [Gemini CLI auto memory](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/auto-memory.md)
- [MiMo Code repository](https://github.com/XiaomiMiMo/MiMo-Code)
- [Cline repository](https://github.com/cline/cline)
- [Codex memories](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md)
- [OpenCode repository](https://github.com/anomalyco/opencode)

这些浮动链接只支持发现和复核候选位置。未列出的 v2 功能描述仍处于 `claimed`，必须由后续 Source Lock 提升证据状态。

-----

## 21. 待决事项

以下选择必须在 Phase A 结束前确定，且一旦进入正式 Study 就冻结：

1. 本地 IPC 使用 Unix domain socket、named pipe 还是跨平台抽象；
2. segment 格式、单段大小、磁盘上限和回收顺序；
3. forensic vault 是否在首个 Pilot 启用；
4. Raw PostgreSQL 与对象库的备份、恢复点和删除协调方式；
5. batch root 的签名密钥 owner 与外部 checkpoint 位置；
6. Analysis mapper 的实现语言和 deterministic runtime image；
7. 正式 Self-Evolution Study 的最小相关效应、样本量和人工标注预算。

这些事项不能由 Adapter 自行决定。决定后写入相应 manifest/schema owner，并为拒绝无效配置提供测试。

-----

## Dev Note

<details>
<summary>非权威工作备注</summary>

v2.1 暂不提供完整 PostgreSQL DDL。先通过 Phase A 的故障注入固定身份、事务、删除和重建规则，再由 migration 文件拥有物理列、索引、分区和外键；把试验性 DDL 长期复制在架构文档中会形成第二份权威。

v2 中的全部 Theme 和逐引擎 Adapter 观察点保留为候选调查清单。后续只把达到 `located` 或更高状态的条目搬入机器可读 Adapter Profile。

</details>
