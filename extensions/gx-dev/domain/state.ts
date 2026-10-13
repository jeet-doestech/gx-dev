/**
 * gx-dev workflow state machine (PLAN §5).
 *
 * The extension — never an agent — owns these transitions. Every transition is
 * validated here and persisted before the next action begins. A transition
 * references the hashes of the artifacts it depends on so stale approvals
 * cannot be reused silently.
 */

import { randomUUID } from "node:crypto";

import type { PlannerTask } from "./schemas.ts";

/** Canonical pipeline states. */
export type PipelineStateName =
  | "INTAKE"
  | "RESEARCH"
  | "REQUIREMENTS_APPROVAL"
  | "PLAN"
  | "PLAN_APPROVAL"
  | "PREPARE_WORKTREES"
  | "DEVELOP"
  | "WRITE_TESTS"
  | "INTEGRATE"
  | "TEST_GATE"
  | "REVIEW_GATE"
  | "DOCUMENTATION_UPDATE"
  | "FINAL_VERIFICATION"
  | "COMMIT"
  | "MEMORY_PROMOTION"
  | "COMPLETE"
  | "REPLAN";

/** Additional control states. */
export type ControlStateName =
  | "WAITING_FOR_USER"
  | "PAUSED"
  | "CANCELLED"
  | "BLOCKED"
  | "RECOVERING"
  | "ROLLING_BACK"
  | "FAILED";

export type WorkflowStateName = PipelineStateName | ControlStateName;

/** Terminal states: no outgoing transitions. */
export const TERMINAL_STATES: readonly WorkflowStateName[] = [
  "COMPLETE",
  "CANCELLED",
  "FAILED",
];

/** States that are entered by escalation and return through PLAN. */
export const REPLAN_STATE = "REPLAN" as const;

/** States that require a user decision before the run can proceed. */
export const USER_CHECKPOINT_STATES: readonly WorkflowStateName[] = [
  "REQUIREMENTS_APPROVAL",
  "PLAN_APPROVAL",
  "WAITING_FOR_USER",
];

/** Gate counters (PLAN §9). A pass resets only its own counter. */
export interface FailureCounters {
  testConsecutiveFailures: number;
  reviewConsecutiveFailures: number;
  integrationConsecutiveFailures: number;
  infrastructureRetries: number;
  totalAttempts: number;
}

export function initialCounters(): FailureCounters {
  return {
    testConsecutiveFailures: 0,
    reviewConsecutiveFailures: 0,
    integrationConsecutiveFailures: 0,
    infrastructureRetries: 0,
    totalAttempts: 0,
  };
}

/**
 * Hashes of the artifacts a decision or transition depends on. Any change to a
 * listed artifact invalidates approvals derived from it. Revisions captured
 * after integration are authoritative Git commit ids, never artifact hashes.
 */
export interface DependencyHashes {
  requirements?: string;
  research?: string;
  plan?: string;
  testPlan?: string;
  developerRevision?: string;
  testWriterRevision?: string;
  stagingRevision?: string;
  evidence?: string[];
}

/** Workflow positions that can carry user-facing questions or decisions. */
export type RunCheckpoint =
  | "requirements"
  | "plan"
  | "develop"
  | "test-gate"
  | "review-gate"
  | "documentation"
  | "commit";

/** One durably recorded user answer (material question, approval, confirm). */
export interface RunExecutionAnswer {
  checkpoint: RunCheckpoint;
  question: string;
  answer: string;
  kind: "approval" | "material-question" | "confirmation";
  at: string;
  /** Unique question instance (crypto randomUUID) this answer belongs to. */
  instanceId?: string;
}

/** A material question parked for the user; answered entries keep the text. */
export interface RunExecutionOpenQuestion {
  id: string;
  checkpoint: RunCheckpoint;
  question: string;
  context: string[];
  answer: string | null;
  at: string;
}

/**
 * Ledger of processed approval decisions (idempotent across re-drives).
 * Decisions bind to a unique question INSTANCE (crypto randomUUID), never to
 * the answer text: two identical "approve" answers are two distinct decision
 * instances, so a revised artifact must always be decided again.
 */
