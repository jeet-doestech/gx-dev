/**
 * Configuration model (PLAN §16). Defaults model every subagent to
 * zai/glm-5.3-flash at max thinking. Project config is honored only after
 * project trust is established (see security docs — index.ts checks
 * ctx.isProjectTrusted() before this file's project loader is called).
 *
 * Validation is strict and fails closed: every known field is type- and
 * range-checked, unknown keys are rejected at every level, and any error
 * makes the whole config invalid. Callers must treat an invalid config as a
 * hard failure (loadConfigWithSources throws); a partial application of an
 * invalid file must never leak defaults that silently re-enable behavior.
 * Only "adjacent" is a supported git.worktreeRoot; other values are
 * rejected instead of being honored only partially. Default flag values
 * (e.g. research.webEnabled: true, memory.reviewRequired: true) always
 * validate — flags the engine honors (git.autoCommit, agents.maxConcurrency,
 * git.retainFailedRuns, gates.*) stay plain accepted options.
 */

export interface AgentModelConfig {
  /** "inherit" uses the orchestrating session's provider/model. */
  researcher: string;
  planner: string;
  developer: string;
  testWriter: string;
  testRunner: string;
  reviewer: string;
  committer: string;
}

export interface GxConfig {
  version: 1;
  agents: {
    maxConcurrency: number;
    timeoutMinutes: number;
    /** pi binary used for child processes; "pi" resolves from PATH. */
    piBinary: string;
    models: AgentModelConfig;
  };
  gates: {
    maxConsecutiveFailures: number;
    maxTotalAttempts: number;
    requireCleanFinalTree: boolean;
  };
  research: {
    webEnabled: boolean;
    recordSources: boolean;
  };
  memory: {
    enabled: boolean;
    updateOnSuccess: boolean;
    reviewRequired: boolean;
    redactSecrets: boolean;
  };
  git: {
    worktreeRoot: "adjacent" | string;
    retainFailedRuns: boolean;
    autoCommit: boolean;
    allowHistoryRewrite: boolean;
  };
}

/** All subagents default to GLM-5.3-Flash at max thinking on the zai provider. */
export const GLM_53_FLASH_MAX = "zai/glm-5.3-flash:max";

export function defaultConfig(): GxConfig {
  return {
    version: 1,
    agents: {
      maxConcurrency: 2,
      timeoutMinutes: 30,
      piBinary: "pi",
      models: {
        researcher: GLM_53_FLASH_MAX,
        planner: GLM_53_FLASH_MAX,
        developer: GLM_53_FLASH_MAX,
        testWriter: GLM_53_FLASH_MAX,
        testRunner: GLM_53_FLASH_MAX,
        reviewer: GLM_53_FLASH_MAX,
        committer: GLM_53_FLASH_MAX,
      },
    },
    gates: {
      maxConsecutiveFailures: 5,
      maxTotalAttempts: 20,
      requireCleanFinalTree: true,
    },
    research: {
      webEnabled: true,
      recordSources: true,
    },
    memory: {
      enabled: true,
      updateOnSuccess: true,
      reviewRequired: true,
      redactSecrets: true,
    },
    git: {
      worktreeRoot: "adjacent",
      retainFailedRuns: true,
      autoCommit: true,
      allowHistoryRewrite: false,
    },
  };
}


/** Role keys for per-subagent model selection. */
export type ModelRoleKey = keyof AgentModelConfig;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Supported range for agents.maxConcurrency. */
const MAX_CONCURRENCY_RANGE = { min: 1, max: 16 } as const;
/** Supported range for agents.timeoutMinutes (minutes; cap = one day). */
const TIMEOUT_MINUTES_RANGE = { min: 0, max: 1440 } as const;
/** Supported range for gates.maxConsecutiveFailures. */
const MAX_CONSECUTIVE_FAILURES_RANGE = { min: 1, max: 100 } as const;
/** Supported range for gates.maxTotalAttempts. */
const MAX_TOTAL_ATTEMPTS_RANGE = { min: 1, max: 1000 } as const;

const KNOWN_TOP_LEVEL_KEYS: readonly string[] = [
  "version",
  "agents",
  "gates",
  "research",
  "memory",
  "git",
];

