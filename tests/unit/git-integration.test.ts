/**
 * Unit tests for the gx-dev git integration + commit layer: diff helpers,
 * commitStaged application (merge-commit / fast-forward, stale-base,
 * symbolic-branch and dirty-tree refusals, history-preserving revert
 * rollback), and the deterministic commit message builder.
 * Uses real git in per-test temp repositories under os.tmpdir().
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { git } from "../../extensions/gx-dev/git/repository.ts";
import { GitWorktreeManager } from "../../extensions/gx-dev/git/worktrees.ts";
import { diffOfWorktree, filesChanged } from "../../extensions/gx-dev/git/integration.ts";
import { buildCommitMessage } from "../../extensions/gx-dev/git/commit.ts";

// Hermetic git config: no user global/system config can break the tests.
const cfgDir = mkdtempSync(join(tmpdir(), "gx-dev-gitcfg-"));
const globalCfg = join(cfgDir, "gitconfig");
writeFileSync(globalCfg, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n");
process.env.GIT_CONFIG_GLOBAL = globalCfg;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
after(() => rmSync(cfgDir, { recursive: true, force: true }));

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "gx-dev-test",
  GIT_AUTHOR_EMAIL: "test@gx-dev.invalid",
  GIT_COMMITTER_NAME: "gx-dev-test",
  GIT_COMMITTER_EMAIL: "test@gx-dev.invalid",
};

function makeSandbox(t: TestContext): { repo: string } {
  const parent = mkdtempSync(join(tmpdir(), "gx-dev-git-"));
  const repo = join(parent, "repo");
  mkdirSync(repo);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { repo };
}

async function initRepo(repo: string): Promise<string> {
  writeFileSync(join(repo, "README.md"), "# test\n");
  const init = await git(repo, ["init", "-b", "main"]);
  assert.equal(init.code, 0, init.stderr);
  const add = await git(repo, ["add", "-A"]);
  assert.equal(add.code, 0, add.stderr);
  const commit = await git(repo, ["commit", "-m", "initial commit"], { env: GIT_ENV });
  assert.equal(commit.code, 0, commit.stderr);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  assert.equal(head.code, 0, head.stderr);
  return head.stdout.trim();
}

/**
 * Full happy-path flow up to a successful integrate: both worktrees carry
 * non-conflicting uncommitted changes that integrate checkpoints.
 */
async function prepareAndIntegrate(
  t: TestContext,
  runId: string,
): Promise<{ repo: string; manager: GitWorktreeManager; base: string; handles: Awaited<ReturnType<GitWorktreeManager["prepareWorktrees"]>> }> {
  const { repo } = makeSandbox(t);
  const base = await initRepo(repo);
  const manager = new GitWorktreeManager();
  const handles = await manager.prepareWorktrees(repo, runId);
  assert.ok(handles.developer && handles.tests && handles.staging);
  writeFileSync(join(handles.developer, "dev.txt"), "developer output\n");
  writeFileSync(join(handles.tests, "test.txt"), "test output\n");
  const result = await manager.integrate(handles);
  assert.equal(result.success, true, `integrate failed: ${JSON.stringify(result.conflictedFiles)}`);
  return { repo, manager, base, handles };
}

test("diffOfWorktree and filesChanged cover committed and uncommitted work", { timeout: 30000 }, async (t) => {
  const { repo } = makeSandbox(t);
  const base = await initRepo(repo);
  const manager = new GitWorktreeManager();
  const handles = await manager.prepareWorktrees(repo, "run-diff-1");
  assert.ok(handles.developer);

  // Committed change...
  writeFileSync(join(handles.developer, "committed.txt"), "committed line\n");
  const add = await git(handles.developer, ["add", "-A"]);
  assert.equal(add.code, 0, add.stderr);
  const commit = await git(handles.developer, ["commit", "-m", "wip"], { env: GIT_ENV });
  assert.equal(commit.code, 0, commit.stderr);
  // ...and an uncommitted edit to a tracked file.
  writeFileSync(join(handles.developer, "committed.txt"), "committed line\nplus uncommitted line\n");

  const diff = await diffOfWorktree(handles.developer, base);
  assert.ok(diff.includes("committed line"));
  assert.ok(diff.includes("plus uncommitted line"));
  assert.ok(diff.includes("diff --git"));

  const files = await filesChanged(handles.developer, base);
  assert.deepEqual([...files].sort(), ["committed.txt"]);

  // A clean worktree yields an empty diff and no changed files.
  const empty = await diffOfWorktree(repo, base);
  assert.equal(empty, "");
  assert.deepEqual(await filesChanged(repo, base), []);

  await manager.cleanup(handles);
});

