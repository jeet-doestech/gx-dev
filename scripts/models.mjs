#!/usr/bin/env node
/**
 * Headless per-subagent model selection CLI for gx-dev.
 *
 *   node scripts/models.mjs                  # show (default)
 *   node scripts/models.mjs show
 *   node scripts/models.mjs list [search]    # real `pi --list-models [search]`
 *   node scripts/models.mjs set <role> <spec>
 *   node scripts/models.mjs unset <role>
 *   node scripts/models.mjs get <role>
 *
 * Resolution layers (highest precedence first): explicit user selection in
 * <repo>/.gx-dev/config.json ("explicit-config") > role-prompt frontmatter
 * `model:` pin ("frontmatter") > configured per-role default
 * ("configured-default") > builtin zai/glm-5.3-flash:max ("builtin-default").
 * The literal value "inherit" delegates to the orchestrating session's model.
 *
 * Exit codes: 0 ok · 1 usage error / unknown role / environment failure ·
 * 2 invalid model spec.
 *
 * Trust guard (mirror of the extension's ctx.isProjectTrusted() policy):
 * scripts run outside pi's project-trust model, so a repository-configured
 * executable (agents.piBinary) is NEVER executed here — model-availability
 * probes always use the ambient `pi` on PATH, never the repo's configured
 * binary. Mutating commands (set/unset) refuse to touch a repo config that
 * fails strict validation: the merge helpers tolerate unreadable configs and
 * would silently replace the whole file with just the new selection, so an
 * invalid file is a hard stop (fix or remove it first) instead of a wipe.
 *
 * Frozen sibling contracts used (extensions/gx-dev, loaded dynamically as in
 * doctor.mjs because this is a .mjs script):
 *   config.ts            MODEL_ROLE_KEYS, INHERIT_MODEL, GLM_53_FLASH_MAX,
 *                        loadConfigWithSources, mergeModelSelection,
 *                        unsetModelSelection, isValidModelSelection,
 *                        validateConfig
 *   agents/discovery.ts  loadRolePrompt (frontmatter `model:` pins)
 *   agents/models.ts     parseListModelOutput, listModelsViaCli,
 *                        listModelsViaRegistry, splitSpec, resolveModelSpec,
 *                        matchModel, qualifySpec, THINKING_LEVELS, PiModelInfo
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, "..");
const agentsDir = join(packageRoot, "agents");
const extensionsDir = join(packageRoot, "extensions", "gx-dev");

const USAGE = `usage: node scripts/models.mjs [command] [args] [--repo <path>]

commands:
  show                  per-role effective model table (default)
  list [search]         models available to pi (pi --list-models [search])
  set <role> <spec>     persist one per-role model selection
  unset <role>          remove one per-role model selection
  get <role>            detailed resolution breakdown for one role

roles: researcher, planner, developer, testWriter, testRunner, reviewer, committer
spec:  provider/model[:thinking] or "inherit"
flags: --repo <path>    target repository holding .gx-dev/config.json (default: cwd)

exit codes: 0 ok · 1 usage error / unknown role · 2 invalid model spec`;

/** Loads an extension module by relative path (type-stripped .ts import). */
async function importExtension(relativePath) {
  return import(pathToFileURL(join(extensionsDir, relativePath)).href);
}

function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

/** Parses argv into the --repo target and positional words (flag anywhere). */
function parseArgv(argv) {
  let repo = process.cwd();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error("--repo requires a path");
        process.exit(1);
      }
      repo = resolve(value);
      i += 1;
    } else if (arg.startsWith("--repo=")) {
      repo = resolve(arg.slice("--repo=".length));
    } else {
      positional.push(arg);
    }
  }
  return { repo, positional };
}

/** Accepts camelCase (testWriter) and kebab-case (test-writer) role ids. */
function normalizeRole(raw, configMod) {
  const camel = raw.replace(/-+([a-z0-9])/g, (_, c) => c.toUpperCase());
  return configMod.MODEL_ROLE_KEYS.find((r) => r === camel) ?? null;
}

