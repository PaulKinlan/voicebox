// tests/mini-app-surface-extraction.test.mjs — the interactive mini-app surface lives in
// public/components/mini-app-surface.mjs, not inline in public/fused.js (voicebox-beads-uei2.7).
//
// This is the bridge-bearing slice, so this file pins the two things a source-level move could break
// silently: (a) the HOST-side contract that kept fourteen call sites unchanged, and (b) the BRIDGE
// protocol — the handshake that validates origin AND source before it removes itself, the port it
// transfers to the frame, and the descriptor html it hands over.
//
// Owner tests keep driving the feature end to end and are unchanged: tests/mini-app-ui.test.mjs,
// tests/ui-ux-accessibility.test.mjs, tests/ux-bubble-stage.test.mjs, tests/agent-monitor-miniapp.test.mjs
// and tests/csp-report-only-browser.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "public", "components", "mini-app-surface.mjs");
const HOST_PATH = path.join(ROOT, "public", "fused.js");
const MARKER_ONE = "PROBE_APP_MARKER_ONE";
const MARKER_TWO = "PROBE_APP_MARKER_TWO";

// Distinctive strings from the moved block. They must be gone from the host, because a second copy of
// the bridge would be two handshakes racing for one frame. Two of the host's lines are deliberately NOT
// carried over verbatim (see DELIBERATE_DIFFERENCES), so they are listed as gone-from-host only.
const MOVED_MARKERS = [
  "currentChannel = new MessageChannel()",
  "function handleBridgeEvent",
  "function attachMiniAppDragHandle",
  "function removeMiniAppFromClientState",
  "pendingToolCalls",
  "onBridgeHandshake",
];
const MOVED_AND_REWRITTEN = ["  miniAppController = {", "catalogMiniApps = catalogMiniApps.filter("];

const has = (text, marker) => text.includes(marker);

function assertMovedOutOfHost(hostSource, moduleSource) {
  for (const marker of MOVED_MARKERS) {
    assert.ok(!has(hostSource, marker), `fused.js must no longer carry ${JSON.stringify(marker)}`);
    assert.ok(has(moduleSource, marker), `the extracted module must carry ${JSON.stringify(marker)}`);
  }
  for (const marker of MOVED_AND_REWRITTEN) {
    assert.ok(!has(hostSource, marker), `fused.js must no longer carry ${JSON.stringify(marker)}`);
  }
  // The two deliberate differences, asserted as differences rather than left implicit: the controller is
  // RETURNED instead of assigned into the host handle, and the catalogue goes through the accessor pair.
  assert.ok(has(moduleSource, "  return {"), "the module returns the controller instead of assigning it into a handle");
  assert.ok(has(moduleSource, "setCatalog(getCatalog().filter((item) => {"), "and reads/writes the catalogue through the injected pair");
  assert.ok(has(moduleSource, "    }));"), "with the added call closed — an unbalanced rewrite here is a syntax error, not a subtle bug");
}

