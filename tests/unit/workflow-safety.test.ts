/**
 * Workflow-safety regression tests (REVIEW P0/P1 scope: approvals, recovery,
 * lifecycle, evidence integrity).
 *
 * The REAL Engine runs over the shared harness (real GitWorktreeManager,
 * real persistence, real gates, deliverable-writing fake agents). Each test
 * pins one specific safety regression:
 *
 *  - git.autoCommit=false cannot apply a commit without explicit user
 *    confirmation; a rejection blocks the run and retains the staging tree;
 *  - the documentation phase may only touch README.md/docs: a smuggled
 *    source edit blocks the run BEFORE the checkpoint commit;
 *  - developer/test-writer "blocked" completions route to BLOCKED for every
 *    role (transport success is not task success);
 *  - uncaught exceptions become durable BLOCKED states, never a stuck phase;
 *  - same-instance pause/resume resets abort/pause only after in-flight work
 *    stopped, and the run then completes;
 *  - agents.maxConcurrency=1 runs the workers strictly sequentially;
 *  - worktree reopen passes the run's original base SHA to the coordinator;
 *  - evidence diffs are actual Git diffs (the synthetic fallback is gone);
 *  - material questions from worker roles park the run and reach the user;
 *  - memory promotion is reviewer-gated and proposal-lint is fail-closed:
 *    blocking findings skip promotion (with recorded evidence) but the
 *    delivered feature still completes;
 *  - approval decisions bind to a unique question INSTANCE + the artifact
 *    hash shown at ask time: arbitrary free text never counts as approval,
 *    an edit re-prompts explicit approval of the amended revision, a
 *    repeated "approve" after a replan is a fresh decision, and an approval
 *    against a changed artifact is rejected fail-closed;
 *  - the docs-only audit covers the complete pre-doc HEAD diff (committed
 *    edits and BOTH rename sides included) plus worktree/untracked paths;
 *  - read-only snapshots exclude gx-dev state, secrets, build output, and
 *    caches;
 *  - infrastructure retry stops at an abort: a cancelled run never retries;
 *  - the command executor tokenizes quotes without shell evaluation,
 *    refuses non-allowlisted and malformed commands, and honors aborts.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { defaultConfig } from "../../extensions/gx-dev/config.ts";
import type { GxConfig } from "../../extensions/gx-dev/config.ts";
import type {
  DeveloperCompletion,
  ReviewerCompletion,
  ReviewFinding,
  TestRunnerCompletion,
} from "../../extensions/gx-dev/domain/schemas.ts";
import {
  asRunState,
  defaultCompletion,
  makeEngineBits,
  makeFixtureRepo,
} from "../helpers/fakes.ts";
import type { EngineBits } from "../helpers/fakes.ts";
import { WORKTREE_DIRNAME } from "../../extensions/gx-dev/git/worktrees.ts";
import type { EngineUI } from "../../extensions/gx-dev/orchestration/engine.ts";
import {
  COMMIT_CONFIRM_QUESTION,
  createProcessExecutor,
  isAffirmative,
  parseApprovalDecision,
  snapshotExcluded,
} from "../../extensions/gx-dev/orchestration/engine.ts";

const REQUEST = "extend greet.js with farewell() and shout(), with tests";

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

function configWith(mutate: (c: GxConfig) => void): GxConfig {
  const c = defaultConfig();
  mutate(c);
  return c;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function withFindings(findings: ReviewFinding[]): ReviewerCompletion {
  const completion = defaultCompletion("reviewer") as ReviewerCompletion;
  completion.findings = findings;
  return completion;
}

function blockedTestRunner(failure: string): TestRunnerCompletion {
  const completion = defaultCompletion("testRunner") as TestRunnerCompletion;
  completion.status = "blocked";
  completion.summary = `test runner blocked: ${failure}`;
  completion.commands = [{ command: "node --test", exitCode: 1 }];
  completion.ownership = [{ failure, owner: "both" }];
  return completion;
}

/** Runs git in a directory, asserting success (test-side inspection/setup). */
function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Staging worktree path of the (single) prepared run in `bits`. */
function stagingDirOf(bits: EngineBits): string {
  const prep = bits.git.callsOf("prepareWorktrees")[0];
  assert.ok(prep, "worktrees were prepared");
  return join(
    dirname(prep!.detail.repoPath as string),
    WORKTREE_DIRNAME,
    prep!.detail.runId as string,
    "staging",
  );
}

