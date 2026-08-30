/**
 * Session review runtime: bounded, idempotent consolidation of finished
 * session ranges into memory records and managed skills.
 *
 * P0 skeleton: the package owns no runtime behavior yet. Its deliverable is
 * the Evidence Lock suite under `tests/evidence-lock/`, which pins the
 * cross-package behavior facts the review design relies on before any
 * production code lands. The plugin name below is the reserved Cordis
 * registration; `inject`/`apply` and the service surface arrive with the
 * runtime itself.
 * @module @deepseek-ai/dsh-session-review
 */

/** Reserved Cordis plugin name; nothing mounts this package until the review runtime lands. */
export const name = 'session-review'
