# System Architecture

This document describes the runtime architecture of Voicebox as implemented in the repository. All generated sections below are verified against the live codebase and server by `scripts/docs-check.mjs` (`npm run docs:check`).

---

## 1. Component Overview

| Component | Key Files | Responsibility |
|---|---|---|
| **Browser Interface** | `public/index.html`, `public/fused.js`, `public/style.css`, `public/live-voice.js`, `public/pip-mic.mjs`, `public/extensions-ui.mjs`, `public/settings-ui.mjs` | Renders the centered voice stage (`#mic`, `#text-form`), floating pop-over bubble tray (`#sqeh-deck`) for Files (`#sqeh-files-bubble`, `#made-list`), File Viewer (`#sqeh-reader-bubble`, `#reader`), Mini-Apps (`#sqeh-actions`, `#mini-app-container` — rendering active workspace and launched apps without hardcoded default apps), and Recent Turns (`#sqeh-toggle-history`, `#session`), plus top-bar dialogs for Settings, Harnesses, Extensions, and Environments (integrating project workspace and machine/browser root configuration directly within the room UI, with a setup guide that says what setup does, why it is needed and in what order, and project creation by name). |
| **HTTP & WebSocket Server** | `server.mjs`, `lib/routes/workspace.mjs`, `lib/routes/extensions.mjs`, `lib/routes/presence.mjs`, `lib/routes/activity.mjs`, `lib/routes/agents-read.mjs`, `lib/routes/changelog.mjs`, `lib/ws-server.mjs` | Zero-dependency (`node:http`) loopback server binding `127.0.0.1`, serving static assets and REST API routes (workspace file/list/grep, extension inventory/staging/decisions, GET/POST presence, GET/DELETE activity, GET agents and GET changelog handlers live in route modules), `/live` voice WebSockets, and `/channel` routed-action sockets. |
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
* **HTTP routes and workspace root boundary (`server.mjs`, `lib/routes/workspace.mjs`, `lib/routes/extensions.mjs`, `lib/routes/presence.mjs`, `core/root.ts`, `browser/acts.ts`)**: `adapter-not-configured`, `approval-invalid-id`, `approval-json-required`, `audit-unreadable`, `bad-answer`, `bad-json`, `bad-request`, `bearer-refused`, `body-too-large`, `bounds-invalid`, `cannot-delete-directory`, `cannot-delete-local`, `cross-environment-unauthorized`, `dotfile-refused`, `environment-not-paired`, `environment-unknown`, `environment-unreachable`, `exec-threw`, `executor-unavailable`, `extension-not-admitted`, `git-failed`, `host-token-refused`, `host-token-required`, `invalid-task`, `loopback-auth-disabled`, `loopback-unauthenticated`, `mini-app-timeout`, `mini-app-unreachable`, `missing-argument`, `missing-content`, `no-project`, `not-a-directory`, `not-a-git-repo`, `not-found`, `not-supported-in-browser`, `nothing-to-undo`, `outside-root`, `pairing-revoked`, `path-missing`, `pattern-not-found`, `pattern-not-unique`, `probe-failed`, `provider-not-configured`, `root-not-mine`, `root-not-reachable-from-here`, `root-unreachable`, `server-error`, `task-root-unavailable`, `unauthenticated-call`, `undo-failed`, `unknown-command`, `unknown-environment`, `unknown-mini-app-tool`, `unknown-root-kind`, `unknown-verb`, `unreadable`, `unsupported-content-type`, `write-error`
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

`lib/routes/presence.mjs` owns only exact `GET /api/presence` and `POST /api/presence` table handlers. `server.mjs` still constructs the single room-presence coordinator, applies the global loopback auth wall before dispatch, and supplies its bounded JSON reader, response writer and channel broadcaster; the route does not copy those security and lifecycle owners (`voicebox-beads-gdq2.1`).

`lib/routes/activity.mjs` owns only exact `GET /api/activity` and `DELETE /api/activity` table handlers. `server.mjs` retains the one mutable activity buffer, its producers, bounded trimming and workspace-reset behavior; the route receives that same array and clears it in place, never replacing the producer's reference. The global loopback wall remains host-owned (`voicebox-beads-gdq2.2`).

