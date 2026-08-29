# mozi 借鉴 DSH：agent 字幕模块设计（函数级规格 + TDD，v5 — Snapshot/Effect 协议收口）

> 状态：设计备忘（working document）
>
> v4 → v5：吸收 `docs/advices-for-v4.md` 第二轮评审（逐条处置见 §0.3），核心为**协议收口**：Snapshot/Effect 双通道、两阶段锁 + caption_rev、renderer 注入、emit 失败语义。v4 的 CaptionProjector 事实-投影分层保留不推翻
>
> 主体：mozi（`/home/moyang/Documents/a88/mozi-hermes-agent/`，Hermes 系 Python agent）
>
> 借鉴对象：deepseek-harness（DSH，all-plugin Cordis harness，TypeScript）
>
> 日期：2026-08-29

**v5 第一原则**：Projector 只产生当前事实 Snapshot；短暂视觉反馈是独立 Effect——Effect 不改写、也不绕过事实投影。

## 0. 定位

字幕（caption）= agent 活动的**实时一行人类可读叙述**（现在进行时），呈现在 CLI spinner、TUI 轨迹、桌面宠物气泡、Slack typing。与 pet 模块是"台词 vs 表情"：同源信号、同层纯显示（不加模型工具、不改 system prompt、对 prompt cache 零影响），粒度更细。现状：半成品素材散落五处且互不相通、不 i18n、不回放；`derive_pet_state` 已有 Python/TUI/桌面三处镜像的前车之鉴。

### 0.1 已核实的集成事实（全部源码验证）

1. `t()`（`agent/i18n.py:232-273`）自带 format 失败保护：`try/except (KeyError, IndexError, ValueError)` → warning + raw 模板——不抛，但失败输出带占位符原文。
2. 网关 `_on_tool_progress`（`tui_gateway/server.py:7687`）对 `tool.started` 提前返回；权威事件在 `_on_tool_start`（`:7606`），payload 含 `context: _tool_ctx(name, args)`（80 字符预览，**脱敏行为未核** → 核查清单 #4）。
3. 工具真并行：`agent/tool_executor.py:1520` `DaemonThreadPoolExecutor`、`:2865` mixed segments——回调可能从不同线程并发到达。
4. 完成事件 id/is_error 分裂：`tool_progress_callback("tool.completed", …)` 有 `is_error` 无 id（`:1865`/`:2779`）；`tool_complete_callback` 有 id 无 `is_error`（`:1891`/`:2793`）；`tool_call_id` 在两处发射点均在作用域内（补 kwargs 即可弥合）。
5. 回调为 4 位置参数（event_type, name, preview, args）+ kwargs。
6. `write_json`（`server.py:2478`）统一打 per-session seq + 环形缓冲；`session.events.since` 重连重放；17 语言 YAML + 键 parity 测试（`tests/agent/test_i18n.py:45`）。
7. 回调路径脱敏已证（executor 回调前 `_redact_tool_args_for_display`、`build_tool_preview` 内部 redact）；`_tool_ctx` 自身未核。
8. **主循环事件与回合同线程**（`conversation_loop.py` 内同步发射 thinking/reasoning/流式回调）——这类事件不存在跨回合迟到问题；可迟到的只有工具工作线程发射的 `tool.*`（中断路径下）。
9. pet 的现行瞬态语义：CLI `_derive_pet_state` 中 `_pet_event` **瞬态 flash 优先于一切推导态**（含 awaiting）——effect 政策 §3.6 与此对齐。

### 0.2 第一轮评审处置摘要（v4 ← `docs/advices.md`，全表见 git 历史 v4 版）

S0 级五项全部采纳（补 `tool_call_id` kwargs、事实/显示分离、CLI/网关共用 projector、State/Frame 拆分、并发串行化）；处方修正四处（队列→锁、server 定时器→自衰减、中央脱敏层→条件触发、parity 豁免→提案待批）。

### 0.3 v5 对 `docs/advices-for-v4.md` 的逐条处置

判定含义：**采纳**=按建议执行；**修正采纳**=诊断成立、处方需改；**部分采纳**=只取一部分。

