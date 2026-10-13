/**
 * Worktree lifecycle (PLAN §8): record the base state, prepare isolated
 * developer/tests/staging worktrees branching from the same base commit,
 * integrate the two branches into staging deterministically, apply the
 * staged result to the user's working branch, and clean up.
 *
 * Refuse-to-overwrite rules (PLAN §13): unrelated uncommitted changes block
 * worktree preparation (gx-dev's own `.gx-dev/` runtime state does not), a
 * moved base branch or a switched symbolic branch blocks commitStaged, and
 * nothing outside the `gx-dev/<run-id>/*` branches is ever modified.
 *
 * Reopen contract: preparing an already-prepared run reopens the existing
 * worktrees instead of failing. The run's base anchor is preserved — never
 * silently re-anchored to the current tip — and, when no base was recorded
 * (fresh manager after a restart), it is recovered from the optional
 * explicit `base` parameter of `prepareWorktrees(repoPath, runId, base?)`
 * or from the run's own branch merge-base. Rollback guidance always uses
 * history-preserving `git revert` instructions, never `git reset --hard`.
 *
 * Fast-forward applies (gx-dev.ffOnly=true) reuse the staging commits
 * as-is, so the engine's commit message would never reach the applied
 * branch — but COMMIT crash reconciliation recognizes the applied commit
 * only by its run-id trailer. commitStaged therefore appends an empty
 * provenance commit carrying the exact engine message to the staging
 * branch first (identical tree, no staged changes, never duplicated on
 * retry) and then fast-forwards.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
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

/**
 * gx-dev's internal state directory inside the target repository (run
 * records, memory scaffolding). Matches domain/persist.ts's `.gx-dev` root.
 * It is filtered from dirty-tree checks at runtime: gx-dev must never block
 * itself on its own bookkeeping, and must never treat anything outside this
 * directory as safe to ignore.
 */
const INTERNAL_STATE_DIR = ".gx-dev";

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

interface RegisteredWorktree {
  /** Absolute path of the registered worktree. */
  path: string;
  /** Short branch name checked out there, or null when detached. */
  branch: string | null;
}

/** True for paths inside gx-dev's internal `.gx-dev/` state directory. */
function isInternalStatePath(path: string): boolean {
  return path === INTERNAL_STATE_DIR || path.startsWith(`${INTERNAL_STATE_DIR}/`);
}

function unquotePath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    try {
      return JSON.parse(path) as string;
    } catch {
      return path;
    }
  }
  return path;
}

