import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "node:http";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

// The dev front serves the shell even when the API's loopback wall refuses it.
// A private API + ephemeral Vite port keep this independent of the shared front.
async function freePort() {
  const socket = createHttpServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("a healthy API with no session asks for sign-in, not a server restart", { timeout: 45000 }, async (t) => {
  const api = await startServer({ env: { VOICEBOX_LOOPBACK_AUTH: "1" } });
  t.after(() => api.stop());
  const previousPort = process.env.PORT;
  process.env.PORT = String(api.port);
  let vite;
  try {
    vite = await createViteServer({ server: { host: "127.0.0.1", port: await freePort(), strictPort: true } });
    await vite.listen();
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
  t.after(() => vite.close());
  const front = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const page = await launch();
  t.after(() => page.close());
  assert.equal((await fetch(`${front}/api/health`)).status, 200);
  const refusal = await fetch(`${front}/api/root`);
  assert.equal(refusal.status, 401);
  assert.equal((await refusal.json()).refused, "loopback-unauthenticated");

  await page.goto(`${front}/`);
  await page.waitFor(() => (document.querySelector("#env-note")?.textContent ?? "").length > 0, { label: "downstream refusal rendered" });
  const state = await page.evaluate(() => ({
    dot: document.querySelector("#server-dot")?.dataset.ok,
    where: document.querySelector("#where-note")?.textContent,
    rootNote: document.querySelector("#root-note")?.textContent,
    envNote: document.querySelector("#env-note")?.textContent,
    syncToastHidden: document.querySelector("#sync-toast")?.hidden,
    syncToastText: document.querySelector("#sync-toast-message")?.textContent,
  }));
  if (process.env.VOICEBOX_HEALTH_EVIDENCE) {
    await page.screenshot(process.env.VOICEBOX_HEALTH_EVIDENCE);
  }
  assert.equal(state.dot, "true", JSON.stringify(state));
  assert.equal(state.syncToastHidden, true, JSON.stringify(state));
  assert.match(`${state.where} ${state.rootNote} ${state.envNote}`, /session|bootstrap ticket/i, JSON.stringify(state));
  assert.doesNotMatch(`${state.where} ${state.rootNote} ${state.envNote}`, /fix the file|machine is not answering/i);

  // Redeem on the front's origin: a ticket redeemed on the API origin cannot give
  // this page its session cookie. Never log or capture the ticket itself.
  const ticketResponse = await fetch(`${api.base}/api/bootstrap`, {
    method: "POST", headers: { "x-voicebox-host-token": api.hostToken },
  });
  assert.equal(ticketResponse.status, 200);
  const ticket = new URL((await ticketResponse.json()).url).searchParams.get("bootstrap");
  assert.ok(ticket);
  await page.goto(`${front}/?bootstrap=${ticket}`);
  await page.waitFor(() => document.querySelector("#where-note")?.textContent?.startsWith("agent:")
    && document.querySelector("#env-note")?.textContent === "", { label: "session recovery" });
  const recovered = await page.evaluate(() => ({
    dot: document.querySelector("#server-dot")?.dataset.ok,
    toastHidden: document.querySelector("#sync-toast")?.hidden,
    url: location.href,
  }));
  assert.equal(recovered.dot, "true");
  assert.equal(recovered.toastHidden, true);
  assert.equal(new URL(recovered.url).searchParams.has("bootstrap"), false);

  await api.stop();
  await page.goto(`${front}/`);
  await page.waitFor(() => document.querySelector("#server-dot")?.dataset.ok === "false", { label: "genuine offline" });
  const offline = await page.evaluate(() => ({
    where: document.querySelector("#where-note")?.textContent,
    toast: document.querySelector("#sync-toast-message")?.textContent,
    visible: !document.querySelector("#sync-toast")?.hidden,
  }));
  assert.match(offline.where, /machine is not answering/i);
  assert.match(offline.toast, /server is not responding/i);
  assert.equal(offline.visible, true);
});

test("a failing environment-list route is not a failing heartbeat", { timeout: 30000 }, async (t) => {
  const api = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") res.end(JSON.stringify({ provider: "script", build: { commit: "aaaaaaa" } }));
    else if (req.url === "/api/root") res.end(JSON.stringify({ declared: false }));
    else if (req.url === "/api/environments") {
      res.statusCode = 500;
      res.end(JSON.stringify({ refused: "environment-list-unreadable", why: "the registry file cannot be read" }));
    } else { res.statusCode = 404; res.end(JSON.stringify({ refused: "not-found" })); }
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const previousPort = process.env.PORT;
  process.env.PORT = String(api.address().port);
  let vite;
  try {
    vite = await createViteServer({ server: { host: "127.0.0.1", port: await freePort(), strictPort: true } });
    await vite.listen();
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
  t.after(() => vite.close());
  const page = await launch();
  t.after(() => page.close());
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`);
  await page.waitFor(() => (document.querySelector("#env-note")?.textContent ?? "").includes("registry file"), { label: "registry error shown" });
  const state = await page.evaluate(() => ({
    dot: document.querySelector("#server-dot")?.dataset.ok,
    where: document.querySelector("#where-note")?.textContent,
    title: document.querySelector("#where-note")?.title,
    note: document.querySelector("#env-note")?.textContent,
    toast: document.querySelector("#sync-toast-message")?.textContent,
  }));
  assert.equal(state.dot, "true", JSON.stringify(state));
  assert.match(state.where, /environment list could not be read/i);
  assert.match(state.title, /GET \/api\/environments.*environment-list-unreadable/);
  assert.match(state.note, /registry file cannot be read/);
  assert.doesNotMatch(state.toast, /server is not responding/i);
});
