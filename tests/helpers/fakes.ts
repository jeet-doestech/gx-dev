/**
 * Fake-agent harness for gx-dev integration and e2e tests (PLAN §17).
 *
 * Deterministic in-memory implementations of the frozen domain contracts plus
 * a `makeEngineBits` factory wiring the REAL Engine (orchestration/engine.ts)
 * over REAL persistence (FsRunStore / FsArtifactStore / JsonlEventStore)
 * inside an isolated temp repository. No network, no child pi processes.
 *
 * Alignment notes (real EngineDeps): { runner, git, memory, runStore,
 * artifacts, events, config, ui? }. The engine generates the runId inside
 * start(), so artifacts/events are wrapped in self-binding delegates that
 * attach to `.gx-dev/runs/<runId>/` on the first runStore.save(). The engine
 * also owns its command executor (createProcessExecutor), so the scripted
 * FakeCommandExecutor here is a standalone test double for the
 * gates/test-gate.ts CommandExecutor contract, not part of EngineDeps.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Engine } from "../../extensions/gx-dev/orchestration/engine.ts";
import type { EngineDeps, EngineUI } from "../../extensions/gx-dev/orchestration/engine.ts";
import type { GxConfig } from "../../extensions/gx-dev/config.ts";
import { defaultConfig } from "../../extensions/gx-dev/config.ts";
import { FsArtifactStore, MemoryArtifactStore } from "../../extensions/gx-dev/domain/artifacts.ts";
import type { ArtifactStore, EvidenceRecord, EvidenceKind } from "../../extensions/gx-dev/domain/artifacts.ts";
import { JsonlEventStore, MemoryEventStore } from "../../extensions/gx-dev/domain/events.ts";
import type { EventStore, GxEvent, GxEventType } from "../../extensions/gx-dev/domain/events.ts";
import type {
  AgentRunOptions,
  AgentRunResult,
  AgentRunner,
  AgentWorkContext,
  GitCoordinator,
  IntegratedResult,
  MemoryCoordinator,
  MemoryProposal,
  RunStore,
  WorktreeHandles,
} from "../../extensions/gx-dev/domain/interfaces.ts";
import { FsRunStore } from "../../extensions/gx-dev/domain/persist.ts";
import type { RunState } from "../../extensions/gx-dev/domain/state.ts";
import type { CommandExecutor } from "../../extensions/gx-dev/gates/test-gate.ts";
import { extractJson, validateCompletion } from "../../extensions/gx-dev/domain/schemas.ts";
import type { AgentCompletion, AgentRole } from "../../extensions/gx-dev/domain/schemas.ts";

// ---------------------------------------------------------------------------
// FakeAgentRunner
// ---------------------------------------------------------------------------

/** One scripted agent step; any omitted field falls back to harness defaults. */
export interface FakeAgentStep {
  /** Structured completion (plain JSON; validated against the role schema). */
  completion?: unknown;
  /** Raw final assistant text; defaults to a markdown report embedding the JSON. */
  rawText?: string;
  /** Agent-logic failure (completion null, infrastructure false). */
  fail?: boolean;
  /** Infrastructure failure (spawn/timeout class). */
  infra?: boolean;
}

/**
 * Script signature: (role, task, call) -> step. `call` is the 1-based
 * per-role invocation counter. Returning undefined/void selects the default
 * happy-path completion for the role.
 */
export type FakeScript = (
  role: AgentRole,
  task: string,
  call: number,
) => FakeAgentStep | void | Promise<FakeAgentStep | void>;

export interface AgentInvocation {
  role: AgentRole;
  task: string;
  call: number;
}

/**
 * Scripted AgentRunner. Every completion (scripted or default) is
 * round-tripped through the real schema validator, so the harness only ever
 * hands the engine role-valid completions — the same guarantee PiAgentRunner
 * provides in live mode. Raw text is rendered as a markdown report with a
 * fenced ```json block (extractJson picks the block; the surrounding prose
 * keeps gate preflights satisfied for non-trivial diffs).
 */
export class FakeAgentRunner implements AgentRunner {
  readonly invocations: AgentInvocation[] = [];
  private readonly callsByRole = new Map<AgentRole, number>();
  private readonly script: FakeScript;

