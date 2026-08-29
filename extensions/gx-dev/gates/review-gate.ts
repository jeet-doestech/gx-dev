/**
 * Adversarial review gate (PLAN §6.7).
 *
 * Pass requires a valid, "complete" reviewer completion AND zero findings
 * with severity "blocking" or "major" (major blocks in v1). Minor and info
 * findings are recorded but do not block. Documentation updates are carried
 * forward for the DOCUMENTATION_UPDATE state.
 */

import type { AgentRunResult } from "../domain/interfaces.ts";
import type { ReviewFinding, ReviewerCompletion } from "../domain/schemas.ts";

export interface ReviewGateResult {
  pass: boolean;
  findings: ReviewFinding[];
  documentationUpdates: string[];
  blockingCount: number;
}

function buildReviewerPrompt(input: {
  stagingDir: string;
  combinedDiff: string;
  requirements: string;
}): string {
  return [
    "You are the adversarial reviewer. Scrutinize the combined staged diff for correctness, requirement coverage, security, error handling, maintainability, and hidden coupling. Return ONE reviewer JSON completion with severity-ranked findings (blocking | major | minor | info; each with path, expected/observed, remediation) and documentationUpdates (documentation paths that must be refreshed).",
    `Staging directory: ${input.stagingDir}`,
    `Approved requirements:\n\n${input.requirements || "(none provided)"}`,
    `Combined diff:\n\n${input.combinedDiff || "(empty)"}`,
  ].join("\n\n");
}

/**
 * Runs the review gate. Reviewer agent failure or an invalid/blocked
 * completion is synthesized into one blocking finding.
 */
export async function runReviewGate(input: {
  stagingDir: string;
  combinedDiff: string;
  requirements: string;
  runReviewerAgent: (prompt: string) => Promise<AgentRunResult>;
}): Promise<ReviewGateResult> {
  const prompt = buildReviewerPrompt({
    stagingDir: input.stagingDir,
    combinedDiff: input.combinedDiff,
    requirements: input.requirements,
  });
  const result = await input.runReviewerAgent(prompt);
  const completion =
    result.completion && "documentationUpdates" in result.completion
      ? result.completion
      : null;
  if (!result.ok || completion === null || completion.status !== "complete") {
    const finding: ReviewFinding = {
      severity: "blocking",
      remediation:
        result.error ?? "reviewer agent failed or returned an invalid completion",
    };
    return {
      pass: false,
      findings: [finding],
      documentationUpdates: [],
      blockingCount: 1,
    };
  }
  const blocking = completion.findings.filter(
    (f) => f.severity === "blocking" || f.severity === "major",
  );
  return {
    pass: blocking.length === 0,
    findings: completion.findings,
    documentationUpdates: completion.documentationUpdates,
    blockingCount: blocking.length,
  };
}
