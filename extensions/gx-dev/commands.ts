/**
 * Declarative /gx-dev command table (PLAN §11, v1 subset).
 *
 * index.ts registers these under the single `gx-dev` command name (pi's
 * registerCommand API is flat — extensions.md "pi.registerCommand") and
 * dispatches on the first argument word. Handlers receive the shared,
 * lazily-constructed engine instance plus the raw argument remainder.
 *
 * The `models` command manages per-subagent model selection: the bare form
 * opens the interactive picker (ui/models-picker.ts), `show` prints the
 * effective per-role resolution, and `set <role> <spec>` persists a direct
 * selection. Persistence goes through config.ts merge/unset helpers; after a
 * change the shared engine is invalidated via the reset hook installed by
 * index.ts (resetActiveEngine) so the next start rebuilds its runner.
 *
 * gxArgumentCompletions backs the command's getArgumentCompletions
 * (extensions.md "pi.registerCommand"): arg 1 → set|show, arg 2 (set) →
 * MODEL_ROLE_KEYS, arg 3 (set) → available model refs from the session
 * registry (ctx.modelRegistry.getAvailable() is a synchronous read per the
 * docs, so no async completion is needed) plus "inherit". Returned values
 * replace the whole argument text, so committed words are re-attached.
 *
 * Trust policy (REVIEW P0 "Project configuration bypasses pi trust"): every
 * command that would honor project configuration containing an executable
 * (agents.piBinary), execute repository operations, or start/resume runs
 * first checks ctx.isProjectTrusted(). An untrusted project's
 * .gx-dev/config.json is never read for execution decisions and its
 * configured binary is never spawned by doctor/models. Model selections are
 * also rejected BEFORE persisting while a run is active (the engine reset
 * hook is a backstop, not the guard — the precheck uses the engine argument).
 *
 * Rollback is intentionally NOT implemented as a command (REVIEW P1: the
 * engine's emitted guidance is history-preserving `git revert`; a destructive
 * reset-based command would be an arbitrary footgun). Cleanup of finished
 * runs goes only through GitWorktreeManager.cleanup with an explicit run id,
 * never while a run is active, and never with force flags.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { Engine } from "./orchestration/engine.ts";
import { AGENT_ROLES } from "./domain/schemas.ts";
import { FsRunStore, runDir } from "./domain/persist.ts";
import type { RunState } from "./domain/state.ts";
import { questionAnswered, TERMINAL_STATES } from "./domain/state.ts";
import { EVIDENCE_MANIFEST_FILE, loadEvidenceManifest } from "./domain/artifacts.ts";
import type { EvidenceRecord } from "./domain/artifacts.ts";
import { git } from "./git/repository.ts";
import { GitWorktreeManager, WORKTREE_DIRNAME } from "./git/worktrees.ts";
import { FsMemoryStore } from "./memory/store.ts";
import { matchModel } from "./agents/models.ts";
import {
  INHERIT_MODEL,
  MODEL_ROLE_KEYS,
  defaultConfig,
  isValidModelSelection,
  loadConfig,
  mergeModelSelection,
} from "./config.ts";
import type { GxConfig, ModelRoleKey } from "./config.ts";
import {
  loadAvailableModelsBudgeted,
  loadRoleModelSources,
  renderOverviewText,
  resolveAllRoleOverviews,
  resolveRoleOverview,
  sessionModelLabel,
  showModelsPicker,
} from "./ui/models-picker.ts";
import { renderStateLine } from "./ui/renderers.ts";
import { showDashboard } from "./ui/dashboard.ts";

export interface GxCommand {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly handler: (
    ctx: ExtensionCommandContext,
    engine: Engine,
    args: string,
  ) => Promise<void>;
}

/**
 * Resolves the packaged agents directory (the 7 role prompt files) relative
 * to this module. Probes both the source layout (<pkg>/agents) and the
 * deeper packaged layout in case a bundler shifts this file.
 */
export function resolveAgentsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "..", "..", "agents"),
    resolve(moduleDir, "..", "..", "..", "..", "agents"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "researcher.md"))) return dir;
  }
  return candidates[0] ?? moduleDir;
}

