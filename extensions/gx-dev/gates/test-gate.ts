/**
 * Test gate (PLAN §6.6, §9).
 *
 * A deterministic, agent-free preflight rejects obvious problems before any
 * model is invoked: an empty verification contract, conflict markers, a
 * developer diff that changes no code content (empty, metadata-only,
 * comment-only, or prose posing as code — a real one-line fix or pure
 * deletion is fine), missing promised tests, secrets on ADDED diff lines
 * (removed secrets are improvements, not violations), and unrelated
 * vendor/generated files. The test-runner agent then proposes advisory
 * verification commands; the gate deterministically executes the union of the
 * planner's verification contract (always, in contract order) plus the
 * agent's not-already-covered proposals, only when each matches an
 * executable-prefix allowlist (a routing filter, not a security sandbox),
 * with a 10-minute timeout per command and 64 KiB output truncation.
 * Advisory commands can add to the contract but never omit from it, and an
 * empty contract fails the gate outright. A test runner that raises a
 * MATERIAL question fails the gate closed: the question is returned in the
 * result so the engine can ask the user. When an artifact store or archiver
 * callback is supplied, each command's executable-command metadata plus its
 * raw output is archived as immutable evidence (the store applies the shared
 * secret-redaction boundary), and failing summaries carry bounded, REDACTED
 * diagnostic output. Evidence outranks confidence: pass/fail comes from real
 * exit codes, not the agent's claims.
 */

import { hashContent, type ArtifactStore } from "../domain/artifacts.ts";
import { redactSecrets } from "../memory/redaction.ts";
import type { AgentRunResult } from "../domain/interfaces.ts";
import type {
  AgentQuestion,
  CommandResult,
  TestRunnerCompletion,
} from "../domain/schemas.ts";

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
  /**
   * Questions from the test-runner completion (present only when it asked
   * any). Material questions always fail the gate closed; the engine routes
   * them to the user and re-runs the gate after an answer.
   */
  questions?: AgentQuestion[];
}

/**
 * Executable-prefix filter — NOT a security sandbox (REVIEW P0). It only
 * checks the first word of a command: allowlisted tools (npm, make, node,
 * ...) can still execute arbitrary code via scripts, -e flags, or targets.
 * Its job is routing (only project verification tooling reaches the
 * executor); anything else (rm, curl, git push, ...) is rejected without
 * execution and fails the gate. It does not constrain what an allowlisted
 * tool can do.
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

/** Max characters of a failing command's output embedded in a summary. */
export const FAILURE_DIAGNOSTIC_CHARS = 2000;

/** Total diagnostic-output budget across one gate run's failure summary. */
export const FAILURE_DIAGNOSTIC_BUDGET = 8 * 1024;

/** Callback alternative to an ArtifactStore: returns the ref to record. */
export type OutputArchiver = (command: string, output: string) => string;

/**
 * Builds the persisted evidence blob for one executed command: an
 * executable-command metadata header (PLAN §6.6: exact commands, exit codes)
 * followed by the raw captured output. The content is deterministic for a
 * given command + output so the content-addressed store deduplicates
 * identical runs; the store applies the shared secret-redaction policy to
 * the whole blob before it touches disk or memory.
 */
export function commandEvidenceContent(input: {
  command: string;
  exitCode: number;
  source: string;
  truncated: boolean;
  output: string;
}): string {
  return [
    `command: ${input.command}`,
    `exitCode: ${input.exitCode}`,
    `source: ${input.source}`,
    `truncated: ${input.truncated}`,
    "",
    input.output,
  ].join("\n");
}

/**
 * Bounds a failing command's output for inclusion in a failure summary so
 * agents rerouting the work see the real stderr/stdout, not just an exit
 * code. Returns "" when there is no output to show.
 */
export function boundedDiagnostic(output: string, maxChars: number): string {
  const trimmed = output.trim();
  if (trimmed === "" || maxChars <= 0) return "";
  const snippet =
    trimmed.length > maxChars
      ? `${trimmed.slice(0, maxChars)}…[truncated]`
      : trimmed;
  return `\n--- command output (bounded) ---\n${snippet}\n--- end of output ---`;
}

export interface ExecutedCommand {
  result: CommandResult;
  /** The (bounded, secret-redacted) output captured from the command. */
  output: string;
  failed: boolean;
}

/**
 * Executes one allowlisted gate command, archives its executable-command
 * metadata plus raw output when an archiver is supplied, and returns the
 * command result plus bounded, secret-REDACTED diagnostic output for
 * failures.
 */
