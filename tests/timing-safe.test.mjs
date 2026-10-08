// tests/timing-safe.test.mjs — voicebox-beads-sseh / GH #26.
//
// Three things are checked here, and it matters which is which:
//
//  1. the helper's own accept/reject matrix, including the cases that must NOT throw;
//  2. ADOPTION — the three sites ask the owner instead of comparing secrets themselves. This is
//     the honest red-old/green-new for a security-shaped change: timing itself cannot be asserted
//     (loopback jitter dwarfs the difference), so what can be pinned is that the comparison is no
//     longer written at the sites. It is a source-level assertion, not a proof of constant-time
//     behaviour, and it is labelled as such;
//  3. REAL PROTOCOL ACCEPTANCE — a driven server, so the change is shown to preserve what the wire
//     accepts and rejects, not just what a unit function returns.
//
//   node --test tests/timing-safe.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { timingSafeStringEqual } from "../lib/timing-safe.mjs";
import { startServer } from "./lib/server.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const HEX48 = "a".repeat(48);
const HEX64 = "b".repeat(64);

// ── 1. the helper ──────────────────────────────────────────────────────────
test("timingSafeStringEqual: accepts only the identical string", () => {
  assert.equal(timingSafeStringEqual(HEX64, HEX64), true);
  assert.equal(timingSafeStringEqual("abc", "abc"), true);
  // Two empty strings ARE equal, and the helper says so: emptiness is a caller's rule (the session
  // token sites keep their truthiness check), not this module's.
  assert.equal(timingSafeStringEqual("", ""), true);
});

test("timingSafeStringEqual: rejects a mismatch anywhere in an equal-length string", () => {
  const first = `x${HEX64.slice(1)}`;
  const middle = `${HEX64.slice(0, 32)}y${HEX64.slice(33)}`;
  const last = `${HEX64.slice(0, 63)}z`;
  for (const [what, provided] of [["first byte", first], ["middle byte", middle], ["last byte", last]]) {
    assert.equal(timingSafeStringEqual(provided, HEX64), false, `${what} must be rejected`);
  }
  assert.equal(timingSafeStringEqual("ABCD", "abcd"), false, "comparison stays case-sensitive");
});

test("timingSafeStringEqual: unequal lengths are a rejection, never a throw", () => {
  assert.equal(timingSafeStringEqual(HEX64.slice(0, 63), HEX64), false, "one short");
  assert.equal(timingSafeStringEqual(`${HEX64}x`, HEX64), false, "one long");
  assert.equal(timingSafeStringEqual("", HEX64), false, "empty against a real secret");
  assert.equal(timingSafeStringEqual(HEX64, ""), false, "real secret against empty");
  // timingSafeEqual itself throws on unequal buffer lengths, so this is the gate that keeps a bad
  // token from turning into a crashed request rather than a refusal.
  assert.doesNotThrow(() => timingSafeStringEqual(HEX64.slice(0, 5), HEX64));
});

test("timingSafeStringEqual: non-strings are refused without throwing", () => {
  for (const value of [undefined, null, 123, {}, [], Buffer.from(HEX64), true]) {
    assert.equal(timingSafeStringEqual(value, HEX64), false, `${String(value)} must be refused`);
    assert.equal(timingSafeStringEqual(HEX64, value), false, `expected side: ${String(value)}`);
  }
});

test("timingSafeStringEqual: multi-byte characters compare by utf8 bytes, not characters", () => {
  assert.equal(timingSafeStringEqual("é", "é"), true);
  assert.equal(timingSafeStringEqual("é", "e"), false);
  // "é" is 2 bytes; a one-byte string of the same length in characters must not be accepted.
  assert.equal(timingSafeStringEqual("é", "ab"), false);
});

// ── 2. adoption: the sites ask the owner ───────────────────────────────────
test("adoption: the three credential-comparison sites route through the owner (source-level, not a timing claim)", () => {
  const server = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
  const extensions = readFileSync(path.join(ROOT, "lib", "extensions.mjs"), "utf8");

  assert.equal(server.includes("sessionToken === ROOM_SESSION_TOKEN"), false,
    "the session-token sites must not compare the secret with === any more");
  assert.equal(extensions.includes("provided === expected"), false,
    "hostTokenOk must not compare the secret with === any more");
  assert.equal(server.includes('from "./lib/timing-safe.mjs"'), true,
    "server.mjs must import the owner");
  assert.equal(extensions.includes('from "./timing-safe.mjs"'), true,
    "lib/extensions.mjs must import the owner");
  // Both session-token sites, so a second copy cannot survive the migration unnoticed.
  // The raw primitive belongs to the owner; a direct call here would mean a second compare again.
  assert.equal(server.includes("timingSafeEqual("), false, "the server must not call the primitive directly");
  assert.equal(server.split("timingSafeStringEqual(sessionToken, ROOM_SESSION_TOKEN)").length - 1, 2,
    "both session-token comparisons (extension authority and /api/root) must use the owner");
});

// ── 3. real protocol acceptance ────────────────────────────────────────────
test("protocol: host token and in-room session token accept exactly what they accepted before", async (t) => {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-sseh-")));
  const workspace = path.join(scratch, "workspace");
  mkdirSync(workspace, { recursive: true });
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: workspace, VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "extensions") } });
  t.after(async () => {
    await server.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  const gate = (headers) =>
    fetch(`${server.base}/api/agents`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" })
      .then((r) => r.status);

  // Site 3: lib/extensions.mjs hostTokenOk, reached through the host header.
  const host = server.hostToken;
  assert.notEqual(await gate({ "x-voicebox-host-token": host }), 403, "the real host token must still be admitted");
  assert.equal(await gate({ "x-voicebox-host-token": `x${host.slice(1)}` }), 403, "an equal-length wrong host token is refused");
  assert.equal(await gate({ "x-voicebox-host-token": host.slice(0, -1) }), 403, "a short host token is refused");
  assert.equal(await gate({ "x-voicebox-host-token": `${host}x` }), 403, "a long host token is refused");
  assert.equal(await gate({ "x-voicebox-host-token": "" }), 403, "an empty host token is refused");
  assert.equal(await gate({}), 403, "a missing host token is refused");

  // Site 1: server.mjs hasExtensionAuthority's session-token comparison. The token is embedded in
  // the served page for the in-room UI, so the drive takes it from there rather than reading state.
  const html = await fetch(`${server.base}/`).then((r) => r.text());
  const found = html.match(/[0-9a-f]{48}/g) ?? [];
  assert.ok(found.length > 0, "the served page must carry the in-room session token");
  const session = found[0];
  assert.equal(session.length, 48, "the session token is 48 hex characters");

  assert.notEqual(await gate({ "x-voicebox-session-token": session }), 403, "the real session token must still grant authority");
  assert.equal(await gate({ "x-voicebox-session-token": `x${session.slice(1)}` }), 403, "an equal-length wrong session token is refused");
  assert.equal(await gate({ "x-voicebox-session-token": session.slice(0, -1) }), 403, "a short session token is refused");
  assert.equal(await gate({ "x-voicebox-session-token": `${session}x` }), 403, "a long session token is refused");
  assert.equal(await gate({ "x-voicebox-session-token": "" }), 403, "an empty session token is refused");
});
