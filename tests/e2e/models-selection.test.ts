/**
 * E2E tests for the headless per-subagent model selection CLI
 * (scripts/models.mjs) and the doctor MODEL section (scripts/doctor.mjs).
 *
 * The real CLI and doctor run as child processes against throwaway temp
 * repos (`--repo`). `pi` is faked by PATH-prepending a temp dir containing an
 * executable `pi` shell script that prints a fixed `--list-models` table
 * fixture, so `list` and the doctor model-availability checks are fully
 * deterministic and network-free. `set`'s availability probe is non-blocking
 * (WARN only), so tests (a)/(d) do not depend on a real pi either.
 *
 * The sibling extensions/gx-dev/agents/models.ts is built in parallel; while
 * it is absent these tests skip with an explicit reason and start running
 * automatically the moment it lands.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileP = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODELS_CLI = join(ROOT, "scripts", "models.mjs");
const DOCTOR_CLI = join(ROOT, "scripts", "doctor.mjs");
/** Parallel-built sibling the scripts import at runtime. */
const MODELS_TS = join(ROOT, "extensions", "gx-dev", "agents", "models.ts");

const SKIP_REASON =
  "sibling extensions/gx-dev/agents/models.ts (parallel build) not present yet";

const DEEPSEEK_SPEC = "ollama-cloud/deepseek-v4-flash:0731:max";

/** Fixed `pi --list-models` fixture: fake entries plus the builtin default's zai/glm-5.3-flash. */
const FAKE_MODEL_TABLE = [
  "provider      model                       context  max-out  thinking  images",
  "fake-cloud    test-model-1                128K     8K       yes       no",
  "fake-cloud    vision-thing                200K     16K      no        yes",
  "zai           glm-5.3-flash               1.0M     32.8K    yes       no",
  "",
].join("\n");

/** Deterministic pi stand-in: --version for doctor's binary check, fixed table otherwise. */
const FAKE_PI_SH = `#!/bin/sh
# gx-dev e2e fake: deterministic \`pi --list-models\` fixture.
case "$1" in
  --version) echo "1.0.0-fake"; exit 0 ;;
esac
cat <<'GX_FIXTURE'
${FAKE_MODEL_TABLE}GX_FIXTURE
exit 0
`;

