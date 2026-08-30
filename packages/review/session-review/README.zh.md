---
description: "session-review 包：P0 骨架，承载 Evidence Lock 套件，钉死评审运行时所依赖的跨包行为事实，供实现与评审运行时的维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-review

[English](README.md) | 中文

## 概述

`dsh-session-review` 将让 harness 从自己的会话中学习：一个会话区间结束后，评审趟次把其中发生的内容沉淀为记忆记录与受管技能，语义上有界、幂等、至少一次。本包是 P0 骨架——不注册任何运行时行为，不可挂载。当前交付物是 `tests/evidence-lock/` 下的 Evidence Lock 套件：它钉死运行时设计所依赖的跨包行为事实（存储、文件系统、技能注册表、工具面契约），让运行时落在经验证的地基上。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

暂勿挂载本包。插件名 `session-review` 已保留，包尚未暴露 `apply`；今天挂载它一无所获。改动被其钉死行为的包时，请先读 Evidence Lock 套件——那里的测试失败意味着评审设计的某个假设刚被破坏。

-----

<a id="understand-the-implementation"></a>
## 理解实现

Evidence Lock 套件实现会话评审设计的 P0 矩阵：68 个编号用例（66 活跃 + 2 项历史回归重放），每例以指向所属源码的方式钉死一条行为事实。多数用例直接驱动真实基础设施——存储域层、本地文件系统原语、技能注册表、工具管线。描述运行时自身未来协议（回执、名称预留、待定目录修订、终结定序）的用例，在测试内以参照实现跑在真实基础设施上，使协议在生产包存在之前即获验证。套件位于 `tests/evidence-lock/`；矩阵与验收门见 [P0 附件](../../../docs/mozi-fork/RC5.5-附件P0-evidence-lock.md)——它属于[会话评审设计](../../../docs/mozi-fork/自我进化机制-RC5.5-方案.md)。

invariant companion 有意为空：骨架不拥有需要审计的服务或持久事件，运行时的 invariant 将随拥有它们的代码一起到来。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些限制描述骨架的当前状态，而非完成后的运行时。

- **无运行时行为** — 本包不注册任何东西；在评审运行时落地之前挂载毫无意义，保留的插件名尚无 `apply`。
- **协议原型只存在于测试中** — 回执、预留与终结的参照实现只存在于 Evidence Lock 套件内；它们证明可行性并钉死契约，但不是生产代码，也不承担覆盖义务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

套件逐例实现冻结的 P0 矩阵；[P0 附件](../../../docs/mozi-fork/RC5.5-附件P0-evidence-lock.md)中的矩阵表是"存在哪些用例、各钉死什么"的权威来源。[P0 骨架 Agent Note](../../../.agents/notes/implemented/feature/2026-08-31-session-review-p0-skeleton.zh.md) 记录套件依赖的 harness 事实。

</details>
