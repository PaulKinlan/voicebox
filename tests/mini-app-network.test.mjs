// tests/mini-app-network.test.mjs — a Mini-App has no network unless it declares it and a person allows it
// (voicebox-beads-cwx5.16), driven in a real browser through the room.
//
// Before this, the inner frame was a srcdoc document with no content security policy: app code could load a
// script from, or send data to, any origin. What is asserted here is the WIRE (Network.requestWillBeSent), not
// the policy text, with a positive control so that "no request seen" cannot be an artefact of not looking:
//   1. an undeclared app sends NOTHING outside, and the card names the origins it was stopped from. (That the
//      policy precedes even a <script src> placed BEFORE the app's <head> is pinned deterministically in
//      tests/app-network-policy.test.mjs: this drive only catches that mutant some of the time, because the
//      frame's very first request can be announced before the test has attached to its target.)
//   2. a declaring app is still offline until a person presses Allow, and is asked by name;
//   3. after Allow the same requests DO go out (the control), and only to the declared origins;
//   4. the approval is remembered for that app and that exact origin set, and asked again when the set changes.
// The hosts are reserved `.test` names: nothing resolves, and requestWillBeSent fires before DNS.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = `
  <script>
    fetch("https://api.vb-example.test/collect?secret=1").catch(() => {});
    new Image().src = "https://cdn.vb-example.test/pixel.png";
    fetch("https://undeclared.vb-example.test/x").catch(() => {});
    document.title = "ran";
  <\/script>`;
// The early script sits BEFORE <head> on purpose.
const undeclaredApp = `<!doctype html><script src="https://cdn.vb-example.test/early.js"><\/script><html><head><title>t</title></head><body>${body}</body></html>`;
const manifest = (csp) => `<script type="application/voicebox-app+json">${JSON.stringify({ csp })}<\/script>`;
const declaringApp = (csp) => `<!doctype html><html><head>${manifest(csp)}<script src="https://cdn.vb-example.test/early.js"><\/script></head><body>${body}</body></html>`;
const DECLARED = { connectDomains: ["https://api.vb-example.test"], resourceDomains: ["https://cdn.vb-example.test"] };

test("a Mini-App reaches the network only through origins it declared and a person allowed", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-app-network-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "workspace") }, cwd: scratch });
  t.after(() => server.stop());
  const page = await launch();
  t.after(() => page.close());
  await page.send("Network.enable");
  await page.goto(`${server.base}/`);
  await page.waitFor(() => typeof window.__voiceboxOnMiniApp === "function" && !!window.__voiceboxMiniAppRegistry, { label: "room booted", timeout: 30000 });

  // THE APP FRAME IS ITS OWN TARGET. A sandboxed srcdoc iframe runs out of process, so the page's Network events
  // never include its requests — a wire assertion made there passes by not looking. Every child target is
  // therefore attached PAUSED (waitForDebuggerOnStart), given Network.enable, and only then released, so even a
  // <script src> in the first bytes of the document is observed.
  await page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const frames = [];
  let adopting = true;
  const adopt = (async () => {
    let seen = 0;
    while (adopting) {
      const attached = page.events("Target.attachedToTarget");
      for (const event of attached.slice(seen)) {
        frames.push(event.sessionId);
        await page.sendTo(event.sessionId, "Network.enable").catch(() => {});
        await page.sendTo(event.sessionId, "Runtime.runIfWaitingForDebugger").catch(() => {});
      }
      seen = attached.length;
      await sleep(10);
    }
  })();
  t.after(async () => { adopting = false; await adopt; });

  // "Since the mount" is a point in the browser's own monotonic clock, not an index: the events come from several
  // sessions, so a position in their concatenation moves whenever a new frame attaches.
  let mark = 0;
  const now = () => Math.max(0, ...requests().map((e) => e.timestamp ?? 0));
  const requests = () => [
    ...page.events("Network.requestWillBeSent"),
    ...frames.flatMap((session) => page.eventsFrom(session, "Network.requestWillBeSent")),
  ];
  // A request the policy stopped never reaches the network, but CDP still announces a parser-initiated one
  // (requestWillBeSent, then loadingFailed with blockedReason "csp"). Those are the policy WORKING, so they are
  // not counted; a request that failed for any other reason (here: the name does not resolve) did leave.
  const failures = () => [
    ...page.events("Network.loadingFailed"),
    ...frames.flatMap((session) => page.eventsFrom(session, "Network.loadingFailed")),
  ];
  const outside = () => {
    const stopped = new Set(failures().filter((e) => e.blockedReason === "csp").map((e) => e.requestId));
    return requests()
      .filter((e) => e.timestamp > mark && !stopped.has(e.requestId))
      .map((e) => String(e.request?.url ?? "")).filter((url) => url.includes("vb-example.test")).map((url) => new URL(url).host).sort();
  };
  const mount = async (appId, html) => {
    // Let the previous app's requests finish being announced before drawing the line.
    await sleep(600);
    mark = now();
    await page.evaluate((d) => { window.__voiceboxOnMiniApp(d); }, { appId, title: appId, html });
  };
  const cardText = (selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", selector);

  // ── 1. undeclared: nothing leaves, and the card says what was stopped ──────────────────────────────
  await mount("offline-app", undeclaredApp);
  await page.waitFor(() => (document.querySelector(".mini-app-network-notice")?.textContent ?? "").includes("undeclared.vb-example.test"), { label: "the blocked-load notice", timeout: 15000 });
  await sleep(300);
  assert.deepEqual(outside(), [], "an app that declared nothing must send no request to any outside origin");
  const notice = await cardText(".mini-app-network-notice");
  for (const host of ["api.vb-example.test", "cdn.vb-example.test", "undeclared.vb-example.test"]) assert.ok(notice.includes(host), `the notice must name ${host}: ${notice}`);
  assert.equal(await page.evaluate(() => !document.querySelector(".mini-app-network-ask")), true, "an app that asked for nothing is not asked about");

  // ── 2. declared but not yet allowed: asked by name, still offline ──────────────────────────────────
  await mount("net-app", declaringApp(DECLARED));
  await page.waitFor(() => !!document.querySelector(".mini-app-network-ask"), { label: "the network question", timeout: 15000 });
  const question = await cardText(".mini-app-network-ask");
  assert.match(question, /net-app asks to use the network/);
  assert.match(question, /Send and receive data: api\.vb-example\.test/);
  assert.match(question, /Load scripts, styles, images and fonts: cdn\.vb-example\.test/);
  await page.waitFor(() => (document.querySelector(".mini-app-network-notice")?.textContent ?? "").includes("api.vb-example.test"), { label: "blocked while unanswered", timeout: 15000 });
  await sleep(300);
  assert.deepEqual(outside(), [], "declaring is asking: nothing may leave before a person answers");

  // ── 3. Allow: THE CONTROL — the same requests now reach the wire, and only the declared ones ───────
  mark = now();
  await page.click(".mini-app-network-ask .mini-app-consent-allow");
  // Compared as a SET of hosts: how many times the document is parsed per mount is not what is under test.
  const reached = () => [...new Set(outside())];
  const deadline = Date.now() + 15000;
  while (reached().length < 2 && Date.now() < deadline) await sleep(50);
  await sleep(300);
  assert.deepEqual(reached(), ["api.vb-example.test", "cdn.vb-example.test"], "after Allow the declared fetch, image and script go out — and the undeclared origin still does not");
  assert.equal(await page.evaluate(() => !document.querySelector(".mini-app-network-ask")), true, "the question goes away once answered");

  // ── 4. remembered for this app and this exact set; asked again when the set changes ───────────────
  await mount("net-app", declaringApp(DECLARED));
  const again = Date.now() + 15000;
  while (reached().length < 2 && Date.now() < again) await sleep(50);
  assert.deepEqual(reached(), ["api.vb-example.test", "cdn.vb-example.test"], "a remount of the approved app runs with its grant");
  assert.equal(await page.evaluate(() => !document.querySelector(".mini-app-network-ask")), true, "an approved app is not asked twice");

  await mount("net-app", declaringApp({ ...DECLARED, connectDomains: [...DECLARED.connectDomains, "https://undeclared.vb-example.test"] }));
  await page.waitFor(() => !!document.querySelector(".mini-app-network-ask"), { label: "asked again for a wider set", timeout: 15000 });
  await sleep(300);
  assert.deepEqual(outside(), [], "a wider request is a new request: the old approval does not cover it, in whole or in part");

  // Keep offline: the bar goes, nothing is granted, and a reload in this page does not nag.
  await page.click(".mini-app-network-ask .mini-app-consent-deny");
  await mount("net-app", declaringApp({ ...DECLARED, connectDomains: [...DECLARED.connectDomains, "https://undeclared.vb-example.test"] }));
  await page.waitFor(() => !!document.querySelector(".mini-app-network-notice"), { label: "still blocked after Keep offline", timeout: 15000 });
  assert.equal(await page.evaluate(() => !document.querySelector(".mini-app-network-ask")), true);
  assert.deepEqual(outside(), []);

  // Another app with the same declaration has its own answer to give.
  await mount("other-app", declaringApp(DECLARED));
  await page.waitFor(() => !!document.querySelector(".mini-app-network-ask"), { label: "a different app is asked for itself", timeout: 15000 });
});