export interface RunExecutionDecision {
  checkpoint: RunCheckpoint;
  decision: "approved" | "rejected" | "amended";
  artifact: string;
  hash: string;
  /** Artifact content hash shown to the user when the question was asked. */
  askHash?: string;
  feedback: string | null;
  /** Unique question instance (crypto randomUUID) this decision consumed. */
  instanceId: string;
  /** True once the decision's transition was performed (replay guard). */
  actedOn?: boolean;
  at: string;
}

/**
 * One asked approval/confirmation question, persisted BEFORE the question is
 * shown (crash-safe). Answers and decisions reference it by instanceId; the
 * recorded artifactHash is what the user was shown, so an approval can be
 * rejected when the actual artifact differs.
 */
export interface RunExecutionApprovalAsk {
  instanceId: string;
  checkpoint: RunCheckpoint;
  question: string;
  /** Full artifact content hash at ask time; "" for artifact-less confirms. */
  artifactHash: string;
  at: string;
}

/**
 * Apply intent persisted BEFORE the final commit touches the user's branch
 * (REVIEW P1: crash between the git merge and the commit receipt). A crash
 * after the merge is recognized by the exact staging tree plus the run-id
 * trailer in the commit message and ancestry from baseHead; the result is
 * then reconciled without re-applying. Ambiguity blocks, never overwrites.
 */
export interface RunExecutionCommitIntent {
  /** Branch the result was being applied to (the run's original branch). */
  baseBranch: string;
  /** Repository HEAD the apply was anchored on (the run's recorded base). */
  baseHead: string;
  /** Staging branch tip at intent time. */
  stagingTip: string;
  /** Exact git tree of the staging branch tip at intent time. */
  stagingTree: string;
  /** The exact commit message to be used (contains the run-id trailer). */
  message: string;
  at: string;
}

/** Serializable failure-attempt record (mirrors escalation.FailureAttempt). */
export interface RunExecutionFailureAttempt {
  gate: string;
  owner: string;
  inputHash: string;
  findings: string[];
  action: string;
}

/**
 * Durable execution context (REVIEW P1 "restart recovery is incomplete"):
 * everything the engine needs to resume a run after a process restart
 * without re-running completed work or losing user decisions. Persisted as
 * the optional `execution` field of RunState; hydrated on resume.
 */
export interface RunExecution {
  /** Story document content supplied at start(). */
  story?: string;
  /** Tasks from the approved plan. */
  planTasks?: PlannerTask[];
  /** Runnable verification contract from the approved plan. */
  verificationContract?: string[];
  /** Plan summary line used for the commit message. */
  planSummary?: string | null;
  /** Current replan epoch (0 = original plan). */
  replanEpoch?: number;
  /** True when plan.md was produced by phaseReplan and PLAN must not re-run. */
  planFromReplan?: boolean;
  /** Documentation paths the reviewer asked to refresh. */
  documentationUpdates?: string[];
  /** Documentation phase finished (and passed the docs-only check). */
  documentationComplete?: boolean;
  /** Exact staging tree that passed final verification. */
  verifiedTree?: string;
  /** Final commit hash after a successful apply (the durable receipt). */
  commitHash?: string | null;
  /** Strategy reported for the applied/reconciled commit. */
  commitStrategy?: string | null;
  /** Rollback guidance for the applied/reconciled commit. */
  commitRollback?: string | null;
  /** Apply intent persisted before the final merge (crash reconciliation). */
  commitIntent?: RunExecutionCommitIntent | null;
  /** Commit message built by the engine (survives restart before apply). */
  commitMessage?: string;
  /** Developer+test-writer work finished and written to implementation/tests artifacts. */
  developComplete?: boolean;
  /** Per-owner rework feedback for the next rerun (never cross-cleared). */
  reworkFeedback?: { developer?: string; testWriter?: string };
  /** User rejection/amendment feedback routed back into research/planning. */
  revisionFeedback?: { requirements?: string; plan?: string };
  /** Full failure-attempt history rendered into failure-history.md. */
  failureAttempts?: RunExecutionFailureAttempt[];
  /** Every user answer recorded at a checkpoint. */
  answers?: RunExecutionAnswer[];
  /** Material questions awaiting (or holding) user answers. */
  openQuestions?: RunExecutionOpenQuestion[];
  /** Processed approval decisions, keyed by question instance id. */
  decisions?: RunExecutionDecision[];
  /** Approval/confirmation questions asked, persisted before each ask. */
  approvalAsks?: RunExecutionApprovalAsk[];
  /** Staging HEAD captured before the documentation agent runs (docs-only). */
  documentationBaseHead?: string;
}

