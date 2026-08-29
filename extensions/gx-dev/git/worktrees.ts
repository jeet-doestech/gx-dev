/**
 * Worktree lifecycle (PLAN §8): record the base state, prepare isolated
 * developer/tests/staging worktrees branching from the same base commit,
 * integrate the two branches into staging deterministically, apply the
 * staged result to the user's working branch, and clean up.
 *
 * Refuse-to-overwrite rules (PLAN §13): a dirty base tree blocks worktree
 * preparation, a moved base branch blocks commitStaged, and nothing outside
 * the `gx-dev/<run-id>/*` branches is ever modified.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitResult } from "./repository.ts";
import type {
  GitCoordinator,
  IntegratedResult,
  WorktreeHandles,
} from "../domain/interfaces.ts";
import { git, inspectRepository } from "./repository.ts";

/** Internal identity for mechanical gx-dev commits (checkpoints, merges). */
const IDENTITY_ARGS: readonly string[] = [
  "-c",
  "user.name=gx-dev",
  "-c",
  "user.email=gx-dev@localhost",
];

/** Worktree root: <repo-parent>/.gx-dev-worktrees/<run-id>/{developer,tests,staging}. */
export const WORKTREE_DIRNAME = ".gx-dev-worktrees";

type WorktreeRole = "developer" | "tests" | "staging";

const ROLES: readonly WorktreeRole[] = ["developer", "tests", "staging"];

function branchName(runId: string, role: WorktreeRole): string {
  return `gx-dev/${runId}/${role}`;
}

function worktreeRoot(repoPath: string, runId: string): string {
  return join(dirname(repoPath), WORKTREE_DIRNAME, runId);
}

interface BaseRecord {
  repoPath: string;
  branch: string | null;
  commit: string;
}

export class GitWorktreeManager implements GitCoordinator {
  private readonly basesByRepo = new Map<string, BaseRecord>();
  private readonly basesByRun = new Map<string, BaseRecord>();

  /** Records the current branch/commit/dirty state of the repository. */
  async recordBase(
    repoPath: string,
  ): Promise<{
    branch: string | null;
    commit: string | null;
    dirty: boolean;
    refused?: string;
  }> {
    const inspect = await inspectRepository(repoPath);
    if (!inspect.isRepo) {
      throw new Error(`not a git repository: ${repoPath}`);
    }
    if (inspect.commit) {
      const record: BaseRecord = {
        repoPath,
        branch: inspect.branch,
        commit: inspect.commit,
      };
      this.basesByRepo.set(repoPath, record);
    }
    return { branch: inspect.branch, commit: inspect.commit, dirty: inspect.dirty };
  }

  /**
   * Creates the three per-run worktrees branching from the recorded base
   * commit. Refuses to run on a dirty tree: unrelated uncommitted changes
   * must never be at risk (the refuse-to-overwrite rule).
   */
  async prepareWorktrees(
    repoPath: string,
    runId: string,
  ): Promise<WorktreeHandles> {
    const inspect = await inspectRepository(repoPath);
    if (!inspect.isRepo) {
      throw new Error(`not a git repository: ${repoPath}`);
    }
    if (inspect.dirty) {
      throw new Error(
        "working tree has uncommitted changes; commit or stash first",
      );
    }
    if (!inspect.commit) {
      throw new Error(
        "repository has no commits; gx-dev requires an initial commit before preparing worktrees",
      );
    }

    const base: BaseRecord = {
      repoPath,
      branch: inspect.branch,
      commit: inspect.commit,
    };
    this.basesByRepo.set(repoPath, base);
    this.basesByRun.set(runId, base);

    const root = worktreeRoot(repoPath, runId);
    const dirs = new Map<WorktreeRole, string>(
      ROLES.map((role) => [role, join(root, role)]),
    );

    for (const role of ROLES) {
      const dir = dirs.get(role);
      if (!dir) continue;
      const branch = branchName(runId, role);
      let res = await git(repoPath, [
        "worktree",
        "add",
        "-b",
        branch,
        dir,
        base.commit,
      ]);
      if (res.code !== 0 && /already exists/.test(res.stderr)) {
        // Same run id prepared again: reuse the existing branch.
        res = await git(repoPath, ["worktree", "add", dir, branch]);
      }
      if (res.code !== 0) {
        throw new Error(
          `git worktree add failed for ${role} (${branch}): ${res.stderr.trim()}`,
        );
      }
    }

    return {
      runId,
      developer: dirs.get("developer") ?? null,
      tests: dirs.get("tests") ?? null,
      staging: dirs.get("staging") ?? null,
      branches: {
        developer: branchName(runId, "developer"),
        tests: branchName(runId, "tests"),
        staging: branchName(runId, "staging"),
      },
    };
  }

