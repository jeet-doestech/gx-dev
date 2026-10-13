/**
 * Artifact hashing and the immutable evidence store (PLAN §10.1, §5).
 * Raw evidence is append-only and content-addressed: stored file names always
 * carry the SHA-256 of the (redacted) content, so repeated attempts never
 * overwrite one another even when a logical name is requested — the logical
 * name is preserved as a filename prefix. Evidence metadata is durable: the
 * filesystem store appends every record to a manifest and reloads it on
 * construction. All evidence is redacted through the shared redaction policy
 * before it touches disk or memory.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

import { redactSecrets } from "../memory/redaction.ts";

/** SHA-256 of UTF-8 content, hex, 16-char prefix is acceptable for display. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/** Evidence categories mirrored on disk under .gx-dev/runs/<run-id>/evidence/. */
export const EVIDENCE_KINDS = [
  "user-input",
  "web",
  "agent-output",
  "commands",
  "diffs",
  "tests",
  "reviews",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Evidence metadata manifest, appended under evidence/ and reloaded on open. */
export const EVIDENCE_MANIFEST_FILE = "manifest.jsonl";

export interface EvidenceRecord {
  kind: EvidenceKind;
  /** Content-addressed file name relative to the kind directory. */
  name: string;
  hash: string;
  bytes: number;
  at: string;
  /** Provenance: which agent or command produced this. */
  source: string;
  /** Secret-redaction replacements applied before storage (absent when none). */
  redactions?: number;
}

/**
 * Immutable, content-addressed evidence file name. A requested logical name
 * is preserved as a prefix and suffixed with the full content hash, so two
 * attempts writing "test-gate-commands.json" produce
 * "test-gate-commands-<hash1>.json" and "test-gate-commands-<hash2>.json"
 * instead of overwriting one another. Without a logical name the blob is
 * named "<hash>.txt".
 */
export function evidenceFileName(name: string | undefined, hash: string): string {
  if (name === undefined || name.trim() === "") return `${hash}.txt`;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${stem}-${hash}${ext}`;
}

interface StoredEvidence {
  content: string;
  hash: string;
  redactions: number;
}

/** Redact secrets first; hash and store exactly what lands on disk. */
function prepareEvidence(content: string): StoredEvidence {
  const redaction = redactSecrets(content);
  return {
    content: redaction.text,
    hash: hashContent(redaction.text),
    redactions: redaction.found,
  };
}

function buildRecord(
  kind: EvidenceKind,
  stored: StoredEvidence,
  source: string,
  at: string,
  name?: string,
): EvidenceRecord {
  return {
    kind,
    name: evidenceFileName(name, stored.hash),
    hash: stored.hash,
    bytes: Buffer.byteLength(stored.content, "utf8"),
    at,
    source,
    ...(stored.redactions > 0 ? { redactions: stored.redactions } : {}),
  };
}

/** Loads a JSONL evidence manifest, tolerating a torn trailing line. */
export function loadEvidenceManifest(file: string): EvidenceRecord[] {
  if (!existsSync(file)) return [];
  const records: EvidenceRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === "object" && parsed !== null &&
        typeof (parsed as EvidenceRecord).name === "string" &&
        typeof (parsed as EvidenceRecord).hash === "string" &&
        typeof (parsed as EvidenceRecord).kind === "string"
      ) {
        records.push(parsed as EvidenceRecord);
      }
    } catch {
      // A torn/corrupt line must not brick the store; keep the readable prefix.
    }
  }
  return records;
}

export interface ArtifactStore {
  /**
   * Redacts and writes raw evidence; returns its record. The stored file name
   * is always content-addressed: a supplied logical name is kept as a prefix
   * and suffixed with the content hash, so records are never overwritten.
   */
  recordEvidence(
    kind: EvidenceKind,
    content: string,
    source: string,
    name?: string,
  ): EvidenceRecord;
  /** Reads a run artifact (requirements.md, plan.md, ...). */
  readArtifact(name: string): string | null;
  /** Writes/overwrites a run artifact and returns its hash. */
  writeArtifact(name: string, content: string): string;
  evidence(): EvidenceRecord[];
  runDir: string;
}

export class FsArtifactStore implements ArtifactStore {
  readonly runDir: string;
  private readonly records: EvidenceRecord[];
  private readonly manifestPath: string;

  constructor(runDir: string) {
    this.runDir = runDir;
    this.manifestPath = join(runDir, "evidence", EVIDENCE_MANIFEST_FILE);
    for (const kind of EVIDENCE_KINDS) {
      mkdirSync(join(runDir, "evidence", kind), { recursive: true });
    }
    // Durable reload: evidence metadata survives reopening the store.
    this.records = loadEvidenceManifest(this.manifestPath);
  }

  recordEvidence(
    kind: EvidenceKind,
    content: string,
    source: string,
    name?: string,
  ): EvidenceRecord {
    const stored = prepareEvidence(content);
    const record = buildRecord(kind, stored, source, new Date().toISOString(), name);
    const file = join(this.runDir, "evidence", kind, record.name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, stored.content, "utf8");
    // Manifest append after the blob exists: a manifest line implies its file.
    appendFileSync(this.manifestPath, `${JSON.stringify(record)}\n`, "utf8");
    this.records.push(record);
    return record;
  }

  readArtifact(name: string): string | null {
    const file = join(this.runDir, name);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  }

  writeArtifact(name: string, content: string): string {
    const file = join(this.runDir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    return hashContent(content);
  }

  evidence(): EvidenceRecord[] {
    return [...this.records];
  }
}

/** In-memory store for tests. */
export class MemoryArtifactStore implements ArtifactStore {
  readonly runDir = "<memory>";
  private readonly evidenceRecords: EvidenceRecord[] = [];
  private readonly artifacts = new Map<string, string>();

  recordEvidence(
    kind: EvidenceKind,
    content: string,
    source: string,
    name?: string,
  ): EvidenceRecord {
    const stored = prepareEvidence(content);
    const record = buildRecord(kind, stored, source, new Date().toISOString(), name);
    this.evidenceRecords.push(record);
    return record;
  }

  readArtifact(name: string): string | null {
    return this.artifacts.get(name) ?? null;
  }

  writeArtifact(name: string, content: string): string {
    this.artifacts.set(name, content);
    return hashContent(content);
  }

  evidence(): EvidenceRecord[] {
    return [...this.evidenceRecords];
  }
}