export async function executeGateCommand(input: {
  stagingDir: string;
  command: string;
  exec: CommandExecutor;
  store?: ArtifactStore | undefined;
  archiveOutput?: OutputArchiver | undefined;
  source: string;
  evidenceNamePrefix?: string | undefined;
}): Promise<ExecutedCommand> {
  const startedAt = Date.now();
  const run = await input.exec.execute(input.stagingDir, input.command, COMMAND_TIMEOUT_MS);
  const truncated = run.truncated || run.output.length > MAX_OUTPUT_BYTES;
  const raw = truncated ? run.output.slice(0, MAX_OUTPUT_BYTES) : run.output;
  // Raw output is handed to the evidence store, which applies the shared
  // secret-redaction boundary before anything touches disk or memory.
  // Feedback (failure summaries, rework prompts, events) is persisted and
  // user-visible, so it carries only REDACTED output.
  const output = redactSecrets(raw).text;
  const evidence = commandEvidenceContent({
    command: input.command,
    exitCode: run.exitCode,
    source: input.source,
    truncated,
    output: raw,
  });
  let outputRef = `output:${hashContent(output).slice(0, 16)}`;
  if (input.store !== undefined) {
    const record = input.store.recordEvidence(
      "commands",
      evidence,
      input.source,
      input.evidenceNamePrefix === undefined
        ? undefined
        : `${input.evidenceNamePrefix}.txt`,
    );
    outputRef = `evidence/${record.kind}/${record.name}`;
  } else if (input.archiveOutput !== undefined) {
    outputRef = input.archiveOutput(input.command, output);
  }
  return {
    result: {
      command: input.command,
      exitCode: run.exitCode,
      outputRef,
      durationMs: Date.now() - startedAt,
    },
    output,
    failed: run.exitCode !== 0,
  };
}

/**
 * Local preflight heuristics (mirror the redaction policy's shapes without a
 * cross-slice dependency). They only decide whether a diff LOOKS like it
 * introduces a secret; feedback redaction uses the shared memory/redaction
 * policy, and evidence storage re-applies it at the store boundary.
 */
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

