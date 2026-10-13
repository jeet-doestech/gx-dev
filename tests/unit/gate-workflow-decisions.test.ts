import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeFixtureRepo, makeEngineBits, defaultCompletion } from "../helpers/fakes.ts";

for (const role of ["testRunner", "reviewer"] as const) {
  test(`${role} material questions reach user without consuming code failure attempts`, async () => {
    const repo = await makeFixtureRepo();
    const bits = makeEngineBits(repo, {
      ui: { askUser: async (question) => question.kind === "approval" ? "approve" : "Use strict validation", notify() {} },
      script(agent, prompt, call) {
        if (agent === role && call === 1) {
          const completion = defaultCompletion(role);
          completion.questions = [{ question: "Strict or permissive validation?", severity: "material" }];
          return { completion };
        }
        if (agent === role && call === 2) assert.match(prompt, /Use strict validation/);
      },
    });
    try {
      const state = await bits.engine.start("Add farewell behavior");
      assert.equal(state.state, "COMPLETE");
      assert.equal(state.counters.testConsecutiveFailures, 0);
      assert.equal(state.counters.reviewConsecutiveFailures, 0);
      assert.ok(state.execution?.answers?.some((answer) => answer.answer === "Use strict validation"));
    } finally {
      bits.git.removeTempDirs(); bits.stores.removePlaceholderDirs(); rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("commit refuses a staging tree changed after final verification", async () => {
  const repo = await makeFixtureRepo();
  const bits = makeEngineBits(repo, { autoApprove: true });
  const runner = bits.agents.run.bind(bits.agents);
  bits.agents.run = async (role, task, work, options) => {
    if (role === "committer") {
      const staging = bits.git.calls.find((call) => call.op === "prepareWorktrees");
      assert.ok(staging);
      const runId = bits.engine.status()!.runId;
      // Worktrees are adjacent to the fixture, not to the disposable advisory snapshot.
      const directory = join(repo, "..", ".gx-dev-worktrees", runId, "staging");
      writeFileSync(join(directory, "unexpected.txt"), "unverified change\n");
      execFileSync("git", ["add", "unexpected.txt"], { cwd: directory });
      execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "unverified"], { cwd: directory, stdio: "ignore" });
    }
    return runner(role, task, work, options);
  };
  try {
    const state = await bits.engine.start("Add farewell behavior");
    assert.equal(state.state, "BLOCKED");
    assert.equal(bits.git.callsOf("commitStaged").length, 0);
  } finally {
    bits.git.removeTempDirs(); bits.stores.removePlaceholderDirs(); rmSync(repo, { recursive: true, force: true });
  }
});