export function initialExecution(): RunExecution {
  return {};
}

export interface RunState {
  /** Unique run id (ulid-like: timestamp + random suffix). */
  runId: string;
  /** Original user request, verbatim. */
  request: string;
  /** Path of the target repository (the user's project). */
  repoPath: string;
  /** Current state. */
  state: WorkflowStateName;
  /** Previous state, for recovery and UI. */
  previousState: WorkflowStateName | null;
  /** State the run should return to after a control state resolves. */
  resumeState: PipelineStateName | null;
  /** Git anchor recorded at intake. */
  base: {
    branch: string | null;
    commit: string | null;
    dirty: boolean;
  } | null;
  /** Failure counters. */
  counters: FailureCounters;
  /** Hashes of approved artifacts, keyed by artifact name. */
  approvals: Record<string, { hash: string; state: WorkflowStateName; at: string }>;
  /** Hash dependencies captured with the most recent transition. */
  dependencies: DependencyHashes;
  /** ISO timestamps of every state entry, for elapsed-time display. */
  history: { state: WorkflowStateName; at: string }[];
  /** Pending question to the user, if state is WAITING_FOR_USER. */
  pendingQuestion: PendingQuestion | null;
  /** Durable execution context; hydrated on restart (may be absent on legacy states). */
  execution?: RunExecution;
  createdAt: string;
  updatedAt: string;
}

export interface PendingQuestion {
  /** Why the orchestrator stopped. */
  reason: string;
  /** The question shown to the user. */
  question: string;
  /** Structured context the user needs to decide. */
  context: string[];
  /** Unique instance id (crypto randomUUID); answers/decisions cite it. */
  instanceId?: string;
  /** Full artifact hash shown with an approval question (binding). */
  artifactHash?: string;
  /** Choices offered; free text is always allowed. */
  choices?: string[];
  /** Answers recorded so far (one entry per ask). Blank answers never resolve. */
  answers: { answer: string; at: string }[];
  severity: "minor" | "material";
  /** Approval checkpoint decision vs a free-form agent question. */
  kind?: "approval" | "material-question" | "confirmation";
  /** Workflow position this question belongs to. */
  checkpoint?: RunCheckpoint;
}

/**
 * Legal transitions. Control states may be entered from any non-terminal
 * pipeline state and return to their resume target when resolved.
 * REQUIREMENTS_APPROVAL -> RESEARCH carries an explicit user rejection back
 * to research: the draft is revised with the user's feedback, never silently
 * approved.
 */
export const TRANSITIONS: Readonly<Record<PipelineStateName, readonly PipelineStateName[]>> = {
  INTAKE: ["RESEARCH"],
  RESEARCH: ["REQUIREMENTS_APPROVAL"],
  REQUIREMENTS_APPROVAL: ["PLAN", "RESEARCH"],
  PLAN: ["PLAN_APPROVAL"],
  PLAN_APPROVAL: ["PREPARE_WORKTREES", "REPLAN"],
  PREPARE_WORKTREES: ["DEVELOP"],
  DEVELOP: ["WRITE_TESTS", "INTEGRATE"],
  WRITE_TESTS: ["INTEGRATE", "DEVELOP"],
  INTEGRATE: ["TEST_GATE"],
  TEST_GATE: ["REVIEW_GATE", "DEVELOP", "WRITE_TESTS", "REPLAN"],
  REVIEW_GATE: [
    "DOCUMENTATION_UPDATE",
    "DEVELOP",
    "WRITE_TESTS",
    "REPLAN",
  ],
  DOCUMENTATION_UPDATE: ["FINAL_VERIFICATION"],
  FINAL_VERIFICATION: ["COMMIT"],
  COMMIT: ["MEMORY_PROMOTION"],
  MEMORY_PROMOTION: ["COMPLETE", "REPLAN"],
  COMPLETE: [],
  REPLAN: ["PLAN"],
};

