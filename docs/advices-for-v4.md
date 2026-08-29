这份 v4 已经不是“方向性方案”，而是接近可以实现的工程规格了。上一版最关键的五个 S0 问题基本都修到了正确方向：`tool_call_id` 补齐、事实状态与显示优先级分离、CLI/网关共用 `CaptionProjector`、`CaptionState/CaptionFrame` 拆分，以及跨线程状态统一进 projector。

但继续做一次更苛刻的设计审查，我认为 **v4 仍有 4 个应该在动工前解决的问题，以及若干适合在 v5 收口的问题**。最大的风险已经从“状态机会算错”转成了“协议和并发边界没有完全闭合”。

## 一、最高优先级：`transient` 设计现在仍然是不闭合的

目前定义：

> `CaptionFrame{state, text, transient}`，`transient=True` 的帧由客户端约 1.6 秒后回落到最近非瞬态帧。



同时 projector 规定：

```text
tool_failed → 发 transient + 投影
turn_done   → 发 transient，然后 _current=idle
MOA         → transient
subagent    → transient
```



这里有一个很大的协议漏洞。

假设：

```text
A tool fails

seq 100: tool_failed transient
seq 101: thinking stable
```

如果客户端遵循“高 seq 胜出”，失败字幕几乎瞬间消失。

如果客户端为了显示 1.6 秒而故意压住 seq 101，那么客户端已经不再是简单的：

```text
latest seq wins
```

而实际上拥有了一个第二状态机：

```text
base caption
+
transient overlay
+
timer
+
pending stable state
```

这和 I5：

> 表面按帧 seq 取最新

实际上已经冲突。

CLI 问题更加明显：

```python
emit=lambda f: setattr(self, "_spinner_text", f.text)
```



它没有“1.6 秒之后恢复 previous stable caption”的 reducer。

所以当前 transient 在不同 surface 上极可能出现：

```text
CLI        瞬态立即被覆盖
Desktop    自己维护 timer
Web        另一套 timer
TUI        又一套
```

最后又形成你一开始非常想消灭的“多端镜像状态机”。

### 我建议不要再让 `transient` 只是 CaptionFrame 的一个 bool

最好明确分两条逻辑通道：

```text
CaptionSnapshot
    当前事实状态
    durable in memory
    reconnectable

CaptionEffect
    tool_failed
    turn_done
    moa notice
    ...
    transient / TTL
```

协议可以变成：

```text
caption.update   → 当前事实字幕
caption.effect   → 闪现效果
```

例如：

```python
CaptionSnapshot(
    state,
    text,
)

CaptionEffect(
    kind,
    text,
    ttl_ms=1600,
)
```

这样：

```text
tool failure
↓
更新事实：thinking
↓
caption.update(thinking)
+
caption.effect(tool_failed, ttl=1600)
```

客户端 UI 是：

```text
effect 存在 → overlay effect
否则       → snapshot
```

这才真正闭合。

而且：

```text
caption_current
```

只保存 Snapshot，天然不会把过期 effect 用于重连。

这是我认为 v4 最值得再做的一次结构修正。

---

# 二、`emit()` 全程持 `threading.Lock` 是一个危险的工程决策

现在明确规定：

> mutate → project → render → emit 全程持锁。

理由是必须保证：

> emit 顺序 == 事实顺序。



这个动机完全正确，但**把任意外部 callback 放在内部状态锁里执行**不是一个理想的实现。

比如：

```python
with self._lock:
    mutate()
    frame = project()
    self._emit(frame)
```

如果 `_emit()` 内：

```text
write_json
logging
websocket bookkeeping
session handling
```

未来任何一层间接调用：

```python
projector.current_frame()
```

就会再次：

```python
acquire(self._lock)
```

因为你规定的是普通：

```python
threading.Lock
```

不是 RLock。

结果就是直接自锁死。

即使没有重入，网络/stdio/复杂 callback 卡顿，也会把同 session 所有字幕事实更新卡住。

因此：

> “字幕事件率很低，所以锁内 emit 没性能问题”



解决的是吞吐量问题，却没有解决：

