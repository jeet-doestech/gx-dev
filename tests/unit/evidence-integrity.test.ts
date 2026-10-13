/**
 * Evidence integrity tests (REVIEW P0: "Evidence does not reliably describe
 * the code being promoted").
 *
 * Covers the artifact-store contract the gates and engine rely on:
 * - evidence filenames are immutable and content-addressed even when a
 *   logical name is supplied (the logical name is preserved as a prefix), so
 *   repeated gate attempts never overwrite one another;
 * - secrets are redacted through memory/redaction.ts BEFORE storage, and
 *   hashes/byte counts describe the stored (redacted) bytes;
 * - evidence metadata is durable: reopening an FsArtifactStore reloads the
 *   manifest instead of returning an empty evidence list.
 * Uses real filesystem stores in temp dirs; no pi APIs, no agents.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  EVIDENCE_MANIFEST_FILE,
  evidenceFileName,
  FsArtifactStore,
  hashContent,
  loadEvidenceManifest,
  MemoryArtifactStore,
  type EvidenceRecord,
} from "../../extensions/gx-dev/domain/artifacts.ts";
import { redactSecrets } from "../../extensions/gx-dev/memory/redaction.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gx-dev-evidence-"));
  tempDirs.push(dir);
  return dir;
}

function evidencePath(runDir: string, record: EvidenceRecord): string {
  return join(runDir, "evidence", record.kind, record.name);
}

describe("content-addressed evidence filenames", () => {
  it("names anonymous blobs <hash>.txt and stores their content", () => {
    const runDir = makeRunDir();
    const store = new FsArtifactStore(runDir);
    const record = store.recordEvidence("agent-output", "raw agent text", "developer");
    assert.equal(record.name, `${hashContent("raw agent text")}.txt`);
    assert.equal(readFileSync(evidencePath(runDir, record), "utf8"), "raw agent text");
    assert.equal(record.hash, hashContent("raw agent text"));
    assert.equal(record.bytes, Buffer.byteLength("raw agent text", "utf8"));
  });

  it("preserves a requested logical name as a prefix and suffixes the content hash", () => {
    const runDir = makeRunDir();
    const store = new FsArtifactStore(runDir);
    const record = store.recordEvidence(
      "commands",
      JSON.stringify({ attempt: 1 }),
      "test-gate",
      "test-gate-commands.json",
    );
    assert.equal(
      record.name,
      `test-gate-commands-${hashContent(JSON.stringify({ attempt: 1 }))}.json`,
    );
    assert.ok(record.name.startsWith("test-gate-commands-"));
  });

  it("never overwrites: a second attempt with the same logical name lands in a new file", () => {
    const runDir = makeRunDir();
    const store = new FsArtifactStore(runDir);
    const first = store.recordEvidence("commands", "attempt one output", "test-gate", "test-gate-commands.json");
    const second = store.recordEvidence("commands", "attempt two output", "test-gate", "test-gate-commands.json");
    assert.notEqual(first.name, second.name);
    assert.ok(existsSync(evidencePath(runDir, first)), "first attempt must survive");
    assert.ok(existsSync(evidencePath(runDir, second)), "second attempt must be stored");
    assert.equal(readFileSync(evidencePath(runDir, first), "utf8"), "attempt one output");
    assert.equal(readFileSync(evidencePath(runDir, second), "utf8"), "attempt two output");
    const files = readdirSync(join(runDir, "evidence", "commands"));
    assert.equal(files.length, 2);
  });

  it("keeps identical content idempotent: same name and bytes yield the same file", () => {
    const runDir = makeRunDir();
    const store = new FsArtifactStore(runDir);
    const first = store.recordEvidence("reviews", "same findings", "review-gate", "review-findings.json");
    const second = store.recordEvidence("reviews", "same findings", "review-gate", "review-findings.json");
    assert.equal(first.name, second.name);
    assert.equal(first.hash, second.hash);
    assert.equal(readdirSync(join(runDir, "evidence", "reviews")).length, 1);
  });

  it("treats extensionless logical names as one prefix", () => {
    assert.equal(evidenceFileName("researcher-1", "abc"), "researcher-1-abc");
    assert.equal(evidenceFileName(".gitignore", "abc"), ".gitignore-abc");
    assert.equal(evidenceFileName(undefined, "abc"), "abc.txt");
    assert.equal(evidenceFileName("  ", "abc"), "abc.txt");
  });

  it("mirrors the same naming scheme in the memory store", () => {
    const store = new MemoryArtifactStore();
    const record = store.recordEvidence("user-input", "the request", "user", "request.md");
    assert.equal(record.name, `request-${hashContent("the request")}.md`);
  });
});

describe("redaction before storage", () => {
  const secretBody = [
    "deploy log:",
    "aws key AKIAIOSFODNN7EXAMPLE used",
    "password: hunter2secret",
  ].join("\n");

  it("stores redacted bytes on disk, never the raw secrets", () => {
    const runDir = makeRunDir();
    const store = new FsArtifactStore(runDir);
    const record = store.recordEvidence("agent-output", secretBody, "developer", "agent-1.md");
    const stored = readFileSync(evidencePath(runDir, record), "utf8");
    assert.ok(!stored.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(!stored.includes("hunter2secret"));
    assert.ok(stored.includes("[REDACTED:api-token]"));
    assert.ok(stored.includes("[REDACTED:assignment]"));
    assert.equal(record.redactions, 2);
  });

  it("hashes and sizes the record after redaction", () => {
    const store = new MemoryArtifactStore();
    const record = store.recordEvidence("agent-output", secretBody, "developer");
    const redacted = redactSecrets(secretBody).text;
    assert.equal(record.hash, hashContent(redacted));
    assert.equal(record.bytes, Buffer.byteLength(redacted, "utf8"));
  });

  it("omits the redactions field when nothing secret was found", () => {
    const store = new MemoryArtifactStore();
    const record = store.recordEvidence("user-input", "please add a logout button", "user");
    assert.equal(record.redactions, undefined);
    assert.ok(!JSON.stringify(record).includes("redactions"));
  });
});

describe("durable evidence manifest", () => {
  it("reopening the store reloads evidence metadata from the manifest", () => {
    const runDir = makeRunDir();
    const first = new FsArtifactStore(runDir);
    const a = first.recordEvidence("commands", "cmd output one", "test-gate", "test-gate-output.txt");
    const b = first.recordEvidence("diffs", "diff --git a/x b/x", "developer", "developer.diff");

    const reopened = new FsArtifactStore(runDir);
    const records = reopened.evidence();
    assert.equal(records.length, 2, "reopened store must not report an empty evidence list");
    assert.deepEqual(
      records.map((r) => ({ kind: r.kind, name: r.name, hash: r.hash, source: r.source })),
      [
        { kind: a.kind, name: a.name, hash: a.hash, source: a.source },
        { kind: b.kind, name: b.name, hash: b.hash, source: b.source },
      ],
    );

    // The reopened store keeps appending.
    const c = reopened.recordEvidence("tests", "test log", "test-gate");
    assert.equal(reopened.evidence().length, 3);
    assert.ok(existsSync(evidencePath(runDir, c)));
  });

  it("appends one JSON line per record to evidence/" + EVIDENCE_MANIFEST_FILE, () => {
    const runDir = makeRunDir();
    const store = new FsArtifactStore(runDir);
    store.recordEvidence("commands", "out", "final-gate");
    store.recordEvidence("reviews", "findings", "review-gate");
    const manifest = join(runDir, "evidence", EVIDENCE_MANIFEST_FILE);
    assert.ok(existsSync(manifest));
    const lines = readFileSync(manifest, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as EvidenceRecord;
      assert.ok(typeof parsed.name === "string");
      assert.ok(typeof parsed.hash === "string");
    }
  });

  it("tolerates a torn trailing manifest line without losing earlier records", () => {
    const runDir = makeRunDir();
    const store = new FsArtifactStore(runDir);
    const record = store.recordEvidence("commands", "out", "test-gate");
    // Simulate a crash mid-append: a partial JSON line lands in the manifest.
    appendFileSync(join(runDir, "evidence", EVIDENCE_MANIFEST_FILE), '{"kind":"comm', "utf8");
    const reopened = new FsArtifactStore(runDir);
    assert.equal(reopened.evidence().length, 1);
    assert.equal(reopened.evidence()[0]!.name, record.name);
    assert.deepEqual(loadEvidenceManifest(join(runDir, "evidence", EVIDENCE_MANIFEST_FILE)).length, 1);
  });

  it("ignores manifest lines that are valid JSON but not evidence records", () => {
    const runDir = makeRunDir();
    new FsArtifactStore(runDir); // scaffolds evidence/ directories
    writeFileSync(join(runDir, "evidence", EVIDENCE_MANIFEST_FILE), '"just a string"\n', "utf8");
    assert.deepEqual(loadEvidenceManifest(join(runDir, "evidence", EVIDENCE_MANIFEST_FILE)), []);
  });

  it("hands out copies of its record list", () => {
    const store = new FsArtifactStore(makeRunDir());
    store.recordEvidence("commands", "out", "test-gate");
    const snapshot = store.evidence();
    snapshot.pop();
    assert.equal(store.evidence().length, 1);
  });
});
