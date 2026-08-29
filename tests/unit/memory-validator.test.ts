import assert from "node:assert/strict";
import { test } from "node:test";

import { serializePage } from "../../extensions/gx-dev/memory/wiki.ts";
import { lintPage, lintWiki } from "../../extensions/gx-dev/memory/validator.ts";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function fm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    provenance: "researcher:run-1; tests:run-1",
    scope: "global",
    freshness: isoDaysAgo(2),
    verification: "verified",
    confidence: "high",
    updated: isoDaysAgo(0),
    ...overrides,
  };
}

const GOOD_BODY = "## Summary\n\nUses SQLite. See [[conventions]].\n";

test("clean page produces no issues", () => {
  assert.deepEqual(lintPage("conventions", serializePage(fm(), GOOD_BODY)), []);
});

test("missing provenance is flagged", () => {
  const issues = lintPage(
    "features/x",
    serializePage({ scope: "global", freshness: isoDaysAgo(1), verification: "verified", confidence: "high", updated: isoDaysAgo(1) }, GOOD_BODY),
  );
  assert.ok(issues.some((i) => i.includes("missing frontmatter field 'provenance'")));
});

test("all missing required fields are flagged individually", () => {
  const issues = lintPage("features/x", serializePage({}, GOOD_BODY));
  for (const field of ["provenance", "scope", "freshness", "verification", "confidence", "updated"]) {
    assert.ok(issues.some((i) => i.includes(`'${field}'`)), `expected issue for ${field}`);
  }
});

test("NOT VERIFIED older than freshness+30d is stale-unverified", () => {
  const stale = lintPage(
    "architecture",
    serializePage(fm({ verification: "NOT VERIFIED", freshness: isoDaysAgo(40) }), GOOD_BODY),
  );
  assert.ok(stale.some((i) => i.includes("stale-unverified")));

  const fresh = lintPage(
    "architecture",
    serializePage(fm({ verification: "NOT VERIFIED", freshness: isoDaysAgo(5) }), GOOD_BODY),
  );
  assert.ok(!fresh.some((i) => i.includes("stale-unverified")));

  const verifiedOld = lintPage(
    "architecture",
    serializePage(fm({ freshness: isoDaysAgo(40) }), GOOD_BODY),
  );
  assert.ok(!verifiedOld.some((i) => i.includes("stale-unverified")));
});

test("missing '## Summary' heading is flagged", () => {
  const issues = lintPage("conventions", serializePage(fm(), "No headings at all here.\n"));
  assert.ok(issues.some((i) => i.includes("missing required heading '## Summary'")));
});

test("orphan risk: content page without outbound links", () => {
  const orphan = lintPage("conventions", serializePage(fm(), "## Summary\n\nNo links here.\n"));
  assert.ok(orphan.some((i) => i.includes("orphan risk")));
  assert.deepEqual(lintPage("conventions", serializePage(fm(), GOOD_BODY)), []);
});

test("copied mutable state: SHA-40 literals and 'currently <n>'", () => {
  const body = "## Summary\n\nDeployed 1234567890abcdef1234567890abcdef12345678 and currently 42 failures. See [[conventions]].\n";
  const issues = lintPage("failures/flake", serializePage(fm(), body));
  const mutable = issues.filter((i) => i.includes("copied mutable state"));
  assert.equal(mutable.length, 2);
});

test("generated pages (index, log) are not hand-validated", () => {
  assert.deepEqual(lintPage("index", "anything at all, no frontmatter"), []);
  assert.deepEqual(lintPage("log", "---\nweird: stuff\n---\nbody"), []);
});

test("lintWiki reports broken [[link]] targets cross-page", () => {
  const broken = lintWiki([{ name: "architecture", raw: serializePage(fm(), GOOD_BODY) }]);
  assert.ok(broken.some((i) => i.includes("broken [[link]]") && i.includes("conventions")));

  const ok = lintWiki([
    { name: "architecture", raw: serializePage(fm(), GOOD_BODY) },
    { name: "conventions", raw: serializePage(fm(), "## Summary\n\nRules. See [[architecture]].\n") },
  ]);
  assert.ok(!ok.some((i) => i.includes("broken [[link]]")));
});

test("lintWiki flags contradiction candidates across pages", () => {
  const issues = lintWiki([
    { name: "architecture", raw: serializePage(fm(), "## Summary\n\nWe must use SQLite for local storage. See [[conventions]].\n") },
    { name: "decisions/db", raw: serializePage(fm(), "## Summary\n\nWe must not use SQLite for local storage. See [[testing]].\n") },
    { name: "conventions", raw: serializePage(fm(), "## Summary\n\nSee [[architecture]].\n") },
    { name: "testing", raw: serializePage(fm(), "## Summary\n\nSee [[decisions/db]].\n") },
  ]);
  assert.ok(issues.some((i) => i.includes("contradiction candidate") && i.includes("sqlite")));
});

test("agreement in polarity is not a contradiction", () => {
  const issues = lintWiki([
    { name: "architecture", raw: serializePage(fm(), "## Summary\n\nWe must use SQLite for local storage. See [[conventions]].\n") },
    { name: "decisions/db", raw: serializePage(fm(), "## Summary\n\nWe must always use SQLite for local storage. See [[conventions]].\n") },
    { name: "conventions", raw: serializePage(fm(), "## Summary\n\nSee [[architecture]].\n") },
  ]);
  assert.ok(!issues.some((i) => i.includes("contradiction candidate")));
});
