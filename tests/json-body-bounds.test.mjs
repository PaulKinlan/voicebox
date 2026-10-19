// tests/json-body-bounds.test.mjs — the JSON body door answers by name (voicebox-beads-d808).
//
//   node --test tests/json-body-bounds.test.mjs
//
// The defect: server.mjs's single readJson read with maxBytes = Infinity and any Content-Type.
// On the default posture (the loopback wall is opt-in) an unauthenticated POST could stream an
// unbounded body into the process's memory, and an oversized or non-JSON body silently resolved
// null — indistinguishable from "no body". The fix:
//
//   · an absent or non-JSON Content-Type is refused 415 before a byte is read, so a browser's
//     simple cross-origin POST cannot reach JSON mutations without a preflight;
//   · a body past the cap (1 MiB by default) is refused 413 BY NAME and the rest of the upload
//     is discarded unread;
//   · normal JSON callers are untouched, and the host survives both refusals.
//
// Driven against the real server as a subprocess; every assertion is an HTTP response. The target
// route is POST /api/exec: readJson runs before any route logic, so a refused body is answered
// before anything could execute — and a well-formed body only ever reaches the verb's own named
// refusal here, because an empty command is never run.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

let server;
let PORT;
let scratch;

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-bodybounds-"));
  server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "workspace") }, cwd: scratch });
  PORT = server.port;
});

test.after(async () => {
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A raw request so the body can be streamed in chunks and oversized. The server answers a refused
 * body with `connection: close` and drains the rest of the upload unread (it does NOT destroy the
 * socket — an early destroy RST-clobbers the answer), so a late write may still fail with EPIPE and
 * the response's 'end' may never fire: the request settles on the FIRST of (response fully read,
 * response stream closed, socket error once the response is COMPLETE), because each carries the
 * answer. An error with only headers in does NOT settle — the body may still be in flight.
 */
function postRaw({ route = "/api/exec", method = "POST", headers = {}, chunks = [] }) {
  return new Promise((resolve, reject) => {
    // Content-Length, always: Node's HTTP parser rejects a CHUNKED body on DELETE outright (bare
    // 400, connection close, no route — measured), so a raw DELETE without it never reaches the door.
    const bodyHeaders = { "content-length": chunks.reduce((n, c) => n + (typeof c === "string" ? Buffer.byteLength(c) : c.length), 0), ...headers };
    let settled = false;
    let seen = null; // the ServerResponse, once headers are in
    let text = "";
    const settle = () => {
      if (settled || !seen) return;
      settled = true;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* asserted by callers that need it */ }
      resolve({ status: seen.statusCode, text, body: parsed });
    };
    const req = http.request({ host: "127.0.0.1", port: PORT, path: route, method, headers: bodyHeaders }, (res) => {
      seen = res;
      res.on("data", (c) => (text += c));
      res.on("end", settle);
      res.on("close", settle);
    });
    req.on("error", (err) => {
      if (settled) return; // the answer is in; the teardown cut a late write
      // Headers alone are not the answer: only settle early if the response is complete;
      // otherwise the response stream's own 'close' settles with whatever arrived whole.
      if (seen?.complete) return settle();
      if (seen) return;
      reject(err);
    });
    for (const chunk of chunks) {
      try { req.write(chunk); } catch { /* the socket was torn down after the refusal */ }
    }
    try { req.end(); } catch { /* same */ }
  });
}

test("a normal JSON body still reaches the route", async () => {
  const res = await postRaw({
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify({ command: "" })],
  });
  // The door let it through; the verb itself refuses an empty command, by name — never 413/415.
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.ok(typeof res.body.refused === "string" && res.body.refused.length > 0, "a named refusal");
  assert.notEqual(res.body.refused, "body-too-large");
  assert.notEqual(res.body.refused, "unsupported-content-type");
});

