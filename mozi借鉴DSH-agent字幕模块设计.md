# mozi 借鉴 DSH：agent 字幕模块设计（函数级规格 + TDD，v4 — CaptionProjector 状态投影模型）

> 状态：设计备忘（working document）
> v3 → v4：吸收 `docs/advices.md` 评审（逐条处置见 §0.2），核心重构为"事实状态 + 投影"模型
> 主体：mozi（`/home/moyang/Documents/a88/mozi-hermes-agent/`，Hermes 系 Python agent）
> 借鉴对象：deepseek-harness（DSH，all-plugin Cordis harness，TypeScript）
> 日期：2026-08-29

## 0. 定位

字幕（caption）= agent 活动的**实时一行人类可读叙述**（现在进行时），呈现在 CLI spinner、TUI 轨迹、桌面宠物气泡、Slack typing。与 pet 模块是"台词 vs 表情"：同源信号、同层纯显示（不加模型工具、不改 system prompt、对 prompt cache 零影响），粒度更细。

现状：半成品素材散落五处（`agent/display.py` 的 `build_status_phrase`/`_TOOL_VERBS`/`get_cute_tool_message`、`cli.py:14426` spinner、`apps/desktop/src/components/pet/pet-bubble.tsx` 硬编码英文台词），互不相通、不 i18n、不回放；`derive_pet_state` 已有 Python/TUI/桌面三处镜像的前车之鉴。

### 0.1 已核实的集成事实（全部源码验证）

1. `t()`（`agent/i18n.py:232-273`）自带 format 失败保护：`try/except (KeyError, IndexError, ValueError)` → warning + 返回 raw 模板——不抛异常，但失败输出带占位符原文。
2. 网关 `_on_tool_progress`（`tui_gateway/server.py:7687`）对 `tool.started` 提前返回；权威事件在 `_on_tool_start`（`:7606`），payload 已含 `context: _tool_ctx(name, args)`（80 字符预览，**脱敏行为未核**，见核查清单 #4）。
3. 工具真并行：`agent/tool_executor.py:1520` `DaemonThreadPoolExecutor`、`:2865` mixed segments——回调可能从不同线程并发到达。
4. **完成事件的 id 与 is_error 分裂在两条回调上（v4 新核）**：`tool_progress_callback("tool.completed", name, None, None, duration=, is_error=, result=)` 有 `is_error` 无 `tool_call_id`（`:1865` 并行路径、`:2779` 串行路径）；`tool_complete_callback(tool_call_id, name, display_args, result)` 有 id 无 `is_error`（`:1891`/`:2793`）。`tool_call_id` 在两处完成发射点均在作用域内（紧随其后的 `tool_complete_callback` 就在用）——**补一个 kwargs 即可弥合**。
5. 回调是 4 位置参数（event_type, name, preview, args）+ kwargs。
6. `write_json`（`server.py:2478`）统一打 per-session seq + 入环形缓冲；`session.events.since` 重连重放；17 语言 YAML + 键 parity 测试（`tests/agent/test_i18n.py:45`）。
7. 回调路径的脱敏证据：executor 在回调前统一 `_redact_tool_args_for_display`（`:1050-1069`）；`display.build_tool_preview` 内部亦先 redact（`display.py:449`）。`_tool_ctx` 自身未核。

### 0.2 v4 对 `docs/advices.md` 的逐条处置

判定含义：**采纳**=按建议执行；**修正采纳**=诊断成立、处方需改；**部分采纳**=只取一部分。

