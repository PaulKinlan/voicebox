# 17. Double-Iframe Sandboxed Architecture for Interactive Mini-Web Apps

Interactive mini-web apps generated or served by Voicebox allow the voice model to construct live user interfaces—calculators, game boards, data visualizers, interactive forms, and task planners—and dynamically manipulate them in real time as the user speaks.

Because mini-app code is voice-generated or untrusted third-party code, it cannot be executed with ambient host authority. This document defines the **Double-Iframe Sandboxed Architecture** and the **Web MCP (Web Model Context Protocol)** bridge that isolates untrusted code while enabling low-latency voice-driven interaction.

---

## 1. Threat Model & Security Boundaries

An interactive mini-app executes arbitrary HTML, CSS, and JavaScript. Without isolation, an untrusted script could:
1. **Access Origin Storage**: Steal credentials, session tokens, host tokens, or stored files from `localStorage`, `sessionStorage`, `document.cookie`, `IndexedDB`, or the Private File System (OPFS).
2. **Execute Origin APIs**: Issue HTTP requests (`fetch("/api/file")`, `fetch("/api/turn")`, `fetch("/api/execute")`) under the ambient host authority of the user's browser.
3. **Hijack Navigation**: Redirect the host window via `window.top.location` or trap the user in prompt/alert modal loops.
4. **Sniff or Spoof Ambient Messages**: Intercept ambient `window.postMessage` events exchanged between host components.
5. **Denial of Service**: Produce unbounded outputs (memory exhaustion) or hang execution indefinitely (freezing UI loops).

---

## 2. Double-Iframe Isolation Architecture