test("commitStaged creates a merge commit on an unchanged base and returns rollback info", { timeout: 30000 }, async (t) => {
  const { repo, manager, base, handles } = await prepareAndIntegrate(t, "run-commit-1");

  const preHead = await git(repo, ["rev-parse", "HEAD"]);
  assert.equal(preHead.stdout.trim(), base, "main repo HEAD must still be the base");

  const message = buildCommitMessage({
    request: "Add the export widget",
    runId: "run-commit-1",
    artifacts: ["dev.txt", "test.txt"],
    strategy: "merge-commit",
  });
  const applied = await manager.commitStaged(handles, message, "main");

  assert.equal(applied.strategy, "merge-commit");
  const postHead = await git(repo, ["rev-parse", "HEAD"]);
  assert.equal(applied.commitHash, postHead.stdout.trim());
  assert.notEqual(applied.commitHash, base);

  assert.ok(applied.rollbackCommand.startsWith("git revert --no-edit --mainline 1 "));
  assert.equal(applied.rollbackCommand, `git revert --no-edit --mainline 1 ${applied.commitHash}`);

  const log = await git(repo, ["log", "--format=%B", "-1"]);
  assert.equal(log.code, 0, log.stderr);
  assert.ok(log.stdout.includes("Run-id: run-commit-1"));
  assert.ok(log.stdout.includes("gx-dev(commit-1): Add the export widget"));

  // The main repo working tree now contains the integrated result.
  assert.ok(readFileSync(join(repo, "dev.txt"), "utf8").includes("developer output"));
  assert.ok(readFileSync(join(repo, "test.txt"), "utf8").includes("test output"));

  await manager.cleanup(handles, { force: true });
});

test("commitStaged uses the fast-forward path when gx-dev.ffOnly is true", { timeout: 30000 }, async (t) => {
  const { repo, manager, base, handles } = await prepareAndIntegrate(t, "run-commit-ff");

  const cfg = await git(repo, ["config", "gx-dev.ffOnly", "true"]);
  assert.equal(cfg.code, 0, cfg.stderr);

  // Tree of the staging result before the apply: the provenance marker the
  // fast-forward appends must keep it byte-identical.
  const preTree = await git(repo, ["rev-parse", `${handles.branches.staging}^{tree}`]);
  assert.equal(preTree.code, 0, preTree.stderr);

  // The engine message is not "unused" on the fast-forward path anymore: it
  // is written verbatim into the provenance marker commit.
  const message = buildCommitMessage({
    request: "Add the export widget",
    runId: "run-commit-ff",
    artifacts: ["dev.txt", "test.txt"],
    strategy: "fast-forward",
  });
  const applied = await manager.commitStaged(handles, message, "main");
  assert.equal(applied.strategy, "fast-forward");

  const stagingTip = await git(repo, ["rev-parse", handles.branches.staging]);
  assert.equal(applied.commitHash, stagingTip.stdout.trim());

  const head = await git(repo, ["rev-parse", "HEAD"]);
  assert.equal(head.stdout.trim(), stagingTip.stdout.trim());
  assert.notEqual(head.stdout.trim(), base);

  // The applied tip carries the exact engine message including the run-id
  // trailer, so COMMIT crash reconciliation can recognize it...
  const log = await git(repo, ["log", "--format=%B", "-1", applied.commitHash]);
  assert.equal(log.code, 0, log.stderr);
  assert.equal(log.stdout.trim(), message.trim());
  assert.ok(log.stdout.includes("Run-id: run-commit-ff"));
  assert.ok(log.stdout.includes("gx-dev(commit-ff): Add the export widget"));

  // ...without dirtying or modifying the integrated tree.
  const postTree = await git(repo, ["rev-parse", `${applied.commitHash}^{tree}`]);
  assert.equal(postTree.stdout.trim(), preTree.stdout.trim());
  const workingTreeDiff = await git(repo, ["diff", "--stat", applied.commitHash]);
  assert.equal(workingTreeDiff.stdout.trim(), "", "working tree must match the applied commit");

  // The main repo working tree contains the integrated result.
  assert.ok(readFileSync(join(repo, "dev.txt"), "utf8").includes("developer output"));
  assert.ok(readFileSync(join(repo, "test.txt"), "utf8").includes("test output"));

  await manager.cleanup(handles, { force: true });
});

