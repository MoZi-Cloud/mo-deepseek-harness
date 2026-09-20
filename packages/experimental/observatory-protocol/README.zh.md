---
description: "Coding-Agent Observatory 协议规格：对 native evidence envelope、study lock 与 capture profile 做严格扫描与规范摘要校验。"
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-observatory-protocol

[English](README.md) | 中文

## 概述

`observatory-protocol` 拥有 Coding-Agent Observatory（方案 v2.3）Phase 0 的可执行规格：native evidence envelope、study lock 与 capture profile。`validateEnvelope`、`validateStudyLock` 与 `validateCaptureProfile` 接收原始 JSON 文本，返回带 RFC 8785 规范字节与 `sha256:` 摘要的解析结果，或按序排列的词表错误——重复键、非规范数字、未知字段、绑定冲突与超限各自携带确切错误码。合成 producer 生成合法 envelope 与系统性违规；随包提交的 fixture 语料与清单钉住每条验收路径。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

对原始文档文本调用对应校验器；判别结果让 runner 无需异常驱动的控制流。

```ts
import { validateEnvelope } from '@deepseek-ai/dsh-experimental-observatory-protocol'

const result = validateEnvelope(rawDocumentText)
if (result.ok) {
  // result.digest names the evidence; result.canonical is the byte-equal reference
} else {
  // result.errors is the sorted ObservatoryError list with codes and JSON Pointers
}
```

<a id="understand-the-implementation"></a>
## 理解实现

校验分三趟：严格 JSON 扫描器（重复键、非规范数字字面量、尾随内容）、把 schema issue 映射到封闭 `observatory.error.v1` 词表的严格 zod schema、以及 spec 专属语义检查（study 绑定、payload 传输形态）。规范字节由自有的 RFC 8785 编码器生成——键排序叠加宿主合规的 `JSON.stringify`——摘要是对规范字节取 `sha256`。四个 ingest 语义错误码在本期仅占位保留，没有产生者。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

这些限制界定本包不适用的场景。它们是当前包约束，不是任务清单。

- **仅 envelope 层** — 身份冲突、seq 缺口与 epoch 重启属于 ingest 语义；相关错误码已保留，其 fixture 随 Phase A 的 ingest 状态机交付。
- **暂无扩展映射** — 未知字段一律拒绝；等真实 producer 出现需求后再交付前向兼容的扩展处理。
- **单实现** — Python 一致性校验器（P0-G）是第二校验实现；在它落地前，跨语言一致性尚未被证明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

`tests/fixtures` 下的语料由 `src/synthetic.ts` 构建器生成后冻结；schema 变更时有意重新生成并审阅 manifest 差异。study lock 字段有意保留自由文本——其含义靠评审钉住，不靠 enum 压缩。

</details>