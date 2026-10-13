/**
 * Unit tests for the filesystem memory store.
 *
 * Mutual exclusion between independent processes is a directory lease
 * (domain/lease.ts) published at `<root>/.lock/owner.json`: a LIVE owner is
 * refused (age is never a takeover criterion) and a DEAD owner (crashed
 * process) is reclaimed, leaving its token's tombstone retained. The old
 * age-based `.lock` FILE protocol — stale files were taken over by mtime —
 * is gone: a leftover lock FILE now fails closed with manual recovery
 * instructions instead of being stolen or auto-replaced.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FsMemoryStore } from "../../extensions/gx-dev/memory/store.ts";
import { acquireFileLease, reclaimedTombstonePath } from "../../extensions/gx-dev/domain/lease.ts";
import type { MemoryCoordinator, MemoryProposal } from "../../extensions/gx-dev/domain/interfaces.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

let counter = 0;

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  counter += 1;
  return {
    page: `decisions/test-page-${counter}`,
    action: "create",
    body: "## Summary\n\nA decision body.\n\nSee [[conventions]].\n",
    provenance: ["researcher:run-a"],
    scope: "global",
    freshness: new Date().toISOString().slice(0, 10),
    verification: "verified",
    runId: "run-a",
    ...overrides,
  };
}

function makeRoot(): string {
  const repo = mkdtempSync(join(tmpdir(), "gx-mem-"));
  tempDirs.push(repo);
  return join(repo, ".gx-dev", "memory");
}

function logLines(root: string): number {
  return readFileSync(join(root, "log.md"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("- ")).length;
}

function lockPathOf(root: string): string {
  return join(root, ".lock");
}

/** The owner record of a published lease directory. */
function readOwner(lock: string): { pid: number; token: string; acquiredAt: string } {
  return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as {
    pid: number;
    token: string;
    acquiredAt: string;
  };
}

/** Publishes a lease directory exactly as domain/lease.ts would. */
function forgeOwner(lock: string, owner: { pid: number; token: string; acquiredAt: string }): void {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), "utf8");
}

/** A real, provably gone pid: spawn a child, SIGKILL it, await its exit. */
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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

test("constructor scaffolds index, log, SCHEMA and subdirectories", () => {
  const root = makeRoot();
  new FsMemoryStore(root, { redact: true });
  assert.ok(existsSync(join(root, "index.md")));
  assert.ok(existsSync(join(root, "log.md")));
  assert.ok(existsSync(join(root, "SCHEMA.md")));
  for (const dir of ["decisions", "features", "failures", "sources", "pins"]) {
    assert.ok(existsSync(join(root, dir)), `missing dir ${dir}`);
  }
});

test("scaffolded wiki passes lint", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  const result = await store.lint();
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
});

test("reserve then promote happy path", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root, { redact: true });
  const p = proposal();
  const adjusted = await store.reserve([p]);
  const a0 = adjusted[0];
  assert.ok(a0);
  assert.equal(a0.action, "create");
  assert.notEqual(a0, p); // adjusted copies, inputs unmutated

  const first = await store.promote(adjusted);
  assert.deepEqual(first.conflicts, []);
  assert.deepEqual(first.applied, [p.page]);

  const file = join(root, `${p.page}.md`);
  assert.ok(existsSync(file));
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.includes("provenance: researcher:run-a"));
  assert.ok(raw.includes("verification: verified"));
  assert.ok(raw.includes("## Summary"));
  assert.ok(raw.includes("[[conventions]]"));

  const indexRaw = readFileSync(join(root, "index.md"), "utf8");
  assert.ok(indexRaw.includes(`[[${p.page}]]`));
  assert.ok(!indexRaw.includes("planned by run-a")); // claim cleared after promote

  assert.equal(logLines(root), 1);

  const second = await store.promote([{ ...a0, action: "update", body: "## Summary\n\nRevised.\n" }]);
  assert.deepEqual(second.conflicts, []);
  assert.equal(logLines(root), 2);
});

