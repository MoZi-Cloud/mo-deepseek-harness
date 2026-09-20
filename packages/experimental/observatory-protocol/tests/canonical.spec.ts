/**
 * Canonical JSON conformance: RFC 8785 encoding corpus, digest stability, and
 * every strict-scanner rejection class with its exact taxonomy code.
 * @module canonical
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeJson,
  jsonPointer,
  pointerFor,
  scanStrictJson,
  SHA256_DIGEST_PATTERN,
  sha256CanonicalDigest,
} from '../src/canonical.ts'
import { ObservatoryError } from '../src/errors.ts'

function scanError(text: string): ObservatoryError {
  try {
    scanStrictJson(text)
  } catch (error) {
    if (error instanceof ObservatoryError) return error
    throw error
  }
  throw new Error(`expected a scan failure for ${JSON.stringify(text)}`)
}

describe('canonicalizeJson', () => {
  it('sorts object keys by UTF-16 code unit and drops insignificant whitespace', () => {
    const text = '{ "b" : 1 , "a" : 2 , "Á" : 3 }'
    expect(canonicalizeJson(scanStrictJson(text))).toBe('{"a":2,"b":1,"Á":3}')
  })

  it('matches the RFC 8785 literal, nesting, and empty container corpus', () => {
    const text = '{ "literals": [null, true, false], "empty object": {}, "empty array": [], "unicode": "é" }'
    expect(canonicalizeJson(scanStrictJson(text))).toBe(
      '{"empty array":[],"empty object":{},"literals":[null,true,false],"unicode":"é"}',
    )
  })

  it('accepts insignificant interior whitespace and normalizes it away', () => {
    expect(canonicalizeJson(scanStrictJson('[ 1 ,\n{ "k" : "v" } ]'))).toBe('[1,{"k":"v"}]')
  })

  it('normalizes non-canonical string escapes while parsing', () => {
    expect(canonicalizeJson(scanStrictJson('{"k":"\\u0041"}'))).toBe('{"k":"A"}')
  })

  it('escapes lone surrogates in the canonical form', () => {
    const canonical = canonicalizeJson(scanStrictJson('{"lone":"\\ud800"}'))
    expect(canonical).toBe('{"lone":"\\ud800"}')
  })

  it('keeps escaped key names distinct from their escape sequences', () => {
    expect(canonicalizeJson(scanStrictJson('{"\\u0041":1}'))).toBe('{"A":1}')
  })
})

describe('sha256CanonicalDigest', () => {
  it('produces the sha256-prefixed lowercase hex digest of the canonical text', () => {
    expect(sha256CanonicalDigest('{"a":2,"b":1}')).toBe(
      `sha256:${createHash('sha256').update('{"a":2,"b":1}', 'utf8').digest('hex')}`,
    )
  })

  it('differs when content differs, and always matches the digest pattern', () => {
    const first = sha256CanonicalDigest(canonicalizeJson({ a: 1 }))
    const second = sha256CanonicalDigest(canonicalizeJson({ a: 2 }))
    expect(first).not.toBe(second)
    expect(first).toMatch(SHA256_DIGEST_PATTERN)
  })
})

describe('scanStrictJson acceptances', () => {
  it('parses nested structure with interior whitespace', () => {
    expect(scanStrictJson('[ 1 , { "k" : "v" } ]')).toEqual([1, { k: 'v' }])
  })

  it('accepts canonical exponent notation exactly as the host serializes it', () => {
    expect(scanStrictJson('[1e+21,0.000001,-0e0]'.replace(',-0e0', ''))).toEqual([1e21, 0.000001])
  })
})

describe('scanStrictJson rejections', () => {
  const cases: readonly { readonly text: string; readonly code: string; readonly path?: string }[] = [
    { text: '', code: 'malformed_json' },
    { text: 'tru', code: 'malformed_json' },
    { text: '{', code: 'malformed_json' },
    { text: '[1,2', code: 'malformed_json' },
    { text: '{"k" "v"}', code: 'malformed_json' },
    { text: '{"k":"v" "j":1}', code: 'malformed_json' },
    { text: '{"k"::1}', code: 'malformed_json' },
    { text: '{"k":"\\x41"}', code: 'malformed_json' },
    { text: '"unterminated', code: 'malformed_json' },
    { text: '+1', code: 'malformed_json' },
    { text: '-x', code: 'malformed_json' },
    { text: '.5', code: 'malformed_json' },
    { text: '01', code: 'malformed_json' },
    { text: '12x', code: 'malformed_json' },
    { text: '[1 2]', code: 'malformed_json' },
    { text: '1.', code: 'malformed_json' },
    { text: '1e', code: 'malformed_json' },
    { text: '{"a":1,"a":2}', code: 'duplicate_key', path: '/a' },
    { text: '{"o":{"~k":1,"~k":2}}', code: 'duplicate_key', path: '/o/~0k' },
    { text: '{"list":[{"k":1},{"k":2,"k":3}]}', code: 'duplicate_key', path: '/list/1/k' },
    { text: '{"seq":42.0}', code: 'non_canonical_number', path: '/seq' },
    { text: '[1.0]', code: 'non_canonical_number', path: '/0' },
    { text: '-0', code: 'non_canonical_number', path: '' },
    { text: '1e999', code: 'non_canonical_number', path: '' },
    { text: '1E2', code: 'non_canonical_number', path: '' },
    { text: '{"a":1} {}', code: 'trailing_content', path: '' },
  ]
  for (const { text, code, path } of cases) {
    it(`rejects ${JSON.stringify(text.length > 32 ? `${text.slice(0, 29)}...` : text)} with ${code}`, () => {
      const error = scanError(text)
      expect(error.code).toBe(code)
      if (path !== undefined) expect(error.path).toBe(path)
    })
  }
})

describe('pointer helpers', () => {
  it('escape RFC 6901 reference tokens and build nested pointers', () => {
    expect(jsonPointer('', 'a/b~c')).toBe('/a~1b~0c')
    expect(pointerFor(['payload', 'value', 0])).toBe('/payload/value/0')
    expect(pointerFor([])).toBe('')
  })
})