function siblingModelsPresent(): boolean {
  try {
    accessSync(MODELS_TS);
    return true;
  } catch {
    return false;
  }
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePiDir(): string {
  const dir = makeTempDir("gx-fake-pi-");
  const pi = join(dir, "pi");
  writeFileSync(pi, FAKE_PI_SH);
  chmodSync(pi, 0o755);
  return dir;
}

function fakePathEnv(fakeDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${fakeDir}${delimiter}${process.env.PATH ?? ""}` };
}

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs `node <script> <args>`; captures exit status and output even on failure. */
async function runNode(
  script: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<CliRun> {
  try {
    const { stdout } = await execFileP(process.execPath, [script, ...args], {
      cwd: ROOT,
      ...(env === undefined ? {} : { env }),
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      status: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? String(error),
    };
  }
}

interface RawConfig {
  agents?: { models?: Record<string, string> };
}

test("set persists a researcher selection, get reports explicit-config resolution, and .gx-dev/config.json contains it", async (t) => {
  if (!siblingModelsPresent()) return t.skip(SKIP_REASON);
  const repo = makeTempDir("gx-models-repo-");
  try {
    const set = await runNode(MODELS_CLI, ["set", "researcher", DEEPSEEK_SPEC, "--repo", repo]);
    assert.equal(set.status, 0, `set must exit 0, got ${set.status}; stderr: ${set.stderr}`);

    const configFile = join(repo, ".gx-dev", "config.json");
    assert.ok(existsSync(configFile), ".gx-dev/config.json must be created");
    const raw = JSON.parse(readFileSync(configFile, "utf8")) as RawConfig;
    assert.equal(
      raw.agents?.models?.["researcher"],
      DEEPSEEK_SPEC,
      "config.json must contain the explicit selection",
    );

    const get = await runNode(MODELS_CLI, ["get", "researcher", "--repo", repo]);
    assert.equal(get.status, 0, `get must exit 0, got ${get.status}; stderr: ${get.stderr}`);
    assert.match(get.stdout, /deepseek/, "get must mention the deepseek spec");
    assert.match(get.stdout, /explicit-config/, "get must report the explicit-config source");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("set with a malformed spec exits 2", async (t) => {
  if (!siblingModelsPresent()) return t.skip(SKIP_REASON);
  const repo = makeTempDir("gx-models-repo-");
  try {
    const res = await runNode(MODELS_CLI, ["set", "researcher", "not a spec!", "--repo", repo]);
    assert.equal(res.status, 2, `invalid spec must exit 2, got ${res.status}`);
    assert.match(`${res.stderr}${res.stdout}`, /invalid model spec/i);
    assert.ok(
      !existsSync(join(repo, ".gx-dev", "config.json")),
      "a rejected spec must not write config",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("set with an unknown role exits 1", async (t) => {
  if (!siblingModelsPresent()) return t.skip(SKIP_REASON);
  const repo = makeTempDir("gx-models-repo-");
  try {
    const res = await runNode(MODELS_CLI, ["set", "nope", "x/y", "--repo", repo]);
    assert.equal(res.status, 1, `unknown role must exit 1, got ${res.status}`);
    assert.match(`${res.stderr}${res.stdout}`, /unknown role/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unset removes the config key and get falls back to a non-explicit source", async (t) => {
  if (!siblingModelsPresent()) return t.skip(SKIP_REASON);
  const repo = makeTempDir("gx-models-repo-");
  try {
    const set = await runNode(MODELS_CLI, ["set", "researcher", DEEPSEEK_SPEC, "--repo", repo]);
    assert.equal(set.status, 0, `setup set must exit 0; stderr: ${set.stderr}`);

    const unset = await runNode(MODELS_CLI, ["unset", "researcher", "--repo", repo]);
    assert.equal(unset.status, 0, `unset must exit 0, got ${unset.status}; stderr: ${unset.stderr}`);

    const raw = JSON.parse(readFileSync(join(repo, ".gx-dev", "config.json"), "utf8")) as RawConfig;
    assert.ok(
      raw.agents?.models && !("researcher" in raw.agents.models),
      "unset must remove the researcher key from config.json",
    );

    const get = await runNode(MODELS_CLI, ["get", "researcher", "--repo", repo]);
    assert.equal(get.status, 0, `get after unset must exit 0; stderr: ${get.stderr}`);
    assert.ok(
      !get.stdout.includes("deepseek"),
      "the explicit deepseek spec must be gone from the resolution",
    );
    // The winning source must no longer be the explicit config selection.
    assert.doesNotMatch(get.stdout, /final:.*explicit-config/);
    assert.match(
      get.stdout,
      /final:.*source: (frontmatter|configured-default|builtin-default)/,
      `get must show a frontmatter/builtin-layer source after unset; got: ${get.stdout}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("list works against a fake pi on PATH and prints the fixture models", async (t) => {
  if (!siblingModelsPresent()) return t.skip(SKIP_REASON);
  const repo = makeTempDir("gx-models-repo-");
  const fakePiDir = makeFakePiDir();
  try {
    const res = await runNode(
      MODELS_CLI,
      ["list", "--repo", repo],
      fakePathEnv(fakePiDir),
    );
    assert.equal(res.status, 0, `list must exit 0, got ${res.status}; stderr: ${res.stderr}`);
    assert.match(res.stdout, /test-model-1/, "list output must contain a fixture model");
    assert.match(res.stdout, /fake-cloud/, "list output must contain the fixture provider");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(fakePiDir, { recursive: true, force: true });
  }
});

test("doctor exits 0 with the fake pi and PASSes the model section deterministically", async (t) => {
  if (!siblingModelsPresent()) return t.skip(SKIP_REASON);
  const repo = makeTempDir("gx-models-repo-");
  const fakePiDir = makeFakePiDir();
  try {
    const res = await runNode(DOCTOR_CLI, ["--repo", repo], fakePathEnv(fakePiDir));
    assert.equal(
      res.status,
      0,
      `doctor must still exit 0, got ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
    assert.ok(!res.stdout.includes("FAIL"), "doctor output must contain no FAIL lines");
    // Every role resolves to zai/glm-5.3-flash:max (frontmatter pin or
    // builtin default) and the fixture table offers zai/glm-5.3-flash.
    assert.match(res.stdout, /PASS\s+researcher zai\/glm-5\.3-flash:max/);
    assert.match(res.stdout, /PASS\s+committer zai\/glm-5\.3-flash:max/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(fakePiDir, { recursive: true, force: true });
  }
});
