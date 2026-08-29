这份 v3 已经比“直接把几个 status string 拼起来”成熟很多，但**还不适合直接进入实现阶段**。基于文档本身做一致性审查，我认为至少有 **5 个阻断级错误、6～8 个高风险设计缺口**。其中最严重的不是文案/i18n，而是**并发状态机目前并没有真正闭合**。

## 一、我认为必须先修的阻断级错误

| 严重度    | 问题                                                           | 为什么是错误                                     | 建议                                  |
| ------ | ------------------------------------------------------------ | ------------------------------------------ | ----------------------------------- |
| **S0** | `in_flight` 用 `tool_call_id` 做 key，但 completion 入口没有 tool id | 状态机根本不知道该删 A 还是 B                          | 完成事件必须携带稳定 `tool_call_id`           |
| **S0** | awaiting 期间直接丢 `tool.completed`                              | UI 虽然不变，但内部状态也不更新，关闭 awaiting 后会恢复到已经结束的工具 | **状态更新与字幕发布必须分离**                   |
| **S0** | 真并行，但 `RelayState` 没有并发串行化机制                                 | dict 单操作原子≠start/remove/select/emit 整个事务原子 | 每 session 串行 event projector 或 lock |
| **S0** | CLI 被假定成“单工具串行视图”                                            | 与文档前面“工具真并行”直接冲突                           | CLI 和 gateway 必须复用同一个 projector     |
| **S0** | `CaptionState` 不包含 text，但 `from_payload` 又要求保留 text          | 类型模型无法满足自己的规格                              | 拆成 `CaptionState` 和 `CaptionFrame`  |

下面逐个说。

---

# 1. 最严重的问题：完成事件无法正确关联 `in_flight`

你定义：

```python
in_flight: dict[str, tuple[str, str]]
# tool_call_id -> (name, subject)
```

并要求：

> `tool.complete` 移除后若仍有在跑工具……



但 `relay_progress` 的契约却是：

```python
relay_progress(
    sid,
    event_type,
    name=None,
    preview=None,
    args=None,
    **kwargs
)
```

没有明确 `tool_call_id`。

而且你前面已经核实的 `tool_progress_callback` 契约也是：

> 4 个位置参数 `(event_type, name, preview, args)` + kwargs

没有证明 kwargs 中一定存在 `tool_call_id`。

这不是“小遗漏”，而是**当前状态机无法实现**。

例如：

```text
call-001 search(...)
call-002 search(...)

tool.completed name="search"
```

你不能用 `name` 删除，因为两个并发调用名字相同。

### 应改成

在动工前核查清单里增加一个 **S0 前置条件**：

```text
必须找到 completion/error callback 中稳定的 tool_call_id。
```

如果原 callback 没有，就应该从 `tool_executor` 往 callback 契约中补：

```python
tool_progress_callback(
    event_type,
    name,
    preview,
    args,
    tool_call_id=call_id,
    ...
)
```

然后统一：

```python
CaptionSignal.tool_call_id: str | None
```

这应该成为核心字段，而不是只存在 relay_tool_start。

---

# 2. `awaiting` 的“抑制”设计会破坏内部真实状态

现在规则写的是：

> awaiting 非 None 期间，relay 丢弃一切非终态信号（tool/moa/subagent/reasoning/replying）。



随后关闭 awaiting：

> 有工具 → 回落 tool_running；无 → thinking。



这里有一个经典状态机错误：

**你把“不要显示”与“不要处理事件”混成了一件事。**

例如：

```text
A.start
→ in_flight = {A}

approval.open
→ awaiting = approval

A.complete
→ 被 awaiting guard 丢掉

approval.close
→ in_flight 还是 {A}

字幕：
正在运行 A…
```

但实际上 A 已经运行完了。

所以 B5 的修正仍然没有真正解决并发，只解决了“视觉上不要盖掉 awaiting”。

### 正确模型应该是

```text
Event
  ↓
update_truth_state()
  ↓
project_visible_caption()
  ↓
if visible caption changed:
    emit()
```

也就是：

```python
def handle(event):
    mutate_runtime_state(event)   # 永远处理
    caption = project(state)      # awaiting 在这里决定优先级
    maybe_emit(caption)
```

而不是：

```python
if awaiting:
    return
```

这可能是整份 v3 最值得优先修改的地方。

---

# 3. 已知是真并行，却没有任何串行化边界

文档自己确认：

> `DaemonThreadPoolExecutor(max_workers=…)`
>
> mixed parallel/sequential segments

也就是 callback 可能真正从不同线程并发到达。

但 `RelayState` 只有：

```python
dict
str | None
bool
last
```

没有：

```python
Lock
RLock
asyncio.Queue
event loop serialization
actor/mailbox
```



假设：

```text
Thread A: A.complete
Thread B: B.start
```

