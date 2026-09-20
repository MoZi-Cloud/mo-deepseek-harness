/**
 * Canonical JSON for Observatory protocol specs: RFC 8785 (JCS) encoding,
 * SHA-256 digests over canonical bytes, and the strict JSON scanner that
 * rejects duplicate keys, non-canonical number literals, and trailing content
 * before any schema validation runs.
 * @module observatory-protocol/canonical
 */

import { createHash } from 'node:crypto'
import { ObservatoryError } from './errors.ts'

/** Any JSON value accepted by the strict scanner and the canonical encoder. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Pattern every spec digest and source-of-truth digest reference must match. */
export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

/** Pattern for capture point keys: lowercase dot-namespaced stable identifiers. */
export const CAPTURE_POINT_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])
const NUMBER_TOKEN_PATTERN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/

interface Parsed<T> {
  readonly value: T
  readonly end: number
}

/**
 * Escape one JSON Pointer reference token per RFC 6901.
 * @param token - object key or array index to escape.
 * @returns the escaped pointer token.
 */
function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * Append one reference token to a JSON Pointer.
 * @param base - pointer so far, `''` for the document root.
 * @param token - object key or array index to append.
 * @returns the extended pointer.
 */
export function jsonPointer(base: string, token: string | number): string {
  return `${base}/${escapePointerToken(String(token))}`
}

/**
 * Build the JSON Pointer for a schema issue path.
 * @param path - sequence of object keys and array indexes from the document root.
 * @returns the JSON Pointer string, `''` for the root.
 */
export function pointerFor(path: readonly (string | number)[]): string {
  return path.reduce<string>((pointer, token) => jsonPointer(pointer, token), '')
}

function skipWhitespace(text: string, start: number): number {
  let index = start
  while (WHITESPACE.has(text.charAt(index))) index += 1
  return index
}

function parseString(text: string, start: number): Parsed<string> {
  let index = start + 1
  while (index < text.length) {
    const character = text[index]
    if (character === '"') {
      const raw = text.slice(start, index + 1)
      try {
        return { value: JSON.parse(raw) as string, end: index + 1 }
      } catch {
        throw new ObservatoryError('malformed_json', '', `invalid string literal at offset ${start}`)
      }
    }
    index += character === '\\' ? 2 : 1
  }
  throw new ObservatoryError('malformed_json', '', `unterminated string at offset ${start}`)
}

function parseNumber(text: string, start: number, pointer: string): Parsed<number> {
  const match = NUMBER_TOKEN_PATTERN.exec(text.slice(start))
  if (match === null) throw new ObservatoryError('malformed_json', pointer, `no number at offset ${start}`)
  const token = match[0]
  const end = start + token.length
  const follower = text[end]
  if (follower !== undefined && /[0-9a-zA-Z_.]/.test(follower)) {
    throw new ObservatoryError('malformed_json', pointer, `malformed number literal ending at offset ${end}`)
  }
  const numeric = Number(token)
  if (!Number.isFinite(numeric) || JSON.stringify(numeric) !== token) {
    throw new ObservatoryError('non_canonical_number', pointer, `number literal ${token} is not in canonical form`)
  }
  return { value: numeric, end }
}

function parseLiteral(text: string, start: number, expected: string, value: boolean | null): Parsed<boolean | null> {
  if (text.startsWith(expected, start)) return { value, end: start + expected.length }
  throw new ObservatoryError('malformed_json', '', `invalid literal at offset ${start}`)
}

function parseValue(text: string, start: number, pointer: string): Parsed<JsonValue> {
  const character = text[start]
  if (character === '"') return parseString(text, start)
  if (character === '{') return parseObject(text, start, pointer)
  if (character === '[') return parseArray(text, start, pointer)
  if (character === 't') return parseLiteral(text, start, 'true', true)
  if (character === 'f') return parseLiteral(text, start, 'false', false)
  if (character === 'n') return parseLiteral(text, start, 'null', null)
  if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
    return parseNumber(text, start, pointer)
  }
  throw new ObservatoryError('malformed_json', pointer, `unexpected character at offset ${start}`)
}

function parseObject(text: string, start: number, pointer: string): Parsed<{ [key: string]: JsonValue }> {
  const result: { [key: string]: JsonValue } = {}
  const seen = new Set<string>()
  let index = skipWhitespace(text, start + 1)
  if (text[index] === '}') return { value: result, end: index + 1 }
  for (;;) {
    if (text[index] !== '"') {
      throw new ObservatoryError('malformed_json', pointer, `expected object key at offset ${index}`)
    }
    const key = parseString(text, index)
    if (seen.has(key.value)) {
      throw new ObservatoryError('duplicate_key', jsonPointer(pointer, key.value), `duplicate object key "${key.value}"`)
    }
    const colon = skipWhitespace(text, key.end)
    if (text[colon] !== ':') {
      throw new ObservatoryError('malformed_json', pointer, `expected ':' after key at offset ${colon}`)
    }
    const value = parseValue(text, skipWhitespace(text, colon + 1), jsonPointer(pointer, key.value))
    result[key.value] = value.value
    seen.add(key.value)
    index = skipWhitespace(text, value.end)
    if (text[index] === ',') {
      index = skipWhitespace(text, index + 1)
      continue
    }
    if (text[index] === '}') return { value: result, end: index + 1 }
    throw new ObservatoryError('malformed_json', pointer, `expected ',' or '}' at offset ${index}`)
  }
}

function parseArray(text: string, start: number, pointer: string): Parsed<JsonValue[]> {
  const result: JsonValue[] = []
  let index = skipWhitespace(text, start + 1)
  if (text[index] === ']') return { value: result, end: index + 1 }
  for (;;) {
    const entry = parseValue(text, index, jsonPointer(pointer, result.length))
    result.push(entry.value)
    index = skipWhitespace(text, entry.end)
    if (text[index] === ',') {
      index = skipWhitespace(text, index + 1)
      continue
    }
    if (text[index] === ']') return { value: result, end: index + 1 }
    throw new ObservatoryError('malformed_json', pointer, `expected ',' or ']' at offset ${index}`)
  }
}

/**
 * Parse JSON with the strict wire rules: duplicate keys, non-canonical number
 * literals, and trailing content are rejected with their taxonomy codes. The
 * scanner fails on the first violation.
 * @param text - raw JSON document text.
 * @returns the parsed value.
 * @throws ObservatoryError with the scanner's first violation.
 */
export function scanStrictJson(text: string): JsonValue {
  const parsed = parseValue(text, 0, '')
  if (skipWhitespace(text, parsed.end) !== text.length) {
    throw new ObservatoryError('trailing_content', '', 'document continues after the root value')
  }
  return parsed.value
}

/**
 * Encode a value as RFC 8785 (JCS) canonical JSON. Object keys sort by UTF-16
 * code unit; number and string forms follow the host's JCS-conformant
 * `JSON.stringify` behavior. Inputs containing `undefined` member values are a
 * caller contract violation and are not validated here.
 * @param value - the parsed JSON value to encode.
 * @returns the canonical JSON text.
 */
export function canonicalizeJson(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(entry => canonicalizeJson(entry)).join(',')}]`
  const members = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${members.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeJson(entry)}`).join(',')}}`
}

/**
 * Compute the protocol digest of canonical JSON text.
 * @param canonical - canonical JSON text from {@link canonicalizeJson}.
 * @returns the `sha256:` prefixed lowercase hex digest.
 */
export function sha256CanonicalDigest(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}
