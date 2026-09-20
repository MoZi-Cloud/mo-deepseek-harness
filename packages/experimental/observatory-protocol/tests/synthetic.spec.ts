/**
 * Synthetic producer contract: the example envelope validates, every mutator
 * produces exactly its violation class, and encoding round-trips are stable.
 * @module synthetic
 */

import { describe, expect, it } from 'vitest'
import { validateEnvelope } from '../src/envelope.ts'
import {
  encodeEnvelopeText,
  exampleEnvelope,
  withBlobTicket,
  withBlobTicketAndValue,
  withDeclaredSizeMismatch,
  withDuplicateKey,
  withExploratoryLeak,
  withMissingInlineValue,
  withMissingLockFields,
  withNonCanonicalNumber,
  withNonJsonInline,
  withOversizePayload,
  withStudyBinding,
  withTrailingContent,
  withUnknownField,
} from '../src/synthetic.ts'

function rejectCodes(text: string): string[] {
  const result = validateEnvelope(text)
  if (result.ok) throw new Error('expected rejection')
  return [...new Set(result.errors.map(error => error.code))]
}

describe('exampleEnvelope', () => {
  it('produces an envelope that validates', () => {
    const result = validateEnvelope(encodeEnvelopeText(exampleEnvelope()))
    expect(result.ok).toBe(true)
  })

  it('applies top-level overrides and encodes deterministically', () => {
    const first = encodeEnvelopeText(exampleEnvelope({ seq: 7 }))
    const second = encodeEnvelopeText(exampleEnvelope({ seq: 7 }))
    expect(first).toBe(second)
    expect(first).toContain('"seq":7')
  })
})

describe('text mutators', () => {
  const valid = encodeEnvelopeText(exampleEnvelope())

  it('withDuplicateKey introduces the duplicate-key violation', () => {
    expect(rejectCodes(withDuplicateKey(valid))).toEqual(['duplicate_key'])
  })

  it('withNonCanonicalNumber introduces the non-canonical-number violation', () => {
    expect(rejectCodes(withNonCanonicalNumber(valid))).toEqual(['non_canonical_number'])
  })

  it('withTrailingContent introduces the trailing-content violation', () => {
    expect(rejectCodes(withTrailingContent(valid))).toEqual(['trailing_content'])
  })
})

describe('object mutators', () => {
  it('withStudyBinding produces an accepted study-bound envelope', () => {
    expect(validateEnvelope(encodeEnvelopeText(withStudyBinding(exampleEnvelope()))).ok).toBe(true)
  })

  it('withBlobTicket produces an accepted blob-ticket envelope', () => {
    expect(validateEnvelope(encodeEnvelopeText(withBlobTicket(exampleEnvelope()))).ok).toBe(true)
  })

  it('withMissingLockFields introduces missing lock references', () => {
    expect(rejectCodes(encodeEnvelopeText(withMissingLockFields(exampleEnvelope())))).toEqual(['missing_field'])
  })

  it('withExploratoryLeak introduces the binding conflict', () => {
    expect(rejectCodes(encodeEnvelopeText(withExploratoryLeak(exampleEnvelope())))).toEqual(['binding_conflict'])
  })

  it('withUnknownField introduces an unknown field', () => {
    expect(rejectCodes(encodeEnvelopeText(withUnknownField(exampleEnvelope())))).toEqual(['unknown_field'])
  })

  it('withDeclaredSizeMismatch introduces the declared-size violation', () => {
    expect(rejectCodes(encodeEnvelopeText(withDeclaredSizeMismatch(exampleEnvelope())))).toEqual(['out_of_range'])
  })

  it('withOversizePayload introduces the size-limit violation', () => {
    expect(rejectCodes(encodeEnvelopeText(withOversizePayload(exampleEnvelope())))).toEqual(['size_limit'])
  })

  it('withBlobTicketAndValue introduces the blob-ticket violation', () => {
    expect(rejectCodes(encodeEnvelopeText(withBlobTicketAndValue(exampleEnvelope())))).toEqual(['invalid_type'])
  })

  it('withNonJsonInline introduces the media-type violation', () => {
    expect(rejectCodes(encodeEnvelopeText(withNonJsonInline(exampleEnvelope())))).toEqual(['invalid_enum'])
  })

  it('withMissingInlineValue introduces the missing value violation', () => {
    expect(rejectCodes(encodeEnvelopeText(withMissingInlineValue(exampleEnvelope())))).toEqual(['missing_field'])
  })
})
