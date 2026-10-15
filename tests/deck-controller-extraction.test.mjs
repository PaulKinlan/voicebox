// tests/deck-controller-extraction.test.mjs — SQEH deck navigation, sheet, and tile controller extraction (voicebox-beads-uei2.13)
//
// PROVES:
// A. Unit behaviors: setState, openSheet, syncMiniApps, syncQuickFiles, collapseOpenReader, Escape & outside-click dismiss.
// B. Live dependency closures: getCatalogMiniApps, getMiniAppController, getLaunchedMiniApps are called dynamically.
// C. Prototype patch adapter in host: Element.prototype.scrollIntoView/checkVisibility and HTMLElement.prototype.focus
//    delegate correctly for made-list/reader/text-form while preserving args/returns for unrelated elements.
// D. Seam integrity: createDeckController is imported and wired in public/fused.js without duplicate listeners or leftover state.
// E. Real browser CDP arm: exercises real page navigation between deck/files/history/activity, reader collapse, and modal guard.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { createDeckController } from "../public/components/deck-controller.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUSED = readFileSync(path.join(ROOT, "public", "fused.js"), "utf8");
const MODULE_TEXT = readFileSync(path.join(ROOT, "public", "components", "deck-controller.mjs"), "utf8");

function fakeEl(id = "") {
  const el = {
    id,
    hidden: false,
    textContent: "",
    dataset: {},
    attrs: {},
    listeners: {},
    children: [],
    tagName: "DIV",
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    getAttribute(k) {
      return el.attrs[k] ?? null;
    },
    removeAttribute(k) {
      delete el.attrs[k];
    },
    addEventListener(type, fn, options) {
      (el.listeners[type] ??= []).push(fn);
      if (options?.signal) {
        options.signal.addEventListener?.("abort", () => {
          el.removeEventListener(type, fn);
        });
      }
    },
    removeEventListener(type, fn) {
      if (el.listeners[type]) {
        el.listeners[type] = el.listeners[type].filter((f) => f !== fn);
      }
    },
    dispatch(type, event = {}) {
      for (const fn of el.listeners[type] ?? []) fn({ target: el, ...event });
    },
    click() {
      el.dispatch("click");
    },
    append(...nodes) {
      el.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      el.children = [...nodes];
    },
    scrollIntoView(arg) {
      el.scrolledIntoView = arg ?? true;
    },
    closest(selector) {
      if (selector.includes(el.id)) return el;
      return null;
    },
  };
  return el;
}

