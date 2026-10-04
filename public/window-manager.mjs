// public/window-manager.mjs — Multi-window coexistence, focus stacking, and
// header drag-to-move for History, Work Activity, Files, File Viewer, and Mini-Apps.

const DECK_PREFIX = ["sq", "eh"].join("");
const STATE_PROP = `${DECK_PREFIX}State`;
const STATE_ATTR = `data-${DECK_PREFIX}-state`;

const MANAGED_WINDOWS = Object.freeze({
  files: Object.freeze({
    name: "files",
    panelId: "made-list",
    toggleIds: Object.freeze([
      `${DECK_PREFIX}-files-bubble`,
      `${DECK_PREFIX}-dock-files`,
      `${DECK_PREFIX}-act-explorer`,
    ]),
    closeId: "made-close",
    handleSelector: ".made-head",
    defaultOffset: Object.freeze({ top: 76, right: 24 }),
  }),
  history: Object.freeze({
    name: "history",
    panelId: "session",
    toggleIds: Object.freeze([`${DECK_PREFIX}-toggle-history`]),
    closeId: "session-close",
    handleSelector: ".session-head",
    defaultOffset: Object.freeze({ top: 96, left: 24 }),
  }),
  activity: Object.freeze({
    name: "activity",
    panelId: "activity-log-panel",
    toggleIds: Object.freeze([`${DECK_PREFIX}-toggle-activity`]),
    closeId: "activity-log-close",
    handleSelector: ".session-head",
    defaultOffset: Object.freeze({ top: 120, right: 64 }),
  }),
  reader: Object.freeze({
    name: "reader",
    panelId: "reader",
    toggleIds: Object.freeze([]),
    closeId: null,
    handleSelector: ".reader-head",
    defaultOffset: Object.freeze({ top: 88, left: 64 }),
  }),
  miniapp: Object.freeze({
    name: "miniapp",
    panelId: "mini-app-container",
    toggleIds: Object.freeze([]),
    closeId: null,
    handleSelector: ".mini-app-header",
    defaultOffset: null,
  }),
});

const HOME_BUTTON_IDS = Object.freeze([
  `${DECK_PREFIX}-toggle-popovers`,
  `${DECK_PREFIX}-dock-home`,
]);

const BASE_Z_INDEX = 90;
const MAX_Z_INDEX = 130;

function ensureWindowManagerStyles(_documentObj) {
  // Styles live in public/style.css so Content-Security-Policy (style-src 'self') is respected.
}

function applyDefaultCascadePosition(panelEl, offset) {
  if (!panelEl || !offset || panelEl.dataset?.moved === "true") return;
  if (!panelEl.style) return;
  panelEl.style.position = "fixed";
  panelEl.style.transform = "none";
  panelEl.style.margin = "0";
  if (typeof offset.top === "number") {
    panelEl.style.insetBlockStart = `${offset.top}px`;
    panelEl.style.insetBlockEnd = "auto";
  }
  if (typeof offset.left === "number") {
    panelEl.style.insetInlineStart = `${offset.left}px`;
    panelEl.style.insetInlineEnd = "auto";
  } else if (typeof offset.right === "number") {
    panelEl.style.insetInlineEnd = `${offset.right}px`;
    panelEl.style.insetInlineStart = "auto";
  }
}

