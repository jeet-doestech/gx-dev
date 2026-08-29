/**
 * Interactive /gx-dev models picker (PLAN §16 — per-subagent model selection).
 *
 * Flow for `/gx-dev models` (no arguments):
 *   1. Role overview — one row per MODEL_ROLE_KEYS entry showing the effective
 *      spec (resolveModelSpec over: explicit config entry > role-prompt
 *      frontmatter > configured default > builtin GLM_53_FLASH_MAX) plus a
 *      source badge; "inherit" rows also surface the session default model
 *      (ctx.model / ctx.thinkingLevel).
 *   2. Model list for the chosen role — source A is
 *      ctx.modelRegistry?.getAvailable?.() normalized via
 *      listModelsViaRegistry; when the registry yields nothing, source B is
 *      listModelsViaCli(config.agents.piBinary). Rows show `provider/model`
 *      with a thinking badge and an images marker, plus two special rows
 *      ("inherit — use session default", "clear override — remove explicit
 *      selection") and, for long lists, a "filter…" pseudo-row that switches
 *      to a text Input used to narrow the list.
 *   3. Thinking level — for reasoning models a SelectList over THINKING_LEVELS
 *      with "max" preselected; non-reasoning models skip this step.
 *   4. Persist via mergeModelSelection (or unsetModelSelection for "clear"),
 *      re-resolve and report the effective spec for the role, and invalidate
 *      the shared engine via the onEngineReset hook (index.resetActiveEngine)
 *      so the next /gx-dev start constructs a fresh PiAgentRunner.
 *
 * pi APIs used (docs/extensions.md "Custom Components / Overlay Mode",
 * docs/tui.md Pattern 1, docs/themes.md tokens): ctx.ui.custom overlay,
 * Container/DynamicBorder/Text/SelectList/Input, matchesKey/Key,
 * ctx.ui.notify, ctx.model/ctx.thinkingLevel/ctx.modelRegistry — theme-aware
 * via ctx.theme tokens only, no hard-coded colors.
 *
 * agents/models.ts is consumed behind exactly this surface:
 *   listModelsViaRegistry, listModelsViaCli, resolveModelSpec, qualifySpec,
 *   THINKING_LEVELS, type PiModelInfo
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import type { Component, Focusable, SelectItem, TUI } from "@earendil-works/pi-tui";
import { loadRolePrompt } from "../agents/discovery.ts";
import {
  listModelsViaCli,
  listModelsViaRegistry,
  qualifySpec,
  resolveModelSpec,
  THINKING_LEVELS,
} from "../agents/models.ts";
import type { PiModelInfo } from "../agents/models.ts";
import {
  GLM_53_FLASH_MAX,
  INHERIT_MODEL,
  loadConfigWithSources,
  mergeModelSelection,
  MODEL_ROLE_KEYS,
  unsetModelSelection,
} from "../config.ts";
import type { GxConfig, ModelRoleKey } from "../config.ts";

/** Where a role's effective model spec comes from (badge strings per spec). */
export type ModelSourceBadge =
  | "explicit-config"
  | "frontmatter"
  | "configured-default"
  | "builtin-default"
  | "inherit";

export interface RoleModelOverview {
  readonly role: ModelRoleKey;
  /** Effective spec: "inherit" or provider/model[:thinking]. */
  readonly spec: string;
  readonly source: ModelSourceBadge;
}

/** Everything resolveModelSpec needs, gathered once per picker invocation. */
export interface ModelSources {
  readonly config: GxConfig;
  /** Selections present verbatim in .gx-dev/config.json (user-explicit). */
  readonly explicit: Partial<Record<ModelRoleKey, string>>;
  readonly agentsDir: string;
}

/** Loads config + explicit-selection sources for effective-resolution reads. */
export async function loadRoleModelSources(
  repoPath: string,
  agentsDir: string,
): Promise<ModelSources> {
  const loaded = await loadConfigWithSources(repoPath);
  return { config: loaded.config, explicit: loaded.explicitModels, agentsDir };
}

