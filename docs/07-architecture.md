# Architecture — what this system is tonight

**This is a snapshot, not a spec.** It describes the tree it sits in, including the parts that are
placeholders, and `scripts/docs-check.mjs` fails when the enumerable claims below drift from the code. For
what voicebox is *meant* to be, read [`00-brief.md`](00-brief.md) (Paul's words), [`02-environment.md`](02-environment.md)
(the environment design — a **design record**, not a description of this tree) and [`01-questions.md`](01-questions.md).

The distinction matters more here than in most repositories: `02-environment.md` and
[`05-harvest.md`](05-harvest.md) are **design records** — they describe systems that may not exist yet, and
they are allowed to. This file and [`08-how-it-runs.md`](08-how-it-runs.md) are **snapshots** — they describe
what runs, and a claim in them that the code contradicts is a bug in the document.

## Components

| component | file | authority for | state |
|---|---|---|---|
| the page | `public/index.html`, `public/fused.js`, `public/style.css`, `public/live-voice.js` | the interface: objects on a canvas, the turn box, the transcript, native modal dialogs for settings, environments, extensions, and harnesses — and the handlers for `{type:"tool"}` (re-reads file list) and `{type:"task"}` (mounts and updates the task card) | real, with labelled simulations |
| the server | `server.mjs` | routes, static serving, running actions, the workspace | **zero dependencies** (`node:http`) |
| the fleet | `lib/fleet.mjs`, `core/fleet.ts` | multi-environment agent discovery, target keys (`env/agent`), and session contact routing | addressable across environments |
| the turn resolver | `lib/resolver.mjs` | turning a transcript into an action `{ verb, name, content? }` | **one provider, three verbs — a placeholder** |
| the environment core | `core/*.ts` | the tier table, policy, containment, the audit, project records | the E1-M0 library; not yet wired to the page | <!-- docs-check: names the mechanism -->
| the tool | `tools/create-asset.wat` | the one tool E1-M0 runs, as a Wasm module | present, exercised by `tests/` | <!-- docs-check: names the mechanism -->
| the dev server | `vite.config.js` | HMR, and forwarding everything the page needs from the server: `/api`, `/live`, the executor channel `/channel`, and **the browser's whole module graph** — the five directories in `lib/browser-sources.mjs` (`core`, `browser`, `tools`, `tests`, `lib`), generated from that one list so the front cannot hold a stale copy of it | dev only — never the production path |

**What is here tonight:** `lib/live-session.mjs` (the upstream live session) and `lib/ws-server.mjs` (the
WebSocket transport) have landed, and the page loads `live-voice.js`, which opens `/live` and streams PCM
through `pcm-worklet.js`. The generated line below says what the model is; the *turn* path is still the
`script` placeholder, and those two facts are what an earlier version of this file managed to conflate.

<!-- BEGIN GENERATED: live-session — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
`lib/live-session.mjs` is present. Registered live providers, with the model each one's handshake names (captured from the provider against a recording transport — never dialed): `gemini` → `models/gemini-3.8-live`, `openai` → `gpt-realtime`. The library fallback is `gemini`, overridable by `VOICEBOX_LIVE_PROVIDER`; the server's `/live` route instead passes the agent-settings provider explicitly.
<!-- END GENERATED: live-session -->

## The turn path, in order

```
page  --POST /api/turn {transcript}-->  server.mjs  --resolveTurn(transcript, provider)-->  lib/resolver.mjs
        <--- {transcript, action, result} ---  server executes the action in the active project root
```

The active project root is wherever the environment declares it (or the boot-time workspace
variable, which is a declaration too) — the path is the server's answer to `GET /api/root`, not a
fixed location this diagram names.

**Who may declare, and why the token is scoped the way it is** (voicebox-beads-fqq). `POST /api/root`
needed the host token for every kind of root, and the page cannot hold one — so a browser-stored project
could never be declared, and a fresh room could not list or write anything at all. The token now guards
what it was actually defending: a **machine** root re-points every file route the *server itself* serves,
so that declaration stays the host's act (403 `host-token-required` without it). A **page-owned** root
(`opfs`, `handle`) grants the server no file-route power — `core/root.ts` `ROOT_FACTS.opfs.reachableFrom
= ["page"]`, every act routes back to the page, and the page refuses any root that is not its own
(`browser/acts.ts`: `root-not-mine`) — so the page may declare it, authorized by the same rule `/channel`
already uses to decide who the local page is: the request's `Origin` is one of this server's own bound
origins. The response says which of the two acts it was (`declaredBy: "host" | "page"`). A request from
any other origin is refused, and the refusal names the rule that would have allowed it.

**A room with no root declared, and a page that holds one.** When nothing is declared at all, the room's
listing and read routes ask the page that holds its own project (`GET /api/files`, `GET /api/file` →
`via: "page"`), and the page answers for its project: the server stores nothing and declares nothing,
and the answer carries the page's descriptor so the room can name whose files these are. A call that
names **no** root means "the project this page holds"; a call that names a *different* root is still
refused `root-not-mine`, and a page with no project open answers `no-project` rather than an empty list.

The server **never parses language itself**: `resolveTurn` returns an action, and the server runs it. That
is the whole seam, and it is why swapping the brain does not touch the page or the server.

<!-- BEGIN GENERATED: providers — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
Registered resolvers: `gemini`, `script`

* `registerResolver(name, fn)` is the seam; `resolveTurn(transcript, provider = "script")` picks one.
* The **script** provider handles `write`, `read` and `list`: `"create a file called hello.txt with hi"` → `{"verb":"write","name":"hello.txt","content":"hi"}`.
* The verbs it produces, driven one utterance each: `write`, `read`, `list`, `make-tool`, `tool`. An utterance matching **none** of them is **unresolved**, by design: `"book me a flight to Lisbon"` → `"the script resolver only knows create/read…"`. (This line used to say *"anything else is unresolved"*, which was a TYPED universal beside a derived example — false the moment `make-tool` and `tool` started resolving.)
* The live voice providers (`gemini`, `openai`) live behind a **different** seam, `registerLiveProvider` in `lib/live-session.mjs`; none of them is a turn resolver — see the tool path below.
<!-- END GENERATED: providers -->

Hand-written addition (not generated): the project's own instruction file — `lib/project-instruction.mjs`, read at live-session start from the declared machine root (`AGENT.md`, then `AGENTS.md`; 32 KiB bound) — composes between the agent's instruction and the tools instruction; absence is normal, unreadable is named.

## The agent loop — one turn, driven

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

## The tool path — which words reach a tool

<!-- BEGIN GENERATED: tool-path — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
**Three ways words reach this server; all reach the shared executor.**

| path | wired today | what carries the words | what runs |
|---|---|---|---|
| typed in the composer | yes | `public/fused.js` → `POST /api/turn` | `resolveTurn()` (`lib/resolver.mjs`, provider `script`) → `execute()` (`server.mjs`) → for tools, `callTool()` (`lib/extensions.mjs`) |
| dictated (browser `SpeechRecognition`, no key) | yes — the same route | `public/fused.js` → `POST /api/turn` | the same |
| spoken to the live model | audio yes; tools **yes** | `public/live-voice.js` → `/live` → `lib/live-session.mjs` → the provider | provider tool call → `commandToAction()` → `execute()` → correlated tool response — and the server tells the page (`{type:"tool"}`), which re-reads the file list so a file the model wrote appears as it arrives |

What each live handshake declares, captured from the provider with the server's shared command list: `gemini` → tools: `list_extensions`, `call_extension`, `write_file`, `read_file`, `list_files`, `delete_file`, `edit_file`, `diff_file`, `grep_files`, `list_agents`, `delegate_task`, `contact_agent`, `launch_mini_app`; `openai` → tools: `list_extensions`, `call_extension`, `write_file`, `read_file`, `list_files`, `delete_file`, `edit_file`, `diff_file`, `grep_files`, `list_agents`, `delegate_task`, `contact_agent`, `launch_mini_app`. Extension discovery reads the current registry; invocation goes through the existing admission and runtime bounds.

Verbs the `script` resolver produces, driven: `"create a file called hello.txt with hi"` → `write`, `"read hello.txt"` → `read`, `"list files"` → `list`, `"create a tool called clock that tells the time"` → `make-tool`, `"run the tool clock"` → `tool`. `make-tool` **proposes** (a pending file the host must admit); `tool` calls an **admitted** tool and nothing else.
<!-- END GENERATED: tool-path -->

## The tool surface — what exists, what it refuses, how to list it

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
* the routes and the root seam (`server.mjs`, `core/root.ts`): `adapter-not-configured`, `approval-invalid-id`, `approval-json-required`, `audit-unreadable`, `bad-answer`, `bad-request`, `bearer-refused`, `bounds-invalid`, `cannot-delete-directory`, `cross-environment-unauthorized`, `dotfile-refused`, `environment-not-paired`, `environment-unknown`, `environment-unreachable`, `exec-threw`, `extension-not-admitted`, `host-token-required`, `missing-argument`, `missing-content`, `not-a-directory`, `not-found`, `outside-root`, `pairing-revoked`, `path-missing`, `pattern-not-found`, `pattern-not-unique`, `probe-failed`, `protected-audit`, `provider-not-configured`, `server-error`, `task-root-unavailable`, `unauthenticated-call`, `unknown-command`, `unknown-environment`, `unknown-root-kind`, `unreadable`, `write-error`
* admitted tools at run time (`lib/extensions.mjs`): `approval-audit-unwritable`, `approval-no-proposal`, `approval-plan-changed`, `approval-unavailable`, `bad-redirect`, `bounds-invalid`, `extension-not-admitted`, `fetch-failed`, `outside-root`, `over-budget`, `params-invalid`, `params-unknown-tool`, `protected-audit`, `redirect-host-not-allowed`, `redirect-without-location`, `too-many-redirects`
* task admission/readback (`core/tasks.ts`, `lib/tasks.mjs`): `agent-environment-mismatch`, `agent-not-configured`, `agent-required`, `executor-unavailable`, `invalid-task`, `invalid-task-address`, `invalid-task-context`, `task-audit-unavailable`, `task-authority-field`, `task-call-id-conflict`, `task-call-id-required`, `task-cancelled`, `task-capacity-exhausted`, `task-context-unavailable`, `task-deadline`, `task-environment-changed`, `task-environment-unverified`, `task-input-over-budget`, `task-invalid-result`, `task-not-found`, `task-not-running`, `task-output-over-budget`, `task-owner-mismatch`, `task-owner-unconfirmed`, `task-owner-unverified`, `task-persistence-failed`, `task-root-replaced`, `task-root-unavailable`, `unbounded-executor`, `unknown-tool`, `unsupported-runtime-capability`

**Listable at run time** — `GET /api/extensions` answers `{ placement, extensions, proposals, present, catalogueCount }` (probed: placement `machine`, catalogueCount 5); `GET /api/extensions/catalogue` previews the gate's verdict on every stranger before anything is staged; `GET /api/extensions/{proposals|catalogue}/<id>/plan` is the disclosure — source, declared, enforced-by-which-mechanism, what it gets, what it cannot have — before any decision.

**What the process itself can reach** — `GET /api/probe` runs `tools/sandbox-probe.mjs` on this environment and answers an **observed** report (probed: HTTP 200, sections `identity`, `sandboxHints`, `filesystem`, `limits`, `tools`, `network`), cached with its `when` and recorded as an activity in the environment's own audit. It reports files, network and limits as facts with the method beside them — a different question from "which tools are admitted", answered by a different instrument.

**Admission is the host's act**, probed from where the page stands: `POST /api/extensions/admit` with no token → HTTP 403, `host-token-required`.
<!-- END GENERATED: tools -->

## Configuration — every variable the process reads

<!-- BEGIN GENERATED: config — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
Every environment variable the server and its libraries read, and where:

| variable | read in | what it does |
|---|---|---|
| `BRAVE_API_KEY` | `lib/extensions.mjs` | the Brave Search API subscription token used by `callHttp` when an extension declares `api.search.brave.com` — without it that call refuses by name (`api-key-missing`) |
| `FORCE_COLOR` | `lib/logger.mjs` | standard terminal colour override (`0` disables ANSI colours in `lib/logger.mjs`, non-zero enables them even when stdout is not a TTY) |
| `GEMINI_API_KEY` | `lib/live-providers/gemini.mjs`, `lib/resolver.mjs`, `server.mjs` | read by TWO things with different refusals: the live session refuses to start by name, and the gemini turn resolver answers `unresolved` saying it has no key |
| `LIVE_PROVIDER` | `lib/live-session.mjs`, `server.mjs` | the OLD NAME of `VOICEBOX_LIVE_PROVIDER`, honoured for one release |
| `NODE_DISABLE_COLORS` | `lib/logger.mjs` | Node's built-in colour disable flag — honoured by `lib/logger.mjs` alongside `NO_COLOR` |
| `NO_COLOR` | `lib/logger.mjs` | standard terminal colour override — when set to a non-empty value, `lib/logger.mjs` strips ANSI colour sequences |
| `OPENAI_API_KEY` | `lib/live-providers/openai.mjs`, `server.mjs` | the OpenAI Realtime key — without it that provider refuses to start, by name |
| `PORT` | `server.mjs` | the port the server binds (default 8787) |
| `VOICEBOX_ACP_ADAPTER` | `lib/pi-acp.mjs` | path or command override for the `pi-acp` stdio adapter binary in `lib/pi-acp.mjs` |
| `VOICEBOX_ACP_PI` | `lib/pi-acp.mjs` | path or command override for the `pi` coding agent CLI used by `lib/pi-acp.mjs` |
| `VOICEBOX_BIND_DEADLINE_MS` | `server.mjs` | how long to keep retrying before giving up by name |
| `VOICEBOX_BIND_RETRY_MS` | `server.mjs` | how often to retry a bind that lost the port race |
| `VOICEBOX_EXTENSIONS_DIR` | `lib/extensions.mjs`, `server.mjs` | the host's extension directory: admitted descriptors, `.host-token` (0600), `.ledger.jsonl`, and `.pairings.json` (the bearer custody store — outside every root) |
| `VOICEBOX_HARNESS` | `server.mjs` | selects the host task adapter (`pi` enables the Pi ACP task adapter in `server.mjs`; unset leaves no default adapter configured) |
| `VOICEBOX_HELLO_BOUND_MS` | `server.mjs` | how long to wait for a hello frame on /channel or /live before refusing (default 5000ms) |
| `VOICEBOX_INSTANCE` | `server.mjs` | this writer's name in the active root's shared log (default `machine`) |
| `VOICEBOX_LIVE_PROVIDER` | `lib/live-session.mjs`, `server.mjs` | the live transport's fallback when the session passes no provider; `/live` passes the agent-settings provider explicitly — **not** the turn resolver |
| `VOICEBOX_PROVIDER` | `server.mjs` | the OLD NAME of `VOICEBOX_RESOLVER`, honoured for one release: a shell that exports it keeps working and gets a line on stderr |
| `VOICEBOX_RESOLVER` | `server.mjs` | which TURN resolver answers `POST /api/turn` (default `script`) — **not** the live provider, which is a different concept |
| `VOICEBOX_SANDBOX_HOMES` | `lib/fence-provider.mjs`, `lib/unit-fence-provider.mjs` | where a fence's writable home is bound from (default `~/sandbox-homes/<key>`) — the one place a fenced environment may write. Must live OUTSIDE /tmp: an L1.5 unit's PrivateTmp hides /tmp in its namespace and a home there fails to bind (status 226/NAMESPACE) |
| `VOICEBOX_WASM_SHELF_DIR` | `lib/extensions.mjs` | directory holding the digest-pinned WASM tool shelf (`manifest.json` and `.wasm` modules; default `~/.isocan/modules/wasm-tools`) |
| `VOICEBOX_WORKSPACE` | `lib/extensions.mjs`, `server.mjs` | declares a machine root at boot — a decision, not a default — and is where the extension system keeps `proposals/` and `audit.jsonl` |
<!-- END GENERATED: config -->

## The routes, as they answer

<!-- BEGIN GENERATED: routes — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
The zero-dependency server (`server.mjs`, `node:http`) binds **127.0.0.1** and serves:

| method | path | probed status |
|---|---|---|
| `GET` | `/` | 200 |
| `GET` | `/api/health` | 200 |
| `GET` | `/api/files` | 200 |
| `POST` | `/api/turn` | 200 |

Anything else that exists under `public/` is served from there (`GET /static` and a fall-through), which is how the page, its scripts and the styles arrive. `/api/health` answers `provider: "script"`, `declared: false` and `root: { kind, path }` for the ACTIVE project root — which the environment declares (`POST /api/root`); the loop has no root of its own, and refuses by name (`root-not-declared`) until one is declared.

A WEBSOCKET UPGRADE ON /live IS ACCEPTED (101) — the zero-dependency server owns it.
<!-- END GENERATED: routes -->

## What the page actually loads

<!-- BEGIN GENERATED: page — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
The page loads `fused.js` and `pip-mic.mjs` and `live-voice.js` from `public/`.
Audio worklets loaded by that code: `pcm-worklet.js`.

`verify.mjs` sits in `public/` but is **not** loaded by `index.html`; it is a support script, not part of the page's load set.
<!-- END GENERATED: page -->

## The audio path, tonight

<!-- BEGIN GENERATED: live-session — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
`lib/live-session.mjs` is present. Registered live providers, with the model each one's handshake names (captured from the provider against a recording transport — never dialed): `gemini` → `models/gemini-3.8-live`, `openai` → `gpt-realtime`. The library fallback is `gemini`, overridable by `VOICEBOX_LIVE_PROVIDER`; the server's `/live` route instead passes the agent-settings provider explicitly.
<!-- END GENERATED: live-session -->

## Where each file's authority lies

- **`server.mjs`** is authoritative for the routes and for what an action *does* (it executes verbs, it does
  not interpret them). It binds `127.0.0.1` only.
- **`lib/resolver.mjs`** is authoritative for the provider list, and for what a transcript means. Its
  contract is one function; a new brain is a `registerResolver` call.
- **`core/`** is authoritative for the tier table, containment and the audit — and it is a **library**: it
  imports nothing outside `core/`, because two copies of it would drift silently (see the design's N18). <!-- docs-check: names the mechanism -->
- **`core/harness-config.ts`** is authoritative for the pure, secret-free configured-agent contract, distinguishing runtime ("node" | "deno" | "browser"), configured agent instances (permanent ID, mutable name, model, reach, bounds), and executing environments. PURE: zero imports outside `core/` (self-contained core library).
- **`lib/harness-config.mjs`** is authoritative for the agent registry and loader, supporting both server storage and zero-server browser-local placements, and feeding configured agents into harness discovery. Server storage writes are atomic (temp file + rename) so a failed write cannot truncate the registry; the host-token-gated `GET`/`POST /api/agents` and `PATCH /api/agents/:id` routes are its HTTP surface.
- **`public/fused.js`** is authoritative for what the page shows, and it **labels its own simulations on the
  page**: files, the turn submission and the containment refusals are real; the shared view, seen-marks and
  admission are simulated and say so. A reader should trust that label over any prose, including this file.
  The room's folder handles (`#open-folder`, `#room-folders-bar`) provide read/write handles persisted in IndexedDB
  across reloads, supporting several directories at once with a "Restore access" button when permission drops to prompt.
  The frontend interface (`public/index.html`, `public/fused.js`, `public/style.css`) is built with modern web
  platform primitives: native modal `<dialog>` (with `closedby="any"` and unified light-dismiss geometry fallbacks),
  `container: env-dialog / inline-size` container queries for component-isolated responsive layout, `<search>` landmark
  semantics, scroll containment (`overscroll-behavior: contain`, `scrollbar-gutter: stable`), keyboard-focusable
  scrollable regions (`<pre tabindex="0">`), IME composition guards, and GitHub-linked commit references in `#build` alongside a quick link to `changelog.html` (`GET /api/changelog`).
  **Folders are navigable** (voicebox-beads-tee): a folder row opens that folder in the same list — the
  listing IS the navigation, and every row carries its path from the root. A crumb bar says where you are
  (`root / proposals / drafts`), every ancestor is a 44px button, a parent control leads back, and Enter
  opens a focused folder row. ONE shared helper (`core/paths.ts` `normaliseRelativeDir`) normalises the
  path for the server and the page alike, so `proposals//drafts/` is the same folder to both while `..`, a
  leading slash and any dotfile segment are refused by name; the root itself is answered directly, because
  a root is not a file name (handing `""` to the file resolver refuses the root — found by driving, on
  both sides). It holds across root kinds: a machine root is listed by the server, a page-owned root (OPFS
  or a picked folder) is listed through the page, which resolves the subpath against its own descriptor.
Zero-server browser delegation (`lib/task-placement.mjs`, `docs/16-zero-server-delegation.md`, `voicebox-beads-8fv.1`)
  associates placement (`browser`, `machine`, `remote`) with the environment rather than requiring a dedicated server broker;
  supports `opfs` and `handle` roots portably without hardcoded machine filesystem paths.
  The room's file list is a `file-explorer` inline-size container: one column by default, two from 36rem,
  with long names wrapping independently of their sizes. Its scroll area is bounded to 40svh/24rem
  so a populated list does not keep growing through the room. Selection, root provenance, arrival
  expiry and folder permissions remain controlled by the existing page logic; CSS changes only their
  presentation. A failed listing still reveals an explicit recovery link when the page provides one;
  other failures do not expose file-creation samples. `tests/room-explorer-ui.test.mjs` drives the native
  controls, layout boundaries and the visible no-project recovery link.