test("a declared non-JSON Content-Type is refused 415 before parsing", async () => {
  const res = await postRaw({
    headers: { "content-type": "text/plain" },
    chunks: ['{"command":""}'],
  });
  assert.equal(res.status, 415);
  assert.ok(res.body, "the refusal body arrived whole");
  assert.equal(res.body.ok, false);
  assert.equal(res.body.refused, "unsupported-content-type");
  assert.match(res.body.why, /text\/plain/);
});

test("a declared but EMPTY media type is still a declared non-JSON type — 415", async () => {
  const res = await postRaw({
    headers: { "content-type": ";charset=utf-8" },
    chunks: ['{"command":""}'],
  });
  assert.equal(res.status, 415);
  assert.ok(res.body, "the refusal body arrived whole");
  assert.equal(res.body.refused, "unsupported-content-type");
});

test("a simple cross-site POST without Content-Type cannot mutate JSON routes", async () => {
  const label = "csrf-untyped-declaration";
  const hasLabel = async () => {
    const listed = await fetch(`http://127.0.0.1:${PORT}/api/environments`).then((r) => r.json());
    assert.equal(listed.ok, true);
    return listed.environments.some((env) => env.label === label);
  };
  assert.equal(await hasLabel(), false, "this isolated server has no such environment before the attempted write");
  const declaration = JSON.stringify({ label, kind: "server", origin: "http://127.0.0.1:1" });
  const browserHeaders = { origin: "https://attacker.example", "sec-fetch-site": "cross-site" };
  const refused = await postRaw({ route: "/api/environments", headers: browserHeaders, chunks: [declaration] });
  assert.equal(refused.status, 415, `an untyped cross-site JSON POST must not register an environment: ${refused.text}`);
  assert.equal(refused.body?.refused, "unsupported-content-type");
  assert.equal(await hasLabel(), false, "the untyped declaration never reached the registry");

  const turn = await postRaw({ route: "/api/turn", headers: browserHeaders, chunks: [JSON.stringify({ action: { verb: "write", name: "csrf.txt", content: "unwanted" } })] });
  assert.equal(turn.status, 415, `an untyped cross-site turn must not reach the executor: ${turn.text}`);
  assert.equal(turn.body?.refused, "unsupported-content-type");

  const typed = await postRaw({ route: "/api/environments", headers: { "content-type": "application/json" }, chunks: [declaration] });
  assert.equal(typed.status, 200, `a declared JSON caller still reaches the route: ${typed.text}`);
  assert.equal(typed.body?.ok, true);
  assert.equal(await hasLabel(), true, "the typed control really registered the environment");
});

test("an oversized body is refused 413 by name, and the rest is discarded unread", async () => {
  const chunk = Buffer.alloc(64 * 1024, "a");
  const chunks = Array.from({ length: 20 }, () => chunk); // 1.25 MiB, past the 1 MiB cap
  const res = await postRaw({
    headers: { "content-type": "application/json" },
    chunks,
  });
  assert.equal(res.status, 413);
  assert.ok(res.body, "the refusal body arrived whole");
  assert.equal(res.body.ok, false);
  assert.equal(res.body.refused, "body-too-large");
});

test("the route never runs on a refused body (no side effect)", async () => {
  // POST /api/environments WRITES to the registry when the body is accepted — so a refused body
  // must leave the registry untouched. Drive it with an oversized but otherwise valid declaration.
  const before = await fetch(`http://127.0.0.1:${PORT}/api/environments`).then((r) => r.json());
  const descriptor = JSON.stringify({ label: "never-registered", kind: "server", origin: "http://127.0.0.1:1", pad: "x".repeat(2 * 1024 * 1024) });
  const res = await postRaw({
    route: "/api/environments",
    headers: { "content-type": "application/json" },
    chunks: [descriptor],
  });
  assert.equal(res.status, 413);
  assert.ok(res.body, "the refusal body arrived whole");
  assert.equal(res.body.refused, "body-too-large");
  const after = await fetch(`http://127.0.0.1:${PORT}/api/environments`).then((r) => r.json());
  assert.deepEqual(
    (after.environments ?? []).map((e) => e.label),
    (before.environments ?? []).map((e) => e.label),
    "the refused declaration was never registered — the route never ran",
  );
});

