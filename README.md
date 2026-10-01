# Voicebox

Voicebox is a real-time, voice-first coding environment in the browser. You speak to an AI model over low-latency full-duplex audio; it speaks back while directly creating and editing files, running build tools, executing isolated WebAssembly modules, and driving coding agents on your machine.

---

## Getting Started

### 1. Prerequisites
- **Node.js**: v22.0.0 or higher
- **Microphone**: Working audio input for voice interaction
- **API Key**: A Google Gemini API key (for Gemini Multimodal Live, default) or an OpenAI API key (for OpenAI Realtime)

### 2. Installation
Clone the repository and install dependencies:

```bash
git clone https://github.com/PaulKinlan/voicebox.git
cd voicebox
npm install
```

### 3. Configure API Credentials
Voicebox connects directly to multimodal speech-to-speech providers over WebSockets. Export your provider key:

```bash
# For Gemini Multimodal Live (default: models/gemini-3.8-live):
export GEMINI_API_KEY="your-gemini-api-key"

# Or for OpenAI Realtime (gpt-realtime):
export OPENAI_API_KEY="your-openai-api-key"
export VOICEBOX_LIVE_PROVIDER="openai"
```

### 4. Start the Server
```bash
npm start
```
The server boots on `http://localhost:8787` (override via `PORT=...`).

To verify installed host harnesses and environment diagnostics without starting the network listener:
```bash
node server.mjs --doctor
```

---

## First Run Walkthrough

1. **Open the Interface**: Navigate to `http://localhost:8787` in a Chromium browser (Chrome or Edge).
2. **Grant Microphone Access**: Allow audio recording when prompted. The client boots an AudioWorklet streaming raw 16kHz PCM.
3. **Select a Workspace**:
   - **Local Directory**: Click the **Folder** icon in the header to open a local repository using the File System Access API.
   - **Browser Scratchpad**: If no local folder is open, Voicebox defaults to the in-browser OPFS (Origin Private File System) scratchpad. Files created here persist across browser reloads.
4. **Speak a Request**:
   - Click the central circular microphone button (or hold the `Space` bar).
   - Say: *"Create an index.html file with a responsive dark-mode counter and a button to increment it."*
   - The circular waveform reacts dynamically to your mic energy.
5. **Live Turn Execution**:
   - The model streams synthesized speech back through your speakers.
   - Concurrently, the server executes the tool call (`write_file`), writing `index.html` to the workspace.
   - The project file tree on the left refreshes in real time as the file lands.
6. **Barge-in Interruption**:
   - Speak while the model is talking to interrupt it. The audio engine detects your voice energy, stops agent playback, and listens for your correction.
7. **Text Composer Fallback**:
   - In quiet environments or when testing without an API key, use the text composer at the bottom. Submitting dispatches to `POST /api/turn` via the deterministic script resolver.

---

## Architecture Deep Dive

Voicebox combines low-latency full-duplex audio transport with sandboxed, audited tool execution.

### 1. Frontend Audio Engine (`public/live-voice.js`, `public/fused.js`)
- **AudioWorklet Streaming**: Microphone input is captured at 16kHz or 24kHz linear PCM and streamed over WebSocket in raw binary frames.
- **Waveform Rendering (`drawInputWave`)**: Draws a circular oscilloscope that blends microphone input and agent playback energies on a fixed full scale without ceiling saturation.
- **Barge-In Energy Detection**: Compares microphone energy against background thresholds. Detecting user speech during playback stops agent audio immediately and transmits an `interrupt` event.
- **Docked Microphone Widget (`#docked-mic`)**: When scrolling through long file trees moves the central button out of view, a docked control appears in the viewport, ensuring voice controls remain accessible.
- **3-State System Interface (`#sqeh-deck`, `#sqeh-sheet`, `#sqeh-dock`)**: the room leads with different sections per state — the deck (voice stage + Quick Files tiles mirrored from the live file list + Mini-Apps quick actions; the Spotify tile is honestly disabled, no integration exists), the session history, and a SYSTEMS QUICK ACCESS sheet the deck body physically moves into (the same nodes, live data in both homes). A persistent dock (home, files, mic FAB, systems, settings) switches states; layered radial arcs glow behind the mic while voice is active (voicebox-beads-sqeh).