function summarizePaths(paths: string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown}, +${paths.length - 5} more` : shown;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Dirty paths of the repository, EXCLUDING gx-dev's internal `.gx-dev/`
 * runtime state (run records, memory scaffolding). Everything else — any
 * unrelated tracked or untracked file — is still reported and blocks, so
 * internal state never widens what gx-dev considers safe to touch.
 */
async function unprotectedDirtyPaths(repoPath: string): Promise<string[]> {
  const status = await git(repoPath, ["status", "--porcelain"]);
  if (status.code !== 0) {
    throw new Error(
      `cannot read status of ${repoPath}: ${status.stderr.trim()}`,
    );
  }
  const out: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.trim() === "" || line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) {
      // Rename: keep the entry unless BOTH sides are internal state.
      const from = unquotePath(rest.slice(0, arrow).trim());
      const to = unquotePath(rest.slice(arrow + 4).trim());
      if (!isInternalStatePath(from) || !isInternalStatePath(to)) out.push(to);
    } else {
      const path = unquotePath(rest);
      if (!isInternalStatePath(path)) out.push(path);
    }
  }
  return out;
}

/** Parses `git worktree list --porcelain` into the registered worktrees. */
async function registeredWorktrees(
  repoPath: string,
): Promise<Map<string, RegisteredWorktree>> {
  const res = await git(repoPath, ["worktree", "list", "--porcelain"]);
  const out = new Map<string, RegisteredWorktree>();
  if (res.code !== 0) return out;
  let current: RegisteredWorktree | null = null;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      out.set(canonicalPath(current.path), current);
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .replace(/^refs\/heads\//, "");
    }
    // "detached" lines leave branch null.
  }
  return out;
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
   * commit — or safely reopens them when this run was already prepared
   * (restart, re-drive, partial creation).
   *
   * Refuse rules: unrelated uncommitted changes in the repository block
   * preparation (gx-dev's internal `.gx-dev/` runtime state is filtered out
   * and never blocks; nothing else is ever ignored).
   *
   * Reopen rules: an existing checkout is reused only when it is registered
   * at this run's own path, checked out at this run's own
   * `gx-dev/<run-id>/<role>` branch, present on disk, and still descends
   * from the run's base. Anything else fails closed; gx-dev never resets or
   * retargets a branch it does not recognize.
   *
   * Base contract (the `base?` parameter is an addition over the
   * `GitCoordinator` interface; callers may omit it): the recorded anchor
   * always wins over the current tip. In order, the base is taken from
   * (1) an existing record for this run, (2) the intake record from
   * recordBase() for this repository — verified against the current HEAD,
   * then consumed, (3) the explicit `base` commit-ish parameter (restart
   * recovery: pass the persisted `state.base.commit`), (4) the merge-base
   * of the run's surviving branches (exact when two or more exist), and
   * only then (5) the current HEAD for a genuinely new run.
   */
  async prepareWorktrees(
    repoPath: string,
    runId: string,
    base?: string,
  ): Promise<WorktreeHandles> {
    const inspect = await inspectRepository(repoPath);
    if (!inspect.isRepo) {
      throw new Error(`not a git repository: ${repoPath}`);
    }
    const dirty = await unprotectedDirtyPaths(repoPath);
    if (dirty.length > 0) {
      throw new Error(
        `working tree has uncommitted changes; commit or stash first (${summarizePaths(dirty)})`,
      );
    }
    if (!inspect.commit) {
      throw new Error(
        "repository has no commits; gx-dev requires an initial commit before preparing worktrees",
      );
    }
    const headCommit: string = inspect.commit;

    const branches = {
      developer: branchName(runId, "developer"),
      tests: branchName(runId, "tests"),
      staging: branchName(runId, "staging"),
    };

    // Snapshot the run's Git state before mutating anything so reopen
    // decisions are made from what is actually registered in the repo.
    const tips = await this.branchTips(repoPath, [
      branches.developer,
      branches.tests,
      branches.staging,
    ]);
    const registered = await registeredWorktrees(repoPath);
    const existingTips = [...tips.values()].filter(
      (tip): tip is string => tip !== null,
    );

    const anchor = await this.resolveRunBase(
      repoPath,
      runId,
      headCommit,
      inspect.branch,
      base,
      existingTips,
    );
    this.basesByRun.set(runId, anchor);

    const root = worktreeRoot(repoPath, runId);
    const dirs = new Map<WorktreeRole, string>(
      ROLES.map((role) => [role, join(root, role)]),
    );

    for (const role of ROLES) {
      const dir = dirs.get(role);
      if (!dir) continue;
      const branch = branchName(runId, role);
      const tip = tips.get(branch) ?? null;

      const registration = registered.get(canonicalPath(dir));
      if (registration) {
        // Reopen in place: the worktree for this run already exists.
        if (registration.branch !== branch) {
          throw new Error(
            `worktree ${dir} is checked out at ${registration.branch ?? "<detached HEAD>"}, expected ${branch}; refusing to reuse a checkout that does not belong to run ${runId}`,
          );
        }
        if (!existsSync(dir)) {
          throw new Error(
            `worktree ${dir} is registered for run ${runId} but missing on disk; run 'git worktree prune' or gx-dev cleanup first`,
          );
        }
        await this.assertDescends(
          repoPath,
          anchor.commit,
          branch,
          tip,
          `reopened branch`,
        );
        continue;
      }

      const elsewhere = [...registered.entries()].find(
        ([, reg]) => reg.branch === branch,
      );
      if (elsewhere) {
        throw new Error(
          `branch ${branch} of run ${runId} is checked out at ${elsewhere[0]}, not at ${dir}; refusing to guess the intended worktree layout`,
        );
      }

      let res: GitResult;
      if (tip) {
        // Leftover branch without a worktree (partial cleanup/crash): reuse
        // the branch only if it still descends from the run's base.
        await this.assertDescends(
          repoPath,
          anchor.commit,
          branch,
          tip,
          `existing branch`,
        );
        res = await git(repoPath, ["worktree", "add", dir, branch]);
      } else {
        res = await git(repoPath, [
          "worktree",
          "add",
          "-b",
          branch,
          dir,
          anchor.commit,
        ]);
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
      branches,
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

    // Branch identity (PLAN §13): HEAD must sit on the recorded base branch
    // AND on the branch the caller asked to apply to. The same SHA checked
    // out on another branch (a user switch mid-run) must never receive the
    // result silently.
    const sym = await git(repoPath, ["symbolic-ref", "--short", "HEAD"]);
    const currentBranch = sym.code === 0 ? sym.stdout.trim() || null : null;
    if (!currentBranch) {
      throw new Error(
        `refusing to apply: repository HEAD is detached; checkout ${baseBranch} before applying the gx-dev result`,
      );
    }
    if (base.branch !== null && currentBranch !== base.branch) {
      throw new Error(
        `branch mismatch: gx-dev recorded base branch '${base.branch}' for run ${handles.runId} but HEAD is now on '${currentBranch}'; checkout ${base.branch} or re-record the base before applying`,
      );
    }
    if (currentBranch !== baseBranch) {
      throw new Error(
        `branch mismatch: asked to apply the gx-dev result to '${baseBranch}' but HEAD is on '${currentBranch}'; refusing to merge into a different branch`,
      );
    }

    const dirty = await unprotectedDirtyPaths(repoPath);
    if (dirty.length > 0) {
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
      // A fast-forward reuses the staging commits as-is, so the engine's
      // message would never appear on the applied branch — but COMMIT crash
      // reconciliation recognizes the applied commit only by its run-id
      // trailer. Append an empty provenance commit carrying the exact
      // engine message to the staging branch first (--allow-empty --only:
      // identical tree, staged changes are never picked up, and a retry
      // after a crashed apply never duplicates the marker), then
      // fast-forward the working branch across it.
      await this.appendProvenanceCommit(
        repoPath,
        staging,
        handles.branches.staging,
        message,
      );
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
    const rollbackCommand = await this.rollbackInstruction(
      repoPath,
      head,
      commitHash,
      strategy,
    );
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

  /**
   * Resolves the base anchor for a run without ever silently re-anchoring
   * to a moved tip (precedence documented on prepareWorktrees).
   */
  private async resolveRunBase(
    repoPath: string,
    runId: string,
    headCommit: string,
    headBranch: string | null,
    explicitBase: string | undefined,
    existingBranchTips: string[],
  ): Promise<BaseRecord> {
    const recordedRun = this.basesByRun.get(runId);
    if (recordedRun) {
      if (headCommit !== recordedRun.commit) {
        throw new Error(
          `run ${runId} was prepared on base ${recordedRun.commit} but repository HEAD is now ${headCommit}; refusing to re-prepare over a moved base`,
        );
      }
      return recordedRun;
    }

    const recordedIntake = this.basesByRepo.get(repoPath);
    if (recordedIntake) {
      if (headCommit !== recordedIntake.commit) {
        throw new Error(
          `intake recorded base ${recordedIntake.commit} but repository HEAD is now ${headCommit}; the working branch moved between recordBase() and prepareWorktrees(). gx-dev keeps the approved anchor: re-record the base deliberately instead of silently moving it`,
        );
      }
      // Consumed by this preparation; every run records its own intake.
      this.basesByRepo.delete(repoPath);
      return recordedIntake;
    }

    if (explicitBase !== undefined) {
      const commit = await this.resolveCommit(repoPath, explicitBase);
      if (!commit) {
        throw new Error(
          `explicit base ${explicitBase} does not resolve to an existing commit`,
        );
      }
      return {
        repoPath,
        branch: headCommit === commit ? headBranch : null,
        commit,
      };
    }

    if (existingBranchTips.length > 0) {
      // Restart recovery without a record: recover the original base from
      // the run's own branches. Two or more branches make the merge-base
      // exact (all were cut from the same commit); a single branch is only
      // trustworthy while it still sits on the current HEAD.
      if (existingBranchTips.length === 1) {
        const tip = existingBranchTips[0] ?? "";
        if (tip === headCommit) {
          return { repoPath, branch: headBranch, commit: tip };
        }
        throw new Error(
          `only one branch of run ${runId} survives and it moved past the original base; pass the recorded base commit explicitly to prepareWorktrees()`,
        );
      }
      const mb = await git(repoPath, ["merge-base", ...existingBranchTips]);
      const commit =
        mb.code === 0 ? (mb.stdout.trim().split("\n")[0] ?? "").trim() : "";
      if (commit === "") {
        throw new Error(
          `cannot recover the original base of run ${runId} from its branches; pass the base commit explicitly to prepareWorktrees()`,
        );
      }
      return {
        repoPath,
        branch: headCommit === commit ? headBranch : null,
        commit,
      };
    }

    return { repoPath, branch: headBranch, commit: headCommit };
  }

  private async resolveCommit(
    repoPath: string,
    ref: string,
  ): Promise<string | null> {
    const res = await git(repoPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    return res.code === 0 ? res.stdout.trim() || null : null;
  }

  private async branchTips(
    repoPath: string,
    branches: readonly string[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const branch of branches) {
      out.set(branch, await this.resolveCommit(repoPath, branch));
    }
    return out;
  }

  /** Fails closed unless `tip` descends from the recorded base commit. */
  private async assertDescends(
    repoPath: string,
    baseCommit: string,
    branch: string,
    tip: string | null,
    label: string,
  ): Promise<void> {
    if (tip === null || tip === baseCommit) return;
    const res = await git(repoPath, [
      "merge-base",
      "--is-ancestor",
      baseCommit,
      tip,
    ]);
    if (res.code !== 0) {
      throw new Error(
        `${label} ${branch} does not descend from the recorded base ${baseCommit}; gx-dev will not reuse or reset it`,
      );
    }
  }

  /**
   * Appends the fast-forward provenance commit to the staging branch: an
   * empty `--allow-empty --only` commit whose message is the exact engine
   * message. The commit ignores the index (`--only`, no paths), so staged
   * accidental changes are never picked up, and the tree is asserted
   * identical before/after (fail closed). A tip that already carries the
   * message — a retried apply after a crash between the marker and the
   * fast-forward — is never duplicated.
   */
  private async appendProvenanceCommit(
    repoPath: string,
    staging: string,
    branch: string,
    message: string,
  ): Promise<void> {
    // The marker must not sweep in unintegrated work: a dirty staging
    // worktree means the staged result is not what verification saw.
    const dirty = await unprotectedDirtyPaths(staging);
    if (dirty.length > 0) {
      throw new Error(
        `staging worktree has uncommitted changes; refusing to append the provenance commit to ${branch} (${summarizePaths(dirty)})`,
      );
    }
    const tip = await git(repoPath, [
      "rev-parse",
      "--verify",
      `${branch}^{commit}`,
    ]);
    if (tip.code !== 0) {
      throw new Error(
        `staging branch ${branch} no longer resolves; refusing to append the provenance commit`,
      );
    }
    const tipSha = tip.stdout.trim();
    const tipTree = await this.commitTree(repoPath, tipSha);
    const tipMessage = await git(repoPath, [
      "log",
      "-1",
      "--format=%B",
      tipSha,
    ]);
    if (tipMessage.code === 0 && tipMessage.stdout.trim() === message.trim()) {
      // Retried apply: the provenance marker of a crashed attempt is
      // already the branch tip; appending another would duplicate it.
      return;
    }
    const commit = await git(staging, [
      ...IDENTITY_ARGS,
      "commit",
      "--allow-empty",
      "--only",
      "-m",
      message,
    ]);
    if (commit.code !== 0) {
      throw new Error(
        `provenance commit on ${branch} failed: ${commit.stderr.trim()}`,
      );
    }
    const after = await git(repoPath, [
      "rev-parse",
      "--verify",
      `${branch}^{commit}`,
    ]);
    const afterSha = after.code === 0 ? after.stdout.trim() : "";
    const afterTree =
      afterSha !== "" ? await this.commitTree(repoPath, afterSha) : null;
    if (tipTree === null || afterTree === null || afterTree !== tipTree) {
      throw new Error(
        `provenance commit on ${branch} changed the tree; refusing to fast-forward an unverifiable result`,
      );
    }
  }

  /** Tree id of a commit, or null when it cannot be resolved. */
  private async commitTree(
    repoPath: string,
    ref: string,
  ): Promise<string | null> {
    const res = await git(repoPath, ["rev-parse", "--verify", `${ref}^{tree}`]);
    return res.code === 0 ? res.stdout.trim() || null : null;
  }

  /**
   * True when the commit's tree equals its first parent's tree — an empty
   * delta (the fast-forward provenance marker, or a deliberately empty
   * commit). Such commits carry nothing to revert: `git revert` would fail
   * and break a rollback chain, so rollback guidance skips them.
   */
  private async isEmptyTreeDelta(
    repoPath: string,
    sha: string,
  ): Promise<boolean> {
    const parents = await git(repoPath, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      sha,
    ]);
    if (parents.code !== 0) return false;
    const parts = parents.stdout.trim().split(/\s+/);
    const firstParent = parts[1];
    if (!firstParent) return false; // root commit: no parent to compare
    const [tree, parentTree] = await Promise.all([
      this.commitTree(repoPath, sha),
      this.commitTree(repoPath, firstParent),
    ]);
    if (tree === null || parentTree === null) return false;
    return tree === parentTree;
  }

  /**
   * Builds the strategy-aware rollback guidance. Default policy (PLAN §13):
   * never rewrite history — reverts undo the integration with ordinary
   * commits, so any later work on the branch survives. `git reset --hard` /
   * `git branch -f`-style rollback discards history and is deliberately not
   * emitted; it requires an explicit human decision outside gx-dev.
   */
  private async rollbackInstruction(
    repoPath: string,
    baseCommit: string,
    appliedCommit: string,
    strategy: string,
  ): Promise<string> {
    if (strategy === "merge-commit") {
      // Reverting a merge needs its mainline parent (1 = the branch tip the
      // merge was applied to).
      return `git revert --no-edit --mainline 1 ${appliedCommit}`;
    }
    // Fast-forward moved the branch across the staging history. Revert the
    // FIRST-PARENT chain newest-first so each reversion applies to the tree
    // it produced. Side branches merged into staging are deliberately left
    // out: the merge reversion itself (--mainline 1) already undoes every
    // change they introduced, and reverting their commits individually
    // would double-revert the same diffs and conflict. Empty tree-delta
    // commits (the fast-forward provenance marker, already-empty commits)
    // are skipped: git revert refuses them and would break the chain.
    const revs = await git(repoPath, [
      "rev-list",
      "--first-parent",
      `${baseCommit}..${appliedCommit}`,
    ]);
    const shas =
      revs.code === 0
        ? revs.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s !== "")
        : [];
    const commands: string[] = [];
    for (const sha of shas) {
      // Nothing to undo: reverting an empty tree-delta (e.g. the provenance
      // marker) fails and would abort the remaining chain.
      if (await this.isEmptyTreeDelta(repoPath, sha)) continue;
      const parents = await git(repoPath, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        sha,
      ]);
      const isMerge =
        parents.code === 0 && parents.stdout.trim().split(/\s+/).length > 2;
      commands.push(
        isMerge
          ? `git revert --no-edit --mainline 1 ${sha}`
          : `git revert --no-edit ${sha}`,
      );
    }
    if (commands.length === 0) {
      return `git revert --no-edit ${appliedCommit}`;
    }
    return commands.join(" && ");
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
