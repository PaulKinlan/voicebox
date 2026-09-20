// tests/environment-registry.test.mjs — THE ENVIRONMENT REGISTRY: a server-owned list of hosts.
//
//   node --test tests/environment-registry.test.mjs
//
// The gap Paul named, driving the live page: the top-right answered "the local server answered" —
// ONE environment — when the ask is a LIST of them. The registry is server-owned (the same list from
// every browser), the "+" button declares a descriptor without starting anything, and a host that is
// listed but not running is REFUSED BY NAME (`environment-unreachable`), never shown as ready. An
// unreadable registry file is a different named refusal (`environment-list-unreadable`), because the
// remedy is the file, not the service.
//
// Driven against the real server as a subprocess: every assertion is an HTTP response or bytes on
// disk, never the server's account of itself.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

let server;
let BASE;
let scratch;

const listEnvs = () => fetch(`${BASE}/api/environments`).then((r) => r.json());
const addEnv = (body) =>
  fetch(`${BASE}/api/environments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-env-"));
  server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "workspace") }, cwd: scratch });
  BASE = server.base;
});

test.after(async () => {
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("the local server is always a row, and it is reachable by construction", async () => {
  const { environments } = await listEnvs();
  const local = environments.find((e) => e.key === "local");
  assert.ok(local, "the local server is a row even with no registry file");
  assert.equal(local.kind, "server");
  assert.equal(local.reachable, true);
  assert.equal(local.refused, null);
});

test("declaring a server environment writes the descriptor and does NOT start it — a stopped host is named unreachable", async () => {
  const added = await addEnv({ label: "atlas box", kind: "server", origin: "http://127.0.0.1:9" });
  assert.equal(added.status, 200);
  assert.equal(added.body.ok, true);
  assert.equal(added.body.environment.label, "atlas box");
  assert.ok(added.body.environment.key, "the server issued a stable key");
  assert.notEqual(added.body.environment.key, "atlas box", "the key is not the label");

  // The descriptor is on disk, server-owned, so a second browser would read the same list.
  const file = path.join(scratch, "workspace", "environments.json");
  assert.ok(existsSync(file), "the registry is written to the server's workspace");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stored.environments.length, 1);
  assert.equal(stored.environments[0].label, "atlas box");

  // The next read probes it: nothing is listening on that port, so it is unreachable BY NAME.
  const { environments } = await listEnvs();
  const remote = environments.find((e) => e.label === "atlas box");
  assert.ok(remote, "the declared environment is in the list");
  assert.equal(remote.reachable, false, "a stopped service is not shown as reachable");
  assert.equal(remote.refused, "environment-unreachable");
  assert.match(remote.why, /not running|did not answer/i, "the refusal names the remedy, not just the denial");
});

test("a malformed declaration is refused by name and does not touch the list", async () => {
  const before = (await listEnvs()).environments.length;
  const noLabel = await addEnv({ kind: "server", origin: "http://127.0.0.1:9" });
  assert.equal(noLabel.status, 400);
  assert.equal(noLabel.body.ok, false);
  assert.equal(noLabel.body.refused, "bad-request");
  const noOrigin = await addEnv({ label: "nowhere", kind: "server" });
  assert.equal(noOrigin.status, 400);
  assert.match(noOrigin.body.why, /origin/i);
  assert.equal((await listEnvs()).environments.length, before, "a refused declaration stores nothing");
});

test("an unreadable registry file is its own refusal, distinct from an empty list", async () => {
  // Write a torn file over the good one and confirm the read says the LIST is broken, not empty.
  const file = path.join(scratch, "workspace", "environments.json");
  writeFileSync(file, "{ not json");
  const res = await fetch(`${BASE}/api/environments`);
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.refused, "environment-list-unreadable");
  assert.match(body.why, /could not be read/i);
  // Restore a good file so the suite's afterEach and any later case is clean.
  writeFileSync(file, JSON.stringify({ environments: [] }));
});
