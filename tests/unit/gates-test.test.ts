/**
 * Unit tests for the test gate and final gate (PLAN §6.6, §6.8, §9).
 * Local fakes only: no pi APIs, no real command execution.
 *
 * Contract enforcement (REVIEW P0 "verification can pass without running the
 * promised tests"): the verification contract must be nonempty, the gate
 * deterministically executes the union of contract + advisory commands, and
 * empty advisory commands cannot omit the contract. Command output is
 * archived through an optional ArtifactStore or archiver callback, and
 * failures carry bounded, secret-redacted diagnostic output.
 *
 * Preflight (REVIEW P2 "arbitrary 10 meaningful lines"): the implementation
 * check is content-aware — a real one-line fix or pure deletion passes, an
 * empty or prose-only diff fails — and the secret scan covers only ADDED
 * diff lines, so removing a secret is never itself a violation. Material
 * questions from the test runner fail the gate closed and are returned so
 * the engine can ask the user.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hashContent,
  MemoryArtifactStore,
} from "../../extensions/gx-dev/domain/artifacts.ts";
import { redactSecrets } from "../../extensions/gx-dev/memory/redaction.ts";
import type { AgentRunResult } from "../../extensions/gx-dev/domain/interfaces.ts";
import type {
  AgentRole,
  TestRunnerCompletion,
} from "../../extensions/gx-dev/domain/schemas.ts";
import { runFinalGate } from "../../extensions/gx-dev/gates/final-gate.ts";
import {
  commandEvidenceContent,
  FAILURE_DIAGNOSTIC_BUDGET,
  FAILURE_DIAGNOSTIC_CHARS,
  runTestGate,
  type CommandExecutor,
  type TestGateDeps,
} from "../../extensions/gx-dev/gates/test-gate.ts";

function agentResult(
  role: AgentRole,
  completion: TestRunnerCompletion | null,
  opts?: { ok?: boolean; error?: string },
): AgentRunResult {
  const ok = opts?.ok ?? true;
  const result: AgentRunResult = {
    role,
    completion: ok ? completion : null,
    rawText: "```json\n" + JSON.stringify(completion, null, 2) + "\n```",
    ok,
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    exitCode: 0,
    infrastructure: false,
  };
  if (opts?.error !== undefined) result.error = opts.error;
  return result;
}

function testRunnerCompletion(
  commands: string[],
  ownership: TestRunnerCompletion["ownership"] = [],
): TestRunnerCompletion {
  return {
    status: "complete",
    summary: "Ran the verification commands.",
    artifacts: [],
    questions: [],
    assumptions: [],
    risks: [],
    commands: commands.map((command) => ({ command, exitCode: 0 })),
    ownership,
  };
}

class FakeExecutor implements CommandExecutor {
  readonly executed: { cwd: string; command: string; timeoutMs: number }[] = [];
  private readonly respond: (call: { cwd: string; command: string }) => {
    exitCode: number;
    output: string;
  };
  constructor(
    respond: (call: { cwd: string; command: string }) => { exitCode: number; output: string },
  ) {
    this.respond = respond;
  }
  async execute(cwd: string, command: string, timeoutMs: number) {
    this.executed.push({ cwd, command, timeoutMs });
    return { ...this.respond({ cwd, command }), truncated: false };
  }
}

const CODE_LINES = [
  "export function greet(name: string): string {",
  "  const cleaned = name.trim();",
  "  if (cleaned.length === 0) {",
  "    throw new Error(\"name must not be empty\");",
  "  }",
  "  return `Hello, ${cleaned}!`;",
  "}",
  "export function greetFormal(name: string): string {",
  "  return `Good day, ${name.trim()}.`;",
  "}",
  "export const GREETING_VERSION = 1;",
  "export const DEFAULT_NAME = \"world\";",
  "export function resetCounter(): void {",
  "  counter = 0;",
  "}",
  "let counter = 0;",
];

const DEV_DIFF_OK = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "--- a/src/feature.ts",
  "+++ b/src/feature.ts",
  "@@ -0,0 +1,16 @@",
  ...CODE_LINES.map((l) => `+${l}`),
].join("\n");

const TEST_DIFF_OK = [
  "diff --git a/test/feature.test.ts b/test/feature.test.ts",
  "--- a/test/feature.test.ts",
  "+++ b/test/feature.test.ts",
  "@@ -0,0 +1,8 @@",
  "+import { greet } from \"../src/feature.ts\";",
  "+import assert from \"node:assert/strict\";",
  "+assert.equal(greet(\"ada\"), \"Hello, ada!\");",
  "+assert.throws(() => greet(\"  \"));",
  "+assert.equal(greetFormal(\"lovelace\"), \"Good day, lovelace.\");",
  "+assert.equal(GREETING_VERSION, 1);",
  "+assert.equal(DEFAULT_NAME, \"world\");",
  "+resetCounter();",
].join("\n");

/** A real one-line fix: a single changed line in an existing file. */
const ONE_LINE_FIX_DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "--- a/src/feature.ts",
  "+++ b/src/feature.ts",
  "@@ -2,1 +2,1 @@",
  "-  const cleaned = name.trim();",
  "+  const cleaned = name.trim().toLowerCase();",
].join("\n");