| # | 建议 | 判定 | 处置与理由 |
|---|---|---|---|
| 1 | `transient` bool 不闭合：latest-seq-wins 与 1.6s 回落互斥，每个表面被迫实现 overlay+timer+pending 第二状态机 | **采纳** | 诊断成立（v4 的 `on_tool_completed(is_error)` 连发 transient 帧与投影帧，正是"seq N 瞬态、seq N+1 稳态"的自相矛盾）。改为双通道：`caption.update`（Snapshot：当前事实，可重连）与 `caption.effect`（Effect：`{kind, text, ttl_ms}`，fire-and-forget overlay）。表面只需哑计时器"到期隐藏"，无 pending 状态机——与 pet 现行 `flashPetActivity(ms=1600)` overlay 模式同构。**载荷精简**：effect 不带 `related_revision`（overlay 无序敏性，rev 仅留调试字段） |
| 2 | `emit` 全程持锁危险（重入自锁、传输卡顿阻塞工具线程、故障隔离差）；建议两阶段 + emit-lock / caption_rev | **修正采纳** | 危害成立：`tool_executor` 在**工具线程上同步调用回调**，锁内 emit 一旦阻塞会直接卡住工具完成；普通 `Lock` 重入即死锁。**采纳两阶段**（状态锁内只做 mutate/project/rev++/构帧/更新 `_current`，锁外 emit）。**不采纳 Plan A 的 emit-lock**：它只防交错不防乱序——两线程仍可能以 rev 6→5 顺序进入 emit 边界，顺序正确性无法由第二把锁保证。正确性来自 **Plan B 的 `caption_rev`**（消费端 higher-rev-wins）：乱序到达时最终值仍正确，与外层 seq（重放缓冲序）职责分离。帧级原子写出本就是网关既有全局性质（所有帧从多线程 `_emit`），字幕未引入新要求，无需为字幕单加串行化 |
| 3 | `turn_epoch`：旧回合迟到事件污染新回合；"Lock 只保证串行，不保证逻辑 epoch" | **部分采纳** | 原则成立（I13 采纳），但"最大剩余 race"的定性强于证据。逐类核实（§0.1-8）：主循环线程事件（thinking/reasoning/stream）与回合同线程**不可能迟到**；迟到的 `tool.completed` 在 `on_turn_started` 清空 `in_flight` 后是未知 id，**已被 v4 的幂等-未知 id 守卫天然拦截**。真正残余 = 中断路径下迟到的 `tool.started`（无来源标记不可判别新旧回合），修复需 executor 回调附带 turn/run 标识——列为**条件后续项**（核查清单 #6），不阻塞主线。采纳其两个测试中现在可实现的（迟到 completed 被忽略）；started 污染测试随 #6 落地 |
| 4 | transient 绕过投影优先级（awaiting 打开时 tool_failed 直接盖掉"等待确认"） | **采纳** | 双通道化后 effect 需要显式政策，照建议"写出来"。v5 规则（§3.6）：**失败类 effect（tool_failed/turn_failed）可叠加在 awaiting 之上**——与 pet 现行 flash-wins 语义一致（§0.1-9），且失败信息有助于用户决策；**信息类 effect（moa/subagent/tool_generating）在 awaiting 打开期间抑制**。effect 永不改写 Snapshot |
| 5 | `from_payload` 放 state.py 造成 `state→assemble→state` 循环或违反"assemble 唯一查 t()" | **采纳** | v4 规格确不闭合。新增 `wire.py`：`state ← assemble`，`wire` 组合二者承载 `to_payload/from_payload`；"wire boundary fail-closed 本就是 wire adapter 的职责" |
| 6 | projector 缺 renderer/lang 依赖，不应偷读全局 locale | **采纳** | 构造器注入 `render: Callable[[CaptionState], str]`；网关=会话语言、CLI=当前 locale、Slack=英文，各自绑定。projector 不懂 locale/session/Slack |
| 7 | emit 失败 + 去重 = 永久饿死（`_last_visible` 先置位则重投影被 dedupe 吞掉） | **采纳** | 区分 `_current`（投影成功即更新，不依赖发送）与 `_last_emitted`（**emit 成功后**才更新）；去重只对 `_last_emitted`；补"首次 emit 抛异常、同投影再次发生、第二次必须发出"的重试测试 |
| 8 | dict 插入序承担产品语义（同 id 重插不移动位置，"最近打开者"≠"dict 末位"） | **采纳** | 显式计数：`AwaitingRequest{kind, order}`、`RunningTool{call_id, name, subject, started_order}`；投影取 awaiting 最大 order、in_flight 最小 started_order |
| 9 | MOA/subagent/tool_generating 过早定为 1.6s 闪现（词汇未核，可能有持续生命周期） | **采纳** | 分类表三列制（§3.6）：信号｜暂定分类｜核查 #1 后终判。`tool_generating` 暂定**认知相位**（入 `last_cognitive` 槽，是真实的持续阶段）；moa/subagent 待核后再定 lifecycle-fact（Snapshot 类）或 effect |
| 10 | 核查清单放太晚（step 2/3/7 依赖核查结论）："测试先行不能代替事实先行" | **采纳** | 核查前移为 **Step 0 — source verification**：五项核完**冻结函数规格**，再进入红绿循环 |
| 11 | Formatter().parse 之外应禁复杂 field 表达式（`{x.foo}`/`{x!r}`/`{x:>100}`） | **采纳** | locale 测试收紧：`field_name` 必须是封闭词表内的简单 identifier、`conversion is None`、`format_spec == ""`——翻译者无法无意改变格式语义 |
| 总体 | v5 = 协议收口而非大改；第一原则"Snapshot 只出事实，Effect 独立不绕过投影" | **采纳** | 即本版第一原则（文档首部） |

