# Agent Note: Session review P0 skeleton and the Evidence Lock suite

Status: implemented

English | [中文](2026-08-31-session-review-p0-skeleton.zh.md)

## Problem

The session review runtime (self-evolution: consolidating finished session ranges into memory records and managed skills) was frozen at design RC5.5.2 with a mandated P0 phase: pin the cross-package behavior facts the design relies on before any runtime code lands, with zero behavior change. The facts span storage, filesystem, skill-registry, and tool-surface contracts, and the design's own protocols (receipts, name reservation, pending catalog revisions, finalization ordering) had to be shown to work on the real infrastructure. No package existed to host this suite.

## Decision

New `review/` group with one package, `@deepseek-ai/dsh-session-review`, as a P0 skeleton: it reserves the Cordis plugin name `session-review`, owns an explained-empty invariant companion, and registers no runtime behavior. The Evidence Lock suite lives at `tests/evidence-lock/`, implementing the 68-case P0 matrix from `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md` (66 active cases plus two historical-regression replays). Cases drive real infrastructure directly; cases describing the runtime's future protocols run reference implementations inside the tests over that same real infrastructure. Those prototypes are deliberately test-only: they carry no coverage obligation and must not be promoted into production code when the runtime lands — the runtime package will own its own implementations and invariants.

Registration footprint stays mechanical: the subsystem-pages gate gains a `review` exemption (no runtime subsystem exists yet), the group joins the `packages/README.md` table, and the aggregate tsconfig references the package.

The matrix is fully pinned: 72 tests across ten spec files cover all 68 cases — storage/fs contracts, the skill registry, the session/tools/subagent/query/preset faces, and the review protocol itself: cursor claim and settlement, append-only ledger attempts, name reservation, record CAS with receipt sets, the completion-marker bundle protocol, saga finalization ordering, and grouped terminal acks. The protocol cases run two reference modules (`review-protocol.ts`, `managed-protocol.ts`) over real storage-domain write chains and real `ctx.fs` bundles; the memory-domain cases run over the real Cordis service registry.

## Consequences

Assumptions of the review design now fail a test instead of a runtime incident: changing one of the pinned contracts surfaces the exact matrix case in `packages/review/session-review/tests/evidence-lock/`. The cost is upkeep — the suite re-pins contracts the owning packages already test, so a contract change can require updating two suites in one PR. The suite also grows a dependency surface wider than the package will ever import at runtime; devDependencies must keep matching what the tests import, or knip fails loud.

## Assumptions the suite corrected

- T01: an unknown provider is an async `NO_PROVIDER` rejection, not a synchronous throw; duplicate provider registration is the synchronous throw.
- T04: the durable child header keys are camelCase (`parentSession`, `delegationDepth`); the matrix spelled `parent_session`.
- T05: `session-query` lives at `packages/session-query/session-query`, not under `packages/session/`.
- T28/T29/T42/T43 name future P1/P3 mechanisms with no production implementation. The cursor, claim, memory-service, and composite-snapshot facts are pinned by test-tree reference implementations. T42/T43 were missing from the earlier batch plan; they are included here because the acceptance gate requires all 68 cases.
- T12: `SubagentStopReasonMap` is a type-only export; the terminal-state set is pinned as a typed array, not by enumerating a runtime object.
- T15: the durable `tool/result` event carries no exec identity — the name is recoverable only by pairing with `tool/call` via callId; provider attribution lives on the live `tools/result` channel (T41).
- T44: single-open is two layers. The same facility rejects a reopen with the `already-open` domain error; a second facility over the same backend hits the backend's "unit is already open" live-handle guard.
- T16: pre-step waterfall registration order makes the first listener outermost, so an inner listener's `next()` cannot observe outer listeners' products. The catalog fact is pinned through the awaited decision, not a nested listener.
- The stock filesystem skill provider is named `filesystem`; `self-evolution-managed` is reserved for evolution output.
- `defineContentToolFixture` takes a property-map dialect (`{ text: { type: 'string', required: true } }`), not a raw JSON schema.
- The pre-push hook's fresh `tsc -b tsconfig.host.json` catches spec type errors that an incremental `pnpm run typecheck` misses; reproduce the hook sequence before every push.

## Alternatives considered

Hosting the suite inside the owning packages (skill, storage, fs) was rejected: the matrix's value is cross-package juxtaposition with a single owner and a single number to cite in design documents, and spreading it would lose both. Deferring the suite until the runtime exists was rejected by the design itself — the point of P0 is to discover infrastructure surprises before the runtime encodes them.

Two harness facts the suite relies on, recorded here because they cost debugging time: the test invariant host joins a duplicate plugin mount by resolved callback, so a companion's registration can only be proven by invoking its `apply` directly against the already-mounted service; and a companion's `apply` throws synchronously (the registration happens while evaluating the `Promise.resolve` argument), so callers that want a rejection must defer the call.

## Verification

`npx vitest run packages/review/session-review/tests` (72 tests) for the suite; `npm run build:lib:host && npm run typecheck:contracts-ready` (the pre-push sequence — not an incremental `pnpm run typecheck`); `verify-package-invariants`, `verify-subsystem-pages`, `verify-package-readme-limitations`, `verify-tsconfig-paths`, `verify-translation-pairing`.
