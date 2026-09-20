/**
 * Error taxonomy conformance: closed vocabulary, reserved ingest codes, and
 * deterministic ordering of collected errors.
 * @module errors
 */

import { describe, expect, it } from 'vitest'
import {
  compareObservatoryErrors,
  isObservatoryErrorCode,
  OBSERVATORY_ERROR_CODES,
  ObservatoryError,
  RESERVED_ERROR_CODES,
  sortObservatoryErrors,
} from '../src/errors.ts'

describe('taxonomy vocabulary', () => {
  it('is closed and contains no duplicates', () => {
    expect(new Set(OBSERVATORY_ERROR_CODES).size).toBe(OBSERVATORY_ERROR_CODES.length)
  })

  it('marks the ingest-semantics codes reserved in this phase', () => {
    for (const code of RESERVED_ERROR_CODES) {
      expect(isObservatoryErrorCode(code)).toBe(true)
    }
    expect(RESERVED_ERROR_CODES).toContain('identity_conflict')
    expect(RESERVED_ERROR_CODES).toContain('quarantine')
  })

  it('recognizes declared codes and rejects unknown strings', () => {
    expect(isObservatoryErrorCode('duplicate_key')).toBe(true)
    expect(isObservatoryErrorCode('no_such_code')).toBe(false)
  })
})

describe('error ordering', () => {
  it('reports errors sorted by pointer, then code, then message', () => {
    const later = new ObservatoryError('invalid_enum', '/b', 'second pointer')
    const earlier = new ObservatoryError('duplicate_key', '/a', 'first pointer')
    const samePathCodeA = new ObservatoryError('invalid_enum', '/b', 'alpha detail')
    const samePathCodeB = new ObservatoryError('invalid_enum', '/b', 'beta detail')
    const sorted = sortObservatoryErrors([later, samePathCodeB, earlier, samePathCodeA])
    expect(sorted.map(error => error.message)).toEqual([
      earlier.message,
      samePathCodeA.message,
      samePathCodeB.message,
      later.message,
    ])
  })

  it('breaks message ties as equal and exposes pointer and code on the error', () => {
    const first = new ObservatoryError('size_limit', '/payload', 'too large')
    const second = new ObservatoryError('size_limit', '/payload', 'too large')
    expect(compareObservatoryErrors(first, second)).toBe(0)
    const beta = new ObservatoryError('invalid_enum', '/b', 'beta detail')
    const alpha = new ObservatoryError('invalid_enum', '/b', 'alpha detail')
    expect(compareObservatoryErrors(beta, alpha)).toBe(1)
    const codeA = new ObservatoryError('duplicate_key', '/b', 'alpha detail')
    expect(compareObservatoryErrors(codeA, beta)).toBe(-1)
    expect(compareObservatoryErrors(beta, codeA)).toBe(1)
    expect(first.code).toBe('size_limit')
    expect(first.path).toBe('/payload')
    expect(first.message).toContain('/payload')
    expect(first.name).toBe('ObservatoryError')
  })
})
