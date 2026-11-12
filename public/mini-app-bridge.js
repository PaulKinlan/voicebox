// public/mini-app-bridge.js — Outer mediator bridge for sandboxed mini-apps (voicebox-beads-q8d)
//
// Security boundary:
//   - Hosted on same origin as Voicebox (http://127.0.0.1:8787).
//   - Communicates with Host Room strictly verifying event.origin === window.location.origin.
//   - Embeds the untrusted app inside an inner iframe strictly configured with sandbox="allow-scripts" (opaque origin).
//   - The fetch relay has two gates. public/relay-target.mjs admits a target only when it RESOLVES to this
//     page's origin (voicebox-beads-zus7), never by a string prefix; public/relay-policy.mjs then decides WHAT
//     may be carried: approved reads are relayed, a host MUTATION is never fetched here at all — it goes to the
//     room as `host_action_request` and only a person's approval makes it happen (voicebox-beads-j6im).
//   - The app document runs under a default-deny network CSP (public/app-network-policy.mjs, voicebox-beads-cwx5.16):
//     the policy is the first thing the document parses, it admits only the declared origins the room granted,
//     and a blocked load is reported to the room by origin so the person sees why an app looks broken.
//   - Mediates tool declarations, capability limits (64KB max, 5s timeout), and Web MCP execution over MessagePort.

import { relayTarget } from "./relay-target.mjs";
import { relayBody } from "./relay-body.mjs";
import { relayPolicy } from "./relay-policy.mjs";
import { applyNetworkPolicy, blockedOrigin } from "./app-network-policy.mjs";

const inner = document.getElementById("inner-app");
let currentAppId = null;
let appChannel = null;
let appChannelTransferred = false;
let roomPort = null;
const registeredTools = new Map();
const pendingCalls = new Map();
// Host actions (voicebox-beads-j6im): requests the room performs on the app's behalf after a person approves
// them. Each is waiting on an answer from the room, correlated by the relay's own callId.
const pendingHostActions = new Map();

try {
  const urlParams = new URLSearchParams(window.location.search);
  currentAppId = urlParams.get("appId") || "app-" + Date.now().toString(36);
} catch {
  currentAppId = "app-" + Date.now().toString(36);
}