```text
reentrancy
callback unpredictability
failure isolation
```

### 更合理的是两阶段提交

projector 内产生：

```python
Emission(
    revision=n,
    frame=...
)
```

锁保护：

```text
mutate
project
revision += 1
构造 frame
更新 current
```

然后释放锁。

之后：

```text
emit(revision, frame)
```

为了防两个线程 emit 乱序，有两个很轻量的方案。

方案 A，我更推荐：

```python
_state_lock
_emit_lock
```

即：

```text
state lock:
    mutate/project
    assign revision

emit lock:
    按 revision 顺序 write_json
```

这里没有 per-session worker/thread。

比 v4 否定的完整 queue 方案轻很多，但也不会在核心状态锁里执行外部 callback。

另一个方案是 payload 直接增加：

```json
"caption_rev": 27
```

这样就算外围传输偶发乱序，caption consumer 仍然可以：

```text
higher caption_rev wins
```

外层 `seq` 负责 session event ordering；

`caption_rev` 负责 caption projection ordering。

我甚至建议两者都做，因为 `caption_rev` 调试并发问题特别有价值。

---

# 三、仅有 Lock 还没有解决“跨 turn 的迟到事件”

v4 的：

```python
on_turn_started():
    turn_active=True
    clear in_flight
    clear awaiting
    stream_active=False
    ...
```



可以清除旧状态。

但是它不能解决：

> **旧回合 callback 在新回合开始以后才到达。**

例如：

```text
Turn 17:
 A.start

Turn 17 end

Turn 18 start
 projector.clear()

---- thread scheduling delay ----

Turn 17 的 reasoning callback 到达
```

现在它会：

```python
last_cognitive = "reasoning"
```

于是污染 Turn 18。

更糟糕：

```text
Turn17 的 tool.started 迟到
```

会重新塞进：

```python
in_flight
```

然后 UI 会显示：

```text
Turn18 正在运行 Turn17 的工具
```

Lock 无法解决这个问题，因为：

> Lock 只保证访问串行，不保证事件属于正确的逻辑 epoch。

### 应增加 `turn_epoch`

Projector：

```python
turn_epoch: int
```

turn start：

```python
turn_epoch += 1
```

进入长期异步工作的事件携带：

```python
event.turn_epoch
```

处理：

```python
if event.turn_epoch != self.turn_epoch:
    ignore stale event
```

如果现有 agent callback 可以拿到稳定的：

```text
turn_id
message_id
run_id
```

优先使用真实 ID。

否则最少由 callback 安装时捕获：

```python
epoch
```

这应该成为一个新的 invariant：

> **I13：任何来自旧 turn epoch 的迟到事件不得修改当前事实状态。**

并加入：

```text
test_late_previous_turn_event_is_ignored
test_late_previous_turn_tool_start_does_not_pollute_new_turn
```

这是 v4 并发模型中目前最大的剩余 race。

---

# 四、`transient` 还绕过了你刚建立起来的 priority model

v4 最重要的原则是：

> 优先级只决定显示什么，绝不丢事实事件。



而投影优先级第一位是：

```text
awaiting_input
```



可是：

```python
on_tool_completed(..., is_error=True)
```

会直接：

```text
emit transient tool_failed
```



这实际上绕过了 `project()`。

假设：

```text
等待用户批准
    ↓
后台工具失败
```

按照事实投影原则：

```text
awaiting_input
```

应该仍然具有最高显示优先级。

但当前 transient 机制会直接显示：

```text
工具出错了
```

于是 B5 类问题又从后门回来。

这也是为什么我建议彻底拆：

```text
Snapshot projection
Effect projection
```

并给 effect 自己定义政策：

```text
critical effect
normal effect
suppressed effect
```

例如：

```text
awaiting_input 时：
    tool_failed effect 可以记录
    但不一定 overlay 当前 awaiting
```

或者定义：

```text
FAILURE effect priority > awaiting
```

都可以。

关键是要**明确写出来**，不能让 `emit transient` 成为绕过 projection 的特殊路径。

---

# 五、`from_payload()` 放在 `state.py` 会产生依赖层次问题

现在定义：

