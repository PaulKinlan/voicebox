// tests/mini-app-relay-policy.test.mjs — what the mini-app fetch relay will carry, driven rather than grepped
// (voicebox-beads-j6im).
//
// THE FINDING. public/relay-target.mjs decided only that a target was SAME-ORIGIN, and the relay then fetched it
// with the bridge page's own authority. server.mjs treats any request carrying this page's Origin as the room
// operator (`hasExtensionAuthority`), and the branch routes gate landing on nothing else — so an
// opaque-origin sandboxed frame could ask the bridge to `POST /api/branches/merge` and the bridge ran
// `git checkout` + `git merge` on the repository. The reviewer's repro got `{ok:true, status:200}`.
//
// WHAT THIS FILE DOES ABOUT IT. It drives the REAL bridge module (public/mini-app-bridge.js) inside a VM with a
// fake DOM, a fake MessageChannel pair and a fake host, and speaks to it the way the sandboxed frame does —
// over the transferred port. So the assertions are about what the module actually does with a request, not
// about how its source is shaped:
//
//   * a read on the approved table is relayed by the bridge, exactly once;
//   * the reviewer's landing request NEVER reaches `fetch` — the bridge posts `host_action_request` to the room
//     and the frame's promise resolves only from the room's answer;
//   * a room answer of Deny/timeout reaches the app as a named refusal, and the repo-touching request is never
//     sent;
//   * a read outside the table (`/api/keys`) and a mutation outside the table (`DELETE /api/file`,
//     `POST /api/extensions/approve`) are refused by name, with no fetch and no host prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { relayPolicy } from "../public/relay-policy.mjs";
import { relayTarget } from "../public/relay-target.mjs";
import { relayBody } from "../public/relay-body.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_FILE = readFileSync(path.join(root, "public", "mini-app-bridge.js"), "utf8");
const BRIDGE_SOURCE = BRIDGE_FILE
  // The three modules are supplied to the VM as the REAL functions, so this is the shipped mediator's logic.
  .replace(/^import .*$/gm, "");
const ORIGIN = "http://127.0.0.1:8787";

class FakePort {
  constructor() {
    this.onmessage = null;
    this.peer = null;
  }
  postMessage(msg) {
    // Asynchronous, as a real MessagePort is: the bridge never sees a message inside its own call stack.
    queueMicrotask(() => {
      try { this.peer?.onmessage?.({ data: msg }); } catch { /* the receiving side threw; nothing to do here */ }
    });
  }
  close() {}
}

function channel() {
  const a = new FakePort();
  const b = new FakePort();
  a.peer = b;
  b.peer = a;
  return { port1: a, port2: b };
}

/** Wait (bounded) for a predicate the async bridge will satisfy after a microtask or two. */
async function waitFor(label, predicate, ms = 500) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * Load the bridge the way /mini-app-bridge.html does, then complete both handshakes (the room's port and the
 * inner frame's port) so the test can speak as either side.
 */
function loadBridge() {
  const fetchCalls = [];
  const hostMessages = [];
  const frameMessages = [];
  let framePort = null;

  const innerWindow = {
    postMessage(msg, _origin, ports) {
      if (ports && ports[0]) framePort = ports[0];
    },
  };
  const inner = { contentWindow: innerWindow, srcdoc: "" };
  const roomWindow = {};
  const listeners = [];

  const window = {
    location: { origin: ORIGIN, search: "?appId=branch-landing-inspector" },
    parent: roomWindow,
    addEventListener(type, fn) { if (type === "message") listeners.push(fn); },
    URLSearchParams,
  };

  const context = vm.createContext({
    window,
    document: { getElementById: (id) => (id === "inner-app" ? inner : null) },
    MessageChannel: function MessageChannel() { return channel(); },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), method: String(options.method || "GET"), body: options.body });
      return {
        status: 200,
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ ok: true, from: "relay" }),
      };
    },
    URL,
    URLSearchParams,
    Response,
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    relayTarget,
    relayBody,
    relayPolicy,
  });
  vm.runInContext(BRIDGE_SOURCE, context, { filename: "public/mini-app-bridge.js" });

  const deliver = (event) => {
    for (const fn of [...listeners]) fn(event);
  };

  // The ROOM hands the bridge its port (same-origin, parent source — the checks the bridge really makes).
  // The bridge keeps port2, so port1 is the room's own end: what it posts is the room speaking.
  const roomChannel = channel();
  roomChannel.port1.onmessage = (event) => hostMessages.push(event.data);
  deliver({
    origin: ORIGIN,
    source: roomWindow,
    data: { type: "mini_app_port", appId: "branch-landing-inspector" },
    ports: [roomChannel.port2],
  });

  // The INNER FRAME announces itself, and the bridge transfers the app channel to it.
  deliver({ data: { type: "mini_app_ready" }, source: innerWindow });
  assert.ok(framePort, "the bridge did not hand the app its port");

  const frameInbox = [];
  const originalFrameHandler = framePort.onmessage;
  framePort.onmessage = (event) => {
    frameInbox.push(event.data);
    if (typeof originalFrameHandler === "function") originalFrameHandler(event);
  };

  return {
    fetchCalls,
    hostMessages,
    frameInbox,
    /** Speak as the sandboxed app: post a fetch_request over the transferred port. */
    askFrame(request) {
      framePort.postMessage({ type: "fetch_request", ...request });
    },
    /** Speak as the room: answer the host action the bridge asked about. */
    answerHostAction(answer) {
      roomChannel.port1.postMessage({ type: "host_action_result", ...answer });
    },
  };
}

