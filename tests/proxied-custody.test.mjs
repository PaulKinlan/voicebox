// tests/proxied-custody.test.mjs — PROXIED CUSTODY + ENVELOPE IDENTITY, driven REMOTELY.
//
//   node --test tests/proxied-custody.test.mjs
//
// The security boundary, driven the way coord required: the REMOTE case, not the local one — two
// real servers on two ephemeral ports stand in for the two machines, because local success is what
// hid the firewall failure all evening. The findings from the first review are re-driven AS THEY
// WERE FOUND: the store is outside every root (a page turn asking to read it returns nothing), and
// pairing is gated (two token-less fetches cannot self-pair).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

let local;
let remote;
let LOCAL;
let REMOTE;
let scratch;
let localExt;
let remoteExt;

const post = (base, path_, body, headers = {}) =>
  fetch(`${base}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const hostToken = (extDir) => readFileSync(path.join(extDir, ".host-token"), "utf8").trim();

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-custody-"));
  localExt = path.join(scratch, "local-ext");
  remoteExt = path.join(scratch, "remote-ext");
  mkdirSync(path.join(scratch, "local-ws"), { recursive: true });
  mkdirSync(path.join(scratch, "remote-ws"), { recursive: true });
  mkdirSync(localExt, { recursive: true });
  mkdirSync(remoteExt, { recursive: true });
  local = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "local-ws"), VOICEBOX_EXTENSIONS_DIR: localExt }, cwd: scratch });
  remote = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "remote-ws"), VOICEBOX_EXTENSIONS_DIR: remoteExt }, cwd: scratch });
  LOCAL = local.base;
  REMOTE = remote.base;
});

test.after(async () => {
  await local.stop();
  await remote.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("pairing is GATED: two token-less fetches cannot self-pair (the m2i shape)", async () => {
  const declared = await post(LOCAL, "/api/environments", { label: "remote box", kind: "server", origin: REMOTE });
  const envKey = declared.body.environment.key;
  // No host token on either side — both acts create/register a credential, so both refuse.
  const issue = await post(REMOTE, "/api/pair", { envKey });
  assert.equal(issue.status, 403);
  assert.equal(issue.body.refused, "host-token-required");
  const complete = await post(LOCAL, "/api/pair/complete", { envKey, bearer: "vbx_anything" });
  assert.equal(complete.status, 403);
  assert.equal(complete.body.refused, "host-token-required");
  // A wrong token is the same refusal — the check is the token, not the header's presence.
  const wrong = await post(REMOTE, "/api/pair", { envKey }, { "x-voicebox-host-token": "not-the-token" });
  assert.equal(wrong.body.refused, "host-token-required");
});

test("a call to an environment that is listed but NOT paired is refused by name, before anything crosses", async () => {
  const declared = await post(LOCAL, "/api/environments", { label: "remote box", kind: "server", origin: REMOTE });
  const key = declared.body.environment.key;
  const call = await post(LOCAL, "/api/call", { envKey: key, tool: "notes", args: {} });
  assert.equal(call.status, 403);
  assert.equal(call.body.refused, "environment-not-paired");
  assert.match(call.body.why, /pair/i);
});

test("a call to an environment nobody declared is refused by name", async () => {
  const call = await post(LOCAL, "/api/call", { envKey: "env_nobody", tool: "notes", args: {} });
  assert.equal(call.status, 404);
  assert.equal(call.body.refused, "unknown-environment");
});

test("the bearer store is OUT of every root: a page turn cannot read it, and a leaked bearer cannot be used", async () => {
  // Pair properly (host token on both sides), then ATTACK AS THE REVIEW DID: a page turn asking to
  // read the store, and a direct remote call with whatever it returns.
  const declared = await post(LOCAL, "/api/environments", { label: "remote box", kind: "server", origin: REMOTE });
  const envKey = declared.body.environment.key;
  const issue = await post(REMOTE, "/api/pair", { envKey }, { "x-voicebox-host-token": hostToken(remoteExt) });
  assert.equal(issue.status, 200);
  const bearer = issue.body.bearer;
  await post(LOCAL, "/api/pair/complete", { envKey, bearer }, { "x-voicebox-host-token": hostToken(localExt) });

  // The store is NOT under the workspace root the page can read: it lives in the host's own dir.
  assert.ok(!existsSync(path.join(scratch, "local-ws", "pairings.json")), "the store is not in the workspace root");
  assert.ok(existsSync(path.join(localExt, ".pairings.json")), "the store is in the host's own directory");
  assert.equal(statSync(path.join(localExt, ".pairings.json")).mode & 0o777, 0o600, "the store is 0600");

  // The attack as it was found: a page turn asking to read the store returns NOTHING (no bearer).
  const read = await post(LOCAL, "/api/turn", { transcript: "read pairings.json" });
  const text = JSON.stringify(read.body);
  assert.ok(!text.includes(bearer), `a page turn must not return the bearer: ${text.slice(0, 200)}`);

  // And a direct remote call with a bearer that was never issued refuses AT THE BEARER CHECK — so
  // the key must exist in the remote's registry (else the earlier unknown-environment refusal runs
  // first). The server owns the key, so the remote declares ITSELF and we read the key it issued.
  const selfReg = await post(REMOTE, "/api/environments", { label: "remote box", kind: "server", origin: REMOTE });
  const remoteKey = selfReg.body.environment.key;
  await post(REMOTE, "/api/pair", { envKey: remoteKey }, { "x-voicebox-host-token": hostToken(remoteExt) });
  const forged = await post(REMOTE, "/api/execute", { envKey: remoteKey, tool: "notes", args: {} }, { authorization: "Bearer vbx_forged" });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.refused, "unauthenticated-call");
});

test("a re-keyed environment refuses by name: the bearer is bound to a key that must still exist in the remote's registry", async () => {
  const declared = await post(LOCAL, "/api/environments", { label: "remote box", kind: "server", origin: REMOTE });
  const envKey = declared.body.environment.key;
  const issue = await post(REMOTE, "/api/pair", { envKey }, { "x-voicebox-host-token": hostToken(remoteExt) });
  const bearer = issue.body.bearer;
  // The bearer was issued for envKey, but the REMOTE's registry never declared that key — so the
  // execute resolves the key FIRST and refuses unknown-environment before bearerOk runs.
  const call = await post(REMOTE, "/api/execute", { envKey, tool: "notes", args: {} }, { authorization: `Bearer ${bearer}` });
  assert.equal(call.status, 404);
  assert.equal(call.body.refused, "unknown-environment", "a key the remote no longer holds refuses by name, even with a valid bearer");
});

test("a corrupt pairing store is a named refusal, not a silent wipe of every credential", async () => {
  writeFileSync(path.join(localExt, ".pairings.json"), "{ not json");
  const declared = await post(LOCAL, "/api/environments", { label: "remote box", kind: "server", origin: REMOTE });
  const call = await post(LOCAL, "/api/call", { envKey: declared.body.environment.key, tool: "notes", args: {} });
  assert.equal(call.status, 500);
  assert.equal(call.body.refused, "pairing-list-unreadable");
  rmSync(path.join(localExt, ".pairings.json"), { force: true });
});

test("a call to the local environment needs no pairing and is answered correctly", async () => {
  const call = await post(LOCAL, "/api/call", { envKey: "local", tool: "notes", args: {} });
  // Local is always callable; the tool may be unadmitted, but the refusal is NOT "pair it".
  assert.notEqual(call.body.refused, "environment-not-paired", "the local host needs no pairing");
});
