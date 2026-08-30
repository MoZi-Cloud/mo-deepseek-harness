---
description: "review 组导览：将会话已完成区间沉淀为记忆记录与受管技能的会话评审运行时，供维护者导航本组。"
kind: "package-group"
---

# review/ — 会话评审家族

[English](README.md) | 中文

## 概述

review 组承载会话评审运行时：一个会话区间结束后，评审趟次把其中发生的内容沉淀为持久学习资源——记忆记录与受管技能——语义上有界、幂等、至少一次。本组尚在建设中：`session-review` 包目前是骨架，其 Evidence Lock 套件钉死运行时所依赖的跨包行为事实，尚未注册任何运行时行为。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| Package | Role | ctx key |
|---|---|---|
| [`session-review/`](session-review/README.zh.md) | 会话评审运行时骨架，承载 Evidence Lock 行为套件 | 暂无（保留插件名 `session-review`） |

-----

<a id="related-documentation"></a>
## 相关文档

- [会话评审设计（RC5.5）](../../docs/mozi-fork/自我进化机制-RC5.5-方案.md) — 冻结方案与阶段门。
- [Evidence Lock 矩阵](../../docs/mozi-fork/RC5.5-附件P0-evidence-lock.md) — 骨架测试所实现的 68 项钉死行为事实。