/** A real pure deletion: lines removed, nothing added. */
const PURE_DELETION_DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "--- a/src/feature.ts",
  "+++ b/src/feature.ts",
  "@@ -12,3 +12,0 @@",
  "-export function resetCounter(): void {",
  "-  counter = 0;",
  "-}",
].join("\n");

/** Prose posing as an implementation: real paths, no code content. */
const PROSE_ONLY_DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "--- a/src/feature.ts",
  "+++ b/src/feature.ts",
  "@@ -0,0 +1,3 @@",
  "+This change adds a friendly greeting helper function.",
  "+It also cleans up the naming and improves overall clarity.",
  "+A follow up change will refresh the documentation files.",
].join("\n");

/** Diff headers with no content hunks at all. */
const METADATA_ONLY_DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "--- a/src/feature.ts",
  "+++ b/src/feature.ts",
].join("\n");

const CONFLICT_DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "--- a/src/feature.ts",
  "+++ b/src/feature.ts",
  "@@ -1,2 +1,6 @@",
  "+export function greet(name: string): string {",
  "+  return `Hello, ${name}!`;",
  "+}",
  "+<<<<<<< HEAD",
  "+=======",
  "+>>>>>>> branch",
].join("\n");

/** A cleanup diff that REMOVES a hardcoded secret (and only that). */
const REMOVED_SECRET_DIFF = [
  "diff --git a/src/config.ts b/src/config.ts",
  "--- a/src/config.ts",
  "+++ b/src/config.ts",
  "@@ -1,2 +1,2 @@",
  " export const config = {",
  "-  token: \"supersecretvalue123\",",
  "+  token: readEnv(\"CONFIG_TOKEN\"),",
  "};",
].join("\n");

function gateDeps(
  exec: CommandExecutor,
  runTestRunnerAgent: TestGateDeps["runTestRunnerAgent"],
): TestGateDeps {
  return { exec, runTestRunnerAgent };
}

