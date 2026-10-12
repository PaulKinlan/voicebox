// Presence routes are a thin HTTP seam: exercise the actual host boundary, not only a factory fake.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

let server;
let scratch;
test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "vb-presence-http-"));
  server = await startServer({ env: { VOICEBOX_WORKSPACE: scratch, VOICEBOX_LOOPBACK_AUTH: undefined } });
});
test.after(async () => { await server?.stop(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });

const request = async (route, { method = "GET", value, contentType = "application/json" } = {}) => {
  const headers = value === undefined ? {} : { "content-type": contentType };
  const response = await fetch(server.base + route, { method, headers, ...(value === undefined ? {} : { body: value }) });
  return { status: response.status, body: await response.json() };
};
const post = (body, route = "/api/presence") => request(route, { method: "POST", value: JSON.stringify(body) });

test("presence HTTP: exact two paths preserve actions, aliases, status and refusal bodies", async () => {
  const empty = await request("/api/presence");
  assert.equal(empty.status, 200);
  assert.equal(empty.body.count, 0);
  const joined = await post({ action: "joinParticipant", participantId: "peer-a", name: "A" });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.participant.participantId, "peer-a");
  assert.equal((await request("/api/presence")).body.count, 1);
  const heart = await post({ participantId: "peer-a", caption: "hello" });
  assert.equal(heart.status, 200, "missing action still means heartbeat");
  assert.equal(heart.body.snapshot.sharedCaptions.at(-1).text, "hello");
  const caption = await post({ action: "record_caption", participantId: "peer-a", speaker: "A", text: "second" });
  assert.equal(caption.status, 200);
  assert.equal(caption.body.snapshot.sharedCaptions.at(-1).text, "second");
  const floor = await post({ action: "requestFloor", participantId: "peer-a" });
  assert.equal(floor.status, 200);
  const refused = await post({ action: "request_floor" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.refused, "invalid-participant");
  assert.equal((await request("/api/presence")).body.floorHolderId, "peer-a");
  assert.equal((await post({ action: "release_floor", participantId: "peer-a" })).status, 200);
  assert.equal((await post({ action: "leaveParticipant", participantId: "peer-a" })).status, 200);
  assert.equal((await request("/api/presence")).body.count, 0);
  for (const [route, method] of [["/api/presence-extra", "GET"], ["/api/presence/", "POST"], ["/api/presence", "DELETE"]]) {
    assert.equal((await request(route, { method })).status, 404, `${method} ${route} must not be captured`);
  }
});

test("presence HTTP: malformed/unsupported/oversized bodies stop before coordinator or broadcast", async () => {
  const before = (await request("/api/presence")).body;
  const malformed = await request("/api/presence", { method: "POST", value: "{", contentType: "application/json" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.refused, "bad-request");
  const nonObject = await request("/api/presence", { method: "POST", value: '"text"', contentType: "application/json" });
  assert.equal(nonObject.status, 400);
  assert.equal(nonObject.body.refused, "bad-request");
  const media = await request("/api/presence", { method: "POST", value: "{}", contentType: "text/plain" });
  assert.equal(media.status, 415);
  assert.equal(media.body.refused, "unsupported-content-type");
  const large = await request("/api/presence", { method: "POST", value: JSON.stringify({ action: "join", participantId: "never", padding: "x".repeat(1024 * 1024) }) });
  assert.equal(large.status, 413);
  assert.equal(large.body.refused, "body-too-large");
  assert.equal((await request("/api/presence")).status, 200, "one refusal must not cause a second response or kill the server");
  assert.deepEqual((await request("/api/presence")).body, before, "refused bodies did not reach presence state");
});

test("presence HTTP: global loopback cookie wall runs before the extracted route", async () => {
  const gated = await startServer({ env: { VOICEBOX_WORKSPACE: scratch, VOICEBOX_LOOPBACK_AUTH: "1" } });
  try {
    for (const [route, method] of [["/api/presence", "GET"], ["/api/presence", "POST"]]) {
      const response = await fetch(gated.base + route, { method });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).refused, "loopback-unauthenticated");
    }
  } finally { await gated.stop(); }
});
