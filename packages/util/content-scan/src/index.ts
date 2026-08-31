/**
 * Pure regex threat scanner for self-evolution content gates: memory writes
 * (the write gate) and published snapshots (the read-boundary gate) share one
 * scanner so a poisoned entry cannot enter the model context even when it
 * bypassed the write gate.
 *
 * Severity is tiered: `blocked` findings reject the write (or replace the
 * entry with a `[BLOCKED: reason]` placeholder at publication); `caution`
 * findings never reject — project facts legitimately contain commands,
 * paths, and env names. The scanner is an advisory guard, not an archival
 * search: input beyond 65,536 chars is scanned as its prefix, and known
 * bypass phrasings outside the anchored set are a documented limitation of
 * the consuming packages, not a security guarantee.
 *
 * @module @deepseek-ai/dsh-content-scan
 */
import {
  INVISIBLE_CHARS,
  MAX_SCAN_CHARS,
  PATTERNS,
  SCAN_SCOPES,
  type ThreatPattern,
} from './patterns.ts'

export { INVISIBLE_CHARS, MAX_SCAN_CHARS, PATTERN_SET_VERSION, PATTERNS, SCAN_SCOPES } from './patterns.ts'
export type { ThreatPattern } from './patterns.ts'

/** Severity assigned to one finding; absence of findings is the safe verdict. */
export type ThreatSeverity = 'caution' | 'blocked'

/** Attack class of one finding. */
export type ThreatCategory = 'injection' | 'exfiltration' | 'obfuscation' | 'persistence'

/** Content surface being scanned. Both scopes run the full set today; the skill scope may narrow at P2 without a signature change. */
export type ScanScope = 'memory' | 'skill'

/** One pattern match located in the scanned text. */
export interface ThreatFinding {
  /** Stable identifier of the matching pattern. */
  readonly patternId: string
  /** Severity of the match. */
  readonly severity: ThreatSeverity
  /** Attack class of the match. */
  readonly category: ThreatCategory
  /** 1-based line in the scanned text where the match starts. */
  readonly line: number
  /** The matched excerpt, capped at 120 characters. */
  readonly excerpt: string
}

/** Three-tier verdict over one text: no findings is safe, any blocked is blocked, otherwise caution. */
export type ScanVerdict = 'safe' | 'caution' | 'blocked'

/** Longest excerpt kept on a finding. */
const MAX_EXCERPT_CHARS = 120

/**
 * Fold findings into the three-tier verdict the gates consume.
 * @param findings - Findings from one {@link scanContent} run.
 * @returns `blocked` when any finding is blocked, `caution` when only caution findings exist, `safe` otherwise.
 */
export function scanVerdict(findings: readonly ThreatFinding[]): ScanVerdict {
  if (findings.some(finding => finding.severity === 'blocked')) return 'blocked'
  if (findings.length > 0) return 'caution'
  return 'safe'
}

/**
 * Run the pattern set over one text. NFKC normalization runs first so
 * full-width lookalikes of attack phrases still match; invisible-Unicode
 * detection runs on the raw text because normalization erases those
 * characters. Input beyond the 65,536-char cap is scanned as its prefix.
 * @param text - Text to scan; never mutated.
 * @param scope - Content surface; an unknown name fails loud.
 * @returns findings ordered by line, then pattern id; duplicate matches of one pattern on one line collapse to the first.
 */
export function scanContent(text: string, scope: ScanScope): ThreatFinding[] {
  if (!SCAN_SCOPES.includes(scope)) {
    throw new Error(`invalid_structure: unknown scan scope '${scope}'`)
  }
  const bounded = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  const findings: ThreatFinding[] = []

  for (const invisible of INVISIBLE_CHARS) {
    let index = bounded.indexOf(invisible)
    while (index !== -1) {
      findings.push({
        patternId: 'invisible_unicode',
        severity: 'blocked',
        category: 'obfuscation',
        line: lineOf(bounded, index),
        excerpt: `U+${invisible.codePointAt(0)?.toString(16).padStart(4, '0')}`,
      })
      index = bounded.indexOf(invisible, index + invisible.length)
    }
  }

  const normalized = bounded.normalize('NFKC')
  for (const pattern of PATTERNS) {
    collectMatches(pattern, normalized, findings)
  }

  findings.sort((left, right) => left.line - right.line || left.patternId.localeCompare(right.patternId))
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = `${finding.patternId}:${finding.line}:${finding.excerpt}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Collect one pattern's matches into `findings`, capped excerpts, 1-based lines. */
function collectMatches(pattern: ThreatPattern, normalized: string, findings: ThreatFinding[]): void {
  const regex = new RegExp(pattern.regex.source, pattern.regex.flags)
  let match = regex.exec(normalized)
  while (match !== null) {
    if (match[0].length === 0) break
    findings.push({
      patternId: pattern.id,
      severity: pattern.severity,
      category: pattern.category,
      line: lineOf(normalized, match.index),
      excerpt: match[0].length > MAX_EXCERPT_CHARS ? match[0].slice(0, MAX_EXCERPT_CHARS) : match[0],
    })
    match = regex.exec(normalized)
  }
}

/** Map a character index onto its 1-based line number. */
function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++
  }
  return line
}