`lib/routes/agents-read.mjs` owns only exact `GET /api/agents`: it filters the host registry and applies a public, secret-free projection plus the admission verdict from a **fresh host context on each GET**. `server.mjs` continues to own mutable harness/adapter configuration, the global loopback auth wall and the separate privileged `POST /api/agents` and `PATCH /api/agents/:id` handlers. The registration alias `environmentKey: "local"` is projected as this host's minted environment key when querying the registry (`voicebox-beads-gdq2.3`).

`lib/routes/changelog.mjs` owns only exact `GET /api/changelog` and its single private cache. It preserves the host's raw `.git/HEAD` plus ref-mtime `:v2` key, cache miss when HEAD is unavailable (as in a worktree `.git` file), bounded `git log` execution and original 200/500 JSON envelopes. Global loopback auth, the separate git-log tool verb, and the following HEAD/GET health handlers remain in `server.mjs` (`voicebox-beads-gdq2.4`).

**A staged Content-Security-Policy — reported, not enforced** (voicebox-beads-ul1m.1; parent `voicebox-beads-ul1m`, ADR `voicebox-beads-28sc`). Responses to the room, `help.html`, `changelog.html`, `environment.html` and `harnesses.html` carry `Content-Security-Policy-Report-Only` holding, character for character, the policy `public/index.html` already enforces through its meta tag — six request spellings covering five documents, since `/` and `/index.html` are the same file. Nothing is blocked: every violation carries `disposition=report`, and there is deliberately no report endpoint, so violations appear in a devtools console and in the page's own `securitypolicyviolation` event — which is how `tests/csp-report-only-browser.test.mjs` asserts them. **The header is keyed on the RESOLVED FILE, never on the requested URL and never on a content type**: `cspReportOnlyHeaders` takes the path that `resolvePublicFile` has already decoded, containment-checked and realpath'd, and reduces it to its public path. That is a fix for a hole a reviewer found rather than the original shape: keyed on the raw request path, `/%68elp.html`, `/help%2Ehtml` and `/help.html/` all reached the same Help document and were served with no header at all, the trailing-slash spelling needing no encoding to type. Patching the comparison with a decode would have closed those three and left the next alias open; keying on the file collapses every spelling — encodings, dot segments, trailing slashes — to one string by construction, and `tests/csp-report-only.test.mjs` asserts that each alias carries the policy AND serves the same bytes as the canonical spelling, with traversal and case-mismatch spellings asserted as still unresolvable so "covered everywhere" cannot be satisfied by covering everything. It remains a list of documents rather than a rule phrased as "any `text/html` response", which would silently cover the mini-app pages under `public/apps/`, the `mini-app-bridge.html` host — excluded because it is the frame that renders user HTML, and because `srcdoc` children inheriting that policy is spec behaviour this change did NOT measure and so did not rely on — and every document added later by someone who never read the server code. Those are excluded, along with every asset and `/api` route. **What the reports currently say is nothing at all.** The worklist emptied with `voicebox-beads-xggy.3`, which moved `environment.html`'s inline stylesheet to `public/environment.css` and its one inline style attribute to a rule in that file: both were what `style-src 'self'` and `style-src-attr` would have blocked, and both are gone. That page also declares its scheme in the head as a `<meta name="color-scheme">`. Its effect is narrower than it first appears: measured with the real external stylesheet, on both OS schemes, the page's own first painted frame is identical with and without the meta, because the render-blocking stylesheet already supplies the scheme and the ground. What the meta reaches was measured on one surface only: the canvas the browser draws for the page. With `/environment.css` held so that the stylesheet could not supply a scheme at all, the UA's `Canvas` resolves dark with the meta and light without it on an otherwise identical page, and `CanvasText` follows. Scrollbars and the caret run on the same mechanism and the same hint covers them, but those surfaces were NOT driven here and this page does not claim to have measured them. A preventive hint, not a fix for a flash in the page's own content. Its root-declaration script was the third until it was extracted to `public/environment-root.js` (voicebox-beads-xggy.2), and `help.html`'s search filter went the same way to `public/help-search.js` (voicebox-beads-xggy.1); an inline script is the one thing `script-src 'self'` would block, and the Modern Web Guidance security guide names refactoring as the alternative to nonces and hashes. **Both of that page's scripts are loaded WITHOUT `defer`, deliberately, and that is a behaviour requirement rather than a style choice** — `environment-root.js` for the declaration and `environment-dialogs.js` for the create-project opener (voicebox-beads-5tv3). Inline at the end of `<body>` it ran while the document was still parsing, so its click listener always existed before a person could click "Declare this folder". A deferred file attaches once the document is already interactive, and a click landing in that window is lost permanently — unlike a search box, a click leaves no state to re-apply, so the fix used on the Help page (apply the value already present) cannot recover it. `tests/csp-report-only-browser.test.mjs` holds the file at the request stage and requires the document NOT to have become interactive, measuring the same technique against a file that IS deferred as its control, and `tests/csp-report-only.test.mjs` fails if the tag ever gains `defer`, `async` or `type="module"`. `environment.html` is now the only allowlisted page that still reports anything, which is what keeps the alias-coverage signal non-vacuous. `index.html` reports nothing, which is the check that this is a mirror of the meta and not a second, stricter policy in disguise.

