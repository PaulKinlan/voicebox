// public/mini-app-bridge.js — Outer mediator bridge for sandboxed mini-apps (voicebox-beads-q8d)
//
// Security boundary:
//   - Hosted on same origin as Voicebox (http://127.0.0.1:8787).
//   - Communicates with Host Room strictly verifying event.origin === window.location.origin.
//   - Embeds the untrusted app inside an inner iframe strictly configured with sandbox="allow-scripts" (opaque origin).
//   - Mediates tool declarations, capability limits (64KB max, 5s timeout), and Web MCP execution over MessagePort.

const inner = document.getElementById("inner-app");
let currentAppId = null;
let appChannel = null;
let roomPort = null;
const registeredTools = new Map();
const pendingCalls = new Map();

try {
  const urlParams = new URLSearchParams(window.location.search);
  currentAppId = urlParams.get("appId") || "app-" + Date.now().toString(36);
} catch {
  currentAppId = "app-" + Date.now().toString(36);
}

const BOUNDS = {
  maxTools: 16,
  maxOutputBytes: 65536,
  callTimeoutMs: 5000,
};

const INJECTED_SDK = `<script>
(function() {
  const tools = new Map();
  let bridgePort = null;
  const pendingMessages = [];

  function postToBridge(msg) {
    if (bridgePort) bridgePort.postMessage(msg);
    else pendingMessages.push(msg);
  }

  window.addEventListener("message", function(event) {
    if (event.data && event.data.type === "mini_app_handshake" && event.ports && event.ports[0]) {
      bridgePort = event.ports[0];
      bridgePort.onmessage = async function(e) {
        const data = e.data;
        if (!data) return;

        if (data.type === "call_tool") {
          const callId = data.callId;
          const name = data.name;
          const args = data.args;
          const tool = tools.get(name);
          if (!tool) {
            bridgePort.postMessage({ type: "tool_result", callId: callId, ok: false, error: "tool not found: " + name });
            return;
          }
          try {
            const result = await tool.execute(args || {});
            bridgePort.postMessage({ type: "tool_result", callId: callId, ok: true, result: result });
          } catch (err) {
            bridgePort.postMessage({ type: "tool_result", callId: callId, ok: false, error: err ? (err.message || String(err)) : "unknown error" });
          }
        }
      };

      for (let i = 0; i < pendingMessages.length; i++) {
        bridgePort.postMessage(pendingMessages[i]);
      }
      pendingMessages.length = 0;
    }
  });

  window.webMcp = {
    registerTool: function(tool) {
      if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") {
        throw new Error("tool must have string name and execute function");
      }
      tools.set(tool.name, tool);
      postToBridge({
        type: "register_tool",
        tool: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || { type: "object", properties: {} }
        }
      });
    },
    ready: function() {
      postToBridge({ type: "app_ready" });
    }
  };

  // Signal to the outer mediator that inner frame script is loaded and ready for port transfer
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "mini_app_ready" }, "*");
  }
})();
<\/script>`;

function postToHost(msg) {
  if (roomPort) {
    try { roomPort.postMessage(msg); } catch {}
  }
  if (window.parent && window.parent !== window) {
    try { window.parent.postMessage(msg, window.location.origin); } catch {}
  }
}

function validateTool(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "tool declaration must be an object" };
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return { ok: false, error: `invalid tool name '${name}'` };
  }
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!raw.parameters || typeof raw.parameters !== "object" || Array.isArray(raw.parameters)) {
    return { ok: false, error: "tool parameters must be an object" };
  }
  return {
    ok: true,
    tool: {
      name,
      description: description.slice(0, 1024),
      parameters: {
        type: "object",
        properties: (raw.parameters.properties && typeof raw.parameters.properties === "object") ? raw.parameters.properties : {},
        required: Array.isArray(raw.parameters.required) ? raw.parameters.required : [],
      },
    },
  };
}

