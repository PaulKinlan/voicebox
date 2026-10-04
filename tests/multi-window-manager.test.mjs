// tests/multi-window-manager.test.mjs — Unit tests for simultaneous multi-window
// coexistence, z-index focus stacking, and header drag-to-move (voicebox-beads-od4p).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWindowManager,
  installWindowManager,
  makeWindowDraggable,
} from "../public/window-manager.mjs";
import * as plainLanguage from "../tools/rendered-plain-language.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_MANAGER_PATH = path.resolve(__dirname, "../public/window-manager.mjs");

function scanSourcePlainLanguage(sourceText) {
  if (typeof plainLanguage.scanPlainLanguage === "function") {
    return plainLanguage.scanPlainLanguage(sourceText);
  }
  const stripped = sourceText
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const literals = [
    ...stripped.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g),
  ].map((m) => m[1] ?? m[2] ?? m[3] ?? "");

  const hits = [];
  const bannedBeadIds = /\b(od4p|sqeh|okgg|wc8c|maeu)\b/i;
  const bannedJargon = /\b(sandbox|iframe|srcdoc|opfs|ipc|json|rpc|wasm|idempotence|worktree)\b/i;

  for (const lit of literals) {
    for (const hit of plainLanguage.identifiersInRenderedText(lit, new Set())) {
      hits.push(hit);
    }
    const beadMatch = lit.match(bannedBeadIds);
    if (beadMatch) {
      hits.push({ token: beadMatch[0], label: "bead-id-in-literal" });
    }
    const jargonMatch = lit.match(bannedJargon);
    if (jargonMatch) {
      hits.push({ token: jargonMatch[0], label: "banned-jargon-in-literal" });
    }
  }
  return hits;
}

