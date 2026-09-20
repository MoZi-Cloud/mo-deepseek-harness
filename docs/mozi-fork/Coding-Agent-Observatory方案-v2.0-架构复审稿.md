# Coding-Agent-Observatory 方案 v2.0
## 多引擎分主题取证 / 可重放证据图 / Sidecar-First / fork-DSH 实证迁移总案

> 状态：架构复审稿 / 可进入实现分解
>
> 日期：2026-09-21
>
> 前身：`Coding-Agent-Observatory方案.md`（总体设计 v1，2026-09-02）
>
> 目标系统：fork-DSH
>
> 数据库：`agent_observatory`
>
> 核心方法：**Source Proof → Runtime Proof → Evidence Integrity → Theme Analysis → Same-task A/B → DSH Gap Audit → Feature Worktree → Re-run → Accept/Reject**
>
> 第一战略主题：**Self-Evolution / Memory / Skill / Historical Learning**
>
> 本版核心变更：**固定五样本 → Engine Registry + Theme Cohort；宽 `raw.event` → Event/Span/Entity/Edge；DB-only blob → PG metadata + CAS；Adapter-heavy → Sidecar First + Native Hook + Surgical Fork；“没看到事件” → Capture Health + Feature State。**

---

# 0. 最终裁定

v1 的核心方法论仍然成立，尤其四条原则必须原封不动保留：

1. **Raw / Analysis / Eval 严格分层**：Raw 只记录“发生了什么”；Analysis 才解释机制；Eval 才判断效果。推断不得回写 Raw。
2. **源码版本、Adapter 版本、实验配置必须固定**：所有结论必须能回到 exact commit、capture policy、task、模型、运行环境。
3. **保留 engine-native evidence**：Canonical schema 是解释层，不得成为唯一事实层。原始 native payload 必须长期保存，允许未来重映射。
4. **Observatory 必须 Non-Interference**：打开观察系统不能改变 provider request、tool call、workspace mutation、memory/skill 结果、subagent 调度和最终输出。

但 v1 有四个已经必须修正的结构问题：

- **样本集固定为五个 Agent**，导致后续优秀开源 Agent 只能“加章节”，不能自然进入实验设计；
- **`raw.event` 过宽**，把 `memory_job_id / review_id / checkpoint_id / compaction_id ...` 都变成固定列，加入新机制会产生大量 nullable column 和频繁 migration；
- **Adapter 职责过重**，容易让每个 fork 同时承担采集、canonicalization、持久化、错误恢复；
- **缺少 Observatory 自身可观测性**，无法严格区分“机制没有发生”和“探针漏了”。

v2 的目标不是“观察更多 Agent”，而是建立一个长期不怕 Agent 数量、机制名称、源码目录变化的**实验取证基础设施**。

---

# 1. v2 的研究对象不再是“Agent 排行”，而是机制

Observatory 不负责回答“哪个 Coding Agent 天下第一”，而负责回答：

> 某个具体机制在什么条件下产生收益，它的成本、失败模式、可迁移部分是什么？

第一版 Theme：

```text
T01 self_evolution
T02 memory_write
T03 memory_recall
T04 memory_consolidation
T05 skill_generation
T06 skill_reuse
T07 compaction_context_fidelity
T08 checkpoint_recovery
T09 subagent_workspace_isolation
T10 tool_permission_approval
T11 protocol_interop
T12 repo_context_selection
T13 durable_session_replay
T14 goal_stop_judging
T15 evaluation_harness
T16 minimal_agent_complexity
T17 memory_secret_safety
```

每个 Theme 有自己的 cohort，不再要求所有 engine × 所有 task 全排列。

---

# 2. Engine Registry 与样本分层

## 2.1 Core Corpus

```text
DSH
Hermes Agent
OpenAI Codex
OpenCode
OpenHands
mini-SWE-agent
```

## 2.2 P0 新增样本

### Qwen Code

必须进入。研究价值：

```text
Auto Memory
Extract
Dream
Recall
Forget
Auto Skill
Skill Review / Curator
Team Memory
SubAgents / Agent Teams
Hooks
Telemetry
Dual Output JSON event stream
```

### Gemini CLI

必须进入 Self-Evolution cohort。研究价值：

```text
historical transcript mining
background extraction
memory patch candidate
SKILL.md candidate
review inbox
human apply/reject/promote
hook lifecycle
tool policy
```

### MiMo Code

必须进入 Self-Evolution cohort。它建立在 OpenCode 血缘上，又加入：

```text
persistent memory
history search
/dream
/distill
goal / stop judge
compose workflows
subagent orchestration
```

因此 `OpenCode → MiMo Code` 是极其宝贵的 lineage experiment。

## 2.3 P1 / P2 候选

```text
P1 Cline      — checkpoint/recovery、typed runtime hooks
P1 SWE-agent  — 实验 harness、trajectory、environment lifecycle
P1 Goose      — ACP/MCP、Agent interoperability
P2 Aider      — RepoMap、context efficiency、git-centric loop
```

Roo Code 主仓库已在 2026-05-15 归档，不进入持续跟踪 Core Corpus，只保留在机制历史库。

---

# 3. Theme Cohort

## 3.1 Self-Evolution Cohort

```text
DSH
Hermes
Codex
Qwen Code
Gemini CLI
MiMo Code
No-learning baseline
```

核心路线：

```text
Hermes = turn-level / post-turn background review
Codex  = historical rollout extraction + serialized global consolidation
Qwen   = incremental extract + dream + recall + forget + auto-skill
Gemini = historical extraction + proposal inbox + explicit approval
MiMo   = trajectory/history search + dream + distill
DSH    = durable history + governed mutation + provenance/replay
```

## 3.2 Compaction Cohort

```text
Codex
OpenCode
OpenHands
Qwen
Gemini
Aider
DSH
```

## 3.3 Recovery Cohort

```text
Hermes
Cline
DSH
MiMo
```

必须分别测：

```text
conversation rewind
workspace rewind
git ref safety
untracked file safety
post-checkpoint user commit safety
recovery latency
```

## 3.4 Protocol / Interop Cohort

```text
Goose
OpenCode
Cline
Codex App Server
DSH
```

---

# 4. 观察架构总图