/** AgentRole ("testWriter") -> packaged prompt file name ("test-writer.md"). */
function roleFile(role: string): string {
  return role.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`) + ".md";
}

let engineResetHook: (() => void) | null = null;

/** index.ts installs resetActiveEngine here during activate(). */
export function setEngineResetHook(hook: () => void): void {
  engineResetHook = hook;
}

export type GxOutputLevel = "info" | "warning" | "error";
type OutputSink = (text: string, level: GxOutputLevel) => void;
let outputSink: OutputSink | null = null;

/**
 * Registers the persistent output channel (pi.appendEntry renderer wired in
 * index.ts). Until set — or outside the TUI — gxOut falls back to toasts.
 */
export function setOutputSink(sink: OutputSink | null): void {
  outputSink = sink;
}

/** Durable command output: persistent transcript entry when available. */
export function gxOut(
  ctx: ExtensionCommandContext,
  text: string,
  level: GxOutputLevel = "info",
): void {
  if (outputSink !== null) {
    outputSink(text, level);
    return;
  }
  ctx.ui.notify(text, level);
}
function resetEngineViaHook(): void {
  engineResetHook?.();
}

/** True while the engine holds a run that has not reached a terminal state. */
function runActive(engine: Engine): boolean {
  const state: RunState | null = engine.status();
  return state !== null && !TERMINAL_STATES.includes(state.state);
}

/**
 * Guards repository-affecting / config-honoring commands behind pi's project
 * trust. Returns false (after notifying) when the project is untrusted.
 */
function requireProjectTrust(
  ctx: ExtensionCommandContext,
  action: string,
): boolean {
  if (ctx.isProjectTrusted()) return true;
  gxOut(
    ctx,
    `gx-dev: ${action} refused — project "${ctx.cwd}" is not trusted, so project configuration ` +
      "(including agents.piBinary) is not honored and repository operations are not performed. " +
      "Trust the project in pi first.",
    "warning",
  );
  return false;
}

/**
 * Loads the project config that may be honored for execution decisions.
 * Untrusted projects get defaults: their .gx-dev/config.json is never read,
 * so a configured executable can never reach a spawn call from here.
 */
async function honoredExecutionConfig(ctx: ExtensionCommandContext): Promise<GxConfig> {
  if (!ctx.isProjectTrusted()) return defaultConfig();
  return loadConfig(ctx.cwd);
}

async function startCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
  args: string,
): Promise<void> {
  const request = args.trim();
  if (request.length === 0) {
    gxOut(ctx, "usage: /gx-dev start <request>", "warning");
    return;
  }
  await engine.start(request);
  const state = engine.status();
  gxOut(ctx, 
    state ? `gx-dev run started: ${state.runId}` : "gx-dev run started",
    "info",
  );
}

async function statusCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
): Promise<void> {
  const state: RunState | null = engine.status();
  if (!state) {
    // Truthful: no active run in this session, but recorded runs may still
    // exist on disk and are inspectable/resumable.
    const runs = await new FsRunStore(ctx.cwd).list();
    gxOut(
      ctx,
      runs.length > 0
        ? `gx-dev: no active run \u2014 ${runs.length} recorded run(s) are available ` +
            "(/gx-dev history, /gx-dev resume [run-id], /gx-dev dashboard)"
        : "gx-dev: no active run (start one with /gx-dev start <request>)",
      "info",
    );
    return;
  }
  gxOut(ctx, renderStateLine(state), "info");
  if (state.pendingQuestion) {
    gxOut(ctx, 
      `question pending [${state.pendingQuestion.severity}]: ${state.pendingQuestion.question} \u2014 /gx-dev answer <text> or /gx-dev dashboard`,
      "warning",
    );
  }
}

async function answerCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
  args: string,
): Promise<void> {
  const text = args.trim();
  if (text.length === 0) {
    gxOut(ctx, "usage: /gx-dev answer <text>", "warning");
    return;
  }
  await engine.answer(text);
  ctx.ui.notify(`gx-dev: answer delivered: ${text}`, "info");
}

async function resumeCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
  args: string,
): Promise<void> {
  const runId = args.trim();
  await engine.resume(runId.length > 0 ? runId : undefined);
  ctx.ui.notify(
    runId.length > 0 ? `gx-dev: resuming ${runId}` : "gx-dev: resuming latest run",
    "info",
  );
}

async function historyCommand(
  ctx: ExtensionCommandContext,
  _engine: Engine,
): Promise<void> {
  const runs = await new FsRunStore(ctx.cwd).list();
  if (runs.length === 0) {
    gxOut(ctx, "gx-dev: no runs recorded", "info");
    return;
  }
  const lines = runs.slice(0, 15).map((r) => `${r.runId}  ${r.state}  ${r.updatedAt}`);
  const suffix = runs.length > lines.length ? `\n\u2026 and ${runs.length - lines.length} more` : "";
  gxOut(ctx, `gx-dev runs (newest first):\n${lines.join("\n")}${suffix}`, "info");
}

async function configCommand(
  ctx: ExtensionCommandContext,
  _engine: Engine,
): Promise<void> {
  let cfg: GxConfig;
  let header: string;
  if (!ctx.isProjectTrusted()) {
    // Display-only command, but stay consistent with the trust policy: an
    // untrusted project's config file is not read at all; defaults are shown
    // with an explicit notice instead of silently impersonating the file.
    cfg = defaultConfig();
    header =
      `gx-dev effective config \u2014 project "${ctx.cwd}" is NOT trusted; ` +
      ".gx-dev/config.json was not read, defaults shown:\n";
  } else {
    try {
      cfg = await loadConfig(ctx.cwd);
      header = "gx-dev effective config (.gx-dev/config.json):\n";
    } catch (e) {
      ctx.ui.notify(
        `gx-dev: config invalid, showing defaults \u2014 ${(e as Error).message}`,
        "warning",
      );
      cfg = defaultConfig();
      header = "gx-dev effective config (defaults; project config invalid):\n";
    }
  }
  const m = cfg.agents.models;
  const summary = [
    `agents: concurrency ${cfg.agents.maxConcurrency}, timeout ${cfg.agents.timeoutMinutes}m, pi binary "${cfg.agents.piBinary}"`,
    `models: researcher=${m.researcher} planner=${m.planner} developer=${m.developer}`,
    `        testWriter=${m.testWriter} testRunner=${m.testRunner} reviewer=${m.reviewer} committer=${m.committer}`,
    `gates: maxConsecutiveFailures ${cfg.gates.maxConsecutiveFailures}, maxTotalAttempts ${cfg.gates.maxTotalAttempts}, cleanFinalTree ${cfg.gates.requireCleanFinalTree}`,
    `research: web ${cfg.research.webEnabled ? "on" : "off"}, sources ${cfg.research.recordSources ? "recorded" : "not recorded"}`,
    `memory: ${cfg.memory.enabled ? "enabled" : "off"}, review ${cfg.memory.reviewRequired ? "required" : "not required"}, redaction ${cfg.memory.redactSecrets ? "on" : "off"}`,
    `git: worktreeRoot ${cfg.git.worktreeRoot}, autoCommit ${cfg.git.autoCommit}, retainFailedRuns ${cfg.git.retainFailedRuns}`,
  ].join("\n");
  gxOut(ctx, `${header}${summary}`, "info");
}

async function modelsCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
  args: string,
): Promise<void> {
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/);
  const sub = trimmed.length === 0 ? null : (parts[0] ?? null);

  // Persisting forms (the interactive picker and `set`) write project config
  // and then invalidate the shared engine. The active-run check happens HERE,
  // via the engine argument, BEFORE any persistence: the old order saved the
  // selection first and only then hit the reset hook's active-run guard,
  // leaving a model change persisted for a run that never used it.
  if ((sub === null || sub === "set") && runActive(engine)) {
    gxOut(
      ctx,
      "gx-dev: a run is active — cancel or finish it before changing model selections (nothing was saved)",
      "warning",
    );
    return;
  }

  if (sub === null) {
    // The picker probes config.agents.piBinary for the model list — that
    // executable must never come from an untrusted repo.
    if (!requireProjectTrust(ctx, "/gx-dev models")) return;
    // Interactive flow; the picker degrades to a notify hint outside the TUI.
    await showModelsPicker(ctx, {
      agentsDir: resolveAgentsDir(),
      onEngineReset: resetEngineViaHook,
    });
    return;
  }
  if (sub === "show") {
    // Display-only: honor project config only for trusted projects; an
    // untrusted repo's config is never read (defaults shown, with a notice).
    const trusted = ctx.isProjectTrusted();
    const sources = trusted
      ? await loadRoleModelSources(ctx.cwd, resolveAgentsDir())
      : { config: defaultConfig(), explicit: {}, agentsDir: resolveAgentsDir() };
    const overview = renderOverviewText(
      resolveAllRoleOverviews(sources),
      sessionModelLabel(ctx),
    );
    gxOut(
      ctx,
      trusted
        ? overview
        : `${overview}\n(project "${ctx.cwd}" is not trusted — .gx-dev/config.json was not read; defaults shown)`,
      "info",
    );
    return;
  }
  if (sub === "set") {
    if (!requireProjectTrust(ctx, "/gx-dev models set")) return;
    await modelsSetCommand(ctx, parts[1], parts[2]);
    return;
  }
  gxOut(ctx, 
    `usage: /gx-dev models [show | set <role> <spec>] \u2014 roles: ${MODEL_ROLE_KEYS.join(", ")}`,
    "warning",
  );
}

/** Case-insensitive role lookup ("testwriter" -> "testWriter"). */
function matchRoleKey(arg: string | undefined): ModelRoleKey | null {
  if (arg === undefined) return null;
  const lower = arg.toLowerCase();
  return MODEL_ROLE_KEYS.find((r) => r.toLowerCase() === lower) ?? null;
}

/** `/gx-dev models set <role> <spec>` — validate, warn-if-unavailable, persist. */
async function modelsSetCommand(
  ctx: ExtensionCommandContext,
  roleArg: string | undefined,
  specArg: string | undefined,
): Promise<void> {
  const agentsDir = resolveAgentsDir();
  const role = matchRoleKey(roleArg);
  if (role === null) {
    ctx.ui.notify(
      `gx-dev: unknown role "${roleArg ?? ""}" \u2014 roles: ${MODEL_ROLE_KEYS.join(", ")}`,
      "warning",
    );
    return;
  }
  const spec = specArg ?? "";
  if (!isValidModelSelection(spec)) {
    ctx.ui.notify(
      `gx-dev: invalid spec "${spec}" \u2014 expected "inherit" or provider/model[:thinking]`,
      "warning",
    );
    return;
  }

  // Reachable only for trusted projects (modelsCommand prechecks trust), so
  // this probe spawns the project-configured binary deliberately. The active-
  // run rejection already happened in modelsCommand before anything persisted.
  // Best-effort availability check with a 3s budget; never blocks the save.
  // matchModel already tolerates a :thinking suffix (splitSpec on its side).
  if (spec !== INHERIT_MODEL) {
    const piBinary = await honoredExecutionConfig(ctx);
    const available = await loadAvailableModelsBudgeted(ctx, piBinary.agents.piBinary, 3000);
    if (available !== null && available.models.length > 0 && matchModel([...available.models], spec) === null) {
      gxOut(ctx, 
        `gx-dev warning: "${spec}" matched none of ${available.models.length} available models (${available.source}); selection saved, but runs may fail to start this agent`,
        "warning",
      );
    }
  }

  await mergeModelSelection(ctx.cwd, role, spec);
  const sources = await loadRoleModelSources(ctx.cwd, agentsDir);
  const overview = resolveRoleOverview(sources, role);
  gxOut(ctx, `gx-dev: ${role} \u2192 ${overview.spec} (${overview.source})`, "info");
  resetEngineViaHook();
  ctx.ui.notify(
    "gx-dev: engine reset \u2014 the next /gx-dev start rebuilds agents with the new model selection",
    "info",
  );
}

interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function binaryCheck(name: string, binary: string, args: string[]): DoctorCheck {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000 });
  if (result.status === 0) {
    const version = (result.stdout ?? "").trim().split("\n")[0] ?? "";
    return { name, ok: true, detail: version.length > 0 ? version : "ok" };
  }
  const reason = result.error?.message ?? `exit code ${result.status ?? "signal"}`;
  return { name, ok: false, detail: `"${binary}" not usable: ${reason}` };
}

async function doctorCommand(
  ctx: ExtensionCommandContext,
  _engine: Engine,
): Promise<void> {
  const checks: DoctorCheck[] = [];

  // 0. Project trust: decides whether project configuration — including the
  //    agents.piBinary executable — may be honored at all.
  const trusted = ctx.isProjectTrusted();
  checks.push({
    name: "trust",
    ok: trusted,
    detail: trusted
      ? `project "${ctx.cwd}" is trusted \u2014 .gx-dev/config.json is honored`
      : `project "${ctx.cwd}" is NOT trusted \u2014 .gx-dev/config.json is not honored and runs are refused; trust the project in pi first`,
  });

  // 1. Effective config validates — read only for trusted projects. An
  //    untrusted repo's configured executable is never read, let alone run.
  let cfg: GxConfig = defaultConfig();
  if (trusted) {
    try {
      cfg = await loadConfig(ctx.cwd);
      checks.push({ name: "config", ok: true, detail: ".gx-dev/config.json valid (or absent)" });
    } catch (e) {
      checks.push({ name: "config", ok: false, detail: (e as Error).message });
    }
  } else {
    checks.push({
      name: "config",
      ok: true,
      detail: "not read (untrusted project) \u2014 defaults in effect",
    });
  }

  // 2. pi binary resolvable (used to spawn subagents in JSON mode). The
  //    spawned binary is the honored config's piBinary: the project's choice
  //    only for trusted projects, otherwise the "pi" default.
  checks.push(binaryCheck("pi", cfg.agents.piBinary || "pi", ["--version"]));

  // 3. git present (worktrees, base recording, commits).
  checks.push(binaryCheck("git", "git", ["--version"]));

  // 4. Node >= 24 (package engines requirement).
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  checks.push({
    name: "node",
    ok: major >= 24,
    detail: `${process.version}${major >= 24 ? "" : " (>=24 required)"}`,
  });

  // 5. Agents dir exists with all 7 role prompt files.
  const agentsDir = resolveAgentsDir();
  const missing = AGENT_ROLES.filter((role) => !existsSync(join(agentsDir, roleFile(role))));
  checks.push({
    name: "agents",
    ok: existsSync(agentsDir) && missing.length === 0,
    detail: !existsSync(agentsDir)
      ? `agents dir not found: ${agentsDir}`
      : missing.length === 0
        ? `all ${AGENT_ROLES.length} role files in ${agentsDir}`
        : `missing: ${missing.map(roleFile).join(", ")}`,
  });

  const lines = checks.map((c) => `${c.ok ? "\u2713" : "\u2717"} ${c.name}: ${c.detail}`);
  const allOk = checks.every((c) => c.ok);
  gxOut(ctx, 
    `gx-dev doctor \u2014 ${allOk ? "all checks passed" : "PROBLEMS FOUND"}:\n${lines.join("\n")}`,
    allOk ? "info" : "warning",
  );
}

// -----------------------------------------------------------------
// evidence / story / retry / memory / cleanup
// -----------------------------------------------------------------

/**
 * `/gx-dev evidence [run-id] [kind]` — read-only display of a run's recorded
 * evidence manifest. Targets the explicit run id, else the engine's current
 * run, else the newest recorded run. Reads only the append-only manifest via
 * loadEvidenceManifest (never constructs an FsArtifactStore, whose
 * constructor creates directories).
 */
async function evidenceCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
  args: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
  const store = new FsRunStore(ctx.cwd);
  let runId: string | null = null;
  if (parts.length > 0 && parts[0]) {
    runId = parts[0];
    // An explicit id must exist — fail closed on typos instead of reporting
    // a misleading "no evidence" for a run that was never recorded.
    if ((await store.load(runId)) === null) {
      gxOut(ctx, `gx-dev: unknown run "${runId}" \u2014 see /gx-dev history`, "warning");
      return;
    }
  } else {
    runId = engine.status()?.runId ?? (await store.list())[0]?.runId ?? null;
  }
  if (runId === null) {
    gxOut(ctx, "gx-dev: no runs recorded \u2014 start one with /gx-dev start <request>", "info");
    return;
  }
  const kindFilter = parts[1];
  const manifest = join(runDir(ctx.cwd, runId), "evidence", EVIDENCE_MANIFEST_FILE);
  let records: EvidenceRecord[] = [];
  try {
    records = loadEvidenceManifest(manifest);
  } catch (e) {
    gxOut(ctx, `gx-dev: cannot read evidence for run ${runId}: ${(e as Error).message}`, "error");
    return;
  }
  if (kindFilter !== undefined) records = records.filter((r) => r.kind === kindFilter);
  if (records.length === 0) {
    gxOut(
      ctx,
      `gx-dev: no evidence recorded for run ${runId}` +
        (kindFilter !== undefined ? ` (kind: ${kindFilter})` : ""),
      "info",
    );
    return;
  }
  const lines = records.map(
    (r) =>
      `  ${r.kind.padEnd(12)} ${r.name}  ${r.hash.slice(0, 12)}  ${r.bytes}B  ` +
      `${r.source}  ${r.at}` +
      (r.redactions !== undefined ? `  [${r.redactions} redaction(s)]` : ""),
  );
  gxOut(
    ctx,
    `gx-dev evidence for run ${runId} (${records.length} record(s)):\n${lines.join("\n")}`,
    "info",
  );
}

/**
 * `/gx-dev story <file-path>` — starts a run whose request is a readable
 * story file's verbatim text. The file must be readable: an unreadable or
 * empty file is a hard error, never silently downgraded to a story-less run.
 */
async function storyCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
  args: string,
): Promise<void> {
  const raw = args.trim();
  if (raw.length === 0) {
    gxOut(ctx, "usage: /gx-dev story <file-path>", "warning");
    return;
  }
  if (!requireProjectTrust(ctx, "/gx-dev story")) return;
  if (runActive(engine)) {
    gxOut(ctx, "gx-dev: a run is active — cancel or finish it before starting a story run", "warning");
    return;
  }
  const storyPath = resolve(ctx.cwd, raw);
  let text: string;
  try {
    text = readFileSync(storyPath, "utf8");
  } catch (e) {
    gxOut(ctx, `gx-dev: cannot read story file ${storyPath}: ${(e as Error).message}`, "error");
    return;
  }
  if (text.trim().length === 0) {
    gxOut(ctx, `gx-dev: story file ${storyPath} is empty`, "warning");
    return;
  }
  const state = await engine.start(text, storyPath);
  gxOut(
    ctx,
    `gx-dev run started from story ${storyPath}: ${state.runId} (story attached to the run's request evidence)`,
    "info",
  );
}