const KNOWN_SECTION_KEYS: Record<string, readonly string[]> = {
  agents: ["maxConcurrency", "timeoutMinutes", "piBinary", "models"],
  gates: ["maxConsecutiveFailures", "maxTotalAttempts", "requireCleanFinalTree"],
  research: ["webEnabled", "recordSources"],
  memory: ["enabled", "updateOnSuccess", "reviewRequired", "redactSecrets"],
  git: ["worktreeRoot", "retainFailedRuns", "autoCommit", "allowHistoryRewrite"],
};

function rejectUnknownKeys(
  section: string,
  obj: Record<string, unknown>,
  known: readonly string[],
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) errors.push(`${section}.${key}: unknown option`);
  }
}

function expectIntegerInRange(
  section: string,
  key: string,
  obj: Record<string, unknown>,
  min: number,
  max: number,
  errors: string[],
): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    errors.push(`${section}.${key}: integer between ${min} and ${max} required`);
    return undefined;
  }
  return v;
}

function expectBoolean(
  section: string,
  key: string,
  obj: Record<string, unknown>,
  errors: string[],
): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    errors.push(`${section}.${key}: boolean required`);
    return undefined;
  }
  return v;
}


export const MODEL_ROLE_KEYS: readonly ModelRoleKey[] = [
  "researcher",
  "planner",
  "developer",
  "testWriter",
  "testRunner",
  "reviewer",
  "committer",
];

/** The literal that delegates a role to the session's default model. */
export const INHERIT_MODEL = "inherit";

export interface ConfigValidationResult {
  ok: boolean;
  errors: string[];
  config: GxConfig;
  /** Model selections present verbatim in the user's config file. These are
   * explicit user choices and take precedence over role-prompt pins. */
  explicitModels: Partial<Record<ModelRoleKey, string>>;
}

