/**
 * Run persistence (PLAN §10.4): state.json is operational truth.
 * Writes are atomic (tmp + rename) so restarts never see torn state.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./state.ts";
import type { RunStore } from "./interfaces.ts";

export function runsRoot(repoPath: string): string {
  return join(repoPath, ".gx-dev", "runs");
}

export function runDir(repoPath: string, runId: string): string {
  return join(runsRoot(repoPath), runId);
}

export class FsRunStore implements RunStore {
  private readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async save(state: RunState): Promise<void> {
    const dir = runDir(this.repoPath, state.runId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "state.json");
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, file);
  }

  async load(runId: string): Promise<RunState | null> {
    const file = join(runDir(this.repoPath, runId), "state.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as RunState;
    } catch {
      return null;
    }
  }

  async list(): Promise<{ runId: string; state: RunState["state"]; updatedAt: string }[]> {
    const root = runsRoot(this.repoPath);
    if (!existsSync(root)) return [];
    const out: { runId: string; state: RunState["state"]; updatedAt: string }[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const state = await this.load(entry.name);
      if (state) {
        out.push({ runId: state.runId, state: state.state, updatedAt: state.updatedAt });
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

/** In-memory run store for tests and the fake-agent harness. */
export class MemoryRunStore implements RunStore {
  private readonly map = new Map<string, RunState>();

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
}