| # | 建议 | 判定 | 处置与理由 |
|---|---|---|---|
| S0-1 | 完成事件缺 `tool_call_id`，状态机无法关联 | **采纳** | 诊断经独立核实成立（§0.1-4）。处方照做：`tool_executor` 两条完成路径的 `tool_progress_callback("tool.completed", …)` 补 `tool_call_id=` kwarg（附加 kwargs，不破坏现有消费者）。曾评估替代方案"改挂 `tool_complete_callback`"——因该回调无 `is_error` 而否决 |
| S0-2 | awaiting 抑制丢 `tool.completed`，事实状态腐化 | **采纳** | "更新事实与显示分离"是正确模型，即 v4 的 CaptionProjector 核心原则：**所有事件先更新事实状态；优先级只决定显示什么，绝不决定哪些事件被丢弃** |
| S0-3 | 真并行但无串行化边界 | **修正采纳** | 风险真实且更严重：帧 seq 在 emit 时打点，emit 顺序必须等于事实顺序，否则"高 seq 胜出"把乱序固化成错误状态。但 per-session 队列 + 消费者线程过重（网关多会话，多一套线程生命周期）；采用**每 projector 一把 `threading.Lock`，mutate+project+render+emit 全程持锁**（emit 为注入回调），字幕事件率≈工具调用率，锁内 emit 无吞吐问题 |
| S0-4 | CLI"串行视图"假设与并行事实冲突 | **采纳** | v3 判断错误：CLI 与网关消费同一批并发回调。v4 将 projector 放 `agent/captions/projector.py`，CLI/网关/Slack 三端共用，网关 relay 只做帧适配 |
| S0-5 | `CaptionState` 无 text 却要求 from_payload 保留 text | **采纳** | 类型矛盾属实。拆分：`CaptionState{kind, params}`（事实/身份）与 `CaptionFrame{state, text, transient}`（线上/显示）；`from_payload() -> CaptionFrame` |
| 6 | `replied: bool` 粒度错，多段流式不再触发 | **采纳** | 换 `stream_active: bool`：工具开始/回合边界复位，下一段输出重新触发 replying |
| 7 | brace 扫描误杀含 JSON 的合法 subject | **采纳** | 弃用输出扫描。运行期：`string.Formatter().parse(模板)` 精确求占位符集合，缺参→回落 generic；模板整体 miss 用"返回值==键"检测。测试期：每 locale 每键断言占位符集==法定集合（§3.9） |
| 8 | "环形缓冲无损"不成立 | **采纳** | 低频字幕帧最易被高频事件挤出环。网关每会话内存保存当前帧（`_sessions[sid]`），`session.events.since` 响应附带 `caption_current`；仍是内存投影，不写 SessionDB，D3 不破 |
| 9 | `awaiting: str\|None` 会被旧 close 误关 | **采纳** | 改 `dict[request_id, kind]`；close 按 id 删除，旧 close 误不了新请求；request_id 可得性入核查清单 #5 |
| 10 | turn_done 终态生命周期不完整 | **修正采纳** | "事实与瞬态分离"方向采纳：事实= idle，`turn_done/turn_failed/tool_failed` 为**自衰减瞬态帧**（`transient=true`，表面本地 1.6s 后回落）。但不采用"server emit idle"（引入服务端定时器）；重连时 projector 服务事实投影（idle），不服务过期瞬态 |
| 11 | `last` 字段语义未定义且恢复过期状态危险 | **采纳** | 删除。投影永远从当前事实重算，无任何"恢复历史 UI"语义；去重基线另设 `_last_visible`（仅比较，不恢复） |
| 12 | "subject 已脱敏"证据链未闭合 | **部分采纳** | 诊断对 `_tool_ctx` 成立（确实未核），但对回调路径过强——executor 回调前 redact 与 `build_tool_preview` 内部 redact 均已核实（§0.1-7）。处置：`_tool_ctx` 脱敏入核查清单 #4，通过则 relay 复用 context，不通过则 relay 用 `build_tool_preview(name, display_args)`（已证脱敏）。"中央 display-safe preview 层"暂缓——范围蔓延，待清单 #4 结果再议 |
| 13 | `KIND_TONE→PetState` 反向耦合 | **采纳** | captions 核心不知道 PetState。映射迁至 `agent/pet/caption_tone.py`（pet→captions 单向依赖，无环） |
| 14 | 实际偏离 DSH"呈现不入传输层"却仍声称遵循 | **采纳** | §1 增加显式架构决策声明：**有意不采用** DSH 的 client-owned presentation，选择 host-rendered canonical text 换取五端一致 |
| 15 | 15 locale 复制英文=假 parity | **修正采纳** | 保留占位方案（parity 是仓级 i18n 政策，本模块不单方改测试开口子），但文档显式标注"键 parity 绿 ≠ i18n 完成"+英文改动不自动传播的漂移风险；"namespace 级 fallback 豁免"作为提案交 i18n 政策所有者，不自行实施 |
| 核心 | RelayState → CaptionProjector | **采纳** | v4 主重构，理由同 S0-2/4 |

**对建议的否定性结论**（处方层面需修正的四处置）：#3 的队列方案过重（锁足够）；#10 的 server 定时器方案引入不必要复杂度；#12 的"中央 display-safe 层"是范围蔓延（条件触发）；#15 的改 parity 测试是仓级政策变更（不应单方实施）。诊断层面 15 条全部成立或基本成立。

## 1. DSH 论点映射与显式偏离声明