test("two concurrent reserves: conflicting create degrades to update", async () => {
  const root = makeRoot();
  const a = new FsMemoryStore(root);
  const b = new FsMemoryStore(root);
  const pa = proposal({ page: "features/shared", runId: "run-a" });
  const pb = proposal({ page: "features/shared", runId: "run-b", body: "## Summary\n\nB variant.\n" });

  const [ra, rb] = await Promise.all([a.reserve([pa]), b.reserve([pb])]);
  const actions = new Set([ra[0]?.action, rb[0]?.action]);
  assert.deepEqual(actions, new Set(["create", "update"]));

  const promotedA = await a.promote(ra);
  assert.deepEqual(promotedA.conflicts, []);

  // b's reserved revision (absent) no longer matches: conditional write trips.
  const promotedB = await b.promote(rb);
  assert.ok(promotedB.conflicts.includes("features/shared"));

  // After re-reserving, the degraded update lands.
  const pb2 = proposal({ page: "features/shared", action: "update", runId: "run-b", body: "## Summary\n\nB lands.\n" });
  const rb2 = await b.reserve([pb2]);
  assert.equal(rb2[0]?.action, "update");
  const ok = await b.promote(rb2);
  assert.deepEqual(ok.conflicts, []);
  assert.ok(readFileSync(join(root, "features", "shared.md"), "utf8").includes("B lands."));
});

test("create for an already existing page degrades to update", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  const seed = proposal({ page: "testing" });
  await store.promote([seed]);
  const later = proposal({ page: "testing", runId: "run-c" });
  const adjusted = await store.reserve([later]);
  assert.equal(adjusted[0]?.action, "update");
});

test("promote aborts to conflicts when the page changed since reserve", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  await store.promote([proposal({ page: "architecture" })]);
  const upd = proposal({ page: "architecture", action: "update", runId: "run-x", body: "## Summary\n\nUpdated body.\n" });
  const adjusted = await store.reserve([upd]);

  const before = logLines(root);
  writeFileSync(
    join(root, "architecture.md"),
    "---\nprovenance: someone-else\n---\n\n## Summary\n\nExternal edit.\n",
    "utf8",
  );

  const result = await store.promote(adjusted);
  assert.deepEqual(result.applied, []);
  assert.ok(result.conflicts.includes("architecture"));
  assert.equal(logLines(root), before); // conflicts leave no log line
});

test("redaction is applied on promote only when enabled", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gx-mem-"));
  tempDirs.push(repo);
  const on = new FsMemoryStore(join(repo, "on", ".gx-dev", "memory"), { redact: true });
  const off = new FsMemoryStore(join(repo, "off", ".gx-dev", "memory"));

  const body = "## Summary\n\nThe password: supersecret99 stays out.\n";
  const p1 = proposal({ body });
  await on.promote([p1]);
  const rawOn = readFileSync(join(repo, "on", ".gx-dev", "memory", `${p1.page}.md`), "utf8");
  assert.ok(rawOn.includes("[REDACTED:assignment]"));
  assert.ok(!rawOn.includes("supersecret99"));

  const p2 = proposal({ body });
  await off.promote([p2]);
  const rawOff = readFileSync(join(repo, "off", ".gx-dev", "memory", `${p2.page}.md`), "utf8");
  assert.ok(rawOff.includes("supersecret99"));
});

test("search returns matching pages with frontmatter and revision hash", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  await store.promote([
    proposal({ page: "architecture", body: "## Summary\n\nWe use SQLite for local storage. See [[conventions]].\n" }),
    proposal({ page: "conventions", body: "## Summary\n\nPrettier formatting everywhere. See [[testing]].\n" }),
  ]);
  const hits = await store.search("sqlite", 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]?.name, "architecture");
  const hit = hits[0];
  assert.ok(hit);
  assert.equal(hit.revision.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(hit.revision));
  assert.equal(hit.frontmatter["scope"], "global");
  assert.ok(hit.body.includes("SQLite"));
  assert.deepEqual(await store.search("prettier", 5).then((hs) => hs.map((h) => h.name)), ["conventions"]);
  assert.deepEqual(await store.search("", 5), []);
});

test("lint reports issues from disk pages", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  writeFileSync(
    join(root, "features", "broken.md"),
    "---\nscope: x\n---\n\nBroken page linking [[missing-thing]].\n",
    "utf8",
  );
  const result = await store.lint();
  assert.equal(result.ok, false);
  const joined = result.issues.join("\n");
  assert.ok(joined.includes("provenance"));
  assert.ok(joined.includes("missing-thing"));
  assert.ok(joined.includes("features/broken"));
});

