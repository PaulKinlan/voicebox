// tests/cswsh-proxy.test.mjs — Cross-Site WebSocket Hijacking (CSWSH) protection on Vite dev front
//
// THE DEFECT (voicebox-beads-efc6):
// In vite.config.js, the /channel and /live proxyReqWs hooks unconditionally replaced the browser
// Origin header with API_TARGET. When a user visited a hostile webpage (e.g. http://evil.com or another
// local port), that hostile page could open WebSocket connections to the Vite dev front
// (ws://localhost:5173/channel or /live). The proxy laundered the hostile origin into API_TARGET,
// bypassing the server's local page origin check without requiring any credentials or pairing bearer.
// The hostile page was admitted as the active executor (pageSocket) and could intercept routed file
// operations, or create unauthenticated Gemini Live provider sessions.
//
// WHAT THIS FILE ASSERTS:
//   1. Real browser (CDP): A hostile webpage on an external origin cannot connect to /channel through
//      the Vite dev front: it is refused with WS 1008 "executor-unauthenticated" and cannot become executor.
//   2. Real browser (CDP): A hostile webpage cannot connect to /live through the Vite dev front:
//      it is refused with WS 1008 "unauthenticated-call" and cannot trigger live session creation.
//   3. Direct API parity: Connecting from the hostile origin directly to the API server is also refused.
//   4. Positive control: A legitimate browser page on the Vite dev front connects and is admitted as executor.
//   5. Edge case: Mismatched loopback Origin spoofing through the proxy is neutralized.
//   6. Opt-in gate: With VOICEBOX_LOOPBACK_AUTH=1, the dev front requires and validates the session cookie.
//
//   node --test tests/cswsh-proxy.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "node:http";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

