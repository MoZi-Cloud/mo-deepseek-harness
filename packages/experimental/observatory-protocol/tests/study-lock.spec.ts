/**
 * Study lock and capture profile spec conformance: digest sensitivity, schema
 * mapping, and reference uniqueness across both registry-facing specs.
 * @module study-lock, capture-profile
 */

import { describe, expect, it } from 'vitest'
import { canonicalizeJson, type JsonValue, sha256CanonicalDigest } from '../src/canonical.ts'
import { validateCaptureProfile } from '../src/capture-profile.ts'
import { validateStudyLock } from '../src/study-lock.ts'

const NO_LEARNING_CONDITION = { condition_id: 'no-learning', feature_state: 'memory off, skill off' }
const RECALL_CONDITION = { condition_id: 'recall-enabled', feature_state: 'memory recall on, governance on' }
const ASSIGNMENT_NO_LEARNING = {
  assignment_id: 'd1d1d1d1-1111-4111-8111-111111111111',
  condition_id: 'no-learning',
  task_id: 'task-001',
  repeat: 1,
}
const ASSIGNMENT_RECALL = {
  assignment_id: 'd2d2d2d2-2222-4222-8222-222222222222',
  condition_id: 'recall-enabled',
  task_id: 'task-002',
  repeat: 3,
}

const STUDY_LOCK = {
  schema: 'observatory.study-lock.v1',
  study_id: 'c2a5e8d1-7f3b-4a99-9e0c-1d2f3a4b5c6d',
  question: 'does governed memory reuse improve held-out task outcomes',
  estimand: {
    population: 'held-out transfer tasks in the pinned repository family',
    treatment: 'recall-enabled versus no-learning',
    unit: 'assignment cell',
    outcome: 'deterministic validator pass rate',
    summary_measure: 'average treatment effect',
  },
  conditions: [NO_LEARNING_CONDITION, RECALL_CONDITION],
  assignments: [ASSIGNMENT_NO_LEARNING, ASSIGNMENT_RECALL],
  missingness_policy: 'first_valid',
  stop_rule: { max_attempts: 3, rule: 'stop after three infrastructure failures per assignment' },
  input_digests: {
    'task-set': 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  },
}

const SESSION_EVENT_POINT = {
  key: 'dsh.session.event.commit',
  id: '2f9ec2f7-31cb-4b3d-9db6-b5db2a4d1b21',
  data_class: 'project_confidential',
  media_type: 'application/json',
  max_events_per_run: 10_000,
}

const CAPTURE_PROFILE = {
  schema: 'observatory.capture-profile.v1',
  engine_revision: `sha256:${'e'.repeat(64)}`,
  adapter_revision: `sha256:${'f'.repeat(64)}`,
  coverage_suite_version: 'synthetic-coverage-2026-09',
  capture_points: [
    SESSION_EVENT_POINT,
    {
      key: 'dsh.memory.publish.commit',
      id: '3f9ec2f7-31cb-4b3d-9db6-b5db2a4d1b22',
      data_class: 'credential_like',
      media_type: 'application/json',
    },
  ],
}

function textOf(value: JsonValue): string {
  return canonicalizeJson(value)
}

describe('study lock validation', () => {
  it('accepts a well-formed lock and produces a digest of its canonical bytes', () => {
    const result = validateStudyLock(textOf(STUDY_LOCK))
    if (!result.ok) throw new Error(result.errors.map(error => error.message).join('; '))
    expect(result.digest).toBe(sha256CanonicalDigest(result.canonical))
    expect(result.value.conditions).toHaveLength(2)
  })

  it('rejects assignments referencing undeclared conditions', () => {
    const mutated = {
      ...STUDY_LOCK,
      assignments: [{ ...ASSIGNMENT_NO_LEARNING, condition_id: 'undeclared' }],
    }
    const result = validateStudyLock(textOf(mutated))
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.map(error => error.code)).toEqual(['invalid_enum'])
  })

  it('rejects duplicate condition ids', () => {
    const mutated = { ...STUDY_LOCK, conditions: [NO_LEARNING_CONDITION, RECALL_CONDITION, NO_LEARNING_CONDITION] }
    const result = validateStudyLock(textOf(mutated))
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.map(error => error.code)).toEqual(['duplicate_reference'])
    expect(result.errors[0]?.path).toBe('/conditions/2/condition_id')
  })

  it('rejects duplicate assignment ids', () => {
    const mutated = { ...STUDY_LOCK, assignments: [ASSIGNMENT_NO_LEARNING, ASSIGNMENT_NO_LEARNING] }
    const result = validateStudyLock(textOf(mutated))
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.map(error => error.code)).toEqual(['duplicate_reference'])
  })

  it('rejects a malformed digest reference in input_digests', () => {
    const mutated = { ...STUDY_LOCK, input_digests: { 'task-set': 'md5:short' } }
    const result = validateStudyLock(textOf(mutated))
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.map(error => error.code)).toEqual(['invalid_type'])
  })

  it('rejects a non-namespaced input digest key', () => {
    const mutated = { ...STUDY_LOCK, input_digests: { Bad_Key: STUDY_LOCK.input_digests['task-set'] } }
    const result = validateStudyLock(textOf(mutated))
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.map(error => error.code)).toEqual(['invalid_type'])
  })
})

describe('capture profile validation', () => {
  it('accepts a well-formed profile with multiple capture points', () => {
    const result = validateCaptureProfile(textOf(CAPTURE_PROFILE))
    if (!result.ok) throw new Error(result.errors.map(error => error.message).join('; '))
    expect(result.digest).toBe(sha256CanonicalDigest(result.canonical))
  })

  it('rejects duplicate capture point keys and ids', () => {
    const mutated = { ...CAPTURE_PROFILE, capture_points: [SESSION_EVENT_POINT, SESSION_EVENT_POINT] }
    const result = validateCaptureProfile(textOf(mutated))
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.map(error => error.code)).toEqual(['duplicate_reference', 'duplicate_reference'])
  })

  it('rejects an unregistered data class', () => {
    const mutated = {
      ...CAPTURE_PROFILE,
      capture_points: [{ ...SESSION_EVENT_POINT, data_class: 'top_secret' }],
    }
    const result = validateCaptureProfile(textOf(mutated))
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.map(error => error.code)).toEqual(['invalid_enum'])
  })

  it('rejects a key without the namespaced shape', () => {
    const mutated = {
      ...CAPTURE_PROFILE,
      capture_points: [{ ...SESSION_EVENT_POINT, key: 'NoDots' }],
    }
    const result = validateCaptureProfile(textOf(mutated))
    if (result.ok) throw new Error('expected rejection')
    expect(result.errors.map(error => error.code)).toEqual(['invalid_type'])
  })

  it('canonicalizes the accepted document identically on repeated validation', () => {
    const first = validateStudyLock(textOf(STUDY_LOCK))
    const second = validateStudyLock(textOf(STUDY_LOCK))
    if (!first.ok || !second.ok) throw new Error('expected acceptance')
    expect(first.canonical).toBe(second.canonical)
    expect(first.digest).toBe(second.digest)
  })
})
