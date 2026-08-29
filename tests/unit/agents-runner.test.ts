/**
 * Unit tests for the child pi process runner (agents/runner.ts).
 *
 * A fake `pi` shell script stands in for the real binary so the runner's
 * spawn/timeout/abort/retry behavior is exercised end to end without a
 * network or a model.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultConfig, GLM_53_FLASH_MAX } from "../../extensions/gx-dev/config.ts";
import type { GxConfig } from "../../extensions/gx-dev/config.ts";
import { MemoryArtifactStore } from "../../extensions/gx-dev/domain/artifacts.ts";
import type { EventStore, GxEvent, GxEventType } from "../../extensions/gx-dev/domain/events.ts";
import type { AgentWorkContext } from "../../extensions/gx-dev/domain/interfaces.ts";
import { PiAgentRunner } from "../../extensions/gx-dev/agents/runner.ts";

/**
 * Local in-memory event store. The shared MemoryEventStore in domain/events.ts
 * uses constructor parameter properties, which Node's strip-only TypeScript
 * loader cannot execute; tests therefore record events with this erasable
 * implementation (type-only import keeps the frozen file unloaded).
 */
class RecordingEventStore implements EventStore {
  private readonly items: GxEvent[] = [];
  private readonly runId: string;

  constructor(runId = "run-test") {
    this.runId = runId;
  }

  append(type: GxEventType, message: string, data?: Record<string, unknown>): GxEvent {
    const event: GxEvent = {
      seq: this.items.length + 1,
      at: new Date().toISOString(),
      runId: this.runId,
      type,
      message,
      ...(data === undefined ? {} : { data }),
    };
    this.items.push(event);
    return event;
  }

  events(): GxEvent[] {
    return [...this.items];
  }
}

const REAL_AGENTS_DIR = fileURLToPath(new URL("../../agents", import.meta.url));

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

// ---------------------------------------------------------------- fake pi

const researcherCompletionJson = JSON.stringify({
  status: "complete",
  summary: "Implemented researcher flow end to end.",
  artifacts: ["requirements-draft.md"],
  questions: [{ question: "Which CI system?", severity: "minor" }],
  assumptions: ["node >= 22"],
  risks: [],
  recommendedNextState: "PLAN",
  sources: [
    { url: "https://example.com/a", title: "A source", retrievedAt: "2025-01-01T00:00:00Z", confidence: "high" },
  ],
  findings: ["repo uses node"],
  requirementAmbiguities: [],
});

const assistantText = "Final report.\n\n```json\n" + researcherCompletionJson + "\n```";

const validEvents = [
  JSON.stringify({ type: "session", version: 3, id: "fake", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" }),
  JSON.stringify({
    type: "message_update",
    usage: { inputTokens: 42, outputTokens: 17 },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working" },
  }),
  JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "the task" }] } }),
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: assistantText }],
    },
  }),
].join("\n");

const invalidEvents = JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "I cannot produce JSON right now." }] },
});

