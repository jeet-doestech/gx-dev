/**
 * Test gate (PLAN §6.6, §9).
 *
 * A deterministic, agent-free preflight rejects obvious problems before any
 * model is invoked: conflict markers, missing implementation, missing
 * promised tests, secrets, and unrelated vendor/generated files. The
 * test-runner agent then proposes verification commands; the gate executes
 * them only when each matches a strict allowlist, with a 10-minute timeout
 * per command and 64 KiB output truncation. Evidence outranks confidence:
 * pass/fail comes from real exit codes, not the agent's claims.
 */

import { hashContent } from "../domain/artifacts.ts";
import type { AgentRunResult } from "../domain/interfaces.ts";
import type { CommandResult, TestRunnerCompletion } from "../domain/schemas.ts";

/** Executes a shell command in a cwd and captures exit code + output. */
export interface CommandExecutor {
  execute(
    cwd: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string; truncated: boolean }>;
}

export interface TestGateDeps {
  exec: CommandExecutor;
  runTestRunnerAgent: (prompt: string) => Promise<AgentRunResult>;
}

export interface TestGateResult {
  pass: boolean;
  preflightIssues: string[];
  commands: CommandResult[];
  ownership: TestRunnerCompletion["ownership"];
  failureSummary: string;
}

/**
 * Strict command allowlist. Anything else (rm, curl, git push, ...) is
 * rejected without execution and fails the gate.
 */
export const COMMAND_ALLOWLIST =
  /^(?:npm|pnpm|yarn|node|npx|python3?|pytest|make|deno|bun|git diff|git status)(?: |$)/;

export function isAllowlistedCommand(command: string): boolean {
  return COMMAND_ALLOWLIST.test(command.trim());
}

/** Per-command timeout: 10 minutes. */
export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Output truncation ceiling: 64 KiB. */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** Local secret heuristics (mirrors the redaction policy; no cross-slice import). */
const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "hardcoded credential assignment",
    pattern:
      /\b(?:api[_-]?key|apikey|secret|password|passwd|token|auth[_-]?token)\b\s*[:=]\s*["'][^"']{8,}["']/i,
  },
  {
    name: "credential embedded in URL",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]{8,}@/,
  },
];