```text
                      ┌─────────────────────────┐
                      │      Observed Agent     │
                      └────────────┬────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
   Native Observer Hook     Surgical Core Seam       Native Protocol
          │                        │                        │
          └──────────── native evidence envelope ──────────┘
                                   │
                              local IPC
                                   │
                      ┌────────────▼────────────┐
                      │ Observatory Sidecar     │
                      │ redact / correlate      │
                      │ capture health          │
                      │ spool / CAS             │
                      │ canonical mapping       │
                      └────────────┬────────────┘
                                   │
                      append-only durable spool
                                   │
               ┌───────────────────┴──────────────────┐
               │                                      │
        PostgreSQL metadata                       CAS/object store
        event/entity/span/edge                    large payload
               │                                      │
               └───────────────────┬──────────────────┘
                                   ▼
                         analysis / eval rebuild
                                   │
                                   ▼
                           DSH feature decision
```

---

# 5. Adapter 只“吐事实”

```text
Adapter != PostgreSQL writer
Adapter != canonicalizer
Adapter != AI analyzer
Adapter != evaluator
Adapter != retrying network client
```

Adapter 只能：

```text
native fact
→ native evidence envelope
→ local non-blocking transport
```

Sidecar 负责：

```text
correlation
redaction
capture-health accounting
blob/CAS
canonical mapping
hash chain
spool
database writer
coverage validation
```

---

# 6. Native Evidence Envelope v2

```json
{
  "schema": "observatory.native.v2",
  "run_id": "uuid",
  "engine": "qwen-code",
  "engine_revision": "git-sha",
  "process_instance_id": "uuid",
  "stream_id": "uuid",
  "capture_point": "memory.extract.finished",
  "capture_method": "native_hook",
  "source_observed_at": "2026-09-21T00:00:00Z",
  "monotonic_ns": 123456789,
  "native_event_type": "qwen-code.memory.extract",
  "native_ids": {
    "session": "...",
    "agent": "...",
    "tool_call": "..."
  },
  "payload": {}
}
```

不要把下面这些写死成顶级 schema：

```text
memory_job_id
skill_revision_id
dream_id
distill_id
review_id
checkpoint_id
approval_id
agent_team_id
workflow_id
```

它们进入 `raw.entity`。

---

# 7. PostgreSQL v2：Registry

```sql
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS analysis;
CREATE SCHEMA IF NOT EXISTS eval;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE raw.engine (
    engine_id          text PRIMARY KEY,
    display_name       text NOT NULL,
    upstream_repo      text,
    primary_language   text,
    lineage_parent     text REFERENCES raw.engine(engine_id),
    active             boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE raw.engine_revision (
    engine_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engine_id          text NOT NULL REFERENCES raw.engine(engine_id),
    upstream_commit    char(40) NOT NULL,
    fork_commit        char(40),
    branch             text,
    git_dirty          boolean NOT NULL,
    dirty_diff_sha256  bytea,
    dependency_digest  bytea,
    runtime_digest     bytea,
    source_manifest_ref bytea,
    captured_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(engine_id, upstream_commit, fork_commit, dirty_diff_sha256)
);

CREATE TABLE raw.adapter_revision (
    adapter_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engine_id           text NOT NULL REFERENCES raw.engine(engine_id),
    adapter_commit      char(40) NOT NULL,
    adapter_version     text NOT NULL,
    envelope_version    integer NOT NULL,
    capture_policy_sha256 bytea NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
```

---

# 8. Theme / Cohort / Experiment

```sql
CREATE TABLE raw.theme (
    theme_id           text PRIMARY KEY,
    title              text NOT NULL,
    description        text NOT NULL,
    enabled            boolean NOT NULL DEFAULT true
);

CREATE TABLE raw.cohort (
    cohort_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    theme_id           text NOT NULL REFERENCES raw.theme(theme_id),
    name               text NOT NULL,
    version            integer NOT NULL,
    rationale          text,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(theme_id, name, version)
);

CREATE TABLE raw.cohort_member (
    cohort_id          uuid NOT NULL REFERENCES raw.cohort(cohort_id),
    engine_id          text NOT NULL REFERENCES raw.engine(engine_id),
    role               text NOT NULL,
    PRIMARY KEY(cohort_id, engine_id)
);

CREATE TABLE raw.experiment (
    experiment_id      uuid PRIMARY KEY,
    cohort_id          uuid NOT NULL REFERENCES raw.cohort(cohort_id),
    name               text NOT NULL,
    task_set_version   text NOT NULL,
    prompt_set_version text NOT NULL,
    comparison_lane    text NOT NULL,
    benchmark_policy_sha256 bytea NOT NULL,
    environment_sha256 bytea NOT NULL,
    model_policy_json  jsonb NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
```

---

# 9. Run / Process / Stream

```sql
CREATE TABLE raw.run (
    run_id              uuid PRIMARY KEY,
    experiment_id       uuid NOT NULL REFERENCES raw.experiment(experiment_id),
    engine_revision_id  uuid NOT NULL REFERENCES raw.engine_revision(engine_revision_id),
    adapter_revision_id uuid NOT NULL REFERENCES raw.adapter_revision(adapter_revision_id),
    task_id              text,
    native_session_id    text,
    started_at           timestamptz NOT NULL,
    cwd_hash             bytea,
    effective_config_sha256 bytea,
    initial_workspace_sha256 bytea,
    initial_context_sha256 bytea,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE raw.process_instance (
    process_instance_id uuid PRIMARY KEY,
    run_id              uuid NOT NULL REFERENCES raw.run(run_id),
    parent_process_id   uuid REFERENCES raw.process_instance(process_instance_id),
    process_role        text NOT NULL,
    pid                 integer,
    executable_digest   bytea,
    argv_digest         bytea,
    env_digest          bytea,
    started_at          timestamptz,
    ended_at            timestamptz,
    attributes          jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE raw.capture_stream (
    stream_id           uuid PRIMARY KEY,
    run_id              uuid NOT NULL REFERENCES raw.run(run_id),
    process_instance_id uuid REFERENCES raw.process_instance(process_instance_id),
    stream_kind         text NOT NULL,
    native_stream_id    text,
    started_at          timestamptz NOT NULL,
    attributes          jsonb NOT NULL DEFAULT '{}'
);
```

