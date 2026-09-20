/**
 * Coding-Agent Observatory protocol specs: strict-scan validation, canonical
 * digests, and the closed error taxonomy for the native evidence envelope,
 * study locks, and capture profiles (Phase 0 of 方案 v2.3).
 * @module observatory-protocol
 */

export {
  canonicalizeJson,
  CAPTURE_POINT_KEY_PATTERN,
  jsonPointer,
  pointerFor,
  scanStrictJson,
  SHA256_DIGEST_PATTERN,
  sha256CanonicalDigest,
  type JsonValue,
} from './canonical.ts'
export {
  compareObservatoryErrors,
  isObservatoryErrorCode,
  OBSERVATORY_ERROR_CODES,
  ObservatoryError,
  RESERVED_ERROR_CODES,
  sortObservatoryErrors,
  type ObservatoryErrorCode,
} from './errors.ts'
export {
  CAPTURE_METHODS,
  ENVELOPE_BINDINGS,
  ENVELOPE_SCHEMA_ID,
  INLINE_MEDIA_TYPE,
  MAX_INLINE_PAYLOAD_BYTES,
  nativeEnvelopeSchema,
  PAYLOAD_TRANSPORTS,
  RECORD_KINDS,
  validateEnvelope,
  type NativeEnvelope,
} from './envelope.ts'
export {
  captureProfileSchema,
  CAPTURE_PROFILE_SCHEMA_ID,
  DATA_CLASSES,
  validateCaptureProfile,
  type CaptureProfile,
} from './capture-profile.ts'
export {
  MISSINGNESS_POLICIES,
  STUDY_LOCK_SCHEMA_ID,
  studyLockSchema,
  validateStudyLock,
  type StudyLock,
} from './study-lock.ts'
export { runSpecValidation, type SpecValidation } from './spec.ts'
export {
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
} from './synthetic.ts'
