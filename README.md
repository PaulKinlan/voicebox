# Voicebox

Voicebox is a real-time, voice-first AI workspace in the browser. Speak naturally with a live multimodal model over low-latency, full-duplex audio while creating and editing files, launching interactive sandboxed Mini-Apps (Web MCP), running digest-pinned WebAssembly tools, and delegating engineering tasks to local or remote coding agents.

---

## Quick Start

### 1. Prerequisites
- **Node.js**: v22.0.0 or higher
- **Browser**: A modern Chromium-based browser (Chrome or Edge) for File System Access API and AudioWorklet support
- **API Key**: Google Gemini (`GEMINI_API_KEY`), OpenAI (`OPENAI_API_KEY`), or Anthropic (`ANTHROPIC_API_KEY`)

### 2. Install & Run
```bash
git clone https://github.com/PaulKinlan/voicebox.git
cd voicebox
npm install
npm start
```
The server starts at `http://localhost:8787` (bound to `127.0.0.1`; override port with `PORT=...`).

### 3. Configure API Keys
You can configure provider keys in either of two ways:
- **In the Browser UI (Recommended)**: Click **Settings (⚙)** in the top bar and paste your Gemini, OpenAI, or Anthropic API key. Keys are saved to the host's `0600` credential store (`GET` / `PUT /api/keys`) and take effect immediately without restarting the server.
- **Via Environment Variables**:
  ```bash
  # Gemini Multimodal Live (default: models/gemini-3.8-live)
  export GEMINI_API_KEY="your-gemini-api-key"

  # OpenAI Realtime (gpt-realtime)
  export OPENAI_API_KEY="your-openai-api-key"

  # Anthropic (for Claude turn resolution and coding agent adapters)
  export ANTHROPIC_API_KEY="your-anthropic-api-key"
  ```

To check installed coding agent harnesses and host diagnostics from the terminal:
```bash
node server.mjs --doctor
```

---

## Using the Interface

1. **Centered Hero Microphone & Composer**:
   - Click the central microphone button (`#mic`) or press `M` to start or stop a live voice session.
   - **Barge-In**: Speak at any time while the assistant is talking to interrupt playback immediately and redirect the conversation.
   - **Text Composer (`#text-form`)**: Type commands or questions directly when working in quiet environments or testing with the deterministic `script` resolver.
