/**
 * Cross-layer contracts. Parallel implementation slices code against these
 * interfaces; only the domain layer may define them.
 */

import type { AgentCompletion, AgentRole } from "./schemas.ts";
import type { RunState } from "./state.ts";

/** Where an agent is allowed to work. Enforced by the runner and git layer. */
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
  prepareWorktrees(repoPath: string, runId: string): Promise<WorktreeHandles>;
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
}

/** Persisted run handle used by engine, TUI, and recovery. */
export interface RunStore {
  save(state: RunState): Promise<void>;
  load(runId: string): Promise<RunState | null>;
  list(): Promise<{ runId: string; state: RunState["state"]; updatedAt: string }[]>;
}

/** Question severity classification (PLAN §7): material -> WAITING_FOR_USER. */
export type QuestionSeverity = "minor" | "material";

export interface QuestionPolicy {
  classify(question: {
    severity?: QuestionSeverity;
    text: string;
  }): QuestionSeverity;
}