The shared static-file resolver refuses decoded NUL bytes as not-found before filesystem calls and still rejects traversal/symlink escapes, while unexpected filesystem failures remain server errors (`voicebox-beads-mgbv`).

Every route that reads a JSON body reads it through one bounded door in `server.mjs` (`readJsonBody`, voicebox-beads-d808): a body past the cap (1 MiB by default; routes whose body carries content — file text, mini-app HTML, extension source, tool args, base64 reference images — pass 8 MiB) is refused `413 body-too-large` with the rest of the upload discarded unread, and a declared non-JSON `Content-Type` is refused `415 unsupported-content-type` before a byte is read. A refused body never reaches the route. The one exception is `POST /api/mini-app/tools`, which predates the door with its own stricter bound (64 KiB, refused `400 body-too-large` — see [docs/17](17-mini-apps-architecture.md)).

<!-- BEGIN GENERATED: page — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
`public/index.html` loads `theme-boot.js`, `fused.js`, `pip-mic.mjs`, `live-voice.js` from `public/`.
AudioWorklet modules loaded by the frontend audio engine: `pcm-worklet.js`.

`verify.mjs` resides in `public/` as a standalone verification utility and is not loaded by `index.html`.
<!-- END GENERATED: page -->

---

## 8. Subsystem Ownership & Boundaries

