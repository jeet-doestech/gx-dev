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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { GitWorktreeManager } from "../../extensions/gx-dev/git/worktrees.ts";
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
  /** Suppress the default real file writes into work.cwd (default false). */
  skipWrite?: boolean;
  /** Extra files written relative to the agent's real cwd (after defaults). */
  writeFiles?: { path: string; content: string }[];
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
  /** Roles in the order their runs STARTED (concurrency observation). */
  readonly startOrder: AgentRole[] = [];
  /** Roles in the order their runs FINISHED (concurrency observation). */
  readonly endOrder: AgentRole[] = [];
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
    work: AgentWorkContext,
    _options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const call = this.count(role) + 1;
    this.callsByRole.set(role, call);
    this.invocations.push({ role, task, call });
    this.startOrder.push(role);
    const startedAt = Date.now();

    let step: FakeAgentStep;
    try {
      step = (await this.script(role, task, call)) ?? { completion: defaultCompletion(role) };
    } catch (e) {
      step = { fail: true, rawText: `script threw: ${(e as Error).message}` };
    }
    const durationMs = Math.max(1, Date.now() - startedAt);

    // Real work in a real cwd (REVIEW §5: fake completions are not enough):
    // the developer and test writer write the promised files into their
    // worktree so the git layer has actual content to checkpoint, diff,
    // integrate, and verify with the real verification contract.
    if (step.skipWrite !== true && (role === "developer" || role === "testWriter")) {
      try {
        writeFakeDeliverables(role, work);
      } catch {
        // a read-only or missing cwd fails best-effort; gates then see it
      }
    }
    for (const file of step.writeFiles ?? []) {
      try {
        const target = join(work.cwd, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content, "utf8");
      } catch {
        // read-only cwd: nothing to write
      }
    }
    this.endOrder.push(role);

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
 * exactly as the task spec requires: researcher with 1 source and concrete
 * acceptanceCriteria for the fixture's farewell/shout behavior; planner with
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
        acceptanceCriteria: [
          'farewell("world") returns "Goodbye, world!"',
          'shout("world") returns "HELLO, WORLD!"',
        ],
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

/**
 * Writes the promised deliverables into the agent's real worktree cwd so the
 * git layer has actual content to checkpoint, diff, integrate, and verify.
 * The developer extends src/greet.js (keeping the public contract); the test
 * writer adds an independent behavior test file. Content is deterministic
 * and produces a ≥10-line implementation diff (test-gate preflight bar).
 */
