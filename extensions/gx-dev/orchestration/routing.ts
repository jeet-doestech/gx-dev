/**
 * Routing policy (PLAN §6.1, §7): question severity classification and gate
 * failure ownership routing. Pure and deterministic — no agent, no I/O.
 */

import type { QuestionSeverity } from "../domain/interfaces.ts";

/** Keywords that make a question material (PLAN §7: must reach the user). */
const MATERIAL_KEYWORDS: readonly string[] = [
  "scope",
  "architecture",
  "security",
  "api",
  "migration",
  "destructive",
  "delete-database",
  "delete database",
  "breaking",
];

/** Keywords that mark a question as minor and reversible. */
const MINOR_KEYWORDS: readonly string[] = ["formatting", "naming", "path-fixer"];

/**
 * Explicit severity wins; otherwise a keyword heuristic applies. Unknown
 * text defaults to minor: minor, reversible decisions may continue without
 * the user (PLAN §7), material ones never do.
 */
export function classifyQuestion(q: {
  severity?: QuestionSeverity;
  text: string;
}): QuestionSeverity {
  if (q.severity === "material" || q.severity === "minor") return q.severity;
  const text = q.text.toLowerCase();
  if (MATERIAL_KEYWORDS.some((k) => text.includes(k))) return "material";
  if (MINOR_KEYWORDS.some((k) => text.includes(k))) return "minor";
  return "minor";
}

export type GateOwner = "developer" | "testWriter";

/**
 * Routes gate-failure ownership to the responsible agent(s).
 *
 * - `both` routes to developer AND testWriter;
 * - `infrastructure` routes to nobody (retried separately, no failure counter);
 * - anything else routes to the named owner.
 *
 * Result is deduplicated in the stable order developer-then-testWriter.
 */
export function routeGateFailure(ownership: { owner: string }[]): GateOwner[] {
  const selected = new Set<GateOwner>();
  for (const entry of ownership) {
    if (entry.owner === "developer") {
      selected.add("developer");
    } else if (entry.owner === "testWriter") {
      selected.add("testWriter");
    } else if (entry.owner === "both") {
      selected.add("developer");
      selected.add("testWriter");
    }
    // "infrastructure" intentionally routes nowhere: infrastructure failures
    // are retried by the orchestrator itself and never count as code failures.
  }
  const order: readonly GateOwner[] = ["developer", "testWriter"];
  return order.filter((owner) => selected.has(owner));
}