describe("test gate preflight", () => {
  it("catches unresolved conflict markers and skips the agent", async () => {
    let agentCalled = false;
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node --test"],
      developerDiff: CONFLICT_DIFF,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion(["npm test"]));
      }),
    });
    assert.equal(result.pass, false);
    assert.equal(result.commands.length, 0);
    assert.equal(agentCalled, false);
    assert.ok(result.preflightIssues.some((i) => i.includes("conflict markers")));
  });

  it("rejects non-allowlisted commands without executing them", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node -e process.exit(0)"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult(
          "testRunner",
          testRunnerCompletion(["rm -rf /", "curl http://evil.example", "node -e process.exit(0)"]),
        ),
      ),
    });
    assert.equal(result.pass, false);
    // Only the allowlisted command touched the executor.
    assert.deepEqual(
      exec.executed.map((c) => c.command),
      ["node -e process.exit(0)"],
    );
    const rejected = result.commands.filter((c) => c.exitCode === -1);
    assert.equal(rejected.length, 2);
    assert.match(rejected[0]!.outputRef ?? "", /not on allowlist/);
  });

  it("passes when the agent completes and all commands exit 0", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "all tests passed" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node -e process.exit(0)"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult(
          "testRunner",
          testRunnerCompletion(["node -e process.exit(0)"], [
            { failure: "unused", owner: "testWriter" },
          ]),
        ),
      ),
    });
    assert.equal(result.pass, true);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0]!.exitCode, 0);
    assert.ok((result.commands[0]!.durationMs ?? 0) >= 0);
    assert.deepEqual(result.ownership, [{ failure: "unused", owner: "testWriter" }]);
    assert.equal(exec.executed[0]!.cwd, "/tmp/staging");
    assert.equal(exec.executed[0]!.timeoutMs, 10 * 60 * 1000);
  });

  it("fails when a contract command exits non-zero", async () => {
    const exec = new FakeExecutor(({ command }) =>
      command.includes("exit(0)") ? { exitCode: 0, output: "ok" } : { exitCode: 3, output: "2 failing" },
    );
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult(
          "testRunner",
          testRunnerCompletion(["npm test"], [
            { failure: "greeting mismatch", owner: "developer" },
          ]),
        ),
      ),
    });
    assert.equal(result.pass, false);
    // The duplicate advisory proposal is subsumed by the contract entry.
    assert.equal(exec.executed.length, 1);
    assert.match(result.failureSummary, /required contract command failed with exit 3/);
    assert.deepEqual(result.ownership, [{ failure: "greeting mismatch", owner: "developer" }]);
  });

  it("defaults ownership to both when the agent provides none", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 1, output: "boom" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion(["npm test"])),
      ),
    });
    assert.equal(result.pass, false);
    assert.equal(result.ownership.length, 1);
    assert.equal(result.ownership[0]!.owner, "both");
  });

  it("flags missing promised tests when the test diff is empty", async () => {
    let agentCalled = false;
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node --test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: "   ",
      deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion([]));
      }),
    });
    assert.equal(result.pass, false);
    assert.equal(agentCalled, false);
    assert.ok(result.preflightIssues.some((i) => i.includes("missing promised tests")));
  });

  it("accepts a valid one-line fix as a meaningful implementation", async () => {
    let agentCalled = false;
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node -e process.exit(0)"],
      developerDiff: ONE_LINE_FIX_DIFF,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion([]));
      }),
    });
    assert.deepEqual(result.preflightIssues, []);
    assert.equal(agentCalled, true, "a real one-line fix must reach the agent");
    assert.equal(result.pass, true);
  });

  it("accepts a pure deletion as a meaningful implementation", async () => {
    let agentCalled = false;
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node -e process.exit(0)"],
      developerDiff: PURE_DELETION_DIFF,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion([]));
      }),
    });
    assert.deepEqual(result.preflightIssues, []);
    assert.equal(agentCalled, true, "a real deletion must reach the agent");
    assert.equal(result.pass, true);
  });

  it("flags prose-only diffs as having no meaningful implementation", async () => {
    let agentCalled = false;
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node --test"],
      developerDiff: PROSE_ONLY_DIFF,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion([]));
      }),
    });
    assert.equal(result.pass, false);
    assert.equal(agentCalled, false, "prose is not code; the agent must not run");
    assert.ok(result.preflightIssues.some((i) => i.includes("no meaningful implementation")));
  });

  it("flags empty and metadata-only developer diffs as no meaningful implementation", async () => {
    for (const developerDiff of ["", METADATA_ONLY_DIFF]) {
      let agentCalled = false;
      const result = await runTestGate({
        stagingDir: "/tmp/staging",
        requirements: "req",
        verificationContract: ["node --test"],
        developerDiff,
        testsDiff: TEST_DIFF_OK,
        deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () => {
          agentCalled = true;
          return agentResult("testRunner", testRunnerCompletion([]));
        }),
      });
      assert.equal(result.pass, false, `diff ${JSON.stringify(developerDiff)} must fail`);
      assert.equal(agentCalled, false);
      assert.ok(result.preflightIssues.some((i) => i.includes("no meaningful implementation")));
    }
  });

  it("flags secrets on added diff lines", async () => {
    const secreted =
      DEV_DIFF_OK + "\n@@ -16,0 +17,1 @@\n+const token = \"supersecretvalue123\";";
    let agentCalled = false;
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node --test"],
      developerDiff: secreted,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion([]));
      }),
    });
    assert.equal(result.pass, false);
    assert.equal(agentCalled, false);
    assert.ok(result.preflightIssues.some((i) => /credential|secret/i.test(i)));
  });

  it("does not flag secrets that the diff removes (only added lines are scanned)", async () => {
    let agentCalled = false;
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node -e process.exit(0)"],
      developerDiff: REMOVED_SECRET_DIFF,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion(["node -e process.exit(0)"]));
      }),
    });
    assert.ok(
      !result.preflightIssues.some((i) => /credential|secret/i.test(i)),
      `removing a secret must not fail preflight: ${result.preflightIssues.join("; ")}`,
    );
    assert.equal(agentCalled, true);
    assert.equal(result.pass, true);
  });

  it("flags vendor/generated files but allows package-lock.json", async () => {
    const vendor =
      DEV_DIFF_OK +
      "\ndiff --git a/node_modules/left-pad/index.js b/node_modules/left-pad/index.js\n--- a/node_modules/left-pad/index.js\n+++ b/node_modules/left-pad/index.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n";
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node --test"],
      developerDiff: vendor,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () =>
        agentResult("testRunner", testRunnerCompletion([])),
      ),
    });
    assert.equal(result.pass, false);
    assert.ok(result.preflightIssues.some((i) => i.includes("node_modules/left-pad/index.js")));

    // package-lock.json alone is fine: gate proceeds past preflight.
    let agentCalled = false;
    await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node --test"],
      developerDiff:
        DEV_DIFF_OK +
        "\ndiff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,2 +1,3 @@\n \"lockfileVersion\": 3,\n+\"name\": \"fixture\",\n",
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion([]));
      }),
    });
    assert.equal(agentCalled, true);
  });
});

