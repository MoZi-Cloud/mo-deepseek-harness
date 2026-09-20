/**
 * Envelope spec conformance: binding semantics, payload transport rules, and
 * the schema-issue to taxonomy-code mapping.
 * @module envelope
 */

import { describe, expect, it } from 'vitest'
import { sha256CanonicalDigest } from '../src/canonical.ts'
import { ENVELOPE_SCHEMA_ID, validateEnvelope } from '../src/envelope.ts'
import {
  encodeEnvelopeText,
  exampleEnvelope,
  withBlobTicket,
  withBlobTicketAndValue,
  withDeclaredSizeMismatch,
  withDuplicateKey,
  withExploratoryLeak,
  withMissingBlobTicket,
  withMissingInlineValue,
  withMissingLockFields,
  withNonCanonicalNumber,
  withNonJsonInline,
  withOversizePayload,
  withStudyBinding,
  withTrailingContent,
  withUnknownField,
} from '../src/synthetic.ts'

function codesOf(text: string): string[] {
  const result = validateEnvelope(text)
  if (result.ok) throw new Error('expected rejection')
  return [...new Set(result.errors.map(error => error.code))]
}

describe('accepted envelopes', () => {
  it('accepts the exploratory example with stable canonical bytes and digest', () => {
    const result = validateEnvelope(encodeEnvelopeText(exampleEnvelope()))
    if (!result.ok) throw new Error(result.errors.map(error => error.message).join('; '))
    expect(result.value.schema).toBe(ENVELOPE_SCHEMA_ID)
    expect(result.digest).toBe(sha256CanonicalDigest(result.canonical))
    expect(result.canonical).not.toContain(' ')
  })

  it('accepts a fully study-bound envelope with native links', () => {
    const result = validateEnvelope(encodeEnvelopeText(withStudyBinding(exampleEnvelope())))
    expect(result.ok).toBe(true)
  })

  it('accepts a blob-ticket payload with a declared media type', () => {
    const result = validateEnvelope(encodeEnvelopeText(withBlobTicket(exampleEnvelope())))
    expect(result.ok).toBe(true)
  })
})

describe('binding semantics', () => {
  it('requires all three lock references on a study-bound envelope', () => {
    const result = validateEnvelope(encodeEnvelopeText(withMissingLockFields(exampleEnvelope())))
    if (result.ok) throw new Error('expected rejection')
    expect([...new Set(result.errors.map(error => error.code))]).toEqual(['missing_field'])
    expect(result.errors).toHaveLength(3)
  })

  it('forbids lock references on an exploratory envelope', () => {
    expect(codesOf(encodeEnvelopeText(withExploratoryLeak(exampleEnvelope())))).toEqual(['binding_conflict'])
  })
})

describe('payload semantics', () => {
  it('rejects an inline payload without its value', () => {
    expect(codesOf(encodeEnvelopeText(withMissingInlineValue(exampleEnvelope())))).toEqual(['missing_field'])
  })

  it('rejects a non-JSON inline media type', () => {
    expect(codesOf(encodeEnvelopeText(withNonJsonInline(exampleEnvelope())))).toEqual(['invalid_enum'])
  })

  it('rejects an inline payload over the size cap', () => {
    expect(codesOf(encodeEnvelopeText(withOversizePayload(exampleEnvelope())))).toEqual(['size_limit'])
  })

  it('rejects a declared_size that does not match the canonical payload bytes', () => {
    expect(codesOf(encodeEnvelopeText(withDeclaredSizeMismatch(exampleEnvelope())))).toEqual(['out_of_range'])
  })

  it('rejects a blob-ticket payload that carries an inline value', () => {
    expect(codesOf(encodeEnvelopeText(withBlobTicketAndValue(exampleEnvelope())))).toEqual(['invalid_type'])
  })
})

describe('strict wire and schema mapping', () => {
  it('rejects duplicate keys from the scanner', () => {
    expect(codesOf(withDuplicateKey(encodeEnvelopeText(exampleEnvelope())))).toEqual(['duplicate_key'])
  })

  it('rejects non-canonical number literals from the scanner', () => {
    expect(codesOf(withNonCanonicalNumber(encodeEnvelopeText(exampleEnvelope())))).toEqual(['non_canonical_number'])
  })

  it('rejects trailing content from the scanner', () => {
    expect(codesOf(withTrailingContent(encodeEnvelopeText(exampleEnvelope())))).toEqual(['trailing_content'])
  })

  it('maps unknown top-level fields to unknown_field', () => {
    expect(codesOf(encodeEnvelopeText(withUnknownField(exampleEnvelope())))).toEqual(['unknown_field'])
  })

  it('maps invalid enum values, malformed formats, and out-of-range numbers to their codes', () => {
    const badRecordKind = encodeEnvelopeText({ ...exampleEnvelope(), record_kind: 'milestone' })
    expect(codesOf(badRecordKind)).toEqual(['invalid_enum'])

    const badUuid = encodeEnvelopeText({ ...exampleEnvelope(), envelope_id: 'not-a-uuid' })
    expect(codesOf(badUuid)).toEqual(['invalid_type'])

    const badCaptureKey = encodeEnvelopeText({ ...exampleEnvelope(), capture_point_key: 'No-Dots' })
    expect(codesOf(badCaptureKey)).toEqual(['invalid_type'])

    const badEpoch = encodeEnvelopeText({ ...exampleEnvelope(), stream_epoch: 0 })
    expect(codesOf(badEpoch)).toEqual(['out_of_range'])

    const badCaptureMethod = encodeEnvelopeText({ ...exampleEnvelope(), capture_method: 'telepathy' })
    expect(codesOf(badCaptureMethod)).toEqual(['invalid_enum'])
  })

  it('maps out-of-bound maxima to out_of_range', () => {
    const badEpoch = encodeEnvelopeText({ ...exampleEnvelope(), stream_epoch: 2 ** 31 })
    expect(codesOf(badEpoch)).toEqual(['out_of_range'])
  })

  it('rejects a blob-ticket transport without the ticket', () => {
    expect(codesOf(encodeEnvelopeText(withMissingBlobTicket(exampleEnvelope())))).toEqual(['missing_field'])
  })

  it('maps missing required fields to missing_field', () => {
    const envelope = exampleEnvelope()
    delete envelope['native_event_type']
    expect(codesOf(encodeEnvelopeText(envelope))).toEqual(['missing_field'])
  })

  it('maps wrong-typed fields to invalid_type', () => {
    const badClock = encodeEnvelopeText({
      ...exampleEnvelope(),
      clock: { wall_time: 12345, monotonic_ns: 0, clock_domain: 'process' },
    })
    expect(codesOf(badClock)).toEqual(['invalid_type'])
  })

  it('fails loudly on structurally invalid input instead of reporting schema errors', () => {
    const result = validateEnvelope('{')
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.map(error => error.code)).toEqual(['malformed_json'])
  })
})