/**
 * Fails closed before any mutation: a repo config that exists but is invalid
 * (unparseable JSON or strict-validation errors) blocks set/unset. Without
 * this guard the merge helpers' tolerant read would treat the broken file as
 * empty and overwrite it, silently destroying the rest of the user's config.
 */
function assertRepoConfigMutable(repoPath, configMod) {
  const file = join(repoPath, ".gx-dev", "config.json");
  if (!existsSync(file)) return;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`refusing to write ${file}: invalid JSON (${errorMessage(e)}) — fix or remove the file first`);
    process.exit(1);
  }
  const result = configMod.validateConfig(raw);
  if (!result.ok) {
    console.error(`refusing to write ${file}: invalid config (${result.errors.join("; ")}) — fix the file first`);
    process.exit(1);
  }
}

function roleOrExit(raw, configMod) {
  const role = normalizeRole(raw ?? "", configMod);
  if (role === null) {
    console.error(`unknown role '${raw}' — expected one of: ${configMod.MODEL_ROLE_KEYS.join(", ")}`);
    process.exit(1);
  }
  return role;
}

function effectiveOrInherit(spec, configMod) {
  return spec === configMod.INHERIT_MODEL ? "(inherit)" : spec;
}

/**
 * Resolves every role via resolveModelSpec with the four layers wired as in
 * the plan: frontmatter pin from the package agents dir, explicit user
 * selection from <repo>/.gx-dev/config.json, configured per-role default
 * (which falls back to the builtin zai/glm-5.3-flash:max in defaultConfig()).
 */
async function resolveAllRoles(repoPath, configMod, discoveryMod, modelsMod) {
  const loaded = await configMod.loadConfigWithSources(repoPath);
  const rows = configMod.MODEL_ROLE_KEYS.map((role) => {
    const pin = discoveryMod.loadRolePrompt(agentsDir, role)?.model;
    const explicit = loaded.explicitModels[role];
    const configuredDefault = loaded.config.agents.models[role];
    const resolved = modelsMod.resolveModelSpec({
      frontmatterModel: pin,
      explicitConfigModel: explicit,
      configuredDefault,
      builtinDefault: configMod.GLM_53_FLASH_MAX,
    });
    return {
      role,
      pin: pin ?? null,
      explicit: explicit ?? null,
      configuredDefault: configuredDefault ?? null,
      builtin: configMod.GLM_53_FLASH_MAX,
      // ModelSpecResolution.spec is null when the role inherits.
      spec: resolved.inherits ? configMod.INHERIT_MODEL : (resolved.spec ?? "(unresolved)"),
      source: resolved.source,
    };
  });
  return { loaded, rows };
}

function padTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => String(c).padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

async function cmdShow(repoPath, configMod, discoveryMod, modelsMod) {
  const { loaded, rows } = await resolveAllRoles(repoPath, configMod, discoveryMod, modelsMod);
  console.log(
    `per-subagent model selection — repo: ${repoPath}` +
      (loaded.fromFile ? "" : " (no .gx-dev/config.json — defaults)"),
  );
  console.log("");
  padTable(
    ["role", "effective spec", "source", "frontmatter pin", "explicit selection"],
    rows.map((r) => [
      r.role,
      effectiveOrInherit(r.spec, configMod),
      r.source,
      r.pin ?? "(none)",
      r.explicit ?? "(none)",
    ]),
  );
}

function isYes(v) {
  return v === true || v === "yes" || v === "true";
}

async function cmdList(search, modelsMod) {
  let models;
  try {
    models = await modelsMod.listModelsViaCli("pi", search, 15_000);
  } catch (e) {
    console.error(`list failed: ${errorMessage(e)}`);
    console.error("hint: check that pi is installed and on PATH (try: pi --version)");
    process.exit(1);
  }
  if (!Array.isArray(models) || models.length === 0) {
    console.error(
      search
        ? `no pi models match '${search}'`
        : "no models reported by pi --list-models",
    );
    console.error("hint: check your pi install (pi --list-models) and provider auth");
    process.exit(1);
  }
  padTable(
    ["provider", "model", "thinking", "images"],
    models.map((m) => [
      String(m?.provider ?? "?"),
      String(m?.modelId ?? m?.model ?? "?"),
      isYes(m?.reasoning) ? "yes" : "no",
      isYes(m?.images) ? "yes" : "no",
    ]),
  );
}

