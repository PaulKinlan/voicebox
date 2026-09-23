import test from "node:test";
import assert from "node:assert/strict";
import { exportDebug, redact, isDebugError } from "../public/debug-transcript.js";
import { createLiveSession, registerLiveProvider } from "../lib/live-session.mjs";
import { createGeminiProvider } from "../lib/live-providers/gemini.mjs";
import { createOpenAIProvider } from "../lib/live-providers/openai.mjs";

test("debug export redacts nested fields, headers, embedded credentials and opaque prose, without mutating raw events", () => {
  const secrets = ["short-password", "short-cookie", "short-auth", "short-key", "BearerValue", "two word secret", "AIzaSySyntheticShapeOnly123456789012345", "sk-proj-syntheticsecretabcdefghijk", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature", "PRIVATE MATERIAL"];
  const raw = [{ type: "tool.result", timestamp: "2026-09-23T12:00:00.000Z", result: { ok: false, refused: "missing-file", error: "not found", password: secrets[0], headers: { Cookie: secrets[1], Authorization: secrets[2] }, nested: [{ api_key: secrets[3] }] },
    text: `Bearer ${secrets[4]}\nlog: password="${secrets[5]}"\n${secrets.slice(6, 9).join(" ")}\n-----BEGIN PRIVATE KEY-----\n${secrets[9]}\n-----END PRIVATE KEY-----`,
    encoded: JSON.stringify({ credentials: { value: secrets[2] } }) }];
  const before = JSON.stringify(raw);
  const exported = exportDebug(raw);
  for (const secret of secrets) assert(!exported.includes(secret), "a seeded secret survived export");
  assert.equal(JSON.stringify(raw), before, "redaction belongs on export, not raw capture");
  const decoded = JSON.parse(exported);
  assert.equal(decoded.result.refused, "missing-file");
  assert.equal(decoded.result.error, "not found");
  assert.equal(decoded.timestamp, raw[0].timestamp);
  for (const text of ["Cookie: a=small; b=smaller", "Set-Cookie: small=value; HttpOnly", "https://user:pass@host/path", "?key=short-key", 'log {"api_key":"short-key"}', "export PRIVATE_KEY='two word secret'"]) {
    const cleaned = redact(text);
    assert.match(cleaned, /redacted/);
    assert(!cleaned.includes("short-key") && !cleaned.includes("two word secret") && !cleaned.includes("user:pass"));
  }
});

test("redacted opaque IDs remain correlatable across the entire JSONL export", () => {
  const callId = "call_012345678901234567890123456789";
  const text = exportDebug([{ type: "tool.request", callId }, { type: "tool.result", callId }]);
  const rows = text.trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].callId, rows[1].callId);
  assert.notEqual(rows[0].callId, callId);
  assert.match(rows[0].callId, /redacted/);
  assert.equal(isDebugError({ type: "tool.result", severity: "error" }), true);
  assert.equal(isDebugError({ type: "tool.dropped" }), true);
  assert.equal(isDebugError({ type: "tool.refused" }), true);
  assert.equal(isDebugError({ type: "tool.delivery", severity: "info" }), false);
});

test("session debug exposes early/closed dropped calls, missing response support and send exceptions", () => {
  let emit;
  const trace = [];
  let routed = 0;
  registerLiveProvider("debug-fixture", opts => { emit = opts.emit; return { close() {} }; });
  const session = createLiveSession({ provider: "debug-fixture", onDebug: e => trace.push(e), onToolCall: () => routed++, log() {} });
  emit({ type: "tool-call", calls: [{ id: "early", name: "read_file", args: { name: "a.txt" } }] });
  assert.equal(routed, 0);
  assert(trace.some(e => e.type === "tool.dropped" && e.reason === "session-not-ready"));
  assert.equal(session.sendToolResponse([{ id: "early" }]), false);
  emit({ type: "ready" });
  assert.equal(session.sendToolResponse([{ id: "unsupported" }]), false);
  assert(trace.some(e => e.callId === "unsupported" && e.reason === "provider-cannot-answer-tool-call"));
  session.close();
  emit({ type: "tool-call", calls: [{ id: "late", name: "read_file" }] });
  assert(trace.some(e => e.type === "tool.dropped" && e.reason === "session-closed"));

  registerLiveProvider("debug-throw", opts => { opts.emit({ type: "ready" }); return { sendToolResponse() { throw new Error("fixture send failure"); }, close() {} }; });
  const throwing = createLiveSession({ provider: "debug-throw", onDebug: e => trace.push(e), log() {} });
  assert.equal(throwing.sendToolResponse([{ id: "throw" }]), false);
  assert(trace.some(e => e.callId === "throw" && e.delivery === "unknown" && e.error === "fixture send failure"));
  throwing.close();
});

for (const [name, create, key] of [["gemini", createGeminiProvider, "GEMINI_API_KEY"], ["openai", createOpenAIProvider, "OPENAI_API_KEY"]]) {
  test(`${name} debug: transport refusal and malformed request are visible, never acknowledged as model receipt`, () => {
    const saved = process.env[key];
    process.env[key] = "synthetic-fixture-only";
    try {
      let onEvent;
      const trace = [];
      const provider = create({ emit() {}, log() {}, debug: e => trace.push(e), transport: {
        connect(_url, handlers) { onEvent = handlers.onEvent; }, send() { return false; }, close() {},
      } });
      assert.equal(provider.sendToolResponse([{ id: "blocked", name: "read_file", response: { result: { ok: false, error: "original error" } } }]), false);
      const delivery = trace.find(e => e.type === "tool.delivery");
      assert.equal(delivery.delivery, "not-sent");
      assert.equal(delivery.modelReceipt, "unknown");
      assert.equal(delivery.response.result.error, "original error");
      onEvent({ kind: "message", data: JSON.stringify(name === "gemini" ? { toolCall: { functionCalls: "invalid" } } : { type: "response.function_call_arguments.done", call_id: "bad", name: "read_file", arguments: "{" }) });
      assert(trace.some(e => e.type === "tool.wire-request"));
      assert(trace.some(e => isDebugError(e)));
      provider.close();
    } finally {
      if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    }
  });
}
