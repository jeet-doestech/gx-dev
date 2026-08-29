/**
 * Unit tests for the test gate and final gate (PLAN §6.6, §6.8, §9).
 * Local fakes only: no pi APIs, no real command execution.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentRunResult } from "../../extensions/gx-dev/domain/interfaces.ts";
import type {
  AgentRole,
  TestRunnerCompletion,
} from "../../extensions/gx-dev/domain/schemas.ts";
import { runFinalGate } from "../../extensions/gx-dev/gates/final-gate.ts";
import {
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
      verificationContract: [],
      developerDiff:
        ["diff --git a/src/feature.ts b/src/feature.ts", "+++ b/src/feature.ts", ...CODE_LINES.map((l) => `+${l}`), "+<<<<<<< HEAD", "+=======", "+>>>>>>> branch"].join("\n"),
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
      verificationContract: [],
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

  it("fails when a command exits non-zero", async () => {
    const exec = new FakeExecutor(({ command }) =>
      command.includes("exit(0)") ? { exitCode: 0, output: "ok" } : { exitCode: 3, output: "2 failing" },
    );
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: [],
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
    assert.match(result.failureSummary, /exit 3/);
    assert.deepEqual(result.ownership, [{ failure: "greeting mismatch", owner: "developer" }]);
  });

  it("defaults ownership to both when the agent provides none", async () => {
    const exec = new FakeExecutor(() => ({ exitCode: 1, output: "boom" }));
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: [],
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
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: [],
      developerDiff: DEV_DIFF_OK,
      testsDiff: "   ",
      deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () =>
        agentResult("testRunner", testRunnerCompletion([])),
      ),
    });
    assert.equal(result.pass, false);
    assert.ok(result.preflightIssues.some((i) => i.includes("missing promised tests")));
  });

  it("flags absence of meaningful implementation under 10 non-trivial lines", async () => {
    const tiny = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "+++ b/src/feature.ts",
      "+export const x = 1;",
      "+export const y = 2;",
      "+export const z = 3;",
    ].join("\n");
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: [],
      developerDiff: tiny,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () =>
        agentResult("testRunner", testRunnerCompletion([])),
      ),
    });
    assert.equal(result.pass, false);
    assert.ok(result.preflightIssues.some((i) => i.includes("no meaningful implementation")));
  });

  it("flags secrets in diffs", async () => {
    const secreted = DEV_DIFF_OK + "\n+const token = \"supersecretvalue123\";\n";
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: [],
      developerDiff: secreted,
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () =>
        agentResult("testRunner", testRunnerCompletion([])),
      ),
    });
    assert.equal(result.pass, false);
    assert.ok(result.preflightIssues.some((i) => /credential|secret/i.test(i)));
  });

  it("flags vendor/generated files but allows package-lock.json", async () => {
    const vendor = DEV_DIFF_OK + "\ndiff --git a/node_modules/left-pad/index.js b/node_modules/left-pad/index.js\n+++ b/node_modules/left-pad/index.js\n+module.exports = 1;\n";
    const result = await runTestGate({
      stagingDir: "/tmp/staging",
      requirements: "req",
      verificationContract: [],
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
      verificationContract: [],
      developerDiff: DEV_DIFF_OK + "\ndiff --git a/package-lock.json b/package-lock.json\n+++ b/package-lock.json\n+\"lockfileVersion\": 3\n",
      testsDiff: TEST_DIFF_OK,
      deps: gateDeps(new FakeExecutor(() => ({ exitCode: 0, output: "" })), async () => {
        agentCalled = true;
        return agentResult("testRunner", testRunnerCompletion([]));
      }),
    });
    assert.equal(agentCalled, true);
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
});
