/**
 * gx-dev orchestration engine (PLAN §5–§9, §12).
 *
 * The engine — never an agent — owns the workflow state machine. Every
 * transition is validated by the domain and persisted (via persistTransition)
 * BEFORE the next action begins. The engine is UI-agnostic: it receives an
 * optional EngineUI callback interface and never imports pi TUI APIs.
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
import type {
  AgentRunResult,
  AgentRunner,
  AgentWorkContext,
  GitCoordinator,
  MemoryCoordinator,
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
  RunState,
  TransitionInput,
} from "../domain/state.ts";
import {
  TERMINAL_STATES,
  canTransition,
  createRunState,
  isPipeline,
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
import { recoverRun, resumableFrom } from "./recovery.ts";
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

/**
 * The engine-owned, allowlisted command executor: spawns via execFile with
 * the command split on whitespace, cwd = staging, environment inherited.
 * Defense in depth: it independently refuses non-allowlisted commands.
 */
/** Best-effort child termination helper imports live above. */

/**
 * Copies a directory tree into a disposable temp snapshot so read-only
 * agents (researcher, planner, review-gate reviewer, test-runner advisor,
 * committer) physically cannot dirty the real repository or staging tree.
 * `.git` and `node_modules` are excluded; everything else is preserved.
 */
async function snapshotDir(source: string): Promise<string> {
  const dest = mkdtempSync(join(tmpdir(), "gx-dev-readonly-"));
  const filter = (src: string): boolean => {
    const base = src.split(/[\\/]/).pop() ?? "";
    return base !== ".git" && base !== "node_modules";
  };
  await cp(source, dest, { recursive: true, filter });
  return dest;
}