**对建议的否定性结论**（处方层面三处）：#2 的 emit-lock 不能保证 revision 顺序（逻辑不充分，正确性由 caption_rev 承担，两把锁非必要）；#3 的"最大剩余 race"定性强于证据（同线程事件不可能迟到、completed 已被未知 id 守卫，残余仅中断路径的迟到 started 且修复依赖 executor 配合）；#1 的 effect 载荷（related_revision 等）属过度设计（overlay 无序敏性）。诊断层面 11 条全部成立。

## 1. DSH 论点映射与显式偏离声明

| # | DSH 论点 | 字幕模块的映射 |
|---|---|---|
| D1 | 本地化显示文本不是身份 | `CaptionState{kind, params}` 是身份；`text` 是渲染快照 |
| D2 | 宿主唯一计算点；整值过线 | 推导/投影/渲染单点（CLI/网关/Slack 共用）；Snapshot/Effect 各自整值 |
| D3 | 呈现不进持久层 | 不写 SessionDB；重连靠内存 `_current` Snapshot + seq 环形缓冲 |
| D4 | 封闭词表 + fail-closed 兜底 | kind 封闭；未知/畸形降 generic（保留 text）；占位符封闭词表 + 测试期格式限制 |
| D5 | 高 seq 胜出 | 双层：外层 seq 管重放缓冲序；**`caption_rev` 管投影序（消费端 higher-rev-wins）** |
| D6 | 辅助 LLM 确定性兜底先行 | P4 可选，不变 |

**显式架构决策（偏离声明）**：DSH 对工具呈现采用 client-owned presentation。本模块**有意不采用**：线上载荷携带 host 渲染的规范 `text`，TS 表面默认零渲染直接显示。取舍理由：mozi 五个异构表面（TUI 无 i18n、desktop 另有 typed catalog），client-derived 将造成第三套渲染镜像。代价：多语言用户共享网关会话语言；`kind/params` 仍随帧下发，保留表面本地重渲染的演进余地。

## 2. 架构：事实投影 + 双通道协议

### 2.1 分层原则

```
原始回调（多线程并发到达）
   ↓ 适配层（CLI / gateway relay；Step 0 核查后冻结词汇）
CaptionProjector
   ├─ ①【状态锁】mutate_truth —— 所有事件永远更新事实
   ├─ ②【状态锁】project(truth) —— 优先级只决定显示什么
   ├─ ③【状态锁】rev += 1；构造 Snapshot / Effect；更新 _current
   ├─ ④【锁外】emit(snapshot) / emit_effect(effect)
   └─ ⑤ emit 成功 →【短暂持锁】更新 _last_emitted（重试语义）
传输
   ├─ caption.update = Snapshot{kind, params, text, rev}
   └─ caption.effect = Effect{kind, text, ttl_ms, rev}
表面
   ├─ 显示 = effect 未到期 ? effect.text : snapshot.text（哑 TTL 计时器）
   └─ 乱序自愈 = higher caption_rev wins
```

### 2.2 文件布局

