/**
 * gx-dev workflow state machine (PLAN §5).
 *
 * The extension — never an agent — owns these transitions. Every transition is
 * validated here and persisted before the next action begins. A transition
 * references the hashes of the artifacts it depends on so stale approvals
 * cannot be reused silently.
 */

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
 * listed artifact invalidates approvals derived from it.
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
  /** Choices offered; free text is always allowed. */
  choices?: string[];
  /** Answers recorded so far (one entry per ask). */
  answers: { answer: string; at: string }[];
  severity: "minor" | "material";
}

/**
 * Legal transitions. Control states may be entered from any non-terminal
 * pipeline state and return to their resume target when resolved.
 */
export const TRANSITIONS: Readonly<Record<PipelineStateName, readonly PipelineStateName[]>> = {
  INTAKE: ["RESEARCH"],
  RESEARCH: ["REQUIREMENTS_APPROVAL"],
  REQUIREMENTS_APPROVAL: ["PLAN"],
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
  return isControl(from) && isPipeline(to);
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
    createdAt: now,
    updatedAt: now,
  };
}

export function newRunId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `run-${t}-${r}`;
}