export function validateConfig(raw: unknown): ConfigValidationResult {
  const errors: string[] = [];
  const out = defaultConfig();
  const explicitModels: Partial<Record<ModelRoleKey, string>> = {};
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["config must be an object"], config: out, explicitModels };
  }
  const cfg: Record<string, unknown> = raw;
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_TOP_LEVEL_KEYS.includes(key)) errors.push(`"${key}": unknown config key`);
  }
  if (cfg["version"] !== 1) errors.push("version: must be 1");

  const agents = cfg["agents"];
  if (agents !== undefined) {
    if (!isPlainObject(agents)) {
      errors.push("agents: object required");
    } else {
      rejectUnknownKeys("agents", agents, KNOWN_SECTION_KEYS["agents"] ?? [], errors);
      const maxConcurrency = expectIntegerInRange(
        "agents", "maxConcurrency", agents,
        MAX_CONCURRENCY_RANGE.min, MAX_CONCURRENCY_RANGE.max, errors,
      );
      if (maxConcurrency !== undefined) out.agents.maxConcurrency = maxConcurrency;
      const timeout = agents["timeoutMinutes"];
      if (timeout !== undefined) {
        if (
          typeof timeout !== "number" || !Number.isFinite(timeout) ||
          timeout <= TIMEOUT_MINUTES_RANGE.min || timeout > TIMEOUT_MINUTES_RANGE.max
        ) {
          errors.push(
            `agents.timeoutMinutes: number greater than ${TIMEOUT_MINUTES_RANGE.min} and at most ${TIMEOUT_MINUTES_RANGE.max} required`,
          );
        } else {
          out.agents.timeoutMinutes = timeout;
        }
      }
      const piBinary = agents["piBinary"];
      if (piBinary !== undefined) {
        if (
          typeof piBinary !== "string" || piBinary.trim().length === 0 ||
          /\s/.test(piBinary) || /[\u0000-\u001f]/.test(piBinary)
        ) {
          errors.push("agents.piBinary: non-empty executable path without whitespace required");
        } else {
          out.agents.piBinary = piBinary;
        }
      }
      const models = agents["models"];
      if (models !== undefined) {
        if (!isPlainObject(models)) {
          errors.push("agents.models: object required");
        } else {
          for (const key of Object.keys(models)) {
            if (!MODEL_ROLE_KEYS.includes(key as ModelRoleKey)) {
              errors.push(`agents.models.${key}: unknown role`);
            }
          }
          for (const role of MODEL_ROLE_KEYS) {
            const v: unknown = models[role];
            if (v === undefined) continue;
            if (typeof v !== "string") {
              errors.push(`agents.models.${role}: string required`);
              continue;
            }
            if (v !== INHERIT_MODEL && !isPlausibleModelSpec(v)) {
              errors.push(`agents.models.${role}: must be "inherit" or provider/model[:thinking]`);
              continue;
            }
            out.agents.models[role] = v;
            explicitModels[role] = v;
          }
        }
      }
    }
  }

  const gates = cfg["gates"];
  if (gates !== undefined) {
    if (!isPlainObject(gates)) {
      errors.push("gates: object required");
    } else {
      rejectUnknownKeys("gates", gates, KNOWN_SECTION_KEYS["gates"] ?? [], errors);
      const consecutive = expectIntegerInRange(
        "gates", "maxConsecutiveFailures", gates,
        MAX_CONSECUTIVE_FAILURES_RANGE.min, MAX_CONSECUTIVE_FAILURES_RANGE.max, errors,
      );
      if (consecutive !== undefined) out.gates.maxConsecutiveFailures = consecutive;
      const total = expectIntegerInRange(
        "gates", "maxTotalAttempts", gates,
        MAX_TOTAL_ATTEMPTS_RANGE.min, MAX_TOTAL_ATTEMPTS_RANGE.max, errors,
      );
      if (total !== undefined) out.gates.maxTotalAttempts = total;
      const clean = expectBoolean("gates", "requireCleanFinalTree", gates, errors);
      if (clean !== undefined) out.gates.requireCleanFinalTree = clean;
    }
  }

  const research = cfg["research"];
  if (research !== undefined) {
    if (!isPlainObject(research)) {
      errors.push("research: object required");
    } else {
      rejectUnknownKeys("research", research, KNOWN_SECTION_KEYS["research"] ?? [], errors);
      const web = expectBoolean("research", "webEnabled", research, errors);
      if (web !== undefined) out.research.webEnabled = web;
      const sources = expectBoolean("research", "recordSources", research, errors);
      if (sources !== undefined) out.research.recordSources = sources;
    }
  }

  const memory = cfg["memory"];
  if (memory !== undefined) {
    if (!isPlainObject(memory)) {
      errors.push("memory: object required");
    } else {
      rejectUnknownKeys("memory", memory, KNOWN_SECTION_KEYS["memory"] ?? [], errors);
      for (const key of ["enabled", "updateOnSuccess", "reviewRequired", "redactSecrets"] as const) {
        const v = expectBoolean("memory", key, memory, errors);
        if (v !== undefined) out.memory[key] = v;
      }
    }
  }

  const git = cfg["git"];
  if (git !== undefined) {
    if (!isPlainObject(git)) {
      errors.push("git: object required");
    } else {
      rejectUnknownKeys("git", git, KNOWN_SECTION_KEYS["git"] ?? [], errors);
      const worktreeRoot = git["worktreeRoot"];
      if (worktreeRoot !== undefined) {
        // Only the supported layout is accepted; anything else is an error so
        // an unimplemented option can never silently change behavior.
        if (worktreeRoot !== "adjacent") {
          errors.push('git.worktreeRoot: only "adjacent" is supported');
        }
      }
      const retain = expectBoolean("git", "retainFailedRuns", git, errors);
      if (retain !== undefined) out.git.retainFailedRuns = retain;
      const autoCommit = expectBoolean("git", "autoCommit", git, errors);
      if (autoCommit !== undefined) out.git.autoCommit = autoCommit;
      const rewrite = expectBoolean("git", "allowHistoryRewrite", git, errors);
      if (rewrite !== undefined) out.git.allowHistoryRewrite = rewrite;
    }
  }

  if (out.git.allowHistoryRewrite) {
    errors.push("git.allowHistoryRewrite: history rewriting is not permitted; remove this option");
  }
  // Do not accept policy switches which the trusted-host runtime cannot enforce.
  if (!out.research.webEnabled) {
    errors.push("research.webEnabled: false is unsupported without network isolation; run only in a trusted environment");
  }
  if (!out.research.recordSources) {
    errors.push("research.recordSources: false is unsupported; source provenance cannot be disabled");
  }
  if (!out.memory.reviewRequired) {
    errors.push("memory.reviewRequired: false is unsupported; durable memory always requires review");
  }

  // Fail closed: never return a partially-applied config. Callers must treat
  // ok=false as "no usable config" (defaults are returned only so callers
  // always see a well-typed value; they must not proceed with it).
  if (errors.length > 0) {
    return { ok: false, errors, config: defaultConfig(), explicitModels: {} };
  }
  return { ok: true, errors: [], config: out, explicitModels };
}