逻辑其实是多个步骤：

```python
remove(A)
check in_flight
choose visible tool
render
emit
```

哪怕 CPython 的 `dict.pop()` 本身安全，也不意味着这五步是一个原子事务。

甚至可能：

```text
A.complete:
  pop A
  sees empty

B.start:
  add B
  emit B

A.complete:
  emit thinking
```

最终高 seq 反而是：

```text
thinking
```

而 B 正在运行。

于是你强调的：

> 高 seq 胜出

反而把 race condition **永久固化成错误状态**。

### 更好的方案

我更推荐不要加大量细粒度锁，而是：

```text
callback threads
      ↓
per-session CaptionProjector queue
      ↓
single consumer
      ↓
state transition
      ↓
emit
```

或者至少：

```python
with state.lock:
    mutate
    project
    build_frame
# 再 emit
```

而且需要明确 `_emit/write_json` 的排序边界。

---

# 4. CLI 的设计与前文的“真并行”直接冲突

§3.6 写：

> CLI 为单工具串行视图，直接用无状态推导，不引 RelayState。



但前面已经确认 `tool_executor` 真并行。

除非你已经源码证明：

```text
CLI callback 前另有串行化 / flatten
```

否则这个结论是不成立的。

例如 CLI 同样可能：

```text
A.start
正在 A

B.start
正在 B

A.complete
思考中…
```

此时 B 明明仍然运行。

也就是说：

**Gateway 修了并行，CLI 又重新制造同一个 bug。**

而这还违反了你自己定义的：

> 全模块唯一“活动 → 字幕语义”决策点。



### 建议架构调整

不要叫：

```text
tui_gateway/captions_relay.py
    RelayState
```

而应该抽出：

```text
agent/captions/
    state.py
    signal.py
    derive.py
    assemble.py
    projector.py     ← 真正状态机
```

例如：

```python
CaptionProjector
```

负责：

```text
in_flight
awaiting
reply stream
turn lifecycle
visible priority
dedupe
```

然后：

```text
CLI       ─┐
Gateway   ─┼→ CaptionProjector
Slack     ─┘
```

Gateway 的 `captions_relay.py` 只负责：

```text
projector output → WS frame
```

这才是真正的“宿主唯一计算点”。

---

# 5. `CaptionState` 与 `text` 的数据模型存在自相矛盾

你定义合法状态：

```text
CaptionState{kind, params}
```



但又规定：

```json
{
  "kind": "...",
  "params": {},
  "text": "..."
}
```

并且：

> from_payload 遇未知 kind 降 generic，**但 text 原样保留**。



问题是：

```python
from_payload(...) -> CaptionState
```

而 `CaptionState` 根本没有 `text`。

那“保留 text”保存在什么地方？

这在类型层面无法成立。

### 建议明确拆成两层

```python
@dataclass(frozen=True)
class CaptionState:
    kind: CaptionKind
    params: Mapping[str, str]
```

以及：

```python
@dataclass(frozen=True)
class CaptionFrame:
    state: CaptionState
    text: str
```

或 wire-specific：

```python
@dataclass(frozen=True)
class CaptionPayload:
    kind: str
    params: dict[str, str]
    text: str
```

这样：

```python
derive() -> CaptionState
render() -> text
make_frame(state, text) -> CaptionFrame
```

`from_payload()` 返回 `CaptionFrame`，逻辑才闭合。

---

# 6. `replied: bool` 的粒度其实不对

当前设计：

> 回合内首个 assistant delta 发一次 replying，之后不发；回合结束才复位。



考虑一个典型 agent turn：

```text
assistant delta
→ replying

tool A start
→ tool_running

tool A complete
→ thinking

assistant delta
→ 由于 replied=True，不再 emit replying
```

于是 UI 会在模型已经继续输出的时候仍然显示：

```text
思考中…
```

所以这里真正需要的不是：

```python
replied: bool
```

而是类似：

```python
assistant_stream_active: bool
```

或者更好：

```python
phase / activity epoch
```

每个新的 assistant stream segment 都能：

```text
false → true → emit replying
```

工具开始时：

```text
assistant_stream_active = False
```

下一段输出重新触发 replying。

---

# 7. `render_caption()` 用“出现 `{`/`}`”判断模板失败，会误杀正常内容

当前规则：

> 渲染结果若仍含 `{`/`}` → generic。



但 subject 本来就是数据。

工具完全可能处理：

```text
{"foo": 1}
```

例如：

```text
正在编辑 {"foo": 1}…
```

这是完全合法的字幕。

现在却会因为里面存在 `{` 和 `}` 被判定为：

```text
处理中…
```

这是一个确定性的 false positive。

### 不应该检查最终字符串有没有 brace

应该检查**模板本身**的 placeholder 是否完整。

最干净的办法是在 locale 测试阶段做：