| # | DSH 论点 | 字幕模块的映射 |
|---|---|---|
| D1 | 本地化显示文本不是身份 | `CaptionState{kind, params}` 是身份；`text` 是渲染快照 |
| D2 | 宿主唯一计算点；整值过线 | 推导、投影、渲染都在 Python 单点（CLI/网关/Slack 共用）；帧携带完整 CaptionFrame |
| D3 | 呈现不进持久层 | 不写 SessionDB；重连靠内存当前帧 + seq 环形缓冲 |
| D4 | 封闭词表 + fail-closed 兜底 | kind 封闭枚举；未知/畸形降 generic（保留 text）；渲染占位符词表封闭且测试期校验 |
| D5 | 高 seq 胜出 | 帧继承 seq；**顺序正确性由 projector 锁保证**（emit 顺序=事实顺序） |
| D6 | 辅助 LLM 确定性兜底先行 | P4 可选，不变 |

**显式架构决策（偏离声明，处置 #14）**：DSH 对工具呈现采用 client-owned presentation（线上只有原始事件，卡片由客户端纯推导）。本模块**有意不采用**该原则：线上载荷携带 host 渲染的规范 `text`，TS 表面默认零渲染直接显示。取舍理由：mozi 有五个异构表面（CLI/TUI/desktop/web/Slack），其中 TUI 无 i18n、desktop 另有 typed catalog——client-derived 将造成第三套"渲染三镜像"，与 pet 三镜像同病。代价：多语言用户共享网关会话语言；`kind/params` 仍随帧下发，保留表面本地重渲染的演进余地。

## 2. 架构：CaptionProjector 状态投影模型

### 2.1 分层原则（处置 S0-2/核心）

```
原始回调（可能多线程并发到达）
   ↓ 适配层（CLI / gateway relay）
CaptionProjector.on_*（全程持锁）
   ├─ ① mutate_truth(event)      # 所有事件永远更新事实状态
   ├─ ② project(truth)           # 优先级只在这里决定"显示什么"
   ├─ ③ 变化或瞬态 → render_caption() → CaptionFrame
   └─ ④ emit(frame)              # 注入的回调：CLI 写 spinner / 网关发 WS 帧
```

两条铁律：**优先级绝不丢弃事实事件**（awaiting 打开期间 `tool.completed` 照常更新 `in_flight`，只是不显示）；**emit 顺序 == 事实顺序**（锁保证，seq 才可信）。

### 2.2 文件布局

```
agent/captions/
  __init__.py    # 契约声明（纯显示、零 prompt 影响）+ 公共导出
  state.py       # CaptionKind / CaptionState / CaptionFrame / make_caption / 载荷往返
  signal.py      # SignalKind / CaptionSignal / caption_signal（词汇归一化）
  derive.py      # derive_caption：单信号→状态的纯查表（一次性信号的构造器）
  verbs.py       # 动词注册表（元数据；文案在 locale）
  assemble.py    # render_caption / verb_text / format_subject（唯一查 t() 处）
  projector.py   # CaptionProjector：事实状态 + 投影 + 锁（核心状态机）
tui_gateway/captions_relay.py  # 薄适配：回调→projector 方法；帧→_emit；重连附 caption_current
agent/pet/caption_tone.py      # kind→PetState 适配器（pet 侧依赖 captions，无环）
locales/*.yaml                 # captions.*（en+zh 真翻译，15 locale 英文占位）
```

### 2.3 运行时调用图

```
tool_executor（补丁后 tool.completed 携带 tool_call_id）/ conversation_loop / run_agent
  │ agent.*_callback（多线程并发）
  ├─ cli.py 适配 → projector.on_* ─► emit=写 _spinner_text
  └─ tui_gateway 装配 captions_relay → projector.on_* ─► emit=_emit("caption.update")
       │    （每会话一个 projector，存 _sessions[sid]；当前帧存供重连）
       └─ write_json：seq + 环形缓冲 → WS/stdio
            ├─ ui-tui / web：直接显示 text
            ├─ desktop：默认显示 text（idle/awaiting 保留自有变体轮换）
            └─ 重连：session.events.since 附 caption_current（越过环形淘汰）
Slack：render_caption(state, "en")（projector 帧的英文渲染，verb/full 两档）
```

### 2.4 函数/类清单

| 函数/类 | 文件 | 职责 |
|---|---|---|
| `make_caption` | state.py | CaptionState 唯一构造器（校验 kind、params 冻结） |
| `make_frame` | state.py | CaptionFrame 构造器（state+text+transient） |
| `CaptionFrame.to_payload` / `from_payload` | state.py | 线载荷往返（from_payload 返回 **CaptionFrame**） |
| `caption_signal` | signal.py | progress 词汇 → CaptionSignal，永不抛 |
| `derive_caption` | derive.py | 单信号 → CaptionState 纯查表（一次性信号用） |
| `verb_key/verb_connector/verb_drops_preview` | verbs.py | 动词注册表元数据 |
| `verb_text/format_subject/render_caption` | assemble.py | 渲染末端（精确占位符检测） |
| `CaptionProjector` | projector.py | 事实状态 + 投影 + 锁 + 一次性帧 + current_frame |
| `caption_tone` | pet/caption_tone.py | kind→PetState 适配器（pet 侧） |
| `relay_*` 适配族 | captions_relay.py | 回调→projector、帧→WS、重连注入 |

