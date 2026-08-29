#!/usr/bin/env node
/**
 * gx-dev headless sample workflow (PLAN §17 end-to-end).
 *
 *   node scripts/sample-workflow.mjs [--live] [--keep]
 *
 * Default (fake brains, real plumbing): creates a throwaway git fixture repo,
 * wires the REAL Engine with REAL FsRunStore / FsArtifactStore /
 * JsonlEventStore / GitWorktreeManager and scripted fake agents, then drives
 * the workflow to COMPLETE. Prints the state timeline, evidence file count,
 * commit hash, and worktree cleanup status.
 *
 * --live: swaps the fake agents for PiAgentRunner child pi processes
 * (defaultConfig(): every role on zai/glm-5.3-flash:max), a real
 * FsMemoryStore, and real git — a true end-to-end run against the fixture
 * repo, bounded by a 25-minute overall budget.
 *
 * --keep: retains the run worktrees and the fixture repo for inspection.
 *
 * NOTE: requires Node >= 24 (or >= 22.6 with --experimental-transform-types)
 * for the .ts dynamic imports below.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const extensionsDir = join(repoRoot, "extensions", "gx-dev");
const agentsDir = join(repoRoot, "agents");

const argv = process.argv.slice(2);
const LIVE = argv.includes("--live");
const KEEP = argv.includes("--keep");

const REQUEST =
  "Add an exclaim(name) function that returns the name followed by an exclamation mark, with tests.";

const OVERALL_BUDGET_MS = Number(process.env.GX_BUDGET_MINUTES ?? 25) * 60 * 1000;

async function importTs(relPath) {
  return import(pathToFileURL(join(extensionsDir, relPath)).href);
}

// ---------------------------------------------------------------------------
// Local fixture repo (equivalent of tests/helpers makeFixtureRepo)
// ---------------------------------------------------------------------------

const GIT_ENV = {
  GIT_AUTHOR_NAME: "gx-dev-sample",
  GIT_AUTHOR_EMAIL: "sample@gx-dev.invalid",
  GIT_COMMITTER_NAME: "gx-dev-sample",
  GIT_COMMITTER_EMAIL: "sample@gx-dev.invalid",
};

function gitSync(cwd, args) {
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: "ignore" });
}

function makeFixtureRepo() {
  const repoPath = mkdtempSync(join(tmpdir(), "gx-dev-sample-"));
  gitSync(repoPath, ["init", "-q", "-b", "main"]);
  // gx-dev run state lives inside the repo (.gx-dev/); keep it out of the
  // working tree so the real GitWorktreeManager's dirty-refusal never trips
  // on the engine's own state.json / events.jsonl.
  writeFileSync(join(repoPath, ".gitignore"), ".gx-dev/\n", "utf8");
  writeFileSync(
    join(repoPath, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" }, null, 2)}\n`,
    "utf8",
  );
  mkdirSync(join(repoPath, "src"), { recursive: true });
  mkdirSync(join(repoPath, "test"), { recursive: true });
  writeFileSync(
    join(repoPath, "src", "greet.js"),
    "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n",
    "utf8",
  );
  writeFileSync(
    join(repoPath, "test", "greet.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { greet } from "../src/greet.js";',
      "",
      'test("greet says hello", () => {',
      '  assert.equal(greet("world"), "Hello, world!");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  gitSync(repoPath, ["add", "-A"]);
  gitSync(repoPath, ["commit", "-q", "-m", "initial fixture"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// Inline fakes (duplicated from tests/helpers on purpose: this script runs
// standalone against the extensions tree). The fake agents write the promised
// files into their worktree cwd so the REAL GitWorktreeManager has content to
// checkpoint, integrate, and commit.
// ---------------------------------------------------------------------------

function baseCompletion(summary) {
  return {
    status: "complete",
    summary,
    artifacts: [],
    questions: [],
    assumptions: [],
    risks: [],
  };
}

function fakeCompletion(role) {
  switch (role) {
    case "researcher":
      return {
        ...baseCompletion("Requirement understood from the local fixture."),
        sources: [
          {
            url: "file://fixture/src/greet.js",
            title: "fixture greet module",
            retrievedAt: new Date().toISOString(),
            confidence: "high",
          },
        ],
        findings: ["src/greet.js exports greet(name); the module is plain ESM."],
        requirementAmbiguities: [],
      };
    case "planner":
      return {
        ...baseCompletion("Two-task plan: implement, then cover with tests."),
        tasks: [
          {
            id: "T1",
            assignee: "developer",
            title: "Implement exclaim(name) in src/exclaim.js",
            files: ["src/exclaim.js"],
            dependsOn: [],
          },
          {
            id: "T2",
            assignee: "testWriter",
            title: "Cover exclaim(name) in test/exclaim.test.js",
            files: ["test/exclaim.test.js"],
            dependsOn: ["T1"],
          },
        ],
        verificationContract: ["node --test"],
        rollbackPlan: "git reset --hard <base-commit>",
      };
    case "developer":
      return {
        ...baseCompletion("Implementation written to src/exclaim.js."),
        changedFiles: ["src/exclaim.js"],
        deviations: [],
        knownLimitations: [],
      };
    case "testWriter":
      return {
        ...baseCompletion("Tests written to test/exclaim.test.js."),
        testInventory: [{ path: "test/exclaim.test.js", covers: "exclaim(name) behavior" }],
        coverageGaps: [],
      };
    case "testRunner":
      return {
        ...baseCompletion("Verification commands passed."),
        commands: [{ command: "node --test", exitCode: 0 }],
        ownership: [],
      };
    case "reviewer":
      return {
        ...baseCompletion("No blocking findings."),
        findings: [],
        documentationUpdates: ["README.md"],
      };
    case "committer":
      return {
        ...baseCompletion("Committed with a merge commit."),
        strategy: "merge-commit",
        commitHash: "abc123",
        rollbackCommand: "git reset",
      };
    default:
      throw new Error(`no fake completion for role: ${role}`);
  }
}

class FakeAgentRunner {
  constructor() {
    this.invocations = [];
    this.callsByRole = new Map();
  }

  count(role) {
    return this.callsByRole.get(role) ?? 0;
  }

  async run(role, task, work) {
    const call = this.count(role) + 1;
    this.callsByRole.set(role, call);
    this.invocations.push({ role, task, call });
    const startedAt = Date.now();

    // Write the promised artifacts into the agent's worktree so the real git
    // layer has content to checkpoint/integrate/commit (best effort).
    if (work && typeof work.cwd === "string") {
      try {
        if (role === "developer") {
          writeFileSync(
            join(work.cwd, "src", "exclaim.js"),
            "export function exclaim(name) {\n  return `${name}!`;\n}\n",
            "utf8",
          );
        }
        if (role === "testWriter") {
          writeFileSync(
            join(work.cwd, "test", "exclaim.test.js"),
            [
              'import test from "node:test";',
              'import assert from "node:assert/strict";',
              'import { exclaim } from "../src/exclaim.js";',
              "",
              'test("exclaim appends !", () => {',
              '  assert.equal(exclaim("hi"), "hi!");',
              "});",
              "",
            ].join("\n"),
            "utf8",
          );
        }
      } catch {
        // worktree writes are best-effort in the demo
      }
    }

    const completion = fakeCompletion(role);
    const rawText = [
      `# ${role} report`,
      "",
      `The ${role} step completed deterministically in the sample harness.`,
      "",
      "```json",
      JSON.stringify(completion, null, 2),
      "```",
      "",
    ].join("\n");
    const { extractJson, validateCompletion } = await importTs("domain/schemas.ts");
    const validation = validateCompletion(role, extractJson(rawText));
    return {
      role,
      completion: validation.completion,
      rawText,
      ok: validation.ok,
      error: validation.ok ? undefined : validation.errors.join("; "),
      durationMs: Math.max(1, Date.now() - startedAt),
      exitCode: 0,
      infrastructure: false,
    };
  }
}

class FakeMemoryCoordinator {
  constructor() {
    this.reserved = [];
    this.promoted = [];
  }

  async reserve(proposals) {
    this.reserved.push(proposals);
    return proposals;
  }

  async promote(proposals) {
    this.promoted.push(proposals);
    return { applied: proposals.map((p) => p.page), conflicts: [] };
  }

  async search() {
    return [];
  }

  async lint() {
    return { ok: true, issues: [] };
  }
}

// ---------------------------------------------------------------------------
// Self-binding persistence: the engine generates the runId inside start(),
// so artifacts/events attach to .gx-dev/runs/<runId>/ on the first save.
// ---------------------------------------------------------------------------

async function makeBindingStores(repoPath) {
  const { FsRunStore } = await importTs("domain/persist.ts");
  const { FsArtifactStore } = await importTs("domain/artifacts.ts");
  const { JsonlEventStore } = await importTs("domain/events.ts");

  const fs = new FsRunStore(repoPath);
  const placeholder = mkdtempSync(join(tmpdir(), "gx-dev-stores-"));
  let artifactsDelegate = new FsArtifactStore(placeholder);
  let eventsDelegate = new JsonlEventStore(placeholder);
  let boundRunId = null;

  const stores = {
    runStore: {
      save: async (state) => {
        if (boundRunId === null) {
          boundRunId = state.runId;
          const dir = join(repoPath, ".gx-dev", "runs", state.runId);
          artifactsDelegate = new FsArtifactStore(dir);
          eventsDelegate = new JsonlEventStore(dir);
        }
        await fs.save(state);
      },
      load: (runId) => fs.load(runId),
      list: () => fs.list(),
    },
    get artifacts() {
      return artifactsDelegate;
    },
    get events() {
      return eventsDelegate;
    },
    get runDir() {
      if (boundRunId === null) throw new Error("stores not bound yet (no run started)");
      return join(repoPath, ".gx-dev", "runs", boundRunId);
    },
  };
  return stores;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Real GitWorktreeManager; --keep skips cleanup so worktrees survive. */
