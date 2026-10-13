/**
 * Integration tests (PLAN §17): full engine workflow over the fake-agent
 * harness with REAL FsRunStore / FsArtifactStore / events.jsonl persistence
 * and a REAL GitWorktreeManager underneath the recording fake.
 *
 * Covers: happy path to COMPLETE with persisted history, events, evidence and
 * memory promotion; WAITING_FOR_USER parking + explicit answers at every
 * mandatory checkpoint; restart recovery via a second Engine over the same run
 * store — including the REVIEW P0 rule that resume() never skips an
 * unanswered question; COMMIT crash reconciliation (crash before the apply,
 * crash between merge and receipt, crash after the receipt — the applied
 * commit is recognized via the persisted intent's exact staging tree, the
 * run-id trailer, and ancestry, then verified and advanced WITHOUT
 * re-applying; ambiguity blocks); cancellation.
 *
 * Engine semantics these tests encode (from orchestration/engine.ts):
 *  - start() resolves to the final RunState;
 *  - requirements and plan approvals are MANDATORY: without a UI the run
 *    parks in WAITING_FOR_USER at every checkpoint (resumeState = the current
 *    pipeline state); blank answers never resolve a question;
 *  - answer() records the answer durably and continues from the resume state;
 *  - resume(runId) on a fresh Engine recovers a persisted run, hydrates the
 *    execution context, and continues — but never advances an unanswered
 *    question;
 *  - the reviewer agent runs three times on the happy path (review gate,
 *    documentation update, memory-proposal review), so a happy run emits
 *    agent-output evidence covering all 7 roles.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRole } from "../../extensions/gx-dev/domain/schemas.ts";
import type { PlannerCompletion } from "../../extensions/gx-dev/domain/schemas.ts";
import type { RunState } from "../../extensions/gx-dev/domain/state.ts";
import {
  scanForAppliedCommit,
  verifyCommitReceipt,
} from "../../extensions/gx-dev/orchestration/recovery.ts";
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

/** Runs git in a directory, asserting success (test-side inspection). */
function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Tears down two engine harnesses over one fixture repo. */
function teardownBoth(
  repoPath: string,
  first: ReturnType<typeof makeEngineBits> | null,
  second: ReturnType<typeof makeEngineBits> | null,
): void {
  first?.stores.removePlaceholderDirs();
  second?.stores.removePlaceholderDirs();
  first?.git.removeTempDirs();
  second?.git.removeTempDirs();
  rmSync(repoPath, { recursive: true, force: true });
}

/** Planner completion that stays "complete" but asks a material question. */
function plannerWithMaterialQuestion(question: string): FakeScript {
  return (role: AgentRole, _task: string, call: number) => {
    if (role === "planner" && call === 1) {
      const planner = defaultCompletion("planner") as PlannerCompletion;
      planner.questions = [
        {
          question,
          severity: "material",
          context: ["The request does not specify the desired tone."],
        },
      ];
      return { completion: planner };
    }
    return undefined;
  };
}

