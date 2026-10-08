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
let appChannelTransferred = false;
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
  // The inner frame is sandboxed WITHOUT allow-same-origin (opaque origin): touching
  // localStorage / sessionStorage THROWS a SecurityError and the app dies with it. Install an
  // in-memory Storage for that case, scoped to this document (voicebox-beads-sdxn).
  function memoryStorage() {
    var map = new Map();
    return {
      getItem: function(k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem: function(k, v) { map.set(String(k), String(v)); },
      removeItem: function(k) { map.delete(String(k)); },
      clear: function() { map.clear(); },
      key: function(i) { return i >= 0 && i < map.size ? Array.from(map.keys())[i] : null; },
      get length() { return map.size; }
    };
  }
  ["localStorage", "sessionStorage"].forEach(function(name) {
    var usable = false;
    try {
      var store = window[name];                 // SecurityError in an opaque origin
      var probe = "__voicebox_storage_probe__";
      store.setItem(probe, "1");
      store.removeItem(probe);
      usable = true;
    } catch (err) { usable = false; }
    if (!usable) {
      try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (err) {}
    }
  });
  const tools = new Map();
  let bridgePort = null;
  const pendingMessages = [];

  function postToBridge(msg) {
    if (bridgePort) bridgePort.postMessage(msg);
    else pendingMessages.push(msg);
  }

  window.addEventListener("message", function(event) {
    // SECURITY HARDENING (voicebox-beads-221y): strictly verify event.source is window.parent
    if (event.source !== window.parent) return;
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
  window.voicebox = window.webMcp;
  try {
    if (typeof navigator !== "undefined") {
      if (!navigator.modelContext) {
        Object.defineProperty(navigator, "modelContext", { value: window.webMcp, configurable: true });
      } else if (typeof navigator.modelContext.registerTool !== "function") {
        navigator.modelContext.registerTool = window.webMcp.registerTool;
      }
    }
  } catch (err) {}

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

const ALLOWED_TOP_PARAM_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
const ALLOWED_STRING_KEYS = new Set(["type", "description", "enum", "maxLength", "minLength"]);
const ALLOWED_NUMBER_KEYS = new Set(["type", "description", "enum", "maximum", "minimum"]);
const ALLOWED_BOOLEAN_KEYS = new Set(["type", "description"]);
const ALLOWED_ARRAY_KEYS = new Set(["type", "description", "items"]);
const ALLOWED_OBJECT_KEYS = new Set(["type", "description", "properties", "required", "additionalProperties"]);
const ALLOWED_ITEMS_KEYS = new Set(["type", "description", "enum"]);
const SUPPORTED_PRIMITIVE_ITEM_TYPES = new Set(["string", "number", "integer", "boolean"]);

function validateSinglePropertySchema(propName, raw, path = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `property '${path}${propName}' schema must be an object`;
  }
  if (typeof raw.type !== "string") {
    return `property '${path}${propName}' must declare a string 'type'`;
  }

  let allowedKeys;
  switch (raw.type) {
    case "string":
      allowedKeys = ALLOWED_STRING_KEYS;
      break;
    case "number":
    case "integer":
      allowedKeys = ALLOWED_NUMBER_KEYS;
      break;
    case "boolean":
      allowedKeys = ALLOWED_BOOLEAN_KEYS;
      break;
    case "array":
      allowedKeys = ALLOWED_ARRAY_KEYS;
      break;
    case "object":
      allowedKeys = ALLOWED_OBJECT_KEYS;
      break;
    default:
      return `unsupported parameter type '${raw.type}' for property '${path}${propName}'`;
  }

  for (const k of Object.keys(raw)) {
    if (!allowedKeys.has(k)) {
      return `unsupported schema keyword '${k}' on property '${path}${propName}' of type '${raw.type}'`;
    }
  }

  if (raw.type === "string" && raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || !raw.enum.every((item) => typeof item === "string")) {
      return `enum for string property '${path}${propName}' must be an array of strings`;
    }
  }
  if ((raw.type === "number" || raw.type === "integer") && raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || !raw.enum.every((item) => typeof item === "number" && Number.isFinite(item))) {
      return `enum for numeric property '${path}${propName}' must be an array of numbers`;
    }
  }

  if (raw.type === "array" && raw.items !== undefined) {
    if (!raw.items || typeof raw.items !== "object" || Array.isArray(raw.items)) {
      return `items schema for array property '${path}${propName}' must be an object`;
    }
    const itemSchema = raw.items;
    for (const k of Object.keys(itemSchema)) {
      if (!ALLOWED_ITEMS_KEYS.has(k)) {
        return `unsupported schema keyword '${k}' in items schema of array property '${path}${propName}'`;
      }
    }
    if (typeof itemSchema.type !== "string" || !SUPPORTED_PRIMITIVE_ITEM_TYPES.has(itemSchema.type)) {
      return `unsupported items type '${String(itemSchema.type)}' for array property '${path}${propName}' (only primitive types string, number, integer, boolean supported)`;
    }
    if (itemSchema.enum !== undefined) {
      if (!Array.isArray(itemSchema.enum)) {
        return `enum in items schema of array property '${path}${propName}' must be an array`;
      }
    }
  }

  if (raw.type === "object" && raw.properties !== undefined) {
    if (!raw.properties || typeof raw.properties !== "object" || Array.isArray(raw.properties)) {
      return `properties for object property '${path}${propName}' must be an object`;
    }
    if (raw.additionalProperties !== undefined && typeof raw.additionalProperties !== "boolean") {
      return `additionalProperties for object property '${path}${propName}' must be a boolean`;
    }
    if (raw.required !== undefined && (!Array.isArray(raw.required) || !raw.required.every((r) => typeof r === "string"))) {
      return `required for object property '${path}${propName}' must be an array of strings`;
    }
    for (const [nestedName, nestedSchema] of Object.entries(raw.properties)) {
      const err = validateSinglePropertySchema(nestedName, nestedSchema, `${path}${propName}.`);
      if (err) return err;
    }
  }

  return null;
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
  const p = raw.parameters;
  for (const k of Object.keys(p)) {
    if (!ALLOWED_TOP_PARAM_KEYS.has(k)) {
      return { ok: false, error: `unsupported top-level schema keyword '${k}' in tool parameters` };
    }
  }
  if (p.type !== "object") {
    return { ok: false, error: "tool parameters schema must specify type: 'object'" };
  }
  if (p.additionalProperties !== undefined && typeof p.additionalProperties !== "boolean") {
    return { ok: false, error: "additionalProperties must be a boolean if specified" };
  }

  const properties = (p.properties && typeof p.properties === "object" && !Array.isArray(p.properties)) ? p.properties : {};

  for (const [propName, propSchema] of Object.entries(properties)) {
    const err = validateSinglePropertySchema(propName, propSchema);
    if (err) {
      return { ok: false, error: err };
    }
  }

  const additionalProperties = p.additionalProperties === false ? false : undefined;

  return {
    ok: true,
    tool: {
      name,
      description: description.slice(0, 1024),
      parameters: {
        type: "object",
        properties,
        required: Array.isArray(p.required) ? p.required.filter(k => typeof k === "string") : [],
        ...(additionalProperties === false ? { additionalProperties: false } : {}),
      },
    },
  };
}

