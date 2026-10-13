/**
 * Command-safety tests for the /gx-dev command table (REVIEW P0 "Project
 * configuration bypasses pi trust" + command UX fixes).
 *
 * All handlers are exercised through mocks: a minimal
 * ExtensionCommandContext stub (cwd, isProjectTrusted, ui.notify) and a
 * minimal Engine stub (status/start/resume recorders). Filesystem effects are
 * asserted against real temp repos, so the tests prove the actual contract:
 *
 *  - trust guard: doctor never executes a project-configured executable from
 *    an untrusted repo; models never honors untrusted project config;
 *  - active-run precheck: a model change with a run active is rejected
 *    BEFORE persisting (the engine reset hook stays a backstop, not a guard);
 *  - story starts a run from a readable file's text and fails closed when
 *    the file is unreadable;
 *  - retry resumes via engine.resume, never answers pending checkpoints,
 *    and reports terminal runs truthfully instead of silently no-oping;
 *  - evidence display reads only the append-only manifest;
 *  - cleanup requires an explicit run id, never touches an active run,
 *    only targets finished runs, and goes through GitWorktreeManager
 *    (real git fixture) without force flags;
 *  - memory lint/search display only for trusted projects and never
 *    scaffold project state as a side effect.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  findGxCommand,
  GX_COMMANDS,
  setEngineResetHook,
} from "../../extensions/gx-dev/commands.ts";
import type { Engine } from "../../extensions/gx-dev/orchestration/engine.ts";
import { initialCounters } from "../../extensions/gx-dev/domain/state.ts";
import type { RunState } from "../../extensions/gx-dev/domain/state.ts";
import { git } from "../../extensions/gx-dev/git/repository.ts";
import { WORKTREE_DIRNAME } from "../../extensions/gx-dev/git/worktrees.ts";

// ---------------------------------------------------------------------------
// hermetic git (mirrors tests/unit/git-worktrees.test.ts)
// ---------------------------------------------------------------------------

const cfgDir = mkdtempSync(join(tmpdir(), "gx-dev-cmdcfg-"));
const globalCfg = join(cfgDir, "gitconfig");
writeFileSync(globalCfg, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = globalCfg;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "gx-dev-test",
  GIT_AUTHOR_EMAIL: "test@gx-dev.invalid",
  GIT_COMMITTER_NAME: "gx-dev-test",
  GIT_COMMITTER_EMAIL: "test@gx-dev.invalid",
};

// ---------------------------------------------------------------------------
// temp dirs
// ---------------------------------------------------------------------------

const cleanupDirs: string[] = [];

function tempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/**
 * Sandbox for git-fixture tests: the repo is nested under a disposable
 * parent so the conventional worktree root (<repo-parent>/.gx-dev-worktrees)
 * stays inside the sandbox instead of colliding in the shared tmpdir.
 */
function tempSandbox(prefix: string): { parent: string; repo: string } {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(parent);
  const repo = join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  return { parent, repo };
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  setEngineResetHook(() => {});
});

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

interface Notification {
  text: string;
  level: string;
}

