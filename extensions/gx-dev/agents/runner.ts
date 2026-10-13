/**
 * Child pi process runner (PLAN §4, §12, §16).
 *
 * Spawns the configured pi binary in JSON mode as a child process (never via
 * a shell string), consumes its JSONL event stream with StreamAccumulator,
 * enforces timeouts and caller cancellation, validates the role's structured
 * completion, retries exactly once with schema feedback, and records raw
 * evidence plus agent_completed/agent_failed lifecycle events.
 *
 * Runtime safety rules enforced here:
 * - The child runs in its own process group (spawn detached). Cancellation
 *   and timeouts signal the whole tree (SIGTERM, escalating to SIGKILL) and
 *   the outcome resolves only after the child's close event, so no
 *   descendant outlives the reported result or keeps writing afterwards.
 * - A caller abort is never retried: an aborted attempt, or an abort observed
 *   before the schema-feedback retry, fails the run immediately.
 * - The single schema retry includes the rejected output text so the model
 *   can repair what it actually produced.
 * - Role `tools:` frontmatter metadata is passed to the child as an explicit
 *   pi tool allowlist. Write-capable tools (edit/write) are granted only
 *   when the caller supplied nonempty writableRoots, and are always added
 *   then so documentation-mode roles can edit docs (the engine enforces the
 *   docs-only diff; bash-style escapes are out of scope here).
 * - "inherit" model resolutions pin the orchestrating session's model via
 *   the optional inheritedModel spec instead of letting the child fall back
 *   to its own default.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { GLM_53_FLASH_MAX } from "../config.ts";
import type { GxConfig, ModelRoleKey } from "../config.ts";
import type { ArtifactStore } from "../domain/artifacts.ts";
import type { EventStore } from "../domain/events.ts";
import type {
  AgentRunner,
  AgentRunOptions,
  AgentRunResult,
  AgentWorkContext,
} from "../domain/interfaces.ts";
import type { AgentCompletion, AgentRole } from "../domain/schemas.ts";
import { loadRolePrompt } from "./discovery.ts";
import { resolveModelSpec } from "./models.ts";
import { validateOrFeedback } from "./protocol.ts";
import { StreamAccumulator } from "./streaming.ts";

interface SpawnOutcome {
  rawText: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  servedModel: string | null;
  sawError: boolean;
  exitCode: number | null;
  infrastructure: boolean;
  error?: string;
}

/** Grace period before escalating SIGTERM to SIGKILL on cancel/timeout. */
const TERMINATE_GRACE_MS = 5_000;
/** Last-resort guard so an aborting spawn still resolves if close never fires. */
const FORCE_FINISH_AFTER_TERMINATION_MS = TERMINATE_GRACE_MS + 2_000;
/** Cap for the invalid-output text echoed back into the schema retry. */
const FEEDBACK_INVALID_TEXT_LIMIT = 4_000;

/** Tools granted write access to the working directory. */
const WRITE_CAPABLE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
/** Canonical ordering for the --tools allowlist (unknown names follow, sorted). */
const TOOL_ORDER: readonly string[] = ["read", "bash", "edit", "write"];

/** Signals the child's whole process group (spawn uses detached: true). */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
    return;
  }
  try {
    // Negative pid targets the process group; no-ops to a fallback if the
    // platform cannot group-signal (child.kill still reaches the direct child).
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Best-effort tree termination: SIGTERM now, SIGKILL after the grace period. */
function terminateTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  signalTree(child, "SIGTERM");
  const escalate = setTimeout(() => signalTree(child, "SIGKILL"), TERMINATE_GRACE_MS);
  escalate.unref();
}

function truncateForFeedback(text: string): string {
  if (text.length <= FEEDBACK_INVALID_TEXT_LIMIT) return text;
  return `${text.slice(0, FEEDBACK_INVALID_TEXT_LIMIT)}\n…[truncated]`;
}

