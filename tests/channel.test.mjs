// tests/channel.test.mjs — the wire protocol drive (reports/…-placement-options.md §4).
//
// THE HONEST CLAIM: an in-process executor door wired to the REAL registry
// (admission, bounds, budget all inherited) with a stand-in peer over a
// captured pipe — THE ROUND TRIP IS REAL EXCEPT THE WIRE. The admission path,
// the bounds check and the budget are the real ones; the only synthetic thing
// is the transport.
//
//   node --test tests/channel.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch state BEFORE the lib loads — the suite never touches repo-owned files.
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "voicebox-channel-test-"));
// A DECLARATION of the active root (not a default): the loop has no root of its own any more.
process.env.VOICEBOX_WORKSPACE = path.join(SCRATCH, "workspace");
process.env.VOICEBOX_EXTENSIONS_DIR = path.join(SCRATCH, "extensions");

const { createChannel, createExecutorDoor } = await import("../lib/channel.mjs");
const extensions = await import("../lib/extensions.mjs");
const { AUTHORITY_BOUNDARY, NOT_CONNECTED, TIMED_OUT, CLOSED } = await import("../core/wire.ts");

test.after(() => rmSync(SCRATCH, { recursive: true, force: true }));

// Admit one real tool through the real gate.
const admitted = extensions.propose(
  {
    id: "clock-tool", name: "clock", description: "the time", source: "model", runsIn: "host",
    capabilities: [], bounds: {},
    tools: [{ name: "clock", description: "the time", primitive: "now", params: {} }],
  },
  "model",
);
assert.equal(admitted.state, "pending");
const adm = await extensions.admitProposal("clock-tool", "admit");
assert.equal(adm.decision, "admitted");

// And refuse one through the same gate, so the routed path inherits refusals too.
extensions.propose(
  {
    id: "mcp-server-local", name: "MCP (local)", description: "launch a process", source: "model", runsIn: "process",
    capabilities: ["exec"], bounds: {},
    tools: [{ name: "mcp_list_tools", description: "x", primitive: "process", params: {} }],
  },
  "model",
);
const refusedMcp = await extensions.admitProposal("mcp-server-local", "admit");
assert.equal(refusedMcp.decision, "refused");
assert.equal(refusedMcp.rule, "exec-absent");

// The stand-in pipe: sends are captured; the "peer" answers through deliver().
function harness({ connected = () => true, peer = "page", timeoutMs = 500 } = {}) {
  const sent = [];
  const channel = createChannel({ peer, connected, send: (m) => sent.push(m), timeoutMs });
  return { channel, sent };
}

const door = createExecutorDoor({
  lookup: extensions.lookupAdmitted,
  exec: (call) => extensions.callTool(call.tool, call.args),
});

test("no peer connected: the ask refuses in words and NOTHING goes on the wire", async () => {
  const { channel, sent } = harness({ connected: () => false });
  const r = await channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  assert.equal(r.ok, false);
  assert.equal(r.refused, NOT_CONNECTED.page);
  assert.match(r.why, /no page is connected/);
  assert.deepEqual(sent, [], "a call was sent to a peer that is not there");
});

test("the round trip is real except the wire: attributed call, real execution, observed facts back", async () => {
  const { channel, sent } = harness();
  const pending = channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  // The wire carried ATTRIBUTION: which descriptor authorises this, and its bounds.
  assert.equal(sent.length, 1);
  const onTheWire = JSON.parse(sent[0]);
  assert.equal(onTheWire.descriptorId, "clock-tool");
  assert.equal(onTheWire.tool, "clock");
  assert.deepEqual(onTheWire.boundsEcho, {});
  assert.match(onTheWire.callId, /^rt_/);
  // The peer's door validates against the REAL registry and runs the REAL tool.
  const answer = await door.receive(sent[0]);
  assert(typeof answer === "string");
  const channelVerdict = channel.deliver(answer);
  assert.equal(channelVerdict.delivered, true);
  const r = await pending;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.observed.content ?? "", /GMT|UTC/, "the observed facts carry the tool's output");
});

test("a tampered boundsEcho is REFUSED, not trusted: the echo is checked against the admission", async () => {
  const { channel, sent } = harness();
  const pending = channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  const tampered = JSON.parse(sent[0]);
  tampered.boundsEcho = { maxRequests: 9999 }; // the call claims bounds it was never admitted with
  const answer = await door.receive(JSON.stringify(tampered));
  channel.deliver(answer);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.refused, "bounds-mismatch");
  assert.match(r.why, /checked, never trusted/);
  assert.equal(JSON.parse(answer).ok, false, "the tampered call produced a refusal answer, not an execution");
});

