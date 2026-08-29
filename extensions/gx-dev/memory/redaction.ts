/**
 * Conservative secret redaction for memory promotion (PLAN §10.3, §10.5:
 * prohibited sensitive content). Patterns cover bearer/API tokens,
 * `password: …`-style assignments, PEM private key blocks, and long
 * hex/base64 credential literals after `Authorization` or in `key:` contexts.
 * Normal prose is never rewritten.
 */

/** Result of redacting a text. */
export interface RedactionResult {
  text: string;
  /** Number of replacements performed. */
  found: number;
}

interface SecretPattern {
  kind: string;
  re: RegExp;
  build: (m: RegExpExecArray) => string;
}

const g = (m: RegExpExecArray, i: number): string => m[i] ?? "";

/** Ordered patterns; earlier (more specific) patterns win. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    build: () => "[REDACTED:private-key]",
  },
  {
    // OpenAI-style sk-, GitHub ghp_/gho_/ghs_/ghu_ and fine-grained pats,
    // AWS access key ids (AKIA…), Slack xox… tokens.
    kind: "api-token",
    re: /\b(?:sk-[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    build: () => "[REDACTED:api-token]",
  },
  {
    // Long credential literals after an Authorization/auth header.
    kind: "authorization",
    re: /\b((?:authorization|auth)\s*[:=]\s*(?:bearer\s+)?["']?)([A-Za-z0-9._+/=-]{16,})/gi,
    build: (m) => `${g(m, 1)}[REDACTED:authorization]`,
  },
  {
    // password/secret/token/api-key assignment values, quoted or bare.
    kind: "assignment",
    re: /\b(password|passwd|secret|token|api[-_]?key)\b(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi,
    build: (m) => `${g(m, 1)}${g(m, 2)}${g(m, 3)}[REDACTED:assignment]${g(m, 3)}`,
  },
  {
    // Long hex or base64 literals in `key:` / `access_key=` contexts.
    kind: "credential",
    re: /\b((?:access[-_])?key\s*[:=]\s*["']?)([A-Fa-f0-9]{16,}|[A-Za-z0-9+/]{32,}={0,2})["']?/g,
    build: (m) => `${g(m, 1)}[REDACTED:credential]`,
  },
];

function applyPattern(text: string, pattern: SecretPattern): { text: string; count: number } {
  let count = 0;
  const re = new RegExp(pattern.re.source, pattern.re.flags);
  const out = text.replace(re, (...args: unknown[]) => {
    const match = String(args[0]);
    // Never rewrite (or double-count) an already redacted span.
    if (match.includes("[REDACTED")) return match;
    count += 1;
    return pattern.build(args as unknown as RegExpExecArray);
  });
  return { text: out, count };
}

/** Redacts secret-looking spans; conservative, keeps normal prose intact. */
export function redactSecrets(text: string): RedactionResult {
  let found = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    const step = applyPattern(out, pattern);
    out = step.text;
    found += step.count;
  }
  return { text: out, found };
}