/**
 * Non-blocking availability check: WARN (never fails) when the spec is not in
 * pi's model list, with a closest-match hint for same model id / different
 * provider (models may need auth later).
 */
async function warnIfUnavailable(spec, configMod, modelsMod) {
  // listModelsViaCli never throws — it resolves [] on spawn errors,
  // nonzero exit, or timeout.
  const models = await modelsMod.listModelsViaCli("pi", undefined, 15_000);
  if (!Array.isArray(models) || models.length === 0) {
    console.log(
      "WARN  could not list pi models (empty output; is pi installed and authenticated?) — skipping availability check (non-blocking)",
    );
    return;
  }
  let matched = false;
  try {
    matched = modelsMod.matchModel(models, spec) !== null;
  } catch {
    matched = false;
  }
  if (matched) return;

  // Closest hint: same model id under a different provider.
  let modelId = null;
  let thinking;
  let provider;
  try {
    const parts = modelsMod.splitSpec(spec); // { base, thinking? }
    const slash = parts.base.lastIndexOf("/");
    provider = slash > -1 ? parts.base.slice(0, slash) : undefined;
    modelId = slash > -1 ? parts.base.slice(slash + 1) : parts.base;
    thinking = parts.thinking;
  } catch {
    modelId = null;
  }
  if (typeof modelId === "string" && modelId.length > 0) {
    const sibling = models.find((m) => m?.modelId === modelId && m?.provider !== provider);
    if (sibling !== undefined) {
      let canonical = `${sibling.provider}/${sibling.modelId}`;
      try {
        canonical = modelsMod.qualifySpec(sibling, thinking);
      } catch {
        // fall back to the manual provider/modelId string
      }
      console.log(
        `WARN  ${spec} not in available pi models — closest: ${canonical} ` +
          `(same model id '${modelId}', different provider); set anyway (non-blocking)`,
      );
      return;
    }
  }
  console.log(
    `WARN  ${spec} not in available pi models — set anyway (models may require auth later; non-blocking)`,
  );
}

async function printUpdatedRow(repoPath, role, action, configMod, discoveryMod, modelsMod) {
  const { rows } = await resolveAllRoles(repoPath, configMod, discoveryMod, modelsMod);
  const row = rows.find((r) => r.role === role);
  console.log(
    `${action}: ${role} = ${effectiveOrInherit(row?.spec ?? "(unresolved)", configMod)} (source: ${row?.source ?? "?"})`,
  );
}

async function cmdSet(args, repoPath, configMod, discoveryMod, modelsMod) {
  const [roleRaw, spec] = args;
  if (!roleRaw || spec === undefined) {
    console.error("usage: set <role> <spec>");
    process.exit(1);
  }
  const role = roleOrExit(roleRaw, configMod);
  if (!configMod.isValidModelSelection(spec)) {
    console.error(
      `invalid model spec '${spec}' — expected "inherit" or provider/model[:thinking]`,
    );
    process.exit(2);
  }
  assertRepoConfigMutable(repoPath, configMod);
  if (spec !== configMod.INHERIT_MODEL) {
    await warnIfUnavailable(spec, configMod, modelsMod);
  }
  try {
    await configMod.mergeModelSelection(repoPath, role, spec);
  } catch (e) {
    console.error(`cannot write selection: ${errorMessage(e)}`);
    process.exit(1);
  }
  await printUpdatedRow(repoPath, role, "set", configMod, discoveryMod, modelsMod);
}