test("a retried fast-forward apply never appends a duplicate provenance marker", { timeout: 30000 }, async (t) => {
  const { repo, manager, base, handles } = await prepareAndIntegrate(t, "run-commit-ff-retry");

  const cfg = await git(repo, ["config", "gx-dev.ffOnly", "true"]);
  assert.equal(cfg.code, 0, cfg.stderr);

  const message = buildCommitMessage({
    request: "Retry-safe application",
    runId: "run-commit-ff-retry",
    artifacts: [],
    strategy: "fast-forward",
  });

  // Simulate a crashed first attempt: the provenance marker landed on the
  // staging branch, then the process died before the fast-forward.
  const marker = await git(handles.staging!, [
    "-c", "user.name=gx-dev", "-c", "user.email=gx-dev@localhost",
    "commit", "--allow-empty", "--only", "-m", message,
  ]);
  assert.equal(marker.code, 0, marker.stderr);
  const crashedMarker = await git(repo, ["rev-parse", handles.branches.staging]);

  // The retry must recognize the existing marker and fast-forward as-is.
  const applied = await manager.commitStaged(handles, message, "main");
  assert.equal(applied.strategy, "fast-forward");
  assert.equal(applied.commitHash, crashedMarker.stdout.trim(), "no second marker may be created");

  const markers = await git(repo, [
    "log", "--format=%H", "-F", "--grep", `Run-id: run-commit-ff-retry`, applied.commitHash,
  ]);
  assert.equal(markers.stdout.trim().split("\n").filter((s) => s !== "").length, 1, "exactly one marker commit expected");
  assert.notEqual(applied.commitHash, base);

  await manager.cleanup(handles, { force: true });
});

test("fast-forward apply refuses a dirty staging worktree", { timeout: 30000 }, async (t) => {
  const { repo, manager, base, handles } = await prepareAndIntegrate(t, "run-commit-ff-dirty");

  const cfg = await git(repo, ["config", "gx-dev.ffOnly", "true"]);
  assert.equal(cfg.code, 0, cfg.stderr);
  writeFileSync(join(handles.staging!, "unintegrated.txt"), "not part of the verified result\n");

  await assert.rejects(
    () => manager.commitStaged(handles, buildCommitMessage({
      request: "Should not apply",
      runId: "run-commit-ff-dirty",
      artifacts: [],
      strategy: "fast-forward",
    }), "main"),
    /staging worktree has uncommitted changes/,
  );

  // Nothing was applied: main still sits on the base and no marker exists.
  const head = await git(repo, ["rev-parse", "HEAD"]);
  assert.equal(head.stdout.trim(), base);
  const markers = await git(repo, [
    "log", "--format=%H", "-F", "--grep", "Run-id: run-commit-ff-dirty", handles.branches.staging,
  ]);
  assert.equal(markers.stdout.trim(), "");

  await manager.cleanup(handles, { force: true });
});