> text 缺失 → generic 模板兜底构造。



但 generic 模板需要：

```python
render_caption()
```

而依赖关系现在是：

```text
assemble.py
    ↓ imports
state.py
```

如果：

```text
state.py::from_payload()
```

再调用：

```text
assemble.render_caption()
```

就变成：

```text
state → assemble → state
```

循环依赖。

如果它直接查：

```python
t("captions.generic")
```

那又违反：

> `assemble.py` 是 captions 内唯一查 t() 的地方。



所以这里目前函数规格自身不闭合。

### 建议增加很小的 `wire.py`

变成：

```text
state.py
    CaptionState
    CaptionFrame
    make_caption
    make_frame

assemble.py
    state → text

wire.py
    state + assemble
    to_payload
    from_payload
```

依赖：

```text
state ← assemble
   \     /
     wire
```

无环。

而且“wire boundary fail closed”本来就是 wire adapter 的职责，不需要硬塞进 domain state。

---

# 六、`CaptionProjector.__init__()` 缺少一个重要依赖：语言/renderer

目前签名只有：

```python
CaptionProjector(
    emit: Callable[[CaptionFrame], None]
)
```



但 projector 内部明确负责：

```text
project
→ render_caption
→ frame
```

问题是：

```python
render_caption(state, lang=?)
```

这里的 `lang` 从哪里来？

尤其你已经明确：

```text
gateway = session language
CLI     = current locale
Slack   = English
```

运行图也写 Slack 使用 `"en"`。

最好不要让 projector 偷读 global locale。

建议构造器变成：

```python
CaptionProjector(
    emit,
    render: Callable[[CaptionState], str],
)
```

例如：

```python
gateway:
render=lambda s: render_caption(s, session.lang)

CLI:
render=lambda s: render_caption(s, current_lang)

Slack:
render=lambda s: render_caption(s, "en")
```

这样 projector 仍然：

```text
不懂 locale
不懂 Slack
不懂 session global
```

单测也容易得多。

---

# 七、`emit` 失败后的去重行为必须精确定义

现在已有很好的测试：

> `test_emit_callback_exception_does_not_corrupt_state`



但这个测试还不够。

假设：

```text
project → tool_running A
_last_visible = A
emit(A)
       ↓
     exception
```

如果 `_last_visible` 已经设置成 A，那么下一次事件再次投影 A：

```text
dedupe → 不 emit
```

客户端将**永远没有看到 A**。

这里实际上需要区分：

```python
_current
_last_projected
_last_emitted
```

我建议只有：

```text
emit 成功之后
```

才更新：

```python
_last_emitted
```

但是：

```python
_current
```

应该在事实投影成功后更新，不依赖网络发送成功。

于是：

```text
_current          = 当前正确事实
_last_emitted     = 客户端最后确认发送的状态
```

重连：

```text
current_frame()
```

仍然拿到正确状态。

下个事件也有机会重新发送。

新增测试：

```text
first emit raises
same projection occurs again
second emit succeeds
```

最终必须发出。

---

# 八、`dict` 的插入顺序现在承担了过多语义

两处都如此：

```text
in_flight → 第一个开始且未完成
awaiting  → 最近打开者
```



Python dict 确实保持插入顺序。

但：

```python
awaiting[id] = new_kind
```

如果相同 ID 更新，位置不会自动移到最后。

于是：

> “最近打开者”

和：

> “dict 最后一个”

不是严格同义。

建议不要把产品语义偷偷依赖 Python 容器细节。

例如：

```python
@dataclass
class AwaitingRequest:
    kind: str
    order: int
```

或者：

```python
OrderedDict
move_to_end(request_id)
```

类似地 `RunningTool` 最好明确：

```python
started_order
```

未来调试日志也容易理解：

```text
tool A started_order=41
tool B started_order=42
```

---

# 九、MOA / subagent / tool_generating 现在被过早决定成“1.6 秒闪一下”

v4 把它们称为“一次性信号”，`derive_caption()` 角色也专门收窄到这些场景。

但文件同时承认：

> `subagent.*` 精确 event_type 尚未核。