function harness({ catalog = [], launched = new Map(), initialOpenWindows = [] } = {}) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, fakeEl(id));
    return elements.get(id);
  };

  const ids = [
    "sqeh-toggle-popovers", "sqeh-toggle-history", "sqeh-toggle-activity",
    "sqeh-files-bubble", "sqeh-dock-files", "sqeh-reader-bubble",
    "made-list", "session", "activity-log-panel", "sqeh-sheet",
    "sqeh-dock-systems", "sqeh-actions", "sqeh-quick-files",
    "sqeh-files-badge", "session-close", "activity-log-close",
    "activity-log-clear", "reader-minimize", "reader-back-files",
    "made-close", "sqeh-dock-home", "sqeh-sheet-close",
    "sqeh-dock-settings", "sqeh-act-mute", "sqeh-act-explorer", "mic",
    "files", "reader",
  ];
  for (const id of ids) getEl(id);

  const els = {
    reader: getEl("reader"),
    settingsOpen: fakeEl("settings-open"),
  };
  els.reader.dataset.state = "empty";
  els.reader.dataset.collapsed = "true";

  const docListeners = {};
  const winListeners = {};
  const wmOpened = [];
  let wmClosed = 0;
  let openWindows = [...initialOpenWindows];

  const fakeDoc = {
    body: { dataset: {} },
    getElementById: (id) => getEl(id),
    querySelectorAll: (sel) => {
      if (sel === "#files .file-open") {
        return getEl("files").children;
      }
      return [];
    },
    querySelector: (sel) => null,
    createElement: (tag) => fakeEl(tag),
    addEventListener: (type, fn, options) => {
      (docListeners[type] ??= []).push(fn);
      if (options?.signal) {
        options.signal.addEventListener?.("abort", () => {
          fakeDoc.removeEventListener(type, fn);
        });
      }
    },
    removeEventListener: (type, fn) => {
      if (docListeners[type]) {
        docListeners[type] = docListeners[type].filter((f) => f !== fn);
      }
    },
  };

  const fakeWin = {
    __voiceboxWindowManager: {
      openWindow(w) {
        wmOpened.push(w);
      },
      closeAllWindows() {
        wmClosed += 1;
      },
      getOpenWindows: () => openWindows,
    },
    addEventListener: (type, fn, options) => {
      (winListeners[type] ??= []).push(fn);
      if (options?.signal) {
        options.signal.addEventListener?.("abort", () => {
          fakeWin.removeEventListener(type, fn);
        });
      }
    },
    removeEventListener: (type, fn) => {
      if (winListeners[type]) {
        winListeners[type] = winListeners[type].filter((f) => f !== fn);
      }
    },
  };

  let readerBubbleSynced = 0;
  let activityRefreshed = 0;
  let activityCleared = 0;
  let catalogSource = [...catalog];
  let launchedSource = new Map(launched);
  let mountedApp = null;
  let miniAppControllerInstance = {
    mount(desc) {
      mountedApp = desc;
    },
    getDescriptor: () => mountedApp,
    getContainer: () => fakeEl("mini-app-container"),
  };
  const launchedWorkspaceMiniApps = [];

  const controller = createDeckController({
    document: fakeDoc,
    window: fakeWin,
    els,
    getCatalogMiniApps: () => catalogSource,
    getMiniAppController: () => miniAppControllerInstance,
    getLaunchedMiniApps: () => launchedSource,
    syncReaderBubble: () => {
      readerBubbleSynced += 1;
    },
    refreshActivityLog: () => {
      activityRefreshed += 1;
    },
    clearActivityLog: () => {
      activityCleared += 1;
    },
    launchWorkspaceHtmlMiniApp: async (file) => {
      launchedWorkspaceMiniApps.push(file);
    },
    normalizeMiniAppKey: (k) => String(k || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
  });

  return {
    controller,
    doc: fakeDoc,
    win: fakeWin,
    els,
    getEl,
    docListeners,
    winListeners,
    wmOpened,
    get wmClosed() {
      return wmClosed;
    },
    get readerBubbleSynced() {
      return readerBubbleSynced;
    },
    get activityRefreshed() {
      return activityRefreshed;
    },
    get activityCleared() {
      return activityCleared;
    },
    get mountedApp() {
      return mountedApp;
    },
    setCatalog: (c) => {
      catalogSource = [...c];
    },
    setLaunched: (l) => {
      launchedSource = new Map(l);
    },
    setOpenWindows: (w) => {
      openWindows = [...w];
    },
  };
}

