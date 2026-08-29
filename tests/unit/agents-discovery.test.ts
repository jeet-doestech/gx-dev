/**
 * Unit tests for role prompt discovery (agents/discovery.ts).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { listRoleFiles, loadRolePrompt, parseFrontmatter } from "../../extensions/gx-dev/agents/discovery.ts";

let cleanupDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gxdev-disc-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs = [];
});

describe("parseFrontmatter", () => {
  it("parses key: value lines and preserves the body", () => {
    const md = '---\nname: researcher\ndescription: "Quoted desc"\nmodel: zai/glm-5.3-flash:max\ntools: read, bash\n---\n\n# Title\n\nBody line.\n';
    const { data, body } = parseFrontmatter(md);
    assert.deepEqual(data, {
      name: "researcher",
      description: "Quoted desc",
      model: "zai/glm-5.3-flash:max",
      tools: "read, bash",
    });
    assert.equal(body, "# Title\n\nBody line.\n");
  });

  it("splits only on the first colon", () => {
    const { data } = parseFrontmatter("---\nmodel: a/b:c:d\n---\nbody");
    assert.equal(data["model"], "a/b:c:d");
  });

  it("treats a file without frontmatter as all body", () => {
    const md = "# Just markdown\nno frontmatter here";
    const { data, body } = parseFrontmatter(md);
    assert.deepEqual(data, {});
    assert.equal(body, md);
  });

  it("treats an unclosed frontmatter block as all body", () => {
    const md = "---\nname: x\nnever closed";
    const { data, body } = parseFrontmatter(md);
    assert.deepEqual(data, {});
    assert.equal(body, md);
  });

  it("handles CRLF line endings", () => {
    const { data, body } = parseFrontmatter("---\r\nname: researcher\r\n---\r\n\r\nBody.\r\n");
    assert.equal(data["name"], "researcher");
    assert.equal(body, "Body.\n");
  });

  it("ignores lines without a colon inside frontmatter", () => {
    const { data } = parseFrontmatter("---\njusttext\nname: y\n---\n");
    assert.deepEqual(data, { name: "y" });
  });
});

describe("loadRolePrompt", () => {
  it("loads a role file with model and tools", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "researcher.md"),
      '---\nname: researcher\ndescription: d\nmodel: zai/glm-5.3-flash:max\ntools: read, bash\n---\n\nMission body.\n',
    );
    const rp = loadRolePrompt(dir, "researcher");
    assert.ok(rp);
    assert.equal(rp.role, "researcher");
    assert.equal(rp.model, "zai/glm-5.3-flash:max");
    assert.deepEqual(rp.tools, ["read", "bash"]);
    assert.equal(rp.prompt, "Mission body.");
  });

  it("maps camelCase role ids to kebab-case files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "test-writer.md"), "---\nname: testWriter\n---\nTest writer body.\n");
    writeFileSync(join(dir, "test-runner.md"), "---\nname: testRunner\n---\nTest runner body.\n");
    const writer = loadRolePrompt(dir, "testWriter");
    assert.ok(writer);
    assert.equal(writer.prompt, "Test writer body.");
    assert.ok(!writer.model);
    assert.ok(!writer.tools);
    const runner = loadRolePrompt(dir, "testRunner");
    assert.ok(runner);
    assert.equal(runner.prompt, "Test runner body.");
  });

  it("returns null for a missing role file", () => {
    const dir = tempDir();
    assert.equal(loadRolePrompt(dir, "reviewer"), null);
  });

  it("returns null for an unreadable agents directory", () => {
    assert.equal(loadRolePrompt(join(tempDir(), "does-not-exist"), "planner"), null);
  });
});

describe("listRoleFiles", () => {
  it("lists only top-level .md files, sorted", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "planner.md"), "x");
    writeFileSync(join(dir, "researcher.md"), "x");
    writeFileSync(join(dir, "notes.txt"), "x");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.md"), "x");
    assert.deepEqual(listRoleFiles(dir), ["planner.md", "researcher.md"]);
  });

  it("returns [] for a missing directory", () => {
    assert.deepEqual(listRoleFiles(join(tempDir(), "nope")), []);
  });

  it("lists the seven shipped gx-dev role files", () => {
    const dir = fileURLAgentsDir();
    assert.deepEqual(listRoleFiles(dir), [
      "committer.md",
      "developer.md",
      "planner.md",
      "researcher.md",
      "reviewer.md",
      "test-runner.md",
      "test-writer.md",
    ]);
    for (const role of ["researcher", "planner", "developer", "testWriter", "testRunner", "reviewer", "committer"]) {
      const rp = loadRolePrompt(dir, role);
      assert.ok(rp, `role ${role} must load`);
      assert.ok(rp.prompt.includes("Output contract"), `${role} prompt must contain an output contract`);
    }
  });
});

function fileURLAgentsDir(): string {
  return fileURLToPath(new URL("../../agents", import.meta.url));
}