  /**
   * Checkpoints any uncommitted work in the developer and tests worktrees,
   * then merges both branches into staging in a fixed order (developer
   * first, then tests). Only mechanical conflicts are resolved; anything
   * else aborts the in-progress merge and is reported for the orchestrator.
   */
  async integrate(handles: WorktreeHandles): Promise<IntegratedResult> {
    const developer = handles.developer;
    const tests = handles.tests;
    const staging = handles.staging;
    if (!developer || !tests || !staging) {
      throw new Error(
        "integrate requires prepared developer/tests/staging worktrees",
      );
    }

    await this.checkpoint(developer, "gx-dev checkpoint: developer");
    await this.checkpoint(tests, "gx-dev checkpoint: tests");

    const autoResolved: string[] = [];
    const conflictedFiles: string[] = [];

    for (const branch of [handles.branches.developer, handles.branches.tests]) {
      const merge = await git(staging, [
        ...IDENTITY_ARGS,
        "merge",
        "--no-edit",
        branch,
      ]);
      if (merge.code === 0) continue;

      const conflicts = await this.conflictedPaths(staging);
      for (const path of conflicts) {
        if (await this.tryTrivialResolve(staging, path)) {
          autoResolved.push(path);
        }
      }

      const remaining = await this.conflictedPaths(staging);
      if (remaining.length > 0) {
        // Semantic conflict: abort this merge, leave earlier merges intact,
        // and hand the file list back to the orchestrator.
        conflictedFiles.push(...remaining);
        await git(staging, ["merge", "--abort"]);
        return {
          stagingWorktree: staging,
          success: false,
          conflictedFiles,
          autoResolved,
        };
      }

      if (conflicts.length > 0) {
        // All conflicts resolved mechanically: conclude the merge commit.
        const conclude = await git(staging, [
          ...IDENTITY_ARGS,
          "commit",
          "--no-edit",
        ]);
        if (conclude.code !== 0) {
          await git(staging, ["merge", "--abort"]);
          return {
            stagingWorktree: staging,
            success: false,
            conflictedFiles: [],
            autoResolved,
          };
        }
      } else {
        // Merge failed without conflict entries (e.g. untracked overwrite).
        await git(staging, ["merge", "--abort"]);
        return {
          stagingWorktree: staging,
          success: false,
          conflictedFiles: [],
          autoResolved,
        };
      }
    }

    return {
      stagingWorktree: staging,
      success: true,
      conflictedFiles: [],
      autoResolved,
    };
  }

