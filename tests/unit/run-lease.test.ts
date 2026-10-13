/**
 * Unit tests for the repository execution lease (REVIEW §1 "Make lifecycle
 * durable": repository/run locks across independent Engine processes).
 *
 * Scope pinned here:
 * - FsRunStore.acquireLease (domain/lease.ts): the lock at execution.lock is a
 *   DIRECTORY holding a fully written owner.json; acquisition is an ATOMIC
 *   NON-REPLACING rename of a prepared claim directory — POSIX refuses a
 *   directory rename onto an existing nonempty directory (Windows refuses any
 *   existing directory), so the kernel itself serializes contenders and no
 *   settle delay or statistical race remains. A LIVE owner is refused
 *   (regardless of age — no TTL); a DEAD owner is reclaimed by renaming its
 *   lock to a deterministic tombstone path derived from its token, which is
 *   RETAINED PERMANENTLY (a retained tombstone is what keeps arbitrarily
 *   delayed stale reclaimers from moving a successor's live lock); corrupt,
 *   ownerless, and legacy-FILE locks fail closed with actionable manual
 *   recovery; release renames the owner's own token-verified lock aside and
 *   never touches a successor's lock.
 * - Kernel rename semantics the protocol relies on (directory onto nonempty
 *   directory is refused; directory onto a file is refused; directory onto an
 *   EMPTY directory replaces on POSIX — which is exactly why the published
 *   lock must be nonempty from the instant it exists).
 * - REAL two-process behavior: a second node process holding the lease blocks
 *   this process; killing it (SIGKILL) lets this process reclaim; competing
 *   processes contending for the same lock (fresh AND dead-owner reclaim)
 *   hold it strictly sequentially — never simultaneously.
 * - FORCED (not statistical) delayed stale reclaimer: a real second process
 *   wins a dead-owner reclaim and begins holding the lease while a stale
 *   reclaimer — which had already read the dead owner — is arbitrarily
 *   preempted; when the stale reclaimer resumes, BOTH of its renames (the
 *   tombstone move and the claim install) are refused by the kernel and the
 *   winner is untouched.
 * - FsRunStore hardening: run-id path traversal refused, state.json schema
 *   sanity, unique per-writer temp names under concurrent saves.
 * - Engine integration: start/resume/answer wrap the lease try/finally
 *   through drive(); a competing Engine is refused while another drives; a
 *   new start is refused while ANY persisted run is unfinished (active-run
 *   discovery under the lease); a dead owner never blocks a new engine;
 *   pause/cancel cooperate reentrantly with this engine's own drive (no
 *   deadlock) and take the lease only when this engine does not own it;
 *   same-instance simultaneous start/resume reject with no duplicate drive.
 */

import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Readable } from "node:stream";
import { test } from "node:test";

import { Engine, type EngineUI } from "../../extensions/gx-dev/orchestration/engine.ts";
import {
  EXECUTION_LEASE_FILENAME,
  FsRunStore,
  isValidRunId,
  MemoryRunStore,
  runDir,
} from "../../extensions/gx-dev/domain/persist.ts";
import {
  acquireFileLease,
  isPidAlive,
  ownerIsDead,
  reclaimedTombstonePath,
} from "../../extensions/gx-dev/domain/lease.ts";
import { FsArtifactStore } from "../../extensions/gx-dev/domain/artifacts.ts";
import type { ArtifactStore, EvidenceKind, EvidenceRecord } from "../../extensions/gx-dev/domain/artifacts.ts";
import { JsonlEventStore } from "../../extensions/gx-dev/domain/events.ts";
import type { EventStore, GxEventType } from "../../extensions/gx-dev/domain/events.ts";
import type { RunStore } from "../../extensions/gx-dev/domain/interfaces.ts";
import { createRunState, type RunState } from "../../extensions/gx-dev/domain/state.ts";
import { defaultConfig } from "../../extensions/gx-dev/config.ts";
import {
  asRunState,
  autoApprovalUI,
  defaultCompletion,
  FakeAgentRunner,
  FakeCommandExecutor,
  FakeGitCoordinator,
  FakeMemoryCoordinator,
  makeFixtureRepo,
} from "../helpers/fakes.ts";
import type { FakeScript } from "../helpers/fakes.ts";

const REQUEST = "add farewell() to greet module";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEASE_MODULE_URL = pathToFileURL(
  join(ROOT, "extensions", "gx-dev", "domain", "lease.ts"),
).href;

// ------------------------------------------------------------------- helpers

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function leasePath(repoPath: string): string {
  return join(repoPath, ".gx-dev", "runs", EXECUTION_LEASE_FILENAME);
}

function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) {
        resolveWait();
        return;
      }
      if (Date.now() > deadline) {
        rejectWait(new Error(`waitFor timed out: ${what}`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Lease child processes: stdin closed, stdout/stderr piped. */
type LeaseChild = ChildProcessByStdio<null, Readable, Readable>;

function exitOf(child: LeaseChild): Promise<number> {
  return new Promise((resolveExit) => {
    // An already-exited child never emits 'exit' again.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit(child.exitCode ?? -1);
      return;
    }
    child.on("exit", (code) => resolveExit(code ?? -1));
  });
}

/**
 * Forges a lease as if published by another process: a lock DIRECTORY holding
 * a fully written owner.json — exactly the shape the directory protocol
 * publishes.
 */
function forgeOwner(
  lock: string,
  owner: { pid: number; token?: string; acquiredAt?: string; pidStartTime?: string },
): void {
  mkdirSync(lock, { recursive: true });
  const record = {
    pid: owner.pid,
    token: owner.token ?? "forged-token",
    acquiredAt: owner.acquiredAt ?? new Date().toISOString(),
    ...(owner.pidStartTime !== undefined ? { pidStartTime: owner.pidStartTime } : {}),
  };
  writeFileSync(join(lock, "owner.json"), JSON.stringify(record), "utf8");
}

function readOwnerFile(lock: string): { pid: number; token: string; acquiredAt: string } {
  return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as {
    pid: number;
    token: string;
    acquiredAt: string;
  };
}

/**
 * A real dead pid: spawn a child, SIGKILL it, and wait for the exit event so
 * the pid is provably gone (tests restart/dead-owner reclaim).
 */
async function makeDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    stdio: "ignore",
  });
  const pid = child.pid ?? -1;
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    child.on("exit", () => resolveExit());
  });
  return pid;
}