const BOUNDS = {
  maxTools: 16,
  maxOutputBytes: 65536,
  maxArgsBytes: 65536,
  maxNestingDepth: 32,
  maxNodeCount: 2048,
  maxSchemaDepth: 16,
  maxSchemaNodes: 512,
  callTimeoutMs: 5000,
  // The fetch relay (voicebox-beads-v1k6): buffered whole, bounded, same-origin paths only.
  fetchRelayTimeoutMs: 30000,
  fetchRelayMaxBodyBytes: 262144,
  // A host action is TWO waits, not one (voicebox-beads-a96w). The first waits for a PERSON to answer the
  // room's prompt, and while it runs nothing has been dispatched — so its expiry may honestly say "nothing was
  // sent". The second starts only when the room reports it has dispatched the request, and from that moment the
  // mutation may already have been applied, so its expiry must say so instead. One clock covering both was the
  // finding: it could expire during the room's own fetch and tell the app nothing was sent after a branch had
  // landed. The fetch underneath keeps the 30s bound above; these are human/deferred waits, so minutes.
  // STRICTLY LONGER than the room's own consent prompt (public/components/mini-app-surface.mjs,
  // HOST_ACTION_CONSENT_MS = 120 s). This is not decoration (voicebox-beads-a96w, round 2): the room renders the
  // bar after a round trip, so ITS 120 s always expires slightly AFTER this one would have. When both were 120 s,
  // this clock could give up first — "nothing was sent" — while the room's bar was still on screen and still
  // clickable, so a person pressing Allow a moment later performed the mutation anyway. Outwaiting the room is what
  // makes "the prompt expired" true when this clock fires; the cancel below makes the room stop even if it somehow
  // outlives us.
  hostActionConsentMs: 180000,
  hostActionFetchMs: 180000,
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

  // FETCH RELAY (voicebox-beads-v1k6): this frame is sandboxed WITHOUT allow-same-origin, so its
  // origin is opaque and fetch("/api/...") can never reach the server — a mini-app that renders
  // fetched state then silently shows its placeholder data instead (the landing inspector showed
  // fabricated branches over 23 real ones). Same-origin requests are relayed over the bridge port to
  // the same-origin bridge page and resolved as real Response objects; foreign ones keep native fetch,
  // which is CORS-bound. Buffered whole — no streaming.
  var nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  var fetchSeq = 0;
  var pendingFetches = new Map();
  var FETCH_RELAY_TIMEOUT_MS = 30000;
  // The relay gate, embedded from the bridge's own module (public/relay-target.mjs) so the two realms cannot
  // drift. Resolved against a fixed placeholder origin, because THIS frame's origin is opaque ("null") and
  // cannot be the base; it only decides whether to ask the relay at all. The bridge re-checks against its REAL
  // origin, and that check is the boundary (voicebox-beads-zus7).
  var RELAY_BASE = "http://mini-app.invalid";
  var relayTarget = (${String(relayTarget)});
  // The body policy, embedded from the same module the bridge imports (voicebox-beads-182c): a body that is not
  // a string is carried (URLSearchParams, FormData, Blob, ArrayBuffer) or REFUSED OUT LOUD — never dropped into
  // a bodyless request the app did not ask for.
  var RELAY_BODY_LIMIT = ${BOUNDS.maxArgsBytes};
  var relayBody = (${String(relayBody)});
  // The relay POLICY, embedded from the bridge's own module (public/relay-policy.mjs, voicebox-beads-j6im):
  // what may be carried at all, and whether a request is a read or a host mutation. The frame refuses here
  // so the app hears the reason immediately; the bridge re-classifies and that copy is the boundary.
  var relayPolicy = (${String(relayPolicy)});
  // The frame's own backstop, deliberately LONGER than the bridge's two phases together: the bridge always
  // answers first, and this one exists only for a relay that stopped answering — so it must not claim the
  // request was never sent (voicebox-beads-a96w).
  var HOST_ACTION_WAIT_MS = ${BOUNDS.hostActionConsentMs + BOUNDS.hostActionFetchMs + 30000};
  window.fetch = function(input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    // A Request carries its own method, headers and body, and its .url is always ABSOLUTE — so the old relay
    // path could only ever have sent it as a GET with no body, i.e. a different request than the app wrote.
    // Fetching it natively is not a fix either (an opaque-origin frame is CORS-blocked, so it fails with a bare
    // "Failed to fetch"). Name the supported spelling instead (voicebox-beads-182c).
    if (typeof Request === "function" && input instanceof Request) {
      return Promise.reject(new Error("fetch relay: pass a URL string and an init object (fetch('/api/x', { method, body })) — a Request object cannot be relayed without changing the request"));
    }
    var target = relayTarget(url, RELAY_BASE);
    if (!target) {
      if (!nativeFetch) return Promise.reject(new Error("fetch is unavailable in this frame"));
      return nativeFetch(input, init);
    }
    var method = String((init && init.method) || "GET").toUpperCase();
    var policy = relayPolicy(method, target.pathname);
    if (!policy.ok) {
      return Promise.reject(new Error("fetch relay refuses this request: " + policy.why));
    }
    var carried = relayBody(init && init.body, { maxBytes: RELAY_BODY_LIMIT });
    if (!carried.ok) {
      return Promise.reject(new Error("fetch relay refuses this request: " + carried.error));
    }
    var headers = (init && init.headers) || {};
    // The form content-type comes from the BODY (URLSearchParams), and only overwrites a plain header bag — a
    // Headers instance is passed through untouched, because spreading it would lose its own semantics.
    var headerTag = Object.prototype.toString.call(headers);
    if (carried.contentType && (headerTag === "[object Object]" || headerTag === "[object Array]")) {
      var named = Object.keys(headers).some(function (name) { return String(name).toLowerCase() === "content-type"; });
      if (!named) {
        headers = Object.assign({}, headers);
        headers["content-type"] = carried.contentType;
      }
    }
    return new Promise(function(resolve, reject) {
      var callId = "fetch-" + (++fetchSeq);
      // A host action waits on a person and then on the room's own request, so it gets the longer backstop; a
      // read is waiting on a socket and keeps the short one.
      var waitMs = policy.kind === "host-action" ? HOST_ACTION_WAIT_MS : FETCH_RELAY_TIMEOUT_MS;
      var timer = setTimeout(function() {
        if (pendingFetches.delete(callId)) {
          reject(new Error(policy.kind === "host-action"
            ? "the relay stopped answering this host action; its outcome is UNKNOWN — check the room before retrying"
            : "fetch relay timed out after " + FETCH_RELAY_TIMEOUT_MS + "ms"));
        }
      }, waitMs);
      pendingFetches.set(callId, { resolve: resolve, reject: reject, timer: timer });
      postToBridge({
        type: "fetch_request",
        callId: callId,
        // The RESOLVED path, so no ambiguity crosses the port: the bridge resolves this string again against
        // its real origin, and a normalized same-origin path can only come back same-origin.
        url: target.pathname + target.search + target.hash,
        method: method,
        headers: headers,
        body: carried.body
      });
    });
  };

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

        if (data.type === "fetch_result") {
          const pending = pendingFetches.get(data.callId);
          if (pending) {
            pendingFetches.delete(data.callId);
            clearTimeout(pending.timer);
            if (data.ok) {
              pending.resolve(new Response(data.bodyText, {
                status: data.status,
                headers: data.headers || {}
              }));
            } else {
              pending.reject(new TypeError(data.error || "fetch relay failed"));
            }
          }
          return;
        }

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

  // A load the network policy blocked (voicebox-beads-cwx5.16). Without this an app that needs an undeclared
  // origin just looks broken; the bridge passes the ORIGIN on so the room can say which declaration is missing.
  document.addEventListener("securitypolicyviolation", function(event) {
    postToBridge({
      type: "csp_violation",
      blockedURI: String(event.blockedURI || "").slice(0, 512),
      directive: String(event.effectiveDirective || event.violatedDirective || "").slice(0, 64)
    });
  });

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

function validateSinglePropertySchema(propName, raw, path = "", depth = 1, counter = { nodes: 0 }) {
  counter.nodes++;
  if (counter.nodes > BOUNDS.maxSchemaNodes) {
    return `schema exceeds maximum node count of ${BOUNDS.maxSchemaNodes}`;
  }
  if (depth > BOUNDS.maxSchemaDepth) {
    return `schema nesting exceeds maximum depth of ${BOUNDS.maxSchemaDepth}`;
  }

  if (propName === "__proto__") {
    return `property name cannot be '__proto__'`;
  }

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

  if (raw.type === "string") {
    if (raw.maxLength !== undefined) {
      if (typeof raw.maxLength !== "number" || !Number.isInteger(raw.maxLength) || raw.maxLength < 0) {
        return `maxLength on property '${path}${propName}' must be a non-negative integer`;
      }
    }
    if (raw.minLength !== undefined) {
      if (typeof raw.minLength !== "number" || !Number.isInteger(raw.minLength) || raw.minLength < 0) {
        return `minLength on property '${path}${propName}' must be a non-negative integer`;
      }
    }
    if (typeof raw.maxLength === "number" && typeof raw.minLength === "number" && raw.minLength > raw.maxLength) {
      return `minLength cannot exceed maxLength on property '${path}${propName}'`;
    }
    if (raw.enum !== undefined) {
      if (!Array.isArray(raw.enum) || raw.enum.length === 0 || !raw.enum.every((item) => typeof item === "string")) {
        return `enum for string property '${path}${propName}' must be a non-empty array of strings`;
      }
      if (typeof raw.minLength === "number" || typeof raw.maxLength === "number") {
        const hasSatisfiable = raw.enum.some((item) => {
          const len = Array.from(item).length;
          if (typeof raw.minLength === "number" && len < raw.minLength) return false;
          if (typeof raw.maxLength === "number" && len > raw.maxLength) return false;
          return true;
        });
        if (!hasSatisfiable) {
          return `no enum members satisfy declared length bounds on property '${path}${propName}'`;
        }
      }
    }
  }

  if (raw.type === "integer") {
    if (raw.maximum !== undefined) {
      if (typeof raw.maximum !== "number" || !Number.isInteger(raw.maximum)) {
        return `maximum on integer property '${path}${propName}' must be an integer`;
      }
    }
    if (raw.minimum !== undefined) {
      if (typeof raw.minimum !== "number" || !Number.isInteger(raw.minimum)) {
        return `minimum on integer property '${path}${propName}' must be an integer`;
      }
    }
    if (typeof raw.maximum === "number" && typeof raw.minimum === "number" && raw.minimum > raw.maximum) {
      return `minimum cannot exceed maximum on property '${path}${propName}'`;
    }
    if (raw.enum !== undefined) {
      if (!Array.isArray(raw.enum) || raw.enum.length === 0 || !raw.enum.every((item) => typeof item === "number" && Number.isInteger(item))) {
        return `enum for integer property '${path}${propName}' must be a non-empty array of integers`;
      }
      if (typeof raw.minimum === "number" || typeof raw.maximum === "number") {
        const hasSatisfiable = raw.enum.some((item) => {
          if (typeof raw.minimum === "number" && item < raw.minimum) return false;
          if (typeof raw.maximum === "number" && item > raw.maximum) return false;
          return true;
        });
        if (!hasSatisfiable) {
          return `no enum members satisfy declared range bounds on property '${path}${propName}'`;
        }
      }
    }
  }

  if (raw.type === "number") {
    if (raw.maximum !== undefined) {
      if (typeof raw.maximum !== "number" || !Number.isFinite(raw.maximum)) {
        return `maximum on property '${path}${propName}' must be a finite number`;
      }
    }
    if (raw.minimum !== undefined) {
      if (typeof raw.minimum !== "number" || !Number.isFinite(raw.minimum)) {
        return `minimum on property '${path}${propName}' must be a finite number`;
      }
    }
    if (typeof raw.maximum === "number" && typeof raw.minimum === "number" && raw.minimum > raw.maximum) {
      return `minimum cannot exceed maximum on property '${path}${propName}'`;
    }
    if (raw.enum !== undefined) {
      if (!Array.isArray(raw.enum) || raw.enum.length === 0 || !raw.enum.every((item) => typeof item === "number" && Number.isFinite(item))) {
        return `enum for numeric property '${path}${propName}' must be a non-empty array of numbers`;
      }
      if (typeof raw.minimum === "number" || typeof raw.maximum === "number") {
        const hasSatisfiable = raw.enum.some((item) => {
          if (typeof raw.minimum === "number" && item < raw.minimum) return false;
          if (typeof raw.maximum === "number" && item > raw.maximum) return false;
          return true;
        });
        if (!hasSatisfiable) {
          return `no enum members satisfy declared range bounds on property '${path}${propName}'`;
        }
      }
    }
  }

  if (raw.type === "array" && raw.items !== undefined) {
    counter.nodes++;
    if (counter.nodes > BOUNDS.maxSchemaNodes) {
      return `schema exceeds maximum node count of ${BOUNDS.maxSchemaNodes}`;
    }
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
      if (!Array.isArray(itemSchema.enum) || itemSchema.enum.length === 0) {
        return `enum in items schema of array property '${path}${propName}' must be a non-empty array`;
      }
      if (itemSchema.type === "string" && !itemSchema.enum.every((item) => typeof item === "string")) {
        return `enum in items schema of array property '${path}${propName}' must contain strings matching type '${itemSchema.type}'`;
      }
      if (itemSchema.type === "number" && !itemSchema.enum.every((item) => typeof item === "number" && Number.isFinite(item))) {
        return `enum in items schema of array property '${path}${propName}' must contain numbers matching type '${itemSchema.type}'`;
      }
      if (itemSchema.type === "integer" && !itemSchema.enum.every((item) => typeof item === "number" && Number.isInteger(item))) {
        return `enum in items schema of array property '${path}${propName}' must contain integers matching type '${itemSchema.type}'`;
      }
      if (itemSchema.type === "boolean" && !itemSchema.enum.every((item) => typeof item === "boolean")) {
        return `enum in items schema of array property '${path}${propName}' must contain booleans matching type '${itemSchema.type}'`;
      }
    }
  }

  if (raw.type === "object") {
    if (raw.properties !== undefined) {
      if (!raw.properties || typeof raw.properties !== "object" || Array.isArray(raw.properties)) {
        return `properties for object property '${path}${propName}' must be an object`;
      }
      if (Object.hasOwn(raw.properties, "__proto__")) {
        return `object property '${path}${propName}' cannot declare '__proto__' property`;
      }
    }
    if (raw.additionalProperties !== undefined && typeof raw.additionalProperties !== "boolean") {
      return `additionalProperties for object property '${path}${propName}' must be a boolean`;
    }
    if (raw.required !== undefined) {
      if (!Array.isArray(raw.required) || !raw.required.every((r) => typeof r === "string" && r.length > 0)) {
        return `required for object property '${path}${propName}' must be an array of non-empty strings`;
      }
      if (raw.required.includes("__proto__")) {
        return `object property '${path}${propName}' required cannot include '__proto__'`;
      }
    }
    if (raw.additionalProperties === false) {
      const nestedPropNames = (raw.properties && typeof raw.properties === "object" && !Array.isArray(raw.properties))
        ? Object.keys(raw.properties)
        : [];
      if (Array.isArray(raw.required)) {
        for (const reqKey of raw.required) {
          if (!nestedPropNames.includes(reqKey)) {
            return `contradictory schema on property '${path}${propName}': required property '${reqKey}' is not declared in properties when additionalProperties: false`;
          }
        }
      }
    }
    if (raw.properties && typeof raw.properties === "object" && !Array.isArray(raw.properties)) {
      for (const [nestedName, nestedSchema] of Object.entries(raw.properties)) {
        const err = validateSinglePropertySchema(nestedName, nestedSchema, `${path}${propName}.`, depth + 1, counter);
        if (err) return err;
      }
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
  if (p.properties !== undefined) {
    if (!p.properties || typeof p.properties !== "object" || Array.isArray(p.properties)) {
      return { ok: false, error: "tool parameters properties must be an object" };
    }
    if (Object.hasOwn(p.properties, "__proto__")) {
      return { ok: false, error: "tool parameters cannot declare '__proto__' property" };
    }
  }

  const properties = (p.properties && typeof p.properties === "object" && !Array.isArray(p.properties)) ? p.properties : {};

  const counter = { nodes: 1 }; // Root parameters schema is node 1
  for (const [propName, propSchema] of Object.entries(properties)) {
    const err = validateSinglePropertySchema(propName, propSchema, "", 1, counter);
    if (err) {
      return { ok: false, error: err };
    }
  }

  const required = Array.isArray(p.required) ? p.required : [];
  if (p.required !== undefined) {
    if (!Array.isArray(p.required) || !p.required.every((r) => typeof r === "string" && r.length > 0)) {
      return { ok: false, error: "tool parameters required must be an array of non-empty strings" };
    }
    if (p.required.includes("__proto__")) {
      return { ok: false, error: "tool parameters required cannot include '__proto__'" };
    }
  }

  const propNames = (p.properties && typeof p.properties === "object" && !Array.isArray(p.properties))
    ? Object.keys(p.properties)
    : [];

  if (p.additionalProperties === false && Array.isArray(p.required)) {
    for (const reqKey of p.required) {
      if (!propNames.includes(reqKey)) {
        return {
          ok: false,
          error: `contradictory schema: required property '${reqKey}' is not declared in properties when additionalProperties: false`,
        };
      }
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

function inspectAndSnapshotJson(
  val,
  path = "",
  depth = 0,
  counter = { nodes: 0 },
  seen = new Set()
) {
  try {
    counter.nodes++;
    if (counter.nodes > BOUNDS.maxNodeCount) {
      return {
        ok: false,
        refused: "invalid-argument-bounds",
        why: `argument exceeds maximum node count of ${BOUNDS.maxNodeCount}`,
      };
    }

    if (depth > BOUNDS.maxNestingDepth) {
      return {
        ok: false,
        refused: "invalid-argument-bounds",
        why: `argument nesting exceeds maximum depth of ${BOUNDS.maxNestingDepth}`,
      };
    }

    if (val === undefined) {
      return { ok: false, refused: "invalid-argument", why: `argument${path ? ` at '${path}'` : ""} cannot be undefined` };
    }
    if (val === null || typeof val === "boolean") {
      return { ok: true, snapshot: val };
    }
    if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        return { ok: false, refused: "invalid-argument", why: `number${path ? ` at '${path}'` : ""} must be a finite number, got ${val}` };
      }
      return { ok: true, snapshot: val };
    }
    if (typeof val === "string") {
      return { ok: true, snapshot: val };
    }
    if (typeof val === "bigint" || typeof val === "symbol" || typeof val === "function") {
      return { ok: false, refused: "invalid-argument", why: `argument${path ? ` at '${path}'` : ""} has unsupported type '${typeof val}'` };
    }
    if (typeof val !== "object") {
      return { ok: false, refused: "invalid-argument", why: `argument${path ? ` at '${path}'` : ""} has invalid type '${typeof val}'` };
    }

    // Reject non-plain objects: Date, RegExp, Map, Set, Promise, Error, ArrayBuffer, ArrayBuffer views
    if (
      val instanceof Date ||
      val instanceof RegExp ||
      val instanceof Map ||
      val instanceof Set ||
      val instanceof Promise ||
      val instanceof Error ||
      val instanceof ArrayBuffer ||
      ArrayBuffer.isView(val)
    ) {
      return {
        ok: false,
        refused: "invalid-argument",
        why: `argument${path ? ` at '${path}'` : ""} cannot be an instance of ${Object.prototype.toString.call(val).slice(8, -1)}`,
      };
    }

    if (seen.has(val)) {
      return { ok: false, refused: "invalid-argument", why: `circular reference detected${path ? ` at '${path}'` : ""}` };
    }
    seen.add(val);

    if (Array.isArray(val)) {
      const len = val.length;
      let ownKeys;
      try {
        ownKeys = Reflect.ownKeys(val);
      } catch {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `cannot read keys on array${path ? ` at '${path}'` : ""}` };
      }

      if (ownKeys.length !== len + 1) {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `array${path ? ` at '${path}'` : ""} cannot contain non-index or symbol properties` };
      }

      let descriptors;
      try {
        descriptors = Object.getOwnPropertyDescriptors(val);
      } catch {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `cannot read descriptors on array${path ? ` at '${path}'` : ""}` };
      }

      const arrSnapshot = [];
      for (let i = 0; i < len; i++) {
        const desc = descriptors[String(i)];
        if (!desc) {
          seen.delete(val);
          return { ok: false, refused: "invalid-argument", why: `sparse array detected${path ? ` at '${path}[${i}]'` : ""}` };
        }
        if (desc.get || desc.set) {
          seen.delete(val);
          return { ok: false, refused: "invalid-argument", why: `array element${path ? ` at '${path}[${i}]'` : ""} cannot use getter/setter accessors` };
        }
        const itemRes = inspectAndSnapshotJson(desc.value, `${path}[${i}]`, depth + 1, counter, seen);
        if (!itemRes.ok) {
          seen.delete(val);
          return itemRes;
        }
        arrSnapshot.push(itemRes.snapshot);
      }
      seen.delete(val);
      return { ok: true, snapshot: arrSnapshot };
    }

    const proto = Object.getPrototypeOf(val);
    if (proto !== null && proto !== Object.prototype) {
      if (Object.prototype.toString.call(val) !== "[object Object]" || (proto && Object.prototype.toString.call(proto) !== "[object Object]")) {
        seen.delete(val);
        return {
          ok: false,
          refused: "invalid-argument",
          why: `argument object${path ? ` at '${path}'` : ""} must be a plain object`,
        };
      }
    }

    let syms = [];
    try {
      syms = Object.getOwnPropertySymbols(val);
    } catch {
      seen.delete(val);
      return { ok: false, refused: "invalid-argument", why: `cannot read symbols on object${path ? ` at '${path}'` : ""}` };
    }
    if (syms.length > 0) {
      seen.delete(val);
      return { ok: false, refused: "invalid-argument", why: `argument object${path ? ` at '${path}'` : ""} cannot contain Symbol keys` };
    }

    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(val);
    } catch {
      seen.delete(val);
      return { ok: false, refused: "invalid-argument", why: `cannot read descriptors on object${path ? ` at '${path}'` : ""}` };
    }

    if (Object.hasOwn(val, "__proto__")) {
      seen.delete(val);
      return { ok: false, refused: "invalid-argument", why: `argument object${path ? ` at '${path}'` : ""} cannot contain '__proto__' property` };
    }

    const objSnapshot = Object.create(null);
    for (const [key, desc] of Object.entries(descriptors)) {
      if (!desc.enumerable) {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `argument property '${path ? `${path}.` : ""}${key}' cannot be non-enumerable` };
      }
      if (desc.get || desc.set) {
        seen.delete(val);
        return { ok: false, refused: "invalid-argument", why: `argument property '${path ? `${path}.` : ""}${key}' cannot use getter/setter accessors` };
      }
      const propRes = inspectAndSnapshotJson(desc.value, path ? `${path}.${key}` : key, depth + 1, counter, seen);
      if (!propRes.ok) {
        seen.delete(val);
        return propRes;
      }
      Object.defineProperty(objSnapshot, key, {
        value: propRes.snapshot,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    seen.delete(val);
    return { ok: true, snapshot: objSnapshot };
  } catch {
    seen.delete(val);
    return {
      ok: false,
      refused: "invalid-argument",
      why: `failed to inspect arguments${path ? ` at '${path}'` : ""}`,
    };
  }
}

function validateToolArgs(params, rawArgs) {
  try {
    let inArgs = rawArgs;
    if (inArgs === null || inArgs === undefined) {
      inArgs = {};
    }
    let isArr = false;
    try {
      isArr = Array.isArray(inArgs);
    } catch {
      return { ok: false, refused: "invalid-argument", why: "failed to inspect arguments: revoked or inaccessible proxy" };
    }
    if (typeof inArgs !== "object" || isArr) {
      return { ok: false, refused: "invalid-tool-arguments", why: `tool arguments must be an object, got ${isArr ? "array" : typeof inArgs}` };
    }

    const snapResult = inspectAndSnapshotJson(inArgs);
    if (!snapResult.ok) {
      return { ok: false, refused: snapResult.refused || "invalid-argument", why: snapResult.why || "invalid argument" };
    }

    let jsonStr = "";
    try {
      jsonStr = JSON.stringify(snapResult.snapshot);
    } catch {
      return { ok: false, refused: "invalid-tool-arguments", why: "tool arguments must be serializable JSON" };
    }

    const byteLen = typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(jsonStr).length
      : (typeof Buffer !== "undefined" ? Buffer.byteLength(jsonStr, "utf8") : jsonStr.length);

    if (byteLen > BOUNDS.maxArgsBytes) {
      return { ok: false, refused: "invalid-tool-arguments", why: `tool arguments size (${byteLen} bytes) exceeds maximum allowed bound of ${BOUNDS.maxArgsBytes} bytes` };
    }

    const args = snapResult.snapshot;

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
            case "string": {
              if (typeof val !== "string") {
                return { ok: false, refused: "invalid-argument-type", why: `argument '${key}' must be a string, got ${typeof val}` };
              }
              const charCount = Array.from(val).length;
              if (typeof schema.maxLength === "number" && charCount > schema.maxLength) {
                return { ok: false, refused: "invalid-argument-length", why: `argument '${key}' length (${charCount}) exceeds maxLength ${schema.maxLength}` };
              }
              if (typeof schema.minLength === "number" && charCount < schema.minLength) {
                return { ok: false, refused: "invalid-argument-length", why: `argument '${key}' length (${charCount}) below minLength ${schema.minLength}` };
              }
              break;
            }
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
              {
                const nestedProps = (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties))
                  ? schema.properties
                  : {};
                const nestedReq = Array.isArray(schema.required) ? schema.required : [];
                const nestedAddl = schema.additionalProperties === false ? false : undefined;
                if (nestedReq.length > 0 || nestedAddl === false || Object.keys(nestedProps).length > 0) {
                  const nestedParams = {
                    type: "object",
                    properties: nestedProps,
                    ...(nestedReq.length ? { required: nestedReq } : {}),
                    ...(nestedAddl === false ? { additionalProperties: false } : {}),
                  };
                  const nestedRes = validateToolArgs(nestedParams, val);
                  if (!nestedRes.ok) {
                    return { ok: false, refused: nestedRes.refused, why: `in argument '${key}': ${nestedRes.why}` };
                  }
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
} catch {
  return { ok: false, refused: "invalid-argument", why: "failed to inspect arguments" };
}
}

// FETCH RELAY, bridge half (voicebox-beads-v1k6): the sandboxed inner frame has an opaque origin
// and cannot fetch the server's own API; this page is same-origin, so it fetches for it. Only
// absolute-path same-origin URLs, a small method allowlist, and a content-type-only header pass —
// the sandboxed app must not be able to mint Cookie/Authorization headers through the relay; the
// page's own same-origin credentials ride the request as they would for the room itself. The body
// is buffered whole and capped.
// A host action, asked of the room and awaited (voicebox-beads-j6im). The bridge does NOT fetch these: the
// app never gets the room's Origin, and the room performs the request itself only when a person approves it.
//
// TWO WAITS, BECAUSE THE TRUTH CHANGES BETWEEN THEM (voicebox-beads-a96w). Until the room reports that it has
// dispatched the request, nothing has been sent, so a timeout may say exactly that. Once the room reports
// `host_action_state: executing`, the request is out — the mutation may land, and may already have landed — so a
// timeout there must be INDETERMINATE rather than a cheerful "nothing was sent". One clock for both phases was
// the finding: it started before consent, so a slow operator plus the room's own fetch could exhaust it and the
// app was told nothing had been sent after a branch had been merged.
function awaitHostAction(request) {
  return new Promise((resolve) => {
    const pending = { resolve, timer: null, phase: "consent" };
    const rearm = (ms, onExpire) => {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        pendingHostActions.delete(request.callId);
        onExpire();
      }, ms);
    };
    pending.executing = () => {
      if (pending.phase !== "consent") return;
      pending.phase = "executing";
      rearm(BOUNDS.hostActionFetchMs, () => resolve({
        ok: false,
        indeterminate: true,
        refused: "host-action-unanswered",
        error: "the room approved this host action and has begun performing it, but its answer did not arrive within "
          + BOUNDS.hostActionFetchMs + "ms; it may have been applied — check before retrying",
      }));
    };
    rearm(BOUNDS.hostActionConsentMs, () => {
      // Tell the room to drop the prompt BEFORE answering the app (voicebox-beads-a96w, round 2): a bar that
      // outlives this clock is a bar whose Allow would perform a request the app has just been told was never sent.
      postToHost({ type: "host_action_cancel", callId: request.callId, reason: "the relay gave up waiting for an answer" });
      resolve({
        ok: false,
        refused: "host-action-no-operator",
        error: "the room's approval prompt expired without an answer; nothing was sent",
      });
    });
    pendingHostActions.set(request.callId, pending);
    postToHost({
      type: "host_action_request",
      callId: request.callId,
      appId: currentAppId,
      action: request.action,
      route: request.route,
      method: request.method,
      path: request.path,
      contentType: request.contentType,
      body: request.body,
    });
  });
}