export class PiAgentRunner implements AgentRunner {
  private readonly config: GxConfig;
  private readonly agentsDir: string;
  private readonly events: EventStore | undefined;
  private readonly artifacts: ArtifactStore | undefined;
  private readonly explicitModels: Partial<Record<ModelRoleKey, string>>;
  /** `provider/model[:thinking]` of the orchestrating session, when known. */
  private readonly inheritedModel: string | undefined;
  /** In-flight spawn attempts; awaited by whenIdle() before shutdown drops us. */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(opts: {
    config: GxConfig;
    agentsDir: string;
    events?: EventStore;
    artifacts?: ArtifactStore;
    /** Explicit per-role selections from the user's config; beats role-prompt pins. */
    explicitModels?: Partial<Record<ModelRoleKey, string>>;
    /** Resolved `provider/model[:thinking]` of the parent session. When a
     * role resolves to "inherit", this spec is pinned explicitly instead of
     * omitting --model (which would pick the child's own default). */
    inheritedModel?: string;
  }) {
    this.config = opts.config;
    this.agentsDir = opts.agentsDir;
    this.events = opts.events;
    this.artifacts = opts.artifacts;
    this.explicitModels = opts.explicitModels ?? {};
    this.inheritedModel = opts.inheritedModel;
  }

  /**
   * Resolves when no agent spawns are in flight. Shutdown awaits this so
   * engine references are never dropped while a child may still be writing.
   */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  async run(
    role: AgentRole,
    task: string,
    work: AgentWorkContext,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const startMs = Date.now();
    if (options?.signal?.aborted) {
      return this.failureResult(role, startMs, {
        rawText: "",
        usage: null,
        servedModel: null,
        sawError: false,
        exitCode: null,
        infrastructure: true,
        error: `agent ${role} aborted by caller`,
      }, `agent ${role} aborted by caller`, true);
    }
    const first = await this.tracked(this.spawnOnce(role, task, work, options));
    // Infrastructure failures — including aborts and timeouts — are never
    // retried, so a cancelled run cannot spin up a second child.
    if (first.infrastructure) {
      return this.failureResult(role, startMs, first, first.error ?? "infrastructure failure", true);
    }
    const firstCheck = validateOrFeedback(role, first.rawText);
    if (firstCheck.ok && firstCheck.completion) {
      return this.successResult(role, startMs, first, firstCheck.completion);
    }
    if (options?.signal?.aborted) {
      // Abort observed between the attempt and the retry: do not spawn again.
      return this.failureResult(
        role,
        startMs,
        first,
        `agent ${role} aborted by caller before schema retry`,
        true,
      );
    }

    // Exactly one retry with schema feedback, including the rejected output
    // so the model repairs what it actually produced (PLAN §12).
    const schemaPart = firstCheck.feedback ?? "Return only one corrected JSON object.";
    const feedback = `${schemaPart}\n\nYour previous output was:\n${truncateForFeedback(first.rawText)}`;
    const second = await this.tracked(this.spawnOnce(role, `${task}\n\n${feedback}`, work, options));
    if (second.infrastructure) {
      return this.failureResult(role, startMs, second, second.error ?? "infrastructure failure", true);
    }
    const secondCheck = validateOrFeedback(role, second.rawText);
    if (secondCheck.ok && secondCheck.completion) {
      return this.successResult(role, startMs, second, secondCheck.completion);
    }
    const errors = secondCheck.errors.join("; ");
    return this.failureResult(
      role,
      startMs,
      second,
      `invalid ${role} output after schema-feedback retry: ${errors}`,
      false,
    );
  }

  /** Registers an in-flight attempt so shutdown can await it (whenIdle). */
  private tracked(attempt: Promise<SpawnOutcome>): Promise<SpawnOutcome> {
    this.inflight.add(attempt);
    void attempt.then(
      () => {
        this.inflight.delete(attempt);
      },
      () => {
        this.inflight.delete(attempt);
      },
    );
    return attempt;
  }

  /**
   * Resolves the model spec: explicit user config -> role frontmatter ->
   * configured default -> builtin default. Explicit config deliberately
   * beats role-prompt pins. "inherit" at any layer delegates to the
   * orchestrating session's model: when the host supplied inheritedModel,
   * that parent spec is pinned explicitly; otherwise --model is omitted.
   */
  private resolveModelArgs(role: AgentRole): string[] {
    const resolved = resolveModelSpec({
      frontmatterModel: loadRolePrompt(this.agentsDir, role)?.model,
      explicitConfigModel: this.explicitModels[role],
      configuredDefault: this.config.agents.models[role],
      builtinDefault: GLM_53_FLASH_MAX,
    });
    if (resolved.inherits || resolved.spec === null) {
      return this.inheritedModel ? ["--model", this.inheritedModel] : [];
    }
    return ["--model", resolved.spec];
  }

