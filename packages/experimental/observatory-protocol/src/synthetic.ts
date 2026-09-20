/**
 * Synthetic producer for conformance work: builds valid envelope documents and
 * systematic per-class violations without running any agent. The committed
 * fixture corpus is generated from these builders; the mutators double as the
 * negative-class reference for Phase A ingest tests.
 * @module observatory-protocol/synthetic
 */

import { type JsonValue, canonicalizeJson } from './canonical.ts'

/** Typed envelope object usable directly as canonical JSON input. */
type EnvelopeObject = { [key: string]: JsonValue }

const LOCK_FIELD_VALUES = {
  spec_digest: `sha256:${'a'.repeat(64)}`,
  study_lock_digest: `sha256:${'b'.repeat(64)}`,
  run_attempt_id: '51842634-e23a-4c74-8d96-4af4a5a41f86',
} as const

/**
 * Build one valid exploratory envelope object with a self-consistent inline
 * payload (`declared_size` matches the canonical payload bytes).
 * @param overrides - deep-spread-free top-level field overrides applied last.
 * @returns the envelope object; encode with {@link encodeEnvelopeText}.
 */
export function exampleEnvelope(overrides: EnvelopeObject = {}): EnvelopeObject {
  const payloadValue = { note: 'synthetic' }
  return {
    schema: 'observatory.native.v2.3',
    binding: 'exploratory',
    envelope_id: '0d2b3d5e-8e27-4d20-9a2a-6cf5dc3f1d20',
    producer_instance_id: '9a4f4f2a-64c1-4c47-83b6-0be1a3a2f3b4',
    stream_id: '7fbfa2d6-4d68-4f03-9f22-e46b1f3c1a55',
    stream_epoch: 1,
    seq: 42,
    record_kind: 'event',
    capture_point_key: 'dsh.session.event.commit',
    capture_point_id: '2f9ec2f7-31cb-4b3d-9db6-b5db2a4d1b21',
    capture_method: 'native_hook',
    native_event_type: 'dsh.session.event',
    clock: {
      wall_time: '2026-09-21T00:00:00.000Z',
      monotonic_ns: 123456789,
      clock_domain: 'process',
    },
    payload: {
      media_type: 'application/json',
      declared_size: Buffer.byteLength(canonicalizeJson(payloadValue), 'utf8'),
      transport: 'inline',
      value: payloadValue,
    },
    ...overrides,
  }
}

/**
 * Encode one envelope object as canonical JSON text.
 * @param envelope - the envelope object to encode.
 * @returns the canonical JSON text.
 */
export function encodeEnvelopeText(envelope: EnvelopeObject): string {
  return canonicalizeJson(envelope)
}

/**
 * Duplicate the `stream_epoch` member in encoded envelope text.
 * @param text - canonical envelope text from {@link encodeEnvelopeText}.
 * @returns text violating the duplicate-key rule.
 */
export function withDuplicateKey(text: string): string {
  return text.replace('"stream_epoch":1', '"stream_epoch":1,"stream_epoch":1')
}

/**
 * Rewrite `seq` as a non-canonical number literal.
 * @param text - canonical envelope text from {@link encodeEnvelopeText}.
 * @returns text violating the canonical-number rule.
 */
export function withNonCanonicalNumber(text: string): string {
  return text.replace('"seq":42', '"seq":42.0')
}

/**
 * Append trailing content after the root value.
 * @param text - canonical envelope text from {@link encodeEnvelopeText}.
 * @returns text violating the trailing-content rule.
 */
export function withTrailingContent(text: string): string {
  return `${text} null`
}

/**
 * Add an unknown top-level member.
 * @param envelope - the envelope object to mutate.
 * @returns the envelope object carrying an unknown field.
 */
export function withUnknownField(envelope: EnvelopeObject): EnvelopeObject {
  return { ...envelope, observation_note: 'unknown top-level extension' }
}

/**
 * Turn the envelope into a fully study-bound one.
 * @param envelope - the envelope object to mutate.
 * @returns the study-bound envelope object.
 */