  constructor(script: FakeScript = () => undefined) {
    this.script = script;
  }

  /** 1-based number of times `role` has been invoked so far. */
  count(role: AgentRole): number {
    return this.callsByRole.get(role) ?? 0;
  }

  async run(
    role: AgentRole,
    task: string,
    _work: AgentWorkContext,
    _options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const call = this.count(role) + 1;
    this.callsByRole.set(role, call);
    this.invocations.push({ role, task, call });
    const startedAt = Date.now();

    let step: FakeAgentStep;
    try {
      step = (await this.script(role, task, call)) ?? { completion: defaultCompletion(role) };
    } catch (e) {
      step = { fail: true, rawText: `script threw: ${(e as Error).message}` };
    }
    const durationMs = Math.max(1, Date.now() - startedAt);

    if (step.infra) {
      const result: AgentRunResult = {
        role,
        completion: null,
        rawText: step.rawText ?? "",
        ok: false,
        error: step.rawText ?? `agent ${role} infrastructure failure (scripted)`,
        durationMs,
        exitCode: null,
        infrastructure: true,
      };
      return result;
    }
    if (step.fail) {
      const result: AgentRunResult = {
        role,
        completion: null,
        rawText: step.rawText ?? "",
        ok: false,
        error: step.rawText ?? `agent ${role} failed (scripted)`,
        durationMs,
        exitCode: 1,
        infrastructure: false,
      };
      return result;
    }

    const completionJson = JSON.stringify(step.completion ?? defaultCompletion(role), null, 2);
    const rawText =
      step.rawText ??
      [
        `# ${role} report`,
        "",
        `The ${role} step completed deterministically in the fake harness.`,
        "",
        "```json",
        completionJson,
        "```",
        "",
      ].join("\n");
    const validation = validateCompletion(role, extractJson(rawText));
    if (!validation.ok || validation.completion === null) {
      const result: AgentRunResult = {
        role,
        completion: null,
        rawText,
        ok: false,
        error: `scripted ${role} completion failed schema validation: ${validation.errors.join("; ")}`,
        durationMs,
        exitCode: 0,
        infrastructure: false,
      };
      return result;
    }
    return {
      role,
      completion: validation.completion,
      rawText,
      ok: true,
      durationMs,
      exitCode: 0,
      infrastructure: false,
    };
  }
}

/**
 * Default happy-path completion for a role (fresh object every call), shaped
 * exactly as the task spec requires: researcher with 1 source; planner with
 * one task per assignee and verificationContract ['node --test']; developer
 * with changedFiles; testWriter with an inventory entry; testRunner with
 * commands [{command:'node --test',exitCode:0}] and empty ownership; reviewer
 * with no findings and documentationUpdates ['README.md']; committer with
 * strategy 'merge-commit', commitHash 'abc123', rollbackCommand 'git reset'.
 */
export function defaultCompletion(role: AgentRole): AgentCompletion {
  const base = {
    status: "complete" as const,
    summary: `${role} step completed (fake harness)`,
    artifacts: [] as string[],
    questions: [] as never[],
    assumptions: [] as string[],
    risks: [] as string[],
  };
  switch (role) {
    case "researcher":
      return {
        ...base,
        summary: "Requirement understood from the local fixture; no external research needed.",
        sources: [
          {
            url: "file://fixture/src/greet.js",
            title: "fixture greet module",
            retrievedAt: new Date().toISOString(),
            confidence: "high" as const,
          },
        ],
        findings: ["src/greet.js exports greet(name); the module is plain ESM."],
        requirementAmbiguities: [],
      };
    case "planner":
      return {
        ...base,
        tasks: [
          {
            id: "T1",
            assignee: "developer" as const,
            title: "Implement the requested change in src/greet.js",
            files: ["src/greet.js"],
            dependsOn: [],
          },
          {
            id: "T2",
            assignee: "testWriter" as const,
            title: "Cover the requested change in test/greet.test.js",
            files: ["test/greet.test.js"],
            dependsOn: ["T1"],
          },
        ],
        verificationContract: ["node --test"],
        rollbackPlan: "git reset --hard <base-commit>",
      };
    case "developer":
      return {
        ...base,
        changedFiles: ["src/greet.js"],
        deviations: [],
        knownLimitations: [],
      };
    case "testWriter":
      return {
        ...base,
        testInventory: [{ path: "test/greet.test.js", covers: "requested behavior" }],
        coverageGaps: [],
      };
    case "testRunner":
      return {
        ...base,
        commands: [{ command: "node --test", exitCode: 0 }],
        ownership: [],
      };
    case "reviewer":
      return {
        ...base,
        findings: [],
        documentationUpdates: ["README.md"],
      };
    case "committer":
      return {
        ...base,
        strategy: "merge-commit" as const,
        commitHash: "abc123",
        rollbackCommand: "git reset",
      };
  }
}

