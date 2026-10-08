# System Architecture

This document describes the runtime architecture of Voicebox as implemented in the repository. All generated sections below are verified against the live codebase and server by `scripts/docs-check.mjs` (`npm run docs:check`).

---

## 1. Component Overview

| Component | Key Files | Responsibility |
|---|---|---|
| **Browser Interface** | `public/index.html`, `public/fused.js`, `public/style.css`, `public/live-voice.js`, `public/pip-mic.mjs` | Renders the centered voice stage (`#mic`, `#text-form`), floating pop-over bubble tray (`#sqeh-deck`) for Files (`#sqeh-files-bubble`, `#made-list`), File Viewer (`#sqeh-reader-bubble`, `#reader`), Mini-Apps (`#sqeh-actions`, `#mini-app-container` — rendering active workspace and launched apps without hardcoded default apps), and Recent Turns (`#sqeh-toggle-history`, `#session`), plus top-bar dialogs for Settings, Harnesses, Extensions, and Environments (integrating project workspace and machine/browser root configuration directly within the room UI, with a setup guide that says what setup does, why it is needed and in what order, and project creation by name). |
| **HTTP & WebSocket Server** | `server.mjs`, `lib/ws-server.mjs` | Zero-dependency (`node:http`) loopback server binding `127.0.0.1`, serving static assets, REST API routes, `/live` voice WebSockets, and `/channel` routed-action sockets. |
| **Live Voice Gateway** | `lib/live-session.mjs`, `lib/commands.mjs`, `lib/project-instruction.mjs` | Manages full-duplex streaming audio and tool-call execution with Gemini Multimodal Live and OpenAI Realtime. |
| **Turn Resolver** | `lib/resolver.mjs` | Translates text transcripts from `POST /api/turn` into structured actions (`write`, `read`, `list`, `make-tool`, `tool`, etc.). |
| **Policy & Domain Core** | `core/root.ts`, `core/extensions.ts`, `core/tasks.ts`, `core/wire.ts`, `core/fleet.ts`, `core/harness-config.ts`, `core/mini-app.ts`, `core/paths.ts`, `core/tier-table.ts` | Runtime-agnostic pure TypeScript modules defining workspace roots, capability admission rules, task state machines, wire envelopes, and path normalization. Imports nothing outside `core/`. |
| **Host Capabilities** | `lib/state-dirs.mjs`, `lib/extensions.mjs`, `lib/wasm-shelf.mjs`, `lib/tasks.mjs`, `lib/task-placement.mjs`, `lib/fleet.mjs`, `lib/harness-config.mjs` | Server-side implementations of extension admission, digest-pinned WebAssembly execution (`tools/create-asset.wat`), ACP task delegation, and multi-environment fleet routing. |
| **Dev Proxy** | `vite.config.js`, `lib/browser-sources.mjs` | Development-only HMR front-end server on port `5173` that proxies `/api`, `/live`, `/channel`, and browser module graphs (`core`, `browser`, `tools`, `tests`, `lib`) to `server.mjs`. |

---

## 2. Live Voice Architecture & Barge-In

`public/live-voice.js` captures microphone audio through the `pcm-worklet.js` AudioWorklet and streams PCM frames over `/live` to `lib/live-session.mjs`.

<!-- BEGIN GENERATED: live-session — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
**Live Voice Providers (`lib/live-session.mjs`)**: `claude` (`(registered, but this check has no capture for it)`), `gemini` (`models/gemini-3.8-live`), `openai` (`gpt-realtime`). The default fallback provider is `gemini` (configurable via `VOICEBOX_LIVE_PROVIDER` or selected per session in the UI Settings dialog).
<!-- END GENERATED: live-session -->

### Full-Duplex Barge-In Detection
While the assistant is speaking, microphone capture remains active so you can interrupt naturally at any time:
1. **Adaptive Client Energy Detection**: `public/live-voice.js` monitors incoming microphone frame energy against both an absolute floor and an adaptive quiet baseline measured at the microphone. Sustained voice energy above the threshold immediately flushes local audio playback and sends `{ type: "interrupt" }` over `/live`.
2. **Upstream Cancellation & Buffer Flush**: On receiving `{ type: "interrupt" }`, `/live` invokes `session.interrupt()` (canceling active OpenAI Realtime generation; Gemini Live detects barge-in server-side). When the upstream provider emits an interrupt event, the server forwards `state: "interrupt"` to the browser to flush any remaining buffered audio frames.

