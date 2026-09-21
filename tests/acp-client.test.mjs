import test from "node:test";
import assert from "node:assert/strict";
import { createAcpClient } from "../lib/acp-client.mjs";
import { TaskInterrupted } from "../lib/task-interrupted.mjs";

// Protocol fixtures prove client validation, never third-party/provider acceptance.
function fixture(reply, options) {
  let receive, ended, closed = 0;
  const sent = [];
  const client = createAcpClient({ onMessage(fn) { receive = fn; }, onClose(fn) { ended = fn; },
    send(m) { sent.push(m); queueMicrotask(() => reply?.(m, receive)); }, close() { closed++; } }, options);
  return { client, sent, receive: (m) => receive(m), end: (e) => ended(e), closed: () => closed };
}
const result = (m, r) => ({ jsonrpc: "2.0", id: m.id, result: r });
const info = { protocolVersion: 1, agentInfo: { name: "pi-acp", version: "0.0.33" } };

test("ACP protocol fixture: handshake, session, text, permission denial and cancellation framing", async () => {
  let finish;
  const f = fixture((m, send) => {
    if (m.method === "initialize") send(result(m, info));
    if (m.method === "session/new") { assert.deepEqual(m.params.mcpServers, []); send(result(m, { sessionId: "s" })); }
    if (m.method === "session/prompt") {
      send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "s", options: [{ optionId: "allow", kind: "allow_once" }] } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "bounded answer" } } } });
      finish = () => send(result(m, { stopReason: "end_turn" }));
    }
  });
  assert.throws(() => f.client.cancel(), { refused: "task-not-running" });
  await f.client.initialize(); await f.client.newSession("/work");
  const answer = f.client.prompt("hello");
  await new Promise((resolve) => setImmediate(resolve));
  f.client.cancel();
  assert.deepEqual(f.sent.find((m) => m.id === "permission-1").result, { outcome: { outcome: "cancelled" } });
  assert.ok(f.sent.some((m) => m.method === "session/cancel" && m.id === undefined));
  finish(); assert.equal(await answer, "bounded answer"); f.client.close();
});

test("ACP fixture refuses wrong version, missing timeout, malformed response, timeout and typed death", async () => {
  for (const changed of [{ protocolVersion: 2 }, { agentInfo: { name: "pi-acp", version: "999" } }]) {
    const f = fixture((m, send) => send(result(m, { ...info, ...changed })));
    await assert.rejects(f.client.initialize(), { refused: "adapter-version-unsupported" });
    assert.equal(f.closed(), 1);
  }
  assert.throws(() => fixture(null, { timeoutMs: Infinity }), { refused: "unbounded-executor" });
  const malformed = fixture((m, send) => send({ jsonrpc: "2.0", id: m.id }));
  await assert.rejects(malformed.client.initialize(), { refused: "acp-invalid-response" });
  const timed = fixture(null, { timeoutMs: 10 });
  await assert.rejects(timed.client.initialize(), { refused: "acp-timeout" });
  const dead = fixture(); const waiting = dead.client.initialize();
  dead.end(new TaskInterrupted("harness-ended-outcome-unknown"));
  await assert.rejects(waiting, TaskInterrupted);
});

test("ACP fixture bounds output and rejects foreign-session updates", async () => {
  for (const [sessionId, text, refusal, count = 1] of [["other", "x", "acp-session-mismatch"], ["s", "x".repeat(400), "acp-invalid-message"], ["s", "x".repeat(100), "task-output-over-budget", 4]]) {
    const f = fixture((m, send) => {
      if (m.method === "initialize") send(result(m, info));
      if (m.method === "session/new") send(result(m, { sessionId: "s" }));
      if (m.method === "session/prompt") for (let i = 0; i < count; i++) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    }, { maxBytes: 350 });
    await f.client.initialize(); await f.client.newSession("/work");
    await assert.rejects(f.client.prompt("hello"), { refused: refusal });
  }
});
