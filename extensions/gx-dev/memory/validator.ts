/**
 * Deterministic memory lint (PLAN §10.5). Structure is checked
 * deterministically rather than relying only on agent instructions.
 * Issues are advisory strings: contradiction candidates are flagged for
 * review, not treated as hard errors.
 */

import { extractLinks, isGeneratedPage, parsePage, REQUIRED_FRONTMATTER } from "./wiki.ts";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);
const SHA40_RE = /\b[0-9a-fA-F]{40}\b/;
const CURRENTLY_RE = /\bcurrently\s+\d+/i;
const NEGATIVE_POLARITY_RE = /\b(?:must not|mustn't|cannot|can't|should not|shouldn't|never)\b/i;
const POSITIVE_POLARITY_RE = /\b(?:must|always|shall|should)\b/i;
const POLARITY_STRIP_RE =
  /\b(?:must not|mustn't|cannot|can't|should not|shouldn't|must|shall|should|always|never)\b/gi;

function parseIsoDate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : t;
}

/**
 * Lints a single page and returns issue strings. `index` and `log` are
 * generated pages and are not hand-validated.
 */
export function lintPage(name: string, raw: string): string[] {
  const issues: string[] = [];
  if (isGeneratedPage(name)) return issues;
  const { frontmatter, body } = parsePage(raw);

  for (const field of REQUIRED_FRONTMATTER) {
    const value = frontmatter[field];
    if (value === undefined || value.trim() === "") {
      issues.push(`${name}: missing frontmatter field '${field}'`);
    }
  }
  const provenance = frontmatter["provenance"];
  if (provenance !== undefined && provenance.split(";").every((part) => part.trim() === "")) {
    issues.push(`${name}: frontmatter field 'provenance' has no entries`);
  }

  const verification = (frontmatter["verification"] ?? "").trim().toLowerCase();
  const unverified = verification === "not-verified" || verification === "not verified";
  if (
    verification !== "" &&
    verification !== "verified" &&
    !unverified
  ) {
    issues.push(
      `${name}: frontmatter field 'verification' must be 'verified' or 'NOT VERIFIED' (got '${frontmatter["verification"]}')`,
    );
  }
  const confidence = (frontmatter["confidence"] ?? "").trim().toLowerCase();
  if (confidence !== "" && !CONFIDENCE_LEVELS.has(confidence)) {
    issues.push(
      `${name}: frontmatter field 'confidence' must be low|medium|high (got '${frontmatter["confidence"]}')`,
    );
  }
  const freshnessMs = parseIsoDate(frontmatter["freshness"]);
  if (frontmatter["freshness"] !== undefined && freshnessMs === null) {
    issues.push(`${name}: frontmatter field 'freshness' is not an ISO date`);
  }
  if (frontmatter["updated"] !== undefined && parseIsoDate(frontmatter["updated"]) === null) {
    issues.push(`${name}: frontmatter field 'updated' is not an ISO date`);
  }

  // stale-unverified: NOT VERIFIED claims past freshness+30d.
  if (unverified && freshnessMs !== null && Date.now() - freshnessMs > THIRTY_DAYS_MS) {
    issues.push(
      `${name}: stale-unverified (NOT VERIFIED with freshness ${frontmatter["freshness"]}, more than 30 days old)`,
    );
  }

  if (!/^##\s+Summary\b/m.test(body)) {
    issues.push(`${name}: missing required heading '## Summary'`);
  }

  if (!/\[\[[^\[\]]+\]\]/.test(body)) {
    issues.push(`${name}: orphan risk (no outbound [[link]])`);
  }

  // Mutable-state smell: SHA-40 literals or "currently <n>" counts in prose.
  const sha = SHA40_RE.exec(body);
  if (sha !== null) {
    issues.push(`${name}: copied mutable state (SHA-40 literal '${sha[0] ?? ""}')`);
  }
  const currently = CURRENTLY_RE.exec(body);
  if (currently !== null) {
    issues.push(`${name}: copied mutable state ('${currently[0] ?? ""}')`);
  }
  return issues;
}

/**
 * Lints a whole wiki: per-page checks plus cross-page checks (broken
 * [[link]] targets, contradiction candidates).
 */
export function lintWiki(pages: { name: string; raw: string }[]): string[] {
  const issues: string[] = [];
  const names = new Set(pages.map((p) => p.name));
  for (const page of pages) issues.push(...lintPage(page.name, page.raw));

  const seenBroken = new Set<string>();
  for (const page of pages) {
    for (const target of extractLinks(page.raw)) {
      if (names.has(target)) continue;
      const key = `${page.name}->${target}`;
      if (seenBroken.has(key)) continue;
      seenBroken.add(key);
      issues.push(`${page.name}: broken [[link]] target '${target}'`);
    }
  }

  issues.push(...findContradictions(pages));
  return issues;
}

interface ClaimEntry {
  pos: string[];
  neg: string[];
}

/**
 * Contradiction heuristic: the same claim phrase (polarity words removed)
 * appearing with must/always polarity in one page and must-not/never
 * polarity in another is flagged for review. Deterministic; advisory only.
 */
function findContradictions(pages: { name: string; raw: string }[]): string[] {
  const claims = new Map<string, ClaimEntry>();
  for (const page of pages) {
    const { body } = parsePage(page.raw);
    for (const line of body.split(/\r?\n/)) {
      if (/^\s*```/.test(line)) continue;
      const negative = NEGATIVE_POLARITY_RE.test(line);
      const positive = !negative && POSITIVE_POLARITY_RE.test(line);
      if (!negative && !positive) continue;
      const key = normalizeClaim(line);
      if (key === null) continue;
      let entry = claims.get(key);
      if (entry === undefined) {
        entry = { pos: [], neg: [] };
        claims.set(key, entry);
      }
      const sides = negative ? entry.neg : entry.pos;
      if (!sides.includes(page.name)) sides.push(page.name);
    }
  }
  const issues: string[] = [];
  for (const [key, entry] of claims) {
    if (entry.pos.length === 0 || entry.neg.length === 0) continue;
    issues.push(
      `contradiction candidate: '${key}' (must/always in ${entry.pos.join(", ")} vs must-not/never in ${entry.neg.join(", ")}) — flag for review, not an error`,
    );
  }
  return issues;
}

function normalizeClaim(line: string): string | null {
  const stripped = line
    .replace(/`[^`]*`/g, " ")
    .replace(/\[\[[^\[\]]*\]\]/g, " ") // links are navigation, not claim content
    .replace(POLARITY_STRIP_RE, " ")
    .toLowerCase();
  const tokens = stripped.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  if (tokens.length < 4) return null;
  return tokens.join(" ");
}