---

## 3. Workspace Roots & Turn Resolution

```
Browser UI ──POST /api/turn { transcript }──▶ server.mjs ──resolveTurn()──▶ lib/resolver.mjs
           ◀── { transcript, action, result } ── Executes action in active project root
```

Voicebox supports both **machine-owned** filesystem roots (`kind: "machine"`) and **browser-owned** roots (`kind: "opfs"` for Origin Private File System or `kind: "handle"` for directories opened via the File System Access API, defined in `core/root.ts`):
- **Declaring a Machine Root**: Re-points server-side file operations on the host machine and therefore requires `x-voicebox-host-token` on `POST /api/root` (`declaredBy: "host"`).
- **Declaring a Browser Root**: `opfs` and `handle` roots reside in the browser (`ROOT_FACTS.opfs.reachableFrom = ["page"]` in `core/root.ts`). Same-origin browser requests can declare page-owned roots directly (`declaredBy: "page"`), and routed file operations execute in the browser via `browser/acts.ts` (refusing mismatched roots with `root-not-mine`).
- **Default Browser Scratchpad Fallback**: When no machine root is declared and no local folder is open, file creation turns in the browser default to the origin's OPFS `scratchpad/` directory so users can create and inspect files immediately on first launch.
- **Project Instructions (`AGENTS.md`)**: `lib/project-instruction.mjs` locates the nearest `AGENT.md` or `AGENTS.md` file (bounded to 32 KiB) from the active folder up to the root and includes it in the model's system instructions.

<!-- BEGIN GENERATED: providers — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
**Registered turn resolvers** (`lib/resolver.mjs`): `claude`, `gemini`, `openai`, `script`

* **Registration & Dispatch**: `registerResolver(name, fn)` registers a text turn resolver; `resolveTurn(transcript, provider = "script")` resolves a user transcript into a structured action.
* **Deterministic Script Resolver (`script`)**: Maps common file and tool commands without requiring an external API key (for example, `"create a file called hello.txt with hi"` → `{"verb":"write","name":"hello.txt","content":"hi"}`).
* **Supported Verbs**: `write`, `read`, `list`, `make-tool`, `tool`. Prompts outside the deterministic grammar return an explicit `unresolved` response (for example, `"book me a flight to Lisbon"` → `"the script resolver only knows create/read…"`).
* **Live Voice Providers**: Full-duplex audio providers (`claude`, `gemini`, `openai`) are registered separately via `registerLiveProvider` in `lib/live-session.mjs` and stream audio and tool calls over `/live`.
<!-- END GENERATED: providers -->

---

## 4. The Agent Loop

<!-- BEGIN GENERATED: loop — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
The table below traces a complete turn executed against a temporary workspace during documentation generation:

| Step | Stage | Mechanism | Verified Output |
|---|---|---|---|
| **1. Turn Request** | Client submits transcript | `POST /api/turn { transcript }` | `"create a file called hello.txt with hi"` |
| **2. Turn Resolution** | Resolver parses transcript into an action | `resolveTurn(transcript, "script")` in `lib/resolver.mjs` | `{"verb":"write","name":"hello.txt","content":"hi"}` |
| **3. Action Execution** | Executor runs action inside the active root | `execute(action)` in `server.mjs` (`POST /api/root`) | `wrote hello.txt (2 bytes)` (`root.kind: "machine"`) |
| **4. Turn Response** | Server returns structured result to client | `{ transcript, action, result }` | `ok: true`, `logged: 2` |
| **5. Audit Trail** | Append-only log records **2 entries** (`attempt`/`attempted` → `allow`/`writes-inside`, linking outcome to attempt sequence) and 1 entry for pre-flight refusal | `<root>/.audit/<writer>.jsonl` (`core/shared-log.ts`), `GET /api/audit` | seq 1 `attempt`, seq 2 `allow`; refusal: seq 3 `refuse`/`outside-root` |