```
agent/captions/
  __init__.py    # 契约声明（纯显示、零 prompt 影响）+ 公共导出
  state.py       # CaptionKind / CaptionState / CaptionSnapshot / CaptionEffect / make_*
  signal.py      # SignalKind / CaptionSignal / caption_signal
  derive.py      # derive_caption：单信号→状态纯查表
  verbs.py       # 动词注册表（元数据；文案在 locale）
  assemble.py    # render_caption / verb_text / format_subject（唯一查 t() 处）
  projector.py   # CaptionProjector：事实 + 投影 + 两阶段锁 + rev + effect 政策
  wire.py        # to_payload / from_payload（state+assemble 组合；线边界 fail-closed）
tui_gateway/captions_relay.py  # 薄适配：回调→projector；Snapshot/Effect→帧；重连注入
agent/pet/caption_tone.py      # kind→PetState 适配器（pet→captions 单向）
locales/*.yaml                 # captions.*（en+zh 真翻译，15 locale 英文占位）
```

依赖（无环）：`state ← assemble ← wire`；`state ← signal/derive ← projector`（projector 依赖注入 render，不 import assemble 的语言逻辑）；pet→captions。

### 2.3 函数/类清单

| 函数/类 | 文件 | 职责 |
|---|---|---|
| `make_caption` / `make_snapshot` / `make_effect` | state.py | 三构造器（校验 kind、冻结、rev 由 projector 分配） |
| `caption_signal` | signal.py | progress 词汇 → CaptionSignal，永不抛 |
| `derive_caption` | derive.py | 单信号 → CaptionState 纯查表 |
| `verb_key` 等三函数 | verbs.py | 动词注册表元数据 |
| `verb_text/format_subject/render_caption` | assemble.py | 渲染末端（精确占位符检测） |
| `CaptionProjector` | projector.py | 事实 + 投影 + 两阶段锁 + rev + effect 政策 + `_current`/`_last_emitted` |
| `snapshot_payload/effect_payload/parse_payload` | wire.py | 线载荷往返（fail-closed） |
| `caption_tone` | pet/caption_tone.py | kind→PetState 适配 |
| `relay_*` 适配族 | captions_relay.py | 回调→projector、帧→WS、重连注入 |

## 3. 逐函数规格

### 3.1 `state.py`

`CaptionKind`（封闭）：`idle | thinking | reasoning | tool_generating | tool_running | tool_failed | subagent | moa | awaiting_input | turn_done | turn_failed | replying | generic`。

- `make_caption(kind, params=None) -> CaptionState`：唯一合法 CaptionState 构造器；params 逐值 `str()` 冻结、None 值键丢弃；非法 kind → `ValueError`（进程内响亮失败；线边界在 wire 层降级）。
- `CaptionSnapshot{state: CaptionState, text: str, rev: int}`（`make_snapshot(state, text, rev)`）：当前事实的整值投影，可重连。
- `CaptionEffect{kind: CaptionKind, text: str, ttl_ms: int, rev: int}`（`make_effect(kind, text, ttl_ms, rev=0)`）：瞬时视觉反馈；`kind` 限于失败/终态/提示类；`ttl_ms` 缺省 1600。

### 3.2 `signal.py` / 3.3 `derive.py`（同 v4，摘要）

`caption_signal(event_type, name=None, preview=None, args=None, **kwargs)`：progress 词汇归一（显式第 4 位置参数；`tool.completed` 从 kwargs 读 `tool_call_id`/`is_error`；表外 → UNKNOWN；永不抛）。`derive_caption(signal) -> CaptionState`：纯查表（无时钟/配置/随机）；角色 = 一次性/认知信号的 CaptionState 构造器，持续态由 projector 从事实直接构造；normative 矩阵同 v4（§3.3）。

### 3.4 `verbs.py` / 3.5 `assemble.py`（同 v4，摘要）

动词注册表三函数（24 键全量迁 `captions.verb.*`，迁移期 parity 锁键集）。`verb_text` 回退链闭合到工具原名；`format_subject` 不截断（信任上游 80 字符预算）；`render_caption(state, lang=None) -> str`：模板 `t(captions.{kind})`（不传 kwargs 取原文）→ `Formatter().parse` 精确求占位符集 → 齐备才 `format_map`，缺参/模板 miss → generic 重来；输出非空永不抛。占位符封闭词表：`{verb, subject, tool, goal, detail, phase, kind}`。

