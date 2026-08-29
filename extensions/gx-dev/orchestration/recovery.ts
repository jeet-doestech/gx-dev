/**
 * Crash/restart recovery (PLAN §5): loads a persisted run and sanity-checks
 * it before the engine resumes driving the state machine.
 */

import type { RunStore } from "../domain/interfaces.ts";
import type { RunState, WorkflowStateName } from "../domain/state.ts";

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
 * history must be non-empty, and its current state name must be known.
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
  return state;
}

/** A run may be resumed from any state except the terminal ones. */
export function resumableFrom(state: WorkflowStateName): boolean {
  return state !== "COMPLETE" && state !== "CANCELLED" && state !== "FAILED";
}
