/**
 * Capture Profile spec (`observatory.capture-profile.v1`, v2.2 §4.1): the
 * revision-bound declaration of capture points, their data classes, and the
 * coverage suite version any capability state must be evaluated against.
 * @module observatory-protocol/capture-profile
 */

import { z } from 'zod'
import { CAPTURE_POINT_KEY_PATTERN, SHA256_DIGEST_PATTERN, jsonPointer, pointerFor } from './canonical.ts'
import { ObservatoryError } from './errors.ts'
import { runSpecValidation, type SpecValidation } from './spec.ts'

/** Schema identifier carried by every capture profile document. */
export const CAPTURE_PROFILE_SCHEMA_ID = 'observatory.capture-profile.v1'

/** Data classes every capture point must declare (v2.1 §9.1 vocabulary). */
export const DATA_CLASSES = ['public_metadata', 'project_confidential', 'credential_like', 'forensic_restricted', 'prohibited'] as const

/** The strict schema of one capture profile document. */
export const captureProfileSchema = z.strictObject({
  schema: z.literal(CAPTURE_PROFILE_SCHEMA_ID),
  engine_revision: z.string().regex(SHA256_DIGEST_PATTERN),
  adapter_revision: z.string().regex(SHA256_DIGEST_PATTERN),
  coverage_suite_version: z.string().min(1),
  capture_points: z
    .array(
      z.strictObject({
        key: z.string().regex(CAPTURE_POINT_KEY_PATTERN),
        id: z.uuid(),
        data_class: z.enum(DATA_CLASSES),
        media_type: z.string().min(1),
        max_events_per_run: z.number().int().min(1).optional(),
      }),
    )
    .min(1),
})

/** One parsed capture profile document. */
export type CaptureProfile = z.infer<typeof captureProfileSchema>

function uniquenessChecks(profile: CaptureProfile): ObservatoryError[] {
  const errors: ObservatoryError[] = []
  const keys = new Set<string>()
  const ids = new Set<string>()
  for (const [index, point] of profile.capture_points.entries()) {
    if (keys.has(point.key)) {
      errors.push(
        new ObservatoryError(
          'duplicate_reference',
          jsonPointer(pointerFor(['capture_points', index]), 'key'),
          `duplicate capture point key "${point.key}"`,
        ),
      )
    }
    if (ids.has(point.id)) {
      errors.push(
        new ObservatoryError(
          'duplicate_reference',
          jsonPointer(pointerFor(['capture_points', index]), 'id'),
          `duplicate capture point id "${point.id}"`,
        ),
      )
    }
    keys.add(point.key)
    ids.add(point.id)
  }
  return errors
}

/**
 * Validate one capture profile document against the v1 spec.
 * @param text - raw JSON document text.
 * @returns the accepted capture profile with canonical bytes and digest, or the sorted error list.
 */
export function validateCaptureProfile(text: string): SpecValidation<CaptureProfile> {
  return runSpecValidation(text, captureProfileSchema, [uniquenessChecks])
}
