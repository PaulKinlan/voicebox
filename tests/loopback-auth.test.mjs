// tests/loopback-auth.test.mjs — the loopback session gate (docs/13 §4, voicebox-beads-kkc).
//
// THE DEFECT (the residual 5c1 named, docs/13 §1): on loopback TCP any local process can write
// `Origin: http://127.0.0.1:<port>` on a raw socket, so /channel's local-page entitlement —
// "entitled by construction" via Origin alone — is a claim any same-machine script can make,
// and the chair it takes answers routed acts with via:"page".
//
// THE FIX lands docs/13 §4 Option A (the Jupyter/code-server pattern) as an OPT-IN gate:
// VOICEBOX_LOOPBACK_AUTH=1 mints a per-process session secret and a one-time bootstrap ticket,
// prints the ticket's URL at startup, and redeems it once — on the page route — into an
// HttpOnly SameSite=Strict cookie. With the gate on, the page and the APIs answer only with
// that cookie (health, the bootstrap door itself, and holders of the host token excepted), and
// /channel + /live require Origin AND cookie for the local-page entitlement. A process that
// cannot read the ticket output falls to the bearer-hello path and is refused there, by name.
//
// THE HONEST CLAIM about what this closes: processes that cannot read the ticket output or the
// host token — a different UID, an unprivileged container. A same-UID process that can read both
// is inside the host boundary by definition (docs/13 §4 rationale); Option B (WebCrypto pairing)
// exists for that and is deliberately not built here.
//
// DEFAULT OFF is itself under test: the gate-off block pins the 5c1 surface so the opt-in can
// never silently become the default.
//
//   node --test tests/loopback-auth.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

const GATE_ON = { VOICEBOX_LOOPBACK_AUTH: "1", VOICEBOX_HELLO_BOUND_MS: "400" };

async function scratchServer(env = {}) {
  const host = mkdtempSync(path.join(tmpdir(), "vb-loopback-auth-"));
  const extensions = path.join(host, "extensions");
  const started = await startServer({ env: { VOICEBOX_EXTENSIONS_DIR: extensions, ...env } });
  return {
    ...started,
    extensions,
    hostToken: () => started.hostToken,
    cleanup: () => rmSync(host, { recursive: true, force: true }),
  };
}

