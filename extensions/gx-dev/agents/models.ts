/**
 * Per-subagent model selection (PLAN §16).
 *
 * Users pick the model for each subagent from THEIR pi setup. Discovery has
 * two surfaces: the CLI (`pi --list-models [search]` printing a fixed-width
 * table) and the extension registry (`ctx.modelRegistry.getAvailable()`).
 * This module normalizes both into PiModelInfo, splits and qualifies
 * selection strings ("provider/model[:thinking]"), matches a selection
 * against the discovered models, and resolves the effective spec per role
 * with a fixed precedence: explicit user config > role frontmatter >
 * configured default > builtin default. "inherit" at any layer delegates to
 * the orchestrating session's model.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** A model available in the user's pi setup. `id` = `${provider}/${modelId}`. */
export interface PiModelInfo {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  images: boolean;
  contextWindow?: string;
  maxOutput?: string;
}

/** Thinking levels accepted in a selection's `:thinking` suffix. */
export const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "true" || v === "yes" || v === "1" || v === "on";
}

function optString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * Parses `pi --list-models` output: a fixed-width table with columns
 * `provider model context max-out thinking images`. The header (first line
 * starting with "provider") and blank lines are skipped; rows are split on
 * 2+ spaces; missing trailing columns are tolerated (thinking/images then
 * default to false); rows without a provider and model column are ignored.
 */
export function parseListModelOutput(stdout: string): PiModelInfo[] {
  const out: PiModelInfo[] = [];
  for (const rawLine of stdout.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.toLowerCase().startsWith("provider")) continue;
    const cols = line
      .split(/\s{2,}/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const provider = cols[0];
    const modelId = cols[1];
    if (provider === undefined || modelId === undefined) continue;
    out.push({
      id: `${provider}/${modelId}`,
      provider,
      modelId,
      name: modelId,
      reasoning: cols[4]?.toLowerCase() === "yes",
      images: cols[5]?.toLowerCase() === "yes",
      ...(cols[2] !== undefined ? { contextWindow: cols[2] } : {}),
      ...(cols[3] !== undefined ? { maxOutput: cols[3] } : {}),
    });
  }
  return out;
}

/**
 * Runs `<piBinary> --list-models [search]` (argv array, never a shell) and
 * parses its table. Returns [] on spawn errors, nonzero exit, timeout
 * (child is killed; default 30s), or any parse yielding nothing usable.
 */
export async function listModelsViaCli(
  piBinary: string,
  search?: string,
  timeoutMs: number = 30_000,
): Promise<PiModelInfo[]> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(piBinary, ["--list-models", ...(search ? [search] : [])], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve([]);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (models: PiModelInfo[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(models);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      finish([]);
    }, timeoutMs);
    timer.unref();

    child.on("error", () => finish([]));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish([]);
        return;
      }
      finish(parseListModelOutput(stdout));
    });
  });
}

/**
 * Normalizes registry Model objects (ctx.modelRegistry.getAvailable()) into
 * PiModelInfo. Defensive by design: `provider` may be a string or {id};
 * the model id may sit under `id` or `modelId`; `name` defaults to the
 * model id; booleans are read leniently. Entries without a usable provider
 * or id are skipped; never throws on odd shapes.
 */
export function listModelsViaRegistry(models: Array<Record<string, unknown>>): PiModelInfo[] {
  const out: PiModelInfo[] = [];
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") continue;

    let provider: string | undefined;
    const rawProvider: unknown = entry["provider"];
    if (typeof rawProvider === "string" && rawProvider.length > 0) {
      provider = rawProvider;
    } else if (rawProvider !== null && typeof rawProvider === "object") {
      const pid = (rawProvider as Record<string, unknown>)["id"];
      if (typeof pid === "string" && pid.length > 0) provider = pid;
    }
    if (provider === undefined) continue;

    const rawId: unknown = entry["id"] ?? entry["modelId"];
    if (typeof rawId !== "string" || rawId.length === 0) continue;

    const rawName: unknown = entry["name"];
    const contextWindow = optString(entry["contextWindow"]);
    const maxOutput = optString(entry["maxOutput"]);
    out.push({
      id: `${provider}/${rawId}`,
      provider,
      modelId: rawId,
      name: typeof rawName === "string" && rawName.length > 0 ? rawName : rawId,
      reasoning: truthy(entry["reasoning"]),
      images: truthy(entry["images"]),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
    });
  }
  return out;
}

