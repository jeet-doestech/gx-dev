/**
 * Append-only event log (PLAN §10.4). events.jsonl is the audit trail;
 * state.json is operational truth. Events are written before side effects
 * that depend on them wherever practical, and always flushed synchronously.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redactSecrets } from "../memory/redaction.ts";

function redactData(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map(redactData);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(?:password|passwd|secret|token|api[-_]?key|authorization)$/i.test(key)
        ? "[REDACTED:credential]" : redactData(item),
    ]));
  }
  return value;
}

export type GxEventType =
  | "run_created"
  | "transition"
  | "agent_started"
  | "agent_completed"
  | "agent_failed"
  | "question_asked"
  | "question_answered"
  | "gate_passed"
  | "gate_failed"
  | "escalation"
  | "worktree_created"
  | "worktree_cleaned"
  | "integration_started"
  | "integration_result"
  | "command_executed"
  | "evidence_recorded"
  | "memory_promoted"
  | "commit_created"
  | "user_action"
  | "orchestrator_intervention"
  | "error";

export interface GxEvent {
  /** Monotonic sequence number within the run. */
  seq: number;
  at: string;
  runId: string;
  type: GxEventType;
  /** Human-readable summary shown in dashboards. */
  message: string;
  /** Structured payload (JSON-serializable). */
  data?: Record<string, unknown>;
}

export interface EventStore {
  append(type: GxEventType, message: string, data?: Record<string, unknown>): GxEvent;
  events(): GxEvent[];
}

export class JsonlEventStore implements EventStore {
  private readonly file: string;
  private cache: GxEvent[] | null = null;

  constructor(runDir: string) {
    this.file = join(runDir, "events.jsonl");
    mkdirSync(dirname(this.file), { recursive: true });
  }

  append(
    type: GxEventType,
    message: string,
    data?: Record<string, unknown>,
  ): GxEvent {
    // Another lease holder may have appended since this instance last read.
    this.cache = null;
    const prior = this.events();
    const event: GxEvent = {
      seq: prior.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1,
      at: new Date().toISOString(),
      runId: this.readRunId(prior),
      type,
      message: redactSecrets(message).text,
      ...(data === undefined ? {} : { data: redactData(data) as Record<string, unknown> }),
    };
    // Preserve an interrupted write verbatim, but keep the next record separate.
    const raw = existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
    appendFileSync(this.file, (raw !== "" && !raw.endsWith("\n") ? "\n" : "") + JSON.stringify(event) + "\n", "utf8");
    this.cache = [...prior, event];
    return event;
  }

  events(): GxEvent[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = [];
      return this.cache;
    }
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    this.cache = lines.flatMap((line): GxEvent[] => {
      try {
        const value = JSON.parse(line) as GxEvent;
        return Number.isInteger(value.seq) && typeof value.type === "string" ? [value] : [];
      } catch { return []; } // interrupted records remain on disk for inspection
    });
    return this.cache;
  }

  private readRunId(prior: GxEvent[]): string {
    const last = prior[prior.length - 1];
    if (last?.runId) return last.runId;
    return basename(dirname(this.file));
  }
}

/** In-memory store for tests and fake-agent harnesses. */
export class MemoryEventStore implements EventStore {
  private readonly items: GxEvent[] = [];
  private readonly runId: string;

  constructor(runId = "run-test") {
    this.runId = runId;
  }

  append(
    type: GxEventType,
    message: string,
    data?: Record<string, unknown>,
  ): GxEvent {
    const event: GxEvent = {
      seq: this.items.length + 1,
      at: new Date().toISOString(),
      runId: this.runId,
      type,
      message: redactSecrets(message).text,
      ...(data === undefined ? {} : { data: redactData(data) as Record<string, unknown> }),
    };
    this.items.push(event);
    return event;
  }

  events(): GxEvent[] {
    return [...this.items];
  }
}
