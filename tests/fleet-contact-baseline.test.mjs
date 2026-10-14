// tests/fleet-contact-baseline.test.mjs — a byte-level baseline for the HOST-OWNED
// POST /api/fleet/contact adapter (voicebox-beads-r9hv.6).
//
// WHY THIS EXISTS: the hub ruled (voicebox-beads-r9hv.3) that POST /api/fleet/contact stays in
// server.mjs. This test is the safety net a future security-reviewed extraction would have to
// keep green: it drives a REAL forward, against a local stub standing in for the remote
// environment, and pins the exact bytes that leave the host. The only network here is
// 127.0.0.1, and nothing in this file writes a bearer or token value to a log or an assertion
// message: secrets are compared in-process with boolean assertions, so a failure prints the
// field name and lengths, never the bytes.
//
// MEASURED WHILE WRITING IT, and pinned below rather than assumed: the route mints a per-call
// audit token (server.mjs:3794, also :3251 for the turn tool) and hands it to
// fleetManager.contact({ authority }), but the remote transport forwards only TWO headers —
// the bearer and content-type. lib/fleet.mjs consumes `authority` on the LOCAL paths only
// (:243 session handler, :271 task host), so on the remote path the minted token is minted and
// dropped: it is not on the wire, and it cannot be pinned byte-for-byte from outside. So the
// remote-path pin is "these two headers and nothing else", and the mint's own expression stays
// the single owner's job in tests/fleet-get-route-seam.test.mjs:27 rather than being duplicated
// here. The caller's own headers are also NOT forwarded: the host builds the outbound set.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

const CALLER_BEARER = "caller_bearer_do_not_log_1";
const PAIRED_BEARER = "paired_bearer_do_not_log_2";

// Compare secret bytes without printing them: a boolean assertion prints only this message.
function sameBytes(actual, expected, what) {
  assert.ok(
    actual === expected,
    `${what} does not match (expected ${expected?.length ?? 0} bytes, got ${actual?.length ?? 0}; values withheld on purpose)`,
  );
}

/** A local stand-in for a remote environment: records every forward, answers with a scripted reply. */
async function startStub() {
  const requests = [];
  const replies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const reply = replies.shift() ?? { status: 200, type: "application/json", body: '{"ok":true}' };
      res.writeHead(reply.status, { "content-type": reply.type });
      res.end(reply.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    reply: (r) => replies.push(r),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let scratch;
let workspace;
let server;
let base;
let stub;      // env_stub   — the target under test
let other;     // env_other  — a second origin, so "did it reach the RIGHT host" is observable
const saved = {};

test.before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-fleet-contact-pin-"));
  workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });
  stub = await startStub();
  other = await startStub();
  server = await startServer({
    env: { VOICEBOX_WORKSPACE: workspace, VOICEBOX_RESOLVER: "script", VOICEBOX_HARNESS: "pi" },
  });
  base = server.base;
  fs.writeFileSync(
    path.join(workspace, "environments.json"),
    JSON.stringify({
      environments: [
        { key: "env_stub", label: "Stub Host", kind: "server", origin: stub.origin },
        { key: "env_other", label: "Other Host", kind: "server", origin: other.origin },
      ],
    }) + "\n",
  );
  fs.writeFileSync(
    path.join(server.extensionsDir, ".pairings.json"),
    JSON.stringify({
      env_stub: { callBearer: PAIRED_BEARER, issuedAt: new Date().toISOString() },
      env_other: { callBearer: PAIRED_BEARER, issuedAt: new Date().toISOString() },
    }) + "\n",
  );
});

