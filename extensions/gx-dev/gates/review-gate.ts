/**
 * Adversarial review gate (PLAN §6.7).
 *
 * Pass requires a valid, "complete" reviewer completion AND zero findings
 * with severity "blocking" or "major" (major blocks in v1). Minor and info
 * findings are recorded but do not block. A reviewer that raises a MATERIAL
 * question fails the gate closed (the gate cannot answer for the user); the
 * questions are returned in the result so the engine can ask the user and
 * re-run. A blocked status remains a gate failure. Documentation updates are
 * carried forward for the DOCUMENTATION_UPDATE state.
 */

import type { AgentRunResult } from "../domain/interfaces.ts";
import type {
  AgentQuestion,
  ReviewFinding,
  ReviewerCompletion,
} from "../domain/schemas.ts";

export interface ReviewGateResult {
  pass: boolean;
  findings: ReviewFinding[];
  documentationUpdates: string[];
  blockingCount: number;
  /**
   * Questions from the reviewer completion (present only when it asked any).
   * Material questions always fail the gate closed; the engine routes them
   * to the user and re-runs the gate after an answer.
   */
  questions?: AgentQuestion[];
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
 * Runs the review gate. Reviewer agent failure, an invalid/blocked
 * completion, or a MATERIAL question is synthesized into blocking finding(s).
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
  // A material question is an unanswered decision the gate cannot make for
  // the user: fail closed and surface the questions so the engine can park
  // the run on them. Minor questions ride along without blocking.
  const materialQuestions = completion.questions.filter(
    (q) => q.severity === "material",
  );
  if (materialQuestions.length > 0) {
    const questionFinding: ReviewFinding = {
      severity: "blocking",
      remediation: `reviewer asked a material question that requires a user decision: ${materialQuestions
        .map((q) => q.question)
        .join("; ")}`,
    };
    const findings = [questionFinding, ...completion.findings];
    return {
      pass: false,
      findings,
      documentationUpdates: completion.documentationUpdates,
      blockingCount: findings.filter(
        (f) => f.severity === "blocking" || f.severity === "major",
      ).length,
      questions: completion.questions,
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
    ...(completion.questions.length > 0 ? { questions: completion.questions } : {}),
  };
}
