/**
 * Concurrency tests for the memory store (REVIEW §4: transactional promotion).
 *
 * The promote transaction — revision check, page write, claim cleanup, log
 * append — must run under the exclusive directory lease (domain/lease.ts,
 * published at `<root>/.lock/owner.json`) so competing processes can never
 * interleave between compare and write. These tests exercise that with real
 * separate Node processes racing on one memory root, plus in-process races,
 * and pin that a crashed owner's lease is reclaimed (tombstone retained)
 * instead of blocking anyone.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FsMemoryStore } from "../../extensions/gx-dev/memory/store.ts";
import { reclaimedTombstonePath } from "../../extensions/gx-dev/domain/lease.ts";
import type { MemoryProposal } from "../../extensions/gx-dev/domain/interfaces.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const STORE_URL = new URL("../../extensions/gx-dev/memory/store.ts", import.meta.url).href;

/** Child process body: reserve + promote one proposal for the shared page. */
const CHILD_SCRIPT = `
const [, , storeUrl, root, runId] = process.argv;
const { FsMemoryStore } = await import(storeUrl);
const store = new FsMemoryStore(root, { redact: true });
const proposal = {
  page: "features/race-page",
  action: "create",
  body: "## Summary\\n\\nDecision " + runId + " wrote this page. See [[conventions]].\\n",
  provenance: [runId],
  scope: "global",
  freshness: new Date().toISOString().slice(0, 10),
  verification: "verified",
  runId,
};
const reserved = await store.reserve([proposal]);
const result = await store.promote(reserved);
process.stdout.write(
  JSON.stringify({
    runId,
    action: reserved[0] === undefined ? "?" : reserved[0].action,
    applied: result.applied,
    conflicts: result.conflicts,
  }) + "\\n",
);
`;

function makeRoot(label: string): { dir: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), `gx-mem-conc-${label}-`));
  tempDirs.push(dir);
  return { dir, root: join(dir, ".gx-dev", "memory") };
}

interface ChildResult {
  runId: string;
  action: string;
  applied: string[];
  conflicts: string[];
}

/** Spawns a real separate Node process that reserves and promotes one page. */
function runChild(childScript: string, root: string, runId: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, STORE_URL, root, runId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`child ${runId} exited with ${code}: ${err}`));
        return;
      }
      const line = out.trim().split(/\r?\n/).filter((l) => l.length > 0).pop();
      if (line === undefined) {
        reject(new Error(`child ${runId} produced no output: ${err}`));
        return;
      }
      resolve(JSON.parse(line) as ChildResult);
    });
  });
}

/**
 * A real, provably gone pid: spawn a child, SIGKILL it, await its exit. Used
 * to forge a crashed engine's memory lease (a well-formed owner record whose
 * process no longer exists — exactly the state domain/lease.ts reclaims).
 */
async function makeDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    stdio: "ignore",
  });
  const pid = child.pid ?? -1;
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    child.on("exit", () => resolveExit());
  });
  return pid;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

test("competing processes: every proposal resolves exactly once, one winner", async () => {
  const { dir, root } = makeRoot("race");
  const childScript = join(dir, "child.mjs");
  writeFileSync(childScript, CHILD_SCRIPT, "utf8");

  const N = 6;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => runChild(childScript, root, `run-${i}`)),
  );

  // Each child either applied its page or hit a conflict — exactly one of the
  // two, for every child. No child may crash, hang, or silently lose its write.
  const totalApplied = results.reduce((n, r) => n + r.applied.length, 0);
  const totalConflicts = results.reduce((n, r) => n + r.conflicts.length, 0);
  assert.equal(totalApplied + totalConflicts, N);
  assert.ok(totalApplied >= 1, "at least one child must land its write");

  // Exactly one child reserved a create (the page starts absent); the rest
  // degrades to update at reserve time — no duplicate semantic creates.
  const actions = results.map((r) => r.action).sort();
  assert.equal(actions.filter((a) => a === "create").length, 1);
  assert.equal(actions.filter((a) => a === "update").length, N - 1);

  // The final file holds exactly one child's body, and it must belong to one
  // of the children that actually applied. Conflicted bodies never land.
  const final = readFileSync(join(root, "features", "race-page.md"), "utf8");
  assert.equal((final.match(/Decision run-\d+ wrote this page/g) ?? []).length, 1);
  const appliedRuns = results.filter((r) => r.applied.length > 0).map((r) => r.runId);
  assert.ok(
    appliedRuns.some((runId) => final.includes(`Decision ${runId} wrote this page`)),
    `final content must come from an applied child (${appliedRuns.join(", ")})`,
  );
  for (const r of results) {
    if (r.conflicts.length > 0) {
      assert.ok(!final.includes(`Decision ${r.runId} wrote this page`));
    }
  }

  // One log line per applied write; no lingering reservation claims; wiki
  // is structurally intact after the race; search finds the single page.
  const log = readFileSync(join(root, "log.md"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("- "));
  assert.equal(log.length, totalApplied);
  const indexRaw = readFileSync(join(root, "index.md"), "utf8");
  assert.ok(!indexRaw.includes("planned by run-"));

  const store = new FsMemoryStore(root);
  assert.deepEqual(await store.lint(), { ok: true, issues: [] });
  const hits = await store.search("wrote", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.name, "features/race-page");
});