- **`server.mjs`**: Owns HTTP routing and the loopback auth wall, root declaration, WebSocket upgrade gates, and the central action executor (`execute()`). Always binds `127.0.0.1`.
- **`lib/routes/workspace.mjs`**: Handles file listing, reading, editing, diffing, deletion and grep after the host auth wall. It calls the host's bounded JSON door, path-authorization seam, page relay and executor; it does not define another root or permission check.
- **`lib/routes/extensions.mjs`**: Handles extension inventory, staging, approval, admission, revocation and reconfiguration after the host auth wall. Host-only admission still checks the host token; in-room mutation uses the host-owned `hasExtensionAuthority()` check, and the bounded JSON door stays in `server.mjs`.
- **`lib/state-dirs.mjs`**: Single owner for host state directory resolution (`VOICEBOX_WORKSPACE`, `VOICEBOX_EXTENSIONS_DIR`, `VOICEBOX_WASM_SHELF_DIR`, `VOICEBOX_SANDBOX_HOMES`), enforced statically by `scripts/single-owner.mjs` and `tests/single-owner.test.mjs`. Expands leading tildes (`~`) to `os.homedir()` across state directory values and operator declarations (`workspaceDeclared()`, `sandboxHomesDeclared()`), enabling boot root declarations (e.g. `VOICEBOX_SANDBOX_HOMES=~/my-dir` or `VOICEBOX_WORKSPACE=~/my-dir`) to resolve and auto-create fresh directories without requiring manual UI folder selection. Used across `server.mjs`, `lib/resolver.mjs`, `lib/extensions.mjs`, `tools/approval-code.mjs`, `lib/fence-provider.mjs`, and `lib/unit-fence-provider.mjs`.
- **`lib/path-auth.mjs`** (voicebox-beads-q0a3): Single owner for machine-side path authorization — root-kind handling (the reachability seam), lexical containment (`core/paths.ts`), the walk-up `realpath` containment, the audit guard, and the segment-wise dotfile denial, in that order. Every file verb (`server.mjs`), admitted extension tool (`lib/extensions.mjs`), mini-app store writer (`lib/mini-app-store.mjs`), cwd containment (`lib/tool-index.mjs`, `tools/env-serve.mjs`) and transport guard (`lib/env-transport.mjs`) asks it; `scripts/single-owner.mjs` refuses a second copy of any of the three shapes (declared as `SITES`), and drives the owner on a scratch tree so a declaration that stops refusing fails the gate.
- **`lib/acp-client.mjs`, `lib/pi-acp.mjs`, `lib/claude-acp.mjs`**: Own the Agent Client Protocol (ACP) client and stdio adapters. Each adapter enforces bounded execution timeouts (60s default ceiling for Pi; 120s `CLAUDE_ACP_TIMEOUT_CEILING_MS` for Claude Code, meta-capped at 600s).
- **`core/harness-config.ts` & `lib/harness-config.mjs`**: Own the configured-agent schema and atomic registry persistence (`GET` / `POST /api/agents`, `PATCH /api/agents/:id`), supporting both server and zero-server browser placements (`lib/task-placement.mjs`, [`docs/16-zero-server-delegation.md`](16-zero-server-delegation.md)).
- **`public/fused.js`**: Owns the browser workspace UI, including:
  - **Pop-Over Bubble Tray (`#sqeh-deck`)**: Toggles the Files popover (`#sqeh-files-bubble`, `#made-list`), floating File Viewer (`#sqeh-reader-bubble`, `#reader`), Mini-App launcher bubbles (`#sqeh-actions`), and Recent Turns popover (`#sqeh-toggle-history`, `#session`).
  - **Directory Navigation & File Management**: Uses `normaliseRelativeDir` in `core/paths.ts` for breadcrumb folder navigation (`tests/room-explorer-ui.test.mjs`, `tests/room-file-list-polish.test.mjs`) and confirmation-gated file deletion via `DELETE /api/file`.
  - **Room Folders Bar & Handle Management**: Manages multi-directory handle adoption, persistence, active folder switching, and observable initialization synchronization (`window.__voiceboxRoomFoldersReady`, `window.__voiceboxClearAllRoomFolders`, `tests/room-folders.test.mjs`).