**Boundary & Admission Guarantees (Verified Against Live Server):**
* **Undeclared Root Refusal**: Running the turn before declaring a project root returns `refused: "root-not-declared"` (`logged: null`). Once declared via `POST /api/root` (`ok: true`, `reachableFromThisProcess: true`), the turn succeeds.
* **Path Containment**: Attempting to read outside the workspace (`"read .."`) is refused with `refused: "outside-root"` and logged at audit sequence `3`.
* **Extension Lifecycle (`make-tool` → `admit` → `tool`)**:
  1. **Propose**: `"create a tool called peek that lists files"` resolves to `make-tool` and writes a pending descriptor (`proposed tool 'peek-tool'`, state `pending`) under `proposals/` without loading code.
  2. **Inspect Plan**: `GET /api/extensions/proposals/peek-tool/plan` previews the admission verdict (`admitted`; enforced: read via `host-primitive-scope`).
  3. **Host Admission**: `POST /api/extensions/admit` with `x-voicebox-host-token` admits the descriptor (`admitted`); requests without the host token fail with HTTP 403 (`host-token-required`).
  4. **Invoke**: `"run the tool peek"` dispatches `tool` → `callTool("peek")` in `lib/extensions.mjs` (`ok: true`, files `["hello.txt"]`).
  5. **Inventory**: `GET /api/extensions` lists `peek-tool` with declared capabilities `[read]`, enforcement `{"read":"host-primitive-scope"}`, and tools `[peek]`.

**Unified Workspace Root**: Admitted file extensions operate on the active project root (`["hello.txt"]`).
<!-- END GENERATED: loop -->

### Extension Registry Integrity at Startup
When the server starts or reloads the extension registry, `lib/extensions.mjs` re-runs the admission gate (`core/extensions.ts`) on every admitted descriptor and cross-checks `.ledger.jsonl`:
- Any admitted descriptor that fails validation, fails JSON parsing (`unreadable`), or was deleted from disk (`descriptor-missing`) is reported in `failedLoads` on `GET /api/extensions` and displayed in the Extensions UI as **Approved, not running** (`tests/extension-init-errors.test.mjs`, `tests/extensions-ui.test.mjs`).

---

## 5. Input Paths & Tool Surface

<!-- BEGIN GENERATED: tool-path — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
User input reaches the shared action executor through three paths:

| Input Path | Active | Transport | Execution Pipeline |
|---|---|---|---|
| **Text Composer** | Yes | `public/fused.js` → `POST /api/turn` | `resolveTurn()` (`lib/resolver.mjs`, default `script`) → `execute()` (`server.mjs`) → `callTool()` (`lib/extensions.mjs`) |
| **Browser Dictation** (`SpeechRecognition`) | Yes | `public/fused.js` → `POST /api/turn` | Same pipeline as Text Composer |
| **Live Voice Audio** | Audio: Yes; Tools: **Yes** | `public/live-voice.js` → `/live` → `lib/live-session.mjs` | Provider tool call → `commandToAction()` → `execute()` → correlated tool response + `{type:"tool"}` UI notification |

**Live Session Tool Declarations**: `claude` declares: (not captured); `gemini` declares: `list_extensions`, `call_extension`, `propose_extension`, `write_file`, `read_file`, `list_files`, `delete_file`, `edit_file`, `diff_file`, `grep_files`, `list_agents`, `delegate_task`, `contact_agent`, `launch_mini_app`, `git_status`, `git_diff`, `git_log`, `inspect_environment`, `undo_last_action`, `list_tools`, `search_tools`, `run_command`, `open_workspace`; `openai` declares: `list_extensions`, `call_extension`, `propose_extension`, `write_file`, `read_file`, `list_files`, `delete_file`, `edit_file`, `diff_file`, `grep_files`, `list_agents`, `delegate_task`, `contact_agent`, `launch_mini_app`, `git_status`, `git_diff`, `git_log`, `inspect_environment`, `undo_last_action`, `list_tools`, `search_tools`, `run_command`, `open_workspace`.

**Script Resolver Sample Utterances**: `"create a file called hello.txt with hi"` → `write`, `"read hello.txt"` → `read`, `"list files"` → `list`, `"create a tool called clock that tells the time"` → `make-tool`, `"run the tool clock"` → `tool`.
<!-- END GENERATED: tool-path -->

<!-- BEGIN GENERATED: tools — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
**Built-In Extension Primitives** (`6` closed primitives in `core/extensions.ts`; extensions parameterize primitives as pure JSON descriptors rather than executing arbitrary model-authored code):