test("competing processes serialize when they reserve one after another", async () => {
  const { dir, root } = makeRoot("serial");
  const childScript = join(dir, "child.mjs");
  writeFileSync(childScript, CHILD_SCRIPT, "utf8");

  // Staggered starts: later children may observe the first child's promote,
  // reserve as update, and legitimately apply after it. Still exactly one
  // create, every proposal resolved once, and one consistent final body.
  const runs = ["run-a", "run-b", "run-c"].map((runId, i) =>
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, i * 150));
      return runChild(childScript, root, runId);
    })(),
  );
  const results = await Promise.all(runs);
  const totalApplied = results.reduce((n, r) => n + r.applied.length, 0);
  const totalConflicts = results.reduce((n, r) => n + r.conflicts.length, 0);
  assert.equal(totalApplied + totalConflicts, results.length);
  assert.equal(results.filter((r) => r.action === "create").length, 1);

  const final = readFileSync(join(root, "features", "race-page.md"), "utf8");
  assert.equal((final.match(/Decision run-\w+ wrote this page/g) ?? []).length, 1);
  assert.ok(!readFileSync(join(root, "index.md"), "utf8").includes("planned by run-"));
});

test("in-process race: simultaneous promotes allow exactly one writer", async () => {
  const { root } = makeRoot("inproc");
  const stores = [new FsMemoryStore(root), new FsMemoryStore(root), new FsMemoryStore(root)];
  const runIds = ["run-a", "run-b", "run-c"];
  const mk = (runId: string): MemoryProposal => ({
    page: "features/simul",
    action: "create",
    body: `## Summary\n\nBody of ${runId}. See [[conventions]].\n`,
    provenance: [runId],
    scope: "global",
    freshness: today(),
    verification: "verified",
    runId,
  });

  // All three reserve (durable claims with identical absent expectations),
  // then promote concurrently: the compare-and-write is under the lock, so
  // exactly one applies and the others conflict instead of overwriting.
  for (const [i, store] of stores.entries()) await store.reserve([mk(runIds[i] ?? "run-x")]);
  const outcomes = await Promise.all(stores.map((store, i) => store.promote([mk(runIds[i] ?? "run-x")])));
  const appliedTotal = outcomes.reduce((n, o) => n + o.applied.length, 0);
  const conflictTotal = outcomes.reduce((n, o) => n + o.conflicts.length, 0);
  assert.equal(appliedTotal, 1);
  assert.equal(conflictTotal, 2);

  const raw = readFileSync(join(root, "features", "simul.md"), "utf8");
  assert.match(raw, /Body of run-[abc]\./);
  assert.ok(!readFileSync(join(root, "index.md"), "utf8").includes("planned by run-"));
});

test("release(runId) from another instance clears durable claims", async () => {
  const { root } = makeRoot("release");
  const holder = new FsMemoryStore(root);
  await holder.reserve([
    { ...mkBase("run-cancelled"), page: "features/cancel-a" },
    { ...mkBase("run-cancelled"), page: "features/cancel-b" },
  ]);
  await holder.reserve([{ ...mkBase("run-kept"), page: "features/kept" }]);
  const index = () => readFileSync(join(root, "index.md"), "utf8");
  assert.ok(index().includes("planned by run-cancelled"));
  assert.ok(index().includes("planned by run-kept"));

  // Cancellation through a different (e.g. restarted) store instance.
  const other = new FsMemoryStore(root);
  await other.release("run-cancelled");
  const raw = index();
  assert.ok(!raw.includes("planned by run-cancelled"));
  assert.ok(raw.includes("planned by run-kept"), "other runs' claims survive");
  assert.ok(raw.includes("(expected: run-kept=absent)"), "durable expectation preserved");
  assert.ok(!existsSync(join(root, "features", "cancel-a.md")));
});

test("a crashed owner's lease never blocks competing processes (dead-owner tombstone reclaim under a real race)", async () => {
  const { dir, root } = makeRoot("reclaim");
  const childScript = join(dir, "child.mjs");
  writeFileSync(childScript, CHILD_SCRIPT, "utf8");

  // A crashed engine left a well-formed lease directory behind (its process
  // no longer exists). The old protocol would have age-taken-over a stale
  // .lock FILE; the directory lease reclaims via a retained tombstone.
  const deadPid = await makeDeadPid();
  const lock = join(root, ".lock");
  const deadToken = "crashed-memory-engine";
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: deadPid, token: deadToken, acquiredAt: new Date().toISOString() }),
    "utf8",
  );

  const N = 3;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => runChild(childScript, root, `run-${i}`)),
  );

  // Every child resolved exactly once despite racing behind the dead owner.
  const totalApplied = results.reduce((n, r) => n + r.applied.length, 0);
  const totalConflicts = results.reduce((n, r) => n + r.conflicts.length, 0);
  assert.equal(totalApplied + totalConflicts, N);
  assert.equal(results.filter((r) => r.action === "create").length, 1);

  // The final page holds exactly one child's body; claims were all spent.
  const final = readFileSync(join(root, "features", "race-page.md"), "utf8");
  assert.equal((final.match(/Decision run-\d+ wrote this page/g) ?? []).length, 1);
  assert.ok(!readFileSync(join(root, "index.md"), "utf8").includes("planned by run-"));

  // The dead owner's tombstone was retained through the whole contention and
  // the lease itself was vacated once the last promote finished.
  const tombstone = reclaimedTombstonePath(lock, deadToken);
  assert.ok(existsSync(tombstone), "the crashed owner's tombstone is retained");
  assert.equal(
    JSON.parse(readFileSync(join(tombstone, "owner.json"), "utf8")).token,
    deadToken,
  );
  assert.ok(!existsSync(lock), "the reclaimed lease was vacated after the operations");
});

function mkBase(runId: string): MemoryProposal {
  return {
    page: "features/x",
    action: "create",
    body: "## Summary\n\nBody. See [[conventions]].\n",
    provenance: [runId],
    scope: "global",
    freshness: today(),
    verification: "verified",
    runId,
  };
}