### 3.6 `projector.py` —— `CaptionProjector`（核心）

```python
class CaptionProjector:
    def __init__(self, emit: Callable[[CaptionSnapshot], None],
                 emit_effect: Callable[[CaptionEffect], None],
                 render: Callable[[CaptionState], str]): ...
```

**事实状态**（私有，状态锁保护）：`in_flight: dict[str, RunningTool{call_id, name, subject, started_order}]`（显式计数，处置 #8）；`awaiting: dict[str, AwaitingRequest{kind, order}]`（同）；`stream_active: bool`；`turn_active: bool`；`last_cognitive: str | None`（"reasoning"|"thinking"|"tool_generating"|None）；`turn_epoch: int`（处置 #3）；`_rev: int`（单调投影计数）；`_current: CaptionSnapshot | None`（投影即更新）；`_last_emitted: CaptionState | None`（**emit 成功后才更新**，去重基线，处置 #7）。

**两阶段锁语义（处置 #2）**：单个 `_state_lock`（普通 Lock，锁内**绝不执行任何外部回调**——无重入死锁面，工具线程不被传输卡顿阻塞）。锁内：①mutate →②project →③`_rev += 1`、构造 Snapshot/Effect、更新 `_current`。锁外：④`emit`/`emit_effect`（注入回调；抛异常捕获记日志）。⑤emit 成功 → 短暂持锁更新 `_last_emitted`。**顺序正确性不依赖 emit 顺序**：载荷携带 `rev`，消费端 higher-rev-wins——两线程乱序到达时最终显示仍为最新事实（外层 seq 仍由 `write_json` 统一打点，管重放缓冲序）。

**投影规则**（`project() -> CaptionState`，纯读，优先级降序）：

1. `awaiting` 非空 → `awaiting_input(kind=最大 order 者)`
2. `in_flight` 非空 → `tool_running(最小 started_order 者)`
3. `stream_active` → `replying`
4. `last_cognitive` 非空 → 对应 kind（reasoning/thinking/tool_generating）
5. `turn_active` → `thinking`
6. 否则 → `idle`

**Effect 政策（处置 #4，normative）**：Snapshot 通道**只**由投影变化驱动；Effect 通道独立：

| 触发 | Effect | awaiting 打开期间 |
|---|---|---|
| `on_tool_completed(is_error=True)` | `tool_failed`（ttl 1600） | **放行**（失败类；与 pet flash-wins 语义一致） |
| `on_turn_ended(False)` | `turn_failed`（ttl 1600） | 放行（终态类） |
| `on_turn_ended(True)` | `turn_done`（ttl 1600） | 放行 |
| moa/subagent/tool_generating 提示 | 对应 effect | **抑制**（信息类） |

Effect 不改写 Snapshot、不进入 `_current`、重连不补发。

**方法族**（每个：锁内 ①②③，锁外 ④⑤；数据输入永不抛）：

| 方法 | 事实更新 | 输出 |
|---|---|---|
| `on_tool_started(call_id, name, subject)` | in_flight 记入（started_order++）；`stream_active=False`；`last_cognitive=None` | Snapshot（变化且≠`_last_emitted` 才 emit） |
| `on_tool_completed(call_id, is_error)` | `in_flight.pop(call_id, None)`（幂等；未知 id 无副作用） | is_error → Effect(tool_failed) + Snapshot；否则 Snapshot |
| `on_tool_generating(tool_name)` | `last_cognitive="tool_generating"`（暂定认知相位，处置 #9） | Snapshot |
| `on_reasoning()/on_thinking()` | last_cognitive 置位 | Snapshot |
| `on_stream_started()` | `stream_active=True`（幂等） | Snapshot |
| `on_awaiting_opened(request_id, kind)` | awaiting 记入（order++） | Snapshot |
| `on_awaiting_closed(request_id)` | `awaiting.pop(request_id, None)`（旧 close 误不了新请求） | Snapshot（按剩余事实投影） |
| `on_turn_started()` | `turn_epoch += 1`；`turn_active=True`；清 in_flight/awaiting；`stream_active=False`；`last_cognitive=None` | Snapshot |
| `on_turn_ended(succeeded)` | `turn_active=False`；清同上；`_current` 置为事实投影 idle | Effect(turn_done/failed) + Snapshot(idle) |
| `on_vocab_signal(signal)` | REASONING/THINKING 分派；MOA/SUBAGENT 按分类表（§3.6 末） | TOOL_*/AWAITING/TURN 类到达 → debug 忽略（防双路） |

