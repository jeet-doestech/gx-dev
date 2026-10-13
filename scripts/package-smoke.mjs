#!/usr/bin/env node
/** Pack/extract/load the published entry point without credentials or model calls. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "gx-package-smoke-"));
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }));
  const tarball = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  assert.equal(typeof tarball?.filename, "string", "npm pack did not return a tarball filename");
  execFileSync("tar", ["-xzf", join(temp, tarball.filename), "-C", temp]);
  const directory = join(temp, "package");
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  for (const role of ["researcher", "planner", "developer", "test-writer", "test-runner", "reviewer", "committer"]) {
    assert.ok(existsSync(join(directory, "agents", `${role}.md`)), `missing ${role}`);
  }
  // Host-supplied peers; this checks packed imports, not registry installation.
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  const { default: activate } = await import(pathToFileURL(join(directory, manifest.pi.extensions[0])).href);
  const commands = new Map();
  const events = new Map();
  activate({
    registerCommand: (name, spec) => commands.set(name, spec),
    registerEntryRenderer() {},
    appendEntry() {},
    on: (name, handler) => events.set(name, handler),
  });
  assert.ok(commands.has("gx-dev"));
  assert.ok(events.has("session_start"));
  assert.ok(events.has("session_shutdown"));
  await events.get("session_shutdown")?.();
  console.log("PASS: packed entry point loads and registers commands/lifecycle hooks (no model calls)");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