export function withStudyBinding(envelope: EnvelopeObject): EnvelopeObject {
  return { ...envelope, binding: 'study', ...LOCK_FIELD_VALUES }
}

/**
 * A study-bound envelope missing `spec_digest`, `study_lock_digest`, and `run_attempt_id`.
 * @param envelope - the envelope object to mutate.
 * @returns the study-bound envelope object without its lock references.
 */
export function withMissingLockFields(envelope: EnvelopeObject): EnvelopeObject {
  return { ...envelope, binding: 'study' }
}

/**
 * An exploratory envelope that illegally carries `spec_digest`.
 * @param envelope - the envelope object to mutate.
 * @returns the leaking exploratory envelope object.
 */
export function withExploratoryLeak(envelope: EnvelopeObject): EnvelopeObject {
  return { ...envelope, spec_digest: LOCK_FIELD_VALUES.spec_digest }
}

/**
 * Break the declared inline payload size.
 * @param envelope - the envelope object to mutate.
 * @returns the envelope object with a wrong `payload.declared_size`.
 */
export function withDeclaredSizeMismatch(envelope: EnvelopeObject): EnvelopeObject {
  const payload = { ...(envelope['payload'] as EnvelopeObject), declared_size: 999 }
  return { ...envelope, payload }
}

/**
 * Replace the inline payload with one over the size cap.
 * @param envelope - the envelope object to mutate.
 * @returns the envelope object with an oversized inline payload.
 */
export function withOversizePayload(envelope: EnvelopeObject): EnvelopeObject {
  const oversized = 'x'.repeat(70_000)
  const payload = {
    media_type: 'application/json',
    declared_size: oversized.length + 2,
    transport: 'inline',
    value: { blob: oversized },
  }
  return { ...envelope, payload }
}

/**
 * Point the payload at a local blob ticket instead of an inline value.
 * @param envelope - the envelope object to mutate.
 * @returns the envelope object with a well-formed blob-ticket payload.
 */
export function withBlobTicket(envelope: EnvelopeObject): EnvelopeObject {
  const payload = {
    media_type: 'application/octet-stream',
    declared_size: 4096,
    transport: 'blob_ticket',
    blob_ticket: 'spool/9f2/capture-blob-0001',
  }
  return { ...envelope, payload }
}

/**
 * Declare the blob-ticket transport without the ticket itself.
 * @param envelope - the envelope object to mutate.
 * @returns the envelope object missing `payload.blob_ticket`.
 */
export function withMissingBlobTicket(envelope: EnvelopeObject): EnvelopeObject {
  const payload = {
    media_type: 'application/octet-stream',
    declared_size: 4096,
    transport: 'blob_ticket',
  }
  return { ...envelope, payload }
}

/**
 * Keep a blob-ticket transport but smuggle an inline value back in.
 * @param envelope - the envelope object to mutate.
 * @returns the envelope object violating the blob-ticket payload rule.
 */
export function withBlobTicketAndValue(envelope: EnvelopeObject): EnvelopeObject {
  const payload = {
    media_type: 'application/octet-stream',
    declared_size: 4096,
    transport: 'blob_ticket',
    blob_ticket: 'spool/9f2/capture-blob-0001',
    value: { smuggled: true },
  }
  return { ...envelope, payload }
}

/**
 * Declare a non-JSON inline media type (the credential-like binary case that
 * must fail closed instead of passing a text scan).
 * @param envelope - the envelope object to mutate.
 * @returns the envelope object violating the inline media-type rule.
 */
export function withNonJsonInline(envelope: EnvelopeObject): EnvelopeObject {
  const payload = {
    media_type: 'text/plain',
    declared_size: 11,
    transport: 'inline',
    value: 'raw secret!',
  }
  return { ...envelope, payload }
}

/**
 * Drop the inline payload value entirely.
 * @param envelope - the envelope object to mutate.
 * @returns the envelope object missing `payload.value`.
 */
export function withMissingInlineValue(envelope: EnvelopeObject): EnvelopeObject {
  const payload = { ...envelope['payload'] as EnvelopeObject }
  delete payload.value
  return { ...envelope, payload }
}