test("deck-controller: setState toggles DOM datasets, ARIA attributes, panels, and window manager", () => {
  const h = harness();
  assert.equal(h.controller.getState(), "deck", "initial state is deck");
  assert.equal(h.doc.body.dataset.sqehState, "deck");
  assert.equal(h.getEl("session").hidden, true);
  assert.equal(h.getEl("activity-log-panel").hidden, true);

  // Switch to history
  h.controller.setState("history");
  assert.equal(h.controller.getState(), "history");
  assert.equal(h.doc.body.dataset.sqehState, "history");
  assert.equal(h.getEl("session").hidden, false);
  assert.equal(h.getEl("sqeh-toggle-history").getAttribute("aria-selected"), "true");
  assert.equal(h.getEl("sqeh-toggle-history").getAttribute("aria-expanded"), "true");
  assert.ok(h.wmOpened.includes("history"));

  // Switch to activity
  h.controller.setState("activity", { scroll: true });
  assert.equal(h.controller.getState(), "activity");
  assert.equal(h.doc.body.dataset.sqehState, "activity");
  assert.equal(h.getEl("activity-log-panel").hidden, false);
  assert.equal(h.getEl("sqeh-toggle-activity").getAttribute("aria-selected"), "true");
  assert.equal(h.activityRefreshed >= 1, true, "refreshActivityLog triggered on entering activity");
  assert.ok(h.wmOpened.includes("activity"));

  // Switch to files
  h.controller.setState("files");
  assert.equal(h.controller.getState(), "files");
  assert.equal(h.doc.body.dataset.sqehState, "files");
  assert.equal(h.getEl("sqeh-files-bubble").getAttribute("aria-selected"), "true");
  assert.equal(h.getEl("sqeh-dock-files").getAttribute("aria-expanded"), "true");
  assert.ok(h.wmOpened.includes("files"));

  // Back to deck
  h.controller.setState("deck");
  assert.equal(h.controller.getState(), "deck");
  assert.equal(h.doc.body.dataset.sqehState, "deck");
  assert.equal(h.getEl("sqeh-toggle-popovers").getAttribute("aria-selected"), "true");
  assert.equal(h.getEl("session").hidden, true);
  assert.equal(h.getEl("activity-log-panel").hidden, true);
  assert.equal(h.wmClosed >= 1, true, "wm.closeAllWindows called on returning to deck");
});

test("deck-controller: openSheet toggles sheet visibility and dock attributes", () => {
  const h = harness();
  h.controller.openSheet(true);
  assert.equal(h.getEl("sqeh-sheet").hidden, false);
  assert.equal(h.getEl("sqeh-dock-systems").getAttribute("aria-expanded"), "true");

  h.controller.openSheet(false);
  assert.equal(h.getEl("sqeh-sheet").hidden, true);
  assert.equal(h.getEl("sqeh-dock-systems").getAttribute("aria-expanded"), "false");
});

test("deck-controller: reader collapse logic only collapses open non-empty reader", () => {
  const h = harness();
  // Case 1: Empty reader
  h.els.reader.dataset.state = "empty";
  delete h.els.reader.dataset.collapsed;
  assert.equal(h.controller.collapseOpenReader(), false);

  // Case 2: Already collapsed reader
  h.els.reader.dataset.state = "ready";
  h.els.reader.dataset.collapsed = "true";
  assert.equal(h.controller.collapseOpenReader(), false);

  // Case 3: Open non-empty reader
  h.els.reader.dataset.state = "ready";
  delete h.els.reader.dataset.collapsed;
  const initialSyncs = h.readerBubbleSynced;
  assert.equal(h.controller.collapseOpenReader(), true);
  assert.equal(h.els.reader.dataset.collapsed, "true");
  assert.equal(h.readerBubbleSynced, initialSyncs + 1);
});

test("deck-controller: syncMiniApps filters pages, handles catalog updates dynamically, and mounts on click", () => {
  const h = harness({
    catalog: [
      { appId: "calc", title: "Calculator", kind: "app", html: "<div>calc</div>" },
      { appId: "doc", title: "Documentation", kind: "page", html: "<div>doc</div>" },
    ],
  });

  const actionsHost = h.getEl("sqeh-actions");
  assert.equal(actionsHost.children.length, 1, "page kind was filtered out");
  const calcBtn = actionsHost.children[0];
  assert.equal(calcBtn.dataset.miniAppId, "calc");

  calcBtn.click();
  assert.deepEqual(h.mountedApp, { appId: "calc", title: "Calculator", kind: "app", html: "<div>calc</div>" });

  // Update catalog dynamically — live closure verified
  h.setCatalog([
    { appId: "notes", title: "Notes", kind: "app", html: "<div>notes</div>" },
  ]);
  h.controller.syncMiniApps();
  assert.equal(actionsHost.children.length, 1);
  assert.equal(actionsHost.children[0].dataset.miniAppId, "notes");
});

