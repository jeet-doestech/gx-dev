/**
 * Failure counters and escalation rules (PLAN §9).
 *
 * A pass resets only its own consecutive counter. Infrastructure failures
 * never touch the code counters but increment infrastructureRetries. Every
 * attempt — pass or fail — increments totalAttempts so the configurable
 * ceiling can always terminate a loop.
 */

import type { FailureCounters } from "../domain/state.ts";

export type FailureGate = "test" | "review" | "integration" | "infrastructure";

/** Produces the next counter snapshot after one gate attempt. */
export function nextCounters(
  counters: FailureCounters,
  gate: FailureGate,
  pass: boolean,
): FailureCounters {
  const next: FailureCounters = { ...counters, totalAttempts: counters.totalAttempts + 1 };
  if (gate === "infrastructure") {
    // Infrastructure never touches code counters; its own retry counter tracks
    // churn and resets once the infrastructure recovers.
    next.infrastructureRetries = pass ? 0 : counters.infrastructureRetries + 1;
    return next;
  }
  if (pass) {
    if (gate === "test") next.testConsecutiveFailures = 0;
    else if (gate === "review") next.reviewConsecutiveFailures = 0;
    else next.integrationConsecutiveFailures = 0;
    return next;
  }
  if (gate === "test") next.testConsecutiveFailures = counters.testConsecutiveFailures + 1;
  else if (gate === "review") next.reviewConsecutiveFailures = counters.reviewConsecutiveFailures + 1;
  else next.integrationConsecutiveFailures = counters.integrationConsecutiveFailures + 1;
  return next;
}

/**
 * Replan when either code gate hits `maxConsecutive` consecutive failures;
 * hard-fail the run when `maxTotal` total attempts have been spent.
 */
export function shouldReplan(
  counters: FailureCounters,
  maxConsecutive: number,
  maxTotal: number,
): { replan: boolean; fail: boolean } {
  return {
    replan:
      counters.testConsecutiveFailures >= maxConsecutive ||
      counters.reviewConsecutiveFailures >= maxConsecutive,
    fail: counters.totalAttempts >= maxTotal,
  };
}

/** One recorded gate failure, rendered for the planner during replanning. */
export interface FailureAttempt {
  gate: string;
  owner: string;
  inputHash: string;
  findings: string[];
  action: string;
}

/** Markdown rendering of the full failure history for the planner. */
export function renderFailureHistory(attempts: FailureAttempt[]): string {
  const lines: string[] = [
    "# Failure history",
    "",
    `${attempts.length} recorded attempt(s).`,
    "",
  ];
  attempts.forEach((attempt, index) => {
    lines.push(`## Attempt ${index + 1} — ${attempt.gate} gate`);
    lines.push(`- owner: ${attempt.owner}`);
    lines.push(`- inputHash: ${attempt.inputHash}`);
    lines.push(`- action: ${attempt.action}`);
    if (attempt.findings.length === 0) {
      lines.push("- findings: (none recorded)");
    } else {
      lines.push("- findings:");
      for (const finding of attempt.findings) lines.push(`  - ${finding}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}