test("a call naming an authority that does not exist is refused as unattributed", async () => {
  const raw = JSON.stringify({ v: 1, callId: "rt_x", tool: "clock", descriptorId: "no-such-tool", args: {}, boundsEcho: {} });
  const answer = door.receive(raw);
  const parsed = JSON.parse(answer);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.refused, "unattributed-call");
  assert.match(parsed.why, /names an authority that does not exist/);
});

test("a call with no attribution at all is refused: descriptorId and boundsEcho are not optional", async () => {
  const raw = JSON.stringify({ v: 1, callId: "rt_y", tool: "clock", args: {} });
  const parsed = JSON.parse(await door.receive(raw));
  assert.equal(parsed.refused, "unattributed-call");
  assert.match(parsed.why, /trusted because it matches an admission, never because it arrived/);
});

test("malformed wire is met with silence (nobody to answer), and the ask times out honestly", async () => {
  const { channel } = harness({ timeoutMs: 60 });
  const pending = channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  assert.equal(await door.receive("this is not json"), null, "an unparseable call got an answer — there was nobody to refuse");
  const r = await pending;
  assert.equal(r.refused, TIMED_OUT.page);
});

test("THE AUTHORITY BOUNDARY: a decision cannot ride the wire — unknown fields are refused both ways", async () => {
  // A call trying to carry a decision:
  const call = JSON.stringify({ v: 1, callId: "rt_z", tool: "clock", descriptorId: "clock-tool", boundsEcho: {}, decision: "allow" });
  const parsed = JSON.parse(await door.receive(call));
  assert.equal(parsed.refused, "unknown-field");
  assert.match(parsed.why, /a decision has no field to ride on/);
  // An answer trying to carry a grant:
  const { channel, sent } = harness();
  const pending = channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  const answer = JSON.stringify({ v: 1, callId: JSON.parse(sent[0]).callId, ok: true, observed: {}, grant: "everything" });
  const verdict = channel.deliver(answer);
  assert.equal(verdict.delivered, false);
  assert.equal(verdict.refused, "unknown-field");
  assert.match(verdict.why, /never authority/);
  // The pending call did NOT settle on the forged answer — it times out instead.
  const r = await pending;
  assert.equal(r.refused, TIMED_OUT.page);
  // And the boundary is a named, exportable sentence — not a vibe:
  assert.match(AUTHORITY_BOUNDARY, /the decision never crosses the channel/);
});

test("an answer claiming ok without observed facts is refused: 'it worked' is a claim, not an observation", async () => {
  const verdict = (() => { const c = harness(); return c.channel.deliver(JSON.stringify({ v: 1, callId: "rt_q", ok: true })); })();
  assert.equal(verdict.delivered, false);
  assert.match(verdict.why, /claim, not an observation/);
});

test("the routed path inherits the gate: a tool refused at admission cannot even be ATTRIBUTED", async () => {
  const { channel, sent } = harness();
  const pending = channel.ask({ tool: "mcp_list_tools", descriptorId: "mcp-server-local", boundsEcho: {} });
  const answer = await door.receive(sent[0]);
  channel.deliver(answer);
  const r = await pending;
  assert.equal(r.ok, false);
  // exec-absent kept the descriptor out of the registry, so a call naming it is
  // an attempt to ride an authority that does not exist — refused BEFORE the
  // executor ever runs, by the attribution check, not by a second opinion:
  assert.equal(r.refused, "unattributed-call");
  assert.match(r.why, /authority that does not exist/);
});

