/**
 * Conformance runner over the committed fixture corpus: every fixture file is
 * validated against its manifest expectation (accept with exact digest, or
 * reject with an exact sorted code set), and the manifest must cover every
 * file on disk. The Python checker in Phase 0 node P0-G consumes the same
 * corpus and manifest.
 * @module conformance
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateCaptureProfile } from '../src/capture-profile.ts'
import { validateEnvelope } from '../src/envelope.ts'
import type { SpecValidation } from '../src/spec.ts'
import { validateStudyLock } from '../src/study-lock.ts'

const fixturesRoot = join(import.meta.dirname, 'fixtures')

interface FixtureExpectation {
  readonly file: string
  readonly target: 'envelope' | 'study-lock' | 'capture-profile'
  readonly expect:
    | { readonly verdict: 'accept'; readonly digest: string }
    | { readonly verdict: 'reject'; readonly codes: readonly string[] }
}

interface FixtureManifest {
  readonly fixtures: readonly FixtureExpectation[]
}

const manifest = JSON.parse(readFileSync(join(fixturesRoot, 'manifest.json'), 'utf8')) as FixtureManifest

function validateTarget(target: FixtureExpectation['target'], text: string): SpecValidation<unknown> {
  switch (target) {
    case 'envelope':
      return validateEnvelope(text)
    case 'study-lock':
      return validateStudyLock(text)
    case 'capture-profile':
      return validateCaptureProfile(text)
  }
  throw new Error(`unknown fixture target ${String(target)}`)
}

function listedFiles(): Set<string> {
  return new Set(manifest.fixtures.map(entry => join(fixturesRoot, entry.file)))
}

function filesOnDisk(): string[] {
  const found: string[] = []
  for (const directory of ['positive', 'negative']) {
    const full = join(fixturesRoot, directory)
    for (const entry of readdirSync(full)) {
      if (entry.endsWith('.json')) found.push(join(full, entry))
    }
  }
  return found.sort()
}

describe('fixture corpus coverage', () => {
  it('covers every fixture file on disk exactly once', () => {
    const listed = [...listedFiles()].sort()
    expect(listed).toEqual(filesOnDisk())
  })

  it('declares at least one fixture for every spec target', () => {
    const targets = new Set(manifest.fixtures.map(entry => entry.target))
    expect(targets).toEqual(new Set(['envelope', 'study-lock', 'capture-profile']))
  })
})

for (const entry of manifest.fixtures) {
  it(`${entry.file} → ${entry.expect.verdict}`, () => {
    const raw = readFileSync(join(fixturesRoot, entry.file), 'utf8')
    const result = validateTarget(entry.target, raw.replace(/\n$/, ''))
    if (entry.expect.verdict === 'accept') {
      if (!result.ok) throw new Error(result.errors.map(error => error.message).join('; '))
      expect(result.digest).toBe(entry.expect.digest)
    } else {
      if (result.ok) throw new Error('expected rejection')
      expect([...new Set(result.errors.map(error => error.code))]).toEqual(entry.expect.codes)
    }
  })
}

describe('validator dispatch', () => {
  it('rejects unknown fixture targets instead of guessing', () => {
    const bogus = 'bogus' as FixtureExpectation['target']
    expect(() => validateTarget(bogus, '{}')).toThrow('unknown fixture target')
  })
})