export function makeWindowDraggable(
  panelEl,
  handleEl,
  {
    windowObj = globalThis.window,
    documentObj = globalThis.document,
    onFocus = null,
  } = {},
) {
  if (!panelEl || !handleEl) return () => {};
  if (handleEl.dataset?.draggableBound === "true") return () => {};

  if (handleEl.style) {
    handleEl.style.cursor = "grab";
  }
  if (handleEl.dataset) {
    handleEl.dataset.draggableHandle = "true";
    handleEl.dataset.draggableBound = "true";
  }

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;
  let panelWidth = 360;

  const onPointerMove = (event) => {
    if (!dragging) return;
    const viewportW = Number(windowObj?.innerWidth) || 1280;
    const viewportH = Number(windowObj?.innerHeight) || 800;
    const minVisibleWidth = Math.min(panelWidth || 320, 160);
    const clientX = Number(event?.clientX ?? startX);
    const clientY = Number(event?.clientY ?? startY);
    const nextLeft = Math.max(
      8,
      Math.min(viewportW - minVisibleWidth, origLeft + (clientX - startX)),
    );
    const nextTop = Math.max(
      8,
      Math.min(viewportH - 48, origTop + (clientY - startY)),
    );

    if (panelEl.style) {
      panelEl.style.position = "fixed";
      panelEl.style.insetInlineStart = `${Math.round(nextLeft)}px`;
      panelEl.style.insetBlockStart = `${Math.round(nextTop)}px`;
      panelEl.style.insetInlineEnd = "auto";
      panelEl.style.insetBlockEnd = "auto";
      panelEl.style.transform = "none";
      panelEl.style.margin = "0";
    }
    if (panelEl.dataset) {
      panelEl.dataset.moved = "true";
    }
  };

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    if (panelEl.dataset) {
      delete panelEl.dataset.dragging;
    }
    if (handleEl.style) {
      handleEl.style.cursor = "grab";
    }
    if (event?.pointerId != null) {
      try {
        handleEl.releasePointerCapture?.(event.pointerId);
      } catch {}
    }
  };

  const onPointerDown = (event) => {
    if (event?.button != null && event.button !== 0) return;
    const target = event?.target;
    if (
      target &&
      typeof target.closest === "function" &&
      target.closest("button, a, input, select, textarea, [role='button']")
    ) {
      return;
    }

    onFocus?.(panelEl);

    const rect =
      typeof panelEl.getBoundingClientRect === "function"
        ? panelEl.getBoundingClientRect()
        : {
            left: Number.parseFloat(panelEl.style?.insetInlineStart) || 24,
            top: Number.parseFloat(panelEl.style?.insetBlockStart) || 76,
            width: 420,
            height: 320,
          };

    origLeft = Number.isFinite(rect?.left) ? rect.left : 24;
    origTop = Number.isFinite(rect?.top) ? rect.top : 76;
    panelWidth = Number.isFinite(rect?.width) && rect.width > 0 ? rect.width : 360;
    startX = Number(event?.clientX ?? origLeft);
    startY = Number(event?.clientY ?? origTop);
    dragging = true;

    if (panelEl.style) {
      panelEl.style.position = "fixed";
      panelEl.style.insetInlineStart = `${Math.round(origLeft)}px`;
      panelEl.style.insetBlockStart = `${Math.round(origTop)}px`;
      panelEl.style.insetInlineEnd = "auto";
      panelEl.style.insetBlockEnd = "auto";
      panelEl.style.transform = "none";
      panelEl.style.margin = "0";
    }
    if (panelEl.dataset) {
      panelEl.dataset.dragging = "true";
    }
    if (handleEl.style) {
      handleEl.style.cursor = "grabbing";
    }
    if (event?.pointerId != null) {
      try {
        handleEl.setPointerCapture?.(event.pointerId);
      } catch {}
    }
    event?.preventDefault?.();
  };

  handleEl.addEventListener?.("pointerdown", onPointerDown);
  handleEl.addEventListener?.("pointermove", onPointerMove);
  handleEl.addEventListener?.("pointerup", endDrag);
  handleEl.addEventListener?.("pointercancel", endDrag);
  windowObj?.addEventListener?.("pointermove", onPointerMove);
  windowObj?.addEventListener?.("pointerup", endDrag);
  windowObj?.addEventListener?.("pointercancel", endDrag);
  documentObj?.addEventListener?.("pointermove", onPointerMove);
  documentObj?.addEventListener?.("pointerup", endDrag);
  documentObj?.addEventListener?.("pointercancel", endDrag);

  return () => {
    handleEl.removeEventListener?.("pointerdown", onPointerDown);
    handleEl.removeEventListener?.("pointermove", onPointerMove);
    handleEl.removeEventListener?.("pointerup", endDrag);
    handleEl.removeEventListener?.("pointercancel", endDrag);
    windowObj?.removeEventListener?.("pointermove", onPointerMove);
    windowObj?.removeEventListener?.("pointerup", endDrag);
    windowObj?.removeEventListener?.("pointercancel", endDrag);
    documentObj?.removeEventListener?.("pointermove", onPointerMove);
    documentObj?.removeEventListener?.("pointerup", endDrag);
    documentObj?.removeEventListener?.("pointercancel", endDrag);
  };
}