---

# 10. Capture Point：解决源码路径漂移

```sql
CREATE TABLE raw.capture_point (
    capture_point_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    engine_revision_id  uuid NOT NULL REFERENCES raw.engine_revision(engine_revision_id),
    semantic_seam       text NOT NULL,
    capture_method      text NOT NULL,
    source_file         text,
    source_symbol       text,
    source_line_hint    integer,
    patch_digest        bytea,
    source_evidence_sha256 bytea,
    expected_cardinality text,
    enabled             boolean NOT NULL DEFAULT true,
    UNIQUE(engine_revision_id, semantic_seam, capture_method, source_symbol)
);
```

本文以 `›` 分隔上游仓库中的目录，避免把这些路径误解为 DSH 本地文件。例如 OpenCode 从 `packages › opencode › src › session › llm.ts` 迁到 `packages › core › src › session › runner › llm.ts`，Analysis 仍查询：

```text
semantic_seam = llm.provider_turn
```

---

# 11. Feature State

能力存在 ≠ 配置存在 ≠ 启用 ≠ 触发 ≠ 成功。

```sql
CREATE TABLE raw.feature_state (
    feature_state_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id             uuid NOT NULL REFERENCES raw.run(run_id),
    feature_name       text NOT NULL,
    available          boolean NOT NULL,
    configured         boolean,
    enabled            boolean,
    triggered          boolean,
    completed          boolean,
    config_digest      bytea,
    observed_trigger_count bigint NOT NULL DEFAULT 0,
    evidence_event_id  uuid,
    attributes         jsonb NOT NULL DEFAULT '{}',
    UNIQUE(run_id, feature_name)
);
```

---

# 12. Entity / Span / Event / Edge

```sql
CREATE TABLE raw.entity (
    entity_id          uuid PRIMARY KEY,
    run_id             uuid NOT NULL REFERENCES raw.run(run_id),
    entity_kind        text NOT NULL,
    native_id          text,
    native_scope       text,
    created_by_event   uuid,
    attributes         jsonb NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX raw_entity_native_idx
ON raw.entity(run_id, entity_kind, native_scope, native_id)
WHERE native_id IS NOT NULL;

CREATE TABLE raw.span (
    span_id            uuid PRIMARY KEY,
    run_id             uuid NOT NULL REFERENCES raw.run(run_id),
    parent_span_id     uuid REFERENCES raw.span(span_id),
    span_kind          text NOT NULL,
    semantic_name      text NOT NULL,
    native_name        text,
    start_event_id     uuid,
    end_event_id       uuid,
    started_at         timestamptz,
    ended_at           timestamptz,
    status             text,
    attributes         jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE raw.event (
    event_id             uuid PRIMARY KEY,
    run_id               uuid NOT NULL REFERENCES raw.run(run_id),
    stream_id            uuid NOT NULL REFERENCES raw.capture_stream(stream_id),
    span_id              uuid REFERENCES raw.span(span_id),
    seq                  bigint NOT NULL CHECK(seq > 0),
    source_observed_at   timestamptz,
    collector_received_at timestamptz NOT NULL,
    monotonic_ns         bigint,
    semantic_name        text NOT NULL,
    native_name          text,
    source_layer         text NOT NULL,
    evidence_class       text NOT NULL,
    schema_version       integer NOT NULL,
    capture_point_id     uuid REFERENCES raw.capture_point(capture_point_id),
    native_payload_ref   bytea,
    canonical_payload_ref bytea,
    attributes           jsonb NOT NULL DEFAULT '{}',
    prev_event_hash      bytea,
    event_hash           bytea NOT NULL,
    UNIQUE(stream_id, seq)
);

CREATE TABLE raw.event_entity (
    event_id            uuid NOT NULL REFERENCES raw.event(event_id),
    entity_id           uuid NOT NULL REFERENCES raw.entity(entity_id),
    role                text NOT NULL,
    PRIMARY KEY(event_id, entity_id, role)
);

CREATE TABLE raw.entity_edge (
    edge_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              uuid NOT NULL REFERENCES raw.run(run_id),
    src_entity_id       uuid NOT NULL REFERENCES raw.entity(entity_id),
    dst_entity_id       uuid NOT NULL REFERENCES raw.entity(entity_id),
    relation            text NOT NULL,
    evidence_event_id   uuid REFERENCES raw.event(event_id),
    attributes          jsonb NOT NULL DEFAULT '{}'
);
```

关系例：

```text
spawned
caused_by
derived_from
extracted_from
consolidated_from
recalled_into
mutated
supersedes
approved_by
rejected_by
generated_skill
restored_from
executed_by
```

---

# 13. Artifact / CAS

```sql
CREATE TABLE raw.artifact (
    artifact_id         uuid PRIMARY KEY,
    run_id              uuid NOT NULL REFERENCES raw.run(run_id),
    artifact_kind       text NOT NULL,
    logical_name        text NOT NULL,
    engine_native_name  text,
    attributes          jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE raw.artifact_version (
    artifact_version_id uuid PRIMARY KEY,
    artifact_id         uuid NOT NULL REFERENCES raw.artifact(artifact_id),
    event_id            uuid NOT NULL REFERENCES raw.event(event_id),
    phase               text NOT NULL,
    exists_flag         boolean NOT NULL,
    content_sha256      bytea,
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE raw.object_ref (
    content_sha256      bytea PRIMARY KEY,
    media_type          text NOT NULL,
    original_size       bigint NOT NULL,
    stored_size         bigint NOT NULL,
    compression         text NOT NULL,
    encryption          text NOT NULL,
    key_id              text,
    storage_backend     text NOT NULL,
    storage_locator     text,
    storage_sha256      bytea NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
```

建议：

```text
< 64 KiB  → inline 可选
>=64 KiB  → filesystem CAS / S3-compatible object store
```

---

# 14. Protocol Frame