async function freePort() {
  const socket = createHttpServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("hostile webpage cannot hijack /channel or /live through Vite dev front (CSWSH)", { timeout: 45000 }, async (t) => {
  // 1. Start isolated API server
  const api = await startServer({ env: { VOICEBOX_HELLO_BOUND_MS: "1500" } });
  t.after(() => api.stop());

  const prev = process.env.PORT;
  process.env.PORT = String(api.port);

  // 2. Start isolated Vite dev server
  let vite;
  try {
    vite = await createViteServer({
      server: { host: "127.0.0.1", port: await freePort(), strictPort: true },
      logLevel: "error",
    });
    await vite.listen();
  } finally {
    if (prev === undefined) delete process.env.PORT;
    else process.env.PORT = prev;
  }
  t.after(() => vite.close());

  const vitePort = vite.httpServer.address().port;
  const viteFront = `http://127.0.0.1:${vitePort}`;

  // 3. Start isolated attacker server on a different origin
  const attackerServer = createHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html>
<body>
  <h1>Attacker</h1>
  <script>
    window.result = {
      channelOpened: false, channelClosed: false, chanCode: null, chanReason: null, chanFrames: [],
      liveOpened: false, liveClosed: false, liveCode: null, liveReason: null, liveFrames: []
    };

    const chanWs = new WebSocket("ws://127.0.0.1:${vitePort}/channel");
    chanWs.onopen = () => {
      window.result.channelOpened = true;
      chanWs.send(JSON.stringify({ type: "hello", role: "rogue-executor" }));
    };
    chanWs.onmessage = (e) => {
      try { window.result.chanFrames.push(JSON.parse(e.data)); }
      catch { window.result.chanFrames.push({ raw: e.data }); }
    };
    chanWs.onclose = (e) => {
      window.result.channelClosed = true;
      window.result.chanCode = e.code;
      window.result.chanReason = e.reason;
    };

    const liveWs = new WebSocket("ws://127.0.0.1:${vitePort}/live");
    liveWs.onopen = () => {
      window.result.liveOpened = true;
      liveWs.send(JSON.stringify({ type: "hello", role: "rogue-live" }));
    };
    liveWs.onmessage = (e) => {
      try { window.result.liveFrames.push(JSON.parse(e.data)); }
      catch { window.result.liveFrames.push({ raw: e.data }); }
    };
    liveWs.onclose = (e) => {
      window.result.liveClosed = true;
      window.result.liveCode = e.code;
      window.result.liveReason = e.reason;
    };
  </script>
</body>
</html>`);
  });
  await new Promise((r) => attackerServer.listen(0, "127.0.0.1", r));
  t.after(() => attackerServer.close());

  const attackerPort = attackerServer.address().port;
  const attackerUrl = `http://127.0.0.1:${attackerPort}`;

  // 4. Launch Chromium and drive the attack from the hostile page
  const page = await launch();
  t.after(() => page.close());

  await page.goto(attackerUrl);
  await page.waitFor(() => {
    const r = window.result;
    return r?.channelClosed && r?.liveClosed;
  }, { boundMs: 6000, label: "wait for hostile websockets to close" });

  const result = await page.evaluate(() => window.result);

  // Assert /channel was refused
  assert.equal(result.chanCode, 1008, "hostile /channel must be closed with WS 1008");
  assert.equal(result.chanReason, "executor-unauthenticated");
  const chanRefused = result.chanFrames.find((f) => f.type === "refused");
  assert.ok(chanRefused, "must receive refusal frame on /channel");
  assert.equal(chanRefused.refused, "executor-unauthenticated");

  // Assert /live was refused
  assert.equal(result.liveCode, 1008, "hostile /live must be closed with WS 1008");
  assert.equal(result.liveReason, "unauthenticated-call");
  const liveRefused = result.liveFrames.find((f) => f.type === "refused");
  assert.ok(liveRefused, "must receive refusal frame on /live");
  assert.equal(liveRefused.refused, "unauthenticated-call");

  // Verify backend state: no executor connected, no live sessions created
  const rootRes = await (await fetch(`${api.base}/api/root`)).json();
  assert.equal(rootRes.executor?.connected, false, "hostile connection must not register as executor");

  const healthRes = await (await fetch(`${api.base}/api/health`)).json();
  assert.equal(healthRes.live?.created, 0, "no live session must be created for hostile peer");

  // 5. Positive control: legitimate page on Vite dev front connects to /channel and is admitted
  await page.goto(`${viteFront}/`);
  const positive = await page.evaluate((front) => {
    return new Promise((resolve) => {
      const ws = new WebSocket(front.replace(/^http/, "ws") + "/channel");
      ws.onopen = () => {
        setTimeout(() => resolve({ opened: true }), 200);
      };
      ws.onerror = (e) => resolve({ opened: false, err: String(e) });
      ws.onclose = (e) => resolve({ opened: false, code: e.code, reason: e.reason });
    });
  }, viteFront);

  assert.equal(positive.opened, true, "legitimate dev-front page must connect to /channel");
  const positiveRoot = await (await fetch(`${api.base}/api/root`)).json();
  assert.equal(positiveRoot.executor?.connected, true, "legitimate dev-front page is active executor");

  // Positive control for /live on Vite dev front: connects and receives rate frame (voicebox-beads-ukmg)
  const positiveLive = await page.evaluate((front) => {
    return new Promise((resolve) => {
      const ws = new WebSocket(front.replace(/^http/, "ws") + "/live");
      const frames = [];
      let resolved = false;
      ws.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data);
          frames.push(parsed);
          if (parsed.type === "rate" && !resolved) {
            resolved = true;
            resolve({ admitted: true, rateFrame: parsed, frames });
          }
        } catch {
          frames.push({ raw: e.data });
        }
      };
      ws.onclose = (e) => {
        if (!resolved) {
          resolved = true;
          resolve({ admitted: false, code: e.code, reason: e.reason, frames });
        }
      };
    });
  }, viteFront);

  assert.notEqual(positiveLive.code, 1008, "legitimate dev-front page must not be refused with WS 1008");
  assert.equal(positiveLive.admitted, true, `dev-front /live connection must receive rate frame: ${JSON.stringify(positiveLive)}`);
  assert.equal(typeof positiveLive.rateFrame.inputRate, "number");
});

