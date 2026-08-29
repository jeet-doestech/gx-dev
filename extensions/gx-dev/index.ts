/**
 * gx-dev extension entry point (PLAN §11, §14).
 *
 * Registers the `/gx-dev` command group, builds the orchestration Engine with
 * pi-backed dependencies, installs the workflow widget, and wires engine
 * notifications into the widget and the question modal.
 *
 * pi APIs used (all per docs/extensions.md and docs/tui.md):
 * - pi.on("session_start") / pi.on("session_shutdown") — idempotent widget
 *   install and cleanup (session-scoped resources are never started in the
 *   extension factory itself)
 * - pi.registerCommand with getArgumentCompletions (flat command names; the
 *   "gx-dev" command dispatches subcommands from commands.GX_COMMANDS; the
 *   completion split lives in commands.gxArgumentCompletions)
 * - ctx.ui.setWidget component-factory overload (workflow widget)
 * - ctx.ui.custom overlay (dashboard, question modal, models picker)
 * - ctx.ui.notify degrade paths in non-TUI modes
 * - ctx.modelRegistry (synchronous getAvailable read) for model completions
 *
 * The Engine consumes `EngineDeps` (orchestration/engine.ts): runner, git,
 * memory, runStore, artifacts, events, config, ui. The event and artifact
 * stores are per-run directories chosen by a run id the engine generates
 * internally, so this slice wires lazy delegating stores that bind to
 * `.gx-dev/runs/<run-id>/` as soon as the engine reports a run.
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Engine } from "./orchestration/engine.ts";
import type { EngineDeps } from "./orchestration/engine.ts";
import { PiAgentRunner } from "./agents/runner.ts";
import { GitWorktreeManager } from "./git/worktrees.ts";
import { FsMemoryStore } from "./memory/store.ts";
import { FsRunStore, runDir } from "./domain/persist.ts";
import { FsArtifactStore } from "./domain/artifacts.ts";
import type { ArtifactStore, EvidenceRecord } from "./domain/artifacts.ts";
import { JsonlEventStore } from "./domain/events.ts";
import type { EventStore, GxEvent, GxEventType } from "./domain/events.ts";
import { defaultConfig, loadConfig } from "./config.ts";
import type { GxConfig } from "./config.ts";
import {
  findGxCommand,
  gxArgumentCompletions,
  gxUsageText,
  resolveAgentsDir,
  setEngineResetHook,
  setOutputSink,
} from "./commands.ts";
import { createWorkflowWidget } from "./ui/workflow-widget.ts";
import type { GxWorkflowWidget } from "./ui/workflow-widget.ts";
import { createQuestionUI } from "./ui/questions.ts";

let activeCtx: ExtensionContext | null = null;
let activeEngine: Engine | null = null;
let enginePromise: Promise<Engine> | null = null;
let widget: GxWorkflowWidget | null = null;
let bufferedAnswer: string | null = null;

/** The shared Engine instance for this session, or null until first use. */
export function getActiveEngine(): Engine | null {
  return activeEngine;
}

/**
 * Invalidates the shared engine so the next getEngine() builds a fresh one
 * (fresh PiAgentRunner, fresh config). Called after /gx-dev models persists a
 * new per-role model selection.
 */
export function resetActiveEngine(): void {
  activeEngine = null;
  enginePromise = null;
}

/** Buffer a free-text answer for the next question (degraded/no-TUI flows). */
export function bufferAnswer(text: string): void {
  bufferedAnswer = text;
}

/**
 * EventStore that binds lazily to `.gx-dev/runs/<run-id>/events.jsonl`. The
 * engine generates the run id inside start(), after setting its state, so the
 * resolver sees the id before the first append; "current" is a safety net.
 */
class DeferredEventStore implements EventStore {
  private bound: JsonlEventStore | null = null;
  private boundRunId: string | null = null;
  private readonly repoPath: string;
  private readonly resolveRunId: () => string | null;

  constructor(repoPath: string, resolveRunId: () => string | null) {
    this.repoPath = repoPath;
    this.resolveRunId = resolveRunId;
  }

  private store(): JsonlEventStore {
    const runId = this.resolveRunId() ?? "current";
    if (this.bound === null || this.boundRunId !== runId) {
      this.bound = new JsonlEventStore(runDir(this.repoPath, runId));
      this.boundRunId = runId;
    }
    return this.bound;
  }

  append(type: GxEventType, message: string, data?: Record<string, unknown>): GxEvent {
    return this.store().append(type, message, data);
  }

  events(): GxEvent[] {
    if (this.bound === null && this.resolveRunId() === null) return [];
    return this.store().events();
  }
}

/** ArtifactStore delegating to the per-run evidence directory, bound lazily. */
class DeferredArtifactStore implements ArtifactStore {
  private bound: FsArtifactStore | null = null;
  private boundRunId: string | null = null;
  private readonly repoPath: string;
  private readonly resolveRunId: () => string | null;

  constructor(repoPath: string, resolveRunId: () => string | null) {
    this.repoPath = repoPath;
    this.resolveRunId = resolveRunId;
  }

  private store(): FsArtifactStore {
    const runId = this.resolveRunId() ?? "current";
    if (this.bound === null || this.boundRunId !== runId) {
      this.bound = new FsArtifactStore(runDir(this.repoPath, runId));
      this.boundRunId = runId;
    }
    return this.bound;
  }

  get runDir(): string {
    return this.store().runDir;
  }

