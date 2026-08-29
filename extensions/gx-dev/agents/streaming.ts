/**
 * Streaming JSONL parser for `pi --mode json` child output (PLAN §4).
 *
 * The child emits one JSON object per line: a session header followed by
 * agent/turn/message lifecycle events. This module never throws on malformed
 * input; blank or partial lines are ignored so a killed child's truncated
 * tail cannot break evidence collection.
 *
 * Event shapes are inspected defensively (fields vary between pi versions):
 * - `message_update` carries top-level cumulative `usage`.
 * - `message_end` carries the final authoritative `message`; assistant text
 *   is read from content blocks, falling back to string content / `.text`.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses one JSONL line; returns null for blank, partial, or invalid lines. */
export function parseEventLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

export interface StreamResult {
  /** Concatenated text of every assistant `message_end`, in arrival order. */
  finalText: string;
  /** Latest cumulative usage reported by `message_update` / assistant `message_end`. */
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Provider-reported model id of the last assistant message, when present. */
  servedModel: string | null;
  /** True when any event of type "error" was observed. */
  sawError: boolean;
}

/** Extracts assistant text from a message object whose shape may vary. */
function extractMessageText(message: Record<string, unknown>): string {
  const content = message["content"];
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"]);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  if (typeof content === "string" && content.length > 0) return content;
  if (typeof message["text"] === "string" && message["text"].length > 0) {
    return message["text"];
  }
  return "";
}

function extractUsage(value: unknown): StreamResult["usage"] {
  if (!isRecord(value)) return null;
  // pi's wire Usage uses input/output; older shapes used inputTokens/outputTokens.
  const input = value["inputTokens"] ?? value["input"];
  const output = value["outputTokens"] ?? value["output"];
  if (typeof input !== "number" && typeof output !== "number") return null;
  return {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
  };
}

/** Accumulates final assistant text, usage, and error flags from JSONL events. */
export class StreamAccumulator {
  private readonly assistantTexts: string[] = [];
  private lastUsage: StreamResult["usage"] = null;
  private lastServedModel: string | null = null;
  private errorSeen = false;

  /** Feeds one raw line; blank, partial, and non-JSON lines are ignored. */
  feed(line: string): void {
    const event = parseEventLine(line);
    if (!isRecord(event)) return;
    const type = event["type"];
    if (type === "message_update") {
      // JSON mode: cumulative usage sits on the event itself.
      const usage =
        extractUsage(event["usage"]) ??
        extractUsage(isRecord(event["message"]) ? event["message"]["usage"] : null);
      if (usage) this.lastUsage = usage;
      return;
    }
    if (type === "message_end") {
      const message = event["message"];
      if (isRecord(message) && message["role"] === "assistant") {
        const text = extractMessageText(message);
        if (text.length > 0) this.assistantTexts.push(text);
        // The final assistant message carries authoritative usage + model.
        const usage = extractUsage(message["usage"]);
        if (usage) this.lastUsage = usage;
        if (typeof message["model"] === "string" && message["model"].length > 0) {
          this.lastServedModel = message["model"];
        }
      }
      return;
    }
    if (type === "error") {
      this.errorSeen = true;
    }
  }

  /** Snapshot of everything accumulated so far. */
  result(): StreamResult {
    return {
      finalText: this.assistantTexts.join("\n"),
      usage: this.lastUsage ? { ...this.lastUsage } : null,
      servedModel: this.lastServedModel,
      sawError: this.errorSeen,
    };
  }
}