test("loopback Origin spoofing through Vite proxy is neutralized", async (t) => {
  const api = await startServer({ env: { VOICEBOX_HELLO_BOUND_MS: "1000" } });
  t.after(() => api.stop());

  const prev = process.env.PORT;
  process.env.PORT = String(api.port);

  let vite;
  try {
    vite = await createViteServer({
      server: { host: "127.0.0.1", port: await freePort(), strictPort: true },
      logLevel: "error",
    });
    await vite.listen();
  } finally {
    if (prev === undefined) delete process.env.PORT;
    else process.env.PORT = prev;
  }
  t.after(() => vite.close());

  const vitePort = vite.httpServer.address().port;
  const viteWs = `ws://127.0.0.1:${vitePort}`;

  // Attempt to spoof Origin as the API target (port mismatch vs Vite's host)
  const spoofOrigin = `http://127.0.0.1:${api.port}`;
  const ws = new WebSocket(`${viteWs}/channel`, { headers: { origin: spoofOrigin } });
  const frames = [];
  ws.onmessage = (e) => {
    try { frames.push(JSON.parse(e.data)); } catch {}
  };
  const closed = await new Promise((resolve) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "spoof" }));
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });

  assert.equal(closed.code, 1008, "spoofed loopback origin must be refused with 1008");
  assert.equal(closed.reason, "executor-unauthenticated");
  const root = await (await fetch(`${api.base}/api/root`)).json();
  assert.equal(root.executor?.connected, false, "spoofed peer must not become executor");
});

test("opt-in gate (VOICEBOX_LOOPBACK_AUTH=1) admits authenticated dev front via cookie", { timeout: 45000 }, async (t) => {
  const api = await startServer({ env: { VOICEBOX_LOOPBACK_AUTH: "1", VOICEBOX_HELLO_BOUND_MS: "1000" } });
  t.after(() => api.stop());

  const prev = process.env.PORT;
  process.env.PORT = String(api.port);

  let vite;
  try {
    vite = await createViteServer({
      server: { host: "127.0.0.1", port: await freePort(), strictPort: true },
      logLevel: "error",
    });
    await vite.listen();
  } finally {
    if (prev === undefined) delete process.env.PORT;
    else process.env.PORT = prev;
  }
  t.after(() => vite.close());

  const vitePort = vite.httpServer.address().port;
  const viteFront = `http://127.0.0.1:${vitePort}`;

  const page = await launch();
  t.after(() => page.close());

  // 1. Unauthenticated dev front -> refused on /channel (no session cookie)
  await page.goto(`${viteFront}/`);
  const unauth = await page.evaluate((front) => {
    return new Promise((resolve) => {
      const ws = new WebSocket(front.replace(/^http/, "ws") + "/channel");
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello" }));
      ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
    });
  }, viteFront);

  assert.equal(unauth.code, 1008, "unauthenticated page on loopback auth must be refused with 1008");
  assert.equal(unauth.reason, "executor-unauthenticated");

  // 2. Redeem single-use ticket on the dev front to obtain vb_session cookie
  const ticketRes = await fetch(`${api.base}/api/bootstrap`, {
    method: "POST",
    headers: { "x-voicebox-host-token": api.hostToken },
  });
  assert.equal(ticketRes.status, 200);
  const ticket = new URL((await ticketRes.json()).url).searchParams.get("bootstrap");
  assert.ok(ticket);

  await page.goto(`${viteFront}/?bootstrap=${ticket}`);
  await new Promise((r) => setTimeout(r, 400));

  // 3. Authenticated dev front -> admitted as executor!
  const auth = await page.evaluate((front) => {
    return new Promise((resolve) => {
      const ws = new WebSocket(front.replace(/^http/, "ws") + "/channel");
      ws.onopen = () => setTimeout(() => resolve({ opened: true }), 200);
      ws.onclose = (e) => resolve({ opened: false, code: e.code });
    });
  }, viteFront);

  assert.equal(auth.opened, true, "cookie-authenticated dev front must be admitted");
  const authRoot = await (await fetch(`${api.base}/api/root`, {
    headers: { "x-voicebox-host-token": api.hostToken },
  })).json();
  assert.equal(authRoot.executor?.connected, true, "cookie-authenticated dev front is active executor");
});