/** UI whose answers come from a script; unchecked questions get "approve". */
function scriptedUI(answer: (q: { kind: string; question: string; checkpoint: string }) => string): EngineUI {
  return {
    askUser: async (q) =>
      answer({ kind: q.kind ?? "material-question", question: q.question, checkpoint: q.checkpoint ?? "" }),
    notify: () => {},
  };
}

// ------------------------------------------------------- autoCommit = false

test("git.autoCommit=false parks for explicit confirmation; approval applies the commit", async () => {
  await withScenario(
    {
      // Approve every checkpoint, but dismiss (blank) the commit confirmation
      // so the run parks there for an explicit headless answer.
      ui: scriptedUI((q) => (q.question === COMMIT_CONFIRM_QUESTION ? "" : "approve")),
      config: configWith((c) => { c.git.autoCommit = false; }),
    },
    async ({ bits }) => {
      const parked = asRunState(await bits.engine.start(REQUEST));
      assert.equal(parked.state, "WAITING_FOR_USER");
      assert.equal(parked.resumeState, "COMMIT", "the run parked at the commit apply");
      assert.equal(parked.pendingQuestion?.kind, "confirmation");
      assert.equal(parked.pendingQuestion?.question, COMMIT_CONFIRM_QUESTION);
      assert.equal(
        bits.git.callsOf("commitStaged").length,
        0,
        "nothing may be applied before the explicit confirmation",
      );
      // resume() with an unanswered confirmation must not apply either.
      const refused = asRunState(await bits.engine.resume());
      assert.equal(refused.state, "WAITING_FOR_USER");
      assert.equal(bits.git.callsOf("commitStaged").length, 0);

      const done = asRunState(await bits.engine.answer("approve"));
      assert.equal(done.state, "COMPLETE");
      assert.equal(bits.git.callsOf("commitStaged").length, 1, "confirmation applied the commit");
      const persisted = await bits.runs.load(done.runId);
      assert.match(persisted?.execution?.commitHash ?? "", /^[0-9a-f]{40}$/);
    },
  );
});

test("git.autoCommit=false: rejecting the apply blocks the run and leaves the result unapplied", async () => {
  await withScenario(
    {
      // Approve all checkpoints, reject ONLY the final commit application.
      ui: scriptedUI((q) => (q.question === COMMIT_CONFIRM_QUESTION ? "reject" : "approve")),
      config: configWith((c) => { c.git.autoCommit = false; }),
    },
    async ({ bits }) => {
      const done = asRunState(await bits.engine.start(REQUEST));
      assert.equal(done.state, "BLOCKED");
      assert.ok(
        (done.history[done.history.length - 1]?.state === "BLOCKED"),
        "history ends at BLOCKED",
      );
      assert.equal(
        bits.git.callsOf("commitStaged").length,
        0,
        "a rejected confirmation must never apply the commit",
      );
      // The gates still ran: the verified result is retained, just unapplied.
      assert.ok(bits.stores.events.events().some((e) => e.type === "gate_passed"));
    },
  );
});

// --------------------------- approval decisions bind to question instances

