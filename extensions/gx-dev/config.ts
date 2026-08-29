/**
 * Configuration model (PLAN §16). Defaults model every subagent to
 * zai/glm-5.3-flash at max thinking. Project config is honored only after
 * project trust is established (see security docs).
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
  const base = defaultConfig();
  const explicitModels: Partial<Record<ModelRoleKey, string>> = {};
  if (raw === null || typeof raw !== "object") {
    return { ok: false, errors: ["config must be an object"], config: base, explicitModels };
  }
  const cfg = raw as Partial<GxConfig> & Record<string, unknown>;
  if (cfg["version"] !== 1) errors.push("version: must be 1");

  const agents = cfg.agents;
  if (agents && typeof agents === "object") {
    if (typeof agents.maxConcurrency === "number" && Number.isInteger(agents.maxConcurrency) && agents.maxConcurrency >= 1) {
      base.agents.maxConcurrency = agents.maxConcurrency;
    } else if (agents.maxConcurrency !== undefined) {
      errors.push("agents.maxConcurrency: positive integer required");
    }
    if (typeof agents.timeoutMinutes === "number" && agents.timeoutMinutes > 0) {
      base.agents.timeoutMinutes = agents.timeoutMinutes;
    }
    if (typeof agents.piBinary === "string" && agents.piBinary.length > 0) {
      base.agents.piBinary = agents.piBinary;
    }
    const models = agents.models;
    if (models && typeof models === "object") {
      for (const role of Object.keys(base.agents.models) as ModelRoleKey[]) {
        const v = (models as unknown as Record<string, unknown>)[role];
        if (v === undefined) continue;
        if (typeof v !== "string") {
          errors.push(`agents.models.${role}: string required`);
          continue;
        }
        if (v !== "inherit" && !isPlausibleModelSpec(v)) {
          errors.push(`agents.models.${role}: must be "inherit" or provider/model[:thinking]`);
          continue;
        }
        base.agents.models[role] = v;
        explicitModels[role] = v;
      }
    }
  }

  const gates = cfg.gates;
  if (gates && typeof gates === "object") {
    if (typeof gates.maxConsecutiveFailures === "number" && gates.maxConsecutiveFailures >= 1) {
      base.gates.maxConsecutiveFailures = gates.maxConsecutiveFailures;
    }
    if (typeof gates.maxTotalAttempts === "number" && gates.maxTotalAttempts >= 1) {
      base.gates.maxTotalAttempts = gates.maxTotalAttempts;
    }
    if (typeof gates.requireCleanFinalTree === "boolean") {
      base.gates.requireCleanFinalTree = gates.requireCleanFinalTree;
    }
  }

  const research = cfg.research;
  if (research && typeof research === "object") {
    if (typeof research.webEnabled === "boolean") base.research.webEnabled = research.webEnabled;
    if (typeof research.recordSources === "boolean") base.research.recordSources = research.recordSources;
  }

  const memory = cfg.memory;
  if (memory && typeof memory === "object") {
    if (typeof memory.enabled === "boolean") base.memory.enabled = memory.enabled;
    if (typeof memory.updateOnSuccess === "boolean") base.memory.updateOnSuccess = memory.updateOnSuccess;
    if (typeof memory.reviewRequired === "boolean") base.memory.reviewRequired = memory.reviewRequired;
    if (typeof memory.redactSecrets === "boolean") base.memory.redactSecrets = memory.redactSecrets;
  }

  const git = cfg.git;
  if (git && typeof git === "object") {
    if (git.worktreeRoot === "adjacent" || typeof git.worktreeRoot === "string") {
      base.git.worktreeRoot = git.worktreeRoot;
    }
    if (typeof git.retainFailedRuns === "boolean") base.git.retainFailedRuns = git.retainFailedRuns;
    if (typeof git.autoCommit === "boolean") base.git.autoCommit = git.autoCommit;
    if (typeof git.allowHistoryRewrite === "boolean") base.git.allowHistoryRewrite = git.allowHistoryRewrite;
  }

  if (base.git.allowHistoryRewrite) {
    errors.push("git.allowHistoryRewrite: history rewriting is not permitted; remove this option");
  }

  return { ok: errors.length === 0, errors, config: base, explicitModels };
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