| Primitive | Capability Required | Host-Mediated Interface |
|---|---|---|
| `now` | — | Returns current host timestamp |
| `read-file` | read | a root-scoped read function: paths resolve inside the project root or refuse |
| `write-file` | write | a root-scoped write function: paths resolve inside the project root, writes are reported and revertible |
| `list-files` | read | a root-scoped read function: paths resolve inside the project root or refuse |
| `http-get` | network | a mediated fetch: hosts outside bounds.hosts are refused by name — INCLUDING across redirects, every hop charged to bounds.maxRequests — and the audit records the URL that actually served the bytes |
| `wasm` | — | Isolated WebAssembly module verified by SHA-256 digest at admission and invocation under strict host memory and timeout ceilings |

**Capabilities Prohibited on `machine` Placement**:
* exec — absent: no mechanism on this placement bounds a spawned child: --allow-run bounds which binary, never what it can do, and a child does not inherit the parent's flags. Admission requires a container that bounds the child.
* eval — absent: eval is not a tool path (design §1.7): the evaluator bypasses whatever the substrate would otherwise enforce.
* import — absent: no import boundary on this placement: dynamic import executes fetched code with no flags by default.

**Extension Catalogue (`catalogue/*.json`, 4 descriptors)**:

| Extension ID | Tools | Declared Capabilities | Bounds | Admission Verdict |
|---|---|---|---|---|
| `brave-search` | `brave_search` → `http-get` | network | hosts: api.search.brave.com; maxRequests: 20 | admitted — network via `mediated-fetch` |
| `mcp-server-local` | `mcp_list_tools` → `process` | exec | command: npx -y @modelcontextprotocol/server-filesystem /tmp | **refused** `exec-absent` |
| `mcp-server-remote` | `mcp_remote_list_tools` → `http-get` | network | hosts: mcp.example.com; maxRequests: 20 | admitted — network via `mediated-fetch` |
| `web-search` | `web_search` → `http-get` | network | hosts: api.duckduckgo.com; maxRequests: 5 | admitted — network via `mediated-fetch` |

**Named Refusal Codes by Subsystem**:
* **Extension admission gate (`core/extensions.ts`)**: `absent-capability`, `bad-tool-name`, `capability-unmediated`, `duplicate-tool`, `eval-not-a-tool-path`, `exec-absent`, `network-unbounded`, `no-tools`, `under-declared`, `unknown-capability`, `unknown-primitive`, `unsupported-abi`
* **HTTP routes and workspace root boundary (`server.mjs`, `core/root.ts`, `browser/acts.ts`)**: `adapter-not-configured`, `approval-invalid-id`, `approval-json-required`, `audit-unreadable`, `bad-answer`, `bad-json`, `bad-request`, `bearer-refused`, `body-too-large`, `bounds-invalid`, `cannot-delete-directory`, `cannot-delete-local`, `cross-environment-unauthorized`, `dotfile-refused`, `environment-not-paired`, `environment-unknown`, `environment-unreachable`, `exec-threw`, `executor-unavailable`, `extension-not-admitted`, `git-failed`, `host-token-refused`, `host-token-required`, `invalid-task`, `loopback-auth-disabled`, `loopback-unauthenticated`, `mini-app-timeout`, `mini-app-unreachable`, `missing-argument`, `missing-content`, `no-project`, `not-a-directory`, `not-a-git-repo`, `not-found`, `not-supported-in-browser`, `nothing-to-undo`, `outside-root`, `pairing-revoked`, `path-missing`, `pattern-not-found`, `pattern-not-unique`, `probe-failed`, `provider-not-configured`, `root-not-mine`, `root-not-reachable-from-here`, `root-unreachable`, `server-error`, `task-root-unavailable`, `unauthenticated-call`, `undo-failed`, `unknown-command`, `unknown-environment`, `unknown-mini-app-tool`, `unknown-root-kind`, `unknown-verb`, `unreadable`, `write-error`
* **Extension runtime (`lib/extensions.mjs`)**: `approval-audit-unwritable`, `approval-no-proposal`, `approval-plan-changed`, `approval-unavailable`, `bad-descriptor`, `bad-redirect`, `bad-tool-name`, `bounds-invalid`, `descriptor-missing`, `extension-not-admitted`, `fetch-failed`, `gate-refused-at-load`, `invalid-id`, `missing-description`, `missing-name`, `network-unbounded`, `no-tools`, `over-budget`, `params-invalid`, `params-unknown-tool`, `redirect-host-not-allowed`, `redirect-without-location`, `too-many-redirects`, `unknown-primitive`, `unreadable`
* **Task delegation and lifecycle (`core/tasks.ts`, `lib/tasks.mjs`)**: `agent-environment-mismatch`, `agent-not-configured`, `agent-required`, `executor-unavailable`, `invalid-task`, `invalid-task-address`, `invalid-task-context`, `task-audit-unavailable`, `task-authority-field`, `task-call-id-conflict`, `task-call-id-required`, `task-cancelled`, `task-capacity-exhausted`, `task-context-unavailable`, `task-deadline`, `task-environment-changed`, `task-environment-unverified`, `task-input-over-budget`, `task-invalid-result`, `task-not-found`, `task-not-running`, `task-output-over-budget`, `task-owner-mismatch`, `task-owner-unconfirmed`, `task-owner-unverified`, `task-persistence-failed`, `task-root-replaced`, `task-root-unavailable`, `unbounded-executor`, `unknown-tool`, `unsupported-runtime-capability`