function handleInnerMessage(event) {
  const data = event.data;
  if (!data) return;

  if (data.type === "register_tool") {
    if (registeredTools.size >= BOUNDS.maxTools) {
      console.warn(`[mini-app-bridge] max tools limit reached (${BOUNDS.maxTools}) for app ${currentAppId}`);
      return;
    }
    const check = validateTool(data.tool);
    if (!check.ok) {
      console.warn(`[mini-app-bridge] rejected tool:`, check.error);
      return;
    }
    registeredTools.set(check.tool.name, check.tool);
    postToHost({
      type: "tools_updated",
      appId: currentAppId,
      tools: Array.from(registeredTools.values()),
    });
  } else if (data.type === "app_ready") {
    postToHost({
      type: "app_ready",
      appId: currentAppId,
      tools: Array.from(registeredTools.values()),
    });
  } else if (data.type === "tool_result") {
    const { callId, ok, result, error } = data;
    const pending = pendingCalls.get(callId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(callId);

      const jsonStr = JSON.stringify(result);
      if (ok && jsonStr && jsonStr.length > BOUNDS.maxOutputBytes) {
        pending.resolve({
          ok: false,
          error: "output over budget (max 64KB)",
        });
        postToHost({
          type: "tool_result",
          callId,
          appId: currentAppId,
          ok: false,
          error: "output over budget (max 64KB)",
        });
        return;
      }

      pending.resolve({ ok, result, error });
      postToHost({
        type: "tool_result",
        callId,
        appId: currentAppId,
        ok,
        result,
        error,
      });
    }
  }
}

// Listen for messages from Host Room and Inner Frame
window.addEventListener("message", (event) => {
  // If message is from inner frame requesting handshake (origin is "null")
  if (event.data && event.data.type === "mini_app_ready") {
    if (appChannel && inner && inner.contentWindow) {
      inner.contentWindow.postMessage(
        { type: "mini_app_handshake", appId: currentAppId },
        "*",
        [appChannel.port2],
      );
    }
    return;
  }

  // Otherwise, message must be from parent window: enforce same-origin
  if (event.origin !== window.location.origin) return;

  const data = event.data;
  if (!data) return;

  if (data.type === "mini_app_port" && event.ports && event.ports[0]) {
    roomPort = event.ports[0];
    roomPort.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "mini_app_init" || msg.type === "load_app") {
        currentAppId = msg.appId || currentAppId;
        registeredTools.clear();
        pendingCalls.clear();

        appChannel = new MessageChannel();
        appChannel.port1.onmessage = handleInnerMessage;

        const rawHtml = msg.html || "<!doctype html><html><body></body></html>";
        inner.srcdoc = INJECTED_SDK + "\n" + rawHtml;
      }
    };
    return;
  }

  if (data.type === "load_app") {
    currentAppId = data.appId || "app-" + Date.now().toString(36);
    registeredTools.clear();
    pendingCalls.clear();

    appChannel = new MessageChannel();
    appChannel.port1.onmessage = handleInnerMessage;

    // Inject SDK before app content
    const rawHtml = data.html || "<!doctype html><html><body></body></html>";
    inner.srcdoc = INJECTED_SDK + "\n" + rawHtml;
  } else if (data.type === "call_tool") {
    const { callId, name, args } = data;
    if (!appChannel) {
      postToHost({
        type: "tool_result",
        callId,
        appId: currentAppId,
        ok: false,
        error: "mini-app bridge is not connected to an app",
      });
      return;
    }

    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      postToHost({
        type: "tool_result",
        callId,
        appId: currentAppId,
        ok: false,
        error: `tool execution timed out after ${BOUNDS.callTimeoutMs}ms`,
      });
    }, BOUNDS.callTimeoutMs);

    pendingCalls.set(callId, {
      timer,
      resolve: (res) => {
        clearTimeout(timer);
      },
    });

    appChannel.port1.postMessage({
      type: "call_tool",
      callId,
      name,
      args,
    });
  }
});

// Notify host window that bridge is loaded and ready
postToHost({ type: "bridge_ready", appId: currentAppId });
postToHost({ type: "mini_app_handshake", appId: currentAppId });
