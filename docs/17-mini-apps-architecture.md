# Interactive Mini-Apps Architecture (Web MCP)

Voicebox can launch interactive HTML mini-apps—calculators, games, visualizers, dashboards, and custom UI tools—directly inside the workspace and allow the voice assistant to control them in real time through **Web MCP (Web Model Context Protocol)**.

Because mini-app code may be model-generated or third-party HTML/JavaScript, Voicebox isolates every mini-app inside a **Double-Iframe Sandbox** (`core/mini-app.ts`, `public/mini-app-bridge.js`, `public/mini-app-sdk.js`).

---

## 1. Threat Model & Isolation Goals

An untrusted mini-app executes arbitrary HTML, CSS, and JavaScript. The sandbox prevents it from:
1. **Reading Host Origin Storage**: Cannot access the Voicebox host's `localStorage`, `sessionStorage`, `document.cookie`, `IndexedDB`, or Origin Private File System (OPFS). (The injected SDK provides a transient, document-local in-memory `Storage` shim so apps that call `localStorage.getItem`/`setItem` work without throwing a `SecurityError`.)
2. **Calling Host APIs**: Because the inner iframe has an opaque `"null"` origin, browser CORS policies block direct `fetch()` calls to `/api/file`, `/api/turn`, or `/api/execute`.
3. **Hijacking Navigation or Modals**: Top-level navigation, popups, and blocking `alert()`/`prompt()` dialogs are disabled by the iframe `sandbox` attribute.
4. **Spoofing Ambient `postMessage` Events**: All communication travels over a private, transferred `MessagePort` rather than ambient window messages.
5. **Hanging or Exhausting the Host**: Tool calls are bounded by a 5,000ms timeout and a 64 KiB output limit.
6. **Malformed or Unbounded Tool Arguments**: Inbound tool arguments from models or external callers are validated against each tool's declared JSON schema (`validateMiniAppToolArgs()`), rejecting missing required parameters, type/enum mismatches, or oversized argument payloads before dispatching to the sandboxed app (`voicebox-beads-fdtu`).

---

