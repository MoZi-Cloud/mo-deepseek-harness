# DSH（mo-deepseek-harness）提示词与上下文优化方案

> 基于对 fork 源码（上游 deepseek-ai 官方 DSH 0.1.2-alpha.1，commit `cd5ef81`）的全量分析。
>
> 目标：① 总结提示词规则 ② 评估可简化空间 ③ 改进上下文压缩 ④ 提速 ⑤ 让纯 CPU 电脑可运行。
>
> 所有文件引用均可点击定位；配置示例均已对照源码中的 Schema 定义核实。

---

## 0. 结论先行（TL;DR）

| 问题 | 答案 |
|---|---|
| 提示词能否简化？ | **能，且路径现成**。DSH 没有单体 system prompt，是"分区注册表 + 按需装配"，官方已内置 `minimal` 预设（一句话 persona + 2 个工具）。标准会话固定开销约 21–34 KB（≈5–8K token），可压到 2–3 KB（≈600–800 token），**首 token 前的 prefill 成本降低约 90%**。 |
| 压缩规则能改进吗？ | **能**。现有三段式（裁剪→溢盘→LLM 摘要）设计良好，但所有默认参数按 **1M 上下文窗口**调校（80% 阈值 / 16% 保留 / 8192 字符裁剪线）。对 8K–32K 窗口的本地小模型，这些参数全部失配，需要按窗口自适应（本文 §3 给出参数表与 `modelPolicies` 配置）。 |
| 能否提速？ | 分三层：harness 侧（并行工具数、guard、快照节流）、协议侧（append-only 会话天然 KV-cache 友好，保持 header 稳定即可命中缓存）、模型服务侧（llama.cpp `--cache-reuse`、线程/batch 配置、短 prompt 直接减少 CPU prefill）。 |
| 纯 CPU 电脑能跑吗？ | **DSH 本体现在就能跑**——纯 Node（≥22），零 GPU 依赖，原生模块只有 node-pty/koffi/landlock（均 CPU）。瓶颈只在模型推理。三条路线：A 远程 API（最弱机器）；B 本地 llama.cpp CPU + 小模型（8B-Q4 约需 6 GB 内存）；C 混合（本地小模型做压缩摘要，主模型走 API）。 |

---

## 1. DSH 提示词规则总结（源码分析）

### 1.1 没有单体 system prompt —— 装配式分区注册表

系统提示词由 `SystemPrompt.assemble()` 按每次模型调用动态装配：`packages/core/system-prompt/src/index.ts:518`（合并全局层+作用域层 → 按 `order` 排序 → 应用 `toolOrder` → 渲染 `{{变量}}`）。

固定分区次序（`FIRST_PARTY_SECTION_ORDER`，同文件 130–161 行）：

```
HARNESS_IDENTITY(-1000) → HARNESS_SOURCE(-900) → WEB_SURFACE(-800)
→ DEPLOYMENT_PERSONA(0) → PLAN_POLICY(500) → TEAM_POLICY(600)
→ PTC_ONLY(800) → FILE_REFERENCE(900) → 各工具分区(1000–2900)
→ TOOLS_SDK(5000) → DELIVERABLE_FILE_REFERENCES(9000) → STRUCTURED_OUTPUT(9900)
```

- **身份句**：`'You are an AI driven by DeepSeek Harness.'` 仅 52 字符（`system-prompt/src/index.ts:412`，可用 `includeHarnessIdentity: false` 关闭）。
- **persona 槽**：各 bundle 统一是 ~100 字符的一句 `You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`（如 `packages/bundle/web-app/cordis.patch.yml:18`）。
- **行为规则不在 persona 里**，而是拆成 ~25 个"每工具一个短分区"（设计约定见 `packages/workflow/tool-workflow/src/index.ts:211` 的注释）。这是 DSH 提示词体系最重要的规则：**工具指引随工具插件注册，persona 保持极小**。

### 1.2 固定提示词清单（含体积与开关）

