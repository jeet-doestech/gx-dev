/**
 * Config policy tests (REVIEW P0: "Project configuration bypasses pi trust;
 * safety options can be ignored").
 *
 * Covers the strict, fail-closed configuration contract that production
 * wiring depends on: every known field is type- and range-checked, unknown
 * keys are rejected at every level, unsupported options are rejected
 * explicitly instead of being half-honored, default flag values always
 * validate, and an invalid config never leaks a partially-applied object.
 * loadConfigWithSources is the loader buildEngine() uses in production, so
 * these tests exercise the exact fail-closed path the engine is built from.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  defaultConfig,
  loadConfig,
  loadConfigWithSources,
  mergeModelSelection,
  unsetModelSelection,
  validateConfig,
} from "../../extensions/gx-dev/config.ts";

let cleanupDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs = [];
});

/** Writes .gx-dev/config.json in a fresh repo dir and validates it. */
function validateFromFile(raw: string) {
  const dir = tempDir("gxdev-cfg-");
  mkdirSync(join(dir, ".gx-dev"), { recursive: true });
  writeFileSync(join(dir, ".gx-dev", "config.json"), raw, "utf8");
  return validateConfig(JSON.parse(raw));
}

describe("validateConfig: defaults and valid configs", () => {
  it("accepts a version-only object and yields the defaults", () => {
    const result = validateConfig({ version: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.config, defaultConfig());
    assert.deepEqual(result.explicitModels, {});
  });

  it("requires the version field", () => {
    const result = validateConfig({});
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /version: must be 1/.test(e)));
  });

  it("accepts every default flag value without rejecting them", () => {
    const result = validateConfig({
      version: 1,
      agents: { maxConcurrency: 2, timeoutMinutes: 30, piBinary: "pi", models: {} },
      gates: { maxConsecutiveFailures: 5, maxTotalAttempts: 20, requireCleanFinalTree: true },
      research: { webEnabled: true, recordSources: true },
      memory: { enabled: true, updateOnSuccess: true, reviewRequired: true, redactSecrets: true },
      git: { worktreeRoot: "adjacent", retainFailedRuns: true, autoCommit: true, allowHistoryRewrite: false },
    });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.deepEqual(result.config, defaultConfig());
  });

  it("honors non-default values the engine consumes (autoCommit, maxConcurrency, gates)", () => {
    const result = validateConfig({
      version: 1,
      agents: { maxConcurrency: 4 },
      git: { autoCommit: false, retainFailedRuns: false },
      gates: { maxConsecutiveFailures: 2, maxTotalAttempts: 7, requireCleanFinalTree: false },
    });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.config.agents.maxConcurrency, 4);
    assert.equal(result.config.git.autoCommit, false);
    assert.equal(result.config.git.retainFailedRuns, false);
    assert.equal(result.config.gates.maxConsecutiveFailures, 2);
    assert.equal(result.config.gates.maxTotalAttempts, 7);
    assert.equal(result.config.gates.requireCleanFinalTree, false);
  });

  it("rejects policy switches the runtime cannot honor rather than silently ignoring them", () => {
    const result = validateConfig({
      version: 1,
      research: { webEnabled: false, recordSources: false },
      memory: { reviewRequired: false },
    });
    assert.equal(result.ok, false);
    for (const key of ["webEnabled", "recordSources", "reviewRequired"]) {
      assert.ok(result.errors.some((error) => error.includes(key) && error.includes("unsupported")));
    }
    const supported = validateConfig({ version: 1, memory: { enabled: false, updateOnSuccess: false, redactSecrets: false } });
    assert.equal(supported.ok, true, supported.errors.join("; "));
    assert.equal(supported.config.memory.enabled, false);
    assert.equal(supported.config.memory.updateOnSuccess, false);
  });

  it("accepts boundary range values", () => {
    const result = validateConfig({
      version: 1,
      agents: { maxConcurrency: 16, timeoutMinutes: 1440 },
      gates: { maxConsecutiveFailures: 100, maxTotalAttempts: 1000 },
    });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.config.agents.maxConcurrency, 16);
    assert.equal(result.config.agents.timeoutMinutes, 1440);
    assert.equal(result.config.gates.maxConsecutiveFailures, 100);
    assert.equal(result.config.gates.maxTotalAttempts, 1000);
  });

  it("accepts a fractional timeoutMinutes", () => {
    const result = validateConfig({ version: 1, agents: { timeoutMinutes: 0.5 } });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.equal(result.config.agents.timeoutMinutes, 0.5);
  });

  it("accepts a bare or absolute piBinary path", () => {
    for (const piBinary of ["pi", "/usr/local/bin/pi", "./bin/pi-tool"]) {
      const result = validateConfig({ version: 1, agents: { piBinary } });
      assert.equal(result.ok, true, `${piBinary}: ${result.errors.join("; ")}`);
      assert.equal(result.config.agents.piBinary, piBinary);
    }
  });

  it("records explicit model selections, including inherit", () => {
    const result = validateConfig({
      version: 1,
      agents: {
        models: {
          researcher: "zai/glm-5.3-flash:max",
          developer: "inherit",
          testWriter: "example/model",
        },
      },
    });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.deepEqual(result.explicitModels, {
      researcher: "zai/glm-5.3-flash:max",
      developer: "inherit",
      testWriter: "example/model",
    });
    assert.equal(result.config.agents.models.developer, "inherit");
  });
});