/**
 * `/gx-dev retry [run-id]` — resumes an interrupted run via engine.resume.
 * Defaults to the newest recorded run that is not terminal. Truthfulness
 * rules: a run parked on an UNANSWERED checkpoint is refused (retry never
 * claims a pending checkpoint was answered — answer it with /gx-dev answer),
 * while an already-answered checkpoint resumes normally; terminal runs are
 * reported as non-resumable instead of silently no-oping.
 */
async function retryCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
  args: string,
): Promise<void> {
  if (!requireProjectTrust(ctx, "/gx-dev retry")) return;
  if (runActive(engine)) {
    gxOut(ctx, "gx-dev: a run is active — cancel or finish it before retrying another run", "warning");
    return;
  }
  const wanted = args.trim();
  const store = new FsRunStore(ctx.cwd);
  let state: RunState | null;
  if (wanted.length > 0) {
    state = await store.load(wanted);
    if (!state) {
      gxOut(ctx, `gx-dev: unknown run "${wanted}" \u2014 see /gx-dev history`, "warning");
      return;
    }
  } else {
    const runs = await store.list();
    const candidate = runs.find((r) => !TERMINAL_STATES.includes(r.state));
    if (!candidate) {
      gxOut(ctx, "gx-dev: no resumable run found — start one with /gx-dev start <request>", "info");
      return;
    }
    state = await store.load(candidate.runId);
    if (!state) {
      gxOut(ctx, `gx-dev: recorded run ${candidate.runId} cannot be loaded`, "warning");
      return;
    }
  }
  if (TERMINAL_STATES.includes(state.state)) {
    gxOut(
      ctx,
      `gx-dev: run ${state.runId} is ${state.state} and cannot be resumed \u2014 start a new run with /gx-dev start <request>`,
      "warning",
    );
    return;
  }
  if (state.state === "WAITING_FOR_USER" && !questionAnswered(state.pendingQuestion)) {
    gxOut(
      ctx,
      `gx-dev: run ${state.runId} is waiting at an unanswered checkpoint` +
        (state.pendingQuestion ? `: "${state.pendingQuestion.question}"` : "") +
        " \u2014 retry does not answer pending checkpoints; answer it with /gx-dev answer <text>",
      "warning",
    );
    return;
  }
  const resumed = await engine.resume(state.runId);
  gxOut(ctx, `gx-dev: retried run ${state.runId} \u2014 now ${renderStateLine(resumed)}`, "info");
}