async function makeGit(repoPath) {
  const { GitWorktreeManager } = await importTs("git/worktrees.ts");
  const real = new GitWorktreeManager();
  const status = { cleanupDone: false, cleanupSkipped: false };
  return {
    git: {
      recordBase: (p) => real.recordBase(p),
      prepareWorktrees: (p, runId) => real.prepareWorktrees(p, runId),
      integrate: (handles) => real.integrate(handles),
      checkpointStaging: (handles, message) => real.checkpointStaging(handles, message),
      commitStaged: (handles, message, baseBranch) => real.commitStaged(handles, message, baseBranch),
      cleanup: async (handles, opts) => {
        if (KEEP) {
          status.cleanupSkipped = true;
          return;
        }
        await real.cleanup(handles, opts);
        status.cleanupDone = true;
      },
    },
    gitStatus: status,
    /** Best-effort post-run cleanup: the engine retains successful-run
     * worktrees; the headless driver releases them (unless --keep). */
    cleanupAfterRun: async (runId, branches) => {
      if (KEEP) {
        status.cleanupSkipped = true;
        return;
      }
      const root = join(dirname(repoPath), ".gx-dev-worktrees", runId);
      const handles = {
        runId,
        developer: join(root, "developer"),
        tests: join(root, "tests"),
        staging: join(root, "staging"),
        branches,
      };
      await real.cleanup(handles, { force: true });
      status.cleanupDone = true;
    },
  };
}

