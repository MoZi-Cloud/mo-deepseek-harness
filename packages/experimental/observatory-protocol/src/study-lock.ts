/**
 * Study Lock spec (`observatory.study-lock.v1`, v2.2 §4.1): the frozen
 * estimand, conditions, assignments, missingness policy, and stop rule that
 * must exist before any outcome of a formal study is visible.
 * @module observatory-protocol/study-lock
 */

import { z } from 'zod'
import { SHA256_DIGEST_PATTERN } from './canonical.ts'
import { jsonPointer, pointerFor } from './canonical.ts'
import { ObservatoryError } from './errors.ts'
import { runSpecValidation, type SpecValidation } from './spec.ts'

/** Schema identifier carried by every study lock document. */
export const STUDY_LOCK_SCHEMA_ID = 'observatory.study-lock.v1'

/** Attempt-selection policies for infrastructure reruns. */
export const MISSINGNESS_POLICIES = ['first_valid', 'all_attempt_sensitivity'] as const

/** The strict schema of one study lock document. */
export const studyLockSchema = z.strictObject({
  schema: z.literal(STUDY_LOCK_SCHEMA_ID),
  study_id: z.uuid(),
  question: z.string().min(1),
  estimand: z.strictObject({
    population: z.string().min(1),
    treatment: z.string().min(1),
    unit: z.string().min(1),
    outcome: z.string().min(1),
    summary_measure: z.string().min(1),
  }),
  conditions: z.array(z.strictObject({ condition_id: z.string().min(1), feature_state: z.string().min(1) })).min(1),
  assignments: z
    .array(
      z.strictObject({
        assignment_id: z.uuid(),
        condition_id: z.string().min(1),
        task_id: z.string().min(1),
        repeat: z.number().int().min(1),
      }),
    )
    .min(1),
  missingness_policy: z.enum(MISSINGNESS_POLICIES),
  stop_rule: z.strictObject({
    max_attempts: z.number().int().min(1),
    rule: z.string().min(1),
  }),
  input_digests: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string().regex(SHA256_DIGEST_PATTERN)),
})

/** One parsed study lock document. */
export type StudyLock = z.infer<typeof studyLockSchema>

function referenceChecks(lock: StudyLock): ObservatoryError[] {
  const errors: ObservatoryError[] = []
  const conditionIds = new Set<string>()
  for (const [index, condition] of lock.conditions.entries()) {
    if (conditionIds.has(condition.condition_id)) {
      errors.push(
        new ObservatoryError(
          'duplicate_reference',
          jsonPointer(pointerFor(['conditions', index]), 'condition_id'),
          `duplicate condition_id "${condition.condition_id}"`,
        ),
      )
    }
    conditionIds.add(condition.condition_id)
  }
  const assignmentIds = new Set<string>()
  for (const [index, assignment] of lock.assignments.entries()) {
    if (assignmentIds.has(assignment.assignment_id)) {
      errors.push(
        new ObservatoryError(
          'duplicate_reference',
          jsonPointer(pointerFor(['assignments', index]), 'assignment_id'),
          `duplicate assignment_id "${assignment.assignment_id}"`,
        ),
      )
    }
    assignmentIds.add(assignment.assignment_id)
    if (!conditionIds.has(assignment.condition_id)) {
      errors.push(
        new ObservatoryError(
          'invalid_enum',
          jsonPointer(pointerFor(['assignments', index]), 'condition_id'),
          `assignment references undeclared condition "${assignment.condition_id}"`,
        ),
      )
    }
  }
  return errors
}

/**
 * Validate one study lock document against the v1 spec.
 * @param text - raw JSON document text.
 * @returns the accepted study lock with canonical bytes and digest, or the sorted error list.
 */
export function validateStudyLock(text: string): SpecValidation<StudyLock> {
  return runSpecValidation(text, studyLockSchema, [referenceChecks])
}