To completely eliminate these hazards, Voicebox adopts a strict **Double-Iframe Architecture**:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Voicebox Host Room (Origin: e.g. http://127.0.0.1:8787)                │
│                                                                        │
│ • Live Voice Session (Gemini / OpenAI Realtime)                        │
│ • MiniAppRegistry: registers active apps and exposes Web MCP tools    │
│ • Communicates with Outer Bridge via same-origin postMessage          │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ Outer Mediator Bridge                                              │ │
│ │ URL: http://127.0.0.1:8787/mini-app-bridge.html (Same Origin)       │ │
│ │                                                                    │ │
│ │ • Enforces event.origin === window.location.origin on host line    │ │
│ │ • Validates tool schemas (alphanumeric names, JSON Schema objects) │ │
│ │ • Enforces execution bounds (64KB output cap, 5000ms call timeout) │ │
│ │ • Owns MessageChannel and transfers port2 to inner frame          │ │
│ │                                                                    │ │
│ │ ┌────────────────────────────────────────────────────────────────┐ │ │
│ │ │ Inner Sandboxed Mini-App                                       │ │ │
│ │ │ URL / srcdoc: Untrusted Application HTML & Script              │ │ │
│ │ │ Attribute: sandbox="allow-scripts"                             │ │ │
│ │ │ Origin: "null" (Opaque / Unique Sandbox Origin)                │ │ │
│ │ │                                                                │ │ │
│ │ │ • Storage access throws SecurityError (natively blocked)       │ │ │
│ │ │ • Origin HTTP fetches blocked (CORS rejects null origin)       │ │ │
│ │ │ • Top-navigation, modals, popups disabled by sandbox           │ │ │
│ │ │ • Exposes tools via window.webMcp.registerTool(...)            │ │ │
│ │ │ • Communicates EXCLUSIVELY over private transferred MessagePort│ │ │
│ │ └────────────────────────────────────────────────────────────────┘ │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

### Why Double-Iframe instead of a Single Iframe?

1. **Clean Separation of Mediation vs Execution**:
   If an untrusted app ran in a single sandboxed iframe (`sandbox="allow-scripts"`), its origin would be `"null"`. In `window.addEventListener("message")`, the host window would have to accept messages from `origin === "null"`. In browser security, `"null"` matches *all* opaque origins (including data: URIs, other sandboxed frames, and cross-site frames), opening the host to message spoofing unless complex cryptographic pairing is used.
2. **Same-Origin Host Mediation**:
   The Outer Bridge is hosted directly on the Voicebox origin (`/mini-app-bridge.html`). Communication between the Host Room and the Outer Bridge uses standard same-origin checks (`event.origin === window.location.origin`).
3. **Private Channel to Untrusted App**:
   The Outer Bridge establishes a `MessageChannel` and transfers `port2` into the inner frame during the handshake. All subsequent RPC traffic travels over this private, point-to-point `MessagePort`, completely immune to ambient `window.postMessage` listeners or cross-frame spoofing.

---

## 3. Web MCP (Web Model Context Protocol)

The mini-app environment provides a lightweight, standards-compliant Web MCP SDK (`public/mini-app-sdk.js` or inlined automatically by the bridge):

### Tool Registration
```javascript
window.webMcp.registerTool({
  name: "set_score",
  description: "Update the score on the interactive scoreboard",
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

// Signal that initialization is complete
window.webMcp.ready();
```

### Execution Protocol

1. **Declaration Relay**: When the app registers a tool, the inner SDK sends `{ type: "register_tool", tool }` across `MessagePort`.
2. **Validation & Filtering**: The Outer Bridge validates the tool declaration against `validateWebMcpTool()`:
   - Tool name must match `^[a-zA-Z0-9_-]{1,64}$`.
   - Description must be non-empty string <= 1024 characters.
   - Parameters must be a JSON Schema object (`type: "object"`).
   - Tool count per mini-app is capped at `MINI_APP_BOUNDS.maxTools` (16).
3. **Live Session Ingestion**: The Outer Bridge emits `tools_updated` to the host. The host's `MiniAppRegistry` translates them into live model function declarations (`toolsToFunctionDeclarations()`) for Gemini Live or OpenAI Realtime.
4. **Voice-Driven Execution**:
   - The user speaks: *"Add three points to home team."*
   - The live voice model calls `set_score({ team: "home", points: 3 })`.
   - The host dispatches the tool call to the bridge: `{ type: "call_tool", callId, name, args }`.
   - The bridge starts a 5000ms deadline timer and forwards the call over the `MessagePort`.
   - The mini-app executes `execute(args)` and updates its DOM/Canvas in real time.
   - The result is posted back over the `MessagePort`.
   - The bridge verifies output bounds (<= 64KB), cancels the timer, and returns the result to the host room.
   - The live session sends the tool response back to the voice model, which confirms aloud: *"Added three points to home team."*

---

## 4. Capability Bounds & Enforcement

All limits are enforced host-side by `core/mini-app.ts` and `public/mini-app-bridge.js`:

| Capability | Bound | Enforcement Location | Refusal / Behavior |
|---|---|---|---|
| **Sandbox Policy** | `allow-scripts` | Outer Bridge (`<iframe sandbox="...">`) | No same-origin, no top navigation, no modals |
| **Storage Access** | Strictly prohibited | Browser engine (`origin: "null"`) | Throws `SecurityError` |
| **Max Tools** | 16 tools / app | Outer Bridge & MiniAppRegistry | Excess registrations refused with warning |
| **Max Output Size** | 64 KB (65,536 bytes) | Outer Bridge mediator | Refused as `"output over budget (max 64KB)"` |
| **Call Timeout** | 5,000 ms | Outer Bridge mediator | Refused as `"tool execution timed out after 5000ms"` |
| **Tool Name** | 1–64 alphanumeric / `_` / `-` | `validateWebMcpTool()` | Refused as `invalid-tool-name` |

---

## 5. Negative Verification & Falsification Evidence

The architecture is proven through negative test drives in `tests/mini-app-architecture.test.mjs`:
1. **Opaque Origin Proof**: Inner iframe observes `window.location.origin === "null"`.
2. **Storage Denial Proof**: Calling `localStorage.setItem()` inside the mini-app throws `SecurityError`.
3. **Mutation Proof**: If `sandbox="allow-scripts allow-same-origin"` were applied, `origin` would leak the server host and `localStorage` would succeed; the test asserts this condition fails RED.
4. **Output Bound Proof**: Tool returning 70,000 bytes is intercepted and refused with `"output over budget"`.
5. **Real-time DOM Verification**: Calling tool via bridge updates inner DOM text synchronously before resolving the result.
