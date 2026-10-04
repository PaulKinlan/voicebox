# Voicebox Documentation Guide

Welcome to the Voicebox technical documentation. This index organizes the architectural overview, runtime operations, security boundaries, capability guides, and roadmap epics across the repository.

---

## 1. Core Architecture & Operations

Start here to understand how Voicebox is structured, how the local server and browser interface run, and how turns execute end-to-end:

| Document | Topic | Summary |
|---|---|---|
| [`00-architectural-overview.md`](00-architectural-overview.md) | **Architectural Overview** | High-level system architecture, Mermaid component and sequence diagrams, browser/host layers, multi-harness concurrency, and module ownership map. |
| [`07-architecture.md`](07-architecture.md) | **Runtime Reference & Generated Tables** | Detailed component map, live voice and text turn paths, UI pop-over bubbles, workspace roots (`core/root.ts`), and auto-generated runtime tables. |
| [`08-how-it-runs.md`](08-how-it-runs.md) | **Operating Model & Dev Workflow** | How `server.mjs` and Vite (`vite.config.js`) run on loopback (`127.0.0.1`), runtime invariants, and how documentation stays synchronized with code. |
| [`09-agent-loop.md`](09-agent-loop.md) | **The Agent Loop** | End-to-end walkthrough of how a voice or text turn starts, resolves into an action, executes inside the active root, and records to the audit log. |
| [`12-pre-push-gate.md`](12-pre-push-gate.md) | **Testing Lanes & Pre-Push Gate** | How tests are partitioned into concurrent `unit` and isolated `live` lanes, stage timeout budgets, and cross-worktree gate locking. |
| [`21-voice-system-commands.md`](21-voice-system-commands.md) | **Voice System Commands & Catalogue** | Deterministic, zero-latency voice commands (`lib/system-commands.mjs`) for clipboard, theme switching, panel navigation, and audio/session control. |
| [`23-pluggable-live-models.md`](23-pluggable-live-models.md) | **Pluggable Live Models** | Public harness API, Gemini 3.8 Thinking, OpenAI Realtime, SVG/ASCII layers, audio negotiation and bounded tools. |
| [`22-roadmap-epics.md`](22-roadmap-epics.md) | **Roadmap & Unimplemented Epics** | Catalogue of the 6 major unimplemented platform epics (shared rooms, branch landing inspector, local STT/TTS, multi-harness diff comparison, OS hotkey bridge, and Wasm concurrency). |

---

## 2. Security, Sandboxing & Credential Custody

Voicebox enforces capability boundaries through host-held credentials, explicit extension admission, and OS-level sandboxing:

| Document | Topic | Summary |
|---|---|---|
| [`07-extension-admission.md`](07-extension-admission.md) | **Extension Admission & Capability Gate** | How extension proposals are staged, inspected via capability disclosure plans, and admitted using the host token or one-time console approval codes. |
| [`08-wire-protocol.md`](08-wire-protocol.md) | **Wire Protocol & Channel Contract** | Call and observation envelopes (`core/wire.ts`), `lib/channel.mjs` RPC semantics, and WebSocket `/channel` authentication. |
| [`09-proxied-custody.md`](09-proxied-custody.md) | **Proxied Custody & Pairing** | How the local host manages `0600` credentials in `HOST_DIR`, pairs with remote environments (`POST /api/pair`), revokes pairings (`DELETE /api/pair`), and proxies calls. |
| [`13-local-browser-authentication-options.md`](13-local-browser-authentication-options.md) | **Loopback Authentication Analysis** | Security evaluation of local browser authentication models (Origin validation, bootstrap tickets, and WebCrypto pairing). |
| [`14-s3-l2-bridge-decision.md`](14-s3-l2-bridge-decision.md) | **Sandbox Network Architecture Decision** | Architectural rationale for keeping interactive voice servers at L1.5 (shared network for cloud model WebSockets) while reserving `--unshare-net` for offline batch tasks. |
| [`15-sandbox.md`](15-sandbox.md) | **Environment Sandboxing & Probes** | How L1 (`tools/fence.sh`) and L1.5 (`tools/fence-unit.sh`) sandboxes bound filesystems and processes, how `GET /api/probe` measures boundaries, and how `/exec` runs. |
| [`18-loopback-session-auth.md`](18-loopback-session-auth.md) | **Loopback Session Gate (`VOICEBOX_LOOPBACK_AUTH=1`)** | Opt-in single-use bootstrap ticket (`?bootstrap=`) and `HttpOnly` session cookie protection for local HTTP and WebSocket endpoints. |

---

## 3. Capabilities, Coding Harnesses & Mini-Apps

