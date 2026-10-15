// public/components/deck-controller.mjs — SQEH deck navigation, sheet, and tile controller (voicebox-beads-uei2.13)
// Extracted from public/fused.js.
// Manages:
// - SQEH 3-state system interface: "deck", "files", "history", "activity"
// - Syncing Quick Files tiles and Mini-App tray bubbles
// - Popover sheet opening/closing
// - Navigation click listeners, outside-click and Escape dismissal
// - Window manager initialization and file list observer

export function createDeckController({
  document = globalThis.document,
  window = globalThis.window,
  els = {},
  getCatalogMiniApps = () => [],
  getMiniAppController = () => null,
  getLaunchedMiniApps = () => new Map(),
  syncReaderBubble = () => {},
  refreshActivityLog = () => {},
  clearActivityLog = () => {},
  normalizeMiniAppKey = (k) => String(k || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
  launchWorkspaceHtmlMiniApp = async () => {},
  installWindowManager = null,
} = {}) {
  // If an existing controller is already active on this window, dispose it to avoid duplicate listeners (voicebox-beads-zw8d)
  if (window?.__voiceboxDeckControllerActive?.dispose) {
    try {
      window.__voiceboxDeckControllerActive.dispose();
    } catch {}
  }

  const controller = new AbortController();
  const { signal } = controller;
  const unsubs = [];

  function on(target, type, fn, options = {}) {
    if (!target) return;
    const opts = typeof options === "boolean" ? { capture: options } : { ...options };
    try {
      target.addEventListener(type, fn, { ...opts, signal });
    } catch {
      target.addEventListener(type, fn, opts);
    }
    unsubs.push(() => {
      try {
        target.removeEventListener?.(type, fn, opts);
      } catch {}
    });
  }

  let state = "deck";

  const collapseOpenReader = () => {
    const reader = els.reader ?? document.getElementById("reader");
    if (reader && reader.dataset?.state !== "empty" && reader.dataset?.collapsed !== "true") {
      reader.dataset.collapsed = "true";
      syncReaderBubble();
      return true;
    }
    return false;
  };

  const toggleFilesPopover = () => {
    if (collapseOpenReader()) {
      setState("files");
      return;
    }
    setState(state === "files" ? "deck" : "files");
  };

  function setState(nextState, { scroll = false } = {}) {
    state = nextState;
    if (document.body) {
      document.body.dataset.sqehState = nextState;
    }
    const wm = window.__voiceboxWindowManager;
    if (wm) {
      if (nextState === "deck") {
        wm.closeAllWindows?.();
      } else if (nextState === "files" || nextState === "history" || nextState === "activity") {
        wm.openWindow?.(nextState);
      }
    }
    const pop = document.getElementById("sqeh-toggle-popovers");
    const hist = document.getElementById("sqeh-toggle-history");
    const act = document.getElementById("sqeh-toggle-activity");
    const filesBubble = document.getElementById("sqeh-files-bubble");
    const dockFiles = document.getElementById("sqeh-dock-files");
    const madeList = document.getElementById("made-list");
    const session = document.getElementById("session");
    const activityPanel = document.getElementById("activity-log-panel");
    const isFiles = nextState === "files" || madeList?.dataset?.windowOpen === "true";
    const isHistory = nextState === "history" || session?.dataset?.windowOpen === "true";
    const isActivity = nextState === "activity" || activityPanel?.dataset?.windowOpen === "true";

    if (pop) pop.setAttribute("aria-selected", String(!isFiles && !isHistory && !isActivity && nextState === "deck"));
    if (hist) {
      hist.setAttribute("aria-selected", String(isHistory));
      hist.setAttribute("aria-expanded", String(isHistory));
    }
    if (act) {
      act.setAttribute("aria-selected", String(isActivity));
      act.setAttribute("aria-expanded", String(isActivity));
    }
    if (filesBubble) {
      filesBubble.setAttribute("aria-selected", String(isFiles));
      filesBubble.setAttribute("aria-expanded", String(isFiles));
    }
    if (dockFiles) {
      dockFiles.setAttribute("aria-expanded", String(isFiles));
    }
    if (session) {
      if (isHistory) {
        session.hidden = false;
        if (scroll && nextState === "history") session.scrollIntoView?.({ block: "start" });
      } else {
        session.hidden = true;
      }
    }
    if (activityPanel) {
      if (isActivity) {
        activityPanel.hidden = false;
        if (nextState === "activity") void refreshActivityLog();
        if (scroll && nextState === "activity") activityPanel.scrollIntoView?.({ block: "start" });
      } else {
        activityPanel.hidden = true;
      }
    }
  }

  function openSheet(open) {
    const sheet = document.getElementById("sqeh-sheet");
    if (!sheet) return;
    sheet.hidden = !open;
    const sys = document.getElementById("sqeh-dock-systems");
    if (sys) sys.setAttribute("aria-expanded", String(open));
  }

  let miniAppsController = null;
  function syncMiniApps() {
    const host = document.getElementById("sqeh-actions");
    if (!host) return;
    miniAppsController?.abort();
    miniAppsController = new AbortController();
    const miniAppsSignal = miniAppsController.signal;

    const attachScopedClick = (el, fn) => {
      try {
        el.addEventListener("click", fn, { signal: miniAppsSignal });
      } catch {
        el.addEventListener("click", fn);
      }
    };

    const seenAppIds = new Set();
    const seenTitles = new Set();
    const seenNormKeys = new Set();
    const buttons = [];

    const markSeen = (appId, title, fileName) => {
      if (appId) seenAppIds.add(String(appId));
      if (title) seenTitles.add(String(title).toLowerCase());
      if (fileName) seenTitles.add(String(fileName).toLowerCase());
      const n1 = normalizeMiniAppKey(fileName || title || appId);
      if (n1) seenNormKeys.add(n1);
    };

    const isAlreadySeen = (appId, title, fileName) => {
      if (appId && seenAppIds.has(String(appId))) return true;
      if (title && seenTitles.has(String(title).toLowerCase())) return true;
      if (fileName && seenTitles.has(String(fileName).toLowerCase())) return true;
      const n1 = normalizeMiniAppKey(fileName || title || appId);
      if (n1 && seenNormKeys.has(n1)) return true;
      return false;
    };

    const catalog = getCatalogMiniApps?.() ?? [];
    for (const item of catalog) {
      if (!item) continue;
      if (item.kind === "page") continue;
      const appId = item.appId || item.id || normalizeMiniAppKey(item.fileName || item.title);
      const label = item.title || item.fileName || appId;
      if (isAlreadySeen(appId, label, item.fileName)) continue;
      markSeen(appId, label, item.fileName);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sqeh-miniapp-bubble";
      btn.dataset.miniAppId = appId;
      if (item.fileName) btn.dataset.miniAppFile = item.fileName;
      const badge = document.createElement("span");
      badge.className = "sqeh-miniapp-bubble-badge";
      badge.textContent = item.sandbox ? String(item.sandbox) : "App";
      const title = document.createElement("span");
      title.className = "sqeh-miniapp-bubble-title";
      title.textContent = label;
      btn.append(badge, title);
      attachScopedClick(btn, async () => {
        const controller = getMiniAppController?.();
        if (!controller) return;
        if (typeof item.html === "string" && item.html) {
          controller.mount(item);
          return;
        }
        try {
          const res = await fetch(`/api/mini-apps?id=${encodeURIComponent(appId)}`);
          if (res.ok) {
            const data = await res.json().catch(() => null);
            const payload = data?.miniApp || data;
            if (payload && typeof payload.html === "string") {
              controller.mount({ ...item, ...payload });
              return;
            }
          }
        } catch {}
        if (item.fileName) {
          await launchWorkspaceHtmlMiniApp(item.fileName);
        }
      });
      buttons.push(btn);
    }

    const launched = getLaunchedMiniApps?.() ?? new Map();
    for (const [appId, desc] of launched.entries()) {
      if (isAlreadySeen(appId, desc.title, desc.fileName)) continue;
      markSeen(appId, desc.title, desc.fileName);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sqeh-miniapp-bubble";
      btn.dataset.miniAppId = appId;
      if (desc.fileName) btn.dataset.miniAppFile = desc.fileName;
      const badge = document.createElement("span");
      badge.className = "sqeh-miniapp-bubble-badge";
      badge.textContent = desc.sandbox ? String(desc.sandbox) : "App";
      const title = document.createElement("span");
      title.className = "sqeh-miniapp-bubble-title";
      title.textContent = desc.title;
      btn.append(badge, title);
      attachScopedClick(btn, () => {
        const controller = getMiniAppController?.();
        if (!controller) return;
        const current = controller.getDescriptor?.();
        const container = controller.getContainer?.();
        if (current?.appId === appId && container && !container.hidden) {
          if (container.dataset.collapsed === "true") controller.toggle?.();
        } else {
          controller.mount(desc);
        }
      });
      buttons.push(btn);
    }

    host.replaceChildren(...buttons);
  }

  let quickFilesController = null;
  function syncQuickFiles() {
    const host = document.getElementById("sqeh-quick-files");
    const allRows = [...document.querySelectorAll("#files .file-open")];
    const badge = document.getElementById("sqeh-files-badge");
    if (badge) badge.textContent = String(allRows.length);
    if (host) {
      quickFilesController?.abort();
      quickFilesController = new AbortController();
      const quickFilesSignal = quickFilesController.signal;

      const attachQuickClick = (el, fn) => {
        try {
          el.addEventListener("click", fn, { signal: quickFilesSignal });
        } catch {
          el.addEventListener("click", fn);
        }
      };

      const rows = allRows.slice(0, 8);
      host.replaceChildren(
        ...rows.map((row) => {
          const tile = document.createElement("button");
          tile.type = "button";
          tile.className = "sqeh-file-tile";
          tile.dataset.file = row.dataset.file ?? "";
          const name = document.createElement("span");
          name.className = "sqeh-tile-name";
          name.textContent = row.dataset.file ?? "(file)";
          const when = document.createElement("span");
          when.className = "sqeh-tile-when";
          when.textContent = row.dataset.kind === "directory" ? "folder" : "file";
          tile.append(name, when);
          attachQuickClick(tile, () => {
            setState("files");
            row.click();
          });
          return tile;
        }),
      );
    }
    syncMiniApps();
  }

  // Navigation click listeners
  const pop = document.getElementById("sqeh-toggle-popovers");
  const hist = document.getElementById("sqeh-toggle-history");
  const act = document.getElementById("sqeh-toggle-activity");
  const filesBubble = document.getElementById("sqeh-files-bubble");
  const readerBubble = document.getElementById("sqeh-reader-bubble");

  on(pop, "click", () => {
    collapseOpenReader();
    setState("deck");
  });
  on(hist, "click", () => {
    collapseOpenReader();
    setState(state === "history" ? "deck" : "history");
  });
  on(act, "click", () => {
    collapseOpenReader();
    setState(state === "activity" ? "deck" : "activity");
  });
  on(document.getElementById("session-close"), "click", () => {
    const session = document.getElementById("session");
    if (session) session.hidden = true;
    setState("deck");
  });
  on(document.getElementById("activity-log-close"), "click", () => {
    const activityPanel = document.getElementById("activity-log-panel");
    if (activityPanel) activityPanel.hidden = true;
    setState("deck");
  });
  on(document.getElementById("activity-log-clear"), "click", () => {
    clearActivityLog();
  });
  on(filesBubble, "click", toggleFilesPopover);
  on(readerBubble, "click", () => {
    const reader = els.reader ?? document.getElementById("reader");
    if (!reader || reader.dataset.state === "empty") return;
    if (reader.dataset.collapsed === "true") {
      delete reader.dataset.collapsed;
      syncReaderBubble();
    } else {
      reader.dataset.collapsed = "true";
      syncReaderBubble();
      if (state === "files") setState("deck");
    }
  });
  on(document.getElementById("reader-minimize"), "click", () => {
    const reader = els.reader ?? document.getElementById("reader");
    if (!reader || reader.dataset.state === "empty") return;
    reader.dataset.collapsed = "true";
    syncReaderBubble();
    if (state === "files") setState("deck");
  });
  on(document.getElementById("reader-back-files"), "click", () => {
    const reader = els.reader ?? document.getElementById("reader");
    if (reader && reader.dataset.state !== "empty") {
      reader.dataset.collapsed = "true";
      syncReaderBubble();
    }
    setState("files");
  });
  on(document.getElementById("made-close"), "click", () => setState("deck"));
  on(document.getElementById("sqeh-dock-home"), "click", () => {
    collapseOpenReader();
    setState("deck");
  });
  on(document.getElementById("sqeh-dock-systems"), "click", () => {
    const sheet = document.getElementById("sqeh-sheet");
    openSheet(sheet?.hidden !== false);
  });
  on(document.getElementById("sqeh-sheet-close"), "click", () => openSheet(false));
  on(document.getElementById("sqeh-act-mute"), "click", () => {
    const mic = document.getElementById("mic");
    const capturing = mic?.getAttribute("aria-pressed") === "true";
    if (capturing) {
      mic?.click();
      setState("deck");
    }
  });
  on(document.getElementById("sqeh-act-explorer"), "click", toggleFilesPopover);
  on(document.getElementById("sqeh-dock-files"), "click", toggleFilesPopover);

  // Light-dismiss the floating Files, History, or Activity popover on Escape or outside click
  let lastDialogDismissAt = 0;
  on(
    document,
    "close",
    (ev) => {
      if (ev.target?.tagName === "DIALOG") lastDialogDismissAt = performance.now();
    },
    true,
  );
  on(
    document,
    "cancel",
    (ev) => {
      if (ev.target?.tagName === "DIALOG") lastDialogDismissAt = performance.now();
    },
    true,
  );
  on(window, "keydown", (e) => {
    const openCount = window.__voiceboxWindowManager?.getOpenWindows?.()?.length ?? 0;
    if (e.key === "Escape" && (openCount > 0 || state === "files" || state === "history" || state === "activity")) {
      const anyModal =
        document.querySelector?.("dialog[open]") ||
        e.target?.closest?.("dialog") ||
        (lastDialogDismissAt > 0 && performance.now() - lastDialogDismissAt < 150);
      if (!anyModal) setState("deck");
    }
  });
  on(document, "pointerdown", (e) => {
    const target = e.target;
    const insideAllowed = target?.closest?.(
      "#made-list, #reader, #session, #activity-log-panel, #mini-app-container, #sqeh-deck, #sqeh-dock, #sqeh-sheet, dialog[open]",
    );
    if (insideAllowed) return;
    const openCount = window.__voiceboxWindowManager?.getOpenWindows?.()?.length ?? 0;
    if (openCount === 1 && (state === "files" || state === "activity")) {
      setState("deck");
    } else if (openCount === 0 && (state === "files" || state === "activity")) {
      setState("deck");
    }
  });

  // Quick Files sync: the file list is the source of truth; refresh the tiles when it changes.
  let filesObserver = null;
  const files = document.getElementById("files");
  if (files && typeof MutationObserver === "function") {
    filesObserver = new MutationObserver(() => syncQuickFiles());
    filesObserver.observe(files, { childList: true, subtree: true });
  }

  // Initial sync
  syncQuickFiles();

  // Install window manager if provided
  if (typeof installWindowManager === "function") {
    installWindowManager(document, window, {
      onOpenActivity: () => void refreshActivityLog(),
      onSyncReaderBubble: () => syncReaderBubble(),
    });
  }

  // Initial state on paint
  setState("deck");

  const instance = {
    setState,
    openSheet,
    syncMiniApps,
    syncQuickFiles,
    collapseOpenReader,
    getState: () => state,
    dispose: () => {
      filesObserver?.disconnect();
      miniAppsController?.abort();
      miniAppsController = null;
      quickFilesController?.abort();
      quickFilesController = null;
      try {
        controller.abort();
      } catch {}
      while (unsubs.length) {
        try {
          unsubs.pop()();
        } catch {}
      }
      if (window?.__voiceboxDeckControllerActive === instance) {
        window.__voiceboxDeckControllerActive = null;
      }
    },
  };

  if (window) {
    window.__voiceboxDeckControllerActive = instance;
  }

  return instance;
}
