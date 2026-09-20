# Agent Note：Observatory 协议 Phase 0——用可执行规格终结第四份全文重写

Status: implemented

[English](2026-09-21-observatory-protocol-phase0.md) | 中文

## Problem

Coding-Agent Observatory 方案已经历三次全文重写（v2.0 复审稿、v2.1、v2.2），每版整体替换上一版。规则一轮比一轮严格，交付物却始终为零：没有 schema、没有 fixture、没有 runner。这一模式带来两个结构性缺陷——没有稳定条款号，跨版本的语义变化无法审阅；未经实现的规则无法暴露自身矛盾。矛盾真实存在：v2.2 §6 要求每个 envelope 必填 `study_lock_digest`，而 v2.2 §17 的 Phase 0 运行的是尚不存在任何 study 的合成 producer，所有合法验证输入在形式上都是非法的。

## Decision

方案 v2.3（`docs/mozi-fork/Coding-Agent-Observatory方案-v2.3.md`）改变文档制度：v2.2 继续作为常驻协议基线，后续修订以编号修正条款叠加，不再全文重写。v2.3 对本次复审出的三个阻断级缺陷作出裁定——study 绑定矛盾（envelope 增加 `binding: "study" | "exploratory"`，只有 study 绑定的 envelope 才能进入正式快照）、过早绑定 PostgreSQL（提交协议只要求"单事务 metadata store"抽象，Phase 0/A 落在 `node:sqlite` 加文件系统 CAS 上，二者藏在接口之后）、以及规格无宿主（落到本包，TypeScript 实现）。

本包实现 Phase 0 节点 P0-A 至 P0-F：自有 RFC 8785 规范编码器；严格 JSON 扫描器在确切 JSON Pointer 上拒绝重复键、非规范数字字面量与尾随内容；封闭的 `observatory.error.v1` 错误词表（四个 ingest 语义码保留占位、本期无产生者）；envelope、study lock、capture profile 三类 schema 及其语义检查（绑定的必须有/必须无、payload 传输形态配对、`declared_size` 相等、引用唯一）；合成 producer 的逐类违规变异器；21 个 fixture 语料与清单，conformance runner 校验接受摘要与精确拒绝码，并检查语料完整性——未登记的 fixture 文件会让测试失败。按 v2.3 §5，方案中的节点表是唯一进度记录，节点状态与代码同提交更新。

## Consequences

一致性验证从此可执行：任何改变接受集合的规格修改必须在同一 PR 内重新生成 fixture 并审阅 manifest 差异，这就是"规则必须随 fixture 交付"的执行机制。编码决定（JCS + `sha256`）被黄金摘要冻结；数字字面量严格性依赖宿主 `JSON.stringify` 的 RFC 8785 合规行为，RFC 语料测试是这一假设的绊网。`too_big` 映射、非法键映射与保留码的存在是因为 Phase A 需要它们；词表封闭意味着新增 ingest 错误码是 schema 版本事件，不是顺手编辑。Phase 0 出口剩余条件是 P0-G——对同一语料的独立 Python 校验器；在它落地前，跨语言一致性未被证明，包 README 如实声明。

## Alternatives considered

第四次全文重写被否决：那会重置所有条款号，并复现产生本轮矛盾本身的"不可审阅差异"问题。第三方规范化依赖被否决：自有编码器是键排序叠加宿主序列化器（约 20 条语句），而严格扫描器无论如何都要自研，依赖只会删掉容易的那一半。扫描器对非规范数字放行被否决：byte-equal 重发语义（v2.2 §6.2）要求在 wire 层就有 canonical bytes 判定函数，而不是只在存储层。
