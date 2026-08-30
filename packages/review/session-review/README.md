---
description: "The session review package: P0 skeleton hosting the Evidence Lock suite that pins the cross-package behavior facts the review runtime relies on, for maintainers implementing and reviewing the runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-review

English | [中文](README.zh.md)

## Summary

`dsh-session-review` will let the harness learn from its own sessions: after a session range finishes, a review pass consolidates what happened into memory records and managed skills under bounded, idempotent, at-least-once semantics. The package is a P0 skeleton — it registers no runtime behavior and must not be mounted. Its current deliverable is the Evidence Lock suite under `tests/evidence-lock/`, which pins the cross-package behavior facts the runtime design relies on (storage, filesystem, skill-registry, and tool-surface contracts), so the runtime lands on verified ground.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Do not mount this package yet. The plugin name `session-review` is reserved and the package exposes no `apply`; compositions that need it today gain nothing. Read the Evidence Lock suite instead when changing the packages whose behavior it pins — a failing test there means an assumption of the review design just broke.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Evidence Lock suite implements the P0 matrix of the session review design: 68 numbered cases (66 active plus two historical-regression replays), each pinning one behavior fact with a pointer to the owning source. Most cases drive real infrastructure — the storage domain layer, the local filesystem primitives, the skill registry, the tool pipeline — directly. The cases that describe the runtime's own future protocols (receipts, name reservation, pending catalog revisions, finalization ordering) run reference implementations inside the tests over that real infrastructure, so the protocols are validated before the production packages exist. The suite lives at `tests/evidence-lock/`; the matrix and its acceptance gates are [the P0 appendix](../../../docs/mozi-fork/RC5.5-附件P0-evidence-lock.md) of the [session review design](../../../docs/mozi-fork/自我进化机制-RC5.5-方案.md).

The invariant companion is intentionally empty: the skeleton owns no services or durable events to audit, and the runtime's invariants will arrive with the code that owns them.

## Known Limitations and Deferred Work

These limits describe the skeleton's current state, not the finished runtime.

- **No runtime behavior** — the package registers nothing; mounting is meaningless until the review runtime lands, and the reserved plugin name has no `apply` yet.
- **Protocol prototypes live in tests** — the receipt, reservation, and finalization reference implementations exist only inside the Evidence Lock suite; they demonstrate feasibility and pin contracts but are not production code and carry no coverage obligation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The suite implements the frozen P0 matrix one case at a time; the matrix table in [the P0 appendix](../../../docs/mozi-fork/RC5.5-附件P0-evidence-lock.md) is the source of truth for which cases exist and what each pins. The [P0 skeleton Agent Note](../../../.agents/notes/implemented/feature/2026-08-31-session-review-p0-skeleton.md) records the harness facts the suite relies on.

</details>
