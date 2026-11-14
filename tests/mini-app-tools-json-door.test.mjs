// tests/mini-app-tools-json-door.test.mjs — voicebox-beads-gesp (the residual of 3bwx).
//
//   node --test tests/mini-app-tools-json-door.test.mjs
//
// POST /api/mini-app/tools hand-rolled its body reader: it accepted ANY Content-Type — so a browser's SIMPLE
// cross-origin POST, which cannot declare application/json without a preflight, was parsed as JSON here, the hole
// voicebox-beads-1la5 closed for every other route — and it answered an oversized body with a bare 400 instead of the
// door's named 413. The route now declares its body on the guarded table, so the CSRF guard answers first and the
// shared door reads the body at this route's own 64 KiB bound.
//
// Driven against the REAL server: what the door says, and that nothing was registered by a refused request.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

async function withServer(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-gesp-"));
  const server = await startServer({ cwd: scratch, env: { VOICEBOX_WORKSPACE: scratch } });
  try {
    return await fn(server);
  } finally {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const register = (base, headers, body) =>
  fetch(`${base}/api/mini-app/tools`, { method: "POST", headers, body });
const tools = async (base) => (await fetch(`${base}/api/mini-app/tools`).then((r) => r.json())).tools;

test("an untyped body is refused by the door, not parsed anyway (voicebox-beads-gesp)", async () => {
  await withServer(async (server) => {
    // text/plain is exactly what a browser can send cross-origin without a preflight.
    const refused = await register(server.base, { "content-type": "text/plain" }, JSON.stringify({ appId: "app_gesp", tools: [{ name: "t1", description: "x", parameters: {} }] }));
    assert.equal(refused.status, 415, "a non-JSON Content-Type must be refused by the shared door");
    const body = await refused.json();
    assert.equal(body.refused, "unsupported-content-type");
    assert.match(body.why, /application\/json/, "the refusal names the type the route wants");
    assert.deepEqual(await tools(server.base), [], "a refused body registers nothing");
  });
});

test("oversize is the door's named 413 at this route's own 64 KiB bound (voicebox-beads-gesp)", async () => {
  await withServer(async (server) => {
    const oversize = JSON.stringify({ appId: "app_gesp", tools: [], pad: "T".repeat(65537) });
    const refused = await register(server.base, { "content-type": "application/json" }, oversize);
    assert.equal(refused.status, 413, "an oversize body is refused by the door");
    const body = await refused.json();
    assert.equal(body.refused, "body-too-large");
    assert.match(body.why, /65536/, "the refusal names THIS route's bound, not the door's default");
    assert.deepEqual(await tools(server.base), [], "a refused body registers nothing");
  });
});

test("a well-formed registration still works, and malformed JSON is still this route's own 400 (voicebox-beads-gesp)", async () => {
  await withServer(async (server) => {
    // Positive control: the route's contract is unchanged for a correct caller.
    const ok = await register(server.base, { "content-type": "application/json" }, JSON.stringify({ appId: "app_gesp", tools: [{ name: "read_notes", description: "d", parameters: { type: "object" } }] }));
    assert.equal(ok.status, 200);
    const registered = await ok.json();
    assert.equal(registered.appId, "app_gesp");
    assert.equal(registered.tools.length, 1, "the tool was registered");
    assert.equal((await tools(server.base)).length, 1);

    // Malformed JSON resolves to null at the door and the route answers in its own words.
    const malformed = await register(server.base, { "content-type": "application/json" }, "{ broken json");
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).refused, "bad-json");
    assert.equal((await tools(server.base)).length, 1, "the malformed body changed nothing");
  });
});