这意味着现在还不知道：

```text
subagent.started
subagent.progress
subagent.completed
```

是否具有持续生命周期。

`moa.*` 同理。

如果一个 MOA aggregation 持续 15 秒，那么：

```text
“正在汇总多个答案…”
```

显示 1.6 秒后又回到：

```text
思考中…
```

很可能反而降低信息质量。

所以这里不要先决定：

```text
MOA = transient
SUBAGENT = transient
```

应该先完成 checklist #1，再分类为：

```text
lifecycle fact
或
effect
```

---

# 十、P0 核查清单现在放得还是太晚

文档规定：

> 5 项未核不得进步骤 9/11。



可是 TDD：

```text
step 2 signal
step 3 derive
step 7 projector
step 9 relay
```



其中 checklist #1/#2/#3/#5 已经直接影响：

```text
SignalKind
subagent semantics
turn lifecycle
stream lifecycle
awaiting request identity
```

也就是说你可能：

```text
step 2~7 全部写绿
↓
完成 checklist
↓
发现真实事件词汇不同
↓
重新改 domain model
```

我建议把 5 项核查全部移动成：

```text
Step 0 — source verification
```

尤其：

```text
#1 subagent vocabulary
#2 turn boundary
#3 stream start
#4 preview redaction
#5 awaiting request_id
```

**核完以后再冻结函数规格。**

这是典型的“测试先行不能代替事实先行”。

---

# 十一、还有一个容易忽略的安全细节：格式模板应该禁止复杂 field expression

你现在用：

```python
Formatter().parse(template)
```

来验证 placeholder。

这是比 brace 扫描正确很多的修复。

但最好再收紧：

只能允许：

```text
{verb}
{subject}
{tool}
{goal}
{detail}
{phase}
{kind}
```

而不是：

```text
{subject.foo}
{subject[0]}
{subject!r}
{subject:>100}
```

虽然 locale 文件属于可信代码库，不属于典型外部攻击面，但这是一个非常便宜的静态完整性检查。

测试应断言：

```text
field_name 必须是简单 identifier
conversion == None
format_spec == ""
```

于是翻译人员不可能无意中改变格式语义。

---

# 我建议的 v5 不要再大改，而是做一次“协议收口”

v4 的核心 `CaptionProjector` 应该保留，不需要推翻。

我建议 v5 只做下面这一轮收口：

```text
CaptionState
    ↓
CaptionProjector
    ├── current Snapshot
    └── optional Effect

CaptionSnapshot
    state
    text
    revision

CaptionEffect
    kind
    text
    ttl_ms
    revision/related_revision

Wire adapter
    ↓
caption.update
caption.effect
```

Projector 内事实可以升级成：

```text
turn_epoch
in_flight
awaiting
stream_active
cognitive_state
```

再把锁模型从：

```text
one lock + external emit inside
```

收敛为：

```text
state lock
    mutate/project/revision

ordered emit boundary
    transport only
```

这样架构层次会非常清楚：

```text
事实层
  ↓
投影层
  ↓
显示状态
  ↓
显示效果
  ↓
传输适配
```

而不是现在还有一点：

```text
projector
同时承担事实、渲染、effect、transport ordering
```

的趋势。

## 最终评价

如果 v3 我会认为“不能直接开工”，那么 **v4 已经达到大约 80～85% 可以开工的程度**。

最值得肯定的是这两条已经真正成为架构核心：

> **所有事件先更新事实，优先级只决定显示什么。**
> **CLI / Gateway 不再分别创造自己的字幕状态机。**



现在最需要避免的是为了处理 `tool_failed/turn_done/MOA` 的“好看效果”，重新把第二个隐形状态机塞进每个客户端。

因此我建议 **v5 的第一原则** 定成一句话：

> **Projector 只产生当前事实 Snapshot；短暂视觉反馈是独立 Effect，不允许 Effect 改写或绕过事实投影。**

然后再补上 **turn epoch、renderer 注入、emit failure 语义和锁边界**。做到这四项后，这份设计基本就可以从“设计备忘”升级成真正适合 Agent 直接照规格实施的工程协议。
