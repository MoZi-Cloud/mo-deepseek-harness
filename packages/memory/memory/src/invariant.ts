/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory`.
 * @module @deepseek-ai/dsh-memory/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MEMORY_STATE_SCHEMA_VERSION, memoryDomain } from './domain.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory'

/** Cordis companion plugin name. */
export const name = 'memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: every durable memory record must carry the schema
 * version the fold layer writes and a non-negative integer revision. A
 * record that violates either proves a write path bypassed the fold layer.
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: InvariantFailure) => {
    const facility = ctx.get('storageDomain') as DomainFacility | undefined
    if (facility === undefined) return
    void facility.open(memoryDomain).then((domain) => {
      for (const [, record] of domain.table('state').entries()) {
        if (record.schemaVersion !== MEMORY_STATE_SCHEMA_VERSION) {
          fail(`memory record schemaVersion ${record.schemaVersion} !== ${MEMORY_STATE_SCHEMA_VERSION} — a write path bypassed the fold layer`)
        }
        if (record.revision < 0 || !Number.isInteger(record.revision)) {
          fail(`memory record revision ${record.revision} is not a non-negative integer — a write path bypassed the fold layer`)
        }
      }
      return domain.close()
    }).catch(() => {
      // Domain not yet open; the next tick re-checks.
    })
  },
  { inject: [] },
)

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