function makeCtx(repo: string, trusted: boolean): {
  ctx: ExtensionCommandContext;
  notifications: Notification[];
} {
  const notifications: Notification[] = [];
  const ctx = {
    cwd: repo,
    isProjectTrusted: () => trusted,
    ui: {
      notify: (text: string, level?: string) => {
        notifications.push({ text, level: level ?? "info" });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

function runState(over: Partial<RunState> & { runId: string }): RunState {
  const now = "2025-06-01T00:00:00.000Z";
  return {
    request: "test request",
    repoPath: "/nowhere",
    state: "PAUSED",
    previousState: "DEVELOP",
    resumeState: "DEVELOP",
    base: null,
    counters: initialCounters(),
    approvals: {},
    dependencies: {},
    history: [{ state: "INTAKE", at: now }],
    pendingQuestion: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

interface EngineRecorder {
  starts: { request: string; storyPath: string | undefined }[];
  resumes: (string | undefined)[];
  answers: string[];
}

/**
 * Minimal Engine stand-in: status() returns `state` (mutable via setState),
 * start/resume/answer record calls. Only the surface the tested commands use.
 */
function makeEngine(state: RunState | null = null): {
  engine: Engine;
  calls: EngineRecorder;
  setState: (next: RunState | null) => void;
} {
  const calls: EngineRecorder = { starts: [], resumes: [], answers: [] };
  let current: RunState | null = state;
  const engine = {
    status: () => current,
    start: async (request: string, storyPath?: string) => {
      calls.starts.push({ request, storyPath });
      current = runState({ runId: `run-new-${calls.starts.length}`, request, state: "INTAKE" });
      return current;
    },
    resume: async (runId?: string) => {
      calls.resumes.push(runId);
      current = current ?? runState({ runId: runId ?? "run-latest", state: "RECOVERING" });
      return current;
    },
    answer: async (text: string) => {
      calls.answers.push(text);
      return current ?? runState({ runId: "run-x" });
    },
    pause: async () => current ?? runState({ runId: "run-x" }),
    cancel: async () => current ?? runState({ runId: "run-x" }),
  } as unknown as Engine;
  return { engine, calls, setState: (next) => (current = next) };
}

/** Persists a run record where FsRunStore.list()/load() will find it. */
function writeRun(repo: string, state: RunState): void {
  const dir = join(repo, ".gx-dev", "runs", state.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

function readRun(repo: string, runId: string): RunState {
  return JSON.parse(
    readFileSync(join(repo, ".gx-dev", "runs", runId, "state.json"), "utf8"),
  ) as RunState;
}

/** Writes an executable shell script; returns its path. */
function writeExecutable(repo: string, name: string, body: string): string {
  const file = join(repo, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

function writeRepoConfig(repo: string, config: Record<string, unknown>): void {
  mkdirSync(join(repo, ".gx-dev"), { recursive: true });
  writeFileSync(join(repo, ".gx-dev", "config.json"), JSON.stringify(config, null, 2), "utf8");
}

async function initRepo(repo: string): Promise<void> {
  const init = await git(repo, ["init", "-b", "main"]);
  assert.equal(init.code, 0, init.stderr);
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
  const add = await git(repo, ["add", "-A"]);
  assert.equal(add.code, 0, add.stderr);
  const commit = await git(repo, ["commit", "-m", "initial"], { env: GIT_ENV });
  assert.equal(commit.code, 0, commit.stderr);
}

async function addWorktree(
  parent: string,
  repo: string,
  runId: string,
  role: "developer" | "tests" | "staging",
): Promise<string> {
  const path = join(parent, WORKTREE_DIRNAME, runId, role);
  mkdirSync(join(path, ".."), { recursive: true });
  const res = await git(repo, ["worktree", "add", path, "-b", `gx-dev/${runId}/${role}`], {
    env: GIT_ENV,
  });
  assert.equal(res.code, 0, res.stderr);
  return path;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("command registration", () => {
  it("registers the new commands alongside the existing table", () => {
    const names = GX_COMMANDS.map((c) => c.name);
    for (const name of ["evidence", "story", "retry", "memory", "cleanup"]) {
      assert.ok(names.includes(name), `missing command: ${name}`);
    }
    assert.equal(names.length, new Set(names).size, "duplicate command names");
    for (const name of ["evidence", "story", "retry", "memory", "cleanup"]) {
      assert.ok(findGxCommand(name)?.handler, `${name} must have a handler`);
    }
  });
});

describe("doctor trust guard", () => {
  it("never executes a project-configured executable from an untrusted repo", async () => {
    const repo = tempRepo("gx-cmd-doctor-untrusted-");
    const marker = join(repo, "marker");
    const fakeBinary = writeExecutable(repo, "fake-pi.sh", `touch "${marker}"\necho fake-pi 1.0`);
    writeRepoConfig(repo, { version: 1, agents: { piBinary: fakeBinary } });
    const { ctx, notifications } = makeCtx(repo, false);

    const doctor = findGxCommand("doctor");
    assert.ok(doctor);
    await doctor.handler(ctx, makeEngine().engine, "");

    assert.ok(!existsSync(marker), "the untrusted repo's configured binary must never run");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /PROBLEMS FOUND/);
    assert.match(text, /trust: .*NOT trusted/);
    assert.match(text, /config: .*not read \(untrusted project\)/);
  });

  it("honors the project binary for trusted repos and reports the trust check", async () => {
    const repo = tempRepo("gx-cmd-doctor-trusted-");
    const marker = join(repo, "marker");
    const fakeBinary = writeExecutable(repo, "fake-pi.sh", `touch "${marker}"\necho fake-pi 1.0`);
    writeRepoConfig(repo, { version: 1, agents: { piBinary: fakeBinary } });
    const { ctx, notifications } = makeCtx(repo, true);

    const doctor = findGxCommand("doctor");
    assert.ok(doctor);
    await doctor.handler(ctx, makeEngine().engine, "");

    assert.ok(existsSync(marker), "a trusted project's configured binary is the doctor's probe target");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /all checks passed/);
    assert.match(text, /trust: .*is trusted/);
  });
});

describe("models command safety", () => {
  it("does not honor project config for `models show` in an untrusted repo", async () => {
    const repo = tempRepo("gx-cmd-models-show-");
    writeRepoConfig(repo, {
      version: 1,
      agents: { models: { researcher: "fake/untrusted-model:max" } },
    });
    const { ctx, notifications } = makeCtx(repo, false);

    const models = findGxCommand("models");
    assert.ok(models);
    await models.handler(ctx, makeEngine().engine, "show");

    const text = notifications.map((n) => n.text).join("\n");
    assert.ok(!text.includes("fake/untrusted-model"), "untrusted config selections must not be shown as effective");
    assert.match(text, /not trusted/);
  });

  it("refuses the model picker for an untrusted repo (it probes the configured binary)", async () => {
    const repo = tempRepo("gx-cmd-models-picker-");
    const marker = join(repo, "marker");
    const fakeBinary = writeExecutable(repo, "fake-pi.sh", `touch "${marker}"\necho fake-pi 1.0`);
    writeRepoConfig(repo, { version: 1, agents: { piBinary: fakeBinary } });
    const { ctx, notifications } = makeCtx(repo, false);

    const models = findGxCommand("models");
    assert.ok(models);
    await models.handler(ctx, makeEngine().engine, "");

    assert.ok(!existsSync(marker), "the picker must not run for untrusted repos");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /models refused/);
    assert.match(text, /not trusted/);
  });

  it("refuses `models set` for an untrusted repo without writing config", async () => {
    const repo = tempRepo("gx-cmd-models-set-untrusted-");
    const configFile = join(repo, ".gx-dev", "config.json");
    writeRepoConfig(repo, { version: 1 });
    const before = readFileSync(configFile, "utf8");
    const { ctx, notifications } = makeCtx(repo, false);

    const models = findGxCommand("models");
    assert.ok(models);
    await models.handler(ctx, makeEngine().engine, "set researcher zai/fake:max");

    assert.equal(readFileSync(configFile, "utf8"), before, "untrusted `set` must not write config");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /models set refused/);
    assert.match(text, /not trusted/);
  });

  it("rejects a model change BEFORE persisting while a run is active", async () => {
    const repo = tempRepo("gx-cmd-models-active-");
    const marker = join(repo, "marker");
    const fakeBinary = writeExecutable(repo, "fake-pi.sh", `touch "${marker}"\necho fake-pi 1.0`);
    writeRepoConfig(repo, { version: 1, agents: { piBinary: fakeBinary } });
    const configFile = join(repo, ".gx-dev", "config.json");
    const before = readFileSync(configFile, "utf8");
    const { ctx, notifications } = makeCtx(repo, true);
    const activeEngine = makeEngine(runState({ runId: "run-active", state: "DEVELOP" }));

    let resets = 0;
    setEngineResetHook(() => {
      resets += 1;
    });

    const models = findGxCommand("models");
    assert.ok(models);
    await models.handler(ctx, activeEngine.engine, "set researcher zai/fake:max");

    assert.equal(readFileSync(configFile, "utf8"), before, "nothing may be persisted while a run is active");
    assert.ok(!existsSync(marker), "even the availability probe must not run after the active-run rejection");
    assert.equal(resets, 0, "the engine reset hook must not fire");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /a run is active/);
    assert.match(text, /nothing was saved/);
  });

  it("rejects the picker path BEFORE persisting while a run is active", async () => {
    const repo = tempRepo("gx-cmd-models-active-picker-");
    writeRepoConfig(repo, { version: 1 });
    const configFile = join(repo, ".gx-dev", "config.json");
    const before = readFileSync(configFile, "utf8");
    const { ctx, notifications } = makeCtx(repo, true);
    const activeEngine = makeEngine(runState({ runId: "run-active", state: "DEVELOP" }));

    const models = findGxCommand("models");
    assert.ok(models);
    await models.handler(ctx, activeEngine.engine, "");

    assert.equal(readFileSync(configFile, "utf8"), before);
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /a run is active/);
  });

  it("persists and resets the engine for a trusted idle session", async () => {
    const repo = tempRepo("gx-cmd-models-set-ok-");
    const marker = join(repo, "marker");
    const fakeBinary = writeExecutable(repo, "fake-pi.sh", `touch "${marker}"\necho fake-pi 1.0`);
    writeRepoConfig(repo, { version: 1, agents: { piBinary: fakeBinary } });
    const { ctx, notifications } = makeCtx(repo, true);

    let resets = 0;
    setEngineResetHook(() => {
      resets += 1;
    });

    const models = findGxCommand("models");
    assert.ok(models);
    await models.handler(ctx, makeEngine().engine, "set developer zai/fake-model:max");

    const saved = JSON.parse(readFileSync(join(repo, ".gx-dev", "config.json"), "utf8")) as {
      agents?: { models?: Record<string, string> };
    };
    assert.equal(saved.agents?.models?.developer, "zai/fake-model:max");
    assert.equal(resets, 1, "a successful save must invalidate the shared engine");
    assert.ok(existsSync(marker), "a trusted project's configured binary backs the availability probe");
    assert.ok(notifications.some((n) => n.text.includes("developer")));
  });
});

describe("story command", () => {
  it("starts a run from a readable story file's verbatim text", async () => {
    const repo = tempRepo("gx-cmd-story-");
    const story = join(repo, "story.md");
    writeFileSync(story, "Add a zoom toggle\n\n- must persist per user\n", "utf8");
    const { ctx, notifications } = makeCtx(repo, true);
    const { engine, calls } = makeEngine();

    const storyCmd = findGxCommand("story");
    assert.ok(storyCmd);
    await storyCmd.handler(ctx, engine, "story.md");

    assert.equal(calls.starts.length, 1);
    assert.equal(calls.starts[0]?.request, "Add a zoom toggle\n\n- must persist per user\n");
    assert.equal(calls.starts[0]?.storyPath, story);
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /run started from story/);
  });

  it("fails closed on an unreadable story file without starting a run", async () => {
    const repo = tempRepo("gx-cmd-story-missing-");
    const { ctx, notifications } = makeCtx(repo, true);
    const { engine, calls } = makeEngine();

    const storyCmd = findGxCommand("story");
    assert.ok(storyCmd);
    await storyCmd.handler(ctx, engine, "does-not-exist.md");

    assert.equal(calls.starts.length, 0);
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /cannot read story file/);
  });

  it("refuses untrusted projects and active runs without starting", async () => {
    const repo = tempRepo("gx-cmd-story-guard-");
    const story = join(repo, "story.md");
    writeFileSync(story, "content", "utf8");

    const untrusted = makeCtx(repo, false);
    const storyCmd = findGxCommand("story");
    assert.ok(storyCmd);
    const a = makeEngine();
    await storyCmd.handler(untrusted.ctx, a.engine, "story.md");
    assert.equal(a.calls.starts.length, 0);
    assert.match(untrusted.notifications.map((n) => n.text).join("\n"), /not trusted/);

    const trusted = makeCtx(repo, true);
    const b = makeEngine(runState({ runId: "run-live", state: "DEVELOP" }));
    await storyCmd.handler(trusted.ctx, b.engine, "story.md");
    assert.equal(b.calls.starts.length, 0);
    assert.match(trusted.notifications.map((n) => n.text).join("\n"), /a run is active/);
  });
});

describe("retry command", () => {
  it("resumes an explicitly selected interrupted run via engine.resume", async () => {
    const repo = tempRepo("gx-cmd-retry-");
    writeRun(repo, runState({ runId: "run-paused-1", state: "PAUSED", resumeState: "DEVELOP" }));
    const { ctx, notifications } = makeCtx(repo, true);
    const { engine, calls } = makeEngine(null);

    const retry = findGxCommand("retry");
    assert.ok(retry);
    await retry.handler(ctx, engine, "run-paused-1");

    assert.deepEqual(calls.resumes, ["run-paused-1"]);
    assert.match(notifications.map((n) => n.text).join("\n"), /retried run run-paused-1/);
  });

  it("never claims to answer a pending checkpoint and leaves the run untouched", async () => {
    const repo = tempRepo("gx-cmd-retry-waiting-");
    const waiting = runState({
      runId: "run-waiting",
      state: "WAITING_FOR_USER",
      resumeState: "REQUIREMENTS_APPROVAL",
      pendingQuestion: {
        reason: "material question",
        question: "Should auth use OAuth?",
        context: [],
        answers: [],
        severity: "material",
      },
    });
    writeRun(repo, waiting);
    const { ctx, notifications } = makeCtx(repo, true);
    const { engine, calls } = makeEngine(null);

    const retry = findGxCommand("retry");
    assert.ok(retry);
    await retry.handler(ctx, engine, "run-waiting");

    assert.equal(calls.resumes.length, 0, "retry must not drive a run past an unanswered checkpoint");
    assert.equal(calls.answers.length, 0);
    const after = readRun(repo, "run-waiting");
    assert.equal(after.pendingQuestion?.answers.length, 0, "no answer may be fabricated");
    assert.equal(after.state, "WAITING_FOR_USER");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /waiting at an unanswered checkpoint/);
    assert.match(text, /does not answer pending checkpoints/);
    assert.match(text, /\/gx-dev answer/);
  });

  it("resumes normally when the checkpoint question was already answered", async () => {
    const repo = tempRepo("gx-cmd-retry-answered-");
    writeRun(repo,
      runState({
        runId: "run-answered",
        state: "WAITING_FOR_USER",
        resumeState: "REQUIREMENTS_APPROVAL",
        pendingQuestion: {
          reason: "material question",
          question: "Should auth use OAuth?",
          context: [],
          answers: [{ answer: "yes, OAuth", at: "2025-06-01T01:00:00.000Z" }],
          severity: "material",
        },
      }),
    );
    const { ctx, notifications } = makeCtx(repo, true);
    const { engine, calls } = makeEngine(null);

    const retry = findGxCommand("retry");
    assert.ok(retry);
    await retry.handler(ctx, engine, "run-answered");

    assert.deepEqual(calls.resumes, ["run-answered"], "an answered checkpoint is resumable");
    assert.match(notifications.map((n) => n.text).join("\n"), /retried run run-answered/);
  });

  it("reports terminal runs truthfully instead of silently no-oping", async () => {
    const repo = tempRepo("gx-cmd-retry-terminal-");
    writeRun(repo, runState({ runId: "run-failed", state: "FAILED" }));
    const { ctx, notifications } = makeCtx(repo, true);
    const { engine, calls } = makeEngine(null);

    const retry = findGxCommand("retry");
    assert.ok(retry);
    await retry.handler(ctx, engine, "run-failed");

    assert.equal(calls.resumes.length, 0);
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /run-failed is FAILED and cannot be resumed/);
  });

  it("refuses while a run is active and defaults to the newest resumable run", async () => {
    const repo = tempRepo("gx-cmd-retry-default-");
    writeRun(repo, runState({ runId: "run-old-complete", state: "COMPLETE", updatedAt: "2025-01-01T00:00:00.000Z" }));
    writeRun(repo, runState({ runId: "run-new-paused", state: "PAUSED", resumeState: "DEVELOP", updatedAt: "2025-06-02T00:00:00.000Z" }));

    const guard = makeCtx(repo, true);
    const retry = findGxCommand("retry");
    assert.ok(retry);
    const active = makeEngine(runState({ runId: "run-live", state: "DEVELOP" }));
    await retry.handler(guard.ctx, active.engine, "");
    assert.equal(active.calls.resumes.length, 0);
    assert.match(guard.notifications.map((n) => n.text).join("\n"), /a run is active/);

    const idle = makeCtx(repo, true);
    const engine = makeEngine(null);
    await retry.handler(idle.ctx, engine.engine, "");
    assert.deepEqual(engine.calls.resumes, ["run-new-paused"], "default retry must skip terminal runs");
  });
});

describe("evidence command", () => {
  function writeManifest(repo: string, runId: string): void {
    writeRun(repo, runState({ runId, state: "DEVELOP" }));
    const dir = join(repo, ".gx-dev", "runs", runId, "evidence");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        kind: "agent-output",
        name: `developer-aaaa11111111.json`,
        hash: "aaaa1111111111111111111111111111111111111111111111111111111111",
        bytes: 120,
        at: "2025-06-01T00:00:01.000Z",
        source: "developer",
      }),
      JSON.stringify({
        kind: "commands",
        name: "test-gate-commands-bbbb2222.json",
        hash: "bbbb2222222222222222222222222222222222222222222222222222222222",
        bytes: 64,
        at: "2025-06-01T00:00:02.000Z",
        source: "test-runner",
        redactions: 2,
      }),
    ];
    writeFileSync(join(dir, "manifest.jsonl"), lines.join("\n") + "\n", "utf8");
  }

  it("displays manifest records for the active run and supports kind filters", async () => {
    const repo = tempRepo("gx-cmd-evidence-");
    writeManifest(repo, "run-ev-1");
    const { ctx, notifications } = makeCtx(repo, true);
    const { engine } = makeEngine(runState({ runId: "run-ev-1", state: "DEVELOP" }));

    const evidence = findGxCommand("evidence");
    assert.ok(evidence);
    await evidence.handler(ctx, engine, "");
    const all = notifications.map((n) => n.text).join("\n");
    assert.match(all, /evidence for run run-ev-1 \(2 record\(s\)\)/);
    assert.match(all, /developer-aaaa11111111\.json/);
    assert.match(all, /aaaa11111111/);
    assert.match(all, /\[2 redaction\(s\)\]/);

    await evidence.handler(ctx, engine, "run-ev-1 commands");
    const filtered = notifications[notifications.length - 1]?.text ?? "";
    assert.match(filtered, /1 record\(s\)/);
    assert.match(filtered, /test-gate-commands-bbbb2222\.json/);
    assert.ok(!filtered.includes("developer-aaaa11111111.json"));
  });

  it("falls back to the newest recorded run and reports missing evidence truthfully", async () => {
    const repo = tempRepo("gx-cmd-evidence-fallback-");
    writeRun(repo, runState({ runId: "run-old", state: "COMPLETE", updatedAt: "2025-01-01T00:00:00.000Z" }));
    writeRun(repo, runState({ runId: "run-new", state: "COMPLETE", updatedAt: "2025-06-02T00:00:00.000Z" }));
    const { ctx, notifications } = makeCtx(repo, true);
    const evidence = findGxCommand("evidence");
    assert.ok(evidence);

    await evidence.handler(ctx, makeEngine().engine, "");
    assert.match(
      notifications[notifications.length - 1]?.text ?? "",
      /no evidence recorded for run run-new/,
      "newest recorded run is the fallback target",
    );

    writeManifest(repo, "run-new");
    await evidence.handler(ctx, makeEngine().engine, "");
    assert.match(notifications[notifications.length - 1]?.text ?? "", /evidence for run run-new/);

    await evidence.handler(ctx, makeEngine().engine, "run-does-not-exist");
    assert.match(notifications[notifications.length - 1]?.text ?? "", /unknown run/);

    const emptyRepo = makeCtx(tempRepo("gx-cmd-evidence-empty-"), true);
    await evidence.handler(emptyRepo.ctx, makeEngine().engine, "");
    assert.match(emptyRepo.notifications.map((n) => n.text).join("\n"), /no runs recorded/);
  });
});

