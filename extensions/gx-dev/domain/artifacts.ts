/**
 * Artifact hashing and the immutable evidence store (PLAN §10.1, §5).
 * Raw evidence is append-only and content-addressed where practical.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

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

export interface EvidenceRecord {
  kind: EvidenceKind;
  /** File name relative to the kind directory. */
  name: string;
  hash: string;
  bytes: number;
  at: string;
  /** Provenance: which agent or command produced this. */
  source: string;
}

export interface ArtifactStore {
  /** Writes raw evidence; returns its record. Content-addressed name if provided name omitted. */
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
  private readonly records: EvidenceRecord[] = [];

  constructor(runDir: string) {
    this.runDir = runDir;
    for (const kind of EVIDENCE_KINDS) {
      mkdirSync(join(runDir, "evidence", kind), { recursive: true });
    }
  }

  recordEvidence(
    kind: EvidenceKind,
    content: string,
    source: string,
    name?: string,
  ): EvidenceRecord {
    const hash = hashContent(content);
    const fileName = name ?? `${hash}.txt`;
    const file = join(this.runDir, "evidence", kind, fileName);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    const record: EvidenceRecord = {
      kind,
      name: fileName,
      hash,
      bytes: Buffer.byteLength(content, "utf8"),
      at: new Date().toISOString(),
      source,
    };
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
    const hash = hashContent(content);
    const record: EvidenceRecord = {
      kind,
      name: name ?? `${hash}.txt`,
      hash,
      bytes: Buffer.byteLength(content, "utf8"),
      at: new Date().toISOString(),
      source,
    };
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