  /**
   * Applies the staged result to the working branch. Only runs when the main
   * repo HEAD still equals the recorded base commit and the tree is clean —
   * a stale base requires an explicit user decision, never a silent overwrite.
   */
  async commitStaged(
    handles: WorktreeHandles,
    message: string,
    baseBranch: string,
  ): Promise<{ commitHash: string; strategy: string; rollbackCommand: string }> {
    const staging = handles.staging;
    if (!staging) {
      throw new Error("commitStaged requires a prepared staging worktree");
    }
    const base = this.basesByRun.get(handles.runId);
    if (!base) {
      throw new Error(
        `no recorded base commit for run ${handles.runId}; call recordBase()/prepareWorktrees() before commitStaged`,
      );
    }
    const repoPath = base.repoPath;

    const headRes = await git(repoPath, ["rev-parse", "HEAD"]);
    const head = headRes.code === 0 ? headRes.stdout.trim() : null;
    if (head !== base.commit) {
      throw new Error(
        `stale base: repository HEAD is ${head ?? "<unknown>"} but gx-dev recorded base ${base.commit} for run ${handles.runId}; the working branch moved during the run. Decide manually: rebase ${handles.branches.staging} onto the new base or re-run integration. gx-dev will not overwrite the newer commit.`,
      );
    }

    const status = await git(repoPath, ["status", "--porcelain"]);
    if (status.code !== 0) {
      throw new Error(
        `cannot read status of ${repoPath}: ${status.stderr.trim()}`,
      );
    }
    if (status.stdout.trim() !== "") {
      throw new Error(
        "main repository has uncommitted changes; commit or stash them before applying the gx-dev result",
      );
    }

    // Verify the staging branch exists and actually carries the intended
    // diff on top of the recorded base before touching the main repo.
    const tipRes = await git(repoPath, [
      "rev-parse",
      "--verify",
      `${handles.branches.staging}^{commit}`,
    ]);
    const stagingTip = tipRes.code === 0 ? tipRes.stdout.trim() : null;
    if (!stagingTip) {
      throw new Error(
        `staging branch ${handles.branches.staging} not found; run integrate() first`,
      );
    }
    if (stagingTip === base.commit) {
      throw new Error(
        "staging branch has no changes relative to the recorded base; nothing to commit",
      );
    }
    const descendant = await git(repoPath, [
      "merge-base",
      "--is-ancestor",
      base.commit,
      stagingTip,
    ]);
    if (descendant.code !== 0) {
      throw new Error(
        `staging branch ${handles.branches.staging} does not descend from the recorded base ${base.commit}; refusing to merge`,
      );
    }

    // Fast-forward only when the merge is already fast-forwardable AND the
    // user configured gx-dev.ffOnly=true; default is a merge commit.
    const ffConfig = await git(repoPath, ["config", "--get", "gx-dev.ffOnly"]);
    const prefersFf =
      ffConfig.code === 0 && ffConfig.stdout.trim().toLowerCase() === "true";
    let merge: GitResult;
    let strategy: string;
    const ffable =
      prefersFf &&
      (await git(repoPath, ["merge-base", "--is-ancestor", head, stagingTip]))
        .code === 0;
    if (ffable) {
      merge = await git(repoPath, [
        ...IDENTITY_ARGS,
        "merge",
        "--ff-only",
        "--no-edit",
        handles.branches.staging,
      ]);
      strategy = "fast-forward";
    } else {
      merge = await git(repoPath, [
        ...IDENTITY_ARGS,
        "merge",
        "--no-ff",
        "-m",
        message,
        handles.branches.staging,
      ]);
      strategy = "merge-commit";
    }
    if (merge.code !== 0) {
      // Leave the main repo untouched; the orchestrator decides next steps.
      await git(repoPath, ["merge", "--abort"]);
      throw new Error(
        `git merge of ${handles.branches.staging} into ${baseBranch} failed: ${merge.stderr.trim()}`,
      );
    }

    const post = await git(repoPath, ["rev-parse", "HEAD"]);
    const commitHash = post.stdout.trim();
    const rollbackCommand = `git reset --hard ${head} && git branch -f ${baseBranch} ${head}`;
    return { commitHash, strategy, rollbackCommand };
  }

  /**
   * Commits pending changes in the staging worktree (e.g. documentation
   * updates applied by the reviewer) so final verification sees a clean
   * tree. Returns the new commit hash, or null when the tree was clean.
   */
  async checkpointStaging(
    handles: WorktreeHandles,
    message: string,
  ): Promise<string | null> {
    const staging = handles.staging;
    if (!staging) return null;
    const before = await git(staging, ["rev-parse", "HEAD"]);
    await this.checkpoint(staging, message);
    const after = await git(staging, ["rev-parse", "HEAD"]);
    return before.stdout.trim() === after.stdout.trim()
      ? null
      : after.stdout.trim();
  }