describe("verification contract enforcement", () => {
  it("fails closed on an empty contract without invoking the agent or executor", async () => {
    let agentCalled = false;
    const exec = new FakeExecutor(() => {
      throw new Error("executor must not run");
    });
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: [],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion(["npm test"]));
      }),
    });
    assert.equal(result.pass, false);
    assert.equal(agentCalled, false);
    assert.equal(result.commands.length, 0);
    assert.equal(exec.executed.length, 0);
    assert.match(result.failureSummary, /verification contract is empty/);
    assert.equal(result.ownership[0]?.owner, "both");
  });

  it("treats whitespace-only contract entries as an empty contract", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["   "],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion([])),
      ),
    });
    assert.equal(result.pass, false);
    assert.match(result.failureSummary, /verification contract is empty/);
  });

  it("runs the contract when the agent proposes zero commands", async () => {
    // Empty advisor commands cannot omit the contract: it still executes.
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "contract ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node -e process.exit(0)"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion([])),
      ),
    });
    assert.equal(result.pass, true);
    assert.deepEqual(exec.executed.map((c) => c.command), ["node -e process.exit(0)"]);
  });

  it("executes contract commands before advisory commands and never duplicates", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test", "node -e process.exit(0)"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult(
          "testRunner",
          // Duplicates the second contract command and adds one advisory.
          testRunnerCompletion(["node -e process.exit(0)", "make check"]),
        ),
      ),
    });
    assert.equal(result.pass, true);
    assert.deepEqual(
      exec.executed.map((c) => c.command),
      ["npm test", "node -e process.exit(0)", "make check"],
    );
    assert.equal(result.commands.length, 3);
  });

  it("fails when the agent reports blocked even though the contract passes", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const blocked = {
      ...testRunnerCompletion(["npm test"]),
      status: "blocked" as const,
      summary: "waiting on flaky network",
    };
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () => agentResult("testRunner", blocked)),
    });
    assert.equal(result.pass, false);
    assert.match(result.failureSummary, /reported blocked/);
  });

  it("fails closed and surfaces material questions from the test runner", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "must not run" }));
    const completion = {
      ...testRunnerCompletion(["npm test"]),
      questions: [
        {
          question: "Which database should the integration tests target?",
          severity: "material" as const,
        },
      ],
    };
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () => agentResult("testRunner", completion)),
    });
    assert.equal(result.pass, false);
    assert.equal(
      exec.executed.length,
      0,
      "no commands may run while a material question is unanswered",
    );
    assert.equal(result.commands.length, 0);
    assert.match(result.failureSummary, /material question/);
    assert.match(result.failureSummary, /Which database should the integration tests target\?/);
    assert.equal(result.questions?.length, 1);
    assert.equal(
      result.questions?.[0]?.question,
      "Which database should the integration tests target?",
    );
    assert.equal(result.questions?.[0]?.severity, "material");
  });

  it("passes with only minor questions and reports them in the result", async () => {
    const completion = {
      ...testRunnerCompletion(["node -e process.exit(0)"]),
      questions: [
        { question: "Rename the helper in a follow-up?", severity: "minor" as const },
      ],
    };
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["node -e process.exit(0)"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () => agentResult("testRunner", completion)),
    });
    assert.equal(result.pass, true);
    assert.equal(result.questions?.length, 1);
    assert.equal(result.questions?.[0]?.question, "Rename the helper in a follow-up?");
    assert.equal(result.questions?.[0]?.severity, "minor");
  });
});