// ---------------------------------------------------------------------------
// FakeGitCoordinator
// ---------------------------------------------------------------------------

export interface FakeGitOptions {
  baseBranch?: string;
  baseCommit?: string;
  /** integrate() outcome; default true. */
  integrateSuccess?: boolean;
  /** Reported conflicts when integrateSuccess is false. */
  conflictedFiles?: string[];
  commitHash?: string;
  rollbackCommand?: string;
  /**
   * Seed each worktree dir with the repo's working files and a fresh git
   * repo + initial commit (default true). The real engine runs `git diff`,
   * `git status --porcelain`, and the verification contract inside these
   * dirs, so they must be working git repositories.
   */
  populateWorktrees?: boolean;
}

export interface FakeGitCall {
  op: "recordBase" | "prepareWorktrees" | "integrate" | "checkpointStaging" | "commitStaged" | "cleanup";
  at: string;
  detail: Record<string, unknown>;
}

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "gx-dev-harness",
  GIT_AUTHOR_EMAIL: "harness@gx-dev.invalid",
  GIT_COMMITTER_NAME: "gx-dev-harness",
  GIT_COMMITTER_EMAIL: "harness@gx-dev.invalid",
};

/**
 * In-memory GitCoordinator. prepareWorktrees creates real temp directories
 * (mkdtemp) on disk, seeded as standalone git repos so the engine's
 * allowlisted commands (`git diff HEAD`, `node --test`,
 * `git status --porcelain`) behave deterministically inside them.
 */
export class FakeGitCoordinator implements GitCoordinator {
  readonly calls: FakeGitCall[] = [];
  private readonly createdDirs: string[] = [];
  private readonly opts: {
    baseBranch: string;
    baseCommit: string;
    integrateSuccess: boolean;
    conflictedFiles: string[];
    commitHash: string;
    rollbackCommand: string;
    populateWorktrees: boolean;
  };

  constructor(opts: FakeGitOptions = {}) {
    this.opts = {
      baseBranch: opts.baseBranch ?? "main",
      baseCommit: opts.baseCommit ?? "b4se000000000000000000000000000000000000",
      integrateSuccess: opts.integrateSuccess ?? true,
      conflictedFiles: opts.conflictedFiles ?? ["src/greet.js"],
      commitHash: opts.commitHash ?? "f00df00df00df00df00df00df00df00df00df00d",
      rollbackCommand: opts.rollbackCommand ?? "git reset --hard HEAD~1",
      populateWorktrees: opts.populateWorktrees ?? true,
    };
  }

  private record(op: FakeGitCall["op"], detail: Record<string, unknown>): void {
    this.calls.push({ op, at: new Date().toISOString(), detail });
  }

  callsOf(op: FakeGitCall["op"]): FakeGitCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  async recordBase(
    repoPath: string,
  ): Promise<{ branch: string | null; commit: string | null; dirty: boolean; refused?: string }> {
    this.record("recordBase", { repoPath });
    return { branch: this.opts.baseBranch, commit: this.opts.baseCommit, dirty: false };
  }

  async prepareWorktrees(repoPath: string, runId: string): Promise<WorktreeHandles> {
    this.record("prepareWorktrees", { repoPath, runId });
    const mk = (role: string): string => {
      const dir = mkdtempSync(join(tmpdir(), `gx-dev-${runId}-${role}-`));
      if (this.opts.populateWorktrees) this.populateWorktree(dir, repoPath);
      this.createdDirs.push(dir);
      return dir;
    };
    const developer = mk("developer");
    const tests = mk("tests");
    const staging = mk("staging");
    return {
      runId,
      developer,
      tests,
      staging,
      branches: {
        developer: `gx-dev/${runId}/developer`,
        tests: `gx-dev/${runId}/tests`,
        staging: `gx-dev/${runId}/staging`,
      },
    };
  }

