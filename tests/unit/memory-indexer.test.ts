import assert from "node:assert/strict";
import { test } from "node:test";

import { bodyText, buildIndex, searchIndex, tokenize } from "../../extensions/gx-dev/memory/indexer.ts";

const PAGES = [
  { name: "heavy", raw: "---\nprovenance: run-1\n---\n\n## Summary\n\nsqlite sqlite sqlite notes about Sqlite.\n" },
  { name: "light", raw: "## Summary\n\nsqlite once only.\n" },
  { name: "other", raw: "## Summary\n\nPrettier formatting rules.\n" },
];

test("buildIndex tokenizes bodies, lowercases, strips markdown and frontmatter", () => {
  const index = buildIndex(PAGES);
  const heavy = index.find((e) => e.name === "heavy");
  assert.ok(heavy);
  assert.equal(heavy.termFreq["sqlite"], 4); // body only; frontmatter excluded
  assert.equal(heavy.termFreq["summary"], 1);
  assert.ok(!("provenance" in heavy.termFreq));
  assert.ok(!("run" in heavy.termFreq));
});

test("stopwords and bare numbers are excluded", () => {
  assert.deepEqual(tokenize("The quick brown fox and the 42 dogs"), ["quick", "brown", "fox", "dogs"]);
});

test("wiki links and markdown syntax are stripped, labels kept", () => {
  const text = bodyText("## Heading\n\n**bold** [[wiki link|alias]] and [label](https://x.y) text\n");
  const tokens = tokenize(text);
  for (const expected of ["heading", "bold", "wiki", "link", "alias", "label", "text"]) {
    assert.ok(tokens.includes(expected), `expected token ${expected} in ${JSON.stringify(tokens)}`);
  }
  assert.ok(!tokens.includes("https"));
});

test("index rebuild is deterministic", () => {
  const a = buildIndex(PAGES);
  const b = buildIndex(PAGES);
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test("searchIndex ranks by summed term frequency", () => {
  const index = buildIndex(PAGES);
  const hits = searchIndex(index, "sqlite", 10);
  assert.equal(hits[0]?.name, "heavy");
  assert.equal(hits[0]?.score, 4);
  assert.equal(hits[1]?.name, "light");
  assert.equal(hits[1]?.score, 1);
  assert.ok(!hits.some((h) => h.name === "other"));
});

test("pages named in indexNames are boosted x2", () => {
  const index = [
    { name: "plain", termFreq: { alpha: 1 } },
    { name: "listed", termFreq: { alpha: 1 } },
  ];
  const hits = searchIndex(index, "alpha", 10, ["listed"]);
  assert.equal(hits[0]?.name, "listed");
  assert.equal(hits[0]?.score, 2);
  assert.equal(hits[1]?.name, "plain");
  assert.equal(hits[1]?.score, 1);
});

test("limit is respected and empty queries return nothing", () => {
  const index = buildIndex(PAGES);
  assert.equal(searchIndex(index, "sqlite", 1).length, 1);
  assert.deepEqual(searchIndex(index, "the of and", 10), []);
  assert.deepEqual(searchIndex(index, "", 10), []);
});

test("ties break deterministically by name", () => {
  const index = [
    { name: "zeta", termFreq: { alpha: 2 } },
    { name: "beta", termFreq: { alpha: 2 } },
  ];
  const hits = searchIndex(index, "alpha", 10);
  assert.deepEqual(hits.map((h) => h.name), ["beta", "zeta"]);
});