describe("evidence archiving and bounded diagnostics", () => {
  it("archives command metadata plus raw output via the artifact store", async () => {
    const store = new MemoryArtifactStore();
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "all 12 tests passed" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion(["npm test"])),
      ),
      store,
    });
    assert.equal(result.pass, true);
    const records = store.evidence();
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.kind, "commands");
    assert.equal(record.source, "test-gate");
    assert.match(record.name, /^test-gate-output-[0-9a-f]{64}\.txt$/);
    assert.equal(result.commands[0]?.outputRef, `evidence/commands/${record.name}`);
    // The persisted blob is self-describing: executable-command metadata
    // header (PLAN §6.6) plus the raw output.
    const expected = commandEvidenceContent({
      command: "npm test",
      exitCode: 0,
      source: "test-gate",
      truncated: false,
      output: "all 12 tests passed",
    });
    assert.equal(record.hash, hashContent(redactSecrets(expected).text));
    assert.equal(record.bytes, Buffer.byteLength(redactSecrets(expected).text));
  });

  it("hashes the redacted evidence content, never raw secrets", async () => {
    const store = new MemoryArtifactStore();
    const exec = new FakeExecutor(() => ({
      exitCode: 0,
      output: "loaded key AKIAIOSFODNN7EXAMPLE from env",
    }));
    await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion(["npm test"])),
      ),
      store,
    });
    const record = store.evidence()[0]!;
    assert.ok((record.redactions ?? 0) >= 1, "redaction count must be recorded");
    const expected = commandEvidenceContent({
      command: "npm test",
      exitCode: 0,
      source: "test-gate",
      truncated: false,
      output: "loaded key AKIAIOSFODNN7EXAMPLE from env",
    });
    const redacted = redactSecrets(expected).text;
    // The store applies the shared redaction boundary: the stored hash and
    // bytes cover the redacted envelope, so raw secrets never land on disk.
    assert.equal(record.hash, hashContent(redacted));
    assert.equal(record.bytes, Buffer.byteLength(redacted));
    assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"));
  });

  it("leaves no orphan output hashes when a store is supplied", async () => {
    const store = new MemoryArtifactStore();
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test", "make check"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion(["make check"])),
      ),
      store,
    });
    assert.equal(result.pass, true);
    assert.equal(result.commands.length, 2);
    const refs = new Set(store.evidence().map((r) => `evidence/${r.kind}/${r.name}`));
    for (const c of result.commands) {
      assert.match(c.outputRef ?? "", /^evidence\/commands\//);
      assert.ok(
        refs.has(c.outputRef ?? ""),
        `outputRef must resolve to a stored record: ${c.outputRef}`,
      );
    }
    assert.ok(
      !result.commands.some((c) => (c.outputRef ?? "").startsWith("output:")),
      "with a store, hash-only output refs would be orphaned evidence",
    );
  });

  it("redacts secrets from failure feedback output", async () => {
    const exec = new FakeExecutor(() => ({
      exitCode: 1,
      output: "AssertionError: expected token AKIAIOSFODNN7EXAMPLE to be hidden",
    }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion(["npm test"])),
      ),
    });
    assert.equal(result.pass, false);
    assert.ok(result.failureSummary.includes("command output (bounded)"));
    assert.ok(result.failureSummary.includes("AssertionError: expected token"));
    assert.ok(
      !result.failureSummary.includes("AKIAIOSFODNN7EXAMPLE"),
      "feedback must carry redacted output, not raw secrets",
    );
    assert.ok(result.failureSummary.includes("[REDACTED:api-token]"));
  });

  it("prefers the archiveOutput callback when no store is given", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion(["npm test"])),
      ),
      archiveOutput: (command, output) => `custom:${command}:${output.length}`,
    });
    assert.equal(result.pass, true);
    assert.match(result.commands[0]?.outputRef ?? '', /^custom:npm test:/);
  });

  it("keeps the hash-only outputRef when no archiver is supplied", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "ok" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion(["npm test"])),
      ),
    });
    assert.match(result.commands[0]?.outputRef ?? '', /^output:[0-9a-f]{16}$/);
  });

  it("includes bounded diagnostic output in the failure summary", async () => {
    const exec = new FakeExecutor(() => ({
      exitCode: 7,
      output: `AssertionError: greeting mismatch\n${"x".repeat(5000)}`,
    }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion(["npm test"])),
      ),
    });
    assert.equal(result.pass, false);
    assert.match(result.failureSummary, /exit 7: npm test/);
    assert.ok(result.failureSummary.includes("command output (bounded)"));
    assert.ok(result.failureSummary.includes("AssertionError: greeting mismatch"));
    assert.ok(result.failureSummary.includes("…[truncated]"));
    // The 5000-char output must be clipped well below its raw size.
    assert.ok(result.failureSummary.length < FAILURE_DIAGNOSTIC_CHARS + 1000);
  });

  it("bounds the total diagnostic output across many failing commands", async () => {
    const exec = new FakeExecutor(() => ({
      exitCode: 1,
      output: `boom\n${"y".repeat(5000)}`,
    }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: ["npm test", "make check", "node -e process.exit(2)", "pytest", "deno test"],
      developerDiff: DEV_DIFF_OK,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(exec, async () =>
        agentResult("testRunner", testRunnerCompletion([])),
      ),
    });
    assert.equal(result.pass, false);
    assert.equal(exec.executed.length, 5);
    // 5 raw outputs x ~5000 chars each; the summary must stay bounded.
    assert.ok(
      result.failureSummary.length < FAILURE_DIAGNOSTIC_BUDGET + 4000,
      `failure summary too large: ${result.failureSummary.length}`,
    );
  });
});