async function cmdUnset(args, repoPath, configMod, discoveryMod, modelsMod) {
  const [roleRaw] = args;
  if (!roleRaw) {
    console.error("usage: unset <role>");
    process.exit(1);
  }
  const role = roleOrExit(roleRaw, configMod);
  assertRepoConfigMutable(repoPath, configMod);
  try {
    await configMod.unsetModelSelection(repoPath, role);
  } catch (e) {
    console.error(`cannot remove selection: ${errorMessage(e)}`);
    process.exit(1);
  }
  await printUpdatedRow(repoPath, role, "unset", configMod, discoveryMod, modelsMod);
}

async function cmdGet(args, repoPath, configMod, discoveryMod, modelsMod) {
  const [roleRaw] = args;
  if (!roleRaw) {
    console.error("usage: get <role>");
    process.exit(1);
  }
  const role = roleOrExit(roleRaw, configMod);
  const { rows } = await resolveAllRoles(repoPath, configMod, discoveryMod, modelsMod);
  const row = rows.find((r) => r.role === role);
  if (row === undefined) {
    console.error(`no resolution for role '${role}'`);
    process.exit(1);
  }
  console.log(`role ${row.role} (repo: ${repoPath})`);
  console.log("");
  console.log("layers (highest precedence first):");
  const layers = [
    ["explicit-config", row.explicit],
    ["frontmatter", row.pin],
    ["configured-default", row.configuredDefault],
    ["builtin-default", row.builtin],
  ];
  for (const [name, value] of layers) {
    const mark = name === row.source ? "  <- wins" : value !== null ? "  (shadowed)" : "";
    console.log(`  ${name.padEnd(20)}${value ?? "(not set)"}${mark}`);
  }
  console.log("");
  console.log(`final: ${effectiveOrInherit(row.spec, configMod)}  (source: ${row.source})`);
  if (row.spec === configMod.INHERIT_MODEL) {
    console.log("split: n/a (inherit uses the orchestrating session's model)");
    return;
  }
  try {
    // splitSpec gives { base: "provider/model", thinking? }; split the base
    // at the last "/" so model ids containing colons stay intact.
    const parts = modelsMod.splitSpec(row.spec);
    const slash = parts.base.lastIndexOf("/");
    const provider = slash > -1 ? parts.base.slice(0, slash) : "?";
    const modelId = slash > -1 ? parts.base.slice(slash + 1) : parts.base;
    const levels = Array.isArray(modelsMod.THINKING_LEVELS) ? modelsMod.THINKING_LEVELS : [];
    const thinking = parts.thinking;
    const state =
      thinking === undefined
        ? "(none)"
        : levels.includes(thinking)
          ? `(known level; levels: ${levels.join(", ")})`
          : `(custom; known levels: ${levels.join(", ")})`;
    console.log(
      `split: provider=${provider}  model=${modelId}  thinking=${thinking ?? "none"} ${state}`,
    );
  } catch (e) {
    console.log(`split: unavailable (${errorMessage(e)})`);
  }
}

const { repo, positional } = parseArgv(process.argv.slice(2));
const command = positional[0] ?? "show";
const rest = positional.slice(1);

let configMod;
let discoveryMod;
let modelsMod;
try {
  configMod = await importExtension("config.ts");
  discoveryMod = await importExtension("agents/discovery.ts");
} catch (e) {
  console.error(`cannot load gx-dev extension modules: ${errorMessage(e)}`);
  process.exit(1);
}
try {
  modelsMod = await importExtension("agents/models.ts");
} catch (e) {
  console.error(`cannot load extensions/gx-dev/agents/models.ts: ${errorMessage(e)}`);
  console.error("(required sibling module — is the parallel-built agents/models.ts present?)");
  process.exit(1);
}

if (command === "show" && rest.length === 0) {
  await cmdShow(repo, configMod, discoveryMod, modelsMod);
} else if (command === "list") {
  await cmdList(rest[0], modelsMod);
} else if (command === "set") {
  await cmdSet(rest, repo, configMod, discoveryMod, modelsMod);
} else if (command === "unset") {
  await cmdUnset(rest, repo, configMod, discoveryMod, modelsMod);
} else if (command === "get") {
  await cmdGet(rest, repo, configMod, discoveryMod, modelsMod);
} else {
  console.log(USAGE);
  process.exit(command === "help" ? 0 : 1);
}