```python
Formatter().parse(template)
```

然后断言：

```text
captions.tool_running placeholders
== {"verb", "subject"}
```

运行期只格式化。

或者实现 `safe_format()` 精确捕获缺参数，而不是搜索最终输出字符。

---

# 8. “环形缓冲能恢复最新字幕，因此无损”这个结论是错的

风险部分写：

> 环形缓冲截断（字幕单条最新值，无损）。



这实际上不成立。

假设字幕最后一次变化：

```text
seq=100 caption.update tool_running
```

随后 agent 输出了大量其他事件：

```text
seq=101...10000
```

环形缓冲长度假设 2000，那么：

```text
seq=100
```

早已经被淘汰。

客户端重连：

```text
session.events.since(...)
```

根本恢复不到当前字幕。

所以：

> “字幕是单条最新值”

并不能推出：

> “环形缓冲无损”。

恰恰因为它更新频率低，更容易被其他高频事件挤出去。

### 如果真的要求重连恢复当前状态

应该有一个 session projection：

```python
session.caption_current
```

它不是 SessionDB 持久化，可以只是内存投影。

重连时：

```text
1. replay events
2. 或直接返回 current projections
```

这与“字幕不写 SessionDB”并不冲突。

---

# 9. `awaiting: str | None` 太弱，容易被旧 close 事件误关

当前只记录：

```python
awaiting: str | None
```



但真正的等待通常有身份：

```text
approval request A
approval request B
sudo request C
```

如果发生：

```text
open A
open B
close A
```

单个字符串无法判断 `close A` 是否应该关闭当前 B。

至少应该是：

```python
AwaitingState(
    request_id,
    kind,
)
```

如果系统保证绝不嵌套，也应该把这个保证写成 invariant + test，而不是默认假设。

---

# 10. `idle` 被定义，却没有完整生命周期

你有：

```text
idle
turn_done
turn_failed
```



还有：

> turn_done 瞬时展示约 1.6s。



但是规格没有明确：

```text
turn_done
   ↓ 1.6s
idle
```

由谁负责？

客户端 timer？

server emit idle？

pet timer？

如果重连发生在这 1.6 秒中间呢？

如果客户端没有 timer 呢？

所以现在 terminal state 生命周期仍然不完整。

建议把“事实状态”和“瞬时视觉 effect”分开：

```text
caption activity = idle
effect = turn_done flash
```

否则 `turn_done` 被当成 durable current state 会很别扭。

---

# 11. `last` 字段定义了，但整个状态机实际上没有定义它的语义

```python
last: CaptionState | None
# 抑制结束后回落用
```



但 awaiting 关闭的 normative 行为却是：

```text
有 in_flight → tool_running
否则 → thinking
```



那么 `last` 到底什么时候：

```text
写？
读？
失效？
```

没有说明。

而“恢复 last”本身通常也是危险的，因为 last 很可能已经过期。

例如：

```text
last = replying
awaiting
turn completed
awaiting closed
```

恢复 replying 就错。

我建议**删掉 `last`**。

不要恢复历史 UI：

```python
visible = project(current_truth_state)
```

永远根据当前事实重新推导。

---

# 12. “subject 已脱敏”在本文证据链里没有真正闭合

文档声称：

> subject 是已脱敏截断的上游预览。



但前面的“已核实事实”只明确说：

> `_tool_ctx(name,args)` 是 80 字符显示预览。



在这份文档提供的证据中，并没有证明：

```text
_tool_ctx == secret-safe/redacted
```

这很重要，因为字幕会扩散到：

```text
CLI
TUI
desktop
Slack
web
```

尤其 Slack 是跨边界输出。

因此 §6 的开工核查清单应该再加：

```text
4. _tool_ctx/build_tool_preview 是否对
   secret/token/password/header/path/query
   做统一 redaction？
```

如果没有，应有一个**中央 display-safe preview** 层，而不是字幕模块自行猜。

---

# 13. `KIND_TONE -> PetState` 是一个不必要的反向耦合

你定义：

```python
KIND_TONE: Mapping[CaptionKind, PetState]
```

同时又说：

> pet 各表面仍以自身信号为准，此表仅供未来统一。



既然现在并不是权威来源，就不应该让 captions 核心数据模型依赖 PetState。

否则很容易变成：

```text
caption → pet
pet → activity
activity → caption
```

形成概念或 import 环。

建议：

```text
caption 核心模块不知道 PetState。
```

需要一致性时在 adapter 中：

```python
caption_kind_to_pet_tone(kind)
```

甚至最好两者都投影自同一个：

```python
AgentActivityState
```

而不是 caption 去解释 pet。

---

# 14. 现在的 v3 事实上已经偏离了它声称借鉴的 DSH 原则

这是一个很有意思的内部矛盾。

附录把 DSH 模式描述为：

