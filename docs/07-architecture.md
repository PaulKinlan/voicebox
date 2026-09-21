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
| the page | `public/index.html`, `public/fused.js`, `public/style.css` | the interface: objects on a canvas, the turn box, the transcript | real, with labelled simulations |
| the server | `server.mjs` | routes, static serving, running actions, the workspace | **zero dependencies** (`node:http`) |
| the turn resolver | `lib/resolver.mjs` | turning a transcript into an action `{ verb, name, content? }` | **one provider, three verbs — a placeholder** |
| the environment core | `core/*.ts` | the tier table, policy, containment, the audit, project records | the E1-M0 library; not yet wired to the page |
| the tool | `tools/create-asset.wat` | the one tool E1-M0 runs, as a Wasm module | present, exercised by `tests/` |
| the dev server | `vite.config.js` | HMR, proxying `/api` (and `/live`, for work not yet landed) | dev only — never the production path |

**What is here tonight:** `lib/live-session.mjs` (the upstream live session) and `lib/ws-server.mjs` (the
WebSocket transport) have landed, and the page loads `live-voice.js`, which opens `/live` and streams PCM
through `pcm-worklet.js`. The generated line below says what the model is; the *turn* path is still the
`script` placeholder, and those two facts are what an earlier version of this file managed to conflate.

<!-- BEGIN GENERATED: live-session -->
`lib/live-session.mjs` is present. Registered live providers, with the model each one's handshake names (captured from the provider against a recording transport — never dialed): `gemini` → `models/gemini-3.8-live`, `openai` → `gpt-realtime`. The default is `gemini`; `LIVE_PROVIDER` overrides it.
<!-- END GENERATED: live-session -->

## The turn path, in order

```
page  --POST /api/turn {transcript}-->  server.mjs  --resolveTurn(transcript, provider)-->  lib/resolver.mjs
        <--- {transcript, action, result} ---  server executes the action in the active project root
```

The active project root is wherever the environment declares it (or the boot-time workspace
variable, which is a declaration too) — the path is the server's answer to `GET /api/root`, not a
fixed location this diagram names.

The server **never parses language itself**: `resolveTurn` returns an action, and the server runs it. That
is the whole seam, and it is why swapping the brain does not touch the page or the server.

<!-- BEGIN GENERATED: providers -->
Registered resolvers: `gemini`, `script`

* `registerResolver(name, fn)` is the seam; `resolveTurn(transcript, provider = "script")` picks one.
* The **script** provider handles `write`, `read` and `list`: `"create a file called hello.txt with hi"` → `{"verb":"write","name":"hello.txt","content":"hi"}`.
* Anything else is **unresolved**, by design: `"book me a flight to Lisbon"` → `"the script resolver only knows create/read…"`.
* The live voice providers (`gemini`, `openai`) live behind a **different** seam, `registerLiveProvider` in `lib/live-session.mjs`; none of them is a turn resolver — see the tool path below.
<!-- END GENERATED: providers -->

## The agent loop — one turn, driven

<!-- BEGIN GENERATED: loop -->
**One turn, driven end to end on a scratch root while this document was generated.** Every value in the last column was read back from the server, not typed.

| step | what happens | the mechanism | driven |
|---|---|---|---|
| **1 · a turn starts** | words arrive | `POST /api/turn {transcript}` — from the composer or browser dictation; the live model's words do **not** arrive here yet (see *the tool path*) | `"create a file called hello.txt with hi"` |
| **2 · something decides** | the resolver turns words into an action, or says it cannot (`unresolved`) | `resolveTurn(transcript, "script")` in `lib/resolver.mjs` — the server never parses language itself | → `{"verb":"write","name":"hello.txt","content":"hi"}` |
| **3 · something acts** | the executor runs the verb in the **active root** — the one declared over `POST /api/root`; none is assumed | `execute(action)` in `server.mjs` | → `wrote hello.txt (2 bytes)` in a root of kind `machine` |
| **4 · the result returns** | the page gets the whole story in one response | `{transcript, action, result}` — `result.ok`, `result.action`, `result.root`, `result.logged` | → `ok: true`, `logged: 2` |
| **5 · the act is recorded** | one entry per act — allowed **or refused** — appended to the root's own log and readable back | `<root>/.audit/<writer>.jsonl` (`core/shared-log.ts`), `GET /api/audit` | → entry seq 1: kind `write`, decision `attempt`, rule `attempted` |