/**
 * `/gx-dev memory lint | search <query>` — read-only display over the
 * project memory wiki through FsMemoryStore. Only for trusted projects: the
 * store's constructor scaffolds directories, so it is additionally only
 * constructed when the memory root already exists (a display command must
 * not create project state as a side effect).
 */
async function memoryCommand(
  ctx: ExtensionCommandContext,
  _engine: Engine,
  args: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
  const sub = parts[0] ?? "";
  if (sub !== "lint" && sub !== "search") {
    gxOut(ctx, "usage: /gx-dev memory lint | search <query>", "warning");
    return;
  }
  if (!requireProjectTrust(ctx, "/gx-dev memory")) return;
  const root = join(ctx.cwd, ".gx-dev", "memory");
  if (!existsSync(root)) {
    gxOut(ctx, `gx-dev: no memory store yet at ${root} \u2014 it is created by the first run`, "info");
    return;
  }
  const memory = new FsMemoryStore(root);
  if (sub === "lint") {
    const result = await memory.lint();
    if (result.ok) {
      gxOut(ctx, `gx-dev memory lint: OK (${root})`, "info");
    } else {
      const shown = result.issues.slice(0, 20);
      const more = result.issues.length > shown.length
        ? `\n\u2026 and ${result.issues.length - shown.length} more`
        : "";
      gxOut(ctx, `gx-dev memory lint: ${result.issues.length} issue(s):\n${shown.join("\n")}${more}`, "warning");
    }
    return;
  }
  const query = parts.slice(1).join(" ").trim();
  if (query.length === 0) {
    gxOut(ctx, "usage: /gx-dev memory search <query>", "warning");
    return;
  }
  const hits = await memory.search(query, 10);
  if (hits.length === 0) {
    gxOut(ctx, `gx-dev memory search "${query}": no matches`, "info");
    return;
  }
  const lines = hits.map((p) => {
    const verification = p.frontmatter["verification"] ?? "?";
    const scope = p.frontmatter["scope"] ?? "?";
    const excerpt = p.body.replace(/\s+/g, " ").trim().slice(0, 100);
    return `  ${p.name}  [${verification}, ${scope}]  ${excerpt}`;
  });
  gxOut(ctx, `gx-dev memory search "${query}" (${hits.length} hit(s)):\n${lines.join("\n")}`, "info");
}