/**
 * Effective model spec for one role via resolveModelSpec, with the inputs the
 * spec mandates: explicit selection, role-prompt frontmatter, the configured
 * per-role default, and the builtin GLM_53_FLASH_MAX fallback. An inheriting
 * resolution (spec === null) is surfaced as the "inherit" spec + badge.
 */
export function resolveRoleOverview(
  sources: ModelSources,
  role: ModelRoleKey,
): RoleModelOverview {
  const frontmatter = loadRolePrompt(sources.agentsDir, role)?.model;
  const resolved = resolveModelSpec({
    explicitConfigModel: sources.explicit[role],
    frontmatterModel: frontmatter,
    configuredDefault: sources.config.agents.models[role],
    builtinDefault: GLM_53_FLASH_MAX,
  });
  if (resolved.inherits || resolved.spec === null) {
    return { role, spec: INHERIT_MODEL, source: "inherit" };
  }
  return { role, spec: resolved.spec, source: resolved.source };
}

/** Effective overview for all seven roles, in MODEL_ROLE_KEYS order. */
export function resolveAllRoleOverviews(sources: ModelSources): RoleModelOverview[] {
  return MODEL_ROLE_KEYS.map((role) => resolveRoleOverview(sources, role));
}

/** "provider/id · thinking level" for the hosting session, or null. */
export function sessionModelLabel(ctx: ExtensionContext): string | null {
  const model = ctx.model;
  if (!model) return null;
  const base = `${model.provider}/${model.id}`;
  return ctx.thinkingLevel ? `${base} \u00b7 thinking ${ctx.thinkingLevel}` : base;
}

export interface AvailableModels {
  readonly models: readonly PiModelInfo[];
  readonly source: "registry" | "cli" | "none";
}

/**
 * Source A: the session model registry (guarding optional chaining, normalized
 * via listModelsViaRegistry). Source B, only when that is missing or empty:
 * the pi CLI subcommand list. Never throws.
 */
export async function loadAvailableModels(
  ctx: ExtensionContext,
  piBinary: string,
): Promise<AvailableModels> {
  let models: PiModelInfo[] = [];
  try {
    const raw = ctx.modelRegistry?.getAvailable?.() ?? [];
    // Registry Model objects are projected onto the loose shape
    // listModelsViaRegistry parses; `images` derives from `input`.
    models = listModelsViaRegistry(
      raw.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        images: m.input.includes("image"),
        contextWindow: m.contextWindow,
        maxOutput: m.maxTokens,
      })),
    );
  } catch {
    models = [];
  }
  if (models.length > 0) return { models, source: "registry" };
  try {
    models = await listModelsViaCli(piBinary);
  } catch {
    models = [];
  }
  return { models, source: models.length > 0 ? "cli" : "none" };
}

/**
 * loadAvailableModels with a hard time budget (used by the non-interactive
 * `models set` form so a slow CLI probe cannot stall the command). Resolves
 * null when the budget expires.
 */
