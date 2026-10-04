# Operating Model & Development Workflow

[`07-architecture.md`](07-architecture.md) describes Voicebox's components and data structures. This document explains how the server and development environment run, how ports and network boundaries are configured, and how runtime invariants and documentation checks work.

---

## 1. Runtime Operating Model

Voicebox runs as a single, zero-dependency Node.js process (`server.mjs`) that serves the static web interface from `public/` and exposes REST and WebSocket endpoints. During frontend development, an optional Vite server (`vite.config.js`) provides Hot Module Replacement (HMR) and proxies API and WebSocket traffic to `server.mjs`.

```
Browser ──▶ Vite Dev Server (:5173, dev only) ──proxy /api, /live, /channel──▶ server.mjs (127.0.0.1:8787)
                    │                                                                    │
                    └──────────────────── serves public/ ────────────────────────────────┴──▶ Active Workspace Root
```

In production (`npm start` or `npm run serve`), `node server.mjs` serves `public/` directly without Vite or external runtime dependencies.

### Ports

| Port | Process | Purpose |
|---|---|---|
| **`8787`** | `server.mjs` (`PORT` overrides) | Primary HTTP and WebSocket server. Always binds **`127.0.0.1`**. |
| **`5173`** | Vite (`npm run dev`, `strictPort: true`) | Development server with HMR. Exits immediately if port `5173` is busy rather than drifting to another port. |

### The Loopback Binding Rule (`127.0.0.1`)
`server.mjs` binds exclusively to loopback (`127.0.0.1`). The browser connects to its local host over loopback, and cross-machine operations are performed via authenticated host-to-host pairing ([`09-proxied-custody.md`](09-proxied-custody.md)) rather than exposing an unauthenticated server on `0.0.0.0`.

---

## 2. Running in Development

```bash
npm start          # Start server.mjs on http://127.0.0.1:8787
npm run dev        # Start Vite dev server on :5173 (proxies /api, /live, /channel to :8787)
npm run docs:check # Verify that documentation blocks and file references match the codebase
npm run docs:write # Regenerate live-probed documentation blocks in README.md and docs/07-architecture.md
```

### Key Runtime Behaviors
- **Real-Time UI Synchronization (`{ type: "tool" }`)**: When a live voice model executes a tool over `/live` (`lib/ws-server.mjs`, `lib/live-session.mjs`), the server sends a `{ type: "tool" }` frame to `public/live-voice.js`. `public/fused.js` automatically refreshes the file list, renders inline file chips on the conversation turn, and opens the floating File Viewer (`#reader`) when the user asks to view a file.
- **Pop-Over Bubble Interface (`#sqeh-deck`)**: The workspace interface keeps the central voice microphone (`#mic`) and text composer (`#text-form`) front-and-center while organizing Files (`#sqeh-files-bubble`), the File Viewer (`#sqeh-reader-bubble`), interactive Mini-Apps (`#sqeh-actions`), and Recent Turns (`#sqeh-toggle-history`) into lightweight pop-over bubbles.
- **Interactive Mini-Apps (`public/mini-app-bridge.js`)**: `.html` files in the workspace or apps launched via `launch_mini_app` run inside `#mini-app-container` using a double-iframe sandbox (`/mini-app-bridge.html` mediating an opaque-origin `sandbox="allow-scripts"` inner frame) and expose Web MCP tools to the voice session.
- **WebAssembly Shelf Tools (`lib/wasm-shelf.mjs`)**: Digest-pinned `.wasm` tools (such as `hash.wasm` and `diff.wasm`) appear in `list_extensions`, execute via `call_extension`, and report execution latency (`durationMs`) to the UI (`tests/live-wasm-room.test.mjs`, `tests/wasm-room-ui.test.mjs`; see [`docs/20-webassembly-tools.md`](20-webassembly-tools.md)).
- **Live Task Cards & Fleet Addressing (`core/fleet.ts`, `lib/fleet.mjs`)**: Delegated coding tasks emit `{ type: "task" }` events to update task progress cards in real time. Agents across environments are addressed as `environmentKey/agentId` or `environmentKey/agentId:sessionId`.
- **Tailscale Serve Firewall Note**: When exposing the dev server over Tailscale Serve (`https://<node>.<tailnet>.ts.net/`), ensure the host firewall permits traffic on `tailscale0` (`sudo ufw allow in on tailscale0`) so remote tailnet peers do not hit `ERR_CONNECTION_ABORTED`.

---

## 3. Core Architectural Invariants

1. **Separated Turn Resolution and Execution**: `server.mjs` executes structured actions and never parses natural language directly; all text turn parsing happens in registered resolvers (`lib/resolver.mjs`).
2. **Verified Frontend Asset Set**: `scripts/docs-check.mjs` parses `public/index.html` (`public/fused.js`, `public/style.css`, `public/live-voice.js`) to ensure the documented script and AudioWorklet load set matches what the browser loads.
3. **Live-Probed HTTP Routes**: Route documentation is verified by booting a real server instance on an ephemeral port and probing the endpoints over HTTP.
4. **Self-Contained `core/` Library**: Modules in `core/` (`core/harness-config.ts`, etc.) have zero imports outside `core/`, allowing pure policy and state logic to be shared across Node and browser runtimes (`lib/harness-config.mjs`).
5. **Strict Path Containment**: `resolveInsideRoot` rejects path traversal (`..`), leading slashes, and dotfile access; verified by `tests/containment-paths.test.mjs`.
6. **Untrusted Transcript Rendering**: Transcripts and tool outputs are rendered via DOM text nodes and safe attributes in `public/`, preventing XSS injection.

---

## 4. Automated Documentation Verification

Voicebox uses two automated scripts to prevent documentation drift:

### 1. Runtime & Claim Verification (`scripts/docs-check.mjs`)
```bash
node scripts/docs-check.mjs                     # Check mode: exits 1 on any drift or broken claim
node scripts/docs-check.mjs --write             # Write mode: regenerates blocks in README.md and docs/07-architecture.md
node scripts/docs-check.mjs --docs-root <dir>   # Run checks against a directory copy (used by tests/docs-drift.test.mjs)
```
`scripts/docs-check.mjs` runs a fast static pre-pass before booting the probe server:
- Verifies that all `<!-- BEGIN GENERATED: ... -->` markers exist and are non-empty.
- The probe server it boots blanks the vendor credential keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) so docs generation never makes ambient vendor calls — an operator's shell credentials cannot change what the documents say (voicebox-beads-tgvk; pinned by `tests/docs-drift.test.mjs`).
- Verifies that every backticked repository file path (such as `lib/extensions.mjs`) exists on disk.
- Verifies that required and forbidden literals in `docs/claims.json` hold across `README.md` and `docs/*.md`.

### 2. Change-Coupled Documentation Gate (`scripts/docs-touched.mjs`)
```bash
node scripts/docs-touched.mjs
```
Every backticked file path in `README.md` or `docs/*.md` registers that file as documented. If a commit modifies a documented source file without updating any markdown document, `scripts/docs-touched.mjs` refuses the push and lists the modified file alongside the documents that reference it (`tests/docs-touched.test.mjs`).

When a code change genuinely does not alter any behavior described by the documentation (for example, an internal comment or refactor), record the check explicitly with a Git commit trailer:
```bash
git commit --amend --trailer "Docs-checked: internal refactor — no documented behavior changed"
```
