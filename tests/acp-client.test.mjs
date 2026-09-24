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
  // Nothing has run in this session: the remedy is to start a task, not to
  // change a permission — so the name says that (voicebox-beads-6co).
  assert.throws(() => f.client.cancel(), { refused: "task-not-found" });
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

/**
 * D2's cancellation half (`voicebox-beads-6co`): a cancel during an in-flight
 * turn SETTLES the turn as cancelled, and cancelling anything that is not a
 * running turn refuses by name — three states, three names, so the reader knows
 * which remedy applies.
 */
test("cancel during an in-flight turn settles the turn as cancelled, and says the notification left", async () => {
  let answerPrompt;
  const f = fixture((m, send) => {
    if (m.method === "initialize") send(result(m, info));
    if (m.method === "session/new") send(result(m, { sessionId: "s" }));
    if (m.method === "session/prompt") answerPrompt = () => send(result(m, { stopReason: "cancelled" }));
  });
  await f.client.initialize();
  await f.client.newSession("/work");
  const turn = f.client.prompt("do something long");
  await new Promise((resolve) => setImmediate(resolve));

  const sent = f.client.cancel();
  assert.deepEqual(sent, { ok: true, sent: true }, "cancel reports what it DID: the notification left");
  const cancel = f.sent.find((m) => m.method === "session/cancel");
  assert.ok(cancel, "a session/cancel notification was sent");
  assert.equal(cancel.id, undefined, "session/cancel is a notification, not a request");
  assert.deepEqual(cancel.params, { sessionId: "s" });

  answerPrompt();
  await assert.rejects(turn, { refused: "task-cancelled" }, "the turn settles BY NAME as cancelled, not as an incomplete turn");
});

test("cancelling a COMPLETED task refuses by name, and it is not the same name as nothing-to-cancel", async () => {
  const f = fixture((m, send) => {
    if (m.method === "initialize") send(result(m, info));
    if (m.method === "session/new") send(result(m, { sessionId: "s" }));
    if (m.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
      send(result(m, { stopReason: "end_turn" }));
    }
  });
  await f.client.initialize();
  await f.client.newSession("/work");
  assert.equal(await f.client.prompt("quick"), "done");
  // A task HAS run here, so "start a task" is the wrong remedy — and the name says so.
  assert.throws(() => f.client.cancel(), { refused: "task-not-running" });
  assert.equal(f.sent.filter((m) => m.method === "session/cancel").length, 0, "nothing was sent for a completed task");
});

test("a turn that is neither end_turn nor cancelled is still an incomplete turn — the new name did not swallow it", async () => {
  const f = fixture((m, send) => {
    if (m.method === "initialize") send(result(m, info));
    if (m.method === "session/new") send(result(m, { sessionId: "s" }));
    if (m.method === "session/prompt") send(result(m, { stopReason: "max_tokens" }));
  });
  await f.client.initialize();
  await f.client.newSession("/work");
  await assert.rejects(f.client.prompt("too long"), { refused: "acp-turn-incomplete" });
});

test("setConfigOption sets option on active session and validates inputs and session state", async () => {
  const f = fixture((m, send) => {
    if (m.method === "initialize") send(result(m, info));
    if (m.method === "session/new") send(result(m, { sessionId: "s" }));
    if (m.method === "session/set_config_option") {
      if (m.params.configId === "bad") {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown option" } });
      } else {
        send(result(m, { configOptions: [] }));
      }
    }
  });

  // Cannot set config before session
  await assert.rejects(f.client.setConfigOption("model", "gpt-4o"), { refused: "acp-state" });
  await f.client.initialize();
  await assert.rejects(f.client.setConfigOption("model", "gpt-4o"), { refused: "acp-state" });

  await f.client.newSession("/work");
  await assert.rejects(f.client.setConfigOption("", "val"), { refused: "acp-invalid-config" });
  await assert.rejects(f.client.setConfigOption("model", 123), { refused: "acp-invalid-config" });

  const res = await f.client.setConfigOption("model", "gpt-4o");
  assert.deepEqual(res, { configOptions: [] });
  assert.ok(f.sent.some((m) => m.method === "session/set_config_option" && m.params.configId === "model" && m.params.value === "gpt-4o"));

  await assert.rejects(f.client.setConfigOption("bad", "val"), { refused: "acp-request-refused" });
});