// ------------------------------------------------- real child-process harness

/**
 * Inline script for REAL second processes. Modes:
 * - hold: acquire the lease, print HELD, hang forever (parent SIGKILLs it —
 *   simulating a crashed engine process that leaves a dead-owner lock).
 * - try-once: attempt the lease once; record the held interval or the
 *   refusal; exit.
 * - retry: retry acquiring (as a competing engine politely would) until a
 *   deadline; record the held interval; exit.
 */
const CHILD_SCRIPT = `
(async () => {
  const { acquireFileLease } = await import(process.env.GX_LEASE_MODULE);
  const { appendFileSync } = await import("node:fs");
  const lock = process.env.GX_LOCK;
  const mode = process.env.GX_MODE;
  const resultFile = process.env.GX_RESULT;
  const holdMs = Number(process.env.GX_HOLD_MS ?? "150");
  if (mode === "hold") {
    const release = await acquireFileLease(lock);
    await release;
    process.stdout.write("HELD\\n");
    // Keep the event loop (and therefore this process) alive until the
    // parent SIGKILLs it: a forever-pending promise alone would drain the
    // loop and turn the "live" owner into a dead one.
    setInterval(() => {}, 10_000);
    await new Promise(() => {});
  } else if (mode === "try-once") {
    try {
      const release = await acquireFileLease(lock);
      const start = Date.now();
      await new Promise((r) => setTimeout(r, holdMs));
      await release();
      appendFileSync(resultFile, JSON.stringify({ ok: true, pid: process.pid, start, end: Date.now() }) + "\\n");
    } catch (e) {
      appendFileSync(resultFile, JSON.stringify({ ok: false, pid: process.pid, error: String(e && e.message) }) + "\\n");
    }
  } else if (mode === "retry") {
    const deadline = Date.now() + 8000;
    let release = null;
    while (release === null) {
      try {
        release = await acquireFileLease(lock);
      } catch (e) {
        if (Date.now() > deadline) {
          appendFileSync(resultFile, JSON.stringify({ ok: false, pid: process.pid, error: String(e && e.message) }) + "\\n");
          process.exit(0);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const start = Date.now();
    await new Promise((r) => setTimeout(r, holdMs));
    await release();
    appendFileSync(resultFile, JSON.stringify({ ok: true, pid: process.pid, start, end: Date.now() }) + "\\n");
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
`;

