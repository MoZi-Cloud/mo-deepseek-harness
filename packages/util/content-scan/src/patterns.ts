/**
 * Threat pattern data for {@link scanContent}: anchored regexes with a fixed
 * severity and category, compiled once at module load.
 *
 * Tiering follows the RC5 disposition of the scanner proposal: `blocked`
 * marks high-confidence injection, exfiltration, or hidden-Unicode content;
 * `caution` marks ordinary shell fragments, credential paths, and env names
 * that project facts legitimately contain. There is deliberately no
 * `safe` finding — the absence of findings is the safe verdict, and
 * {@link scanVerdict} computes the three-tier verdict.
 *
 * Anchoring discipline (borrowed from the Hermes scanner, H-SKILLS-GUARD):
 * patterns anchor on C2/attack vocabulary, never on bossy prose alone;
 * bounded `{0,8}` filler between key tokens prevents both multi-word
 * evasion and unbounded backtracking.
 *
 * @module @deepseek-ai/dsh-content-scan/patterns
 */
import type { ScanScope, ThreatCategory, ThreatSeverity } from './index.ts'

/** Version of the shipped pattern set; bumps whenever a pattern is added, changed, or removed. */
export const PATTERN_SET_VERSION = 1

/** One compiled threat pattern. */
export interface ThreatPattern {
  /** Stable machine-readable identifier surfaced on every finding. */
  readonly id: string
  /** Severity assigned when the pattern matches. */
  readonly severity: ThreatSeverity
  /** Attack class assigned when the pattern matches. */
  readonly category: ThreatCategory
  /** Compiled matcher over NFKC-normalized text. */
  readonly regex: RegExp
}

const FILLER = '(?:[\\w·\\s]{0,24})?'

/**
 * The shipped pattern set. Both scan scopes run the full set today; the
 * scope parameter exists so the skill scope can narrow at P2 without a
 * signature change.
 */
