---
description: "The memory capability package: per-scope durable recall folded from host ops, with anti-replay receipts, budgets, and digest-gated composite publication."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

`dsh-memory` gives the harness a bounded long-term memory: a review pass folds host-allocated mutation ops into per-scope durable state (project and user), and a publisher re-renders that state into one composite snapshot message whenever its digest changes. Every op carries host-authoritative fields — op id, derived entry id, timestamp — so folding is pure and crash replays converge to duplicates instead of double-writes. The current deliverable is the contract layer: the storage domain declaration, the record schemas, and the pure fold/publication functions; the Service and Publisher that mount them land in the next batch of the same phase.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Do not mount this package yet: the `MemoryService`/`MemoryPublisher` assembly is the next batch of this phase, and nothing here registers runtime behavior. The pure layer is already usable — `foldMemoryOps`, `splitReceipts`, and the publication pipeline are exported for the assembly to compose — and a storage consumer opens the memory domain through the `memoryDomain` declaration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Receipts are split in two. Pending receipts record ops whose review attempt has not reached a terminal state and are never evicted; the bounded recent-terminal ring records terminal-acked ops and is the only region that garbage-collects. Replay detection consults pending ∪ ring before any base check, so a replayed op returns the originally recorded digest even when its entry is already gone. Publication scans every entry at the read boundary — caution findings pass, blocked findings render as `[BLOCKED: reason]` placeholders without their payload — inside a fence grown past the longest backtick run of the body, under an exact token budget that throws instead of truncating.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits describe the contract layer's current state, not the finished capability.

- **No runtime assembly yet** — the Service (sole memory-domain opener, write-boundary scan, grouped terminal acks) and the composite fail-open Publisher mount in the next batch of this phase; until then the package registers no plugins and owns no model-visible behavior.
- **The user scope is types-only** — this phase fills only the project scope; the user scope's published section stays absent while the pipeline already carries it.
- **Receipt retention is protocol-owned** — pending receipts shrink only when the review runtime acks terminal ops; without acks they are retained forever, which is the safe direction but keeps the storage record from shrinking.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The function-level contracts and their acceptance rows live in [the self-evolution design](../../../docs/mozi-fork/自我进化机制-RC5.5-方案.md) and its [P1 memory appendix](../../../docs/mozi-fork/RC5.5-附件P1-memory.md); the tests pin each acceptance name from that table.

</details>