async function handleFetchRelay(data) {
  const { callId } = data;
  const reply = (msg) => {
    try {
      appChannel.port1.postMessage({ type: "fetch_result", callId, ...msg });
    } catch {}
  };
  const url = typeof data.url === "string" ? data.url : "";
  // THE GATE (voicebox-beads-zus7): the target must RESOLVE to this page's origin. A prefix test admitted
  // "/\\t//host:port/leak" — one leading slash, a stripped control char — and this fetch reached a foreign
  // origin on the bridge's behalf, which is exactly the egress the sandbox exists to prevent.
  const target = relayTarget(url, window.location.origin);
  if (!target) {
    reply({ ok: false, error: "the fetch relay serves same-origin paths only" });
    return;
  }
  const method = String(data.method || "GET").toUpperCase();
  // WHAT THIS REQUEST MAY DO (voicebox-beads-j6im). Same-origin was never the whole question: the relay used to
  // hand an opaque-origin frame the room page's authority, so `POST /api/branches/merge` from app code landed a
  // branch into the repository. The policy names the reads this surface may perform and refuses the rest; a
  // host mutation is not fetched here at all.
  const policy = relayPolicy(method, target.pathname);
  if (!policy.ok) {
    reply({ ok: false, error: `the fetch relay refused (${policy.refused}): ${policy.why}` });
    return;
  }
  const headers = {};
  const wantedContentType = data.headers && typeof data.headers === "object" ? (data.headers["content-type"] || data.headers["Content-Type"]) : null;
  if (typeof wantedContentType === "string") headers["content-type"] = wantedContentType.slice(0, 200);
  // The body policy again, at the TRUST boundary: the frame's own copy bounded it there, and this copy bounds
  // what actually arrives. A body this side cannot carry is refused out loud rather than sent empty
  // (voicebox-beads-182c).
  const carried = method === "GET" || method === "HEAD" ? { ok: true } : relayBody(data.body, { maxBytes: BOUNDS.maxArgsBytes });
  if (!carried.ok) {
    reply({ ok: false, error: `fetch relay refuses this request: ${carried.error}` });
    return;
  }
  if (policy.kind === "host-action") {
    const answer = await awaitHostAction({
      callId,
      action: policy.action,
      route: policy.route,
      method,
      path: target.pathname + target.search,
      contentType: headers["content-type"],
      // The body AS IT ARRIVED on the port, not this side's rebuilt copy (voicebox-beads-j6im): a FormData body
      // is rebuilt into a real FormData here, and a FormData cannot be structured-cloned to the room. What the
      // frame sent is cloneable by construction, and the room rebuilds it with the same relayBody.
      body: data.body,
    });
    if (!answer || answer.ok !== true) {
      // `indeterminate` crosses to the frame so an app can tell "the room refused" from "the room may have done
      // it and could not tell me" (voicebox-beads-a96w). Collapsing the two was the whole defect.
      reply({ ok: false, indeterminate: answer?.indeterminate === true, refused: answer?.refused, error: answer?.error || "the room refused this host action" });
      return;
    }
    reply({
      ok: true,
      status: answer.status,
      headers: answer.headers || { "content-type": "application/json" },
      bodyText: String(answer.bodyText ?? ""),
    });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOUNDS.fetchRelayTimeoutMs);
  try {
    const res = await fetch(target.href, {
      method,
      headers,
      body: carried.body,
      signal: controller.signal,
    });
    const text = await res.text();
    reply({
      ok: true,
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "text/plain" },
      bodyText: text.length > BOUNDS.fetchRelayMaxBodyBytes ? text.slice(0, BOUNDS.fetchRelayMaxBodyBytes) : text,
    });
  } catch (err) {
    reply({ ok: false, error: `fetch relay failed: ${err?.message ?? String(err)}` });
  } finally {
    clearTimeout(timer);
  }
}