export const PATTERNS: readonly ThreatPattern[] = [
  // ── Prompt injection: English anchors ──
  {
    id: 'prompt_injection_ignore',
    severity: 'blocked',
    category: 'injection',
    regex: new RegExp(
      `ignore\\s+${FILLER}(?:previous|all|above|prior)\\s+${FILLER}instructions`, 'gi',
    ),
  },
  {
    id: 'disregard_rules',
    severity: 'blocked',
    category: 'injection',
    regex: new RegExp(
      `disregard\\s+${FILLER}(?:your|all|any)\\s+${FILLER}(?:instructions|rules|guidelines)`, 'gi',
    ),
  },
  {
    id: 'sys_prompt_override',
    severity: 'blocked',
    category: 'injection',
    regex: /system\s+prompt\s+override/gi,
  },
  {
    id: 'leak_system_prompt',
    severity: 'blocked',
    category: 'exfiltration',
    regex: new RegExp(
      `(?:output|reveal|print|show)\\s+${FILLER}(?:the\\s+)?(?:system|initial)\\s+prompt`, 'gi',
    ),
  },
  {
    id: 'role_hijack',
    severity: 'blocked',
    category: 'injection',
    regex: new RegExp(
      `you\\s+are\\s+${FILLER}now\\s+(?:a|an|the)\\s+`, 'gi',
    ),
  },
  {
    id: 'bypass_restrictions',
    severity: 'blocked',
    category: 'injection',
    regex: new RegExp(
      `(?:with\\s+no|without|ignore\\s+your)\\s+${FILLER}(?:restrictions|limits|rules|filters|safety)`, 'gi',
    ),
  },
  {
    id: 'deception_hide',
    severity: 'blocked',
    category: 'injection',
    regex: new RegExp(
      `do\\s+not\\s+${FILLER}(?:tell|inform)\\s+${FILLER}the\\s+user`, 'gi',
    ),
  },
  {
    id: 'context_exfil',
    severity: 'blocked',
    category: 'exfiltration',
    regex: new RegExp(
      `(?:include|output|print|share|send|exfiltrate)\\s+${FILLER}(?:conversation|chat\\s+history|previous\\s+messages|full\\s+context|entire\\s+context)`, 'gi',
    ),
  },
  // ── Prompt injection: Chinese anchors ──
  {
    id: 'cn_injection_ignore_instructions',
    severity: 'blocked',
    category: 'injection',
    regex: /(忽略|无视)(掉)?((?:之前|以前|以上|上面|先前|所有|全部|的){1,3})(系统)?(提示词?|指令|规则)/g,
  },
  {
    id: 'cn_deception_hide',
    severity: 'blocked',
    category: 'injection',
    regex: /(不要|别|切勿)(告诉|告知|透露给?)(用户|人类|他)|(隐瞒|瞒着)(用户)|(不要|别|切勿)让(用户|人类)(知道|发现)/g,
  },
  {
    id: 'cn_role_hijack',
    severity: 'blocked',
    category: 'injection',
    regex: /你现在(是|扮演)|(假装|假定)你是|扮演(一个)?没有任何(限制|约束|规则)/g,
  },
  {
    id: 'cn_bypass_filters',
    severity: 'blocked',
    category: 'injection',
    regex: /(绕过|无视|关闭)(安全|内容|审查)(过滤|审查|限制|机制)/g,
  },
  {
    id: 'cn_context_exfil',
    severity: 'blocked',
    category: 'exfiltration',
    regex: /(输出|泄露|打印|分享|发送|外传)(完整)?(的)?(系统提示词?|对话(记录|历史)|聊天记录|上下文)/g,
  },
  {
    id: 'cn_covert_action',
    severity: 'blocked',
    category: 'injection',
    regex: /(偷偷|悄悄|私自|私下|静默)(地)?(执行|运行|上传|发送|外传|安装|写入)/g,
  },
  {
    id: 'html_comment_injection',
    severity: 'blocked',
    category: 'injection',
    regex: /<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/gi,
  },
  {
    id: 'hidden_div',
    severity: 'blocked',
    category: 'injection',
    regex: /<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/gi,
  },
  // ── Exfiltration: secret interpolation into network commands ──
  {
    id: 'exfil_curl_secret',
    severity: 'blocked',
    category: 'exfiltration',
    regex: /(?:curl|wget|fetch|httpx?)[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/gi,
  },
  {
    id: 'encoded_exfil',
    severity: 'blocked',
    category: 'exfiltration',
    regex: /base64[^\n]{0,2048}(?:\benv\b|environ|credentials|API[_-]?KEY)/gi,
  },
  {
    id: 'obfuscated_exec',
    severity: 'blocked',
    category: 'obfuscation',
    regex: /\beval\s*\(\s*(?:atob|base64)|echo\s+[^\n]{0,2048}\|\s*(?:ba)?sh/gi,
  },
  {
    id: 'read_secrets_file',
    severity: 'blocked',
    category: 'exfiltration',
    regex: /cat\s+[^\n]{0,2048}(\.env(?![\w.])|credentials\b|\.netrc\b|\.pgpass\b|\.npmrc\b|\.pypirc\b)/gi,
  },
  {
    id: 'credential_dir_transfer',
    severity: 'blocked',
    category: 'exfiltration',
    regex: /(?:curl|wget|scp|rsync|nc|netcat)[^\n]{0,2048}[~\/](?:\.(?:ssh|aws|gnupg|kube))/gi,
  },
  {
    id: 'ssh_backdoor',
    severity: 'blocked',
    category: 'persistence',
    regex: /authorized_keys/gi,
  },
  {
    id: 'hardcoded_secret',
    severity: 'blocked',
    category: 'exfiltration',
    regex: /(?:api[-_]?key|token|secret|password)\s*[=:]\s*["'][!-~]{20,}/gi,
  },
  {
    id: 'md_variable_exfil',
    severity: 'blocked',
    category: 'exfiltration',
    regex: /[!]?\[[^\]\n]{0,512}\]\(https?:\/\/[^\)\n]{0,1024}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/gi,
  },
  {
    id: 'tmp_staging_exfil',
    severity: 'blocked',
    category: 'exfiltration',
    regex: />\s*\/tmp\/[^\s|;&]{0,512}\s*&&\s*(?:curl|wget|nc|python|node)/gi,
  },
  {
    id: 'dns_exfil',
    severity: 'blocked',
    category: 'exfiltration',
    regex: /(?<![-/\w])\b(?:dig|nslookup)\s+[^\n]{0,2048}\$/gi,
  },
  // ── Caution: ordinary fragments project facts legitimately contain ──
  {
    id: 'send_to_url',
    severity: 'caution',
    category: 'exfiltration',
    regex: /\b(?:send|post|upload|transmit|推送|上传|发送)[^\n]{0,2048}\s+(?:to|at|到|至)\s+https?:\/\//gi,
  },
  {
    id: 'env_var_reference',
    severity: 'caution',
    category: 'exfiltration',
    regex: /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\b/g,
  },
  {
    id: 'credential_path_reference',
    severity: 'caution',
    category: 'exfiltration',
    regex: /[~]\??\/\.(?:ssh|aws|gnupg|kube)|\.env\b(?![\w.])/g,
  },
  {
    id: 'network_command',
    severity: 'caution',
    category: 'exfiltration',
    regex: /(?:^|[\s(])\b(?:curl|wget|nc|netcat)\s+\S/gi,
  },
  {
    id: 'agent_config_modification',
    severity: 'caution',
    category: 'persistence',
    regex: new RegExp(
      '(?:^|\\n)\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?'
      + '(?:write|edit|modify|append|overwrite|update|\u4fee\u6539|\u5199\u5165|\u8ffd\u52a0|\u7f16\u8f91|\u66f4\u65b0)'
      + '[^\\n]{0,2048}?\\b(?:AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules)',
      'gi',
    ),
  },
]

/**
 * Invisible and bidirectional Unicode characters used to hide or reorder
 * injected instructions (aligned with the Hermes scanner set): zero-width
 * joiners, directional overrides and isolates, invisible math operators,
 * and the BOM.
 */
export const INVISIBLE_CHARS: readonly string[] = [
  '\u200b', '\u200c', '\u200d', '\u2060', '\u2062', '\u2063', '\u2064',
  '\ufeff', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
  '\u2066', '\u2067', '\u2068', '\u2069',
]

/** Largest single text accepted by one scan; input beyond the cap is scanned as its prefix. */
export const MAX_SCAN_CHARS = 65_536

/** Every scope name {@link scanContent} accepts; unknown names fail loud. */
export const SCAN_SCOPES: readonly ScanScope[] = ['memory', 'skill']