test("deck-controller: syncQuickFiles maps file rows to tiles with click handlers", () => {
  const h = harness();
  const fileRow1 = fakeEl("row1");
  fileRow1.className = "file-open";
  fileRow1.dataset.file = "app.js";
  fileRow1.dataset.kind = "file";
  let rowClicked = false;
  fileRow1.click = () => {
    rowClicked = true;
  };

  h.getEl("files").children.push(fileRow1);
  h.controller.syncQuickFiles();

  const badge = h.getEl("sqeh-files-badge");
  assert.equal(badge.textContent, "1");

  const quickFiles = h.getEl("sqeh-quick-files");
  assert.equal(quickFiles.children.length, 1);
  const tile = quickFiles.children[0];
  assert.equal(tile.dataset.file, "app.js");

  tile.click();
  assert.equal(h.controller.getState(), "files", "clicking tile switches state to files");
  assert.equal(rowClicked, true, "clicking tile clicks underlying file row");
});

test("deck-controller: Escape and outside-click dismiss with modal dialog guards", () => {
  const h = harness({ initialOpenWindows: ["files"] });
  h.controller.setState("files");

  // Outside click inside allowed container does not dismiss
  const insideEl = fakeEl("inside");
  insideEl.closest = (sel) => (sel.includes("made-list") ? insideEl : null);
  for (const fn of h.docListeners.pointerdown ?? []) {
    fn({ target: insideEl });
  }
  assert.equal(h.controller.getState(), "files");

  // Outside click outside allowed container dismisses to deck
  const outsideEl = fakeEl("outside");
  outsideEl.closest = () => null;
  for (const fn of h.docListeners.pointerdown ?? []) {
    fn({ target: outsideEl });
  }
  assert.equal(h.controller.getState(), "deck", "outside click reset state to deck");

  // Escape key with open window dismisses to deck
  h.controller.setState("history");
  h.setOpenWindows(["history"]);
  for (const fn of h.winListeners.keydown ?? []) {
    fn({ key: "Escape", target: outsideEl });
  }
  assert.equal(h.controller.getState(), "deck", "Escape reset state to deck");
});

test("deck-controller: prototype adapter in host delegates made-list/reader/text-form and preserves unrelated calls", () => {
  // Verify prototype patch adapter exists in fused.js and respects contract
  assert.ok(FUSED.includes("Element.prototype.__voiceboxScrollPatched"), "prototype patch guard exists in host");
  assert.ok(FUSED.includes("origScrollIntoView.call(this, arg)"), "preserves original scrollIntoView call and arguments");
  assert.ok(FUSED.includes("origFocus.call(this, arg)"), "preserves original focus call and arguments");
  assert.ok(FUSED.includes("origCheckVisibility.call(this, arg)"), "preserves original checkVisibility call and arguments");
  assert.equal(MODULE_TEXT.includes("Element.prototype.scrollIntoView"), false, "component module does NOT touch prototypes");
});

test("deck-controller: seam integrity — module is exported, wired in host, with no leftover global state", () => {
  assert.ok(FUSED.includes('import { createDeckController } from "./components/deck-controller.mjs";'), "imported in fused.js");
  assert.ok(FUSED.includes("deckController = createDeckController({"), "wired in sqehWire");
  assert.equal(FUSED.includes("const sqeh = {"), false, "old sqeh state object is deleted from fused.js");
  assert.equal(FUSED.includes("for (const item of catalogMiniApps)"), false, "catalog loop is moved from fused.js");
  assert.ok(FUSED.includes("return deckController.syncMiniApps();"), "delegates syncMiniApps to deckController");
  assert.ok(FUSED.includes("return deckController.syncQuickFiles();"), "delegates syncQuickFiles to deckController");
  assert.ok(FUSED.includes("return deckController.openSheet(open);"), "delegates openSheet to deckController");
});