| 组件 | 位置 | 体积 | 常开? |
|---|---|---|---|
| 身份句 | `packages/core/system-prompt/src/index.ts:412` | 52 ch | 是 |
| persona | bundle yml + `packages/preset/agent-presets/presets/standard/agent.cordis.yml:28` | ~100 ch | 是 |
| 计划模式分区 | `presets/standard/agent.cordis.yml:113` | ~2.4 KB | 计划模式时 |
| 工具指引分区（bash/read/write/edit/glob/grep/jobs/web×2/lsp/goal/pty…） | 各 `packages/*/tool-*/src/index.ts` | 0.1–0.7 KB/个 | 随工具 |
| Cordis 工具分区 | `packages/extensions/tool-cordis/src/prompt.ts:3` | ~10 KB | 仅 cordis 预设 |
| **工具 schema 描述**（随 `tools` 字段发给模型） | 各 `defineTool({description})`；bash ~1.4 KB、workflow ~2.5 KB | **合计 15–25 KB** | 随工具 |
| 子代理/workflow/ralph 分区 | `tool-subagent/src/index.ts:592` 等 | ~0.5 KB/个 | 随工具 |
| PTC 模式生成的 SDK 声明 | `packages/core/tools/src/index.ts:843` | 数 KB | 仅 PTC |

标准 web 会话固定开销 ≈ **6–9 KB 分区文本 + 15–25 KB 工具 schema ≈ 5–8K token**（按 DSH 自己的 4 字符/token 估算）。**大头是工具 schema，不是文字分区。**

### 1.3 每步动态注入（进入消息历史而非 system prompt)

装配顺序（`packages/core/agent-loop/src/agent.ts:232` `preStep()`）：**用户消息批 → AGENTS.md 工作区上下文 → runtime-context 快照 → time-context**。

- **AGENTS.md**：`packages/context/agent-instructions/src/files.ts` 发现 `$DSH_HOME/AGENTS.md`（全局）+ 根→cwd 的 `AGENTS.md`/`CLAUDE.md`，包 `<system-reminder>` 注入；预算 `maxBytes: 65536`（默认 64 KB，可在配置调小）。
- **runtime-context 快照**：沙箱策略/审批策略/委托关系渲染成一条 user 消息，**替换式**——只保留最新一条（`packages/core/agent-loop/src/runtime-context.ts` 的 `RuntimeContextProjection` 追踪 retained 快照，旧快照被顶掉）。这部分设计很省上下文。
- **time-context**：`packages/context/time-context/src/index.ts` —— 默认**每个 step 追加**一条 ~150 ch 的持久 user 消息（"Time sampled while preparing turn N, step S…"）。⚠️ 50 步的长任务会累积 ~7.5 KB。有 `refreshIntervalMs` 配置可节流（设大即近似关闭）。

### 1.4 输出侧的三个隐形上下文消费者

1. **工具结果即时封顶**：`packages/util/output-retention`（read/grep 自带截断）。
2. **溢盘 spill**：工具输出 > `maxInlineBytes`（默认 50 000 B）时全文落盘（`packages/spill/spill-local`，0600 权限），上下文里只留 头+尾预览+文件路径引用，模型可用 `read/grep` 回读（`packages/spill/spill-policy/src/index.ts:190`）。**细节**：为避免 read→spill→read 死循环，`read` 工具的结果不 spill。
3. **工具结果裁剪器**：`packages/compaction/compaction-tool-result-pruner` —— 超过 `thresholdChars: 8192` 的旧工具结果，中间替换为 `[... tool result middle pruned ...]`，保留头 4096 + 尾 1024 字符。

### 1.5 压缩子系统（三段式 + 溢出恢复）

触发与参数（`packages/compaction/compaction-basic/src/{index,config}.ts`）：

