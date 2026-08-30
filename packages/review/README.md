---
description: "The review group map: the session review runtime that consolidates finished session ranges into memory records and managed skills, for maintainers navigating the group."
kind: "package-group"
---

# review/ — session review family

English | [中文](README.zh.md)

## Summary

The review group hosts the session review runtime: after a session range finishes, a review pass consolidates what happened into durable learning resources — memory records and managed skills — under bounded, idempotent, at-least-once semantics. The group is under construction: the `session-review` package is currently a skeleton whose Evidence Lock suite pins the cross-package behavior facts the runtime relies on, and no runtime behavior is registered yet.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`session-review/`](session-review/README.md) | Session review runtime skeleton hosting the Evidence Lock behavior suite | none yet (reserved plugin name `session-review`) |

-----

<a id="related-documentation"></a>
## Related documentation

- [Session review design (RC5.5)](../../docs/mozi-fork/自我进化机制-RC5.5-方案.md) — the frozen plan and its phase gates.
- [Evidence Lock matrix](../../docs/mozi-fork/RC5.5-附件P0-evidence-lock.md) — the 68 pinned behavior facts the skeleton's tests implement.