  recordEvidence(
    kind: Parameters<ArtifactStore["recordEvidence"]>[0],
    content: string,
    source: string,
    name?: string,
  ): EvidenceRecord {
    return this.store().recordEvidence(kind, content, source, name);
  }

  readArtifact(name: string): string | null {
    return this.store().readArtifact(name);
  }

  writeArtifact(name: string, content: string): string {
    return this.store().writeArtifact(name, content);
  }

  evidence(): EvidenceRecord[] {
    if (this.bound === null && this.resolveRunId() === null) return [];
    return this.store().evidence();
  }
}

async function buildEngine(ctx: ExtensionContext): Promise<Engine> {
  const repoPath = ctx.cwd;
  let config: GxConfig;
  try {
    config = await loadConfig(repoPath);
  } catch {
    config = defaultConfig();
  }

  // The engine instance is closed over so the deferred stores can resolve the
  // active run id the moment the engine publishes its state.
  let engineRef: Engine | null = null;
  const resolveRunId = (): string | null => engineRef?.status()?.runId ?? null;

  const deps: EngineDeps = {
    config,
    ui: createQuestionUI(ctx, {
      takeBufferedAnswer: () => {
        const answer = bufferedAnswer;
        bufferedAnswer = null;
        return answer;
      },
      onNotify: () => {
        void refreshWidget();
      },
    }),
    runner: new PiAgentRunner({ config, agentsDir: resolveAgentsDir() }),
    git: new GitWorktreeManager(),
    memory: new FsMemoryStore(join(repoPath, ".gx-dev", "memory"), {
      redact: config.memory.redactSecrets,
    }),
    runStore: new FsRunStore(repoPath),
    artifacts: new DeferredArtifactStore(repoPath, resolveRunId),
    events: new DeferredEventStore(repoPath, resolveRunId),
  };
  const engine = new Engine(repoPath, deps);
  engineRef = engine;
  return engine;
}

function getEngine(): Promise<Engine> {
  if (activeEngine !== null) return Promise.resolve(activeEngine);
  if (enginePromise === null) {
    const ctx = activeCtx;
    if (ctx === null) return Promise.reject(new Error("gx-dev: no active session"));
    // The build result is only adopted while enginePromise still points at
    // this in-flight build — resetActiveEngine() may drop it concurrently.
    const p: Promise<Engine> = buildEngine(ctx)
      .then((engine) => {
        if (enginePromise === p) activeEngine = engine;
        return engine;
      })
      .catch((e: unknown) => {
        if (enginePromise === p) enginePromise = null;
        throw e;
      });
    enginePromise = p;
  }
  return enginePromise;
}

/** Engine notifications and command completions feed the workflow widget. */
async function refreshWidget(): Promise<void> {
  if (widget === null || activeEngine === null) return;
  try {
    widget.update(activeEngine.status());
  } catch {
    // Engine not ready or shut down; widget keeps its previous content.
  }
}

async function dispatch(
  cmdCtx: ExtensionCommandContext,
  rawArgs: string,
): Promise<void> {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0 || trimmed === "help") {
    cmdCtx.ui.notify(`gx-dev commands:\n${gxUsageText()}`, "info");
    return;
  }
  const spaceIdx = trimmed.indexOf(" ");
  const name = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const command = findGxCommand(name);
  if (!command) {
    cmdCtx.ui.notify(`Unknown gx-dev command "${name}".\n${gxUsageText()}`, "warning");
    return;
  }
  try {
    const engine = await getEngine();
    await command.handler(cmdCtx, engine, rest);
    await refreshWidget();
  } catch (e) {
    cmdCtx.ui.notify(`gx-dev ${name} failed: ${(e as Error).message}`, "error");
  }
}

export default function activate(pi: ExtensionAPI): void {
  // Commands that persist model selections invalidate the shared engine via
  // this hook (commands.ts cannot import index.ts without a cycle).
  setEngineResetHook(resetActiveEngine);

  // Durable command output: persistent, TUI-only transcript entries (never
  // sent to the LLM). Registered once; level colors follow the active theme.
  pi.registerEntryRenderer("gx-dev-output", (entry, _opts, theme) => {
    const data = entry.data as { text?: string; level?: string };
    const level = data?.["level"];
    const text = typeof data?.["text"] === "string" ? data["text"] : "";
    const color = (t: typeof theme, s: string): string =>
      level === "error" ? t.fg("error", s)
      : level === "warning" ? t.fg("warning", s)
      : t.fg("muted", s);
    const lines = text.split("\n");
    const children = lines.map((l) => new Text(color(theme, l === "" ? " " : l)));
    const box = new Box(1, 1);
    for (const child of children) box.addChild(child);
    return box;
  });
  setOutputSink((text, level) => {
    pi.appendEntry("gx-dev-output", { text, level });
  });

  // Widget install happens on session_start (not in the factory) because UI
  // access requires an ExtensionContext and session-scoped resources must not
  // start from the extension factory.
  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    if (ctx.mode === "tui") {
      widget = createWorkflowWidget(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    widget?.dispose();
    widget = null;
    activeEngine = null;
    enginePromise = null;
    activeCtx = null;
    bufferedAnswer = null;
    setOutputSink(null);
  });

  pi.registerCommand("gx-dev", {
    description: "gx-dev multi-agent workflow control (start/status/dashboard/...)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null =>
      gxArgumentCompletions(prefix, activeCtx),
    handler: (args: string, cmdCtx: ExtensionCommandContext) => dispatch(cmdCtx, args),
  });
}
