// public/mini-app-sdk.js — In-iframe Web MCP SDK for voice-interactive mini-apps (voicebox-beads-q8d)
//
// Runs inside the untrusted inner iframe (sandbox="allow-scripts", opaque origin).
// Communicates strictly via the transferred MessagePort from the outer mediator bridge.
// Zero network/storage access needed.

const tools = new Map();
let bridgePort = null;
const pendingMessages = [];

function postToBridge(msg) {
  if (bridgePort) {
    bridgePort.postMessage(msg);
  } else {
    pendingMessages.push(msg);
  }
}

// Listen for the initial handshake from the outer bridge transferring port2
window.addEventListener("message", (event) => {
  if (event.data?.type === "mini_app_handshake" && event.ports && event.ports[0]) {
    bridgePort = event.ports[0];
    bridgePort.onmessage = async (e) => {
      const data = e.data;
      if (!data) return;

      if (data.type === "call_tool") {
        const { callId, name, args } = data;
        const tool = tools.get(name);
        if (!tool) {
          bridgePort.postMessage({
            type: "tool_result",
            callId,
            ok: false,
            error: `tool '${name}' not found in mini-app`,
          });
          return;
        }

        try {
          const result = await tool.execute(args ?? {});
          bridgePort.postMessage({
            type: "tool_result",
            callId,
            ok: true,
            result,
          });
        } catch (err) {
          bridgePort.postMessage({
            type: "tool_result",
            callId,
            ok: false,
            error: err?.message ?? String(err),
          });
        }
      }
    };

    // Flush any tools registered before handshake completed
    for (const msg of pendingMessages) {
      bridgePort.postMessage(msg);
    }
    pendingMessages.length = 0;
  }
});

// Signal to the parent window that the inner app script is ready for port transfer
if (window.parent && window.parent !== window) {
  window.parent.postMessage({ type: "mini_app_ready" }, "*");
}

/**
 * Register a Web MCP tool with the voice environment.
 */
export function registerTool(tool) {
  if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") {
    throw new Error("tool must have a string name and an execute function");
  }
  tools.set(tool.name, tool);
  postToBridge({
    type: "register_tool",
    tool: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  });
}

/**
 * Notify the bridge that the mini-app has finished initial setup.
 */
export function ready() {
  postToBridge({ type: "app_ready" });
}

// Global convenience object
window.webMcp = {
  registerTool,
  ready,
};