## 3. 逐函数规格

约定：所有函数遵循 §4 不变式；"永不抛"指对任意**数据**输入不抛。

### 3.1 `state.py`

`CaptionKind`（封闭枚举）：`idle | thinking | reasoning | replying | tool_generating | tool_running | tool_failed | subagent | moa | awaiting_input | turn_done | turn_failed | generic`。

#### `make_caption(kind, params=None) -> CaptionState`

- **功能**：唯一合法构造点。kind 归一为枚举，params 逐值 `str()` 冻结（`MappingProxyType`），值为 None 的键丢弃。
- **输入**：`kind: CaptionKind | str`；`params: Mapping[str, object] | None`。
- **输出**：frozen `CaptionState{kind, params}`。
- **边界**：非法 kind → `ValueError`（程序员错误响亮失败；数据错误在 signal/from_payload 层降级 generic）。

#### `make_frame(state, text, transient=False) -> CaptionFrame`

- **功能**：帧构造器。`CaptionFrame{state: CaptionState, text: str, transient: bool}`——`text` 为规范显示值；`transient=True` 标记自衰减瞬态帧（tool_failed/turn_done/turn_failed 及 moa/subagent 类一次性提示），表面本地约 1.6s 后回落显示最近非瞬态帧。
- **边界**：`text` 非空 str（空则调用方以 generic 兜底后再构造）。

#### `CaptionFrame.to_payload() -> dict` / `from_payload(payload) -> CaptionFrame`

- **功能**：线边界。`to_payload` → `{"kind": …, "params": {...}, "text": …, "transient": bool}`；`from_payload` 返回 **CaptionFrame**（处置 S0-5——v3 的类型矛盾消除）。
- **边界**：未知 kind → state 降 generic、**text 原样保留**（显示真相不被样式降级破坏）；params 非 dict → 空；transient 非 bool → False；text 缺失 → 以 generic 模板兜底构造。任何畸形不抛。

### 3.2 `signal.py`

`SignalKind`：`TOOL_STARTED | TOOL_COMPLETED | TOOL_FAILED | REASONING | THINKING | TOOL_GENERATING | REPLYING | MOA | SUBAGENT | AWAITING_INPUT | TURN_DONE | TURN_FAILED | IDLE | UNKNOWN`。

`CaptionSignal{event, tool, subject, phase, detail, is_error, tool_call_id}`（`tool_call_id: str | None` 为核心关联字段，处置 S0-1）。

#### `caption_signal(event_type, name=None, preview=None, args=None, **kwargs) -> CaptionSignal`

- **功能**：progress 词汇归一化；显式收第 4 位置参数 args（忽略）；`tool.completed` 从 kwargs 读 `tool_call_id` 与 `is_error`（**依赖 §3.8 的 executor 补丁**）；词汇表外 → UNKNOWN；永不抛。
- **normative 映射**：

| event_type | SignalKind | 字段 |
|---|---|---|
| `tool.started` | TOOL_STARTED | tool, subject, tool_call_id=kwargs |
| `tool.completed` ∧ ¬is_error | TOOL_COMPLETED | tool, tool_call_id |
| `tool.completed` ∧ is_error | TOOL_FAILED | tool, tool_call_id |
| `tool.output_risk` | UNKNOWN | — |
| `reasoning*` 前缀 | REASONING | — |
| `moa.*` | MOA | phase, detail=name |
| `subagent.*` 前缀 | SUBAGENT | detail=name |
| 其他（含 None/空） | UNKNOWN | — |

### 3.3 `derive.py`

#### `derive_caption(signal) -> CaptionState`

- **功能**：单信号 → 状态的**纯查表**（无时钟/配置/随机）。角色定位（v4 收窄）：**一次性信号**（moa/subagent/reasoning/thinking/tool_generating/tool_failed）的 CaptionState 构造器，被 projector 内部调用；持续态（tool_running/awaiting_input/replying/idle）由 projector 从事实状态直接构造，不经此函数。
- **normative 矩阵**（兼测试矩阵）：

| SignalKind | kind | params |
|---|---|---|
| TOOL_COMPLETED | thinking | tool |
| TOOL_FAILED | tool_failed | tool |
| REASONING | reasoning | — |
| THINKING | thinking | — |
| TOOL_GENERATING | tool_generating | tool |
| REPLYING | replying | — |
| MOA | moa | phase, detail（可缺省） |
| SUBAGENT | subagent | detail |
| AWAITING_INPUT | awaiting_input | kind |
| TURN_DONE / TURN_FAILED | turn_done / turn_failed | — |
| IDLE | idle | — |
| TOOL_STARTED | tool_running | tool, subject（可缺省）——仅供无 projector 的裸调用 |
| UNKNOWN | generic | — |

