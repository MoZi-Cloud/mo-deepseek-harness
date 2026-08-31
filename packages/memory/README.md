---
description: "Package map for the memory capability family: per-scope durable recall with anti-replay receipts and digest-gated composite publication."
kind: "package-group"
---

# memory/ — durable memory capability

English | [中文](README.zh.md)

## Summary

The `memory/` group owns the harness's bounded long-term memory: per-scope durable state folded from host-allocated review ops, anti-replay receipt bookkeeping, and the composite snapshot publication that carries memory into the model context.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`memory/`](memory/README.md) | Per-scope durable recall folded from host ops, with receipts, budgets, and composite snapshot publication |

-----

<a id="related-documentation"></a>
## Related documentation

- [Root package map](../README.md) — where `memory/` sits among all package groups.
- [Self-evolution design](../../docs/mozi-fork/自我进化机制-RC5.5-方案.md) — the design this family implements.
- [Adding a package cookbook](../../docs/cookbook/adding-a-package.md) — how a new package lands in this group.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