export function createProcessExecutor(): CommandExecutor {
  return {
    async execute(cwd, command, timeoutMs) {
      if (!isAllowlistedCommand(command)) {
        return {
          exitCode: 126,
          output: `rejected: command not on allowlist: ${command}`,
          truncated: false,
        };
      }
      const parts = command.trim().split(/\s+/);
      const file = parts[0];
      if (!file) {
        return { exitCode: 127, output: "empty command", truncated: false };
      }
      const args = parts.slice(1);
      try {
        const { stdout, stderr } = await execFileP(file, args, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env },
        });
        const t = truncateOutput(stdout + stderr);
        return { exitCode: 0, output: t.output, truncated: t.truncated };
      } catch (err) {
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
    "- (drafted by the researcher; approve or edit at the requirements checkpoint)",
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

function researchPrompt(request: string, story: string | null, brief: string | null): string {
  return [
    "You are the researcher. Inspect the repository and produce ONE researcher JSON completion (single ```json block). Identify languages, frameworks, conventions, risks, and requirement ambiguities. Ask material questions explicitly with severity \"material\".",
    `User request:\n\n${request}`,
    story ? `Story document:\n\n${story}` : null,
    brief ? `Known repository brief:\n\n${brief}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}

function plannerPrompt(
  request: string,
  requirements: string,
  research: string,
  failureHistory: string | null,
): string {
  return [
    "You are the planner. Produce ONE planner JSON completion: tasks assigned to developer or testWriter, a verificationContract of runnable commands, and a rollbackPlan.",
    `User request:\n\n${request}`,
    `Approved requirements:\n\n${requirements}`,
    `Research:\n\n${research}`,
    failureHistory
      ? `The previous plan failed repeatedly. Full failure history follows; reconsider the whole approach.\n\n${failureHistory}`
      : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}

function developerPrompt(
  request: string,
  requirements: string,
  tasks: PlannerTask[],
  feedback: string | undefined,
): string {
  const devTasks = tasks.filter((t) => t.assignee === "developer");
  const lines = devTasks.map((t) => `- [${t.id}] ${t.title} (files: ${t.files.join(", ") || "n/a"})`);
  return [
    "You are the developer. Work ONLY inside your assigned worktree. Implement the tasks and return ONE developer JSON completion with changedFiles. Document deviations from the plan.",
    `User request:\n\n${request}`,
    `Approved requirements:\n\n${requirements}`,
    lines.length > 0 ? `Your tasks:\n${lines.join("\n")}` : "Implement the requested feature.",
    feedback ? `A gate returned findings you must address:\n\n${feedback}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}

function testWriterPrompt(
  request: string,
  requirements: string,
  tasks: PlannerTask[],
  feedback: string | undefined,
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
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}

function documentationPrompt(updates: string[]): string {
  return [
    "You are the reviewer in documentation mode. Apply ONLY the following documentation updates by editing documentation files (README.md, docs/, website/) in your working directory. Do not touch implementation or tests.",
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

/** Deterministic workflow engine. See PLAN §5 for the state machine. */
export class Engine {
  private readonly repoPath: string;
  private readonly deps: EngineDeps;
  private state: RunState | null = null;
  private handles: WorktreeHandles | null = null;
  private aborter = new AbortController();
  private cancelRequested = false;
  private pauseRequested = false;
  private story: string | null = null;
  private planFromReplan = false;
  private replanEpoch = 0;
  private evidenceSeq = 0;
  private planTasks: PlannerTask[] = [];
  private planHash: string | null = null;
  private planSummary: string | null = null;
  private verificationContract: string[] = [];
  private reviewerDocumentationUpdates: string[] = [];
  private commitHash: string | null = null;
  private reworkFeedback: { developer?: string; testWriter?: string } = {};
  private failureAttempts: FailureAttempt[] = [];
  private readonly executor: CommandExecutor;

  constructor(repoPath: string, deps: EngineDeps) {
    this.repoPath = repoPath;
    this.deps = deps;
    this.executor = createProcessExecutor();
  }

  status(): RunState | null {
    return this.state;
  }

  async start(request: string, storyPath?: string): Promise<RunState> {
    if (this.state && !TERMINAL_STATES.includes(this.state.state)) {
      throw new Error("a run is already active; cancel or finish it before starting a new one");
    }
    this.cancelRequested = false;
    this.pauseRequested = false;
    this.planFromReplan = false;
    this.replanEpoch = 0;
    this.evidenceSeq = 0;
    this.planTasks = [];
    this.planHash = null;
    this.planSummary = null;
    this.verificationContract = [];
    this.reviewerDocumentationUpdates = [];
    this.commitHash = null;
    this.reworkFeedback = {};
    this.failureAttempts = [];
    this.handles = null;
    this.story = null;
    this.aborter = new AbortController();
    if (storyPath) {
      try {
        this.story = readFileSync(storyPath, "utf8");
      } catch {
        this.story = null;
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
      this.story ? `${request}\n\n## Story\n\n${this.story}` : request,
      "user",
      "request.md",
    );
    await this.drive();
    return this.state!;
  }

  /** Answers the pending question; only valid while WAITING_FOR_USER. */
  async answer(text: string): Promise<RunState> {
    const state = this.state;
    if (!state) throw new Error("no active run");
    if (state.state !== "WAITING_FOR_USER" || !state.pendingQuestion) {
      throw new Error(`answer() is only valid while WAITING_FOR_USER (current state: ${state.state})`);
    }
    const question: PendingQuestion = {
      ...state.pendingQuestion,
      answers: [
        ...state.pendingQuestion.answers,
        { answer: text, at: new Date().toISOString() },
      ],
    };
    this.state = { ...state, pendingQuestion: question };
    this.evidenceSeq += 1;
    this.deps.artifacts.recordEvidence(
      "user-input",
      `${question.question}\n\nAnswer: ${text}`,
      "user",
      `answer-${this.evidenceSeq}.md`,
    );
    this.deps.events.append("question_answered", text, {
      question: question.question,
      severity: question.severity,
    });
    await this.deps.runStore.save(this.state);
    const target = state.resumeState;
    if (target && canTransition(this.state.state, target)) {
      await this.transition({ to: target, reason: "user answered the pending question" });
      await this.drive();
    }
    return this.state!;
  }

  async pause(): Promise<RunState> {
    const state = this.state;
    if (!state) throw new Error("no active run");
    if (TERMINAL_STATES.includes(state.state)) return state;
    if (isPipeline(state.state)) {
      this.pauseRequested = true;
      this.aborter.abort();
      this.deps.events.append("user_action", "run paused by user", {});
      this.state = await persistTransition(this.persistence, state, {
        to: "PAUSED",
        reason: "user paused the run",
      });
    }
    return this.state!;
  }

  async resume(runId?: string): Promise<RunState> {
    if (runId || !this.state) {
      const id = runId ?? (await this.deps.runStore.list())[0]?.runId;
      if (!id) throw new Error("no run found to resume");
      const recovered = await recoverRun(this.deps.runStore, id);
      if (!recovered) throw new Error(`run ${id} cannot be recovered`);
      this.state = recovered;
      this.handles = null;
      this.pauseRequested = false;
      this.cancelRequested = false;
      this.aborter = new AbortController();
      this.deps.events.append("user_action", `resuming run ${id}`, {});
    }
    const current = this.state!;
    if (!resumableFrom(current.state)) return current;
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
  }

  async cancel(): Promise<RunState> {
    const state = this.state;
    if (!state) throw new Error("no active run");
    if (TERMINAL_STATES.includes(state.state)) return state;
    this.cancelRequested = true;
    this.aborter.abort();
    this.deps.events.append("user_action", "run cancelled by user", {});
    this.state = await persistTransition(this.persistence, state, {
      to: "CANCELLED",
      reason: "user cancelled the run",
    });
    await this.cleanupWorktrees(!this.deps.config.git.retainFailedRuns);
    return this.state!;
  }

  // ------------------------------------------------------------------ core

  private get ui(): EngineUI | null {
    return this.deps.ui ?? null;
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
    this.state = await persistTransition(this.persistence, from, input);
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

  private async ensureHandles(): Promise<WorktreeHandles> {
    if (!this.handles) {
      this.handles = await this.deps.git.prepareWorktrees(this.repoPath, this.state!.runId);
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
    await this.deps.git.cleanup(handles, force ? { force: true } : undefined);
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
      const result = await this.deps.runner.run(role, task, work, {
        timeoutMs: this.deps.config.agents.timeoutMinutes * 60_000,
        signal: this.aborter.signal,
      });
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
      attempt += 1;
      await sleep(200 * 2 ** (attempt - 1));
    }
  }

  /** Read-only roles run inside a disposable snapshot (write containment). */
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

  /** Routes an agent failure to BLOCKED (infra counters recorded). */
  private async blockOnAgentFailure(role: AgentRole, result: AgentRunResult): Promise<void> {
    const reason = result.infrastructure
      ? `${role} infrastructure failure after retries: ${result.error ?? "unknown error"}`
      : `${role} agent failure: ${result.error ?? "invalid completion"}`;
    if (result.infrastructure) {
      await this.setCounters(nextCounters(this.state!.counters, "infrastructure", false));
    }
    this.deps.events.append("error", reason, { role, infrastructure: result.infrastructure });
    this.ui?.notify(`gx-dev: ${reason}`);
    await this.transition({ to: "BLOCKED", reason });
  }

  /** Records one attempt in failure-history.md. The file always renders the
   * full numbered history so the planner sees every causal attempt. */
  private recordFailureAttempt(attempt: FailureAttempt): void {
    this.failureAttempts = [...this.failureAttempts, attempt];
    this.deps.artifacts.writeArtifact(
      "failure-history.md",
      renderFailureHistory(this.failureAttempts),
    );
    this.deps.events.append(
      "escalation",
      `failure recorded at ${attempt.gate} gate (owner: ${attempt.owner})`,
      { ...attempt },
    );
  }

  /**
   * Asks a material question. With a UI: ask, record the answer, continue.
   * Without: persist WAITING_FOR_USER (resume target = current pipeline
   * state) and stop the drive loop so headless drivers can re-invoke.
   */
  private async askMaterialQuestion(
    phase: string,
    question: AgentQuestion,
  ): Promise<boolean> {
    const pq: PendingQuestion = {
      reason: `material question during ${phase} requires a user decision`,
      question: question.question,
      context: question.context ?? [],
      answers: [],
      severity: "material",
    };
    this.deps.events.append("question_asked", question.question, {
      severity: "material",
      phase,
    });
    this.ui?.notify(`gx-dev question: ${question.question}`, { phase, severity: "material" });
    if (this.ui) {
      const answer = await this.ui.askUser(pq);
      if (this.bail()) return false;
      pq.answers.push({ answer, at: new Date().toISOString() });
      this.evidenceSeq += 1;
      this.deps.artifacts.recordEvidence(
        "user-input",
        `${question.question}\n\nAnswer: ${answer}`,
        "user",
        `answer-${this.evidenceSeq}.md`,
      );
      this.deps.events.append("question_answered", answer, { question: question.question });
      return true;
    }
    await this.transition({ to: "WAITING_FOR_USER", pendingQuestion: pq, reason: pq.reason });
    return false;
  }

  /** Captures a worktree diff via the allowlisted executor, with an
   * agent-reported fallback when git is unavailable (e.g. fresh runs). */
  private async captureDiff(dir: string | null, result: AgentRunResult): Promise<string> {
    if (dir) {
      const real = await this.executor.execute(dir, "git diff HEAD", COMMAND_TIMEOUT_MS);
      if (real.exitCode === 0 && real.output.trim() !== "") return real.output;
    }
    const completion = result.completion;
    const files =
      completion && "changedFiles" in completion && completion.changedFiles.length > 0
        ? completion.changedFiles
        : ["(worktree)"];
    const body = result.rawText;
    const bodyLines = body.split("\n");
    return files
      .map((f) =>
        [
          `diff --git a/${f} b/${f}`,
          `--- a/${f}`,
          `+++ b/${f}`,
          `@@ -0,0 +1,${bodyLines.length} @@`,
          ...bodyLines.map((l) => `+${l}`),
        ].join("\n"),
      )
      .join("\n");
  }

  private storePlanArtifacts(result: AgentRunResult): void {
    const completion =
      result.completion && "verificationContract" in result.completion
        ? result.completion
        : null;
    this.planTasks = completion ? [...completion.tasks] : [];
    this.verificationContract = completion ? [...completion.verificationContract] : [];
    this.planSummary = completion ? completion.summary : result.rawText.slice(0, 200);
    const header =
      this.replanEpoch > 0 ? `# Plan (replan epoch ${this.replanEpoch})` : "# Plan";
    const plan = [header, "", renderPlanBody(result)].join("\n");
    this.planHash = this.deps.artifacts.writeArtifact("plan.md", plan);
    this.deps.artifacts.writeArtifact("test-plan.md", renderTestPlan(this.planTasks));
    this.deps.artifacts.writeArtifact(
      "verification.json",
      JSON.stringify(this.verificationContract, null, 2),
    );
  }

  private planHashOrCompute(): string {
    return (
      this.planHash ?? hashContent(this.deps.artifacts.readArtifact("plan.md") ?? "")
    );
  }

  private buildRunSummary(): string {
    const state = this.state!;
    const parts = [`Request: ${state.request}`];
    if (this.planSummary) parts.push(`Plan: ${this.planSummary}`);
    parts.push("All gates passed (test gate, review gate, final verification).");
    return parts.join("\n\n");
  }

  private docCandidatePaths(updates: string[]): string[] {
    const found = new Set<string>();
    for (const update of updates) {
      for (const m of update.matchAll(/[A-Za-z0-9._\-/]+\.(?:md|mdx|txt)/g)) {
        if (m[0]) found.add(m[0]);
      }
    }
    if (found.size === 0) {
      found.add("README.md");
      found.add("docs");
    }
    return [...found];
  }

  // ---------------------------------------------------------------- phases

  private async drive(): Promise<RunState> {
    for (;;) {
      const state = this.state!;
      if (this.bail()) return state;
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
          return state;
      }
      if (this.state === state) return state; // no progress: never spin
    }
  }

  private async phaseIntake(): Promise<void> {
    const base = await this.deps.git.recordBase(this.repoPath);
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
    const prompt = researchPrompt(this.state!.request, this.story, brief);
    const result = await this.runReadonlyAgent("researcher", prompt, this.repoPath);
    if (this.bail()) return;
    if (!result.ok) {
      await this.blockOnAgentFailure("researcher", result);
      return;
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
    const questions = result.completion?.questions ?? [];
    const material = questions.find(
      (q) => classifyQuestion({ severity: q.severity, text: q.question }) === "material",
    );
    if (material && !(await this.askMaterialQuestion("requirements approval", material))) {
      return; // now WAITING_FOR_USER (resumeState = REQUIREMENTS_APPROVAL)
    }
    await this.transition({
      to: "PLAN",
      approval: { artifact: "requirements.md", hash: requirementsHash },
      reason: "requirements approved",
    });
  }

  private async phaseRequirementsApproval(): Promise<void> {
    // Reached on resume after a headless answer(); approve and continue.
    const hash = hashContent(this.deps.artifacts.readArtifact("requirements.md") ?? "");
    await this.transition({
      to: "PLAN",
      approval: { artifact: "requirements.md", hash },
      reason: "requirements approved",
    });
  }

  private async phasePlan(): Promise<void> {
    let result: AgentRunResult | null = null;
    if (this.planFromReplan) {
      this.planFromReplan = false; // plan.md already produced by phaseReplan
    } else {
      const prompt = plannerPrompt(
        this.state!.request,
        this.deps.artifacts.readArtifact("requirements.md") ?? "",
        this.deps.artifacts.readArtifact("research.md") ?? "",
        null,
      );
      result = await this.runReadonlyAgent("planner", prompt, this.repoPath);
      if (this.bail()) return;
      if (!result.ok) {
        await this.blockOnAgentFailure("planner", result);
        return;
      }
      this.storePlanArtifacts(result);
    }
    const planHash = this.planHashOrCompute();
    await this.transition({
      to: "PLAN_APPROVAL",
      dependencies: { plan: planHash },
      reason: "plan drafted",
    });
    const questions = result?.completion?.questions ?? [];
    const material = questions.find(
      (q) => classifyQuestion({ severity: q.severity, text: q.question }) === "material",
    );
    if (material && !(await this.askMaterialQuestion("plan approval", material))) {
      return; // now WAITING_FOR_USER (resumeState = PLAN_APPROVAL)
    }
    await this.transition({
      to: "PREPARE_WORKTREES",
      approval: { artifact: "plan.md", hash: planHash },
      reason: "plan approved",
    });
  }

  private async phasePlanApproval(): Promise<void> {
    // Reached on resume after a headless answer(); approve and continue.
    await this.transition({
      to: "PREPARE_WORKTREES",
      approval: { artifact: "plan.md", hash: this.planHashOrCompute() },
      reason: "plan approved",
    });
  }

  private async phaseWorktrees(): Promise<void> {
    await this.ensureHandles();
    await this.transition({ to: "DEVELOP", reason: "worktrees ready" });
  }

  private async phaseDevelop(): Promise<void> {
    const handles = await this.ensureHandles();
    const requirements = this.deps.artifacts.readArtifact("requirements.md") ?? "";
    const developerTask = developerPrompt(
      this.state!.request,
      requirements,
      this.planTasks,
      this.reworkFeedback.developer,
    );
    const developerRun = this.runAgent("developer", developerTask, {
      cwd: handles.developer ?? this.repoPath,
      writableRoots: handles.developer ? [handles.developer] : [],
    });
    // Persist the transition before dispatching the second concurrent action.
    await this.transition({
      to: "WRITE_TESTS",
      reason: "developer agent dispatched; test writer starting in parallel",
    });
    const testWriterTask = testWriterPrompt(
      this.state!.request,
      requirements,
      this.planTasks,
      this.reworkFeedback.testWriter,
    );
    const testWriterRun = this.runAgent("testWriter", testWriterTask, {
      cwd: handles.tests ?? this.repoPath,
      writableRoots: handles.tests ? [handles.tests] : [],
    });
    const [devResult, testResult] = await Promise.all([developerRun, testWriterRun]);
    if (this.bail()) return;
    this.reworkFeedback = {};
    if (!devResult.ok) {
      await this.blockOnAgentFailure("developer", devResult);
      return;
    }
    this.deps.artifacts.writeArtifact("implementation.md", renderImplementationReport(devResult));
    this.deps.artifacts.writeArtifact(
      "developer.diff",
      await this.captureDiff(handles.developer, devResult),
    );
    if (!testResult.ok) {
      await this.blockOnAgentFailure("testWriter", testResult);
      return;
    }
    this.deps.artifacts.writeArtifact("tests.md", renderTestsReport(testResult));
    this.deps.artifacts.writeArtifact(
      "tests.diff",
      await this.captureDiff(handles.tests, testResult),
    );
    await this.transition({
      to: "INTEGRATE",
      reason: "implementation and tests complete",
      dependencies: {
        developerRevision: hashContent(devResult.rawText),
        testWriterRevision: hashContent(testResult.rawText),
      },
    });
  }

  private async phaseWriteTests(): Promise<void> {
    // Usually resolved inline by phaseDevelop; reached directly only on recovery.
    const handles = await this.ensureHandles();
    if (this.deps.artifacts.readArtifact("tests.diff") === null) {
      const result = await this.runAgent(
        "testWriter",
        testWriterPrompt(
          this.state!.request,
          this.deps.artifacts.readArtifact("requirements.md") ?? "",
          this.planTasks,
          undefined,
        ),
        { cwd: handles.tests ?? this.repoPath, writableRoots: handles.tests ? [handles.tests] : [] },
      );
      if (this.bail()) return;
      if (!result.ok) {
        await this.blockOnAgentFailure("testWriter", result);
        return;
      }
      this.deps.artifacts.writeArtifact("tests.md", renderTestsReport(result));
      this.deps.artifacts.writeArtifact(
        "tests.diff",
        await this.captureDiff(handles.tests, result),
      );
    }
    await this.transition({ to: "INTEGRATE", reason: "tests ready" });
  }

  private async phaseIntegrate(): Promise<void> {
    const handles = await this.ensureHandles();
    for (;;) {
      if (this.bail()) return;
      const integration = await this.deps.git.integrate(handles);
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
        const combined = [
          this.deps.artifacts.readArtifact("developer.diff") ?? "",
          this.deps.artifacts.readArtifact("tests.diff") ?? "",
        ].join("\n");
        this.deps.artifacts.writeArtifact("combined.diff", combined);
        await this.transition({
          to: "TEST_GATE",
          reason: "branches integrated",
          dependencies: { stagingRevision: hashContent(combined) },
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

  private async phaseTestGate(): Promise<void> {
    const handles = await this.ensureHandles();
    const staging = handles.staging ?? this.repoPath;
    const requirements = this.deps.artifacts.readArtifact("requirements.md") ?? "";
    const developerDiff = this.deps.artifacts.readArtifact("developer.diff") ?? "";
    const testsDiff = this.deps.artifacts.readArtifact("tests.diff") ?? "";
    const result = await runTestGate({
      stagingDir: staging,
      requirements,
      verificationContract: this.verificationContract,
      developerDiff,
      testsDiff,
      deps: {
        exec: this.executor,
        runTestRunnerAgent: (prompt: string) =>
          this.runReadonlyAgent("testRunner", prompt, staging),
      },
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
    const inputHash = hashContent(
      [developerDiff, testsDiff, this.verificationContract.join("\n")].join("\n"),
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
        dependencies: { stagingRevision: inputHash },
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
    this.reworkFeedback = {};
    if (owners.includes("developer")) this.reworkFeedback.developer = result.failureSummary;
    if (owners.includes("testWriter")) this.reworkFeedback.testWriter = result.failureSummary;
    await this.reworkAfterGateFailure("test", owners);
  }

  private async phaseReviewGate(): Promise<void> {
    const handles = await this.ensureHandles();
    const staging = handles.staging ?? this.repoPath;
    const combinedDiff = this.deps.artifacts.readArtifact("combined.diff") ?? "";
    const requirements = this.deps.artifacts.readArtifact("requirements.md") ?? "";
    const result = await runReviewGate({
      stagingDir: staging,
      combinedDiff,
      requirements,
      runReviewerAgent: (prompt: string) =>
        this.runReadonlyAgent("reviewer", prompt, staging),
    });
    if (this.bail()) return;
    this.deps.artifacts.recordEvidence(
      "reviews",
      JSON.stringify(result.findings, null, 2),
      "review-gate",
      "review-findings.json",
    );
    const inputHash = hashContent(combinedDiff);
    if (result.pass) {
      const next = nextCounters(this.state!.counters, "review", true);
      await this.setCounters(next);
      this.reviewerDocumentationUpdates = [...result.documentationUpdates];
      this.deps.events.append("gate_passed", "review gate passed", {});
      await this.transition({
        to: "DOCUMENTATION_UPDATE",
        reason: "review gate passed",
        dependencies: { stagingRevision: inputHash },
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
    this.reworkFeedback = {};
    if (owners.includes("developer")) {
      this.reworkFeedback.developer = result.findings
        .map((f) => `${f.severity} at ${f.path ?? "?"}: ${f.remediation}`)
        .join("\n");
    }
    if (owners.includes("testWriter")) {
      this.reworkFeedback.testWriter = result.findings
        .map((f) => `${f.severity} at ${f.path ?? "?"}: ${f.remediation}`)
        .join("\n");
    }
    await this.reworkAfterGateFailure("review", owners);
  }

  /** Gate-failure rework loop: DEVELOP → (rerun) → WRITE_TESTS → INTEGRATE. */
  private async reworkAfterGateFailure(gate: "test" | "review", owners: GateOwner[]): Promise<void> {
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
    await this.transition({ to: "INTEGRATE", reason: "rework complete; reintegrating" });
  }

  private async rerunForOwners(owners: GateOwner[], feedback: string): Promise<boolean> {
    this.reworkFeedback = {};
    if (owners.includes("developer")) this.reworkFeedback.developer = feedback;
    if (owners.includes("testWriter")) this.reworkFeedback.testWriter = feedback;
    if (owners.includes("developer")) {
      const ok = await this.rerunDeveloper();
      if (!ok || this.bail()) return false;
    }
    if (owners.includes("testWriter")) {
      const ok = await this.rerunTestWriter();
      if (!ok || this.bail()) return false;
    }
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
        this.planTasks,
        this.reworkFeedback.developer,
      ),
      {
        cwd: handles.developer ?? this.repoPath,
        writableRoots: handles.developer ? [handles.developer] : [],
      },
    );
    if (this.bail()) return false;
    this.reworkFeedback = {};
    if (!result.ok) {
      await this.blockOnAgentFailure("developer", result);
      return false;
    }
    this.deps.artifacts.writeArtifact("implementation.md", renderImplementationReport(result));
    this.deps.artifacts.writeArtifact(
      "developer.diff",
      await this.captureDiff(handles.developer, result),
    );
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
        this.planTasks,
        this.reworkFeedback.testWriter,
      ),
      {
        cwd: handles.tests ?? this.repoPath,
        writableRoots: handles.tests ? [handles.tests] : [],
      },
    );
    if (this.bail()) return false;
    this.reworkFeedback = {};
    if (!result.ok) {
      await this.blockOnAgentFailure("testWriter", result);
      return false;
    }
    this.deps.artifacts.writeArtifact("tests.md", renderTestsReport(result));
    this.deps.artifacts.writeArtifact(
      "tests.diff",
      await this.captureDiff(handles.tests, result),
    );
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
    this.planFromReplan = true;
  }

  private async phaseReplan(): Promise<void> {
    const history = this.deps.artifacts.readArtifact("failure-history.md")
      ?? "(no recorded failures)";
    const prompt = plannerPrompt(
      this.state!.request,
      this.deps.artifacts.readArtifact("requirements.md") ?? "",
      this.deps.artifacts.readArtifact("research.md") ?? "",
      history,
    );
    const result = await this.runReadonlyAgent("planner", prompt, this.repoPath);
    if (this.bail()) return;
    if (!result.ok) {
      await this.blockOnAgentFailure("planner", result);
      return;
    }
    this.replanEpoch += 1;
    this.storePlanArtifacts(result); // epoch header ⇒ plan hash changes
    this.planFromReplan = true;
    const newPlanHash = this.planHash;
    await this.transition({
      to: "PLAN",
      reason: `new plan produced by replan epoch ${this.replanEpoch}`,
      ...(newPlanHash !== null ? { dependencies: { plan: newPlanHash } } : {}),
    });
  }

  private async phaseDocumentationUpdate(): Promise<void> {
    const handles = await this.ensureHandles();
    const staging = handles.staging ?? this.repoPath;
    const updates = this.reviewerDocumentationUpdates;
    const result = await this.runAgent("reviewer", documentationPrompt(updates), {
      cwd: staging,
      writableRoots: [join(staging, "README.md"), join(staging, "docs"), join(staging, "website")],
    });
    if (this.bail()) return;
    if (!result.ok) {
      await this.blockOnAgentFailure("reviewer", result);
      return;
    }
    const candidates = this.docCandidatePaths(updates);
    const changedOnDisk = candidates.some((p) => existsSync(join(staging, p)));
    if (!changedOnDisk) {
      this.deps.events.append(
        "orchestrator_intervention",
        "documentation update produced no detectable file changes; logging intervention",
        { candidates, updates },
      );
      this.ui?.notify("gx-dev: documentation updates could not be verified on disk; intervention logged");
    }
    // Checkpoint documentation edits so final verification sees a clean tree.
    const docCommit = await this.deps.git.checkpointStaging(
      handles,
      "gx-dev checkpoint: documentation",
    );
    if (docCommit) {
      this.deps.events.append("commit_created", "documentation checkpoint committed", {
        commitHash: docCommit,
        worktree: "staging",
      });
    }
    await this.transition({ to: "FINAL_VERIFICATION", reason: "documentation updated" });
  }

  private async phaseFinalVerification(): Promise<void> {
    const handles = await this.ensureHandles();
    const staging = handles.staging ?? this.repoPath;
    const result = await runFinalGate({
      stagingDir: staging,
      verificationContract: this.verificationContract,
      exec: this.executor,
      requireCleanTree: this.deps.config.gates.requireCleanFinalTree,
      checkClean: async () => {
        const run = await this.executor.execute(staging, "git status --porcelain", COMMAND_TIMEOUT_MS);
        return run.exitCode === 0 && run.output.trim() === "";
      },
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
    if (result.pass) {
      this.deps.events.append("gate_passed", "final verification passed", {});
      await this.transition({ to: "COMMIT", reason: "final verification passed" });
      return;
    }
    const reason = `final verification failed: ${result.failures.join("; ")}`;
    this.deps.events.append("gate_failed", reason, { failures: result.failures });
    this.ui?.notify(`gx-dev: ${reason}`);
    await this.transition({ to: "BLOCKED", reason });
  }

  private async phaseCommit(): Promise<void> {
    const handles = await this.ensureHandles();
    const staging = handles.staging ?? this.repoPath;
    const summary = this.buildRunSummary();
    const result = await this.runReadonlyAgent("committer", committerPrompt(this.state!.request, summary), staging);
    if (this.bail()) return;
    if (!result.ok) {
      await this.blockOnAgentFailure("committer", result);
      return;
    }
    const completion =
      result.completion && "commitHash" in result.completion ? result.completion : null;
    // Deterministic message policy: the engine owns the commit message shape.
    // The committer's summary may inform the subject, but is never used
    // verbatim — live runs showed agents returning paragraph-length blobs.
    const fallback = buildCommitMessage(this.state!.request, this.state!.runId, summary);
    const advisedSubject = completion
      ? completion.summary.trim().split(/[.\n]/)[0]?.trim().slice(0, 72) ?? ""
      : "";
    const message =
      completion && completion.summary.trim() !== ""
        ? `${advisedSubject}\n\n${fallback.split("\n").slice(1).join("\n").trim()}\n\nAdvised-by: gx-dev committer agent (zai/glm-5.3-flash:max).`
        : fallback;
    // The engine performs the commit itself; the agent only advises.
    const commit = await this.deps.git.commitStaged(
      handles,
      message,
      this.state!.base?.branch ?? "main",
    );
    this.commitHash = commit.commitHash;
    this.deps.events.append(
      "commit_created",
      `commit ${commit.commitHash} created via ${commit.strategy}`,
      { ...commit, message },
    );
    this.deps.artifacts.writeArtifact(
      "result.md",
      renderResult(this.state!, commit, this.deps.artifacts.evidence()),
    );
    await this.transition({ to: "MEMORY_PROMOTION", reason: "commit created" });
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
    const proposals: MemoryProposal[] = [
      {
        page: featurePage,
        action: "create",
        body: [`# ${state.request}`, "", this.buildRunSummary()].join("\n"),
        provenance: [state.runId, this.commitHash ?? "unknown"],
        scope: "feature",
        freshness: now,
        verification: "verified",
        runId: state.runId,
      },
    ];
    if (this.reviewerDocumentationUpdates.length > 0) {
      proposals.push({
        page: `${featurePage}-documentation`,
        action: "update",
        body: this.reviewerDocumentationUpdates.join("\n"),
        provenance: [state.runId, this.commitHash ?? "unknown"],
        scope: "feature",
        freshness: now,
        verification: "verified",
        runId: state.runId,
      });
    }
    const reserved = await this.deps.memory.reserve(proposals);
    const { applied, conflicts } = await this.deps.memory.promote(reserved);
    this.deps.artifacts.writeArtifact("memory-proposal.md", JSON.stringify(reserved, null, 2));
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