test("commitStaged refuses a stale base with an actionable error", { timeout: 30000 }, async (t) => {
  const { repo, manager, handles } = await prepareAndIntegrate(t, "run-commit-stale");

  // Unrelated commit lands on the base branch during the run.
  writeFileSync(join(repo, "unrelated.txt"), "someone else worked here\n");
  const add = await git(repo, ["add", "-A"]);
  assert.equal(add.code, 0);
  const commit = await git(repo, ["commit", "-m", "unrelated work"], { env: GIT_ENV });
  assert.equal(commit.code, 0, commit.stderr);

  await assert.rejects(
    () => manager.commitStaged(handles, "should not apply", "main"),
    /stale base/,
  );

  // The refusal must have left the repo untouched.
  const head = await git(repo, ["log", "--format=%s", "-1"]);
  assert.ok(head.stdout.includes("unrelated work"));

  await manager.cleanup(handles, { force: true });
});

test("commitStaged refuses when the main repo tree is dirty", { timeout: 30000 }, async (t) => {
  const { repo, manager, handles } = await prepareAndIntegrate(t, "run-commit-dirty");

  writeFileSync(join(repo, "uncommitted.txt"), "in progress\n");
  await assert.rejects(
    () => manager.commitStaged(handles, "should not apply", "main"),
    /uncommitted changes/,
  );

  await manager.cleanup(handles, { force: true });
});

test("commitStaged refuses when HEAD sits on a different branch at the recorded base SHA", { timeout: 30000 }, async (t) => {
  const { repo, manager, base, handles } = await prepareAndIntegrate(t, "run-switch-1");

  // Same SHA, different branch: a user checkout mid-run must never receive
  // the result silently (the old guard only compared HEAD SHAs).
  const checkout = await git(repo, ["checkout", "-b", "other"]);
  assert.equal(checkout.code, 0, checkout.stderr);

  await assert.rejects(
    () => manager.commitStaged(handles, "should not apply", "main"),
    /branch mismatch/,
  );

  // Nothing was applied: `main` and the tree are untouched.
  const mainTip = await git(repo, ["rev-parse", "main"]);
  assert.equal(mainTip.stdout.trim(), base);
  assert.ok(!existsSync(join(repo, "dev.txt")));

  // Back on the recorded branch the same call succeeds.
  const back = await git(repo, ["checkout", "main"]);
  assert.equal(back.code, 0, back.stderr);
  const applied = await manager.commitStaged(handles, "applies on main", "main");
  assert.ok(/^[0-9a-f]{40}$/.test(applied.commitHash));

  await manager.cleanup(handles, { force: true });
});

test("commitStaged refuses a supplied base branch other than the checked-out one", { timeout: 30000 }, async (t) => {
  const { manager, handles } = await prepareAndIntegrate(t, "run-target-1");

  await assert.rejects(
    () => manager.commitStaged(handles, "should not apply", "develop"),
    /different branch/,
  );

  await manager.cleanup(handles, { force: true });
});

test("commitStaged tolerates gx-dev internal state but still refuses unrelated dirty files", { timeout: 30000 }, async (t) => {
  const { repo, manager, handles } = await prepareAndIntegrate(t, "run-internal-apply");

  // gx-dev's own runtime state does not block the final application.
  mkdirSync(join(repo, ".gx-dev", "runs", "run-internal-apply"), { recursive: true });
  writeFileSync(join(repo, ".gx-dev", "runs", "run-internal-apply", "state.json"), "{}\n");
  const applied = await manager.commitStaged(handles, "applies despite internal state", "main");
  assert.ok(/^[0-9a-f]{40}$/.test(applied.commitHash));

  await manager.cleanup(handles, { force: true });

  // Unrelated uncommitted files still block.
  const second = await prepareAndIntegrate(t, "run-unrelated-apply");
  writeFileSync(join(second.repo, "in-progress.txt"), "user work\n");
  await assert.rejects(
    () => second.manager.commitStaged(second.handles, "should not apply", "main"),
    /uncommitted changes/,
  );
  await second.manager.cleanup(second.handles, { force: true });
});