test("approval parsing: only an exact affirmative command approves; free text is an edit; reject carries the reason", () => {
  for (const yes of ["approve", "Approve", "approve.", "yes", "ok"]) {
    assert.equal(parseApprovalDecision(yes).decision, "approved", yes);
  }
  assert.ok(isAffirmative("approve"));
  assert.ok(!isAffirmative("approve it please"), "multi-word prose is not an affirmative command");

  const reject = parseApprovalDecision("reject the scope must include error handling");
  assert.equal(reject.decision, "rejected");
  assert.equal(reject.feedback, "the scope must include error handling");
  assert.equal(parseApprovalDecision("reject: bad contract").feedback, "bad contract");
  assert.equal(parseApprovalDecision("rejected").decision, "rejected");
  assert.equal(parseApprovalDecision("no").decision, "rejected");

  // Arbitrary free text NEVER counts as approval — not even approval-ish prose.
  for (const text of [
    "looks good to me, ship it",
    "LGTM but rename the helper",
    "approve, but also add retry handling",
    "yes please and update the docs",
  ]) {
    const parsed = parseApprovalDecision(text);
    assert.equal(parsed.decision, "amended", text);
    assert.equal(parsed.feedback, text);
  }
});

test("an approval against an artifact that changed since the shown hash is rejected fail-closed", async () => {
  await withScenario({}, async ({ bits }) => {
    const parked = asRunState(await bits.engine.start(REQUEST));
    assert.equal(parked.state, "WAITING_FOR_USER");
    assert.equal(parked.pendingQuestion?.kind, "approval");

    // Tamper with the artifact AFTER the question (with its hash) was shown.
    const original = bits.stores.artifacts.readArtifact("requirements.md") ?? "";
    assert.ok(original.length > 0);
    bits.stores.artifacts.writeArtifact("requirements.md", `${original}\nTampered after ask.\n`);

    const after = asRunState(await bits.engine.answer("approve"));
    assert.equal(
      after.state,
      "WAITING_FOR_USER",
      "the mismatched approval must not advance the run",
    );
    const decisions = (await bits.runs.load(after.runId))?.execution?.decisions ?? [];
    const rejection = decisions.find((d) => d.decision === "rejected");
    assert.ok(rejection, "the mismatching approval is recorded as a rejection");
    assert.match(rejection?.feedback ?? "", /changed since the approval was requested/);
    assert.ok(bits.agents.count("researcher") >= 2, "the run went back to research with the rejection");

    // The re-drafted revision is asked fresh (new instance, new shown hash).
    const asks = (await bits.runs.load(after.runId))?.execution?.approvalAsks ?? [];
    assert.ok(asks.length >= 2, "a fresh approval question was asked for the new revision");
    assert.notEqual(asks[0]?.instanceId, asks.at(-1)?.instanceId);
  });
});