function isPlausibleModelSpec(v: string): boolean {
  // provider/model[:thinking]
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:+-]+$/.test(v);
}

/** True for well-formed selections: "inherit" or provider/model[:thinking]. */
export function isValidModelSelection(v: string): boolean {
  return v === INHERIT_MODEL || isPlausibleModelSpec(v);
}

export interface LoadedConfig {
  config: GxConfig;
  explicitModels: Partial<Record<ModelRoleKey, string>>;
  /** True when a user config file existed. */
  fromFile: boolean;
}

/** Loads .gx-dev/config.json with explicit-selection tracking, else defaults. */
export async function loadConfigWithSources(repoPath: string): Promise<LoadedConfig> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = join(repoPath, ".gx-dev", "config.json");
  if (!existsSync(file)) {
    return { config: defaultConfig(), explicitModels: {}, fromFile: false };
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const result = validateConfig(raw);
    if (!result.ok) {
      throw new Error(`invalid gx-dev config: ${result.errors.join("; ")}`);
    }
    return {
      config: result.config,
      explicitModels: result.explicitModels,
      fromFile: true,
    };
  } catch (e) {
    throw new Error(`cannot load ${file}: ${(e as Error).message}`);
  }
}

/** Reads the raw user config object (empty when absent). */
async function readRawConfig(repoPath: string): Promise<Record<string, unknown>> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = join(repoPath, ".gx-dev", "config.json");
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writeRawConfig(repoPath: string, raw: Record<string, unknown>): Promise<void> {
  const { mkdirSync, writeFileSync, renameSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = join(repoPath, ".gx-dev", "config.json");
  mkdirSync(join(repoPath, ".gx-dev"), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

function withModelKey(raw: Record<string, unknown>, role: ModelRoleKey, value: string | undefined): Record<string, unknown> {
  const agents = { ...((raw["agents"] as Record<string, unknown> | undefined) ?? {}) };
  const models = {
    ...((agents["models"] as Record<string, string> | undefined) ?? {}),
  };
  if (value === undefined) delete models[role];
  else models[role] = value;
  agents["models"] = models;
  return { ...raw, version: 1, agents };
}

/**
 * Persists one per-subagent model selection into .gx-dev/config.json
 * (atomic write; creates the file when absent). `spec` is "inherit" or
 * "provider/model[:thinking]". Returns the updated explicit map.
 */
export async function mergeModelSelection(
  repoPath: string,
  role: ModelRoleKey,
  spec: string,
): Promise<Partial<Record<ModelRoleKey, string>>> {
  if (!isValidModelSelection(spec)) {
    throw new Error(
      `invalid model selection for ${role}: ${spec} (expected "inherit" or provider/model[:thinking])`,
    );
  }
  const raw = await readRawConfig(repoPath);
  await writeRawConfig(repoPath, withModelKey(raw, role, spec));
  const { explicitModels } = await loadConfigWithSources(repoPath);
  return explicitModels;
}

/** Removes one per-subagent selection so role-prompt/default applies again. */
export async function unsetModelSelection(
  repoPath: string,
  role: ModelRoleKey,
): Promise<Partial<Record<ModelRoleKey, string>>> {
  const raw = await readRawConfig(repoPath);
  await writeRawConfig(repoPath, withModelKey(raw, role, undefined));
  const { explicitModels } = await loadConfigWithSources(repoPath);
  return explicitModels;
}

/** Loads .gx-dev/config.json when present, else defaults. */
export async function loadConfig(repoPath: string): Promise<GxConfig> {
  return (await loadConfigWithSources(repoPath)).config;
}