## 2. Double-Iframe Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Voicebox Host Room (Same Origin: http://127.0.0.1:8787)                │
│                                                                        │
│ • Live Voice Session (Gemini Live / OpenAI Realtime)                   │
│ • MiniAppRegistry: tracks active apps and exposes Web MCP tools        │
│ • Pop-over container (#mini-app-container) & launcher (#sqeh-actions)  │
│ • Verifies e.source === outer.contentWindow on bridge handshake        │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ Outer Mediator Bridge (/mini-app-bridge.html, Same Origin)         │ │
│ │                                                                    │ │
│ │ • Verifies event.origin === window.location.origin & window.parent │ │
│ │ • Verifies event.source === inner.contentWindow on mini_app_ready  │ │
│ │ • Validates Web MCP tool schemas (validateWebMcpTool)              │ │
│ │ • Enforces 64 KiB output cap and 5,000ms execution timeout         │ │
│ │ • Creates fresh MessageChannel on each inner load and transfers    │ │
│ │   port2 to the inner sandboxed frame                               │ │
│ │                                                                    │ │
│ │ ┌────────────────────────────────────────────────────────────────┐ │ │
│ │ │ Inner Sandboxed Mini-App (<iframe id="inner-app">)             │ │ │
│ │ │ Attribute: sandbox="allow-scripts"                             │ │ │
│ │ │ Origin: "null" (Opaque Sandbox Origin)                         │ │ │
│ │ │                                                                │ │ │
│ │ │ • Verifies event.source === window.parent on handshake         │ │ │
│ │ │ • Registers tools via window.webMcp.registerTool(...)          │ │ │
│ │ │ • Communicates exclusively over transferred MessagePort        │ │ │
│ │ └────────────────────────────────────────────────────────────────┘ │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

### Why Two Nested Iframes?
- **Outer Mediator Bridge (`/mini-app-bridge.html`)**: Runs on the same origin as the Voicebox room so the host window can verify `event.origin === window.location.origin` and `e.source === outer.contentWindow` to prevent foreign frames from triggering spoofed premature handshakes. When receiving `mini_app_ready`, the bridge strictly verifies `event.source === inner.contentWindow` before transferring the MessagePort, preventing decoy frames from forcing port churn or intercepting handshake transfers (`voicebox-beads-221y`).
- **Inner Sandboxed Frame (`sandbox="allow-scripts"`)**: Runs in a unique opaque origin (`"null"`). On every load or reload of the inner document, the outer bridge creates a fresh `MessageChannel` and transfers `port2` into the inner frame. The inner SDK strictly verifies `event.source === window.parent` before accepting `mini_app_handshake` and adopting the port, ensuring other frames in the document cannot hijack the app's tool execution channel; the inner document itself remains the trusted counterparty for tool execution.

---

## 3. Authoring Mini-Apps with Web MCP (`window.webMcp`)

The bridge automatically injects `public/mini-app-sdk.js` into the inner frame right after `<!doctype html>` (preserving `CSS1Compat` Standards Mode). Mini-apps expose interactive tools to the voice assistant using `window.webMcp.registerTool()`:

```javascript
window.webMcp.registerTool({
  name: "set_score",
  description: "Add points to a team on the scoreboard",
  parameters: {
    type: "object",
    properties: {
      team: { type: "string", enum: ["home", "away"] },
      points: { type: "number", description: "Points to add" }
    },
    required: ["team", "points"]
  },
  execute: async ({ team, points }) => {
    const el = document.getElementById(`${team}-score`);
    el.textContent = String(Number(el.textContent) + points);
    return { ok: true, currentScore: Number(el.textContent) };
  }
});

// Signal that tool registration is complete
window.webMcp.ready();
```

### Tool Lifecycle during a Voice Session
1. **Registration**: The inner app calls `window.webMcp.registerTool(...)`, sending `{ type: "register_tool", tool }` over the private `MessagePort`.
2. **Schema Validation (`core/mini-app.ts`)**: `validateWebMcpTool()` verifies the tool name (`^[a-zA-Z0-9_-]{1,64}$`), description (≤ 1,024 chars), JSON Schema parameters (`type: "object"`), and per-app tool count (`maxTools: 16`).
3. **Live Voice Exposure**: `MiniAppRegistry` converts registered tools into function declarations (`toolsToFunctionDeclarations()`) for the active live voice session.
4. **Voice Execution & Host Argument Validation**: When the user says *"Add three points to the home team"*, the voice model calls `set_score`. The host (`server.mjs`) and outer bridge validate the incoming arguments against the tool's declared JSON schema (`validateMiniAppToolArgs()`). Parameter schemas are strictly validated at registration against an enforceably validated subset:
   - Supported property types: `string`, `number`, `integer`, `boolean`, `array`, `object`.
   - Allowed keyword allowlists per type: `string` (`maxLength`, `minLength`, `enum`), `number`/`integer` (`maximum`, `minimum`, `enum`), `boolean`, `array` (`items` with primitive `type` and `enum`), `object` (`properties`, `required`, `additionalProperties`).
   - Declarations with unsupported keywords (such as `pattern`, `format`, `default`, `items.minLength`, or nested `items.type: "array" | "object"`) are intentionally rejected at registration with `invalid-tool-parameters` to ensure the host only registers schemas it strictly verifies at dispatch.
   - Malformed payloads (missing required properties, prototype-inherited properties, type/enum mismatches, out-of-bounds numbers/strings, unrecognized keys when `additionalProperties: false` is set, array item mismatches, or argument payloads exceeding 64 KiB in UTF-8 bytes) are refused before dispatch with a structured refusal (`refused: missing-argument`, `invalid-argument-type`, `invalid-argument-enum`, `invalid-argument-range`, `invalid-argument-length`, or `invalid-tool-arguments`). Unknown tool names fail closed immediately with `refused: unknown-tool`. Valid invocations dispatch `{ type: "call_tool", callId, name, args }` to the inner app, enforce the 5,000ms timeout and 64 KiB response cap, and return the result to the voice model.

---

## 4. Enforced Bounds (`core/mini-app.ts`, `public/mini-app-bridge.js`)

| Bound | Limit | Enforcement Point | Behavior When Exceeded |
|---|---|---|---|
| **Iframe Sandbox** | `sandbox="allow-scripts"` | `<iframe id="inner-app">` | Blocks host storage, cookies, top navigation, and modals. |
| **Max Tools per App** | `16` | Outer Bridge & `MiniAppRegistry` | Excess tool registrations are rejected. |
| **Max Tool Output** | `64 KiB` (`65,536` bytes) | Outer Bridge | Refused with `"output over budget (max 64KB)"`. |
| **Tool Execution Timeout** | `5,000ms` | Outer Bridge | Refused with `"tool execution timed out after 5000ms"`. |
| **Tool Arguments Schema & Bounds** | Declared JSON schema, max 64 KiB | Host & Outer Bridge | Refused with `missing-argument`, `invalid-argument-type`, `invalid-argument-enum`, or `invalid-tool-arguments`. |
| **Tool Arguments Depth & Nodes** | Max 32 nesting levels, max 2048 nodes | Host & Outer Bridge | Refused with `invalid-argument-bounds`. |
| **Tool Name Format** | `1–64` chars (`a-zA-Z0-9_-`) | `validateWebMcpTool()` | Refused with `invalid-tool-name`. |
| **Handshake Source** | `inner.contentWindow` / `window.parent` | Outer Bridge & Inner SDK | Drops unverified postMessage frames from decoy frames. |

### Verification Suite
```bash
node --test tests/mini-app-architecture.test.mjs
```