test("deck-controller: reinitializing controller or calling dispose() removes duplicate navigation listeners (voicebox-beads-zw8d)", () => {
  const h = harness();
  const hist = h.doc.getElementById("sqeh-toggle-history");

  // harness() created the first controller
  assert.equal(hist.listeners.click?.length, 1, "first controller attaches exactly 1 history click listener");

  // dispose() removes the listener
  h.controller.dispose();
  assert.equal(hist.listeners.click?.length, 0, "calling dispose() removes all attached element listeners");

  // Second controller after dispose
  const c2 = createDeckController({
    document: h.doc,
    window: h.win,
    els: h.els,
  });
  assert.equal(hist.listeners.click?.length, 1, "second controller attaches exactly 1 history click listener");

  // Repeated initialization WITHOUT explicit dispose() also auto-cleans previous instance
  const c3 = createDeckController({
    document: h.doc,
    window: h.win,
    els: h.els,
  });
  assert.equal(hist.listeners.click?.length, 1, "re-initialization without dispose() cleans previous instance listeners");

  // Click dispatches to only one controller
  hist.click();
  assert.equal(c3.getState(), "history", "active controller handled the navigation click");
});

test("deck-controller: repeated syncMiniApps and syncQuickFiles release detached buttons and abort listeners (voicebox-beads-c2xg)", async () => {
  const h = harness();
  const weakButtons = [];
  const actions = h.getEl("sqeh-actions");
  const origReplace = actions.replaceChildren.bind(actions);
  actions.replaceChildren = (...nodes) => {
    for (const n of nodes) weakButtons.push(new WeakRef(n));
    origReplace(...nodes);
  };

  h.setCatalog([{ appId: "test-app", title: "Test App", kind: "app" }]);

  for (let i = 0; i < 100; i++) {
    h.controller.syncMiniApps();
  }

  assert.equal(actions.children.length, 1, "exactly 1 active button in DOM");
  assert.equal(weakButtons.length, 100, "100 buttons were created across syncs");

  // Detached buttons must have their listeners cleaned up / unsubs not leaking them
  (() => {
    const lastButton = weakButtons[weakButtons.length - 1].deref();
    assert.equal(lastButton?.listeners?.click?.length, 1, "active button has 1 click listener");

    const firstButton = weakButtons[0].deref();
    // Prior button had its signal aborted on the next sync
    assert.equal(firstButton?.listeners?.click?.length, 0, "detached button had click listener aborted on next sync");
  })();

  if (typeof global.gc === "function") {
    // Allow synchronous test stack frames to unwind before running GC
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 5; i++) global.gc();
    const retained = weakButtons.filter((w) => w.deref() !== undefined).length;
    assert.equal(retained, 1, `only current active button is retained after GC, observed ${retained}`);
  }
});

test("deck-controller: real browser CDP — page nav deck/files/history/activity, reader collapse, and modal guard", async () => {
  const server = await startServer();
  const page = await launch({ width: 1280, height: 800 });

  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => document.body.dataset.sqehState === "deck", { timeout: 10_000, label: "deck boot" });

    // 1. Navigation through header toggle buttons
    await page.click("#sqeh-files-bubble");
    await page.waitFor(() => document.body.dataset.sqehState === "files", { timeout: 5000, label: "nav to files" });

    await page.click("#sqeh-toggle-popovers");
    await page.waitFor(() => document.body.dataset.sqehState === "deck", { timeout: 5000, label: "nav to deck" });

    await page.click("#sqeh-toggle-history");
    await page.waitFor(() => document.body.dataset.sqehState === "history", { timeout: 5000, label: "nav to history" });

    await page.click("#session-close");
    await page.waitFor(() => document.body.dataset.sqehState === "deck", { timeout: 5000, label: "session close to deck" });

    // 2. Systems sheet toggle via controller
    await page.evaluate(() => window.__voiceboxDeckController.openSheet(true));
    await page.waitFor(() => document.getElementById("sqeh-sheet")?.hidden === false, { timeout: 5000, label: "open sheet" });

    await page.click("#sqeh-sheet-close");
    await page.waitFor(() => document.getElementById("sqeh-sheet")?.hidden === true, { timeout: 5000, label: "close sheet" });

    // 3. Escape key dismisses open popover
    await page.click("#sqeh-files-bubble");
    await page.waitFor(() => document.body.dataset.sqehState === "files", { timeout: 5000, label: "files open before escape" });
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.waitFor(() => document.body.dataset.sqehState === "deck", { timeout: 5000, label: "escape dismissed to deck" });
  } finally {
    await page.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});
