// tests/sync-toast-extraction.test.mjs — the revision-mismatch toast and the build stamp live in
// public/components/sync-toast.mjs, not inline in public/fused.js (voicebox-beads-uei2.5).
//
// The owner tests keep driving the feature end to end and are unchanged: tests/ux-bubble-stage.test.mjs
// drives the toast through window.__voiceboxSyncToast.update(...) and tests/health-auth-browser.test.mjs
// reads #sync-toast's hidden state. This file covers the five ways THIS extraction can rot while those
// stay green:
//   1. a LEFTOVER COPY in the host (counted, with a listener-free clone to prove the count is wiring);
//   2. a move that did not really happen (fused.js must no longer carry the moved markers, statically —
//      no lint gate would catch a dead copy);
//   3. the injected openChangelogDialog not really being injected (driven standalone with a spy);
//   4. the page global's shape drifting (tests call window.__voiceboxSyncToast.update);
//   5. pageBuild becoming unreachable — the host's About box calls it, and that call can happen before
//      the controller exists, so it must remain a plain exported function rather than a controller method.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "public", "components", "sync-toast.mjs");
const HOST_PATH = path.join(ROOT, "public", "fused.js");

const MOVED_MARKERS = [
  "let dismissedSyncKey",
  "let currentSyncKey",
  "let initialServerCommit",
  "function updateSyncToast",
  "function stampBuild",
  "function pageBuild",
  "on(els.syncToastReload",
  "on(els.syncToastDismiss",
];

