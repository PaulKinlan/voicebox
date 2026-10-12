import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createActivityRoutes } from "../lib/routes/activity.mjs";

test("activity factory is wired at its exact host table position without inline duplicates", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(root, "server.mjs"), "utf8");
  assert.match(source, /createActivityRoutes\(\{ workActivityLog, json \}\)/);
  assert.match(source, /\.\.\.activityRoutes,\s*"GET \/api\/gemini\/capabilities":/);
  assert.doesNotMatch(source, /"(?:GET|DELETE) \/api\/activity":/, "no inline handler can shadow the factory");
});

test("GET and DELETE retain the host's single mutable log and all later producer writes", () => {
  const initial = { kind: "file", summary: "wrote a.txt" };
  const log = [initial];
  const json = (response, status, payload) => { response.status = status; response.payload = payload; return response; };
  const routes = createActivityRoutes({ workActivityLog: log, json });
  assert.deepEqual(Object.keys(routes).sort(), ["DELETE /api/activity", "GET /api/activity"]);
  const get = routes["GET /api/activity"];
  const del = routes["DELETE /api/activity"];
  const before = {};
  get(null, before);
  assert.equal(before.status, 200);
  assert.deepEqual(before.payload, { ok: true, entries: [initial] });
  assert.strictEqual(before.payload.entries, log, "GET observes the same array producers append to");

  const cleared = {};
  del(null, cleared);
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.payload, { ok: true, entries: [] });
  assert.strictEqual(before.payload.entries, log, "DELETE must not replace the producer's array");
  assert.deepEqual(log, [], "DELETE empties it in place");
  const later = { kind: "command", summary: "later" };
  log.push(later); // the host's appendWorkActivity still holds this reference
  const after = {};
  get(null, after);
  assert.strictEqual(after.payload.entries, log);
  assert.deepEqual(after.payload.entries, [later]);
});