describe("validateConfig: unknown keys are rejected", () => {
  it("rejects unknown top-level keys", () => {
    const result = validateConfig({ version: 1, turbo: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /"turbo": unknown config key/.test(e)));
  });

  it("rejects unknown keys in every section", () => {
    const sections: Array<[string, Record<string, unknown>]> = [
      ["agents", { nope: 1 }],
      ["gates", { extra: true }],
      ["research", { mode: "deep" }],
      ["memory", { auto: false }],
      ["git", { remote: "origin" }],
    ];
    for (const [section, extra] of sections) {
      const result = validateConfig({ version: 1, [section]: extra });
      assert.equal(result.ok, false, `${section} must reject unknown keys`);
      assert.ok(
        result.errors.some((e) => e.startsWith(`${section}.`) && /unknown option/.test(e)),
        `${section} error should name the key: ${result.errors.join("; ")}`,
      );
    }
  });

  it("rejects unknown model role keys", () => {
    const result = validateConfig({
      version: 1,
      agents: { models: { researcher: "inherit", ceo: "x/y" } },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /agents\.models\.ceo: unknown role/.test(e)));
  });
});

describe("validateConfig: types and ranges", () => {
  it("requires version to be exactly 1", () => {
    for (const version of [2, "1", null, undefined]) {
      const result = validateConfig({ version });
      assert.equal(result.ok, false, `version ${String(version)} must be rejected`);
      assert.ok(result.errors.some((e) => /version: must be 1/.test(e)));
    }
  });

  it("rejects non-object sections (including arrays and null)", () => {
    for (const section of ["agents", "gates", "research", "memory", "git"]) {
      for (const bad of [[], null, "x", 5]) {
        const result = validateConfig({ version: 1, [section]: bad });
        assert.equal(result.ok, false, `${section}=${JSON.stringify(bad)} must be rejected`);
        assert.ok(
          result.errors.some((e) => e === `${section}: object required`),
          `${section}: ${result.errors.join("; ")}`,
        );
      }
    }
  });

  it("range-checks agents.maxConcurrency", () => {
    for (const bad of [0, -1, 1.5, 17, "2", true, NaN]) {
      const result = validateConfig({ version: 1, agents: { maxConcurrency: bad } });
      assert.equal(result.ok, false, `maxConcurrency ${String(bad)} must be rejected`);
      assert.ok(result.errors.some((e) => /agents\.maxConcurrency: integer between 1 and 16 required/.test(e)));
    }
    for (const good of [1, 8, 16]) {
      const result = validateConfig({ version: 1, agents: { maxConcurrency: good } });
      assert.equal(result.ok, true, `maxConcurrency ${good}: ${result.errors.join("; ")}`);
    }
  });

  it("range-checks agents.timeoutMinutes and rejects NaN/Infinity", () => {
    for (const bad of [0, -30, 1441, Number.NaN, Number.POSITIVE_INFINITY, "30", true]) {
      const result = validateConfig({ version: 1, agents: { timeoutMinutes: bad } });
      assert.equal(result.ok, false, `timeoutMinutes ${String(bad)} must be rejected`);
      assert.ok(result.errors.some((e) => /agents\.timeoutMinutes:/.test(e)));
    }
  });

  it("rejects empty or spaced piBinary values", () => {
    for (const bad of ["", "   ", "pi --mode json", "pie\n"]) {
      const result = validateConfig({ version: 1, agents: { piBinary: bad } });
      assert.equal(result.ok, false, `piBinary ${JSON.stringify(bad)} must be rejected`);
      assert.ok(result.errors.some((e) => /agents\.piBinary:/.test(e)));
    }
  });

  it("range-checks gates counters", () => {
    for (const [key, bad] of [
      ["maxConsecutiveFailures", 0],
      ["maxConsecutiveFailures", 101],
      ["maxConsecutiveFailures", 2.5],
      ["maxTotalAttempts", 0],
      ["maxTotalAttempts", 1001],
    ] as const) {
      const result = validateConfig({ version: 1, gates: { [key]: bad } });
      assert.equal(result.ok, false, `gates.${key}=${bad} must be rejected`);
      assert.ok(result.errors.some((e) => e.startsWith(`gates.${key}: integer between`)));
    }
  });

  it("requires booleans for every boolean option (no silent coercion)", () => {
    const booleanChecks: Array<[string, string]> = [
      ["gates", "requireCleanFinalTree"],
      ["research", "webEnabled"],
      ["research", "recordSources"],
      ["memory", "enabled"],
      ["memory", "updateOnSuccess"],
      ["memory", "reviewRequired"],
      ["memory", "redactSecrets"],
      ["git", "retainFailedRuns"],
      ["git", "autoCommit"],
      ["git", "allowHistoryRewrite"],
    ];
    for (const [section, key] of booleanChecks) {
      for (const bad of ["true", 1, null]) {
        const result = validateConfig({ version: 1, [section]: { [key]: bad } });
        assert.equal(result.ok, false, `${section}.${key}=${JSON.stringify(bad)} must be rejected`);
        assert.ok(
          result.errors.some((e) => e === `${section}.${key}: boolean required`),
          `${section}.${key}: ${result.errors.join("; ")}`,
        );
      }
    }
  });

  it("rejects model selections that are neither inherit nor provider/model[:thinking]", () => {
    // Note: ids may legitimately contain colons ("ollama-cloud/deepseek-v4-flash:0731"),
    // so only clearly malformed specs are rejected here.
    for (const bad of ["", "nomodel", "zai/", "/model", "a/b c"]) {
      const result = validateConfig({ version: 1, agents: { models: { researcher: bad } } });
      assert.equal(result.ok, false, `model ${JSON.stringify(bad)} must be rejected`);
      assert.ok(result.errors.some((e) => /agents\.models\.researcher:/.test(e)));
    }
    for (const bad of [5, true, null]) {
      const result = validateConfig({ version: 1, agents: { models: { researcher: bad } } });
      assert.equal(result.ok, false, `model ${String(bad)} must be rejected`);
      assert.ok(result.errors.some((e) => /agents\.models\.researcher: string required/.test(e)));
    }
  });

  it("rejects git.worktreeRoot values other than the supported 'adjacent'", () => {
    for (const bad of ["/tmp/wt", "sibling", "", "ADJACENT"]) {
      const result = validateConfig({ version: 1, git: { worktreeRoot: bad } });
      assert.equal(result.ok, false, `worktreeRoot ${JSON.stringify(bad)} must be rejected`);
      assert.ok(result.errors.some((e) => /git\.worktreeRoot: only "adjacent" is supported/.test(e)));
    }
    const good = validateConfig({ version: 1, git: { worktreeRoot: "adjacent" } });
    assert.equal(good.ok, true);
  });

  it("refuses git.allowHistoryRewrite: true even though it is a known boolean", () => {
    const result = validateConfig({ version: 1, git: { allowHistoryRewrite: true } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /history rewriting is not permitted/.test(e)));
  });
});

