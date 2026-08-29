#!/usr/bin/env node
/**
 * gx-dev environment doctor.
 *
 *   node scripts/doctor.mjs
 *
 * Checks: node >= 22, git available, pi available (warn only — required for
 * --live runs), the seven role prompt files under agents/, that
 * defaultConfig() passes validateConfig(), and (MODEL section, warn-only)
 * that every role's effective model selection resolves and — when not
 * "inherit" — matches a model pi actually offers. Exit code is non-zero on
 * any FAIL; model availability warnings never fail the check.
 */

import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const agentsDir = join(repoRoot, "agents");

const ROLE_FILES = [
  "researcher.md",
  "planner.md",
  "developer.md",
  "test-writer.md",
  "test-runner.md",
  "reviewer.md",
  "committer.md",
];

let failed = false;

function pass(msg) {
  console.log(`PASS  ${msg}`);
}

function warn(msg) {
  console.log(`WARN  ${msg}`);
}

function fail(msg) {
  failed = true;
  console.log(`FAIL  ${msg}`);
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major >= 22) {
    pass(`node >= 22 (v${process.versions.node})`);
  } else {
    fail(`node >= 22 required, found v${process.versions.node}`);
  }
}

function checkBinary(binary, args, { required }) {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 10_000 }, (err, stdout) => {
      if (!err) {
        const version = String(stdout).trim().split("\n")[0] || "ok";
        pass(`${binary} available (${version})`);
      } else if (err.code === "ENOENT" && !required) {
        warn(`${binary} not found on PATH — needed only for live mode (sample-workflow.mjs --live)`);
      } else {
        fail(`${binary} ${args.join(" ")} failed: ${err.message.split("\n")[0]}`);
      }
      resolve();
    });
  });
}

function checkAgentPrompts() {
  if (!existsSync(agentsDir)) {
    fail(`agents directory missing: ${agentsDir}`);
    return;
  }
  const present = new Set(readdirSync(agentsDir));
  const missing = ROLE_FILES.filter((f) => !present.has(f));
  if (missing.length === 0) {
    pass(`agents dir has all ${ROLE_FILES.length} role prompts (${agentsDir})`);
  } else {
    fail(`agents dir missing ${missing.length} role prompt(s): ${missing.join(", ")}`);
  }
}

async function checkConfig() {
  try {
    const configUrl = pathToFileURL(join(repoRoot, "extensions", "gx-dev", "config.ts")).href;
    const { defaultConfig, validateConfig } = await import(configUrl);
    const result = validateConfig(defaultConfig());
    if (result.ok) {
      pass("defaultConfig() passes validateConfig()");
    } else {
      fail(`defaultConfig() rejected by validateConfig(): ${result.errors.join("; ")}`);
    }
  } catch (e) {
    fail(`cannot load extensions/gx-dev/config.ts: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * MODEL section (warn-only): resolves each role's effective model spec with
 * the same wiring as `node scripts/models.mjs show` — frontmatter pin from
 * the package agents dir, explicit user selection from
 * <repo>/.gx-dev/config.json (--repo flag, default cwd), configured default,
 * builtin zai/glm-5.3-flash:max. Non-inherit specs are matched once against
 * a cached `pi --list-models` listing; unmatched models are availability
 * warnings (auth may be missing), never failures.
 */
async function checkModels() {
  try {
    const configUrl = pathToFileURL(join(repoRoot, "extensions", "gx-dev", "config.ts")).href;
    const discoveryUrl = pathToFileURL(join(repoRoot, "extensions", "gx-dev", "agents", "discovery.ts")).href;
    const modelsUrl = pathToFileURL(join(repoRoot, "extensions", "gx-dev", "agents", "models.ts")).href;
    const { MODEL_ROLE_KEYS, INHERIT_MODEL, GLM_53_FLASH_MAX, loadConfigWithSources } = await import(configUrl);
    const { loadRolePrompt } = await import(discoveryUrl);
    const modelsMod = await import(modelsUrl);

    // --repo <path> | --repo=<path>, default cwd (same flag as models.mjs).
    let repoPath = process.cwd();
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--repo") {
        repoPath = resolve(String(argv[i + 1] ?? process.cwd()));
        break;
      }
      if (typeof arg === "string" && arg.startsWith("--repo=")) {
        repoPath = resolve(arg.slice("--repo=".length));
        break;
      }
    }

    const loaded = await loadConfigWithSources(repoPath);
    console.log(`\nmodel selection (repo: ${repoPath}):`);

    // Cache the pi model list; fetch it at most once, lazily.
    let cached = null;
    let listError = null;
    const modelsList = async () => {
      if (cached === null && listError === null) {
        try {
          cached = await modelsMod.listModelsViaCli("pi", undefined, 15_000);
        } catch (e) {
          listError = e instanceof Error ? e.message : String(e);
        }
      }
      return { list: cached, error: listError };
    };

    for (const role of MODEL_ROLE_KEYS) {
      const pin = loadRolePrompt(agentsDir, role)?.model;
      const resolved = modelsMod.resolveModelSpec({
        frontmatterModel: pin,
        explicitConfigModel: loaded.explicitModels[role],
        configuredDefault: loaded.config.agents.models[role],
        builtinDefault: GLM_53_FLASH_MAX,
      });
      const spec = resolved.inherits ? INHERIT_MODEL : (resolved.spec ?? "(unresolved)");
      if (spec === INHERIT_MODEL) {
        pass(`${role} (inherit)`);
        continue;
      }
      const { list, error } = await modelsList();
      if (error !== null) {
        warn(`${role} model ${spec} availability unknown: cannot list pi models (${error})`);
        continue;
      }
      let matched = false;
      try {
        matched = Boolean(modelsMod.matchModel(list ?? [], spec));
      } catch {
        matched = false;
      }
      if (matched) {
        pass(`${role} ${spec}`);
      } else {
        warn(`${role} model ${spec} not in available pi models`);
      }
    }
  } catch (e) {
    // Module or config load problems are warn-only here; the config check
    // above already FAILs on a broken config. Never fail on MODEL checks.
    warn(`model selection checks skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

checkNodeVersion();
await checkBinary("git", ["--version"], { required: true });
await checkBinary("pi", ["--version"], { required: false });
checkAgentPrompts();
await checkConfig();
await checkModels();

console.log(failed ? "\ndoctor: FAIL" : "\ndoctor: OK (warnings do not fail the check)");
process.exit(failed ? 1 : 0);
