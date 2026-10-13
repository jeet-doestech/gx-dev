/**
 * Run persistence (PLAN §10.4): state.json is operational truth.
 * Writes are atomic (unique tmp + rename) so restarts never see torn state,
 * and concurrent writers never clobber one another's temp file.
 *
 * Hardening (REVIEW §1 "Make lifecycle durable"):
 * - Run ids are validated as plain directory names (no path traversal) on
 *   every save/load/list; malformed ids fail closed instead of escaping
 *   `.gx-dev/runs/`.
 * - Loaded states must be minimally well-formed (object with a valid runId
 *   matching the directory and a non-empty state name) or they read as null.
 * - FsRunStore implements the optional repository execution lease
 *   (`RunStore.acquireLease`): an exclusive pid/token directory lease under the
 *   runs root with dead-owner reclaim (see domain/lease.ts).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RunState } from "./state.ts";
import type { RunStore } from "./interfaces.ts";
import { acquireFileLease, type LeaseRelease } from "./lease.ts";

export function runsRoot(repoPath: string): string {
  return join(repoPath, ".gx-dev", "runs");
}

export function runDir(repoPath: string, runId: string): string {
  return join(runsRoot(repoPath), runId);
}

/** Filename of the repository-level execution lease inside the runs root. */
export const EXECUTION_LEASE_FILENAME = "execution.lock";

/**
 * A run id is a plain directory name under `.gx-dev/runs/`: alphanumerics
 * with limited punctuation, never a path. Anything else (traversal like
 * `../x`, nested `a/b`, empty, absurdly long) is rejected fail-closed.
 */
export function isValidRunId(runId: unknown): runId is string {
  return (
    typeof runId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) &&
    !runId.includes("..")
  );
}

/** Minimal shape sanity for a parsed state.json (recovery.ts checks deeper). */
function isRunStateShaped(value: unknown): value is RunState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as { runId?: unknown; state?: unknown };
  return isValidRunId(v.runId) && typeof v.state === "string" && v.state.length > 0;
}

export class FsRunStore implements RunStore {
  private readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async save(state: RunState): Promise<void> {
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("FsRunStore.save: refusing to persist a non-object run state");
    }
    if (!isValidRunId(state.runId)) {
      throw new Error(`FsRunStore.save: refusing invalid run id ${JSON.stringify(state.runId)}`);
    }
    if (typeof state.state !== "string" || state.state.length === 0) {
      throw new Error(`FsRunStore.save: refusing to persist run ${state.runId} without a state name`);
    }
    const dir = runDir(this.repoPath, state.runId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "state.json");
    // Unique temp name per writer: two processes persisting the same run
    // never overwrite each other's tmp file, and residue from a crashed
    // writer can never be renamed onto state.json by a later save.
    const tmp = join(dir, `state.json.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      renameSync(tmp, file);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      throw e;
    }
  }

  async load(runId: string): Promise<RunState | null> {
    // Fail closed on traversal or malformed ids: a run id is a plain
    // directory name, never a path.
    if (!isValidRunId(runId)) return null;
    const file = join(runDir(this.repoPath, runId), "state.json");
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      // Schema sanity: a state.json that is not a well-shaped run record —
      // or whose recorded runId does not match its directory — reads as
      // absent instead of poisoning recovery.
      if (!isRunStateShaped(parsed)) return null;
      if (parsed.runId !== runId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async list(): Promise<{ runId: string; state: RunState["state"]; updatedAt: string }[]> {
    const root = runsRoot(this.repoPath);
    if (!existsSync(root)) return [];
    const out: { runId: string; state: RunState["state"]; updatedAt: string }[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      // Only valid run-id directories are runs; this also skips the
      // execution lease file and any stray files/directories.
      if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
      const state = await this.load(entry.name);
      if (state) {
        out.push({ runId: state.runId, state: state.state, updatedAt: state.updatedAt });
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Repository execution lease (REVIEW §1): exclusive across independent
   * engine processes. Ownership is a pid/token directory lease next to the runs;
   * a live owner is refused, a dead owner (crashed process) is reclaimed,
   * reclaimers are serialized safely, and age alone never breaks the lease.
   */
  async acquireLease(): Promise<LeaseRelease> {
    return acquireFileLease(join(runsRoot(this.repoPath), EXECUTION_LEASE_FILENAME));
  }
}

/** In-memory run store for tests and the fake-agent harness. */
export class MemoryRunStore implements RunStore {
  private readonly map = new Map<string, RunState>();
  private leaseToken: string | null = null;

  async save(state: RunState): Promise<void> {
    this.map.set(state.runId, state);
  }

  async load(runId: string): Promise<RunState | null> {
    return this.map.get(runId) ?? null;
  }

  async list(): Promise<{ runId: string; state: RunState["state"]; updatedAt: string }[]> {
    return [...this.map.values()]
      .map((s) => ({ runId: s.runId, state: s.state, updatedAt: s.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * In-process execution lease (single-process mutual exclusion; the
   * cross-process pid/token semantics live in FsRunStore).
   */
  async acquireLease(): Promise<LeaseRelease> {
    if (this.leaseToken !== null) {
      throw new Error("execution lease is already held (in-memory run store)");
    }
    const token = randomUUID();
    this.leaseToken = token;
    return async () => {
      if (this.leaseToken === token) this.leaseToken = null;
    };
  }
}