const THE_REPRO = {
  callId: "untrusted",
  url: "/api/branches/merge",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ branch: "candidate" }),
};

test("the reviewer's repro never reaches fetch: the bridge asks the room instead", async () => {
  const bridge = loadBridge();
  bridge.askFrame(THE_REPRO);
  await waitFor("the host_action_request", () => bridge.hostMessages.some((m) => m.type === "host_action_request"));

  const asked = bridge.hostMessages.find((m) => m.type === "host_action_request");
  assert.equal(asked.callId, "untrusted");
  assert.equal(asked.route, "POST /api/branches/merge");
  assert.equal(asked.action, "land a candidate branch into the base branch");
  assert.equal(asked.body, JSON.stringify({ branch: "candidate" }));
  assert.equal(asked.appId, "branch-landing-inspector");
  assert.deepEqual(bridge.fetchCalls, [], "the bridge fetched a mutating route with the room's own authority");
  assert.deepEqual(bridge.frameInbox, [], "the frame was answered before a person answered");
  // Release the pending question so this file leaves no 120s host-action timer behind.
  bridge.answerHostAction({ callId: "untrusted", ok: false, error: "closed by the test" });
});

test("a denied host action reaches the app as a refusal, and nothing was sent", async () => {
  const bridge = loadBridge();
  bridge.askFrame(THE_REPRO);
  await waitFor("the host_action_request", () => bridge.hostMessages.length > 0);
  bridge.answerHostAction({ callId: "untrusted", ok: false, error: "the room's operator denied this action" });
  await waitFor("the refusal", () => bridge.frameInbox.length > 0);

  const reply = bridge.frameInbox[0];
  assert.equal(reply.type, "fetch_result");
  assert.equal(reply.ok, false);
  assert.match(reply.error, /denied/);
  assert.deepEqual(bridge.fetchCalls, [], "a denied action was sent anyway");
});

test("an approved host action returns the room's own status and bytes to the app", async () => {
  const bridge = loadBridge();
  bridge.askFrame(THE_REPRO);
  await waitFor("the host_action_request", () => bridge.hostMessages.length > 0);
  // The ROOM performs the fetch; the bridge only carries its answer back. This side never sees a fetch.
  bridge.answerHostAction({
    callId: "untrusted",
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify({ ok: true, headCommit: "abc123" }),
  });
  await waitFor("the answer", () => bridge.frameInbox.length > 0);

  const reply = bridge.frameInbox[0];
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 200);
  assert.match(reply.bodyText, /abc123/);
  assert.deepEqual(bridge.fetchCalls, [], "the bridge performed an approved action itself instead of the room");
});