```sql
CREATE TABLE raw.protocol_frame (
    frame_id            uuid PRIMARY KEY,
    run_id              uuid NOT NULL REFERENCES raw.run(run_id),
    process_instance_id uuid REFERENCES raw.process_instance(process_instance_id),
    protocol            text NOT NULL,
    direction           text NOT NULL,
    transport           text,
    connection_id       text,
    request_id          text,
    method              text,
    frame_kind          text,
    payload_ref         bytea,
    observed_at         timestamptz NOT NULL,
    event_id            uuid REFERENCES raw.event(event_id)
);
```

适用：

```text
Codex App Server
Goose ACP
MCP
OpenHands Agent Server
Qwen dual-output reverse channel
```

---

# 15. Capture Health：Observatory 必须审计自己

```sql
CREATE TABLE raw.capture_health (
    health_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              uuid NOT NULL REFERENCES raw.run(run_id),
    stream_id           uuid REFERENCES raw.capture_stream(stream_id),
    interval_start      timestamptz NOT NULL,
    interval_end        timestamptz NOT NULL,
    events_observed     bigint NOT NULL,
    events_dropped      bigint NOT NULL DEFAULT 0,
    queue_high_water    bigint,
    spool_bytes         bigint,
    writer_lag_ms_p95   bigint,
    last_good_seq       bigint,
    gap_detected        boolean NOT NULL DEFAULT false,
    gap_reason          text,
    attributes          jsonb NOT NULL DEFAULT '{}'
);
```

正式分析规则：

```text
absence of event + capture_health clean
→ 才允许解释为“机制未发生”
```

若 `gap_detected=true`，只能得出 `evidence_incomplete`。

---

# 16. Observer Intervention

```sql
CREATE TABLE raw.observer_intervention (
    intervention_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id             uuid NOT NULL REFERENCES raw.run(run_id),
    event_id           uuid REFERENCES raw.event(event_id),
    hook_name          text NOT NULL,
    latency_us         bigint,
    mutated_input      boolean NOT NULL DEFAULT false,
    mutated_output     boolean NOT NULL DEFAULT false,
    returned_control   boolean NOT NULL DEFAULT false,
    control_action     text,
    attributes         jsonb NOT NULL DEFAULT '{}'
);
```

正式 benchmark gate：

```text
mutated_input    = false
mutated_output   = false
returned_control = false
```

否则 run 标 `observer_contaminated`。

---

# 17. Deterministic Redaction

正确路径：

```text
raw local source
      ↓
deterministic credential / secret scanner
      ↓
encrypted forensic raw copy
      ↓
redacted projection
      ↓
analysis model / memory extraction
```

不能只依赖“让模型不要记 secret”。

---

# 18. Non-Interference v2

Agent 内部探针只能：

```text
allocate tiny envelope
write non-blocking local queue
return
```

不得：

```text
connect PostgreSQL
HTTP upload
wait on sidecar
LLM analyze
canonicalize large payload
compress large blob synchronously
```

## 18.1 ON/OFF Gate

固定 provider replay/mock：

```text
Observatory OFF
vs
Observatory ON
```

要求：

```text
same semantic provider requests
same provider outputs
same tool calls
same tool args
same permission decisions
same workspace mutations
same memory/skill mutations
same subagent graph
same compaction points
same final output
```

## 18.2 Performance Gate

记录：

```text
p50/p95 per-hook latency
agent wall time delta
CPU delta
RSS delta
disk write delta
```

建议目标：

```text
hot-path hook p95 < 500us
sync script hook p95 < 5ms
agent wall-time overhead < 2%
```

---

# 19. Probe 优先级

```text
Level 0: existing export / protocol / log
Level 1: native observer hook
Level 2: wrapper / subclass
Level 3: one-line surgical seam
Level 4: invasive fork
```

原则：能用 Level 0/1 证明的事实，禁止先用 Level 4。

---

# 20. Hermes Adapter v2

## 20.1 优先 Observer Hooks

当前 Hermes 已有：

```text
pre_api_request
post_api_request
api_request_error
post_tool_call
post_llm_call
on_stream_start/delta/end
on_session_start/end/finalize/reset
on_skill_lifecycle
subagent_start/subagent_stop
pre_approval_request/post_approval_response
kanban lifecycle
```

request observer 还带：

```text
session_id
turn_id
task_id
api_request_id
api_call_count
```

因此 provider/tool/session 主取证不再需要大面积 patch。

## 20.2 Surgical Fork

只补：

```text
background_review.py
memory authoritative commit
skill candidate / ledger authoritative commit
checkpoint create/restore
context compressor decision
```

DSH 应重点学习：

```text
turn-local fast learning
consent-aware writes
background review isolation
observer-grade correlation IDs
skill lifecycle telemetry
```

---

# 21. Codex Adapter v2

## 21.1 Protocol First

App Server / protocol 镜像：

```text
request
response
notification
thread
turn
approval
review
compaction
```

所有 frame 原样进入 `raw.protocol_frame`。

## 21.2 Core Memory

当前 memory runtime orchestration 位于：

```text
codex-rs/core/src/memories/
```

可重用 crate：

```text
codex-rs/memories/read
codex-rs/memories/write
```

Phase 1 抓：

```text
scan
claim
load rollout
filter evidence
render extraction prompt
model attempt
raw_memory
rollout_summary
persist
lease settlement
```

Phase 2 抓：

```text
global lock claim
input selection
workspace before
consolidation prompt
model attempt
workspace diff
MEMORY.md
memory_summary.md
skills/*
commit
lock release
```

DSH 应重点学习：

```text
parallel historical extraction
lease semantics
serialized global consolidation
read/write pipeline separation
memory citation / read-usage telemetry
```

---

# 22. OpenCode Adapter v2

## 22.1 Plugin First

Plugin 可观察：

```text
event
chat.message
chat.params
tool.execute.before
tool.execute.after
permission.ask
command.execute.before
shell.env
experimental.session.compacting
```

Observatory plugin 只记录，绝不能修改 output。

## 22.2 V2 Provider Seam

当前核心 seam：

```text
packages › core › src › session › runner › llm.ts
```

它集中负责：

```text
projected V2 history
llm.stream(request)
assistant text
reasoning
usage
provider error
durable tool call
tool settlement
continuation
```

surgical seam：

```text
before llm.stream(request)
after each provider semantic event
before durable local tool side effect
after tool settlement
```

## 22.3 Compaction