describe("validateConfig: fail-closed invalid results", () => {
  it("never returns a partially-applied config or partial explicit models", () => {
    const result = validateConfig({
      version: 1,
      agents: {
        maxConcurrency: 99,
        timeoutMinutes: 10,
        piBinary: "pi",
        models: { researcher: "valid/spec", developer: "nope" },
      },
      git: { autoCommit: false },
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 2);
    // Exactly the defaults — a caller that ignores ok must not observe the
    // valid-looking partial values from the invalid file.
    assert.deepEqual(result.config, defaultConfig());
    assert.deepEqual(result.explicitModels, {});
  });

  it("rejects non-object roots", () => {
    for (const bad of [null, "x", 5, true, []]) {
      const result = validateConfig(bad);
      assert.equal(result.ok, false);
      assert.deepEqual(result.config, defaultConfig());
    }
  });

  it("aggregates multiple errors from one file", () => {
    const result = validateConfig({
      version: 2,
      agents: { maxConcurrency: 0 },
      git: { worktreeRoot: "/nope", allowHistoryRewrite: true },
      bogus: 1,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 5, `expected several errors: ${result.errors.join("; ")}`);
  });
});

describe("loadConfigWithSources (production loader used by buildEngine)", () => {
  it("returns defaults when no config file exists", async () => {
    const dir = tempDir("gxdev-cfg-");
    const loaded = await loadConfigWithSources(dir);
    assert.equal(loaded.fromFile, false);
    assert.deepEqual(loaded.config, defaultConfig());
    assert.deepEqual(loaded.explicitModels, {});
    assert.deepEqual(await loadConfig(dir), defaultConfig());
  });

  it("loads a valid file with explicit selections", async () => {
    const dir = tempDir("gxdev-cfg-");
    mkdirSync(join(dir, ".gx-dev"), { recursive: true });
    writeFileSync(
      join(dir, ".gx-dev", "config.json"),
      JSON.stringify({ version: 1, agents: { models: { developer: "example/selected-model:high" } } }),
      "utf8",
    );
    const loaded = await loadConfigWithSources(dir);
    assert.equal(loaded.fromFile, true);
    assert.equal(loaded.config.agents.models.developer, "example/selected-model:high");
    assert.deepEqual(loaded.explicitModels, { developer: "example/selected-model:high" });
  });

  it("throws on unparsable JSON (fail closed, no defaults)", async () => {
    const dir = tempDir("gxdev-cfg-");
    mkdirSync(join(dir, ".gx-dev"), { recursive: true });
    writeFileSync(join(dir, ".gx-dev", "config.json"), "{not json", "utf8");
    await assert.rejects(() => loadConfigWithSources(dir), /cannot load/);
    await assert.rejects(() => loadConfig(dir), /cannot load/);
  });

  it("throws on a schema-invalid file instead of silently applying defaults", async () => {
    const dir = tempDir("gxdev-cfg-");
    mkdirSync(join(dir, ".gx-dev"), { recursive: true });
    writeFileSync(
      join(dir, ".gx-dev", "config.json"),
      JSON.stringify({ version: 1, agents: { piBinary: "" }, git: { autoCommit: false }, wat: 1 }),
      "utf8",
    );
    await assert.rejects(() => loadConfigWithSources(dir), (e: Error) => {
      return /invalid gx-dev config/.test(e.message) && /agents\.piBinary/.test(e.message);
    });
  });

  it("throws on unknown keys in a project file", async () => {
    const dir = tempDir("gxdev-cfg-");
    mkdirSync(join(dir, ".gx-dev"), { recursive: true });
    writeFileSync(
      join(dir, ".gx-dev", "config.json"),
      JSON.stringify({ version: 1, sandbox: "none" }),
      "utf8",
    );
    await assert.rejects(() => loadConfigWithSources(dir), /unknown config key/);
  });

  it("rejects an unsupported worktreeRoot from a project file", async () => {
    const result = validateFromFile(JSON.stringify({ version: 1, git: { worktreeRoot: "/tmp/wt" } }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /worktreeRoot/.test(e)));
  });
});

describe("model selection persistence round-trips through strict validation", () => {
  it("mergeModelSelection persists and re-loads an explicit selection", async () => {
    const dir = tempDir("gxdev-cfg-");
    const explicit = await mergeModelSelection(dir, "developer", "example/m:high");
    assert.deepEqual(explicit, { developer: "example/m:high" });
    const loaded = await loadConfigWithSources(dir);
    assert.equal(loaded.fromFile, true);
    assert.equal(loaded.config.agents.models.developer, "example/m:high");
  });

  it("mergeModelSelection refuses invalid specs", async () => {
    const dir = tempDir("gxdev-cfg-");
    await assert.rejects(() => mergeModelSelection(dir, "developer", "not a spec"), /invalid model selection/);
  });

  it("unsetModelSelection removes the explicit selection so defaults apply again", async () => {
    const dir = tempDir("gxdev-cfg-");
    await mergeModelSelection(dir, "developer", "example/m");
    const after = await unsetModelSelection(dir, "developer");
    assert.deepEqual(after, {});
    const loaded = await loadConfigWithSources(dir);
    assert.equal(loaded.config.agents.models.developer, defaultConfig().agents.models.developer);
  });
});
