/**
 * Unit tests for the gx-dev orchestration engine (PLAN §5, §7, §9).
 *
 * The REAL Engine runs over the shared harness (tests/helpers/fakes.ts): real
 * GitWorktreeManager git operations, real persistence, real gates, and fake
 * agents that write their promised deliverables into their real worktree cwds
 * (REVIEW §5: fake completions alone are not delivery evidence).
 *
 * Positive cases use the explicit auto-approval UI — mandatory approvals are
 * part of the contract, so a no-UI run parks at every checkpoint instead of
 * advancing. Approval decisions bind to unique question instances plus the
 * artifact hash shown at ask time; an edit amends the artifact and the
 * amended revision is ASKED AGAIN for explicit approval (never auto-approves).
 * The final commit carries the run-id trailer (crash reconciliation) and an
 * unpinned Advised-by line (the served model is recorded, never hardcoded).
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type {
  AgentQuestion,
  ResearcherCompletion,
  TestRunnerCompletion,
} from "../../extensions/gx-dev/domain/schemas.ts";
import type { RunState } from "../../extensions/gx-dev/domain/state.ts";
import { defaultConfig } from "../../extensions/gx-dev/config.ts";
import {
  asRunState,
  defaultCompletion,
  makeEngineBits,
  makeFixtureRepo,
} from "../helpers/fakes.ts";
import type { EngineBits, FakeScript } from "../helpers/fakes.ts";

const REQUEST = "extend greet.js with farewell() and shout(), with tests";

// ----------------------------------------------------------------- scripting

function researcherWithQuestion(question: AgentQuestion): ResearcherCompletion {
  const completion = defaultCompletion("researcher") as ResearcherCompletion;
  completion.questions = [question];
  return completion;
}

function blockedTestRunner(
  failure: string,
  owner: "developer" | "both" = "developer",
): TestRunnerCompletion {
  const completion = defaultCompletion("testRunner") as TestRunnerCompletion;
  completion.status = "blocked";
  completion.summary = `test runner blocked: ${failure}`;
  completion.commands = [{ command: "node --test", exitCode: 1 }];
  completion.ownership = [{ failure, owner }];
  return completion;
}

// ------------------------------------------------------------------- helpers

interface Scenario {
  bits: EngineBits;
  repoPath: string;
}

async function withScenario(
  options: Parameters<typeof makeEngineBits>[1],
  run: (s: Scenario) => Promise<void>,
): Promise<void> {
  const repoPath = await makeFixtureRepo();
  let bits: EngineBits | null = null;
  try {
    bits = makeEngineBits(repoPath, options);
    await run({ bits, repoPath });
  } finally {
    bits?.stores.removePlaceholderDirs();
    bits?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Role-prefix evidence names are `<role>-<seq>-<sha256>.md` (content-addressed). */
function evidenceRoles(bits: EngineBits, role: string): number {
  return bits.stores.artifacts
    .evidence()
    .filter((e) => e.kind === "agent-output" && e.name.startsWith(`${role}-`))
    .length;
}

/** UI that answers from a scripted queue (default "approve" when exhausted). */
function queueUI(answers: string[]): import("../../extensions/gx-dev/orchestration/engine.ts").EngineUI {
  const queue = [...answers];
  return {
    askUser: async () => (queue.length > 0 ? (queue.shift() as string) : "approve"),
    notify: () => {},
  };
}

// ---------------------------------------------------------------------- tests

