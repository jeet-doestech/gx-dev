/**
 * Full-screen dashboard overlay (PLAN §11): state graph, recent events, active
 * counters, worktree paths, token usage, and gate status.
 *
 * Built on pi's documented overlay API (`ctx.ui.custom(..., { overlay: true })`,
 * extensions.md "Custom Components / Overlay Mode", tui.md "Overlays") with
 * keyboard input via `matchesKey` (tui.md "Keyboard Input"). While open, the
 * view refreshes itself from disk (state.json + events.jsonl) on an interval;
 * with no active run it binds to the newest recorded run instead. The refresh
 * timer is disposed when the overlay closes.
 */

import type { ContextUsage, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import type { Engine } from "../orchestration/engine.ts";
import type { GxEvent } from "../domain/events.ts";
import { JsonlEventStore } from "../domain/events.ts";
import { FsRunStore, runDir } from "../domain/persist.ts";
import type { RunState } from "../domain/state.ts";
import { isControl } from "../domain/state.ts";
import { WORKTREE_DIRNAME } from "../git/worktrees.ts";
import {
  countersSummary,
  EVENT_MESSAGE_MAX,
  formatElapsed,
  pipelinePositionOf,
  renderEvent,
  shortRunId,
  WORKFLOW_SEGMENTS,
  workflowCellStates,
} from "./renderers.ts";

/** Number of recent events shown in the scrollable window. */
export const DASHBOARD_EVENT_WINDOW = 20;

/**
 * How often the dashboard re-reads run state and events from disk while the
 * overlay is open (docs/tui.md "Overlays": overlay components are disposed
 * when closed and must not be reused, so the refresh timer is owned by
 * showDashboard() and cleared in a finally block around ctx.ui.custom()).
 */
export const DASHBOARD_REFRESH_MS = 2000;

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

const BAD_EVENT_TYPES = new Set(["agent_failed", "gate_failed", "escalation", "error"]);
const GOOD_EVENT_TYPES = new Set(["agent_completed", "gate_passed", "commit_created", "memory_promoted"]);

function eventColorToken(type: GxEvent["type"]): "error" | "success" | "warning" | "muted" {
  if (BAD_EVENT_TYPES.has(type)) return "error";
  if (GOOD_EVENT_TYPES.has(type)) return "success";
  if (type === "question_asked") return "warning";
  return "muted";
}

function usageFromEvents(events: readonly GxEvent[]): UsageTotals {
  const totals: UsageTotals = { inputTokens: 0, outputTokens: 0 };
  for (const e of events) {
    const data = e.data as { usage?: { inputTokens?: unknown; outputTokens?: unknown } } | undefined;
    const usage = data?.usage;
    if (!usage) continue;
    if (typeof usage.inputTokens === "number") totals.inputTokens += usage.inputTokens;
    if (typeof usage.outputTokens === "number") totals.outputTokens += usage.outputTokens;
  }
  return totals;
}

function worktreePathsFromEvents(events: readonly GxEvent[]): string[] {
  const paths: string[] = [];
  for (const e of events) {
    if (e.type !== "worktree_created") continue;
    const data = e.data as Record<string, unknown> | undefined;
    if (!data) continue;
    for (const key of ["path", "developer", "tests", "staging"]) {
      const v = data[key];
      if (typeof v === "string" && v.length > 0 && !paths.includes(v)) paths.push(v);
    }
  }
  return paths;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function gateLabel(theme: Theme, ok: boolean, consecutiveFailures: number): string {
  return ok
    ? theme.fg("success", "passing")
    : theme.fg("error", `failing (${consecutiveFailures} consecutive)`);
}

interface DashboardData {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly snapshot: DashboardSnapshot;
  readonly contextUsage: ContextUsage | undefined;
  readonly onClose: () => void;
}

/**
 * Everything the dashboard renders, replaced wholesale on each refresh tick.
 * `live` is true when `state` is the engine's in-process run (this session
 * drives it); false when the state/events come from disk for a recorded run
 * (no active run — the dashboard then shows the run it was opened with).
 */
interface DashboardSnapshot {
  readonly state: RunState | null;
  readonly events: readonly GxEvent[];
  readonly live: boolean;
}

class DashboardView implements Component {
  private scroll = 0;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private snapshot: DashboardSnapshot;
  private contextUsage: ContextUsage | undefined;
  private readonly onClose: () => void;

  constructor(data: DashboardData) {
    this.tui = data.tui;
    this.theme = data.theme;
    this.snapshot = data.snapshot;
    this.contextUsage = data.contextUsage;
    this.onClose = data.onClose;
  }

  /** Replaces the rendered data (refresh tick) and triggers a redraw. */
  applySnapshot(snapshot: DashboardSnapshot, contextUsage: ContextUsage | undefined): void {
    this.snapshot = snapshot;
    this.contextUsage = contextUsage;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const maxScroll = Math.max(0, this.snapshot.events.length - DASHBOARD_EVENT_WINDOW);
    if (matchesKey(data, Key.escape)) {
      this.onClose();
      return;
    }
    if (data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) this.scroll = Math.min(maxScroll, this.scroll + 3);
    else if (matchesKey(data, Key.down)) this.scroll = Math.max(0, this.scroll - 3);
    else if (matchesKey(data, Key.pageUp)) this.scroll = Math.min(maxScroll, this.scroll + 15);
    else if (matchesKey(data, Key.pageDown)) this.scroll = Math.max(0, this.scroll - 15);
    else return;
    this.tui.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.buildLines(width).map((line) => truncateToWidth(line, width));
  }

  private buildLines(width: number): string[] {
    const th = this.theme;
    const state = this.snapshot.state;
    const events = this.snapshot.events;
    const lines: string[] = [];
    const rule = th.fg("border", "\u2500".repeat(Math.min(width, 64)));

    if (state) {
      const startedAt = state.history[0]?.at ?? state.createdAt;
      const liveBadge = this.snapshot.live ? "" : th.fg("muted", " \u00B7 recorded (no active run)");
      lines.push(
        th.fg("accent", th.bold(`gx-dev run ${shortRunId(state.runId)}`)) +
          th.fg("muted", ` \u00B7 ${state.state} \u00B7 ${formatElapsed(startedAt)} \u00B7 ${countersSummary(state.counters)}`) +
          liveBadge,
      );
      lines.push(th.fg("dim", `request: ${state.request}`));
    } else {
      lines.push(th.fg("muted", th.bold("gx-dev \u00B7 no active run, no recorded run")));
    }
    lines.push(rule);

    // State graph: 8 segments with member pipeline states.
    lines.push(th.fg("muted", th.bold("WORKFLOW")));
    const currentBar = state
      ? isControl(state.state)
        ? state.resumeState ?? state.state
        : state.state
      : null;
    const currentPos = currentBar ? pipelinePositionOf(currentBar) : -1;
    const cellStates = currentBar
      ? workflowCellStates(currentBar)
      : WORKFLOW_SEGMENTS.map(() => "pending" as const);
    WORKFLOW_SEGMENTS.forEach((seg, i) => {
      const cell = cellStates[i] ?? "pending";
      const glyph =
        cell === "done"
          ? th.fg("success", "\u2588")
          : cell === "active"
            ? th.fg("accent", "\u2593")
            : th.fg("dim", "\u2591");
      const members = seg.states
        .map((s) => {
          if (s === currentBar) return th.fg("accent", th.bold(`[${s}]`));
          const pos = pipelinePositionOf(s);
          if (currentPos >= 0 && pos >= 0 && pos < currentPos) return th.fg("success", s);
          return th.fg("dim", s);
        })
        .join(th.fg("dim", " \u00B7 "));
      lines.push(`${glyph} ${seg.label.padEnd(9)}${members}`);
    });
    lines.push(rule);

    // Counters and gates.
    if (state) {
      const c = state.counters;
      lines.push(
        th.fg("muted", th.bold("COUNTERS")) +
          th.fg(
            "text",
            `  ${countersSummary(c)} \u00B7 infra retries: ${c.infrastructureRetries} \u00B7 total attempts: ${c.totalAttempts}`,
          ),
      );
      const gateEvents = events.filter(
        (e) => e.type === "gate_passed" || e.type === "gate_failed",
      ).length;
      lines.push(
        th.fg("muted", th.bold("GATES")) +
          th.fg("text", "  test: ") +
          gateLabel(th, c.testConsecutiveFailures === 0, c.testConsecutiveFailures) +
          th.fg("text", " \u00B7 review: ") +
          gateLabel(th, c.reviewConsecutiveFailures === 0, c.reviewConsecutiveFailures) +
          th.fg("dim", ` \u00B7 gate events: ${gateEvents}`),
      );

      // Worktrees: prefer run events, fall back to the conventional path.
      lines.push(th.fg("muted", th.bold("WORKTREES")));
      const paths = worktreePathsFromEvents(events);
      if (paths.length > 0) {
        for (const p of paths) lines.push(th.fg("text", `  ${p}`));
      } else {
        const root = join(dirname(state.repoPath), WORKTREE_DIRNAME, state.runId);
        lines.push(th.fg("dim", `  ${root} (pending)`));
      }
    }

    // Token usage: agent-reported usage plus the hosting session's context.
    const totals = usageFromEvents(events);
    if (totals.inputTokens > 0 || totals.outputTokens > 0 || this.contextUsage) {
      let tokensLine =
        th.fg("muted", th.bold("TOKENS")) +
        th.fg("text", `  agents: in ${formatTokens(totals.inputTokens)} \u00B7 out ${formatTokens(totals.outputTokens)}`);
      const cu = this.contextUsage;
      if (cu && cu.percent !== null) {
        tokensLine += th.fg(
          "dim",
          ` \u00B7 session ctx ${cu.percent}% of ${formatTokens(cu.contextWindow)}`,
        );
      }
      lines.push(tokensLine);
    }
    lines.push(rule);

    // Recent events, newest last, scrolled back with arrow keys.
    const total = events.length;
    const end = Math.max(0, total - this.scroll);
    const start = Math.max(0, end - DASHBOARD_EVENT_WINDOW);
    lines.push(
      th.fg("muted", th.bold("EVENTS")) +
        th.fg(
          "dim",
          total > 0
            ? `  ${start + 1}-${end} of ${total}  (\u2191\u2193 scroll)`
            : "  none recorded",
        ),
    );
    for (const e of events.slice(start, end)) {
      lines.push(th.fg(eventColorToken(e.type), `  ${renderEvent(e).slice(0, EVENT_MESSAGE_MAX + 24)}`));
    }
    lines.push("");
    lines.push(th.fg("dim", "\u2191/\u2193 scroll events \u00B7 esc/q close"));
    return lines;
  }
}

/**
 * Reads the run's events, preferring an engine-exposed accessor when one
 * exists, otherwise the append-only on-disk audit trail. A FRESH
 * JsonlEventStore is constructed per read: the class caches events after the
 * first read, so a shared instance would freeze the dashboard at open time.
 */
async function loadEvents(cwd: string, runId: string | null, engine: Engine): Promise<GxEvent[]> {
  const anyEngine = engine as { events?: () => unknown };
  if (typeof anyEngine.events === "function") {
    try {
      const events = await anyEngine.events();
      if (Array.isArray(events)) return events as GxEvent[];
    } catch {
      // fall back to the on-disk audit trail
    }
  }
  if (runId !== null) {
    try {
      return new JsonlEventStore(runDir(cwd, runId)).events();
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * One refresh tick: the engine's live status when it still owns the bound
 * run, otherwise state.json re-read from disk (another process may have
 * resumed the run); plus the events audit trail from disk. Disk state is
 * preferred over a staler live snapshot by `updatedAt` comparison.
 */
async function readSnapshot(
  cwd: string,
  engine: Engine,
  runId: string | null,
): Promise<DashboardSnapshot> {
  const liveState = engine.status();
  const live = liveState !== null && liveState.runId === runId;
  let state: RunState | null = live ? liveState : null;
  if (!live && runId !== null) {
    try {
      const diskState = await new FsRunStore(cwd).load(runId);
      if (diskState !== null && (state === null || diskState.updatedAt > state.updatedAt)) {
        state = diskState;
      }
    } catch {
      // keep the live/last-known state
    }
  }
  const events = await loadEvents(cwd, runId, engine);
  return { state, events, live };
}

/**
 * Shows the dashboard overlay for the engine's current run, or — when no run
 * is active — for the newest recorded run (history remains inspectable).
 * While open, state and events are re-read from disk on an interval and the
 * view re-renders; the timer is always cleared when the overlay closes
 * (finally around ctx.ui.custom), so no refresh outlives the component.
 * Resolves when the user closes it (esc/q). Falls back to a one-line status
 * in non-TUI modes.
 */
export async function showDashboard(ctx: ExtensionContext, engine: Engine): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("gx-dev dashboard requires interactive TUI mode; use /gx-dev status", "warning");
    return;
  }
  const live = engine.status();
  const runId = live?.runId
    ?? ((await new FsRunStore(ctx.cwd).list())[0]?.runId ?? null);
  const initial = await readSnapshot(ctx.cwd, engine, runId);
  const viewRef: { view: DashboardView | null } = { view: null };
  const refresh = async (): Promise<void> => {
    const view = viewRef.view;
    if (view === null) return; // overlay closed (or not yet opened)
    try {
      const snapshot = await readSnapshot(ctx.cwd, engine, runId);
      view.applySnapshot(snapshot, ctx.getContextUsage());
    } catch {
      // keep the last good frame; the next tick retries
    }
  };
  const timer = setInterval(() => {
    void refresh();
  }, DASHBOARD_REFRESH_MS);
  // Never hold the host process open just for the refresh timer.
  timer.unref();
  try {
    await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const view = new DashboardView({
          tui,
          theme,
          snapshot: initial,
          contextUsage: ctx.getContextUsage(),
          onClose: () => done(null),
        });
        viewRef.view = view;
        return view;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "85%",
          minWidth: 64,
          maxHeight: "95%",
        },
      },
    );
  } finally {
    // Proper disposal: the overlay component is discarded by pi on close;
    // drop our reference and stop the disk-refresh interval.
    clearInterval(timer);
    viewRef.view = null;
  }
}
