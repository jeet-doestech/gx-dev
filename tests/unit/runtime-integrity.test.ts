import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeEngineBits, makeFixtureRepo } from "../helpers/fakes.ts";
import { buildEngine } from "../../extensions/gx-dev/index.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

test("changed approved requirements block delivery at the next execution boundary", async () => {
  const repo = await makeFixtureRepo();
  const bits = makeEngineBits(repo, { autoApprove: true });
  const run = bits.agents.run.bind(bits.agents);
  bits.agents.run = async (...args) => {
    const result = await run(...args);
    if (args[0] === "developer") bits.stores.artifacts.writeArtifact("requirements.md", "Changed outside approval");
    return result;
  };
  try {
    const state = await bits.engine.start("Add farewell behavior");
    assert.equal(state.state, "BLOCKED");
    assert.equal(bits.git.callsOf("commitStaged").length, 0);
  } finally {
    bits.git.removeTempDirs(); bits.stores.removePlaceholderDirs(); rmSync(repo, { recursive: true, force: true });
  }
});

test("stale parked controls cannot overwrite a run advanced by another owner", async () => {
  const repo = await makeFixtureRepo();
  const bits = makeEngineBits(repo);
  try {
    const parked = await bits.engine.start("Add farewell behavior");
    assert.equal(parked.state, "WAITING_FOR_USER");
    const external = { ...parked, state: "CANCELLED" as const, pendingQuestion: null };
    await bits.runs.save(external);
    await assert.rejects(bits.engine.answer("approve"), /persisted run changed/);
    await assert.rejects(bits.engine.cancel(), /persisted run changed/);
    assert.equal((await bits.runs.load(parked.runId))?.state, "CANCELLED");
    assert.equal((await bits.engine.resume())?.state, "CANCELLED");
  } finally {
    bits.git.removeTempDirs(); bits.stores.removePlaceholderDirs(); rmSync(repo, { recursive: true, force: true });
  }
});

test("production engine construction is read-only even in an untrusted project", async () => {
  const repo = await makeFixtureRepo();
  try {
    const context = {
      cwd: repo, isProjectTrusted: () => false, mode: "json", hasUI: false,
      ui: { notify() {} },
    } as unknown as ExtensionContext;
    const built = await buildEngine(context);
    assert.equal(built.projectTrusted, false);
    assert.equal(built.engine.status(), null);
    assert.equal(existsSync(join(repo, ".gx-dev")), false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
