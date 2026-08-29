/**
 * Unit tests for the gx-dev git worktree layer. Uses real git in per-test
 * temp repositories under os.tmpdir(); never touches the working repo.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { git, inspectRepository } from "../../extensions/gx-dev/git/repository.ts";
import { GitWorktreeManager } from "../../extensions/gx-dev/git/worktrees.ts";

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

function makeSandbox(t: TestContext): { parent: string; repo: string } {
  const parent = mkdtempSync(join(tmpdir(), "gx-dev-git-"));
  const repo = join(parent, "repo");
  mkdirSync(repo);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, repo };
}

async function initRepo(repo: string, files: Record<string, string> = {}): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repo, name), content);
  }
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

async function commitFile(
  repoOrWorktree: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  writeFileSync(join(repoOrWorktree, file), content);
  const add = await git(repoOrWorktree, ["add", "-A"]);
  assert.equal(add.code, 0, add.stderr);
  const commit = await git(repoOrWorktree, ["commit", "-m", message], { env: GIT_ENV });
  assert.equal(commit.code, 0, commit.stderr);
}

test("inspectRepository reports a clean repo", { timeout: 30000 }, async (t) => {
  const { repo } = makeSandbox(t);
  const base = await initRepo(repo, { "README.md": "# test\n" });

  const inspect = await inspectRepository(repo);
  assert.equal(inspect.isRepo, true);
  assert.equal(inspect.branch, "main");
  assert.equal(inspect.commit, base);
  assert.equal(inspect.dirty, false);
  assert.deepEqual(inspect.dirtyFiles, []);
  assert.ok(inspect.existingWorktrees.includes(repo));
});

test("inspectRepository reports dirty state with file list", { timeout: 30000 }, async (t) => {
  const { repo } = makeSandbox(t);
  await initRepo(repo, { "README.md": "# test\n", "src.txt": "src\n" });

  writeFileSync(join(repo, "README.md"), "# changed\n");
  writeFileSync(join(repo, "untracked.txt"), "new\n");

  const inspect = await inspectRepository(repo);
  assert.equal(inspect.isRepo, true);
  assert.equal(inspect.dirty, true);
  assert.ok(inspect.dirtyFiles.includes("README.md"));
  assert.ok(inspect.dirtyFiles.includes("untracked.txt"));
});

test("inspectRepository on a non-repo yields isRepo false without throwing", { timeout: 30000 }, async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "gx-dev-nonrepo-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const inspect = await inspectRepository(parent);
  assert.equal(inspect.isRepo, false);
  assert.equal(inspect.branch, null);
  assert.equal(inspect.commit, null);
  assert.equal(inspect.dirty, false);
  assert.deepEqual(inspect.dirtyFiles, []);
  assert.deepEqual(inspect.existingWorktrees, []);

  // A path that does not exist at all must also be resilient.
  const missing = await inspectRepository(join(parent, "does-not-exist"));
  assert.equal(missing.isRepo, false);
});

test("prepareWorktrees creates three worktrees and branches at the base commit", { timeout: 30000 }, async (t) => {
  const { repo } = makeSandbox(t);
  const base = await initRepo(repo, { "README.md": "# test\n" });

  const manager = new GitWorktreeManager();
  await manager.recordBase(repo);
  const handles = await manager.prepareWorktrees(repo, "run-prepare-1");

  for (const wt of [handles.developer, handles.tests, handles.staging]) {
    assert.ok(wt, "worktree path must be set");
    assert.ok(wt.includes(".gx-dev-worktrees"), wt);
  }
  assert.equal(handles.runId, "run-prepare-1");
  assert.deepEqual(handles.branches, {
    developer: "gx-dev/run-prepare-1/developer",
    tests: "gx-dev/run-prepare-1/tests",
    staging: "gx-dev/run-prepare-1/staging",
  });

  for (const role of ["developer", "tests", "staging"] as const) {
    const wt = handles[role];
    assert.ok(wt);
    const tip = await git(repo, ["rev-parse", handles.branches[role]]);
    assert.equal(tip.code, 0, tip.stderr);
    assert.equal(tip.stdout.trim(), base, `${role} branch must sit on base`);
  }

  const inspect = await inspectRepository(repo);
  for (const wt of [handles.developer, handles.tests, handles.staging]) {
    assert.ok(wt && inspect.existingWorktrees.includes(wt));
  }

  await manager.cleanup(handles);
});

test("prepareWorktrees refuses a dirty tree (refuse-to-overwrite rule)", { timeout: 30000 }, async (t) => {
  const { repo } = makeSandbox(t);
  await initRepo(repo, { "README.md": "# test\n" });

  writeFileSync(join(repo, "uncommitted.txt"), "precious\n");
  const manager = new GitWorktreeManager();
  await assert.rejects(
    () => manager.prepareWorktrees(repo, "run-dirty-1"),
    /uncommitted changes/,
  );
});

test("integrate merges non-conflicting changes from both worktrees into staging", { timeout: 30000 }, async (t) => {
  const { repo } = makeSandbox(t);
  await initRepo(repo, { "README.md": "# test\n" });

  const manager = new GitWorktreeManager();
  const handles = await manager.prepareWorktrees(repo, "run-integrate-ok");
  assert.ok(handles.developer && handles.tests && handles.staging);

  // Uncommitted work in both worktrees; integrate must checkpoint it.
  writeFileSync(join(handles.developer, "dev.txt"), "developer output\n");
  writeFileSync(join(handles.tests, "test.txt"), "test output\n");

  const result = await manager.integrate(handles);
  assert.equal(result.success, true, `integrate failed: ${JSON.stringify(result.conflictedFiles)}`);
  assert.equal(result.stagingWorktree, handles.staging);
  assert.deepEqual(result.conflictedFiles, []);
  assert.deepEqual(result.autoResolved, []);

  const dev = await git(handles.staging, ["show", "HEAD:dev.txt"]);
  assert.equal(dev.code, 0, dev.stderr);
  assert.ok(dev.stdout.includes("developer output"));
  const tst = await git(handles.staging, ["show", "HEAD:test.txt"]);
  assert.equal(tst.code, 0, tst.stderr);
  assert.ok(tst.stdout.includes("test output"));

  const devLog = await git(handles.developer, ["log", "--format=%s", "HEAD"]);
  assert.ok(devLog.stdout.includes("gx-dev checkpoint: developer"));
  const testLog = await git(handles.tests, ["log", "--format=%s", "HEAD"]);
  assert.ok(testLog.stdout.includes("gx-dev checkpoint: tests"));

  await manager.cleanup(handles);
});

test("integrate reports conflicting same-line edits and aborts the merge", { timeout: 30000 }, async (t) => {
  const { repo } = makeSandbox(t);
  await initRepo(repo, { "conflict.txt": "base line one\nbase line two\n" });

  const manager = new GitWorktreeManager();
  const handles = await manager.prepareWorktrees(repo, "run-integrate-clash");
  assert.ok(handles.developer && handles.tests && handles.staging);

  writeFileSync(join(handles.developer, "conflict.txt"), "developer line one\nbase line two\n");
  writeFileSync(join(handles.tests, "conflict.txt"), "tests line one\nbase line two\n");

  const result = await manager.integrate(handles);
  assert.equal(result.success, false);
  assert.deepEqual([...result.conflictedFiles].sort(), ["conflict.txt"]);

  // The abort must have restored a clean staging worktree.
  const status = await git(handles.staging, ["status", "--porcelain"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.stdout.trim(), "");

  await manager.cleanup(handles, { force: true });
});

test("cleanup removes worktrees and deletes only the run's branches", { timeout: 30000 }, async (t) => {
  const { repo } = makeSandbox(t);
  const base = await initRepo(repo, { "README.md": "# test\n" });

  const manager = new GitWorktreeManager();
  const handles = await manager.prepareWorktrees(repo, "run-cleanup-1");
  for (const wt of [handles.developer, handles.tests, handles.staging]) {
    assert.ok(wt, "worktree must exist before cleanup");
  }

  // Unrelated branch must survive cleanup untouched.
  await git(repo, ["branch", "feature-unrelated", base]);

  await manager.cleanup(handles);

  for (const wt of [handles.developer, handles.tests, handles.staging]) {
    assert.ok(wt !== null && !existsSync(wt), `worktree ${wt} should be gone`);
  }
  for (const branch of [handles.branches.developer, handles.branches.tests, handles.branches.staging]) {
    const check = await git(repo, ["rev-parse", "--verify", `${branch}^{commit}`]);
    assert.notEqual(check.code, 0, `branch ${branch} should be deleted`);
  }
  const unrelated = await git(repo, ["rev-parse", "--verify", "feature-unrelated"]);
  assert.equal(unrelated.code, 0, "unrelated branch must survive");
});

test("checkpointStaging commits documentation edits and returns null when clean", { timeout: 30000 }, async (t) => {
  const { repo } = makeSandbox(t);
  await initRepo(repo, { "README.md": "# test\n" });

  const manager = new GitWorktreeManager();
  const handles = await manager.prepareWorktrees(repo, "run-docchk-1");
  assert.ok(handles.staging);

  // Clean tree: no commit, null result.
  const none = await manager.checkpointStaging(handles, "gx-dev checkpoint: documentation");
  assert.equal(none, null, "clean staging must return null");

  // Documentation edit: committed, hash returned, tree clean afterwards.
  writeFileSync(join(handles.staging, "README.md"), "# test\n\nUpdated by reviewer.\n");
  const hash = await manager.checkpointStaging(handles, "gx-dev checkpoint: documentation");
  assert.ok(hash && /^[0-9a-f]{40}$/.test(hash), "checkpoint must return the new commit hash");
  const status = await git(handles.staging, ["status", "--porcelain"]);
  assert.equal(status.stdout.trim(), "", "staging must be clean after checkpoint");

  await manager.cleanup(handles, { force: true });
});