test("log.md grows exactly one line per promote", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  const p1 = proposal();
  const p2 = proposal({ action: "update", runId: "run-b" });
  await store.promote([p1]);
  assert.equal(logLines(root), 1);
  await store.promote([p2]);
  assert.equal(logLines(root), 2);
  const log = readFileSync(join(root, "log.md"), "utf8");
  assert.ok(log.includes(` ${p1.runId} create ${p1.page}`));
  assert.ok(log.includes(` ${p2.runId} update ${p2.page}`));
});

test("unsafe and generated page names are rejected on reserve and promote", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  const unsafe = [
    "../evil",
    "a/../b",
    "/abs/path",
    "features/./x",
    "features//x",
    "a\\\\b",
    "features/trailing/",
    ".",
    "..",
    "  spaced  ",
  ];
  for (const name of unsafe) {
    await assert.rejects(() => store.reserve([proposal({ page: name })]), /unsafe memory page name/);
    await assert.rejects(() => store.promote([proposal({ page: name })]), /unsafe memory page name/);
  }
  // index.md and log.md are store-generated; promotion must not clobber them.
  for (const name of ["index", "log"]) {
    await assert.rejects(() => store.reserve([proposal({ page: name })]), /generated/);
    await assert.rejects(() => store.promote([proposal({ page: name })]), /generated/);
  }
  // Nothing was written outside the root or into the namespace dirs.
  assert.ok(!existsSync(join(root, "evil.md")));
  assert.equal(readFileSync(join(root, "index.md"), "utf8").includes("[["), true);
});

test("promote redacts inherited frontmatter as well as body", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root, { redact: true });
  writeFileSync(
    join(root, "features", "leaky.md"),
    [
      "---",
      "provenance: earlier-run",
      "scope: global",
      "freshness: 2025-01-01",
      "verification: NOT VERIFIED",
      "confidence: low",
      "updated: 2025-01-01",
      "gh_token: ghp_APIKEYSAMPLE12345",
      "---",
      "",
      "## Summary",
      "",
      "Old body. See [[conventions]].",
      "",
    ].join("\n"),
    "utf8",
  );
  const p = proposal({
    page: "features/leaky",
    action: "update",
    body: "## Summary\n\npassword: hunter2x stays hidden. See [[conventions]].\n",
  });
  const result = await store.promote([p]); // no reserve: still safe, still redacted
  assert.deepEqual(result.conflicts, []);
  const raw = readFileSync(join(root, "features", "leaky.md"), "utf8");
  assert.ok(raw.includes("[REDACTED:api-token]"), "frontmatter token redacted");
  assert.ok(raw.includes("[REDACTED:assignment]"), "body assignment redacted");
  assert.ok(!raw.includes("ghp_"));
  assert.ok(!raw.includes("hunter2x"));
  assert.ok(raw.includes("gh_token: [REDACTED:api-token]"), "inherited key kept, value redacted");
  assert.ok(raw.includes("confidence: low"), "unrelated inherited fields preserved");
});

test("lintProposals previews structural issues without blocking promote", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  assert.deepEqual(store.lintProposals([proposal()]), { ok: true, issues: [] });

  const bad = proposal({
    page: "features/proposed",
    body: "No summary heading and no links.",
    provenance: [],
    scope: "",
    freshness: "not-a-date",
  });
  const preview = store.lintProposals([bad]);
  assert.equal(preview.ok, false);
  const joined = preview.issues.join("\n");
  assert.ok(joined.includes("features/proposed: missing required heading '## Summary'"));
  assert.ok(joined.includes("orphan risk"));
  assert.ok(joined.includes("provenance has no entries"));
  assert.ok(joined.includes("scope is empty"));
  assert.ok(joined.includes("freshness is not an ISO date"));

  // Advisory only: promote still applies reviewed content with lint findings.
  const result = await store.promote([{ ...bad, provenance: ["reviewer:x"] }]);
  assert.deepEqual(result.applied, ["features/proposed"]);

  // Broken links resolve against disk pages and the proposed set.
  const crossLink = proposal({
    page: "features/linking",
    body: "## Summary\n\nSee [[features/proposed]] and [[missing-page]].\n",
  });
  const linkPreview = store.lintProposals([crossLink]);
  assert.ok(linkPreview.issues.join("\n").includes("broken [[link]] target 'missing-page'"));
  assert.ok(!linkPreview.issues.some((i) => i.includes("features/proposed]]")));

  // Secret-like bodies are flagged; mutable state smells surface too.
  const flagged = store.lintProposals([
    proposal({ body: "## Summary\n\ntoken: superspecialtoken99. See [[conventions]].\n" }),
    proposal({ body: `## Summary\n\nDeployed ${"a".repeat(40)} today. See [[conventions]].\n` }),
  ]);
  const flaggedJoined = flagged.issues.join("\n");
  assert.ok(flaggedJoined.includes("secret-like content"));
  assert.ok(flaggedJoined.includes("copied mutable state"));
});

