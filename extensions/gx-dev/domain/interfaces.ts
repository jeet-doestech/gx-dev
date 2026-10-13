/**
 * Cross-layer contracts. Parallel implementation slices code against these
 * interfaces; only the domain layer may define them.
 */

import type { LeaseRelease } from "./lease.ts";
import type { AgentCompletion, AgentRole } from "./schemas.ts";
import type { RunState } from "./state.ts";

/** Agent scope and tool policy. Paths are not OS-enforced filesystem isolation. */
export interface AgentWorkContext {
  /** Absolute working directory for the child process cwd. */
  cwd: string;
  /** Absolute paths the agent may write within; empty means read-only. */
  writableRoots: readonly string[];
  /** Environment passed to the child (already sanitized). */
  env?: Record<string, string>;
}

export interface AgentRunResult {
  role: AgentRole;
  /** Validated completion when status ok, else null. */
  completion: AgentCompletion | null;
  /** Raw final assistant text (evidence). */
  rawText: string;
  ok: boolean;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Provider-reported model id that actually served the final message. */
  servedModel?: string;
  durationMs: number;
  exitCode: number | null;
  /** True when the failure is infrastructure (spawn/timeout), not agent logic. */
  infrastructure: boolean;
}

export interface AgentRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra system-prompt text appended after the role prompt. */
  appendSystemPrompt?: string;
}

export interface AgentRunner {
  run(
    role: AgentRole,
    task: string,
    work: AgentWorkContext,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
}

export interface WorktreeHandles {
  runId: string;
  /** Absolute paths; null when not applicable. */
  developer: string | null;
  tests: string | null;
  staging: string | null;
  branches: { developer: string; tests: string; staging: string };
}

export interface IntegratedResult {
  stagingWorktree: string;
  success: boolean;
  /** Files with unresolved conflicts (semantic conflicts go back to agents). */
  conflictedFiles: string[];
  /** Mechanical conflicts the orchestrator resolved itself (logged). */
  autoResolved: string[];
}

export interface GitCoordinator {
  /** Records base state; refuses when unrelated dirty changes would be at risk. */
  recordBase(repoPath: string): Promise<{ branch: string | null; commit: string | null; dirty: boolean; refused?: string }>;
  /**
   * Prepares (or safely reopens, after a restart) the per-run worktrees. The
   * optional `base` commit-ish is the run's original intake base SHA: pass it
   * so a reopening manager anchors the worktrees to the approved base instead
   * of re-deriving (or silently re-anchoring to) the current tip.
   */
  prepareWorktrees(repoPath: string, runId: string, base?: string): Promise<WorktreeHandles>;
  integrate(handles: WorktreeHandles): Promise<IntegratedResult>;
  /** Commits pending changes in the staging worktree (documentation updates); null when clean. */
  checkpointStaging(handles: WorktreeHandles, message: string): Promise<string | null>;
  /** Creates the final commit on the working branch from staging. */
  commitStaged(
    handles: WorktreeHandles,
    message: string,
    baseBranch: string,
  ): Promise<{ commitHash: string; strategy: string; rollbackCommand: string }>;
  cleanup(handles: WorktreeHandles, opts?: { force?: boolean }): Promise<void>;
}

export interface MemoryPage {
  name: string;
  frontmatter: Record<string, string>;
  body: string;
  /** Revision hash of the file content at read time. */
  revision: string;
}

export interface MemoryProposal {
  page: string;
  action: "create" | "update" | "archive";
  body: string;
  provenance: string[];
  scope: string;
  freshness: string;
  verification: "verified" | "not-verified";
  runId: string;
}

export interface MemoryCoordinator {
  /** Reserves page names atomically; degrades conflicting creates to updates. */
  reserve(proposals: MemoryProposal[]): Promise<MemoryProposal[]>;
  /** Applies reviewed proposals with conditional revision checks. */
  promote(proposals: MemoryProposal[]): Promise<{ applied: string[]; conflicts: string[] }>;
  /** Index-first retrieval (PLAN §10.2). */
  search(query: string, limit?: number): Promise<MemoryPage[]>;
  /** Deterministic lint of the wiki. */
  lint(): Promise<{ ok: boolean; issues: string[] }>;
  /**
   * Optional structural preview lint for proposals (REVIEW §4: reviewed
   * memory). Implemented by the filesystem store; callers must degrade
   * gracefully when absent.
   */
  lintProposals?(proposals: MemoryProposal[]): { ok: boolean; issues: string[] };
  /**
   * Optional release of a run's durable reservation claims (REVIEW §4:
   * cancellation must not squat on page names). Implemented by the
   * filesystem store; callers must degrade gracefully when absent.
   */
  release?(runId: string): Promise<void>;
}

/** Persisted run handle used by engine, TUI, and recovery. */
export interface RunStore {
  save(state: RunState): Promise<void>;
  load(runId: string): Promise<RunState | null>;
  list(): Promise<{ runId: string; state: RunState["state"]; updatedAt: string }[]>;
  /**
   * Optional repository execution lease (REVIEW §1 "Make lifecycle
   * durable"): exclusive across independent Engine processes so two engines
   * can never drive/start/resume/answer the same repository simultaneously.
   * Implementations own the ownership rules (the filesystem store uses a
   * pid/token directory lease with dead-owner reclaim); the engine treats the
   * method as OPTIONAL and degrades gracefully when absent, so in-memory
   * stores and legacy wrappers keep working single-process.
   */
  acquireLease?(): Promise<LeaseRelease>;
}

/** Question severity classification (PLAN §7): material -> WAITING_FOR_USER. */
export type QuestionSeverity = "minor" | "material";

export interface QuestionPolicy {
  classify(question: {
    severity?: QuestionSeverity;
    text: string;
  }): QuestionSeverity;
}