/**
 * Returns true when `from -> to` is legal. Control-state entry is legal from
 * any non-terminal state; control-state exit must return to the recorded
 * resume target (or CANCELLED / FAILED from PAUSED/BLOCKED).
 */
export function canTransition(
  from: WorkflowStateName,
  to: WorkflowStateName,
): boolean {
  if (from === to) return false;
  if (TERMINAL_STATES.includes(from)) return false;
  if (TERMINAL_STATES.includes(to)) {
    return to === "COMPLETE" ? from === "MEMORY_PROMOTION" : true;
  }
  if (from === "REPLAN") {
    return to === "PLAN";
  }
  if (isPipeline(from) && isPipeline(to)) {
    return TRANSITIONS[from].includes(to);
  }
  // Pipeline -> control: any non-terminal pipeline state may pause/wait/block.
  if (isPipeline(from) && isControl(to)) return true;
  // Control -> pipeline: only back to a state the run was in (engine checks
  // resumeState; here we allow the exit and let the engine validate target).
  // Control -> BLOCKED is also legal: resolving a parked question can reveal
  // a blocking condition (e.g. the user declines the commit application).
  if (isControl(from)) {
    return to === "BLOCKED" || isPipeline(to);
  }
  return false;
}

export function isPipeline(s: WorkflowStateName): s is PipelineStateName {
  return s in TRANSITIONS;
}

export function isControl(s: WorkflowStateName): s is ControlStateName {
  return !isPipeline(s);
}

export interface TransitionInput {
  to: WorkflowStateName;
  dependencies?: DependencyHashes;
  approval?: { artifact: string; hash: string };
  pendingQuestion?: PendingQuestion | null;
  reason: string;
}

export type TransitionResult =
  | { ok: true; state: RunState }
  | { ok: false; error: string };

/**
 * Pure state transition. The caller is responsible for persisting the result
 * (`RunStore.save`) before starting the next action.
 */
export function applyTransition(
  state: RunState,
  input: TransitionInput,
): TransitionResult {
  if (!canTransition(state.state, input.to)) {
    return {
      ok: false,
      error: `illegal transition ${state.state} -> ${input.to}`,
    };
  }
  const now = new Date().toISOString();
  const approvals = { ...state.approvals };
  if (input.approval) {
    approvals[input.approval.artifact] = {
      hash: input.approval.hash,
      state: input.to,
      at: now,
    };
  }
  const resumeState = isControl(input.to)
    ? isPipeline(state.state)
      ? state.state
      : state.resumeState
    : state.resumeState;
  const next: RunState = {
    ...state,
    previousState: state.state,
    state: input.to,
    resumeState,
    approvals,
    dependencies: input.dependencies
      ? { ...state.dependencies, ...input.dependencies }
      : state.dependencies,
    pendingQuestion: input.pendingQuestion ?? null,
    history: [...state.history, { state: input.to, at: now }],
    updatedAt: now,
  };
  return { ok: true, state: next };
}

/** Creates the initial run state. */
export function createRunState(input: {
  runId: string;
  request: string;
  repoPath: string;
}): RunState {
  const now = new Date().toISOString();
  return {
    runId: input.runId,
    request: input.request,
    repoPath: input.repoPath,
    state: "INTAKE",
    previousState: null,
    resumeState: null,
    base: null,
    counters: initialCounters(),
    approvals: {},
    dependencies: {},
    history: [{ state: "INTAKE", at: now }],
    pendingQuestion: null,
    execution: initialExecution(),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Fresh unique question instance id: decisions and answers bind to this
 * instance (never to the answer text), so repeated identical answers after a
 * replan are distinct decisions instead of stale consumed approvals.
 */
export function newQuestionInstanceId(): string {
  return randomUUID();
}

/** True when the pending question has at least one non-blank answer. */
export function questionAnswered(q: PendingQuestion | null): boolean {
  return q !== null && q.answers.some((a) => a.answer.trim() !== "");
}

export function newRunId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `run-${t}-${r}`;
}