test("commitStaged emits a history-preserving revert as the rollback command", { timeout: 30000 }, async (t) => {
  const { repo, manager, base, handles } = await prepareAndIntegrate(t, "run-revert-1");

  const applied = await manager.commitStaged(handles, "rollback probe", "main");
  assert.equal(applied.rollbackCommand, `git revert --no-edit --mainline 1 ${applied.commitHash}`);
  assert.ok(!applied.rollbackCommand.includes("reset --hard"));
  assert.ok(!applied.rollbackCommand.includes("branch -f"));

  // The emitted command must actually undo the result without rewriting
  // history: run it verbatim (single command, no shell needed).
  const argv = applied.rollbackCommand.split(/\s+/).slice(1); // drop "git"
  const rollback = await git(repo, argv, { env: GIT_ENV });
  assert.equal(rollback.code, 0, rollback.stderr);

  // The working tree is back to the base content...
  assert.ok(!existsSync(join(repo, "dev.txt")));
  assert.ok(!existsSync(join(repo, "test.txt")));
  const head = await git(repo, ["rev-parse", "HEAD"]);
  assert.notEqual(head.stdout.trim(), base);
  // ...while both the base and the applied merge remain reachable in main's
  // history, and the reverted tree exactly matches the base tree.
  const history = await git(repo, ["log", "--format=%H", "main"]);
  const hashes = history.stdout.split("\n").map((line) => line.trim());
  assert.ok(hashes.includes(applied.commitHash), "merge commit must remain reachable");
  assert.ok(hashes.includes(base), "base must remain reachable");
  const treeDiff = await git(repo, ["diff", "--stat", base, "HEAD"]);
  assert.equal(treeDiff.stdout.trim(), "", "reverted tree must equal the base tree");

  await manager.cleanup(handles, { force: true });
});

test("fast-forward integration emits a first-parent revert chain whose execution restores the base tree", { timeout: 60000 }, async (t) => {
  const { repo, manager, base, handles } = await prepareAndIntegrate(t, "run-revert-ff");

  const cfg = await git(repo, ["config", "gx-dev.ffOnly", "true"]);
  assert.equal(cfg.code, 0, cfg.stderr);
  const message = buildCommitMessage({
    request: "Add the export widget",
    runId: "run-revert-ff",
    artifacts: ["dev.txt", "test.txt"],
    strategy: "fast-forward",
  });
  const applied = await manager.commitStaged(handles, message, "main");
  assert.equal(applied.strategy, "fast-forward");

  assert.ok(applied.rollbackCommand.startsWith("git revert"));
  assert.ok(!applied.rollbackCommand.includes("reset --hard"));
  assert.ok(!applied.rollbackCommand.includes("branch -f"));

  // The provenance marker is an empty tree-delta: it must not be reverted
  // (git revert would refuse and break the chain).
  assert.ok(
    !applied.rollbackCommand.includes(applied.commitHash),
    "the empty provenance marker must be skipped by the rollback",
  );

  // Only the FIRST-PARENT chain is reverted: side branches merged into
  // staging are undone by the merge reversion itself (-m 1) — reverting
  // them individually would double-revert the same diffs.
  const chain = await git(repo, ["rev-list", "--first-parent", `${base}..${applied.commitHash}`]);
  const chainShas = chain.stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  const revertible = chainShas.filter((s) => s !== applied.commitHash);
  assert.ok(revertible.length >= 2, "the chain must span the merge and its first-parent commits");
  for (const sha of revertible) {
    assert.ok(applied.rollbackCommand.includes(sha), `rollback must revert ${sha}`);
  }
  const everything = await git(repo, ["rev-list", `${base}..${applied.commitHash}`]);
  const sideBranch = everything.stdout
    .split("\n").map((s) => s.trim())
    .filter((s) => s !== "" && !chainShas.includes(s));
  assert.ok(sideBranch.length >= 1, "the merged tests branch must be a side branch of the chain");
  for (const sha of sideBranch) {
    assert.ok(
      !applied.rollbackCommand.includes(sha),
      `side-branch commit ${sha} must not be reverted individually (double revert)`,
    );
  }
  assert.equal(
    applied.rollbackCommand.split("--mainline 1").length - 1,
    1,
    "exactly one merge commit is expected in the fast-forward range",
  );
  const newest = revertible[0] ?? "";
  const oldest = revertible[revertible.length - 1] ?? "";
  assert.ok(
    applied.rollbackCommand.indexOf(newest) < applied.rollbackCommand.indexOf(oldest),
    "reversions must be ordered newest-first",
  );

  // EXECUTE the emitted rollback verbatim: it must undo the fast-forward.
  for (const step of applied.rollbackCommand.split(" && ")) {
    const argv = step.trim().split(/\s+/).slice(1); // drop "git"
    const rollback = await git(repo, argv, { env: GIT_ENV });
    assert.equal(rollback.code, 0, `rollback step failed: ${step}\n${rollback.stderr}`);
  }

  // The original base tree is restored exactly...
  const treeDiff = await git(repo, ["diff", "--stat", base, "HEAD"]);
  assert.equal(treeDiff.stdout.trim(), "", "rolled-back tree must equal the base tree");
  assert.ok(!existsSync(join(repo, "dev.txt")));
  assert.ok(!existsSync(join(repo, "test.txt")));
  // ...with zero history loss: the base, every applied commit, and the
  // provenance marker remain reachable from the branch.
  const history = await git(repo, ["log", "--format=%H", "main"]);
  const hashes = history.stdout.split("\n").map((s) => s.trim());
  assert.ok(hashes.includes(base), "base must remain reachable");
  for (const sha of chainShas) {
    assert.ok(hashes.includes(sha), `${sha} must remain reachable`);
  }
  for (const sha of sideBranch) {
    assert.ok(hashes.includes(sha), `side-branch commit ${sha} must remain reachable`);
  }

  await manager.cleanup(handles, { force: true });
});

