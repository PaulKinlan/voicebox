// tests/acp-permission-host.test.mjs — the host side of the permission round trip
// (`voicebox-beads-lgx`).
//
// WHAT THIS PINS: a real `session/request_permission` from a harness reaching a
// HOST and coming back. Until now the client answered a hardcoded `cancelled`
// ("no effect authority"), so the denial direction was wired and the host
// direction did not exist — a doc that is accurate about refusals and silent
// about the absence of an allow reads like a finished feature.
//
// THREE PROPERTIES, and the third is the one that makes it a gate rather than a
// button:
//   1. NO decider supplied -> `cancelled`, exactly as before (the safe default
//      is unchanged, so the existing suite passes for the right reason).
//   2. A decider that allows -> the harness's own `allow_once` option is
//      selected, i.e. the effect may proceed.
//   3. A grant is validated against what was OFFERED, and refusals keep their
//      PROVENANCE (a person's no vs an expiry), because the wire's `cancelled`
//      cannot carry that difference and whoever is waiting needs it.
//
//   node --test tests/acp-permission-host.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createAcpClient } from "../lib/acp-client.mjs";

const info = { protocolVersion: 1, agentInfo: { name: "pi-acp", version: "0.0.33" } };
const result = (m, r) => ({ jsonrpc: "2.0", id: m.id, result: r });

// The same fixture shape tests/acp-client.test.mjs uses: a stand-in harness over
// a captured pipe. The round trip is real except the transport.
function fixture(reply, options) {
  let receive;
  const sent = [];
  const client = createAcpClient({
    onMessage(fn) { receive = fn; },
    onClose() {},
    send(m) { sent.push(m); queueMicrotask(() => reply?.(m, receive)); },
    close() {},
  }, options);
  return { client, sent };
}

/** Handshake, open a session, then ask for exactly one permission. */
async function ask({ decide, options = [{ optionId: "allow", kind: "allow_once" }], sessionId = "s" } = {}) {
  const f = fixture((m, send) => {
    if (m.method === "initialize") send(result(m, info));
    if (m.method === "session/new") send(result(m, { sessionId: "s" }));
    if (m.method === "session/prompt") {
      send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId, title: "Permission: write", options } });
      send(result(m, { stopReason: "end_turn" }));
    }
  }, decide === undefined ? {} : { decide });
  await f.client.initialize();
  await f.client.newSession("/work");
  const prompt = f.client.prompt("hello");
  await new Promise((resolve) => setImmediate(resolve));
  const reply = f.sent.find((m) => m.id === "permission-1");
  await prompt;
  return { reply, decisions: f.client.permissions() };
}

test("no decider supplied: the answer is `cancelled` — the default changed for nobody", async () => {
  const { reply, decisions } = await ask();
  assert.deepEqual(reply.result, { outcome: { outcome: "cancelled" } });
  assert.equal(decisions.length, 1, "the decision is recorded even when nobody decided");
  assert.equal(decisions[0].decision, "cancelled");
  assert.equal(decisions[0].reason, "no-effect-authority", "and the reason names the absence of an authority");
});

test("a host that allows: the harness's own allow option is selected, so the effect may proceed", async () => {
  const { reply, decisions } = await ask({ decide: () => ({ allow: true, reason: "person said yes" }) });
  assert.deepEqual(reply.result, { outcome: { outcome: "selected", optionId: "allow" } });
  assert.equal(decisions[0].decision, "selected");
  assert.equal(decisions[0].optionId, "allow");
  assert.equal(decisions[0].reason, "person said yes");
});

test("a bare `true` from a decider is an allowance — the smallest thing a policy can answer", async () => {
  const { reply } = await ask({ decide: () => true });
  assert.deepEqual(reply.result, { outcome: { outcome: "selected", optionId: "allow" } });
});

test("a refusal keeps its PROVENANCE: a person's no and an expiry are distinguishable by the host", async () => {
  const human = await ask({ decide: () => ({ allow: false, reason: "denied" }) });
  const expired = await ask({ decide: () => ({ allow: false, reason: "expired" }) });
  assert.deepEqual(human.reply.result, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(expired.reply.result, { outcome: { outcome: "cancelled" } });
  // The wire says the same thing for both, which is why the reason is kept here:
  // a refusal that cannot name its cause is the defect this vocabulary exists to prevent.
  assert.equal(human.decisions[0].reason, "denied");
  assert.equal(expired.decisions[0].reason, "expired");
  assert.notEqual(human.decisions[0].reason, expired.decisions[0].reason);
});

test("MISMATCH: an allow where the harness offered no allow option is refused, not sent", async () => {
  const { reply, decisions } = await ask({
    options: [{ optionId: "no", kind: "reject_once" }],
    decide: () => ({ allow: true }),
  });
  assert.deepEqual(reply.result, { outcome: { outcome: "cancelled" } });
  assert.equal(decisions[0].reason, "no-allow-option", "a permission for a plan is not a permission for what runs");
});

test("MISMATCH: an allow naming an option nobody offered is refused, not sent", async () => {
  const { reply, decisions } = await ask({ decide: () => ({ allow: true, optionId: "ghost" }) });
  assert.deepEqual(reply.result, { outcome: { outcome: "cancelled" } });
  assert.equal(decisions[0].reason, "option-not-offered");
});

test("a decider that throws DENIES and does not kill the session: failing to decide is not allowing", async () => {
  const { reply, decisions } = await ask({ decide: () => { throw new Error("policy offline"); } });
  assert.deepEqual(reply.result, { outcome: { outcome: "cancelled" } });
  assert.match(decisions[0].reason, /^decider-threw/, "the cause is the decider's own failure, named");
});

test("a request for another session is refused before any host is asked", async () => {
  let asked = 0;
  const { reply, decisions } = await ask({ sessionId: "somewhere-else", decide: () => { asked += 1; return { allow: true }; } });
  assert.deepEqual(reply.result, { outcome: { outcome: "cancelled" } });
  assert.equal(decisions[0].reason, "foreign-session");
  assert.equal(asked, 0, "the host is never asked about a session this client does not hold");
});

test("an authority that cannot be called is refused at construction", () => {
  const transport = { onMessage() {}, onClose() {}, send() {}, close() {} };
  assert.throws(() => createAcpClient(transport, { decide: 5 }), { refused: "acp-decider-invalid" });
});