| 项 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | **0.8** | 估算 token ≥ 窗口 80% 时触发 |
| `retainRatio` | **0.16** | 最新 16% 窗口的尾部原文保留 |
| `maxTokens` | 8192 | 摘要生成本身的上限 |
| `compactionRetries` | 1 | 一次不够再压的额外次数 |
| `maxOverflowRetries` | 1 | 供应商报 `CONTEXT_WINDOW_EXCEEDED` 后的恢复次数 |

流程：① 先无模型裁剪（pruner）→ 复测，达标即省一次 LLM 调用；② 仍超则选头部区间（`selectCompactableRange`，`region.ts:100`，保 tool-call/result 配对完整性），用 **KV-cache 友好**的方式做 LLM 摘要——复用会话原 system+tools+被遮蔽消息做前缀，只在末尾追加 `COMPACTION_INSTRUCTION`（`summarizer.ts:32`，固定 8 节模板：主要请求/关键概念/文件与代码/错误与修复/待办/当前工作/下一步/关键上下文）；③ 摘要以 `<compacted-summary>` 包裹、带 `surfaceOp: replace` 替换遮蔽区间。事件日志永不删（`shadowedSeqs` 可回放）。

**Token 计数是启发式**：`packages/llm/token-meter/src/estimate.ts:12` 硬编码 `CHARS_PER_TOKEN = 4`；有 provider usage 回填锚定（取 usage 与估算的较大者，保守），但中文/代码场景误差可达 ±30%。

### 1.6 KV-cache 友好设计（提速的关键既有资产）

- 会话日志 append-only；`request/header` 事件只在 header 真变时追加（`agent.ts:507`）——**中途换模型/换工具集 = 缓存全失效**。
- 摘要调用刻意构造为上一请求的真前缀（`summarizer.ts:24`）。
- 计划模式保留完整工具目录"for request-cache stability"（`cordis.patch.yml:315`）。

### 1.7 预设体系（简化的事实基础）

`packages/preset/agent-presets/presets/`：`standard`（27 工具）/ `minimal`（**2 工具**：bash + str_replace_editor；persona `complete: true` 即整个 system prompt 只有一句 "You are a helpful software engineer assistant."；关闭 runtime-context；**无压缩**）/ `ptc` / `cordis`。

---

## 2. 提示词简化方案

### 2.1 零代码（配置级，立即可用）

| 动作 | 配置位置 | 收益 |
|---|---|---|
| 换 `minimal` 预设 | 会话/预设选择处 | system prompt 一句话 + 2 工具，固定开销 21–34 KB → ~2–3 KB |
| AGENTS.md 预算 64K→8K | `dsh-agent-instructions` 配置 `maxBytes: 8192` | 防止巨型项目说明吃满小窗口 |
| 关 web 表面分区 | `surfaceContext: false` | ~1.1 KB |
| time-context 节流 | `dsh-time-context` 配置 `refreshIntervalMs: 3600000` | 长任务省数 KB |
| `DSH_SYSTEM_PROMPT`（sdk-minimal） | 环境变量 | SDK 场景自定义最短 persona |

### 2.2 预设级（写 YAML，不改源码 —— 推荐给本地小模型）

复制 `presets/minimal` 为自定义预设（Web UI 支持 fork 预设），在 yml 里：
- 从 minimal 起步（2 工具），按需加回 `read`/`edit`/`grep`/`glob` 四件套 —— **8 个工具以内**是本地小模型的舒适区；
- 显式挂上 `compaction-basic` + `tool-result-pruner` + `spill-policy` 三行（minimal 默认没有，见 §3-W6）；
- persona `complete: true` 保持封闭，防止后续插件注入分区。

工具数与固定开销的量化关系（估算，4 ch/token）：

| 配置 | 工具数 | 固定 prompt 体积 | ≈token |
|---|---|---|---|
| standard（现状） | 27 | 21–34 KB | 5–8K |
| 精简 preset（8 工具） | 8 | 6–9 KB | 1.5–2.2K |
| minimal（2 工具） | 2 | 2–3 KB | 0.6–0.8K |

### 2.3 代码级（fork 改动，收益最大但要维护）