**Runtime Inspection & Admission Endpoints**:
* `GET /api/extensions`: Returns `{ placement, extensions, proposals, present, failedLoads, catalogueCount }` (placement: `machine`, catalogueCount: 4).
* `GET /api/extensions/catalogue`: Previews admission verdicts for all catalogue descriptors.
* `GET /api/extensions/{proposals|catalogue}/<id>/plan`: Returns capability and enforcement disclosure prior to admission.
* `GET /api/probe`: Runs `tools/sandbox-probe.mjs` and returns an observed environment report (HTTP 200; sections: `identity`, `sandboxHints`, `filesystem`, `limits`, `tools`, `network`).
* `POST /api/extensions/admit`: Requires `x-voicebox-host-token` (unauthenticated requests fail with HTTP 403 `host-token-required`).
<!-- END GENERATED: tools -->

---

## 6. Environment Variables & Configuration

<!-- BEGIN GENERATED: config — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
Environment variables read by the server and runtime libraries:

| Variable | Read In | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `lib/live-providers/claude.mjs`, `lib/pi-acp.mjs`, `lib/resolver.mjs`, `server.mjs` | Anthropic API key used by the `claude` resolver/provider and forwarded to the `pi-acp` adapter as a fallback when no store credential exists (can also be configured in the UI Settings dialog). |
| `BRAVE_API_KEY` | `lib/extensions.mjs` | Brave Search API subscription token used by `http-get` extensions targeting `api.search.brave.com`. |
| `FORCE_COLOR` | `lib/logger.mjs` | Terminal color override (`0` disables ANSI colors in `lib/logger.mjs`; non-zero enables them when stdout is not a TTY). |
| `GEMINI_API_KEY` | `lib/gemini-models.mjs`, `lib/live-providers/gemini.mjs`, `lib/resolver.mjs`, `server.mjs` | Google Gemini API key for Gemini Live voice sessions and the `gemini` text turn resolver (can also be configured in the UI Settings dialog). |
| `LIVE_PROVIDER` | `lib/live-session.mjs`, `server.mjs` | Deprecated alias for `VOICEBOX_LIVE_PROVIDER`, retained for backward compatibility. |
| `NODE_DISABLE_COLORS` | `lib/logger.mjs` | Node.js built-in flag that disables ANSI terminal colors alongside `NO_COLOR`. |
| `NO_COLOR` | `lib/logger.mjs` | Disables ANSI color sequences in `lib/logger.mjs` when set to a non-empty value. |
| `OPENAI_API_KEY` | `lib/live-providers/openai.mjs`, `lib/resolver.mjs`, `server.mjs` | OpenAI API key for OpenAI Realtime voice sessions and the `openai` text turn resolver (can also be configured in the UI Settings dialog). |
| `PATH` | `lib/claude-acp.mjs`, `lib/tool-index.mjs` | System executable search path, also inherited by task-adapter child processes. |
| `PORT` | `server.mjs` | HTTP server port bound on `127.0.0.1` (default `8787`). |
| `VOICEBOX_ACP_ADAPTER` | `lib/pi-acp.mjs` | Path or command override for the `pi-acp` stdio adapter binary in `lib/pi-acp.mjs`. |
| `VOICEBOX_ACP_PI` | `lib/pi-acp.mjs` | Path or command override for the `pi` coding agent CLI used by `lib/pi-acp.mjs`. |
| `VOICEBOX_BIND_DEADLINE_MS` | `server.mjs` | Maximum duration in milliseconds to retry binding the server port before failing. |
| `VOICEBOX_BIND_RETRY_MS` | `server.mjs` | Interval in milliseconds between port bind retries at startup. |
| `VOICEBOX_CLAUDE_CLI` | `lib/claude-acp.mjs` | Path override for the Claude Code CLI executable (`CLAUDE_CODE_EXECUTABLE`) used by `lib/claude-acp.mjs`. |
| `VOICEBOX_CLAUDE_KEEP_API_KEY` | `lib/claude-acp.mjs` | Set to `1` to retain `ANTHROPIC_API_KEY` in the Claude Code adapter child environment (omitted by default so CLI login takes precedence). |
| `VOICEBOX_ENABLE_STUB_PROVIDER` | `server.mjs` | Set to `1` to register the key-free `stub` live voice provider for local audio testing. |
| `VOICEBOX_EXTENSIONS_DIR` | `lib/state-dirs.mjs` | Host state directory storing admitted extensions, `.host-token`, `.ledger.jsonl`, `.pairings.json`, `.api-keys.json`, and `.harness-settings.json` (mode `0600`). |
| `VOICEBOX_HARNESS` | `server.mjs` | Default host coding agent harness (`pi` or `claude`; can also be switched at runtime in the Harnesses UI dialog). |
| `VOICEBOX_HELLO_BOUND_MS` | `server.mjs` | Timeout in milliseconds to receive an authentication `hello` frame on `/channel` or `/live` (default `5000`). |
| `VOICEBOX_INSTANCE` | `server.mjs` | Writer identifier recorded in the active workspace's `.audit/<writer>.jsonl` log (default `machine`). |
| `VOICEBOX_LIVE_PROVIDER` | `lib/live-session.mjs`, `server.mjs` | Fallback live voice provider (`gemini`, `openai`, or `claude`) when the client session does not specify one. |
| `VOICEBOX_LOOPBACK_AUTH` | `server.mjs` | Set to `1` to require a single-use bootstrap ticket (`?bootstrap=<ticket>`) and `HttpOnly` session cookie for local browser access. Redemption answers `303` to the plain route with the ticket removed, so the first refresh is authenticated rather than a re-used-ticket `401`. **Default off** (accepted testing posture): with the gate off, unauthenticated loopback clients — including browser-originated requests — can reach state-mutating routes such as active-workspace writes, so the server prints a startup warning naming the exposure and this remedy (see `docs/18-loopback-session-auth.md`). |
| `VOICEBOX_OPENAI_INPUT_TRANSCRIPTION` | `lib/live-providers/openai.mjs` | Set to `1` to enable `gpt-4o-mini-transcribe` input audio transcription in the OpenAI Realtime session handshake. |
| `VOICEBOX_PROVIDER` | `server.mjs` | Deprecated alias for `VOICEBOX_RESOLVER`, retained for backward compatibility. |
| `VOICEBOX_RESOLVER` | `server.mjs` | Default text turn resolver used by `POST /api/turn` (`script`, `gemini`, `openai`, or `claude`; default `script`). |
| `VOICEBOX_SANDBOX_HOMES` | `lib/state-dirs.mjs` | Base directory for fenced sandbox home directories (default `~/sandbox-homes/<key>`, located outside `/tmp` for `PrivateTmp` compatibility). |
| `VOICEBOX_WASM_SHELF_DIR` | `lib/state-dirs.mjs` | Directory containing the digest-pinned WebAssembly tool shelf (`manifest.json` and `.wasm` binaries; default `~/.isocan/modules/wasm-tools`). |
| `VOICEBOX_WORKSPACE` | `lib/state-dirs.mjs` | Declares an active machine project root at startup and stores extension proposals (`proposals/`) and extension audit logs (`audit.jsonl`). |
<!-- END GENERATED: config -->

