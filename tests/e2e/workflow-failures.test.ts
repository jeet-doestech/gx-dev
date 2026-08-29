/**
 * E2E failure-routing tests (PLAN §9, §17): test-gate failures must re-enter
 * the developer's state, counters must reset on success, and five consecutive
 * test failures must escalate to REPLAN with the failure history handed back
 * to the planner.
 *
 * Failure lever: the fake testRunner returns `status: "blocked"` with
 * developer ownership. This is deterministic because the real test gate
 * executes the verification contract for evidence but treats a blocked
 * test-runner report as a failure regardless of the real exit code.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { TestRunnerCompletion } from "../../extensions/gx-dev/domain/schemas.ts";
import {
  asRunState,
  defaultCompletion,
  makeEngineBits,
  makeFixtureRepo,
} from "../helpers/fakes.ts";
import type { FakeScript } from "../helpers/fakes.ts";

const REQUEST = "add farewell() to greet module";

function blockedTestRunnerCompletion(failure: string): TestRunnerCompletion {
  const completion = defaultCompletion("testRunner") as TestRunnerCompletion;
  completion.status = "blocked";
  completion.summary = `test runner blocked: ${failure}`;
  completion.commands = [{ command: "node --test", exitCode: 1 }];
  completion.ownership = [{ failure, owner: "developer" }];
  return completion;
}

test("test gate failure routes back to DEVELOP, developer is re-invoked, then the run completes and the counter resets to zero", async () => {
  const repoPath = await makeFixtureRepo();
  let bits: ReturnType<typeof makeEngineBits> | null = null;
  try {
    const script: FakeScript = (role, _task, call) => {
      if (role === "testRunner" && call === 1) {
        return { completion: blockedTestRunnerCompletion("greet test failed") };
      }
      return undefined; // second invocation takes the happy path
    };

    bits = makeEngineBits(repoPath, { script });

    const state = asRunState(await bits.engine.start(REQUEST));
    assert.equal(state.state, "COMPLETE", `expected COMPLETE after rework, got: ${state.state}`);

    assert.ok(
      bits.agents.count("developer") >= 2,
      "developer must be re-invoked after the failed test gate",
    );
    const states = state.history.map((h) => h.state);
    assert.ok(
      states.filter((s) => s === "TEST_GATE").length >= 2,
      `history must show a retried TEST_GATE: ${states.join(" -> ")}`,
    );
    assert.ok(
      states.filter((s) => s === "DEVELOP").length >= 2,
      `history must show DEVELOP re-entry: ${states.join(" -> ")}`,
    );
    assert.equal(
      state.counters.testConsecutiveFailures,
      0,
      "a passing test gate must reset testConsecutiveFailures to 0",
    );
  } finally {
    bits?.stores.removePlaceholderDirs();
    bits?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("five consecutive test failures escalate to REPLAN: planner is re-invoked with the failure history, then the run completes", async () => {
  const repoPath = await makeFixtureRepo();
  let bits: ReturnType<typeof makeEngineBits> | null = null;
  try {
    let replanned = false;
    const script: FakeScript = (role, task, call) => {
      if (role === "planner" && call >= 2) {
        replanned = true; // the new plan unlocks the gate
      }
      if (role === "testRunner" && !replanned) {
        return { completion: blockedTestRunnerCompletion("greet test failed") };
      }
      return undefined;
    };

    bits = makeEngineBits(repoPath, { script });

    const state = asRunState(await bits.engine.start(REQUEST));
    assert.equal(state.state, "COMPLETE", `expected COMPLETE after replan, got: ${state.state}`);

    const plannerInvocations = bits.agents.invocations.filter((i) => i.role === "planner");
    assert.ok(
      plannerInvocations.length >= 2,
      "planner must be re-invoked after five consecutive test failures",
    );
    const replanTask = plannerInvocations[1]?.task ?? "";
    assert.match(
      replanTask,
      /failure-history|Failure/i,
      `replan task must carry the failure history; got: ${replanTask.slice(0, 400)}`,
    );

    const states = state.history.map((h) => h.state);
    assert.ok(states.includes("REPLAN"), `history must pass through REPLAN: ${states.join(" -> ")}`);
    const replanIndex = states.indexOf("REPLAN");
    assert.ok(
      replanIndex > -1 && states[replanIndex + 1] === "PLAN",
      "REPLAN must be followed by PLAN",
    );
    assert.equal(
      state.counters.testConsecutiveFailures,
      0,
      "final passing gate must reset testConsecutiveFailures",
    );
  } finally {
    bits?.stores.removePlaceholderDirs();
    bits?.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});