function writeScript(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

function heredoc(events: string): string {
  return "cat <<'GXEOF'\n" + events + "\nGXEOF\n";
}

/** Always emits a valid researcher completion; records argv when asked. */
function fakeValid(dir: string): string {
  return writeScript(
    dir,
    "pi-valid",
    String.raw`#!/bin/sh
if [ -n "$GX_ARGV_FILE" ]; then
  for a in "$@"; do
    printf '%s\n' "$a" >> "$GX_ARGV_FILE"
  done
fi
` + heredoc(validEvents),
  );
}

/** Emits invalid output unless the task prompt contains the retry marker ("failed"). */
function fakeRetryThenValid(dir: string): string {
  return writeScript(
    dir,
    "pi-retry",
    String.raw`#!/bin/sh
for last in "$@"; do :; done
if [ -n "$GX_CALLS_FILE" ]; then
  printf 'x\n' >> "$GX_CALLS_FILE"
fi
case "$last" in
  *failed*)
` + heredoc(validEvents) + `
    ;;
  *)
` + heredoc(invalidEvents) + `
    ;;
esac
`,
  );
}

/** Always emits invalid output; counts invocations. */
function fakeAlwaysInvalid(dir: string): string {
  return writeScript(
    dir,
    "pi-garbage",
    String.raw`#!/bin/sh
if [ -n "$GX_CALLS_FILE" ]; then
  printf 'x\n' >> "$GX_CALLS_FILE"
fi
` + heredoc(invalidEvents),
  );
}

/** Sleeps forever; used for the timeout and abort paths. */
function fakeSleepForever(dir: string): string {
  return writeScript(dir, "pi-sleep", "#!/bin/sh\nexec sleep 30\n");
}

/** Exits 1 immediately with stderr noise and no stdout events; counts invocations. */
function fakeCrash(dir: string): string {
  return writeScript(
    dir,
    "pi-crash",
    String.raw`#!/bin/sh
if [ -n "$GX_CALLS_FILE" ]; then
  printf 'x\n' >> "$GX_CALLS_FILE"
fi
echo "boom: model unreachable" >&2
exit 1
`,
  );
}

// ---------------------------------------------------------------- harness

function makeConfig(piBinary: string): GxConfig {
  const config = defaultConfig();
  config.agents.piBinary = piBinary;
  return config;
}

interface RunHarness {
  events: RecordingEventStore;
  artifacts: MemoryArtifactStore;
  argvFile: string | null;
  callsFile: string | null;
}

function harness(scriptPath: string, recordArgv: boolean): { work: AgentWorkContext; stores: RunHarness } {
  const dir = tempDir("gxdev-run-");
  const argvFile = recordArgv ? join(dir, "argv.txt") : null;
  const callsFile = join(dir, "calls.txt");
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
  if (argvFile) env["GX_ARGV_FILE"] = argvFile;
  env["GX_CALLS_FILE"] = callsFile;
  return {
    work: { cwd: dir, writableRoots: [], env },
    stores: { events: new RecordingEventStore(), artifacts: new MemoryArtifactStore(), argvFile, callsFile },
  };
}

function readLines(file: string | null): string[] {
  if (!file) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}

// ------------------------------------------------------------------ tests

describe("PiAgentRunner", () => {
  it("spawns pi with json mode and role model, validates the completion, records evidence", async () => {
    const script = fakeValid(tempDir("gxdev-bin-"));
    const config = makeConfig(script);
    config.agents.models.researcher = "inherit"; // frontmatter model must win
    const { work, stores } = harness(script, true);
    const runner = new PiAgentRunner({ config, agentsDir: REAL_AGENTS_DIR, events: stores.events, artifacts: stores.artifacts });

    const result = await runner.run("researcher", "Draft requirements for feature X.", work);

    assert.equal(result.ok, true);
    assert.equal(result.infrastructure, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.role, "researcher");
    assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 17 });
    assert.ok(result.durationMs >= 0);
    assert.match(result.rawText, /Final report\./);
    assert.ok(result.completion);
    assert.equal(result.completion.status, "complete");
    if (result.completion && "sources" in result.completion) {
      assert.equal(result.completion.sources.length, 1);
    }

    const argv = readLines(stores.argvFile);
    assert.equal(argv[0], "--mode");
    assert.equal(argv[1], "json");
    const modelIdx = argv.indexOf("--model");
    assert.notEqual(modelIdx, -1, "--model flag must be present (from role frontmatter)");
    assert.equal(argv[modelIdx + 1], GLM_53_FLASH_MAX);
    const sysIdx = argv.indexOf("--append-system-prompt");
    assert.notEqual(sysIdx, -1);
    // The multiline system prompt spans several captured lines between the
    // flag and the final task argument; reassemble and check the body.
    const systemPrompt = argv.slice(sysIdx + 1, -1).join("\n");
    assert.match(systemPrompt, /Mission/);
    assert.equal(argv[argv.length - 1], "Draft requirements for feature X.");

    const events = stores.events.events();
    assert.ok(events.some((e) => e.type === "agent_completed"));
    assert.ok(!events.some((e) => e.type === "agent_failed"));
    const evidence = stores.artifacts.evidence();
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.kind, "agent-output");
    assert.equal(evidence[0]?.source, "researcher");
  });

  it("retries exactly once with schema feedback and then succeeds", async () => {
    const dir = tempDir("gxdev-bin-");
    const script = fakeRetryThenValid(dir);
    const { work, stores } = harness(script, false);
    const runner = new PiAgentRunner({ config: makeConfig(script), agentsDir: REAL_AGENTS_DIR, events: stores.events, artifacts: stores.artifacts });

    const result = await runner.run("researcher", "Produce the repository brief.", work);

    assert.equal(readLines(stores.callsFile).length, 2, "fake pi must be invoked exactly twice");
    assert.equal(result.ok, true);
    assert.equal(result.infrastructure, false);
    assert.ok(result.completion);
    assert.equal(result.completion.status, "complete");
    assert.ok(stores.events.events().some((e) => e.type === "agent_completed"));
  });

  it("fails without infrastructure flag when output stays invalid after the retry", async () => {
    const script = fakeAlwaysInvalid(tempDir("gxdev-bin-"));
    const { work, stores } = harness(script, false);
    const runner = new PiAgentRunner({ config: makeConfig(script), agentsDir: REAL_AGENTS_DIR, events: stores.events });

    const result = await runner.run("researcher", "Brief the team.", work);

    assert.equal(readLines(stores.callsFile).length, 2);
    assert.equal(result.ok, false);
    assert.equal(result.infrastructure, false);
    assert.equal(result.completion, null);
    assert.match(result.error ?? "", /retry/);
    assert.match(result.error ?? "", /unparseable JSON/);
    assert.ok(stores.events.events().some((e) => e.type === "agent_failed"));
  });

  it("kills the child and returns an infrastructure failure on timeout", async () => {
    const script = fakeSleepForever(tempDir("gxdev-bin-"));
    const { work, stores } = harness(script, false);
    const runner = new PiAgentRunner({ config: makeConfig(script), agentsDir: REAL_AGENTS_DIR, events: stores.events });

    const result = await runner.run("researcher", "Hanging task.", work, { timeoutMs: 300 });

    assert.equal(result.ok, false);
    assert.equal(result.infrastructure, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.completion, null);
    assert.match(result.error ?? "", /timed out after 300ms/);
    assert.ok(result.durationMs < 5_000);
    assert.ok(stores.events.events().some((e) => e.type === "agent_failed"));
  });

  it("kills the child and returns an infrastructure failure when the caller aborts", async () => {
    const script = fakeSleepForever(tempDir("gxdev-bin-"));
    const { work, stores } = harness(script, false);
    const runner = new PiAgentRunner({ config: makeConfig(script), agentsDir: REAL_AGENTS_DIR, events: stores.events });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50).unref();

    const result = await runner.run("researcher", "Aborted task.", work, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    assert.equal(result.ok, false);
    assert.equal(result.infrastructure, true);
    assert.match(result.error ?? "", /aborted/);
  });

  it("reports an infrastructure failure for nonzero exit with no events", async () => {
    const script = fakeCrash(tempDir("gxdev-bin-"));
    const { work, stores } = harness(script, false);
    const runner = new PiAgentRunner({ config: makeConfig(script), agentsDir: REAL_AGENTS_DIR, events: stores.events, artifacts: stores.artifacts });

    const result = await runner.run("researcher", "Any task.", work);

    assert.equal(result.ok, false);
    assert.equal(result.infrastructure, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.completion, null);
    assert.match(result.error ?? "", /exited with code 1/);
    assert.match(result.error ?? "", /model unreachable/);
    assert.equal(stores.artifacts.evidence().length, 0, "no evidence on failure");
    assert.ok(stores.events.events().some((e) => e.type === "agent_failed"));
  });

  it("omits --model when the resolved spec is inherit", async () => {
    const binDir = tempDir("gxdev-bin-");
    const script = fakeValid(binDir);
    const agentsDir = tempDir("gxdev-agents-");
    writeFileSync(
      join(agentsDir, "researcher.md"),
      "---\nname: researcher\ndescription: d\ntools: read\n---\nPlain single-line researcher prompt body.\n",
    );
    const config = makeConfig(script);
    config.agents.models.researcher = "inherit";
    const { work, stores } = harness(script, true);
    const runner = new PiAgentRunner({ config, agentsDir, events: stores.events });

    const result = await runner.run("researcher", "Task without model.", work);

    assert.equal(result.ok, true);
    const argv = readLines(stores.argvFile);
    assert.equal(argv.indexOf("--model"), -1, "inherit must omit the --model flag");
    const sysIdx = argv.indexOf("--append-system-prompt");
    assert.equal(argv[sysIdx + 1], "Plain single-line researcher prompt body.");
    assert.equal(argv[argv.length - 1], "Task without model.");
  });

  it("spawns --model from explicit user config, beating the role-prompt pin", async () => {
    const script = fakeValid(tempDir("gxdev-bin-"));
    const config = makeConfig(script);
    const { work, stores } = harness(script, true);
    // REAL_AGENTS_DIR's researcher.md pins zai/glm-5.3-flash:max in
    // frontmatter; the explicit selection must override it.
    const runner = new PiAgentRunner({
      config,
      agentsDir: REAL_AGENTS_DIR,
      explicitModels: { researcher: "x/y:high" },
      events: stores.events,
    });

    const result = await runner.run("researcher", "Explicit model selection.", work);

    assert.equal(result.ok, true);
    const argv = readLines(stores.argvFile);
    const modelIdx = argv.indexOf("--model");
    assert.notEqual(modelIdx, -1, "explicit config must produce a --model flag");
    assert.equal(argv[modelIdx + 1], "x/y:high");
    assert.ok(stores.events.events().some((e) => e.type === "agent_completed"));
  });

  it("omits --model when explicit config says inherit, even with a frontmatter pin", async () => {
    const script = fakeValid(tempDir("gxdev-bin-"));
    const config = makeConfig(script);
    const { work, stores } = harness(script, true);
    // Frontmatter pins a model; the explicit "inherit" must win and let the
    // orchestrating session's model apply.
    const runner = new PiAgentRunner({
      config,
      agentsDir: REAL_AGENTS_DIR,
      explicitModels: { researcher: "inherit" },
      events: stores.events,
    });

    const result = await runner.run("researcher", "Inherit from session.", work);

    assert.equal(result.ok, true);
    const argv = readLines(stores.argvFile);
    assert.equal(argv.indexOf("--model"), -1, "explicit inherit must omit the --model flag");
  });

  it("does not retry when the first attempt fails on infrastructure", async () => {
    const script = fakeCrash(tempDir("gxdev-bin-"));
    const { work, stores } = harness(script, false);
    const runner = new PiAgentRunner({ config: makeConfig(script), agentsDir: REAL_AGENTS_DIR });

    await runner.run("researcher", "Task.", work);
    assert.equal(readLines(stores.callsFile).length, 1, "infrastructure failures must not be retried");
  });
});
