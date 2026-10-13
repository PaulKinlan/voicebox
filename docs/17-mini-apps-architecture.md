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
   - Declarations with unsupported keywords (such as `pattern`, `format`, `default`, `items.minLength`, or nested `items.type: "array" | "object"`) or declaring `"__proto__"` in `properties` or `required` are intentionally rejected at registration with `invalid-tool-parameters` to ensure the host only registers schemas it strictly verifies at dispatch.
   - Declarations declaring `enum` alongside bounds (`minLength`, `maxLength`, `minimum`, `maximum`) require all members to match the primitive `type` and at least one member to satisfy declared bounds (rejected at registration if unsatisfiable); individual out-of-bounds members are refused at dispatch.
   - Malformed payloads (missing required properties, prototype-inherited properties, type/enum mismatches, out-of-bounds numbers/strings, unrecognized keys when `additionalProperties: false` is set, array item mismatches, non-index array metadata, own `__proto__` properties, or argument payloads exceeding 64 KiB in UTF-8 bytes) are refused before dispatch with a structured refusal (`refused: missing-argument`, `invalid-argument`, `invalid-argument-type`, `invalid-argument-enum`, `invalid-argument-range`, `invalid-argument-length`, or `invalid-tool-arguments`). Legitimate data keys (`constructor`, `prototype`) are preserved safely on null-prototype snapshots. Unknown tool names fail closed immediately with `refused: unknown-tool`. Valid invocations dispatch `{ type: "call_tool", callId, name, args }` to the inner app, enforce the 5,000ms timeout and 64 KiB response cap, and return the result to the voice model.

---

## 4. Classification: Mini-Apps vs Pages (`lib/mini-app-store.mjs`, `voicebox-beads-rtsr`)

Mini-app discovery walks the workspace (depth ≤ 1), the host shelf (`<extensionsDir>/mini-apps`), and sandbox homes (depth ≤ 2). Before `voicebox-beads-rtsr` the only test was the file extension, so "mini-app" meant "a file whose name ends in `.html`" and the room's Mini-App tray (`#sqeh-actions`) rendered every page in the current folder as an App bubble.

Every discovered entry now carries a **`kind`** — `"app"` or `"page"` — alongside the fields it already had (`appId`, `slug`, `title`, `fileName`, `source`, `sandbox`, `storagePath`, `sizeBytes`, `createdAt`, `updatedAt`, `html`):

| Source | `kind` | Why |
|---|---|---|
| **Host shelf** (`<hostDir>/mini-apps`) | `app` | Only `saveMiniApp` writes there, so a file on the shelf *is* an app. |
| **Sandbox** (`sandboxHomesDir()/<name>`, extra sandbox roots) | `app` | The file is user-authored inside a fence. Grouping these with pages would hide real apps; whether sandbox HTML belongs in the tray remains an open product question. |
| **Workspace** (`rootPath`) | `page`, promoted to `app` only when **proven** | A workspace `.html` file is a page unless a shelf record proves it is the app that record describes. |

**Proof, and why it is not the slug.** An existing shelf record names the workspace file it was saved from — `saveMiniApp` writes `workspacePath` (the file's path relative to the workspace root) into `<slug>.meta.json` — and discovery accepts a workspace file as that app only when `workspacePath` equals its own relative path. Records written before this field exist, so an older record is accepted by comparing the shelf copy byte for byte with the workspace file. Anything else is a page: it keeps its own title and `appId`, takes none of the record's metadata, and **does not claim the slug**, so the shelf file itself is still discovered as the app it is. Slug alone was never proof — an unrelated page that happened to share a slug inherited the app's `appId` and title.

The classification decides the **list**, not what can be launched: `getMiniApp()` and the `launch_mini_app` verb still resolve a page by name, `file`, `slug`, `appId` or title, and the File Viewer's **Open as Mini-App** action (`#file-run-app`) launches any `.html` file. Saving a page (through the API or the assistant) writes the shelf record that promotes it to an app on the next discovery. The tray reads `kind` and defaults a payload with no `kind` to `app`, so an older server still renders as it did.

### Identity, lookup, deletion and saving, per artifact (`voicebox-beads-dvu8`, `voicebox-beads-p7p1`)
A page carries its own id space — `page_<slug>` beside an app's `app_<slug>` — so two entries never share an id. When a name is ambiguous (a page and a shelf app that share a slug, a file name or a title), the first resolution step that matches anything decides the answer, and **within that step an app outranks a page**: `getMiniApp("collision.html")`, the `launch_mini_app` verb and `DELETE /api/mini-apps?id=…` all mean the app. A page is still found by what only it answers to — its own title, or `page_<slug>` — so launching a page by name is unchanged.

Deletion asks **ownership per artifact**, never per name: an entry deletes its own `storagePath` (for a page, its own workspace file); shelf artifacts are deleted only when the entry is an **app** and the shelf record there is that app's record (matched by the `appId` inside it); a workspace file is deleted only for a **proven workspace app** — a shelf entry that merely shares the page's name owes the workspace nothing. That closes cross-deletion in both directions: deleting an unrelated page no longer destroys the same-slug shelf app, and deleting a shelf app no longer deletes the page.

Saving asks the same question: the target is the **file** the caller named (a workspace entry with that name wins), and a save that would take a shelf name already owned by a **different** app is refused `mini-app-name-taken`, naming the app, with nothing written — rather than overwriting that app's copy and record. Promoting a page whose name is free stays the supported path, and the promoted app takes the canonical `app_<slug>` id.

---

## 5. Enforced Bounds (`core/mini-app.ts`, `public/mini-app-bridge.js`)

| Bound | Limit | Enforcement Point | Behavior When Exceeded |
|---|---|---|---|
| **Iframe Sandbox** | `sandbox="allow-scripts"` | `<iframe id="inner-app">` | Blocks host storage, cookies, top navigation, and modals. |
| **Max Tools per App** | `16` | Outer Bridge & `MiniAppRegistry` | Excess tool registrations are rejected. |
| **Max Tool Output** | `64 KiB` (`65,536` bytes) | Outer Bridge | Refused with `"output over budget (max 64KB)"`. |
| **Tool Execution Timeout** | `5,000ms` | Outer Bridge | Refused with `"tool execution timed out after 5000ms"`. |
| **Tool Arguments Schema & Bounds** | Declared JSON schema, max 64 KiB | Host & Outer Bridge | Refused with `missing-argument`, `invalid-argument-type`, `invalid-argument-enum`, or `invalid-tool-arguments`. |
| **Tool Arguments Depth & Nodes** | Max 32 nesting levels, max 2048 nodes | Host & Outer Bridge | Refused with `invalid-argument-bounds`. |
| **Tool Schema Depth & Nodes** | Max 16 nesting levels, max 512 nodes | Host (`validateWebMcpTool`) & Bridge | Refused with `invalid-tool-parameters`. |
| **Tools Registration Body** | Max 64 KiB (`65,536` bytes) | Host (`POST /api/mini-app/tools`) | Refused with HTTP 400 (`body-too-large`). This route predates the server's shared JSON door (voicebox-beads-d808) and keeps its own stricter bound and status; every other JSON route answers `413 body-too-large` from the door. |
| **Tool Name Format** | `1–64` chars (`a-zA-Z0-9_-`) | `validateWebMcpTool()` | Refused with `invalid-tool-name`. |
| **Handshake Source** | `inner.contentWindow` / `window.parent` | Outer Bridge & Inner SDK | Drops unverified postMessage frames from decoy frames. |

### Verification Suite
```bash
node --test tests/mini-app-architecture.test.mjs
```