> client-derived tool presentation / **呈现不入传输层**。



但 v3 明确决定：

```json
{
  "kind": "...",
  "params": {},
  "text": "已经渲染完成的本地化文案"
}
```

而且 TS 默认直接显示 `text`。

也就是说：

**本地化 presentation text 正式进入了 transport。**

这不一定是坏设计。

实际上针对 Mozi 的多端一致性，我甚至认为这种取舍**可以是合理的**。

问题在于文档现在一边说：

```text
借鉴 DSH：呈现不入传输层
```

一边实际设计：

```text
presentation text 就放在线协议里
```

应该明确写成：

> **这里有意不采用 DSH 的 client-owned presentation 原则。Mozi 选择 host-rendered canonical text，以换取 CLI/TUI/Web/Desktop/Slack 一致性。**

这样它才是一个明确的 architecture decision，而不是似乎仍然遵循 DSH。

---

# 15. 15 个 locale 复制英文，是短期可接受但长期错误的债务实现方式

现在：

> en+zh 真翻译，其余 15 locale 机械复制英文，以保持 parity。



这能让测试变绿，但它制造的是一种**假 parity**：

```text
key parity = green
translation correctness = unknown
```

更麻烦的是以后英文修改：

```yaml
en:
  replying: "Responding…"
```

15 个复制版本不会自动更新。

如果 i18n 架构允许，我更推荐：

```text
缺少 captions.*：
locale → en fallback
```

测试改为：

```text
en 必须完整
zh 必须完整
其他 locale 可以 fallback，但不能 malformed
```

而不是复制 15 份英文。

如果现有 i18n 的 parity 机制必须全键，则可以暂时保持现方案，但至少不要把：

```text
parity green
```

当成：

```text
i18n 完成
```

---

# 我建议把核心架构从 RelayState 改成 `CaptionProjector`

这是我认为最有价值的一次结构调整。

当前思想是：

```text
Signal
→ derive_caption
→ RelayState 部分拦截
→ render
```

我建议改为：

```text
Raw callback
     │
     ▼
normalize_event()
     │
     ▼
CaptionProjector
  ├─ tools: call_id → RunningTool
  ├─ awaiting: AwaitingRequest | None
  ├─ assistant_stream_active
  ├─ turn_status
  └─ activity ordering
     │
     ▼
project_caption()
     │
     ▼
CaptionState(kind, params)
     │
     ▼
render_caption()
     │
     ▼
CaptionFrame(state, text)
```

最大的区别是：

> **所有事件都先更新事实状态；priority 只决定“显示什么”，绝不决定“哪些事实事件被丢掉”。**

这样很多复杂性会一次消失。

---

## TDD 也应该补几类目前缺失的测试

现有测试计划已经相当不错，特别是并行 A/B 和 awaiting 抑制测试。

但当前测试甚至会把一个错误行为锁死：

```text
awaiting 时 tool.completed → 零帧
```

“零帧”没问题，问题是还应该验证：

```text
内部 in_flight 已更新。
```

我建议 v4 至少再增加这一组测试：

* `test_completed_while_awaiting_updates_truth_but_emits_nothing`
* `test_parallel_same_tool_name_correlated_by_call_id`
* `test_duplicate_completion_is_idempotent`
* `test_unknown_completion_id_does_not_remove_other_tool`
* `test_concurrent_start_complete_is_serialized`
* `test_second_reply_segment_after_tool_emits_replying_again`
* `test_subject_containing_json_braces_does_not_fallback`
* `test_awaiting_close_for_old_request_does_not_close_new_request`
* `test_caption_current_survives_event_ring_eviction`
* `test_preview_redacts_secret_before_cross_surface_emit`

---

# 最后的判断

如果按严重度排序，我会这样处理：

**第一批必须在写代码前修：**

`tool_call_id → awaiting 状态更新 → session 并发串行化 → CLI/Gateway 共用 projector → CaptionState/Frame 类型拆分。`

这五项不解决，TDD 写得越多，越可能只是把错误架构固定下来。

第二批紧接着修：

`replied bool → stream phase`、brace 检测、awaiting request_id、idle/turn_done 生命周期、ring-buffer 重连语义。

剩下的 `KIND_TONE`、15 locale 英文占位、DSH 原则表述等可以作为架构清理项。

所以我的评价不是“v3 推翻重写”，而是：**整体方向已经对了，尤其“纯 derive + 有状态聚合”的分层是对的；真正的问题是状态机还停留在‘字幕抑制器’，尚未升级成‘事实状态投影器’。** 一旦把 `RelayState` 重构为通用 `CaptionProjector`，CLI、Gateway、并行、awaiting、replying、重连这几条线会同时变得更干净。

我建议下一版直接定为 **v4：CaptionProjector 状态投影模型**，而不是继续给现有 `RelayState` 打补丁。