function createMockElement(tagName = "div", id = "") {
  const listeners = new Map();
  const attributes = new Map();
  const children = [];
  let rect = { left: 40, top: 80, width: 480, height: 320 };

  const el = {
    tagName: tagName.toUpperCase(),
    id,
    className: "",
    hidden: false,
    dataset: {},
    style: {},
    children,
    parentElement: null,
    textContent: "",
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    appendChild(child) {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      const ev = {
        target: el,
        currentTarget: el,
        button: 0,
        stopped: false,
        stopImmediatePropagation() {
          this.stopped = true;
        },
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...event,
      };
      const list = [...(listeners.get(ev.type) ?? [])];
      for (const fn of list) {
        fn(ev);
        if (ev.stopped) break;
      }
      return !ev.defaultPrevented;
    },
    click() {
      this.dispatchEvent({ type: "click", target: el });
    },
    getBoundingClientRect() {
      return { ...rect };
    },
    setMockRect(nextRect) {
      rect = { ...rect, ...nextRect };
    },
    querySelector(selector) {
      if (selector.startsWith(".")) {
        const cls = selector.slice(1);
        return children.find((c) => c.className.split(/\s+/).includes(cls)) ?? null;
      }
      return null;
    },
    closest(selector) {
      const selectors = selector.split(",").map((s) => s.trim().toLowerCase());
      let cur = el;
      while (cur) {
        const tag = cur.tagName?.toLowerCase();
        if (selectors.includes(tag)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
  };
  return el;
}

function createWindowFixture() {
  const byId = new Map();
  const docListeners = new Map();
  const winListeners = new Map();

  const register = (el) => {
    if (el.id) byId.set(el.id, el);
    return el;
  };

  const head = createMockElement("head");
  const body = createMockElement("body");

  // Panels + drag handles + header buttons
  const madeList = register(createMockElement("section", "made-list"));
  madeList.className = "made";
  const madeHead = createMockElement("div");
  madeHead.className = "made-head";
  const madeClose = register(createMockElement("button", "made-close"));
  madeHead.appendChild(madeClose);
  madeList.appendChild(madeHead);
  madeList.setMockRect({ left: 680, top: 76, width: 520, height: 420 });

  const session = register(createMockElement("section", "session"));
  session.className = "session";
  session.hidden = true;
  const sessionHead = createMockElement("div");
  sessionHead.className = "session-head";
  const sessionClose = register(createMockElement("button", "session-close"));
  sessionHead.appendChild(sessionClose);
  session.appendChild(sessionHead);
  session.setMockRect({ left: 24, top: 96, width: 480, height: 360 });

  const activityPanel = register(createMockElement("section", "activity-log-panel"));
  activityPanel.className = "activity-panel";
  activityPanel.hidden = true;
  const activityHead = createMockElement("div");
  activityHead.className = "session-head";
  const activityClose = register(createMockElement("button", "activity-log-close"));
  activityHead.appendChild(activityClose);
  activityPanel.appendChild(activityHead);
  activityPanel.setMockRect({ left: 260, top: 120, width: 560, height: 400 });

  const reader = register(createMockElement("section", "reader"));
  reader.className = "reader";
  reader.dataset.state = "ready";
  const readerHead = createMockElement("div");
  readerHead.className = "reader-head";
  const readerBackFiles = register(createMockElement("button", "reader-back-files"));
  readerHead.appendChild(readerBackFiles);
  reader.appendChild(readerHead);
  reader.setMockRect({ left: 64, top: 88, width: 580, height: 460 });

  const miniApp = register(createMockElement("section", "mini-app-container"));
  miniApp.className = "mini-app";
  const miniAppHeader = createMockElement("div");
  miniAppHeader.className = "mini-app-header";
  miniApp.appendChild(miniAppHeader);

  // Toggle buttons
  const filesBubble = register(createMockElement("button", "sqeh-files-bubble"));
  const dockFiles = register(createMockElement("button", "sqeh-dock-files"));
  const actExplorer = register(createMockElement("button", "sqeh-act-explorer"));
  const toggleHistory = register(createMockElement("button", "sqeh-toggle-history"));
  const toggleActivity = register(createMockElement("button", "sqeh-toggle-activity"));
  const togglePopovers = register(createMockElement("button", "sqeh-toggle-popovers"));
  const dockHome = register(createMockElement("button", "sqeh-dock-home"));

  const documentObj = {
    head,
    body,
    createElement(tag) {
      return createMockElement(tag);
    },
    getElementById(id) {
      return byId.get(id) ?? null;
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      for (const fn of [...(docListeners.get(event.type) ?? [])]) {
        fn(event);
      }
    },
  };

  const windowObj = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      for (const fn of [...(winListeners.get(event.type) ?? [])]) {
        fn(event);
      }
    },
  };

  return {
    documentObj,
    windowObj,
    elements: {
      madeList,
      madeHead,
      madeClose,
      session,
      sessionHead,
      sessionClose,
      activityPanel,
      activityHead,
      activityClose,
      reader,
      readerHead,
      readerBackFiles,
      miniApp,
      miniAppHeader,
      filesBubble,
      dockFiles,
      actExplorer,
      toggleHistory,
      toggleActivity,
      togglePopovers,
      dockHome,
    },
  };
}

test("Multi-window coexistence: Files, History, and Activity can all be open at the same time", () => {
  const { documentObj, windowObj, elements } = createWindowFixture();
  let activityRefreshCount = 0;

  const wm = installWindowManager(documentObj, windowObj, {
    onOpenActivity: () => {
      activityRefreshCount += 1;
    },
  });

  // 1. Click Files bubble -> Files window opens
  elements.filesBubble.click();
  assert.equal(wm.isWindowOpen("files"), true);
  assert.equal(elements.madeList.dataset.windowOpen, "true");
  assert.equal(elements.madeList.hidden, false);
  assert.equal(elements.filesBubble.getAttribute("aria-selected"), "true");
  assert.equal(elements.dockFiles.getAttribute("aria-expanded"), "true");
  assert.equal(documentObj.body.dataset.sqehState, "files");

  // 2. Click History button -> History opens AND Files remains open!
  elements.toggleHistory.click();
  assert.equal(wm.isWindowOpen("files"), true);
  assert.equal(wm.isWindowOpen("history"), true);
  assert.equal(elements.madeList.dataset.windowOpen, "true");
  assert.equal(elements.session.hidden, false);
  assert.equal(elements.session.dataset.windowOpen, "true");
  assert.equal(elements.toggleHistory.getAttribute("aria-selected"), "true");
  assert.equal(documentObj.body.dataset.sqehState, "history");
  assert.equal(documentObj.body.dataset.openWindows, "files history");

  // 3. Click Activity button -> Activity opens AND both Files and History remain open!
  elements.toggleActivity.click();
  assert.equal(activityRefreshCount, 1);
  assert.equal(wm.isWindowOpen("files"), true);
  assert.equal(wm.isWindowOpen("history"), true);
  assert.equal(wm.isWindowOpen("activity"), true);
  assert.equal(elements.madeList.dataset.windowOpen, "true");
  assert.equal(elements.session.hidden, false);
  assert.equal(elements.activityPanel.hidden, false);
  assert.equal(elements.activityPanel.dataset.windowOpen, "true");
  assert.equal(elements.reader.dataset.state, "ready");
  assert.equal(documentObj.body.dataset.sqehState, "activity");
  assert.equal(documentObj.body.dataset.openWindows, "files history activity");

  // 4. Closing Activity leaves Files and History open and falls back sqehState to "history"
  elements.activityClose.click();
  assert.equal(wm.isWindowOpen("activity"), false);
  assert.equal(elements.activityPanel.hidden, true);
  assert.equal(wm.isWindowOpen("files"), true);
  assert.equal(wm.isWindowOpen("history"), true);
  assert.equal(elements.madeList.dataset.windowOpen, "true");
  assert.equal(elements.session.hidden, false);
  assert.equal(documentObj.body.dataset.sqehState, "history");

  // 5. Clicking Home closes all windows and resets sqehState to "deck"
  elements.togglePopovers.click();
  assert.deepEqual(wm.getOpenWindows(), []);
  assert.equal(elements.session.hidden, true);
  assert.equal(elements.activityPanel.hidden, true);
  assert.equal(elements.madeList.dataset.windowOpen, undefined);
  assert.equal(documentObj.body.dataset.sqehState, "deck");
});

test("Focus z-index stacking: clicking any window brings it to the front above other open windows", () => {
  const { documentObj, windowObj, elements } = createWindowFixture();
  const wm = createWindowManager({ documentObj, windowObj });

  wm.openWindow("files");
  wm.openWindow("history");
  wm.openWindow("activity");

  const zFilesInitial = Number(elements.madeList.style.zIndex);
  const zHistoryInitial = Number(elements.session.style.zIndex);
  const zActivityInitial = Number(elements.activityPanel.style.zIndex);
  assert.ok(zFilesInitial < zHistoryInitial);
  assert.ok(zHistoryInitial < zActivityInitial);
  assert.equal(elements.activityPanel.dataset.windowFocused, "true");

  // Clicking on the Files panel elevates its z-index above Activity and marks it focused
  elements.madeList.dispatchEvent({ type: "pointerdown", target: elements.madeList });
  const zFilesAfterClick = Number(elements.madeList.style.zIndex);
  assert.ok(zFilesAfterClick > zActivityInitial);
  assert.equal(elements.madeList.dataset.windowFocused, "true");
  assert.equal(elements.activityPanel.dataset.windowFocused, undefined);

  // Clicking on the Reader panel elevates its z-index above Files
  elements.reader.dispatchEvent({ type: "pointerdown", target: elements.reader });
  const zReaderAfterClick = Number(elements.reader.style.zIndex);
  assert.ok(zReaderAfterClick > zFilesAfterClick);
  assert.ok(zReaderAfterClick <= 130, "window z-index must stay below modal dialogs at 140");
  assert.equal(elements.reader.dataset.windowFocused, "true");
  assert.equal(elements.madeList.dataset.windowFocused, undefined);
});

test("Draggable windows: dragging a window header moves the window while clicking header buttons does not drag", () => {
  const { documentObj, windowObj, elements } = createWindowFixture();
  createWindowManager({ documentObj, windowObj });

  assert.equal(elements.madeHead.style.cursor, "grab");
  assert.equal(elements.madeHead.dataset.draggableHandle, "true");
  assert.equal(elements.activityHead.style.cursor, "grab");
  assert.equal(elements.activityHead.dataset.draggableHandle, "true");

  // 1. Clicking the Close button inside .made-head must NOT start a drag
  elements.madeHead.dispatchEvent({
    type: "pointerdown",
    target: elements.madeClose,
    clientX: 700,
    clientY: 90,
  });
  assert.equal(elements.madeList.dataset.dragging, undefined);
  assert.equal(elements.madeList.dataset.moved, undefined);

  // 2. Dragging .made-head updates insetInlineStart / insetBlockStart and sets dataset.moved = "true"
  elements.madeList.setMockRect({ left: 680, top: 76, width: 520, height: 420 });
  elements.madeHead.dispatchEvent({
    type: "pointerdown",
    target: elements.madeHead,
    clientX: 700,
    clientY: 90,
    pointerId: 1,
  });
  assert.equal(elements.madeList.dataset.dragging, "true");
  assert.equal(elements.madeHead.style.cursor, "grabbing");

  windowObj.dispatchEvent({
    type: "pointermove",
    clientX: 500,
    clientY: 190,
    pointerId: 1,
  });
  assert.equal(elements.madeList.style.position, "fixed");
  assert.equal(elements.madeList.style.insetInlineStart, "480px");
  assert.equal(elements.madeList.style.insetBlockStart, "176px");
  assert.equal(elements.madeList.style.insetInlineEnd, "auto");
  assert.equal(elements.madeList.style.transform, "none");
  assert.equal(elements.madeList.dataset.moved, "true");

  windowObj.dispatchEvent({
    type: "pointerup",
    clientX: 500,
    clientY: 190,
    pointerId: 1,
  });
  assert.equal(elements.madeList.dataset.dragging, undefined);
  assert.equal(elements.madeHead.style.cursor, "grab");

  // 3. Dragging #activity-log-panel .session-head also moves the activity window and clamps to viewport bounds
  elements.activityPanel.setMockRect({ left: 260, top: 120, width: 560, height: 400 });
  elements.activityHead.dispatchEvent({
    type: "pointerdown",
    target: elements.activityHead,
    clientX: 300,
    clientY: 140,
    pointerId: 2,
  });
  windowObj.dispatchEvent({
    type: "pointermove",
    clientX: 420,
    clientY: 240,
    pointerId: 2,
  });
  assert.equal(elements.activityPanel.style.insetInlineStart, "380px");
  assert.equal(elements.activityPanel.style.insetBlockStart, "220px");
  assert.equal(elements.activityPanel.dataset.moved, "true");
  windowObj.dispatchEvent({ type: "pointerup", pointerId: 2 });

  // Standalone makeWindowDraggable export works on custom panels too
  const customPanel = createMockElement("div", "custom-panel");
  const customHandle = createMockElement("div", "custom-handle");
  customPanel.appendChild(customHandle);
  const cleanup = makeWindowDraggable(customPanel, customHandle, { windowObj, documentObj });
  assert.equal(typeof cleanup, "function");
  cleanup();
});

test("Plain-language gate: public/window-manager.mjs has zero identifier or jargon hits", () => {
  const raw = fs.readFileSync(WINDOW_MANAGER_PATH, "utf8");
  const hits = scanSourcePlainLanguage(raw);
  assert.deepEqual(
    hits,
    [],
    `public/window-manager.mjs must not contain ticket ids or banned jargon in string literals: ${JSON.stringify(hits)}`,
  );
});