function writeFakeDeliverables(role: "developer" | "testWriter", work: AgentWorkContext): void {
  if (typeof work.cwd !== "string" || work.cwd === "") return;
  if (role === "developer") {
    const src = join(work.cwd, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "greet.js"),
      [
        "export function greet(name) {",
        "  return `Hello, ${name}!`;",
        "}",
        "",
        "export function farewell(name) {",
        "  return `Goodbye, ${name}!`;",
        "}",
        "",
        "export function shout(name) {",
        "  const loud = typeof name === \"string\" ? name.toUpperCase() : name;",
        "  return `HELLO, ${loud}!`;",
        "}",
        "",
        "export function whisper(name) {",
        "  return `psst... hey ${name}`;",
        "}",
        "",
        "export function greetAll(...names) {",
        "  return names.map((n) => greet(n)).join(\", \");",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  if (role === "testWriter") {
    const testDir = join(work.cwd, "test");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, "farewell.test.js"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { farewell, shout } from "../src/greet.js";',
        "",
        'test("farewell says goodbye", () => {',
        '  assert.equal(farewell("world"), "Goodbye, world!");',
        "});",
        "",
        'test("shout raises the volume", () => {',
        '  assert.equal(shout("world"), "HELLO, WORLD!");',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

// ---------------------------------------------------------------------------
// FakeGitCoordinator (real Git underneath)
// ---------------------------------------------------------------------------

export interface FakeGitOptions {
  /** integrate() outcome; default true. When false, integrate() short-circuits with the configured conflict (no real merge). */
  integrateSuccess?: boolean;
  /** Reported conflicts when integrateSuccess is false. */
  conflictedFiles?: string[];
  /** When set, commitStaged reports this hash instead of applying a real commit. */
  commitHash?: string;
  /** Rollback command reported with commitHash override. */
  rollbackCommand?: string;
}

export interface FakeGitCall {
  op: "recordBase" | "prepareWorktrees" | "integrate" | "checkpointStaging" | "commitStaged" | "cleanup";
  at: string;
  detail: Record<string, unknown>;
}

/**
 * Recording GitCoordinator that DELEGATES to the real GitWorktreeManager
 * (REVIEW §5: the old standalone-repo fake let state-machine tests pass
 * without establishing delivery). prepareWorktrees/integrate/checkpoint/
 * commit are real git operations over the fixture repository, so actual
 * diffs, tree ids, gates, and the final commit are exercised end to end.
 */
export class FakeGitCoordinator implements GitCoordinator {
  readonly calls: FakeGitCall[] = [];
  private readonly repos = new Set<string>();
  private readonly runsPrepared = new Set<string>();
  private readonly real = new GitWorktreeManager();
  private readonly opts: {
    integrateSuccess: boolean;
    conflictedFiles: string[];
    commitHash?: string;
    rollbackCommand?: string;
  };

  constructor(opts: FakeGitOptions = {}) {
    this.opts = {
      integrateSuccess: opts.integrateSuccess ?? true,
      conflictedFiles: opts.conflictedFiles ?? ["src/greet.js"],
      ...(opts.commitHash !== undefined ? { commitHash: opts.commitHash } : {}),
      ...(opts.rollbackCommand !== undefined
        ? { rollbackCommand: opts.rollbackCommand }
        : {}),
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
    this.repos.add(repoPath);
    this.record("recordBase", { repoPath });
    return this.real.recordBase(repoPath);
  }

  async prepareWorktrees(repoPath: string, runId: string, base?: string): Promise<WorktreeHandles> {
    this.repos.add(repoPath);
    this.runsPrepared.add(runId);
    this.record("prepareWorktrees", { repoPath, runId, ...(base !== undefined ? { base } : {}) });
    return this.real.prepareWorktrees(repoPath, runId, base);
  }

  async integrate(handles: WorktreeHandles): Promise<IntegratedResult> {
    this.record("integrate", { runId: handles.runId });
    if (!this.opts.integrateSuccess) {
      return {
        stagingWorktree: handles.staging ?? "",
        success: false,
        conflictedFiles: [...this.opts.conflictedFiles],
        autoResolved: [],
      };
    }
    return this.real.integrate(handles);
  }

  async checkpointStaging(
    handles: WorktreeHandles,
    message: string,
  ): Promise<string | null> {
    this.record("checkpointStaging", { runId: handles.runId, message });
    return this.real.checkpointStaging(handles, message);
  }

  async commitStaged(
    handles: WorktreeHandles,
    message: string,
    baseBranch: string,
  ): Promise<{ commitHash: string; strategy: string; rollbackCommand: string }> {
    this.record("commitStaged", { runId: handles.runId, message, baseBranch });
    if (this.opts.commitHash !== undefined) {
      return {
        commitHash: this.opts.commitHash,
        strategy: "merge-commit",
        rollbackCommand: this.opts.rollbackCommand ?? "git revert HEAD",
      };
    }
    return this.real.commitStaged(handles, message, baseBranch);
  }

  async cleanup(handles: WorktreeHandles, opts?: { force?: boolean }): Promise<void> {
    this.record("cleanup", { runId: handles.runId, force: opts?.force === true });
    await this.real.cleanup(handles, opts);
  }

  /**
   * Test teardown: force-remove this harness's prepared run worktrees.
   * Only the run-specific directories are removed — the worktree ROOT is
   * shared by every fixture under the same parent tmpdir, and other test
   * files may run concurrently with live worktrees there.
   */
  removeTempDirs(): void {
    for (const repoPath of this.repos) {
      try {
        const root = join(dirname(repoPath), ".gx-dev-worktrees");
        for (const runId of this.runsPrepared) {
          const dir = join(root, runId);
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        }
        const git = (args: string[]): void => {
          execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
        };
        git(["worktree", "prune", "--force"]);
        for (const runId of this.runsPrepared) {
          const branches = execFileSync("git", ["branch", "--list", `gx-dev/${runId}/*`], {
            cwd: repoPath,
            encoding: "utf8",
          });
          for (const line of branches.split("\n")) {
            const name = line.replace("*", "").trim();
            if (name !== "") {
              try {
                git(["branch", "-D", name]);
              } catch {
                // already gone
              }
            }
          }
        }
      } catch {
        // best-effort teardown
      }
    }
    this.repos.clear();
    this.runsPrepared.clear();
  }
}

// ---------------------------------------------------------------------------
// FakeMemoryCoordinator
// ---------------------------------------------------------------------------

/** Records reserve/promote/search traffic; lint is trivially healthy. */
export class FakeMemoryCoordinator implements MemoryCoordinator {
  readonly reserved: MemoryProposal[][] = [];
  readonly promoted: MemoryProposal[][] = [];
  readonly searched: string[] = [];
  readonly lintChecked: MemoryProposal[][] = [];
  readonly released: string[] = [];

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

  async search(query: string, _limit?: number): Promise<never[]> {
    this.searched.push(query);
    return [];
  }

  async lint(): Promise<{ ok: boolean; issues: string[] }> {
    return { ok: true, issues: [] };
  }

  lintProposals(proposals: MemoryProposal[]): { ok: boolean; issues: string[] } {
    this.lintChecked.push(proposals);
    return { ok: true, issues: [] };
  }

  async release(runId: string): Promise<void> {
    this.released.push(runId);
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
  /**
   * Auto-approval UI for positive cases (REVIEW: mandatory approvals mean a
   * no-UI run parks at every checkpoint). Answers "approve" to everything.
   */
  autoApprove?: boolean;
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

/** UI that explicitly approves every question/decision (positive cases). */
export function autoApprovalUI(): EngineUI {
  return {
    askUser: async (_question) => "approve",
    notify: () => {},
  };
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
  const ui = opts.ui ?? (opts.autoApprove === true ? autoApprovalUI() : undefined);

  const deps: EngineDeps = {
    runner: agents,
    git,
    memory,
    runStore: stores.runStore,
    artifacts: stores.artifacts,
    events: stores.events,
    config: opts.config ?? defaultConfig(),
    ...(ui !== undefined ? { ui } : {}),
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