- `current_snapshot() -> CaptionSnapshot | None`：锁内读 `_current`（重连服务；Effect 永不进入）。
- **迟到事件守卫（处置 #3 的现可实现）**：`on_tool_completed` 对未知 call_id 的静默忽略即回合隔离——回合切换清空后，旧回合 completed 全部成为未知 id。`turn_epoch` 字段与 I13 不变量现在落地，来源标记（executor 回调附 turn id）为核查清单 #6 的条件后续。

**MOA/subagent/tool_generating 分类表（处置 #9）**：

| 信号 | 暂定分类 | 终判条件 |
|---|---|---|
| `tool_generating` | 认知相位（last_cognitive 槽，Snapshot） | 已定：JSON 生成是持续阶段 |
| `moa.*` | Effect（暂） | 核查 #1 后：有 start/complete 生命周期 → 事实槽（Snapshot kind=moa）；无 → Effect |
| `subagent.*` | Effect（暂） | 同上 |

### 3.7 `wire.py`（处置 #5）

- `snapshot_payload(s: CaptionSnapshot) -> dict` → `{"kind": …, "params": {...}, "text": …, "rev": n}`；网关包成 `caption.update` 帧。
- `effect_payload(e: CaptionEffect) -> dict` → `{"kind": …, "text": …, "ttl_ms": …, "rev": n}`；`caption.effect` 帧。
- `parse_snapshot(payload) -> CaptionSnapshot` / `parse_effect(payload) -> CaptionEffect`：线边界 fail-closed——未知 kind 降 generic 但 **text/rev 原样保留**；params 非 dict → 空；ttl_ms 非 int → 1600；text 缺失 → `render_caption(generic state)` 兜底（`wire` 可调 `assemble`，无环）；畸形不抛。

### 3.8 `agent/pet/caption_tone.py`、接线、重连（同 v4 增 rev）

`caption_tone(kind) -> PetState` 静态映射，pet→captions 单向依赖。executor 补丁（P0）：两条完成路径补 `tool_call_id=` kwarg。网关 relay：每会话 projector 存 `_sessions[sid]["captions"]`，`emit=_emit("caption.update", …)`、`emit_effect=_emit("caption.effect", …)`、`render=lambda s: render_caption(s, session_lang)`；`relay_tool_start` 的 subject 来源由核查 #4 决定；`relay_progress` 首行守卫 `tool.started`；重连：`session.events.since` 响应附 `caption_current`（`current_snapshot()` 的 payload 或 null——只服务 Snapshot，Effect 天然不补发）。CLI：同 projector，`emit` 写 `_spinner_text`、`emit_effect` 走既有 pet flash 计时机制（`_pet_anim_loop` 同款）或自然被下一 Snapshot 覆盖。Slack：`render_caption(state, "en")`。

### 3.9 locale（normative 键集 + 格式限制）

键集与每键法定占位符同 v4（12 kind 模板 + 24 动词 + generic 动词 + 2 连接词 + 4 awaiting_kind；`tool_failed/tool_generating: {tool}`、`tool_running: {verb, subject}`、`moa: {phase, detail}`、`subagent: {detail}`、`awaiting_input: {kind}`、其余 ∅）。**格式限制（处置 #11）**：测试期对每 locale 每键断言 `Formatter().parse` 产出——`field_name ∈ 封闭词表`（简单 identifier）、`conversion is None`、`format_spec == ""`；出现 `{x.foo}`/`{x!r}`/`{x:>10}`/位置 `{}` 一律红。翻译策略与假 parity 警告同 v4（en+zh 真翻译 + 15 占位；parity 绿 ≠ i18n 完成；fallback 豁免提案待 i18n 政策所有者）。

## 4. 不变式（跨函数契约，测试锚点）

