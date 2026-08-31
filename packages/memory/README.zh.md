---
description: "记忆能力家族的包地图：按作用域的持久记忆，带防重放回执与按摘要闸控的复合发布。"
kind: "package-group"
---

# memory/ — 持久记忆能力

[English](README.md) | 中文

## 概述

`memory/` 组负责 harness 的有界长期记忆：从 Host 预分配的评审 op 折叠而来的按作用域持久状态、防重放回执记账，以及把记忆带进模型上下文的 composite snapshot 发布。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`memory/`](memory/README.zh.md) | 从 Host op 折叠的按作用域持久记忆，带回执、预算与 composite snapshot 发布 |

-----

<a id="related-documentation"></a>
## 相关文档

- [根包地图](../README.zh.md) — `memory/` 在所有包组中的位置。
- [自我进化设计](../../docs/mozi-fork/自我进化机制-RC5.5-方案.md) — 本家族实现的设计。
- [新增包 cookbook](../../docs/cookbook/adding-a-package.zh.md) — 新包如何进入本组。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
