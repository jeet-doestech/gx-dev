/**
 * Compact workflow widget rendered above the editor (PLAN §11).
 *
 * Uses pi's documented widget API (`ctx.ui.setWidget` with a component
 * factory, extensions.md "Widgets, Status, and Footer" / tui.md Pattern 5).
 * The factory receives the active theme so all color comes from theme tokens.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { RunState, WorkflowStateName } from "../domain/state.ts";
import { isControl } from "../domain/state.ts";
import {
  CONTROL_GLYPHS,
  countersSummary,
  formatElapsed,
  shortRunId,
  workflowCellStates,
} from "./renderers.ts";

const WIDGET_KEY = "gx-dev-workflow";

export interface GxWorkflowWidget {
  /** Feed the latest run state; null clears the widget content. */
  update(state: RunState | null): void;
  /** Remove the widget entirely. */
  dispose(): void;
}

function barCells(theme: Theme, state: WorkflowStateName): string {
  return workflowCellStates(state)
    .map((c) => {
      if (c === "done") return theme.fg("success", "\u2588");
      if (c === "active") return theme.fg("accent", "\u2593");
      return theme.fg("dim", "\u2591");
    })
    .join(theme.fg("dim", "\u2502"));
}

/** Widget lines for the current state; already theme-colored. */
export function renderWidgetLines(theme: Theme, state: RunState | null): string[] {
  if (!state) return [];
  const lines: string[] = [];
  const barState = isControl(state.state)
    ? state.resumeState ?? state.state
    : state.state;
  const glyph = CONTROL_GLYPHS[state.state] ?? "";
  const startedAt = state.history[0]?.at ?? state.createdAt;
  const head = [
    barCells(theme, barState),
    theme.fg("accent", state.state),
    glyph !== undefined ? theme.fg("warning", glyph) : "",
    theme.fg(
      "muted",
      `${formatElapsed(startedAt)} \u00B7 ${countersSummary(state.counters)}`,
    ),
  ]
    .filter((part) => part !== "")
    .join(" ");
  lines.push(head);
  const tail = `run ${shortRunId(state.runId)} \u00B7 ${state.request}`;
  lines.push(theme.fg("dim", tail));
  if (state.state === "WAITING_FOR_USER" && state.pendingQuestion) {
    lines.push(
      theme.fg(
        "warning",
        `\u231B ${state.pendingQuestion.question} \u2014 /gx-dev answer <text> or /gx-dev dashboard`,
      ),
    );
  } else if (state.state === "PAUSED") {
    lines.push(
      theme.fg("warning", "\u23F8 paused \u2014 /gx-dev resume to continue"),
    );
  }
  return lines;
}

export function createWorkflowWidget(ctx: ExtensionContext): GxWorkflowWidget {
  let current: RunState | null = null;
  let disposed = false;

  const install = (): void => {
    if (disposed) return;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        render: (width: number): string[] =>
          renderWidgetLines(theme, current).map((line) =>
            truncateToWidth(line, width),
          ),
        invalidate: (): void => {},
      }),
      { placement: "aboveEditor" },
    );
  };

  install();

  return {
    update(state: RunState | null): void {
      if (disposed) return;
      current = state;
      if (state === null) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      install();
    },
    dispose(): void {
      disposed = true;
      current = null;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    },
  };
}