| # | 不变式 | 检验 |
|---|---|---|
| I1 | `derive_caption` 纯函数 | test_derive |
| I2 | signal/derive/render/parse_* 对任意数据输入永不抛；render 输出非空 | fuzz |
| I3 | 整值：Snapshot/Effect 各自完整载荷，无增量 | relay/projector |
| I4 | 进程内非法 kind 响亮失败；线边界未知 kind 降 generic 且 text/rev 保留 | test_wire |
| I5 | **双层序**：外层 seq 管重放缓冲；`caption_rev` 管投影序，消费端 higher-rev-wins | 乱序测试 |
| I6 | 渲染回退链闭合（verb→generic→en→工具原名；模板 miss/缺参→generic；占位符精确判定） | test_assemble/test_locale |
| I7 | 词汇性参数渲染端本地化、数据性原样；占位符与格式表达封闭 | test_locale |
| I8 | text 是规范显示值；TS 表面零渲染 | 表面验收 |
| I9 | 事实与显示分离：任何事件都更新事实；优先级只影响投影 | test_projector |
| I10 | 状态锁内不执行外部回调；乱序 emit 不破坏最终一致（rev 自愈） | 并发测试 |
| I11 | Effect 不进入 `_current`、不改写 Snapshot、重连不补发 | test_projector |
| I12 | captions 核心不 import pet | import 检查 |
| I13 | **旧回合迟到事件不得修改当前事实**（现可实现：未知 call_id 忽略；完整 epoch 标记随核查 #6） | 迟到 completed 测试 |
| I14 | **emit 失败不饿死**：`_last_emitted` 仅在 emit 成功后更新；重投影必须重发 | 重试测试 |
| I15 | Effect 政策：失败/终态类可叠加 awaiting；信息类在 awaiting 期间抑制 | 政策测试 |

## 5. TDD 计划

### 5.1 红—绿—重构顺序

| 步 | 内容 |
|---|---|
| **0** | **Source verification（处置 #10，未核不得写测试）**：五项核查（§6 清单）→ **冻结函数规格** → 分类表终判（moa/subagent）。"测试先行不能代替事实先行" |
| 1 | test_state（State/Snapshot/Effect 构造与校验） |
| 2 | test_signal（矩阵 + 第 4 位置参数 + tool_call_id 归一） |
| 3 | test_derive 矩阵 |
| 4 | locale：en+zh 真翻译 + 15 占位 + **占位符词表与格式限制测试**（Formatter().parse 三断言） |
| 5 | test_assemble |
| 6 | test_verbs（迁移 parity） |
| 7 | **test_projector**（§5.2） |
| 8 | executor 补丁测试（两条路径 kwargs 捕获含 tool_call_id） |
| 9 | test_wire（payload 往返 + fail-closed 降级保 text/rev） |
| 10 | test_captions_relay |
| 11 | CLI 测试 |
| 12 | 手动验收 |

### 5.2 关键用例（命名即验收；★ = 本轮建议新增）

`test_projector.py`：

- ★ `test_snapshot_and_effect_are_separate_channels` — tool_failed：一帧 Effect + 一帧 Snapshot（thinking），顺序与覆盖互不干扰。
- ★ `test_informational_effect_suppressed_while_awaiting` — awaiting 期间 moa effect 零帧；`tool_failed` effect 放行（I15）。
- ★ `test_emit_failure_then_reprojection_is_reemitted` — 首次 emit 抛异常 → 同投影再次发生 → 第二次 emit 必须成功发出（I14）。
- ★ `test_current_snapshot_excludes_effects`；`test_reconnect_serves_fact_snapshot_after_turn_end`（idle 而非 turn_done）。
- ★ `test_out_of_order_emit_resolved_by_rev` — 构造两线程乱序 emit，消费端按 higher-rev-wins 取最新事实（I5/I10）。
- ★ `test_state_lock_never_runs_emit_callback` — emit 回调内断言锁未被持有（`lock.acquire(blocking=False)` 探测）。
- `test_completed_while_awaiting_updates_truth_but_emits_no_snapshot_change`；`test_parallel_same_tool_name_correlated_by_call_id`；`test_duplicate_completion_is_idempotent`；`test_unknown_completion_id_does_not_remove_other_tool`（同时即 I13 现实测试：迟到 completed 被忽略）；`test_concurrent_start_complete_serialized_by_final_state`；`test_second_reply_segment_after_tool_emits_replying_again`；`test_awaiting_close_for_old_request_does_not_close_new_request`；`test_projection_priority_matrix`；`test_on_vocab_signal_ignores_lifecycle_signals`。
- （条件，随核查 #6）`test_late_previous_turn_tool_start_does_not_pollute_new_turn`。