let server;
let BASE;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "sync-toast-extraction-test" } });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/`);
  await page.waitFor(() => window.__voiceboxSyncToast !== undefined, { label: "the host to wire the sync toast" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

// ── static arms, as named guards so their mutants can drive them ────────────────────────────────────
// Token, not substring: `includes("function stampBuild")` would also accept `stampBuildLegacy`.
const hasMarker = (text, marker) => new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(text);

function assertMovedOutOfHost(hostSource, moduleSource) {
  for (const marker of MOVED_MARKERS) {
    assert.ok(!hasMarker(hostSource, marker), `${marker} must no longer be inline in fused.js`);
    assert.ok(hasMarker(moduleSource, marker), `the extracted module must carry ${marker}`);
  }
}

function assertHostContract(hostSource, moduleSource) {
  assert.match(moduleSource, /export function pageBuild\(\)/, "pageBuild must be a plain export: renderAbout() calls it and may run before the controller exists");
  assert.match(hostSource, /import \{ createSyncToastController, pageBuild \} from "\.\/components\/sync-toast\.mjs";/, "the host imports both");
  assert.match(hostSource, /\bpageBuild\(\)/, "the host still calls pageBuild (the About box names the page revision)");
  assert.match(hostSource, /const syncToastController = createSyncToastController\(\{ els, on, openChangelogDialog \}\);/, "wired at one site, with the dialog opener injected");
  assert.match(hostSource, /window\.__voiceboxSyncToast = \{ update: syncToastController\.update \};/, "the page global keeps its shape: tests call .update(...)");
  assert.match(moduleSource, /export function createSyncToastController\(\{ els, on, openChangelogDialog \}\)/, "the module takes the opener as a dependency");
}

test("the surface is in the module and gone from the host, and the host contract is intact", () => {
  const host = readFileSync(HOST_PATH, "utf8");
  const mod = readFileSync(MODULE_PATH, "utf8");
  assertMovedOutOfHost(host, mod);
  assertHostContract(host, mod);

  // NEGATIVE MUTANTS: each guard must fail when the thing it checks is undone.
  const hostWithLeftover = host.replace("const syncToastController", 'function stampBuild(server) { return server; }\nconst syncToastController');
  assert.notEqual(hostWithLeftover, host, "the leftover-copy mutant must change the host");
  assert.throws(() => assertMovedOutOfHost(hostWithLeftover, mod), { name: "AssertionError" }, "a leftover inline copy must be caught");

  const hostWithoutImport = host.replace('import { createSyncToastController, pageBuild } from "./components/sync-toast.mjs";\n', "");
  assert.notEqual(hostWithoutImport, host, "the no-import mutant must change the host");
  assert.throws(() => assertHostContract(hostWithoutImport, mod), { name: "AssertionError" }, "a dropped import must be caught");

  const hostWithSnapshotGlobal = host.replace("window.__voiceboxSyncToast = { update: syncToastController.update };", "window.__voiceboxSyncToast = { update: () => {} };");
  assert.notEqual(hostWithSnapshotGlobal, host, "the global-shape mutant must change the host");
  assert.throws(() => assertHostContract(hostWithSnapshotGlobal, mod), { name: "AssertionError" }, "a global that no longer reaches the surface must be caught");

  const modWithPrivatePageBuild = mod.replace("export function pageBuild()", "function pageBuild()");
  assert.notEqual(modWithPrivatePageBuild, mod, "the unexported-pageBuild mutant must change the module");
  assert.throws(() => assertHostContract(host, modWithPrivatePageBuild), { name: "AssertionError" }, "an unexported pageBuild must be caught: renderAbout() would hit a temporal dead zone");
});

test("the real page renders the stamp, opens the changelog from that line, and honours the toast global", async () => {
  const stamp = await page.evaluate(() => {
    const line = document.getElementById("build");
    const link = line?.querySelector('a[href="#changelog-dialog"]');
    return {
      text: line?.textContent ?? "",
      linkText: link?.textContent ?? null,
      hasPopup: link?.getAttribute("aria-haspopup") ?? null,
      controls: link?.getAttribute("aria-controls") ?? null,
      dialogOpenBefore: document.getElementById("changelog-dialog")?.open ?? null,
    };
  });
  assert.match(stamp.text, /page /, "the stamp must name the page revision (the moved pageBuild still runs)");
  assert.equal(stamp.linkText, "change log", "the stamp must carry the change-log link the module appends");
  assert.equal(stamp.hasPopup, "dialog", "the link keeps its dialog semantics");
  assert.equal(stamp.controls, "changelog-dialog", "the link keeps pointing at the dialog");
  assert.notEqual(stamp.dialogOpenBefore, true, "the dialog starts closed");

  // The INJECTED opener, end to end: the link the MODULE builds opens the dialog the HOST passed in.
  const opened = await page.evaluate(() => {
    document.getElementById("build").querySelector('a[href="#changelog-dialog"]').click();
    return document.getElementById("changelog-dialog")?.open === true;
  });
  assert.equal(opened, true, "clicking the module's change-log link must open the changelog dialog — that is the injected openChangelogDialog working");
  await page.evaluate(() => document.getElementById("changelog-dialog")?.close());

  // The page global's contract, driven: show, then hide. tests/ux-bubble-stage.test.mjs does the same.
  const toast = await page.evaluate(async () => {
    const read = () => ({ hidden: document.getElementById("sync-toast")?.hidden, text: document.getElementById("sync-toast-message")?.textContent ?? "" });
    window.__voiceboxSyncToast.update({ outOfSync: true, reason: "different revisions", key: "k-1" });
    const shown = read();
    window.__voiceboxSyncToast.update({ outOfSync: false });
    return { shown, hidden: read() };
  });
  assert.equal(toast.shown.hidden, false, "update({outOfSync:true}) must show the toast");
  assert.equal(toast.shown.text, "different revisions", "the toast must carry the revision reason it was given");
  assert.equal(toast.hidden.hidden, true, "update({outOfSync:false}) must hide it again");

  // The dismissed-key memory moved with the surface: dismissing must suppress THAT key, not every key.
  const dismissed = await page.evaluate(() => {
    const toast = document.getElementById("sync-toast");
    window.__voiceboxSyncToast.update({ outOfSync: true, reason: "r", key: "k-dismiss" });
    const shownBefore = toast.hidden === false;
    document.getElementById("sync-toast-dismiss").click();
    const afterDismiss = toast.hidden;
    window.__voiceboxSyncToast.update({ outOfSync: true, reason: "r", key: "k-dismiss" });
    const sameKey = toast.hidden;
    window.__voiceboxSyncToast.update({ outOfSync: true, reason: "r", key: "k-other" });
    const otherKey = toast.hidden;
    window.__voiceboxSyncToast.update({ outOfSync: false });
    return { shownBefore, afterDismiss, sameKey, otherKey };
  });
  assert.equal(dismissed.shownBefore, true, "the toast must show before dismissing");
  assert.equal(dismissed.afterDismiss, true, "dismiss must hide it");
  assert.equal(dismissed.sameKey, true, "the dismissed key must stay suppressed (dismissedSyncKey travelled with the module)");
  assert.equal(dismissed.otherKey, false, "a DIFFERENT key must still show — the memory is per key, not a blanket mute");
  // A listener-free clone must do nothing: the module listens on the element the host handed it.
  const cloneEffect = await page.evaluate(() => {
    const toast = document.getElementById("sync-toast");
    window.__voiceboxSyncToast.update({ outOfSync: true, reason: "r", key: "k-clone" });
    const clone = document.getElementById("sync-toast-dismiss").cloneNode(true);
    document.body.appendChild(clone);
    clone.click();
    const stillShown = toast.hidden === false;
    clone.remove();
    window.__voiceboxSyncToast.update({ outOfSync: false });
    return stillShown;
  });
  assert.equal(cloneEffect, true, "a clone of the dismiss control must not hide the toast: the listener is on the host-supplied element");
});

test("driven standalone, the module uses its injected deps and never reaches for the page's own dialog", async () => {
  const result = await page.evaluate(async () => {
    const { createSyncToastController } = await import("/components/sync-toast.mjs");
    const els = {
      syncToast: document.createElement("div"),
      syncToastMessage: document.createElement("p"),
      syncToastReload: document.createElement("button"),
      syncToastDismiss: document.createElement("button"),
      build: document.createElement("div"),
    };
    const listeners = [];
    const opened = [];
    const controller = createSyncToastController({
      els,
      on: (el, type) => listeners.push([el === els.syncToastReload ? "reload" : el === els.syncToastDismiss ? "dismiss" : "?", type]),
      openChangelogDialog: (trigger) => opened.push(trigger === null ? null : trigger.textContent),
    });
    controller.stampBuild({ commit: "deadbee", branch: "main", dirty: false });
    // The module's stampBuild writes into document.getElementById("build") — verbatim behaviour, it never
    // used els for that — so the link it builds is found there, not in the stub. Clicking it must call the
    // INJECTED opener, and the page's own changelog dialog must stay shut: that is what proves the module
    // takes its opener as a dependency instead of reaching for the host's.
    const link = [...document.getElementById("build").querySelectorAll("a")].find((a) => a.textContent === "change log");
    // Read the line BEFORE the second call: stampBuild rewrites #build every time it runs.
    const stampAfterFirst = document.getElementById("build").textContent;
    link?.click();
    // A mismatching page revision must drive the toast through the injected els, not a global lookup.
    controller.stampBuild({ commit: "0000000", branch: "main", dirty: true });
    return {
      listeners,
      opened,
      pageDialogOpened: document.getElementById("changelog-dialog")?.open === true,
      linkFound: Boolean(link),
      stampText: stampAfterFirst,
      toastHidden: els.syncToast.hidden,
      toastText: els.syncToastMessage.textContent,
      hasUpdate: typeof controller.update,
      hasStamp: typeof controller.stampBuild,
    };
  });

  assert.deepEqual(result.listeners, [["reload", "click"], ["dismiss", "click"]], "the module wires exactly the two toast controls");
  assert.equal(result.linkFound, true, "the stamp must build the change-log link");
  assert.deepEqual(result.opened, ["change log"], "the change-log link must call the INJECTED opener, not the page's dialog");
  assert.equal(result.pageDialogOpened, false, "clicking it must NOT open the page's own changelog dialog: the module has no other route to it");
  assert.match(result.stampText, /server main @ deadbee/, "the stamp must render the server revision it was handed");
  assert.equal(result.toastHidden, false, "a page/server revision mismatch must show the toast");
  assert.match(result.toastText, /different revisions/, "the mismatch reason must land in the injected message element");
  assert.equal(result.hasUpdate, "function", "the controller must expose update for the page global");
  assert.equal(result.hasStamp, "function", "the controller must expose stampBuild for the health poll and the initial paint");
});
