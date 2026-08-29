/**
 * Pure-ish diff helpers used by the gates (PLAN §8 step 8, §13: review the
 * actual generated diffs, never an agent's stated intention).
 */

import { git } from "./repository.ts";

/**
 * Full diff of a worktree relative to the base commit: the committed diff
 * (`<base>...HEAD`) plus the uncommitted worktree/index diff (`git diff
 * HEAD`, which covers staged and unstaged changes against the branch tip
 * without double-counting committed work).
 */
export async function diffOfWorktree(
  worktree: string,
  baseCommit: string,
): Promise<string> {
  const committed = await git(worktree, ["diff", `${baseCommit}...HEAD`]);
  const uncommitted = await git(worktree, ["diff", "HEAD"]);
  const parts: string[] = [];
  for (const res of [committed, uncommitted]) {
    if (res.code === 0 && res.stdout.trim() !== "") parts.push(res.stdout);
  }
  return parts.join("\n");
}

/** Files changed relative to the base commit, committed and uncommitted. */
export async function filesChanged(
  worktree: string,
  baseCommit: string,
): Promise<string[]> {
  const [committed, uncommitted] = await Promise.all([
    git(worktree, ["diff", "--name-only", `${baseCommit}...HEAD`]),
    git(worktree, ["diff", "--name-only", "HEAD"]),
  ]);
  const files = new Set<string>();
  for (const res of [committed, uncommitted]) {
    if (res.code !== 0) continue;
    for (const line of res.stdout.split("\n")) {
      const file = line.trim();
      if (file !== "") files.add(file);
    }
  }
  return [...files];
}