test("runtime refusals flow over the wire BY NAME, and the budget charges routed calls", async () => {
  extensions.propose(
    {
      id: "rdprobe", name: "RD Probe", description: "probe", source: "model", runsIn: "host",
      capabilities: ["network"], bounds: { hosts: ["127.0.0.1"], maxRequests: 1 },
      tools: [{ name: "rdprobe", description: "GET", primitive: "http-get", params: {} }],
    },
    "model",
  );
  assert.equal((await extensions.admitProposal("rdprobe", "admit")).decision, "admitted");
  const { channel, sent } = harness();
  const ask = (url) => {
    const idx = sent.length; // the envelope is sent synchronously inside ask()
    const p = channel.ask({ tool: "rdprobe", descriptorId: "rdprobe", boundsEcho: { hosts: ["127.0.0.1"], maxRequests: 1 }, args: { url } });
    return (async () => {
      const a = await door.receive(sent[idx]);
      channel.deliver(a);
      return p;
    })();
  };
  // An undeclared host: the runtime refuses BY NAME through the wire.
  const other = await ask("http://example.com/x");
  assert.equal(other.ok, false);
  assert.equal(other.refused, "host-not-allowed");
  // The declared but unroutable host: fetch-failed, and the attempt is charged.
  const dead = await ask("http://127.0.0.1:9/x");
  assert.equal(dead.ok, false);
  assert.equal(dead.refused, "fetch-failed");
  // Budget charged 1/1 by that attempt: the next routed call exhausts it, BY NAME.
  const again = await ask("http://127.0.0.1:9/x");
  assert.equal(again.refused, "budget-exhausted");
  assert.match(again.why, /1 of 1 requests used/);
});

test("an in-process caller may hand the door an OBJECT — the framing this commit's claim runs in", async () => {
  const { channel, sent } = harness();
  const pending = channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  // The peer parsed the wire, so what it holds is an OBJECT, not a string:
  const objectForm = JSON.parse(sent[0]);
  const answer = await door.receive(objectForm);
  assert(typeof answer === "string", "an object call produced no answer — parseCall refused it");
  assert.equal(channel.deliver(answer).delivered, true);
  const r = await pending;
  assert.equal(r.ok, true, `the object path refused a good call: ${JSON.stringify(r)}`);
  assert.match(r.observed.content ?? '', /GMT|UTC/);
  // The reviewer's driven pair, identical data both ways: the object parses,
  // the same data with an unknown field lands on unknown-field — NOT malformed.
  const pure = await import("../core/wire.ts");
  const asObject = pure.parseCall({ v: 1, callId: "rt_o", tool: "clock", descriptorId: "clock-tool", boundsEcho: {} }, extensions.lookupAdmitted);
  assert.equal(asObject.ok, true, "parseCall still refuses objects after the fix");
  const withExtra = pure.parseCall({ v: 1, callId: "rt_o", tool: "clock", descriptorId: "clock-tool", boundsEcho: {}, decision: "allow" }, extensions.lookupAdmitted);
  assert.equal(withExtra.ok, false);
  assert.equal(withExtra.refused, "unknown-field");
});

test("absence is a vocabulary: which half is missing is IN the refusal name", async () => {
  // page absent:
  const pageDown = harness({ connected: () => false, peer: "page" });
  const pageR = await pageDown.channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  assert.equal(pageR.refused, "no-page");
  // machine absent (the page-harness orientation):
  const machineDown = harness({ connected: () => false, peer: "machine" });
  const machineR = await machineDown.channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  assert.equal(machineR.refused, "machine-unreachable");
  assert.match(machineR.why, /the machine is unreachable/);
  assert.notEqual(pageR.refused, machineR.refused, "the two absences must not be the same experience");
  // timeout and closed are distinct from each other and from not-connected:
  const slow = harness({ timeoutMs: 50 });
  const slowPending = slow.channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  const timeoutR = await slowPending;
  assert.equal(timeoutR.refused, "page-timeout");
  const gone = harness();
  const gonePending = gone.channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  assert.equal(gone.channel.waiting(), 1);
  gone.channel.abandon();
  const closedR = await gonePending;
  assert.equal(closedR.refused, "page-closed");
  assert.match(closedR.why, /the page closed before it answered/);
  const machineGone = harness({ peer: "machine" });
  const machinePending = machineGone.channel.ask({ tool: "clock", descriptorId: "clock-tool", boundsEcho: {} });
  machineGone.channel.abandon();
  assert.equal((await machinePending).refused, "machine-closed");
  assert.equal([NOT_CONNECTED.page, TIMED_OUT.page, CLOSED.page, NOT_CONNECTED.machine, TIMED_OUT.machine, CLOSED.machine].length,
    new Set([NOT_CONNECTED.page, TIMED_OUT.page, CLOSED.page, NOT_CONNECTED.machine, TIMED_OUT.machine, CLOSED.machine]).size,
    "the absence vocabulary has duplicate names");
});