  async integrate(handles: WorktreeHandles): Promise<IntegratedResult> {
    this.record("integrate", { runId: handles.runId });
    if (this.opts.integrateSuccess) {
      return {
        stagingWorktree: handles.staging ?? "",
        success: true,
        conflictedFiles: [],
        autoResolved: [],
      };
    }
    return {
      stagingWorktree: handles.staging ?? "",
      success: false,
      conflictedFiles: [...this.opts.conflictedFiles],
      autoResolved: [],
    };
  }

  async checkpointStaging(
    handles: WorktreeHandles,
    message: string,
  ): Promise<string | null> {
    this.record("checkpointStaging", { runId: handles.runId, message });
    return null;
  }

  async commitStaged(
    handles: WorktreeHandles,
    message: string,
    baseBranch: string,
  ): Promise<{ commitHash: string; strategy: string; rollbackCommand: string }> {
    this.record("commitStaged", { runId: handles.runId, message, baseBranch });
    return {
      commitHash: this.opts.commitHash,
      strategy: "merge-commit",
      rollbackCommand: this.opts.rollbackCommand,
    };
  }

  async cleanup(handles: WorktreeHandles, opts?: { force?: boolean }): Promise<void> {
    this.record("cleanup", { runId: handles.runId, force: opts?.force === true });
    this.removeTempDirs();
  }

  /** Test teardown: force-remove every temp dir this fake created. */
  removeTempDirs(): void {
    for (const dir of this.createdDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    this.createdDirs.length = 0;
  }

  /**
   * Copies the repo's working files (excluding .git) into the worktree dir
   * and initializes it as its own git repository with an initial commit, so
   * it is a clean tree: `git status --porcelain` is empty and `node --test`
   * runs the fixture's real tests.
   */
  private populateWorktree(dir: string, repoPath: string): void {
    try {
      if (!existsSync(repoPath)) return;
      cpSync(repoPath, dir, {
        recursive: true,
        filter: (src) => basename(src) !== ".git",
      });
      const git = (args: string[]): void => {
        execFileSync("git", args, {
          cwd: dir,
          env: { ...process.env, ...GIT_ENV },
          stdio: "ignore",
        });
      };
      git(["init", "-q", "-b", "main"]);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "worktree base (fake harness)"]);
    } catch {
      // best-effort seeding; gates then see a plain empty dir
    }
  }
}

// ---------------------------------------------------------------------------
// FakeMemoryCoordinator
// ---------------------------------------------------------------------------

/** Records reserve/promote traffic; search and lint are trivially healthy. */
export class FakeMemoryCoordinator implements MemoryCoordinator {
  readonly reserved: MemoryProposal[][] = [];
  readonly promoted: MemoryProposal[][] = [];

  async reserve(proposals: MemoryProposal[]): Promise<MemoryProposal[]> {
    this.reserved.push(proposals);
    return proposals;
  }

  async promote(
    proposals: MemoryProposal[],
  ): Promise<{ applied: string[]; conflicts: string[] }> {
    this.promoted.push(proposals);
    return { applied: proposals.map((p) => p.page), conflicts: [] };
  }

  async search(_query: string, _limit?: number): Promise<never[]> {
    return [];
  }

  async lint(): Promise<{ ok: boolean; issues: string[] }> {
    return { ok: true, issues: [] };
  }
}

// ---------------------------------------------------------------------------
// FakeCommandExecutor
// ---------------------------------------------------------------------------

export interface FakeExecutorOptions {
  /** Fixed exit code per command; wins over defaultExitCode. */
  exitCodes?: Record<string, number>;
  /** Dynamic exit code per command+call (1-based per command); wins over exitCodes. */
  exitScript?: (command: string, call: number) => number | undefined;
  /** Exit code for anything unmapped; default 0. */
  defaultExitCode?: number;
}