/** Worktree role paths/branches for a run; mirrors git/worktrees.ts conventions. */
function runWorktreeHandles(repoPath: string, runId: string): {
  runId: string;
  developer: string;
  tests: string;
  staging: string;
  branches: { developer: string; tests: string; staging: string };
} {
  // git/worktrees.ts keeps these helpers private, so the conventional layout
  // (<repo-parent>/.gx-dev-worktrees/<run-id>/{role}, branches gx-dev/<run-id>/<role>)
  // is mirrored here. GitWorktreeManager.cleanup tolerates missing entries.
  const root = join(dirname(repoPath), WORKTREE_DIRNAME, runId);
  return {
    runId,
    developer: join(root, "developer"),
    tests: join(root, "tests"),
    staging: join(root, "staging"),
    branches: {
      developer: `gx-dev/${runId}/developer`,
      tests: `gx-dev/${runId}/tests`,
      staging: `gx-dev/${runId}/staging`,
    },
  };
}

/**
 * `/gx-dev cleanup <run-id>` — removes a FINISHED run's worktrees and
 * branches through GitWorktreeManager.cleanup only. Safety rules:
 *   - the run id is explicit (no bare form, no "latest" guessing),
 *   - refused while any run is active (cleanup must not race live writers),
 *   - only terminal runs (COMPLETE/CANCELLED/FAILED) are eligible,
 *   - non-force: dirty worktrees and unmerged branches are tolerated and
 *     reported as leftovers, never destroyed (no --force, no prune, no rm).
 * Remaining paths/branches are verified afterwards and reported truthfully.
 */