- **边界**：枚举外 event → generic，不抛。

### 3.4 `verbs.py`（同 v3）

`verb_key(tool_name) -> str | None`（未注册返回 None）；`verb_connector`/`verb_drops_preview` 迁移自 display 三表（过渡期供 display 消费）；24 键一次性全量进 `captions.verb.*`，迁移期 parity 测试锁键集，迁移后删旧表。

### 3.5 `assemble.py`（渲染末端，唯一查 `t()` 处）

#### `verb_text(tool_name, lang=None) -> str`

链：注册 → `t(f"captions.verb.{tool}", lang)`；未注册 → `t("captions.verb.generic", lang)`；**闭合终点**：返回值==所查键（整体 miss）→ 返回工具原名。

#### `format_subject(state, lang=None) -> str`

免预览集合 → `""`；否则 `connector + subject`（connector 查 `captions.connector.for/plain`，zh 的 for 为空串）。**不截断**（信任上游 80 字符预算）；缺键当空串。

#### `render_caption(state, lang=None) -> str`

- **功能**：精确渲染（处置 #7）：
  1. `template = t(f"captions.{kind}", lang)`（不传 kwargs → 原始模板）；`template == 键` → 整体 miss → 用 `captions.generic` 模板重来；
  2. `needed = {fname for _, fname, _, _ in Formatter().parse(template) if fname}`——**占位符集合精确求取，不做输出 brace 扫描**（含 JSON 的 subject 是合法字幕）；
  3. 组装参数（词汇性预本地化：verb/kind；数据性原样：subject/tool/goal/detail/phase）；`needed ⊆ have` → `template.format_map(params)`；缺参 → generic 模板重来；内层仍兜 `try/except ValueError`（异常格式规格）→ generic。
- **输出**：非空 str，永不抛。词汇性占位符的**封闭集合**：`{verb, subject, tool, goal, detail, phase, kind}`。

### 3.6 `projector.py` —— `CaptionProjector`（核心）

```python
class CaptionProjector:
    def __init__(self, emit: Callable[[CaptionFrame], None]): ...
```

**事实状态**（私有，锁保护）：`in_flight: dict[str, RunningTool]`（call_id → {name, subject}，插入序=开始序）；`awaiting: dict[str, str]`（request_id → kind，处置 #9）；`stream_active: bool`；`turn_active: bool`；`last_cognitive: str | None`（"reasoning"|"thinking"|None）；`_last_visible: CaptionState | None`（仅去重比较，**无恢复语义**，处置 #11）；`_current: CaptionFrame | None`（最新非瞬态帧，重连用）。

**锁语义（处置 S0-3）**：单个 `threading.Lock`；每个 `on_*` 方法全程持锁（①mutate→②project→③render→④emit）。emit 是构造器注入的回调，在锁内调用——**理由**：帧 seq 在网关 `write_json` 打点，emit 顺序必须等于事实顺序，锁外 emit 会让两个线程的帧乱序到达、"高 seq 胜出"把乱序固化成永久错误状态。字幕事件率≈工具调用率，锁内 emit 无吞吐风险。

**投影规则**（`project() -> CaptionState`，纯读事实，优先级从高到低）：

1. `awaiting` 非空 → `awaiting_input(kind=最近打开者)`
2. `in_flight` 非空 → `tool_running(第一个开始且未完成的工具)`
3. `stream_active` → `replying`
4. `last_cognitive == "reasoning"` → `reasoning`
5. `turn_active` → `thinking`
6. 否则 → `idle`

**方法族**（每个：锁内 mutate → project → 可见态变化才 render+emit；或发瞬态帧）：

