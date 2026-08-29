import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FsMemoryStore } from "../../extensions/gx-dev/memory/store.ts";
import type { MemoryProposal } from "../../extensions/gx-dev/domain/interfaces.ts";

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
