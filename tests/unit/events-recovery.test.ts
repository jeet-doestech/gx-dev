import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { test } from "node:test";
import { JsonlEventStore } from "../../extensions/gx-dev/domain/events.ts";

test("event stores reload sequence across owners and preserve interrupted records", () => {
  const directory = mkdtempSync(join(tmpdir(), "gx-event-"));
  try {
    const first = new JsonlEventStore(directory);
    const second = new JsonlEventStore(directory);
    assert.equal(first.append("run_created", "created").runId, basename(directory));
    assert.equal(second.append("user_action", "second owner").seq, 2);
    appendFileSync(join(directory, "events.jsonl"), '{"seq":3,"type":');
    assert.equal(first.append("user_action", "recovered").seq, 3);
    assert.equal(new JsonlEventStore(directory).events().length, 3);
    assert.match(readFileSync(join(directory, "events.jsonl"), "utf8"), /\{"seq":3,"type":\n/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("event logs redact nested secrets without changing caller objects", () => {
  const directory = mkdtempSync(join(tmpdir(), "gx-event-"));
  try {
    const payload = { nested: [{ token: "private-value", output: "ghp_123456789abcdefgh" }], exitCode: 1 };
    const event = new JsonlEventStore(directory).append("error", "password=private-value", payload);
    const raw = readFileSync(join(directory, "events.jsonl"), "utf8");
    assert.doesNotMatch(raw, /private-value|ghp_123456789abcdefgh/);
    assert.match(raw, /REDACTED/);
    assert.equal(event.data?.exitCode, 1);
    assert.equal(payload.nested[0]?.token, "private-value");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
