/**
 * Unit tests for the pi `--mode json` JSONL stream parser (agents/streaming.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEventLine, StreamAccumulator } from "../../extensions/gx-dev/agents/streaming.ts";

describe("parseEventLine", () => {
  it("parses valid JSON objects", () => {
    const parsed = parseEventLine('{"type":"agent_start"}');
    assert.deepEqual(parsed, { type: "agent_start" });
  });

  it("returns null for blank lines", () => {
    assert.equal(parseEventLine(""), null);
    assert.equal(parseEventLine("   \t "), null);
  });

  it("returns null for partial/truncated lines", () => {
    assert.equal(parseEventLine('{"type":"mess'), null);
    assert.equal(parseEventLine('{"type":"message_end",'), null);
  });

  it("returns null for non-JSON garbage", () => {
    assert.equal(parseEventLine("not json at all"), null);
    assert.equal(parseEventLine("Error: boom"), null);
  });
});

describe("StreamAccumulator", () => {
  it("starts empty", () => {
    const acc = new StreamAccumulator();
    assert.deepEqual(acc.result(), { finalText: "", usage: null, servedModel: null, sawError: false });
  });

  it("extracts assistant text from message_end content blocks", () => {
    const acc = new StreamAccumulator();
    acc.feed('{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"task"}]}}');
    acc.feed(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Part one."},{"type":"text","text":" Part two."}]}}',
    );
    assert.equal(acc.result().finalText, "Part one. Part two.");
    assert.equal(acc.result().sawError, false);
  });

  it("concatenates text across multiple assistant message_end events", () => {
    const acc = new StreamAccumulator();
    acc.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}');
    acc.feed('{"type":"tool_execution_end","toolCallId":"t1","toolName":"read","result":"ok","isError":false}');
    acc.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}');
    assert.equal(acc.result().finalText, "first\nsecond");
  });

  it("falls back to string content and .text fields defensively", () => {
    const acc = new StreamAccumulator();
    acc.feed('{"type":"message_end","message":{"role":"assistant","content":"plain string"}}');
    assert.equal(acc.result().finalText, "plain string");

    const acc2 = new StreamAccumulator();
    acc2.feed('{"type":"message_end","message":{"role":"assistant","text":"bare text field"}}');
    assert.equal(acc2.result().finalText, "bare text field");
  });

  it("ignores assistant messages with no text content", () => {
    const acc = new StreamAccumulator();
    acc.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}');
    acc.feed('{"type":"message_end","message":{"role":"assistant","content":[]}}');
    assert.equal(acc.result().finalText, "");
  });

  it("takes usage from the last message_update event", () => {
    const acc = new StreamAccumulator();
    acc.feed('{"type":"message_update","usage":{"inputTokens":10,"outputTokens":2},"assistantMessageEvent":{"type":"text_delta","delta":"a"}}');
    acc.feed('{"type":"message_update","usage":{"inputTokens":25,"outputTokens":9},"assistantMessageEvent":{"type":"text_delta","delta":"b"}}');
    assert.deepEqual(acc.result().usage, { inputTokens: 25, outputTokens: 9 });
  });

  it("keeps the last known usage when a later update omits it", () => {
    const acc = new StreamAccumulator();
    acc.feed('{"type":"message_update","usage":{"inputTokens":7,"outputTokens":3}}');
    acc.feed('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"a"}}');
    assert.deepEqual(acc.result().usage, { inputTokens: 7, outputTokens: 3 });
  });

  it("flags sawError when an error event arrives", () => {
    const acc = new StreamAccumulator();
    acc.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}');
    acc.feed('{"type":"error","error":{"message":"provider exploded"}}');
    const r = acc.result();
    assert.equal(r.sawError, true);
    assert.equal(r.finalText, "hi");
  });

  it("survives blank lines, partial lines, and non-event JSON without throwing", () => {
    const acc = new StreamAccumulator();
    acc.feed("");
    acc.feed('{"type":"message_end","mess');
    acc.feed("42");
    acc.feed('"just a string"');
    acc.feed("   ");
    acc.feed('{"unknown":"shape"}');
    acc.feed('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}');
    assert.equal(acc.result().finalText, "ok");
    assert.equal(acc.result().usage, null);
  });

  it("handles a realistic multi-event session fixture", () => {
    const fixture = [
      '{"type":"session","version":3,"id":"u1","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
      '{"type":"agent_start"}',
      '{"type":"turn_start"}',
      '{"type":"message_start","message":{"role":"assistant","content":[]}}',
      '{"type":"message_update","usage":{"inputTokens":42,"outputTokens":17},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hel"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"toolResults":[]}',
      '{"type":"agent_end","messages":[]}',
      "",
    ].join("\n");
    const acc = new StreamAccumulator();
    for (const line of fixture.split("\n")) acc.feed(line);
    assert.deepEqual(acc.result(), {
      finalText: "Hello",
      usage: { inputTokens: 42, outputTokens: 17 },
      servedModel: null,
      sawError: false,
    });
  });
});

describe("wire usage + servedModel", () => {
  it("captures pi wire usage (input/output keys) and servedModel from assistant message_end", () => {
    const fixture = [
      JSON.stringify({ type: "message_update", usage: { input: 2602, output: 4 } }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "glm-5.3-flash",
          provider: "zai",
          content: [{ type: "text", text: "OK" }],
          usage: { input: 2602, output: 18, cacheRead: 704 },
        },
      }),
    ].join("\n");
    const acc = new StreamAccumulator();
    for (const line of fixture.split("\n")) acc.feed(line);
    const r = acc.result();
    assert.deepEqual(r.usage, { inputTokens: 2602, outputTokens: 18 });
    assert.equal(r.servedModel, "glm-5.3-flash");
    assert.equal(r.finalText, "OK");
  });
});

describe("usage aggregation across turns (REVIEW: retain whole-run usage, not the latest message)", () => {
  it("sums usage across multiple completed assistant messages", () => {
    const acc = new StreamAccumulator();
    acc.feed(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "turn one" }], usage: { input: 100, output: 50 } },
      }),
    );
    acc.feed(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "turn two" }], usage: { input: 200, output: 30 } },
      }),
    );
    const r = acc.result();
    assert.deepEqual(r.usage, { inputTokens: 300, outputTokens: 80 });
    assert.equal(r.finalText, "turn one\nturn two");
  });

  it("counts an in-flight message once: message_update usage is cumulative per message", () => {
    const acc = new StreamAccumulator();
    acc.feed(JSON.stringify({ type: "message_update", usage: { input: 10, output: 2 } }));
    acc.feed(JSON.stringify({ type: "message_update", usage: { input: 25, output: 9 } }));
    // message_end without usage falls back to the last cumulative update.
    acc.feed(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    );
    assert.deepEqual(acc.result().usage, { inputTokens: 25, outputTokens: 9 });
  });

  it("aggregates multi-turn runs where each turn streams its own cumulative usage", () => {
    const acc = new StreamAccumulator();
    // Turn 1: streaming updates then a final authoritative end.
    acc.feed(JSON.stringify({ type: "message_update", usage: { input: 60, output: 10 } }));
    acc.feed(JSON.stringify({ type: "message_update", usage: { input: 100, output: 50 } }));
    acc.feed(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "a" }], usage: { input: 100, output: 55 } },
      }),
    );
    acc.feed(JSON.stringify({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: "", isError: false }));
    // Turn 2: fresh message; the message_end value is authoritative.
    acc.feed(JSON.stringify({ type: "message_update", usage: { input: 40, output: 10 } }));
    acc.feed(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "b" }], usage: { input: 40, output: 15 } },
      }),
    );
    assert.deepEqual(acc.result().usage, { inputTokens: 140, outputTokens: 70 });
  });

  it("does not double-count when message_end repeats the in-flight update usage", () => {
    const acc = new StreamAccumulator();
    acc.feed(JSON.stringify({ type: "message_update", usage: { input: 42, output: 17 } }));
    acc.feed(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "x" }], usage: { input: 42, output: 17 } },
      }),
    );
    assert.deepEqual(acc.result().usage, { inputTokens: 42, outputTokens: 17 });
  });

  it("ignores usage on non-assistant message_end events", () => {
    const acc = new StreamAccumulator();
    acc.feed(
      JSON.stringify({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "task" }], usage: { input: 999, output: 999 } },
      }),
    );
    assert.equal(acc.result().usage, null);
  });

  it("still reports the in-flight message usage when the stream is truncated (killed child)", () => {
    const acc = new StreamAccumulator();
    acc.feed(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "one" }], usage: { input: 10, output: 5 } },
      }),
    );
    acc.feed(JSON.stringify({ type: "message_update", usage: { input: 7, output: 3 } }));
    // No message_end for the second message — truncated tail.
    assert.deepEqual(acc.result().usage, { inputTokens: 17, outputTokens: 8 });
  });

  it("reports null usage when no usage was ever observed", () => {
    const acc = new StreamAccumulator();
    acc.feed(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "no usage here" }] },
      }),
    );
    assert.equal(acc.result().usage, null);
  });
});