export async function loadAvailableModelsBudgeted(
  ctx: ExtensionContext,
  piBinary: string,
  budgetMs: number,
): Promise<AvailableModels | null> {
  const task = loadAvailableModels(ctx, piBinary);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Plain-text overview table for `/gx-dev models show` (and degraded modes). */
export function renderOverviewText(
  overviews: readonly RoleModelOverview[],
  sessionLabel: string | null,
): string {
  const roleWidth = Math.max(...overviews.map((o) => o.role.length));
  const specWidth = Math.max(...overviews.map((o) => o.spec.length), 10);
  const header =
    `gx-dev model assignments` +
    (sessionLabel !== null ? ` (session default: ${sessionLabel})` : "");
  const rows = overviews.map(
    (o) => `  ${o.role.padEnd(roleWidth)}  ${o.spec.padEnd(specWidth)}  ${o.source}`,
  );
  return [header, ...rows].join("\n");
}

/** Options for the interactive picker. */
export interface ModelsPickerOptions {
  readonly agentsDir: string;
  /** Installed by commands.ts → index.resetActiveEngine after a persist. */
  readonly onEngineReset?: () => void;
}

/**
 * Runs the full interactive flow. Returns true when a selection was persisted
 * (the caller then reports the engine reset); false on cancel/degradation.
 */
export async function showModelsPicker(
  ctx: ExtensionContext,
  opts: ModelsPickerOptions,
): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(
      "gx-dev models picker requires interactive TUI; use /gx-dev models show or /gx-dev models set <role> <spec>",
      "warning",
    );
    return false;
  }

  const sources = await loadRoleModelSources(ctx.cwd, opts.agentsDir);
  const available = await loadAvailableModels(ctx, sources.config.agents.piBinary);
  const sessionLabel = sessionModelLabel(ctx);

  const action = await ctx.ui.custom<ModelsPickerAction | null>(
    (tui, theme, _keybindings, done) =>
      new ModelsPickerModal({ tui, theme, sources, available, sessionLabel, done }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "78%", minWidth: 60 },
    },
  );
  if (action === null) return false;

  try {
    if (action.kind === "clear") {
      await unsetModelSelection(ctx.cwd, action.role);
    } else {
      const spec = action.kind === "inherit" ? INHERIT_MODEL : action.spec;
      await mergeModelSelection(ctx.cwd, action.role, spec);
    }
  } catch (e) {
    ctx.ui.notify(`gx-dev: failed to persist model selection: ${(e as Error).message}`, "error");
    return false;
  }

  // Re-resolve from disk so the user sees the exact effective outcome.
  const fresh = await loadRoleModelSources(ctx.cwd, opts.agentsDir);
  const overview = resolveRoleOverview(fresh, action.role);
  ctx.ui.notify(
    `gx-dev: ${action.role} \u2192 ${overview.spec} (${overview.source})`,
    "info",
  );
  opts.onEngineReset?.();
  ctx.ui.notify(
    "gx-dev: engine reset \u2014 the next /gx-dev start rebuilds agents with the new model selection",
    "info",
  );
  return true;
}

/** Result of the interactive modal, persisted by showModelsPicker. */
type ModelsPickerAction =
  | { readonly kind: "set"; readonly role: ModelRoleKey; readonly spec: string }
  | { readonly kind: "inherit"; readonly role: ModelRoleKey }
  | { readonly kind: "clear"; readonly role: ModelRoleKey };

type PickerMode = "roles" | "models" | "thinking" | "filter";

/** Pseudo-row values (NUL-prefixed so they can never collide with models). */
const ACTION_EXIT = "\u0000gx-dev-exit";
const ACTION_INHERIT = "\u0000gx-dev-inherit";
const ACTION_CLEAR = "\u0000gx-dev-clear";
const ACTION_FILTER = "\u0000gx-dev-filter";

/** Model list length at or above which the "filter…" pseudo-row appears. */
const FILTER_THRESHOLD = 12;
const LIST_MAX_ROWS = 12;

interface ModalData {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly sources: ModelSources;
  readonly available: AvailableModels;
  readonly sessionLabel: string | null;
  readonly done: (action: ModelsPickerAction | null) => void;
}

function itemWith(value: string, label: string, description?: string): SelectItem {
  return description !== undefined && description.length > 0
    ? { value, label, description }
    : { value, label };
}

/**
 * The multi-step modal: role list → model list → (optional) thinking level,
 * with an embedded filter-input state. Follows the QuestionModal pattern:
 * state-driven rebuild of a Container inside a ctx.ui.custom overlay.
 */
