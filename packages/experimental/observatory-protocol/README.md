---
description: "Coding-Agent Observatory protocol specs: strict-scan and canonical-digest validation for native evidence envelopes, study locks, and capture profiles."
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-observatory-protocol

English | [中文](README.zh.md)

## Summary

`observatory-protocol` owns the executable Phase 0 specs of the Coding-Agent Observatory (方案 v2.3): the native evidence envelope, the study lock, and the capture profile. `validateEnvelope`, `validateStudyLock`, and `validateCaptureProfile` take raw JSON text and return either the parsed spec with its RFC 8785 canonical bytes and `sha256:` digest, or sorted taxonomy errors — duplicate keys, non-canonical numbers, unknown fields, binding conflicts, and size violations each carry their exact code. The synthetic producer builds valid envelopes and systematic violations; the committed fixture corpus and manifest pin every acceptance path.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call one validator with raw document text; the discriminated result avoids exception-driven control flow in runners.

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
## Understand the implementation

Validation runs in three passes: a strict JSON scanner (duplicate keys, non-canonical number literals, trailing content), a strict zod schema whose issues map to the closed `observatory.error.v1` taxonomy, and spec-specific semantic checks (study binding, payload transport). Canonical bytes come from an owned RFC 8785 encoder — key sorting over the host's conformant `JSON.stringify` — and the digest is `sha256` over those bytes. Four ingest-semantics codes are reserved in the taxonomy with no producer in this phase.

## Known Limitations and Deferred Work

These limits define where the package is not the right tool. They are current package constraints, not a task backlog.

- **Envelope layer only** — identity conflicts, seq gaps, and epoch restarts are ingest semantics; their codes are reserved and their fixtures arrive with the Phase A ingest state machine.
- **No extension map yet** — unknown fields are rejected outright; forward-compatible extension handling is deferred until a real producer needs it.
- **English/Chinese docs, one implementation** — the Python conformance checker (P0-G) is the second validator; until it lands, cross-language conformance is unproven.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The fixture corpus under `tests/fixtures` is generated from `src/synthetic.ts` builders and frozen; regenerate deliberately and review the manifest diff when the schema changes. Study lock fields are intentionally free-text strings — the study lock pins meaning through review, not through enum compression.

</details>