2. **Pop-Over Bubbles (`#sqeh-deck`)**:
   - **Files (`#sqeh-files-bubble`)**: Opens your active workspace file list (`#made-list`) in a compact floating pop-over card. Switch between a local directory (via the browser's File System Access API) or the persistent in-browser OPFS scratchpad.
   - **File Viewer (`#sqeh-reader-bubble` / `#reader`)**: Displays file contents in a floating viewer popover. It also opens automatically when you ask the assistant to *"open \<file\>"* or *"show me \<file\>"*. Includes a **Minimize to Bubble** (`#reader-minimize`) button and an **Open as Mini-App** (`#file-run-app`) action for `.html` files.
   - **Mini-Apps (`#sqeh-actions`)**: Interactive HTML apps and games in your workspace—or created live during conversation—open in a draggable, resizable, full-screen-expandable pop-over window (`#mini-app-container`). Each Mini-App runs inside a sandboxed double-iframe bridge that exposes interactive Web MCP tools directly to the voice assistant.
   - **Recent Turns (`#sqeh-toggle-history`)**: Opens a floating pop-over bubble (`#session`) displaying recent conversation turns, tool execution timings, and inline file edit chips.
3. **Top Bar Controls**:
   - **Theme Toggle (`#theme-toggle`)**: Switch between Warm Paper (light) and Dark mode.
   - **Harnesses**: Inspect and activate installed coding agent harnesses (such as Pi or Claude Code) directly in the UI without setting environment variables.
   - **Environments**: Manage local, fenced sandbox, and paired remote execution environments.
   - **Extensions**: Review extension capability disclosures, approve pending proposals, and inspect the WebAssembly tool shelf.
   - **Settings (⚙)**: Configure voice selection, assistant instructions, audio input/output devices, and provider API keys.

---

## Architecture Overview

Voicebox pairs a zero-dependency Node.js gateway (`server.mjs`) and modular browser UI (`public/fused.js`, `public/live-voice.js`) with a pure TypeScript policy core (`core/`).

### Pluggable live-model library

`lib/live-harness.mjs` exposes the gated session and provider registry without starting the UI or server. Gemini offers **3.8 Live** (default), **3.8 Thinking** (2048-token reasoning budget), and **3.8 Flash**; OpenAI Realtime uses the same tool catalogue and executor. Claude live streaming remains a placeholder, separate from coding-agent delegation.

```text
Client UI -> /live wire -> Live harness seam -> Gemini 3.8 / OpenAI providers
                               |                        -> vendor bidi sockets
                               +-> Tool catalogue -> bounded host executor -> result
```

![Live providers, audio rates and tool execution](docs/assets/pluggable-live-models.svg)

See [Pluggable live models](docs/23-pluggable-live-models.md) for the API, 16/24 kHz rate negotiation, tool roundtrip and verification limits. The [documentation site](https://paulkinlan.github.io/voicebox/) builds from `docs/` on main via `.github/workflows/pages.yml`; feature pushes prepare documentation but do not deploy it.

### 1. Live Voice Gateway & Turn Resolvers (`lib/live-session.mjs`, `lib/resolver.mjs`)
- **Full-Duplex Voice (`/live`)**: Streams 16kHz/24kHz PCM audio between the browser's `pcm-worklet.js` AudioWorklet and upstream providers (`models/gemini-3.8-live` or `gpt-realtime`).
- **Workspace Instructions (`lib/project-instruction.mjs`)**: Automatically discovers the nearest `AGENTS.md` or `AGENT.md` file (up to 32 KiB) in the active workspace and injects it into the live session instruction.
- **Turn Resolution (`POST /api/turn`)**: Text composer and browser dictation requests resolve into structured actions through `lib/resolver.mjs` before executing on the shared server executor.

<!-- BEGIN GENERATED: providers — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
**Registered turn resolvers** (`lib/resolver.mjs`): `claude`, `gemini`, `openai`, `script`

* **Registration & Dispatch**: `registerResolver(name, fn)` registers a text turn resolver; `resolveTurn(transcript, provider = "script")` resolves a user transcript into a structured action.
* **Deterministic Script Resolver (`script`)**: Maps common file and tool commands without requiring an external API key (for example, `"create a file called hello.txt with hi"` → `{"verb":"write","name":"hello.txt","content":"hi"}`).
* **Supported Verbs**: `write`, `read`, `list`, `make-tool`, `tool`. Prompts outside the deterministic grammar return an explicit `unresolved` response (for example, `"book me a flight to Lisbon"` → `"the script resolver only knows create/read…"`).
* **Live Voice Providers**: Full-duplex audio providers (`claude`, `gemini`, `openai`) are registered separately via `registerLiveProvider` in `lib/live-session.mjs` and stream audio and tool calls over `/live`.
<!-- END GENERATED: providers -->

<!-- BEGIN GENERATED: live-session — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
**Live Voice Providers (`lib/live-session.mjs`)**: `claude` (`(registered, but this check has no capture for it)`), `gemini` (`models/gemini-3.8-live`), `openai` (`gpt-realtime`). The default fallback provider is `gemini` (configurable via `VOICEBOX_LIVE_PROVIDER` or selected per session in the UI Settings dialog).
<!-- END GENERATED: live-session -->

### 2. The Agent Loop & Shared Executor (`server.mjs`, `core/extensions.ts`)
Whether an action originates from a live voice tool call or a typed turn, it runs through a single mediated executor:
- **Workspace File Tools**: Root-scoped operations (`read_file`, `write_file`, `list_files`, `delete_file`, `edit_file`, `diff_file`, `grep_files`) enforce strict path containment inside the declared project root.
- **WebAssembly Tool Shelf (`lib/wasm-shelf.mjs`, `lib/wasm-worker.mjs`)**: Executes digest-pinned `.wasm` modules in isolated worker processes with strict memory, stdout (2 MB), and wall-clock (5,000ms) ceilings. See [`docs/20-webassembly-tools.md`](docs/20-webassembly-tools.md).
- **Coding Agent Delegation (`lib/pi-acp.mjs`, `lib/claude-acp.mjs`)**: Delegates complex multi-step coding tasks over the Agent Client Protocol (ACP) to Pi or Claude Code with bounded timeouts and output budgets.
- **Sandboxing & Audit Trail (`lib/fence-provider.mjs`, `core/tier-table.ts`)**: Enforces capability boundaries and records every attempt, outcome, and refusal in an append-only JSONL audit log.

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

**Extension Catalogue (`catalogue/*.json`, 5 descriptors)**:

| Extension ID | Tools | Declared Capabilities | Bounds | Admission Verdict |
|---|---|---|---|---|
| `brave-search` | `brave_search` → `http-get` | network | hosts: api.search.brave.com; maxRequests: 20 | admitted — network via `mediated-fetch` |
| `mcp-server-local` | `mcp_list_tools` → `process` | exec | command: npx -y @modelcontextprotocol/server-filesystem /tmp | **refused** `exec-absent` |
| `mcp-server-remote` | `mcp_remote_list_tools` → `http-get` | network | hosts: mcp.example.com; maxRequests: 20 | admitted — network via `mediated-fetch` |
| `notes` | `read_notes` → `read-file` | read | — | admitted — read via `host-primitive-scope` |
| `web-search` | `web_search` → `http-get` | network | hosts: api.duckduckgo.com; maxRequests: 5 | admitted — network via `mediated-fetch` |

**Named Refusal Codes by Subsystem**:
* **Extension admission gate (`core/extensions.ts`)**: `absent-capability`, `bad-tool-name`, `capability-unmediated`, `duplicate-tool`, `eval-not-a-tool-path`, `exec-absent`, `network-unbounded`, `no-tools`, `under-declared`, `unknown-capability`, `unknown-primitive`, `unsupported-abi`
* **HTTP routes and workspace root boundary (`server.mjs`, `core/root.ts`, `browser/acts.ts`)**: `adapter-not-configured`, `approval-invalid-id`, `approval-json-required`, `audit-unreadable`, `bad-answer`, `bad-request`, `bearer-refused`, `bounds-invalid`, `cannot-delete-directory`, `cannot-delete-local`, `cross-environment-unauthorized`, `dotfile-refused`, `environment-not-paired`, `environment-unknown`, `environment-unreachable`, `exec-threw`, `executor-unavailable`, `extension-not-admitted`, `git-failed`, `host-token-refused`, `host-token-required`, `invalid-task`, `loopback-auth-disabled`, `loopback-unauthenticated`, `mini-app-timeout`, `mini-app-unreachable`, `missing-argument`, `missing-content`, `no-project`, `not-a-directory`, `not-a-git-repo`, `not-found`, `not-supported-in-browser`, `nothing-to-undo`, `outside-root`, `pairing-revoked`, `path-missing`, `pattern-not-found`, `pattern-not-unique`, `probe-failed`, `protected-audit`, `provider-not-configured`, `root-not-mine`, `root-not-reachable-from-here`, `root-unreachable`, `server-error`, `task-root-unavailable`, `unauthenticated-call`, `undo-failed`, `unknown-command`, `unknown-environment`, `unknown-mini-app-tool`, `unknown-root-kind`, `unknown-verb`, `unreadable`, `write-error`
* **Extension runtime (`lib/extensions.mjs`)**: `approval-audit-unwritable`, `approval-no-proposal`, `approval-plan-changed`, `approval-unavailable`, `bad-descriptor`, `bad-redirect`, `bad-tool-name`, `bounds-invalid`, `descriptor-missing`, `extension-not-admitted`, `fetch-failed`, `gate-refused-at-load`, `invalid-id`, `missing-description`, `missing-name`, `network-unbounded`, `no-tools`, `outside-root`, `over-budget`, `params-invalid`, `params-unknown-tool`, `protected-audit`, `redirect-host-not-allowed`, `redirect-without-location`, `too-many-redirects`, `unknown-primitive`, `unreadable`
* **Task delegation and lifecycle (`core/tasks.ts`, `lib/tasks.mjs`)**: `agent-environment-mismatch`, `agent-not-configured`, `agent-required`, `executor-unavailable`, `invalid-task`, `invalid-task-address`, `invalid-task-context`, `task-audit-unavailable`, `task-authority-field`, `task-call-id-conflict`, `task-call-id-required`, `task-cancelled`, `task-capacity-exhausted`, `task-context-unavailable`, `task-deadline`, `task-environment-changed`, `task-environment-unverified`, `task-input-over-budget`, `task-invalid-result`, `task-not-found`, `task-not-running`, `task-output-over-budget`, `task-owner-mismatch`, `task-owner-unconfirmed`, `task-owner-unverified`, `task-persistence-failed`, `task-root-replaced`, `task-root-unavailable`, `unbounded-executor`, `unknown-tool`, `unsupported-runtime-capability`

**Runtime Inspection & Admission Endpoints**:
* `GET /api/extensions`: Returns `{ placement, extensions, proposals, present, failedLoads, catalogueCount }` (placement: `machine`, catalogueCount: 5).
* `GET /api/extensions/catalogue`: Previews admission verdicts for all catalogue descriptors.
* `GET /api/extensions/{proposals|catalogue}/<id>/plan`: Returns capability and enforcement disclosure prior to admission.
* `GET /api/probe`: Runs `tools/sandbox-probe.mjs` and returns an observed environment report (HTTP 200; sections: `identity`, `sandboxHints`, `filesystem`, `limits`, `tools`, `network`).
* `POST /api/extensions/admit`: Requires `x-voicebox-host-token` (unauthenticated requests fail with HTTP 403 `host-token-required`).
<!-- END GENERATED: tools -->

---

## Configuration Reference

<!-- BEGIN GENERATED: config — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
Environment variables read by the server and runtime libraries:

| Variable | Read In | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `lib/live-providers/claude.mjs`, `lib/pi-acp.mjs`, `lib/resolver.mjs`, `server.mjs` | Anthropic API key used by the `claude` resolver/provider and forwarded to the `pi-acp` adapter as a fallback when no store credential exists (can also be configured in the UI Settings dialog). |
| `BRAVE_API_KEY` | `lib/extensions.mjs` | Brave Search API subscription token used by `http-get` extensions targeting `api.search.brave.com`. |
| `FORCE_COLOR` | `lib/logger.mjs` | Terminal color override (`0` disables ANSI colors in `lib/logger.mjs`; non-zero enables them when stdout is not a TTY). |
| `GEMINI_API_KEY` | `lib/live-providers/gemini.mjs`, `lib/resolver.mjs`, `server.mjs` | Google Gemini API key for Gemini Live voice sessions and the `gemini` text turn resolver (can also be configured in the UI Settings dialog). |
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
| `VOICEBOX_LOOPBACK_AUTH` | `server.mjs` | Set to `1` to require a single-use bootstrap ticket (`?bootstrap=<ticket>`) and `HttpOnly` session cookie for local browser access. |
| `VOICEBOX_OPENAI_INPUT_TRANSCRIPTION` | `lib/live-providers/openai.mjs` | Set to `1` to enable `gpt-4o-mini-transcribe` input audio transcription in the OpenAI Realtime session handshake. |
| `VOICEBOX_PROVIDER` | `server.mjs` | Deprecated alias for `VOICEBOX_RESOLVER`, retained for backward compatibility. |
| `VOICEBOX_RESOLVER` | `server.mjs` | Default text turn resolver used by `POST /api/turn` (`script`, `gemini`, `openai`, or `claude`; default `script`). |
| `VOICEBOX_SANDBOX_HOMES` | `lib/state-dirs.mjs` | Base directory for fenced sandbox home directories (default `~/sandbox-homes/<key>`, located outside `/tmp` for `PrivateTmp` compatibility). |
| `VOICEBOX_WASM_SHELF_DIR` | `lib/state-dirs.mjs` | Directory containing the digest-pinned WebAssembly tool shelf (`manifest.json` and `.wasm` binaries; default `~/.isocan/modules/wasm-tools`). |
| `VOICEBOX_WORKSPACE` | `lib/state-dirs.mjs` | Declares an active machine project root at startup and stores extension proposals (`proposals/`) and extension audit logs (`audit.jsonl`). |
<!-- END GENERATED: config -->

---

## Documentation & Testing

### Documentation Index
See [`docs/README.md`](docs/README.md) for the complete guide to Voicebox's architecture, security model, sandboxing, wire protocol, Mini-Apps, and WebAssembly tools.

### Verification & Quality Gates
- **Scoped Tests (`npm run test:changed`)**: Runs only the unit and integration tests covering files modified since `origin/main`.
- **Unit Test Suite (`npm run test:unit`)**: Runs the fast concurrent unit test suite across `core/`, `lib/`, and `browser/`.
- **Full Test Suite (`npm test`)**: Runs the unit suite, server integration tests, and browser CDP tests.
- **Acceptance Harness (`npm run accept`)**: Verifies the live served application end-to-end in headless Chromium.
- **Documentation Sync (`npm run docs:write` / `npm run docs:check`)**: Regenerates and verifies the live-probed documentation blocks in `README.md` and `docs/07-architecture.md`.