**Where it fails, by name** (driven): the same turn **before any root is declared** → `refused: root-not-declared`, `logged: null` (no root, so nowhere to hold a log — the response says so rather than omitting the field); `"read .."` → `refused: outside-root`, and the refusal is itself logged as entry seq 3. Declaring the root answered `ok: true`, `reachableFromThisProcess: true`, and the turn that was refused a moment earlier then succeeded.

**The same loop, making a tool and then calling it** (driven, in this order):
1. `"create a tool called peek that lists files"` → verb `make-tool` → `proposed tool 'peek-tool'`, state `pending` — a **file** under the extension workspace's `proposals/`, not loaded.
2. `GET /api/extensions/proposals/peek-tool/plan` → the gate would say `admitted`; enforced: read via `host-primitive-scope`.
3. `POST /api/extensions/admit {id, confirm: true, decision: "admit"}` **with the host token** (the 0600 file in the host's extension directory) → `admitted`. Without the token → HTTP 403 `host-token-required`.
4. `"run the tool peek"` → verb `tool` → `callTool("peek")` in `lib/extensions.mjs` → `ok: true`, files `["audit.jsonl","probe.json"]`.
5. `GET /api/extensions` now lists `peek-tool`: declared `read`, enforced `{"read":"host-primitive-scope"}`, tools `peek`.

**Two roots, not one — a fact the drive exposes rather than a claim.** The turn wrote `hello.txt` into the declared root, but the admitted tool listed `["audit.jsonl","probe.json"]`: it sees the **extension workspace** (`VOICEBOX_WORKSPACE`), not the root declared over `/api/root`. Its act was recorded in that workspace's `audit.jsonl` (2 entries) and **not** in the root's `.audit/` log (still 3 entries). The design says one root; the wiring today is two. When they become one, this paragraph flips and the check goes red.
<!-- END GENERATED: loop -->

## The tool path — which words reach a tool

<!-- BEGIN GENERATED: tool-path -->
**Three ways words reach this server. Two of them reach a tool.**

| path | wired today | what carries the words | what runs |
|---|---|---|---|
| typed in the composer | yes | `public/fused.js` → `POST /api/turn` | `resolveTurn()` (`lib/resolver.mjs`, provider `script`) → `execute()` (`server.mjs`) → for tools, `callTool()` (`lib/extensions.mjs`) |
| dictated (browser `SpeechRecognition`, no key) | yes — the same route | `public/fused.js` → `POST /api/turn` | the same |
| spoken to the live model | audio yes; tools **yes** | `public/live-voice.js` → `/live` → `lib/live-session.mjs` → the provider | the `/live` handler now calls the executor — update this row's prose |

What each live handshake declares, captured from the provider itself: `gemini` → tools: **none**; `openai` → tools: **none**. When a provider starts declaring tools this line changes and the check goes red — that is the moment the row above stops being true.

Verbs the `script` resolver produces, driven: `"create a file called hello.txt with hi"` → `write`, `"read hello.txt"` → `read`, `"list files"` → `list`, `"create a tool called clock that tells the time"` → `make-tool`, `"run the tool clock"` → `tool`. `make-tool` **proposes** (a pending file the host must admit); `tool` calls an **admitted** tool and nothing else.
<!-- END GENERATED: tool-path -->

## The tool surface — what exists, what it refuses, how to list it

<!-- BEGIN GENERATED: tools -->
**The default tools are a closed set of 5 primitives** (`PRIMITIVES` in `core/extensions.ts`). A model authors a descriptor that *parameterises* one; it never authors a body, so nothing in the runtime evaluates model-written code.

| primitive | consumes | what the host hands the tool |
|---|---|---|
| `now` | — | nothing — it answers with the clock |
| `read-file` | read | a root-scoped read function: paths resolve inside the project root or refuse |
| `write-file` | write | a root-scoped write function: paths resolve inside the project root, writes are reported and revertible |
| `list-files` | read | a root-scoped read function: paths resolve inside the project root or refuse |
| `http-get` | network | a mediated fetch: hosts outside bounds.hosts are refused by name — INCLUDING across redirects, every hop charged to bounds.maxRequests — and the audit records the URL that actually served the bytes |

**What no tool can have on the `machine` placement**, asked of the gate itself:
* exec — absent: no mechanism on this placement bounds a spawned child: --allow-run bounds which binary, never what it can do, and a child does not inherit the parent's flags. Admission requires a container that bounds the child.
* eval — absent: eval is not a tool path (design §1.7): the evaluator bypasses whatever the substrate would otherwise enforce.
* import — absent: no import boundary on this placement: dynamic import executes fetched code with no flags by default.

**The catalogue** — `catalogue/*.json`, 4 tracked descriptors (strangers' extensions you can sideload). **None is loaded until the host admits it**; the last column is what `admit()` says today:

| id | tools | declares | bounds | the gate's verdict |
|---|---|---|---|---|
| `mcp-server-local` | `mcp_list_tools` → `process` | exec | command: npx -y @modelcontextprotocol/server-filesystem /tmp | **refused** `exec-absent` |
| `mcp-server-remote` | `mcp_remote_list_tools` → `http-get` | network | hosts: mcp.example.com; maxRequests: 20 | admitted — network via `mediated-fetch` |
| `notes` | `read_notes` → `read-file` | read | — | admitted — read via `host-primitive-scope` |
| `web-search` | `web_search` → `http-get` | network | hosts: api.duckduckgo.com; maxRequests: 5 | admitted — network via `mediated-fetch` |

**What it refuses, by name** — literal refusal declarations collected from these sources:
* the gate (`core/extensions.ts`): `absent-capability`, `bad-tool-name`, `capability-unmediated`, `duplicate-tool`, `eval-not-a-tool-path`, `exec-absent`, `network-unbounded`, `no-tools`, `under-declared`, `unknown-capability`, `unknown-primitive`
* the routes and the root seam (`server.mjs`, `core/root.ts`): `approval-invalid-id`, `approval-json-required`, `audit-unreadable`, `bad-answer`, `bad-request`, `dotfile-refused`, `environment-not-paired`, `exec-threw`, `host-token-required`, `missing-content`, `not-a-directory`, `not-found`, `outside-root`, `path-missing`, `probe-failed`, `protected-audit`, `provider-not-configured`, `server-error`, `unauthenticated-call`, `unknown-command`, `unknown-environment`, `unknown-root-kind`, `unreadable`, `write-error`
* admitted tools at run time (`lib/extensions.mjs`): `admission-refused`, `approval-audit-unwritable`, `approval-no-proposal`, `approval-plan-changed`, `approval-unavailable`, `bad-redirect`, `bad-url`, `budget-exhausted`, `fetch-failed`, `host-not-allowed`, `not-admitted`, `outside-root`, `over-budget`, `protected-audit`, `redirect-host-not-allowed`, `redirect-without-location`, `too-many-redirects`, `unknown-primitive`, `unknown-tool`
* task admission/readback (`core/tasks.ts`, `lib/tasks.mjs`): `agent-required`, `executor-unavailable`, `invalid-task`, `invalid-task-address`, `invalid-task-context`, `task-audit-unavailable`, `task-authority-field`, `task-call-id-conflict`, `task-call-id-required`, `task-capacity-exhausted`, `task-context-unavailable`, `task-deadline`, `task-environment-changed`, `task-environment-unverified`, `task-input-over-budget`, `task-invalid-result`, `task-not-found`, `task-output-over-budget`, `task-owner-mismatch`, `task-owner-unconfirmed`, `task-owner-unverified`, `task-persistence-failed`, `task-root-replaced`, `task-root-unavailable`, `unbounded-executor`, `unknown-tool`

**Listable at run time** — `GET /api/extensions` answers `{ placement, extensions, proposals, present, catalogueCount }` (probed: placement `machine`, catalogueCount 4); `GET /api/extensions/catalogue` previews the gate's verdict on every stranger before anything is staged; `GET /api/extensions/{proposals|catalogue}/<id>/plan` is the disclosure — source, declared, enforced-by-which-mechanism, what it gets, what it cannot have — before any decision.

**What the process itself can reach** — `GET /api/probe` runs `tools/sandbox-probe.mjs` on this environment and answers an **observed** report (probed: HTTP 200, sections `identity`, `sandboxHints`, `filesystem`, `limits`, `tools`, `network`), cached with its `when` and recorded as an activity in the environment's own audit. It reports files, network and limits as facts with the method beside them — a different question from "which tools are admitted", answered by a different instrument.

**Admission is the host's act**, probed from where the page stands: `POST /api/extensions/admit` with no token → HTTP 403, `host-token-required`.
<!-- END GENERATED: tools -->

## Configuration — every variable the process reads

<!-- BEGIN GENERATED: config -->
Every environment variable the server and its libraries read, and where:

| variable | read in | what it does |
|---|---|---|
| `GEMINI_API_KEY` | `lib/live-providers/gemini.mjs` | the Gemini Live key — without it the live session refuses to start, by name |
| `LIVE_PROVIDER` | `lib/live-session.mjs` | which live voice provider `/live` uses (default `gemini`) |
| `OPENAI_API_KEY` | `lib/live-providers/openai.mjs` | the OpenAI Realtime key — without it that provider refuses to start, by name |
| `PORT` | `server.mjs` | the port the server binds (default 8787) |
| `VOICEBOX_BIND_DEADLINE_MS` | `server.mjs` | how long to keep retrying before giving up by name |
| `VOICEBOX_BIND_RETRY_MS` | `server.mjs` | how often to retry a bind that lost the port race |
| `VOICEBOX_EXTENSIONS_DIR` | `lib/extensions.mjs`, `server.mjs` | the host's extension directory: admitted descriptors, `.host-token` (0600), `.ledger.jsonl`, and `.pairings.json` (the bearer custody store — outside every root) |
| `VOICEBOX_INSTANCE` | `server.mjs` | this writer's name in the active root's shared log (default `machine`) |
| `VOICEBOX_PROVIDER` | `server.mjs` | which TURN resolver answers `POST /api/turn` (default `script`) |
| `VOICEBOX_SANDBOX_HOMES` | `lib/fence-provider.mjs` | where a fence's writable home is bound from (default `~/sandbox-homes/<key>`) — the one place a fenced environment may write |
| `VOICEBOX_WORKSPACE` | `lib/extensions.mjs`, `server.mjs` | declares a machine root at boot — a decision, not a default — and is where the extension system keeps `proposals/` and `audit.jsonl` |
<!-- END GENERATED: config -->

## The routes, as they answer

<!-- BEGIN GENERATED: routes -->
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

<!-- BEGIN GENERATED: page -->
The page loads `fused.js` and `pip-mic.mjs` and `live-voice.js` from `public/`.
Audio worklets loaded by that code: `pcm-worklet.js`.

`verify.mjs` sits in `public/` but is **not** loaded by `index.html`; it is a support script, not part of the page's load set.
<!-- END GENERATED: page -->

## The audio path, tonight

<!-- BEGIN GENERATED: live-session -->
`lib/live-session.mjs` is present. Registered live providers, with the model each one's handshake names (captured from the provider against a recording transport — never dialed): `gemini` → `models/gemini-3.8-live`, `openai` → `gpt-realtime`. The default is `gemini`; `LIVE_PROVIDER` overrides it.
<!-- END GENERATED: live-session -->

## Where each file's authority lies

- **`server.mjs`** is authoritative for the routes and for what an action *does* (it executes verbs, it does
  not interpret them). It binds `127.0.0.1` only.
- **`lib/resolver.mjs`** is authoritative for the provider list, and for what a transcript means. Its
  contract is one function; a new brain is a `registerResolver` call.
- **`core/`** is authoritative for the tier table, containment and the audit — and it is a **library**: it
  imports nothing outside `core/`, because two copies of it would drift silently (see the design's N18).
- **`public/fused.js`** is authoritative for what the page shows, and it **labels its own simulations on the
  page**: files, the turn submission and the containment refusals are real; the shared view, seen-marks and
  admission are simulated and say so. A reader should trust that label over any prose, including this file.