V2 compaction 已明确区分：

```text
full durable history
!=
active model representation
```

DSH 应重点学习：

```text
typed core
durable event projection
plugin policy boundary
durable tool-call-before-side-effect
active-context vs full-history separation
```

---

# 23. OpenHands Adapter v2

优先零 fork：

```text
EventLog
Agent Server event stream
events.jsonl / API
LLM completion logging
OpenTelemetry
```

只在要研究内部 decision 时补：

```text
prepared View
Agent step
CondenserBase.condense(view)
parallel tool scheduling
```

DSH 应重点学习：

```text
event-driven state
runtime/workspace abstraction
read-only condenser boundary
parallel tool execution
server/client separation
```

---

# 24. mini-SWE-agent Adapter v2

包裹：

```text
DefaultAgent.run
DefaultAgent.step
DefaultAgent.query
DefaultAgent.execute_actions
DefaultAgent.save
Model.query
Environment.execute
```

特别抓：

```text
provider raw response
→ parser
→ FormatError
```

避免“已经花钱但 message 未 append”时证据消失。

---

# 25. Qwen Code Adapter

这是 v2 第一优先新增。

## 25.1 Level 0：Dual Output

先完全不 fork：

```text
--json-fd
--json-file
--input-file
```

建议：

```text
Qwen TUI
   │
   ├─ JSONL event FIFO ─→ sidecar
   └─ normal stdout
```

Sidecar 必须记录：

```text
consumer connected/disconnected
FIFO overflow
output bridge disabled
last emitted seq
session_end observed?
```

## 25.2 Level 1：Hooks

重点：

```text
InstructionsLoaded
UserPromptSubmit
PreToolUse
PostToolUse
SessionStart
SessionEnd
Subagent lifecycle
```

正式 benchmark 中，hook 必须返回 neutral response。

## 25.3 Level 1：Telemetry

已有：

```text
qwen-code.memory.extract
qwen-code.memory.dream
qwen-code.memory.recall
```

用于 trigger/duration cross-check。

## 25.4 Level 3：Auto Memory Surgical Seams

当前源码索引：

```text
packages › core › src › memory › extract.ts
    runAutoMemoryExtract

packages › core › src › memory › extractionAgentPlanner.ts
    runAutoMemoryExtractionByAgent

packages › core › src › memory › dream.ts
    runManagedAutoMemoryDream

packages › core › src › memory › dreamAgentPlanner.ts
    planManagedAutoMemoryDreamByAgent

packages › core › src › memory › recall.ts
    resolveRelevantAutoMemoryPromptForQuery

packages › core › src › memory › forget.ts
    forgetManagedAutoMemoryEntries
```

### Extract 必抓

```text
cursor before
history slice identity
eligible user-message count
extraction-agent input
agent route/model
touched topics
patches
metadata before/after
index before/after
cursor after
```

### Dream 必抓

```text
trigger
lock
candidate docs
dedup
cleanup
agent plan
mechanical operations
topic freshness before/after
```

### Recall 必抓

```text
query
docs scanned
heuristic selection
model selection if used
selected docs
injected prompt
future task outcome
```

### Forget 必抓

```text
candidate
reason
exact delete set
future retrieval impact
```

### Auto Skill 必抓

```text
tool-heavy session eligibility
review input
candidate generated
confirmation
skill persisted
skill first load
skill successful reuse
stale transition
```

DSH 应重点学习：

```text
incremental cursor extraction
Dream consolidation
explicit recall subsystem
forget lifecycle
memory freshness
Auto Skill lifecycle
team memory tier
```

---

# 26. Gemini CLI Adapter

## 26.1 Hooks First

Observatory hook：

```text
stdin JSON
→ append local spool
→ return neutral JSON
```

禁止 DB / HTTP blocking。

## 26.2 Auto Memory

当前路径：

```text
session transcript
→ eligibility scan
→ project lock
→ extraction agent
→ memory .patch / SKILL.md candidate
→ inbox
→ human approve/reject/promote
```

与 Qwen 形成清晰对照：

```text
Qwen   = 自动记忆/整理较主动
Gemini = 自动发现候选，但 active state 前必须审阅
```

## 26.3 Surgical Seams

重点：

```text
packages › core › src › agents › skill-extraction-agent.ts
packages › core › src › services › memoryService.ts
```

必须抓：

```text
eligible transcript set
idle/length eligibility
lock claim
input excerpts
pre-model deterministic redaction result
candidate memory patch
candidate skill
patch validation
inbox persist
user decision
active memory mutation
```

## 26.4 安全实验

```text
raw transcript contains fake credential
→ 是否在进模型前 deterministic scrub
→ candidate 是否包含
→ log 是否泄漏
```

DSH 必须采用 deterministic scrub before LLM extraction。

DSH 应重点学习：

```text
proposal inbox
human governed promotion
patch validation
eligibility throttling
cross-session extraction lock
```

---

# 27. MiMo Code Adapter

MiMo 最大价值之一：`OpenCode lineage control`。

必须抓：

```text
persistent memory
history
checkpoint
dream
distill
goal judge
compose
workflow
```

## 27.1 Dream

```text
scan recent session traces
→ promote durable knowledge
→ MEMORY.md
→ prune stale entries
```

抓：

```text
auto/manual trigger
history query
selected trajectory windows
dream subagent input
memory before
memory after
deleted stale entries
```

## 27.2 Distill

```text
repeated manual workflow
→ high-confidence candidate
→ skill / subagent / command
```

抓：

```text
candidate evidence sessions
frequency/confidence
generated artifact type
persisted location
future invocation
future success
```

DSH 应重点学习：

```text
history searchable substrate
dream/distill 分工
knowledge → procedure conversion
goal/stop judge
deterministic workflow orchestration
```

---

# 28. Cline Adapter

## 28.1 Runtime Hooks

优先：

```text
beforeRun
afterRun
beforeModel
afterModel
beforeTool
afterTool
onEvent
```

全部作为 observer。

## 28.2 Checkpoint Restore

当前源码有：

```text
beginWorktreeRestoreTransaction()
commit()
rollback()
createCheckpointRestorePlan()
applyCheckpointToWorktree()
```

必须抓：

