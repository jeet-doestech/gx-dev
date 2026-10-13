/**
 * gx-dev orchestration engine (PLAN §5–§9, §12).
 *
 * The engine — never an agent — owns the workflow state machine. Every
 * transition is validated by the domain and persisted (via persistTransition)
 * BEFORE the next action begins. The engine is UI-agnostic: it receives an
 * optional EngineUI callback interface and never imports pi TUI APIs.
 *
 * REVIEW hardening implemented here:
 * - Mandatory explicit requirements/plan approval (approve / reject / edit)
 *   even when an agent asks no material question. The WAITING_FOR_USER state
 *   is persisted BEFORE any question UI is shown; blank/Esc answers leave the
 *   run waiting; resume() never advances an unanswered question.
 * - User answers persist (state.execution) and flow into downstream prompts.
 * - All material questions are consumed (not just the first) and worker-role
 *   blocked statuses route to BLOCKED for every role.
 * - A durable execution context rides on RunState.execution and is hydrated
 *   on restart: plan tasks/contract, story, decisions, replan/failure
 *   history, doc updates, commit message/hash, per-owner feedback, answers.
 * - Same-instance resume resets abort/pause only after in-flight work
 *   stopped; drive() is single-flight; cancellation awaits in-flight work
 *   before cleanup; uncaught exceptions become durable BLOCKED states.
 * - Worktree reopen passes the run's original base SHA to GitCoordinator.
 * - Evidence diffs are actual Git diffs (base→worker, base→staging) captured
 *   after integrate() checkpoints the code — untracked files included; the
 *   synthetic diff fallback is gone and dependencies carry Git tree ids.
 * - The documentation phase is enforced docs-only by comparing git status
 *   before/after; source edits block before the checkpoint commit.
 * - git.autoCommit=false requires explicit user confirmation before apply.
 * - agents.maxConcurrency=1 runs workers strictly sequentially.
 * - Successful runs clean their own worktrees; failed runs honor the
 *   retention policy; cancellation releases memory reservations.
 * - Lifecycle locking (REVIEW §1): start/resume/answer hold an optional
 *   cross-process execution lease (RunStore.acquireLease) for the whole
 *   drive-until-checkpoint; competing engines are refused while it is held.
 *   A dead owner (crashed process) is reclaimed; a new start is also refused
 *   while ANY persisted run is unfinished (active-run discovery under the
 *   lease). pause/cancel cooperate reentrantly with this engine's own drive
 *   and take the lease only when this engine does not already own it; a
 *   concurrent start rejects, and a concurrent resume serializes behind the
 *   active operation (no duplicate drive, no lease handover gap).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GxConfig } from "../config.ts";
import type { ArtifactStore, EvidenceRecord } from "../domain/artifacts.ts";
import { hashContent } from "../domain/artifacts.ts";
import type { EventStore } from "../domain/events.ts";
import type { LeaseRelease } from "../domain/lease.ts";
import type {
  AgentRunResult,
  AgentRunner,
  AgentWorkContext,
  GitCoordinator,
  MemoryCoordinator,
  MemoryPage,
  MemoryProposal,
  RunStore,
  WorktreeHandles,
} from "../domain/interfaces.ts";
import type {
  AgentQuestion,
  AgentRole,
  PlannerTask,
} from "../domain/schemas.ts";
import type {
  FailureCounters,
  PendingQuestion,
  RunCheckpoint,
  RunExecution,
  RunExecutionAnswer,
  RunExecutionApprovalAsk,
  RunExecutionDecision,
  RunState,
  TransitionInput,
} from "../domain/state.ts";
import {
  TERMINAL_STATES,
  canTransition,
  createRunState,
  initialExecution,
  isPipeline,
  newQuestionInstanceId,
  newRunId,
} from "../domain/state.ts";
import type { CommandExecutor } from "../gates/test-gate.ts";
import {
  COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  isAllowlistedCommand,
  runTestGate,
} from "../gates/test-gate.ts";
import { runReviewGate } from "../gates/review-gate.ts";
import { runFinalGate } from "../gates/final-gate.ts";
import type { GateOwner } from "./routing.ts";
import { classifyQuestion, routeGateFailure } from "./routing.ts";
import {
  recoverRun,
  resumableFrom,
  scanForAppliedCommit,
  verifyCommitReceipt,
  waitingOnUser,
  type AppliedCommitCandidate,
} from "./recovery.ts";
import type { FailureAttempt, FailureGate } from "./escalation.ts";
import {
  nextCounters,
  renderFailureHistory,
  shouldReplan,
} from "./escalation.ts";
import { persistTransition } from "./transitions.ts";

/** Optional callback surface so the engine never depends on any TUI. */
export interface EngineUI {
  askUser(q: PendingQuestion): Promise<string>;
  notify(message: string, data?: Record<string, unknown>): void;
}

export interface EngineDeps {
  runner: AgentRunner;
  git: GitCoordinator;
  memory: MemoryCoordinator;
  runStore: RunStore;
  artifacts: ArtifactStore;
  events: EventStore;
  config: GxConfig;
  ui?: EngineUI;
  /**
   * Optional command-executor injection (deterministic engine tests). When
   * absent the engine builds the allowlisted process executor bound to its
   * own abort signal.
   */
  executor?: CommandExecutor;
}

const execFileP = promisify(execFile);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function truncateOutput(output: string): { output: string; truncated: boolean } {
  if (output.length > MAX_OUTPUT_BYTES) {
    return { output: output.slice(0, MAX_OUTPUT_BYTES), truncated: true };
  }
  return { output, truncated: false };
}

// ---------------------------------------------------------------------------
// Command execution: structured tokenizing + abort awareness (REVIEW P2)
// ---------------------------------------------------------------------------

/**
 * Splits a command string into argv the way a POSIX shell would tokenize —
 * whitespace splits, single/double quotes, backslash escapes — WITHOUT any
 * shell evaluation. The tokens are passed to execFile, so metacharacters
 * like `;`, `&&`, or backticks are ordinary argument text, never interpreted.
 * Throws on an unterminated quote (the caller refuses the command).
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (quote === null && ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (quote !== null && ch === quote) {
      quote = null;
      continue;
    }
    if (quote === null && /\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (escaped) {
    current += "\\";
    hasToken = true;
  }
  if (quote !== null) throw new Error("unterminated quote");
  if (hasToken) tokens.push(current);
  return tokens;
}

export interface ProcessExecutorOptions {
  /**
   * Accessor for the engine's current abort signal: checked before every
   * spawn and wired into the child so a cancellation kills running commands.
   */
  signal?: () => AbortSignal | undefined;
}

/**
 * The engine-owned, allowlisted command executor: spawns via execFile with
 * shell-lexer tokenization (quotes honored, never a shell), cwd = staging,
 * environment inherited. Defense in depth: it independently refuses
 * non-allowlisted commands. Abort-aware: an aborted signal refuses new
 * commands and terminates running ones.
 */
export function createProcessExecutor(
  opts?: ProcessExecutorOptions,
): CommandExecutor {
  return {
    async execute(cwd, command, timeoutMs) {
      const signal = opts?.signal?.();
      if (signal?.aborted) {
        return { exitCode: 130, output: "aborted by caller before spawn", truncated: false };
      }
      if (!isAllowlistedCommand(command)) {
        return {
          exitCode: 126,
          output: `rejected: command not on allowlist: ${command}`,
          truncated: false,
        };
      }
      let tokens: string[];
      try {
        tokens = tokenizeCommand(command);
      } catch (e) {
        return {
          exitCode: 126,
          output: `rejected: malformed command: ${(e as Error).message}`,
          truncated: false,
        };
      }
      const file = tokens[0];
      if (!file) {
        return { exitCode: 127, output: "empty command", truncated: false };
      }
      const args = tokens.slice(1);
      try {
        const { stdout, stderr } = await execFileP(file, args, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env },
          ...(signal !== undefined ? { signal } : {}),
        });
        const t = truncateOutput(stdout + stderr);
        return { exitCode: 0, output: t.output, truncated: t.truncated };
      } catch (err) {
        if (signal?.aborted) {
          return { exitCode: 130, output: "aborted by caller", truncated: false };
        }
        const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
        const exitCode = typeof e.code === "number" ? e.code : 1;
        const raw =
          (typeof e.stdout === "string" ? e.stdout : "") +
          (typeof e.stderr === "string" ? e.stderr : "");
        const t = truncateOutput(raw);
        return { exitCode, output: t.output, truncated: t.truncated };
      }
    },
  };
}

/**
 * Basenames excluded from read-only snapshots: gx-dev's own runtime state,
 * environment/credential files, build output, and caches. Read-only agents
 * receive a sanitized tree — raw prior-run records and secrets never leak
 * into an agent context (curated memory reaches them via the prompt only).
 */
const SNAPSHOT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".gx-dev",
  ".pi",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".npm",
  ".next",
  ".turbo",
  ".parcel-cache",
  ".venv",
  "venv",
  ".pytest_cache",
  "__pycache__",
]);

/** True when a file or directory must NOT be copied into a snapshot. */
export function snapshotExcluded(base: string): boolean {
  if (SNAPSHOT_EXCLUDED_DIRS.has(base)) return true;
  if (base.startsWith(".env")) return true; // .env, .env.local, .env.production…
  if (/^credentials?(?:\.[^/]*)?$/i.test(base)) return true; // credentials, credential.json…
  if (/\.pem$|\.key$|\.p12$|\.pfx$/i.test(base)) return true; // key material
  if (/^id_rsa|^id_ed25519|^id_ecdsa|^\.netrc$|^\.npmrc$|^\.git-credentials$/i.test(base)) {
    return true;
  }
  return false;
}

/**
 * Copies a filtered tree for advisory agents, avoiding accidental relative
 * writes to the working repository. This is not a sandbox: absolute paths,
 * symlinks and subprocesses still have host-user permissions.
 * `.git`, `.gx-dev` (prior-run records), secrets, build output, and caches
 * are excluded; the sanitized remainder is preserved.
 */
async function snapshotDir(source: string): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), "gx-dev-readonly-"));
  const filter = (src: string): boolean => {
    const base = src.split(/[\\/]/).pop() ?? "";
    return !snapshotExcluded(base);
  };
  await cp(source, dest, { recursive: true, filter });
  return dest;
}

function conflictOwner(file: string): "developer" | "testWriter" | "both" {
  const testish =
    /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file);
  const devish = /(?:^|\/)(?:src|lib|app)(?:\/|$)|\.[cm]?[jt]sx?$/i.test(file);
  if (testish && devish) return "both";
  if (testish) return "testWriter";
  if (devish) return "developer";
  return "both";
}