async function buildFakeDeps(repoPath) {
  const { defaultConfig } = await importTs("config.ts");
  const stores = await makeBindingStores(repoPath);
  const wired = await makeGit(repoPath);

  const deps = {
    runner: new FakeAgentRunner(),
    git: wired.git,
    memory: new FakeMemoryCoordinator(),
    runStore: stores.runStore,
    // Delegating wrappers: the delegates re-point to .gx-dev/runs/<runId>/
    // on the first runStore.save(), after the engine has minted the run id.
    artifacts: {
      recordEvidence: (kind, content, source, name) =>
        stores.artifacts.recordEvidence(kind, content, source, name),
      readArtifact: (name) => stores.artifacts.readArtifact(name),
      writeArtifact: (name, content) => stores.artifacts.writeArtifact(name, content),
      evidence: () => stores.artifacts.evidence(),
      get runDir() {
        return stores.artifacts.runDir;
      },
    },
    events: {
      append: (type, message, data) => stores.events.append(type, message, data),
      events: () => stores.events.events(),
    },
    config: defaultConfig(),
    ui: {
      askUser: async () => "approved",
      notify: (message, data) => console.log("[gx]", message, data ?? ""),
    },
  };
  return { deps, stores, gitStatus: wired.gitStatus, cleanupAfterRun: wired.cleanupAfterRun };
}