/**
 * Splits a selection into its base spec and thinking suffix. The colon only
 * counts when it appears AFTER the last `/`, so path-like model ids
 * ("ollama-cloud/deepseek-v4-flash:0731") survive; the LAST colon after the
 * slash separates thinking ("…/:0731:max" -> base keeps ":0731").
 */
export function splitSpec(spec: string): { base: string; thinking?: string } {
  const slash = spec.lastIndexOf("/");
  const colon = spec.lastIndexOf(":");
  if (colon !== -1 && colon > slash) {
    const base = spec.slice(0, colon);
    const thinking = spec.slice(colon + 1);
    if (thinking.length > 0) return { base, thinking };
  }
  return { base: spec };
}

/** How a role's model spec was resolved, at which precedence layer. */
export interface ModelSpecResolution {
  spec: string | null;
  inherits: boolean;
  source: "explicit-config" | "frontmatter" | "configured-default" | "builtin-default";
  modelId?: string;
  thinking?: string;
}

/**
 * Resolves the effective model spec for a role. Precedence:
 * explicitConfigModel -> frontmatterModel -> configuredDefault ->
 * builtinDefault. A layer whose value is "inherit" (case-insensitive)
 * resolves IMMEDIATELY as { spec: null, inherits: true, source: <layer> } —
 * it wins over every lower layer, including any pin there. When no layer is
 * set at all, nothing is pinned and the session model applies (inherits at
 * the builtin-default layer).
 */
export function resolveModelSpec(input: {
  frontmatterModel?: string | undefined;
  explicitConfigModel?: string | undefined;
  configuredDefault?: string | undefined;
  builtinDefault?: string | undefined;
}): ModelSpecResolution {
  const layers: Array<[string | undefined, ModelSpecResolution["source"]]> = [
    [input.explicitConfigModel, "explicit-config"],
    [input.frontmatterModel, "frontmatter"],
    [input.configuredDefault, "configured-default"],
    [input.builtinDefault, "builtin-default"],
  ];
  for (const [value, source] of layers) {
    if (value === undefined || value.length === 0) continue;
    if (value.trim().toLowerCase() === "inherit") {
      return { spec: null, inherits: true, source };
    }
    const { base, thinking } = splitSpec(value);
    return {
      spec: value,
      inherits: false,
      source,
      modelId: base,
      ...(thinking !== undefined ? { thinking } : {}),
    };
  }
  return { spec: null, inherits: true, source: "builtin-default" };
}

/**
 * First PiModelInfo matching the selection: exact id; selection base
 * (sans thinking) equals id; selection equals modelId case-insensitively;
 * selection base equals modelId case-insensitively. Strategies are tried in
 * that priority order; within a strategy the first model wins. Null if none.
 */
export function matchModel(models: PiModelInfo[], selection: string): PiModelInfo | null {
  const { base } = splitSpec(selection);
  const selectionLc = selection.toLowerCase();
  const baseLc = base.toLowerCase();
  for (const m of models) if (m.id === selection) return m;
  for (const m of models) if (m.id === base) return m;
  for (const m of models) if (m.modelId.toLowerCase() === selectionLc) return m;
  for (const m of models) if (m.modelId.toLowerCase() === baseLc) return m;
  return null;
}

/**
 * Fully qualified selection: `provider/modelId`, plus `:thinking` only when
 * the model supports reasoning AND a thinking suffix is provided.
 */
export function qualifySpec(model: PiModelInfo, thinking?: string): string {
  const base = `${model.provider}/${model.modelId}`;
  if (model.reasoning && thinking !== undefined && thinking.length > 0) {
    return `${base}:${thinking}`;
  }
  return base;
}