1. **工具 schema 描述瘦身**：bash 的 1.4 KB 动态描述（`packages/shell/tool-bash/src/index.ts:70-100`）压到 ~300 ch；workflow 的 2.5 KB 描述（`tool-workflow/src/index.ts:137`）压到 ~400 ch。这两项即省 ~1K token。
2. **分区合并**：把 0.1–0.7 KB 的每工具分区合并为一段"工具速查"分区（约省 30–40% 分区文本）。
3. **按模型档位自动切换描述集**：在 `ToolRuntime.wireSchemas()`（`packages/core/tools/src/index.ts:842`）加 `schemaProfile: 'full' | 'compact'`，路由到本地小模型时自动用 compact 集。这是 fork 的核心竞争力改动。

### 2.4 不要动的部分

身份句/persona 已是极限小；runtime-context 替换式设计、append-only 日志、摘要的前缀复用——这些是 DSH 的优点，简化时必须保留，否则 KV-cache 全废。

---

## 3. 更好的上下文压缩规则

### 3.1 现状弱点（源码证据）

| # | 弱点 | 证据 |
|---|---|---|
| W1 | 4 字符/token 启发式，对 8K–32K 窗口误差致命 | `token-meter/src/estimate.ts:12` |
| W2 | 只支持头部锚定压缩，无中段驱逐 | `compaction-basic/src/region.ts:132`（区间恒从 surface 0 开始） |
| W3 | 参数按 1M 窗口调校：8K 窗口时阈值 6.4K/保留仅 1.3K，摘要还没写完就又触发 | `config.ts:20-23` |
| W4 | 裁剪线 8192 字符 ≈ 2K token，对 8K 窗口一条工具结果就能占 1/4 | `compaction-tool-result-pruner/src/config.ts:7` |
| W5 | 溢出恢复仅 1 次机会 | `maxOverflowRetries: 1` |
| W6 | **minimal 预设（最适合小模型）反而没有任何压缩** | `presets/minimal/agent.cordis.yml` 头注释 "Context compaction is absent" |
| W7 | 摘要 maxTokens 8192 对小模型过大，截断即硬错（"incomplete checkpoint"） | `summarizer.ts:206` |

### 3.2 改进方案

**P1 按窗口自适应参数（配置级，今天就能做）** —— 利用现成的 `modelPolicies`（`compaction-basic/src/types.ts:32`，按 provider+model 精确覆盖）。小窗口推荐值：

| 参数 | 默认（1M 窗口） | ≤16K 窗口建议 | 32K 窗口建议 |
|---|---|---|---|
| `thresholdRatio` | 0.8 | **0.6**（早压，留生成余量） | 0.7 |
| `retainRatio` | 0.16 | **0.35**（尾部多留） | 0.3 |
| pruner `thresholdChars` | 8192 | **2048**（head 1024/tail 512） | 4096（head 2048/tail 1024） |
| spill `maxInlineBytes` | 50000 | **16384** | 32768 |
| 摘要 `maxTokens` | 8192 | **2048** | 4096 |
| `maxOverflowRetries` | 1 | 2 | 2 |

（原理：小窗口下 80% 阈值太晚——摘要本身还要占生成位；16% 保留太少——尾部太薄模型会失忆刚做过的步骤。）

**P2 token 估算校准（小代码改动）**：对本地 llama.cpp 启用 usage 锚定的下界也接受（当前只在 usage ≥ 估算时才锚定，`token-meter/src/index.ts:140`），或按路由维护一个 chars/token 滑动校准系数（中文 ≈1.8，代码 ≈3.5），一次校准请求即可获得。

**P3 中段驱逐（中等代码改动，收益大）**：新增 "aging" 策略——超过 N 步之前的大体积 `tool/result`（比如 >2K token）不等压缩，直接降级为 头 512 ch + spill 文件引用。复用现成 spill 基建，只改 `region.ts` 的区间选择与一个 `tools/post-execute` 钩子。这解决"历史大结果反复参与每次 prefill"的最大浪费。