function handleInnerMessage(event) {
  const data = event.data;
  if (!data) return;

  if (data.type === "fetch_request") {
    handleFetchRelay(data);
    return;
  }

  if (data.type === "csp_violation") {
    // Reported once per origin and bounded per load: app code chooses how often this fires.
    const origin = blockedOrigin(data.blockedURI);
    if (!origin || reportedBlocks.has(origin) || reportedBlocks.size >= MAX_REPORTED_BLOCKS) return;
    reportedBlocks.add(origin);
    postToHost({
      type: "network_blocked",
      appId: currentAppId,
      origin,
      directive: typeof data.directive === "string" ? data.directive.slice(0, 64) : "",
    });
    return;
  }

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

  const valid = validateToolArgs(registered.parameters || { type: "object", properties: {} }, args);
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
  const cleanArgs = valid.value;

  // THE TOOL BUDGET DOES NOT RUN WHILE A PERSON IS DECIDING (voicebox-beads-j6im). This budget bounds APP
  // code, and a tool that asks the room for a host action is waiting on a human — the bridge's 5s bound would
  // otherwise refuse every consented landing from the voice path ("land feat/x" → consent prompt → answer),
  // which is the path the whole change exists to keep honest rather than to remove. The waiting is still
  // bounded: the host action itself has two bounds (consent, then fetch: voicebox-beads-a96w), ONE pending at a time,
  // and the prompt is answered by a click, so this cannot be used to buy unbounded time.
  const entry = { timer: null, resolve: () => clearTimeout(entry.timer) };
  const armCallTimer = () => setTimeout(() => {
    if (pendingHostActions.size > 0) {
      entry.timer = armCallTimer();
      return;
    }
    pendingCalls.delete(callId);
    postToHost({
      type: "tool_result",
      callId,
      appId: currentAppId,
      ok: false,
      error: `tool execution timed out after ${BOUNDS.callTimeoutMs}ms`,
    });
  }, BOUNDS.callTimeoutMs);
  entry.timer = armCallTimer();
  pendingCalls.set(callId, entry);

  appChannel.port1.postMessage({
    type: "call_tool",
    callId,
    name,
    args: cleanArgs,
  });
}

