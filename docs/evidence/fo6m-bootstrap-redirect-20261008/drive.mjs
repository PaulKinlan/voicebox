// docs/evidence/fo6m-bootstrap-redirect-20261008/drive.mjs — the real-browser drive for
// voicebox-beads-fo6m: a gate-on launch must leave the PLAIN route in the address bar, so the
// refresh everyone performs is authenticated instead of re-presenting a consumed bootstrap ticket.
//
//   node docs/evidence/fo6m-bootstrap-redirect-20261008/drive.mjs --label after
//
// It starts this checkout's own `node server.mjs` the way `npm start` does (VOICEBOX_LOOPBACK_AUTH=1,
// a scratch extensions directory, PORT=0 so it cannot collide), reads the bootstrap URL the server
// prints, and drives Chromium through the three moments Paul named:
//
//   1. open the printed bootstrap URL      → where does the browser end up, and does the page render?
//   2. refresh that page (Page.reload)     → is the refresh authenticated, or a used-ticket 401?
//   3. revisit the original consumed URL   → redirect again, or a refusal?
//
// The pre-fix tree is the same drive against a server with the old redemption, which is what the
// `before` run records (the receipt says how that server was supplied). Nothing here writes into the
// tree: the server's scratch state lands in a temp directory that is removed on the way out, and the
// browser is closed in a `finally` — one browser at a time, as the fleet's rules require.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "../../../tests/lib/cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const label = (() => {
  const at = process.argv.indexOf("--label");
  return at === -1 ? "after" : (process.argv[at + 1] ?? "after");
})();

const bootstrapLine = (stdout) => stdout.match(/bootstrap  (http:\/\/127\.0\.0\.1:\d+\/\?bootstrap=[0-9a-f]{64})/)?.[1] ?? null;
const bannerLine = (stdout) => stdout.match(/voicebox on http:\/\/127\.0\.0\.1:(\d+)\D/)?.[1] ?? null;

const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-fo6m-"));
const env = { ...process.env, PORT: "0", VOICEBOX_LOOPBACK_AUTH: "1", VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "extensions") };
delete env.VOICEBOX_WORKSPACE; // no root from the shell, exactly as tests/lib/server.mjs pins it
const server = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => (stdout += String(chunk)));
server.stderr.on("data", (chunk) => (stderr += String(chunk)));

const read = async (url) => {
  const res = await fetch(url, { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), body: (await res.text()).slice(0, 160) };
};
const inPage = async (page) =>
  page.evaluate(() => ({
    href: location.href,
    title: document.title,
    wordmark: document.querySelector("h1.wordmark")?.textContent?.trim() ?? null,
    bodyText: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
  }));

let browser = null;
const log = { label, server: { port: null, bootstrapUrl: null }, steps: {}, http: {}, notes: [] };

try {
  const deadline = Date.now() + 20000;
  while (!bootstrapLine(stdout) && Date.now() < deadline) await sleep(50);
  const boot = bootstrapLine(stdout);
  if (!boot) throw new Error(`the server never printed a bootstrap URL within 20s; stdout was:\n${stdout}\nstderr was:\n${stderr}`);
  log.server.port = Number(bannerLine(stdout));
  log.server.bootstrapUrl = boot;
  const base = `http://127.0.0.1:${log.server.port}`;

  browser = await launch();
  await browser.send("Network.enable");

  // 1. THE FIRST LAUNCH.
  await browser.goto(boot);
  log.steps.launched = await inPage(browser);
  await browser.screenshot(path.join(HERE, `${label}-1-launched.png`));

  // 2. THE REFRESH — the moment Paul described.
  await browser.reload();
  log.steps.refreshed = await inPage(browser);
  await browser.screenshot(path.join(HERE, `${label}-2-refreshed.png`));

  // 3. THE ORIGINAL (now consumed) BOOTSTRAP URL, with the session the launch minted: bookmark,
  //    history, back button.
  await browser.goto(boot);
  log.steps.consumedRevisit = await inPage(browser);
  await browser.screenshot(path.join(HERE, `${label}-3-consumed-revisit.png`));

  // The protocol's own record of the redemption hop, from both ends: Chrome reports a 3xx as the
  // NEXT request's `redirectResponse` (a redirect fires no `responseReceived` of its own), while the
  // pre-fix tree's 200-at-the-ticket-URL DOES land in `responseReceived` — so the two runs differ
  // here by construction, which is the point of keeping it.
  const stripTicket = (url) => (url ?? "").replace(/bootstrap=[0-9a-f]{64}/, "bootstrap=<ticket>");
  log.notes.push("CDP does not expose Set-Cookie on Network response headers; the cookie the redemption set is proved by `http.browserCookies`, read from the browser's own jar.");
  log.http.redemption = [
    ...browser
      .events("Network.requestWillBeSent")
      .filter((event) => event.redirectResponse)
      .map((event) => ({
        saw: "redirectResponse",
        url: stripTicket(event.redirectResponse.url),
        status: event.redirectResponse.status,
        location: event.redirectResponse.headers.location ?? null,
        next: stripTicket(event.request.url),
      })),
    ...browser
      .events("Network.responseReceived")
      .map((event) => event.response)
      .filter((response) => response.url.includes("bootstrap="))
      .map((response) => ({
        saw: "responseReceived",
        url: stripTicket(response.url),
        status: response.status,
        location: response.headers.location ?? null,
      })),
  ];

  // What the BROWSER now holds, read from the browser's own jar — the shape only, never the secret.
  log.http.browserCookies = ((await browser.send("Storage.getCookies")).cookies ?? []).map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  }));

  // The unauthenticated half, straight over HTTP: a stale ticket with no session is still refused.
  await sleep(150);
  log.http.noSessionRevisit = await read(boot);
  log.http.plainRouteWithoutSession = await read(`${base}/`);

  writeFileSync(path.join(HERE, `${label}-drive.json`), JSON.stringify(log, null, 2) + "\n");
  const verdict = {
    launchedOnPlainRoute: log.steps.launched.href === `${base}/`,
    refreshRenderedPage: log.steps.refreshed.href === `${base}/` && log.steps.refreshed.title === "Voicebox",
    consumedRevisitOnPlainRoute: log.steps.consumedRevisit.href === `${base}/` && log.steps.consumedRevisit.title === "Voicebox",
  };
  console.log(JSON.stringify({ label, verdict, steps: log.steps, redemption: log.http.redemption }, null, 2));
  if (label === "after" && !Object.values(verdict).every(Boolean)) process.exitCode = 1;
} finally {
  await browser?.close();
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {}
  await sleep(200);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
}