function validateToolArgs(params, rawArgs) {
  let args = rawArgs;
  if (args === null || args === undefined) {
    args = {};
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, refused: "invalid-tool-arguments", why: `tool arguments must be an object, got ${Array.isArray(args) ? "array" : typeof args}` };
  }
  let jsonStr = "";
  try {
    jsonStr = JSON.stringify(args);
  } catch {
    return { ok: false, refused: "invalid-tool-arguments", why: "tool arguments must be serializable JSON" };
  }

  const byteLen = typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(jsonStr).length
    : (typeof Buffer !== "undefined" ? Buffer.byteLength(jsonStr, "utf8") : jsonStr.length);

  if (byteLen > BOUNDS.maxOutputBytes) {
    return { ok: false, refused: "invalid-tool-arguments", why: `tool arguments size (${byteLen} bytes) exceeds maximum allowed bound of ${BOUNDS.maxOutputBytes} bytes` };
  }

  const p = params || { type: "object", properties: {} };
  const properties = (p.properties && typeof p.properties === "object" && !Array.isArray(p.properties)) ? p.properties : {};
  const required = Array.isArray(p.required) ? p.required : [];

  for (const reqKey of required) {
    if (typeof reqKey === "string" && (!Object.hasOwn(args, reqKey) || args[reqKey] === undefined || args[reqKey] === null)) {
      return { ok: false, refused: "missing-argument", why: `missing required argument '${reqKey}'` };
    }
  }

  if (p.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(properties, key)) {
        return { ok: false, refused: "invalid-argument", why: `unrecognized argument '${key}' not permitted by tool schema` };
      }
    }
  }

  for (const [key, val] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) continue;
    const schema = properties[key];
    if (schema) {
      if (val === null) {
        return { ok: false, refused: "invalid-argument-type", why: `argument '${key}' cannot be null` };
      }
      if (val !== undefined) {
        if (schema.type) {
          switch (schema.type) {
            case "string":
              if (typeof val !== "string") {
                return { ok: false, refused: "invalid-argument-type", why: `argument '${key}' must be a string, got ${typeof val}` };
              }
              if (typeof schema.maxLength === "number" && val.length > schema.maxLength) {
                return { ok: false, refused: "invalid-argument-length", why: `argument '${key}' length (${val.length}) exceeds maxLength ${schema.maxLength}` };
              }
              if (typeof schema.minLength === "number" && val.length < schema.minLength) {
                return { ok: false, refused: "invalid-argument-length", why: `argument '${key}' length (${val.length}) below minLength ${schema.minLength}` };
              }
              break;
            case "number":
              if (typeof val !== "number" || !Number.isFinite(val)) {
                return { ok: false, refused: "invalid-argument-type", why: `argument '${key}' must be a finite number, got ${typeof val === "number" ? "NaN/Infinity" : typeof val}` };
              }
              if (typeof schema.maximum === "number" && val > schema.maximum) {
                return { ok: false, refused: "invalid-argument-range", why: `argument '${key}' value ${val} exceeds maximum ${schema.maximum}` };
              }
              if (typeof schema.minimum === "number" && val < schema.minimum) {
                return { ok: false, refused: "invalid-argument-range", why: `argument '${key}' value ${val} below minimum ${schema.minimum}` };
              }
              break;
            case "integer":
              if (typeof val !== "number" || !Number.isInteger(val)) {
                return { ok: false, refused: "invalid-argument-type", why: `argument '${key}' must be an integer, got ${val}` };
              }
              if (typeof schema.maximum === "number" && val > schema.maximum) {
                return { ok: false, refused: "invalid-argument-range", why: `argument '${key}' value ${val} exceeds maximum ${schema.maximum}` };
              }
              if (typeof schema.minimum === "number" && val < schema.minimum) {
                return { ok: false, refused: "invalid-argument-range", why: `argument '${key}' value ${val} below minimum ${schema.minimum}` };
              }
              break;
            case "boolean":
              if (typeof val !== "boolean") {
                return { ok: false, refused: "invalid-argument-type", why: `argument '${key}' must be a boolean, got ${typeof val}` };
              }
              break;
            case "array":
              if (!Array.isArray(val)) {
                return { ok: false, refused: "invalid-argument-type", why: `argument '${key}' must be an array, got ${typeof val}` };
              }
              if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
                const itemSchema = schema.items;
                const itemType = typeof itemSchema.type === "string" ? itemSchema.type : null;
                for (let i = 0; i < val.length; i++) {
                  const item = val[i];
                  if (item === null) {
                    return { ok: false, refused: "invalid-argument-type", why: `array item at index ${i} in '${key}' cannot be null` };
                  }
                  if (itemType) {
                    if (itemType === "string" && typeof item !== "string") {
                      return { ok: false, refused: "invalid-argument-type", why: `array item at index ${i} in '${key}' must be a string, got ${typeof item}` };
                    }
                    if (itemType === "number" && (typeof item !== "number" || !Number.isFinite(item))) {
                      return { ok: false, refused: "invalid-argument-type", why: `array item at index ${i} in '${key}' must be a number, got ${typeof item}` };
                    }
                    if (itemType === "integer" && (typeof item !== "number" || !Number.isInteger(item))) {
                      return { ok: false, refused: "invalid-argument-type", why: `array item at index ${i} in '${key}' must be an integer, got ${typeof item}` };
                    }
                    if (itemType === "boolean" && typeof item !== "boolean") {
                      return { ok: false, refused: "invalid-argument-type", why: `array item at index ${i} in '${key}' must be a boolean, got ${typeof item}` };
                    }
                    if (itemType === "object" && (typeof item !== "object" || Array.isArray(item))) {
                      return { ok: false, refused: "invalid-argument-type", why: `array item at index ${i} in '${key}' must be an object, got ${Array.isArray(item) ? "array" : typeof item}` };
                    }
                  }
                  if (Array.isArray(itemSchema.enum) && !itemSchema.enum.includes(item)) {
                    return { ok: false, refused: "invalid-argument-enum", why: `array item at index ${i} in '${key}' value ${JSON.stringify(item)} is not one of allowed enum values` };
                  }
                }
              }
              break;
            case "object":
              if (typeof val !== "object" || Array.isArray(val)) {
                return { ok: false, refused: "invalid-argument-type", why: `argument '${key}' must be an object, got ${Array.isArray(val) ? "array" : typeof val}` };
              }
              if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
                const nestedParams = {
                  type: "object",
                  properties: schema.properties,
                  ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
                  ...(schema.additionalProperties === false ? { additionalProperties: false } : {}),
                };
                const nestedRes = validateToolArgs(nestedParams, val);
                if (!nestedRes.ok) {
                  return { ok: false, refused: nestedRes.refused, why: `in argument '${key}': ${nestedRes.why}` };
                }
              }
              break;
          }
        }
        if (Array.isArray(schema.enum) && !schema.enum.includes(val)) {
          return { ok: false, refused: "invalid-argument-enum", why: `argument '${key}' value ${JSON.stringify(val)} is not one of allowed enum values` };
        }
      }
    }
  }

  return { ok: true, value: args };
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