function buildCommitMessage(request: string, runId: string, summary: string): string {
  const title = (request.trim().split("\n")[0] ?? request).slice(0, 72);
  return [
    title,
    "",
    summary.trim(),
    "",
    `Produced by gx-dev run ${runId}.`,
    `Evidence: .gx-dev/runs/${runId}/`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Approval-decision parsing (explicit user authority)
// ---------------------------------------------------------------------------

export type ApprovalDecision = "approved" | "rejected" | "amended";

/** True for an explicit yes-class answer (approval / commit confirmation). */
export function isAffirmative(text: string): boolean {
  return /^(?:approve|approved|approval|yes|y|ok|okay|apply|confirm|confirmed|lgtm)\.?$/i.test(
    text.trim(),
  );
}

/**
 * Parses an approval-checkpoint answer into an explicit decision. ONLY a
 * bare affirmative command word ("approve" and equivalent single-token
 * confirmations) approves — arbitrary free text NEVER counts as approval.
 * "reject <reason>" (or a bare no) rejects with feedback; any other
 * non-blank text is a user amendment/edit whose text is appended to the
 * artifact, after which the amended revision is asked for explicit approval
 * again (an edit never auto-approves). Blank answers never reach this
 * parser: they keep the run waiting.
 */
export function parseApprovalDecision(text: string): {
  decision: ApprovalDecision;
  feedback: string | null;
} {
  const t = text.trim();
  if (isAffirmative(t)) return { decision: "approved", feedback: null };
  if (/^(?:no|n)\.?$/i.test(t)) return { decision: "rejected", feedback: null };
  const rejectMatch = /^(?:reject(?:ed)?|rejection)\.?(?:\s*[:-]\s*|\s+)([\s\S]+)$/i.exec(t);
  if (rejectMatch) {
    const feedback = (rejectMatch[1] ?? "").trim();
    return { decision: "rejected", feedback: feedback === "" ? null : feedback };
  }
  if (/^(?:reject(?:ed)?|rejection)\.?$/i.test(t)) {
    return { decision: "rejected", feedback: null };
  }
  return { decision: "amended", feedback: t };
}

const APPROVAL_QUESTIONS: Readonly<Record<"requirements" | "plan", string>> = {
  requirements: "Approve the requirements draft?",
  plan: "Approve the plan?",
};

/** The commit confirmation asked when git.autoCommit is false. */
export const COMMIT_CONFIRM_QUESTION =
  "Apply the verified gx-dev result to your working branch now? (git.autoCommit is false)";

function approvalQuestionFor(checkpoint: "requirements" | "plan"): string {
  return APPROVAL_QUESTIONS[checkpoint];
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function renderResearchReport(result: AgentRunResult): string {
  const c =
    result.completion && "sources" in result.completion ? result.completion : null;
  const lines: string[] = ["# Research", "", result.rawText, ""];
  if (c) {
    lines.push("## Sources", "");
    for (const s of c.sources) {
      lines.push(`- ${s.title} — ${s.url} (retrieved ${s.retrievedAt}, confidence: ${s.confidence})`);
    }
    lines.push("", "## Findings", "");
    for (const f of c.findings) lines.push(`- ${f}`);
    lines.push("", "## Requirement ambiguities", "");
    for (const a of c.requirementAmbiguities) lines.push(`- ${a}`);
  }
  return lines.join("\n");
}

function renderRequirementsDraft(result: AgentRunResult): string {
  const c = result.completion;
  const lines: string[] = [
    "# Requirements draft",
    "",
    c ? c.summary : result.rawText,
    "",
    "## Acceptance criteria",
    "",
    ...(c && "acceptanceCriteria" in c ? c.acceptanceCriteria.map((criterion) => `- ${criterion}`) : []),
    "",
  ];
  if (c && c.questions.length > 0) {
    lines.push("## Open questions", "");
    for (const q of c.questions) lines.push(`- (${q.severity}) ${q.question}`);
  }
  return lines.join("\n");
}

function renderPlanBody(result: AgentRunResult): string {
  const c =
    result.completion && "verificationContract" in result.completion
      ? result.completion
      : null;
  const lines: string[] = [c ? c.summary : result.rawText, ""];
  if (c) {
    lines.push("## Tasks", "");
    for (const t of c.tasks) {
      lines.push(`- [${t.id}] (${t.assignee}) ${t.title} — files: ${t.files.join(", ") || "n/a"}`);
    }
    lines.push("", "## Verification contract", "");
    for (const v of c.verificationContract) lines.push(`- ${v}`);
    lines.push("", "## Rollback plan", "", c.rollbackPlan);
  }
  return lines.join("\n");
}

function renderTestPlan(tasks: PlannerTask[]): string {
  const testTasks = tasks.filter((t) => t.assignee === "testWriter");
  const lines: string[] = [
    "# Test plan",
    "",
    "Independent behavior tests authored by the test-writer agent.",
    "",
  ];
  if (testTasks.length === 0) {
    lines.push("- (no explicit test tasks; cover the requirements' observable behavior)");
  }
  for (const t of testTasks) {
    lines.push(`- [${t.id}] ${t.title} — files: ${t.files.join(", ") || "n/a"}`);
  }
  return lines.join("\n");
}

function renderImplementationReport(result: AgentRunResult): string {
  const c =
    result.completion && "changedFiles" in result.completion ? result.completion : null;
  const lines: string[] = ["# Implementation report", ""];
  if (c) {
    lines.push(c.summary, "", "## Changed files", "");
    for (const f of c.changedFiles) lines.push(`- ${f}`);
    lines.push("", "## Deviations", "");
    if (c.deviations.length === 0) lines.push("- none");
    for (const d of c.deviations) lines.push(`- ${d}`);
    lines.push("", "## Known limitations", "");
    if (c.knownLimitations.length === 0) lines.push("- none");
    for (const l of c.knownLimitations) lines.push(`- ${l}`);
  } else {
    lines.push(result.rawText);
  }
  return lines.join("\n");
}

function renderTestsReport(result: AgentRunResult): string {
  const c =
    result.completion && "testInventory" in result.completion ? result.completion : null;
  const lines: string[] = ["# Tests report", ""];
  if (c) {
    lines.push(c.summary, "", "## Test inventory", "");
    for (const t of c.testInventory) lines.push(`- ${t.path} — covers: ${t.covers}`);
    lines.push("", "## Coverage gaps", "");
    if (c.coverageGaps.length === 0) lines.push("- none recorded");
    for (const g of c.coverageGaps) lines.push(`- ${g}`);
  } else {
    lines.push(result.rawText);
  }
  return lines.join("\n");
}

function renderResult(
  state: RunState,
  commit: { commitHash: string; strategy: string; rollbackCommand: string },
  evidence: EvidenceRecord[],
): string {
  const lines: string[] = [
    "# gx-dev run result",
    "",
    `- run: ${state.runId}`,
    `- request: ${state.request}`,
    `- commit: ${commit.commitHash}`,
    `- strategy: ${commit.strategy}`,
    `- rollback: ${commit.rollbackCommand}`,
    "",
    "## Evidence",
    "",
  ];
  for (const e of evidence) {
    lines.push(`- ${e.kind}/${e.name} (${e.hash.slice(0, 12)}) by ${e.source}`);
  }
  return lines.join("\n");
}

function researchPrompt(
  request: string,
  story: string | null,
  brief: string | null,
  revisionFeedback: string | null,
  memoryContext: string | null,
): string {
  return [
    "You are the researcher. Inspect the repository and produce ONE researcher JSON completion (single ```json block). Identify languages, frameworks, conventions, risks, and requirement ambiguities. Include a nonempty acceptanceCriteria array of observable request outcomes. Ask material questions explicitly with severity \"material\".",
    `User request:\n\n${request}`,
    story ? `Story document:\n\n${story}` : null,
    brief ? `Known repository brief:\n\n${brief}` : null,
    memoryContext ? `Project memory (index-first retrieval; reuse reviewed knowledge):\n\n${memoryContext}` : null,
    revisionFeedback
      ? `The user REJECTED the previous requirements draft. Address this feedback when re-drafting:\n\n${revisionFeedback}`
      : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}

function plannerPrompt(
  request: string,
  requirements: string,
  research: string,
  failureHistory: string | null,
  revisionFeedback: string | null,
  answersBlock: string | null,
): string {
  return [
    "You are the planner. Produce ONE planner JSON completion: tasks assigned to developer or testWriter, a verificationContract of runnable commands, and a rollbackPlan.",
    `User request:\n\n${request}`,
    `Approved requirements:\n\n${requirements}`,
    `Research:\n\n${research}`,
    failureHistory
      ? `The previous plan failed repeatedly. Full failure history follows; reconsider the whole approach.\n\n${failureHistory}`
      : null,
    revisionFeedback
      ? `The user REJECTED the previous plan. Address this feedback when re-planning:\n\n${revisionFeedback}`
      : null,
    answersBlock ? `User decisions and answers you must honor:\n\n${answersBlock}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}

function developerPrompt(
  request: string,
  requirements: string,
  tasks: PlannerTask[],
  feedback: string | undefined,
  answersBlock: string | null,
): string {
  const devTasks = tasks.filter((t) => t.assignee === "developer");
  const lines = devTasks.map((t) => `- [${t.id}] ${t.title} (files: ${t.files.join(", ") || "n/a"})`);
  return [
    "You are the developer. Work ONLY inside your assigned worktree. Implement the tasks and return ONE developer JSON completion with changedFiles. Document deviations from the plan.",
    `User request:\n\n${request}`,
    `Approved requirements:\n\n${requirements}`,
    lines.length > 0 ? `Your tasks:\n${lines.join("\n")}` : "Implement the requested feature.",
    feedback ? `A gate returned findings you must address:\n\n${feedback}` : null,
    answersBlock ? `User decisions and answers you must honor:\n\n${answersBlock}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}

function testWriterPrompt(
  request: string,
  requirements: string,
  tasks: PlannerTask[],
  feedback: string | undefined,
  answersBlock: string | null,
): string {
  const testTasks = tasks.filter((t) => t.assignee === "testWriter");
  const lines = testTasks.map((t) => `- [${t.id}] ${t.title} (files: ${t.files.join(", ") || "n/a"})`);
  return [
    "You are the test writer. Work ONLY inside your assigned worktree. Independently implement the planned tests from the requirements and public contracts; do not modify production code. Return ONE testWriter JSON completion with testInventory.",
    `User request:\n\n${request}`,
    `Approved requirements:\n\n${requirements}`,
    lines.length > 0
      ? `Your tasks:\n${lines.join("\n")}`
      : "Write behavior tests covering the requirements.",
    feedback ? `A gate returned findings you must address:\n\n${feedback}` : null,
    answersBlock ? `User decisions and answers you must honor:\n\n${answersBlock}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}

function documentationPrompt(updates: string[]): string {
  return [
    "You are the reviewer in documentation mode. Apply ONLY the following documentation updates by editing documentation files (README.md, docs/) in your working directory. Do not touch implementation or tests.",
    "Updates to apply:",
    ...(updates.length > 0 ? updates.map((u) => `- ${u}`) : ["- Refresh affected documentation for the delivered feature."]),
    "Return ONE reviewer JSON completion; set documentationUpdates to the documentation files you touched.",
  ].join("\n");
}

function committerPrompt(request: string, summary: string): string {
  return [
    "You are the committer. Verify the staging worktree contains only intended changes and choose the commit message.",
    `User request:\n\n${request}`,
    `Run summary:\n\n${summary}`,
    "Return ONE committer JSON completion; put the desired commit message in \"summary\" and report the integration strategy.",
  ].join("\n\n");
}

function memoryProposalReviewPrompt(proposals: MemoryProposal[]): string {
  return [
    "You are the adversarial reviewer for project-memory proposals. Decide whether each proposal is accurate, evidence-linked, secrets-free, and safe to promote into long-term memory. Return ONE reviewer JSON completion with findings (severity blocking|major|minor|info, each with remediation) and documentationUpdates: [].",
    `Proposals:\n\n${JSON.stringify(proposals, null, 2)}`,
  ].join("\n\n");
}

/** Deterministic workflow engine. See PLAN §5 for the state machine. */
export class Engine {
  private readonly repoPath: string;
  private readonly deps: EngineDeps;
  private state: RunState | null = null;
  private handles: WorktreeHandles | null = null;
  private aborter = new AbortController();
  private cancelRequested = false;
  private pauseRequested = false;
  /** Durable execution context (mirrors RunState.execution). */
  private exec: RunExecution = initialExecution();
  private evidenceSeq = 0;
  /** Single-flight guard: only one drive loop may run at a time. */
  private driving = false;
  /**
   * True while a start/resume lifecycle operation is in flight. A
   * concurrent start is rejected; a concurrent resume serializes behind it
   * (waitForIdle) — either way, no duplicate drive is ever created.
   */
  private lifecycleBusy = false;
  /**
   * Cross-process execution lease currently held on behalf of this engine
   * (null when not held, or when the store has no lease support). Control
   * operations issued while a drive is in flight cooperate reentrantly
   * instead of acquiring again.
   */
  private leaseRelease: LeaseRelease | null = null;
  /** In-flight agent/command work; awaited before cleanup and control resets. */
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly processExecutor: CommandExecutor;

  constructor(repoPath: string, deps: EngineDeps) {
    this.repoPath = repoPath;
    this.deps = deps;
    this.processExecutor = createProcessExecutor({ signal: () => this.aborter.signal });
  }

  status(): RunState | null {
    return this.state;
  }

  /**
   * Acquires the cross-process execution lease for a lifecycle operation.
   *
   * Reentrant by design: while THIS engine already holds the lease (its own
   * drive is in flight), answer/pause/cancel must cooperate with that drive
   * — re-acquiring would deadlock behind the very drive they need to stop.
   * Stores without lease support degrade gracefully to no locking
   * (single-process use). The returned thunk releases exactly what this
   * call acquired and is idempotent.
   */
  private async acquireRunLease(): Promise<LeaseRelease> {
    if (this.leaseRelease !== null) return async () => {};
    const store = this.deps.runStore;
    const acquire = store.acquireLease;
    if (acquire === undefined) return async () => {};
    const release = await acquire.call(store);
    this.leaseRelease = release;
    return async () => {
      if (this.leaseRelease !== release) return; // ownership moved on
      this.leaseRelease = null;
      await release();
    };
  }

  /**
   * Active-run discovery (fail closed, called under the execution lease): a
   * NEW run must never start while any persisted run is unfinished — a
   * parked question, a paused/blocked run, or a run a crashed process left
   * mid-pipeline. The lease closes the TOCTOU window between the scan and
   * the create against competing engines.
   */
  /** A parked engine may be stale after another process recovered the run. */
  private async assertControlSnapshot(expected: RunState): Promise<void> {
    if (this.state !== expected) throw new Error("run changed while acquiring control; refresh with resume before retrying");
    if (this.driving) return; // controls cooperate with this engine's live drive
    const saved = await this.deps.runStore.load(expected.runId);
    if (!saved || JSON.stringify(saved) !== JSON.stringify(expected)) {
      throw new Error("persisted run changed in another process; resume the run before applying a control action");
    }
  }

  private async refuseUnfinishedPersistedRun(operation: string): Promise<void> {
    const runs = await this.deps.runStore.list();
    const unfinished = runs.filter((r) => !TERMINAL_STATES.includes(r.state));
    if (unfinished.length === 0) return;
    const first = unfinished[0]!;
    const more = unfinished.length > 1 ? ` (+${unfinished.length - 1} more unfinished)` : "";
    throw new Error(
      `${operation} refused: persisted run ${first.runId} is unfinished (state: ${first.state})${more}; ` +
        "answer, resume, or cancel it before starting a new run",
    );
  }

  /**
   * Waits until the engine is fully idle: no drive loop, no in-flight
   * start/resume lifecycle operation, and no held execution lease. Used by
   * resume() to serialize behind (or take over from) an operation that is
   * still winding down, so the lease is never dropped mid-handover.
   */
  private async waitForIdle(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (
      this.driving || this.lifecycleBusy || this.leaseRelease !== null
    ) {
      if (Date.now() >= deadline) throw new Error("engine still owns active work; refusing concurrent resume");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async start(request: string, storyPath?: string): Promise<RunState> {
    if (this.state && !TERMINAL_STATES.includes(this.state.state)) {
      throw new Error("a run is already active; cancel or finish it before starting a new one");
    }
    // Same-instance start/start and start/resume overlap is REJECTED (a new
    // run is never created behind another operation's back). resume() is the
    // takeover path: it serializes behind an active operation instead.
    if (this.lifecycleBusy) {
      throw new Error("another start/resume is already in progress on this engine; wait for it to return");
    }
    // A control operation (answer/pause/cancel) holding the lease means the
    // engine is mid-control: starting now would race it — reject instead.
    if (this.leaseRelease !== null) {
      throw new Error("an engine control (answer/pause/cancel) still holds the execution lease; retry when it returns");
    }
    this.lifecycleBusy = true;
    let releaseLease: LeaseRelease;
    try {
      releaseLease = await this.acquireRunLease();
    } catch (e) {
      this.lifecycleBusy = false;
      throw e;
    }
    try {
      // Active-run discovery under the lease: a parked, paused, blocked, or
      // crashed run on disk blocks a brand-new run.
      await this.refuseUnfinishedPersistedRun("start");
      this.cancelRequested = false;
      this.pauseRequested = false;
      this.exec = initialExecution();
      this.evidenceSeq = 0;
      this.handles = null;
      this.aborter = new AbortController();
      if (storyPath) {
        try {
          this.exec.story = readFileSync(storyPath, "utf8");
        } catch {
          delete this.exec.story;
          this.ui?.notify(`gx-dev: could not read story file ${storyPath}; continuing with request only`);
        }
      }
      const runId = newRunId();
      const state = createRunState({ runId, request, repoPath: this.repoPath });
      this.state = state;
      await this.deps.runStore.save(state);
      this.deps.events.append("run_created", `run ${runId} created`, { runId });
      this.deps.artifacts.recordEvidence(
        "user-input",
        this.exec.story ? `${request}\n\n## Story\n\n${this.exec.story}` : request,
        "user",
        "request.md",
      );
      await this.drive();
      return this.state!;
    } finally {
      try {
        await releaseLease();
      } finally {
        this.lifecycleBusy = false;
      }
    }
  }

  /**
   * Answers the pending question; only valid while WAITING_FOR_USER. A blank
   * answer is recorded for audit but the run STAYS waiting — an unanswered or
   * dismissed question never advances the workflow.
   */
  async answer(text: string): Promise<RunState> {
    const state = this.state;
    if (!state) throw new Error("no active run");
    if (state.state !== "WAITING_FOR_USER" || !state.pendingQuestion) {
      throw new Error(`answer() is only valid while WAITING_FOR_USER (current state: ${state.state})`);
    }
    // Reentrant while this engine's own drive holds the lease (an ask UI is
    // pending): the answer cooperates with the active drive instead of
    // re-acquiring. A parked run acquires the lease so a competing engine
    // that is driving this repository cannot be mutated underneath.
    const releaseLease = await this.acquireRunLease();
    try {
      await this.assertControlSnapshot(state);
      await this.recordAnswer(state.pendingQuestion, text);
      if (text.trim() === "") {
        this.deps.events.append("user_action", "blank answer recorded; run stays waiting", {});
        return this.state!;
      }
      const target = state.resumeState;
      if (target && canTransition(this.state!.state, target)) {
        await this.transition({ to: target, reason: "user answered the pending question" });
        await this.drive();
      }
      return this.state!;
    } finally {
      await releaseLease();
    }
  }

  async pause(): Promise<RunState> {
    const state = this.state;
    if (!state) throw new Error("no active run");
    if (TERMINAL_STATES.includes(state.state)) return state;
    if (isPipeline(state.state)) {
      // Reentrant when THIS engine's drive holds the lease: pause must stop
      // that drive, never wait behind it. A parked pause (drive already
      // returned) takes the lease so a competing engine driving the same
      // repository refuses the mutation.
      const releaseLease = await this.acquireRunLease();
      try {
        await this.assertControlSnapshot(state);
        this.pauseRequested = true;
        this.aborter.abort();
        this.deps.events.append("user_action", "run paused by user", {});
        this.state = await persistTransition(this.persistence, { ...state, execution: this.snapshotExecution() }, {
          to: "PAUSED",
          reason: "user paused the run",
        });
        // Nothing may keep writing behind a paused run.
        await this.awaitInflight();
      } finally {
        await releaseLease();
      }
    }
    return this.state!;
  }

  async resume(runId?: string): Promise<RunState> {
    // Same-instance resume SERIALIZES behind an operation that is still
    // active or winding down (an in-flight start/resume, a drive, or a
    // control holding the lease): stop it, wait for full quiescence — lease
    // release included — and only then take over. This both preserves the
    // abort/quiesce takeover semantics and guarantees the lease is never
    // dropped between the previous operation's finally and this drive.
    if (this.driving || this.lifecycleBusy || this.leaseRelease !== null) {
      this.aborter.abort();
      await this.quiesce();
      await this.waitForIdle();
    }
    // Set synchronously after the idle wait: a second resume entering in the
    // same tick observes lifecycleBusy and serializes behind this one.
    this.lifecycleBusy = true;
    let releaseLease: LeaseRelease;
    try {
      releaseLease = await this.acquireRunLease();
    } catch (e) {
      this.lifecycleBusy = false;
      throw e;
    }
    try {
      const active =
        this.state !== null && !TERMINAL_STATES.includes(this.state.state) ? this.state : null;
      if (active !== null && runId !== undefined && active.runId !== runId) {
        throw new Error(
          `a run is already active (${active.runId}); cancel or finish it before resuming run ${runId}`,
        );
      }
      if (runId || !this.state) {
        const id = runId ?? (await this.deps.runStore.list())[0]?.runId;
        if (!id) throw new Error("no run found to resume");
        const recovered = await recoverRun(this.deps.runStore, id);
        if (!recovered) throw new Error(`run ${id} cannot be recovered`);
        // Stop anything this engine still owns, wait for it (and any winding-
        // down drive loop) to finish, and only then swap in the recovered
        // execution context and fresh controls.
        this.aborter.abort();
        await this.quiesce();
        this.state = recovered;
        this.handles = null;
        this.hydrateExecution(recovered.execution);
        this.pauseRequested = false;
        this.cancelRequested = false;
        this.aborter = new AbortController();
        this.deps.events.append("user_action", `resuming run ${id}`, {});
      } else if (active !== null) {
        // Same instance, active run: reset abort/pause ONLY after in-flight
        // work (and the winding-down drive loop) has stopped.
        this.aborter.abort();
        await this.quiesce();
        this.pauseRequested = false;
        this.cancelRequested = false;
        this.aborter = new AbortController();
        const saved = await recoverRun(this.deps.runStore, active.runId);
        if (!saved) throw new Error(`run ${active.runId} cannot be recovered`);
        if (JSON.stringify(saved) !== JSON.stringify(this.state)) {
          this.state = saved;
          this.handles = null;
          this.hydrateExecution(saved.execution);
        }
        this.deps.events.append("user_action", "resuming run on the same engine", {});
      } else {
        // Terminal in-memory state without an id: nothing to resume.
        return this.state;
      }
      const current = this.state!;
      if (!resumableFrom(current.state)) return current;
      // resume never means approval: an unanswered question keeps the run parked.
      if (waitingOnUser(current)) {
        this.deps.events.append(
          "user_action",
          "resume ignored: the pending question is unanswered",
          { question: current.pendingQuestion?.question ?? null },
        );
        this.ui?.notify("gx-dev: the pending question is unanswered — answer it before resuming");
        return current;
      }
      if (isPipeline(current.state)) {
        // Crashed mid-pipeline: pass through RECOVERING back to the resume target.
        this.state = await persistTransition(this.persistence, current, {
          to: "RECOVERING",
          reason: "recovering run before resume",
        });
        const target = this.state!.resumeState;
        if (target && canTransition("RECOVERING", target)) {
          this.state = await persistTransition(this.persistence, this.state!, {
            to: target,
            reason: "recovery complete; resuming",
          });
        }
      } else {
        const target = current.resumeState;
        if (target && canTransition(current.state, target)) {
          this.state = await persistTransition(this.persistence, current, {
            to: target,
            reason: "resuming from checkpoint",
          });
        } else {
          return this.state!;
        }
      }
      await this.drive();
      return this.state!;
    } finally {
      try {
        await releaseLease();
      } finally {
        this.lifecycleBusy = false;
      }
    }
  }

  async cancel(): Promise<RunState> {
    const state = this.state;
    if (!state) throw new Error("no active run");
    if (TERMINAL_STATES.includes(state.state)) return state;
    // Parked cancel acquires the lease ONLY if this engine does not already
    // own it: cancelling while this engine's drive is in flight must stop
    // that drive, not wait behind it (the drive's own lifecycle operation
    // releases the lease when it unwinds). A parked cancel takes the lease
    // so a competing engine driving this repository refuses the mutation.
    const releaseLease = await this.acquireRunLease();
    try {
      await this.assertControlSnapshot(state);
      this.cancelRequested = true;
      this.aborter.abort();
      this.deps.events.append("user_action", "run cancelled by user", {});
      this.state = await persistTransition(this.persistence, { ...state, execution: this.snapshotExecution() }, {
        to: "CANCELLED",
        reason: "user cancelled the run",
      });
      // Cancellation awaits in-flight work before any cleanup touches the tree.
      await this.awaitInflight();
      try {
        await this.deps.memory.release?.(state.runId);
      } catch {
        // release is optional and best-effort; cancellation must not fail on it
      }
      await this.cleanupWorktrees(!this.deps.config.git.retainFailedRuns);
      return this.state!;
    } finally {
      await releaseLease();
    }
  }

  // ------------------------------------------------------------------ core

  private get ui(): EngineUI | null {
    return this.deps.ui ?? null;
  }

  private get executor(): CommandExecutor {
    return this.deps.executor ?? this.processExecutor;
  }

  /**
   * Wraps a gate executor so every in-flight gate command is tracked: a
   * pause/cancel awaits running commands before cleanup (no cleanup race).
   */
  private trackedExecutor(executor: CommandExecutor): CommandExecutor {
    return {
      execute: (cwd: string, command: string, timeoutMs: number) =>
        this.tracked(executor.execute(cwd, command, timeoutMs)),
    };
  }

  /**
   * Registers a Git side effect (merge, apply, checkpoint, cleanup) as
   * tracked work so pauses/cancels quiesce it before touching the tree.
   */
  private gitSideEffect<T>(p: Promise<T>): Promise<T> {
    return this.tracked(p);
  }

  private get persistence(): { runStore: RunStore; events: EventStore } {
    return { runStore: this.deps.runStore, events: this.deps.events };
  }

  private bail(): boolean {
    return this.cancelRequested || this.pauseRequested;
  }

  private async transition(input: TransitionInput): Promise<void> {
    // A stop request wins over any in-flight phase transition.
    if (this.cancelRequested || this.pauseRequested) return;
    const from = this.state;
    if (!from || TERMINAL_STATES.includes(from.state)) return;
    // Every transition persists the latest durable execution context.
    this.state = await persistTransition(
      this.persistence,
      { ...from, execution: this.snapshotExecution() },
      input,
    );
    this.ui?.notify(`state: ${from.state} → ${input.to}`, {
      runId: this.state.runId,
      state: this.state.state,
      reason: input.reason,
    });
  }

  private async setCounters(counters: FailureCounters): Promise<void> {
    if (!this.state) return;
    this.state = { ...this.state, counters };
    await this.deps.runStore.save(this.state);
  }

  /** JSON-safe deep copy of the in-memory execution context (drops undefined). */
  private snapshotExecution(): RunExecution {
    return JSON.parse(JSON.stringify(this.exec)) as RunExecution;
  }

  private hydrateExecution(execution: RunExecution | undefined): void {
    this.exec =
      execution !== undefined
        ? (JSON.parse(JSON.stringify(execution)) as RunExecution)
        : initialExecution();
  }

  /** Persists the current execution context without a state transition. */
  private async persistExecution(): Promise<void> {
    if (!this.state) return;
    this.state = { ...this.state, execution: this.snapshotExecution() };
    await this.deps.runStore.save(this.state);
  }

  /** Registers a promise so cancellation can await it before cleanup. */
  private tracked<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.then(
      () => {
        this.inflight.delete(p);
      },
      () => {
        this.inflight.delete(p);
      },
    );
    return p;
  }

  private async awaitInflight(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /**
   * Waits until the engine is fully quiescent: any active drive loop has
   * unwound (it exits promptly after a stop request) and no tracked work is
   * in flight. Control resets and recovery only happen after this.
   */
  private async quiesce(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (this.driving) {
      if (Date.now() > deadline) throw new Error("run has not quiesced; refusing to replace its active execution context");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await this.awaitInflight();
  }

  private async ensureHandles(): Promise<WorktreeHandles> {
    if (!this.handles) {
      // Pass the run's original base SHA so a reopening manager anchors the
      // worktrees to the approved base instead of the current tip.
      const base = this.state!.base?.commit ?? undefined;
      this.handles = await this.gitSideEffect(
        this.deps.git.prepareWorktrees(this.repoPath, this.state!.runId, base),
      );
      this.deps.events.append("worktree_created", "worktrees prepared", {
        runId: this.handles.runId,
        branches: this.handles.branches,
      });
    }
    return this.handles;
  }

  private async cleanupWorktrees(force: boolean): Promise<void> {
    const handles = this.handles;
    if (!handles) return;
    this.handles = null;
    await this.gitSideEffect(this.deps.git.cleanup(handles, force ? { force: true } : undefined));
    this.deps.events.append("worktree_cleaned", "worktrees cleaned up", {
      runId: handles.runId,
      force,
    });
  }

  /**
   * Runs an agent with infrastructure retry (up to 3 retries with 200ms×2^n
   * backoff), agent events, and raw-output evidence on every attempt.
   */
  private async runAgent(
    role: AgentRole,
    task: string,
    work: AgentWorkContext,
  ): Promise<AgentRunResult> {
    const maxRetries = 3;
    let attempt = 0;
    for (;;) {
      this.deps.events.append("agent_started", `${role} started (attempt ${attempt + 1})`, {
        role,
        attempt: attempt + 1,
      });
      const result = await this.tracked(
        this.deps.runner.run(role, task, work, {
          timeoutMs: this.deps.config.agents.timeoutMinutes * 60_000,
          signal: this.aborter.signal,
        }),
      );
      this.evidenceSeq += 1;
      this.deps.artifacts.recordEvidence(
        "agent-output",
        result.rawText,
        role,
        `${role}-${this.evidenceSeq}.md`,
      );
      if (result.ok) {
        this.deps.events.append("agent_completed", `${role} completed`, {
          role,
          durationMs: result.durationMs,
          usage: result.usage ?? null,
        });
        return result;
      }
      this.deps.events.append(
        "agent_failed",
        `${role} failed: ${result.error ?? "unknown error"}`,
        { role, infrastructure: result.infrastructure, attempt: attempt + 1 },
      );
      if (!result.infrastructure || attempt >= maxRetries) return result;
      // A stop request is not an infrastructure signal: a cancelled or paused
      // run must never burn retries behind the abort (REVIEW: shutdown).
      if (this.aborter.signal.aborted || this.bail()) return result;
      attempt += 1;
      await sleep(200 * 2 ** (attempt - 1));
      if (this.aborter.signal.aborted || this.bail()) return result;
    }
  }

  /** Advisory roles run in a disposable snapshot (not an OS security boundary). */
  private async runReadonlyAgent(
    role: AgentRole,
    task: string,
    realCwd: string,
  ): Promise<AgentRunResult> {
    const snapshot = await snapshotDir(realCwd);
    try {
      return await this.runAgent(role, task, { cwd: snapshot, writableRoots: [] });
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
  }

  /** Runs one allowlisted command through the tracked executor. */
  private execCommand(cwd: string, command: string, timeoutMs = COMMAND_TIMEOUT_MS) {
    return this.tracked(this.executor.execute(cwd, command, timeoutMs));
  }

  /**
   * Agent transport success is not task success (REVIEW P1): a schema-valid
   * completion with status "blocked" is a failure for every role.
   */
  private agentFailed(result: AgentRunResult): boolean {
    if (!result.ok) return true;
    return result.completion !== null && result.completion.status === "blocked";
  }

  /** Routes an agent failure (or blocked status) to BLOCKED. */
  private async blockOnAgentFailure(role: AgentRole, result: AgentRunResult): Promise<void> {
    const completion = result.completion;
    const blockedStatus = result.ok && completion !== null && completion.status === "blocked";
    const detail = blockedStatus && completion !== null
      ? completion.summary
      : result.error ?? "unknown error";
    const reason = result.infrastructure
      ? `${role} infrastructure failure after retries: ${detail}`
      : blockedStatus
        ? `${role} reported blocked: ${detail}`
        : `${role} agent failure: ${detail}`;
    if (result.infrastructure) {
      await this.setCounters(nextCounters(this.state!.counters, "infrastructure", false));
    }
    this.deps.events.append("error", reason, {
      role,
      infrastructure: result.infrastructure,
      blockedStatus,
    });
    this.ui?.notify(`gx-dev: ${reason}`);
    await this.transition({ to: "BLOCKED", reason });
  }

  /** Records one attempt in failure-history.md and the durable context. */
  private recordFailureAttempt(attempt: FailureAttempt): void {
    this.exec.failureAttempts = [...(this.exec.failureAttempts ?? []), attempt];
    this.deps.artifacts.writeArtifact(
      "failure-history.md",
      renderFailureHistory(this.exec.failureAttempts),
    );
    this.deps.events.append(
      "escalation",
      `failure recorded at ${attempt.gate} gate (owner: ${attempt.owner})`,
      { ...attempt },
    );
  }

  // ---------------------------------------------------------- checkpoints

  /** Enqueues every material question for a checkpoint (idempotent). */
  private enqueueMaterialQuestions(
    checkpoint: RunCheckpoint,
    questions: readonly AgentQuestion[] | undefined,
  ): void {
    for (const q of questions ?? []) {
      if (classifyQuestion({ severity: q.severity, text: q.question }) !== "material") continue;
      const open = (this.exec.openQuestions ?? []).some(
        (oq) => oq.checkpoint === checkpoint && oq.question === q.question,
      );
      if (open) continue;
      (this.exec.openQuestions ??= []).push({
        id: `${checkpoint}-${(this.exec.openQuestions?.length ?? 0) + 1}`,
        checkpoint,
        question: q.question,
        context: q.context ?? [],
        answer: null,
        at: new Date().toISOString(),
      });
    }
  }

  /** Records an answer durably: pendingQuestion, evidence, events, execution. */
  private async recordAnswer(pq: PendingQuestion, text: string): Promise<void> {
    const answered: PendingQuestion = {
      ...pq,
      answers: [...pq.answers, { answer: text, at: new Date().toISOString() }],
    };
    if (this.state && this.state.pendingQuestion === pq) {
      this.state = { ...this.state, pendingQuestion: answered };
    }
    this.evidenceSeq += 1;
    this.deps.artifacts.recordEvidence(
      "user-input",
      `${pq.question}\n\nAnswer: ${text}`,
      "user",
      `answer-${this.evidenceSeq}.md`,
    );
    this.deps.events.append("question_answered", text, {
      question: pq.question,
      severity: pq.severity,
    });
    const answerEntry: RunExecutionAnswer = {
      checkpoint: pq.checkpoint ?? "requirements",
      question: pq.question,
      answer: text,
      kind: pq.kind ?? "material-question",
      at: new Date().toISOString(),
    };
    if (pq.instanceId !== undefined) answerEntry.instanceId = pq.instanceId;
    (this.exec.answers ??= []).push(answerEntry);
    await this.persistExecution();
  }

  /**
   * Asks one pending question. The WAITING_FOR_USER state (with the question)
   * is persisted BEFORE any UI is shown, so a crash mid-ask leaves a
   * resolvable waiting run. Without a UI the run simply stays parked. Blank
   * answers (dismiss/Esc) are recorded but keep the run waiting: the return
   * value is null and the caller must not proceed.
   */
  private async askPending(pq: PendingQuestion): Promise<string | null> {
    this.deps.events.append("question_asked", pq.question, {
      severity: pq.severity,
      kind: pq.kind ?? "material-question",
      checkpoint: pq.checkpoint ?? null,
    });
    this.ui?.notify(`gx-dev question: ${pq.question}`, { phase: pq.checkpoint ?? null, severity: pq.severity });
    if (this.state !== null && this.state.state === "WAITING_FOR_USER") {
      // Already parked on a question (e.g. the amendment re-ask inside one
      // drive, or a second material question at the same checkpoint): swap in
      // the new question and persist — a WAITING→WAITING self-transition is
      // illegal by design.
      this.state = { ...this.state, pendingQuestion: pq };
      await this.deps.runStore.save(this.state);
      this.deps.events.append("transition", `WAITING_FOR_USER → WAITING_FOR_USER (${pq.reason})`, {
        from: "WAITING_FOR_USER",
        to: "WAITING_FOR_USER",
        reason: pq.reason,
      });
    } else {
      await this.transition({ to: "WAITING_FOR_USER", pendingQuestion: pq, reason: pq.reason });
    }
    if (!this.ui) return null;
    let answer = "";
    try {
      answer = await this.ui.askUser(pq);
    } catch (e) {
      this.deps.events.append(
        "orchestrator_intervention",
        `question UI failed; run stays waiting: ${(e as Error).message}`,
        {},
      );
      return null;
    }
    if (this.bail()) return null;
    await this.recordAnswer(pq, answer);
    return answer.trim() === "" ? null : answer;
  }

  /** Latest non-blank answer recorded for a question instance, or null. */
  private latestAnswerForInstance(instanceId: string): RunExecutionAnswer | null {
    const all = this.exec.answers ?? [];
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const a = all[i]!;
      if (a.instanceId === instanceId && a.answer.trim() !== "") return a;
    }
    return null;
  }

  /** The most recent ask ledger entry for a checkpoint's decision question. */
  private approvalAskFor(
    checkpoint: RunCheckpoint,
    question: string,
  ): RunExecutionApprovalAsk | null {
    const asks = this.exec.approvalAsks ?? [];
    for (let i = asks.length - 1; i >= 0; i -= 1) {
      const a = asks[i]!;
      if (a.checkpoint === checkpoint && a.question === question) return a;
    }
    return null;
  }

  /** Recorded decision for a question instance, if any. */
  private decisionForInstance(instanceId: string): RunExecutionDecision | null {
    return (
      (this.exec.decisions ?? []).find((d) => d.instanceId === instanceId) ?? null
    );
  }

  /**
   * Asks a decision question (approval or confirmation) with a FRESH unique
   * instance id and persists the ask ledger entry BEFORE the question is
   * shown (crash-safe). Answers and decisions reference this instance — never
   * the answer text — so a repeated "approve" after a replan is a new
   * decision instead of a stale consumed approval.
   */
  private async askDecisionQuestion(
    pq: PendingQuestion,
  ): Promise<string | null> {
    (this.exec.approvalAsks ??= []).push({
      instanceId: pq.instanceId ?? newQuestionInstanceId(),
      checkpoint: pq.checkpoint ?? "requirements",
      question: pq.question,
      artifactHash: pq.artifactHash ?? "",
      at: new Date().toISOString(),
    });
    await this.persistExecution();
    return await this.askPending(pq);
  }

  /** Renders durable checkpoint answers for downstream prompts. */
  private answersBlock(checkpoints: readonly RunCheckpoint[]): string | null {
    const entries = (this.exec.answers ?? []).filter(
      (a) => checkpoints.includes(a.checkpoint) && a.answer.trim() !== "",
    );
    if (entries.length === 0) return null;
    const lines: string[] = ["## User decisions and answers", ""];
    for (const a of entries) {
      lines.push(`- [${a.checkpoint}] Q: ${a.question}`, `  A: ${a.answer}`);
    }
    return lines.join("\n");
  }

  /**
   * Resolves every open material question for a checkpoint, in order. Parks
   * the run (persisted) on the first unanswered question without a UI. A
   * headless answer() that landed while parked is picked up from the durable
   * answer log, so no question is asked twice or silently skipped.
   */
  private async resolveOpenQuestions(checkpoint: RunCheckpoint): Promise<"done" | "parked"> {
    for (;;) {
      const pending = (this.exec.openQuestions ?? []).find(
        (q) => q.checkpoint === checkpoint && (q.answer === null || q.answer.trim() === ""),
      );
      if (!pending) return "done";
      const recorded = (this.exec.answers ?? []).find(
        (a) =>
          a.checkpoint === checkpoint &&
          a.question === pending.question &&
          a.answer.trim() !== "",
      );
      if (recorded !== undefined) {
        pending.answer = recorded.answer;
        await this.persistExecution();
        continue;
      }
      const pq: PendingQuestion = {
        instanceId: newQuestionInstanceId(),
        reason: `material question during ${checkpoint} requires a user decision`,
        question: pending.question,
        context: pending.context,
        answers: [],
        severity: "material",
        kind: "material-question",
        checkpoint,
      };
      const answer = await this.askPending(pq);
      if (answer === null || this.bail()) return "parked";
      pending.answer = answer;
      await this.persistExecution();
    }
  }

  /**
   * Explicit approval checkpoint (REVIEW P0): requirements and plan ALWAYS
   * require an approve/reject/edit decision, even with no material questions.
   * First consumes the checkpoint's material questions, then obtains the
   * decision. "done" means the checkpoint transitioned onward (or back);
   * "parked" means the run is waiting for the user.
   *
   * Decisions bind to a unique question INSTANCE plus the artifact hash shown
   * at ask time (REVIEW P0): a repeated "approve" after a replan is a new
   * decision, an already-decided instance is replayed idempotently (crash
   * between decision and transition), and an approval against an artifact
   * that no longer matches the shown hash is rejected fail-closed.
   */
  private async resolveCheckpoint(
    checkpoint: "requirements" | "plan",
    artifact: string,
  ): Promise<"done" | "parked"> {
    const question = approvalQuestionFor(checkpoint);
    for (;;) {
      const open = await this.resolveOpenQuestions(checkpoint);
      if (open === "parked") return "parked";
      const ask = this.approvalAskFor(checkpoint, question);
      const recorded = ask !== null ? this.latestAnswerForInstance(ask.instanceId) : null;
      const decided = ask !== null ? this.decisionForInstance(ask.instanceId) : null;
      if (ask !== null && recorded !== null && decided !== null && decided.decision !== "amended" && decided.actedOn !== true) {
        // Crash recovery: a decision persisted but never acted on (crash
        // between the decision record and its transition) is honored without
        // re-asking. Decisions already acted on are consumed: their phase can
        // only be re-entered with a NEW artifact revision, which is asked
        // fresh below.
        const outcome = await this.applyCheckpointDecision(checkpoint, artifact, recorded.answer, ask);
        if (outcome === "amended") continue;
        return outcome;
      }
      if (ask === null || recorded === null || decided !== null) {
        // No ask yet, an unanswered ask, or a consumed ask (decided or
        // amended): ask a FRESH instance bound to the current artifact hash.
        const artifactHash = hashContent(this.deps.artifacts.readArtifact(artifact) ?? "");
        const pq: PendingQuestion = {
          instanceId: newQuestionInstanceId(),
          reason: `explicit ${checkpoint} approval is required before the run may proceed`,
          question,
          context: [
            `Artifact under decision: ${artifact} (review it under .gx-dev/runs/${this.state!.runId}/)`,
            `Artifact hash shown for this decision: ${artifactHash}`,
            "Reply 'approve' to approve exactly this revision, 'reject <reason>' to send it back, or 'edit <text>' to append an amendment (the amended revision is then asked for explicit approval).",
          ],
          choices: ["approve", "reject", "edit"],
          answers: [],
          severity: "material",
          kind: "approval",
          checkpoint,
          artifactHash,
        };
        const answer = await this.askDecisionQuestion(pq);
        if (answer === null || this.bail()) return "parked";
        const freshAsk = this.approvalAskFor(checkpoint, question);
        if (freshAsk === null) return "parked"; // unreachable: askDecisionQuestion persists it
        const outcome = await this.applyCheckpointDecision(checkpoint, artifact, answer, freshAsk);
        if (outcome === "amended") continue; // re-ask approval of the amended revision
        return outcome;
      }
      // Headless pickup: the ask's instance has an unconsumed recorded answer.
      const outcome = await this.applyCheckpointDecision(checkpoint, artifact, recorded.answer, ask);
      if (outcome === "amended") continue;
      return outcome;
    }
  }

  /**
   * Applies an explicit approval decision (idempotent via the instance
   * ledger). Returns "amended" when the answer was an edit: the amendment is
   * appended and the caller must re-ask for explicit approval of the amended
   * revision — an edit NEVER auto-approves.
   */
  private async applyCheckpointDecision(
    checkpoint: "requirements" | "plan",
    artifact: string,
    answer: string,
    ask: RunExecutionApprovalAsk,
  ): Promise<"done" | "parked" | "amended"> {
    if (answer.trim() === "") return "parked";
    const instanceId = ask.instanceId;
    let decision = this.decisionForInstance(instanceId);
    if (decision === null) {
      const parsed = parseApprovalDecision(answer);
      if (parsed.decision === "amended" && parsed.feedback !== null) {
        this.applyArtifactAmendment(artifact, parsed.feedback, instanceId);
      }
      const currentHash = hashContent(this.deps.artifacts.readArtifact(artifact) ?? "");
      // Approval binds to the revision SHOWN at ask time: if the artifact
      // changed since the question was displayed, an "approve" must never
      // pass — it is recorded as a rejection (fail closed).
      let effective = parsed.decision;
      let feedback = parsed.feedback;
      if (parsed.decision === "approved" && currentHash !== ask.artifactHash) {
        effective = "rejected";
        feedback =
          `artifact changed since the approval was requested (shown ${ask.artifactHash.slice(0, 12)}, now ${currentHash.slice(0, 12)}); refusing the approval`;
      }
      decision = {
        checkpoint,
        decision: effective,
        artifact,
        hash: currentHash,
        askHash: ask.artifactHash,
        feedback,
        instanceId,
        at: new Date().toISOString(),
      };
      (this.exec.decisions ??= []).push(decision);
      if (effective === "rejected") {
        const rejectionFeedback = feedback ?? "(no reason given)";
        if (checkpoint === "requirements") {
          this.exec.revisionFeedback = { ...this.exec.revisionFeedback, requirements: rejectionFeedback };
        } else {
          this.exec.revisionFeedback = { ...this.exec.revisionFeedback, plan: rejectionFeedback };
        }
        this.recordFailureAttempt({
          gate: checkpoint === "requirements" ? "requirements-approval" : "plan-approval",
          owner: "user",
          inputHash: ask.artifactHash,
          findings: [rejectionFeedback],
          action:
            checkpoint === "requirements"
              ? "requirements returned to research with user feedback"
              : "plan returned to replanning with user feedback",
        });
      }
      await this.persistExecution();
    }
    if (decision.decision === "rejected") {
      if (checkpoint === "requirements") {
        await this.transition({
          to: "RESEARCH",
          reason: "requirements rejected by user; revising with feedback",
        });
      } else {
        await this.transition({
          to: "REPLAN",
          reason: "plan rejected by user; replanning with feedback",
        });
      }
      await this.markDecisionActed(decision);
      return "done";
    }
    if (decision.decision === "amended") {
      return "amended";
    }
    const hash = hashContent(this.deps.artifacts.readArtifact(artifact) ?? "");
    const target = checkpoint === "requirements" ? "PLAN" : "PREPARE_WORKTREES";
    await this.transition({
      to: target,
      approval: { artifact, hash },
      reason: `${checkpoint} approved by user`,
    });
    await this.markDecisionActed(decision);
    return "done";
  }

  /** Marks a decision's transition as performed (replay guard), durably. */
  private async markDecisionActed(decision: RunExecutionDecision): Promise<void> {
    if (decision.actedOn === true) return;
    decision.actedOn = true;
    await this.persistExecution();
  }

  /**
   * Appends a durable user-amendment section to an artifact. Idempotent
   * across a crash between the amendment write and the decision persist: the
   * section carries the question instance id, and an already-present section
   * for the same instance is never appended twice.
   */
  private applyArtifactAmendment(artifact: string, amendment: string, instanceId: string): void {
    const current = this.deps.artifacts.readArtifact(artifact) ?? "";
    if (current.includes(`question ${instanceId})`)) return;
    const updated = `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}\n## User amendments (${new Date().toISOString()}; question ${instanceId})\n\n${amendment}\n`;
    this.deps.artifacts.writeArtifact(artifact, updated);
  }

  // ------------------------------------------------------------ git reads

  /**
   * Engine-internal git read: execFile (no shell), tracked for cancellation.
   * The gate allowlist constrains AGENT-proposed commands; the engine's own
   * evidence plumbing may use read-only git plumbing directly.
   */
  private async gitRead(dir: string, args: string[]): Promise<{ exitCode: number; output: string } | null> {
    const p = new Promise<{ exitCode: number; output: string }>((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd: dir,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          signal: this.aborter.signal,
        },
        (err, stdout, stderr) => {
          const code =
            err === null
              ? 0
              : typeof (err as { code?: unknown }).code === "number"
                ? (err as { code: number }).code
                : 1;
          resolve({ exitCode: code, output: `${stdout}${stderr}` });
        },
      );
    });
    try {
      return await this.tracked(p);
    } catch {
      return null;
    }
  }

  /** Actual committed diff base→HEAD in a worktree (null when git fails). */
  private async gitDiff(dir: string | null, base: string): Promise<string | null> {
    if (!dir) return null;
    const res = await this.gitRead(dir, ["diff", base, "HEAD"]);
    if (res === null || res.exitCode !== 0) return null;
    return res.output;
  }

  /** Authoritative Git commit id of a worktree (null when git fails). */
  private async gitRevParse(dir: string | null): Promise<string | null> {
    if (!dir) return null;
    const res = await this.gitRead(dir, ["rev-parse", "HEAD"]);
    if (res === null || res.exitCode !== 0) return null;
    const sha = res.output.trim().split("\n")[0] ?? "";
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  }

  /** Resolves a ref (branch name, sha) to a full commit id (null on failure). */
  private async gitResolve(dir: string, ref: string): Promise<string | null> {
    const res = await this.gitRead(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (res === null || res.exitCode !== 0) return null;
    const sha = res.output.trim().split("\n")[0] ?? "";
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  }

  /** Resolves a rev to its git tree id (null on failure). */
  private async gitTreeOf(dir: string | null, rev: string): Promise<string | null> {
    if (!dir) return null;
    const res = await this.gitRead(dir, ["rev-parse", rev]);
    if (res === null || res.exitCode !== 0) return null;
    const tree = res.output.trim().split("\n")[0] ?? "";
    return /^[0-9a-f]{40}$/i.test(tree) ? tree : null;
  }

  /** True/false ancestry answer; null when git fails (callers fail closed). */
  private async gitAncestor(
    dir: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean | null> {
    const res = await this.gitRead(dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
    if (res === null) return null;
    if (res.exitCode === 0) return true;
    // exit 1 = "not an ancestor"; anything else is a git failure.
    return res.exitCode === 1 ? false : null;
  }

  // --------------------------------------------------------------- memory

  /** Index-first retrieval for the researcher prompt (degrades to null). */
  private async memoryContext(query: string): Promise<string | null> {
    try {
      const hits: MemoryPage[] = await this.deps.memory.search(query, 3);
      if (hits.length === 0) return null;
      const lines: string[] = ["## Project memory (index-first retrieval)"];
      for (const page of hits) {
        const summary =
          page.body.split("\n").find((l) => l.trim() !== "" && !l.startsWith("#")) ?? "";
        lines.push(
          `- [[${page.name}]] (${page.frontmatter["verification"] ?? "unknown verification"}): ${summary.slice(0, 200)}`,
        );
      }
      return lines.join("\n");
    } catch (e) {
      this.deps.events.append(
        "orchestrator_intervention",
        `memory search unavailable: ${(e as Error).message}`,
        {},
      );
      return null;
    }
  }

  /** Existing wiki pages to link a memory proposal to (lint-safe). */
  private async memoryRelatedPages(query: string): Promise<string[]> {
    try {
      const hits = await this.deps.memory.search(query, 3);
      const feature = `features/${this.state!.runId}`;
      const names = hits.map((h) => h.name).filter((n) => n !== feature);
      if (names.length > 0) return names;
    } catch {
      // degrade to scaffolded core pages below
    }
    return ["testing", "conventions"];
  }

  /**
   * Reviewer gate over memory proposals (runReviewGate-style verdict): pass
   * requires a valid, "complete" reviewer completion with zero blocking or
   * major findings — never an automatic "verified".
   */
  private async reviewMemoryProposals(
    proposals: MemoryProposal[],
  ): Promise<{ approved: boolean; note: string }> {
    const result = await this.runReadonlyAgent(
      "reviewer",
      memoryProposalReviewPrompt(proposals),
      this.repoPath,
    );
    if (this.bail()) return { approved: false, note: "run stopping; memory promotion deferred" };
    const completion =
      result.completion && "documentationUpdates" in result.completion
        ? result.completion
        : null;
    if (!result.ok || completion === null || completion.status !== "complete") {
      return {
        approved: false,
        note: result.error ?? "memory reviewer failed or returned an invalid completion",
      };
    }
    const blocking = completion.findings.filter(
      (f) => f.severity === "blocking" || f.severity === "major",
    );
    if (blocking.length > 0) {
      return {
        approved: false,
        note: `memory reviewer blocked promotion: ${blocking.map((f) => f.remediation).join("; ")}`,
      };
    }
    return { approved: true, note: "memory proposals reviewed; no blocking findings" };
  }

  // -------------------------------------------------------------- helpers

  private storePlanArtifacts(result: AgentRunResult): void {
    const completion =
      result.completion && "verificationContract" in result.completion
        ? result.completion
        : null;
    this.exec.planTasks = completion ? [...completion.tasks] : [];
    this.exec.verificationContract = completion ? [...completion.verificationContract] : [];
    this.exec.planSummary = completion ? completion.summary : result.rawText.slice(0, 200);
    const epoch = this.exec.replanEpoch ?? 0;
    const header = epoch > 0 ? `# Plan (replan epoch ${epoch})` : "# Plan";
    const plan = [header, "", renderPlanBody(result)].join("\n");
    this.deps.artifacts.writeArtifact("plan.md", plan);
    this.deps.artifacts.writeArtifact("test-plan.md", renderTestPlan(this.exec.planTasks ?? []));
    this.deps.artifacts.writeArtifact(
      "verification.json",
      JSON.stringify(this.exec.verificationContract ?? [], null, 2),
    );
  }

  private planHashOrCompute(): string {
    return hashContent(this.deps.artifacts.readArtifact("plan.md") ?? "");
  }

  private buildRunSummary(): string {
    const state = this.state!;
    const parts = [`Request: ${state.request}`];
    if (this.exec.planSummary) parts.push(`Plan: ${this.exec.planSummary}`);
    parts.push("All gates passed (test gate, review gate, final verification).");
    return parts.join("\n");
  }

  // ---------------------------------------------------------------- phases

  /** Single-flight drive: concurrent callers coalesce onto the active loop. */
  private async drive(): Promise<RunState> {
    if (this.driving) return this.state!;
    this.driving = true;
    try {
      return await this.driveLoop();
    } finally {
      this.driving = false;
    }
  }

  private async driveLoop(): Promise<RunState> {
    for (;;) {
      const state = this.state!;
      if (this.bail()) return this.state ?? state;
      try {
        this.assertApprovalIntegrity(state);
        await this.stepState(state);
      } catch (e) {
        // Uncaught exceptions become durable BLOCKED states, never a
        // misleading active phase (REVIEW P1).
        const reason = `orchestration error in ${state.state}: ${(e as Error).message}`;
        this.deps.events.append("error", reason, {
          state: state.state,
          stack: (e as Error).stack ?? null,
        });
        this.ui?.notify(`gx-dev: ${reason}`);
        await this.transition({ to: "BLOCKED", reason });
        return this.state!;
      }
      if (this.state === null) return state;
      const after = this.state;
      if (after.state === "COMPLETE" && state.state !== "COMPLETE") {
        // Successful runs clean their own worktrees (REVIEW §4).
        try {
          await this.cleanupWorktrees(true);
        } catch (e) {
          this.deps.events.append(
            "orchestrator_intervention",
            `post-success worktree cleanup failed: ${(e as Error).message}`,
            {},
          );
        }
      } else if (
        after.state === "FAILED" &&
        state.state !== "FAILED" &&
        !this.deps.config.git.retainFailedRuns
      ) {
        try {
          await this.cleanupWorktrees(true);
        } catch (e) {
          this.deps.events.append(
            "orchestrator_intervention",
            `post-failure worktree cleanup failed: ${(e as Error).message}`,
            {},
          );
        }
      }
      if (this.state === state) return this.state; // no progress: never spin
    }
  }
  /** Recheck approved artifacts at execution boundaries, including after restart. */
  private assertApprovalIntegrity(state: RunState): void {
    const afterPlan = new Set([
      "PREPARE_WORKTREES", "DEVELOP", "WRITE_TESTS", "INTEGRATE", "TEST_GATE",
      "REVIEW_GATE", "DOCUMENTATION_UPDATE", "FINAL_VERIFICATION", "COMMIT",
    ]);
    const artifacts = afterPlan.has(state.state) ? ["requirements.md", "plan.md"]
      : ["PLAN", "PLAN_APPROVAL", "REPLAN"].includes(state.state) ? ["requirements.md"] : [];
    for (const name of artifacts) {
      const approved = state.approvals[name];
      const content = this.deps.artifacts.readArtifact(name);
      if (!approved || content === null || approved.hash !== hashContent(content)) {
        throw new Error(`${name} is missing or changed since approval; restore the approved artifact or cancel and start a new run`);
      }
    }
  }

  private async stepState(state: RunState): Promise<void> {
    switch (state.state) {
      case "INTAKE":
        await this.phaseIntake();
        break;
      case "RESEARCH":
        await this.phaseResearch();
        break;
      case "REQUIREMENTS_APPROVAL":
        await this.phaseRequirementsApproval();
        break;
      case "PLAN":
        await this.phasePlan();
        break;
      case "PLAN_APPROVAL":
        await this.phasePlanApproval();
        break;
      case "PREPARE_WORKTREES":
        await this.phaseWorktrees();
        break;
      case "DEVELOP":
        await this.phaseDevelop();
        break;
      case "WRITE_TESTS":
        await this.phaseWriteTests();
        break;
      case "INTEGRATE":
        await this.phaseIntegrate();
        break;
      case "TEST_GATE":
        await this.phaseTestGate();
        break;
      case "REVIEW_GATE":
        await this.phaseReviewGate();
        break;
      case "DOCUMENTATION_UPDATE":
        await this.phaseDocumentationUpdate();
        break;
      case "FINAL_VERIFICATION":
        await this.phaseFinalVerification();
        break;
      case "COMMIT":
        await this.phaseCommit();
        break;
      case "MEMORY_PROMOTION":
        await this.phaseMemoryPromotion();
        break;
      case "REPLAN":
        await this.phaseReplan();
        break;
      default:
        // Control/terminal states stop the drive loop; they are resolved
        // through answer()/resume()/cancel().
        return;
    }
  }

  private async phaseIntake(): Promise<void> {
    const base = await this.gitSideEffect(this.deps.git.recordBase(this.repoPath));
    if (this.bail()) return;
    if (base.refused) {
      this.deps.events.append("error", `run refused at intake: ${base.refused}`, {});
      this.ui?.notify(`gx-dev: ${base.refused}`);
      await this.transition({ to: "BLOCKED", reason: base.refused });
      return;
    }
    this.state = {
      ...this.state!,
      base: { branch: base.branch, commit: base.commit, dirty: base.dirty },
    };
    await this.deps.runStore.save(this.state);
    await this.transition({ to: "RESEARCH", reason: "base state recorded" });
  }

  private async phaseResearch(): Promise<void> {
    const brief = this.deps.artifacts.readArtifact("research.md");
    const memory = await this.memoryContext(this.state!.request);
    const revision = this.exec.revisionFeedback?.requirements ?? null;
    const prompt = researchPrompt(
      this.state!.request,
      this.exec.story ?? null,
      brief,
      revision,
      memory,
    );
    const result = await this.runReadonlyAgent("researcher", prompt, this.repoPath);
    if (this.bail()) return;
    if (this.agentFailed(result)) {
      await this.blockOnAgentFailure("researcher", result);
      return;
    }
    if (revision !== null) {
      const rf = { ...this.exec.revisionFeedback };
      delete rf.requirements;
      this.exec.revisionFeedback = rf;
    }
    const researchHash = this.deps.artifacts.writeArtifact(
      "research.md",
      renderResearchReport(result),
    );
    const requirementsHash = this.deps.artifacts.writeArtifact(
      "requirements.md",
      renderRequirementsDraft(result),
    );
    await this.transition({
      to: "REQUIREMENTS_APPROVAL",
      dependencies: { research: researchHash, requirements: requirementsHash },
      reason: "research complete",
    });
    this.enqueueMaterialQuestions("requirements", result.completion?.questions);
    await this.persistExecution();
    const outcome = await this.resolveCheckpoint("requirements", "requirements.md");
    if (outcome === "parked") return;
  }

  private async phaseRequirementsApproval(): Promise<void> {
    // Re-entry after an answer or restart: the checkpoint resolves only from
    // the durable recorded decision — never by implicit approval.
    const outcome = await this.resolveCheckpoint("requirements", "requirements.md");
    if (outcome === "parked") return;
  }

  private async phasePlan(): Promise<void> {
    let result: AgentRunResult | null = null;
    if (this.exec.planFromReplan) {
      this.exec.planFromReplan = false; // plan.md already produced by phaseReplan
      await this.persistExecution();
    } else {
      const prompt = plannerPrompt(
        this.state!.request,
        this.deps.artifacts.readArtifact("requirements.md") ?? "",
        this.deps.artifacts.readArtifact("research.md") ?? "",
        null,
        this.exec.revisionFeedback?.plan ?? null,
        this.answersBlock(["requirements"]),
      );
      result = await this.runReadonlyAgent("planner", prompt, this.repoPath);
      if (this.bail()) return;
      if (this.agentFailed(result)) {
        await this.blockOnAgentFailure("planner", result);
        return;
      }
      const rf = { ...this.exec.revisionFeedback };
      delete rf.plan;
      this.exec.revisionFeedback = rf;
      this.storePlanArtifacts(result);
    }
    const planHash = this.planHashOrCompute();
    await this.transition({
      to: "PLAN_APPROVAL",
      dependencies: { plan: planHash },
      reason: "plan drafted",
    });
    if (result !== null) {
      this.enqueueMaterialQuestions("plan", result.completion?.questions);
      await this.persistExecution();
    }
    const outcome = await this.resolveCheckpoint("plan", "plan.md");
    if (outcome === "parked") return;
  }

  private async phasePlanApproval(): Promise<void> {
    const outcome = await this.resolveCheckpoint("plan", "plan.md");
    if (outcome === "parked") return;
  }

  private async phaseWorktrees(): Promise<void> {
    await this.ensureHandles();
    await this.transition({ to: "DEVELOP", reason: "worktrees ready" });
  }

  private async phaseDevelop(): Promise<void> {
    if (!this.exec.developComplete) {
      const handles = await this.ensureHandles();
      const requirements = this.deps.artifacts.readArtifact("requirements.md") ?? "";
      const answers = this.answersBlock(["requirements", "plan", "develop"]);
      const maxConcurrency = Math.max(1, this.deps.config.agents.maxConcurrency);
      const developerTask = developerPrompt(
        this.state!.request,
        requirements,
        this.exec.planTasks ?? [],
        this.exec.reworkFeedback?.developer,
        answers,
      );
      const developerWork = {
        cwd: handles.developer ?? this.repoPath,
        writableRoots: handles.developer ? [handles.developer] : [],
      };
      const testWriterTask = testWriterPrompt(
        this.state!.request,
        requirements,
        this.exec.planTasks ?? [],
        this.exec.reworkFeedback?.testWriter,
        answers,
      );
      const testWriterWork = {
        cwd: handles.tests ?? this.repoPath,
        writableRoots: handles.tests ? [handles.tests] : [],
      };
      const developerRun = this.runAgent("developer", developerTask, developerWork);
      // Persist the transition before dispatching the second concurrent action.
      await this.transition({
        to: "WRITE_TESTS",
        reason:
          maxConcurrency === 1
            ? "developer work staged; test writer starting (maxConcurrency=1)"
            : "developer agent dispatched; test writer starting in parallel",
      });
      let testWriterRun: Promise<AgentRunResult> | null = null;
      if (maxConcurrency >= 2) {
        testWriterRun = this.runAgent("testWriter", testWriterTask, testWriterWork);
      }
      const devResult = await developerRun;
      if (this.bail()) return;
      const testResult =
        testWriterRun !== null
          ? await testWriterRun
          : await this.runAgent("testWriter", testWriterTask, testWriterWork);
      if (this.bail()) return;
      if (this.agentFailed(devResult)) {
        await this.blockOnAgentFailure("developer", devResult);
        return;
      }
      this.deps.artifacts.writeArtifact("implementation.md", renderImplementationReport(devResult));
      if (this.agentFailed(testResult)) {
        await this.blockOnAgentFailure("testWriter", testResult);
        return;
      }
      this.deps.artifacts.writeArtifact("tests.md", renderTestsReport(testResult));
      // Both workers consumed their feedback for this pass.
      this.exec.reworkFeedback = {};
      this.exec.developComplete = true;
      await this.persistExecution();
      this.enqueueMaterialQuestions(
        "develop",
        [
          ...(devResult.completion?.questions ?? []),
          ...(testResult.completion?.questions ?? []),
        ],
      );
      await this.persistExecution();
    }
    const questions = await this.resolveOpenQuestions("develop");
    if (questions === "parked") return;
    await this.transition({ to: "INTEGRATE", reason: "implementation and tests complete" });
  }

  private async phaseWriteTests(): Promise<void> {
    // Recovery path only. An incomplete developer must never be skipped: go
    // back through DEVELOP so the implementation is actually produced.
    if (!this.exec.developComplete || this.deps.artifacts.readArtifact("implementation.md") === null) {
      await this.transition({
        to: "DEVELOP",
        reason: "recovery: developer work incomplete; developing before tests",
      });
      return;
    }
    const handles = await this.ensureHandles();
    if (this.deps.artifacts.readArtifact("tests.md") === null) {
      const result = await this.runAgent(
        "testWriter",
        testWriterPrompt(
          this.state!.request,
          this.deps.artifacts.readArtifact("requirements.md") ?? "",
          this.exec.planTasks ?? [],
          this.exec.reworkFeedback?.testWriter,
          this.answersBlock(["requirements", "plan", "develop"]),
        ),
        { cwd: handles.tests ?? this.repoPath, writableRoots: handles.tests ? [handles.tests] : [] },
      );
      if (this.bail()) return;
      if (this.agentFailed(result)) {
        await this.blockOnAgentFailure("testWriter", result);
        return;
      }
      this.deps.artifacts.writeArtifact("tests.md", renderTestsReport(result));
      this.exec.developComplete = true;
      this.enqueueMaterialQuestions("develop", result.completion?.questions);
      await this.persistExecution();
    }
    const questions = await this.resolveOpenQuestions("develop");
    if (questions === "parked") return;
    await this.transition({ to: "INTEGRATE", reason: "tests ready" });
  }

  private async phaseIntegrate(): Promise<void> {
    const handles = await this.ensureHandles();
    for (;;) {
      if (this.bail()) return;
      const integration = await this.gitSideEffect(this.deps.git.integrate(handles));
      this.deps.events.append(
        "integration_result",
        integration.success
          ? "branches integrated cleanly"
          : `integration conflicts: ${integration.conflictedFiles.join(", ")}`,
        {
          success: integration.success,
          conflictedFiles: integration.conflictedFiles,
          autoResolved: integration.autoResolved,
        },
      );
      if (integration.success) {
        // Actual Git evidence only (REVIEW P0): integrate() checkpointed every
        // worker (untracked files included), so base→worker and base→staging
        // diffs are complete and authoritative. No synthetic fallback.
        const base = this.state!.base?.commit ?? null;
        if (base === null) {
          await this.transition({
            to: "BLOCKED",
            reason: "no base commit recorded at intake; cannot capture actual git diffs",
          });
          return;
        }
        const [developerDiff, testsDiff, combined] = await Promise.all([
          this.gitDiff(handles.developer, base),
          this.gitDiff(handles.tests, base),
          this.gitDiff(handles.staging, base),
        ]);
        const [developerTip, testTip, stagingTip] = await Promise.all([
          this.gitRevParse(handles.developer),
          this.gitRevParse(handles.tests),
          this.gitRevParse(handles.staging),
        ]);
        if (
          developerDiff === null || testsDiff === null || combined === null ||
          developerTip === null || testTip === null || stagingTip === null
        ) {
          await this.transition({
            to: "BLOCKED",
            reason: "actual git diffs/tree ids could not be captured; refusing to fabricate evidence",
          });
          return;
        }
        this.deps.artifacts.writeArtifact("developer.diff", developerDiff);
        this.deps.artifacts.writeArtifact("tests.diff", testsDiff);
        this.deps.artifacts.writeArtifact("combined.diff", combined);
        await this.transition({
          to: "TEST_GATE",
          reason: "branches integrated",
          dependencies: {
            developerRevision: developerTip,
            testWriterRevision: testTip,
            stagingRevision: stagingTip,
          },
        });
        return;
      }
      const next = nextCounters(this.state!.counters, "integration", false);
      await this.setCounters(next);
      const owners = routeGateFailure(
        integration.conflictedFiles.map((f) => ({ owner: conflictOwner(f) })),
      );
      this.recordFailureAttempt({
        gate: "integration",
        owner: owners.join("+") || "both",
        inputHash: hashContent(integration.conflictedFiles.join("\n")),
        findings: integration.conflictedFiles.map((f) => `semantic conflict in ${f}`),
        action: `rerouted to ${owners.join(" + ") || "both"}`,
      });
      await this.persistExecution();
      const esc = shouldReplan(
        next,
        this.deps.config.gates.maxConsecutiveFailures,
        this.deps.config.gates.maxTotalAttempts,
      );
      if (esc.fail) {
        await this.transition({
          to: "FAILED",
          reason: `total attempt ceiling reached (${next.totalAttempts} ≥ ${this.deps.config.gates.maxTotalAttempts})`,
        });
        return;
      }
      if (next.integrationConsecutiveFailures >= this.deps.config.gates.maxConsecutiveFailures) {
        await this.escalateToReplan("integration", true);
        return;
      }
      const feedback = `Semantic conflicts must be resolved in your own worktree: ${integration.conflictedFiles.join(", ")}`;
      const ok = await this.rerunForOwners(owners, feedback);
      if (!ok) return;
    }
  }

  /** Questions are decisions, not code failures. Re-run the advisor with the answer. */
  private async handleGateQuestions(
    checkpoint: "test-gate" | "review-gate",
    questions: readonly AgentQuestion[] | undefined,
  ): Promise<boolean> {
    const material = (questions ?? []).filter((q) => q.severity === "material");
    if (material.length === 0) return false;
    const unresolved = material.filter((q) => !(this.exec.answers ?? []).some(
      (answer) => answer.checkpoint === checkpoint && answer.question === q.question && answer.answer.trim() !== "",
    ));
    if (unresolved.length === 0) {
      await this.transition({ to: "BLOCKED", reason: `${checkpoint} advisor repeated an answered material question; revise the request or advisor before retrying` });
      return true;
    }
    this.enqueueMaterialQuestions(checkpoint, unresolved);
    await this.persistExecution();
    if (await this.resolveOpenQuestions(checkpoint) === "parked") return true;
    await this.transition({ to: checkpoint === "test-gate" ? "TEST_GATE" : "REVIEW_GATE", reason: "material gate questions answered; re-evaluating with user decisions" });
    return true;
  }

  private async phaseTestGate(): Promise<void> {
    if (await this.resolveOpenQuestions("test-gate") === "parked") return;
    const handles = await this.ensureHandles();
    const staging = handles.staging ?? this.repoPath;
    const requirements = this.deps.artifacts.readArtifact("requirements.md") ?? "";
    const developerDiff = this.deps.artifacts.readArtifact("developer.diff") ?? "";
    const testsDiff = this.deps.artifacts.readArtifact("tests.diff") ?? "";
    const result = await runTestGate({
      stagingDir: staging,
      requirements,
      verificationContract: this.exec.verificationContract ?? [],
      developerDiff,
      testsDiff,
      deps: {
        exec: this.trackedExecutor(this.executor),
        runTestRunnerAgent: (prompt: string) =>
          this.runReadonlyAgent("testRunner", `${prompt}\n\n${this.answersBlock(["requirements", "plan", "test-gate"]) ?? ""}`, staging),
      },
      store: this.deps.artifacts,
    });
    if (this.bail()) return;
    for (const c of result.commands) {
      this.deps.events.append("command_executed", `${c.command} → exit ${c.exitCode}`, { ...c });
    }
    this.deps.artifacts.recordEvidence(
      "commands",
      JSON.stringify(result.commands, null, 2),
      "test-gate",
      "test-gate-commands.json",
    );
    if (await this.handleGateQuestions("test-gate", result.questions)) return;
    const inputHash = hashContent(
      [developerDiff, testsDiff, (this.exec.verificationContract ?? []).join("\n")].join("\n"),
    );
    if (result.pass) {
      const next = nextCounters(this.state!.counters, "test", true);
      await this.setCounters(next);
      this.deps.events.append("gate_passed", "test gate passed", {
        totalAttempts: next.totalAttempts,
      });
      await this.transition({
        to: "REVIEW_GATE",
        reason: "test gate passed",
      });
      return;
    }
    const next = nextCounters(this.state!.counters, "test", false);
    await this.setCounters(next);
    const owners = routeGateFailure(result.ownership);
    this.recordFailureAttempt({
      gate: "test",
      owner: owners.join("+") || "both",
      inputHash,
      findings: [...result.preflightIssues, result.failureSummary],
      action: `rerouted to ${owners.join(" + ") || "both"}`,
    });
    this.deps.events.append("gate_failed", `test gate failed: ${result.failureSummary}`, {
      preflightIssues: result.preflightIssues,
      owners,
    });
    await this.persistExecution();
    const esc = shouldReplan(
      next,
      this.deps.config.gates.maxConsecutiveFailures,
      this.deps.config.gates.maxTotalAttempts,
    );
    if (esc.fail) {
      await this.transition({
        to: "FAILED",
        reason: `total attempt ceiling reached (${next.totalAttempts} ≥ ${this.deps.config.gates.maxTotalAttempts})`,
      });
      return;
    }
    if (esc.replan) {
      await this.escalateToReplan("test", false);
      return;
    }
    this.exec.reworkFeedback = {};
    if (owners.includes("developer")) {
      this.exec.reworkFeedback = { ...this.exec.reworkFeedback, developer: result.failureSummary };
    }
    if (owners.includes("testWriter")) {
      this.exec.reworkFeedback = { ...this.exec.reworkFeedback, testWriter: result.failureSummary };
    }
    await this.persistExecution();
    await this.reworkAfterGateFailure("test", owners);
  }

  private async phaseReviewGate(): Promise<void> {
    if (await this.resolveOpenQuestions("review-gate") === "parked") return;
    const handles = await this.ensureHandles();
    const staging = handles.staging ?? this.repoPath;
    const combinedDiff = this.deps.artifacts.readArtifact("combined.diff") ?? "";
    const requirements = this.deps.artifacts.readArtifact("requirements.md") ?? "";
    const result = await runReviewGate({
      stagingDir: staging,
      combinedDiff,
      requirements,
      runReviewerAgent: (prompt: string) =>
        this.runReadonlyAgent("reviewer", `${prompt}\n\n${this.answersBlock(["requirements", "plan", "review-gate"]) ?? ""}`, staging),
    });
    if (this.bail()) return;
    this.deps.artifacts.recordEvidence(
      "reviews",
      JSON.stringify(result.findings, null, 2),
      "review-gate",
      "review-findings.json",
    );
    if (await this.handleGateQuestions("review-gate", result.questions)) return;
    const inputHash = hashContent(combinedDiff);
    if (result.pass) {
      const next = nextCounters(this.state!.counters, "review", true);
      await this.setCounters(next);
      this.exec.documentationUpdates = [...result.documentationUpdates];
      this.deps.events.append("gate_passed", "review gate passed", {});
      await this.persistExecution();
      await this.transition({
        to: "DOCUMENTATION_UPDATE",
        reason: "review gate passed",
      });
      return;
    }
    const next = nextCounters(this.state!.counters, "review", false);
    await this.setCounters(next);
    const owners = routeGateFailure(
      result.findings.map((f) => ({ owner: f.path ? conflictOwner(f.path) : "both" })),
    );
    this.recordFailureAttempt({
      gate: "review",
      owner: owners.join("+") || "both",
      inputHash,
      findings: result.findings.map((f) => `${f.severity}: ${f.remediation}`),
      action: `rerouted to ${owners.join(" + ") || "both"}`,
    });
    this.deps.events.append(
      "gate_failed",
      `review gate failed: ${result.blockingCount} blocking/major finding(s)`,
      { blockingCount: result.blockingCount, owners },
    );
    await this.persistExecution();
    const esc = shouldReplan(
      next,
      this.deps.config.gates.maxConsecutiveFailures,
      this.deps.config.gates.maxTotalAttempts,
    );
    if (esc.fail) {
      await this.transition({
        to: "FAILED",
        reason: `total attempt ceiling reached (${next.totalAttempts} ≥ ${this.deps.config.gates.maxTotalAttempts})`,
      });
      return;
    }
    if (esc.replan) {
      await this.escalateToReplan("review", false);
      return;
    }
    this.exec.reworkFeedback = {};
    if (owners.includes("developer")) {
      this.exec.reworkFeedback = {
        ...this.exec.reworkFeedback,
        developer: result.findings
          .map((f) => `${f.severity} at ${f.path ?? "?"}: ${f.remediation}`)
          .join("\n"),
      };
    }
    if (owners.includes("testWriter")) {
      this.exec.reworkFeedback = {
        ...this.exec.reworkFeedback,
        testWriter: result.findings
          .map((f) => `${f.severity} at ${f.path ?? "?"}: ${f.remediation}`)
          .join("\n"),
      };
    }
    await this.persistExecution();
    await this.reworkAfterGateFailure("review", owners);
  }

  /** Gate-failure rework loop: DEVELOP → (rerun) → WRITE_TESTS → INTEGRATE. */
  private async reworkAfterGateFailure(gate: "test" | "review", owners: GateOwner[]): Promise<void> {
    // Work is being redone: recovery must never treat it as complete.
    this.exec.developComplete = false;
    await this.persistExecution();
    await this.transition({
      to: "DEVELOP",
      reason: `${gate} gate failure → rework (${owners.join(" + ") || "both"})`,
    });
    if (owners.includes("developer")) {
      const ok = await this.rerunDeveloper();
      if (!ok || this.bail()) return;
    }
    await this.transition({
      to: "WRITE_TESTS",
      reason: `${gate} gate failure → test-writer checkpoint`,
    });
    if (owners.includes("testWriter")) {
      const ok = await this.rerunTestWriter();
      if (!ok || this.bail()) return;
    }
    this.exec.developComplete = true;
    await this.persistExecution();
    await this.transition({ to: "INTEGRATE", reason: "rework complete; reintegrating" });
  }

  private async rerunForOwners(owners: GateOwner[], feedback: string): Promise<boolean> {
    this.exec.reworkFeedback = {};
    if (owners.includes("developer")) {
      this.exec.reworkFeedback = { ...this.exec.reworkFeedback, developer: feedback };
    }
    if (owners.includes("testWriter")) {
      this.exec.reworkFeedback = { ...this.exec.reworkFeedback, testWriter: feedback };
    }
    await this.persistExecution();
    this.exec.developComplete = false;
    await this.persistExecution();
    if (owners.includes("developer")) {
      const ok = await this.rerunDeveloper();
      if (!ok || this.bail()) return false;
    }
    if (owners.includes("testWriter")) {
      const ok = await this.rerunTestWriter();
      if (!ok || this.bail()) return false;
    }
    this.exec.developComplete = true;
    await this.persistExecution();
    return true;
  }

  private async rerunDeveloper(): Promise<boolean> {
    const handles = this.handles;
    if (!handles) return false;
    const result = await this.runAgent(
      "developer",
      developerPrompt(
        this.state!.request,
        this.deps.artifacts.readArtifact("requirements.md") ?? "",
        this.exec.planTasks ?? [],
        this.exec.reworkFeedback?.developer,
        this.answersBlock(["requirements", "plan", "develop"]),
      ),
      {
        cwd: handles.developer ?? this.repoPath,
        writableRoots: handles.developer ? [handles.developer] : [],
      },
    );
    if (this.bail()) return false;
    // Consume ONLY the developer's own feedback: the test writer's findings
    // must survive a developer rerun (REVIEW P1 per-owner feedback).
    const rf = { ...this.exec.reworkFeedback };
    delete rf.developer;
    this.exec.reworkFeedback = rf;
    await this.persistExecution();
    if (this.agentFailed(result)) {
      await this.blockOnAgentFailure("developer", result);
      return false;
    }
    this.deps.artifacts.writeArtifact("implementation.md", renderImplementationReport(result));
    this.enqueueMaterialQuestions("develop", result.completion?.questions);
    await this.persistExecution();
    return true;
  }

  private async rerunTestWriter(): Promise<boolean> {
    const handles = this.handles;
    if (!handles) return false;
    const result = await this.runAgent(
      "testWriter",
      testWriterPrompt(
        this.state!.request,
        this.deps.artifacts.readArtifact("requirements.md") ?? "",
        this.exec.planTasks ?? [],
        this.exec.reworkFeedback?.testWriter,
        this.answersBlock(["requirements", "plan", "develop"]),
      ),
      {
        cwd: handles.tests ?? this.repoPath,
        writableRoots: handles.tests ? [handles.tests] : [],
      },
    );
    if (this.bail()) return false;
    // Consume only the test writer's own feedback (per-owner preservation).
    const rf = { ...this.exec.reworkFeedback };
    delete rf.testWriter;
    this.exec.reworkFeedback = rf;
    await this.persistExecution();
    if (this.agentFailed(result)) {
      await this.blockOnAgentFailure("testWriter", result);
      return false;
    }
    this.deps.artifacts.writeArtifact("tests.md", renderTestsReport(result));
    this.enqueueMaterialQuestions("develop", result.completion?.questions);
    await this.persistExecution();
    return true;
  }

  private async escalateToReplan(gate: FailureGate | string, hopThroughTestGate: boolean): Promise<void> {
    this.deps.events.append(
      "escalation",
      `${gate} gate reached ${this.deps.config.gates.maxConsecutiveFailures} consecutive failures; replanning`,
      { gate },
    );
    this.ui?.notify(`gx-dev: replanning after repeated ${gate} failures`);
    if (hopThroughTestGate) {
      // TRANSITIONS has no INTEGRATE→REPLAN edge; route through the gate node.
      await this.transition({
        to: "TEST_GATE",
        reason: "escalation path: REPLAN is reachable from TEST_GATE",
      });
    }
    await this.transition({
      to: "REPLAN",
      reason: `${gate} consecutive failures exceeded the limit`,
    });
    // Replan is a fresh approach: consecutive streaks reset, totalAttempts does not.
    const state = this.state!;
    await this.setCounters({
      ...state.counters,
      testConsecutiveFailures: 0,
      reviewConsecutiveFailures: 0,
      integrationConsecutiveFailures: 0,
    });
    this.exec.planFromReplan = true;
    await this.persistExecution();
  }

  private async phaseReplan(): Promise<void> {
    const history = this.deps.artifacts.readArtifact("failure-history.md")
      ?? "(no recorded failures)";
    const prompt = plannerPrompt(
      this.state!.request,
      this.deps.artifacts.readArtifact("requirements.md") ?? "",
      this.deps.artifacts.readArtifact("research.md") ?? "",
      history,
      this.exec.revisionFeedback?.plan ?? null,
      this.answersBlock(["requirements", "plan"]),
    );
    const result = await this.runReadonlyAgent("planner", prompt, this.repoPath);
    if (this.bail()) return;
    if (this.agentFailed(result)) {
      await this.blockOnAgentFailure("planner", result);
      return;
    }
    const rf = { ...this.exec.revisionFeedback };
    delete rf.plan;
    this.exec.revisionFeedback = rf;
    this.exec.replanEpoch = (this.exec.replanEpoch ?? 0) + 1;
    this.storePlanArtifacts(result); // epoch header ⇒ plan hash changes
    this.exec.planFromReplan = true;
    await this.persistExecution();
    this.enqueueMaterialQuestions("plan", result.completion?.questions);
    await this.persistExecution();
    const newPlanHash = this.planHashOrCompute();
    await this.transition({
      to: "PLAN",
      reason: `new plan produced by replan epoch ${this.exec.replanEpoch}`,
      dependencies: { plan: newPlanHash },
    });
  }

  private async phaseDocumentationUpdate(): Promise<void> {
    const handles = await this.ensureHandles();
    const staging = handles.staging ?? this.repoPath;
    if (!this.exec.documentationComplete) {
      // Persist the pre-documentation baseline HEAD BEFORE the agent runs, so
      // the docs-only check can audit the COMPLETE pre-doc..current diff —
      // including edits the reviewer committed itself (REVIEW P0 bypass).
      if (this.exec.documentationBaseHead === undefined) {
        const baseHead = await this.gitRevParse(staging);
        if (baseHead === null) {
          await this.transition({
            to: "BLOCKED",
            reason: "cannot record the documentation baseline HEAD; refusing to run the documentation phase unverifiable",
          });
          return;
        }
        this.exec.documentationBaseHead = baseHead;
        await this.persistExecution();
      }
      const updates = this.exec.documentationUpdates ?? [];
      const result = await this.runAgent("reviewer", documentationPrompt(updates), {
        cwd: staging,
        writableRoots: [join(staging, "README.md"), join(staging, "docs")],
      });
      if (this.bail()) return;
      if (this.agentFailed(result)) {
        await this.blockOnAgentFailure("reviewer", result);
        return;
      }
      this.enqueueMaterialQuestions("documentation", result.completion?.questions);
      this.exec.documentationComplete = true;
      await this.persistExecution();
    }
    const questions = await this.resolveOpenQuestions("documentation");
    if (questions === "parked") return;
    // Docs-only enforcement (REVIEW P0): compare AFTER the agent and BEFORE
    // the checkpoint. The audited set is the committed diff from the pre-doc
    // baseline HEAD to the current staging HEAD plus every worktree and
    // untracked path — so committed source edits and renames (both sides,
    // via --no-renames) are rejected just like worktree edits. Anything
    // outside README.md/docs blocks BEFORE the checkpoint commit — a source
    // edit is never checkpointed.
    const baseHead = this.exec.documentationBaseHead ?? null;
    if (baseHead === null) {
      await this.transition({
        to: "BLOCKED",
        reason: "documentation baseline HEAD is missing; the documentation-only check cannot be verified",
      });
      return;
    }
    const changed = await this.stagingPathsSince(staging, baseHead);
    if (changed === null) {
      await this.transition({
        to: "BLOCKED",
        reason: "cannot inspect the staging tree for the documentation-only check: git diff/status failed",
      });
      return;
    }
    const violations = changed.filter((p) => !isDocsPath(p));
    if (violations.length > 0) {
      this.deps.events.append(
        "error",
        `documentation phase touched non-documentation files: ${violations.join(", ")}`,
        { violations },
      );
      this.ui?.notify(`gx-dev: documentation phase touched non-documentation files: ${violations.join(", ")}`);
      await this.transition({
        to: "BLOCKED",
        reason: `documentation phase touched non-documentation files: ${violations.join(", ")}; nothing was checkpointed`,
      });
      return;
    }
    if (changed.length === 0) {
      this.deps.events.append(
        "orchestrator_intervention",
        "documentation update produced no detectable file changes; logging intervention",
        { updates: this.exec.documentationUpdates ?? [] },
      );
      this.ui?.notify("gx-dev: documentation updates could not be verified on disk; intervention logged");
    }
    // Checkpoint documentation edits so final verification sees a clean tree.
    const docCommit = await this.gitSideEffect(
      this.deps.git.checkpointStaging(handles, "gx-dev checkpoint: documentation"),
    );
    if (docCommit) {
      this.deps.events.append("commit_created", "documentation checkpoint committed", {
        commitHash: docCommit,
        worktree: "staging",
      });
    }
    await this.transition({ to: "FINAL_VERIFICATION", reason: "documentation updated" });
  }

  /**
   * Every staging path changed since `baseHead`: the committed diff from the
   * baseline to the current staging HEAD (NUL-delimited, --no-renames so a
   * rename contributes BOTH its old and new side) plus all worktree and
   * untracked changes (`git status --porcelain -z --no-renames -uall`).
   * Returns null when git inspection fails (fail closed).
   */
  private async stagingPathsSince(staging: string, baseHead: string): Promise<string[] | null> {
    const committed = await this.gitRead(staging, [
      "diff", "-z", "--name-only", "--no-renames", baseHead, "HEAD",
    ]);
    if (committed === null || committed.exitCode !== 0) return null;
    const status = await this.gitRead(staging, [
      "status", "--porcelain", "-z", "--no-renames", "-uall",
    ]);
    if (status === null || status.exitCode !== 0) return null;
    return [...new Set([
      ...nulSeparatedPaths(committed.output),
      ...gitStatusZPaths(status.output),
    ])];
  }

  private async phaseFinalVerification(): Promise<void> {
    const handles = await this.ensureHandles();
    const staging = handles.staging ?? this.repoPath;
    const beforeTree = await this.gitTreeOf(staging, "HEAD^{tree}");
    const result = await runFinalGate({
      stagingDir: staging,
      verificationContract: this.exec.verificationContract ?? [],
      exec: this.trackedExecutor(this.executor),
      requireCleanTree: this.deps.config.gates.requireCleanFinalTree,
      checkClean: async () => {
        const run = await this.execCommand(staging, "git status --porcelain");
        return run.exitCode === 0 && run.output.trim() === "";
      },
      store: this.deps.artifacts,
    });
    if (this.bail()) return;
    for (const c of result.commands) {
      this.deps.events.append("command_executed", `${c.command} → exit ${c.exitCode}`, { ...c });
    }
    this.deps.artifacts.recordEvidence(
      "commands",
      JSON.stringify(result.commands, null, 2),
      "final-gate",
      "final-gate-commands.json",
    );
    const afterTree = await this.gitTreeOf(staging, "HEAD^{tree}");
    if (result.pass && beforeTree !== null && beforeTree === afterTree) {
      this.exec.verifiedTree = afterTree;
      await this.persistExecution();
      this.deps.events.append("gate_passed", "final verification passed", { tree: afterTree });
      await this.transition({ to: "COMMIT", reason: "final verification passed" });
      return;
    }
    const reason = `final verification failed: ${result.failures.join("; ") || "staging tree changed during verification or could not be inspected"}`;
    this.deps.events.append("gate_failed", reason, { failures: result.failures });
    this.ui?.notify(`gx-dev: ${reason}`);
    await this.transition({ to: "BLOCKED", reason });
  }

  private async phaseCommit(): Promise<void> {
    const handles = await this.ensureHandles();
    // Crash reconciliation first (REVIEW P1): a previous drive may have
    // applied the commit and died before/after persisting the receipt. The
    // applied result is verified (original branch, staging tree, run-id
    // trailer, ancestry) and the run advances WITHOUT re-applying.
    if (await this.reconcileCommitApply(handles)) return;
    if (this.exec.commitMessage === undefined) {
      const staging = handles.staging ?? this.repoPath;
      const summary = this.buildRunSummary();
      const result = await this.runReadonlyAgent("committer", committerPrompt(this.state!.request, summary), staging);
      if (this.bail()) return;
      if (this.agentFailed(result)) {
        await this.blockOnAgentFailure("committer", result);
        return;
      }
      const completion =
        result.completion && "commitHash" in result.completion ? result.completion : null;
      // Deterministic message policy: the engine owns the commit message shape.
      // The committer's summary may inform the subject, but is never used
      // verbatim — live runs showed agents returning paragraph-length blobs.
      // The trailer block (run id + evidence path) is always preserved: crash
      // reconciliation recognizes the applied commit by it.
      const fallback = buildCommitMessage(this.state!.request, this.state!.runId, summary);
      const advisedSubject = completion
        ? completion.summary.trim().split(/[.\n]/)[0]?.trim().slice(0, 72) ?? ""
        : "";
      // Never hardcode a model: record the provider-reported served model, or
      // an unpinned generic marker when none is known.
      const advisedBy = result.servedModel
        ? `Advised-by: gx-dev committer agent (${result.servedModel}).`
        : "Advised-by: gx-dev committer agent.";
      const message =
        completion && completion.summary.trim() !== ""
          ? `${advisedSubject}\n\n${fallback.split("\n").slice(1).join("\n").trim()}\n\n${advisedBy}`
          : fallback;
      this.exec.commitMessage = message;
      this.enqueueMaterialQuestions("commit", result.completion?.questions);
      await this.persistExecution();
    }
    const questions = await this.resolveOpenQuestions("commit");
    if (questions === "parked") return;
    // autoCommit=false: an explicit user confirmation is required before the
    // result is applied to the user's branch (REVIEW P0 config bypass). The
    // confirmation binds to a unique question instance like every approval.
    if (!this.deps.config.git.autoCommit) {
      const ask = this.approvalAskFor("commit", COMMIT_CONFIRM_QUESTION);
      const recorded = ask !== null ? this.latestAnswerForInstance(ask.instanceId) : null;
      const decided = ask !== null ? this.decisionForInstance(ask.instanceId) : null;
      const answer = decided !== null
        ? decided.decision === "approved" ? "approve" : "reject"
        : recorded !== null ? recorded.answer : null;
      if (answer === null) {
        const pq: PendingQuestion = {
          instanceId: newQuestionInstanceId(),
          reason: "git.autoCommit is false: applying the result requires explicit confirmation",
          question: COMMIT_CONFIRM_QUESTION,
          context: [
            `Target branch: ${this.state!.base?.branch ?? "main"}`,
            "Reply 'approve' to apply the commit, or 'reject' to leave the result unapplied on the staging branch.",
          ],
          choices: ["approve", "reject"],
          answers: [],
          severity: "material",
          kind: "confirmation",
          checkpoint: "commit",
        };
        const fresh = await this.askDecisionQuestion(pq);
        if (fresh === null || this.bail()) return;
        const freshAsk = this.approvalAskFor("commit", COMMIT_CONFIRM_QUESTION);
        if (freshAsk === null) return;
        if (!(await this.applyCommitConfirmation(freshAsk, fresh))) return;
      } else if (!(await this.applyCommitConfirmation(ask!, answer))) {
        return;
      }
    }
    const message = this.exec.commitMessage;
    const baseBranch = this.state!.base?.branch ?? "main";
    // Persist the apply intent BEFORE the merge touches the user's branch: a
    // crash after the merge but before the receipt is recognized via the
    // exact staging tree, the run-id trailer, and ancestry (never re-applied
    // blindly, ambiguous commits block).
    const stagingTip = await this.gitRevParse(handles.staging);
    const stagingTree = stagingTip !== null
      ? await this.gitTreeOf(handles.staging, "HEAD^{tree}")
      : null;
    const baseHead = this.state!.base?.commit ?? null;
    if (stagingTip === null || stagingTree === null || baseHead === null) {
      await this.transition({
        to: "BLOCKED",
        reason: "cannot record the apply intent (staging tip/tree or base unavailable); refusing to apply unverifiable",
      });
      return;
    }
    if (stagingTree !== this.exec.verifiedTree) {
      await this.transition({ to: "BLOCKED", reason: "staging tree no longer matches final verification; refusing to commit" });
      return;
    }
    this.exec.commitIntent = {
      baseBranch,
      baseHead,
      stagingTip,
      stagingTree,
      message,
      at: new Date().toISOString(),
    };
    await this.persistExecution();
    // The engine performs the commit itself; the agent only advises.
    const commit = await this.gitSideEffect(
      this.deps.git.commitStaged(handles, message, baseBranch),
    );
    await this.finishCommit(commit, "applied");
  }

  /**
   * Records the commit confirmation decision for a question instance.
   * Returns false when the run must not proceed (blocked/not authorized).
   * Only an exact affirmative command authorizes the apply.
   */
  private async applyCommitConfirmation(
    ask: RunExecutionApprovalAsk,
    answer: string,
  ): Promise<boolean> {
    if (answer.trim() === "") return false;
    const authorized = isAffirmative(answer.trim());
    if (this.decisionForInstance(ask.instanceId) === null) {
      (this.exec.decisions ??= []).push({
        checkpoint: "commit",
        decision: authorized ? "approved" : "rejected",
        artifact: "(commit apply confirmation)",
        hash: "",
        askHash: ask.artifactHash,
        feedback: authorized ? null : "the user did not authorize applying the commit",
        instanceId: ask.instanceId,
        at: new Date().toISOString(),
      });
      await this.persistExecution();
    }
    if (!authorized) {
      await this.transition({
        to: "BLOCKED",
        reason: "commit not authorized by the user; the verified result remains on the staging branch",
      });
      return false;
    }
    return true;
  }

  /**
   * Durable commit receipt: persist the applied/reconciled hash, record the
   * event with evidence, generate result.md, and advance to memory
   * promotion. Idempotent — used by both the apply and the reconcile path.
   */
  private async finishCommit(
    commit: { commitHash: string; strategy: string; rollbackCommand: string },
    via: "applied" | "reconciled",
  ): Promise<void> {
    this.exec.commitHash = commit.commitHash;
    this.exec.commitStrategy = commit.strategy;
    this.exec.commitRollback = commit.rollbackCommand;
    await this.persistExecution();
    this.deps.events.append(
      "commit_created",
      `commit ${commit.commitHash} ${via} via ${commit.strategy}`,
      { ...commit, via },
    );
    this.deps.artifacts.writeArtifact(
      "result.md",
      renderResult(this.state!, commit, this.deps.artifacts.evidence()),
    );
    await this.transition({
      to: "MEMORY_PROMOTION",
      reason:
        via === "reconciled"
          ? "commit reconciled after restart; verified, not re-applied"
          : "commit created",
    });
  }

  /**
   * COMMIT crash reconciliation. Returns true when the phase is resolved
   * (advanced to MEMORY_PROMOTION or BLOCKED); false when the apply may
   * proceed. Two crash windows are handled:
   *
   * 1. receipt present (crash after `execution.commitHash` was persisted):
   *    the receipted commit is verified against the run's original branch,
   *    the run-id trailer, the recorded base ancestry, and — when an apply
   *    intent exists — the exact staging tree, then the result is generated
   *    and the run advances without re-applying.
   * 2. intent present but no receipt (crash between the git merge and the
   *    receipt): branch history is scanned for the applied commit via the
   *    exact staging tree + run-id trailer + ancestry. Exactly one match is
   *    receipted and advanced; no match means the merge never landed and the
   *    apply proceeds normally; multiple matches are AMBIGUOUS and block —
   *    gx-dev never guesses and never overwrites.
   */
  private async reconcileCommitApply(handles: WorktreeHandles): Promise<boolean> {
    const state = this.state!;
    const intent = this.exec.commitIntent ?? null;
    const receipted = this.exec.commitHash ?? null;
    if (receipted === null && intent === null) return false;
    const failClosed = async (reason: string): Promise<true> => {
      this.deps.events.append("error", `commit reconciliation blocked: ${reason}`, {
        runId: state.runId,
      });
      this.ui?.notify(`gx-dev: commit reconciliation blocked: ${reason}`);
      await this.transition({ to: "BLOCKED", reason: `commit reconciliation blocked: ${reason}` });
      return true;
    };
    const baseBranch = state.base?.branch ?? null;
    if (baseBranch === null) {
      return await failClosed("the run's original branch was not recorded; manual resolution required");
    }
    const baseHead = intent !== null ? intent.baseHead : state.base?.commit ?? null;
    if (baseHead === null) {
      return await failClosed("the run's base commit was not recorded; manual resolution required");
    }
    const branchTip = await this.gitResolve(this.repoPath, baseBranch);
    if (branchTip === null) {
      return await failClosed(`recorded base branch ${baseBranch} no longer resolves; manual resolution required`);
    }
    const trailer = `gx-dev run ${state.runId}`;
    const candidates = await this.scanBranchCommits(branchTip, trailer, baseHead);
    if (candidates === null) {
      return await failClosed("git history could not be inspected; manual resolution required");
    }
    if (receipted !== null) {
      const entry = candidates.find((c) => c.sha === receipted) ?? null;
      const verdict = verifyCommitReceipt(entry, {
        receiptedSha: receipted,
        runIdTrailer: trailer,
        stagingTree: intent !== null ? intent.stagingTree : null,
        baseBranch,
      });
      if (!verdict.ok) {
        return await failClosed(`${verdict.reason}; the repository will not be overwritten`);
      }
      const strategy = verdict.mergeCommit ? "merge-commit" : "fast-forward";
      const rollbackCommand = await this.rollbackFor(receipted, strategy);
      await this.finishCommit(
        { commitHash: receipted, strategy, rollbackCommand },
        "reconciled",
      );
      return true;
    }
    // No receipt: recognize a commit applied by a crash before the receipt.
    if (intent === null) return false; // unreachable; kept for clarity
    const scan = scanForAppliedCommit(candidates, {
      runIdTrailer: trailer,
      stagingTree: intent.stagingTree,
    });
    if (scan.kind === "ambiguous") {
      return await failClosed(
        `ambiguous applied commits (${scan.shas.join(", ")}) match the apply intent; manual resolution required; nothing was overwritten`,
      );
    }
    if (scan.kind !== "applied") return false; // merge never landed: apply normally
    const strategy = scan.mergeCommit ? "merge-commit" : "fast-forward";
    const rollbackCommand = await this.rollbackFor(scan.sha, strategy);
    this.exec.commitHash = scan.sha;
    await this.persistExecution();
    await this.finishCommit(
      { commitHash: scan.sha, strategy, rollbackCommand },
      "reconciled",
    );
    return true;
  }

  /**
   * Inspects the branch history (bounded) for reconciliation candidates:
   * sha, tree, parents, message, and base ancestry. Returns null when git
   * inspection fails (fail closed).
   */
  private async scanBranchCommits(
    branchTip: string,
    trailer: string,
    baseHead: string,
  ): Promise<AppliedCommitCandidate[] | null> {
    const revs = await this.gitRead(this.repoPath, ["rev-list", "--max-count=200", branchTip]);
    if (revs === null || revs.exitCode !== 0) return null;
    const candidates: AppliedCommitCandidate[] = [];
    for (const sha of revs.output.split("\n").map((s) => s.trim()).filter((s) => s !== "")) {
      // Cheap message pre-filter before the per-commit plumbing.
      const show = await this.gitRead(this.repoPath, [
        "show", "-s", "--format=%H%x00%T%x00%P%x00%B", sha,
      ]);
      if (show === null || show.exitCode !== 0) return null;
      const parts = show.output.split("\0");
      const shownSha = (parts[0] ?? "").trim();
      const tree = (parts[1] ?? "").trim();
      const parents = (parts[2] ?? "").trim().split(/\s+/).filter((s) => s !== "");
      const message = parts.slice(3).join("\0");
      if (shownSha !== sha) return null;
      if (!message.includes(trailer)) continue;
      const ancestor = await this.gitAncestor(this.repoPath, baseHead, sha);
      if (ancestor === null) return null;
      candidates.push({ sha, tree, parents, message, baseIsAncestor: ancestor });
    }
    return candidates;
  }

  /** Strategy-aware, history-preserving rollback guidance (revert-based). */
  private async rollbackFor(applied: string, strategy: string): Promise<string> {
    if (strategy === "merge-commit") {
      return `git revert --no-edit --mainline 1 ${applied}`;
    }
    const baseCommit = this.state!.base?.commit ?? null;
    if (baseCommit === null) return `git revert --no-edit ${applied}`;
    const revs = await this.gitRead(this.repoPath, ["rev-list", `${baseCommit}..${applied}`]);
    const shas =
      revs !== null && revs.exitCode === 0
        ? revs.output.split("\n").map((s) => s.trim()).filter((s) => s !== "")
        : [];
    const commands: string[] = [];
    for (const sha of shas) {
      const parents = await this.gitRead(this.repoPath, ["rev-list", "--parents", "-n", "1", sha]);
      const isMerge =
        parents !== null && parents.exitCode === 0 && parents.output.trim().split(/\s+/).length > 2;
      commands.push(
        isMerge ? `git revert --no-edit --mainline 1 ${sha}` : `git revert --no-edit ${sha}`,
      );
    }
    return commands.length === 0 ? `git revert --no-edit ${applied}` : commands.join(" && ");
  }

  private async phaseMemoryPromotion(): Promise<void> {
    const state = this.state!;
    if (!this.deps.config.memory.enabled || !this.deps.config.memory.updateOnSuccess) {
      await this.transition({
        to: "COMPLETE",
        reason: "memory promotion disabled by configuration",
      });
      return;
    }
    const now = new Date().toISOString();
    const featurePage = `features/${state.runId}`;
    const related = await this.memoryRelatedPages(state.request);
    const relatedLine = `Related: ${related.map((r) => `[[${r}]]`).join(", ")}.`;
    const contract = (this.exec.verificationContract ?? []).join("; ") || "(none)";
    const provenance = [state.runId, this.exec.commitHash ?? "unknown"];
    const proposals: MemoryProposal[] = [
      {
        page: featurePage,
        action: "create",
        body: [
          "## Summary",
          "",
          state.request,
          "",
          this.buildRunSummary(),
          "",
          "## Outcome",
          "",
          `- Delivered by gx-dev run ${state.runId} and applied to the working branch.`,
          `- Verification contract executed: ${contract}`,
          "",
          relatedLine,
          "",
        ].join("\n"),
        provenance,
        scope: "feature",
        freshness: now,
        verification: "not-verified",
        runId: state.runId,
      },
    ];
    if ((this.exec.documentationUpdates ?? []).length > 0) {
      proposals.push({
        page: `${featurePage}-documentation`,
        action: "update",
        body: [
          "## Summary",
          "",
          "Documentation refreshed for the delivered feature.",
          "",
          "## Updates",
          "",
          ...(this.exec.documentationUpdates ?? []).map((u) => `- ${u}`),
          "",
          relatedLine,
          "",
        ].join("\n"),
        provenance,
        scope: "feature",
        freshness: now,
        verification: "not-verified",
        runId: state.runId,
      });
    }
    // Reviewer gate over the proposals: promotion is never auto-"verified".
    const review = await this.reviewMemoryProposals(proposals);
    this.deps.events.append(
      review.approved ? "gate_passed" : "orchestrator_intervention",
      review.note,
      { proposals: proposals.map((p) => p.page) },
    );
    this.deps.artifacts.writeArtifact(
      "memory-proposal.md",
      JSON.stringify({ proposals, review }, null, 2),
    );
    if (!review.approved) {
      this.ui?.notify(`gx-dev: memory promotion skipped — ${review.note}`);
      await this.transition({
        to: "COMPLETE",
        reason: "run complete (feature committed; memory promotion pending review)",
      });
      return;
    }
    for (const p of proposals) p.verification = "verified";
    // Structural preview lint when the store supports it. Lint findings fail
    // CLOSED: promotion is skipped with recorded evidence instead of applying
    // structurally invalid pages (REVIEW §4: reviewed memory).
    let lint: { ok: boolean; issues: string[] } | null = null;
    try {
      lint = this.deps.memory.lintProposals?.(proposals) ?? null;
    } catch (e) {
      lint = { ok: false, issues: [`lintProposals threw: ${(e as Error).message}`] };
    }
    if (lint !== null && !lint.ok) {
      this.deps.artifacts.writeArtifact(
        "memory-proposal.md",
        JSON.stringify({ proposals, review, lint, promoted: false, skipReason: "lint findings" }, null, 2),
      );
      this.deps.events.append(
        "orchestrator_intervention",
        `memory promotion skipped: proposal lint findings: ${lint.issues.join("; ")}`,
        { issues: lint.issues },
      );
      this.ui?.notify(`gx-dev: memory promotion skipped — lint findings: ${lint.issues.join("; ")}`);
      await this.transition({
        to: "COMPLETE",
        reason: "run complete (feature committed; memory promotion skipped: proposal lint findings)",
      });
      return;
    }
    const reserved = await this.deps.memory.reserve(proposals);
    const { applied, conflicts } = await this.deps.memory.promote(reserved);
    this.deps.artifacts.writeArtifact(
      "memory-proposal.md",
      JSON.stringify({ proposals: reserved, review, lint, applied, conflicts }, null, 2),
    );
    this.deps.events.append("memory_promoted", `promoted ${applied.length} memory page(s)`, {
      applied,
      conflicts,
    });
    if (conflicts.length > 0) {
      this.ui?.notify(`gx-dev: memory conflicts: ${conflicts.join(", ")}`, { conflicts });
    }
    await this.transition({ to: "COMPLETE", reason: "run complete" });
  }
}

/**
 * Paths from NUL-delimited `git diff -z --name-only` output: every
 * NUL-separated entry is a path; --no-renames makes a rename appear as both
 * its deleted old side and added new side, so both are audited.
 */
function nulSeparatedPaths(out: string): string[] {
  return out
    .split("\0")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/**
 * Paths from NUL-delimited `git status --porcelain -z --no-renames -uall`
 * output: each entry is `XY <path>` (two status letters, a space, then the
 * path); untracked files are listed individually. Rename pairs are two
 * separate entries under --no-renames, so both sides are audited.
 */
function gitStatusZPaths(out: string): string[] {
  const paths: string[] = [];
  for (const entry of out.split("\0")) {
    if (entry.trim() === "" || entry.length < 4) continue;
    paths.push(entry.slice(3));
  }
  return paths;
}

/** Only README.md and docs/** qualify as documentation-phase edits. */
function isDocsPath(path: string): boolean {
  return /^README\.md$/i.test(path) || /^docs\//.test(path);
}