test.after(async () => {
  await server?.stop();
  await stub?.close();
  await other?.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

const post = (body, headers = {}) =>
  fetch(`${base}/api/fleet/contact`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("the forward carries the caller's bearer, the built body, and nothing else", async () => {
  stub.requests.length = 0;   // the stub is shared across the tests in this file; each starts clean
  // CONTROL first: the same forward without any caller-supplied headers. Comparing against it is
  // how this test pins "the caller's headers do not ride along" without hardcoding the transport's
  // own header names (undici adds accept, accept-*, connection, content-length, host, user-agent,
  // sec-fetch-mode — pinning those exactly would go red on a Node upgrade for no good reason).
  stub.reply({ status: 200, type: "application/json", body: '{"ok":true}' });
  await post({ target: "env_stub/agent_x", message: "control" }, { authorization: `Bearer ${CALLER_BEARER}` });
  assert.equal(stub.requests.length, 1, "the control request must produce one forward");
  const controlHeaders = Object.keys(stub.requests[0].headers).sort();

  stub.reply({ status: 200, type: "application/json", body: JSON.stringify({ ok: true, targetKey: "env_stub/agent_x", reply: "hello" }) });
  const res = await post(
    { target: "env_stub/agent_x", message: "please look at this", sessionId: "sess-1" },
    {
      authorization: `Bearer ${CALLER_BEARER}`,
      // Caller-supplied headers must NOT ride along: the host builds the outbound set itself.
      "x-voicebox-authority": "attacker-supplied",
      "x-forwarded-for": "203.0.113.7",
      cookie: "session=secret-cookie-value",
    },
  );
  assert.equal(res.status, 200, "a remote ok reply maps to 200");
  const echoed = await res.json();
  assert.equal(echoed.ok, true, "the remote payload passes through unchanged");
  assert.equal(echoed.reply, "hello", "the remote reply reaches the caller");

  assert.equal(stub.requests.length, 2, "exactly one forward reached the target");
  const sent = stub.requests[1];
  assert.equal(sent.method, "POST", "the forward is a POST");
  assert.equal(sent.url, "/api/fleet/contact", "the forward keeps the contact path");
  sameBytes(sent.headers.authorization, `Bearer ${CALLER_BEARER}`, "the forwarded authorization header");
  assert.equal(sent.headers["content-type"], "application/json", "the forward declares JSON");
  assert.deepEqual(
    Object.keys(sent.headers).sort(),
    controlHeaders,
    "the caller's own headers must not change the outbound header set at all: the host builds it",
  );
  for (const smuggled of ["x-voicebox-authority", "x-forwarded-for", "cookie"]) {
    assert.ok(!(smuggled in sent.headers), `the caller-supplied '${smuggled}' must not be forwarded`);
  }
  assert.ok(
    !Object.keys(sent.headers).some((h) => /authority|token/i.test(h)),
    "no authority/token header rides along: the per-call minted audit token is NOT forwarded on this path (lib/fleet.mjs consumes it on the local session/delegate paths only)",
  );
  sameBytes(
    sent.body,
    JSON.stringify({ target: "env_stub/agent_x", message: "please look at this", sessionId: "sess-1" }),
    "the forwarded body",
  );
});

test("with no caller bearer the PAIRED bearer is used, and a malformed body never reaches the target", async () => {
  stub.requests.length = 0;
  stub.reply({ status: 200, type: "application/json", body: '{"ok":true}' });
  const res = await post({ target: "env_stub/agent_x", message: "no caller bearer" });
  assert.equal(res.status, 200, "a paired environment answers without a caller bearer");
  assert.equal(stub.requests.length, 1, "one forward");
  sameBytes(stub.requests[0].headers.authorization, `Bearer ${PAIRED_BEARER}`, "the paired bearer used for the forward");

  // A body that is not a JSON object is refused before any forward happens.
  const bad = await post("{not json");
  assert.equal(bad.status, 400, "a malformed body is a 400");
  assert.equal((await bad.json()).refused, "bad-request", "refused by name");
  assert.equal(stub.requests.length, 1, "the malformed body caused no forward at all");

  // An unknown environment is refused by the resolver, also without a forward.
  const unknown = await post({ target: "env_nope/agent_x", message: "hello" });
  assert.equal(unknown.status, 400, "an unknown environment is a 400");
  assert.equal((await unknown.json()).refused, "environment-unknown", "refused by name");
  assert.equal(stub.requests.length, 1, "no forward for an unknown environment");
});

test("the remote's refusal name decides the status, and the forward reaches the named host", async () => {
  stub.requests.length = 0;
  other.requests.length = 0;
  const cases = [
    ["cross-environment-unauthorized", 403],
    ["environment-not-paired", 403],
    ["agent-not-found", 400],
    ["session-not-found", 400],
  ];
  for (const [refused, status] of cases) {
    stub.reply({ status: 200, type: "application/json", body: JSON.stringify({ ok: false, refused }) });
    const before = stub.requests.length;
    const res = await post({ target: "env_stub/agent_x", message: "ping" });
    assert.equal(res.status, status, `a remote '${refused}' must map to ${status}`);
    assert.equal((await res.json()).refused, refused, "the remote's refusal name is passed through");
    assert.equal(stub.requests.length, before + 1, "the refusal came from the target, so there was a forward");
  }

  // A target that answers with something other than JSON is unreachable, not broken JSON.
  stub.reply({ status: 200, type: "text/html", body: "<html>not json</html>" });
  const notJson = await post({ target: "env_stub/agent_x", message: "ping" });
  assert.equal(notJson.status, 400, "a non-JSON reply is a 400");
  assert.equal((await notJson.json()).refused, "environment-unreachable", "and it is named as unreachable");

  // Target identity: a different key must go to THAT host, with that key in the body.
  other.reply({ status: 200, type: "application/json", body: '{"ok":true}' });
  const otherBefore = other.requests.length;
  const stubBefore = stub.requests.length;
  const res = await post({ target: "env_other/agent_y", message: "to the other host" });
  assert.equal(res.status, 200, "the other host answers");
  assert.equal(other.requests.length, otherBefore + 1, "the forward went to the environment named in the target");
  assert.equal(stub.requests.length, stubBefore, "and NOT to the other environment's origin");
  sameBytes(
    other.requests[otherBefore].body,
    JSON.stringify({ target: "env_other/agent_y", message: "to the other host" }),
    "the forwarded body of the second target",
  );
  sameBytes(other.requests[otherBefore].headers.authorization, `Bearer ${PAIRED_BEARER}`, "the second target's bearer");
});