test("buildCommitMessage produces a deterministic conventional message", () => {
  const message = buildCommitMessage({
    request: "Add dark mode toggle",
    runId: "run-abc123",
    artifacts: ["src/theme.ts", "src/settings.ts"],
    strategy: "merge-commit",
  });
  const lines = message.split("\n");
  assert.equal(lines[0], "gx-dev(abc123): Add dark mode toggle");
  assert.equal(lines[1], "");
  assert.ok(lines.includes("Run-id: run-abc123"));
  assert.ok(lines.includes("Strategy: merge-commit"));
  assert.ok(lines.includes("  - src/theme.ts"));
  assert.ok(lines.includes("  - src/settings.ts"));
  assert.ok(lines.includes("Generated by gx-dev multi-agent workflow."));
  assert.ok(message.startsWith("gx-dev(abc123): Add dark mode toggle\n\n"));

  const again = buildCommitMessage({
    request: "Add dark mode toggle",
    runId: "run-abc123",
    artifacts: ["src/theme.ts", "src/settings.ts"],
    strategy: "merge-commit",
  });
  assert.equal(message, again, "must be deterministic");
});

test("buildCommitMessage trims long requests to a 72-char first line", () => {
  const long = `${"Refactor the entire persistence layer of the reporting service so that ".repeat(3)}.`;
  const message = buildCommitMessage({
    request: long,
    runId: "run-trim-1234567890",
    artifacts: [],
    strategy: "fast-forward",
  });
  const firstLine = message.split("\n")[0] ?? "";
  assert.ok(firstLine.length <= 72, `first line too long: ${firstLine.length}`);
  assert.ok(firstLine.startsWith("gx-dev(trim-1234567): "));
  assert.ok(firstLine.endsWith("..."), "hard trim appends an ellipsis");
  // Only the first request line is used.
  const multiline = buildCommitMessage({
    request: "Fix the parser\n\nDetailed body that must not leak into the subject.",
    runId: "run-multi-1",
    artifacts: [],
    strategy: "merge-commit",
  });
  assert.equal(multiline.split("\n")[0], "gx-dev(multi-1): Fix the parser");
});