| 方法 | 事实更新 | 发帧 |
|---|---|---|
| `on_tool_started(call_id, name, subject)` | `in_flight[call_id]=…`；`stream_active=False`；`last_cognitive=None` | 投影（去重后） |
| `on_tool_completed(call_id, is_error)` | `in_flight.pop(call_id, None)`（**幂等**：重复完成无副作用；未知 id 不影响其他工具） | is_error → 瞬态 `tool_failed`（tool 取 pop 出的名字，无则缺省）+投影；否则投影 |
| `on_tool_generating(tool_name)` | 无 | 瞬态 `tool_generating` |
| `on_reasoning()` / `on_thinking()` | `last_cognitive` 置位 | 投影 |
| `on_stream_started()` | `stream_active=True`（幂等） | 投影（replying） |
| `on_awaiting_opened(request_id, kind)` | `awaiting[request_id]=kind` | 投影 |
| `on_awaiting_closed(request_id)` | `awaiting.pop(request_id, None)`（**旧 close 误不了新请求**） | 投影（事实：剩余 awaiting / in_flight / …） |
| `on_turn_started()` | `turn_active=True`；清 `in_flight`/`awaiting`；`stream_active=False`；`last_cognitive=None`（跨回合残留防御） | 投影 |
| `on_turn_ended(succeeded)` | `turn_active=False`；清同上 | 瞬态 `turn_done`/`turn_failed`；随后 `_current` 置为**事实投影 idle**（处置 #10：重连不服务过期瞬态） |
| `on_vocab_signal(signal)` | REASONING/THINKING 分派到上面对应方法；MOA/SUBAGENT 发瞬态帧 | TOOL_*/AWAITING/TURN 类信号到达 → 记 debug 忽略（防与专用方法双路，v3 分流守卫的 projector 化） |

- `current_frame() -> CaptionFrame | None`：锁内读 `_current`（重连服务用；瞬态帧**不进入** `_current`）。
- **边界**：全部方法对任意数据输入不抛（内部 try/except → debug 日志）；emit 回调抛异常不得影响事实状态（捕获记日志）。

### 3.7 `agent/pet/caption_tone.py`（处置 #13）

`caption_tone(kind: CaptionKind) -> PetState`：静态映射（tool_running/tool_generating/moa/subagent/generic/replying→RUN，reasoning/thinking→REVIEW，awaiting_input→WAITING，tool_failed/turn_failed→FAILED，turn_done→WAVE，idle→IDLE）。依赖方向 pet→captions 单向；captions 核心不 import pet。

### 3.8 接线

**executor 补丁（P0 前置，处置 S0-1）**：`tool_executor.py` 两条完成路径的 `tool_progress_callback("tool.completed", …)` 各补 `tool_call_id=tool_call_id` kwarg（作用域内已有；附加 kwargs 不破坏现有消费者）。配 mock 捕获测试。

**网关 `captions_relay.py`**（薄适配）：每会话 projector 存 `_sessions[sid]["captions"]`，emit 回调 = `_emit("caption.update", sid, frame.to_payload())`。入口族：`relay_progress`（首行守卫：`tool.started` 直接 return；其余经 `caption_signal` → `on_vocab_signal`，`tool.completed` 分派到 `on_tool_completed`）；`relay_tool_start`（挂 `_on_tool_start`，subject 取 `context`——**来源由核查清单 #4 决定**：`_tool_ctx` 已证脱敏则复用，否则 `build_tool_preview(name, display_args)`）；`relay_tool_gen`/`relay_awaiting(opened/closed)`/`relay_turn_*`（挂钩点见核查清单 #2/#3/#5）。开关 `display.captions.enabled`。重连：`session.events.since` 响应附 `caption_current`（`current_frame()` 的 payload 或 null，处置 #8）。

**CLI**：同样持有 projector（`emit=lambda f: setattr(self, "_spinner_text", f.text)`）；`_on_tool_progress` 适配分派（处置 S0-4）；`_pet_react_turn_end` 接 `on_turn_ended`。Slack：`render_caption(state, "en")`。

### 3.9 locale（normative 键集 + 占位符法定表）

键集同 v3（12 个 kind 模板 + 24 动词 + generic 动词 + 2 连接词 + 4 个 awaiting_kind）。**每键法定占位符**（测试期用 `Formatter().parse` 逐 locale 断言，处置 #7）：

| 键 | 法定占位符 |
|---|---|
| `tool_running` | `{verb, subject}` |
| `tool_failed` / `tool_generating` | `{tool}` |
| `moa` | `{phase, detail}` |
| `subagent` | `{detail}` |
| `awaiting_input` | `{kind}` |
| 其余 kind 模板、连接词、awaiting_kind、动词 | ∅ |

翻译策略：en+zh 真翻译；15 locale 同 PR 机械化英文占位（parity 保持绿）。**显式警告（处置 #15）**：键 parity 绿 ≠ i18n 完成；英文文案变更**不会**自动传播到 15 份占位副本，需人工同步或重跑复制脚本；"namespace 级 fallback 豁免"为已登记提案，待 i18n 政策所有者决定，本模块不单方修改仓级 parity 测试。

## 4. 不变式（跨函数契约，测试锚点）

