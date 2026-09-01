---
description: "面向自进化内容闸的纯正则威胁扫描器：对注入、外传、持久化与隐藏 Unicode 模式输出分档结论。"
kind: "package-library"
---

# @deepseek-ai/dsh-content-scan

[English](README.md) | 中文

## 概述

`dsh-content-scan` 用一套锚定模式扫描文本，返回带定位的发现：每条发现携带 `caution` 或 `blocked` 档位、攻击类别、1 起始行号与截断摘录。写入闸在 `blocked` 命中时拒绝记忆内容；读边界闸在发布时重扫并把命中条目渲染为占位符——两道闸共用这一个扫描器，被投毒的条目即使绕过写入闸也无法进入模型上下文。扫描先做 NFKC 归一（全角形近字同样命中），在原始文本上检测不可见与双向 Unicode 字符，并将输入截断到 65,536 字符。这是一个零依赖库；包内的语料测试同时钉住检出集合与误报预算。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在内容闸处调用 `scanContent(text, scope)`，再用 `scanVerdict` 把发现折叠成闸消费的三档结论。`blocked` 拒绝；`caution` 从不拒绝——项目事实本就合法地包含命令、路径与环境变量名。

```ts
import { scanContent, scanVerdict } from '@deepseek-ai/dsh-content-scan'

const entryText = 'Run pnpm run test:docs before committing documentation.'
const findings = scanContent(entryText, 'memory')
if (scanVerdict(findings) === 'blocked') {
  // reject the write, naming the finding ids
}
```

<a id="understand-the-implementation"></a>
## 理解实现

模式锚定在攻击词汇上——关键 token 之间的有界 filler 同时阻止多词变体逃避与无界回溯——绝不只锚定命令式口吻。分档是刻意设计：高置信注入、密钥进网络命令的外传、持久化痕迹与隐藏 Unicode 归 `blocked`；普通 shell 片段、凭证路径与环境变量名提及归 `caution`。模式集合一旦变化 `PATTERN_SET_VERSION` 即递增，持久化的决策因此能指明产出它的扫描器版本。

<a id="model-experience"></a>
## 模型体验

None, as this is a pure scan utility that registers nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

These limits define where the package is not the right tool. They are current package constraints, not a task backlog.

- **锚点集是声明的，不是穷尽的** — 中文与英文锚点集之外的改写措辞会通过；语料测试钉住所覆盖的范围，消费闸在文档中把它定位为建议性守卫而非安全边界。
- **仅扫描前缀** — 超过 65,536 字符的文本只扫描其前缀；超长文本末尾的检出不在设计范围内。
- **caution 从不阻断** — 只有 caution 发现的文本会通过所有闸；需要更严行为的调用方自行拥有该策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

扩充语料钉住范围之外的中文锚点集保持待办；每个新锚点必须同时带来一条 positive 语料与一次 benign 语料重跑，以保住零误报预算。

</details>
