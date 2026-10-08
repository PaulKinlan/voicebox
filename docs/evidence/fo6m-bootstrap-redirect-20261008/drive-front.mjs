// docs/evidence/fo6m-bootstrap-redirect-20261008/drive-front.mjs — the same drive on the VITE DEV
// FRONT (`npm run dev`), because that path is where a relative redirect target earns its keep.
//
//   node docs/evidence/fo6m-bootstrap-redirect-20261008/drive-front.mjs
//
// The front (`localhost:<frontPort>`) is a different origin from the API server
// (`127.0.0.1:<apiPort>`), and the redemption proxy in `vite.config.js` forwards `?bootstrap=`
// navigations upstream verbatim — status, `Location` and `Set-Cookie`. Two things are only true if
// the `Location` is RELATIVE, and this drive measures both:
//
//   * the browser stays on the front it launched from, rather than being handed to the API origin;
//   * the cookie the redemption sets is stored for the FRONT's host, which is the origin the page's
//     proxied API calls and WebSocket upgrades are same-origin with.
//
// The API port is chosen by the OS (PORT=0) and the front is given a port of its own, so neither
// side can collide with a served tree another lane is holding. Both processes and the browser are
// closed in a `finally`.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "../../../tests/lib/cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const FRONT_PORT = 5273;
const FRONT = `http://localhost:${FRONT_PORT}`;

const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-fo6m-front-"));
const apiEnv = { ...process.env, PORT: "0", VOICEBOX_LOOPBACK_AUTH: "1", VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "extensions") };
delete apiEnv.VOICEBOX_WORKSPACE;
const api = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { cwd: ROOT, env: apiEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
let apiOut = "";
api.stdout.on("data", (chunk) => (apiOut += String(chunk)));

let front = null;
let frontOut = "";
let browser = null;
const log = { surface: "vite-dev-front", front: FRONT, api: { port: null }, steps: {}, http: {}, notes: [] };

const inPage = async (page) =>
  page.evaluate(() => ({
    href: location.href,
    title: document.title,
    wordmark: document.querySelector("h1.wordmark")?.textContent?.trim() ?? null,
    bodyText: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
  }));

try {
  const deadline = Date.now() + 20000;
  while (!/bootstrap  (http:\/\/127\.0\.0\.1:\d+\/\?bootstrap=[0-9a-f]{64})/.test(apiOut) && Date.now() < deadline) await sleep(50);
  const apiBootstrap = apiOut.match(/bootstrap  (http:\/\/127\.0\.0\.1:\d+\/\?bootstrap=[0-9a-f]{64})/)?.[1];
  if (!apiBootstrap) throw new Error(`the API server never printed a bootstrap URL; stdout was:\n${apiOut}`);
  log.api.port = Number(apiOut.match(/voicebox on http:\/\/127\.0\.0\.1:(\d+)\D/)?.[1]);
  log.api.bootstrapUrl = apiBootstrap.replace(/bootstrap=[0-9a-f]{64}/, "bootstrap=<ticket>");
  // The launch a person performs on the dev front: the printed URL, on the front's origin.
  const frontBootstrap = new URL(apiBootstrap);
  frontBootstrap.port = String(FRONT_PORT);
  frontBootstrap.hostname = "localhost";

  front = spawn(path.join(ROOT, "node_modules/.bin/vite"), ["--port", String(FRONT_PORT), "--strictPort", "--clearScreen", "false"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(log.api.port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  front.stdout.on("data", (chunk) => (frontOut += String(chunk)));
  front.stderr.on("data", (chunk) => (frontOut += String(chunk)));
  const frontDeadline = Date.now() + 40000;
  while (!/ready in \d+ ms/.test(frontOut) && Date.now() < frontDeadline) await sleep(100);
  if (!/ready in \d+ ms/.test(frontOut)) throw new Error(`the dev front never reported ready; output was:\n${frontOut}`);

  browser = await launch();
  await browser.send("Network.enable");

  await browser.goto(frontBootstrap.toString());
  log.steps.launched = await inPage(browser);
  await browser.screenshot(path.join(HERE, "front-1-launched.png"));

  await browser.reload();
  log.steps.refreshed = await inPage(browser);
  await browser.screenshot(path.join(HERE, "front-2-refreshed.png"));

  await browser.goto(frontBootstrap.toString());
  log.steps.consumedRevisit = await inPage(browser);
  await browser.screenshot(path.join(HERE, "front-3-consumed-revisit.png"));

  log.http.browserCookies = ((await browser.send("Storage.getCookies")).cookies ?? []).map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  }));

  const noSession = await fetch(frontBootstrap.toString(), { redirect: "manual" });
  log.http.noSessionRevisit = { status: noSession.status, location: noSession.headers.get("location"), body: (await noSession.text()).slice(0, 120) };

  writeFileSync(path.join(HERE, "front-drive.json"), JSON.stringify(log, null, 2) + "\n");
  const verdict = {
    frontRedirectedToItsOwnOrigin: log.steps.launched.href === `${FRONT}/`,
    refreshRenderedPage: log.steps.refreshed.href === `${FRONT}/` && log.steps.refreshed.title === "Voicebox",
    consumedRevisitOnPlainRoute: log.steps.consumedRevisit.href === `${FRONT}/` && log.steps.consumedRevisit.title === "Voicebox",
    cookieScopedToTheFront: log.http.browserCookies.some((c) => c.name === "vb_session" && c.domain === "localhost" && c.path === "/" && c.httpOnly),
  };
  console.log(JSON.stringify({ verdict, steps: log.steps, cookies: log.http.browserCookies, noSessionRevisit: log.http.noSessionRevisit }, null, 2));
  if (!Object.values(verdict).every(Boolean)) process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of [front, api]) {
    if (!child) continue;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  await sleep(300);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
}