describe("final gate", () => {
  it("passes when every contract command exits 0 and the tree is clean", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "" }));
    let cleanChecked = 0;
    const result = await runFinalGate({
      stagingDir: "/tmp/staging",
      verificationContract: ["node -e process.exit(0)", "npm test"],
      exec,
      requireCleanTree: true,
      checkClean: async () => {
        cleanChecked += 1;
        return true;
      },
    });
    assert.equal(result.pass, true);
    assert.equal(result.failures.length, 0);
    assert.equal(result.commands.length, 2);
    assert.equal(cleanChecked, 1);
  });

  it("fails on a dirty tree", async () => {
    const result = await runFinalGate({
      stagingDir: "/tmp/staging",
      verificationContract: ["node -e process.exit(0)"],
      exec: new FakeExecutor(() => ({ exitCode: 0, output: "" })),
      requireCleanTree: true,
      checkClean: async () => false,
    });
    assert.equal(result.pass, false);
    assert.ok(result.failures.some((f) => f.includes("not clean")));
  });

  it("fails when a contract command exits non-zero", async () => {
    const exec = new FakeExecutor(({ command }) =>
      command.includes("exit(0)") ? { exitCode: 0, output: "" } : { exitCode: 1, output: "typecheck failed" },
    );
    const result = await runFinalGate({
      stagingDir: "/tmp/staging",
      verificationContract: ["node -e process.exit(0)", "npm run typecheck"],
      exec,
      requireCleanTree: false,
      checkClean: async () => true,
    });
    assert.equal(result.pass, false);
    assert.match(result.failures[0] ?? "", /exit 1/);
  });

  it("rejects non-allowlisted contract commands and skips the clean check when not required", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "" }));
    let cleanChecked = 0;
    const result = await runFinalGate({
      stagingDir: "/tmp/staging",
      verificationContract: ["git push --force origin main"],
      exec,
      requireCleanTree: false,
      checkClean: async () => {
        cleanChecked += 1;
        return true;
      },
    });
    assert.equal(result.pass, false);
    assert.equal(exec.executed.length, 0);
    assert.equal(cleanChecked, 0);
    assert.match(result.failures[0] ?? "", /allowlist/);
  });

  it("fails closed on an empty contract even when the tree is clean", async () => {
    // REVIEW repro: final verification passed an empty contract because the
    // clean-tree check succeeded. It must never pass without executing
    // required checks.
    const exec = new FakeExecutor(() => {
      throw new Error("executor must not run");
    });
    let cleanChecked = 0;
    const result = await runFinalGate({
      stagingDir: "/tmp/staging",
      verificationContract: [],
      exec,
      requireCleanTree: true,
      checkClean: async () => {
        cleanChecked += 1;
        return true;
      },
    });
    assert.equal(result.pass, false);
    assert.equal(exec.executed.length, 0);
    assert.equal(result.commands.length, 0);
    assert.equal(cleanChecked, 1, "clean-tree check still runs for diagnostics");
    assert.ok(result.failures.some((f) => f.includes("verification contract is empty")));
  });

  it("archives final-gate command output through the store", async () => {
    const store = new MemoryArtifactStore();
    const exec = new FakeExecutor(() => ({ exitCode: 0, output: "typecheck ok" }));
    const result = await runFinalGate({
      stagingDir: "/tmp/staging",
      verificationContract: ["npm run typecheck"],
      exec,
      requireCleanTree: false,
      checkClean: async () => true,
      store,
    });
    assert.equal(result.pass, true);
    const records = store.evidence();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.source, "final-gate");
    assert.match(records[0]!.name, /^final-gate-output-[0-9a-f]{64}\.txt$/);
    assert.equal(result.commands[0]?.outputRef, `evidence/commands/${records[0]!.name}`);
  });

  it("includes bounded output in failing verification entries", async () => {
    const exec = new FakeExecutor(() => ({
      exitCode: 1,
      output: `error TS2304: cannot find name 'greet'\n${"z".repeat(5000)}`,
    }));
    const result = await runFinalGate({
      stagingDir: "/tmp/staging",
      verificationContract: ["npm run typecheck"],
      exec,
      requireCleanTree: false,
      checkClean: async () => true,
    });
    assert.equal(result.pass, false);
    const failure = result.failures[0] ?? "";
    assert.match(failure, /exit 1: npm run typecheck/);
    assert.ok(failure.includes("command output (bounded)"));
    assert.ok(failure.includes("error TS2304"));
    assert.ok(failure.includes("…[truncated]"));
    assert.ok(failure.length < FAILURE_DIAGNOSTIC_CHARS + 1000);
  });
});