test("reserved revisions are durable across store restarts", async () => {
  const root = makeRoot();
  const first = new FsMemoryStore(root);
  const p = proposal({ page: "features/durable", runId: "run-1" });
  const reserved = await first.reserve([p]);
  assert.equal(reserved[0]?.action, "create");
  // The durable claim carries the run's expected revision.
  const indexRaw = readFileSync(join(root, "index.md"), "utf8");
  assert.ok(indexRaw.includes("planned by run-1 (expected: run-1=absent)"));

  // A fresh instance (restart) reloads the expectation from disk.
  const restarted = new FsMemoryStore(root);
  const ok = await restarted.promote(reserved); // page unchanged since reserve
  assert.deepEqual(ok.applied, ["features/durable"]);
  assert.deepEqual(ok.conflicts, []);

  // And the same for a second reservation taken by yet another instance.
  const third = new FsMemoryStore(root);
  const upd = proposal({
    page: "features/durable",
    action: "update",
    runId: "run-2",
    body: "## Summary\n\nNewer. See [[conventions]].\n",
  });
  const reserved2 = await third.reserve([upd]);
  writeFileSync(
    join(root, "features", "durable.md"),
    "---\nprovenance: external\n---\n\n## Summary\n\nExternal edit. See [[conventions]].\n",
    "utf8",
  );
  const conflicted = await third.promote(reserved2);
  assert.deepEqual(conflicted.applied, []);
  assert.ok(conflicted.conflicts.includes("features/durable"));
  assert.ok(!readFileSync(join(root, "features", "durable.md"), "utf8").includes("Newer."));
});

test("conflicts and release(runId) clear reservation claims", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  const p = proposal({ page: "features/clearme", runId: "run-z" });
  await store.reserve([p]);
  const index = () => readFileSync(join(root, "index.md"), "utf8");
  assert.ok(index().includes("planned by run-z"));

  writeFileSync(
    join(root, "features", "clearme.md"),
    "---\nprovenance: x\n---\n\n## Summary\n\nRace winner. See [[conventions]].\n",
    "utf8",
  );
  const result = await store.promote([p]);
  assert.ok(result.conflicts.includes("features/clearme"));
  assert.ok(!index().includes("planned by run-z"), "conflicted claim is dropped");

  // release(runId) drops claims without promoting anything.
  const other = proposal({ page: "features/cancelled", runId: "run-q" });
  await store.reserve([other]);
  assert.ok(index().includes("planned by run-q"));
  await store.release("run-q");
  assert.ok(!index().includes("planned by run-q"));
  assert.ok(!existsSync(join(root, "features", "cancelled.md")), "release never writes pages");
  // Releasing an unknown run is a no-op.
  await store.release("run-q");
});

test("constructor scaffolding never overwrites existing pages (exclusive create)", () => {
  const repo = mkdtempSync(join(tmpdir(), "gx-mem-"));
  tempDirs.push(repo);
  const root = join(repo, ".gx-dev", "memory");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "architecture.md"),
    "---\nprovenance: human\n---\n\n## Summary\n\nHand written by a user.\n",
    "utf8",
  );
  new FsMemoryStore(root); // racing scaffold must not placeholder the page
  assert.match(readFileSync(join(root, "architecture.md"), "utf8"), /Hand written by a user\./);
  // The remaining core pages still scaffold, and the store stays consistent.
  assert.ok(existsSync(join(root, "project-overview.md")));
  assert.ok(existsSync(join(root, "testing.md")));
});