class ModelsPickerModal implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly sources: ModelSources;
  private readonly available: AvailableModels;
  private readonly sessionLabel: string | null;
  private readonly done: (action: ModelsPickerAction | null) => void;
  private readonly container = new Container();
  private mode: PickerMode = "roles";
  private role: ModelRoleKey = "researcher";
  private filterText = "";
  private pendingModel: PiModelInfo | null = null;
  private selectList: SelectList | null = null;
  private input: Input | null = null;
  private resolved = false;

  /** Focusable — propagated to the embedded Input for IME cursor placement. */
  get focused(): boolean {
    return this.input?.focused ?? false;
  }
  set focused(value: boolean) {
    if (this.input) this.input.focused = value;
  }

  constructor(data: ModalData) {
    this.tui = data.tui;
    this.theme = data.theme;
    this.sources = data.sources;
    this.available = data.available;
    this.sessionLabel = data.sessionLabel;
    this.done = data.done;
    this.rebuild();
  }

  private rebuild(): void {
    const th = this.theme;
    this.container.clear();
    this.selectList = null;
    this.input = null;
    this.container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

    if (this.mode === "roles") this.buildRoles();
    else if (this.mode === "models") this.buildModels();
    else if (this.mode === "thinking") this.buildThinking();
    else this.buildFilter();

    this.container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
  }

  private buildRoles(): void {
    const th = this.theme;
    this.container.addChild(
      new Text(th.fg("accent", th.bold("gx-dev \u00b7 per-role model assignment")), 1, 0),
    );
    this.container.addChild(
      new Text(
        this.sessionLabel !== null
          ? th.fg("muted", `session default: ${this.sessionLabel}`)
          : th.fg("dim", "session default: (none \u2014 inherit rows will fall back to defaults)"),
        1,
        0,
      ),
    );
    const items: SelectItem[] = resolveAllRoleOverviews(this.sources).map((o) => {
      const effective =
        o.spec === INHERIT_MODEL && this.sessionLabel !== null
          ? `inherit \u2192 ${this.sessionLabel}`
          : o.spec;
      return itemWith(o.role, o.role, `${effective} \u00b7 ${o.source}`);
    });
    items.push({ value: ACTION_EXIT, label: "\u2715 exit \u2014 leave model picker" });
    this.attachList(items, "roles", "\u2191\u2193 choose role \u00b7 enter select \u00b7 esc exit");
  }

  private buildModels(): void {
    const th = this.theme;
    const total = this.available.models.length;
    this.container.addChild(
      new Text(
        th.fg("accent", th.bold(`gx-dev \u00b7 models for ${this.role}`)) +
          th.fg("muted", ` \u00b7 ${total} available via ${this.available.source}`),
        1,
        0,
      ),
    );
    if (total === 0) {
      this.container.addChild(
        new Text(
          th.fg("warning", "no models available from registry or CLI \u2014 only inherit/clear apply"),
          1,
          0,
        ),
      );
    }
    if (this.filterText.length > 0) {
      this.container.addChild(
        new Text(th.fg("warning", `filter: "${this.filterText}" (filter\u2026 row clears)`), 1, 0),
      );
    }
    const query = this.filterText.trim().toLowerCase();
    const visible =
      query.length === 0
        ? this.available.models
        : this.available.models.filter((m) => m.id.toLowerCase().includes(query));
    const items: SelectItem[] = visible.map((m) => {
      const badges: string[] = [];
      if (m.reasoning) badges.push("thinking");
      if (m.images) badges.push("images");
      const name = m.name !== m.id && m.name.length > 0 ? m.name : undefined;
      const desc = [name, ...badges].filter((part) => part !== undefined).join(" \u00b7 ");
      return itemWith(m.id, m.id, desc || undefined);
    });
    items.push(
      itemWith(
        ACTION_INHERIT,
        "inherit \u2014 use session default",
        this.sessionLabel ?? undefined,
      ),
    );
    items.push(itemWith(ACTION_CLEAR, "clear override \u2014 remove explicit selection"));
    if (total > FILTER_THRESHOLD || this.filterText.length > 0) {
      items.push(
        itemWith(
          ACTION_FILTER,
          "filter\u2026",
          this.filterText.length > 0 ? `current: "${this.filterText}"` : "type to narrow the list",
        ),
      );
    }
    this.attachList(
      items,
      "models",
      "\u2191\u2193 choose \u00b7 enter select \u00b7 esc back to roles",
    );
  }

  private buildThinking(): void {
    const th = this.theme;
    const model = this.pendingModel;
    this.container.addChild(
      new Text(
        th.fg("accent", th.bold(`gx-dev \u00b7 thinking level for ${this.role}`)) +
          th.fg("muted", model !== null ? ` \u00b7 ${model.id}` : ""),
        1,
        0,
      ),
    );
    const items: SelectItem[] = THINKING_LEVELS.map((level) => itemWith(level, level));
    const list = this.attachList(
      items,
      "thinking",
      "\u2191\u2193 choose \u00b7 enter select \u00b7 esc back to models",
    );
    // Default "max" preselected at the top of the working set.
    const maxIdx = THINKING_LEVELS.indexOf("max");
    list.setSelectedIndex(maxIdx >= 0 ? maxIdx : 0);
  }

  private buildFilter(): void {
    const th = this.theme;
    this.container.addChild(
      new Text(
        th.fg("accent", th.bold(`gx-dev \u00b7 filter models for ${this.role}`)),
        1,
        0,
      ),
    );
    const input = new Input();
    input.setValue(this.filterText);
    input.onSubmit = (value: string) => {
      this.filterText = value.trim();
      this.mode = "models";
      this.rebuild();
      this.tui.requestRender();
    };
    this.input = input;
    this.container.addChild(input);
    this.container.addChild(
      new Text(th.fg("dim", "enter apply filter \u00b7 esc back (keeps current filter)"), 1, 0),
    );
  }

  private attachList(items: SelectItem[], mode: PickerMode, hint: string): SelectList {
    const th = this.theme;
    const list = new SelectList(items, Math.min(Math.max(items.length, 1), LIST_MAX_ROWS), {
      selectedPrefix: (t: string) => th.fg("accent", t),
      selectedText: (t: string) => th.fg("accent", t),
      description: (t: string) => th.fg("muted", t),
      scrollInfo: (t: string) => th.fg("dim", t),
      noMatch: (t: string) => th.fg("warning", t),
    });
    list.onSelect = (item: SelectItem) => this.onSelect(item, mode);
    list.onCancel = () => this.onCancel(mode);
    this.selectList = list;
    this.container.addChild(list);
    this.container.addChild(new Text(th.fg("dim", hint), 1, 0));
    return list;
  }

  private onSelect(item: SelectItem, mode: PickerMode): void {
    if (mode === "roles") {
      if (item.value === ACTION_EXIT) {
        this.finish(null);
        return;
      }
      this.role = item.value as ModelRoleKey;
      this.mode = "models";
    } else if (mode === "models") {
      if (item.value === ACTION_INHERIT) {
        this.finish({ kind: "inherit", role: this.role });
        return;
      }
      if (item.value === ACTION_CLEAR) {
        this.finish({ kind: "clear", role: this.role });
        return;
      }
      if (item.value === ACTION_FILTER) {
        this.mode = "filter";
      } else {
        const info = this.available.models.find((m) => m.id === item.value);
        if (info !== undefined) this.chooseModel(info);
        return;
      }
    } else if (mode === "thinking") {
      // THINKING_LEVELS entries are plain strings; qualifySpec appends the
      // suffix only for reasoning models.
      const model = this.pendingModel;
      if (model === null) {
        this.mode = "models";
      } else {
        this.finish({
          kind: "set",
          role: this.role,
          spec: qualifySpec(model, item.value),
        });
        return;
      }
    }
    this.rebuild();
    this.tui.requestRender();
  }

  private onCancel(mode: PickerMode): void {
    if (mode === "roles") {
      this.finish(null);
      return;
    }
    this.mode = mode === "thinking" ? "models" : "roles";
    this.rebuild();
    this.tui.requestRender();
  }

  /** Concrete model chosen: reasoning models pick a thinking level first. */
  private chooseModel(info: PiModelInfo): void {
    if (info.reasoning) {
      this.pendingModel = info;
      this.mode = "thinking";
    } else {
      // Non-reasoning models skip the thinking step entirely.
      this.finish({ kind: "set", role: this.role, spec: qualifySpec(info) });
      return;
    }
    this.rebuild();
    this.tui.requestRender();
  }

  private finish(action: ModelsPickerAction | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.container.clear();
    this.done(action);
  }

  handleInput(data: string): void {
    if (this.resolved) return;
    if (matchesKey(data, Key.escape)) {
      // Single escape path per mode (the filter Input never sees it).
      if (this.mode === "roles") this.finish(null);
      else if (this.mode === "thinking") this.onCancel("thinking");
      else if (this.mode === "models") this.onCancel("models");
      else {
        this.mode = "models";
        this.rebuild();
      }
      this.tui.requestRender();
      return;
    }
    if (this.mode === "filter") this.input?.handleInput(data);
    else this.selectList?.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}
