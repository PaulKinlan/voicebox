// tests/json-body-bounds.test.mjs — the JSON body door answers by name (voicebox-beads-d808).
//
//   node --test tests/json-body-bounds.test.mjs
//
// The defect: server.mjs's single readJson read with maxBytes = Infinity and any Content-Type.
// On the default posture (the loopback wall is opt-in) an unauthenticated POST could stream an
// unbounded body into the process's memory, and an oversized or non-JSON body silently resolved
// null — indistinguishable from "no body". The fix:
//
//   · a DECLARED Content-Type that is not JSON is refused 415 before a byte is read;
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
 * A raw POST so the body can be streamed in chunks and oversized. The server cuts an oversized
 * upload by destroying the socket once the 413 has flushed, so a late write fails with EPIPE and
 * the response's 'end' may never fire — the request settles on the FIRST of (response fully read,
 * socket error after the response headers arrived), because both carry the answer.
 */
function postRaw({ route = "/api/exec", headers = {}, chunks = [] }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let seen = null; // the ServerResponse, once headers are in
    let text = "";
    const settle = () => {
      if (settled || !seen) return;
      settled = true;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* asserted by callers that need it */ }
      resolve({ status: seen.statusCode, text, body: parsed });
    };    const req = http.request({ host: "127.0.0.1", port: PORT, path: route, method: "POST", headers }, (res) => {
      seen = res;
      res.on("data", (c) => (text += c));
      res.on("end", settle);
      res.on("close", settle);
    });
    req.on("error", (err) => {
      if (settled) return; // the answer is in; the teardown cut a late write
      if (seen) return settle(); // headers arrived before the cut — the status IS the answer
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
  // POST /api/mini-apps carries the app's html — content. A ~2 MiB app must NOT meet the default
  // cap: any answer that is not 413 proves the door passed it (validation may still 400 it).
  const res = await postRaw({
    route: "/api/mini-apps",
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify({ appId: "big-app", html: "<!--" + "y".repeat(2 * 1024 * 1024) + "-->" })],
  });
  assert.ok(res.body, "the answer body arrived whole");
  assert.notEqual(res.status, 413, "a content route does not answer 413 at 2 MiB");
  assert.notEqual(res.body?.refused, "body-too-large");
});

test("an absent Content-Type with an empty body is still allowed (parses as {})", async () => {
  const res = await postRaw({ headers: {}, chunks: [] });
  assert.equal(res.status, 400);
  assert.ok(res.body, "the answer body arrived whole");
  assert.equal(res.body.ok, false);
  assert.notEqual(res.body.refused, "unsupported-content-type");
  assert.notEqual(res.body.refused, "body-too-large");
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
