/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-review`.
 * @module @deepseek-ai/dsh-session-review/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-review'

/** Cordis companion plugin name. */
export const name = 'session-review-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the P0 skeleton owns no services or durable events —
 * its Evidence Lock suite pins cross-package behavior facts from tests, and
 * the review runtime's own invariants arrive with the runtime that owns them.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
