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
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { Engine } from "./orchestration/engine.ts";
import { AGENT_ROLES } from "./domain/schemas.ts";
import { FsRunStore } from "./domain/persist.ts";
import type { RunState } from "./domain/state.ts";
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

function resetEngineViaHook(): void {
  engineResetHook?.();
}

async function startCommand(
  ctx: ExtensionCommandContext,
  engine: Engine,
  args: string,
): Promise<void> {
  const request = args.trim();
  if (request.length === 0) {
    ctx.ui.notify("usage: /gx-dev start <request>", "warning");
    return;
  }
  await engine.start(request);
  const state = engine.status();
  ctx.ui.notify(
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
    ctx.ui.notify("gx-dev: no active run (start one with /gx-dev start <request>)", "info");
    return;
  }
  ctx.ui.notify(renderStateLine(state), "info");
  if (state.pendingQuestion) {
    ctx.ui.notify(
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
    ctx.ui.notify("usage: /gx-dev answer <text>", "warning");
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
    ctx.ui.notify("gx-dev: no runs recorded", "info");
    return;
  }
  const lines = runs.slice(0, 15).map((r) => `${r.runId}  ${r.state}  ${r.updatedAt}`);
  const suffix = runs.length > lines.length ? `\n\u2026 and ${runs.length - lines.length} more` : "";
  ctx.ui.notify(`gx-dev runs (newest first):\n${lines.join("\n")}${suffix}`, "info");
}

async function configCommand(
  ctx: ExtensionCommandContext,
  _engine: Engine,
): Promise<void> {
  let cfg: GxConfig;
  try {
    cfg = await loadConfig(ctx.cwd);
  } catch (e) {
    ctx.ui.notify(
      `gx-dev: config invalid, showing defaults \u2014 ${(e as Error).message}`,
      "warning",
    );
    cfg = defaultConfig();
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
  ctx.ui.notify(`gx-dev effective config (.gx-dev/config.json):\n${summary}`, "info");
}

async function modelsCommand(
  ctx: ExtensionCommandContext,
  _engine: Engine,
  args: string,
): Promise<void> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    // Interactive flow; the picker degrades to a notify hint outside the TUI.
    await showModelsPicker(ctx, {
      agentsDir: resolveAgentsDir(),
      onEngineReset: resetEngineViaHook,
    });
    return;
  }
  const parts = trimmed.split(/\s+/);
  const sub = parts[0];
  if (sub === "show") {
    const sources = await loadRoleModelSources(ctx.cwd, resolveAgentsDir());
    ctx.ui.notify(
      renderOverviewText(resolveAllRoleOverviews(sources), sessionModelLabel(ctx)),
      "info",
    );
    return;
  }
  if (sub === "set") {
    await modelsSetCommand(ctx, parts[1], parts[2]);
    return;
  }
  ctx.ui.notify(
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

  // Best-effort availability check with a 3s budget; never blocks the save.
  // matchModel already tolerates a :thinking suffix (splitSpec on its side).
  if (spec !== INHERIT_MODEL) {
    const available = await loadAvailableModelsBudgeted(ctx, (await loadConfig(ctx.cwd)).agents.piBinary, 3000);
    if (available !== null && available.models.length > 0 && matchModel([...available.models], spec) === null) {
      ctx.ui.notify(
        `gx-dev warning: "${spec}" matched none of ${available.models.length} available models (${available.source}); selection saved, but runs may fail to start this agent`,
        "warning",
      );
    }
  }

  await mergeModelSelection(ctx.cwd, role, spec);
  const sources = await loadRoleModelSources(ctx.cwd, agentsDir);
  const overview = resolveRoleOverview(sources, role);
  ctx.ui.notify(`gx-dev: ${role} \u2192 ${overview.spec} (${overview.source})`, "info");
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

  // 1. Effective config validates.
  try {
    await loadConfig(ctx.cwd);
    checks.push({ name: "config", ok: true, detail: ".gx-dev/config.json valid (or absent)" });
  } catch (e) {
    checks.push({ name: "config", ok: false, detail: (e as Error).message });
  }
  const cfg = await loadConfig(ctx.cwd).catch(() => defaultConfig());

  // 2. pi binary resolvable (used to spawn subagents in JSON mode).
  checks.push(binaryCheck("pi", cfg.agents.piBinary || "pi", ["--version"]));

  // 3. git present (worktrees, base recording, commits).
  checks.push(binaryCheck("git", "git", ["--version"]));

  // 4. Node >= 22 (package engines requirement).
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  checks.push({
    name: "node",
    ok: major >= 22,
    detail: `${process.version}${major >= 22 ? "" : " (>=22 required)"}`,
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
  ctx.ui.notify(
    `gx-dev doctor \u2014 ${allOk ? "all checks passed" : "PROBLEMS FOUND"}:\n${lines.join("\n")}`,
    allOk ? "info" : "warning",
  );
}

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
    description: "Check pi binary, git, node version, agent files, and config",
    usage: "doctor",
    handler: doctorCommand,
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
