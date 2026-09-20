/**
 * Native Evidence Envelope v2.3 spec (v2.2 §6 as amended by 方案 v2.3 §2.1):
 * the transport identity and capture context of one producer observation.
 * The envelope never carries cross-engine semantic names or effect judgments,
 * and its study binding is a capture-context choice — exploratory envelopes
 * are valid captures that can never enter a formal Evidence Snapshot.
 * @module observatory-protocol/envelope
 */

import { z } from 'zod'
import { canonicalizeJson, CAPTURE_POINT_KEY_PATTERN, jsonPointer, SHA256_DIGEST_PATTERN } from './canonical.ts'
import { ObservatoryError } from './errors.ts'
import { runSpecValidation, type SpecValidation } from './spec.ts'

/** Schema identifier carried by every envelope document. */
export const ENVELOPE_SCHEMA_ID = 'observatory.native.v2.3'

/** Hard byte cap for inline payloads; larger observations must use blob tickets. */
export const MAX_INLINE_PAYLOAD_BYTES = 65_536

/** The only media type accepted for inline payloads; anything else is Phase A quarantine material. */
export const INLINE_MEDIA_TYPE = 'application/json'

/** Record kinds of the native stream protocol. */
export const RECORD_KINDS = ['stream_start', 'event', 'heartbeat', 'drop_notice', 'stream_end'] as const

/** Capture methods ordered from least to most invasive observation. */
export const CAPTURE_METHODS = ['native_hook', 'native_export', 'protocol_mirror', 'wrapper', 'source_seam'] as const

/** Payload transports: inline value or a local blob ticket reference. */
export const PAYLOAD_TRANSPORTS = ['inline', 'blob_ticket'] as const

/** Capture-context bindings: formal study membership or exploratory capture. */
export const ENVELOPE_BINDINGS = ['study', 'exploratory'] as const

/** The strict schema of one native evidence envelope document. */
export const nativeEnvelopeSchema = z.strictObject({
  schema: z.literal(ENVELOPE_SCHEMA_ID),
  binding: z.enum(ENVELOPE_BINDINGS),
  envelope_id: z.uuid(),
  producer_instance_id: z.uuid(),
  stream_id: z.uuid(),
  stream_epoch: z.number().int().min(1).max(2 ** 31 - 1),
  seq: z.number().int().min(1),
  record_kind: z.enum(RECORD_KINDS),
  capture_point_key: z.string().regex(CAPTURE_POINT_KEY_PATTERN),
  capture_point_id: z.uuid(),
  capture_method: z.enum(CAPTURE_METHODS),
  native_event_type: z.string().min(1),
  clock: z.strictObject({
    wall_time: z.iso.datetime(),
    monotonic_ns: z.number().int().min(0),
    clock_domain: z.string().min(1),
  }),
  native_links: z.array(z.strictObject({ relation: z.string().min(1), native_id: z.string().min(1) })).optional(),
  payload: z.strictObject({
    media_type: z.string().min(1),
    declared_size: z.number().int().min(0),
    transport: z.enum(PAYLOAD_TRANSPORTS),
    value: z.json().optional(),
    blob_ticket: z.string().min(1).optional(),
  }),
  spec_digest: z.string().regex(SHA256_DIGEST_PATTERN).optional(),
  study_lock_digest: z.string().regex(SHA256_DIGEST_PATTERN).optional(),
  run_attempt_id: z.uuid().optional(),
})

/** One parsed native evidence envelope. */
export type NativeEnvelope = z.infer<typeof nativeEnvelopeSchema>

const LOCK_FIELDS = ['spec_digest', 'study_lock_digest', 'run_attempt_id'] as const

function bindingChecks(envelope: NativeEnvelope): ObservatoryError[] {
  const errors: ObservatoryError[] = []
  if (envelope.binding === 'study') {
    for (const field of LOCK_FIELDS) {
      if (envelope[field] === undefined) {
        errors.push(new ObservatoryError('missing_field', jsonPointer('', field), `a study-bound envelope requires ${field}`))
      }
    }
  } else {
    for (const field of LOCK_FIELDS) {
      if (envelope[field] !== undefined) {
        errors.push(
          new ObservatoryError(
            'binding_conflict',
            jsonPointer('', field),
            `${field} is forbidden on an exploratory envelope`,
          ),
        )
      }
    }
  }
  return errors
}

function payloadChecks(envelope: NativeEnvelope): ObservatoryError[] {
  const errors: ObservatoryError[] = []
  const payload = envelope.payload
  if (payload.transport === 'inline') {
    if (payload.value === undefined) {
      errors.push(new ObservatoryError('missing_field', jsonPointer('payload', 'value'), 'an inline payload requires value'))
      return errors
    }
    if (payload.media_type !== INLINE_MEDIA_TYPE) {
      errors.push(
        new ObservatoryError('invalid_enum', jsonPointer('payload', 'media_type'), `inline payloads must use ${INLINE_MEDIA_TYPE}`),
      )
      return errors
    }
    const byteLength = Buffer.byteLength(canonicalizeJson(payload.value), 'utf8')
    if (byteLength > MAX_INLINE_PAYLOAD_BYTES) {
      errors.push(
        new ObservatoryError(
          'size_limit',
          jsonPointer('payload', 'value'),
          `inline payload exceeds ${String(MAX_INLINE_PAYLOAD_BYTES)} bytes`,
        ),
      )
      return errors
    }
    if (byteLength !== payload.declared_size) {
      errors.push(
        new ObservatoryError(
          'out_of_range',
          jsonPointer('payload', 'declared_size'),
          `declared_size ${String(payload.declared_size)} does not match the ${String(byteLength)}-byte canonical payload`,
        ),
      )
    }
    return errors
  }
  if (payload.blob_ticket === undefined) {
    errors.push(new ObservatoryError('missing_field', jsonPointer('payload', 'blob_ticket'), 'a blob-ticket payload requires blob_ticket'))
    return errors
  }
  if (payload.value !== undefined) {
    errors.push(
      new ObservatoryError('invalid_type', jsonPointer('payload', 'value'), 'value is forbidden on a blob-ticket payload'),
    )
  }
  return errors
}

/**
 * Validate one native evidence envelope document against the v2.3 spec.
 * @param text - raw JSON document text.
 * @returns the accepted envelope with canonical bytes and digest, or the sorted error list.
 */
export function validateEnvelope(text: string): SpecValidation<NativeEnvelope> {
  return runSpecValidation(text, nativeEnvelopeSchema, [bindingChecks, payloadChecks])
}