async function cleanupCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
  args: string,
): Promise<void> {
  const runId = args.trim();
  if (runId.length === 0) {
    gxOut(
      ctx,
      "usage: /gx-dev cleanup <run-id> \u2014 an explicit run id is required (/gx-dev history to list)",
      "warning",
    );
    return;
  }
  if (!requireProjectTrust(ctx, "/gx-dev cleanup")) return;
  if (runActive(engine)) {
    gxOut(ctx, "gx-dev: a run is active — cleanup is refused while a run may be writing", "warning");
    return;
  }
  const state = await new FsRunStore(ctx.cwd).load(runId);
  if (!state) {
    gxOut(ctx, `gx-dev: unknown run "${runId}" \u2014 see /gx-dev history`, "warning");
    return;
  }
  if (!TERMINAL_STATES.includes(state.state)) {
    gxOut(
      ctx,
      `gx-dev: run ${runId} is ${state.state}, not finished \u2014 only COMPLETE/CANCELLED/FAILED runs can be cleaned up`,
      "warning",
    );
    return;
  }
  const handles = runWorktreeHandles(ctx.cwd, runId);
  const had = [handles.developer, handles.tests, handles.staging].filter(existsSync);
  await new GitWorktreeManager().cleanup(handles);

  // Truthful post-verification: report what actually remains.
  const remainingPaths = [handles.developer, handles.tests, handles.staging].filter(existsSync);
  const branchRes = await git(ctx.cwd, ["branch", "--list", `gx-dev/${runId}/*`]);
  const remainingBranches = branchRes.code === 0
    ? branchRes.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)
    : [];
  if (remainingPaths.length === 0 && remainingBranches.length === 0) {
    gxOut(
      ctx,
      had.length > 0
        ? `gx-dev: cleanup of run ${runId} complete \u2014 removed ${had.length} worktree path(s) and their branches`
        : `gx-dev: run ${runId} had no worktree paths or branches to clean up`,
      "info",
    );
    return;
  }
  const leftovers = [
    ...remainingPaths.map((p) => `path ${p}`),
    ...remainingBranches.map((b) => `branch ${b}`),
  ];
  gxOut(
    ctx,
    `gx-dev: cleanup of run ${runId} finished with leftover(s) (dirty worktrees or unmerged branches are never force-removed):\n` +
      leftovers.map((l) => `  ${l}`).join("\n") +
      "\nInspect and remove them manually if safe.",
    "warning",
  );
}

