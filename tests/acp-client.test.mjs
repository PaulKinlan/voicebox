import test from "node:test";
import assert from "node:assert/strict";
import { createAcpClient, ACP_AGENT } from "../lib/acp-client.mjs";
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
const info = { protocolVersion: 1, agentInfo: { name: ACP_AGENT.name, version: ACP_AGENT.version } };

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

test("the timeout ceiling is PER-ADAPTER (voicebox-beads-hmco): a raised ceiling admits longer deadlines, the default still refuses them", async () => {
  // With the adapter's own ceiling, a 120s timeout is finite and admitted.
  const raised = fixture((m, send) => { if (m.method === "initialize") send(result(m, info)); },
    { timeoutMs: 120000, timeoutCeilingMs: 120000 });
  await raised.client.initialize(); // a within-ceiling client initializes — nothing refuses it
  raised.client.close();

  // The DEFAULT ceiling (60000 — pi's) still refuses a 120s timeout, naming the ceiling.
  assert.throws(
    () => fixture(() => {}, { timeoutMs: 120000 }),
    (err) => err.refused === "unbounded-executor" && /ceiling 60000ms/.test(err.message),
    "the default ceiling must refuse 120s by name",
  );

  // Even a raised ceiling is itself bounded: nothing here can be made unbounded.
  assert.throws(
    () => fixture(() => {}, { timeoutMs: 601000, timeoutCeilingMs: 601000 }),
    (err) => err.refused === "unbounded-executor",
    "a ceiling above the 600000ms meta-cap must refuse",
  );
});

test("a write that fails because the harness is already GONE is not the verdict — the transport's closure is (voicebox-beads-cps6)", async () => {
  // THE MEASURED FLAKE, made deterministic: a stub adapter writes stderr and exits(1), and the
  // client's initialize frame loses the race against the process. The raw `write EPIPE` used to
  // reach the caller as the task's outcome, so the diagnostics case failed on the write instead of
  // asserting the exit code and stderr it exists for. The peer-gone frame is dropped (there is
  // nobody to receive it) and the transport's own closure — which carries the diagnostic — settles
  // the pending request.
  let ended;
  const client = createAcpClient({
    onMessage() {}, onClose(fn) { ended = fn; },
    send() { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); }, close() {},
  }, { timeoutMs: 1000 });

  const pending = client.initialize();
  ended(Object.assign(new Error("claude-code process exited with code 1 while initializing claude-code\nStderr: npm error notarget ETARGET"), { refused: "harness-ended-outcome-unknown" }));
  await assert.rejects(pending, (err) =>
    err.refused === "harness-ended-outcome-unknown" && /ETARGET/.test(err.message),
  "the closure's diagnostic must win over the write failure");
});

test("a write failure that is NOT the peer being gone still surfaces as itself — the tolerance is not a blanket swallow (voicebox-beads-cps6)", async () => {
  // The adversarial control: the codes that mean "there is nobody to receive this" are absorbed,
  // and nothing else is. A transport that fails for a real reason must name that reason rather
  // than stalling until the timeout and refusing as an unrelated one.
  const client = createAcpClient({
    onMessage() {}, onClose() {},
    send() { throw Object.assign(new Error("bad file descriptor"), { code: "EBADF" }); }, close() {},
  }, { timeoutMs: 1000 });

  await assert.rejects(client.initialize(), (err) => err.code === "EBADF",
    "a non-peer-gone write failure must still reach the caller as itself");
});

test("cancel() reports what it DID: a frame dropped because the peer is gone is not 'sent' (voicebox-beads-cps6)", async () => {
  // The corollary of absorbing a peer-gone write: `sent: true` claims "the notification left".
  // When the harness is already gone it did not, and the closure — not this call — is the verdict.
  // Otherwise cancel() would report delivery for a frame that was dropped.
  let receive;
  const client = createAcpClient({
    onMessage(fn) { receive = fn; }, onClose() {},
    send(m) {
      if (m.method === "session/cancel") throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      queueMicrotask(() => {
        if (m.method === "initialize") receive(result(m, info));
        if (m.method === "session/new") receive(result(m, { sessionId: "s" }));
        // session/prompt stays unanswered: the turn is in flight, which is when cancel applies.
      });
    },
    close() {},
  }, { timeoutMs: 2000 });

  await client.initialize();
  await client.newSession("/work");
  const turn = client.prompt("hello");
  turn.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(client.cancel(), { ok: true, sent: false }, "a frame that never left must not be reported as sent");

  client.close();
  await assert.rejects(turn, (err) => err.refused === "acp-closed", "the closure settles the in-flight turn");
});
