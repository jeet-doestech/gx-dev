/**
 * Git process plumbing (PLAN §8, §13).
 *
 * Every git interaction goes through a single execFile-style spawn:
 * never a shell, args array only, killed on timeout, output capped.
 * All higher-level calls must be resilient: a missing repository is
 * reported (`isRepo: false`), never thrown.
 */

import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitCallOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Hard cap on captured output per stream (PLAN §13: enforce truncation). */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs `git <args>` with `repoPath` as cwd. Never uses a shell and never
 * throws for non-zero exit codes; resolves with the exit `code` instead.
 * Spawn failures (e.g. git missing, cwd gone) resolve with code -1.
 */
export function git(
  repoPath: string,
  args: string[],
  opts?: GitCallOptions,
): Promise<GitResult> {
  return new Promise((resolve) => {
    // Copy process.env (dropping undefined holes), then overlay caller env.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    if (opts?.env) {
      for (const [key, value] of Object.entries(opts.env)) env[key] = value;
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const child = spawn("git", args, {
      cwd: repoPath,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
      else truncated = true;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
      else truncated = true;
    });

    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let note: string | null = null;
      if (timedOut) {
        note = `gx-dev: git process killed after timeout (${timeoutMs}ms)`;
      } else if (truncated) {
        note = "gx-dev: git output truncated";
      }
      resolve({
        stdout,
        stderr: note ? `${stderr}${stderr ? "\n" : ""}${note}` : stderr,
        code,
      });
    };

    child.on("error", (err: Error) => {
      if (!settled) stderr = `${stderr}${stderr ? "\n" : ""}${err.message}`;
      finish(-1);
    });

    child.on("close", (code) => {
      finish(timedOut ? -1 : (code ?? -1));
    });
  });
}

export interface RepoInspection {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  dirtyFiles: string[];
  existingWorktrees: string[];
}

const EMPTY_INSPECTION: RepoInspection = {
  isRepo: false,
  branch: null,
  commit: null,
  dirty: false,
  dirtyFiles: [],
  existingWorktrees: [],
};

/**
 * Inspects a repository without ever throwing: a missing repo (or missing
 * git binary) yields `isRepo: false` and neutral fields.
 */
export async function inspectRepository(
  repoPath: string,
): Promise<RepoInspection> {
  const probe = await git(repoPath, ["rev-parse", "--git-dir"]);
  if (probe.code !== 0) return EMPTY_INSPECTION;

  const [branchRes, commitRes, statusRes, worktreeRes] = await Promise.all([
    git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(repoPath, ["rev-parse", "HEAD"]),
    git(repoPath, ["status", "--porcelain"]),
    git(repoPath, ["worktree", "list", "--porcelain"]),
  ]);

  const rawBranch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
  const branch = rawBranch === "" || rawBranch === "HEAD" ? null : rawBranch;
  const commit = commitRes.code === 0 ? commitRes.stdout.trim() || null : null;
  const dirtyFiles =
    statusRes.code === 0 ? parsePorcelain(statusRes.stdout) : [];
  const existingWorktrees =
    worktreeRes.code === 0 ? parseWorktreeList(worktreeRes.stdout) : [];

  return {
    isRepo: true,
    branch,
    commit,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    existingWorktrees,
  };
}

/** Parses `git status --porcelain` output into file paths. */
function parsePorcelain(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "" || line.length < 4) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    // Rename/copy entries render as "R  old -> new"; track the new path.
    if (status.includes("R") || status.includes("C")) {
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4);
    }
    files.push(unquote(path));
  }
  return files;
}

/** Parses `git worktree list --porcelain` into worktree paths. */
function parseWorktreeList(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length));
  }
  return paths;
}

function unquote(path: string): string {
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path;
    }
  }
  return path;
}