| # | 不变式 | 检验 |
|---|---|---|
| I1 | `derive_caption` 纯函数 | test_derive |
| I2 | signal/derive/render/from_payload 对任意数据输入永不抛；render 输出非空 | fuzz 用例 |
| I3 | 整值：每帧完整 `{kind, params, text, transient}`，无增量 | relay/projector 测试 |
| I4 | 进程内非法 kind 响亮失败；线边界未知 kind 降 generic **但 text 保留** | test_state |
| I5 | 载荷不含 seq；表面按帧 seq 取最新 | relay/replay 测试 |
| I6 | 渲染回退链闭合：verb.<tool>→verb.generic→en→工具原名；模板 miss/缺参→generic（**占位符集合精确判定，无 brace 扫描**） | test_assemble + test_locale |
| I7 | 词汇性参数渲染端本地化、数据性原样；占位符种类封闭 | test_assemble/test_locale |
| I8 | text 是规范显示值：TS 表面默认零渲染；重渲染是可选增强 | 表面验收 |
| I9 | **事实与显示分离**：任何事件（含 awaiting 期间）都更新事实状态；优先级只影响投影 | test_projector |
| I10 | **emit 顺序 == 事实顺序**（锁内 emit）；并发 start/complete 交错后最终帧与串行重放一致 | test_concurrent_* |
| I11 | 瞬态帧不进入 `current_frame`；重连服务事实投影而非过期瞬态 | test_projector + relay |
| I12 | captions 核心不 import pet（tone 映射在 pet 侧） | import 检查测试 |

## 5. TDD 计划

### 5.1 红—绿—重构顺序

| 步 | 先写的失败测试 | 实现到绿 |
|---|---|---|
| 1 | test_state.py（State/Frame/payload 往返含 text/transient） | state.py |
| 2 | test_signal.py（矩阵 + 第 4 位置参数 + tool_call_id kwarg 归一） | signal.py |
| 3 | test_derive.py 矩阵 | derive.py |
| 4 | test_i18n parity + **test_locale_placeholder_vocabulary**（Formatter().parse 逐键断言法定占位符） | en+zh 真翻译 + 15 占位 |
| 5 | test_assemble.py | assemble.py |
| 6 | test_verbs.py（迁移 parity） | verbs.py + display 切换 |
| 7 | **test_projector.py（核心，§5.2）** | projector.py |
| 8 | tests/…/test_tool_executor_caption_id.py（两条路径 kwargs 捕获） | executor 补丁 |
| 9 | test_captions_relay.py | relay + server 装配 |
| 10 | tests/cli/test_cli_captions.py | cli.py 接线 |
| 11 | 手动验收 §5.4 | 表面消费 |

### 5.2 关键用例（命名即验收）

`test_projector.py`（建议新增用例全部纳入，标 ★）：

- ★ `test_completed_while_awaiting_updates_truth_but_emits_nothing` — A.start→approval.open→A.complete：零 tool 帧，但 close 后字幕非 A（v3 S0-2 场景）。
- ★ `test_parallel_same_tool_name_correlated_by_call_id` — 同名并发两调用，按 id 各自移除。
- ★ `test_duplicate_completion_is_idempotent`。
- ★ `test_unknown_completion_id_does_not_remove_other_tool`。
- ★ `test_concurrent_start_complete_is_serialized` — 多线程交错压入随机 start/complete，最终 `current_frame` == 串行重放同序列的结果（I10）。
- ★ `test_second_reply_segment_after_tool_emits_replying_again` — delta→tool→delta 二次触发 replying。
- ★ `test_awaiting_close_for_old_request_does_not_close_new_request`。
- ★ `test_transient_frames_do_not_become_current`；`test_current_frame_is_fact_projection_after_turn_end`（idle 而非 turn_done）。
- `test_projection_priority_matrix` — §3.6 六级优先级参数化。
- `test_dedupe_visible_state` — 同态重复事件零冗余帧。
- `test_on_vocab_signal_ignores_lifecycle_signals`（防双路）。
- `test_emit_callback_exception_does_not_corrupt_state`。

`test_assemble.py`：★ `test_subject_containing_json_braces_does_not_fallback`（'{"foo": 1}' 原样出现在输出）；`test_missing_placeholder_falls_back_to_generic`（精确检测而非扫描）；`test_template_miss_falls_back_to_generic_copy`；`test_verb_text_key_miss_falls_back_to_tool_name`；`test_render_tool_running_zh_and_en`；`test_render_never_empty`。

`test_locale`：`test_placeholder_vocabulary_per_locale`（每 locale 每键占位符集==法定表）；`test_parity_all_locales_have_captions_keys`（既有门）。