function dispatchCallTool(data) {
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

  const registered = registeredTools.get(name);
  if (!registered) {
    postToHost({
      type: "tool_result",
      callId,
      appId: currentAppId,
      ok: false,
      refused: "unknown-tool",
      error: `refused: unknown-tool — tool '${name}' is not registered in this mini-app`,
    });
    return;
  }

  if (registered.parameters) {
    const valid = validateToolArgs(registered.parameters, args);
    if (!valid.ok) {
      postToHost({
        type: "tool_result",
        callId,
        appId: currentAppId,
        ok: false,
        refused: valid.refused,
        error: `refused: ${valid.refused} — ${valid.why}`,
      });
      return;
    }
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
    resolve: () => {
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

function injectSdkIntoHtml(rawHtml) {
  const src = typeof rawHtml === "string" && rawHtml.trim()
    ? rawHtml
    : "<!doctype html><html><head></head><body></body></html>";
  const baseStyle = `<style id="voicebox-mini-app-base">html, body { overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }</style>`;
  const payload = baseStyle + "\n" + INJECTED_SDK;
  const doctypeMatch = src.match(/^\s*<!doctype\s+[^>]*>/i);
  if (doctypeMatch) {
    const afterDoctype = src.slice(doctypeMatch[0].length);
    const headMatch = afterDoctype.match(/<head(?:\s[^>]*)?>/i);
    if (headMatch) {
      const insertAt = doctypeMatch[0].length + headMatch.index + headMatch[0].length;
      return src.slice(0, insertAt) + "\n" + payload + "\n" + src.slice(insertAt);
    }
    return doctypeMatch[0] + "\n" + payload + "\n" + afterDoctype;
  }
  return "<!doctype html>\n" + payload + "\n" + src;
}

// Listen for messages from Host Room and Inner Frame
window.addEventListener("message", (event) => {
  // If message is from inner frame requesting handshake (origin is "null")
  if (event.data && event.data.type === "mini_app_ready") {
    // SECURITY HARDENING (voicebox-beads-221y): strictly verify event.source is inner.contentWindow
    if (!inner || !inner.contentWindow || event.source !== inner.contentWindow) {
      console.warn("[mini-app-bridge] rejected mini_app_ready from unverified window source");
      return;
    }
    // The inner frame announces readiness EVERY time its document (re)loads, and a transferred port
    // is single-use: re-sending appChannel.port2 throws DataCloneError (Paul's console, 2026-09-27).
    // Use the channel minted at load ONCE; on a repeat handshake mint a fresh one and wire it to
    // the same mediator, so the inner always gets a live port (voicebox-beads-sdxn).
    if (!appChannel || appChannelTransferred) {
      appChannel = new MessageChannel();
      appChannel.port1.onmessage = handleInnerMessage;
    }
    appChannelTransferred = true;
    try {
      inner.contentWindow.postMessage(
        { type: "mini_app_handshake", appId: currentAppId },
        "*",
        [appChannel.port2],
      );
    } catch (err) {
      postToHost({ type: "mini_app_bridge_error", appId: currentAppId, ok: false, error: `handshake failed: ${err?.message ?? String(err)}` });
    }
    return;
  }

  // Otherwise, message must be from parent window: enforce same-origin and parent source (voicebox-beads-221y)
  if (event.origin !== window.location.origin) return;
  if (event.source !== window.parent) return;

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
        appChannelTransferred = false;

        const rawHtml = msg.html || "<!doctype html><html><body></body></html>";
        inner.srcdoc = injectSdkIntoHtml(rawHtml);
      } else if (msg.type === "call_tool") {
        dispatchCallTool(msg);
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
    appChannelTransferred = false;

    // Inject SDK while preserving Standards Mode doctype
    const rawHtml = data.html || "<!doctype html><html><body></body></html>";
    inner.srcdoc = injectSdkIntoHtml(rawHtml);
  } else if (data.type === "call_tool") {
    dispatchCallTool(data);
  }
});

// Notify host window that bridge is loaded and ready
postToHost({ type: "bridge_ready", appId: currentAppId });
postToHost({ type: "mini_app_handshake", appId: currentAppId });
