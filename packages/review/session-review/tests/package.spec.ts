import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as pkg from '../src/index.ts'
import * as companion from '../src/invariant.ts'

describe('session-review P0 skeleton', () => {
  it('reserves its plugin name without registering runtime behavior', () => {
    expect(pkg.name).toBe('session-review')
    expect(Object.hasOwn(pkg, 'apply')).toBe(false)
  })

  it('mounts an intentionally empty invariant companion', async () => {
    expect(companion.name).toBe('session-review-invariant')
    expect(companion.inject).toEqual(['invariants'])
    // The test invariant host mounts the owning companion into every root
    // (scripts/test-invariants.ts); a second registration of the same owner
    // therefore proves the companion's apply ran and reserved the name.
    const ctx = new Context()
    await ctx.plugin({ apply: () => {} })
    // Calling the companion's apply directly bypasses the host's plugin join,
    // so the duplicate-owner rejection proves the host auto-mounted the
    // companion into this root before the test ran. The deferred call converts
    // apply's synchronous throw into a rejection.
    const error = await Promise.resolve()
      .then(() => companion.apply(ctx))
      .then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      'invariants: package "@deepseek-ai/dsh-session-review" is already registered',
    )
  })
})
