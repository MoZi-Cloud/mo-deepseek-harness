# Agent Note: Session review P0 skeleton and the Evidence Lock suite

Status: implemented

English | [中文](2026-08-31-session-review-p0-skeleton.zh.md)

## Problem

The session review runtime (self-evolution: consolidating finished session ranges into memory records and managed skills) was frozen at design RC5.5.2 with a mandated P0 phase: pin the cross-package behavior facts the design relies on before any runtime code lands, with zero behavior change. The facts span storage, filesystem, skill-registry, and tool-surface contracts, and the design's own protocols (receipts, name reservation, pending catalog revisions, finalization ordering) had to be shown to work on the real infrastructure. No package existed to host this suite.

## Decision

New `review/` group with one package, `@deepseek-ai/dsh-session-review`, as a P0 skeleton: it reserves the Cordis plugin name `session-review`, owns an explained-empty invariant companion, and registers no runtime behavior. The Evidence Lock suite lives at `tests/evidence-lock/`, implementing the 68-case P0 matrix from `docs/mozi-fork/RC5.5-附件P0-evidence-lock.md` (66 active cases plus two historical-regression replays). Cases drive real infrastructure directly; cases describing the runtime's future protocols run reference implementations inside the tests over that same real infrastructure. Those prototypes are deliberately test-only: they carry no coverage obligation and must not be promoted into production code when the runtime lands — the runtime package will own its own implementations and invariants.

Registration footprint stays mechanical: the subsystem-pages gate gains a `review` exemption (no runtime subsystem exists yet), the group joins the `packages/README.md` table, and the aggregate tsconfig references the package.

## Consequences

Assumptions of the review design now fail a test instead of a runtime incident: changing one of the pinned contracts surfaces the exact matrix case in `packages/review/session-review/tests/evidence-lock/`. The cost is upkeep — the suite re-pins contracts the owning packages already test, so a contract change can require updating two suites in one PR. The suite also grows a dependency surface wider than the package will ever import at runtime; devDependencies must keep matching what the tests import, or knip fails loud.

## Alternatives considered

Hosting the suite inside the owning packages (skill, storage, fs) was rejected: the matrix's value is cross-package juxtaposition with a single owner and a single number to cite in design documents, and spreading it would lose both. Deferring the suite until the runtime exists was rejected by the design itself — the point of P0 is to discover infrastructure surprises before the runtime encodes them.

Two harness facts the suite relies on, recorded here because they cost debugging time: the test invariant host joins a duplicate plugin mount by resolved callback, so a companion's registration can only be proven by invoking its `apply` directly against the already-mounted service; and a companion's `apply` throws synchronously (the registration happens while evaluating the `Promise.resolve` argument), so callers that want a rejection must defer the call.

## Verification

`npx vitest run packages/review/session-review/tests` for the suite; `npx tsc -b packages/review/session-review`; `verify-package-invariants`, `verify-subsystem-pages`, `verify-package-readme-limitations`, `verify-tsconfig-paths`, `verify-translation-pairing`.