---

## 7. HTTP Routes & Frontend Scripts

<!-- BEGIN GENERATED: routes — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
The HTTP server (`server.mjs`, built on `node:http`) binds **127.0.0.1** and serves the core routes below:

| Method | Route | Probed Status |
|---|---|---|
| `GET` | `/` | 200 |
| `GET` | `/api/health` | 200 |
| `GET` | `/api/files` | 200 |
| `POST` | `/api/turn` | 200 |

Static frontend assets are served from `public/`. `GET /api/health` reports the active turn resolver (`provider: "script"`), whether a workspace root is declared (`declared: false`), and the active `root: { kind, path }` configured via `POST /api/root`. Before a root is declared, root-scoped file operations return `root-not-declared`.

A WEBSOCKET UPGRADE ON /live IS ACCEPTED (101) — the zero-dependency server owns it.
<!-- END GENERATED: routes -->

<!-- BEGIN GENERATED: page — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
`public/index.html` loads `fused.js`, `pip-mic.mjs`, `live-voice.js` from `public/`.
AudioWorklet modules loaded by the frontend audio engine: `pcm-worklet.js`.

`verify.mjs` resides in `public/` as a standalone verification utility and is not loaded by `index.html`.
<!-- END GENERATED: page -->

---

## 8. Subsystem Ownership & Boundaries