```text
pre-restore HEAD
checkpoint ref
pre-restore dirty/untracked set
private restore ref
reset target
post-restore HEAD
post-restore reachability
message rewind target
commit()
rollback()
```

不能只问“restore 是否返回 success”，必须问：

```text
pre-existing user commits still reachable?
branch tip changed?
untracked files restored?
ignored files touched?
conversation and workspace aligned?
```

DSH 应重点学习：

```text
restore transaction
private recovery refs
message/workspace separate restore plan
typed runtime interception
```

同时 DSH 必须增加 post-checkpoint commit protection。

---

# 29. SWE-agent Adapter

完整 SWE-agent 不替代 mini-SWE。

`RunSingle` 已接受 `RunHook`，`SWEEnv.add_hook()` 提供 environment lifecycle interception。

Observatory 用它验证：

```text
fixture reproducibility
environment cleanliness
task packaging
trajectory output
patch artifact
evaluation harness
```

DSH 应重点学习实验工程纪律，而不是产品功能。

---

# 30. Goose Adapter

Goose 重点是协议。

优先完全不 fork：

```text
ACP stdio mirror
MCP JSON-RPC mirror
extension lifecycle
provider exchange boundary
```

重点实体：

```text
acp_session
acp_request
mcp_server
mcp_tool
extension
provider_exchange
```

DSH 应重点学习：

```text
agent as ACP server
ACP agent as provider
MCP capability forwarding
extension/provider separation
```

---

# 31. Aider Adapter

重点：

```text
Coder.run
Coder.run_one
Coder.send_message
RepoMap generation
GitRepo.commit
lint/test reflection
```

必须记录：

```text
repo total files
RepoMap selected symbols
RepoMap token cost
in-chat files
read-only files
model request context allocation
files actually edited
wrong-file exploration count
reflections
commit
```

DSH 应重点学习：

```text
symbol-level repo context compression
git-first edit accounting
minimal mechanism baseline
```

---

# 32. 不同 Agent 最值得吸收什么

| Agent | DSH 首要学习对象 | 不应直接照搬 |
|---|---|---|
| Hermes | turn-local review、consent-aware learning、observer correlation | 单纯按 turn 自动写一切 |
| Codex | historical extraction + serialized consolidation + lease | 文件格式本身 |
| OpenCode | durable event/session、plugin boundary、tool-before-side-effect | 快速变化的物理目录结构 |
| OpenHands | EventLog、runtime abstraction、Condenser boundary | 全部 SDK layering |
| mini-SWE | 极简 loop 与复杂度控制 | 功能缺失本身 |
| Qwen Code | Extract/Dream/Recall/Forget、Auto Skill、freshness | 默认自动写策略直接复制 |
| Gemini CLI | candidate inbox、approval、patch validation | 仅靠 prompt 保护 secret |
| MiMo Code | history substrate、Dream/Distill、goal judge | 与 OpenCode 重复的表层 UI |
| Cline | checkpoint transaction、typed hook | destructive reset 行为 |
| SWE-agent | reproducible harness | 产品体验 |
| Goose | ACP/MCP interoperability | 非 DSH 核心的 extension complexity |
| Aider | RepoMap/context efficiency | 极简结构限制 |

---

# 33. Self-Evolution 统一生命周期

```text
Evidence
   ↓
Eligibility
   ↓
Extraction
   ↓
Candidate
   ↓
Validation
   ↓
Governance
   ↓
Commit
   ↓
Visibility
   ↓
Recall / Skill Selection
   ↓
Use
   ↓
Outcome
   ↓
Consolidate / Age / Forget
```

不是每个 Agent 都有每一阶段；不存在的阶段标 `N/A`，绝不能伪造。

---

# 34. Self-Evolution 关键实体与边

实体：

```text
learning_source
learning_job
candidate
governance_decision
memory_entry
skill_revision
recall_decision
usage
outcome
consolidation
aging_action
```

关键 edge：

```text
candidate extracted_from source
memory_entry promoted_from candidate
skill_revision generated_from candidate
recall selected memory_entry
task used skill_revision
outcome caused_by usage
consolidation merged memory_entry
aging_action removed memory_entry
```

这样可以回答：

> 某条记忆来自哪次错误修复，什么时候被召回，是否真的帮助了未来任务？

---

# 35. Self-Evolution 指标

Memory：

```text
candidate precision
candidate recall（抽样标注）
incorrect-memory rate
duplicate rate
stale rate
recall precision
recall token cost
future task reuse
future error avoidance
cross-task transfer
cross-project leakage
```

Skill：

```text
candidate generated
approved/persisted
discovered
invoked
completed successfully
reduced tool calls
reduced wall time
reduced failure
stale / retired
```

最重要的比值之一：

```text
useful_reuse / generated_candidates
```

否则系统可能只是很会产生垃圾知识。

---

# 36. Context / Compaction 统一实验

必须保存：

```text
full durable history
model-visible request
compaction selection
summary
recent context
post-compaction request
future task result
```

指标：

```text
critical evidence retention
token savings
signature/provider compatibility
wrong assumption after compaction
re-read tool calls
time-to-recover-lost-context
```

---

# 37. Workspace Evidence

sidecar 独立抓：

```text
git HEAD
branch
index digest
tracked dirty set
untracked set
deleted set
worktree list
```

snapshot 边界：

```text
run start
before destructive tool
after write/edit tool
before checkpoint
after checkpoint
before restore
after restore
task end
```

---

# 38. 外挂 Sidecar 进程级观察

允许：

```text
process tree
exit status
stdout/stderr digest
CPU
RSS
open file count
network endpoint class
disk spool size
```

默认不做：

```text
ptrace
memory dump
TLS MITM
credential capture
```

高侵入取证必须单独实验 lane。

---

# 39. Hook 与外挂职责边界

Hook 最擅长：

```text
semantic identity
prepared request
tool identity
memory candidate
governance decision
internal trigger reason
```

Sidecar 最擅长：

```text
protocol
process
filesystem
git
timing
capture health
spool durability
```

Artifact probe 最擅长：

```text
SQLite
JSONL
MEMORY.md
SKILL.md
checkpoint files
trajectory
session transcript
```

理想证据是三路交叉：