/**
 * Scripted test double for the gates/test-gate.ts CommandExecutor contract:
 * maps command -> exit code (default 0) without spawning anything. NOTE: the
 * real Engine builds its own allowlisted executor internally, so this fake is
 * not part of EngineDeps; it exists for direct gate-level testing.
 */
export class FakeCommandExecutor implements CommandExecutor {
  readonly executed: { cwd: string; command: string; timeoutMs: number }[] = [];
  private readonly callsByCommand = new Map<string, number>();
  private readonly opts: FakeExecutorOptions;

  constructor(opts: FakeExecutorOptions = {}) {
    this.opts = opts;
  }

  async execute(
    cwd: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string; truncated: boolean }> {
    this.executed.push({ cwd, command, timeoutMs });
    const call = (this.callsByCommand.get(command) ?? 0) + 1;
    this.callsByCommand.set(command, call);
    const exitCode =
      this.opts.exitScript?.(command, call) ??
      this.opts.exitCodes?.[command] ??
      this.opts.defaultExitCode ??
      0;
    return {
      exitCode,
      output:
        exitCode === 0 ? "" : `simulated failure output for: ${command}`,
      truncated: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Self-binding persistence (the engine generates the runId inside start())
// ---------------------------------------------------------------------------

/** Delegates to an FsArtifactStore/JsonlEventStore created under
 * `.gx-dev/runs/<runId>/` as soon as the run id is known. */
class BindingStores {
  readonly artifacts: ArtifactStore;
  readonly events: EventStore;
  readonly runStore: RunStore;
  private artifactsDelegate!: ArtifactStore;
  private eventsDelegate!: EventStore;
  private placeholderDirs: string[] = [];
  private bound = false;

  constructor(
    repoPath: string,
    attachRunId: string | undefined,
    eventsKind: "jsonl" | "memory",
  ) {
    const bind = (runId: string): void => {
      if (this.bound) return;
      this.bound = true;
      const dir = join(repoPath, ".gx-dev", "runs", runId);
      this.artifactsDelegate = new FsArtifactStore(dir);
      this.eventsDelegate =
        eventsKind === "memory" ? new MemoryEventStore() : new JsonlEventStore(dir);
    };
    if (attachRunId !== undefined) {
      bind(attachRunId);
    } else {
      const placeholder = mkdtempSync(join(tmpdir(), "gx-dev-stores-"));
      this.placeholderDirs.push(placeholder);
      this.artifactsDelegate = new FsArtifactStore(placeholder);
      this.eventsDelegate =
        eventsKind === "memory" ? new MemoryEventStore() : new JsonlEventStore(placeholder);
    }

    const fs = new FsRunStore(repoPath);
    this.runStore = {
      save: async (state: RunState): Promise<void> => {
        if (!this.bound) {
          bind(state.runId);
        }
        await fs.save(state);
      },
      load: (runId: string) => fs.load(runId),
      list: () => fs.list(),
    };

    const artifactsOuter = this;
    this.artifacts = {
      get runDir(): string {
        return artifactsOuter.artifactsDelegate.runDir;
      },
      recordEvidence(
        kind: EvidenceKind,
        content: string,
        source: string,
        name?: string,
      ): EvidenceRecord {
        return artifactsOuter.artifactsDelegate.recordEvidence(kind, content, source, name);
      },
      readArtifact(name: string): string | null {
        return artifactsOuter.artifactsDelegate.readArtifact(name);
      },
      writeArtifact(name: string, content: string): string {
        return artifactsOuter.artifactsDelegate.writeArtifact(name, content);
      },
      evidence(): EvidenceRecord[] {
        return artifactsOuter.artifactsDelegate.evidence();
      },
    };

    const eventsOuter = this;
    this.events = {
      append(type: GxEventType, message: string, data?: Record<string, unknown>): GxEvent {
        return eventsOuter.eventsDelegate.append(type, message, data);
      },
      events(): GxEvent[] {
        return eventsOuter.eventsDelegate.events();
      },
    };
  }

  /** Teardown for unbound placeholders. */
  removePlaceholderDirs(): void {
    for (const dir of this.placeholderDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    this.placeholderDirs = [];
  }
}

// ---------------------------------------------------------------------------
// makeEngineBits / makeFixtureRepo
// ---------------------------------------------------------------------------

export interface EngineUIOptions {
  /** Default: no UI — the engine parks material questions in WAITING_FOR_USER. */
  ui?: EngineUI;
}

export interface EngineBitsOptions extends EngineUIOptions {
  script?: FakeScript;
  git?: FakeGitOptions;
  /** Attach artifacts/events to an existing run dir (restart-recovery tests). */
  attachRunId?: string;
  /** 'jsonl' (default) writes events.jsonl so tests can audit the file. */
  events?: "jsonl" | "memory";
  config?: GxConfig;
}

export interface EngineBits {
  repoPath: string;
  engine: Engine;
  agents: FakeAgentRunner;
  git: FakeGitCoordinator;
  memory: FakeMemoryCoordinator;
  executor: FakeCommandExecutor;
  runs: RunStore;
  stores: BindingStores;
}

/** Wires the REAL Engine with all fakes plus real persistence stores. */
export function makeEngineBits(repoPath: string, opts: EngineBitsOptions = {}): EngineBits {
  const agents = new FakeAgentRunner(opts.script ?? (() => undefined));
  const git = new FakeGitCoordinator(opts.git);
  const memory = new FakeMemoryCoordinator();
  const executor = new FakeCommandExecutor();
  const stores = new BindingStores(repoPath, opts.attachRunId, opts.events ?? "jsonl");

  const deps: EngineDeps = {
    runner: agents,
    git,
    memory,
    runStore: stores.runStore,
    artifacts: stores.artifacts,
    events: stores.events,
    config: opts.config ?? defaultConfig(),
    ...(opts.ui !== undefined ? { ui: opts.ui } : {}),
  };

  return {
    repoPath,
    engine: new Engine(repoPath, deps),
    agents,
    git,
    memory,
    executor,
    runs: stores.runStore,
    stores,
  };
}

const FIXTURE_GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "gx-dev-fixture",
  GIT_AUTHOR_EMAIL: "fixture@gx-dev.invalid",
  GIT_COMMITTER_NAME: "gx-dev-fixture",
  GIT_COMMITTER_EMAIL: "fixture@gx-dev.invalid",
};

function gitSync(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...FIXTURE_GIT_ENV },
    stdio: "ignore",
  });
}