test("happy path: engine drives all seven roles to COMPLETE with persisted history, events, evidence, and memory promotion", async () => {
  const repoPath = await makeFixtureRepo();
  let bits: ReturnType<typeof makeEngineBits> | null = null;
  try {
    bits = makeEngineBits(repoPath, { autoApprove: true });
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
    // (the reviewer runs three times: review gate + docs + memory review).
    const evidenceDir = join(runDirOf(repoPath, state), "evidence", "agent-output");
    assert.ok(existsSync(evidenceDir), `agent-output evidence dir must exist at ${evidenceDir}`);
    const evidenceFiles = readdirSync(evidenceDir).filter((f) => !f.startsWith("."));
    assert.ok(
      evidenceFiles.length >= 7,
      `expected >= 7 agent-output evidence files, got: ${evidenceFiles.length}`,
    );
    // Content-addressed names look like `<role>-<seq>-<sha256>.md`.
    const coveredRoles = new Set(
      evidenceFiles
        .map((f) => f.replace(/-\d+-[0-9a-f]{64}\.md$/, ""))
        .filter((name): name is AgentRole => ALL_ROLES.includes(name as AgentRole)),
    );
    for (const role of ALL_ROLES) {
      assert.ok(coveredRoles.has(role), `evidence must include an agent-output file for ${role}`);
    }

    // Memory promotion happened at least once, reviewed and lint-checked.
    assert.ok(
      bits?.memory.promoted.length >= 1,
      "memory.promote must be called at least once before COMPLETE",
    );
    assert.ok(
      bits?.memory.lintChecked.length >= 1,
      "memory.lintProposals must be consulted before promotion",
    );
  } finally {
    bits?.stores.removePlaceholderDirs();
    bits?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("material planner question parks in WAITING_FOR_USER; explicit answers (question + approval) complete the run; answers flow downstream", async () => {
  const repoPath = await makeFixtureRepo();
  let bits: ReturnType<typeof makeEngineBits> | null = null;
  try {
    bits = makeEngineBits(repoPath, { script: plannerWithMaterialQuestion("Should farewell() be formal or casual?") });

    // Without a UI the run parks at the MANDATORY requirements approval first.
    const requirements = asRunState(await bits.engine.start(REQUEST));
    assert.equal(requirements.state, "WAITING_FOR_USER");
    assert.equal(requirements.pendingQuestion?.kind, "approval");
    assert.equal(requirements.pendingQuestion?.checkpoint, "requirements");

    // Approve requirements -> the planner's material question parks next.
    const state = asRunState(await bits.engine.answer("approve"));
    assert.equal(state.state, "WAITING_FOR_USER", "material question must park the run");
    assert.ok(state.pendingQuestion !== null, "pendingQuestion must be recorded");
    assert.equal(state.pendingQuestion?.severity, "material");
    assert.equal(state.pendingQuestion?.kind, "material-question");
    assert.equal(state.pendingQuestion?.checkpoint, "plan");
    assert.equal(state.resumeState, "PLAN_APPROVAL", "resume target must be the plan checkpoint");

    // Answer the question -> the MANDATORY plan approval parks next.
    const approval = asRunState(await bits.engine.answer("keep it formal"));
    assert.equal(approval.state, "WAITING_FOR_USER", "plan approval must park (no UI)");
    assert.equal(approval.pendingQuestion?.kind, "approval");
    assert.equal(approval.pendingQuestion?.checkpoint, "plan");

    const done = asRunState(await bits.engine.answer("approve"));
    assert.equal(done.state, "COMPLETE", `expected COMPLETE after answers, got: ${done.state}`);
    const states = done.history.map((h) => h.state);
    assert.ok(states.includes("WAITING_FOR_USER"), "history must record the wait");
    assert.ok(
      states.indexOf("COMPLETE") > states.indexOf("WAITING_FOR_USER"),
      "COMPLETE must come after the resolved wait",
    );
    const persisted = await bits.runs.load(state.runId);
    assert.ok(persisted !== null && persisted.state === "COMPLETE");

    // The question's answer flowed into downstream worker prompts.
    const developerTask = bits.agents.invocations.find((i) => i.role === "developer")?.task ?? "";
    assert.match(developerTask, /keep it formal/, "user answer must reach the developer prompt");
  } finally {
    bits?.stores.removePlaceholderDirs();
    bits?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("restart recovery: resume() never skips an unanswered question; hydration completes the run without re-planning", async () => {
  const repoPath = await makeFixtureRepo();
  let first: ReturnType<typeof makeEngineBits> | null = null;
  let second: ReturnType<typeof makeEngineBits> | null = null;
  try {
    first = makeEngineBits(repoPath, {
      script: plannerWithMaterialQuestion("Proceed with option A or B for farewell()?"),
    });
    // Park at the mandatory requirements approval, then answer it; the
    // planner's material question parks next.
    const requirements = asRunState(await first.engine.start(REQUEST));
    assert.equal(requirements.state, "WAITING_FOR_USER");
    const parked = asRunState(await first.engine.answer("approve"));
    assert.equal(parked.state, "WAITING_FOR_USER");
    assert.equal(parked.pendingQuestion?.kind, "material-question");
    const runId = parked.runId;
    const parkedHistory = (await first.runs.load(runId))?.history.length ?? 0;

    // A SECOND Engine (fresh fakes, no UI) over the same repo / run store /
    // run dir. Resuming a run parked on an UNANSWERED question must not
    // advance it (REVIEW P0: resume never means approval).
    second = makeEngineBits(repoPath, { attachRunId: runId });
    const refused = asRunState(await second.engine.resume(runId));
    assert.equal(
      refused.state,
      "WAITING_FOR_USER",
      "resume must not skip the unanswered question",
    );
    assert.equal(
      (await second.runs.load(runId))?.history.length,
      parkedHistory,
      "an unanswered question keeps the persisted history unchanged",
    );

    // Answer the material question on the new engine: the mandatory plan
    // approval parks next (also on the recovered engine).
    const approval = asRunState(await second.engine.answer("option A"));
    assert.equal(approval.state, "WAITING_FOR_USER");
    assert.equal(approval.pendingQuestion?.kind, "approval");

    const resumed = asRunState(await second.engine.answer("approve"));
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

    // The execution context was hydrated: the recovered engine continued with
    // the ORIGINAL plan instead of invoking the planner again.
    assert.equal(
      second.agents.count("planner"),
      0,
      "the recovered engine must not re-run the planner (durable plan context)",
    );
    assert.ok(
      second.agents.count("developer") >= 1,
      "the recovered engine ran the workers with hydrated plan tasks",
    );
  } finally {
    first?.stores.removePlaceholderDirs();
    second?.stores.removePlaceholderDirs();
    first?.git.removeTempDirs();
    second?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("cancel from WAITING_FOR_USER lands in CANCELLED, is persisted, and releases memory reservations", async () => {
  const repoPath = await makeFixtureRepo();
  let bits: ReturnType<typeof makeEngineBits> | null = null;
  try {
    bits = makeEngineBits(repoPath, {
      script: plannerWithMaterialQuestion("Proceed with option A or B?"),
    });
    const requirements = asRunState(await bits.engine.start(REQUEST));
    assert.equal(requirements.state, "WAITING_FOR_USER");
    const state = asRunState(await bits.engine.answer("approve"));
    assert.equal(state.state, "WAITING_FOR_USER");

    const cancelled = asRunState(await bits.engine.cancel());
    assert.equal(cancelled.state, "CANCELLED", "cancel from WAITING_FOR_USER must be terminal");

    const persisted = await bits.runs.load(cancelled.runId);
    assert.ok(persisted !== null, "cancelled run must be persisted");
    assert.equal(persisted.state, "CANCELLED");
    assert.ok(
      bits.memory.released.includes(cancelled.runId),
      "cancellation must release the run's memory reservation claims",
    );
  } finally {
    bits?.stores.removePlaceholderDirs();
    bits?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

// ------------------------------------------------ COMMIT crash reconciliation

test("crash BEFORE the apply (intent persisted, merge never landed): resume applies exactly once and completes", async () => {
  const repoPath = await makeFixtureRepo();
  let first: ReturnType<typeof makeEngineBits> | null = null;
  let second: ReturnType<typeof makeEngineBits> | null = null;
  try {
    first = makeEngineBits(repoPath, { autoApprove: true });
    // Sabotage ONLY the final apply: it throws before any git side effect.
    first.git.commitStaged = async () => {
      throw new Error("simulated crash before the apply");
    };
    const blockedState = asRunState(await first.engine.start(REQUEST));
    assert.equal(blockedState.state, "BLOCKED");
    const runId = blockedState.runId;

    // The apply intent was persisted BEFORE the merge was attempted.
    const crashed = await first.runs.load(runId);
    const intent = crashed?.execution?.commitIntent;
    assert.ok(intent, "the apply intent is durable before the apply");
    assert.equal(intent?.baseBranch, "main");
    assert.match(intent?.baseHead ?? "", /^[0-9a-f]{40}$/);
    assert.match(intent?.stagingTree ?? "", /^[0-9a-f]{40}$/);
    assert.match(intent?.message ?? "", new RegExp(`gx-dev run ${runId}`));
    assert.equal(crashed?.execution?.commitHash ?? null, null, "no receipt exists");
    assert.equal(gitIn(repoPath, ["rev-parse", "HEAD"]), intent?.baseHead, "the merge never landed");

    // A second engine recovers: nothing applied → it proceeds and applies once.
    second = makeEngineBits(repoPath, { attachRunId: runId, autoApprove: true });
    const resumed = asRunState(await second.engine.resume(runId));
    assert.equal(resumed.state, "COMPLETE", `recovered run completes, got ${resumed.state}`);
    assert.equal(second.git.callsOf("commitStaged").length, 1, "applied exactly once");

    const head = gitIn(repoPath, ["rev-parse", "HEAD"]);
    const message = gitIn(repoPath, ["log", "-1", "--format=%B"]);
    assert.match(message, new RegExp(`gx-dev run ${runId}`), "the applied commit carries the run trailer");
    const resultMd = second.stores.artifacts.readArtifact("result.md") ?? "";
    assert.match(resultMd, new RegExp(`commit: ${head}`));
    const receipted = (await second.runs.load(runId))?.execution?.commitHash ?? "";
    assert.equal(receipted, head, "the durable receipt matches HEAD");
  } finally {
    teardownBoth(repoPath, first, second);
  }
});

test("crash AFTER the merge but BEFORE the receipt: resume reconciles the applied commit without re-applying", async () => {
  const repoPath = await makeFixtureRepo();
  let first: ReturnType<typeof makeEngineBits> | null = null;
  let second: ReturnType<typeof makeEngineBits> | null = null;
  try {
    first = makeEngineBits(repoPath, { autoApprove: true });
    // The merge lands, THEN the process dies before the receipt persists.
    const realCommitStaged = first.git.commitStaged.bind(first.git);
    first.git.commitStaged = async (handles, message, baseBranch) => {
      const result = await realCommitStaged(handles, message, baseBranch);
      void result;
      throw new Error("simulated crash after the merge, before the receipt");
    };
    const blockedState = asRunState(await first.engine.start(REQUEST));
    assert.equal(blockedState.state, "BLOCKED");
    const runId = blockedState.runId;

    const headAfterCrash = gitIn(repoPath, ["rev-parse", "HEAD"]);
    assert.notEqual(headAfterCrash, (await first.runs.load(runId))?.base?.commit, "the merge DID land");
    const crashed = await first.runs.load(runId);
    assert.equal(crashed?.execution?.commitHash ?? null, null, "the receipt was lost");
    assert.ok(crashed?.execution?.commitIntent, "the intent survived");
    assert.equal(
      crashed?.execution?.commitIntent?.stagingTree,
      gitIn(repoPath, ["rev-parse", `${headAfterCrash}^{tree}`]),
      "the applied merge has exactly the intent's staging tree",
    );

    second = makeEngineBits(repoPath, { attachRunId: runId, autoApprove: true });
    const resumed = asRunState(await second.engine.resume(runId));
    assert.equal(resumed.state, "COMPLETE", `reconciled run completes, got ${resumed.state}`);
    assert.equal(
      second.git.callsOf("commitStaged").length,
      0,
      "the applied commit was RECOGNIZED, never re-applied",
    );
    assert.equal(
      gitIn(repoPath, ["rev-parse", "HEAD"]),
      headAfterCrash,
      "reconciliation did not move HEAD",
    );
    assert.equal(second.agents.count("committer"), 0, "no phase work was re-run");

    const resultMd = second.stores.artifacts.readArtifact("result.md") ?? "";
    assert.match(resultMd, new RegExp(`commit: ${headAfterCrash}`));
    assert.match(resultMd, /git revert/, "reconciliation still generates rollback guidance");
    const persisted = await second.runs.load(runId);
    assert.equal(persisted?.execution?.commitHash, headAfterCrash, "the receipt was rebuilt durably");
    const reconciliation = persisted?.history.map((h) => h.state) ?? [];
    assert.ok(reconciliation.includes("COMMIT"), "the run re-entered COMMIT through recovery");
  } finally {
    teardownBoth(repoPath, first, second);
  }
});

test("crash AFTER the receipt: resume verifies the receipt against branch/trailer/tree and advances without re-applying", async () => {
  const repoPath = await makeFixtureRepo();
  let first: ReturnType<typeof makeEngineBits> | null = null;
  let second: ReturnType<typeof makeEngineBits> | null = null;
  try {
    first = makeEngineBits(repoPath, { autoApprove: true });
    // Same crash window as above, but this time the receipt was already
    // persisted when the process died (crash between receipt and transition).
    const realCommitStaged = first.git.commitStaged.bind(first.git);
    first.git.commitStaged = async (handles, message, baseBranch) => {
      const result = await realCommitStaged(handles, message, baseBranch);
      void result;
      throw new Error("simulated crash after the receipt");
    };
    const blockedState = asRunState(await first.engine.start(REQUEST));
    assert.equal(blockedState.state, "BLOCKED");
    const runId = blockedState.runId;
    const headAfterCrash = gitIn(repoPath, ["rev-parse", "HEAD"]);

    // Persist the receipt by hand (exactly what the engine does right after
    // the apply returns) so the resumed engine takes the verify path.
    const crashed = await first.runs.load(runId);
    assert.ok(crashed !== null);
    crashed.execution = { ...crashed.execution, commitHash: headAfterCrash };
    await first.runs.save(crashed);

    second = makeEngineBits(repoPath, { attachRunId: runId, autoApprove: true });
    const resumed = asRunState(await second.engine.resume(runId));
    assert.equal(resumed.state, "COMPLETE", `receipt verified and advanced, got ${resumed.state}`);
    assert.equal(second.git.callsOf("commitStaged").length, 0, "nothing was re-applied");
    assert.equal(gitIn(repoPath, ["rev-parse", "HEAD"]), headAfterCrash, "HEAD unchanged");
    const resultMd = second.stores.artifacts.readArtifact("result.md") ?? "";
    assert.match(resultMd, new RegExp(`commit: ${headAfterCrash}`));
  } finally {
    teardownBoth(repoPath, first, second);
  }
});

test("ambiguous applied commits (identical tree + trailer twice) BLOCK reconciliation; nothing is overwritten", async () => {
  const repoPath = await makeFixtureRepo();
  let first: ReturnType<typeof makeEngineBits> | null = null;
  let second: ReturnType<typeof makeEngineBits> | null = null;
  try {
    first = makeEngineBits(repoPath, { autoApprove: true });
    // Crash between the merge and the receipt (as above).
    const realCommitStaged = first.git.commitStaged.bind(first.git);
    first.git.commitStaged = async (handles, message, baseBranch) => {
      const result = await realCommitStaged(handles, message, baseBranch);
      void result;
      throw new Error("simulated crash after the merge, before the receipt");
    };
    const blockedState = asRunState(await first.engine.start(REQUEST));
    assert.equal(blockedState.state, "BLOCKED");
    const runId = blockedState.runId;

    // Forge a SECOND commit carrying the SAME tree and the same run-id
    // trailer (as a sloppy manual recovery attempt would): recognition is now
    // ambiguous and must BLOCK — the engine never guesses, never overwrites.
    const headAfterCrash = gitIn(repoPath, ["rev-parse", "HEAD"]);
    const message = gitIn(repoPath, ["log", "-1", "--format=%B"]);
    const forged = execFileSync(
      "git",
      ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", message],
      {
        cwd: repoPath,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "gx-dev-test",
          GIT_AUTHOR_EMAIL: "test@gx-dev.invalid",
          GIT_COMMITTER_NAME: "gx-dev-test",
          GIT_COMMITTER_EMAIL: "test@gx-dev.invalid",
        },
      },
    ).trim();
    gitIn(repoPath, ["reset", "--hard", forged]);
    assert.equal(gitIn(repoPath, ["rev-parse", "HEAD"]), forged);

    second = makeEngineBits(repoPath, { attachRunId: runId, autoApprove: true });
    const resumed = asRunState(await second.engine.resume(runId));
    assert.equal(resumed.state, "BLOCKED", "ambiguity must block, never guess");
    assert.equal(second.git.callsOf("commitStaged").length, 0, "nothing was applied or overwritten");
    assert.equal(gitIn(repoPath, ["rev-parse", "HEAD"]), forged, "the repository was left untouched");
    const ambiguousEvent = second.stores.events.events().find(
      (e) => e.type === "error" && /ambiguous applied commits/.test(e.message),
    );
    assert.ok(ambiguousEvent !== undefined, "the ambiguity is recorded as a blocking error");
    assert.match(ambiguousEvent?.message ?? "", /manual resolution required/);
  } finally {
    teardownBoth(repoPath, first, second);
  }
});

test("commit reconciliation recognition: exact tree + run-id trailer + ancestry; ambiguity must block", () => {
  const sha = (c: string) => c.repeat(40);
  const tree = "t".repeat(40);
  const otherTree = "o".repeat(40);
  const base = sha("b");
  const trailer = "gx-dev run run-abc";
  const mergeMessage = `feat: greet\n\nProduced by ${trailer}.\nEvidence: .gx-dev/runs/run-abc/`;

  // Exactly one matching candidate → applied merge commit.
  const applied = scanForAppliedCommit(
    [{ sha: sha("1"), tree, parents: [base, sha("9")], message: mergeMessage, baseIsAncestor: true }],
    { runIdTrailer: trailer, stagingTree: tree },
  );
  assert.deepEqual(applied, { kind: "applied", sha: sha("1"), mergeCommit: true });

  // Same commit without the trailer / with a different tree / without
  // ancestry → never recognized.
  assert.equal(
    scanForAppliedCommit(
      [{ sha: sha("1"), tree, parents: [base], message: "unrelated commit", baseIsAncestor: true }],
      { runIdTrailer: trailer, stagingTree: tree },
    ).kind,
    "none",
    "missing trailer",
  );
  assert.equal(
    scanForAppliedCommit(
      [{ sha: sha("1"), tree: otherTree, parents: [base], message: mergeMessage, baseIsAncestor: true }],
      { runIdTrailer: trailer, stagingTree: tree },
    ).kind,
    "none",
    "tree mismatch",
  );
  assert.equal(
    scanForAppliedCommit(
      [{ sha: sha("1"), tree, parents: [base], message: mergeMessage, baseIsAncestor: false }],
      { runIdTrailer: trailer, stagingTree: tree },
    ).kind,
    "none",
    "not descended from the recorded base",
  );

  // Two matches (e.g. the merge applied twice after a reset) are AMBIGUOUS:
  // the engine must block, never guess and never overwrite.
  const ambiguous = scanForAppliedCommit(
    [
      { sha: sha("1"), tree, parents: [base, sha("9")], message: mergeMessage, baseIsAncestor: true },
      { sha: sha("2"), tree, parents: [sha("1")], message: mergeMessage, baseIsAncestor: true },
    ],
    { runIdTrailer: trailer, stagingTree: tree },
  );
  assert.deepEqual(ambiguous, { kind: "ambiguous", shas: [sha("1"), sha("2")] });

  // Receipt verification fails closed on every mismatch dimension.
  const entry = { sha: sha("1"), tree, parents: [base, sha("9")], message: mergeMessage, baseIsAncestor: true };
  assert.equal(verifyCommitReceipt(entry, { receiptedSha: sha("1"), runIdTrailer: trailer, stagingTree: tree, baseBranch: "main" }).ok, true);
  assert.equal(verifyCommitReceipt(null, { receiptedSha: sha("3"), runIdTrailer: trailer, stagingTree: tree, baseBranch: "main" }).ok, false);
  assert.equal(
    verifyCommitReceipt({ ...entry, message: "no trailer here" }, { receiptedSha: sha("1"), runIdTrailer: trailer, stagingTree: tree, baseBranch: "main" }).ok,
    false,
  );
  assert.equal(
    verifyCommitReceipt({ ...entry, tree: otherTree }, { receiptedSha: sha("1"), runIdTrailer: trailer, stagingTree: tree, baseBranch: "main" }).ok,
    false,
    "tree mismatch against the persisted intent fails the receipt",
  );
});
