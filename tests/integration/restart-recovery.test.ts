/**
 * Integration tests (PLAN §17): full engine workflow over the fake-agent
 * harness with REAL FsRunStore / FsArtifactStore / events.jsonl persistence.
 *
 * Covers: happy path to COMPLETE with persisted history, events, evidence and
 * memory promotion; WAITING_FOR_USER parking + answer(); restart recovery via
 * a second Engine over the same run store; cancellation.
 *
 * Engine semantics these tests encode (from orchestration/engine.ts):
 *  - start() resolves to the final RunState;
 *  - without a UI, a material question parks the run in WAITING_FOR_USER
 *    (resumeState = the current pipeline state);
 *  - answer() records the answer and continues from the resume state;
 *  - resume(runId) on a fresh Engine recovers a persisted run and continues;
 *  - the reviewer agent runs twice (review gate + documentation update), so
 *    a happy path emits 8 agent-output evidence files covering all 7 roles.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRole } from "../../extensions/gx-dev/domain/schemas.ts";
import type { PlannerCompletion } from "../../extensions/gx-dev/domain/schemas.ts";
import type { RunState } from "../../extensions/gx-dev/domain/state.ts";
import {
  asRunState,
  defaultCompletion,
  makeEngineBits,
  makeFixtureRepo,
} from "../helpers/fakes.ts";
import type { FakeScript } from "../helpers/fakes.ts";

const REQUEST = "add farewell() to greet module";

const ALL_ROLES: readonly AgentRole[] = [
  "researcher",
  "planner",
  "developer",
  "testWriter",
  "testRunner",
  "reviewer",
  "committer",
];

const REQUIRED_SEQUENCE = [
  "INTAKE",
  "RESEARCH",
  "PLAN",
  "DEVELOP",
  "WRITE_TESTS",
  "INTEGRATE",
  "TEST_GATE",
  "REVIEW_GATE",
  "COMMIT",
  "MEMORY_PROMOTION",
] as const;

function runDirOf(repoPath: string, state: RunState): string {
  return join(repoPath, ".gx-dev", "runs", state.runId);
}

test("happy path: engine drives all seven roles to COMPLETE with persisted history, events, evidence, and memory promotion", async () => {
  const repoPath = await makeFixtureRepo();
  let bits: ReturnType<typeof makeEngineBits> | null = null;
  try {
    bits = makeEngineBits(repoPath);
    const state = asRunState(await bits.engine.start(REQUEST));

    assert.equal(state.state, "COMPLETE", `expected COMPLETE, got: ${state.state}`);

    const status = bits.engine.status();
    assert.ok(status !== null && status !== undefined, "status() must be non-null after start");
    assert.equal(asRunState(status).runId, state.runId);
    assert.equal(asRunState(status).state, "COMPLETE");

    // state.json exists with the full transition history.
    const stateFile = join(runDirOf(repoPath, state), "state.json");
    assert.ok(existsSync(stateFile), `state.json must exist at ${stateFile}`);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
    assert.equal(persisted.runId, state.runId);
    const states = persisted.history.map((h) => h.state);
    for (const required of REQUIRED_SEQUENCE) {
      assert.ok(
        states.includes(required),
        `history must contain ${required}; got: ${states.join(" -> ")}`,
      );
    }

    // events.jsonl: at least one transition event per required state.
    const eventsFile = join(runDirOf(repoPath, state), "events.jsonl");
    assert.ok(existsSync(eventsFile), `events.jsonl must exist at ${eventsFile}`);
    const events = readFileSync(eventsFile, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type: string; message: string; data?: Record<string, unknown> });
    assert.ok(events.length > 0, "events.jsonl must not be empty");
    for (const required of REQUIRED_SEQUENCE) {
      const found = events.some(
        (e) =>
          JSON.stringify(e).includes(`"${required}"`) ||
          (e.message?.includes(required) ?? false),
      );
      assert.ok(found, `events.jsonl needs >=1 event referencing state ${required}`);
    }

    // Evidence: one agent-output file per agent run, covering all seven roles
    // (the reviewer runs twice: review gate + documentation update).
    const evidenceDir = join(runDirOf(repoPath, state), "evidence", "agent-output");
    assert.ok(existsSync(evidenceDir), `agent-output evidence dir must exist at ${evidenceDir}`);
    const evidenceFiles = readdirSync(evidenceDir).filter((f) => !f.startsWith("."));
    assert.ok(
      evidenceFiles.length >= 7,
      `expected >= 7 agent-output evidence files, got: ${evidenceFiles.length}`,
    );
    const coveredRoles = new Set(
      evidenceFiles
        .map((f) => f.replace(/-\d+\.md$/, ""))
        .filter((name): name is AgentRole => ALL_ROLES.includes(name as AgentRole)),
    );
    for (const role of ALL_ROLES) {
      assert.ok(coveredRoles.has(role), `evidence must include an agent-output file for ${role}`);
    }

    // Memory promotion happened at least once.
    assert.ok(
      bits?.memory.promoted.length >= 1,
      "memory.promote must be called at least once before COMPLETE",
    );
  } finally {
    bits?.stores.removePlaceholderDirs();
    bits?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("material planner question parks in WAITING_FOR_USER; answer() on the same engine completes the run", async () => {
  const repoPath = await makeFixtureRepo();
  let bits: ReturnType<typeof makeEngineBits> | null = null;
  try {
    const script: FakeScript = (role: AgentRole, _task: string, call: number) => {
      if (role === "planner" && call === 1) {
        const planner = defaultCompletion("planner") as PlannerCompletion;
        planner.status = "blocked";
        planner.questions = [
          {
            question: "Should farewell() be formal or casual?",
            severity: "material",
            context: ["The request does not specify the desired tone."],
          },
        ];
        return { completion: planner };
      }
      return undefined;
    };

    bits = makeEngineBits(repoPath, { script }); // no UI: material questions park the run
    const state = asRunState(await bits.engine.start(REQUEST));
    assert.equal(state.state, "WAITING_FOR_USER", "material question must park the run");
    assert.ok(state.pendingQuestion !== null, "pendingQuestion must be recorded");
    assert.equal(state.pendingQuestion?.severity, "material");
    assert.equal(state.resumeState, "PLAN_APPROVAL", "resume target must be the plan checkpoint");

    const done = asRunState(await bits.engine.answer("proceed with option A"));
    assert.equal(done.state, "COMPLETE", `expected COMPLETE after answer, got: ${done.state}`);
    const states = done.history.map((h) => h.state);
    assert.ok(states.includes("WAITING_FOR_USER"), "history must record the wait");
    assert.ok(
      states.indexOf("COMPLETE") > states.indexOf("WAITING_FOR_USER"),
      "COMPLETE must come after the resolved wait",
    );
    const persisted = await bits.runs.load(state.runId);
    assert.ok(persisted !== null && persisted.state === "COMPLETE");
  } finally {
    bits?.stores.removePlaceholderDirs();
    bits?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("restart recovery: a second Engine over the same run store resumes the parked run to COMPLETE", async () => {
  const repoPath = await makeFixtureRepo();
  let first: ReturnType<typeof makeEngineBits> | null = null;
  let second: ReturnType<typeof makeEngineBits> | null = null;
  try {
    const script: FakeScript = (role: AgentRole, _task: string, call: number) => {
      if (role === "planner" && call === 1) {
        const planner = defaultCompletion("planner") as PlannerCompletion;
        planner.status = "blocked";
        planner.questions = [
          { question: "Proceed with option A or B for farewell()?", severity: "material" },
        ];
        return { completion: planner };
      }
      return undefined;
    };

    first = makeEngineBits(repoPath, { script });
    const parked = asRunState(await first.engine.start(REQUEST));
    assert.equal(parked.state, "WAITING_FOR_USER");
    const runId = parked.runId;

    // A SECOND Engine (fresh fakes, no UI) over the same repo / run store /
    // run dir. Its persistence must attach to the existing run directory.
    second = makeEngineBits(repoPath, { attachRunId: runId });
    const resumed = asRunState(await second.engine.resume(runId));
    assert.equal(
      resumed.state,
      "COMPLETE",
      `resume of the recovered run must drive to COMPLETE, got: ${resumed.state}`,
    );
    const states = resumed.history.map((h) => h.state);
    assert.ok(states.includes("WAITING_FOR_USER"), "recovered history keeps the wait");
    assert.ok(
      states.indexOf("WAITING_FOR_USER") < states.indexOf("COMPLETE"),
      "COMPLETE must come after the recovered wait",
    );

    // The second engine's persistence landed in the original run dir.
    const stateFile = join(runDirOf(repoPath, resumed), "state.json");
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as RunState;
    assert.equal(persisted.state, "COMPLETE");
    assert.ok(second.memory.promoted.length >= 1, "resumed engine promoted memory");
  } finally {
    first?.stores.removePlaceholderDirs();
    second?.stores.removePlaceholderDirs();
    first?.git.removeTempDirs();
    second?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("cancel from WAITING_FOR_USER lands in CANCELLED and is persisted", async () => {
  const repoPath = await makeFixtureRepo();
  let bits: ReturnType<typeof makeEngineBits> | null = null;
  try {
    const script: FakeScript = (role: AgentRole, _task: string, call: number) => {
      if (role === "planner" && call === 1) {
        const planner = defaultCompletion("planner") as PlannerCompletion;
        planner.status = "blocked";
        planner.questions = [
          { question: "Proceed with option A or B?", severity: "material" },
        ];
        return { completion: planner };
      }
      return undefined;
    };

    bits = makeEngineBits(repoPath, { script });
    const state = asRunState(await bits.engine.start(REQUEST));
    assert.equal(state.state, "WAITING_FOR_USER");

    const cancelled = asRunState(await bits.engine.cancel());
    assert.equal(cancelled.state, "CANCELLED", "cancel from WAITING_FOR_USER must be terminal");

    const persisted = await bits.runs.load(cancelled.runId);
    assert.ok(persisted !== null, "cancelled run must be persisted");
    assert.equal(persisted.state, "CANCELLED");
  } finally {
    bits?.stores.removePlaceholderDirs();
    bits?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});