test("a live memory lease is refused regardless of age; the holder is named and the lock is never touched", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root, { lockRetryMs: 150 });
  const lock = lockPathOf(root);
  // A LIVE owner recorded 30 days ago: under the old protocol its lock file
  // would eventually be age-taken-over; now age is irrelevant — it is held.
  forgeOwner(lock, { pid: process.pid, token: "live-old-owner", acquiredAt: daysAgoIso(30) });

  await assert.rejects(() => store.reserve([proposal()]), /held by pid/);
  await assert.rejects(() => store.promote([proposal()]), /held by pid/);
  assert.equal(readOwner(lock).token, "live-old-owner", "the refused acquirer never modified the lock");

  // Manual recovery (the holder releases) unblocks the store immediately.
  rmSync(lock, { recursive: true, force: true });
  const adjusted = await store.reserve([proposal()]);
  const result = await store.promote(adjusted);
  assert.deepEqual(result.conflicts, []);
  assert.ok(!existsSync(lock), "the store vacates the lease after each operation");
});

test("a foreign process holding the lease blocks store operations, then releases them", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root, { lockRetryMs: 150 });
  const lock = lockPathOf(root);
  const hold = await acquireFileLease(lock);
  await assert.rejects(() => store.reserve([proposal()]), /held by pid/);
  assert.equal(readOwner(lock).pid, process.pid, "the lease stayed with its owner");
  await hold();
  assert.ok(!existsSync(lock), "release vacated the lease");
  const adjusted = await store.reserve([proposal()]);
  assert.equal(adjusted[0]?.action, "create");
});

test("a crashed owner's lease is reclaimed through the store; the dead owner's tombstone is retained", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  const lock = lockPathOf(root);
  const deadPid = await makeDeadPid();
  forgeOwner(lock, { pid: deadPid, token: "dead-memory-owner", acquiredAt: daysAgoIso(30) });
  const tombstone = reclaimedTombstonePath(lock, "dead-memory-owner");

  const p = proposal();
  const adjusted = await store.reserve([p]); // reclaims on the first attempt
  const result = await store.promote(adjusted);
  assert.deepEqual(result.conflicts, []);
  assert.ok(existsSync(join(root, `${p.page}.md`)), "the reclaimed store applied the write");

  // The dead owner's record lives on in the permanently retained tombstone.
  assert.ok(existsSync(tombstone), "the tombstone is retained");
  assert.equal(JSON.parse(readFileSync(join(tombstone, "owner.json"), "utf8")).token, "dead-memory-owner");
  assert.ok(!existsSync(lock), "the store vacated the reclaimed lease after the operation");
});

test("unusable locks fail closed: ownerless, corrupt, and legacy lock FILE objects are never modified; manual recovery unblocks", async () => {
  const root = makeRoot();
  const store = new FsMemoryStore(root);
  const lock = lockPathOf(root);

  // An ownerless lock directory: never guessed dead, never reclaimed, never
  // deleted, never written to.
  mkdirSync(lock, { recursive: true });
  await assert.rejects(() => store.reserve([proposal()]), /owner record/);
  assert.deepEqual(readdirSync(lock), [], "the ownerless lock was left untouched");
  rmSync(lock, { recursive: true, force: true });

  // A lock directory with a garbage owner record: refused, content preserved.
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), "not json at all", "utf8");
  await assert.rejects(() => store.promote([proposal()]), /owner record/);
  assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), "not json at all");
  rmSync(lock, { recursive: true, force: true });

  // A leftover lock FILE from the old .lock protocol: never age-taken-over,
  // never auto-replaced — the store fails closed with manual instructions.
  const legacy = JSON.stringify({ pid: 4242424, at: "2020-01-01T00:00:00.000Z" });
  writeFileSync(lock, legacy, "utf8");
  await assert.rejects(() => store.release("run-a"), /legacy lock FILE/);
  await assert.rejects(() => store.reserve([proposal()]), /legacy lock FILE/);
  assert.equal(readFileSync(lock, "utf8"), legacy, "the legacy file was not modified");

  // Manual recovery (remove the file, as the error instructs) unblocks.
  rmSync(lock, { force: true });
  await store.release("run-a"); // no claims: a no-op that now succeeds
  const adjusted = await store.reserve([proposal()]);
  assert.equal(adjusted[0]?.action, "create");
});

test("FsMemoryStore remains assignable to the MemoryCoordinator contract", async () => {
  const store: MemoryCoordinator = new FsMemoryStore(makeRoot());
  assert.equal(typeof store.reserve, "function");
  assert.equal(typeof store.promote, "function");
  assert.equal(typeof store.search, "function");
  assert.equal(typeof store.lint, "function");
  const { applied, conflicts } = await store.promote([]);
  assert.deepEqual({ applied, conflicts }, { applied: [], conflicts: [] });
});
