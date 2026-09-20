# Agent Note: Observatory protocol Phase 0 — executable specs over a fourth restatement

Status: implemented

English | [中文](2026-09-21-observatory-protocol-phase0.zh.md)

## Problem

The Coding-Agent Observatory design had grown through three full-restatement baselines (v2.0 review draft, v2.1, v2.2), each replacing the previous file. Rules tightened every round while the deliverable stayed zero: no schema, no fixture, no runner. Two structural defects follow from that pattern — semantic changes between baselines are unreviewable because there are no stable clause numbers, and unimplemented rules cannot expose their own contradictions. The contradiction was real: v2.2 §6 mandates a `study_lock_digest` on every envelope, while v2.2 §17 Phase 0 runs synthetic producers with no study in existence, making every legal validation input formally illegal.

## Decision

方案 v2.3 (`docs/mozi-fork/Coding-Agent-Observatory方案-v2.3.md`) changes the document regime: v2.2 stays the standing protocol baseline and later revisions arrive as numbered amendment clauses against it, not as new restatements. v2.3 rules on the three blocking defects of the lineage — the study-binding contradiction (envelopes now carry `binding: "study" | "exploratory"`, and only study-bound envelopes can enter formal snapshots), the premature PostgreSQL binding (the commit protocol now requires only a single-transaction metadata store; Phase 0/A lands on `node:sqlite` plus a filesystem CAS behind interfaces), and the unhosted specs (they live in this package as TypeScript).

The package implements Phase 0 nodes P0-A through P0-F: an owned RFC 8785 canonical encoder, a strict JSON scanner rejecting duplicate keys, non-canonical number literals, and trailing content at exact JSON Pointers; the closed `observatory.error.v1` taxonomy (four ingest-semantics codes reserved with no producer); the envelope, study-lock, and capture-profile schemas with semantic checks (binding presence and absence, payload transport pairing, `declared_size` equality, reference uniqueness); a synthetic producer whose mutators generate each violation class; and a 21-fixture corpus with a manifest that the conformance runner checks for acceptance digests and exact rejection codes — plus completeness, so an unlisted fixture file fails the suite. Per v2.3 §5 the node table in the 方案 is the progress record and node status moves in the same commit as the code.

## Consequences

Conformance is now executable: any spec change that alters acceptance must regenerate fixtures and review the manifest diff in the same PR, which is the enforcement of "rules arrive with fixtures". The encoding decision (JCS + `sha256`) is frozen by the golden digests; the number-literal strictness relies on the host's `JSON.stringify` being RFC 8785-conformant, and the RFC corpus tests are the tripwire if that assumption breaks. The `too_big` mapping, the invalid-key mapping, and the reserved codes exist because Phase A will need them, and the taxonomy being closed means adding ingest codes is a schema-versioned event, not an edit. Remaining Phase 0 exit condition is P0-G, the independent Python checker over the same corpus; until it lands, cross-language conformance is unproven and the package README says so.

## Alternatives considered

A fourth full restatement was rejected: it would have reset every clause number and repeated the unreviewable-diff problem that produced the contradiction this round fixes. A third-party canonicalization dependency was rejected because the owned encoder is key sorting over the host serializer (~20 statements) while the strict scanner is required regardless; the dependency would have deleted the easy half. Making the scanner lenient on non-canonical numbers was rejected because byte-equal resend semantics (v2.2 §6.2) need a canonical-bytes decision function at the wire, not only at rest.