/** Code-syntax characters: brackets, operators, strings, statements. */
const CODE_SYNTAX = /[{}()[\]<>=+*/\\|&^~`$%;:@"'-]/;

/** Statements/declarations that are code even without syntax characters. */
const CODE_KEYWORD =
  /^(?:return|if|else|elif|for|while|switch|case|default|break|continue|import|from|export|const|let|var|function|def|class|struct|enum|interface|type|public|private|protected|static|async|await|try|catch|except|finally|raise|throw|new|delete|yield|pass|with|package|use|fn|impl|match|end|do|then|begin|print|echo)\b/;

interface DiffContentLines {
  added: string[];
  removed: string[];
}

/**
 * Added (+) and removed (-) content lines of a unified diff. Diff metadata
 * (headers, hunks, +++/---) and context lines are excluded: context is
 * pre-existing content, not part of the change. A removed line whose text
 * itself starts with `-- ` is indistinguishable from the `--- ` header and
 * is skipped (same limitation as any line-based diff parser).
 */
function diffContentLines(diff: string): DiffContentLines {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (DIFF_METADATA.test(line)) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

/**
 * True when a line looks like natural-language prose rather than code: at
 * least two bare words, no code-syntax characters, and no leading code
 * keyword. This is what stops a prose paragraph from masquerading as an
 * implementation (REVIEW: the old line-count preflight "can accept
 * substantial prose"). It errs toward prose for genuinely terse code
 * fragments, which fails closed.
 */
export function isProseLine(line: string): boolean {
  const body = line.trim();
  if (body === "") return false;
  if (CODE_KEYWORD.test(body)) return false;
  if (CODE_SYNTAX.test(body)) return false;
  return body.split(/\s+/).length >= 2;
}

/**
 * True when the developer diff changes real files with real code: at least
 * one ADDED or REMOVED line that is neither blank, punctuation, a comment,
 * nor prose. A valid one-line fix and a pure deletion both qualify; an
 * empty diff, metadata-only diff, or prose-only "implementation" does not
 * (REVIEW: the arbitrary 10-line check rejected one-line fixes yet accepted
 * substantial prose).
 */
export function hasMeaningfulImplementation(developerDiff: string): boolean {
  if (changedPaths([developerDiff]).length === 0) return false;
  const { added, removed } = diffContentLines(developerDiff);
  for (const line of [...added, ...removed]) {
    const body = line.trim();
    if (body === "") continue;
    if (PUNCTUATION_ONLY.test(body)) continue;
    if (COMMENT_ONLY.test(body)) continue;
    if (isProseLine(body)) continue;
    return true;
  }
  return false;
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
  if (!hasMeaningfulImplementation(input.developerDiff)) {
    issues.push(
      "no meaningful implementation: developer diff changes no code content (empty, metadata-only, comment-only, or prose)",
    );
  }
  if (input.testsDiff.trim() === "") {
    issues.push("missing promised tests: test diff is empty");
  }
  // Only ADDED lines can introduce a secret: a removed secret is a fix, and
  // context lines are pre-existing content outside this change.
  for (const [label, diff] of pairs) {
    for (const line of diffContentLines(diff).added) {
      for (const secret of SECRET_PATTERNS) {
        if (secret.pattern.test(line)) {
          issues.push(`possible ${secret.name} in ${label} diff`);
        }
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
    `Verification contract (REQUIRED — these run first no matter what you propose; you may add advisory commands):\n${
      input.verificationContract.map((c) => `- ${c}`).join("\n") || "- (none declared)"
    }`,
    `Changed files:\n${input.files.map((f) => `- ${f}`).join("\n") || "- (none detected)"}`,
    `Developer diff:\n\n${input.developerDiff || "(empty)"}`,
    `Test diff:\n\n${input.testsDiff || "(empty)"}`,
    "Only propose commands beginning with: npm, pnpm, yarn, node, npx, python, python3, pytest, make, deno, bun, git diff, git status. Other commands are rejected by the orchestrator.",
  ].join("\n\n");
}

/**
 * Deterministic execution plan: every contract command first (in contract
 * order, deduplicated), then the agent's advisory proposals that the contract
 * does not already cover. Advisory commands can extend the contract but never
 * replace or omit from it.
 */
export function planCommandUnion(
  verificationContract: string[],
  proposed: CommandResult[],
): { command: string; required: boolean }[] {
  const seen = new Set<string>();
  const plan: { command: string; required: boolean }[] = [];
  for (const raw of verificationContract) {
    const command = raw.trim();
    if (command === "" || seen.has(command)) continue;
    seen.add(command);
    plan.push({ command, required: true });
  }
  for (const proposal of proposed) {
    const command = proposal.command.trim();
    if (command === "" || seen.has(command)) continue;
    seen.add(command);
    plan.push({ command, required: false });
  }
  return plan;
}

/**
 * Runs the test gate: contract check → preflight → test-runner agent →
 * allowlisted execution of the contract∪advisory union. The verification
 * contract must be nonempty; the gate fails closed when it is empty (e.g.
 * after an incomplete restart hydration). A test runner that raises a
 * material question also fails closed: no commands run, and the questions
 * are returned in the result so the engine can ask the user. A blocked
 * status remains a gate failure. Returns the evidence-based result;
 * ownership defaults to "both".
 */
export async function runTestGate(input: {
  stagingDir: string;
  requirements: string;
  verificationContract: string[];
  developerDiff: string;
  testsDiff: string;
  deps: TestGateDeps;
  /** Optional: archives each executed command's actual output as evidence. */
  store?: ArtifactStore;
  /** Optional callback alternative to `store`; returns the recorded ref. */
  archiveOutput?: OutputArchiver;
}): Promise<TestGateResult> {
  const contract = planCommandUnion(input.verificationContract, [])
    .map((step) => step.command);
  if (contract.length === 0) {
    const summary =
      "verification contract is empty: the planner must declare at least one runnable command before verification can execute";
    return {
      pass: false,
      preflightIssues: [],
      commands: [],
      ownership: [{ failure: summary, owner: "both" }],
      failureSummary: summary,
    };
  }

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

  // A material question is an unanswered decision the gate cannot make for
  // the user: fail closed before executing anything and surface the question
  // so the engine can park the run on it. Minor questions ride along without
  // blocking.
  const materialQuestions = completion.questions.filter((q) => q.severity === "material");
  if (materialQuestions.length > 0) {
    const failure = `test runner asked a material question that requires a user decision: ${materialQuestions
      .map((q) => q.question)
      .join("; ")}`;
    return {
      pass: false,
      preflightIssues,
      commands: [],
      ownership: [{ failure, owner: "both" }],
      failureSummary: failure,
      questions: completion.questions,
    };
  }

  const plan = planCommandUnion(input.verificationContract, completion.commands);
  const commands: CommandResult[] = [];
  const failures: string[] = [];
  let pass = completion.status === "complete";
  if (completion.status !== "complete") {
    failures.push(`test runner reported blocked: ${completion.summary}`);
  }
  let diagnosticBudget = FAILURE_DIAGNOSTIC_BUDGET;
  for (const step of plan) {
    if (!isAllowlistedCommand(step.command)) {
      commands.push({
        command: step.command,
        exitCode: -1,
        outputRef: "rejected: command not on allowlist",
      });
      failures.push(
        `rejected non-allowlisted ${step.required ? "required " : ""}command: ${step.command}`,
      );
      pass = false;
      continue;
    }
    const executed = await executeGateCommand({
      stagingDir: input.stagingDir,
      command: step.command,
      exec: input.deps.exec,
      store: input.store,
      archiveOutput: input.archiveOutput,
      source: "test-gate",
      evidenceNamePrefix: "test-gate-output",
    });
    commands.push(executed.result);
    if (executed.failed) {
      const diagnostic = boundedDiagnostic(
        executed.output,
        Math.min(FAILURE_DIAGNOSTIC_CHARS, diagnosticBudget),
      );
      diagnosticBudget = Math.max(0, diagnosticBudget - diagnostic.length);
      failures.push(
        `${step.required ? "required contract command" : "command"} failed with exit ${executed.result.exitCode}: ${step.command}${diagnostic}`,
      );
      pass = false;
    }
  }

  const ownership: TestRunnerCompletion["ownership"] =
    completion.ownership.length > 0
      ? completion.ownership
      : [{ failure: failures.join("; ") || "test gate result", owner: "both" }];
  const failureSummary = pass
    ? "test gate passed"
    : failures.length > 0
      ? failures.join("; ")
      : "test gate failed";
  return {
    pass,
    preflightIssues,
    commands,
    ownership,
    failureSummary,
    ...(completion.questions.length > 0 ? { questions: completion.questions } : {}),
  };
}