/**
 * Creates a throwaway git repository with an initial commit:
 * package.json {name:'fixture',type:'module'}, src/greet.js exporting
 * greet(name), and test/greet.test.js using node:test. Returns the repo path;
 * callers rmSync(recursive, force) it in their finally block.
 */
export async function makeFixtureRepo(): Promise<string> {
  const repoPath = mkdtempSync(join(tmpdir(), "gx-dev-fixture-"));
  gitSync(repoPath, ["init", "-q", "-b", "main"]);
  writeFileSync(
    join(repoPath, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "0.0.0", type: "module" }, null, 2)}\n`,
    "utf8",
  );
  const src = join(repoPath, "src");
  const testDir = join(repoPath, "test");
  mkdirSync(src, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(src, "greet.js"),
    ["export function greet(name) {", "  return `Hello, ${name}!`;", "}", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(testDir, "greet.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { greet } from "../src/greet.js";',
      "",
      'test("greet says hello", () => {',
      '  assert.equal(greet("world"), "Hello, world!");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  gitSync(repoPath, ["add", "-A"]);
  gitSync(repoPath, ["commit", "-q", "-m", "initial fixture"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// Result shaping helpers
// ---------------------------------------------------------------------------

/**
 * Engine methods return a RunState directly, but accept result envelopes
 * (e.g. { state, commitHash }) defensively so tests survive small API
 * evolution. Rejects garbage.
 */
export function asRunState(res: unknown): RunState {
  if (res !== null && typeof res === "object") {
    const candidate = res as { state?: unknown; runId?: unknown };
    if (
      candidate.state !== null &&
      typeof candidate.state === "object" &&
      typeof (candidate.state as { runId?: unknown }).runId === "string"
    ) {
      return candidate.state as RunState;
    }
    if (typeof candidate.runId === "string") return res as RunState;
  }
  throw new TypeError(`expected a RunState (or result envelope with .state), got: ${String(res)}`);
}

/** Convenience for tests reading persisted state.json / events files. */
export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