### 2. Live Session Gateway (`/live`, `lib/live-session.mjs`)
The server acts as an authenticated full-duplex gateway between browser WebSockets and upstream speech-to-speech providers.
- **Providers**: Supports Gemini Multimodal Live (`models/gemini-3.8-live`) and OpenAI Realtime (`gpt-realtime`).
- **Project Context (`AGENTS.md`)**: On session boot, `lib/project-instruction.mjs` scans upward from the active workspace folder to locate the nearest `AGENTS.md` or `AGENT.md` (bounded at 32 KiB) and injects it into system instructions.
- **Tool Protocol**: Function call requests from the model are mapped by `commandToAction()` into the unified server executor, returning correlated results back to the model turn.

<!-- BEGIN GENERATED: providers — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
Registered resolvers: `claude`, `gemini`, `openai`, `script`

* `registerResolver(name, fn)` is the seam; `resolveTurn(transcript, provider = "script")` picks one.
* The **script** provider handles `write`, `read` and `list`: `"create a file called hello.txt with hi"` → `{"verb":"write","name":"hello.txt","content":"hi"}`.
* The verbs it produces, driven one utterance each: `write`, `read`, `list`, `make-tool`, `tool`. An utterance matching **none** of them is **unresolved**, by design: `"book me a flight to Lisbon"` → `"the script resolver only knows create/read…"`. (This line used to say *"anything else is unresolved"*, which was a TYPED universal beside a derived example — false the moment `make-tool` and `tool` started resolving.)
* The live voice providers (`claude`, `gemini`, `openai`) live behind a **different** seam, `registerLiveProvider` in `lib/live-session.mjs`; none of them is a turn resolver — see the tool path below.
<!-- END GENERATED: providers -->

<!-- BEGIN GENERATED: live-session — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
`lib/live-session.mjs` is present. Registered live providers, with the model each one's handshake names (captured from the provider against a recording transport — never dialed): `claude` → `(registered, but this check has no capture for it)`, `gemini` → `models/gemini-3.8-live`, `openai` → `gpt-realtime`. The library fallback is `gemini`, overridable by `VOICEBOX_LIVE_PROVIDER`; the server's `/live` route instead passes the agent-settings provider explicitly.
<!-- END GENERATED: live-session -->

### 3. Tool Execution & Sandboxing (`server.mjs`, `core/extensions.ts`)
Tool execution is strictly partitioned and mediated:
- **Built-in Workspace Tools**: Root-scoped operations (`read_file`, `write_file`, `list_files`, `delete_file`, `edit_file`, `diff_file`, `grep_files`). Paths are constrained to the active project root; directory traversal attempts (`../`) are refused.
- **WebAssembly Tool Shelf (`lib/wasm-shelf.mjs`, `lib/wasm-worker.mjs`)**:
  - Standalone `.wasm` modules executed in isolated worker processes.
  - Linear memory caps (`--wasm-max-mem-pages=4096`), stdout buffer limits (2 MB), and child-side watchdogs (6,000ms) guarantee that misbehaving or looping WASM tools terminate cleanly without blocking the server.
  - See [`docs/20-webassembly-tools.md`](docs/20-webassembly-tools.md) for the buffer ABI contracts and compiler guidelines.
- **Agent Client Protocol (ACP) Delegation (`lib/pi-acp.mjs`, `lib/claude-acp.mjs`)**:
  - Delegates complex, long-running engineering tasks out-of-process via ACP over stdio.
  - Supports host coding agents including Pi and Claude Code with bounded execution ceilings.
- **Fencing & Security Boundaries (`lib/fence-provider.mjs`, `core/tier-table.ts`)**:
  - Mediated network fetch with strict host allowlisting and hop-bounded redirect tracking.
  - Every action, tool call, and refusal is recorded in an immutable, append-only audit trail (`audit.jsonl`).

<!-- BEGIN GENERATED: loop — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
**One turn, driven end to end on a scratch root while this document was generated.** Every value in the last column was read back from the server, not typed.