function assertHostContract(hostSource, moduleSource) {
  assert.match(hostSource, /import \{ initMiniAppHost \} from "\.\/components\/mini-app-surface\.mjs";/, "the host imports the factory");
  // The handle and the Map STAY: fourteen call sites read the handle, six of them null-guarded, and the
  // Map has readers outside this surface. That is why no call site needed an edit.
  assert.match(hostSource, /let miniAppController = null;/, "the live handle stays in the host");
  assert.match(hostSource, /const launchedMiniApps = new Map\(\);/, "the shared Map stays in the host");
  assert.match(hostSource, /if \(els\.miniAppContainer\) \{\n\s*\/\/[\s\S]*?miniAppController = initMiniAppHost\(\{/, "and the env guard still wraps the init");
  assert.match(hostSource, /getCatalog: \(\) => catalogMiniApps,/, "the catalogue is handed over as a live getter");
  assert.match(hostSource, /setCatalog: \(next\) => \{ catalogMiniApps = next; \},/, "and a live setter: the delete path reassigns it, so a snapshot would silently stop working");
  assert.match(hostSource, /window\.__voiceboxMiniApp = miniAppController;/, "the page global is still assigned inside the guard (undefined when there is no container)");
  assert.match(hostSource, /const launchedMiniApps = new Map\(\);[\s\S]*?launchedMiniApps,\n\s*\}\);/, "the Map is passed in, not rebuilt");
  assert.match(moduleSource, /export function initMiniAppHost\(\{/, "the module's seam");
  assert.match(
    moduleSource,
    /return \{\s*mount,\s*close,\s*toggle,\s*expandToggle,\s*reload,\s*editCurrentMiniApp,\s*deleteCurrentMiniApp,\s*callTool,\s*getTools: \(\) => \[\.\.\.currentTools\],\s*getDescriptor: \(\) => currentDescriptor,\s*getContainer: \(\) => els\.miniAppContainer,\s*\};/,
    "the module returns the SAME eleven-member controller the host's call sites expect",
  );
}

test("the surface is in the module, gone from the host, and the host contract that saved 14 call sites holds", () => {
  const host = readFileSync(HOST_PATH, "utf8");
  const mod = readFileSync(MODULE_PATH, "utf8");
  assertMovedOutOfHost(host, mod);
  assertHostContract(host, mod);

  // NEGATIVE MUTANTS.
  const leftover = host.replace("let miniAppController = null;", "let miniAppController = null;\n  function mount() {}\n  function handleBridgeEvent() {}");
  assert.notEqual(leftover, host);
  assert.throws(() => assertMovedOutOfHost(leftover, mod), { name: "AssertionError" }, "a leftover bridge function in the host must be caught");

  const snapshotCatalog = host.replace("getCatalog: () => catalogMiniApps,", "getCatalog: catalogMiniApps,");
  assert.notEqual(snapshotCatalog, host);
  assert.throws(() => assertHostContract(snapshotCatalog, mod), { name: "AssertionError" }, "a snapshot instead of a live getter must be caught");

  const noSetter = host.replace("setCatalog: (next) => { catalogMiniApps = next; },\n", "");
  assert.notEqual(noSetter, host);
  assert.throws(() => assertHostContract(noSetter, mod), { name: "AssertionError" }, "dropping the setter must be caught: the delete path reassigns the catalogue");

  const mapRebuilt = host.replace("    launchedMiniApps,\n  });", "    launchedMiniApps: new Map(),\n  });");
  assert.notEqual(mapRebuilt, host);
  assert.throws(() => assertHostContract(mapRebuilt, mod), { name: "AssertionError" }, "rebuilding the Map must be caught: its readers outside this surface would see an empty one");

  const noGlobal = host.replace("  window.__voiceboxMiniApp = miniAppController;\n", "");
  assert.notEqual(noGlobal, host);
  assert.throws(() => assertHostContract(noGlobal, mod), { name: "AssertionError" }, "a dropped page global must be caught");

  const moduleWithoutReturn = mod.replace(/return \{\n\s*mount,/, "return {\n    notMount: mount,");
  assert.notEqual(moduleWithoutReturn, mod);
  assert.throws(() => assertHostContract(host, moduleWithoutReturn), { name: "AssertionError" }, "a controller that no longer matches the call sites must be caught");
});

let server;
let base;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "mini-app-surface-extraction-test" } });
  base = server.base;
  page = await launch();
  await page.goto(`${base}/`);
  await page.waitFor(() => Boolean(window.__voiceboxMiniApp), { label: "the host to wire the mini-app surface" });
  // Instrument the three things the bridge invariants are about, BEFORE any mount happens: the channels
  // the host opens (so a remount's close is observable), the window-level message listeners (so the
  // handshake's self-removal is observable), and nothing else.
  await page.evaluate(() => {
    const probe = { channels: [], added: [], removed: [] };
    window.__miniAppProbe = probe;
    window.__miniAppProbeReset = () => { probe.channels.length = 0; probe.added.length = 0; probe.removed.length = 0; };
    const RealMessageChannel = window.MessageChannel;
    window.MessageChannel = function MessageChannelSpy(...args) {
      const channel = new RealMessageChannel(...args);
      const record = { closed: 0 };
      probe.channels.push(record);
      const realClose = channel.port1.close.bind(channel.port1);
      channel.port1.close = function closeSpy() { record.closed += 1; return realClose(); };
      return channel;
    };
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    window.addEventListener = function addSpy(type, fn, opts) {
      if (type === "message") probe.added.push(fn);
      return realAdd(type, fn, opts);
    };
    window.removeEventListener = function removeSpy(type, fn, opts) {
      if (type === "message") probe.removed.push(fn);
      return realRemove(type, fn, opts);
    };
  });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

const installApp = (marker) =>
  page.evaluate((m) => {
    window.__voiceboxMiniApp.mount({
      appId: `probe-${m}`,
      title: `Probe ${m}`,
      fileName: `probe-${m}.html`,
      html: `<!doctype html><html><body><h1>${m}</h1></body></html>`,
    });
  }, marker);

const innerSrcdoc = () =>
  page.evaluate(() => {
    const frame = document.getElementById("mini-app-outer-frame");
    if (!frame || !frame.contentDocument) return "";
    const inner = frame.contentDocument.getElementById("inner-app");
    return inner ? inner.getAttribute("srcdoc") || "" : "";
  });

test("the real bridge completes: the descriptor html reaches the sandboxed frame, and the handshake listener removes itself", async () => {
  await page.evaluate(() => { window.__miniAppProbeReset(); document.getElementById("activity-log-clear"); });
  await installApp(MARKER_ONE);
  await page.waitFor(
    () => {
      const frame = document.getElementById("mini-app-outer-frame");
      const inner = frame && frame.contentDocument && frame.contentDocument.getElementById("inner-app");
      return Boolean(inner && (inner.getAttribute("srcdoc") || "").includes("PROBE_APP_MARKER_ONE"));
    },
    { label: "the mini-app html to cross the bridge into the sandboxed frame" },
  );

  const state = await page.evaluate(() => ({
    srcdoc: (() => {
      const frame = document.getElementById("mini-app-outer-frame");
      const inner = frame.contentDocument.getElementById("inner-app");
      return inner.getAttribute("srcdoc") || "";
    })(),
    channels: window.__miniAppProbe.channels.length,
    added: window.__miniAppProbe.added.length,
    removed: window.__miniAppProbe.removed.length,
    sameHandler: window.__miniAppProbe.removed[0] === window.__miniAppProbe.added[0],
    frames: document.querySelectorAll("#mini-app-outer-frame").length,
    src: document.getElementById("mini-app-outer-frame").getAttribute("src") || "",
  }));

  assert.match(state.srcdoc, /PROBE_APP_MARKER_ONE/, "the app html the host handed over must land in the bridge's sandboxed frame — that is mini_app_init/load_app carrying the descriptor");
  assert.match(state.src, /^\/mini-app-bridge\.html\?appId=/, "the frame must be the bridge page, named by appId");
  assert.equal(state.frames, 1, "exactly one outer frame: a second bridge would be a second handshake racing for one port");
  assert.equal(state.channels, 1, "one MessageChannel per mount — the channel whose port2 the bridge receives");
  assert.equal(state.added, 1, "the handshake installs exactly one window message listener");
  assert.equal(state.removed, 1, "and REMOVES it on success — a listener that stayed would leak a handshake per mount");
  assert.equal(state.sameHandler, true, "the removed handler is the one that was added");
});

test("a remount closes the previous port and re-delivers html — the single-use port is never reused", async () => {
  const before = await page.evaluate(() => window.__miniAppProbe.channels.length);
  await installApp(MARKER_TWO);
  await page.waitFor(
    () => {
      const frame = document.getElementById("mini-app-outer-frame");
      const inner = frame && frame.contentDocument && frame.contentDocument.getElementById("inner-app");
      return Boolean(inner && (inner.getAttribute("srcdoc") || "").includes("PROBE_APP_MARKER_TWO"));
    },
    { label: "the second app html to cross the bridge" },
  );
  const after = await page.evaluate(() => ({
    channels: window.__miniAppProbe.channels.length,
    firstClosed: window.__miniAppProbe.channels[0].closed,
    frames: document.querySelectorAll("#mini-app-outer-frame").length,
    added: window.__miniAppProbe.added.length,
    removed: window.__miniAppProbe.removed.length,
  }));

  assert.equal(after.channels, before + 1, "a remount opens a FRESH channel (a transferred port is single-use)");
  assert.equal(after.firstClosed, 1, "and closes the previous port exactly once");
  assert.equal(after.frames, 1, "the viewport still holds one frame, not two");
  assert.equal(after.added, 2, "the second mount installs its own handshake listener");
  assert.equal(after.removed, 2, "which also removes itself — no accumulation across mounts");
});

test("driven directly on the installed handler, a forged handshake is refused unless origin AND source match", async () => {
  const result = await page.evaluate(async () => {
    const { initMiniAppHost } = await import("/components/mini-app-surface.mjs");
    const div = () => document.createElement("div");
    const els = {
      miniAppContainer: div(), miniAppViewport: div(), miniAppDock: div(), miniAppBubbleTitle: div(),
      miniAppBubble: div(), miniAppSheetHandle: div(), miniAppDragHandle: div(), miniAppClose: div(),
      miniAppToggle: div(), miniAppExpand: div(), miniAppReload: div(), miniAppEdit: div(),
      miniAppDelete: div(), miniAppSourceBadge: div(), miniAppTitle: div(),
    };
    const calls = { sync: 0, getCatalog: 0, setCatalog: [] };
    const launched = new Map();
    const controller = initMiniAppHost({
      els,
      request: async () => ({ ok: true, json: async () => ({}) }),
      load: async () => {},
      isHtmlFileName: (n) => String(n).endsWith(".html"),
      normalizeMiniAppKey: (n) => `app_${String(n).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      getCatalog: () => { calls.getCatalog += 1; return []; },
      setCatalog: (next) => { calls.setCatalog.push(next); },
      syncReaderBubble: () => {},
      renderRead: () => {},
      sqehSyncMiniApps: () => { calls.sync += 1; },
      launchedMiniApps: launched,
    });

    window.__miniAppProbeReset();
    // The frame is created with the module's own hardcoded bridge URL, and a DETACHED iframe has no
    // contentWindow at all — which would make the handshake bail before it validates anything. So this
    // arm attaches the container (a browsing context exists) and neutralises the frame's src, so the real
    // bridge never loads and the handler can be driven deterministically.
    const realCreateElement = document.createElement.bind(document);
    document.createElement = (tag, ...rest) => {
      const el = realCreateElement(tag, ...rest);
      if (String(tag).toLowerCase() === "iframe") {
        Object.defineProperty(el, "src", { get: () => "about:blank", set: () => {}, configurable: true });
      }
      return el;
    };
    document.body.appendChild(els.miniAppViewport);
    controller.mount({ appId: "probe-direct", title: "Direct", fileName: "direct.html", html: "<h1>direct</h1>" });
    document.createElement = realCreateElement;
    const handler = window.__miniAppProbe.added.at(-1);
    const frame = els.miniAppViewport.firstElementChild;
    const frameWindow = frame.contentWindow;
    const forged = { origin: "https://evil.example", source: frameWindow, data: { type: "bridge_ready", appId: "probe-direct" } };
    const wrongSource = { origin: window.location.origin, source: window, data: { type: "bridge_ready", appId: "probe-direct" } };

    handler(forged);
    const afterForeignOrigin = window.__miniAppProbe.removed.length;
    handler(wrongSource);
    const afterWrongSource = window.__miniAppProbe.removed.length;
    handler({ origin: window.location.origin, source: frameWindow, data: { type: "bridge_ready", appId: "probe-direct" } });
    const afterReal = window.__miniAppProbe.removed.length;
    const removedIsTheHandler = window.__miniAppProbe.removed.at(-1) === handler;
    // The handler is gone now. Call it DIRECTLY again and you would bypass the removal entirely and hit
    // DataCloneError on the port it already transferred — so the honest check is a real dispatched event:
    // if the listener were still attached, this would run the body a second time and change nothing here.
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "bridge_ready", appId: "probe-direct" },
      origin: window.location.origin,
      source: frameWindow,
    }));
    const afterReplay = window.__miniAppProbe.removed.length;

    // The delete path is where the catalogue is REASSIGNED, so it is the honest test of the accessor pair.
    window.fetch = async () => ({ ok: true, json: async () => ({}) });
    const before = { get: calls.getCatalog, set: calls.setCatalog.length };
    controller.mount({ appId: "probe-del", title: "Delete Me", fileName: "delete-me.html", html: "<h1>bye</h1>" });
    const sizeBeforeDelete = launched.size;
    await controller.deleteCurrentMiniApp();
    const after = { get: calls.getCatalog, set: calls.setCatalog.length };
    const sizeAfterDelete = launched.size;
    const delStillPresent = launched.has("probe-del");
    delete window.fetch;

    // Clean up: the handshake listeners this standalone instance installed on the REAL window, and the
    // stub container this arm attached to the document.
    for (const fn of window.__miniAppProbe.added) window.removeEventListener("message", fn);
    els.miniAppViewport.remove();

    return { afterForeignOrigin, afterWrongSource, afterReal, removedIsTheHandler, afterReplay, before, after, sizeBeforeDelete, sizeAfterDelete, delStillPresent, syncCalls: calls.sync, hasMount: typeof controller.mount, hasGetContainer: controller.getContainer() === els.miniAppContainer };
  });

  assert.equal(result.afterForeignOrigin, 0, "a handshake from a foreign origin must be refused, even with the right source");
  assert.equal(result.afterWrongSource, 0, "a handshake from the right origin but the WRONG window must be refused — this is the check that stops any page posting a port into the surface");
  assert.equal(result.afterReal, 1, "the real handshake (both checks true) proceeds exactly once");
  assert.equal(result.removedIsTheHandler, true, "and removes itself by the same reference");
  assert.equal(result.afterReplay, 1, "a real re-dispatch after removal changes nothing: the listener is genuinely detached, not merely a handler we stopped calling");
  assert.ok(result.after.get > result.before.get, "the delete path reads the catalogue through the injected getter");
  assert.ok(result.after.set > result.before.set, "and writes it back through the injected setter — the only reason a reassigning caller still works");
  assert.equal(result.sizeBeforeDelete, 2, "the injected Map is the one the surface fills, not a private copy");
  assert.equal(result.sizeAfterDelete, 1, "and the one it empties again on delete");
  assert.equal(result.delStillPresent, false, "the deleted app is gone from the injected Map");
  assert.ok(result.syncCalls >= 2, "mount calls the injected sqehSyncMiniApps at the end, as it did inline");
  assert.equal(result.hasMount, "function", "the controller exposes mount");
  assert.equal(result.hasGetContainer, true, "and getContainer returns the container it was handed");
});