/**
 * Rollback note (intentionally unimplemented): there is no /gx-dev rollback
 * command. Rollback guidance is produced by the engine's commit step as
 * history-preserving `git revert` instructions; a command that ran
 * reset/branch-force style rollback itself would be an arbitrary destructive
 * operation on the user's branch and stays out of scope (REVIEW P1).
 */
export const GX_COMMANDS: readonly GxCommand[] = [
  {
    name: "start",
    description: "Start a new gx-dev run for a feature request",
    usage: "start <request>",
    handler: startCommand,
  },
  {
    name: "status",
    description: "Show current run state, elapsed time, and gate counters",
    usage: "status",
    handler: statusCommand,
  },
  {
    name: "dashboard",
    description: "Open the full-screen dashboard (state graph, events, gates)",
    usage: "dashboard",
    handler: (ctx, engine) => showDashboard(ctx, engine),
  },
  {
    name: "answer",
    description: "Answer a pending question (also consumed before it is asked)",
    usage: "answer <text>",
    handler: answerCommand,
  },
  {
    name: "pause",
    description: "Pause the active run at a checkpoint",
    usage: "pause",
    handler: async (ctx, engine) => {
      await engine.pause();
      ctx.ui.notify("gx-dev: run paused", "info");
    },
  },
  {
    name: "resume",
    description: "Resume a paused run (latest, or by run id)",
    usage: "resume [run-id]",
    handler: resumeCommand,
  },
  {
    name: "cancel",
    description: "Cancel the active run (worktrees are retained for inspection)",
    usage: "cancel",
    handler: async (ctx, engine) => {
      await engine.cancel();
      ctx.ui.notify("gx-dev: run cancelled", "info");
    },
  },
  {
    name: "history",
    description: "List recorded runs (newest first)",
    usage: "history",
    handler: historyCommand,
  },
  {
    name: "config",
    description: "Show the effective gx-dev configuration",
    usage: "config",
    handler: configCommand,
  },
  {
    name: "models",
    description: "Assign per-role subagent models (picker; or show / set <role> <spec>)",
    usage: "models [show | set <role> <spec>]",
    handler: modelsCommand,
  },
  {
    name: "doctor",
    description: "Check trust, config, pi binary, git, node version, and agent files",
    usage: "doctor",
    handler: doctorCommand,
  },
  {
    name: "evidence",
    description: "Show recorded evidence for a run (explicit id, active, or newest)",
    usage: "evidence [run-id] [kind]",
    handler: evidenceCommand,
  },
  {
    name: "story",
    description: "Start a run whose request is a readable story file's text",
    usage: "story <file-path>",
    handler: storyCommand,
  },
  {
    name: "retry",
    description: "Resume an interrupted run (never answers pending checkpoints)",
    usage: "retry [run-id]",
    handler: retryCommand,
  },
  {
    name: "memory",
    description: "Inspect the project memory wiki (trusted projects only)",
    usage: "memory lint | search <query>",
    handler: memoryCommand,
  },
  {
    name: "cleanup",
    description: "Remove a finished run's worktrees/branches (explicit run id required)",
    usage: "cleanup <run-id>",
    handler: cleanupCommand,
  },
];