The log's SHAPE is derived too, not described: the write produced **2** entries and the refusal **1**, counted from `GET /api/audit` either side of each act. Row 5 used to say *"one entry per act"* as TYPED prose inside this generated block, and it stayed there after the shape changed (attempt-first, `voicebox-beads-y69`) because nothing about that sentence was derived — the marker on this block's opening comment says which half you can trust.

| step | what happens | the mechanism | driven |
|---|---|---|---|
| **1 · a turn starts** | words arrive | `POST /api/turn {transcript}` — from the composer or browser dictation; the live model's words do **not** arrive here yet (see *the tool path*) | `"create a file called hello.txt with hi"` |
| **2 · something decides** | the resolver turns words into an action, or says it cannot (`unresolved`) | `resolveTurn(transcript, "script")` in `lib/resolver.mjs` — the server never parses language itself | → `{"verb":"write","name":"hello.txt","content":"hi"}` |
| **3 · something acts** | the executor runs the verb in the **active root** — the one declared over `POST /api/root`; none is assumed | `execute(action)` in `server.mjs` | → `wrote hello.txt (2 bytes)` in a root of kind `machine` |
| **4 · the result returns** | the page gets the whole story in one response | `{transcript, action, result}` — `result.ok`, `result.action`, `result.root`, `result.logged` | → `ok: true`, `logged: 2` |
| **5 · the act is recorded** | **2 entries** for that one write — `attempt`/`attempted` then `allow`/`writes-inside` — the outcome carrying the attempt's own seq; a pre-flight refusal records one | `<root>/.audit/<writer>.jsonl` (`core/shared-log.ts`), `GET /api/audit` | → seq 1 `attempt`, seq 2 `allow`; then seq 3 `refuse`/`outside-root` |

**Where it fails, by name** (driven): the same turn **before any root is declared** → `refused: root-not-declared`, `logged: null` (no root, so nowhere to hold a log — the response says so rather than omitting the field); `"read .."` → `refused: outside-root`, and the refusal is itself logged as entry seq 3. Declaring the root answered `ok: true`, `reachableFromThisProcess: true`, and the turn that was refused a moment earlier then succeeded.