test("an approved read is relayed by the bridge, against the request the app wrote", async () => {
  const bridge = loadBridge();
  bridge.askFrame({ callId: "read-1", url: "/api/branches/candidates", method: "GET" });
  await waitFor("the relayed read", () => bridge.frameInbox.length > 0);

  assert.equal(bridge.fetchCalls.length, 1);
  assert.equal(bridge.fetchCalls[0].url, `${ORIGIN}/api/branches/candidates`);
  assert.equal(bridge.fetchCalls[0].method, "GET");
  assert.deepEqual(bridge.hostMessages, [], "a read must not need a person");
  const reply = bridge.frameInbox[0];
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 200);
  assert.match(reply.bodyText, /"from":"relay"/);
});

test("reads outside the approved table are refused by name, with no fetch and no prompt", async () => {
  for (const url of ["/api/keys", "/api/file?name=README.md", "/api/agent-settings", "/api/root", "/api/grep?q=x"]) {
    const bridge = loadBridge();
    bridge.askFrame({ callId: "snoop", url, method: "GET" });
    await waitFor(`${url} refusal`, () => bridge.frameInbox.length > 0);
    const reply = bridge.frameInbox[0];
    assert.equal(reply.ok, false, `${url} was relayed`);
    assert.match(reply.error, /relay-read-not-approved/);
    assert.deepEqual(bridge.fetchCalls, [], `${url} reached fetch`);
    assert.deepEqual(bridge.hostMessages, [], `${url} raised a consent prompt`);
  }
});

test("mutations outside the approved action table are refused, not prompted", async () => {
  const hostile = [
    { url: "/api/file?name=README.md", method: "DELETE", body: "{}" },
    { url: "/api/extensions/approve", method: "POST", body: "{}" },
    { url: "/api/agent-settings", method: "PUT", body: "{}" },
    { url: "/api/root", method: "DELETE", body: "{}" },
  ];
  for (const request of hostile) {
    const bridge = loadBridge();
    bridge.askFrame({ callId: "hostile", ...request });
    await waitFor(`${request.method} ${request.url} refusal`, () => bridge.frameInbox.length > 0);
    const reply = bridge.frameInbox[0];
    assert.equal(reply.ok, false, `${request.method} ${request.url} was carried`);
    assert.match(reply.error, /relay-mutation-not-approved/);
    assert.deepEqual(bridge.fetchCalls, []);
    assert.deepEqual(bridge.hostMessages, [], `${request.method} ${request.url} raised a consent prompt it should not`);
  }
});

test("the policy tables are the one classification site, and they name their answers", () => {
  // read / host-action / refuse — the three outcomes the bridge and the room both branch on.
  assert.deepEqual(relayPolicy("GET", "/api/branches/candidates"), { ok: true, kind: "read" });
  assert.deepEqual(relayPolicy("head", "/api/health"), { ok: true, kind: "read" });
  const land = relayPolicy("POST", "/api/branches/merge");
  assert.equal(land.ok, true);
  assert.equal(land.kind, "host-action");
  assert.equal(land.route, "POST /api/branches/merge");
  assert.match(land.action, /land a candidate branch/);

  for (const [method, pathname, refused] of [
    ["GET", "/api/keys", "relay-read-not-approved"],
    ["GET", "/api/file", "relay-read-not-approved"],
    ["DELETE", "/api/file", "relay-mutation-not-approved"],
    ["POST", "/api/extensions/approve", "relay-mutation-not-approved"],
    ["POST", "http://example.invalid/api/branches/merge", "relay-bad-path"],
    ["POST", "/api/branches/merge\u0000", "relay-bad-path"],
    ["", "/api/health", "relay-no-method"],
  ]) {
    const verdict = relayPolicy(method, pathname);
    assert.equal(verdict.ok, false, `${method} ${pathname} was admitted`);
    assert.equal(verdict.refused, refused);
    assert.equal(typeof verdict.why, "string");
    assert.ok(verdict.why.length > 20, "a refusal must say why, not just that");
  }
});

test("the frame SDK embeds this same policy, so the two realms cannot drift", () => {
  assert.match(BRIDGE_FILE, /import \{ relayPolicy \} from "\.\/relay-policy\.mjs";/);
  assert.match(BRIDGE_FILE, /var relayPolicy = \(\$\{String\(relayPolicy\)\}\);/, "the injected SDK must be built from this function's own source");
});
