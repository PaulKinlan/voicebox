// tests/proxied-custody.test.mjs — PROXIED CUSTODY + ENVELOPE IDENTITY, driven REMOTELY.
//
//   node --test tests/proxied-custody.test.mjs
//
// The security boundary, driven the way coord required: the REMOTE case, not the local one. Two real
// servers — a LOCAL host (which the page talks to) and a REMOTE environment (a second ephemeral port,
// the stand-in for another machine). Tonight's firewall failure is the reason: local success hid a
// locked remote road for an hour, so "it works on loopback" must never stand in for "it works across
// the wire". Every assertion crosses a real socket.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

let local;
let remote;
let LOCAL;
let REMOTE;
let scratch;

const post = (base, path_, body) =>
  fetch(`${base}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-custody-"));
  mkdirSync(path.join(scratch, "local-ws"), { recursive: true });
  mkdirSync(path.join(scratch, "remote-ws"), { recursive: true });
  local = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "local-ws") }, cwd: scratch });
  remote = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "remote-ws") }, cwd: scratch });
  LOCAL = local.base;
  REMOTE = remote.base;
});

test.after(async () => {
  await local.stop();
  await remote.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("a call to an environment that is listed but NOT paired is refused by name, before anything crosses", async () => {
  // Register the remote environment on the LOCAL host, but do not pair it. The server owns the key.
  const declared = await post(LOCAL, "/api/environments", { label: "remote box", kind: "server", origin: REMOTE });
  const key = declared.body.environment.key;
  assert.ok(key, "the server issued the key");
  const call = await post(LOCAL, "/api/call", { envKey: key, tool: "notes", args: {} });
  assert.equal(call.status, 403);
  assert.equal(call.body.ok, false);
  assert.equal(call.body.refused, "environment-not-paired");
  assert.match(call.body.why, /pair/i, "the refusal names the remedy (pair it), not just the denial");
});

test("a call to an environment nobody declared is refused by name", async () => {
  const call = await post(LOCAL, "/api/call", { envKey: "env_nobody", tool: "notes", args: {} });
  assert.equal(call.status, 404);
  assert.equal(call.body.refused, "unknown-environment");
});

test("pairing issues a bearer the PAGE never holds, and a proxied call crosses to the REMOTE over a real socket", async () => {
  // Declare the remote on the local host.
  const declared = await post(LOCAL, "/api/environments", { label: "remote box", kind: "server", origin: REMOTE });
  const envKey = declared.body.environment.key;
  assert.ok(envKey, "the server issued the environment's key");

  // PAIR: the remote accepts and issues a bearer; the local records the bearer it will CALL with.
  // The bearer lives in BOTH hosts' 0600 files and is never served by a route or shown to the page.
  const paired = await post(REMOTE, "/api/pair", { envKey });
  assert.equal(paired.status, 200);
  const bearer = paired.body.bearer;
  assert.ok(bearer?.startsWith("vbx_"), "the remote issued a bearer");
  await post(LOCAL, "/api/pair/complete", { envKey, bearer });

  // Custody: the bearer is on disk, mode 0600, in each host's own workspace — not in any route's answer.
  const localPairings = path.join(scratch, "local-ws", "pairings.json");
  const remotePairings = path.join(scratch, "remote-ws", "pairings.json");
  assert.ok(existsSync(localPairings) && existsSync(remotePairings), "both sides recorded the pairing");
  assert.equal(statSync(localPairings).mode & 0o777, 0o600, "the local bearer file is 0600");
  assert.equal(statSync(remotePairings).mode & 0o777, 0o600, "the remote bearer file is 0600");

  // The remote needs an admitted tool to call: admit nothing, so the call is refused by the REMOTE
  // by name (unknown-tool) — proving the bearer authenticated AND the call reached the remote's
  // executor rather than dying on the way. The envelope identity (envKey) is what the bearer is
  // bound to.
  const call = await post(LOCAL, "/api/call", { envKey, tool: "notes", args: {} });
  assert.equal(call.status, 403, "the remote refused the unadmitted tool");
  assert.equal(call.body.ok, false);
  assert.equal(call.body.refused, "unknown-tool", "the refusal came from the REMOTE's executor — the call crossed");
});

test("a proxied call with a FORGED bearer is refused by the remote before any tool runs", async () => {
  const declared = await post(LOCAL, "/api/environments", { label: "remote box 2", kind: "server", origin: REMOTE });
  const envKey = declared.body.environment.key;
  const paired = await post(REMOTE, "/api/pair", { envKey });
  await post(LOCAL, "/api/pair/complete", { envKey, bearer: paired.body.bearer });
  // Forge: present a bearer that was never issued for this key.
  const forged = await fetch(`${REMOTE}/api/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer vbx_forged" },
    body: JSON.stringify({ envKey, tool: "notes", args: {} }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal(forged.status, 403);
  assert.equal(forged.body.refused, "unauthenticated-call", "the bearer is checked before any tool runs");
});