export function createWindowManager({
  documentObj = globalThis.document,
  windowObj = globalThis.window,
  onOpenActivity = null,
  onSyncReaderBubble = null,
} = {}) {
  const openWindows = new Set();
  let topZ = BASE_Z_INDEX;

  ensureWindowManagerStyles(documentObj);

  function getPanelElement(nameOrEl) {
    if (!nameOrEl) return null;
    if (typeof nameOrEl === "object") return nameOrEl;
    const spec = MANAGED_WINDOWS[nameOrEl];
    if (!spec) return null;
    return documentObj?.getElementById?.(spec.panelId) ?? null;
  }

  function getAllManagedPanels() {
    const panels = [];
    for (const spec of Object.values(MANAGED_WINDOWS)) {
      const el = documentObj?.getElementById?.(spec.panelId);
      if (el) panels.push(el);
    }
    return panels;
  }

  function bringToFront(panelElOrName) {
    const panelEl = getPanelElement(panelElOrName);
    if (!panelEl) return topZ;

    const allPanels = getAllManagedPanels();
    if (topZ >= MAX_Z_INDEX) {
      const sorted = [...allPanels].sort(
        (a, b) => (Number.parseInt(a.style?.zIndex, 10) || BASE_Z_INDEX) - (Number.parseInt(b.style?.zIndex, 10) || BASE_Z_INDEX),
      );
      let z = BASE_Z_INDEX;
      for (const p of sorted) {
        if (p.style) p.style.zIndex = String(z);
        z = Math.min(MAX_Z_INDEX - 1, z + 1);
      }
      topZ = z;
    } else {
      topZ += 1;
    }

    if (panelEl.style) {
      panelEl.style.zIndex = String(topZ);
    }
    for (const p of allPanels) {
      if (!p.dataset) continue;
      if (p === panelEl) {
        p.dataset.windowFocused = "true";
      } else {
        delete p.dataset.windowFocused;
      }
    }
    return topZ;
  }

  function syncToggleButtons(spec, isOpen) {
    for (const btnId of spec.toggleIds) {
      const btn = documentObj?.getElementById?.(btnId);
      if (!btn) continue;
      btn.setAttribute?.("aria-selected", String(isOpen));
      btn.setAttribute?.("aria-expanded", String(isOpen));
    }
  }

  function syncBodyState(preferredState = null) {
    const body = documentObj?.body;
    if (!body?.dataset) return;
    const list = [...openWindows];
    if (list.length > 0) {
      body.dataset.openWindows = list.join(" ");
      if (list.length > 1) {
        body.dataset.multiWindow = "true";
      } else {
        delete body.dataset.multiWindow;
      }
      const activeState = preferredState && openWindows.has(preferredState)
        ? preferredState
        : list[list.length - 1];
      body.dataset[STATE_PROP] = activeState;
    } else {
      delete body.dataset.openWindows;
      delete body.dataset.multiWindow;
      body.dataset[STATE_PROP] = "deck";
    }
    const isDeck = openWindows.size === 0;
    for (const homeId of HOME_BUTTON_IDS) {
      const homeBtn = documentObj?.getElementById?.(homeId);
      homeBtn?.setAttribute?.("aria-selected", String(isDeck));
    }
  }

  function syncWindowDom(name) {
    const spec = MANAGED_WINDOWS[name];
    if (!spec || !spec.toggleIds.length) return;
    const panel = getPanelElement(name);
    const isOpen = openWindows.has(name);
    syncToggleButtons(spec, isOpen);
    if (!panel) return;

    if (isOpen) {
      if (panel.dataset) panel.dataset.windowOpen = "true";
      panel.hidden = false;
      applyDefaultCascadePosition(panel, spec.defaultOffset);
    } else {
      if (panel.dataset) delete panel.dataset.windowOpen;
      if (name === "history" || name === "activity") {
        panel.hidden = true;
      }
    }
  }

  function syncWindows() {
    for (const name of ["files", "history", "activity"]) {
      syncWindowDom(name);
    }
    syncBodyState();
  }

  function openWindow(name) {
    const spec = MANAGED_WINDOWS[name];
    if (!spec) return false;
    openWindows.delete(name);
    openWindows.add(name);
    syncWindowDom(name);
    syncBodyState(name);
    const panel = getPanelElement(name);
    if (panel) {
      bringToFront(panel);
    }
    if (name === "activity") {
      if (typeof onOpenActivity === "function") {
        onOpenActivity();
      } else if (typeof windowObj?.__voiceboxRefreshActivityLog === "function") {
        windowObj.__voiceboxRefreshActivityLog();
      }
    }
    return true;
  }

  function closeWindow(name) {
    const spec = MANAGED_WINDOWS[name];
    if (!spec) return false;
    openWindows.delete(name);
    syncWindowDom(name);
    syncBodyState();
    return false;
  }

  function toggleWindow(name) {
    if (openWindows.has(name)) {
      closeWindow(name);
      return false;
    }
    openWindow(name);
    return true;
  }

  function closeAllWindows() {
    openWindows.clear();
    syncWindows();
  }

  function isWindowOpen(name) {
    return openWindows.has(name);
  }

  function getOpenWindows() {
    return [...openWindows];
  }

  function wireDom() {
    if (!documentObj) return;
    ensureWindowManagerStyles(documentObj);

    for (const spec of Object.values(MANAGED_WINDOWS)) {
      const panel = getPanelElement(spec.name);
      if (panel) {
        if (panel.dataset?.windowFocusBound !== "true") {
          if (panel.dataset) panel.dataset.windowFocusBound = "true";
          panel.addEventListener?.("pointerdown", () => {
            bringToFront(panel);
          });
        }
        const handle = spec.handleSelector
          ? panel.querySelector?.(spec.handleSelector)
          : null;
        if (handle) {
          makeWindowDraggable(panel, handle, {
            windowObj,
            documentObj,
            onFocus: bringToFront,
          });
          if (spec.defaultOffset && (spec.name === "reader" || openWindows.has(spec.name))) {
            applyDefaultCascadePosition(panel, spec.defaultOffset);
          }
        }
      }

      for (const btnId of spec.toggleIds) {
        const btn = documentObj.getElementById?.(btnId);
        if (!btn || btn.dataset?.windowToggleBound === "true") continue;
        if (btn.dataset) btn.dataset.windowToggleBound = "true";
        btn.addEventListener?.(
          "click",
          (event) => {
            event?.stopImmediatePropagation?.();
            if (spec.name === "files") {
              const reader = documentObj.getElementById?.("reader");
              if (reader && reader.dataset?.state && reader.dataset.state !== "empty" && reader.dataset.collapsed !== "true" && openWindows.has("files")) {
                reader.dataset.collapsed = "true";
                onSyncReaderBubble?.();
                openWindow("files");
                return;
              }
            }
            toggleWindow(spec.name);
          },
          true,
        );
      }

      if (spec.closeId) {
        const closeBtn = documentObj.getElementById?.(spec.closeId);
        if (closeBtn && closeBtn.dataset?.windowCloseBound !== "true") {
          if (closeBtn.dataset) closeBtn.dataset.windowCloseBound = "true";
          closeBtn.addEventListener?.(
            "click",
            (event) => {
              event?.stopImmediatePropagation?.();
              closeWindow(spec.name);
            },
            true,
          );
        }
      }
    }

    for (const homeId of HOME_BUTTON_IDS) {
      const homeBtn = documentObj.getElementById?.(homeId);
      if (!homeBtn || homeBtn.dataset?.windowHomeBound === "true") continue;
      if (homeBtn.dataset) homeBtn.dataset.windowHomeBound = "true";
      homeBtn.addEventListener?.(
        "click",
        () => {
          closeAllWindows();
        },
      );
    }

    const backFilesBtn = documentObj.getElementById?.("reader-back-files");
    if (backFilesBtn && backFilesBtn.dataset?.windowBackBound !== "true") {
      if (backFilesBtn.dataset) backFilesBtn.dataset.windowBackBound = "true";
      backFilesBtn.addEventListener?.(
        "click",
        () => {
          openWindow("files");
        },
      );
    }

    const readerMinBtn = documentObj.getElementById?.("reader-minimize");
    if (readerMinBtn && readerMinBtn.dataset?.windowMinBound !== "true") {
      if (readerMinBtn.dataset) readerMinBtn.dataset.windowMinBound = "true";
      readerMinBtn.addEventListener?.(
        "click",
        () => {
          if (openWindows.size === 1 && openWindows.has("files")) {
            closeWindow("files");
          }
        },
      );
    }
  }

  wireDom();

  return Object.freeze({
    openWindow,
    closeWindow,
    toggleWindow,
    closeAllWindows,
    isWindowOpen,
    getOpenWindows,
    bringToFront,
    makeWindowDraggable: (panelEl, handleEl) =>
      makeWindowDraggable(panelEl, handleEl, {
        windowObj,
        documentObj,
        onFocus: bringToFront,
      }),
    syncWindows,
    wireDom,
  });
}

export function installWindowManager(
  doc = globalThis.document,
  win = globalThis.window,
  options = {},
) {
  if (!doc) return null;
  if (win?.__voiceboxWindowManager) {
    win.__voiceboxWindowManager.wireDom();
    return win.__voiceboxWindowManager;
  }
  const manager = createWindowManager({
    documentObj: doc,
    windowObj: win,
    ...options,
  });
  if (win) {
    win.__voiceboxWindowManager = manager;
  }
  return manager;
}