function openChannel(base, { origin = null, cookie = null } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/channel`, Object.keys(headers).length ? { headers } : undefined);
  const frames = [];
  ws.onmessage = (e) => {
    try {
      frames.push(typeof e.data === "string" ? JSON.parse(e.data) : e.data);
    } catch {
      frames.push({ unparsed: e.data });
    }
  };
  const opened = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const closed = new Promise((res) => {
    ws.onclose = res;
  });
  return { ws, frames, opened, closed };
}

async function waitFor(predicate, { boundMs = 6000 } = {}) {
  const started = Date.now();
  while (!(await predicate()) && Date.now() - started < boundMs) await new Promise((r) => setTimeout(r, 30));
  return await predicate();
}

function selfOrigin(base) {
  return base; // the page's Origin IS the http base — the header a forger would write
}

async function executorConnected(base, cookie = null) {
  const res = await fetch(`${base}/api/root`, cookie ? { headers: { cookie } } : undefined);
  const body = await res.json();
  return body.executor?.connected ?? false;
}

function sessionCookieFrom(res) {
  const raw = res.headers.get("set-cookie");
  assert.ok(raw, "redemption must set the session cookie");
  assert.match(raw, /^vb_session=[0-9a-f]{64}/, "the cookie must carry the per-process session secret");
  assert.match(raw, /; HttpOnly/i, "the cookie must be HttpOnly — script-readable tokens are what docs/13 §1 rules out");
  assert.match(raw, /; SameSite=Strict/i, "the cookie must be SameSite=Strict");
  assert.match(raw, /; Path=\//, "the cookie must be scoped to the whole origin");
  return raw.split(";")[0];
}

// ── the default surface: GATE OFF ────────────────────────────────────────────

test("default OFF: the page answers without any cookie, and ?bootstrap= is ignored", async () => {
  const server = await scratchServer();
  try {
    const page = await fetch(`${server.base}/`);
    assert.equal(page.status, 200, "the default surface serves the page openly (5c1 behaviour)");
    assert.equal(page.headers.get("set-cookie"), null, "no session cookie may be minted by default");

    const withParam = await fetch(`${server.base}/?bootstrap=not-a-ticket`);
    assert.equal(withParam.status, 200, "the bootstrap param must be inert when the gate is off");
    assert.equal(withParam.headers.get("set-cookie"), null);
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("default OFF: the bootstrap door does not exist", async () => {
  const server = await scratchServer();
  try {
    const res = await fetch(`${server.base}/api/bootstrap`, {
      method: "POST",
      headers: { "x-voicebox-host-token": server.hostToken() },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.refused, "loopback-auth-disabled");
    assert.match(body.why, /VOICEBOX_LOOPBACK_AUTH=1/);
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("default OFF: a forged loopback Origin alone still takes the executor chair — the documented residual", async () => {
  const server = await scratchServer();
  try {
    // This is the boundary 5c1 named and docs/13 §1 measured — PINNED here on purpose: the test
    // names what the gate-on block closes, and fails if the default ever drifts without a decision.
    const page = openChannel(server.base, { origin: selfOrigin(server.base) });
    await page.opened;
    assert.ok(
      await waitFor(() => executorConnected(server.base)),
      "with the gate off, an Origin-matching connection is the executor (5c1 boundary, unchanged)",
    );
    page.ws.close();
  } finally {
    await server.stop();
    server.cleanup();
  }
});

// ── the gated surface: VOICEBOX_LOOPBACK_AUTH=1 ──────────────────────────────

test("gate ON: an unauthenticated request is refused by name, with the remedy, before any route", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    const page = await fetch(`${server.base}/`);
    assert.equal(page.status, 401);
    const pageBody = await page.text();
    assert.match(pageBody, /loopback-unauthenticated/);
    assert.match(pageBody, /bootstrap/, "the refusal must carry the remedy");

    const api = await fetch(`${server.base}/api/environments`);
    assert.equal(api.status, 401);
    const apiBody = await api.json();
    assert.equal(apiBody.refused, "loopback-unauthenticated");
    assert.match(apiBody.why, /bootstrap/);
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("gate ON: /api/health stays open — the spawn-and-wait harness reads it before any session exists", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    const res = await fetch(`${server.base}/api/health`);
    assert.equal(res.status, 200, "health is the heartbeat; walling it would blind every supervisor");
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("gate ON: the printed bootstrap URL redeems ONCE into the session cookie", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    const match = await waitFor(() => server.stdout().match(new RegExp(`bootstrap  http://127\\.0\\.0\\.1:${server.port}/\\?bootstrap=([0-9a-f]{64})`)));
    assert.ok(match, `the server must print its bootstrap URL at startup; stdout was:\n${server.stdout()}`);
    const printedUrl = match[0].replace(/^bootstrap  /, "");

    const first = await fetch(printedUrl, { redirect: "manual" });
    assert.equal(first.status, 200, "the first redemption must serve the page, not a redirect");
    assert.match(first.headers.get("content-type") ?? "", /text\/html/);
    const cookie = sessionCookieFrom(first);

    const second = await fetch(printedUrl, { redirect: "manual" });
    assert.equal(second.status, 401, "a consumed ticket must not redeem again — one ticket opens one session");
    const body = await second.text();
    assert.match(body, /bootstrap-ticket-refused/);

    const unknown = await fetch(`${server.base}/?bootstrap=${"ab".repeat(32)}`, { redirect: "manual" });
    assert.equal(unknown.status, 401, "an unknown ticket is refused, not ignored");
    assert.match(await unknown.text(), /bootstrap-ticket-refused/);

    // The redeemed cookie opens the page and the APIs.
    const authedPage = await fetch(`${server.base}/`, { headers: { cookie } });
    assert.equal(authedPage.status, 200);
    const authedApi = await fetch(`${server.base}/api/environments`, { headers: { cookie } });
    assert.equal(authedApi.status, 200);
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("gate ON: POST /api/bootstrap with the host token mints a fresh single-use ticket", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    const refused = await fetch(`${server.base}/api/bootstrap`, { method: "POST" });
    assert.equal(refused.status, 403, "minting without the host token is refused");
    assert.equal((await refused.json()).refused, "host-token-refused");

    const res = await fetch(`${server.base}/api/bootstrap`, {
      method: "POST",
      headers: { "x-voicebox-host-token": server.hostToken() },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.url, new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/\\?bootstrap=[0-9a-f]{64}$`));

    const redeemed = await fetch(body.url, { redirect: "manual" });
    assert.equal(redeemed.status, 200);
    sessionCookieFrom(redeemed); // shape-asserted in the helper

    const again = await fetch(body.url, { redirect: "manual" });
    assert.equal(again.status, 401, "the minted ticket is single-use like the startup one");
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("gate ON: the host token passes the wall — the shell keeps its acts without a browser", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    const res = await fetch(`${server.base}/api/environments`, {
      headers: { "x-voicebox-host-token": server.hostToken() },
    });
    assert.notEqual(res.status, 401, "a valid host token IS authentication; the wall must not blind the shell");
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("gate ON: a forged loopback Origin WITHOUT the cookie cannot take the executor chair", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    // THE regression this whole feature exists for: the request channel-auth.test.mjs's
    // "local page" case admits today is refused the moment the entitlement needs a session.
    const forger = openChannel(server.base, { origin: selfOrigin(server.base) });
    await forger.opened;
    forger.ws.send(JSON.stringify({ type: "hello", role: "environment" })); // no bearer, forged origin

    const closeEv = await forger.closed;
    assert.equal(closeEv.code, 1008);
    assert.equal(closeEv.reason, "executor-unauthenticated");
    const refusal = forger.frames.find((f) => f.type === "refused");
    assert.ok(refusal, "the refusal must be named before close");
    assert.equal(refusal.refused, "executor-unauthenticated");
    assert.equal(await executorConnected(server.base), false, "the forger must not become the executor");
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("gate ON: a forged Origin with a WRONG cookie is refused too", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    const forger = openChannel(server.base, { origin: selfOrigin(server.base), cookie: `vb_session=${"cd".repeat(32)}` });
    await forger.opened;
    forger.ws.send(JSON.stringify({ type: "hello", role: "environment" }));

    const closeEv = await forger.closed;
    assert.equal(closeEv.reason, "executor-unauthenticated");
    assert.equal(await executorConnected(server.base), false);
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("gate ON: the real page — Origin AND session cookie — is entitled without any hello", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    const match = await waitFor(() => server.stdout().match(/bootstrap=([0-9a-f]{64})/));
    const redeemed = await fetch(`http://127.0.0.1:${server.port}/?bootstrap=${match[1]}`, { redirect: "manual" });
    const cookie = sessionCookieFrom(redeemed);

    const page = openChannel(server.base, { origin: selfOrigin(server.base), cookie });
    await page.opened;
    assert.ok(
      await waitFor(() => executorConnected(server.base, cookie)),
      "the served page presents the cookie on the upgrade and takes the chair, hello-free",
    );
    page.ws.close();
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("gate ON: /live — forged Origin without the cookie falls to the hello gate and is refused", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    const ws = new WebSocket(`${server.base.replace(/^http/, "ws")}/live`, { headers: { origin: selfOrigin(server.base) } });
    const frames = [];
    ws.onmessage = (e) => {
      try { frames.push(JSON.parse(e.data)); } catch { frames.push({ unparsed: e.data }); }
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ type: "hello", role: "environment" })); // no bearer
    const closed = new Promise((res) => { ws.onclose = res; });
    const closeEv = await closed;
    assert.equal(closeEv.code, 1008);
    assert.equal(closeEv.reason, "unauthenticated-call", "/live's hello gate names the refusal in its own vocabulary");
    assert.ok(frames.some((f) => f.type === "refused" && f.refused === "unauthenticated-call"));
  } finally {
    await server.stop();
    server.cleanup();
  }
});

