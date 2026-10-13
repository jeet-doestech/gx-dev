/**
 * Unit tests for the adversarial review gate (PLAN §6.7).
 * Local fakes only: no pi APIs, no network.
 *
 * Material questions from the reviewer fail the gate closed and are returned
 * in the result so the engine can ask the user; a blocked status remains a
 * gate failure.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentRunResult } from "../../extensions/gx-dev/domain/interfaces.ts";
import type { AgentRole, ReviewerCompletion } from "../../extensions/gx-dev/domain/schemas.ts";
import { runReviewGate } from "../../extensions/gx-dev/gates/review-gate.ts";

function agentResult(
  role: AgentRole,
  completion: ReviewerCompletion | null,
  opts?: { ok?: boolean; error?: string },
): AgentRunResult {
  const ok = opts?.ok ?? true;
  const rawText = "```json\n" + JSON.stringify(completion, null, 2) + "\n```";
  const result: AgentRunResult = {
    role,
    completion: ok ? completion : null,
    rawText,
    ok,
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    exitCode: 0,
    infrastructure: false,
  };
  if (opts?.error !== undefined) result.error = opts.error;
  return result;
}

function reviewerCompletion(
  findings: ReviewerCompletion["findings"],
  documentationUpdates: string[] = [],
  status: "complete" | "blocked" = "complete",
): ReviewerCompletion {
  return {
    status,
    summary: "Reviewed the combined diff.",
    artifacts: [],
    questions: [],
    assumptions: [],
    risks: [],
    findings,
    documentationUpdates,
  };
}

describe("review gate", () => {
  it("passes with zero blocking/major findings and carries documentation updates", async () => {
    let prompt = "";
    const result = await runReviewGate({
      stagingDir: "/tmp/staging",
      combinedDiff: "diff --git a/src/x.ts b/src/x.ts",
      requirements: "Add a greeting endpoint",
      runReviewerAgent: async (p) => {
        prompt = p;
        return agentResult(
          "reviewer",
          reviewerCompletion(
            [
              { severity: "minor", path: "src/x.ts", remediation: "Rename variable." },
              { severity: "info", remediation: "Consider a JSDoc comment." },
            ],
            ["README.md", "docs/api.md"],
          ),
        );
      },
    });
    assert.equal(result.pass, true);
    assert.equal(result.blockingCount, 0);
    assert.equal(result.findings.length, 2);
    assert.deepEqual(result.documentationUpdates, ["README.md", "docs/api.md"]);
    assert.match(prompt, /Add a greeting endpoint/);
    assert.match(prompt, /combined staged diff/);
  });

  it("fails on a blocking finding", async () => {
    const result = await runReviewGate({
      stagingDir: "/tmp/staging",
      combinedDiff: "diff",
      requirements: "req",
      runReviewerAgent: async () =>
        agentResult(
          "reviewer",
          reviewerCompletion([
            { severity: "blocking", path: "src/x.ts", line: 12, remediation: "SQL injection: parameterize the query." },
          ]),
        ),
    });
    assert.equal(result.pass, false);
    assert.equal(result.blockingCount, 1);
  });

  it("blocks on major severity in v1", async () => {
    const result = await runReviewGate({
      stagingDir: "/tmp/staging",
      combinedDiff: "diff",
      requirements: "req",
      runReviewerAgent: async () =>
        agentResult(
          "reviewer",
          reviewerCompletion([
            { severity: "major", path: "src/y.ts", remediation: "Unchecked error path swallows failures." },
            { severity: "minor", remediation: "Nit." },
          ]),
        ),
    });
    assert.equal(result.pass, false);
    assert.equal(result.blockingCount, 1);
  });

  it("fails when the reviewer agent fails or returns an invalid completion", async () => {
    const failed = await runReviewGate({
      stagingDir: "/tmp/staging",
      combinedDiff: "diff",
      requirements: "req",
      runReviewerAgent: async () =>
        agentResult("reviewer", null, { ok: false, error: "agent crashed" }),
    });
    assert.equal(failed.pass, false);
    assert.equal(failed.blockingCount, 1);
    assert.match(failed.findings[0]!.remediation, /agent crashed/);

    const invalid = await runReviewGate({
      stagingDir: "/tmp/staging",
      combinedDiff: "diff",
      requirements: "req",
      runReviewerAgent: async () => agentResult("reviewer", null, { ok: true }),
    });
    assert.equal(invalid.pass, false);
    assert.equal(invalid.blockingCount, 1);
  });

  it("fails when the reviewer reports status blocked", async () => {
    const result = await runReviewGate({
      stagingDir: "/tmp/staging",
      combinedDiff: "diff",
      requirements: "req",
      runReviewerAgent: async () =>
        agentResult(
          "reviewer",
          reviewerCompletion([], [], "blocked"),
        ),
    });
    assert.equal(result.pass, false);
    assert.equal(result.blockingCount, 1);
  });

  it("fails closed and surfaces material questions from the reviewer", async () => {
    const completion = {
      ...reviewerCompletion([
        { severity: "minor", path: "src/x.ts", remediation: "Rename variable." },
      ]),
      questions: [
        {
          question: "Should the deprecated endpoint stay behind a flag?",
          severity: "material" as const,
        },
      ],
    };
    const result = await runReviewGate({
      stagingDir: "/tmp/staging",
      combinedDiff: "diff",
      requirements: "req",
      runReviewerAgent: async () => agentResult("reviewer", completion),
    });
    assert.equal(result.pass, false, "a material question must fail the gate closed");
    assert.equal(result.blockingCount, 1);
    assert.match(result.findings[0]!.remediation, /material question/);
    assert.match(
      result.findings[0]!.remediation,
      /Should the deprecated endpoint stay behind a flag\?/,
    );
    assert.equal(result.questions?.length, 1);
    assert.equal(
      result.questions?.[0]?.question,
      "Should the deprecated endpoint stay behind a flag?",
    );
    assert.equal(result.questions?.[0]?.severity, "material");
  });

  it("keeps the reviewer's own findings alongside the material-question finding", async () => {
    const completion = {
      ...reviewerCompletion([
        { severity: "major", path: "src/y.ts", remediation: "Unchecked error path." },
      ]),
      questions: [
        { question: "Drop the legacy format now?", severity: "material" as const },
      ],
    };
    const result = await runReviewGate({
      stagingDir: "/tmp/staging",
      combinedDiff: "diff",
      requirements: "req",
      runReviewerAgent: async () => agentResult("reviewer", completion),
    });
    assert.equal(result.pass, false);
    assert.equal(result.blockingCount, 2, "material question finding + major finding");
    assert.ok(result.findings.some((f) => f.remediation === "Unchecked error path."));
    assert.equal(result.questions?.length, 1);
  });

  it("passes with only minor questions and reports them in the result", async () => {
    const completion = {
      ...reviewerCompletion([
        { severity: "info", remediation: "Consider a JSDoc comment." },
      ]),
      questions: [
        { question: "Add benchmarks in a follow-up?", severity: "minor" as const },
      ],
    };
    const result = await runReviewGate({
      stagingDir: "/tmp/staging",
      combinedDiff: "diff",
      requirements: "req",
      runReviewerAgent: async () => agentResult("reviewer", completion),
    });
    assert.equal(result.pass, true);
    assert.equal(result.blockingCount, 0);
    assert.equal(result.questions?.length, 1);
    assert.equal(result.questions?.[0]?.question, "Add benchmarks in a follow-up?");
    assert.equal(result.questions?.[0]?.severity, "minor");
  });
});
