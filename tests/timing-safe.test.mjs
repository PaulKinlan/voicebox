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

test("timingSafeStringEqual: compares source code units, so distinct strings stay distinct", () => {
  assert.equal(timingSafeStringEqual("é", "é"), true);
  assert.equal(timingSafeStringEqual("é", "e"), false, "one code unit against two");
  assert.equal(timingSafeStringEqual("é", "ab"), false, "same nothing: different code units, different count");

  // THE COLLISION THIS HELPER MADE POSSIBLE, and the reason it uses utf16le rather than utf8: a lone
  // surrogate and the replacement character are DIFFERENT JavaScript strings that UTF-8 encodes to
  // the same bytes. An exact-string helper that called them equal would be failing its own contract.
  // This assertion is GREEN on utf16le and RED on utf8, so it is the behavioural discriminator for
  // the encoding choice rather than a description of it.
  assert.equal(timingSafeStringEqual("\uD800", "\uFFFD"), false, "a lone surrogate is not the replacement character");
  assert.equal(timingSafeStringEqual("\uFFFD", "\uFFFD"), true, "the replacement character is itself");

  // Astral control: a surrogate pair is two code units and must equal only itself, not either half.
  assert.equal(timingSafeStringEqual("😀", "😀"), true);
  assert.equal(timingSafeStringEqual("😀", "\uD83D"), false, "half a pair is not the pair");
  assert.equal(timingSafeStringEqual("😀", "\uDE00"), false, "nor the other half");
  assert.equal(timingSafeStringEqual("\uD83D\uDE00", "😀"), true, "and the pair is spelled either way");
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

  // The COOKIE site needs its OWN guard, and the 9f2b1fe delta review is right that it had none:
  // reverting sessionCookieOk to a bare equality passes every protocol outcome below, because an
  // exact compare accepts and rejects exactly the same cookie values, and it passes the
  // no-direct-primitive check too, because it calls no primitive at all. So the adoption is asserted
  // where it lives - on that function's own body, positively and negatively - rather than on the file.
  const cookieBody = /function sessionCookieOk\(req\) \{[\s\S]*?\n\}/.exec(server)?.[0] ?? "";
  assert.ok(cookieBody, "sessionCookieOk must still exist in server.mjs for this guard to mean anything");
  assert.match(cookieBody, /timingSafeStringEqual\(/, "sessionCookieOk must ask the owner for the cookie comparison");
  assert.equal(cookieBody.includes("=== LOOPBACK_SESSION"), false,
    "sessionCookieOk must not compare the cookie itself - the reviewer's mutant (reverting this call) has to fail here");
  assert.equal(server.split("timingSafeStringEqual(sessionToken, ROOM_SESSION_TOKEN)").length - 1, 2,
    "both session-token comparisons (extension authority and /api/root) must use the owner");
});

// ── 3. real protocol acceptance ────────────────────────────────────────────
test("protocol: host token and in-room session token accept exactly what they accepted before", async (t) => {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-sseh-")));
  const workspace = path.join(scratch, "workspace");
  mkdirSync(workspace, { recursive: true });
  // VOICEBOX_LOOPBACK_AUTH: undefined pins the POSTURE UNDER TEST rather than inheriting whatever the
  // ambient shell is set to: with the wall on, the invalid-token requests below are refused 401 by the
  // loopback wall before this route can answer 403, and the assertions would be measuring the shell
  // (the tests/loopback-auth.test.mjs pattern). The cookie test further down pins it ON deliberately.
  const server = await startServer({ env: {
    VOICEBOX_LOOPBACK_AUTH: undefined,
    VOICEBOX_WORKSPACE: workspace,
    VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "extensions"),
  } });
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

// ── 4. the vb_session cookie, driven ───────────────────────────────────────
// The cookie check (sessionCookieOk in server.mjs) is one of the four comparisons that moved onto
// lib/timing-safe.mjs, so it gets driven acceptance here rather than a unit assertion alone.
//
// READ THE OUTCOMES CAREFULLY, THEY ARE NOT ALL REFUSALS: the cookie authenticates the LOOPBACK
// WALL, nothing more. With the real cookie the request passes the wall and is then refused 403 by
// the separate extension-authority gate, which answers to the host token, the in-room session token
// and the page origin - not to this cookie. So 401 is "the wall refused you", 403-with-a-real-cookie
// is the wall ACCEPTING and a different gate deciding, and both are asserted below so neither can
// be mistaken for the other.
//
// What this does NOT attest: timing. Nothing here measures how long a comparison took, because
// loopback jitter dwarfs the difference; the discrimination for this change is driven acceptance
// plus adoption of the owner, which the adoption test above asserts separately.
test("protocol: the vb_session cookie still gates the loopback wall and is not extension authority", async (t) => {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-sseh-cookie-")));
  mkdirSync(path.join(scratch, "workspace"), { recursive: true });
  let server = null;
  // Registered before anything can fail, and it owns both the process and the temp dir: a failed
  // assertion must not leave a listening server or a scratch directory behind.
  t.after(async () => {
    try { await server?.stop(); } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
  server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: path.join(scratch, "workspace"),
      VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "extensions"),
      VOICEBOX_LOOPBACK_AUTH: "1",
    },
  });

  const gated = (headers) =>
    fetch(`${server.base}/api/agents`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // 1. No cookie: refused by the wall, by name.
  const anonymous = await gated({});
  assert.equal(anonymous.status, 401, "without a cookie the loopback wall must refuse");
  assert.equal(anonymous.body.refused, "loopback-unauthenticated", "and it must say which wall refused");

  // 2. The host token mints a one-time bootstrap ticket; the ticket redeems into the cookie.
  const mint = await fetch(`${server.base}/api/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: "{}",
  });
  assert.equal(mint.status, 200, "the host token must still mint a bootstrap ticket");
  const { url } = await mint.json();
  assert.match(String(url), /\?bootstrap=[0-9a-f]{64}$/, "the bootstrap URL carries a 64-hex one-time ticket");

  const redeem = await fetch(url, { redirect: "manual" });
  const setCookie = redeem.headers.get("set-cookie") ?? "";
  const secret = /vb_session=([0-9a-f]{64})/.exec(setCookie)?.[1];
  // The value is never printed: the test asserts its SHAPE, so nothing secret reaches the log.
  assert.ok(secret, "redeeming the ticket must set a 64-hex vb_session cookie");

  // 3. The real cookie passes the wall, and is then refused by the OTHER gate - 403, not 401.
  const withCookie = await gated({ cookie: `vb_session=${secret}` });
  assert.equal(withCookie.status, 403,
    "a real cookie passes the loopback wall; the 403 is the separate extension-authority gate, not the wall");

  // 4. An equal-length wrong cookie is refused by the wall.
  assert.equal((await gated({ cookie: `vb_session=x${secret.slice(1)}` })).status, 401, "a wrong cookie of equal length is refused");

  // 5. A short cookie is refused rather than thrown on: unequal lengths never reach timingSafeEqual,
  //    which throws on buffers of different length - the length gate is what turns that into a 401.
  assert.equal((await gated({ cookie: `vb_session=${secret.slice(0, -1)}` })).status, 401, "a short cookie is refused, not crashed on");
});

// ── 5. the second session-token site, driven: POST /api/root ───────────────
// Finding P2 #2 of the 9f2b1fe review: the wire test drove the extension-authority comparison but not
// the /api/root one, so the second migrated site was only covered by the source assertion. This drives
// it. The outcome is chosen to DISCRIMINATE THE GUARD rather than merely be a refusal: a machine root
// is decided by the token, so the real session token must get PAST the guard and be answered by the
// route itself (200, with the root declared), while a wrong, short or absent token is refused at the
// guard with 403 refused "host-token-required". A test that only asserted "not 200" would pass on a
// route that broke for every caller; asserting the 200 is what pins that the token was accepted.
test("protocol: POST /api/root is decided by the second session-token site", async (t) => {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-sseh-root-")));
  const workspace = path.join(scratch, "workspace");
  const declared = path.join(scratch, "declared-project");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(declared, { recursive: true });
  let server = null;
  t.after(async () => {
    try { await server?.stop(); } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
  server = await startServer({ env: {
    VOICEBOX_LOOPBACK_AUTH: undefined,
    VOICEBOX_WORKSPACE: workspace,
    VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "extensions"),
  } });

  const html = await fetch(`${server.base}/`).then((r) => r.text());
  const session = (html.match(/[0-9a-f]{48}/g) ?? [])[0];
  assert.ok(session, "the served page must carry the in-room session token");

  const declareRoot = (headers) =>
    fetch(`${server.base}/api/root`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ project: "sseh-fixture", root: { kind: "machine", path: declared } }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const accepted = await declareRoot({ "x-voicebox-session-token": session });
  assert.equal(accepted.status, 200, "the real session token must get PAST the guard at /api/root");
  assert.equal(accepted.body.ok, true, "and the route must then do its work rather than refuse");
  assert.notEqual(accepted.body.refused, "host-token-required", "the guard refusal must not be what answered the real token");

  const wrong = await declareRoot({ "x-voicebox-session-token": `x${session.slice(1)}` });
  assert.equal(wrong.status, 403, "an equal-length wrong session token is refused");
  assert.equal(wrong.body.refused, "host-token-required", "and refused by the guard, by name");

  const short = await declareRoot({ "x-voicebox-session-token": session.slice(0, -1) });
  assert.equal(short.status, 403, "a short session token is refused rather than thrown on");
  assert.equal(short.body.refused, "host-token-required", "refused by the guard");

  const malformed = await declareRoot({ "x-voicebox-session-token": "not-a-token" });
  assert.equal(malformed.status, 403, "a malformed session token is refused");

  const missing = await declareRoot({});
  assert.equal(missing.status, 403, "and no token at all is refused");
  assert.equal(missing.body.refused, "host-token-required", "by the same guard, so the 200 above was the guard accepting");
});