  /**
   * Builds the pi tool-policy arguments from the role's `tools:` frontmatter
   * metadata and the caller's writableRoots:
   * - No metadata: no flag; the child's own default toolset applies.
   * - With metadata: the declared list is passed as an explicit --tools
   *   allowlist. edit/write are granted ONLY when writableRoots is nonempty,
   *   and are added then even when undeclared so documentation-mode roles
   *   can edit docs (the engine enforces the docs-only diff separately).
   *   A role left with no tools at all is started with --no-tools.
   * Note: bash-style escapes are not sandboxed here; writableRoots is a
   * policy signal, not an OS boundary.
   */
  private resolveToolArgs(role: AgentRole, work: AgentWorkContext): string[] {
    const declared = loadRolePrompt(this.agentsDir, role)?.tools;
    if (declared === undefined) return [];
    const canWrite = work.writableRoots.length > 0;
    const tools = new Set<string>(declared);
    for (const tool of WRITE_CAPABLE_TOOLS) {
      if (canWrite) tools.add(tool);
      else tools.delete(tool);
    }
    if (tools.size === 0) return ["--no-tools"];
    const ordered = [
      ...TOOL_ORDER.filter((t) => tools.has(t)),
      ...[...tools].filter((t) => !TOOL_ORDER.includes(t)).sort(),
    ];
    return ["--tools", ordered.join(",")];
  }

  private buildSystemPrompt(role: AgentRole, options?: AgentRunOptions): string {
    const loaded = loadRolePrompt(this.agentsDir, role);
    let systemPrompt =
      loaded?.prompt ??
      `You are the ${role} agent in the gx-dev workflow. Follow the output contract given in the task exactly.`;
    if (options?.appendSystemPrompt) {
      systemPrompt = `${systemPrompt}\n\n${options.appendSystemPrompt}`;
    }
    return systemPrompt;
  }