async function buildLiveDeps(repoPath) {
  const { defaultConfig } = await importTs("config.ts");
  const { PiAgentRunner } = await importTs("agents/runner.ts");
  const { FsMemoryStore } = await importTs("memory/store.ts");
  const stores = await makeBindingStores(repoPath);
  const wired = await makeGit(repoPath);

  const inner = new PiAgentRunner({ config: defaultConfig(), agentsDir });
  const roleDurations = new Map(); // role -> { calls, ms }
  const runner = {
    run: async (role, task, work, options) => {
      const startedAt = Date.now();
      try {
        return await inner.run(role, task, work, options);
      } finally {
        const rec = roleDurations.get(role) ?? { calls: 0, ms: 0 };
        rec.calls += 1;
        rec.ms += Date.now() - startedAt;
        roleDurations.set(role, rec);
      }
    },
  };

  const deps = {
    runner,
    git: wired.git,
    memory: new FsMemoryStore(join(repoPath, ".gx-dev", "memory")),
    runStore: stores.runStore,
    artifacts: {
      recordEvidence: (kind, content, source, name) =>
        stores.artifacts.recordEvidence(kind, content, source, name),
      readArtifact: (name) => stores.artifacts.readArtifact(name),
      writeArtifact: (name, content) => stores.artifacts.writeArtifact(name, content),
      evidence: () => stores.artifacts.evidence(),
      get runDir() {
        return stores.artifacts.runDir;
      },
    },
    events: {
      append: (type, message, data) => stores.events.append(type, message, data),
      events: () => stores.events.events(),
    },
    config: defaultConfig(),
    ui: {
      askUser: async (question) => {
        console.log(`[gx] auto-approving question: ${question.question}`);
        return "approved";
      },
      notify: (message, data) => console.log("[gx]", message, data ?? ""),
    },
  };
  return {
    deps,
    stores,
    gitStatus: wired.gitStatus,
    cleanupAfterRun: wired.cleanupAfterRun,
    roleDurations,
  };
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function extractRunState(res) {
  if (res && typeof res === "object") {
    if (res.state && typeof res.state === "object" && typeof res.state.runId === "string") {
      return res.state;
    }
    if (typeof res.runId === "string") return res;
  }
  throw new Error(`engine returned something we cannot read a RunState from: ${String(res)}`);
}

function commitHashFromEvents(runDir) {
  try {
    const eventsFile = join(runDir, "events.jsonl");
    if (!existsSync(eventsFile)) return null;
    const lines = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const event = JSON.parse(lines[i]);
      if (event.type === "commit_created") {
        const hash = event.data?.commitHash ?? event.data?.hash;
        if (typeof hash === "string") return hash;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function evidenceFileCount(runDir) {
  try {
    return readdirSync(join(runDir, "evidence", "agent-output")).filter((f) => !f.startsWith(".")).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`gx-dev sample workflow — mode: ${LIVE ? "LIVE (pi children)" : "fake agents"}`);
  const repoPath = makeFixtureRepo();
  console.log(`fixture repo: ${repoPath}${KEEP ? " (kept)" : ""}`);

  const wired = LIVE ? await buildLiveDeps(repoPath) : await buildFakeDeps(repoPath);
  const { Engine } = await importTs("orchestration/engine.ts");
  const engine = new Engine(repoPath, wired.deps);

  let timedOut = false;
  const budget = setTimeout(() => {
    timedOut = true;
    console.error("[gx] overall budget exceeded; cancelling run");
    engine.cancel().catch(() => {});
  }, OVERALL_BUDGET_MS);

  let exitCode = 0;
  try {
    const res = await engine.start(REQUEST);
    const state = extractRunState(res);
    const runDir = wired.stores.runDir;

    // The engine retains successful-run worktrees; the headless driver
    // releases them through the real manager (unless --keep).
    try {
      await wired.cleanupAfterRun(state.runId, {
        developer: `gx-dev/${state.runId}/developer`,
        tests: `gx-dev/${state.runId}/tests`,
        staging: `gx-dev/${state.runId}/staging`,
      });
    } catch (e) {
      console.error(`[gx] worktree cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    console.log("\n=== state timeline ===");
    for (const entry of state.history) {
      console.log(`  ${entry.at}  ${entry.state}`);
    }

    const commitHash = commitHashFromEvents(runDir);
    const evidence = evidenceFileCount(runDir);
    const worktreeRoot = join(dirname(repoPath), ".gx-dev-worktrees", state.runId);
    const worktreeRoles = ["developer", "tests", "staging"];
    const worktreesGone =
      !existsSync(worktreeRoot) ||
      readdirSync(worktreeRoot).filter((d) => worktreeRoles.includes(d)).length === 0;
    const cleanup = wired.gitStatus.cleanupSkipped
      ? "retained (--keep)"
      : wired.gitStatus.cleanupDone && worktreesGone
        ? "done"
        : "not confirmed";

    console.log("\n=== summary ===");
    console.log(`  final state:      ${state.state}`);
    console.log(`  evidence files:   ${evidence} (agent-output)`);
    console.log(`  commit hash:      ${commitHash ?? "<none>"}`);
    console.log(`  worktree cleanup: ${cleanup}`);
    if (LIVE && wired.roleDurations.size > 0) {
      console.log("  per-role durations:");
      for (const [role, rec] of wired.roleDurations) {
        console.log(`    ${role.padEnd(11)} ${rec.calls} call(s), ${(rec.ms / 1000).toFixed(1)}s`);
      }
    }

    if (timedOut) throw new Error("overall budget (25 min) exceeded");
    if (state.state !== "COMPLETE") {
      throw new Error(`workflow ended in ${state.state} instead of COMPLETE`);
    }
    console.log("\nPASS: workflow reached COMPLETE");
  } catch (e) {
    exitCode = 1;
    console.error(`\nFAIL: ${e instanceof Error ? e.message : String(e)}`);
    try {
      const s = engine.status();
      if (s) console.error(`  (engine status at failure: ${s.state})`);
    } catch {
      // ignore
    }
  } finally {
    clearTimeout(budget);
  }

  if (!KEEP) {
    rmSync(repoPath, { recursive: true, force: true });
  } else {
    console.log(`fixture repo kept at: ${repoPath}`);
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(`FAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
