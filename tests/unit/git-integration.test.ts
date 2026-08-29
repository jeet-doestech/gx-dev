/**
 * Unit tests for the gx-dev git integration + commit layer: diff helpers,
 * commitStaged application (merge-commit / fast-forward, stale-base and
 * dirty-tree refusals), and the deterministic commit message builder.
 * Uses real git in per-test temp repositories under os.tmpdir().
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  assert.ok(applied.rollbackCommand.startsWith(`git reset --hard ${base} `));
  assert.ok(applied.rollbackCommand.includes(`git branch -f main ${base}`));

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

  const applied = await manager.commitStaged(handles, "unused on ff", "main");
  assert.equal(applied.strategy, "fast-forward");

  const stagingTip = await git(repo, ["rev-parse", handles.branches.staging]);
  assert.equal(applied.commitHash, stagingTip.stdout.trim());

  const head = await git(repo, ["rev-parse", "HEAD"]);
  assert.equal(head.stdout.trim(), stagingTip.stdout.trim());
  assert.notEqual(head.stdout.trim(), base);

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
