// lib/mini-app-host.mjs — Host-side manager for double-iframe mini-apps (voicebox-beads-q8d)
//
// Manages the outer bridge iframe, tracks tool declarations from sandboxed mini-apps,
// and maps them into function declarations for live voice models.

import {
  validateWebMcpTool,
  toolsToFunctionDeclarations,
  MINI_APP_BOUNDS,
} from "../core/mini-app.ts";

export { validateWebMcpTool, toolsToFunctionDeclarations, MINI_APP_BOUNDS };

/**
 * Registry holding active mini-apps and their registered Web MCP tools.
 */
export class MiniAppRegistry {
  constructor() {
    this.apps = new Map(); // appId -> { title, tools, callTool }
    this.onToolsChanged = null;
  }

  registerApp(appId, meta = {}) {
    const entry = {
      appId,
      title: meta.title || "Mini App",
      tools: new Map(),
      callTool: meta.callTool || null,
      declaredAt: new Date().toISOString(),
    };
    this.apps.set(appId, entry);
    return entry;
  }

  unregisterApp(appId) {
    const existed = this.apps.delete(appId);
    if (existed && this.onToolsChanged) {
      this.onToolsChanged(this.getAllTools());
    }
  }

  updateTools(appId, rawTools = []) {
    const app = this.apps.get(appId);
    if (!app) return false;

    app.tools.clear();
    for (const raw of rawTools) {
      const valid = validateWebMcpTool(raw);
      if (valid.ok) {
        if (app.tools.size < MINI_APP_BOUNDS.maxTools) {
          app.tools.set(valid.value.name, valid.value);
        }
      }
    }

    if (this.onToolsChanged) {
      this.onToolsChanged(this.getAllTools());
    }
    return true;
  }

  getAllTools() {
    const all = [];
    for (const app of this.apps.values()) {
      for (const tool of app.tools.values()) {
        all.push(tool);
      }
    }
    return all;
  }

  getFunctionDeclarations() {
    return toolsToFunctionDeclarations(this.getAllTools());
  }

  async executeTool(name, args = {}) {
    for (const app of this.apps.values()) {
      if (app.tools.has(name)) {
        if (typeof app.callTool !== "function") {
          return { ok: false, error: `mini-app '${app.appId}' has no callTool implementation` };
        }
        return await app.callTool(name, args);
      }
    }
    return { ok: false, error: `tool '${name}' not found in any registered mini-app` };
  }
}

/**
 * Controller for an in-browser double-iframe container.
 * Intended for use in DOM environments (browser/CDP).
 */
export function createMiniAppHost(container, options = {}) {
  const bridgeUrl = options.bridgeUrl ?? "/mini-app-bridge.html";
  const registry = options.registry ?? new MiniAppRegistry();

  const bridgeIframe = document.createElement("iframe");
  bridgeIframe.src = bridgeUrl;
  bridgeIframe.style.width = "100%";
  bridgeIframe.style.height = "100%";
  bridgeIframe.style.border = "0";
  bridgeIframe.setAttribute("title", "Mini-App Bridge");

  let bridgeReady = false;
  let readyResolve = null;
  const bridgeReadyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });

  const pendingRpc = new Map();
  let nextCallId = 1;
  let activeAppId = null;

  function handleMessage(event) {
    // Only accept same-origin messages from the bridge
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data) return;

    if (data.type === "bridge_ready") {
      bridgeReady = true;
      if (readyResolve) readyResolve();
    } else if (data.type === "tools_updated") {
      registry.updateTools(data.appId, data.tools);
    } else if (data.type === "tool_result") {
      const p = pendingRpc.get(data.callId);
      if (p) {
        pendingRpc.delete(data.callId);
        p.resolve(data);
      }
    }
  }

  window.addEventListener("message", handleMessage);
  container.replaceChildren(bridgeIframe);

  async function loadApp({ appId, html, title = "Mini-App" }) {
    await bridgeReadyPromise;
    activeAppId = appId;

    registry.registerApp(appId, {
      title,
      callTool: (name, args) => callTool(name, args),
    });

    bridgeIframe.contentWindow.postMessage(
      { type: "load_app", appId, html, title },
      window.location.origin,
    );

    // Wait until at least one message is received back from bridge or ready
    return new Promise((resolve) => {
      const listener = (e) => {
        if (e.origin === window.location.origin && e.data?.appId === appId && (e.data.type === "app_ready" || e.data.type === "tools_updated")) {
          window.removeEventListener("message", listener);
          resolve({ ok: true, appId });
        }
      };
      window.addEventListener("message", listener);
      setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve({ ok: true, appId });
      }, 1500);
    });
  }

  function callTool(name, args = {}) {
    const callId = `call_${nextCallId++}_${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      pendingRpc.set(callId, { resolve });
      bridgeIframe.contentWindow.postMessage(
        { type: "call_tool", callId, name, args },
        window.location.origin,
      );
    });
  }

  function destroy() {
    window.removeEventListener("message", handleMessage);
    if (activeAppId) registry.unregisterApp(activeAppId);
    bridgeIframe.remove();
  }

  return {
    bridgeIframe,
    registry,
    loadApp,
    callTool,
    destroy,
  };
}
