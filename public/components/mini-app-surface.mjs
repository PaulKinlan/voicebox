/**
 * @summary Interactive mini-app iframe bridge and container surface.
 */
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
// mini_app_init. tests/mini-app-surface-extraction.test.mjs pins each of those invariants.
//
// HOST ACTIONS (voicebox-beads-j6im) are the ONE addition to that surface: a sandboxed app cannot fetch a
// mutating route with the room's authority (the relay used to let it, and a `POST /api/branches/merge` from
// app code landed a branch into the repository). Instead the bridge forwards `host_action_request` here, this
// module re-checks the same policy table (public/relay-policy.mjs) and asks the PERSON with an in-card consent
// prompt naming the app, the action and the body preview. Only an Allow performs the fetch, with this page's
// own authority, and the route's real status and bytes go back to the app. Deny, timeout or close answers a
// named refusal and sends nothing.
import { relayPolicy } from "../relay-policy.mjs";
import { relayBody } from "../relay-body.mjs";

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
  // At most ONE host action may be waiting on a person at a time (voicebox-beads-j6im): a second prompt while
  // the first is unanswered is refused by name rather than stacked, so app code cannot bury a consent question
  // under a queue of its own making.
  let pendingHostAction = null;
  // Approved host actions whose request this page has sent and not yet heard back from. While one is in flight
  // the tool that asked for it is still working, so the room's 5.5s tool budget must not expire under it.
  let executingHostActions = 0;

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

  function handleBridgeEvent(data, channel = currentChannel) {
    if (!data) return;
    // A message from a channel that has been replaced belongs to an app that is no longer mounted.
    if (channel !== currentChannel) return;
    if ((data.type === "tools_updated" || data.type === "app_ready") && Array.isArray(data.tools)) {
      currentTools = data.tools;
      if (window.__voiceboxMiniAppRegistry) {
        window.__voiceboxMiniAppRegistry.updateTools("active-room-app", data.tools);
      }
    } else if (data.type === "host_action_cancel") {
      // The bridge gave up waiting (voicebox-beads-a96w round 2). Drop the bar and refuse it: an Allow that lands
      // after the app was told "nothing was sent" would be exactly the lie this protocol exists to prevent.
      if (pendingHostAction) pendingHostAction.finish(false, "the app's relay gave up waiting for an answer");
    } else if (data.type === "host_action_request") {
      void answerHostAction(data, channel);
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

  // ── HOST ACTIONS, ASKED OF A PERSON (voicebox-beads-j6im) ──────────────────────────────────────
  //
  // The finding: the fetch relay handed the sandboxed frame this page's own Origin, server.mjs treats that
  // Origin as the room operator, and lib/routes/branches.mjs then ran `git checkout` + `git merge` for app
  // code. Same-origin admission was never evidence that the frame is the room UI.
  //
  // So a mutation is no longer a relay request at all. The bridge forwards it here and this page asks the
  // person, then performs it itself. Three properties are the point:
  //   * the app supplies no authority — it never holds an Origin, and the decision is a click in this DOM,
  //     outside the iframe, which app HTML cannot draw over or script;
  //   * the route must be one this page declares in public/relay-policy.mjs, so an app cannot invent a
  //     host action nobody approved;
  //   * the answer the app receives carries the route's REAL status and bytes, so an app that reports
  //     "Landed …" is still reporting the server's own answer (the ulhi rule), not the approval.
  // The answer goes to the channel the request ARRIVED on, never to whichever app is mounted when it is ready:
  // every bridge numbers its calls from 1, so app A's late result posted to app B's channel would be taken by
  // B as the answer to its own `fetch-1`. A replaced channel's port is closed, so a late answer is dropped.
  function replyToApp(channel, callId, msg) {
    try {
      if (channel) channel.port1.postMessage({ type: "host_action_result", callId, ...msg });
    } catch {}
  }

  // The room's own bound on the request it performs after a person approved it (voicebox-beads-a96w). Generous,
  // because a branch merge is a git operation; but BOUNDED, because the app is waiting and, once dispatched, the
  // honest answer to "did it happen?" can no longer be "no".
  const HOST_ACTION_FETCH_MS = 120000;
  // The room's consent window. The bridge outwaits this by a margin on purpose (voicebox-beads-a96w round 2): the
  // bar appears a round trip after the bridge starts waiting, so equal windows meant the app could be told nothing
  // was sent while this bar was still clickable, and Allow would then perform the request anyway.
  const HOST_ACTION_CONSENT_MS = 120000;

  function clearHostActionPrompt() {
    if (!pendingHostAction) return;
    const { el, timer } = pendingHostAction;
    pendingHostAction = null;
    clearTimeout(timer);
    el?.remove?.();
  }

  /**
   * WHAT THE PERSON IS APPROVING, in words (voicebox-beads-j6im). The body is not always a string: a FormData
   * crosses as an entries envelope, a Blob/ArrayBuffer whole. Saying "no body" for those would tell an operator
   * the opposite of the truth about the request they are about to authorize, so each shape is described.
   */
  function describeHostActionBody(body) {
    if (typeof body === "string") return body.length > 200 ? `${body.slice(0, 200)}…` : body || "empty body";
    if (body === undefined || body === null) return "no body";
    if (Array.isArray(body.voiceboxRelayFormData)) {
      const parts = body.voiceboxRelayFormData.slice(0, 8).map((entry) => {
        const [key, value] = Array.isArray(entry) ? entry : ["?", "?"];
        return `${key}=${typeof value === "string" ? value : (value?.name || "blob")}`;
      });
      const more = body.voiceboxRelayFormData.length > 8 ? ", …" : "";
      return `FormData — ${parts.join(", ")}${more}`;
    }
    const tag = Object.prototype.toString.call(body).slice(8, -1);
    if (typeof body.size === "number") return `${tag} — ${body.size} bytes`;
    if (typeof body.byteLength === "number") return `${tag} — ${body.byteLength} bytes`;
    return tag;
  }

  function askOperatorForHostAction({ appId, action, route, body }) {
    return new Promise((resolve) => {
      const host = els.miniAppViewport || els.miniAppContainer;
      if (!host) {
        resolve({ allowed: false, why: "there is no room surface to ask on" });
        return;
      }
      const bar = document.createElement("div");
      bar.className = "mini-app-consent";
      bar.setAttribute("role", "alertdialog");
      bar.setAttribute("aria-labelledby", "mini-app-consent-what");
      bar.setAttribute("aria-describedby", "mini-app-consent-detail");

      const what = document.createElement("p");
      what.className = "mini-app-consent-what";
      what.id = "mini-app-consent-what";
      const appName = document.createElement("strong");
      appName.textContent = String(appId || "this app");
      what.append(appName, document.createTextNode(` asks the room to ${action}.`));

      const detail = document.createElement("p");
      detail.className = "mini-app-consent-detail";
      detail.id = "mini-app-consent-detail";
      detail.textContent = `${route} — ${describeHostActionBody(body)}`;

      const actions = document.createElement("div");
      actions.className = "mini-app-consent-actions";
      const allow = document.createElement("button");
      allow.type = "button";
      allow.className = "mini-app-consent-allow";
      allow.textContent = "Allow once";
      const deny = document.createElement("button");
      deny.type = "button";
      deny.className = "mini-app-consent-deny";
      deny.textContent = "Deny";
      actions.append(allow, deny);
      bar.append(what, detail, actions);
      // PREPENDED, not appended: the mini-app card is anchored bottom-right and the floating bubble dock
      // (z-index 110, pointer-events auto) sits over its lower-right corner, so a bar appended under the frame
      // is a bar a real mouse cannot press — measured, the press landed on the button and the release on
      // .mini-app-bubble, so no click ever reached the handler. At the top of the viewport it is unobstructed.
      host.prepend(bar);

      const finish = (allowed, why) => {
        clearHostActionPrompt();
        resolve({ allowed, why });
      };
      allow.addEventListener("click", () => finish(true));
      deny.addEventListener("click", () => finish(false, "the room's operator denied this action"));
      const timer = setTimeout(
        () => finish(false, "nobody answered the room's approval prompt in time"),
        HOST_ACTION_CONSENT_MS,
      );
      pendingHostAction = { el: bar, timer, finish };
      // The safe answer is the focused one: a stray Enter or Space must not land a branch.
      deny.focus({ preventScroll: true });
    });
  }

  async function answerHostAction(data, channel = currentChannel) {
    const callId = data?.callId;
    if (typeof callId !== "string" || !callId) return;
    const method = String(data.method || "").toUpperCase();
    const path = typeof data.path === "string" ? data.path : "";
    const pathname = path.split("?")[0].split("#")[0];
    const policy = relayPolicy(method, pathname);
    if (!policy.ok || policy.kind !== "host-action") {
      replyToApp(channel, callId, {
        ok: false,
        error: `the room refuses this host action: ${policy.ok ? `${policy.route} is not one of the approved host actions` : policy.why}`,
      });
      return;
    }
    if (pendingHostAction) {
      replyToApp(channel, callId, {
        ok: false,
        error: "the room is still waiting for a person to answer another host action; nothing was sent",
      });
      return;
    }

    const approved = await askOperatorForHostAction({
      appId: data.appId || currentDescriptor?.appId || "this app",
      action: policy.action,
      route: policy.route,
      body: data.body,
    });
    if (!approved.allowed) {
      replyToApp(channel, callId, { ok: false, error: `${approved.why || "the room did not approve this action"}; nothing was sent` });
      return;
    }

    // The body is rebuilt by the SAME policy the bridge and the frame use (voicebox-beads-182c/ctmt), so a
    // FormData crosses as an envelope and becomes a real FormData here — the browser still chooses the multipart
    // boundary and content-type. A body the relay cannot carry is refused by name, never silently emptied.
    const carried = relayBody(data.body, { maxBytes: 65536 });
    if (!carried.ok) {
      replyToApp(channel, callId, { ok: false, error: `the room refuses this host action's body: ${carried.error}; nothing was sent` });
      return;
    }
    // The room's own request, with the room's own Origin: the app's approval is a person's click, not a header
    // the app can mint. Raw fetch (not the injected `request`) so the app gets the route's real status and body
    // bytes back verbatim, unparsed — an app that screenshots `res.status` must not be shown a laundered one.
    const declaredType = typeof data.contentType === "string" && data.contentType ? data.contentType : carried.contentType;
    // DISPATCHED (voicebox-beads-a96w): tell the app's bridge that the wait is no longer for a person, before the
    // request is on the wire. Its consent clock retires on this message and a much longer one takes over, so a
    // slow operator plus a slow route can never make the app hear "nothing was sent" about a request that ran.
    try {
      if (channel) channel.port1.postMessage({ type: "host_action_state", callId, state: "executing" });
    } catch {}
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), HOST_ACTION_FETCH_MS);
    let response;
    let bodyText;
    executingHostActions += 1;
    try {
      response = await fetch(path, {
        method,
        // No content-type for a rebuilt FormData: fetch has to set the multipart boundary itself.
        ...(declaredType ? { headers: { "content-type": declaredType } } : {}),
        body: carried.body,
        signal: abort.signal,
      });
      // fetch() settles when the HEADERS arrive. The body is read under the same deadline and the same catch:
      // a stalled body must still be abandoned, and a body that fails to arrive is not an empty success.
      bodyText = await response.text();
    } catch (err) {
      // The request WAS dispatched, so this is an indeterminate outcome, not a refusal: a timeout can abandon a
      // request the server went on to apply, and a network error can follow a request that arrived.
      replyToApp(channel, callId, {
        ok: false,
        indeterminate: true,
        refused: abort.signal.aborted ? "host-action-abandoned" : "host-action-unanswered",
        error: abort.signal.aborted
          ? `the room abandoned this request after ${HOST_ACTION_FETCH_MS}ms; it had already been sent, so it may have been applied — check before retrying`
          : `the room's request did not complete (${err?.message ?? String(err)}); it had already been sent, so it may have been applied`,
      });
      return;
    } finally {
      clearTimeout(deadline);
      executingHostActions -= 1;
    }
    replyToApp(channel, callId, {
      ok: true,
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
      bodyText,
    });
  }

  function callTool(name, args = {}) {
    if (!currentChannel) {
      return Promise.resolve({ ok: false, error: "no active mini-app is mounted in the room" });
    }
    const callId = `room_call_${nextToolCallId++}_${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      // The room's tool budget bounds APP code, and it does not run while the app's own request is waiting on a
      // PERSON to answer the consent prompt above (voicebox-beads-j6im): a 5.5s budget would otherwise make every
      // consented host action from the voice path fail. The wait is still bounded — the consent prompt answers
      // itself after two minutes, and only one may be pending — so this cannot buy unbounded time.
      const entry = {
        resolve,
        timer: null,
      };
      const armCallTimer = () => setTimeout(() => {
        // …nor while an approved action is on the wire: that wait is bounded by HOST_ACTION_FETCH_MS.
        if (pendingHostAction || executingHostActions > 0) {
          entry.timer = armCallTimer();
          return;
        }
        pendingToolCalls.delete(callId);
        resolve({ ok: false, error: "mini-app tool execution timed out" });
      }, 5500);
      entry.timer = armCallTimer();
      pendingToolCalls.set(callId, entry);
      try {
        currentChannel.port1.postMessage({
          type: "call_tool",
          callId,
          name,
          args,
        });
      } catch (err) {
        clearTimeout(entry.timer);
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
    // A pending host action dies with the surface: an unanswered consent question must never be answered by the
    // app going away (voicebox-beads-j6im).
    if (pendingHostAction) pendingHostAction.finish(false, "the mini-app closed before a person answered");
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

    // A remount replaces the app the question was about, so the question goes with it.
    if (pendingHostAction) pendingHostAction.finish(false, "the mini-app was remounted before a person answered");

    const outer = document.createElement("iframe");
    outer.src = bridgeUrl;
    outer.className = "mini-app-frame";
    outer.id = "mini-app-outer-frame";
    outer.title = title;

    if (currentChannel) {
      try { currentChannel.port1.close(); } catch {}
    }
    currentChannel = new MessageChannel();
    const channel = currentChannel;
    channel.port1.onmessage = (event) => handleBridgeEvent(event.data, channel);

    const onBridgeHandshake = (e) => {
      if (e.origin !== window.location.origin) return;
      if (!outer.contentWindow || e.source !== outer.contentWindow) return;
      if (e.data && (e.data.type === "mini_app_handshake" || e.data.type === "bridge_ready")) {
        window.removeEventListener("message", onBridgeHandshake);
        outer.contentWindow.postMessage(
          { type: "mini_app_port", appId },
          window.location.origin,
          [channel.port2],
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
      await fetch(`/api/mini-apps?id=${encodeURIComponent(idParam)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" }, // the JSON door also checks bodyless deletes
      });
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