**P4 给 minimal 补压缩（预设 YAML 一行事）**：在自定义 preset 里挂 `@deepseek-ai/dsh-compaction-basic`、`@deepseek-ai/dsh-compaction-tool-result-pruner`、`@deepseek-ai/dsh-spill-policy` 三行（base bundle `cordis.patch.yml:323-409` 有现成写法可抄）。

**P5 摘要路由分离**：`summarizationProvider/Model` 指向快通道（本地小模型或 flash 类 API），主对话不受 8192 token 摘要生成阻塞。

**P6 time-context 节流**：`refreshIntervalMs` 拉到 1 小时级，长任务省 5–8 KB。

**P7（fork 深度项）摘要模板瘦身**：`COMPACTION_INSTRUCTION` 的 8 节模板对短会话过重，可按被压区间 token 量选择 4 节短模板（意图/文件/当前工作/下一步）。

---

## 4. 提速

### 4.1 harness 侧
- `agent-loop.maxParallelToolCalls`：默认 10（`packages/core/agent-loop/src/constants.ts:5`）。本地小模型并行 tool-call 解析易乱序，**降到 2–3** 反而总时延更低。
- 关闭 `repeat-tool-reminder`（guard）与不用的 web 工具，少注入少轮次。
- **保持 header 稳定**：一个会话内不换模型、不动工具集（`agent.ts:507` 只在 header 变化时才重建，但一变就是全量重 prefill）。
- 会话复用 > 新开：append-only + 前缀稳定 = 提供商/本地 KV-cache 命中。

### 4.2 模型服务侧（llama.cpp CPU）
- `--cache-reuse 256`（slot 内前缀复用，配合 DSH 的 append-only 命中率极高）；`--keep-all-threads` 无此参数，用 `-t <物理核数>`、batch `-b 2048 -ub 512`；
- `--jinja`（启用对话模板，工具调用必需）；`-c 16384` 按需给窗口（内存 = 窗口×层数×kv 头维度）；
- prompt 越短 prefill 越快 —— §2 的简化直接就是提速：CPU prefill 吞吐 ~50–200 token/s，**省 5K token 固定 prompt ≈ 每 step 省 25–100 秒**（未命中缓存时）。

### 4.3 协议侧
- DeepSeek 官方路由自动 prompt cache（usage 里 `prompt_cache_hit_tokens` 已解析，`llm-deepseek/src/translate.ts:54`）。
- 本地 llama.cpp：不开 `--no-warmup`，长会话保持单 slot（`-np 1 --cont-batching`），KV 复用率最高。

---

## 5. 纯 CPU 电脑运行方案

### 5.1 前提结论
DSH = 纯 Node 客户端（Node ≥22.19，原生依赖 node-pty/koffi/landlock 全 CPU），`npx @deepseek-ai/dsh web` 或 Python wheel 单文件版均可。**没有任何 GPU 假设**（仓库中无 cuda 依赖）。

### 5.2 内存预算（本地模型路线）

| 模型 | 量化 | 权重+KV(16K) 约需 | 适用 |
|---|---|---|---|
| Qwen3-4B-Instruct | Q4_K_M | ~4 GB | 8 GB 内存的老笔记本 |
| Qwen3-8B-Instruct-2507 | Q4_K_M | ~7 GB | 16 GB 机器（推荐下限） |
| Qwen3-14B / GLM/Qwen2.5-Coder-14B | Q4_K_M | ~11 GB | 32 GB 机器 |

**硬门槛是工具调用（tool_calls JSON）可靠性**：27 工具的 standard 预设对 8B 模型过载，务必用 §2.2 的 8 工具预设。

### 5.3 路线 B 完整配置（本地 llama.cpp）

`llama-server` 启动（CPU）：
```bash
llama-server -m qwen3-8b-instruct-2507-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 --jinja \
  -c 16384 -t $(nproc) -b 2048 -ub 512 \
  --cache-reuse 256 -np 1 --cont-batching
```

