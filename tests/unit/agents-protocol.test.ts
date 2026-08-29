/**
 * Unit tests for the structured completion validation bridge (agents/protocol.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateOrFeedback } from "../../extensions/gx-dev/agents/protocol.ts";

function fenced(json: unknown): string {
  return `Lead-in sentence.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

const researcherCompletion = {
  status: "complete",
  summary: "Repo uses Node 22 and vitest.",
  artifacts: ["requirements-draft.md"],
  questions: [{ question: "Target Node version?", severity: "minor" }],
  assumptions: ["node >= 22"],
  risks: ["legacy build script"],
  recommendedNextState: "PLAN",
  sources: [
    {
      url: "https://example.com/a",
      title: "A source",
      retrievedAt: "2025-01-01T00:00:00Z",
      excerpt: "relevant",
      confidence: "high",
    },
  ],
  findings: ["vitest configured"],
  requirementAmbiguities: ["wording of AC2"],
};

describe("validateOrFeedback", () => {
  it("accepts a valid fenced researcher completion", () => {
    const r = validateOrFeedback("researcher", fenced(researcherCompletion));
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.equal(r.feedback, undefined);
    assert.ok(r.completion);
    if (r.completion?.status !== undefined) assert.equal(r.completion.status, "complete");
    const c = r.completion as typeof researcherCompletion & { status: string };
    assert.equal(c.sources.length, 1);
    assert.equal(c.sources[0]?.confidence, "high");
    assert.equal(c.requirementAmbiguities[0], "wording of AC2");
  });

  it("accepts a bare JSON object without a fence", () => {
    const r = validateOrFeedback("researcher", JSON.stringify({ ...researcherCompletion, questions: [] }));
    assert.equal(r.ok, true);
    assert.ok(r.completion);
  });

  it("rejects unparseable text and reports the parse error", () => {
    const r = validateOrFeedback("researcher", "I could not produce JSON, sorry.");
    assert.equal(r.ok, false);
    assert.equal(r.completion, undefined);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0] ?? "", /unparseable JSON/);
    assert.ok(r.feedback);
    assert.match(r.feedback ?? "", /failed researcher schema validation/);
    assert.match(r.feedback ?? "", /unparseable JSON/);
  });

  it("lists schema errors and builds feedback on invalid base fields", () => {
    const r = validateOrFeedback("researcher", fenced({ status: "done", sources: [] }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("status")));
    assert.ok(r.errors.some((e) => e.includes("summary")));
    assert.ok(r.errors.some((e) => e.includes("findings")));
    assert.match(r.feedback ?? "", /status: must be 'complete' or 'blocked'/);
    assert.match(r.feedback ?? "", /Required base fields/);
  });

  it("requires a non-empty planner rollbackPlan", () => {
    const base = {
      status: "complete",
      summary: "plan",
      artifacts: [],
      questions: [],
      assumptions: [],
      risks: [],
      tasks: [{ id: "T1", assignee: "developer", title: "Do it", files: ["a.ts"], dependsOn: [] }],
      verificationContract: ["npm test"],
      rollbackPlan: "",
    };
    const bad = validateOrFeedback("planner", fenced(base));
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.includes("rollbackPlan")));

    const good = validateOrFeedback("planner", fenced({ ...base, rollbackPlan: "git revert <sha>" }));
    assert.equal(good.ok, true);
    assert.ok(good.completion);
  });

  it("rejects invalid committer strategy and accepts a valid commit report", () => {
    const base = {
      status: "complete",
      summary: "committed",
      artifacts: [],
      questions: [],
      assumptions: [],
      risks: [],
    };
    const bad = validateOrFeedback("committer", fenced({ ...base, strategy: "force-push" }));
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.includes("strategy")));

    const good = validateOrFeedback(
      "committer",
      fenced({ ...base, strategy: "cherry-pick", commitHash: "abc1234", rollbackCommand: "git revert abc1234" }),
    );
    assert.equal(good.ok, true);
    assert.ok(good.completion);
  });

  it("rejects reviewer findings without remediation", () => {
    const r = validateOrFeedback(
      "reviewer",
      fenced({
        status: "complete",
        summary: "reviewed",
        artifacts: [],
        questions: [],
        assumptions: [],
        risks: [],
        findings: [{ severity: "major", path: "a.ts" }],
        documentationUpdates: [],
      }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("remediation")));
  });

  it("rejects testRunner commands without numeric exit codes", () => {
    const r = validateOrFeedback(
      "testRunner",
      fenced({
        status: "complete",
        summary: "ran",
        artifacts: [],
        questions: [],
        assumptions: [],
        risks: [],
        commands: [{ command: "npm test" }],
        ownership: [],
      }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("exitCode")));
  });
});
