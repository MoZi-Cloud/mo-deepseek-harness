/**
 * Shared validation driver for Observatory specs: one strict-scan pass, one
 * schema pass with taxonomy-mapped issues, then spec-specific semantic checks;
 * accepted documents return canonical bytes and their digest.
 * @module observatory-protocol/spec
 */

import type { ZodType } from 'zod'
import { canonicalizeJson, pointerFor, scanStrictJson, sha256CanonicalDigest, type JsonValue } from './canonical.ts'
import { ObservatoryError, sortObservatoryErrors } from './errors.ts'

/** Outcome of validating one spec document. */
export type SpecValidation<T> =
  | { readonly ok: true; readonly value: T; readonly canonical: string; readonly digest: string }
  | { readonly ok: false; readonly errors: readonly ObservatoryError[] }

/**
 * Map one schema issue to the protocol taxonomy. Duck-typed on purpose: the
 * vocabulary of schema issue codes is an implementation detail of the schema
 * library, and the taxonomy is the only wire-visible vocabulary.
 * @param issue - schema issue with `code`, `path`, and `message` fields.
 * @returns the taxonomy error for the issue.
 */
function errorFromIssue(issue: { code: string; path: PropertyKey[]; message: string; received?: string }): ObservatoryError {
  const pointer = pointerFor(issue.path.map(String))
  switch (issue.code) {
    case 'unrecognized_keys':
      return new ObservatoryError('unknown_field', pointer, issue.message)
    case 'invalid_value':
      return new ObservatoryError('invalid_enum', pointer, issue.message)
    case 'invalid_format':
      return new ObservatoryError('invalid_type', pointer, issue.message)
    case 'too_big':
    case 'too_small':
      return new ObservatoryError('out_of_range', pointer, issue.message)
    case 'invalid_type':
      if (issue.received === 'undefined' || issue.message.endsWith('received undefined')) {
        return new ObservatoryError('missing_field', pointer, issue.message)
      }
      return new ObservatoryError('invalid_type', pointer, issue.message)
    default:
      return new ObservatoryError('invalid_type', pointer, issue.message)
  }
}

/**
 * Validate one spec document: strict scan, schema parse with mapped issues,
 * then semantic checks; an accepted document carries its canonical bytes and
 * digest. Errors are reported in the canonical sorted order.
 * @param text - raw JSON document text.
 * @param schema - the spec's strict schema.
 * @param semanticChecks - spec-specific checks beyond schema expressiveness.
 * @returns the accepted spec value with canonical bytes and digest, or the sorted error list.
 */
export function runSpecValidation<T>(
  text: string,
  schema: ZodType<T>,
  semanticChecks: readonly ((value: T) => ObservatoryError[])[] = [],
): SpecValidation<T> {
  let value: JsonValue
  try {
    value = scanStrictJson(text)
  } catch (error) {
    // scanStrictJson's whole throw surface is ObservatoryError.
    return { ok: false, errors: [error as ObservatoryError] }
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, errors: sortObservatoryErrors(parsed.error.issues.map(errorFromIssue)) }
  }
  const errors = sortObservatoryErrors(semanticChecks.flatMap(check => check(parsed.data)))
  if (errors.length > 0) return { ok: false, errors }
  const canonical = canonicalizeJson(value)
  return { ok: true, value: parsed.data, canonical, digest: sha256CanonicalDigest(canonical) }
}