`test_captions_relay.py`：`test_relay_progress_ignores_tool_started`；`test_frame_shape_whole_value_with_text_and_transient`；`test_disabled_emits_nothing`；`test_tool_start_subject_source_follows_checklist4`（两条来源路径参数化）；★ `test_caption_current_survives_event_ring_eviction`（灌满环形缓冲淘汰旧字幕帧后，`session.events.since` 响应仍带 caption_current）；★ `test_preview_redacts_secret_before_cross_surface_emit`（**条件于核查清单 #4**：注入含 token 的 args，断言线上 text 不含 token——若来源路径无法保证则该测试驱动 relay 层补脱敏）；`test_replay_orders_and_last_wins`；`test_internal_errors_swallowed`。

`test_state/signal/derive/verbs/cli` 同 v3 相应用例（state 增 `test_from_payload_returns_frame_with_text`、`test_unknown_kind_degrades_but_keeps_text`；signal 增 `test_completed_carries_tool_call_id`）。

`tests/…/test_tool_executor_caption_id.py`：mock 捕获两条完成路径的 `tool_progress_callback` 调用，断言 kwargs 含 `tool_call_id` 且值等于该次调用的 id。

### 5.3 验收门（DoD）

§5.1 全绿；parity 绿（15 为登记占位）；display 旧路径既有测试不回归；核查清单 5 项已核并回填文档；`test_preview_redacts_secret_before_cross_surface_emit` 绿或其前置清单项明确结论。

### 5.4 表面手动验收

同 v3（TUI/web 显示 text、重连恢复当前字幕含环形淘汰场景；桌面 pet-bubble 真实字幕 + idle/awaiting 变体轮换；`grep -r "crunching\|hit a snag" apps/desktop/src` 零命中；Slack 同源；FAILED 表情与"出错了"同帧）。

### 5.5 P4（可选）LLM 智能字幕预留

`refine_caption(state, tool_result_summary, llm_call) -> CaptionFrame`：规则帧先显示，LLM 晚到**替换同位 text**、新工具事件即废；`min_tool_seconds` 节流。仅防接口漂移。

## 6. 风险、非目标与动工前核查清单

- **非目标**：帧合并；SessionDB 持久化（内存投影除外）；TUI i18n（消费 text 天然跟随会话语言）；tool.output_risk 入字幕；服务端瞬态定时器（表面自衰减）。
- **风险**：占位翻译债与英文漂移（§3.9 显式警告 + 复制脚本可重跑）；多语言用户共享会话语言（§1 偏离声明；桌面可重渲染缓解）；emit 在锁内（速率≈工具调用率，可接受；若未来高频化再引入每会话队列——届时按 S0-3 原方案演进）；projector 每会话内存（一个 dataclass + 锁，可忽略）。
- **动工前核查清单（5 项，未核不得进步骤 9/11）**：
  1. `subagent.*` 回调精确词表（`server.py::_agent_cbs` 实测）；
  2. 网关回合边界帧（`on_turn_started/ended` 接线：`message.complete` 还是另有 turn 生命周期帧）；
  3. assistant 流式首 delta 网关挂钩点（`on_stream_started`）；
  4. **`_tool_ctx` 是否统一脱敏**（决定 `relay_tool_start` 的 subject 来源：复用 context 或 `build_tool_preview`；同时驱动 `test_preview_redacts_secret_*` 的基线）；
  5. clarify/approval/sudo/secret 帧中 request_id 的可得性（`awaiting` 按 id 关联的前提）。

## 7. 附录：文件索引

mozi：信号源 `agent/tool_executor.py`（started `:1055`、completed 并行 `:1865`/串行 `:2779`、complete_callback `:1891/:2793`、线程池 `:1520`、mixed `:2865`）、`agent/conversation_loop.py:6904`、`run_agent.py:475-491`；网关 `tui_gateway/server.py`（`write_json:2478`、`_on_tool_start:7606`、`_on_tool_progress:7687`、`_on_tool_complete:7640`、`_agent_cbs:7929`、`event_replay.py`）；素材 `agent/display.py`（`_TOOL_VERBS:627`、`build_tool_preview:446`（内部 redact `:449`）、`build_status_phrase:762`）、`cli.py:14426/20570`、`apps/desktop/src/components/pet/pet-bubble.tsx`；i18n `agent/i18n.py:232-273`、`locales/*.yaml`、`tests/agent/test_i18n.py:45`；pet `agent/pet/state.py`。

DSH（被借鉴模式与**显式偏离点**）：`packages/core/session/src/types.ts`（信封/词表/整值）、`packages/session/session-projection/`（单点计算——v4 的 CaptionProjector 即其"事实折叠+投影"思想的逐会话微缩版）、`docs/cookbook/adding-a-tool.md` 与 `2026-08-23-client-derived-tool-presentation.md`（client-owned presentation——本模块**有意不采用**，见 §1）、`2026-08-23-locale-owned-client-ui-copy.md`、`packages/session/session-title*`。
