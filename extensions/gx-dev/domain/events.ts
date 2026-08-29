/**
 * Append-only event log (PLAN §10.4). events.jsonl is the audit trail;
 * state.json is operational truth. Events are written before side effects
 * that depend on them wherever practical, and always flushed synchronously.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

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
    const prior = this.events();
    const event: GxEvent = {
      seq: prior.length + 1,
      at: new Date().toISOString(),
      runId: this.readRunId(prior),
      type,
      message,
      ...(data === undefined ? {} : { data }),
    };
    appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8");
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
    this.cache = lines.map((l) => JSON.parse(l) as GxEvent);
    return this.cache;
  }

  private readRunId(prior: GxEvent[]): string {
    const last = prior[prior.length - 1];
    if (last?.runId) return last.runId;
    const h = createHash("sha256").update(this.file).digest("hex").slice(0, 12);
    return `run-${h}`;
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
      message,
      ...(data === undefined ? {} : { data }),
    };
    this.items.push(event);
    return event;
  }

  events(): GxEvent[] {
    return [...this.items];
  }
}
