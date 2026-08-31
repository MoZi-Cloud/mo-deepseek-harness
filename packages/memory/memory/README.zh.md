---
description: "记忆能力包：按作用域的持久记忆，从 Host op 折叠而来，带防重放回执、预算与按摘要闸控的复合发布。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

[English](README.md) | 中文

## 概述

`dsh-memory` 为 harness 提供有界的长期记忆：评审把 Host 预分配字段的变更 op 折叠进按作用域的持久状态（project 与 user），发布器在该状态的复合摘要变化时重新发布一条 composite snapshot 消息。每个 op 都携带 Host 权威字段——opId、派生的 entryId、时间戳——因此折叠是纯函数，崩溃重放收敛为 duplicate 而非重复写入。当前交付的是契约层：存储 domain 声明、记录 schema 与纯折叠/发布函数；挂载它们的 Service 与 Publisher 在同一阶段的下一批落地。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

先不要挂载本包：`MemoryService`/`MemoryPublisher` 装配在本阶段的下一批到来，这里的任何代码都还不注册运行时行为。纯函数层已经可用——`foldMemoryOps`、`splitReceipts` 与发布管线均已导出，供装配组合使用——存储消费方经 `memoryDomain` 声明打开 memory domain。

-----

<a id="understand-the-implementation"></a>
## 理解实现

回执一分为二。pending 回执记录评审 attempt 尚未到达终态的 op，永不淘汰；有界的 recent-terminal 环记录已确认终态的 op，是唯一可回收的区域。重放查重先于任何 base 检查查 pending ∪ 环，因此重放的 op 即使目标条目已删除，也返回最初记录的 digest。发布在读边界扫描每一条内容——caution 命中放行，blocked 命中渲染为不带原文的 `[BLOCKED: reason]` 占位——正文置于随内容中最长反引号串增长的围栏内，token 预算精确：超限抛错而非截断。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些限制描述契约层的当前状态，而非完成后的能力。

- **运行时尚未装配** —— Service（memory domain 唯一 opener、写边界扫描、分组终态 ack）与复合 fail-open Publisher 在本阶段下一批挂载；在此之前本包不注册任何插件、不拥有任何模型可见行为。
- **user 作用域仅有类型** —— 本阶段只填 project 作用域；user 作用域的发布节保持缺省，管线已为其就位。
- **回执保留由协议决定** —— pending 回执只在评审运行时确认终态时收缩；没有 ack 就永久保留，方向安全，但存储记录不会缩小。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

函数级契约与验收行见[自我进化设计](../../../docs/mozi-fork/自我进化机制-RC5.5-方案.md)的 [P1 memory 附件](../../../docs/mozi-fork/RC5.5-附件P1-memory.md)；测试逐一钉住该表的验收名。

</details>