- **`public/extensions-ui.mjs`** (voicebox-beads-v25a, slice of `voicebox-beads-uei2`): Owns the extension surface — the four-state list (running / waiting / found-here / refused), the approval disclosure and its plan cache, the manage dialog (reconfigure and remove), and the create-local form, together with the listeners that wire them. The Extensions UI now lives in `public/extensions-ui.mjs`; `public/fused.js` retains the host wiring, the shared element refs and the live WebSocket tool-status ownership. This narrows the edit surface of the central file — measured line counts are pinned to the extraction commit `73105d7` on `voicebox-beads-v25a`. The four things the surface used to read as `fused.js` locals now arrive through a single `initExtensionsUI({ els, request, on, installLightDismissFallback, getToolStatus })` call: `els` is a pass-through of the element map, and the other three are the same helpers the rest of the page uses, so nothing is duplicated for `voicebox-beads-ymu6` to collide with. `lastToolStatus` deliberately did NOT move — the live websocket tool-call hook owns it — so the module reads it through `getToolStatus()`, which must stay LIVE: it feeds the WASM shelf's latency readout. A snapshot captured at init would freeze that readout, and before `voicebox-beads-w1f9` that was invisible — the readout was wrong while the suite stayed green. It is not invisible now: `tests/extensions-ui-extraction.test.mjs` drives the real page's own wiring and the room loop's own `window.__voiceboxOnToolCalls` hook, so a captured accessor turns that test RED instead of shipping. `tests/extensions-ui-extraction.test.mjs` holds both failure modes: the dialog must not open when the surface's listeners are absent, and a status change made behind the module must change the rendered latency on the next render.
- **`public/settings-ui.mjs`** (voicebox-beads-ymu6): Owns the native Settings dialog's open/close/gear focus and `aria-expanded` listeners, agent settings pickers/persistence/reconnect messaging and masked provider-key status/save flow. `public/fused.js` injects its existing `els`, `request`, `health`, `refreshDevices` and `on` helper at one initialization site and retains exactly the original two boot-time loaders; the module itself makes no request at import/initialization. The host still owns device selection/capture/output routing, microphone hotkey, root/About facts, live-vision controls, theme and shared light-dismiss geometry. The browser sends only pasted nonempty key values via PUT, clears key inputs on success and never persists or displays plaintext credentials; the host retains the credential store and API authorization. The header gear, `open_panel=settings` system command and SQEH dock all invoke that same gear opener (`voicebox-beads-psfw`); no direct `showModal()` bypass remains in the host, so the three routes share refresh, modal state and close focus. `tests/settings-ui-extraction.test.mjs` pins wiring, boot-request counts, dialog state, credential masking and live-session restart; `tests/settings-open-paths-seam.test.mjs` pins the three-route wiring and `tests/settings-open-paths-browser.test.mjs` drives each route plus repeat-open/close behavior. Focused browser suites `tests/settings-dialog.test.mjs` and `tests/agent-settings-ui.test.mjs` drive observable behavior.
- **`public/theme.mjs`** (voicebox-beads-ri9x, first slice of `voicebox-beads-mvxl`): Owner of the theme preference — the tri-state (`light` / `dark` / `system`) held in `localStorage` under `voicebox:theme`, the `data-theme` (effective) and `data-theme-mode` (preference) attributes, the `prefers-color-scheme` listener that re-applies while `system` is chosen, and the select/toggle/label/icon sync. Its `storage` listener follows valid choices from another tab without writing back, falls back to light for removed/invalid values, and `initTheme` re-entry removes only its own UI/media/storage listeners. Extracted from `public/fused.js`, which had grown it inline; `fused.js` hands it its three controls at boot (`initTheme`) and calls `applyTheme` from the system-command branch, so the module depends on nothing else in the page. Driven in real Chromium by `tests/theme-browser.test.mjs` and the two-tab/Help case in `tests/theme-cross-tab-browser.test.mjs`; `tests/theme-storage.test.mjs` pins listener lifecycle.
- **`public/style.css`** (voicebox-beads-7xse): The palette itself. All ten colour tokens are single `light-dark(light, dark)` pairs on `:root`, which declares `color-scheme: light dark`, and `:root[data-theme="light"]` / `:root[data-theme="dark"]` set ONLY `color-scheme` — so the light and dark values cannot drift apart, an explicit choice is a one-property override, and a browser that runs no script still follows the OS. The card shadow deliberately keeps box-shadow syntax with only its COLOUR in a `light-dark()` pair (`--shadow-ink`): `light-dark()` resolves to a `<color>`, so wrapping the shadow itself makes the declaration invalid and the computed value `none`, with no error anywhere — `tests/theme-tokens.test.mjs` refuses that shape and holds every token to the value it had before the refactor, while `tests/theme-os-fallback.test.mjs` asserts the computed shadow is never `none` in either scheme.

  The same file carries the room and Help placeholder fix (voicebox-beads-0q5c): those pages drew placeholder
  text from the user agent's grey, measuring 4.45:1 light and 4.16:1 dark against the fields' own backgrounds
  (and 4.19:1 / 3.17:1 on the two transcript fields' darker ground), under the 4.5:1 floor this project applies
  to placeholder text. `:where(.room, .settings-form, .help-page) :is(input, textarea)::placeholder` sets it to
  `var(--muted)` — the colour the surrounding secondary text already uses — with an explicit `opacity: 1`, the
  same statement `.list-tools input::placeholder` already
  carries, and inert in this browser (opacity measured at 1 before the rule existed) — which measures 5.91:1 light and
  7.47:1 dark on those fields. The `:where()` wrapper is load-bearing: `.room input::placeholder` and
  `.composer input::placeholder` are at EQUAL specificity (one class plus one type, since `::placeholder` counts
  as a type), so on a tie source order decides and a plain container rule overrides the composer's deliberate
  alpha composite. `:where()` contributes zero specificity, so the rule fills only the gap the user agent
  leaves and cannot outrank an authored rule. `tests/placeholder-contrast-browser.test.mjs` drives the
  application's own theme preference into stored light and stored dark and holds every opaque placeholder field
  in both themes to the floor, and holds the composer to its own separate rule rather than to this one.

  The room composer's field (`#utterance`, voicebox-beads-8wm8) is deliberately quieter than typed text, so it is
  a translucent mix of `--muted` rather than the token itself. At 62% it composited to 2.68:1 light and 3.46:1 dark
  against the field's own ground — under the floor. It is now 90%, chosen for HEADROOM rather than because it is
  the bare minimum: 88% is the bare clearing candidate, at 4.54:1 light and 5.61:1 dark, only 0.04 above the floor
  in light and so inside rendering variance. At 90% the placeholder keeps alpha 0.902 and measures 4.81:1 light and
  5.87:1 dark against typed text at 14.91:1 and 17.11:1, so it stays roughly a third of the entered text's
  contrast and is not flattened to the opaque token. The
  figures come from injecting the exact declaration into a disposable browser and reading composited pixels, with
  alpha taken from a black/white pixel pair instead of parsing an `oklch()`/`color()` string; the same probe
  re-reads the `0q5c` opaque fields and `.list-tools` to confirm that changing a value inside `.composer`'s own
  declaration leaves them untouched. Focus leaves the composer ground unchanged up to one unit, and the composer
  input is never disabled — only the send button is.

  `tests/placeholder-contrast-browser.test.mjs` drives the application's own theme preference into stored light and
  stored dark and asserts the composer's mix percentage, its composited contrast against the resolved ground, its
  alpha staying below 1, and that it remains a clear margin below the typed text in both themes. It enumerates the
  composer placeholder with a non-empty guard, so a selector matching nothing fails rather than passes, and a
  reduction mutant (90% back to 62%) must turn it red.
- **`public/environment.css`** (voicebox-beads-xggy.3): The Environment page's own stylesheet — its 11 colour tokens, each a single `light-dark(light, dark)` pair on `:root`, plus the page's layout, table, dialog and `:focus-visible` rules. It is a **separate palette** from `style.css`'s ten: same discipline, different values (this page's dark ground is `#101014`, not `#0b0f19`). Moved out of the page's inline block for CSP readiness: the 80 original rules moved verbatim and in the same order, and the file adds a provenance header comment plus two rules: the one that replaced the single inline style attribute, and
`::placeholder { color: var(--muted); }` (voicebox-beads-sv2n; widened from a single input to the bare pseudo-element
by voicebox-beads-yd08), which replaces the user agent's placeholder grey — 4.34:1 light and 3.87:1 dark, under the
4.5:1 floor this project applies to placeholder text — with the colour the page's secondary text already uses,
measuring 5.76:1 and 6.45:1 on every one of the page's six placeholder fields (five inputs and the asset-body textarea), which all draw from `--input-bg`. The browser test pins every pair twice — as the exact declared `light-dark()` text, and as the colour it resolves to in each scheme — so a future palette change is a deliberate act rather than something a relocation or a tidy-up carries in (voicebox-beads-h1oo).
- **`public/theme-boot.js`** (voicebox-beads-xpwt): The pre-paint copy of that decision, and the reason `theme.mjs` is described as the owner rather than the only site. It is a CLASSIC script — not a module, not deferred — loaded from `<head>` so it runs before the first paint, and since voicebox-beads-uj16 it is the SAME file that `public/help.html` loads: that page kept its own copy inline as the LAST thing in its `<body>`, and the copy is deleted rather than kept in step. **That copy did NOT flash**, which is worth stating because assuming it did is easy and wrong: an inline classic script runs while the document is parsing, and measured on the pre-uj16 markup it set the attribute at 1ms with the first frame at 13ms already dark. The xpwt flash came from a DEFERRED MODULE, a different timing. So the reason to delete this copy is divergence, not timing — it ignored `system`, never set `data-theme-mode`, and had no listener, and no test related it to the owner. The listener is why `public/help-theme.mjs` exists: the guard resolves the system scheme ONCE, so with `system` stored it would pin the page to whatever the OS was at load, and the module's `initTheme()` installs the listener that keeps following an operating-system switch while the page is open (voicebox-beads-ftqe, found in review). `theme.mjs` is imported by `fused.js` and module scripts are always deferred, so without this the theme was applied after the paint (measured: dark stored, FCP 76ms, dark applied 78ms — a person who chose dark saw light first on every load). It restates `theme.mjs`'s four decisions — the storage key, the `light`/`dark`/`system` whitelist with anything else falling back to light, the `matchMedia` resolution, and the two attribute names — because it cannot import the module it shadows; `tests/theme-boot-parity.test.mjs` drives both implementations through the same fake DOM over the same matrix of stored values, OS schemes and blocked storage, and refuses any disagreement, so the restatement cannot drift silently; a further assertion there refuses any page that loads this file as a module or deferred, assigns `data-theme` itself, or reads the storage key itself, which is exactly the shape `help.html` had. It is external rather than inline because the page's own policy is `script-src 'self'` (`public/index.html`), with no `'unsafe-inline'`, nonce or hash, which blocks the inline form the Modern Web Guidance FOUC recipe prescribes. That claim is measured rather than assumed, and the tag's placement is load-bearing: a `<meta>` CSP governs only what is fetched after it is parsed, so the script sits BELOW the policy — an inline script added after the meta does not run, while this same-origin file loads and the theme is applied before the first frame, so the guard is demonstrably inside the policy rather than escaping it. `tests/theme-first-paint.test.mjs` asserts the theme at the first `requestAnimationFrame`, and its dark case fails when this script is removed from `index.html`; `tests/help-theme-first-paint.test.mjs` does the same for `public/help.html`, where removing the script leaves the first frame reading `null` at 55ms with the light ground — that page's old body-end behaviour, reproduced exactly. It also asserts the computed `color-scheme` in the first frame, so the browser-drawn surfaces (scrollbars, caret, text selection, form controls) are not left on the previous scheme. **Degradation, stated plainly rather than implied:** if the storage read throws — site data blocked, private modes — the guard falls back to `light`, which is exactly what `theme.mjs`'s `initTheme` does in the same situation, and the page still paints and works. If JavaScript is disabled, or this script fails to load, the guard does nothing — and since voicebox-beads-7xse that is no longer a broken case: `public/style.css` sets `color-scheme: light dark` and writes every colour token as one `light-dark(light, dark)` pair, and neither page forces a scheme on `<html>` any more, so a browser with scripting disabled follows the operating system. A media query is NOT what provides this, and deliberately so: `:root[data-theme="light"]` outranks one, which is why a `@media (prefers-color-scheme: dark)` block would have been silently defeated until the forced attribute was removed and `color-scheme` was left to carry the decision. Both schemes are measured in a real browser by `tests/theme-os-fallback.test.mjs`, whose no-JS cases read computed styles through the CDP CSS domain because `page.evaluate` throws when scripting is disabled; the same file also pins the surviving asymmetry — with scripting, "no stored choice" still means LIGHT, because that is what `theme.mjs` does, so disabling JavaScript is what produces OS-following behaviour, not the other way round. A theme change made in another browser tab is not followed either (voicebox-beads-vtf3). An OFFLINE or lie-fi load is a separate case that this fix does not repair and deliberately does not claim to: `public/sw.js` is network-first but falls back to `caches.match("./index.html")` when the network fails, so a cached `index.html` whose markup predates this guard will still flash, because that document's markup is what runs. That is a cache-freshness property of serving any cached document rather than something the guard can reach, so it is excluded from this change rather than fixed by it.