Guides covering task delegation to external coding agents, interactive Web MCP Mini-Apps, and WebAssembly tools:

| Document | Topic | Summary |
|---|---|---|
| [`10-delegate-task-d1.md`](10-delegate-task-d1.md) | **Task Delegation & Durable Handles** | Authenticated task admission (`delegate_task`), sealed root-bound task addresses, private audit persistence, and outcome classification. |
| [`11-acp-adapter.md`](11-acp-adapter.md) | **Agent Client Protocol (ACP) Adapters** | Integrating external coding agents (`lib/pi-acp.mjs` and `lib/claude-acp.mjs`) over stdio JSON-RPC with bounded timeouts and cancellation. |
| [`12-harness-inventory.md`](12-harness-inventory.md) | **Installed Harness Inventory** | Discovering installed coding agent CLIs (`GET /api/harnesses`, `tools/list-harnesses.mjs`) and operator-declared tool catalogues. |
| [`16-zero-server-delegation.md`](16-zero-server-delegation.md) | **Zero-Server Browser Delegation** | Running task delegation across `browser`, `machine`, and `remote` placements with portable `opfs`, `handle`, and `machine` roots (`lib/task-placement.mjs`). |
| [`17-mini-apps-architecture.md`](17-mini-apps-architecture.md) | **Interactive Mini-Apps (Web MCP)** | Double-iframe sandbox architecture (`/mini-app-bridge.html`), private `MessagePort` RPC, and live voice tool registration via `window.webMcp`. |
| [`20-webassembly-tools.md`](20-webassembly-tools.md) | **WebAssembly Tool Shelf** | Authoring, compiling (`tools/build-wasm.mjs`), digest-pinning, and executing isolated `.wasm` modules (`buffer-abi/1` and `buffer-abi/diff`). |

---

## 4. Historical Design Archive & Empirical Evidence

Early pre-implementation spike notes (archived under `docs/archive/`) and empirical test receipts (under `docs/evidence/`):

- **Archived Pre-Implementation Notes (`docs/archive/`)**:
  - [`docs/archive/00-brief.md`](archive/00-brief.md) — Initial spoken product brief and foundational goals.
  - [`docs/archive/01-questions.md`](archive/01-questions.md) — Early architectural questions and trade-offs.
  - [`docs/archive/02-environment.md`](archive/02-environment.md) — Pre-implementation environment spike notes.
  - [`docs/archive/03-architecture-k3.md`](archive/03-architecture-k3.md) — Early harness transport and permission exploration.
  - [`docs/archive/04-e1-m0-build-spec.md`](archive/04-e1-m0-build-spec.md) — Initial milestone build specification.
  - [`docs/archive/05-harvest.md`](archive/05-harvest.md) & [`docs/archive/06-dynamic-tools.md`](archive/06-dynamic-tools.md) — Prior-art surveys and dynamic tool evaluations.
  - [`docs/archive/interface.md`](archive/interface.md) — Early studio/beside/return interface exploration.
  - [`docs/archive/live-fixes.md`](archive/live-fixes.md) — Historical log of early live audio fixes.
- **Empirical Evidence Receipts (`docs/evidence/`)**:
  - [`docs/evidence/substrate-20260919/RECEIPT.md`](evidence/substrate-20260919/RECEIPT.md) — Measurements of runtime permission flags, symlink resolution, and child process bounds.
  - [`docs/evidence/opfs-20260919/RECEIPT.md`](evidence/opfs-20260919/RECEIPT.md) — Browser Origin Private File System (OPFS) activation and persistence measurements.
  - [`docs/evidence/picked-dir-symlink/RECEIPT.md`](evidence/picked-dir-symlink/RECEIPT.md) — Probe instrument for symlink behavior inside user-picked browser directories.

---

## 5. How Documentation Stays Verified

`scripts/docs-check.mjs` automatically verifies the documentation against the live codebase on every test run (`tests/docs-drift.test.mjs`):

1. **Generated Runtime Blocks**: Capabilities, routes, turn resolvers, live voice models, and environment variables between `<!-- BEGIN GENERATED: ... -->` and `<!-- END GENERATED: ... -->` markers in `README.md`, `docs/07-architecture.md`, and `docs/08-how-it-runs.md` are derived directly from a live scratch server and source modules. Run `npm run docs:write` to update them.
2. **File Path Existence**: Every backticked repository file path in `README.md` and `docs/*.md` is checked to ensure the referenced file exists on disk.
3. **Policy Claims (`docs/claims.json`)**: Enforces required architectural invariants and blocks retired terminology from reappearing in hand-written prose.