```text
Hook says committed
+
artifact diff exists
+
future session actually sees it
```

---

# 40. Surgical Fork 规范

每个 patch 必须：

```text
one semantic seam
read-only
no control-flow branch based on collector
no network
no DB
no exception propagation
```

标准模板：

```text
capture_before(...)
original_call(...)
capture_after(...)
```

`capture_*` 必须：

```text
best-effort
bounded allocation
non-blocking enqueue
drop-accounted
```

若 enqueue 满：Agent 继续，`events_dropped++`，并写 capture health gap。

---

# 41. Fork Patch Manifest

每个 fork patch 登记：

```text
patch_id
engine_revision
semantic_seam
source_symbol
before_source_digest
after_source_digest
patch_digest
expected_events
non_interference_test
```

upstream rebase 后 source digest mismatch：

```text
adapter invalid
→ 禁止直接跑正式 corpus
```

---

# 42. Synthetic Coverage Suite

最低场景：

```text
LLM success
LLM retry
LLM fatal error
tool success
tool failure
tool denied
workspace write
workspace delete
session end
abort
resume
```

能力存在时：

```text
compaction
subagent
memory extract
memory recall
memory consolidation
skill generate
skill reuse
checkpoint
restore
approval
MCP
ACP
```

每个 scenario 声明：

```text
expected semantic events
minimum count
allowed extra events
required entities
required edges
```

---

# 43. Capture Completeness

不用一个百分比分数掩盖关键缺失。

```text
C0 Broken
C1 Basic       task/llm/tool/result 可重建
C2 Stateful    workspace/session 可重建
C3 Advanced    高级机制可重建
C4 Forensic    provider attempt、artifact before/after、gap、native payload 完整
```

正式主题实验要求：

```text
Core mechanism >= C3
其余路径 >= C2
```

---

# 44. Experiment Lanes

同一个 engine 至少可能有：

```text
native_default
native_feature_on
native_feature_off
observatory_on
observatory_off
patched_probe
```

禁止把 feature on/off 与 Observatory on/off 混成一个变量。

---

# 45. Same-task A/B

优先固定：

```text
same task
same repo origin commit
same model
same reasoning effort
same max tokens
same tool policy
same timeout
same environment
```

无法同模型时，明确使用 `native-strength lane`，不得与 common-model lane 混写。

---

# 46. Lineage Experiment：OpenCode vs MiMo

尽可能固定：

```text
same upstream ancestry window
same model
same task
same tool policy
```

观察：

```text
OpenCode
vs MiMo feature-off
vs MiMo memory-only
vs MiMo dream
vs MiMo distill
```

这是判断 persistent learning feature 是否真实增益的高价值近似因果实验。

---

# 47. DSH Self-Evolution Ablation

```text
DSH-no-learning
DSH-extract-only
DSH-extract+governance
DSH-extract+consolidation
DSH-full
```

否则即使 DSH full 表现更好，也无法知道哪一层贡献收益。

---

# 48. 第一轮 v2 Pilot Corpus

## P0-A Collector Validation

```text
mini-SWE
OpenHands
OpenCode
Qwen
```

验证 wrapper / event-native / plugin-native / dual-output 四种形态。

## P0-B Self-Evolution

```text
Hermes
Codex
Qwen
Gemini
MiMo
DSH
baseline
```

建议：

```text
12–20 个高信息长任务
4–8 个跨 session follow-up
4 个错误纠正重复场景
```

## P1-C Recovery / Interop / Context

```text
Cline
Goose
SWE-agent
Aider
```

按 Theme 接入。

---

# 49. 第一轮必须产出的报告

```text
R1 Engine Registry & Source Lock
R2 Capture Coverage / Capture Health
R3 Self-Evolution Architecture Matrix
R4 Memory Candidate Precision / Governance
R5 Recall & Reuse Effectiveness
R6 Skill Generation → Real Reuse Funnel
R7 Compaction Fidelity
R8 Checkpoint / Restore Safety
R9 Tool / Permission / Observer Contamination
R10 Subagent / Workspace Isolation
R11 Context Efficiency / RepoMap
R12 Protocol Interop (MCP / ACP / App Server)
R13 Complexity-vs-Outcome
R14 DSH Gap Audit
R15 DSH Feature Ablation
```

---

# 50. 第一轮 DSH 候选迁移方向

## Learning Intake

```text
Hermes fast turn-level learning signal
+
Qwen incremental cursor extraction
+
Gemini candidate inbox / explicit governance
```

## Historical Consolidation

```text
Codex parallel historical extraction + serialized global consolidation
+
Qwen Dream dedup/aging
+
MiMo trajectory search + Dream
```

## Procedure Learning

```text
Qwen Auto Skill
+
MiMo Distill
+
DSH governed skill lineage
```

## Recall

```text
Qwen explicit recall strategy
+
MiMo searchable history
+
DSH provenance-aware ranking
```

## Recovery

```text
Hermes checkpoint ideas
+
Cline restore transaction
+
DSH durable session authority
```

但 DSH 必须增加 post-checkpoint commit protection。

---

# 51. DSH Self-Evolution 目标形态（待实证）

```text
durable event history
       ↓
incremental extraction jobs
       ↓
candidate graph
       ↓
deterministic secret scrub
       ↓
evidence-linked proposal
       ↓
governance policy
       ↓
memory / skill commit
       ↓
recall / skill selection
       ↓
usage telemetry
       ↓
outcome attribution
       ↓
periodic consolidation / aging
       ↓
replayable provenance
```

与 RC5.5.4 优势结合：

```text
authority
idempotency
durability
authorization
provenance
```

---

# 52. 实施顺序

```text
V2-O0 Schema & Envelope
V2-O1 Sidecar Core
V2-O2 mini-SWE Smoke Test
V2-O3 OpenHands
V2-O4 OpenCode
V2-O5 Qwen
V2-O6 Hermes
V2-O7 Codex
V2-O8 Gemini
V2-O9 MiMo
V2-P1 Cline / SWE-agent / Goose / Aider
```

Adapter 开发不是按知名度，而是按观测形态：

```text
wrapper-simple
→ event-native
→ plugin-native
→ structured dual-output
→ observer-rich
→ protocol+memory-complex
→ governance/background-complex
```