test("happy path: mandatory approvals (auto-approval UI), real diffs, real commit, self-cleanup", async () => {
  await withScenario({ autoApprove: true }, async ({ bits }) => {
    const state = asRunState(await bits.engine.start(REQUEST));
    assert.equal(state.state, "COMPLETE", `expected COMPLETE, got ${state.state}`);

    // Exact history: every checkpoint parked in WAITING_FOR_USER before the
    // approval UI answered it (persisted-before-UI).
    assert.deepEqual(
      state.history.map((h) => h.state),
      [
        "INTAKE",
        "RESEARCH",
        "REQUIREMENTS_APPROVAL",
        "WAITING_FOR_USER",
        "PLAN",
        "PLAN_APPROVAL",
        "WAITING_FOR_USER",
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
      ],
    );

    // Explicit approval decisions are durably recorded with artifact hashes
    // and the unique question instance each decision consumed.
    const persisted = await bits.runs.load(state.runId);
    assert.ok(persisted !== null);
    const decisions = persisted.execution?.decisions ?? [];
    assert.deepEqual(
      decisions.map((d) => `${d.checkpoint}:${d.decision}`),
      ["requirements:approved", "plan:approved"],
    );
    for (const d of decisions) {
      assert.match(d.hash, /^[0-9a-f]{64}$/, "approval binds to an artifact hash");
      assert.match(d.instanceId, /^[0-9a-f-]{36}$/, "each decision cites its question instance");
      assert.equal(d.actedOn, true, "the decision's transition was performed");
      assert.ok(
        persisted.approvals[d.artifact] !== undefined,
        "approval recorded in state.approvals",
      );
    }
    const asks = persisted.execution?.approvalAsks ?? [];
    assert.equal(asks.length, 2, "one ask per approval checkpoint");
    for (const ask of asks) {
      assert.match(ask.instanceId, /^[0-9a-f-]{36}$/);
      assert.match(ask.artifactHash, /^[0-9a-f]{64}$/, "the shown artifact hash is persisted with the ask");
    }

    // Real agents, real deliverables, real git.
    const onceRoles = ["researcher", "planner", "developer", "testWriter", "testRunner", "committer"] as const;
    for (const role of onceRoles) {
      assert.equal(bits.agents.count(role), 1, `${role} ran once`);
    }
    assert.equal(bits.agents.count("reviewer"), 3, "reviewer: review gate + docs + memory review");

    // Evidence diffs are ACTUAL git diffs (no synthetic fallback).
    const developerDiff = bits.stores.artifacts.readArtifact("developer.diff") ?? "";
    const testsDiff = bits.stores.artifacts.readArtifact("tests.diff") ?? "";
    const combined = bits.stores.artifacts.readArtifact("combined.diff") ?? "";
    assert.match(developerDiff, /^diff --git a\/src\/greet\.js b\/src\/greet\.js$/m);
    assert.match(testsDiff, /^diff --git a\/test\/farewell\.test\.js/m);
    assert.match(combined, /^diff --git a\/src\/greet\.js/m);
    assert.match(combined, /^diff --git a\/test\/farewell\.test\.js/m);
    assert.match(
      state.dependencies.stagingRevision ?? "",
      /^[0-9a-f]{40}$/,
      "staging dependency is an authoritative git tree id",
    );

    // The commit really happened on the fixture branch, with the real hash.
    assert.equal(bits.git.callsOf("commitStaged").length, 1);
    const resultMd = bits.stores.artifacts.readArtifact("result.md") ?? "";
    assert.match(resultMd, /commit: [0-9a-f]{40}/);
    assert.match(resultMd, /git revert/);

    // The commit message carries the run-id trailer (crash reconciliation)
    // and an UNPINNED Advised-by line — never a hardcoded model.
    const commitMessage = bits.git.callsOf("commitStaged")[0]!.detail.message as string;
    assert.match(commitMessage, new RegExp(`Produced by gx-dev run ${state.runId}\\.`));
    assert.match(commitMessage, /Evidence: \.gx-dev\/runs\//);
    assert.match(commitMessage, /Advised-by: gx-dev committer agent\./);
    assert.doesNotMatch(commitMessage, /zai\//, "no hardcoded provider/model pin");

    // Reviewed memory promotion with lint and wiki-valid structure.
    assert.equal(bits.memory.promoted.length, 1);
    const proposal = bits.memory.promoted[0]![0]!;
    assert.equal(proposal.page, `features/${state.runId}`);
    assert.equal(proposal.verification, "verified");
    assert.equal(proposal.provenance[0], state.runId);
    assert.match(proposal.provenance[1] ?? "", /^[0-9a-f]{40}$/);
    assert.match(proposal.body, /^## Summary$/m);
    assert.match(proposal.body, /Related: \[\[\w[\w/-]*\]\]/);
    assert.ok(bits.memory.lintChecked.length >= 1, "lintProposals consulted");

    // Successful runs clean their own worktrees.
    const cleanups = bits.git.callsOf("cleanup");
    assert.equal(cleanups.length, 1);
    assert.equal(cleanups[0]!.detail.force, true);

    // Evidence covers every role.
    for (const role of ["researcher", "planner", "developer", "testWriter", "testRunner", "reviewer", "committer"]) {
      assert.ok(evidenceRoles(bits, role) >= 1, `agent-output evidence for ${role}`);
    }
  });
});

test("mandatory approvals without a UI: every checkpoint parks; blank answers never advance; answers flow downstream", async () => {
  await withScenario(
    {
      script: (role, _task, call) => {
        if (role === "researcher" && call === 1) {
          return {
            completion: researcherWithQuestion({
              question: "Should the public API be sync or async? This is an API-breaking decision.",
              severity: "material",
              context: ["affects every caller"],
            }),
          };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const parked = asRunState(await bits.engine.start(REQUEST));
      assert.equal(parked.state, "WAITING_FOR_USER");
      assert.equal(parked.resumeState, "REQUIREMENTS_APPROVAL");
      assert.equal(parked.pendingQuestion?.kind, "material-question");
      assert.equal(parked.pendingQuestion?.severity, "material");
      const runId = parked.runId;

      // The parked state (with the question) was persisted BEFORE any UI.
      const persistedPark = await bits.runs.load(runId);
      assert.equal(persistedPark?.state, "WAITING_FOR_USER");
      assert.ok(persistedPark?.pendingQuestion !== null);

      // Answer the material question -> next checkpoint parks (approval).
      const afterMaterial = asRunState(await bits.engine.answer("Keep the API synchronous"));
      assert.equal(afterMaterial.state, "WAITING_FOR_USER");
      assert.equal(afterMaterial.pendingQuestion?.kind, "approval");
      assert.equal(afterMaterial.pendingQuestion?.checkpoint, "requirements");

      // A blank answer is recorded but the run STAYS waiting.
      const afterBlank = asRunState(await bits.engine.answer(""));
      assert.equal(afterBlank.state, "WAITING_FOR_USER");
      assert.equal(afterBlank.pendingQuestion?.kind, "approval");
      assert.equal(
        (await bits.runs.load(runId))?.state,
        "WAITING_FOR_USER",
        "blank answer must not advance the persisted run",
      );
      // resume() must not skip the unanswered (blank-only) question either.
      const resumed = asRunState(await bits.engine.resume());
      assert.equal(resumed.state, "WAITING_FOR_USER");
      assert.equal(
        resumed.history.length,
        afterBlank.history.length,
        "resume must not advance past an unanswered question",
      );

      // Explicit approval -> plan approval checkpoint parks.
      const afterApproval = asRunState(await bits.engine.answer("approve"));
      assert.equal(afterApproval.state, "WAITING_FOR_USER");
      assert.equal(afterApproval.pendingQuestion?.kind, "approval");
      assert.equal(afterApproval.pendingQuestion?.checkpoint, "plan");

      const done = asRunState(await bits.engine.answer("approve"));
      assert.equal(done.state, "COMPLETE");

      // The material answer reached downstream prompts (the planner at least).
      const plannerPrompt = bits.agents.invocations.find((i) => i.role === "planner")?.task ?? "";
      assert.match(plannerPrompt, /Keep the API synchronous/);

      // Answers were persisted and recorded as user evidence.
      const saved = await bits.runs.load(runId);
      const answers = saved?.execution?.answers ?? [];
      assert.ok(answers.some((a) => a.answer === "Keep the API synchronous"));
      assert.ok(answers.some((a) => a.answer === "approve"));
      assert.ok(
        bits.stores.artifacts.evidence().some((e) => e.source === "user" && e.name.startsWith("answer-")),
      );

      // answer() outside WAITING_FOR_USER is rejected.
      await assert.rejects(() => bits.engine.answer("too late"), /only valid while WAITING_FOR_USER/);
    },
  );
});

test("rejected requirements return to RESEARCH with the user's feedback; the revised draft is asked again", async () => {
  await withScenario(
    {
      // Scripted UI: reject the first requirements draft, approve the rest.
      ui: queueUI(["reject the scope must include error handling for empty names"]),
    },
    async ({ bits }) => {
      const done = asRunState(await bits.engine.start(REQUEST));
      assert.equal(done.state, "COMPLETE");
      assert.ok(bits.agents.count("researcher") >= 2, "researcher re-ran after rejection");

      const researchPrompts = bits.agents.invocations
        .filter((i) => i.role === "researcher")
        .map((i) => i.task);
      assert.match(
        researchPrompts[1] ?? "",
        /REJECTED the previous requirements draft[\s\S]*error handling for empty names/,
        "the revision feedback must reach the researcher prompt",
      );

      const persisted = await bits.runs.load(done.runId);
      const history = persisted?.history.map((h) => h.state) ?? [];
      assert.ok(history.includes("RESEARCH"));
      assert.ok(
        history.filter((s) => s === "REQUIREMENTS_APPROVAL").length >= 2,
        "history shows the rejection loop",
      );
      const rejection = (persisted?.execution?.decisions ?? []).find(
        (d) => d.checkpoint === "requirements" && d.decision === "rejected",
      );
      assert.ok(rejection, "rejection decision recorded durably");
      assert.match(rejection?.feedback ?? "", /error handling for empty names/);
      // The revised draft was approved explicitly (asked again, not inherited).
      assert.ok(
        (persisted?.execution?.decisions ?? []).some(
          (d) => d.checkpoint === "requirements" && d.decision === "approved",
        ),
      );
    },
  );
});

test("an amendment answer edits the requirements artifact; the amended revision is asked again and explicitly approved", async () => {
  const AMENDMENT = "farewell() must accept an optional punctuation argument";
  await withScenario({ ui: queueUI([AMENDMENT]) }, async ({ bits }) => {
    const done = asRunState(await bits.engine.start(REQUEST));
    assert.equal(done.state, "COMPLETE");

    const requirements = bits.stores.artifacts.readArtifact("requirements.md") ?? "";
    assert.match(requirements, /## User amendments/);
    assert.match(requirements, /punctuation argument/);

    // The amendment flowed into the planner prompt via the approved artifact.
    const plannerPrompt = bits.agents.invocations.find((i) => i.role === "planner")?.task ?? "";
    assert.match(plannerPrompt, /punctuation argument/);

    const persisted = await bits.runs.load(done.runId);
    const decisions = persisted?.execution?.decisions ?? [];
    const amended = decisions.find((d) => d.decision === "amended");
    assert.ok(amended, "amendment recorded durably");
    assert.match(amended?.hash ?? "", /^[0-9a-f]{64}$/);

    // An edit NEVER auto-approves: the amended revision is a NEW question
    // instance (with the amended artifact's shown hash) and is explicitly
    // approved before the run proceeds.
    const approved = decisions.find(
      (d) => d.checkpoint === "requirements" && d.decision === "approved",
    );
    assert.ok(approved, "explicit approval of the amended revision recorded");
    assert.notEqual(amended?.instanceId, approved?.instanceId, "the amended revision is a fresh ask");
    assert.equal(approved?.hash, amended?.hash, "the approval binds to the amended artifact hash");
    const reqAsks = (persisted?.execution?.approvalAsks ?? []).filter(
      (a) => a.checkpoint === "requirements",
    );
    assert.ok(reqAsks.length >= 2, "the amendment triggered a re-ask");
    assert.equal(reqAsks.at(-1)?.artifactHash, amended?.hash, "the re-ask showed the amended revision");
    assert.ok(
      (persisted?.execution?.answers ?? []).some((a) => a.answer === AMENDMENT),
      "amendment answer persisted",
    );
  });
});

test("rejected plans route through REPLAN and the planner re-plans with the user's feedback", async () => {
  await withScenario(
    { ui: queueUI(["approve", "reject use a callback-based API for farewell()"]) },
    async ({ bits }) => {
      const done = asRunState(await bits.engine.start(REQUEST));
      assert.equal(done.state, "COMPLETE");

      assert.ok(bits.agents.count("planner") >= 2, "planner re-invoked after plan rejection");
      const replanPrompt = bits.agents.invocations.filter((i) => i.role === "planner")[1]?.task ?? "";
      assert.match(replanPrompt, /REJECTED the previous plan/);
      assert.match(replanPrompt, /callback-based API/);

      const persisted = await bits.runs.load(done.runId);
      const history = persisted?.history.map((h) => h.state) ?? [];
      assert.ok(history.includes("REPLAN"), "history passes through REPLAN");
      const replanIdx = history.indexOf("REPLAN");
      assert.equal(history[replanIdx + 1], "PLAN");
      const rejection = (persisted?.execution?.decisions ?? []).find(
        (d) => d.checkpoint === "plan" && d.decision === "rejected",
      );
      assert.ok(rejection, "plan rejection recorded durably");
    },
  );
});

test("blocked test-runner reports fail the gate and reroute only the developer; a pass resets its counter", async () => {
  let gateFailures = 0;
  await withScenario(
    {
      autoApprove: true,
      script: (role, _task, call) => {
        if (role === "testRunner" && call === 1) {
          gateFailures += 1;
          return { completion: blockedTestRunner("farewell output mismatches the requirements") };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "COMPLETE");

      assert.equal(bits.agents.count("developer"), 2, "developer reworked once");
      assert.equal(bits.agents.count("testWriter"), 1, "test writer untouched");
      const devPrompts = bits.agents.invocations.filter((i) => i.role === "developer");
      assert.match(devPrompts[1]?.task ?? "", /farewell output mismatches/, "gate feedback reached the developer");

      assert.equal(state.counters.testConsecutiveFailures, 0, "pass reset its counter");
      assert.equal(gateFailures, 1);
      const history = state.history.map((h) => h.state);
      assert.equal(history.filter((s) => s === "TEST_GATE").length, 2);
    },
  );
});

test("per-owner feedback survives a developer rerun (test-writer findings are not wiped)", async () => {
  await withScenario(
    {
      autoApprove: true,
      script: (role, _task, call) => {
        if (role === "testRunner" && call === 1) {
          return {
            completion: blockedTestRunner("both sides must coordinate", "both"),
          };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "COMPLETE");
      // Both owners were rerun and each prompt carried the shared finding.
      const devPrompts = bits.agents.invocations.filter((i) => i.role === "developer");
      const twPrompts = bits.agents.invocations.filter((i) => i.role === "testWriter");
      assert.match(devPrompts[1]?.task ?? "", /both sides must coordinate/);
      assert.match(twPrompts[1]?.task ?? "", /both sides must coordinate/);
      assert.equal(bits.agents.count("developer"), 2);
      assert.equal(bits.agents.count("testWriter"), 2);
    },
  );
});

test("five consecutive gate failures escalate to REPLAN with the full failure history", async () => {
  let replanned = false;
  await withScenario(
    {
      autoApprove: true,
      script: (role, _task, call) => {
        if (role === "planner" && call >= 2) {
          replanned = true;
        }
        if (role === "testRunner" && !replanned) {
          return { completion: blockedTestRunner("greet test failed") };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "COMPLETE");

      assert.ok(bits.agents.count("planner") >= 2);
      const replanPrompt = bits.agents.invocations.filter((i) => i.role === "planner")[1]?.task ?? "";
      for (let i = 1; i <= 5; i += 1) {
        assert.match(replanPrompt, new RegExp(`## Attempt ${i} `), `history attempt ${i} in the replan prompt`);
      }
      assert.match(replanPrompt, /inputHash/);

      const history = state.history.map((h) => h.state);
      assert.ok(history.includes("REPLAN"));
      // Worktrees were reused across the replan (no re-prepare).
      assert.equal(bits.git.callsOf("prepareWorktrees").length, 1);
    },
  );
});

test("maxTotalAttempts hard-fails the run and failed worktrees are retained by policy", async () => {
  const config = defaultConfig();
  config.gates.maxTotalAttempts = 3;
  config.gates.maxConsecutiveFailures = 10;
  await withScenario(
    {
      autoApprove: true,
      config,
      script: (role) => {
        if (role === "testRunner") {
          return { completion: blockedTestRunner("greet test failed") };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "FAILED");
      assert.equal(state.counters.totalAttempts, 3);
      assert.equal(bits.agents.count("developer"), 3, "initial + rework after failures 1 and 2");
      assert.equal(
        bits.git.callsOf("cleanup").length,
        0,
        "retainFailedRuns=true keeps failed-run worktrees",
      );
    },
  );
});

test("cancel mid-development awaits in-flight work, releases reservations, and cleans per policy", async () => {
  let releaseDeveloper: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseDeveloper = resolve;
  });
  const config = defaultConfig();
  config.git.retainFailedRuns = false;
  await withScenario(
    {
      autoApprove: true,
      config,
      script: async (role, _task, call) => {
        if (role === "developer" && call === 1) {
          await held; // hold the agent run open until the test releases it
          return { completion: defaultCompletion("developer") };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const done = bits.engine.start(REQUEST);
      await waitFor(() => bits.agents.count("developer") > 0);
      const fromState = bits.engine.status()!.state;
      assert.ok(
        fromState === "DEVELOP" || fromState === "WRITE_TESTS",
        `cancel happened mid-development (state was ${fromState})`,
      );

      // cancel() waits for the in-flight agent before cleanup — release it
      // concurrently, then await the cancellation.
      const cancelPromise = bits.engine.cancel();
      releaseDeveloper();
      const cancelled = asRunState(await cancelPromise);
      assert.equal(cancelled.state, "CANCELLED");
      assert.equal(cancelled.history[cancelled.history.length - 1]!.state, "CANCELLED");

      const state = asRunState(await done);
      assert.equal(state.state, "CANCELLED");
      assert.equal(bits.engine.status()?.state, "CANCELLED");

      const cleanups = bits.git.callsOf("cleanup");
      assert.equal(cleanups.length, 1, "worktrees cleaned (retainFailedRuns=false)");
      assert.equal(cleanups[0]!.detail.force, true);
      assert.equal(bits.git.callsOf("commitStaged").length, 0, "nothing was committed");
      assert.ok(
        bits.memory.released.includes(state.runId),
        "cancellation releases durable memory reservations",
      );
    },
  );
});