describe("cleanup command", () => {
  it("requires an explicit run id and refuses active or unfinished runs", async () => {
    const repo = tempRepo("gx-cmd-cleanup-guard-");
    writeRun(repo, runState({ runId: "run-paused", state: "PAUSED" }));
    writeRun(repo, runState({ runId: "run-done", state: "COMPLETE" }));
    const { ctx, notifications } = makeCtx(repo, true);

    const cleanup = findGxCommand("cleanup");
    assert.ok(cleanup);

    await cleanup.handler(ctx, makeEngine().engine, "");
    assert.match(notifications[0]?.text ?? "", /explicit run id is required/);

    const active = makeEngine(runState({ runId: "run-live", state: "DEVELOP" }));
    await cleanup.handler(ctx, active.engine, "run-done");
    assert.match(notifications[1]?.text ?? "", /cleanup is refused while a run is active|a run is active/);

    await cleanup.handler(ctx, makeEngine().engine, "run-paused");
    assert.match(notifications[2]?.text ?? "", /not finished/);

    await cleanup.handler(ctx, makeEngine().engine, "run-unknown");
    assert.match(notifications[3]?.text ?? "", /unknown run/);
  });

  it("refuses untrusted projects without touching worktrees", async () => {
    const { parent, repo } = tempSandbox("gx-cmd-cleanup-untrusted-");
    await initRepo(repo);
    const runId = "run-cleanup-u";
    const stagingPath = await addWorktree(parent, repo, runId, "staging");
    writeRun(repo, runState({ runId, state: "COMPLETE" }));

    const { ctx, notifications } = makeCtx(repo, false);
    const cleanup = findGxCommand("cleanup");
    assert.ok(cleanup);
    await cleanup.handler(ctx, makeEngine().engine, runId);

    assert.match(notifications.map((n) => n.text).join("\n"), /not trusted/);
    assert.ok(existsSync(stagingPath), "untrusted cleanup must not remove anything");
  });

  it("removes a finished run's worktrees and branches via GitWorktreeManager", async () => {
    const { parent, repo } = tempSandbox("gx-cmd-cleanup-real-");
    await initRepo(repo);
    const runId = "run-cleanup-1";
    const paths = [
      await addWorktree(parent, repo, runId, "developer"),
      await addWorktree(parent, repo, runId, "tests"),
      await addWorktree(parent, repo, runId, "staging"),
    ];
    writeRun(repo, runState({ runId, state: "COMPLETE" }));
    for (const p of paths) assert.ok(existsSync(p), "fixture worktree must exist");

    const { ctx, notifications } = makeCtx(repo, true);
    const cleanup = findGxCommand("cleanup");
    assert.ok(cleanup);
    await cleanup.handler(ctx, makeEngine().engine, runId);

    for (const p of paths) assert.ok(!existsSync(p), `worktree ${p} must be removed`);
    const branches = await git(repo, ["branch", "--list", `gx-dev/${runId}/*`]);
    assert.match(branches.stdout.trim(), /^\s*$/, "run branches must be deleted");
    assert.match(notifications.map((n) => n.text).join("\n"), /cleanup of run run-cleanup-1 complete/);
  });

  it("never force-removes leftovers: dirty worktrees are reported, not destroyed", async () => {
    const { parent, repo } = tempSandbox("gx-cmd-cleanup-dirty-");
    await initRepo(repo);
    const runId = "run-cleanup-2";
    const developer = await addWorktree(parent, repo, runId, "developer");
    const staging = await addWorktree(parent, repo, runId, "staging");
    writeFileSync(join(staging, "uncommitted.txt"), "precious\n", "utf8");
    writeRun(repo, runState({ runId, state: "CANCELLED" }));

    const { ctx, notifications } = makeCtx(repo, true);
    const cleanup = findGxCommand("cleanup");
    assert.ok(cleanup);
    await cleanup.handler(ctx, makeEngine().engine, runId);

    assert.ok(!existsSync(developer), "clean worktrees are still removed");
    assert.ok(existsSync(staging), "a dirty worktree must never be force-removed");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /leftover/);
    assert.match(text, /never force-removed/);
    assert.match(text, new RegExp(staging.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("memory command", () => {
  function writeMemoryFixture(repo: string): string {
    const root = join(repo, ".gx-dev", "memory");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "alpha.md"),
      [
        "---",
        "provenance: researcher:run-a",
        "scope: global",
        "freshness: 2025-01-01",
        "verification: verified",
        "confidence: high",
        "updated: 2025-01-01",
        "---",
        "",
        "## Summary",
        "",
        "Alpha convention about zebra builds.",
        "",
        "See [[conventions]].",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(root, "broken.md"), "# Broken\n\nno frontmatter at all\n", "utf8");
    return root;
  }

  it("refuses untrusted projects without scaffolding any memory state", async () => {
    const repo = tempRepo("gx-cmd-memory-untrusted-");
    const { ctx, notifications } = makeCtx(repo, false);
    const memory = findGxCommand("memory");
    assert.ok(memory);

    await memory.handler(ctx, makeEngine().engine, "lint");

    assert.match(notifications.map((n) => n.text).join("\n"), /not trusted/);
    assert.ok(!existsSync(join(repo, ".gx-dev")), "display commands must not create project state");
  });

  it("reports a missing store without creating it", async () => {
    const repo = tempRepo("gx-cmd-memory-missing-");
    const { ctx, notifications } = makeCtx(repo, true);
    const memory = findGxCommand("memory");
    assert.ok(memory);

    await memory.handler(ctx, makeEngine().engine, "search zebra");

    assert.match(notifications.map((n) => n.text).join("\n"), /no memory store yet/);
    assert.ok(!existsSync(join(repo, ".gx-dev", "memory")));
  });

  it("displays lint issues and search hits via FsMemoryStore when trusted", async () => {
    const repo = tempRepo("gx-cmd-memory-lint-");
    const root = writeMemoryFixture(repo);
    const { ctx, notifications } = makeCtx(repo, true);
    const memory = findGxCommand("memory");
    assert.ok(memory);

    await memory.handler(ctx, makeEngine().engine, "lint");
    const lintText = notifications[notifications.length - 1]?.text ?? "";
    assert.match(lintText, /memory lint: \d+ issue\(s\)/);
    assert.match(lintText, /broken: missing frontmatter field 'provenance'/);

    await memory.handler(ctx, makeEngine().engine, "search zebra");
    const searchText = notifications[notifications.length - 1]?.text ?? "";
    assert.match(searchText, /memory search "zebra" \(1 hit\(s\)\)/);
    assert.match(searchText, /alpha/);
    assert.match(searchText, /verified/);
    assert.ok(root.length > 0);
  });

  it("shows usage for bare or unknown subcommands", async () => {
    const repo = tempRepo("gx-cmd-memory-usage-");
    const { ctx, notifications } = makeCtx(repo, true);
    const memory = findGxCommand("memory");
    assert.ok(memory);

    await memory.handler(ctx, makeEngine().engine, "");
    await memory.handler(ctx, makeEngine().engine, "promote something");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /usage: \/gx-dev memory lint \| search <query>/);
  });
});

describe("status truthfulness", () => {
  it("points at recorded history when there is no active run", async () => {
    const repo = tempRepo("gx-cmd-status-history-");
    writeRun(repo, runState({ runId: "run-a", state: "COMPLETE", updatedAt: "2025-01-01T00:00:00.000Z" }));
    writeRun(repo, runState({ runId: "run-b", state: "PAUSED", updatedAt: "2025-02-01T00:00:00.000Z" }));
    const { ctx, notifications } = makeCtx(repo, true);
    const status = findGxCommand("status");
    assert.ok(status);

    await status.handler(ctx, makeEngine().engine, "");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /no active run/);
    assert.match(text, /2 recorded run\(s\)/);
    assert.match(text, /\/gx-dev history/);
  });

  it("keeps the plain message when nothing was ever recorded", async () => {
    const repo = tempRepo("gx-cmd-status-empty-");
    const { ctx, notifications } = makeCtx(repo, true);
    const status = findGxCommand("status");
    assert.ok(status);

    await status.handler(ctx, makeEngine().engine, "");
    assert.match(notifications.map((n) => n.text).join("\n"), /no active run \(start one with \/gx-dev start/);
  });

  it("prints the state line for an active run", async () => {
    const repo = tempRepo("gx-cmd-status-active-");
    const { ctx, notifications } = makeCtx(repo, true);
    const status = findGxCommand("status");
    assert.ok(status);

    await status.handler(ctx, makeEngine(runState({ runId: "run-live", state: "DEVELOP" })).engine, "");
    const text = notifications.map((n) => n.text).join("\n");
    assert.match(text, /run .* · DEVELOP ·/);
    assert.ok(!text.includes("no active run"));
  });
});