test("gate ON: /live — the cookie-carrying page is entitled without a hello", async () => {
  const server = await scratchServer(GATE_ON);
  try {
    const match = await waitFor(() => server.stdout().match(/bootstrap=([0-9a-f]{64})/));
    const redeemed = await fetch(`http://127.0.0.1:${server.port}/?bootstrap=${match[1]}`, { redirect: "manual" });
    const cookie = sessionCookieFrom(redeemed);

    const ws = new WebSocket(`${server.base.replace(/^http/, "ws")}/live`, { headers: { origin: selfOrigin(server.base), cookie } });
    const frames = [];
    ws.onmessage = (e) => {
      try { frames.push(JSON.parse(e.data)); } catch { frames.push({ unparsed: e.data }); }
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    // Entitlement is observable as NOT-refused: the socket proceeds to the rate frame (or a
    // provider-declared-rate error under the script resolver) — anything but the 1008 refusal.
    const gotLife = await waitFor(() => frames.length > 0, { boundMs: 2500 });
    assert.ok(gotLife, "an entitled /live socket hears back from the session path");
    assert.equal(
      frames.some((f) => f.type === "refused"),
      false,
      `the cookie-carrying page must not be refused; frames were ${JSON.stringify(frames)}`,
    );
    ws.close();
  } finally {
    await server.stop();
    server.cleanup();
  }
});