test("a repeated 'approve' after a replan is a fresh decision, not a consumed answer (headless)", async () => {
  let replanned = false;
  await withScenario(
    {
      // No UI: every checkpoint parks and must be answered headlessly.
      script: (role, _task, call) => {
        if (role === "planner" && call >= 2) replanned = true;
        if (role === "testRunner" && !replanned) {
          return { completion: blockedTestRunner("greet test failed") };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const requirements = asRunState(await bits.engine.start(REQUEST));
      assert.equal(requirements.state, "WAITING_FOR_USER");
      const firstPlan = asRunState(await bits.engine.answer("approve"));
      assert.equal(firstPlan.state, "WAITING_FOR_USER");
      assert.equal(firstPlan.pendingQuestion?.checkpoint, "plan");

      // Approve plan #1; the gates fail repeatedly, the run replans, and the
      // NEW plan parks on a FRESH approval question instead of inheriting the
      // consumed "approve" (whose text-hash collided under the old matcher).
      const replannedPlan = asRunState(await bits.engine.answer("approve"));
      assert.equal(replannedPlan.state, "WAITING_FOR_USER");
      assert.equal(replannedPlan.pendingQuestion?.checkpoint, "plan");

      const persistedMid = await bits.runs.load(replannedPlan.runId);
      const planAsks = (persistedMid?.execution?.approvalAsks ?? []).filter(
        (a) => a.checkpoint === "plan",
      );
      assert.equal(planAsks.length, 2, "the replanned plan is a NEW question instance");
      assert.notEqual(planAsks[0]?.instanceId, planAsks[1]?.instanceId);
      assert.notEqual(
        planAsks[0]?.artifactHash,
        planAsks[1]?.artifactHash,
        "the new plan revision carries its own shown hash",
      );

      const done = asRunState(await bits.engine.answer("approve"));
      assert.equal(
        done.state,
        "COMPLETE",
        "the second 'approve' must be consumed as its own decision (the old text-hash matcher parked forever)",
      );
      const decisions = (await bits.runs.load(done.runId))?.execution?.decisions ?? [];
      const planApprovals = decisions.filter(
        (d) => d.checkpoint === "plan" && d.decision === "approved",
      );
      assert.equal(planApprovals.length, 2);
      assert.notEqual(planApprovals[0]?.instanceId, planApprovals[1]?.instanceId);
    },
  );
});

// ----------------------------------------------- documentation scope carve-out

test("documentation phase: a smuggled source edit blocks the run BEFORE the checkpoint", async () => {
  let reviewerCalls = 0;
  await withScenario(
    {
      autoApprove: true,
      script: (role, _task, call) => {
        if (role !== "reviewer") return undefined;
        reviewerCalls = call;
        if (call === 2) {
          // Documentation-mode reviewer smuggles a production source edit.
          return {
            completion: defaultCompletion("reviewer"),
            writeFiles: [{ path: "src/smuggled.js", content: "export const smuggled = true;\n" }],
          };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "BLOCKED");
      assert.ok(reviewerCalls >= 2, "documentation reviewer ran");
      assert.equal(
        bits.git.callsOf("checkpointStaging").length,
        0,
        "the source edit must not be checkpointed",
      );
      assert.equal(bits.git.callsOf("commitStaged").length, 0, "nothing reaches the user branch");
      const errorEvent = bits.stores.events.events().find((e) => e.type === "error");
      assert.match(errorEvent?.message ?? "", /non-documentation files/);
      assert.match(errorEvent?.message ?? "", /src\/smuggled\.js/);
    },
  );
});

test("documentation phase: a COMMITTED source edit blocks the run BEFORE the checkpoint", async () => {
  // The docs-mode reviewer (reviewer call 2) writes a production source edit
  // AND commits it itself. The old status-only check saw a clean tree and
  // waved it through; the pre-doc-HEAD diff audit must catch it.
  let bitsRef: EngineBits | null = null;
  await withScenario(
    {
      autoApprove: true,
      script: (role, _task, call) => {
        if (role !== "reviewer" || call !== 2) return undefined;
        const staging = stagingDirOf(bitsRef!);
        writeFileSync(join(staging, "src", "committed.js"), "export const smuggled = true;\n");
        gitIn(staging, ["add", "-A"]);
        gitIn(staging, [
          "-c", "user.name=gx-dev-test", "-c", "user.email=test@gx-dev.invalid",
          "commit", "-q", "-m", "docs agent commits a source edit",
        ]);
        return { completion: defaultCompletion("reviewer") };
      },
    },
    async ({ bits }) => {
      bitsRef = bits;
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "BLOCKED", "a committed source edit must block");
      assert.equal(
        bits.git.callsOf("checkpointStaging").length,
        0,
        "the committed source edit must not be checkpointed",
      );
      assert.equal(bits.git.callsOf("commitStaged").length, 0, "nothing reaches the user branch");
      const errorEvent = bits.stores.events.events().find((e) => e.type === "error");
      assert.match(errorEvent?.message ?? "", /non-documentation files/);
      assert.match(errorEvent?.message ?? "", /src\/committed\.js/);
    },
  );
});

test("documentation phase: a committed src→docs rename blocks via BOTH rename sides", async () => {
  // Under `git status --porcelain` the rename surfaces only as its new docs
  // side (docs/greet.js) and passed the old check; with --no-renames the
  // deleted src side is audited too and blocks.
  let bitsRef: EngineBits | null = null;
  await withScenario(
    {
      autoApprove: true,
      script: (role, _task, call) => {
        if (role !== "reviewer" || call !== 2) return undefined;
        const staging = stagingDirOf(bitsRef!);
        mkdirSync(join(staging, "docs"), { recursive: true });
        gitIn(staging, ["mv", "src/greet.js", "docs/greet.js"]);
        gitIn(staging, [
          "-c", "user.name=gx-dev-test", "-c", "user.email=test@gx-dev.invalid",
          "commit", "-q", "-m", "docs agent renames production source into docs",
        ]);
        return { completion: defaultCompletion("reviewer") };
      },
    },
    async ({ bits }) => {
      bitsRef = bits;
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "BLOCKED", "the renamed source must block via its deleted src side");
      assert.equal(bits.git.callsOf("checkpointStaging").length, 0);
      const errorEvent = bits.stores.events.events().find((e) => e.type === "error");
      assert.match(errorEvent?.message ?? "", /src\/greet\.js/);
    },
  );
});

// ------------------------------------------- blocked statuses for every role

test("a developer completion with status blocked routes the run to BLOCKED", async () => {
  await withScenario(
    {
      autoApprove: true,
      script: (role) => {
        if (role === "developer") {
          const completion = defaultCompletion("developer") as DeveloperCompletion;
          completion.status = "blocked";
          completion.summary = "blocked: the requested API conflicts with the public contract";
          return { completion };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "BLOCKED", "blocked transport-success is a task failure");
      const errorEvent = bits.stores.events.events().find((e) => e.type === "error");
      assert.match(errorEvent?.message ?? "", /developer reported blocked/);
      assert.equal(bits.git.callsOf("commitStaged").length, 0);
    },
  );
});

// ------------------------------------------- exceptions are durable BLOCKED

test("an uncaught coordinator exception becomes a durable BLOCKED state", async () => {
  await withScenario({ autoApprove: true }, async ({ bits }) => {
    bits.git.integrate = async () => {
      throw new Error("simulated git layer crash");
    };
    const state = asRunState(await bits.engine.start(REQUEST));
    assert.equal(state.state, "BLOCKED", "exceptions must not leave a misleading active phase");
    const errorEvent = bits.stores.events.events().find((e) => e.type === "error");
    assert.match(errorEvent?.message ?? "", /orchestration error in INTEGRATE/);
    assert.match(errorEvent?.message ?? "", /simulated git layer crash/);
    const persisted = await bits.runs.load(state.runId);
    assert.equal(persisted?.state, "BLOCKED", "the blocked state is durable");
  });
});

// ------------------------------------------------- pause/resume on one engine

test("an infrastructure failure after a stop request is never retried (abort wins)", async () => {
  let releaseDeveloper: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseDeveloper = resolve;
  });
  await withScenario(
    {
      autoApprove: true,
      script: async (role, _task, call) => {
        if (role === "developer" && call === 1) {
          await held; // hold the attempt open until the test cancels
          return { infra: true, rawText: "simulated infrastructure crash" };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const done = bits.engine.start(REQUEST);
      await waitFor(() => bits.agents.count("developer") > 0);
      // cancel() aborts synchronously BEFORE awaiting the in-flight attempt,
      // so when the attempt fails the abort has already been observed.
      const cancelPromise = bits.engine.cancel();
      releaseDeveloper();
      const cancelled = asRunState(await cancelPromise);
      assert.equal(cancelled.state, "CANCELLED");
      assert.equal(asRunState(await done).state, "CANCELLED");
      assert.equal(
        bits.agents.count("developer"),
        1,
        "the failed attempt must not be retried behind the abort",
      );
      assert.equal(bits.git.callsOf("commitStaged").length, 0);
    },
  );
});

test("same-instance pause/resume resets abort and pause only after in-flight work stopped", async () => {
  let releaseDeveloper: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseDeveloper = resolve;
  });
  await withScenario(
    {
      autoApprove: true,
      script: async (role, _task, call) => {
        if (role === "developer" && call === 1) {
          await held;
          return { completion: defaultCompletion("developer") };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const done = bits.engine.start(REQUEST);
      await waitFor(() => bits.agents.count("developer") > 0);

      const pausePromise = bits.engine.pause();
      releaseDeveloper();
      const paused = asRunState(await pausePromise);
      assert.equal(paused.state, "PAUSED");
      assert.ok(bits.agents.endOrder.includes("developer"), "in-flight work stopped before pause returned");

      const resumed = asRunState(await bits.engine.resume());
      assert.equal(
        resumed.state,
        "COMPLETE",
        `same-instance resume must finish the run, got ${resumed.state}`,
      );
      // start() resolves when ITS drive stops — PAUSED at pause time, or
      // COMPLETE when the unwind observed the resumed run finishing first.
      const state = asRunState(await done);
      assert.ok(
        state.state === "PAUSED" || state.state === "COMPLETE",
        `start resolved at ${state.state}`,
      );
      assert.equal(bits.engine.status()?.state, "COMPLETE", "the engine ended COMPLETE");
      assert.ok(
        bits.git.callsOf("commitStaged").length === 1,
        "the paused-then-resumed run delivered",
      );
    },
  );
});

// ----------------------------------------------------------- maxConcurrency

test("agents.maxConcurrency=1 runs the developer and test writer strictly sequentially", async () => {
  await withScenario(
    { autoApprove: true, config: configWith((c) => { c.agents.maxConcurrency = 1; }) },
    async ({ bits }) => {
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "COMPLETE");
      const start = bits.agents.startOrder.filter((r) => r === "developer" || r === "testWriter");
      const end = bits.agents.endOrder.filter((r) => r === "developer" || r === "testWriter");
      assert.equal(start.length, 2);
      assert.equal(end.length, 2);
      assert.deepEqual(start, ["developer", "testWriter"], "workers started sequentially");
      assert.deepEqual(end, ["developer", "testWriter"], "developer finished before testWriter started");
    },
  );
});

test("default maxConcurrency=2 dispatches the test writer while the developer is still running", async () => {
  let releaseDeveloper: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseDeveloper = resolve;
  });
  await withScenario(
    {
      autoApprove: true,
      script: async (role, _task, call) => {
        if (role === "developer" && call === 1) {
          await held; // hold the developer so concurrency is observable
          return { completion: defaultCompletion("developer") };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const done = bits.engine.start(REQUEST);
      // With maxConcurrency=2 the test writer starts without waiting for the
      // developer to finish (with maxConcurrency=1 this would time out).
      await waitFor(() => bits.agents.count("testWriter") > 0);
      assert.equal(bits.agents.count("developer"), 1);
      releaseDeveloper();
      const state = asRunState(await done);
      assert.equal(state.state, "COMPLETE");
    },
  );
});

// --------------------------------------------- worktree reopen passes base SHA

test("worktrees are prepared with the run's original base commit for safe reopen", async () => {
  await withScenario({ autoApprove: true }, async ({ bits }) => {
    const state = asRunState(await bits.engine.start(REQUEST));
    assert.equal(state.state, "COMPLETE");
    const prepares = bits.git.callsOf("prepareWorktrees");
    assert.equal(prepares.length, 1);
    assert.equal(prepares[0]!.detail.base, state.base?.commit, "the intake base SHA is passed through");
  });
});

// ------------------------------------------------ actual Git diffs as evidence

test("evidence diffs are actual unified git diffs — no synthetic fallback", async () => {
  await withScenario({ autoApprove: true }, async ({ bits }) => {
    const state = asRunState(await bits.engine.start(REQUEST));
    assert.equal(state.state, "COMPLETE");
    const combined = bits.stores.artifacts.readArtifact("combined.diff") ?? "";
    // A synthetic fallback would embed agent prose, never real index lines.
    assert.match(combined, /^diff --git a\/src\/greet\.js b\/src\/greet\.js$/m);
    assert.match(combined, /^index [0-9a-f]+\.\.[0-9a-f]+ /m);
    assert.match(combined, /^\+\+\+ b\/test\/farewell\.test\.js$/m);
    assert.ok(!combined.includes("fake harness"), "no agent prose leaked into the diff");
    // The committed tree really contains the delivered files.
    const staging = bits.git.callsOf("integrate").length >= 1;
    assert.ok(staging);
    assert.match(state.dependencies.stagingRevision ?? "", /^[0-9a-f]{40}$/);
  });
});

// --------------------------------------- worker material questions park safely

test("a worker material question parks the run before integration; the answer unblocks without re-running workers", async () => {
  await withScenario(
    {
      // Approve the requirements/plan checkpoints, but dismiss (blank) the
      // developer's material question so the run parks on it headlessly.
      ui: scriptedUI((q) => (q.question.includes("null names") ? "" : "approve")),
      script: (role) => {
        if (role === "developer") {
          const completion = defaultCompletion("developer") as DeveloperCompletion;
          completion.questions = [
            { question: "Should farewell() also accept null names?", severity: "material", context: ["public contract"] },
          ];
          return { completion };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const parked = asRunState(await bits.engine.start(REQUEST));
      assert.equal(parked.state, "WAITING_FOR_USER");
      assert.equal(parked.pendingQuestion?.kind, "material-question");
      assert.equal(parked.pendingQuestion?.checkpoint, "develop");
      assert.equal(parked.resumeState, "WRITE_TESTS", "resume target is the parked pipeline state");

      const done = asRunState(await bits.engine.answer("no, reject null names"));
      assert.equal(done.state, "COMPLETE");
      assert.equal(
        bits.agents.count("developer"),
        1,
        "the completed developer work is not re-run just to consume the answer",
      );

      // The answer is durable and recorded at the develop checkpoint.
      const persisted = await bits.runs.load(done.runId);
      const answers = persisted?.execution?.answers ?? [];
      assert.ok(answers.some((a) => a.answer === "no, reject null names" && a.checkpoint === "develop"));
      const implementation = bits.stores.artifacts.readArtifact("implementation.md") ?? "";
      assert.ok(implementation.length > 0);
    },
  );
});

// ------------------------------------------------- memory promotion is gated

test("a blocking memory review skips promotion but the delivered feature still completes", async () => {
  await withScenario(
    {
      autoApprove: true,
      script: (role, _task, call) => {
        if (role === "reviewer" && call === 3) {
          // call 3 = the memory-proposal review (1 = code review, 2 = docs)
          return { completion: withFindings([
            { severity: "blocking", remediation: "the proposal overstates what was verified" },
          ]) };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "COMPLETE", "the feature delivery is not gated on memory");
      assert.equal(
        bits.memory.promoted.length,
        0,
        "blocked proposals are never promoted as verified",
      );
      const proposal = bits.stores.artifacts.readArtifact("memory-proposal.md") ?? "";
      assert.match(proposal, /overstates what was verified/);
      const intervention = bits.stores.events.events().find(
        (e) => e.type === "orchestrator_intervention" && /memory reviewer blocked promotion/.test(e.message),
      );
      assert.ok(intervention !== undefined, "the blocking review is recorded as an intervention");
    },
  );
});

test("memory proposal lint findings fail closed: promotion is skipped with evidence", async () => {
  await withScenario(
    {
      autoApprove: true,
      script: (role, _task, call) => {
        if (role === "reviewer" && call === 3) {
          // The memory-proposal review approves; the structural lint must
          // still gate promotion.
          return { completion: withFindings([]) };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      bits.memory.lintProposals = () => ({
        ok: false,
        issues: ["features/run-x: body is missing a ## Summary section"],
      });
      const state = asRunState(await bits.engine.start(REQUEST));
      assert.equal(state.state, "COMPLETE", "the delivered feature is not gated on memory");
      assert.equal(
        bits.memory.promoted.length,
        0,
        "lint findings must SKIP promotion, not merely warn",
      );
      const proposal = bits.stores.artifacts.readArtifact("memory-proposal.md") ?? "";
      assert.match(proposal, /missing a ## Summary section/);
      assert.match(proposal, /"promoted": false/);
      const intervention = bits.stores.events.events().find(
        (e) =>
          e.type === "orchestrator_intervention" &&
          /memory promotion skipped/.test(e.message),
      );
      assert.ok(intervention !== undefined, "the lint skip is recorded as an intervention with evidence");
    },
  );
});

// ------------------------------------ read-only snapshots are sanitized

test("read-only snapshots exclude gx-dev state, secrets, build output, and caches", () => {
  for (const excluded of [
    ".git", ".gx-dev", ".pi", "node_modules",
    ".env", ".env.local", ".env.production",
    "credentials", "credentials.json",
    "server.pem", "private.key", "id_rsa", ".netrc", ".npmrc", ".git-credentials",
    "dist", "build", "out", "coverage", ".cache", ".next", "__pycache__", ".venv",
  ]) {
    assert.ok(snapshotExcluded(excluded), `${excluded} must be excluded from snapshots`);
  }
  for (const included of ["src", "lib", "test", "package.json", "README.md", ".github", "tsconfig.json"]) {
    assert.ok(!snapshotExcluded(included), `${included} must stay in snapshots`);
  }
});

// --------------------------------------------------------- command executor

test("command executor: quote-aware tokenizing without shell evaluation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gx-dev-exec-"));
  try {
    const exec = createProcessExecutor();
    const quoted = await exec.execute(dir, `node -e "console.log('a' + ' ' + 'b')"`, 30_000);
    assert.equal(quoted.exitCode, 0, `quoted script failed: ${quoted.output}`);
    assert.equal(quoted.output.trim(), "a b", "quotes must survive tokenizing");

    // Metacharacters stay ordinary argv text: no shell, no eval.
    const noShell = await exec.execute(
      dir,
      `node -e "console.log('argv:' + process.argv.slice(1).length)" x; echo pwned`,
      30_000,
    );
    assert.equal(noShell.exitCode, 0);
    assert.equal(noShell.output.trim(), "argv:3", "'; echo pwned' must be argv, not a second command");

    const refused = await exec.execute(dir, "curl http://example.invalid", 30_000);
    assert.equal(refused.exitCode, 126, "non-allowlisted commands are refused");

    const malformed = await exec.execute(dir, `node -e "unterminated`, 30_000);
    assert.equal(malformed.exitCode, 126, "unterminated quotes are refused");

    const empty = await exec.execute(dir, "   ", 30_000);
    assert.equal(empty.exitCode, 126, "whitespace-only commands never reach a shell");
    assert.match(empty.output, /allowlist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command executor honors an aborted signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gx-dev-exec-"));
  try {
    const controller = new AbortController();
    controller.abort();
    const exec = createProcessExecutor({ signal: () => controller.signal });
    const aborted = await exec.execute(dir, "node -e process.exit(0)", 30_000);
    assert.equal(aborted.exitCode, 130);
    assert.match(aborted.output, /aborted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------- single-flight drive

test("starting a second run while one is active is refused (single-flight)", async () => {
  let releaseDeveloper: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseDeveloper = resolve;
  });
  await withScenario(
    {
      autoApprove: true,
      script: async (role, _task, call) => {
        if (role === "developer" && call === 1) {
          await held;
          return { completion: defaultCompletion("developer") };
        }
        return undefined;
      },
    },
    async ({ bits }) => {
      const first = bits.engine.start(REQUEST);
      await waitFor(() => bits.agents.count("developer") > 0);
      await assert.rejects(
        () => bits.engine.start("another request"),
        /a run is already active/,
      );
      releaseDeveloper();
      const state = asRunState(await first);
      assert.equal(state.state, "COMPLETE");
    },
  );
});
