/**
 * Child pi process runner (PLAN §4, §12, §16).
 *
 * Spawns the configured pi binary in JSON mode as a child process (never via
 * a shell string), consumes its JSONL event stream with StreamAccumulator,
 * enforces timeouts and caller cancellation, validates the role's structured
 * completion, retries exactly once with schema feedback, and records raw
 * evidence plus agent_completed/agent_failed lifecycle events.
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

/** Best-effort child termination: SIGTERM now, SIGKILL after 5 seconds. */
function terminate(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const escalate = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  escalate.unref();
}

export class PiAgentRunner implements AgentRunner {
  private readonly config: GxConfig;
  private readonly agentsDir: string;
  private readonly events: EventStore | undefined;
  private readonly artifacts: ArtifactStore | undefined;
  private readonly explicitModels: Partial<Record<ModelRoleKey, string>>;

  constructor(opts: {
    config: GxConfig;
    agentsDir: string;
    events?: EventStore;
    artifacts?: ArtifactStore;
    /** Explicit per-role selections from the user's config; beats role-prompt pins. */
    explicitModels?: Partial<Record<ModelRoleKey, string>>;
  }) {
    this.config = opts.config;
    this.agentsDir = opts.agentsDir;
    this.events = opts.events;
    this.artifacts = opts.artifacts;
    this.explicitModels = opts.explicitModels ?? {};
  }

  async run(
    role: AgentRole,
    task: string,
    work: AgentWorkContext,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const startMs = Date.now();
    const first = await this.spawnOnce(role, task, work, options);
    if (first.infrastructure) {
      return this.failureResult(role, startMs, first, first.error ?? "infrastructure failure", true);
    }
    const firstCheck = validateOrFeedback(role, first.rawText);
    if (firstCheck.ok && firstCheck.completion) {
      return this.successResult(role, startMs, first, firstCheck.completion);
    }

    // Exactly one retry with schema feedback (PLAN §12).
    const feedback = firstCheck.feedback ?? "Return only one corrected JSON object.";
    const second = await this.spawnOnce(role, `${task}\n\n${feedback}`, work, options);
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

  /**
   * Resolves the model spec: explicit user config -> role frontmatter ->
   * configured default -> builtin default. Explicit config deliberately
   * beats role-prompt pins; "inherit" at any layer omits --model so the
   * orchestrating session's model applies.
   */
  private resolveModelArgs(role: AgentRole): string[] {
    const resolved = resolveModelSpec({
      frontmatterModel: loadRolePrompt(this.agentsDir, role)?.model,
      explicitConfigModel: this.explicitModels[role],
      configuredDefault: this.config.agents.models[role],
      builtinDefault: GLM_53_FLASH_MAX,
    });
    if (resolved.inherits || resolved.spec === null) return [];
    return ["--model", resolved.spec];
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
    const systemPrompt = this.buildSystemPrompt(role, options);
    const args = ["--mode", "json", ...modelArgs, "--append-system-prompt", systemPrompt, task];
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
        child = spawn(this.config.agents.piBinary, args, {
          cwd: work.cwd,
          env: work.env,
          stdio: ["ignore", "pipe", "pipe"],
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
        options?.signal?.removeEventListener("abort", onAbort);
        rl.close();
        stdout.destroy();
        child.stderr?.destroy();
        resolve(outcome);
      };

      const onAbort = (): void => {
        terminate(child);
        finish(infraOutcome(`agent ${role} aborted by caller`));
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
        terminate(child);
        finish(infraOutcome(`agent ${role} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref();

      child.on("error", (err: Error) => {
        finish(infraOutcome(`spawn failed: ${err.message}`));
      });

      child.on("close", (code: number | null) => {
        const r = acc.result();
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
