---
description: "Pure regex threat scanner for self-evolution content gates: severity-tiered findings over injection, exfiltration, persistence, and hidden-Unicode patterns."
kind: "package-library"
---

# @deepseek-ai/dsh-content-scan

English | [中文](README.zh.md)

## Summary

`dsh-content-scan` runs one anchored pattern set over a text and returns located findings, each carrying a severity of `caution` or `blocked`, an attack category, a 1-based line, and a capped excerpt. The write gate rejects memory content on `blocked` findings; the read-boundary gate re-scans at publication and renders flagged entries as placeholders — the two gates share this one scanner so a poisoned entry cannot enter the model context even when it bypassed the write. Scanning NFKC-normalizes first (full-width lookalikes match), detects invisible and bidirectional Unicode on the raw text, and caps input at 65,536 characters. It is a zero-dependency library; the corpus tests in this package pin both the detection set and the false-positive budget.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call `scanContent(text, scope)` at a content gate, then fold the findings with `scanVerdict` to get the three-tier verdict the gates consume. `blocked` rejects; `caution` never does — project facts legitimately contain commands, paths, and env names.

```ts
import { scanContent, scanVerdict } from '@deepseek-ai/dsh-content-scan'

const findings = scanContent(entryText, 'memory')
if (scanVerdict(findings) === 'blocked') {
  // reject the write, naming the finding ids
}
```

<a id="understand-the-implementation"></a>
## Understand the implementation

Patterns anchor on attack vocabulary — bounded filler between key tokens prevents multi-word evasion and unbounded backtracking — never on bossy prose alone. Severity tiering is deliberate: high-confidence injection, secret-into-network-command exfiltration, persistence tells, and hidden Unicode are `blocked`; ordinary shell fragments, credential paths, and env-name mentions are `caution`. `PATTERN_SET_VERSION` bumps whenever the set changes, so persisted decisions can name the scanner version that produced them.

## Model Experience

None, as this is a pure scan utility that registers nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the package is not the right tool. They are current package constraints, not a task backlog.

- **The anchor set is declared, not exhaustive** — rephrasings outside the anchored English and Chinese sets pass; the corpus tests pin what is covered, and the consuming gates document this as an advisory guard rather than a security boundary.
- **Prefix scanning only** — text beyond 65,536 characters is scanned as its prefix; detections near the end of an oversized text are out of scope by design.
- **Caution never blocks** — a text whose only findings are caution findings passes every gate; callers that need stricter behavior own that policy themselves.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Broadening the Chinese anchor set beyond the corpus-pinned phrases stays open; each new anchor must arrive with a positive-corpus entry and a benign-corpus re-run so the false-positive budget stays zero.

</details>