/** Origins already reported as blocked for the app that is loaded now. */
const reportedBlocks = new Set();
const MAX_REPORTED_BLOCKS = 8;

/**
 * The document the inner frame parses: the network policy, then the SDK, then the app. The policy's placement
 * and the narrowing of the room's `grant` to what the app declares are public/app-network-policy.mjs's.
 */
function injectSdkIntoHtml(rawHtml, grant) {
  const src = typeof rawHtml === "string" && rawHtml.trim()
    ? rawHtml
    : "<!doctype html><html><head></head><body></body></html>";
  reportedBlocks.clear();
  return applyNetworkPolicy(withSdk(src), grant, { hostOrigin: location.origin });
}

function withSdk(src) {
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
        inner.srcdoc = injectSdkIntoHtml(rawHtml, msg.network);
      } else if (msg.type === "call_tool") {
        dispatchCallTool(msg);
      } else if (msg.type === "host_action_state") {
        // The room has DISPATCHED the request (voicebox-beads-a96w). From here the wait is for an answer, not for
        // a person, so the clock that may say "nothing was sent" is retired and the indeterminate one armed.
        pendingHostActions.get(msg.callId)?.executing?.();
      } else if (msg.type === "host_action_result") {
        // The room's answer to a host action (voicebox-beads-j6im): approval and the route's own response, or a
        // named refusal. Nothing reaches the server until this arrives.
        const pending = pendingHostActions.get(msg.callId);
        if (pending) {
          pendingHostActions.delete(msg.callId);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        }
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
    inner.srcdoc = injectSdkIntoHtml(rawHtml, data.network);
  } else if (data.type === "call_tool") {
    dispatchCallTool(data);
  }
});

// Notify host window that bridge is loaded and ready
postToHost({ type: "bridge_ready", appId: currentAppId });
postToHost({ type: "mini_app_handshake", appId: currentAppId });