function spawnLeaseChild(env: Record<string, string>): LeaseChild {
  return spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Resolves once the child printed HELD (it holds the lease from then on). */
function waitUntilHeld(child: LeaseChild): Promise<void> {
  return new Promise((resolveHeld, rejectHeld) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectHeld(new Error("child never reported HELD"));
    }, 15_000);
    const onData = (d: Buffer): void => {
      if (d.toString().includes("HELD")) {
        cleanup();
        resolveHeld();
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      rejectHeld(new Error(`child exited before HELD (code ${code})`));
    };
    function cleanup(): void {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    }
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

interface RecordedInterval {
  ok: boolean;
  pid: number;
  start?: number;
  end?: number;
  error?: string;
}

function readIntervals(resultFile: string): RecordedInterval[] {
  return readFileSync(resultFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedInterval);
}

/** Held intervals must be strictly sequential: never two owners at once. */
function assertNoOverlap(intervals: RecordedInterval[], what: string): void {
  const held = intervals
    .filter((i) => i.ok)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  assert.ok(held.length >= 2, `${what}: expected >=2 successful holders, got ${held.length}`);
  for (let i = 1; i < held.length; i += 1) {
    const prev = held[i - 1]!;
    const cur = held[i]!;
    assert.ok(
      (cur.start ?? 0) >= (prev.end ?? 0) - 5,
      `${what}: leases overlapped (pid ${prev.pid} held until ${prev.end}, pid ${cur.pid} started ${cur.start})`,
    );
  }
}

// ------------------------------------------------- engine harness (lease on)

/**
 * Self-binding persistence WITH the execution lease wired (mirrors index.ts,
 * which passes a bare FsRunStore into the engine). Optionally omits
 * acquireLease to pin the graceful-degradation contract.
 */
class DeferredLeaseStores {
  readonly runStore: RunStore;
  readonly artifacts: ArtifactStore;
  readonly events: EventStore;
  private bound: { artifacts: FsArtifactStore; events: JsonlEventStore } | null = null;
  private readonly fs: FsRunStore;

  constructor(repoPath: string, opts: { withLease?: boolean } = {}) {
    this.fs = new FsRunStore(repoPath);
    const self = this;
    const bind = (runId: string): void => {
      if (self.bound !== null) return;
      const dir = join(repoPath, ".gx-dev", "runs", runId);
      self.bound = {
        artifacts: new FsArtifactStore(dir),
        events: new JsonlEventStore(dir),
      };
    };
    const withLease = opts.withLease !== false;
    this.runStore = {
      save: async (state: RunState): Promise<void> => {
        bind(state.runId);
        await self.fs.save(state);
      },
      load: (runId: string) => self.fs.load(runId),
      list: () => self.fs.list(),
      ...(withLease ? { acquireLease: () => self.fs.acquireLease() } : {}),
    };
    const outer = this;
    this.artifacts = {
      get runDir(): string {
        return outer.bound!.artifacts.runDir;
      },
      recordEvidence(
        kind: EvidenceKind,
        content: string,
        source: string,
        name?: string,
      ): EvidenceRecord {
        return outer.bound!.artifacts.recordEvidence(kind, content, source, name);
      },
      readArtifact(name: string): string | null {
        return outer.bound!.artifacts.readArtifact(name);
      },
      writeArtifact(name: string, content: string): string {
        return outer.bound!.artifacts.writeArtifact(name, content);
      },
      evidence(): EvidenceRecord[] {
        return outer.bound!.artifacts.evidence();
      },
    };
    this.events = {
      append(type: GxEventType, message: string, data?: Record<string, unknown>) {
        return outer.bound!.events.append(type, message, data);
      },
      events() {
        return outer.bound!.events.events();
      },
    };
  }
}

interface EngineHarness {
  engine: Engine;
  agents: FakeAgentRunner;
  git: FakeGitCoordinator;
  memory: FakeMemoryCoordinator;
  stores: DeferredLeaseStores;
}

function makeLeaseEngine(
  repoPath: string,
  opts: {
    script?: FakeScript;
    ui?: EngineUI;
    withLease?: boolean;
  } = {},
): EngineHarness {
  const agents = new FakeAgentRunner(opts.script ?? (() => undefined));
  const git = new FakeGitCoordinator();
  const memory = new FakeMemoryCoordinator();
  const stores = new DeferredLeaseStores(repoPath, {
    ...(opts.withLease !== undefined ? { withLease: opts.withLease } : {}),
  });
  const engine = new Engine(repoPath, {
    runner: agents,
    git,
    memory,
    runStore: stores.runStore,
    artifacts: stores.artifacts,
    events: stores.events,
    config: defaultConfig(),
    executor: new FakeCommandExecutor(),
    ...(opts.ui !== undefined ? { ui: opts.ui } : {}),
  });
  return { engine, agents, git, memory, stores };
}

/** Script that holds the FIRST researcher invocation open until released. */
function gateResearcher(): { script: FakeScript; open: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const script: FakeScript = async (role, _task, call) => {
    if (role === "researcher" && call === 1) {
      await gate;
      return { completion: defaultCompletion("researcher") };
    }
    return undefined;
  };
  return { script, open: release };
}

// ------------------------------------------------------------ lease file tests

test("lease: exclusive acquire/release across two stores; refusal names the live owner; release is idempotent and removes the lock", async () => {
  const repoPath = makeTempDir("gx-dev-lease-basic-");
  const storeA = new FsRunStore(repoPath);
  const storeB = new FsRunStore(repoPath);
  try {
    const release = await storeA.acquireLease();
    const owner = readOwnerFile(leasePath(repoPath));
    assert.equal(owner.pid, process.pid, "the lock records the owning pid");

    await assert.rejects(() => storeB.acquireLease(), (e: Error) => {
      assert.match(e.message, /lease/);
      assert.match(e.message, new RegExp(`pid ${process.pid}`));
      return true;
    });

    await release();
    await release(); // idempotent
    assert.equal(existsSync(leasePath(repoPath)), false, "release removes the lock directory");

    const releaseB = await storeB.acquireLease();
    await releaseB();
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("lease: a LIVE owner is refused regardless of age (never breaks merely by being old)", async () => {
  const repoPath = makeTempDir("gx-dev-lease-live-");
  const store = new FsRunStore(repoPath);
  try {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    forgeOwner(leasePath(repoPath), { pid: process.pid, acquiredAt: old });
    await assert.rejects(
      () => store.acquireLease(),
      (e: Error) => {
        assert.match(e.message, /pid/);
        assert.match(e.message, /lease/);
        return true;
      },
    );
    assert.equal(existsSync(leasePath(repoPath)), true, "a refused acquirer never deletes the lock");
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("lease: dead owner (crashed process) is reclaimed on restart — age is irrelevant", async () => {
  const repoPath = makeTempDir("gx-dev-lease-dead-");
  const store = new FsRunStore(repoPath);
  try {
    const deadPid = await makeDeadPid();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    forgeOwner(leasePath(repoPath), { pid: deadPid, acquiredAt: old });
    const release = await store.acquireLease();
    const owner = readOwnerFile(leasePath(repoPath));
    assert.equal(owner.pid, process.pid, "the dead owner was replaced by the reclaimer");
    await release();
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("lease: corrupt and ownerless lock directories fail closed — never guessed dead, never reclaimed, never deleted", async () => {
  const repoPath = makeTempDir("gx-dev-lease-corrupt-");
  const store = new FsRunStore(repoPath);
  const lock = leasePath(repoPath);
  try {
    // An ownerless lock directory (no owner.json at all).
    mkdirSync(lock, { recursive: true });
    await assert.rejects(
      () => store.acquireLease(),
      (e: Error) => {
        assert.match(e.message, /owner record/);
        assert.match(e.message, /manual/);
        return true;
      },
    );
    assert.equal(existsSync(lock), true, "an ownerless lock is never deleted by the library");
    assert.deepEqual(readdirSync(lock), [], "an ownerless lock is never written to");
    rmSync(lock, { recursive: true, force: true });

    // A lock directory whose owner record is garbage.
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), "not json at all", "utf8");
    await assert.rejects(() => store.acquireLease(), /owner record/);
    assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), "not json at all");
    rmSync(lock, { recursive: true, force: true });

    // An owner record with a path-unsafe token (untrusted input): the token
    // is embedded verbatim in tombstone paths, so it must fail closed.
    forgeOwner(lock, { pid: await makeDeadPid(), token: "../evil" });
    await assert.rejects(() => store.acquireLease(), /owner record/);
    assert.equal(
      readOwnerFile(lock).token,
      "../evil",
      "an unsafe-token lock is never reclaimed or modified",
    );
    rmSync(lock, { recursive: true, force: true });

    // Manual recovery (remove the stale lock) unblocks acquisition.
    const release = await store.acquireLease();
    await release();
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("lease: a legacy lock FILE is refused with actionable manual recovery (never auto-replaced)", async () => {
  const repoPath = makeTempDir("gx-dev-lease-legacy-");
  const store = new FsRunStore(repoPath);
  const lock = leasePath(repoPath);
  try {
    mkdirSync(dirname(lock), { recursive: true });
    // Older gx-dev releases published an exclusive-create lock FILE (here:
    // even one with a live owner record — it must not be trusted OR replaced).
    const legacy = JSON.stringify({ pid: process.pid, token: "legacy", acquiredAt: "" });
    writeFileSync(lock, legacy, "utf8");
    await assert.rejects(
      () => store.acquireLease(),
      (e: Error) => {
        assert.match(e.message, /legacy lock FILE/);
        assert.match(e.message, /manual/);
        assert.match(e.message, /rm /);
        return true;
      },
    );
    assert.equal(existsSync(lock), true, "the legacy file was not deleted");
    assert.equal(readFileSync(lock, "utf8"), legacy, "the legacy file was not modified");

    // Manual recovery unblocks the directory protocol.
    rmSync(lock, { force: true });
    const release = await store.acquireLease();
    await release();
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("fs rename semantics the lease protocol relies on", () => {
  const base = makeTempDir("gx-dev-lease-rename-");
  try {
    const mkClaim = (name: string): string => {
      const dir = join(base, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "owner.json"), `"${name}"`, "utf8");
      return dir;
    };

    // (1) directory → existing NONEMPTY directory is refused on every
    // platform: the acquisition primitive. First rename wins; every later
    // rename is refused by the kernel (ENOTEMPTY on POSIX; EEXIST/EPERM on
    // Windows). This is what makes the claim non-replacing.
    const a = mkClaim("a");
    const bFull = mkClaim("b-full");
    assert.throws(
      () => renameSync(a, bFull),
      (e: NodeJS.ErrnoException) =>
        ["ENOTEMPTY", "EEXIST", "EPERM"].includes(e.code ?? ""),
      "a directory rename onto a nonempty directory must be refused",
    );
    assert.equal(existsSync(join(bFull, "owner.json")), true, "the target was untouched");
    assert.equal(existsSync(join(a, "owner.json")), true, "the source was untouched");

    // (2) directory → existing EMPTY directory: POSIX silently REPLACES it
    // (Windows refuses). The protocol never leaves the lock empty, so this
    // difference is never exercised — pinned here to document exactly why the
    // published lock must be nonempty from the instant it exists.
    const c = mkClaim("c");
    const dEmpty = join(base, "d-empty");
    mkdirSync(dEmpty, { recursive: true });
    if (process.platform === "win32") {
      assert.throws(() => renameSync(c, dEmpty));
    } else {
      renameSync(c, dEmpty);
      assert.equal(existsSync(join(dEmpty, "owner.json")), true, "the empty dir was replaced");
      assert.equal(existsSync(c), false, "the source moved");
    }

    // (3) directory → existing FILE is refused: a legacy lock FILE can never
    // be silently replaced by a claim rename (fail closed on legacy state).
    const legacyFile = join(base, "legacy.lock");
    writeFileSync(legacyFile, "legacy", "utf8");
    const g = mkClaim("g");
    assert.throws(() => renameSync(g, legacyFile));
    assert.equal(readFileSync(legacyFile, "utf8"), "legacy", "the file was untouched");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("lease: pid liveness and pid-reuse detection", { skip: process.platform !== "linux" }, async () => {
  const deadPid = await makeDeadPid();
  assert.equal(isPidAlive(deadPid), false, "a SIGKILLed pid is dead");
  assert.equal(isPidAlive(process.pid), true, "own pid is alive");
  assert.equal(ownerIsDead({ pid: deadPid, token: "t", acquiredAt: "" }), true);
  assert.equal(ownerIsDead({ pid: process.pid, token: "t", acquiredAt: "" }), false);
  // A live-looking pid whose /proc start time differs from the recorded one
  // is a REUSED pid: the original owner is dead.
  assert.equal(
    ownerIsDead({ pid: process.pid, token: "t", acquiredAt: "", pidStartTime: "1" }),
    true,
    "pid reuse (start time mismatch) counts as dead",
  );
  assert.equal(ownerIsDead({ pid: 0, token: "t", acquiredAt: "" }), true);
});

test("REAL two processes: a live child process holding the lease blocks this process; SIGKILL lets it reclaim", async () => {
  const repoPath = makeTempDir("gx-dev-lease-twoproc-");
  const store = new FsRunStore(repoPath);
  const child = spawnLeaseChild({
    GX_LEASE_MODULE: LEASE_MODULE_URL,
    GX_LOCK: leasePath(repoPath),
    GX_MODE: "hold",
  });
  try {
    await waitUntilHeld(child);
    const owner = readOwnerFile(leasePath(repoPath));
    assert.equal(owner.pid, child.pid, "the child process owns the lease directory");
    const childToken = owner.token;

    // Live owner refuses THIS process (cross-process mutual exclusion)...
    await assert.rejects(() => store.acquireLease(), /held by pid/);
    assert.equal(readOwnerFile(leasePath(repoPath)).pid, child.pid, "the refusal left the live owner intact");

    // Restart-safety: SIGKILL the holding process (a crashed engine), then
    // this process reclaims the dead owner's lease.
    child.kill("SIGKILL");
    assert.equal(await exitOf(child), -1, "the child died by signal");
    const release = await store.acquireLease();
    const reclaimed = readOwnerFile(leasePath(repoPath));
    assert.equal(reclaimed.pid, process.pid, "the dead owner's lease was reclaimed");
    await release();
    assert.equal(existsSync(leasePath(repoPath)), false, "release cleaned the reclaimed lock");
    assert.equal(
      existsSync(reclaimedTombstonePath(leasePath(repoPath), childToken)),
      true,
      "the killed owner's tombstone is retained",
    );

    // And the same refusal works for a SECOND live process.
    const child2 = spawnLeaseChild({
      GX_LEASE_MODULE: LEASE_MODULE_URL,
      GX_LOCK: leasePath(repoPath),
      GX_MODE: "hold",
    });
    try {
      await waitUntilHeld(child2);
      await assert.rejects(() => store.acquireLease(), new RegExp(`pid ${child2.pid}`));
    } finally {
      child2.kill("SIGKILL");
      await exitOf(child2);
    }
    const release2 = await store.acquireLease();
    const owner2 = readOwnerFile(leasePath(repoPath));
    assert.equal(owner2.pid, process.pid, "the second dead owner was reclaimed too");
    await release2();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exitOf(child).catch(() => -1);
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("REAL two processes: competing children hold the lease strictly sequentially (no simultaneous owners)", async () => {
  const repoPath = makeTempDir("gx-dev-lease-contend-");
  const resultFile = join(repoPath, "intervals.jsonl");
  const children = [1, 2, 3].map(() =>
    spawnLeaseChild({
      GX_LEASE_MODULE: LEASE_MODULE_URL,
      GX_LOCK: leasePath(repoPath),
      GX_MODE: "retry",
      GX_RESULT: resultFile,
      GX_HOLD_MS: "120",
    }),
  );
  try {
    await Promise.all(children.map(exitOf));
    const intervals = readIntervals(resultFile);
    assert.equal(
      intervals.filter((i) => i.ok).length,
      3,
      `every competing child eventually held the lease: ${JSON.stringify(intervals)}`,
    );
    assertNoOverlap(intervals, "fresh-lock contention");
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("REAL two processes: concurrent reclaimers of a dead owner's lease are serialized — never two simultaneous owners", async () => {
  const repoPath = makeTempDir("gx-dev-lease-reclaim-");
  const resultFile = join(repoPath, "intervals.jsonl");
  const deadPid = await makeDeadPid();
  forgeOwner(leasePath(repoPath), { pid: deadPid });
  const children = [1, 2].map(() =>
    spawnLeaseChild({
      GX_LEASE_MODULE: LEASE_MODULE_URL,
      GX_LOCK: leasePath(repoPath),
      GX_MODE: "retry",
      GX_RESULT: resultFile,
      GX_HOLD_MS: "120",
    }),
  );
  try {
    await Promise.all(children.map(exitOf));
    const intervals = readIntervals(resultFile);
    assert.equal(
      intervals.filter((i) => i.ok).length,
      2,
      `both reclaimers eventually held the lease: ${JSON.stringify(intervals)}`,
    );
    assertNoOverlap(intervals, "dead-owner reclaim contention");
    // The dead owner's tombstone was retained through the whole contention.
    assert.equal(
      existsSync(reclaimedTombstonePath(leasePath(repoPath), "forged-token")),
      true,
      "the reclaimed dead owner's tombstone is retained",
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("FORCED delayed stale reclaimer: preempted after reading a dead owner, it can neither tombstone the winner's live lock nor install its claim (REAL second process)", async () => {
  const repoPath = makeTempDir("gx-dev-lease-stale-");
  const lock = leasePath(repoPath);
  const deadToken = "stale-dead-token";
  let child: LeaseChild | null = null;
  try {
    // The dead owner whose lock a reclaimer would try to reclaim.
    const deadPid = await makeDeadPid();
    forgeOwner(lock, { pid: deadPid, token: deadToken });
    const tombstone = reclaimedTombstonePath(lock, deadToken);
    assert.equal(existsSync(tombstone), false, "no tombstone exists yet");

    // ── The stale reclaimer's state: it has ALREADY read the dead owner and
    // derived its tombstone path. The OS now preempts it — simulated here,
    // deterministically, by a REAL second process running to completion while
    // the stale reclaimer does not execute another instruction.

    // The winner: a real second process reclaims the dead owner and holds.
    child = spawnLeaseChild({
      GX_LEASE_MODULE: LEASE_MODULE_URL,
      GX_LOCK: lock,
      GX_MODE: "hold",
    });
    await waitUntilHeld(child);

    // The winner tombstoned the dead owner (retained record) and owns the lock.
    assert.equal(existsSync(tombstone), true, "the winner retired the dead owner's lock");
    assert.equal(
      JSON.parse(readFileSync(join(tombstone, "owner.json"), "utf8")).token,
      deadToken,
      "the tombstone retains the dead owner's record",
    );
    const winner = readOwnerFile(lock);
    assert.equal(winner.pid, child.pid, "the winner holds the lock");
    const winnerToken = winner.token;

    // ── The stale reclaimer resumes. Step 1: its tombstone rename. The target
    // tombstone already exists and is nonempty, so the kernel must refuse —
    // the winner's live lock must NOT be moved aside or overwritten.
    let refused: NodeJS.ErrnoException | null = null;
    try {
      renameSync(lock, tombstone);
    } catch (e) {
      refused = e as NodeJS.ErrnoException;
    }
    assert.ok(refused !== null, "the stale tombstone rename must be refused by the kernel");
    assert.ok(
      ["ENOTEMPTY", "EEXIST", "EPERM"].includes(refused.code ?? ""),
      `expected an occupancy refusal, got ${refused.code}`,
    );
    assert.equal(readOwnerFile(lock).token, winnerToken, "the winner's lock was untouched");

    // Stale reclaimer step 2: install its own prepared claim directory. The
    // kernel must refuse here too (the lock directory is nonempty).
    const staleClaim = join(dirname(lock), `${basename(lock)}.stale-claim`);
    mkdirSync(staleClaim, { recursive: true });
    writeFileSync(
      join(staleClaim, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "stale-claim-token", acquiredAt: "" }),
      "utf8",
    );
    let claimRefused: NodeJS.ErrnoException | null = null;
    try {
      renameSync(staleClaim, lock);
    } catch (e) {
      claimRefused = e as NodeJS.ErrnoException;
    }
    assert.ok(claimRefused !== null, "the stale claim rename must be refused by the kernel");
    rmSync(staleClaim, { recursive: true, force: true });
    assert.equal(readOwnerFile(lock).token, winnerToken, "the winner still holds the lock");

    // End to end: the public API still refuses for THIS process as well —
    // the winner is unharmed and in full possession of the lease.
    await assert.rejects(() => acquireFileLease(lock), new RegExp(`held by pid ${child!.pid}`));

    // Normal operation afterwards: SIGKILL the winner and reclaim it.
    child.kill("SIGKILL");
    assert.equal(await exitOf(child), -1);
    const release = await acquireFileLease(lock);
    assert.equal(readOwnerFile(lock).pid, process.pid, "the dead winner was reclaimed");
    await release();
    assert.equal(existsSync(lock), false, "release vacated the lock");

    // Both tombstones (the original dead owner's AND the killed winner's)
    // are retained permanently — they are what keeps any later stale
    // reclaimer for those tokens safe.
    assert.equal(existsSync(tombstone), true, "the original tombstone is retained forever");
    assert.equal(
      existsSync(reclaimedTombstonePath(lock, winnerToken)),
      true,
      "the winner's tombstone is retained too",
    );
  } finally {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exitOf(child).catch(() => -1);
    }
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("tombstone retention: a second delayed reclaimer for the SAME dead token cannot move a successor's lock onto the retained tombstone", async () => {
  const repoPath = makeTempDir("gx-dev-lease-tomb-");
  const lock = leasePath(repoPath);
  try {
    const deadPid = await makeDeadPid();
    forgeOwner(lock, { pid: deadPid, token: "dead-token-A" });
    const tombstone = reclaimedTombstonePath(lock, "dead-token-A");

    // Reclaimer 1 wins the tombstone step and claims the lock (a live
    // successor owner).
    renameSync(lock, tombstone);
    forgeOwner(lock, { pid: process.pid, token: "successor-live" });

    // Reclaimer 2 read dead-token-A long ago and only now resumes with the
    // exact step the protocol prescribes: rename the lock to the SAME
    // deterministic tombstone. The retained nonempty tombstone makes the
    // kernel refuse; the successor's live lock is never moved.
    let refused: NodeJS.ErrnoException | null = null;
    try {
      renameSync(lock, tombstone);
    } catch (e) {
      refused = e as NodeJS.ErrnoException;
    }
    assert.ok(refused !== null, "the late reclaimer's tombstone rename must be refused");
    assert.equal(
      readOwnerFile(lock).token,
      "successor-live",
      "the successor's lock was untouched",
    );
    assert.equal(
      JSON.parse(readFileSync(join(tombstone, "owner.json"), "utf8")).token,
      "dead-token-A",
      "the tombstone still holds the dead owner's record",
    );

    // The public API agrees: the live successor refuses any new acquirer.
    await assert.rejects(() => acquireFileLease(lock), /held by pid/);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("a retained tombstone with NO lock present never blocks acquisition (reclaimer crashed after tombstoning, before claiming)", async () => {
  const repoPath = makeTempDir("gx-dev-lease-tombfree-");
  const lock = leasePath(repoPath);
  try {
    const deadPid = await makeDeadPid();
    forgeOwner(lock, { pid: deadPid, token: "dead-token-B" });
    const tombstone = reclaimedTombstonePath(lock, "dead-token-B");
    // A reclaimer moved the dead owner aside and then crashed before claiming.
    renameSync(lock, tombstone);
    assert.equal(existsSync(lock), false);

    // The next acquirer simply claims the free lock; the tombstone stays.
    const release = await acquireFileLease(lock);
    assert.equal(readOwnerFile(lock).pid, process.pid);
    await release();
    assert.equal(existsSync(lock), false, "release vacated the lock");
    assert.equal(existsSync(tombstone), true, "the tombstone is retained forever");
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- FsRunStore hardening

test("FsRunStore: run ids are plain directory names — path traversal and malformed ids fail closed", async () => {
  const repoPath = makeTempDir("gx-dev-lease-runid-");
  const store = new FsRunStore(repoPath);
  try {
    const evil = ["../evil", "sub/dir", "..", ".", "", "a\\b", `${"x".repeat(200)}`];
    for (const id of evil) {
      assert.equal(isValidRunId(id), false, `isValidRunId must reject ${JSON.stringify(id)}`);
      assert.equal(await store.load(id), null, `load must refuse ${JSON.stringify(id)}`);
      const state = createRunState({
        runId: "placeholder",
        request: REQUEST,
        repoPath,
      });
      const bad = { ...state, runId: id } as RunState;
      await assert.rejects(() => store.save(bad), /run id/, `save must refuse ${JSON.stringify(id)}`);
    }
    assert.equal(existsSync(join(repoPath, "evil")), false, "nothing escaped the runs root");

    // A legitimate run id round-trips.
    const state = createRunState({ runId: "run-abc123", request: REQUEST, repoPath });
    await store.save(state);
    const loaded = await store.load("run-abc123");
    assert.ok(loaded !== null);
    assert.equal(loaded.runId, "run-abc123");
    assert.equal(loaded.state, "INTAKE");
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("FsRunStore: state.json schema sanity — corrupt or mismatched records read as absent", async () => {
  const repoPath = makeTempDir("gx-dev-lease-schema-");
  const store = new FsRunStore(repoPath);
  try {
    const dir = runDir(repoPath, "run-schema1");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "state.json");

    writeFileSync(file, "{not json", "utf8");
    assert.equal(await store.load("run-schema1"), null, "unparseable state reads as absent");

    writeFileSync(file, JSON.stringify({ runId: "run-schema1" }), "utf8");
    assert.equal(await store.load("run-schema1"), null, "a record without a state name is refused");

    writeFileSync(file, JSON.stringify({ runId: "run-OTHER", state: "INTAKE" }), "utf8");
    assert.equal(
      await store.load("run-schema1"),
      null,
      "a record whose runId does not match its directory is refused",
    );

    writeFileSync(file, JSON.stringify(createRunState({ runId: "run-schema1", request: REQUEST, repoPath })), "utf8");
    const loaded = await store.load("run-schema1");
    assert.ok(loaded !== null, "a well-formed record loads");
    assert.equal(loaded.state, "INTAKE");
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("FsRunStore: list() skips invalid directory names, the lock directory, and retained tombstones", async () => {
  const repoPath = makeTempDir("gx-dev-lease-list-");
  const store = new FsRunStore(repoPath);
  try {
    const state = createRunState({ runId: "run-good", request: REQUEST, repoPath });
    await store.save(state);
    mkdirSync(runDir(repoPath, "not a run id"), { recursive: true });
    mkdirSync(runDir(repoPath, "..hidden"), { recursive: true });
    // The published lock directory and a retained tombstone both live in the
    // runs root; neither is a run.
    forgeOwner(leasePath(repoPath), { pid: 1, token: "t" });
    renameSync(leasePath(repoPath), reclaimedTombstonePath(leasePath(repoPath), "t"));
    forgeOwner(leasePath(repoPath), { pid: 1, token: "t2" });

    const runs = await store.list();
    assert.deepEqual(
      runs.map((r) => r.runId),
      ["run-good"],
      "only valid run-id directories are listed",
    );
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("FsRunStore: concurrent saves from two store instances all land; unique temp names leave no residue", async () => {
  const repoPath = makeTempDir("gx-dev-lease-tmp-");
  const storeA = new FsRunStore(repoPath);
  const storeB = new FsRunStore(repoPath);
  try {
    const base = createRunState({ runId: "run-tmp", request: REQUEST, repoPath });
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 25; i += 1) {
      writes.push(storeA.save({ ...base, state: i % 2 === 0 ? "INTAKE" : "RESEARCH" }));
      writes.push(storeB.save({ ...base, updatedAt: new Date().toISOString() }));
    }
    await Promise.all(writes);

    const loaded = await storeA.load("run-tmp");
    assert.ok(loaded !== null, "the final state is valid after concurrent writes");
    const residue = readdirSync(runDir(repoPath, "run-tmp")).filter((f) => f.includes(".tmp"));
    assert.deepEqual(residue, [], "no temp files may survive completed saves");
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("MemoryRunStore: acquireLease provides in-process mutual exclusion", async () => {
  const store = new MemoryRunStore();
  const release = await store.acquireLease();
  await assert.rejects(() => store.acquireLease(), /already held/);
  await release();
  const release2 = await store.acquireLease();
  await release2();
});

// ----------------------------------------------------------- engine integration

test("engine: a competing Engine is refused while another engine's drive holds the lease; the lease is released at checkpoints", async () => {
  const repoPath = await makeFixtureRepo();
  const gate = gateResearcher();
  const a = makeLeaseEngine(repoPath, { script: gate.script, ui: autoApprovalUI() });
  const b = makeLeaseEngine(repoPath);
  try {
    // Engine A drives: the researcher is held open, so the lease is held.
    const driving = a.engine.start(REQUEST);
    await waitFor(() => a.agents.count("researcher") > 0, "engine A reached the researcher");

    // Engine B can neither start nor resume while A holds the lease.
    await assert.rejects(() => b.engine.start(REQUEST), /lease/i, "start is refused by the lease");
    await assert.rejects(() => b.engine.resume(), /lease/i, "resume is refused by the lease");
    assert.equal(b.engine.status(), null, "a refused engine never mutates its own state");

    // A completes; its drive returned and the lease was released in finally.
    gate.open();
    const done = asRunState(await driving);
    assert.equal(done.state, "COMPLETE", `expected COMPLETE, got ${done.state}`);

    // B can drive now: the released lease is re-acquirable end to end (B
    // has no UI and parks at the mandatory requirements approval).
    const second = asRunState(await b.engine.start(REQUEST));
    assert.equal(
      second.state,
      "WAITING_FOR_USER",
      `expected B to acquire the released lease and park, got ${second.state}`,
    );
  } finally {
    a.git.removeTempDirs();
    b.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("engine: active-run discovery refuses a new start while ANY persisted run is unfinished (even when parked)", async () => {
  const repoPath = await makeFixtureRepo();
  const a = makeLeaseEngine(repoPath);
  const b = makeLeaseEngine(repoPath);
  try {
    // Engine A parks at the mandatory requirements approval (no UI).
    const parked = asRunState(await a.engine.start(REQUEST));
    assert.equal(parked.state, "WAITING_FOR_USER");

    await assert.rejects(
      () => b.engine.start(REQUEST),
      (e: Error) => {
        assert.match(e.message, /unfinished/);
        assert.match(e.message, new RegExp(parked.runId));
        assert.match(e.message, /WAITING_FOR_USER/);
        return true;
      },
    );
    assert.equal(b.engine.status(), null, "the refused start created no run");

    // After A's run is cancelled (terminal), B may start.
    const cancelled = asRunState(await a.engine.cancel());
    assert.equal(cancelled.state, "CANCELLED");
    const started = asRunState(await b.engine.start(REQUEST));
    assert.equal(started.state, "WAITING_FOR_USER", "B parks at its own requirements approval");
  } finally {
    a.git.removeTempDirs();
    b.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("engine: a dead-owner lease never blocks a new engine; a live foreign pid does (REAL cross-process)", async () => {
  const repoPath = await makeFixtureRepo();
  let child: LeaseChild | null = null;
  const a = makeLeaseEngine(repoPath, { ui: autoApprovalUI() });
  const b = makeLeaseEngine(repoPath);
  try {
    const deadPid = await makeDeadPid();
    forgeOwner(leasePath(repoPath), { pid: deadPid });
    // Restart safety: the crashed owner's lease is reclaimed transparently.
    const done = asRunState(await a.engine.start(REQUEST));
    assert.equal(done.state, "COMPLETE");

    // A live foreign process holding the lease refuses the engine.
    const parked = asRunState(await b.engine.start(REQUEST));
    assert.equal(parked.state, "WAITING_FOR_USER");
    child = spawnLeaseChild({
      GX_LEASE_MODULE: LEASE_MODULE_URL,
      GX_LOCK: leasePath(repoPath),
      GX_MODE: "hold",
    });
    await waitUntilHeld(child);
    const c = makeLeaseEngine(repoPath, { ui: autoApprovalUI() });
    try {
      await assert.rejects(() => c.engine.start(REQUEST), new RegExp(`pid ${child!.pid}`));
      await assert.rejects(() => c.engine.resume(parked.runId), /lease/i);
    } finally {
      c.git.removeTempDirs();
    }
  } finally {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exitOf(child).catch(() => -1);
    }
    a.git.removeTempDirs();
    b.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("engine: cancel and pause issued while this engine's drive holds the lease do NOT deadlock", async () => {
  for (const control of ["cancel", "pause"] as const) {
    const repoPath = await makeFixtureRepo();
    const gate = gateResearcher();
    const a = makeLeaseEngine(repoPath, { script: gate.script, ui: autoApprovalUI() });
    try {
      const driving = a.engine.start(REQUEST);
      await waitFor(() => a.agents.count("researcher") > 0, `${control}: researcher in flight`);

      // The control must stop the drive, never wait behind it (the drive
      // holds the lease here — reentrant cooperation, not re-acquisition).
      const controlled = control === "cancel" ? a.engine.cancel() : a.engine.pause();
      gate.open();
      const state = asRunState(await Promise.race([
        controlled,
        new Promise<never>((_, rejectDeads) =>
          setTimeout(() => rejectDeads(new Error(`${control} deadlocked behind the drive`)), 10_000),
        ),
      ]));
      assert.equal(state.state, control === "cancel" ? "CANCELLED" : "PAUSED");
      assert.equal(asRunState(await driving).state, state.state);

      const persisted = await a.stores.runStore.load(state.runId);
      assert.equal(persisted?.state, state.state, "the control state is durable");
    } finally {
      a.git.removeTempDirs();
      rmSync(repoPath, { recursive: true, force: true });
    }
  }
});

test("engine: a parked cancel takes the lease and is REFUSED while another process holds it; it succeeds after release", async () => {
  const repoPath = await makeFixtureRepo();
  const a = makeLeaseEngine(repoPath);
  try {
    const parked = asRunState(await a.engine.start(REQUEST));
    assert.equal(parked.state, "WAITING_FOR_USER");

    // Simulate another engine process driving this repository.
    const external = await new FsRunStore(repoPath).acquireLease();
    try {
      await assert.rejects(() => a.engine.cancel(), /lease/i);
      const stillParked = await a.stores.runStore.load(parked.runId);
      assert.equal(stillParked?.state, "WAITING_FOR_USER", "the refused cancel mutated nothing");
    } finally {
      await external();
    }

    const cancelled = asRunState(await a.engine.cancel());
    assert.equal(cancelled.state, "CANCELLED");
  } finally {
    a.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("engine: same-instance simultaneous start rejects; concurrent resumes serialize with no duplicate drive", async () => {
  const repoPath = await makeFixtureRepo();
  const gate = gateResearcher();
  const a = makeLeaseEngine(repoPath, { script: gate.script, ui: autoApprovalUI() });
  try {
    const driving = a.engine.start(REQUEST);
    await waitFor(() => a.agents.count("researcher") > 0, "researcher in flight");
    await assert.rejects(() => a.engine.start(REQUEST), /already (in progress|active)/);
    assert.equal(a.agents.count("researcher"), 1, "the in-flight drive was not duplicated");

    // Pause stops the drive (release the gated researcher), then TWO
    // concurrent resumes serialize behind each other: exactly one takeover
    // drive finishes the run — the delivered commit exists exactly once.
    const pausePromise = a.engine.pause();
    gate.open();
    assert.equal(asRunState(await pausePromise).state, "PAUSED");

    const settled = await Promise.allSettled([a.engine.resume(), a.engine.resume()]);
    for (const s of settled) {
      assert.ok(
        s.status === "fulfilled" || /already in progress/.test(String((s as PromiseRejectedResult).reason)),
        `resume must serialize or reject, never fail: ${String(s.status === "rejected" ? (s as PromiseRejectedResult).reason : "")}`,
      );
    }
    assert.equal(asRunState(a.engine.status()).state, "COMPLETE", "the serialized resumes finished the run");
    assert.equal(
      a.git.callsOf("commitStaged").length,
      1,
      "no duplicate drive: the result was applied exactly once",
    );
    assert.equal(
      a.agents.count("researcher"),
      2,
      "exactly one re-run: the pause-aborted attempt plus the resumed research (never two concurrent drives)",
    );
    const doneState = asRunState(await driving);
    assert.ok(
      doneState.state === "PAUSED" || doneState.state === "COMPLETE",
      `start resolved at ${doneState.state}`,
    );
  } finally {
    a.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("engine: simultaneous parked answers cooperate on ONE drive (no duplicate phase work)", async () => {
  const repoPath = await makeFixtureRepo();
  const a = makeLeaseEngine(repoPath);
  try {
    const parked = asRunState(await a.engine.start(REQUEST));
    assert.equal(parked.state, "WAITING_FOR_USER", "parked at the requirements approval");

    const settled = await Promise.allSettled([
      a.engine.answer("approve"),
      a.engine.answer("approve"),
    ]);
    assert.ok(
      settled.some((s) => s.status === "fulfilled"),
      `at least one answer must proceed: ${JSON.stringify(settled.map((s) => s.status))}`,
    );

    // The run advanced through PLAN (planner) and parked at PLAN_APPROVAL —
    // driven by exactly ONE drive loop (the planner ran once, not twice).
    const state = asRunState(
      await (settled.find((s) => s.status === "fulfilled") as PromiseFulfilledResult<RunState>).value,
    );
    assert.equal(state.state, "WAITING_FOR_USER");
    assert.equal(state.pendingQuestion?.checkpoint, "plan");
    assert.equal(a.agents.count("planner"), 1, "no duplicate drive re-ran the planner");

    const persisted = await a.stores.runStore.load(state.runId);
    assert.equal(persisted?.state, "WAITING_FOR_USER");
  } finally {
    a.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("engine: stores WITHOUT lease support degrade gracefully (optional contract)", async () => {
  const repoPath = await makeFixtureRepo();
  const a = makeLeaseEngine(repoPath, { withLease: false });
  try {
    const parked = asRunState(await a.engine.start(REQUEST));
    assert.equal(parked.state, "WAITING_FOR_USER", "a lease-less store still runs the lifecycle");
    const cancelled = asRunState(await a.engine.cancel());
    assert.equal(cancelled.state, "CANCELLED");
  } finally {
    a.git.removeTempDirs();
    rmSync(repoPath, { recursive: true, force: true });
  }
});
