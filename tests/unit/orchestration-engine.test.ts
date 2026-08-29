/**
 * Unit tests for the gx-dev orchestration engine (PLAN §5, §7, §9).
 * Every collaborator is a local in-memory fake: no pi APIs, no real git
 * repositories, no network. Small timeouts only; deterministic scripts.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { defaultConfig, type GxConfig } from "../../extensions/gx-dev/config.ts";
import type {
  ArtifactStore,
  EvidenceKind,
  EvidenceRecord,
} from "../../extensions/gx-dev/domain/artifacts.ts";
import { hashContent } from "../../extensions/gx-dev/domain/artifacts.ts";
import type {
  AgentRunResult,
  AgentRunner,
  AgentWorkContext,
  GitCoordinator,
  IntegratedResult,
  MemoryCoordinator,
  MemoryPage,
  MemoryProposal,
  RunStore,
  WorktreeHandles,
} from "../../extensions/gx-dev/domain/interfaces.ts";
import type {
  EventStore,
  GxEvent,
  GxEventType,
} from "../../extensions/gx-dev/domain/events.ts";
import type {
  AgentCompletion,
  AgentQuestion,
  AgentRole,
} from "../../extensions/gx-dev/domain/schemas.ts";
import type { RunState } from "../../extensions/gx-dev/domain/state.ts";
import {
  Engine,
  type EngineDeps,
} from "../../extensions/gx-dev/orchestration/engine.ts";

// --------------------------------------------------------------------- fakes

type AgentScript = (
  role: AgentRole,
  task: string,
  call: number,
) => AgentRunResult | Promise<AgentRunResult>;

class FakeRunner implements AgentRunner {
  readonly calls: { role: AgentRole; task: string }[] = [];
  private readonly script: AgentScript;
  constructor(script: AgentScript) {
    this.script = script;
  }
  async run(role: AgentRole, task: string, _work: AgentWorkContext): Promise<AgentRunResult> {
    this.calls.push({ role, task });
    const call = this.calls.filter((c) => c.role === role).length;
    return await this.script(role, task, call);
  }
  count(role: AgentRole): number {
    return this.calls.filter((c) => c.role === role).length;
  }
  prompts(role: AgentRole): string[] {
    return this.calls.filter((c) => c.role === role).map((c) => c.task);
  }
}

class FakeGit implements GitCoordinator {
  readonly prepareCalls: string[] = [];
  readonly commitCalls: { message: string; baseBranch: string }[] = [];
  readonly cleaned: { runId: string; opts?: { force?: boolean } }[] = [];
  integrateCount = 0;
  async recordBase(_repoPath: string) {
    return { branch: "main", commit: "abc123def456", dirty: false };
  }
  async prepareWorktrees(repoPath: string, runId: string): Promise<WorktreeHandles> {
    this.prepareCalls.push(runId);
    const root = join(repoPath, ".gx-dev-worktrees", runId);
    const developer = join(root, "developer");
    const tests = join(root, "tests");
    const staging = join(root, "staging");
    // The engine's real command executor needs the directories to exist.
    for (const dir of [developer, tests, staging]) mkdirSync(dir, { recursive: true });
    return {
      runId,
      developer,
      tests,
      staging,
      branches: {
        developer: `gx-dev/${runId}/developer`,
        tests: `gx-dev/${runId}/tests`,
        staging: `gx-dev/${runId}/staging`,
      },
    };
  }
  async integrate(handles: WorktreeHandles): Promise<IntegratedResult> {
    this.integrateCount += 1;
    return {
      stagingWorktree: handles.staging ?? "",
      success: true,
      conflictedFiles: [],
      autoResolved: [],
    };
  }
  async checkpointStaging(_handles: WorktreeHandles, _message: string) {
    return null;
  }
  async commitStaged(_handles: WorktreeHandles, message: string, baseBranch: string) {
    this.commitCalls.push({ message, baseBranch });
    return {
      commitHash: "deadbeef1234567890",
      strategy: "fast-forward",
      rollbackCommand: "git revert deadbeef1234567890",
    };
  }
  async cleanup(handles: WorktreeHandles, opts?: { force?: boolean }) {
    this.cleaned.push({ runId: handles.runId, ...(opts ? { opts } : {}) });
  }
}

class FakeMemory implements MemoryCoordinator {
  readonly reserved: MemoryProposal[][] = [];
  readonly promoted: MemoryProposal[][] = [];
  async reserve(proposals: MemoryProposal[]): Promise<MemoryProposal[]> {
    this.reserved.push(proposals);
    return proposals;
  }
  async promote(proposals: MemoryProposal[]) {
    this.promoted.push(proposals);
    return { applied: proposals.map((p) => p.page), conflicts: [] as string[] };
  }
  async search(_query: string, _limit?: number): Promise<MemoryPage[]> {
    return [];
  }
  async lint() {
    return { ok: true, issues: [] as string[] };
  }
}

class FakeRunStore implements RunStore {
  readonly saves: RunState[] = [];
  private readonly map = new Map<string, RunState>();
  async save(state: RunState): Promise<void> {
    this.map.set(state.runId, state);
    this.saves.push(state);
  }
  async load(runId: string): Promise<RunState | null> {
    return this.map.get(runId) ?? null;
  }
  async list() {
    return [...this.map.values()].map((s) => ({
      runId: s.runId,
      state: s.state,
      updatedAt: s.updatedAt,
    }));
  }
}

class FakeArtifactStore implements ArtifactStore {
  readonly runDir = "<memory>";
  private readonly artifacts = new Map<string, string>();
  private readonly records: EvidenceRecord[] = [];
  recordEvidence(kind: EvidenceKind, content: string, source: string, name?: string): EvidenceRecord {
    const hash = hashContent(content);
    const record: EvidenceRecord = {
      kind,
      name: name ?? `${hash}.txt`,
      hash,
      bytes: Buffer.byteLength(content, "utf8"),
      at: new Date().toISOString(),
      source,
    };
    this.records.push(record);
    return record;
  }
  readArtifact(name: string): string | null {
    return this.artifacts.get(name) ?? null;
  }
  writeArtifact(name: string, content: string): string {
    this.artifacts.set(name, content);
    return hashContent(content);
  }
  evidence(): EvidenceRecord[] {
    return [...this.records];
  }
}

class FakeEventStore implements EventStore {
  private readonly items: GxEvent[] = [];
  append(type: GxEventType, message: string, data?: Record<string, unknown>): GxEvent {
    const event: GxEvent = {
      seq: this.items.length + 1,
      at: new Date().toISOString(),
      runId: "run-test",
      type,
      message,
      ...(data ? { data } : {}),
    };
    this.items.push(event);
    return event;
  }
  events(): GxEvent[] {
    return [...this.items];
  }
  of(type: GxEventType): GxEvent[] {
    return this.items.filter((e) => e.type === type);
  }
}

// ------------------------------------------------------------- script helpers

function agentResult(
  role: AgentRole,
  completion: AgentCompletion | null,
  opts?: { ok?: boolean; error?: string; rawText?: string },
): AgentRunResult {
  const ok = opts?.ok ?? true;
  const result: AgentRunResult = {
    role,
    completion: ok ? completion : null,
    rawText:
      opts?.rawText ?? "```json\n" + JSON.stringify(completion, null, 2) + "\n```",
    ok,
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    exitCode: 0,
    infrastructure: false,
  };
  if (opts?.error !== undefined) result.error = opts.error;
  return result;
}

function researcherCompletion(questions: AgentQuestion[] = []): AgentCompletion {
  return {
    status: "complete",
    summary: "Researched the repository: TypeScript ESM project using node:test.",
    artifacts: [],
    questions,
    assumptions: [],
    risks: [],
    sources: [],
    findings: ["TypeScript ESM codebase", "Tests run with node:test"],
    requirementAmbiguities: [],
  };
}

function plannerCompletion(): AgentCompletion {
  return {
    status: "complete",
    summary: "Plan: implement the greeting module and independent behavior tests.",
    artifacts: [],
    questions: [],
    assumptions: [],
    risks: [],
    tasks: [
      { id: "d1", assignee: "developer", title: "Implement greeting module", files: ["src/feature.ts"], dependsOn: [] },
      { id: "t1", assignee: "testWriter", title: "Write behavior tests", files: ["test/feature.test.ts"], dependsOn: [] },
    ],
    verificationContract: ["node -e process.exit(0)"],
    rollbackPlan: "git revert the gx-dev commit",
  };
}

function developerCompletionJson(): AgentCompletion {
  return {
    status: "complete",
    summary: "Implemented the greeting module with exported helpers.",
    artifacts: ["src/feature.ts"],
    questions: [],
    assumptions: [],
    risks: [],
    changedFiles: ["src/feature.ts"],
    deviations: [],
    knownLimitations: [],
  };
}

function testWriterCompletionJson(): AgentCompletion {
  return {
    status: "complete",
    summary: "Wrote independent behavior tests for the greeting module.",
    artifacts: ["test/feature.test.ts"],
    questions: [],
    assumptions: [],
    risks: [],
    testInventory: [{ path: "test/feature.test.ts", covers: "greet() behavior" }],
    coverageGaps: [],
  };
}

function testRunnerCompletion(
  commands: string[],
  ownership: { failure: string; owner: "developer" | "testWriter" | "both" | "infrastructure" }[] = [],
): AgentCompletion {
  return {
    status: "complete",
    summary: "Discovered and executed the verification commands.",
    artifacts: [],
    questions: [],
    assumptions: [],
    risks: [],
    commands: commands.map((command) => ({ command, exitCode: 0 })),
    ownership,
  };
}

function reviewerCompletion(): AgentCompletion {
  return {
    status: "complete",
    summary: "Reviewed the combined diff; no blocking findings.",
    artifacts: [],
    questions: [],
    assumptions: [],
    risks: [],
    findings: [],
    documentationUpdates: [],
  };
}

function committerCompletion(): AgentCompletion {
  return {
    status: "complete",
    summary: "feat: add greeting endpoint",
    artifacts: ["src/feature.ts"],
    questions: [],
    assumptions: [],
    risks: [],
    strategy: "fast-forward",
    commitHash: "deadbeef1234567890",
    rollbackCommand: "git revert deadbeef1234567890",
  };
}

// Raw agent text feeding the developer/test diffs via the engine's fallback:
// the fenced JSON plus notes exceeds the 10-non-trivial-line preflight bar.
const DEV_RAW = [
  "```json",
  JSON.stringify(developerCompletionJson(), null, 2),
  "```",
  "",
  "Implementation notes:",
  "- Added src/feature.ts with the requested greeting helper.",
  "- Exported the public function following existing module conventions.",
  "- Kept backward compatibility with existing exports.",
].join("\n");

const TEST_RAW = [
  "```json",
  JSON.stringify(testWriterCompletionJson(), null, 2),
  "```",
  "",
  "Test notes:",
  "- Covered the greeting behavior from the public contract only.",
  "- Added positive and failure-path cases.",
  "- No production code was touched.",
].join("\n");

function happyScript(role: AgentRole, _task: string, _call: number): AgentRunResult {
  switch (role) {
    case "researcher":
      return agentResult(role, researcherCompletion());
    case "planner":
      return agentResult(role, plannerCompletion());
    case "developer":
      return agentResult(role, developerCompletionJson(), { rawText: DEV_RAW });
    case "testWriter":
      return agentResult(role, testWriterCompletionJson(), { rawText: TEST_RAW });
    case "testRunner":
      return agentResult(role, testRunnerCompletion(["node -e process.exit(0)"]));
    case "reviewer":
      return agentResult(role, reviewerCompletion());
    case "committer":
      return agentResult(role, committerCompletion());
  }
}

function flakyTestGateScript(failures: number): AgentScript {
  return (role, task, call) => {
    if (role === "testRunner") {
      if (call <= failures) {
        return agentResult(
          role,
          testRunnerCompletion(["node -e process.exit(1)"], [
            { failure: "greeting does not match the requirements", owner: "developer" },
          ]),
        );
      }
      return agentResult(role, testRunnerCompletion(["node -e process.exit(0)"]));
    }
    return happyScript(role, task, call);
  };
}

// -------------------------------------------------------------------- harness

const EXPECTED_HAPPY_HISTORY = [
  "INTAKE",
  "RESEARCH",
  "REQUIREMENTS_APPROVAL",
  "PLAN",
  "PLAN_APPROVAL",
  "PREPARE_WORKTREES",
  "DEVELOP",
  "WRITE_TESTS",
  "INTEGRATE",
  "TEST_GATE",
  "REVIEW_GATE",
  "DOCUMENTATION_UPDATE",
  "FINAL_VERIFICATION",
  "COMMIT",
  "MEMORY_PROMOTION",
  "COMPLETE",
] as const;

interface Harness {
  repo: string;
  runner: FakeRunner;
  git: FakeGit;
  memory: FakeMemory;
  runStore: FakeRunStore;
  artifacts: FakeArtifactStore;
  events: FakeEventStore;
  engine: Engine;
}

const tempDirs: string[] = [];

async function makeHarness(
  script: AgentScript,
  configOverrides?: (c: GxConfig) => void,
): Promise<Harness> {
  const repo = await mkdtemp(join(tmpdir(), "gx-dev-engine-"));
  tempDirs.push(repo);
  const config = defaultConfig();
  config.gates.requireCleanFinalTree = false; // fake worktrees are not git repos
  if (configOverrides) configOverrides(config);
  const runner = new FakeRunner(script);
  const git = new FakeGit();
  const memory = new FakeMemory();
  const runStore = new FakeRunStore();
  const artifacts = new FakeArtifactStore();
  const events = new FakeEventStore();
  const deps: EngineDeps = { runner, git, memory, runStore, artifacts, events, config };
  return { repo, runner, git, memory, runStore, artifacts, events, engine: new Engine(repo, deps) };
}

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------- tests

describe("orchestration engine", () => {
  it("drives INTAKE → COMPLETE with persisted transitions (happy path)", async () => {
    const h = await makeHarness(happyScript);
    const state = await h.engine.start("Add a greeting endpoint");
    assert.equal(state.state, "COMPLETE");

    // Exact full state history sequence.
    assert.deepEqual(
      state.history.map((entry) => entry.state),
      [...EXPECTED_HAPPY_HISTORY],
    );

    // Every transition was persisted BEFORE the next action began.
    EXPECTED_HAPPY_HISTORY.forEach((name, index) => {
      const save = h.runStore.saves.find(
        (s) => s.history.length === index + 1 && s.state === name,
      );
      assert.ok(save, `transition to ${name} was persisted`);
    });
    const lengths = h.runStore.saves.map((s) => s.history.length);
    for (let i = 1; i < lengths.length; i += 1) {
      assert.ok(lengths[i]! >= lengths[i - 1]!, "saves never rewind history");
    }
    // One transition event per edge, plus the run creation.
    assert.equal(h.events.of("transition").length, EXPECTED_HAPPY_HISTORY.length - 1);
    assert.equal(h.events.of("run_created").length, 1);

    // Agents ran exactly once in their assigned contexts.
    for (const role of ["researcher", "planner", "developer", "testWriter", "testRunner", "committer"] as const) {
      assert.equal(h.runner.count(role), 1, `${role} ran once`);
    }
    assert.equal(h.runner.count("reviewer"), 2); // review gate + documentation update

    // Commit + evidence + memory promotion.
    assert.equal(h.git.commitCalls.length, 1);
    assert.equal(h.git.commitCalls[0]!.baseBranch, "main");
    // Message policy: advised subject line + deterministic body (never the
    // committer's paragraph verbatim).
    const message = h.git.commitCalls[0]!.message;
    assert.ok(message.startsWith("feat: add greeting endpoint"), `subject must lead: ${message}`);
    assert.ok(!message.includes("\n") || message.split("\n")[0]!.length <= 72, "subject ≤ 72 chars");
    assert.ok(message.includes("Produced by gx-dev run"), "body must carry the run id");
    assert.ok(message.includes("Advised-by: gx-dev committer"), "body must credit the advisor");
    const resultArtifact = h.artifacts.readArtifact("result.md") ?? "";
    assert.match(resultArtifact, /deadbeef1234567890/);
    assert.match(resultArtifact, /git revert deadbeef1234567890/);
    assert.match(resultArtifact, /Add a greeting endpoint/);
    for (const name of ["research.md", "requirements.md", "plan.md", "test-plan.md", "verification.json", "implementation.md", "tests.md"]) {
      assert.ok(h.artifacts.readArtifact(name) !== null, `${name} artifact written`);
    }
    assert.ok(h.git.integrateCount >= 1);
    assert.equal(h.memory.promoted.length, 1);
    const proposal = h.memory.promoted[0]![0]!;
    assert.equal(proposal.scope, "feature");
    assert.equal(proposal.verification, "verified");
    assert.equal(proposal.provenance[0], state.runId);
    assert.equal(proposal.provenance[1], "deadbeef1234567890");
    assert.equal(h.runner.count("developer"), 1);
    assert.equal(h.runner.count("testWriter"), 1);
  });

  it("parks on a material question without a UI, then answer() continues to COMPLETE", async () => {
    const materialQuestion: AgentQuestion[] = [
      {
        question: "Should the public API be synchronous or async? This is an API-breaking decision.",
        severity: "material",
        context: ["affects every caller"],
      },
    ];
    const h = await makeHarness((role, task, call) => {
      if (role === "researcher") {
        return agentResult(role, researcherCompletion(materialQuestion));
      }
      return happyScript(role, task, call);
    });
    const parked = await h.engine.start("Add a greeting endpoint");
    assert.equal(parked.state, "WAITING_FOR_USER");
    assert.equal(parked.resumeState, "REQUIREMENTS_APPROVAL");
    assert.ok(parked.pendingQuestion);
    assert.equal(parked.pendingQuestion!.severity, "material");
    assert.deepEqual(
      parked.history.map((e) => e.state),
      ["INTAKE", "RESEARCH", "REQUIREMENTS_APPROVAL", "WAITING_FOR_USER"],
    );

    const final = await h.engine.answer("Keep the API synchronous for v1");
    assert.equal(final.state, "COMPLETE");
    assert.equal(final.pendingQuestion, null);
    assert.ok(final.history.some((e) => e.state === "COMPLETE"));

    // The answer was recorded as evidence and on the parked state.
    const savedAnswer = h.runStore.saves.find(
      (s) => s.pendingQuestion !== null && s.pendingQuestion.answers.length > 0,
    );
    assert.ok(savedAnswer);
    assert.equal(savedAnswer!.pendingQuestion!.answers[0]!.answer, "Keep the API synchronous for v1");
    assert.ok(h.artifacts.evidence().some((e) => e.source === "user" && e.name.startsWith("answer-")));

    // answer() outside WAITING_FOR_USER is rejected.
    await assert.rejects(
      () => h.engine.answer("too late"),
      /only valid while WAITING_FOR_USER/,
    );
  });

  it("routes a test-gate failure to the developer only; a pass resets the counter", async () => {
    const h = await makeHarness(flakyTestGateScript(1));
    const state = await h.engine.start("Add a greeting endpoint");
    assert.equal(state.state, "COMPLETE");

    assert.equal(h.runner.count("developer"), 2, "developer reworked once");
    assert.equal(h.runner.count("testWriter"), 1, "test writer untouched");
    // The rework prompt carried the gate failure feedback.
    assert.match(h.runner.prompts("developer")[1] ?? "", /exit 1/);

    assert.equal(state.counters.testConsecutiveFailures, 0, "pass reset its own counter");
    // 2 test attempts + 1 review attempt = 3 total attempts.
    assert.equal(state.counters.totalAttempts, 3);
    const gateStates = state.history.filter((e) => e.state === "TEST_GATE");
    assert.equal(gateStates.length, 2, "test gate ran twice");
    assert.equal(h.events.of("gate_failed").length, 1);
  });

  it("replans after 5 consecutive test failures with the full failure history", async () => {
    const h = await makeHarness(flakyTestGateScript(5));
    const state = await h.engine.start("Add a greeting endpoint");
    assert.equal(state.state, "COMPLETE");
    assert.ok(state.history.some((e) => e.state === "REPLAN"));

    // The planner ran exactly twice: initial plan + replan.
    assert.equal(h.runner.count("planner"), 2);
    const replanPrompt = h.runner.prompts("planner")[1] ?? "";
    for (let i = 1; i <= 5; i += 1) {
      assert.match(replanPrompt, new RegExp(`## Attempt ${i} `), `history attempt ${i} in planner prompt`);
    }
    assert.match(replanPrompt, /inputHash/);

    // failure-history.md contains all five attempts (causal history retained).
    const history = h.artifacts.readArtifact("failure-history.md") ?? "";
    assert.equal((history.match(/## Attempt /g) ?? []).length, 5);

    // The worktrees were reused after replanning (no re-prepare).
    assert.equal(h.git.prepareCalls.length, 1);
    assert.equal(h.runner.count("testRunner"), 6);
  });

  it("hard-fails the run when maxTotalAttempts is reached", async () => {
    const h = await makeHarness(flakyTestGateScript(Number.MAX_SAFE_INTEGER), (c) => {
      c.gates.maxTotalAttempts = 3;
      c.gates.maxConsecutiveFailures = 10;
    });
    const state = await h.engine.start("Add a greeting endpoint");
    assert.equal(state.state, "FAILED");
    assert.ok(!state.history.some((e) => e.state === "REPLAN"));
    assert.equal(state.counters.totalAttempts, 3);
    assert.equal(state.counters.testConsecutiveFailures, 3);
    assert.equal(h.runner.count("developer"), 3); // initial + rework after failures 1 and 2
    assert.equal(h.events.of("gate_failed").length, 3);
  });

  it("cancel from DEVELOP → CANCELLED and cleanup when retainFailedRuns=false", async () => {
    let releaseDeveloper: (result: AgentRunResult) => void = () => {};
    const held = new Promise<AgentRunResult>((resolve) => {
      releaseDeveloper = resolve;
    });
    const h = await makeHarness((role, task, call) => {
      if (role === "developer" && call === 1) return held;
      return happyScript(role, task, call);
    }, (c) => {
      c.git.retainFailedRuns = false;
    });

    const done = h.engine.start("Add a greeting endpoint");
    await waitFor(() => h.runner.count("developer") > 0);
    const fromState = h.engine.status()!.state;
    assert.ok(
      fromState === "DEVELOP" || fromState === "WRITE_TESTS",
      `cancel happened mid-development (state was ${fromState})`,
    );

    const cancelled = await h.engine.cancel();
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(cancelled.history[cancelled.history.length - 1]!.state, "CANCELLED");
    assert.equal(h.git.cleaned.length, 1, "worktrees cleaned up");
    assert.equal(h.git.commitCalls.length, 0, "nothing was committed");

    releaseDeveloper(agentResult("developer", developerCompletionJson(), { rawText: DEV_RAW }));
    const state = await done;
    assert.equal(state.state, "CANCELLED");
    assert.equal(h.engine.status()?.state, "CANCELLED");
  });
});
