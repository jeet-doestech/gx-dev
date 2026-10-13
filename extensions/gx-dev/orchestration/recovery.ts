/**
 * Crash/restart recovery (PLAN §5): loads a persisted run and sanity-checks
 * it before the engine resumes driving the state machine.
 */

import type { RunStore } from "../domain/interfaces.ts";
import {
  questionAnswered,
  type RunState,
  type WorkflowStateName,
} from "../domain/state.ts";

/** Every valid state name; anything else means a corrupt state.json. */
const KNOWN_STATES: readonly WorkflowStateName[] = [
  "INTAKE",
  "RESEARCH",
  "REQUIREMENTS_APPROVAL",
  "PLAN",
  "PLAN_APPROVAL",
  "PREPARE_WORKTREES",
  "DEVELOP",
  "WRITE_TESTS",
  "INTEGRATE",
  "TEST_GATE",
  "REVIEW_GATE",
  "DOCUMENTATION_UPDATE",
  "FINAL_VERIFICATION",
  "COMMIT",
  "MEMORY_PROMOTION",
  "COMPLETE",
  "REPLAN",
  "WAITING_FOR_USER",
  "PAUSED",
  "CANCELLED",
  "BLOCKED",
  "RECOVERING",
  "ROLLING_BACK",
  "FAILED",
];

/**
 * Loads a run and applies recovery sanity checks: the state must exist, its
 * history must be non-empty, its current state name must be known, and its
 * failure counters must be intact. A legacy state without `execution` is
 * still recoverable (the engine hydrates an empty context); a state whose
 * `execution` field is corrupt (non-object) is refused — resuming with a
 * lost plan/contract could skip verification, so recovery fails closed.
 * Returns null when the run cannot be trusted.
 */
export async function recoverRun(
  runStore: RunStore,
  runId: string,
): Promise<RunState | null> {
  let state: RunState | null = null;
  try {
    state = await runStore.load(runId);
  } catch {
    return null;
  }
  if (!state) return null;
  if (!Array.isArray(state.history) || state.history.length === 0) return null;
  if (!KNOWN_STATES.includes(state.state)) return null;
  if (!state.counters || typeof state.counters !== "object") return null;
  for (const value of Object.values(state.counters)) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
  }
  if (state.execution !== undefined && !isPlainObject(state.execution)) return null;
  return state;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A run may be resumed from any state except the terminal ones. */
export function resumableFrom(state: WorkflowStateName): boolean {
  return state !== "COMPLETE" && state !== "CANCELLED" && state !== "FAILED";
}

/**
 * True when the run is parked on a question the user has not answered yet.
 * Resuming such a run must never advance it: `resume` never means approval.
 */
export function waitingOnUser(state: RunState): boolean {
  if (state.state !== "WAITING_FOR_USER") return false;
  return !questionAnswered(state.pendingQuestion);
}

// ------------------------------------------------------------------ COMMIT
// crash reconciliation (pure decision logic; the engine supplies git reads)

/** One inspected commit from the run's original branch history. */
export interface AppliedCommitCandidate {
  sha: string;
  /** Git tree id of the commit (`<sha>^{tree}`). */
  tree: string;
  /** Parent commit ids (first parent first). */
  parents: string[];
  /** Full commit message body. */
  message: string;
  /** True when the recorded base head is an ancestor of (or equal to) the sha. */
  baseIsAncestor: boolean;
}

/** Result of scanning branch history for a commit applied before a crash. */
export type AppliedCommitScan =
  | { kind: "none" }
  | { kind: "applied"; sha: string; mergeCommit: boolean }
  | { kind: "ambiguous"; shas: string[] };

/**
 * Recognizes a commit that a crashed COMMIT phase already applied (crash
 * between the `git merge` and the durable receipt). A match requires ALL of:
 * the run-id trailer in the commit message, the EXACT staging tree persisted
 * in the pre-apply intent, and ancestry from the recorded base head. More
 * than one match is ambiguous and must block — never overwrite.
 */
export function scanForAppliedCommit(
  candidates: readonly AppliedCommitCandidate[],
  input: { runIdTrailer: string; stagingTree: string },
): AppliedCommitScan {
  const matches = candidates.filter(
    (c) =>
      c.message.includes(input.runIdTrailer) &&
      c.tree === input.stagingTree &&
      c.baseIsAncestor,
  );
  if (matches.length === 1) {
    const only = matches[0]!;
    return { kind: "applied", sha: only.sha, mergeCommit: only.parents.length > 1 };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", shas: matches.map((m) => m.sha) };
  }
  return { kind: "none" };
}

/** Outcome of verifying a persisted commit receipt against the repository. */
export type ReceiptVerification =
  | { ok: true; mergeCommit: boolean }
  | { ok: false; reason: string };

/**
 * Verifies a receipted commit (execution.commitHash) still matches what the
 * engine applied: reachable from the run's original branch, carries the
 * run-id trailer, descends from the recorded base head, and — when an apply
 * intent exists — has exactly the intent's staging tree. Fails closed.
 */
export function verifyCommitReceipt(
  entry: AppliedCommitCandidate | null,
  input: {
    receiptedSha: string;
    runIdTrailer: string;
    stagingTree: string | null;
    baseBranch: string;
  },
): ReceiptVerification {
  if (entry === null) {
    return {
      ok: false,
      reason: `receipted commit ${input.receiptedSha} is not reachable from the recorded base branch ${input.baseBranch}`,
    };
  }
  if (!entry.message.includes(input.runIdTrailer)) {
    return {
      ok: false,
      reason: `receipted commit ${input.receiptedSha} does not carry the gx-dev run trailer`,
    };
  }
  if (input.stagingTree !== null && entry.tree !== input.stagingTree) {
    return {
      ok: false,
      reason: `receipted commit ${input.receiptedSha} tree does not match the persisted apply intent`,
    };
  }
  if (!entry.baseIsAncestor) {
    return {
      ok: false,
      reason: `receipted commit ${input.receiptedSha} does not descend from the recorded base`,
    };
  }
  return { ok: true, mergeCommit: entry.parents.length > 1 };
}
