/**
 * Pure formatting helpers for the gx-dev TUI (PLAN §11).
 *
 * No pi imports: these functions are plain string formatters over the domain
 * model so they stay trivially unit-testable. Color is applied by the caller
 * with the active pi theme; everything returned here is theme-neutral.
 */

import type { GxEvent } from "../domain/events.ts";
import type { RunState, WorkflowStateName } from "../domain/state.ts";
import { isControl, TERMINAL_STATES } from "../domain/state.ts";

/** Maximum rendered length of an event message. */
export const EVENT_MESSAGE_MAX = 100;

/** A coarse pipeline segment. Eight segments cover the PLAN §5 pipeline. */
export interface WorkflowSegment {
  readonly label: string;
  readonly states: readonly WorkflowStateName[];
}

/**
 * Pipeline states folded into 8 display segments:
 * INTAKE, RESEARCH, APPROVE, WORKTREE, BUILD, GATES, FINALIZE, COMPLETE.
 */
export const WORKFLOW_SEGMENTS: readonly WorkflowSegment[] = [
  { label: "INTAKE", states: ["INTAKE"] },
  { label: "RESEARCH", states: ["RESEARCH"] },
  {
    label: "APPROVE",
    states: ["REQUIREMENTS_APPROVAL", "PLAN", "PLAN_APPROVAL"],
  },
  { label: "WORKTREE", states: ["PREPARE_WORKTREES"] },
  { label: "BUILD", states: ["DEVELOP", "WRITE_TESTS", "INTEGRATE"] },
  { label: "GATES", states: ["TEST_GATE", "REVIEW_GATE"] },
  {
    label: "FINALIZE",
    states: ["DOCUMENTATION_UPDATE", "FINAL_VERIFICATION", "COMMIT"],
  },
  { label: "COMPLETE", states: ["MEMORY_PROMOTION", "COMPLETE"] },
];

/** Pipeline states flattened in display order (for progress computations). */
export const PIPELINE_ORDER: readonly WorkflowStateName[] =
  WORKFLOW_SEGMENTS.flatMap((s) => [...s.states]);

/** Index of the segment containing `state`, or -1 when unmapped. */
export function segmentIndexFor(state: WorkflowStateName): number {
  return WORKFLOW_SEGMENTS.findIndex((s) => s.states.includes(state));
}

/** Position of a state in the flattened pipeline, or -1 when unmapped. */
export function pipelinePositionOf(state: WorkflowStateName): number {
  return PIPELINE_ORDER.indexOf(state);
}

export type WorkflowCellState = "done" | "active" | "pending";

/**
 * Cell classification for the 8-segment bar. Control states and REPLAN do not
 * advance pipeline segments: every cell stays "pending" and callers should
 * surface the control marker separately (see CONTROL_GLYPHS).
 */
export function workflowCellStates(state: WorkflowStateName): WorkflowCellState[] {
  if (isControl(state) || state === "REPLAN") {
    return WORKFLOW_SEGMENTS.map(() => "pending" as const);
  }
  const idx = segmentIndexFor(state);
  const finished = state === "COMPLETE";
  return WORKFLOW_SEGMENTS.map((_, i): WorkflowCellState => {
    if (finished || i < idx) return "done";
    if (i === idx) return "active";
    return "pending";
  });
}

/** Glyphs shown for control/escalation states next to the segment bar. */
export const CONTROL_GLYPHS: Readonly<Record<string, string>> = {
  WAITING_FOR_USER: "\u231B", // hourglass
  PAUSED: "\u23F8", // double vertical bar
  CANCELLED: "\u2717", // ballot X
  BLOCKED: "\u26D4", // no entry
  RECOVERING: "\u21BB", // clockwise arrow
  ROLLING_BACK: "\u21A9", // leftwards arrow with hook
  FAILED: "\u2717",
  REPLAN: "\u21BA", // anticlockwise arrow
};

/**
 * Compact 8-segment progress bar, e.g. `█│█│▓│░│░│░│░│░ GATES ⌛`.
 * Unicode box/block characters only; no color — the caller applies theme.
 */
export function renderWorkflowBar(state: WorkflowStateName): string {
  const cells = workflowCellStates(state)
    .map((c) => (c === "done" ? "\u2588" : c === "active" ? "\u2593" : "\u2591"))
    .join("\u2502");
  const idx = segmentIndexFor(state);
  const label = idx >= 0 ? WORKFLOW_SEGMENTS[idx]?.label ?? "" : "";
  const glyph = CONTROL_GLYPHS[state];
  const parts = [cells];
  if (label) parts.push(label);
  if (glyph !== undefined) parts.push(glyph);
  return parts.join(" ");
}

/** Run id with the conventional `run-` prefix removed, capped for display. */
export function shortRunId(runId: string, max = 16): string {
  const bare = runId.startsWith("run-") ? runId.slice(4) : runId;
  return bare.length > max ? bare.slice(0, max) : bare;
}

/** Human elapsed time from an ISO timestamp to `now`: 45s / 3m12s / 1h04m. */
export function formatElapsed(fromIso: string, now: Date = new Date()): string {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return "?";
  let secs = Math.max(0, Math.floor((now.getTime() - from) / 1000));
  const days = Math.floor(secs / 86400);
  secs -= days * 86400;
  const hours = Math.floor(secs / 3600);
  secs -= hours * 3600;
  const mins = Math.floor(secs / 60);
  secs -= mins * 60;
  const two = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  if (days > 0) return `${days}d${two(hours)}h`;
  if (hours > 0) return `${hours}h${two(mins)}m`;
  if (mins > 0) return `${mins}m${two(secs)}s`;
  return `${secs}s`;
}

/** Gate counters summary, e.g. `T:1 R:0 I:0` (test/review/integration). */
export function countersSummary(counters: RunState["counters"]): string {
  return [
    `T:${counters.testConsecutiveFailures}`,
    `R:${counters.reviewConsecutiveFailures}`,
    `I:${counters.integrationConsecutiveFailures}`,
  ].join(" ");
}

/**
 * One-line run summary: short run id, state, elapsed since the first history
 * entry, and the gate counters, e.g.
 * `run lz3k1a-x9y2z1 · PLAN_APPROVAL · 4m12s · T:0 R:0 I:0`
 */
export function renderStateLine(state: RunState, now: Date = new Date()): string {
  const startedAt = state.history[0]?.at ?? state.createdAt;
  const parts = [
    `run ${shortRunId(state.runId)}`,
    state.state,
    formatElapsed(startedAt, now),
    countersSummary(state.counters),
  ];
  return parts.join(" \u00B7 ");
}

/** Truncate a message to at most `max` visible characters with an ellipsis. */
export function truncateMessage(message: string, max = EVENT_MESSAGE_MAX): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, Math.max(1, max - 1)) + "\u2026";
}

/** One-line event rendering: `#42 agent_completed developer finished in 31s`. */
export function renderEvent(e: GxEvent): string {
  return `#${e.seq} ${e.type} ${truncateMessage(e.message)}`;
}

/** True when the run has reached a terminal state. */
export function isTerminalState(state: WorkflowStateName): boolean {
  return TERMINAL_STATES.includes(state);
}