`$DSH_HOME/settings.yaml`（`~/.dsh/settings.yaml`）：
```yaml
llm-pi-ai:
  providers:
    llama-local:
      displayName: llama.cpp CPU
      apiKeyEnv: LLAMA_API_KEY        # pi-ai 强制要 key；llama-server 接受任意值
      api: openai-completions
      baseURL: http://127.0.0.1:8080/v1
      defaultContextWindow: 16384     # llama-server 的 /v1/models 不报窗口，必须手填
      defaultMaxTokens: 4096
      compat:
        maxTokensField: max_tokens        # 否则发 max_completion_tokens 被拒
        supportsDeveloperRole: false      # 否则推理模型收到 role:"developer" 被拒
        thinkingFormat: chat-template     # 或按服务端去掉思考输出
        requiresToolResultName: false
        supportsUsageInStreaming: true
      models:
        - id: qwen3-8b-instruct-2507
          contextWindow: 16384
          maxTokens: 4096

# 小窗口压缩参数（§3-P1）
dsh-compaction-basic:
  modelPolicies:
    - provider: llama-local
      model: qwen3-8b-instruct-2507
      thresholdRatio: 0.6
      retainRatio: 0.35
      maxTokens: 2048
      maxOverflowRetries: 2
dsh-compaction-tool-result-pruner:
  thresholdChars: 2048
  headChars: 1024
  tailChars: 512
dsh-spill-policy:
  maxInlineBytes: 16384
dsh-agent-instructions:
  maxBytes: 8192
dsh-time-context:
  refreshIntervalMs: 3600000
```
配合：`export LLAMA_API_KEY=no-key`，Web UI 里选 llama-local 路由 + 自定义精简预设。

已核实的坑（`docs/user/guide/providers.md:86` 也确认）：
- pi-ai 对 OpenAI 兼容端点**强制要求 key**（`llm-pi-ai/src/provider.ts:66`）→ 假 key 即可；
- 推理模型的 `role:"developer"` 与 `max_completion_tokens` 是两大拒绝源 → 两个 compat 开关必须按上例设置；
- `/v1/models` 不返回 `context_length` → `contextWindow` 不填会落到 pi-ai 默认 262144，压缩永远不会触发且必溢出。

### 5.4 路线 A / C
- **A（最弱机器，如 2–4 GB 内存上网本）**：只跑 DSH + 远程 API（DeepSeek 官方或任意 OpenAI 兼容网关）。DSH 进程本身内存占用为普通 Node web 服务量级。
- **C（混合）**：主对话走 API；`summarizationProvider/Model` 指向本地小模型（压缩摘要对质量要求低，4B 足够），既省钱又把压缩的 8192 token 生成从关键路径拿掉。

---

## 6. 实施清单与验收

| 阶段 | 内容 | 改动面 | 验收 |
|---|---|---|---|
| 0 | settings.yaml + llama-server 启动（§5.3） | 零代码 | CPU 机器完成一次工具调用闭环 |
| 1 | 自定义精简预设（§2.2）+ 压缩参数（§3-P1） | 1 个 YAML | 固定 prompt ≤2.2K token；16K 窗口跑完 30+ 步不溢出 |
| 2 | P3 中段驱逐 + P2 校准 + schema 瘦身（§2.3/§3） | fork C++→无，纯 TS | 每 step prefill token 同比降 ≥40% |
| 3 | 验收基准 | — | 复用既有 DSH 基准三题（LRU/Median/Sudoku）：对比 token 用量、端到端时延、一次通过率；本地 8B 预期通过 LRU/Median，Sudoku 允许失败（对齐此前裁剪版模型的结论） |

**优先级建议**：先做阶段 0+1（一天内完成、零代码风险、解决"能不能跑"）；阶段 2 按实际瓶颈再投入——若阶段 1 后时延可接受，P3 中段驱逐优先级最高（长会话收益最大），schema 瘦身次之。