- **`server.mjs`**: Owns HTTP routing, WebSocket upgrade gates, and the central action executor (`execute()`). Always binds `127.0.0.1`.
- **`lib/state-dirs.mjs`**: Single owner for host state directory resolution (`VOICEBOX_WORKSPACE`, `VOICEBOX_EXTENSIONS_DIR`, `VOICEBOX_WASM_SHELF_DIR`, `VOICEBOX_SANDBOX_HOMES`), enforced statically by `scripts/single-owner.mjs` and `tests/single-owner.test.mjs`. Expands leading tildes (`~`) to `os.homedir()` across state directory values and operator declarations (`workspaceDeclared()`, `sandboxHomesDeclared()`), enabling boot root declarations (e.g. `VOICEBOX_SANDBOX_HOMES=~/my-dir` or `VOICEBOX_WORKSPACE=~/my-dir`) to resolve and auto-create fresh directories without requiring manual UI folder selection. Used across `server.mjs`, `lib/resolver.mjs`, `lib/extensions.mjs`, `tools/approval-code.mjs`, `lib/fence-provider.mjs`, and `lib/unit-fence-provider.mjs`.
- **`lib/path-auth.mjs`** (voicebox-beads-q0a3): Single owner for machine-side path authorization — root-kind handling (the reachability seam), lexical containment (`core/paths.ts`), the walk-up `realpath` containment, the audit guard, and the segment-wise dotfile denial, in that order. Every file verb (`server.mjs`), admitted extension tool (`lib/extensions.mjs`), mini-app store writer (`lib/mini-app-store.mjs`), cwd containment (`lib/tool-index.mjs`, `tools/env-serve.mjs`) and transport guard (`lib/env-transport.mjs`) asks it; `scripts/single-owner.mjs` refuses a second copy of any of the three shapes (declared as `SITES`), and drives the owner on a scratch tree so a declaration that stops refusing fails the gate.
- **`lib/acp-client.mjs`, `lib/pi-acp.mjs`, `lib/claude-acp.mjs`**: Own the Agent Client Protocol (ACP) client and stdio adapters. Each adapter enforces bounded execution timeouts (60s default ceiling for Pi; 120s `CLAUDE_ACP_TIMEOUT_CEILING_MS` for Claude Code, meta-capped at 600s).
- **`core/harness-config.ts` & `lib/harness-config.mjs`**: Own the configured-agent schema and atomic registry persistence (`GET` / `POST /api/agents`, `PATCH /api/agents/:id`), supporting both server and zero-server browser placements (`lib/task-placement.mjs`, [`docs/16-zero-server-delegation.md`](16-zero-server-delegation.md)).
- **`public/fused.js`**: Owns the browser workspace UI, including:
  - **Pop-Over Bubble Tray (`#sqeh-deck`)**: Toggles the Files popover (`#sqeh-files-bubble`, `#made-list`), floating File Viewer (`#sqeh-reader-bubble`, `#reader`), Mini-App launcher bubbles (`#sqeh-actions`), and Recent Turns popover (`#sqeh-toggle-history`, `#session`).
  - **Directory Navigation & File Management**: Uses `normaliseRelativeDir` in `core/paths.ts` for breadcrumb folder navigation (`tests/room-explorer-ui.test.mjs`, `tests/room-file-list-polish.test.mjs`) and confirmation-gated file deletion via `DELETE /api/file`.
  - **Room Folders Bar & Handle Management**: Manages multi-directory handle adoption, persistence, active folder switching, and observable initialization synchronization (`window.__voiceboxRoomFoldersReady`, `window.__voiceboxClearAllRoomFolders`, `tests/room-folders.test.mjs`).
