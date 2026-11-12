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
function loadBridge({ consentMs = null, fetchMs = null } = {}) {
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
  // The reviewer's repro accelerated the module's own bounds rather than waiting 120s; the bounds are the two
  // numbers this file pins, and patching them here keeps every assertion about the SHIPPED logic
  // (voicebox-beads-a96w).
  const source = BRIDGE_SOURCE
    .replace(/hostActionConsentMs: \d+/, `hostActionConsentMs: ${consentMs ?? 180000}`)
    .replace(/hostActionFetchMs: \d+/, `hostActionFetchMs: ${fetchMs ?? 180000}`);
  vm.runInContext(source, context, { filename: "public/mini-app-bridge.js" });

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
    /** Speak as the room: report that the request has been DISPATCHED (voicebox-beads-a96w). */
    hostActionState({ callId, state }) {
      roomChannel.port1.postMessage({ type: "host_action_state", callId, state });
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

// ── THE TWO WAITS (voicebox-beads-a96w) ───────────────────────────────────────────────────────────────
//
// The reviewer's repro: accelerate the single 120s clock to 40ms, have the operator Allow at 30ms and the room
// answer 25ms after that — the app was told "the room did not answer this host action in time; nothing was sent"
// while the room had actually performed the mutation. One clock covered the wait for a person AND the room's own
// fetch, so the truth changed underneath it. These three cases pin the three states a wait can end in.

test("an approval answered after the consent clock would have expired still reaches the app (reviewer's repro, a96w)", async () => {
  // Wide apart on purpose: consent retires almost immediately, the room's answer is deliberately much later.
  const bridge = loadBridge({ consentMs: 20, fetchMs: 400 });
  bridge.askFrame(THE_REPRO);
  await waitFor("the host_action_request", () => bridge.hostMessages.length > 0);
  // The operator approves and the room DISPATCHES — this is the message the old code had no way to send.
  bridge.hostActionState({ callId: "untrusted", state: "executing" });
  await new Promise((resolve) => setTimeout(resolve, 60)); // well past the consent clock
  bridge.answerHostAction({
    callId: "untrusted",
    ok: true,
    status: 200,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify({ ok: true, landed: true }),
  });
  await waitFor("the answer", () => bridge.frameInbox.length > 0);

  const reply = bridge.frameInbox[0];
  assert.equal(reply.ok, true, `the room's own answer was lost: ${JSON.stringify(reply)}`);
  assert.equal(reply.status, 200);
  assert.match(reply.bodyText, /landed/);
  assert.doesNotMatch(String(reply.error ?? ""), /nothing was sent/);
});

test("a room that dispatched and then went silent says INDETERMINATE, never 'nothing was sent' (a96w)", async () => {
  const bridge = loadBridge({ consentMs: 1000, fetchMs: 30 });
  bridge.askFrame(THE_REPRO);
  await waitFor("the host_action_request", () => bridge.hostMessages.length > 0);
  bridge.hostActionState({ callId: "untrusted", state: "executing" });
  await waitFor("the indeterminate answer", () => bridge.frameInbox.length > 0, 1000);

  const reply = bridge.frameInbox[0];
  assert.equal(reply.ok, false);
  assert.equal(reply.indeterminate, true, "a dispatched request whose answer never arrived must be indeterminate");
  assert.equal(reply.refused, "host-action-unanswered");
  assert.match(reply.error, /may have been applied/);
  assert.doesNotMatch(reply.error, /nothing was sent/, "the app was told a dispatched request was never sent");
});

test("nobody answering the room's prompt says nothing was sent, and stays a refusal (a96w)", async () => {
  const bridge = loadBridge({ consentMs: 30, fetchMs: 10_000 });
  bridge.askFrame(THE_REPRO);
  await waitFor("the refusal", () => bridge.frameInbox.length > 0, 1000);

  const reply = bridge.frameInbox[0];
  assert.equal(reply.ok, false);
  assert.equal(reply.refused, "host-action-no-operator");
  assert.match(reply.error, /nothing was sent/);
  assert.notEqual(reply.indeterminate, true, "an unanswered prompt sent nothing, so it cannot be indeterminate");
  assert.deepEqual(bridge.fetchCalls, [], "the bridge sent the request while waiting for a person");
});

test("the room reports the dispatch BEFORE it fetches, so a slow fetch cannot masquerade as 'nothing was sent' (a96w)", () => {
  // The bridge's honest two-phase clock is only honest if the room tells it when the request goes out. Nothing
  // in this file can drive a 120s browser fetch, so the ordering itself is pinned here: an `executing` message
  // that arrived after the fetch — or a fetch with no bound — would restore exactly the defect.
  const room = readFileSync(path.join(root, "public", "components", "mini-app-surface.mjs"), "utf8");
  const dispatch = room.indexOf('type: "host_action_state", callId, state: "executing"');
  const fetchAt = room.indexOf("response = await fetch(path, {");
  assert.ok(dispatch > 0, "the room never reports that it dispatched the request");
  assert.ok(fetchAt > 0, "the room's host-action fetch moved; this pin needs re-reading");
  assert.ok(dispatch < fetchAt, "the dispatch report must precede the fetch, or a timeout during the fetch still lies");
  // And a dispatched request must be BOUNDED (an abandoned request is an indeterminate outcome, not a clean no).
  assert.match(room, /HOST_ACTION_FETCH_MS = \d+/, "the room's own request has no bound");
  assert.match(room.slice(fetchAt), /signal: abort\.signal/, "the room's fetch cannot be abandoned");
  const catchPath = room.slice(room.indexOf("} catch (err) {", fetchAt));
  assert.match(catchPath.slice(0, 800), /indeterminate: true/, "a dispatched request that fails must be reported as indeterminate");
});

test("the relay OUTWAITS the room's own prompt, and cancels it rather than leaving a live Allow behind (a96w round 2)", () => {
  // Round 2 of the finding: two independent consent windows. The room renders its bar a round trip AFTER the bridge
  // starts waiting, so equal windows meant the bridge could give up first — "nothing was sent" — while the room's
  // Allow was still clickable, and a click then performed the mutation behind a lie. Two properties close it, and
  // both are pinned numerically here because a 120s browser wait cannot be driven:
  const bridgeSource = readFileSync(path.join(root, "public", "mini-app-bridge.js"), "utf8");
  const roomSource = readFileSync(path.join(root, "public", "components", "mini-app-surface.mjs"), "utf8");
  const bridgeConsent = Number(/hostActionConsentMs: (\d+)/.exec(bridgeSource)?.[1]);
  const roomConsent = Number(/HOST_ACTION_CONSENT_MS = (\d+)/.exec(roomSource)?.[1]);
  assert.ok(Number.isFinite(bridgeConsent) && Number.isFinite(roomConsent), "both consent windows must be named constants");
  assert.ok(
    bridgeConsent > roomConsent,
    `the relay must outwait the room (${bridgeConsent}ms vs ${roomConsent}ms), or it can give up while the bar is live`,
  );
  assert.match(roomSource, /data\.type === "host_action_cancel"/, "the room must handle the relay giving up");
  assert.match(
    roomSource.slice(roomSource.indexOf('data.type === "host_action_cancel"')),
    /pendingHostAction\.finish\(/,
    "a cancelled host action must drop the bar, not leave it clickable",
  );
});

test("giving up on the prompt CANCELS the room before the app is told nothing was sent (a96w round 2)", async () => {
  const bridge = loadBridge({ consentMs: 30, fetchMs: 10_000 });
  bridge.askFrame(THE_REPRO);
  await waitFor("the refusal", () => bridge.frameInbox.length > 0, 1000);
  const inbox = bridge.hostMessages.map((m) => m.type);
  assert.ok(inbox.includes("host_action_cancel"), `the room was left with a live prompt: ${JSON.stringify(inbox)}`);
  const cancel = bridge.hostMessages.find((m) => m.type === "host_action_cancel");
  assert.equal(cancel.callId, "untrusted");
  const reply = bridge.frameInbox[0];
  assert.equal(reply.refused, "host-action-no-operator");
  assert.match(reply.error, /nothing was sent/);
});

test("the room answers the channel a host action ARRIVED on, bounds the body read, and keeps the tool waiting while it runs", () => {
  // Three review findings on the landing PR, pinned the way the dispatch ordering above is pinned (a browser
  // remount racing a 120s fetch cannot be driven here):
  const room = readFileSync(path.join(root, "public", "components", "mini-app-surface.mjs"), "utf8");
  const answer = room.slice(room.indexOf("async function answerHostAction("), room.indexOf("function callTool("));
  // 1. Every bridge numbers its calls from 1, so a late result sent to "whichever app is mounted now" is taken by
  //    the NEW app as the answer to its own call. The channel is captured on arrival and nothing else is used.
  assert.match(room, /port1\.onmessage = \(event\) => handleBridgeEvent\(event\.data, channel\)/, "each channel must hand over itself with its messages");
  assert.match(room, /void answerHostAction\(data, channel\)/);
  assert.doesNotMatch(answer, /currentChannel\./, "a host action must never be answered through the currently mounted app's channel");
  assert.doesNotMatch(room.slice(room.indexOf("function replyToApp("), room.indexOf("async function answerHostAction(")).split("const HOST_ACTION_FETCH_MS")[0], /currentChannel/);
  // 2. fetch() settles on headers: the body read sits inside the same try, before the deadline is cleared.
  const fetchAt = answer.indexOf("response = await fetch(path, {");
  const bodyAt = answer.indexOf("bodyText = await response.text();");
  const catchAt = answer.indexOf("} catch (err) {", fetchAt);
  const clearAt = answer.indexOf("clearTimeout(deadline);", fetchAt);
  assert.ok(fetchAt > 0 && bodyAt > fetchAt && bodyAt < catchAt && catchAt < clearAt, "the body must be read under the request's deadline and its indeterminate catch");
  assert.doesNotMatch(answer, /\.text\(\)\.catch\(/, "a body that failed to arrive must not become an empty success");
  // 3. An approved action in flight holds the room's tool budget open, exactly as an unanswered prompt does.
  assert.match(room, /if \(pendingHostAction \|\| executingHostActions > 0\) \{\s*entry\.timer = armCallTimer\(\);/);
  assert.ok(answer.indexOf("executingHostActions += 1;") < fetchAt && answer.indexOf("executingHostActions -= 1;") > catchAt, "the in-flight count must bracket the request");
});
