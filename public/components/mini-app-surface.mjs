// public/components/mini-app-surface.mjs — the interactive mini-app surface, extracted from
// public/fused.js (voicebox-beads-uei2.7, the bridge-bearing slice of the decomposition scoped in
// voicebox-beads-uei2).
//
// OWNS: the mini-app card (mount/close/toggle/expand/reload/edit/delete), the tool catalogue the
// card exposes (sync/register/call with its pending-call correlation), and the BRIDGE to the
// sandboxed app: the #mini-app-outer-frame iframe pointing at /mini-app-bridge.html, the
// MessageChannel whose port2 is transferred to that frame, the origin+source-validated handshake
// that completes it, and the descriptor html it hands over.
//
// WHAT THE HOST KEEPS, and why the exports here are shaped around it:
//   * `let miniAppController = null` stays in the host as the live handle, because fourteen call
//     sites across the host read it and six of them are null-guarded. The host assigns this
//     factory's return into that handle, so no call site changed; `window.__voiceboxMiniApp` is
//     still assigned inside the host's own `if (els.miniAppContainer)` guard, so a page without
//     the container still leaves the global undefined and the controller null, exactly as before.
//   * `launchedMiniApps` also stays in the host (it has readers outside this surface) and is
//     passed in as the same Map, because it is only ever mutated in place, never reassigned.
//   * `catalogMiniApps` is read AND reassigned by the delete path, so it arrives as an ACCESSOR
//     PAIR (getCatalog/setCatalog) rather than a snapshot: a snapshot would silently stop a
//     deletion from updating the catalogue.
//   * `sqehSyncMiniApps` is declared after this surface in the host and the shell calls back into
//     the controller, so it is injected as a callback and called at the same point in mount.
//
// THE BRIDGE IS THE RISKY PART and is left exactly as it was, in order: close the previous port,
// build the frame, open a fresh MessageChannel, attach port1, install a WINDOW-level handshake
// listener that validates BOTH e.origin and e.source before it removes itself, then transfer port2
// (single-use: a second transfer of the same port throws DataCloneError) and post load_app plus
// mini_app_init. tests/mini-app-host-extraction.test.mjs pins each of those invariants.
export function initMiniAppHost({
  els,
  request,
  load,
  isHtmlFileName,
  normalizeMiniAppKey,
  getCatalog,
  setCatalog,
  syncReaderBubble,
  renderRead,
  sqehSyncMiniApps,
  launchedMiniApps,
}) {
  let currentDescriptor = null;
  let currentChannel = null;
  let currentTools = [];
  let isCollapsed = false;
  let isExpanded = false;
  const pendingToolCalls = new Map();
  let nextToolCallId = 1;

  async function syncMiniAppTools(appId, tools) {
    try {
      await request("/api/mini-app/tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: appId || "active-room-app",
          title: currentDescriptor?.title || "Interactive Mini-App",
          tools: Array.isArray(tools) ? tools : [],
        }),
      });
    } catch { /* best-effort sync */ }
  }

  function handleBridgeEvent(data) {
    if (!data) return;
    if ((data.type === "tools_updated" || data.type === "app_ready") && Array.isArray(data.tools)) {
      currentTools = data.tools;
      if (window.__voiceboxMiniAppRegistry) {
        window.__voiceboxMiniAppRegistry.updateTools("active-room-app", data.tools);
      }
    } else if (data.type === "tool_result" && data.callId && pendingToolCalls.has(data.callId)) {
      const entry = pendingToolCalls.get(data.callId);
      pendingToolCalls.delete(data.callId);
      clearTimeout(entry.timer);
      entry.resolve({
        ok: Boolean(data.ok),
        result: data.result,
        error: data.error,
        refused: data.refused,
      });
    }
  }

  function callTool(name, args = {}) {
    if (!currentChannel) {
      return Promise.resolve({ ok: false, error: "no active mini-app is mounted in the room" });
    }
    const callId = `room_call_${nextToolCallId++}_${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingToolCalls.delete(callId);
        resolve({ ok: false, error: "mini-app tool execution timed out" });
      }, 5500);
      pendingToolCalls.set(callId, { resolve, timer });
      try {
        currentChannel.port1.postMessage({
          type: "call_tool",
          callId,
          name,
          args,
        });
      } catch (err) {
        clearTimeout(timer);
        pendingToolCalls.delete(callId);
        resolve({ ok: false, error: err?.message ?? String(err) });
      }
    });
  }

  window.__voiceboxMiniAppRegistry = {
    updateTools(appId, tools) {
      currentTools = Array.isArray(tools) ? tools : [];
      void syncMiniAppTools(appId, currentTools);
    },
    getAllTools: () => [...currentTools],
    executeTool: (name, args) => callTool(name, args),
  };

  function close() {
    els.miniAppContainer.hidden = true;
    if (els.miniAppDock) els.miniAppDock.hidden = true;
    if (els.miniAppBubble) els.miniAppBubble.setAttribute("aria-expanded", "false");
    if (els.miniAppViewport) els.miniAppViewport.replaceChildren();
    for (const [callId, entry] of pendingToolCalls.entries()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: "mini-app closed before tool finished" });
      pendingToolCalls.delete(callId);
    }
    if (currentChannel) {
      try { currentChannel.port1.close(); } catch {}
      currentChannel = null;
    }
    currentDescriptor = null;
    currentTools = [];
    void syncMiniAppTools("active-room-app", []);
  }

  function toggle() {
    isCollapsed = !isCollapsed;
    els.miniAppContainer.dataset.collapsed = String(isCollapsed);
    if (els.miniAppBubble) {
      els.miniAppBubble.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    }
    if (els.miniAppToggle) {
      els.miniAppToggle.setAttribute("aria-label", isCollapsed ? "Expand App" : "Collapse App");
      els.miniAppToggle.setAttribute("title", isCollapsed ? "Expand App" : "Collapse App");
      const use = els.miniAppToggle.querySelector("use");
      if (use) use.setAttribute("href", isCollapsed ? "#i-maximize" : "#i-minimize");
    }
  }

  function expandToggle() {
    isExpanded = !isExpanded;
    els.miniAppContainer.dataset.expanded = String(isExpanded);
    if (els.miniAppExpand) {
      els.miniAppExpand.setAttribute("aria-label", isExpanded ? "Standard size App" : "Full screen App");
      els.miniAppExpand.setAttribute("title", isExpanded ? "Standard size App" : "Full screen App");
      const use = els.miniAppExpand.querySelector("use");
      if (use) use.setAttribute("href", isExpanded ? "#i-minimize" : "#i-maximize");
    }
  }

  function attachMiniAppDragHandle(handleEl) {
    if (!handleEl || !els.miniAppContainer) return;
    let dragState = null;
    handleEl.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target?.closest?.("button, a, input, select, textarea")) return;
      if (els.miniAppContainer.dataset.expanded === "true") return;
      const rect = els.miniAppContainer.getBoundingClientRect();
      dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        width: rect.width,
      };
      els.miniAppContainer.dataset.dragging = "true";
      els.miniAppContainer.style.left = `${Math.round(rect.left)}px`;
      els.miniAppContainer.style.top = `${Math.round(rect.top)}px`;
      els.miniAppContainer.style.right = "auto";
      els.miniAppContainer.style.bottom = "auto";
      els.miniAppContainer.style.transform = "none";
      try {
        if (e.pointerId !== undefined) handleEl.setPointerCapture?.(e.pointerId);
      } catch {}

      const onMove = (ev) => {
        if (!dragState) return;
        const dx = ev.clientX - dragState.startX;
        const dy = ev.clientY - dragState.startY;
        const maxLeft = Math.max(8, window.innerWidth - Math.min(dragState.width || 320, 160));
        const maxTop = Math.max(8, window.innerHeight - 48);
        const nextLeft = Math.max(8, Math.min(maxLeft, dragState.startLeft + dx));
        const nextTop = Math.max(8, Math.min(maxTop, dragState.startTop + dy));
        els.miniAppContainer.style.left = `${Math.round(nextLeft)}px`;
        els.miniAppContainer.style.top = `${Math.round(nextTop)}px`;
      };

      const onUp = () => {
        dragState = null;
        delete els.miniAppContainer.dataset.dragging;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  }

  function mount(descriptor) {
    if (!descriptor || typeof descriptor.html !== "string") {
      console.warn("[voicebox] mini-app mount requires an html string");
      return;
    }
    const title = (descriptor.title || descriptor.fileName || "Interactive Mini-App").trim();
    const normKey = normalizeMiniAppKey(descriptor.fileName || title || descriptor.appId);
    const derivedFileName = descriptor.fileName || (isHtmlFileName(title) ? title : `${(normKey.replace(/^app_/, "") || "mini-app")}.html`);

    let existingKey = null;
    let existingEntry = null;
    for (const [k, v] of launchedMiniApps.entries()) {
      const vNorm = normalizeMiniAppKey(v.fileName || v.title || k);
      if (
        (descriptor.appId && (k === descriptor.appId || v.appId === descriptor.appId)) ||
        (descriptor.fileName && v.fileName && v.fileName.toLowerCase() === String(descriptor.fileName).toLowerCase()) ||
        (v.title && v.title.toLowerCase() === title.toLowerCase()) ||
        (normKey && vNorm === normKey)
      ) {
        existingKey = k;
        existingEntry = v;
        break;
      }
    }

    const appId = existingKey || descriptor.appId || normKey || `app_${Date.now().toString(36)}`;
    if (existingKey && existingKey !== appId) {
      launchedMiniApps.delete(existingKey);
    }

    const merged = {
      ...(existingEntry || {}),
      ...descriptor,
      appId,
      title,
      fileName: derivedFileName,
      html: descriptor.html,
    };
    currentDescriptor = merged;
    launchedMiniApps.set(appId, merged);

    currentTools = [];
    isCollapsed = false;
    els.miniAppContainer.dataset.collapsed = "false";
    els.miniAppContainer.hidden = false;
    if (els.miniAppTitle) {
      els.miniAppTitle.textContent = title;
    }
    if (els.miniAppSourceBadge) {
      let sourceLabel = "Workspace";
      if (merged.sandbox) {
        sourceLabel = `Environment · ${merged.sandbox}`;
      } else if (merged.source === "host" || merged.source === "shelf") {
        sourceLabel = "Saved app";
      } else if (merged.fileName) {
        sourceLabel = `Workspace · ${merged.fileName}`;
      }
      els.miniAppSourceBadge.textContent = sourceLabel;
      els.miniAppSourceBadge.hidden = false;
    }
    if (els.miniAppDock) {
      els.miniAppDock.hidden = false;
    }
    if (els.miniAppBubbleTitle) {
      els.miniAppBubbleTitle.textContent = title;
    }
    if (els.miniAppBubble) {
      els.miniAppBubble.setAttribute("aria-expanded", "true");
    }

    const bridgeUrl = `/mini-app-bridge.html?appId=${encodeURIComponent(appId)}`;

    const outer = document.createElement("iframe");
    outer.src = bridgeUrl;
    outer.className = "mini-app-frame";
    outer.id = "mini-app-outer-frame";
    outer.title = title;

    if (currentChannel) {
      try { currentChannel.port1.close(); } catch {}
    }
    currentChannel = new MessageChannel();
    currentChannel.port1.onmessage = (event) => handleBridgeEvent(event.data);

    const onBridgeHandshake = (e) => {
      if (e.origin !== window.location.origin) return;
      if (!outer.contentWindow || e.source !== outer.contentWindow) return;
      if (e.data && (e.data.type === "mini_app_handshake" || e.data.type === "bridge_ready")) {
        window.removeEventListener("message", onBridgeHandshake);
        outer.contentWindow.postMessage(
          { type: "mini_app_port", appId },
          window.location.origin,
          [currentChannel.port2],
        );
        outer.contentWindow.postMessage(
          { type: "load_app", appId, html: descriptor.html, title },
          window.location.origin,
        );
        currentChannel.port1.postMessage({
          type: "mini_app_init",
          appId,
          html: descriptor.html,
        });
      }
    };
    window.addEventListener("message", onBridgeHandshake);

    if (els.miniAppViewport) els.miniAppViewport.replaceChildren(outer);
    sqehSyncMiniApps();
  }

  function reload() {
    if (currentDescriptor) mount(currentDescriptor);
  }

  function editCurrentMiniApp() {
    if (!currentDescriptor) return;
    const rawTitle = currentDescriptor.fileName || currentDescriptor.title || "mini-app.html";
    const slug = normalizeMiniAppKey(rawTitle).replace(/^app_/, "") || "mini-app";
    const fileName = currentDescriptor.fileName || (isHtmlFileName(rawTitle) ? rawTitle : `${slug}.html`);
    const html = currentDescriptor.html ?? "";
    renderRead(fileName, html, "disk");
    if (els.fileEditor) {
      els.fileEditor.value = html;
      els.fileEditor.hidden = false;
    }
    if (els.reader) {
      els.reader.dataset.editing = "true";
      delete els.reader.dataset.collapsed;
    }
    if (els.readerBody) els.readerBody.hidden = true;
    if (els.fileEdit) els.fileEdit.hidden = true;
    if (els.fileSave) {
      els.fileSave.hidden = false;
      els.fileSave.disabled = false;
    }
    if (els.fileCancelEdit) els.fileCancelEdit.hidden = false;
    syncReaderBubble();
    els.fileEditor?.focus();
  }

  function removeMiniAppFromClientState(info = {}) {
    const targetNorm = normalizeMiniAppKey(info.fileName || info.title || info.appId);
    for (const [k, v] of [...launchedMiniApps.entries()]) {
      const kNorm = normalizeMiniAppKey(v.fileName || v.title || k);
      if (
        (info.appId && (k === info.appId || v.appId === info.appId)) ||
        (info.fileName && v.fileName === info.fileName) ||
        (info.title && v.title?.toLowerCase() === String(info.title).toLowerCase()) ||
        (targetNorm && kNorm === targetNorm)
      ) {
        launchedMiniApps.delete(k);
      }
    }
    setCatalog(getCatalog().filter((item) => {
      const cNorm = normalizeMiniAppKey(item.fileName || item.title || item.appId);
      if (info.appId && item.appId === info.appId) return false;
      if (info.fileName && item.fileName === info.fileName) return false;
      if (targetNorm && cNorm === targetNorm) return false;
      return true;
    }));
    if (currentDescriptor) {
      const curNorm = normalizeMiniAppKey(currentDescriptor.fileName || currentDescriptor.title || currentDescriptor.appId);
      if (
        (info.appId && currentDescriptor.appId === info.appId) ||
        (info.fileName && currentDescriptor.fileName === info.fileName) ||
        (targetNorm && curNorm === targetNorm)
      ) {
        close();
      }
    }
    sqehSyncMiniApps();
  }

  async function deleteCurrentMiniApp() {
    if (!currentDescriptor) return;
    const target = { ...currentDescriptor };
    const idParam = target.appId || target.fileName || target.title || "";
    removeMiniAppFromClientState(target);
    try {
      await fetch(`/api/mini-apps?id=${encodeURIComponent(idParam)}`, { method: "DELETE" });
    } catch {}
    if (target.fileName && !target.sandbox) {
      try {
        await fetch(`/api/file?name=${encodeURIComponent(target.fileName)}`, { method: "DELETE" });
      } catch {}
    }
    await load();
  }

  window.__voiceboxOnMiniAppDeleted = removeMiniAppFromClientState;

  if (els.miniAppClose) els.miniAppClose.addEventListener("click", close);
  if (els.miniAppToggle) els.miniAppToggle.addEventListener("click", toggle);
  if (els.miniAppExpand) els.miniAppExpand.addEventListener("click", expandToggle);
  if (els.miniAppReload) els.miniAppReload.addEventListener("click", reload);
  if (els.miniAppEdit) els.miniAppEdit.addEventListener("click", editCurrentMiniApp);
  if (els.miniAppDelete) els.miniAppDelete.addEventListener("click", () => void deleteCurrentMiniApp());
  if (els.miniAppBubble) els.miniAppBubble.addEventListener("click", toggle);
  attachMiniAppDragHandle(els.miniAppDragHandle);
  attachMiniAppDragHandle(els.miniAppSheetHandle);

  // Quick light-dismiss when clicking outside the popover card, dock, and mini-app bubble triggers
  document.addEventListener("pointerdown", (e) => {
    if (els.miniAppContainer && !els.miniAppContainer.hidden && els.miniAppContainer.dataset.collapsed !== "true") {
      const target = e.target;
      const inTrigger = target?.closest?.("#sqeh-actions, #file-run-app");
      if (!els.miniAppContainer.contains(target) && (!els.miniAppDock || !els.miniAppDock.contains(target)) && !inTrigger) {
        toggle();
      }
    }
  });

  // Quick dismiss on Escape key unless an open modal dialog is handling it
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.miniAppContainer && !els.miniAppContainer.hidden && els.miniAppContainer.dataset.collapsed !== "true") {
      const anyModal = document.querySelector("dialog[open]");
      if (!anyModal) {
        toggle();
        e.stopPropagation();
      }
    }
  });

  return {
    mount,
    close,
    toggle,
    expandToggle,
    reload,
    editCurrentMiniApp,
    deleteCurrentMiniApp,
    callTool,
    getTools: () => [...currentTools],
    getDescriptor: () => currentDescriptor,
    getContainer: () => els.miniAppContainer,
  };
}