const DIFF_METADATA = /^(?:diff --git |index |@@ |\+\+\+ |--- )/;
const PUNCTUATION_ONLY = /^[{}()[\];,.<>=+\-*/|&!?~^%\\`@#$:'"]+$/;
const COMMENT_ONLY = /^(?:\/\/|\/\*|\*<\/?|#)/;

/** Non-trivial content lines: not diff metadata, blank, punctuation, or comments. */
export function countNonTrivialLines(content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    if (DIFF_METADATA.test(line)) continue;
    const body = line.replace(/^[+\- ]/, "").trim();
    if (body === "") continue;
    if (PUNCTUATION_ONLY.test(body)) continue;
    if (COMMENT_ONLY.test(body)) continue;
    count += 1;
  }
  return count;
}

/** Extracts changed file paths from unified diffs. */
export function changedPaths(diffs: string[]): string[] {
  const paths = new Set<string>();
  for (const diff of diffs) {
    for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
      const path = m[2];
      if (path) paths.add(path);
    }
    for (const m of diff.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) {
      const path = m[1];
      if (path && path !== "/dev/null") paths.add(path);
    }
  }
  return [...paths];
}

/** package-lock.json changes are allowed; node_modules/ and dist/ are not. */
export function isVendorOrGeneratedPath(path: string): boolean {
  if (/^package-lock\.json$/.test(path)) return false;
  return /(?:^|\/)(?:node_modules|dist)\//.test(path);
}

export interface PreflightInput {
  developerDiff: string;
  testsDiff: string;
}

/** Pure, deterministic preflight — no agent involved. */
export function runPreflight(input: PreflightInput): string[] {
  const issues: string[] = [];
  const pairs: readonly (readonly [string, string])[] = [
    ["developer", input.developerDiff],
    ["test", input.testsDiff],
  ];
  for (const [label, diff] of pairs) {
    if (diff.includes("<<<<<<<")) {
      issues.push(`unresolved conflict markers (<<<<<<<) in ${label} diff`);
    }
  }
  if (countNonTrivialLines(input.developerDiff) < 10) {
    issues.push(
      "no meaningful implementation: developer diff has fewer than 10 non-trivial lines",
    );
  }
  if (input.testsDiff.trim() === "") {
    issues.push("missing promised tests: test diff is empty");
  }
  for (const [label, diff] of pairs) {
    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(diff)) {
        issues.push(`possible ${secret.name} in ${label} diff`);
      }
    }
  }
  for (const path of changedPaths([input.developerDiff, input.testsDiff])) {
    if (isVendorOrGeneratedPath(path)) {
      issues.push(`unrelated vendor/generated file in diff: ${path}`);
    }
  }
  return [...new Set(issues)];
}

function buildTestRunnerPrompt(input: {
  requirements: string;
  verificationContract: string[];
  developerDiff: string;
  testsDiff: string;
  files: string[];
}): string {
  return [
    "You are the test runner. Inspect the diffs, then return ONE testRunner JSON completion with: the exact commands needed to verify the change (commands[] with command and expected exitCode) and an ownership classification for any failure (developer | testWriter | both | infrastructure).",
    `Requirements:\n\n${input.requirements || "(none provided)"}`,
    `Verification contract (must be executed):\n${
      input.verificationContract.map((c) => `- ${c}`).join("\n") || "- (none declared)"
    }`,
    `Changed files:\n${input.files.map((f) => `- ${f}`).join("\n") || "- (none detected)"}`,
    `Developer diff:\n\n${input.developerDiff || "(empty)"}`,
    `Test diff:\n\n${input.testsDiff || "(empty)"}`,
    "Only propose commands beginning with: npm, pnpm, yarn, node, npx, python, python3, pytest, make, deno, bun, git diff, git status. Other commands are rejected by the orchestrator.",
  ].join("\n\n");
}

/**
 * Runs the test gate: preflight → test-runner agent → allowlisted execution.
 * Returns the evidence-based result; ownership defaults to "both".
 */
export async function runTestGate(input: {
  stagingDir: string;
  requirements: string;
  verificationContract: string[];
  developerDiff: string;
  testsDiff: string;
  deps: TestGateDeps;
}): Promise<TestGateResult> {
  const preflightIssues = runPreflight({
    developerDiff: input.developerDiff,
    testsDiff: input.testsDiff,
  });
  if (preflightIssues.length > 0) {
    // Reject before spending an agent run: the problems are already fatal.
    const summary = `preflight failed: ${preflightIssues.join("; ")}`;
    return {
      pass: false,
      preflightIssues,
      commands: [],
      ownership: [{ failure: summary, owner: "both" }],
      failureSummary: summary,
    };
  }

  const files = changedPaths([input.developerDiff, input.testsDiff]);
  const prompt = buildTestRunnerPrompt({
    requirements: input.requirements,
    verificationContract: input.verificationContract,
    developerDiff: input.developerDiff,
    testsDiff: input.testsDiff,
    files,
  });
  const result = await input.deps.runTestRunnerAgent(prompt);
  const completion =
    result.completion && "commands" in result.completion ? result.completion : null;
  if (!result.ok || completion === null) {
    const failure =
      result.error ?? "test runner agent failed or returned an invalid completion";
    return {
      pass: false,
      preflightIssues,
      commands: [],
      ownership: [{ failure, owner: "both" }],
      failureSummary: failure,
    };
  }

  const commands: CommandResult[] = [];
  const failures: string[] = [];
  let pass = completion.status === "complete";
  if (completion.status !== "complete") {
    failures.push(`test runner reported blocked: ${completion.summary}`);
  }
  for (const command of completion.commands) {
    if (!isAllowlistedCommand(command.command)) {
      commands.push({
        command: command.command,
        exitCode: -1,
        outputRef: "rejected: command not on allowlist",
      });
      failures.push(`rejected non-allowlisted command: ${command.command}`);
      pass = false;
      continue;
    }
    const startedAt = Date.now();
    const run = await input.deps.exec.execute(
      input.stagingDir,
      command.command,
      COMMAND_TIMEOUT_MS,
    );
    const truncated = run.truncated || run.output.length > MAX_OUTPUT_BYTES;
    const output = truncated ? run.output.slice(0, MAX_OUTPUT_BYTES) : run.output;
    commands.push({
      command: command.command,
      exitCode: run.exitCode,
      outputRef: `output:${hashContent(output).slice(0, 16)}`,
      durationMs: Date.now() - startedAt,
    });
    if (run.exitCode !== 0) {
      failures.push(`command failed with exit ${run.exitCode}: ${command.command}`);
      pass = false;
    }
  }

  const ownership: TestRunnerCompletion["ownership"] =
    completion.ownership.length > 0
      ? completion.ownership
      : [{ failure: failures.join("; ") || "test gate result", owner: "both" }];
  const failureSummary = pass
    ? "test gate passed"
    : failures.join("; ") || "test gate failed";
  return { pass, preflightIssues, commands, ownership, failureSummary };
}