---

# 53. 每个 Adapter 的验收清单

```text
1. exact upstream SHA?
2. exact fork SHA?
3. capture point source symbol?
4. native payload retained?
5. provider attempt observable?
6. tool call/result observable?
7. workspace independently observable?
8. session end observable?
9. capture gap detectable?
10. ON/OFF non-interference passed?
11. collector crash fail-open?
12. formal theme coverage level?
```

高级能力存在时再验：

```text
compaction
memory write
memory recall
consolidation
skill generation
skill reuse
subagent
checkpoint/restore
```

---

# 54. 第一阶段不做什么

不做：

```text
统一所有 Agent 内部 API
给缺失机制的 Agent 补机制
第一轮就把十二 Agent 都改成 fork
把 AI judge 写入 Raw
抓 hidden chain-of-thought
```

只保存 provider 实际暴露的 reasoning blocks / summary / opaque replay items / stream deltas。

---

# 55. 版本冻结规则

每个 corpus 开始后：

```text
engine revision frozen
adapter revision frozen
schema major frozen
capture policy frozen
task set frozen
model policy frozen
```

发现 probe bug：

```text
停止对应 engine lane
→ 新 adapter revision
→ 重新 synthetic coverage
→ 新 run
```

禁止偷偷修 adapter 后继续往同一实验桶写。

---

# 56. Raw Schema Migration

Raw 必须：

```text
append-only
backward-readable
native payload retained
```

Canonical mapper 可以升级：

```text
analysis_mapping_v1
analysis_mapping_v2
```

同一批 Raw 允许重建不同版本 Analysis。

---

# 57. Observatory 自己也要版本化

至少版本化：

```text
sidecar
native envelope
canonical mapper
redactor
capture policy
coverage suite
analysis pipeline
eval rubric
```

任何结论必须携带：

```text
analysis_run_id
analyzer_version
mapping_version
eval_version
```

---

# 58. v2 最重要的三个先做项

## 1. Event / Entity / Edge / Capture Health schema

这是后续所有 Agent 可持续扩展的基础。

## 2. Qwen Code Adapter

原因：

```text
Auto Memory + Dream + Recall + Forget + Auto Skill
集中在同一开源实现
+
Dual Output / hooks / telemetry 允许零侵入起步
```

## 3. Self-Evolution Cohort

立即把：

```text
Hermes + Codex + DSH
```

扩展为：

```text
Hermes + Codex + Qwen + Gemini + MiMo + DSH + baseline
```

否则当前 Self-Evolution 结论存在明显样本偏差。

---

# 59. 北极星指标

```text
task success ↑
repeat error ↓
time-to-correct-path ↓
tool waste ↓
recovery time ↓
token/cost ↓

memory precision ↑
memory recall usefulness ↑
skill real reuse ↑
long-term transfer ↑

incorrect memory ↓
stale knowledge ↓
cross-project leakage ↓

observer overhead ↓
evidence completeness ↑
replayability ↑
```

同时不能牺牲：

```text
provenance
durability
authorization
security
non-interference
```

---

# 60. 当前源码证据索引（2026-09-21）

正式开工前仍需 pin exact SHA。

## Hermes Agent
- Hooks / Observer: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md
- Plugin hooks: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md
- Memory / background review: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md

## OpenAI Codex
- Memories: https://github.com/openai/codex/blob/main/codex-rs/memories/README.md
- App Server: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

## OpenCode
- Repository and source anchors: https://github.com/anomalyco/opencode
- V2 session spec: https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md

## OpenHands
- Agent Server / telemetry: https://github.com/openhands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/README.md

## Qwen Code
- Memory: https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/memory.md
- Memory design/source index: https://github.com/QwenLM/qwen-code/blob/main/docs/design/auto-memory/memory-system.md
- Hooks: https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md
- Telemetry: https://github.com/QwenLM/qwen-code/blob/main/docs/developers/development/telemetry.md
- Dual Output: https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/dual-output.md

## Gemini CLI
- Auto Memory: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/auto-memory.md
- Settings: https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md
- Auto Memory redaction issue/source anchors: https://github.com/google-gemini/gemini-cli/issues/26525

## MiMo Code
- Repository: https://github.com/XiaomiMiMo/MiMo-Code
- Repository and builtin docs: https://github.com/XiaomiMiMo/MiMo-Code

## Cline
- Repository, runtime hooks, and checkpoint restore: https://github.com/cline/cline
- Restore safety issue: https://github.com/cline/cline/issues/13550

## SWE-agent
- RunSingle / RunHook: https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/run/run_single.py
- Environment / EnvHook: https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/environment/swe_env.py

## Goose
- Architecture / ACP / MCP: https://github.com/aaif-goose/goose/blob/main/documentation/docs/goose-architecture/goose-architecture.md

## Aider
- RepoMap: https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md
- Coder loop: https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py
- Git commit: https://github.com/Aider-AI/aider/blob/main/aider/repo.py

---

# 61. 最终判断

`Coding-Agent-Observatory v1` 的“证据优先、不可篡改 Raw、Native Payload、Non-Interference、Same-task A/B”方向继续保留。

v2 正式替代这些 v1 假设：

```text
固定五 Agent
→ Registry + Cohort

raw.event 宽表
→ Event / Span / Entity / Edge

DB 存全部大对象
→ Metadata + CAS

Adapter 承担过多逻辑
→ Sidecar First

源码文件路径是长期锚点
→ semantic capture point + exact revision

没事件 = 没发生
→ feature_state + capture_health

Hermes/Codex 是主要 Self-Evolution 对照
→ Hermes/Codex/Qwen/Gemini/MiMo/DSH 六路线
```

从工程收益排序，v2 开工优先级：

```text
P0-1 Evidence schema v2
P0-2 Sidecar core
P0-3 Qwen adapter
P0-4 Self-Evolution cohort
P0-5 OpenCode V2 + MiMo lineage experiment
P0-6 Cline restore safety experiment
```

完成这些后，Observatory 才真正从“一次性五 Agent 研究方案”升级为：

> **可持续吸收优秀 Coding Agent 机制、用真实运行证据验证收益、再安全迁移到 DSH 的长期实验平台。**
