# Voicebox

**A voice-first web front end to a build environment.** You talk to it; it makes things.

**Start with [docs/README.md](docs/README.md)** — the map: what to read first, which document is
authority for what, and what you can safely ignore. Then [docs/00-brief.md](docs/00-brief.md), which
is Paul's own words.

> Working name. Rename is cheap — see [docs/00-brief.md](docs/00-brief.md).

## The idea

An agent you speak to, in a browser, that can create anything you ask for — because it
has a real build environment behind it and a tool surface you can extend. Not a chat box
with a voice bolted on: the voice *is* the interface, and the thing on the other end can
act on your machine.

## Principles

1. **Voice-first.** The interface is conversation, and it stays available — you can keep
   talking to it while working on something else.
2. **A web front end to a real environment.** Not a sandbox demo: it drives a build
   system that can produce software.
3. **Extensible models.** Gemini Live first, OpenAI Realtime alongside — swap the live
   model without rewriting the harness.
4. **Extensible platform.** Give it new tools and skills when you need them; extensions
   can add tools into the agent loop.
5. **Light, not a framework.** Inspired by minimal single-harness designs rather than by
   heavyweight agent frameworks.
6. **Local project files.** A project on disk is the unit of work.

## Lineage

Built from parts of projects that already work — see [docs/00-brief.md](docs/00-brief.md)
for what is borrowed from where, and [docs/01-questions.md](docs/01-questions.md) for what
is still undecided.

## Status

Seeded 2026-09-19 from a spoken brief. Design in progress — and **the descriptions below are a
snapshot**: what this tree does tonight, placeholders included.

**Which documents are which**, because a reader needs to know whether they are holding a spec or a
snapshot:

| document | kind | authority for |
|---|---|---|
| [`docs/00-brief.md`](docs/00-brief.md) | **spec** (Paul's words) | what this is meant to be |
| [`docs/02-environment.md`](docs/02-environment.md), [`docs/05-harvest.md`](docs/05-harvest.md) | **design records** | systems that may not exist yet — allowed to describe the future |
| [`docs/07-architecture.md`](docs/07-architecture.md), [`docs/08-how-it-runs.md`](docs/08-how-it-runs.md), this README | **snapshots** | what runs *now*; a claim here that the code contradicts is a bug in the document |

The blocks marked `BEGIN GENERATED` are written by `scripts/docs-check.mjs` from the code itself, and
`tests/docs-drift.test.mjs` fails when they drift.

Task admission's API, evidence boundaries and unfinished execution work are documented in
[D1: authenticated task admission and durable handles](docs/10-delegate-task-d1.md).
[ACP adapter diagnostics](docs/11-acp-adapter.md) now verify one real pi-acp/pi version pair
without credentials. Actual delegated model tasks still refuse pending bounded provider access;
this is not browser-only delegation acceptance.

## Before pushing

The pre-push hook keeps the full test suite: 180 seconds for `npm test`, then
45 seconds for `npm run accept`. Refusals name the stage and distinguish a
timeout from a failing command; both output streams remain visible. See
[gate measurements and regression drives](docs/12-pre-push-gate.md).
Acceptance checks read idempotence on its private instance: three GETs per root/file
route must return the seeded state and leave its file bytes and write metadata unchanged.
It does not assert that another lane's shared server stays unchanged.
The live-tools write check waits for both the file and its successful `write_file`
websocket event within the same 60-second budget; file creation alone does not
prove that the page has received the report.

## The two paths, stated separately

The largest gap in this product was invisible because one word — *live* — covered two different things:
the **audio** path and the **turn** path. They are not the same, so they are not written as one:

<!-- BEGIN GENERATED: providers -->
Registered resolvers: `gemini`, `script`

* `registerResolver(name, fn)` is the seam; `resolveTurn(transcript, provider = "script")` picks one.
* The **script** provider handles `write`, `read` and `list`: `"create a file called hello.txt with hi"` → `{"verb":"write","name":"hello.txt","content":"hi"}`.
* Anything else is **unresolved**, by design: `"book me a flight to Lisbon"` → `"the script resolver only knows create/read…"`.
* The live voice providers (`gemini`, `openai`) live behind a **different** seam, `registerLiveProvider` in `lib/live-session.mjs`; none of them is a turn resolver — see the tool path below.
<!-- END GENERATED: providers -->

<!-- BEGIN GENERATED: live-session -->
`lib/live-session.mjs` is present. Registered live providers, with the model each one's handshake names (captured from the provider against a recording transport — never dialed): `gemini` → `models/gemini-3.8-live`, `openai` → `gpt-realtime`. The library fallback is `gemini`, overridable by `VOICEBOX_LIVE_PROVIDER`; the server's `/live` route instead passes the agent-settings provider explicitly.
<!-- END GENERATED: live-session -->

## Tool calling: how words become an act, and what tools exist

OpenAI Realtime carries the same command declarations and instruction as Gemini.
Its function calls run through the shared executor and return correlated results or
named refusals; after generation and all tool results finish, it requests the spoken
continuation. Synthetic browser/vendor verification and its withheld-handler negative
control are recorded in [the live fixes report](docs/live-fixes.md).

Everything in this section is one of three things, and says which: **exists-and-driven** (the
generated blocks — produced by `scripts/docs-check.mjs` from the code and a real server, and red in
`npm test` when they drift), **designed-not-built** (marked), or **neither**. A hand-written tool
list is a lie with a delay on it; these blocks are regenerated with `npm run docs:write`.

### The agent loop (exists-and-driven)

What runs when you speak or type: **a turn starts → something decides → something acts → the
result returns → the act is recorded.** The table is regenerated by driving one real turn, so the
values in it are what the server answered, and a step that stops being wired goes red rather than
stale.

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
4. `"run the tool peek"` → verb `tool` → `callTool("peek")` in `lib/extensions.mjs` → `ok: true`, files `["hello.txt"]`.
5. `GET /api/extensions` now lists `peek-tool`: declared `read`, enforced `{"read":"host-primitive-scope"}`, tools `peek`.

**One root**: the admitted tool listed `["hello.txt"]` — the same root the turn wrote `hello.txt` into.
<!-- END GENERATED: loop -->

### How tool calling works (exists-and-driven)

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

So, precisely: **the live voice model cannot call a tool today.** Its words reach the page and stop
there. Wiring the voice path to the executor the loop calls is another lane's work, in flight —
*designed-not-built*. Until the table above says otherwise, "the voice agent can do X" is false for
every X.

### What exists by default, and what it refuses (exists-and-driven)

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
* admitted tools at run time (`lib/extensions.mjs`): `admission-refused`, `approval-audit-unwritable`, `approval-no-proposal`, `approval-plan-changed`, `approval-unavailable`, `bad-redirect`, `bad-url`, `budget-exhausted`, `fetch-failed`, `host-not-allowed`, `not-admitted`, `outside-root`, `over-budget`, `protected-audit`, `redirect-host-not-allowed`, `redirect-without-location`, `root-not-declared`, `root-not-reachable-from-here`, `too-many-redirects`, `unknown-primitive`, `unknown-tool`
* task admission/readback (`core/tasks.ts`, `lib/tasks.mjs`): `agent-required`, `executor-unavailable`, `invalid-task`, `invalid-task-address`, `invalid-task-context`, `task-audit-unavailable`, `task-authority-field`, `task-call-id-conflict`, `task-call-id-required`, `task-capacity-exhausted`, `task-context-unavailable`, `task-deadline`, `task-environment-changed`, `task-environment-unverified`, `task-input-over-budget`, `task-invalid-result`, `task-not-found`, `task-output-over-budget`, `task-owner-mismatch`, `task-owner-unconfirmed`, `task-owner-unverified`, `task-persistence-failed`, `task-root-replaced`, `task-root-unavailable`, `unbounded-executor`, `unknown-tool`

**Listable at run time** — `GET /api/extensions` answers `{ placement, extensions, proposals, present, catalogueCount }` (probed: placement `machine`, catalogueCount 4); `GET /api/extensions/catalogue` previews the gate's verdict on every stranger before anything is staged; `GET /api/extensions/{proposals|catalogue}/<id>/plan` is the disclosure — source, declared, enforced-by-which-mechanism, what it gets, what it cannot have — before any decision.

**What the process itself can reach** — `GET /api/probe` runs `tools/sandbox-probe.mjs` on this environment and answers an **observed** report (probed: HTTP 200, sections `identity`, `sandboxHints`, `filesystem`, `limits`, `tools`, `network`), cached with its `when` and recorded as an activity in the environment's own audit. It reports files, network and limits as facts with the method beside them — a different question from "which tools are admitted", answered by a different instrument.

**Admission is the host's act**, probed from where the page stands: `POST /api/extensions/admit` with no token → HTTP 403, `host-token-required`.
<!-- END GENERATED: tools -->

### How to add one (exists-and-driven, with one designed-not-built step)

A tool is a **descriptor** — data, never code — carrying `id`, `name`, `capabilities`, `bounds` and a
`tools` array whose entries each name one primitive from the table above (shape:
`ExtensionDescriptor` in `core/extensions.ts`). Two doors, one gate:

1. **Propose.** The model says *"create a tool called clock that tells the time"* (the `make-tool`
   verb), or anything POSTs a descriptor to `/api/extensions/proposals`, or you sideload a catalogue
   entry with `POST /api/extensions/sideload {id, confirm: true}`. All three land as a **pending**
   file in `proposals/` under the workspace. Nothing loads.
2. **Read the plan.** `GET /api/extensions/proposals/<id>/plan` — what it declares, what would be
   enforced and by which mechanism, what it would be handed, what it cannot have.
3. **Approve with a one-time host code.** In **Extensions → Waiting for review** (or **Found here**),
   open **Review and approve on the host**, then **Request approval code**. Review the exact plan
   in the server terminal and enter its eight-digit code in the page. It expires after two minutes,
   works once, and cannot approve a changed plan. The human decision is recorded before admission;
   the page never receives the host token. Keep server output private: anyone reading it can use
   an unexpired code. Restarting the server invalidates outstanding codes.
   The existing shell alternative remains: `POST /api/extensions/admit {id, confirm: true, decision: "admit"}`
   with the `x-voicebox-host-token` header, whose value is the file `.host-token` (mode 0600) in the
   extension directory. The page cannot read that file; your shell can. Admission re-runs the same
   `admit()` the plan showed, moves the descriptor into the host directory, records it in
   `.ledger.jsonl`, and rebuilds the registry. A file dropped into the directory by hand is
   *present, not admitted* — visible in the inventory, never live.
4. **Call it.** *"run the tool clock"* → the `tool` verb → `callTool()`. Only admitted tools answer.

Where an extension **may** act today is *driven* in the loop block above — through the root-scoped
primitives in **the extension workspace** (`VOICEBOX_WORKSPACE`), which the drive shows is not yet
the root declared over `/api/root`; and on the network only at the hosts in `bounds.hosts`, at most
`bounds.maxRequests` times, redirects included. Where it **may not**: spawn a process, evaluate code,
import code, leave that root — each refused by name, never silently; the generated list above is
the authority for which names exist.

*Designed-not-built:* a tool that runs **in the page** rather than on this server
(`docs/02-environment.md` §1.7's browser placement — the `handle-scope` / `csp-connect-src`
mechanisms in `MECHANISMS.browser`). The gate can already decide for that placement; no page-side
executor exists yet.

### How to see what is available at run time (exists-and-driven)

Ask the server, not the source. The two questions have two instruments, both probed in the
generated block above: **which tools are admitted** (`GET /api/extensions`, plus the catalogue
preview and the per-proposal plan) and **what the process itself can reach** (`GET /api/probe`,
which runs the sandbox probe on the environment and reports observed facts). The primitives
themselves are the exported `PRIMITIVES` — there is no route for them because they are not a
runtime fact, they are the code.

### How it is configured (exists-and-driven)

<!-- BEGIN GENERATED: config -->
Every environment variable the server and its libraries read, and where:

| variable | read in | what it does |
|---|---|---|
| `GEMINI_API_KEY` | `lib/live-providers/gemini.mjs` | the Gemini Live key — without it the live session refuses to start, by name |
| `LIVE_PROVIDER` | `lib/live-session.mjs` | the OLD NAME of `VOICEBOX_LIVE_PROVIDER`, honoured for one release |
| `OPENAI_API_KEY` | `lib/live-providers/openai.mjs` | the OpenAI Realtime key — without it that provider refuses to start, by name |
| `PORT` | `server.mjs` | the port the server binds (default 8787) |
| `VOICEBOX_BIND_DEADLINE_MS` | `server.mjs` | how long to keep retrying before giving up by name |
| `VOICEBOX_BIND_RETRY_MS` | `server.mjs` | how often to retry a bind that lost the port race |
| `VOICEBOX_EXTENSIONS_DIR` | `lib/extensions.mjs`, `server.mjs` | the host's extension directory: admitted descriptors, `.host-token` (0600), `.ledger.jsonl`, and `.pairings.json` (the bearer custody store — outside every root) |
| `VOICEBOX_HELLO_BOUND_MS` | `server.mjs` | how long to wait for a hello frame on /channel or /live before refusing (default 5000ms) |
| `VOICEBOX_INSTANCE` | `server.mjs` | this writer's name in the active root's shared log (default `machine`) |
| `VOICEBOX_LIVE_PROVIDER` | `lib/live-session.mjs` | the live transport's fallback when the session passes no provider; `/live` passes the agent-settings provider explicitly — **not** the turn resolver |
| `VOICEBOX_PROVIDER` | `server.mjs` | the OLD NAME of `VOICEBOX_RESOLVER`, honoured for one release: a shell that exports it keeps working and gets a line on stderr |
| `VOICEBOX_RESOLVER` | `server.mjs` | which TURN resolver answers `POST /api/turn` (default `script`) — **not** the live provider, which is a different concept |
| `VOICEBOX_SANDBOX_HOMES` | `lib/fence-provider.mjs` | where a fence's writable home is bound from (default `~/sandbox-homes/<key>`) — the one place a fenced environment may write |
| `VOICEBOX_WORKSPACE` | `lib/extensions.mjs`, `server.mjs` | declares a machine root at boot — a decision, not a default — and is where the extension system keeps `proposals/` and `audit.jsonl` |
<!-- END GENERATED: config -->

There is no config file. What is on or off is decided by which provider is named, which key is
present, and which descriptors the host has admitted — the ledger is the switch.

## The agent loop

Separate from both of those paths, and the thing that actually runs when a turn arrives: the loop from
**speech or typing → a decision → an execution → a result → a record**. It is not the live connection, and the
live connection cannot do it: the loop is entered on **`POST /api/turn`**, and everything below is what happens
after that.

- **What decides** is a **resolver seam** — a provider registered by name that turns a transcript into an
  **action**, or into an explicit *unresolved* sentence. The server never parses language itself; that is what
  the seam is for. Today exactly **one** resolver is registered (a script provider with a few verbs), and a
  model-backed one is *planned and not registered*.
- **Who executes** is **the executor the server calls** — the one place that touches the build environment. It
  resolves every path *inside the active root* before touching it, records a tool *proposal* without loading
  it, and invokes tools through the runtime's admission, bounds and budget.
- **Where the result goes** is back on the turn response, and into the active root for the verbs that write. A
  tool that declines answers **refused with a reason** — a result, not an exception.
- **What gets recorded** is the **audit in the active root**, refusals included, numbered by sequence so a
  resumed process continues rather than restarts.
- **Where it fails** is named: no root declared, the root vanishing, a path outside the root, nothing to do,
  a tool declining, and a proposal that is recorded but **not loaded**. Each has its own sentence, because a
  refusal that names the wrong cause is worse than no refusal.

**The full section — including what is wired today and how to check each claim in a minute — is
[`docs/09-agent-loop.md`](docs/09-agent-loop.md).** That page is the one to read before changing the resolver,
the executor or the audit, and it is written to be checked against the running server rather than believed.

## Running (the skeleton loop)

```sh
node server.mjs            # serves the page on http://127.0.0.1:8787
```

Open the page in Chrome, press the mic, and speak — e.g. *"create a file called
hello.txt with hello world"*, *"read hello.txt"*, *"list files"*. A text field
does the same without a mic. Every turn is captured, resolved to an action, and
the result is written into **the active project root** — a real directory on
disk, declared by the page (`POST /api/root`) rather than assumed.

`VOICEBOX_WORKSPACE=/some/folder node server.mjs` declares one at boot, which is
how you run the loop against a folder without opening the page. With no
declaration the loop refuses every act by name — `root-not-declared` — because a
default is a decision nobody made, and `workspace/` was exactly that. <!-- docs-check: names the mechanism -->

What works today:

- **Speech capture** — a live `AudioContext` at 16 kHz (the browser resamples
  natively; nothing hand-rolled) streamed as PCM16 over `/live` to
  **models/gemini-3.8-live** via the Gemini Live API, **with thinking**. The
  model's 24 kHz audio streams back and plays. Browser `SpeechRecognition`
  dictation remains only as a no-key fallback for one-shot turns — it is not
  the product path.
- **Turn resolution** — a deterministic script resolver (`lib/resolver.mjs`)
  that knows create/read/list. It is a placeholder brain, deliberately: the
  resolver is a provider seam (`registerResolver(name, fn)`), and the model
  resolvers plug into exactly that contract.
- **The action executor** — writes/reads/lists files in **the active project root** on disk, which the
  environment page declares (or `VOICEBOX_WORKSPACE` at boot). It used to say `workspace/`, <!-- docs-check: names the mechanism --> which
  stopped being true the moment the default root was retired: the loop has no root of its own, and a
  sentence naming one was the last piece of the second root left standing in the docs.

What does not work yet:

- **No model resolves a turn.** The live model *talks* (over `/live`), but the
  thing that turns words into an action is still the scripted resolver, and
  the live model's words never reach it — see *Tool calling* above. The seam is
  `lib/resolver.mjs`: wire a resolver that calls a model and returns the same
  `{ verb, name, content }` shape and the rest of the loop is unchanged.
- **No always-on conversation.** While a live session is open the mic streams
  continuously, the model replies, and you can interrupt it — that part landed.
  What is missing is the version with **no press at all** (a wake word or a
  standing session), which is what the brief's "always-on" means.
- **The loop has no root of its own.** It writes into the active project root, which the
  environment declares — OPFS, a folder you picked, or a folder on this machine — and it
  refuses by name when the root belongs to another placement (see the environment page
  below, and `docs/evidence/one-root-20260920/RECEIPT.md`). There is no `workspace/` <!-- docs-check: names the mechanism -->
  default any more: what used to be two roots is one.

## The browser environment (projects that live in this browser)

```sh
node server.mjs            # then open http://127.0.0.1:8787/environment.html
```

A page with a **working environment** behind it rather than a chat box: an environment
page at `/environment.html` where a project is a real root — either this origin's private
OPFS storage, or **a folder you pick or drop** — held by a persisted directory handle, with
an append-only audit beside the files, a tier table as data, and one tool (`create an asset`)
running as a **Wasm module whose only two imports are the ones the host hands it**, which is
what makes "it cannot reach the network" structural instead of promised.

- The page always says **which kind of root** it is showing, whether it is held
  persistently, which undo it has, and where its audit lives.
- An **explorer over three roots** — origin storage, the picked folder, the server's
  `workspace/` — each labelled <!-- docs-check: names the mechanism --> with its own authority, each a single bounded listing.
- Failures have names: `needs-gesture`, `permission-denied`, `handle-gone`,
  `root-unreachable`, `not-found`, `not-a-project`.

Checks: `npm run test:e1m0` <!-- docs-check: names the mechanism --> (25 acceptance checks, driven in a real headless Chromium).
Evidence, including what the platform actually does with a dropped folder and the two
behaviours that cannot be driven headlessly: [docs/evidence/picked-root-20260919/RECEIPT.md](docs/evidence/picked-root-20260919/RECEIPT.md).

Next step: wire the first live model resolver behind the seam (Gemini Live),
then grow the action set toward the build environment.