test("a content route accepts a body past the 1 MiB default (8 MiB content cap)", async () => {
  // POST /api/mini-apps carries the app's html — content. A ~2 MiB app must PASS the door and be
  // saved: a positive proof (200 + the app reads back), not just the absence of a 413.
  const res = await postRaw({
    route: "/api/mini-apps",
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify({ appId: "big-app", html: "<!--" + "y".repeat(2 * 1024 * 1024) + "-->" })],
  });
  assert.ok(res.body, "the answer body arrived whole");
  assert.equal(res.status, 200, `a 2 MiB mini-app saves through the content cap, got ${res.status}: ${res.text.slice(0, 200)}`);
  assert.equal(res.body.ok, true);
  const readBack = await fetch(`http://127.0.0.1:${PORT}/api/mini-apps?id=big-app`).then((r) => r.json());
  assert.ok(readBack.ok && (readBack.miniApp?.html?.length ?? readBack.app?.html?.length ?? 0) > 2 * 1024 * 1024,
    "the saved app reads back with its full 2 MiB html — the door passed the whole body");
});

test("a refused body at a .catch-rethrow call site answers 413 exactly once", async () => {
  // DELETE /api/mini-apps is one of the three `readJson().catch(err => ...)` callers: a swallowed
  // BodyRefusal there would run the route on a refused body and answer TWICE. The one answer must
  // be the door's 413.
  const res = await postRaw({
    route: "/api/mini-apps",
    method: "DELETE",
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify({ appId: "big-app", pad: "z".repeat(2 * 1024 * 1024) })],
  });
  assert.equal(res.status, 413);
  assert.ok(res.body, "the refusal body arrived whole");
  assert.equal(res.body.refused, "body-too-large");
  // And the app saved by the previous test is untouched — the delete route never ran.
  const stillThere = await fetch(`http://127.0.0.1:${PORT}/api/mini-apps?id=big-app`).then((r) => r.json());
  assert.ok(stillThere.ok, "the refused DELETE did not run");
});

test("a bodyless mini-app DELETE declares JSON: untyped refusal cannot erase the app", async () => {
  const id = "csrf-delete-control";
  const saved = await postRaw({
    route: "/api/mini-apps", headers: { "content-type": "application/json" },
    chunks: [JSON.stringify({ appId: id, html: "<p>keep until a typed delete</p>" })],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body?.ok, true);

  const route = `/api/mini-apps?id=${id}`;
  const untyped = await postRaw({ route, method: "DELETE" });
  assert.equal(untyped.status, 415, "an untyped, bodyless DELETE does not bypass the shared JSON door");
  assert.equal(untyped.body?.refused, "unsupported-content-type");
  const stillThere = await fetch(`http://127.0.0.1:${PORT}${route}`).then((r) => r.json());
  assert.equal(stillThere.ok, true, "the refused delete did not remove the app");

  const typed = await postRaw({ route, method: "DELETE", headers: { "content-type": "application/json" } });
  assert.equal(typed.status, 200, "a header-only JSON declaration preserves bodyless deletion by query id");
  assert.equal(typed.body?.ok, true);
  const gone = await fetch(`http://127.0.0.1:${PORT}${route}`).then((r) => r.json());
  assert.equal(gone.ok, false, "the declared caller really deleted the app");
});

test("an absent Content-Type is refused even with an empty body", async () => {
  const res = await postRaw({ headers: {}, chunks: [] });
  assert.equal(res.status, 415);
  assert.ok(res.body, "the answer body arrived whole");
  assert.equal(res.body.refused, "unsupported-content-type");
});

test("the host survives both refusals and keeps serving", async () => {
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
  assert.equal(health.status, 200);
  // And a normal caller still works after the refusals above.
  const res = await postRaw({
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify({ command: "" })],
  });
  assert.equal(res.status, 400);
  assert.ok(res.body, "the answer body arrived whole");
});
