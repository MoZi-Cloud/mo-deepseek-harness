/**
 * Observatory protocol error taxonomy (`observatory.error.v1`).
 *
 * The vocabulary is closed: parsers reject unknown codes, and every negative
 * conformance fixture names one code from this list. Codes marked reserved in
 * {@link RESERVED_ERROR_CODES} have no producer in this phase; their ingest
 * semantics arrive with Phase A and their presence here only fixes the wire
 * vocabulary.
 * @module observatory-protocol/errors
 */

/** Every error code the protocol vocabulary owns, including reserved ingest codes. */
export const OBSERVATORY_ERROR_CODES = [
  'malformed_json',
  'duplicate_key',
  'non_canonical_number',
  'trailing_content',
  'unknown_field',
  'missing_field',
  'invalid_type',
  'invalid_enum',
  'out_of_range',
  'size_limit',
  'binding_conflict',
  'duplicate_reference',
  'identity_conflict',
  'seq_gap',
  'epoch_restart',
  'quarantine',
] as const

/** One taxonomy error code. */
export type ObservatoryErrorCode = (typeof OBSERVATORY_ERROR_CODES)[number]

/**
 * Codes declared for Phase A ingest semantics; no validator in this phase emits them.
 * Their fixture suites are delivered with the ingest state machine.
 */
export const RESERVED_ERROR_CODES: readonly ObservatoryErrorCode[] = [
  'identity_conflict',
  'seq_gap',
  'epoch_restart',
  'quarantine',
]

/** One protocol violation located by JSON Pointer. */
export class ObservatoryError extends Error {
  /** Taxonomy code naming the violation class. */
  readonly code: ObservatoryErrorCode
  /** JSON Pointer to the offending location, `''` for the whole document. */
  readonly path: string

  /**
   * @param code - taxonomy code naming the violation class.
   * @param path - JSON Pointer to the offending location.
   * @param detail - human-readable explanation of the specific violation.
   */
  constructor(code: ObservatoryErrorCode, path: string, detail: string) {
    super(`${code} at ${path === '' ? '<root>' : path}: ${detail}`)
    this.name = 'ObservatoryError'
    this.code = code
    this.path = path
  }
}

/**
 * Order two errors deterministically by pointer, then code, then message.
 * @param a - first error.
 * @param b - second error.
 * @returns a negative, zero, or positive value per standard comparator contracts.
 */
export function compareObservatoryErrors(a: ObservatoryError, b: ObservatoryError): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  if (a.code !== b.code) return a.code < b.code ? -1 : 1
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
}

/**
 * Sort a collected error list into the canonical reporting order.
 * @param errors - errors in collection order.
 * @returns a new array sorted by {@link compareObservatoryErrors}.
 */
export function sortObservatoryErrors(errors: readonly ObservatoryError[]): readonly ObservatoryError[] {
  return [...errors].sort(compareObservatoryErrors)
}

/**
 * Check whether a string is a code from the closed taxonomy vocabulary.
 * @param value - candidate code.
 * @returns true when `value` is in {@link OBSERVATORY_ERROR_CODES}.
 */
export function isObservatoryErrorCode(value: string): value is ObservatoryErrorCode {
  return (OBSERVATORY_ERROR_CODES as readonly string[]).includes(value)
}
