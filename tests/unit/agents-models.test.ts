/**
 * Unit tests for per-subagent model selection (agents/models.ts):
 * CLI/registry discovery normalization, selection-string splitting,
 * precedence resolution, matching, and qualification.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  listModelsViaCli,
  listModelsViaRegistry,
  matchModel,
  parseListModelOutput,
  qualifySpec,
  resolveModelSpec,
  splitSpec,
  THINKING_LEVELS,
} from "../../extensions/gx-dev/agents/models.ts";
import type { PiModelInfo } from "../../extensions/gx-dev/agents/models.ts";

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

function model(provider: string, modelId: string, reasoning = false, images = false): PiModelInfo {
  return { id: `${provider}/${modelId}`, provider, modelId, name: modelId, reasoning, images };
}

// ---------------------------------------------------------------- fixture

const LIST_FIXTURE = [
  "provider        model                     context  max-out  thinking  images",
  "zai             glm-5.3-flash             1.0M     32.8K    yes       yes",
  "ollama-cloud    deepseek-v4-flash:0731    1.0M     32.8K    yes       no",
  "",
  "openai          gpt-5.2                   400K     128K     no        no",
  "single-column-row",
  "anthropic       claude-sonnet-4-5         200K     64K      yes",
].join("\n") + "\n";

// ------------------------------------------------------------------ tests

describe("parseListModelOutput", () => {
  it("parses the fixed-width table, skipping header, blank lines, and broken rows", () => {
    const models = parseListModelOutput(LIST_FIXTURE);
    assert.equal(models.length, 4, "header + blank + single-column row must be skipped");

    const zai = models[0]!;
    assert.equal(zai.id, "zai/glm-5.3-flash");
    assert.equal(zai.provider, "zai");
    assert.equal(zai.modelId, "glm-5.3-flash");
    assert.equal(zai.name, "glm-5.3-flash");
    assert.equal(zai.reasoning, true);
    assert.equal(zai.images, true);
    assert.equal(zai.contextWindow, "1.0M");
    assert.equal(zai.maxOutput, "32.8K");

    // Model ids may contain colons and survive intact.
    const deepseek = models[1]!;
    assert.equal(deepseek.id, "ollama-cloud/deepseek-v4-flash:0731");
    assert.equal(deepseek.reasoning, true);
    assert.equal(deepseek.images, false);

    const gpt = models[2]!;
    assert.equal(gpt.reasoning, false);
    assert.equal(gpt.images, false);

    // Missing trailing images column: images defaults to false, earlier cols kept.
    const claude = models[3]!;
    assert.equal(claude.id, "anthropic/claude-sonnet-4-5");
    assert.equal(claude.reasoning, true);
    assert.equal(claude.images, false);
    assert.equal(claude.contextWindow, "200K");
    assert.equal(claude.maxOutput, "64K");
  });

  it("returns [] for empty or header-only output", () => {
    assert.deepEqual(parseListModelOutput(""), []);
    assert.deepEqual(parseListModelOutput("provider model context max-out thinking images\n"), []);
    assert.deepEqual(parseListModelOutput("\n\n   \n"), []);
  });
});

describe("listModelsViaCli", () => {
  it("spawns the pi binary with an argv array and parses its table", async () => {
    const dir = tempDir("gxdev-models-");
    const argsFile = join(dir, "args.txt");
    const script = join(dir, "pi-list");
    writeFileSync(
      script,
      `#!/bin/sh
for a in "$@"; do
  printf '%s\n' "$a" >> "${argsFile}"
done
cat <<'GXEOF'
${LIST_FIXTURE}
GXEOF
`,
    );
    chmodSync(script, 0o755);

    const models = await listModelsViaCli(script, "glm");

    assert.equal(models.length, 4);
    assert.equal(models[0]!.id, "zai/glm-5.3-flash");
    const argv = readFileSync(argsFile, "utf8").split("\n").filter((l) => l.length > 0);
    assert.deepEqual(argv, ["--list-models", "glm"], "must use an argv array, never a shell string");
  });

  it("returns [] on nonzero exit", async () => {
    const dir = tempDir("gxdev-models-");
    const script = join(dir, "pi-fail");
    writeFileSync(script, '#!/bin/sh\necho "boom" >&2\nexit 3\n');
    chmodSync(script, 0o755);
    assert.deepEqual(await listModelsViaCli(script), []);
  });

  it("returns [] and kills the child on timeout", async () => {
    const dir = tempDir("gxdev-models-");
    const script = join(dir, "pi-hang");
    writeFileSync(script, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(script, 0o755);

    const start = Date.now();
    const models = await listModelsViaCli(script, undefined, 200);
    const elapsed = Date.now() - start;

    assert.deepEqual(models, []);
    assert.ok(elapsed < 5_000, `timeout path must not block (took ${elapsed}ms)`);
  });

  it("returns [] on spawn error (missing binary)", async () => {
    const models = await listModelsViaCli("/nonexistent/gx-dev-no-such-pi");
    assert.deepEqual(models, []);
  });
});

describe("listModelsViaRegistry", () => {
  it("normalizes well-formed registry Model objects", () => {
    const models = listModelsViaRegistry([
      {
        provider: "zai",
        id: "glm-5.3-flash",
        name: "GLM-5.3 Flash",
        reasoning: true,
        images: true,
        contextWindow: 1_048_576,
        maxOutput: "32.8K",
      },
      { provider: { id: "ollama-cloud" }, modelId: "deepseek-v4-flash:0731", reasoning: "yes" },
      { provider: "openai", id: "gpt-5.2", reasoning: false, images: false },
    ]);

    assert.equal(models.length, 3);
    assert.deepEqual(models[0], {
      id: "zai/glm-5.3-flash",
      provider: "zai",
      modelId: "glm-5.3-flash",
      name: "GLM-5.3 Flash",
      reasoning: true,
      images: true,
      contextWindow: "1048576",
      maxOutput: "32.8K",
    });
    // provider given as {id}; id under modelId; name defaults to modelId;
    // string-boolean reasoning.
    assert.deepEqual(models[1], {
      id: "ollama-cloud/deepseek-v4-flash:0731",
      provider: "ollama-cloud",
      modelId: "deepseek-v4-flash:0731",
      name: "deepseek-v4-flash:0731",
      reasoning: true,
      images: false,
    });
    assert.equal(models[2]!.id, "openai/gpt-5.2");
  });

  it("skips odd shapes without throwing", () => {
    const weird = [
      null,
      42,
      "a string",
      {},
      { provider: "zai" }, // no id
      { id: "orphan" }, // no provider
      { provider: {}, id: "x" }, // provider object without id
      { provider: { nope: true }, id: "x" }, // ditto
      { provider: "zai", id: 7 }, // non-string id
    ] as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(listModelsViaRegistry(weird), []);
  });
});

describe("splitSpec", () => {
  it("splits provider/model:thinking", () => {
    assert.deepEqual(splitSpec("zai/glm-5.3-flash:max"), {
      base: "zai/glm-5.3-flash",
      thinking: "max",
    });
  });

  it("splits on the LAST colon after the slash so colon-bearing ids survive", () => {
    assert.deepEqual(splitSpec("ollama-cloud/deepseek-v4-flash:0731:max"), {
      base: "ollama-cloud/deepseek-v4-flash:0731",
      thinking: "max",
    });
  });

  it("keeps bare specs and specs without a thinking suffix intact", () => {
    assert.deepEqual(splitSpec("glm-5.3"), { base: "glm-5.3" });
    assert.deepEqual(splitSpec("zai/glm-5.3-flash"), { base: "zai/glm-5.3-flash" });
  });

  it("ignores colons that appear before the last slash (path-like ids)", () => {
    assert.deepEqual(splitSpec("weird:prefix/glm-5.3"), { base: "weird:prefix/glm-5.3" });
  });
});

describe("resolveModelSpec", () => {
  const BUILTIN = "zai/glm-5.3-flash:max";

  it("explicit-config beats frontmatter beats configured beats builtin", () => {
    const all = resolveModelSpec({
      frontmatterModel: "a/fm:high",
      explicitConfigModel: "x/ex:max",
      configuredDefault: "c/cfg:low",
      builtinDefault: BUILTIN,
    });
    assert.deepEqual(all, {
      spec: "x/ex:max",
      inherits: false,
      source: "explicit-config",
      modelId: "x/ex",
      thinking: "max",
    });

    const noExplicit = resolveModelSpec({
      frontmatterModel: "a/fm:high",
      configuredDefault: "c/cfg:low",
      builtinDefault: BUILTIN,
    });
    assert.equal(noExplicit.source, "frontmatter");
    assert.equal(noExplicit.spec, "a/fm:high");
    assert.equal(noExplicit.modelId, "a/fm");

    const onlyConfigured = resolveModelSpec({ configuredDefault: "c/cfg:low", builtinDefault: BUILTIN });
    assert.equal(onlyConfigured.source, "configured-default");
    assert.equal(onlyConfigured.spec, "c/cfg:low");

    const onlyBuiltin = resolveModelSpec({ builtinDefault: BUILTIN });
    assert.deepEqual(onlyBuiltin, {
      spec: BUILTIN,
      inherits: false,
      source: "builtin-default",
      modelId: "zai/glm-5.3-flash",
      thinking: "max",
    });
  });

  it("inherit short-circuits immediately at each layer", () => {
    const explicit = resolveModelSpec({
      frontmatterModel: "a/fm:high",
      explicitConfigModel: "inherit",
      configuredDefault: "c/cfg",
      builtinDefault: BUILTIN,
    });
    assert.deepEqual(explicit, { spec: null, inherits: true, source: "explicit-config" });

    const frontmatter = resolveModelSpec({
      frontmatterModel: "inherit",
      configuredDefault: "c/cfg",
      builtinDefault: BUILTIN,
    });
    assert.deepEqual(frontmatter, { spec: null, inherits: true, source: "frontmatter" });

    const configured = resolveModelSpec({ configuredDefault: "inherit", builtinDefault: BUILTIN });
    assert.deepEqual(configured, { spec: null, inherits: true, source: "configured-default" });

    const builtin = resolveModelSpec({ builtinDefault: "inherit" });
    assert.deepEqual(builtin, { spec: null, inherits: true, source: "builtin-default" });
  });

  it("treats INHERIT case-insensitively", () => {
    for (const v of ["INHERIT", "Inherit", "iNhErIt"]) {
      const r = resolveModelSpec({ explicitConfigModel: v, builtinDefault: BUILTIN });
      assert.equal(r.inherits, true, v);
      assert.equal(r.source, "explicit-config");
    }
  });

  it("inherits at builtin-default when no layer is set", () => {
    assert.deepEqual(resolveModelSpec({}), { spec: null, inherits: true, source: "builtin-default" });
  });
});

describe("matchModel", () => {
  const models = parseListModelOutput(LIST_FIXTURE);

  it("matches by exact id", () => {
    assert.equal(matchModel(models, "zai/glm-5.3-flash")?.id, "zai/glm-5.3-flash");
    assert.equal(matchModel(models, "ollama-cloud/deepseek-v4-flash:0731")?.id, "ollama-cloud/deepseek-v4-flash:0731");
  });

  it("matches by selection base (sans thinking) equal to id", () => {
    assert.equal(matchModel(models, "zai/glm-5.3-flash:max")?.id, "zai/glm-5.3-flash");
    assert.equal(matchModel(models, "deepseek-v4-flash:0731:max")?.id, "ollama-cloud/deepseek-v4-flash:0731");
  });

  it("matches modelId case-insensitively (bare and with thinking)", () => {
    assert.equal(matchModel(models, "GLM-5.3-FLASH")?.id, "zai/glm-5.3-flash");
    assert.equal(matchModel(models, "Glm-5.3-Flash:High")?.id, "zai/glm-5.3-flash");
    assert.equal(matchModel(models, "DEEPSEEK-V4-FLASH:0731")?.id, "ollama-cloud/deepseek-v4-flash:0731");
  });

  it("returns the first model within a strategy when several share a modelId", () => {
    const dupes = [model("aaa", "dup"), model("bbb", "dup")];
    assert.equal(matchModel(dupes, "dup")?.id, "aaa/dup");
    assert.equal(matchModel(dupes, "DUP:MAX")?.id, "aaa/dup");
    assert.equal(matchModel(dupes, "bbb/dup")?.id, "bbb/dup");
  });

  it("returns null when nothing matches", () => {
    assert.equal(matchModel(models, "nope/nope"), null);
    assert.equal(matchModel(models, "does-not-exist"), null);
    assert.equal(matchModel([], "zai/glm-5.3-flash"), null);
  });
});

describe("qualifySpec", () => {
  it("appends :thinking only for reasoning models", () => {
    const reasoning = model("zai", "glm-5.3-flash", true);
    const plain = model("openai", "gpt-5.2", false);
    assert.equal(qualifySpec(reasoning, "max"), "zai/glm-5.3-flash:max");
    assert.equal(qualifySpec(plain, "high"), "openai/gpt-5.2");
  });

  it("returns the bare provider/model when thinking is omitted", () => {
    assert.equal(qualifySpec(model("zai", "glm-5.3-flash", true)), "zai/glm-5.3-flash");
    assert.equal(qualifySpec(model("openai", "gpt-5.2")), "openai/gpt-5.2");
  });
});

describe("THINKING_LEVELS", () => {
  it("covers the documented levels", () => {
    assert.deepEqual([...THINKING_LEVELS], ["off", "low", "medium", "high", "xhigh", "max"]);
  });
});