/** Flat-command dispatch helper for index.ts. */
export function findGxCommand(name: string): GxCommand | undefined {
  return GX_COMMANDS.find((c) => c.name === name);
}

export function gxUsageText(): string {
  return GX_COMMANDS.map((c) => `  /gx-dev ${c.usage} \u2014 ${c.description}`).join("\n");
}

interface CompletionCandidate {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * Builds AutocompleteItems for one argument slot. pi replaces the whole
 * argument text with item.value (pi-tui autocomplete.js applyCompletion), so
 * already-committed words are re-attached before the completed candidate.
 */
function completionsForSlot(
  candidates: readonly CompletionCandidate[],
  inProgress: string,
  committed: readonly string[],
): AutocompleteItem[] | null {
  const p = inProgress.toLowerCase();
  const matches = candidates.filter((c) => c.value.toLowerCase().startsWith(p));
  if (matches.length === 0) return null;
  const head = committed.length > 0 ? `${committed.join(" ")} ` : "";
  return matches.map((c) => ({
    value: head + c.value,
    label: c.label,
    ...(c.description !== undefined ? { description: c.description } : {}),
  }));
}

/**
 * Available model refs for the third `set` argument, from the session
 * registry (synchronous getAvailable per docs/extensions.md
 * "ctx.modelRegistry") plus the "inherit" literal. Best-effort: registry
 * problems degrade to the inherit-only candidate list.
 */
function modelRefCandidates(ctx: ExtensionContext | null): CompletionCandidate[] {
  const items: CompletionCandidate[] = [
    { value: INHERIT_MODEL, label: INHERIT_MODEL, description: "use the session default model" },
  ];
  try {
    const raw = ctx?.modelRegistry?.getAvailable?.() ?? [];
    const seen = new Set<string>([INHERIT_MODEL]);
    for (const m of raw) {
      const ref = `${m.provider}/${m.id}`;
      if (!seen.has(ref)) {
        seen.add(ref);
        items.push({ value: ref, label: ref });
      }
    }
  } catch {
    // registry unavailable — role-only (inherit) completion still works
  }
  return items;
}

/**
 * Completion provider for the `gx-dev` command (wired in index.ts). Splits
 * the argument prefix into committed words + the word in progress, then
 * completes: subcommand → (models) set|show → (set) role → (set) model ref.
 * Synchronous: ctx.modelRegistry.getAvailable() is a sync read, so no async
 * completion path is required.
 */
export function gxArgumentCompletions(
  prefix: string,
  ctx: ExtensionContext | null,
): AutocompleteItem[] | null {
  const endsWithSpace = /\s$/.test(prefix);
  const words = prefix.trim().split(/\s+/).filter((w) => w.length > 0);
  const inProgress = endsWithSpace ? "" : (words.pop() ?? "");
  const committed = words;

  if (committed.length === 0) {
    return completionsForSlot(
      GX_COMMANDS.map((c) => ({ value: c.name, label: c.name, description: c.description })),
      inProgress,
      committed,
    );
  }
  if (committed[0] !== "models") return null;
  if (committed.length === 1) {
    return completionsForSlot(
      [
        { value: "set", label: "set", description: "set a role's model directly" },
        { value: "show", label: "show", description: "print the per-role overview" },
      ],
      inProgress,
      committed,
    );
  }
  if (committed[1] !== "set") return null;
  if (committed.length === 2) {
    return completionsForSlot(
      MODEL_ROLE_KEYS.map((r) => ({ value: r, label: r })),
      inProgress,
      committed,
    );
  }
  if (committed.length === 3) {
    return completionsForSlot(modelRefCandidates(ctx), inProgress, committed);
  }
  return null;
}