  private spawnOnce(
    role: AgentRole,
    task: string,
    work: AgentWorkContext,
    options?: AgentRunOptions,
  ): Promise<SpawnOutcome> {
    const modelArgs = this.resolveModelArgs(role);
    const toolArgs = this.resolveToolArgs(role, work);
    const systemPrompt = this.buildSystemPrompt(role, options);
    const args = [
      "--mode",
      "json",
      ...modelArgs,
      ...toolArgs,
      "--append-system-prompt",
      systemPrompt,
      task,
    ];
    const timeoutMs = options?.timeoutMs ?? this.config.agents.timeoutMinutes * 60_000;

    return new Promise<SpawnOutcome>((resolve) => {
      if (options?.signal?.aborted) {
        resolve({
          rawText: "",
          usage: null,
          servedModel: null,
          sawError: false,
          exitCode: null,
          infrastructure: true,
          error: `agent ${role} aborted by caller`,
        });
        return;
      }

      let child: ChildProcess;
      try {
        // detached: true puts the child in its own process group so the whole
        // tree can be signalled on cancel/timeout.
        child = spawn(this.config.agents.piBinary, args, {
          cwd: work.cwd,
          env: work.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
      } catch (e) {
        resolve({
          rawText: "",
          usage: null,
          servedModel: null,
          sawError: false,
          exitCode: null,
          infrastructure: true,
          error: `spawn failed: ${(e as Error).message}`,
        });
        return;
      }

      const stdout = child.stdout;
      if (!stdout) {
        resolve({
          rawText: "",
          usage: null,
          servedModel: null,
          sawError: false,
          exitCode: null,
          infrastructure: true,
          error: "spawn produced no stdout pipe",
        });
        return;
      }

      let settled = false;
      let stderrTail = "";
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      // Set when cancel/timeout terminates the child; the outcome then waits
      // for the close event so no descendant outlives the reported result.
      let stopError: string | null = null;
      const acc = new StreamAccumulator();

      const infraOutcome = (error: string): SpawnOutcome => {
        const r = acc.result();
        return {
          rawText: r.finalText,
          usage: r.usage,
          servedModel: r.servedModel,
          sawError: r.sawError,
          exitCode: null,
          infrastructure: true,
          error,
        };
      };

      const finish = (outcome: SpawnOutcome): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        options?.signal?.removeEventListener("abort", onAbort);
        rl.close();
        stdout.destroy();
        child.stderr?.destroy();
        resolve(outcome);
      };

      /**
       * Cancels the child: signal the whole process group (SIGTERM, then
       * SIGKILL after the grace period) and resolve only once the close event
       * confirms every pipe from the tree is closed.
       */
      const requestStop = (reason: string): void => {
        if (settled || stopError !== null) return;
        stopError = reason;
        terminateTree(child);
        forceTimer = setTimeout(() => {
          finish(infraOutcome(`${reason}; child did not exit after termination`));
        }, FORCE_FINISH_AFTER_TERMINATION_MS);
        forceTimer.unref();
      };

      const onAbort = (): void => {
        requestStop(`agent ${role} aborted by caller`);
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const rl = createInterface({ input: stdout });
      rl.on("line", (line: string) => acc.feed(line));

      const stderr = child.stderr;
      if (stderr) {
        stderr.on("data", (chunk: Buffer) => {
          stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2_000);
        });
      }

      timeout = setTimeout(() => {
        requestStop(`agent ${role} timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timeout.unref();

      child.on("error", (err: Error) => {
        finish(infraOutcome(`spawn failed: ${err.message}`));
      });

      child.on("close", (code: number | null) => {
        const r = acc.result();
        if (stopError !== null) {
          // Cancel/timeout: report the stop reason, never the child's own
          // exit status, and only now that the tree's pipes have closed.
          finish({
            rawText: r.finalText,
            usage: r.usage,
            servedModel: r.servedModel,
            sawError: r.sawError,
            exitCode: code,
            infrastructure: true,
            error: stopError,
          });
          return;
        }
        if (code !== 0) {
          const detail = stderrTail.trim().length > 0 ? `: ${stderrTail.trim()}` : "";
          finish({
            rawText: r.finalText,
            usage: r.usage,
            servedModel: r.servedModel,
            sawError: r.sawError,
            exitCode: code,
            infrastructure: true,
            error: `pi exited with code ${code ?? "signal"}${detail}`,
          });
          return;
        }
        finish({
          rawText: r.finalText,
          usage: r.usage,
          servedModel: r.servedModel,
          sawError: r.sawError,
          exitCode: code,
          infrastructure: false,
        });
      });
    });
  }

  private successResult(
    role: AgentRole,
    startMs: number,
    attempt: SpawnOutcome,
    completion: AgentCompletion,
  ): AgentRunResult {
    if (this.artifacts) {
      this.artifacts.recordEvidence("agent-output", attempt.rawText, role);
    }
    this.events?.append("agent_completed", `${role} agent completed`, {
      role,
      summary: completion.summary,
      status: completion.status,
      ...(attempt.servedModel ? { servedModel: attempt.servedModel } : {}),
    });
    const result: AgentRunResult = {
      role,
      completion,
      rawText: attempt.rawText,
      ok: true,
      durationMs: Date.now() - startMs,
      exitCode: attempt.exitCode,
      infrastructure: false,
    };
    if (attempt.usage) result.usage = attempt.usage;
    if (attempt.servedModel) result.servedModel = attempt.servedModel;
    return result;
  }

  private failureResult(
    role: AgentRole,
    startMs: number,
    attempt: SpawnOutcome,
    error: string,
    infrastructure: boolean,
  ): AgentRunResult {
    this.events?.append("agent_failed", `${role} agent failed: ${error}`, {
      role,
      infrastructure,
    });
    const result: AgentRunResult = {
      role,
      completion: null,
      rawText: attempt.rawText,
      ok: false,
      error,
      durationMs: Date.now() - startMs,
      exitCode: attempt.exitCode,
      infrastructure,
    };
    if (attempt.usage) result.usage = attempt.usage;
    if (attempt.servedModel) result.servedModel = attempt.servedModel;
    return result;
  }
}