**The same loop, making a tool and then calling it** (driven, in this order):
1. `"create a tool called peek that lists files"` → verb `make-tool` → `proposed tool 'peek-tool'`, state `pending` — a **file** under the extension workspace's `proposals/`, not loaded.
2. `GET /api/extensions/proposals/peek-tool/plan` → the gate would say `admitted`; enforced: read via `host-primitive-scope`.
3. `POST /api/extensions/admit {id, confirm: true, decision: "admit"}` **with the host token** (the 0600 file in the host's extension directory) → `admitted`. Without the token → HTTP 403 `host-token-required`.
4. `"run the tool peek"` → verb `tool` → `callTool("peek")` in `lib/extensions.mjs` → `ok: true`, files `["hello.txt"]`.
5. `GET /api/extensions` now lists `peek-tool`: declared `read`, enforced `{"read":"host-primitive-scope"}`, tools `peek`.

**One root**: the admitted tool listed `["hello.txt"]` — the same root the turn wrote `hello.txt` into.
<!-- END GENERATED: loop -->

<!-- BEGIN GENERATED: tool-path — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
**Three ways words reach this server; all reach the shared executor.**

| path | wired today | what carries the words | what runs |
|---|---|---|---|
| typed in the composer | yes | `public/fused.js` → `POST /api/turn` | `resolveTurn()` (`lib/resolver.mjs`, provider `script`) → `execute()` (`server.mjs`) → for tools, `callTool()` (`lib/extensions.mjs`) |
| dictated (browser `SpeechRecognition`, no key) | yes — the same route | `public/fused.js` → `POST /api/turn` | the same |
| spoken to the live model | audio yes; tools **yes** | `public/live-voice.js` → `/live` → `lib/live-session.mjs` → the provider | provider tool call → `commandToAction()` → `execute()` → correlated tool response — and the server tells the page (`{type:"tool"}`), which re-reads the file list so a file the model wrote appears as it arrives |

What each live handshake declares, captured from the provider with the server's shared command list: `claude` → tools: (not captured); `gemini` → tools: `list_extensions`, `call_extension`, `propose_extension`, `write_file`, `read_file`, `list_files`, `delete_file`, `edit_file`, `diff_file`, `grep_files`, `list_agents`, `delegate_task`, `contact_agent`, `launch_mini_app`, `git_status`, `git_diff`, `git_log`, `inspect_environment`, `undo_last_action`; `openai` → tools: `list_extensions`, `call_extension`, `propose_extension`, `write_file`, `read_file`, `list_files`, `delete_file`, `edit_file`, `diff_file`, `grep_files`, `list_agents`, `delegate_task`, `contact_agent`, `launch_mini_app`, `git_status`, `git_diff`, `git_log`, `inspect_environment`, `undo_last_action`. Extension discovery reads the current registry; invocation goes through the existing admission and runtime bounds.

Verbs the `script` resolver produces, driven: `"create a file called hello.txt with hi"` → `write`, `"read hello.txt"` → `read`, `"list files"` → `list`, `"create a tool called clock that tells the time"` → `make-tool`, `"run the tool clock"` → `tool`. `make-tool` **proposes** (a pending file the host must admit); `tool` calls an **admitted** tool and nothing else.
<!-- END GENERATED: tool-path -->

<!-- BEGIN GENERATED: tools — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
**The default tools are a closed set of 6 primitives** (`PRIMITIVES` in `core/extensions.ts`). A model authors a descriptor that *parameterises* one; it never authors a body, so nothing in the runtime evaluates model-written code.

| primitive | consumes | what the host hands the tool |
|---|---|---|
| `now` | — | nothing — it answers with the clock |
| `read-file` | read | a root-scoped read function: paths resolve inside the project root or refuse |
| `write-file` | write | a root-scoped write function: paths resolve inside the project root, writes are reported and revertible |
| `list-files` | read | a root-scoped read function: paths resolve inside the project root or refuse |
| `http-get` | network | a mediated fetch: hosts outside bounds.hosts are refused by name — INCLUDING across redirects, every hop charged to bounds.maxRequests — and the audit records the URL that actually served the bytes |
| `wasm` | — | nothing — the module closes its own CAPABILITIES (linear memory, zero imports); its bytes are verified at admission and rehashed at every call, and its time and memory are bounded by HOST constants, never by the module's declaration |

**What no tool can have on the `machine` placement**, asked of the gate itself:
* exec — absent: no mechanism on this placement bounds a spawned child: --allow-run bounds which binary, never what it can do, and a child does not inherit the parent's flags. Admission requires a container that bounds the child.
* eval — absent: eval is not a tool path (design §1.7): the evaluator bypasses whatever the substrate would otherwise enforce.
* import — absent: no import boundary on this placement: dynamic import executes fetched code with no flags by default.

**The catalogue** — `catalogue/*.json`, 5 tracked descriptors (strangers' extensions you can sideload). **None is loaded until the host admits it**; the last column is what `admit()` says today:

| id | tools | declares | bounds | the gate's verdict |
|---|---|---|---|---|
| `brave-search` | `brave_search` → `http-get` | network | hosts: api.search.brave.com; maxRequests: 20 | admitted — network via `mediated-fetch` |
| `mcp-server-local` | `mcp_list_tools` → `process` | exec | command: npx -y @modelcontextprotocol/server-filesystem /tmp | **refused** `exec-absent` |
| `mcp-server-remote` | `mcp_remote_list_tools` → `http-get` | network | hosts: mcp.example.com; maxRequests: 20 | admitted — network via `mediated-fetch` |
| `notes` | `read_notes` → `read-file` | read | — | admitted — read via `host-primitive-scope` |
| `web-search` | `web_search` → `http-get` | network | hosts: api.duckduckgo.com; maxRequests: 5 | admitted — network via `mediated-fetch` |

**What it refuses, by name** — literal refusal declarations collected from these sources:
* the gate (`core/extensions.ts`): `absent-capability`, `bad-tool-name`, `capability-unmediated`, `duplicate-tool`, `eval-not-a-tool-path`, `exec-absent`, `network-unbounded`, `no-tools`, `under-declared`, `unknown-capability`, `unknown-primitive`, `unsupported-abi`
* the routes and the root seam (`server.mjs`, `core/root.ts`, `browser/acts.ts`): `adapter-not-configured`, `approval-invalid-id`, `approval-json-required`, `audit-unreadable`, `bad-answer`, `bad-request`, `bearer-refused`, `bounds-invalid`, `cannot-delete-directory`, `cannot-delete-local`, `cross-environment-unauthorized`, `dotfile-refused`, `environment-not-paired`, `environment-unknown`, `environment-unreachable`, `exec-threw`, `extension-not-admitted`, `git-failed`, `host-token-refused`, `host-token-required`, `loopback-auth-disabled`, `loopback-unauthenticated`, `mini-app-timeout`, `mini-app-unreachable`, `missing-argument`, `missing-content`, `no-project`, `not-a-directory`, `not-a-git-repo`, `not-found`, `not-supported-in-browser`, `nothing-to-undo`, `outside-root`, `pairing-revoked`, `path-missing`, `pattern-not-found`, `pattern-not-unique`, `probe-failed`, `protected-audit`, `provider-not-configured`, `root-not-mine`, `root-not-reachable-from-here`, `root-unreachable`, `server-error`, `task-root-unavailable`, `unauthenticated-call`, `undo-failed`, `unknown-command`, `unknown-environment`, `unknown-mini-app-tool`, `unknown-root-kind`, `unknown-verb`, `unreadable`, `write-error`
* admitted tools at run time (`lib/extensions.mjs`): `approval-audit-unwritable`, `approval-no-proposal`, `approval-plan-changed`, `approval-unavailable`, `bad-descriptor`, `bad-redirect`, `bad-tool-name`, `bounds-invalid`, `descriptor-missing`, `extension-not-admitted`, `fetch-failed`, `gate-refused-at-load`, `invalid-id`, `missing-description`, `missing-name`, `network-unbounded`, `no-tools`, `outside-root`, `over-budget`, `params-invalid`, `params-unknown-tool`, `protected-audit`, `redirect-host-not-allowed`, `redirect-without-location`, `too-many-redirects`, `unknown-primitive`, `unreadable`
* task admission/readback (`core/tasks.ts`, `lib/tasks.mjs`): `agent-environment-mismatch`, `agent-not-configured`, `agent-required`, `executor-unavailable`, `invalid-task`, `invalid-task-address`, `invalid-task-context`, `task-audit-unavailable`, `task-authority-field`, `task-call-id-conflict`, `task-call-id-required`, `task-cancelled`, `task-capacity-exhausted`, `task-context-unavailable`, `task-deadline`, `task-environment-changed`, `task-environment-unverified`, `task-input-over-budget`, `task-invalid-result`, `task-not-found`, `task-not-running`, `task-output-over-budget`, `task-owner-mismatch`, `task-owner-unconfirmed`, `task-owner-unverified`, `task-persistence-failed`, `task-root-replaced`, `task-root-unavailable`, `unbounded-executor`, `unknown-tool`, `unsupported-runtime-capability`

**Listable at run time** — `GET /api/extensions` answers `{ placement, extensions, proposals, present, failedLoads, catalogueCount }` (probed: placement `machine`, catalogueCount 5); `GET /api/extensions/catalogue` previews the gate's verdict on every stranger before anything is staged; `GET /api/extensions/{proposals|catalogue}/<id>/plan` is the disclosure — source, declared, enforced-by-which-mechanism, what it gets, what it cannot have — before any decision.

**What the process itself can reach** — `GET /api/probe` runs `tools/sandbox-probe.mjs` on this environment and answers an **observed** report (probed: HTTP 200, sections `identity`, `sandboxHints`, `filesystem`, `limits`, `tools`, `network`), cached with its `when` and recorded as an activity in the environment's own audit. It reports files, network and limits as facts with the method beside them — a different question from "which tools are admitted", answered by a different instrument.

**Admission is the host's act**, probed from where the page stands: `POST /api/extensions/admit` with no token → HTTP 403, `host-token-required`.
<!-- END GENERATED: tools -->

---

## Configuration Reference

<!-- BEGIN GENERATED: config — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
Every environment variable the server and its libraries read, and where:

| variable | read in | what it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | `lib/live-providers/claude.mjs`, `lib/pi-acp.mjs`, `lib/resolver.mjs` | the pi adapter child's DELIBERATE pass-through (voicebox-beads-cpbr, measured): pi's anthropic provider falls back to this ambient key when the auth store has no anthropic entry — the mechanism string in `lib/pi-acp.mjs` names it present/absent per host; scoping it out makes anthropic-model delegations refuse `model-unsupported` (unlike nz60's claude child, where the key is an override and is deleted) |
| `BRAVE_API_KEY` | `lib/extensions.mjs` | the Brave Search API subscription token used by `callHttp` when an extension declares `api.search.brave.com` — without it that call refuses by name (`api-key-missing`) |
| `FORCE_COLOR` | `lib/logger.mjs` | standard terminal colour override (`0` disables ANSI colours in `lib/logger.mjs`, non-zero enables them even when stdout is not a TTY) |
| `GEMINI_API_KEY` | `lib/live-providers/gemini.mjs`, `lib/resolver.mjs`, `server.mjs` | read by TWO things with different refusals: the live session refuses to start by name, and the gemini turn resolver answers `unresolved` saying it has no key |
| `LIVE_PROVIDER` | `lib/live-session.mjs`, `server.mjs` | the OLD NAME of `VOICEBOX_LIVE_PROVIDER`, honoured for one release |
| `NODE_DISABLE_COLORS` | `lib/logger.mjs` | Node's built-in colour disable flag — honoured by `lib/logger.mjs` alongside `NO_COLOR` |
| `NO_COLOR` | `lib/logger.mjs` | standard terminal colour override — when set to a non-empty value, `lib/logger.mjs` strips ANSI colour sequences |
| `OPENAI_API_KEY` | `lib/live-providers/openai.mjs`, `lib/resolver.mjs`, `server.mjs` | the OpenAI Realtime key — without it that provider refuses to start, by name |
| `PATH` | `lib/claude-acp.mjs` | the executable search path — also inherited by task-adapter children (the claude adapter resolves its pinned `npx` through it) |
| `PORT` | `server.mjs` | the port the server binds (default 8787) |
| `VOICEBOX_ACP_ADAPTER` | `lib/pi-acp.mjs` | path or command override for the `pi-acp` stdio adapter binary in `lib/pi-acp.mjs` |
| `VOICEBOX_ACP_PI` | `lib/pi-acp.mjs` | path or command override for the `pi` coding agent CLI used by `lib/pi-acp.mjs` |
| `VOICEBOX_BIND_DEADLINE_MS` | `server.mjs` | how long to keep retrying before giving up by name |
| `VOICEBOX_BIND_RETRY_MS` | `server.mjs` | how often to retry a bind that lost the port race |
| `VOICEBOX_CLAUDE_CLI` | `lib/claude-acp.mjs` | the claude CLI the adapter child is told to execute (exported to it as `CLAUDE_CODE_EXECUTABLE`); unset resolves the user-installed CLI, else the adapter-bundled binary |
| `VOICEBOX_CLAUDE_KEEP_API_KEY` | `lib/claude-acp.mjs` | opt-back for the claude-code adapter child env: set to `1` to keep the host's `ANTHROPIC_API_KEY`. By default that key is DELETED from the child — an inherited key overrides claude.ai login and can stall the prompt — the host's own environment is never mutated, and the test asserts the key is ABSENT rather than present-with-no-value, because those are different child environments (voicebox-beads-nz60) |
| `VOICEBOX_ENABLE_STUB_PROVIDER` | `server.mjs` | registers the key-free `stub` live provider for proofs (it echoes the microphone back at 0.3 gain; no vendor, no network, no key). OFF by default, so it is never offered in the provider list a person chooses from (voicebox-beads-ldxa) |
| `VOICEBOX_EXTENSIONS_DIR` | `lib/state-dirs.mjs` | the host's extension directory: admitted descriptors, `.host-token` (0600), `.ledger.jsonl`, and `.pairings.json` (the bearer custody store — outside every root) |
| `VOICEBOX_HARNESS` | `server.mjs` | selects the host task adapter (`pi` enables the Pi ACP task adapter in `server.mjs`; unset leaves no default adapter configured) |
| `VOICEBOX_HELLO_BOUND_MS` | `server.mjs` | how long to wait for a hello frame on /channel or /live before refusing (default 5000ms) |
| `VOICEBOX_INSTANCE` | `server.mjs` | this writer's name in the active root's shared log (default `machine`) |
| `VOICEBOX_LIVE_PROVIDER` | `lib/live-session.mjs`, `server.mjs` | the live transport's fallback when the session passes no provider; `/live` passes the agent-settings provider explicitly — **not** the turn resolver |
| `VOICEBOX_LOOPBACK_AUTH` | `server.mjs` | set to `1` to turn on the loopback session gate (docs/13 §4, docs/18): the page and the APIs answer only with the HttpOnly `SameSite=Strict` session cookie that a one-time bootstrap ticket mints — the ticket's URL is printed at startup, or minted from the shell via `POST /api/bootstrap` with the host token. Default unset serves the page openly (the 5c1 surface). The session secret is per-process and in-memory: a restart invalidates every issued cookie, and the remedy is the URL the new process printed |
| `VOICEBOX_OPENAI_INPUT_TRANSCRIPTION` | `lib/live-providers/openai.mjs` | set to `1` (or pass `inputTranscription: true` to `createOpenAIProvider`) to enable `gpt-4o-mini-transcribe` input audio transcription in the OpenAI Realtime session handshake |
| `VOICEBOX_PROVIDER` | `server.mjs` | the OLD NAME of `VOICEBOX_RESOLVER`, honoured for one release: a shell that exports it keeps working and gets a line on stderr |
| `VOICEBOX_RESOLVER` | `server.mjs` | which TURN resolver answers `POST /api/turn` (default `script`) — **not** the live provider, which is a different concept |
| `VOICEBOX_SANDBOX_HOMES` | `lib/state-dirs.mjs` | where a fence's writable home is bound from (default `~/sandbox-homes/<key>`) — the one place a fenced environment may write. Must live OUTSIDE /tmp: an L1.5 unit's PrivateTmp hides /tmp in its namespace and a home there fails to bind (status 226/NAMESPACE) |
| `VOICEBOX_WASM_SHELF_DIR` | `lib/state-dirs.mjs` | directory holding the digest-pinned WASM tool shelf (`manifest.json` and `.wasm` modules; default `~/.isocan/modules/wasm-tools`) |
| `VOICEBOX_WORKSPACE` | `lib/state-dirs.mjs` | declares a machine root at boot — a decision, not a default — and is where the extension system keeps `proposals/` and `audit.jsonl` |
<!-- END GENERATED: config -->

There is no configuration file. Runtime behavior is controlled by environment variables, selected provider keys, and admitted extensions.

---

## Documentation

For architectural specifications, security designs, and protocol contracts, start with [`docs/README.md`](docs/README.md) — the index and documentation map across all 21 topics.

---

## Development & Quality Gates

Voicebox uses multi-tier automated test gates:

- **Scoped Test Runner (`npm run test:changed`)**:
  Inspects git diffs against `origin/main`, maps modified source files to their exercising test suites, and runs only relevant tests. Essential for fast inner-loop iteration.
- **Unit Suite (`npm run test:unit`)**:
  Executes fast unit tests across core, lib, and browser logic in ~5 seconds.
- **Full Test Suite (`npm test`)**:
  Executes unit tests, concurrent server live tests (`--test-concurrency=4`), and serial browser CDP tests.
- **Acceptance Gate (`npm run accept`)**:
  Runs end-to-end verification asserting read idempotence, file write event verification, and headless browser proofs.
- **Documentation Drift Check (`npm run docs:check`)**:
  Verifies that generated capability tables in `README.md` remain synchronized with the runtime implementation. To regenerate blocks after code changes, run `npm run docs:write`.