`test_locale.py`：★ `test_no_complex_format_expressions`（conversion/format_spec/属性访问全拒绝）；`test_placeholder_vocabulary_per_locale`；parity。

`test_wire.py`：`test_snapshot_roundtrip`；`test_effect_roundtrip`；`test_unknown_kind_degrades_but_keeps_text_and_rev`；`test_garbage_payloads_never_raise`。

其余（state/signal/derive/assemble/verbs/relay/CLI/executor）同 v4 用例基线，relay 增 `test_caption_current_survives_ring_eviction`（Snapshot 通道）、`test_preview_redacts_secret_before_cross_surface_emit`（条件于核查 #4）。

### 5.3 验收门（DoD）

§5.1 全绿（含 Step 0 冻结记录）；parity 绿（15 为登记占位）；display 旧路径不回归；核查 5 项结论回填文档；I13 完整版（executor turn id）结论或条件后续登记。

### 5.4 表面手动验收（同 v4 增双通道项）

TUI/web：显示 = 未到期 Effect ? effect.text : snapshot.text；重连恢复 Snapshot（含环形淘汰场景）。桌面：pet-bubble 真实字幕 + idle/awaiting 变体轮换 + effect 叠加 1.6s。`grep -r "crunching\|hit a snag" apps/desktop/src` 零命中。Slack 同源（en）。

### 5.5 P4（可选）LLM 智能字幕预留

`refine_caption(state, tool_result_summary, llm_call) -> CaptionSnapshot`：规则 Snapshot 先行，LLM 晚到以更高 rev 替换、新工具事件即废；`min_tool_seconds` 节流。仅防接口漂移。

## 6. 风险、非目标与动工前核查清单（Step 0）

- **非目标**：帧合并；SessionDB 持久化；TUI i18n；`tool.output_risk` 入字幕；服务端 effect 定时器（表面哑 TTL）；emit 顺序锁（正确性由 rev 承担）。
- **风险**：占位翻译债与英文漂移（§3.9）；多语言用户共享会话语言（§1）；effect TTL 到期与 Snapshot 更新的竞态（表面规则固定为"effect 未到期优先，到期即回落当前 Snapshot"——无 pending 状态）；迟到 `tool.started`（中断路径）在核查 #6 落地前为**已登记残余风险**。
- **核查清单（5 项 + 1 条件项，全部前置于任何测试，处置 #10）**：
  1. `subagent.*` 回调精确词表（决定分类表终判）；
  2. 网关回合边界帧（`on_turn_started/ended` 接线点）；
  3. assistant 流式首 delta 网关挂钩点（`on_stream_started`）；
  4. `_tool_ctx` 是否统一脱敏（决定 `relay_tool_start` subject 来源；驱动跨面脱敏测试基线）；
  5. clarify/approval/sudo/secret 帧中 request_id 可得性；
  6. （条件后续）executor 回调附带 turn/run 标识的可行性——I13 完整版（迟到 `tool.started` epoch 标记）的前提。

## 7. 附录：文件索引

mozi：`agent/tool_executor.py`（started `:1055`、completed 并行 `:1865`/串行 `:2779`、complete_callback `:1891/:2793`、线程池 `:1520`）、`agent/conversation_loop.py:6904`、`run_agent.py:475-491`；`tui_gateway/server.py`（`write_json:2478`、`_on_tool_start:7606`、`_on_tool_complete:7640`、`_on_tool_progress:7687`、`_agent_cbs:7929`、`event_replay.py`）；`agent/display.py`（`_TOOL_VERBS:627`、`build_tool_preview:446`、`build_status_phrase:762`）；`cli.py:14426/20570`；`apps/desktop/src/components/pet/pet-bubble.tsx` 与 pet flash 机制（`store/pet.ts::flashPetActivity`）；`agent/i18n.py:232-273`、`locales/*.yaml`、`tests/agent/test_i18n.py:45`；`agent/pet/state.py`（flash 优先语义）。

DSH（被借鉴模式与显式偏离点）：`packages/core/session/src/types.ts`（信封/词表/整值）、`packages/session/session-projection/`（事实折叠+投影 + higher-seq-wins——v5 的 rev 自愈即其投影序规则在字幕流内的应用）、`2026-08-23-client-derived-tool-presentation.md`（**有意不采用**，见 §1）、`2026-08-23-locale-owned-client-ui-copy.md`、`packages/session/session-title*`。