  /**
   * Removes this run's worktrees and deletes its three branches. Best
   * effort: tolerates "not a working tree" and similar cleanup errors.
   * Branch deletion uses `-D` only with force, `-d` otherwise, and only ever
   * touches the run's own `gx-dev/<run-id>/*` branches.
   */
  async cleanup(
    handles: WorktreeHandles,
    opts?: { force?: boolean },
  ): Promise<void> {
    const force = opts?.force === true;
    const repoPath =
      this.basesByRun.get(handles.runId)?.repoPath ??
      (handles.staging ? repoFromWorktree(handles.staging) : null);
    if (!repoPath) return;

    for (const wt of [handles.developer, handles.tests, handles.staging]) {
      if (!wt) continue;
      const args = force
        ? ["worktree", "remove", "--force", wt]
        : ["worktree", "remove", wt];
      await git(repoPath, args); // tolerate failures (already gone, dirty, ...)
    }
    for (const branch of [
      handles.branches.developer,
      handles.branches.tests,
      handles.branches.staging,
    ]) {
      const args = force
        ? ["branch", "-D", branch]
        : ["branch", "-d", branch];
      await git(repoPath, args); // tolerate unmerged-deletion refusals
    }
    this.basesByRun.delete(handles.runId);
  }

  /** Commits all pending changes in a worktree; skips clean worktrees. */
  private async checkpoint(worktree: string, message: string): Promise<void> {
    const status = await git(worktree, ["status", "--porcelain"]);
    if (status.code !== 0) {
      throw new Error(
        `git status failed in ${worktree}: ${status.stderr.trim()}`,
      );
    }
    if (status.stdout.trim() === "") return;
    const add = await git(worktree, ["add", "-A"]);
    if (add.code !== 0) {
      throw new Error(`git add -A failed in ${worktree}: ${add.stderr.trim()}`);
    }
    const commit = await git(worktree, [
      ...IDENTITY_ARGS,
      "commit",
      "-m",
      message,
    ]);
    if (commit.code !== 0) {
      throw new Error(
        `git commit failed in ${worktree}: ${commit.stderr.trim()}`,
      );
    }
  }

  private async conflictedPaths(worktree: string): Promise<string[]> {
    const res = await git(worktree, ["diff", "--name-only", "--diff-filter=U"]);
    if (res.code !== 0) return [];
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  /**
   * Resolves only mechanical conflicts:
   * - both sides produced identical content → take that content;
   * - one side deleted the file and the other side's content still equals
   *   the merge base (i.e. it never actually touched it) → take the
   *   surviving deletion.
   * Everything else is left for the abort/report path.
   */
  private async tryTrivialResolve(
    worktree: string,
    path: string,
  ): Promise<boolean> {
    const stages = await git(worktree, ["ls-files", "-u", "--", path]);
    if (stages.code !== 0) return false;
    const shas = new Map<number, string>();
    for (const line of stages.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const meta = (line.split("\t")[0] ?? "").split(/\s+/);
      const sha = meta[1];
      const stage = Number(meta[2]);
      if (sha && stage >= 1 && stage <= 3) shas.set(stage, sha);
    }
    const baseSha = shas.get(1);
    const oursSha = shas.get(2);
    const theirsSha = shas.get(3);

    if (oursSha && theirsSha && oursSha === theirsSha) {
      const checkout = await git(worktree, ["checkout", "--ours", "--", path]);
      if (checkout.code !== 0) return false;
      const add = await git(worktree, ["add", "--", path]);
      return add.code === 0;
    }

    if (baseSha && ((oursSha && !theirsSha) || (!oursSha && theirsSha))) {
      const surviving = oursSha ?? theirsSha;
      if (surviving === baseSha) {
        const rm = await git(worktree, ["rm", "-f", "--", path]);
        return rm.code === 0;
      }
    }

    return false;
  }
}

/**
 * Recovers the repo root from a linked worktree's `.git` file
 * (`gitdir: <repo>/.git/worktrees/<name>`) when no base was recorded.
 */
function repoFromWorktree(worktree: string): string | null {
  try {
    const content = readFileSync(join(worktree, ".git"), "utf8").trim();
    if (!content.startsWith("gitdir:")) return null;
    const gitdir = content.slice("gitdir:".length).trim();
    return dirname(dirname(dirname(gitdir)));
  } catch {
    return null;
  }
}
