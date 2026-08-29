import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { redactSecrets } from "../../extensions/gx-dev/memory/redaction.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test("redacts bearer/API tokens (sk-, ghp_, AKIA)", () => {
  const r = redactSecrets("call with sk-abc12345XYZ and ghp_a1B2c3D4e5F6 then AKIAIOSFODNN7EXAMPLE");
  assert.equal(r.found, 3);
  assert.ok(!r.text.includes("sk-abc12345XYZ"));
  assert.ok(!r.text.includes("ghp_a1B2c3D4e5F6"));
  assert.ok(!r.text.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.equal(r.text.match(/\[REDACTED:api-token\]/g)?.length, 3);
});

test("does not redact hyphenated words that merely contain token prefixes", () => {
  const r = redactSecrets("the task-12345678 id and risk-abcdefgh notation stay intact");
  assert.equal(r.found, 0);
  assert.equal(r.text, "the task-12345678 id and risk-abcdefgh notation stay intact");
});

test("redacts assignment-style values, quoted and bare", () => {
  const r = redactSecrets('password: hunter2secret and api_key = "s3cr3tvalue"');
  assert.equal(r.found, 2);
  assert.ok(r.text.includes("password: [REDACTED:assignment]"));
  assert.ok(r.text.includes('api_key = "[REDACTED:assignment]"'));
  assert.ok(!r.text.includes("hunter2secret"));
  assert.ok(!r.text.includes("s3cr3tvalue"));
});

test("redacts PEM private key blocks", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7fakedata\n-----END RSA PRIVATE KEY-----";
  const r = redactSecrets(`config:\n${pem}\nend`);
  assert.equal(r.found, 1);
  assert.ok(r.text.includes("[REDACTED:private-key]"));
  assert.ok(!r.text.includes("MIIEpAIBAAKCAQEA7"));
});

test("redacts long credential after Authorization/Bearer", () => {
  const r = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  assert.equal(r.found, 1);
  assert.ok(r.text.startsWith("Authorization: Bearer [REDACTED:authorization]"));
  assert.ok(!r.text.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
});

test("redacts long hex/base64 literals in key: contexts", () => {
  const r = redactSecrets("key: 0123456789abcdef0123456789abcdef");
  assert.equal(r.found, 1);
  assert.ok(r.text.includes("key: [REDACTED:credential]"));
  assert.ok(!r.text.includes("0123456789abcdef0123456789abcdef"));
});

test("never redacts normal prose", () => {
  const prose =
    "We must never hardcode credentials. The secret sauce is love; token counting matters. risk-12345678 is not a token.";
  const r = redactSecrets(prose);
  assert.equal(r.found, 0);
  assert.equal(r.text, prose);
});

test("already redacted text is left alone (found 0)", () => {
  const r = redactSecrets("password: [REDACTED:assignment] stays untouched");
  assert.equal(r.found, 0);
  assert.equal(r.text, "password: [REDACTED:assignment] stays untouched");
});
