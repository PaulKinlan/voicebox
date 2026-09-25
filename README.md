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

## Installed harnesses

Open **Harnesses** from the voice page (which opens the modal dialog without navigating away) and click **Check installed harnesses**, or run
`node tools/list-harnesses.mjs`. This lists known host CLIs with descriptions, observed
versions and present/unrunnable/unknown/absent states. Set `VOICEBOX_HARNESS_TOOLS` to
an absolute JSON file path to add host-declared tool names and descriptions, with their
source and scope. Expand **Declared tools** on a row to read them. Missing or invalid
metadata says **Tools — unknown**; an explicitly empty declaration is shown separately.
These are declarations, not observed session tools or permissions. Listing a tool neither
enables delegation nor checks authentication. Pi's task adapter can be selected with
`VOICEBOX_HARNESS=pi`; other inventoried CLIs have no configured task adapter.
No sandbox wrapping or local browser-to-CLI bridge is added. See
[the catalogue format and limits](docs/12-harness-inventory.md).

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
`tests/docs-drift.test.mjs` fails when they drift. The prose **around** them is watched too:
`scripts/docs-touched.mjs` refuses a push that moves a file a document describes without touching a
document — Paul's rule, *every update updates the docs and the README in the same change*. See
[`docs/08-how-it-runs.md`](docs/08-how-it-runs.md) for the mechanism and its recorded way past.

Task admission's API, evidence boundaries and unfinished execution work are documented in
[D1: authenticated task admission and durable handles](docs/10-delegate-task-d1.md).
[ACP adapter diagnostics](docs/11-acp-adapter.md) now verify one real pi-acp/pi version pair (pi-acp 0.0.34 / pi 0.87.1)
without credentials. Actual delegated model tasks still refuse pending bounded provider access;
this is not browser-only delegation acceptance.

## Before pushing

The pre-push hook keeps the full test suite: 180 seconds for `npm test`, then
45 seconds for `npm run accept`. Refusals name the stage and distinguish a
timeout from a failing command; both output streams remain visible. See
[gate measurements and regression drives](docs/12-pre-push-gate.md).
Acceptance checks read idempotence on its private instance: three GETs per root/file
route must return the seeded state and leave its file bytes and write metadata unchanged.

## The top bar

The header carries the surface controls as icon buttons — Harnesses, Change
log, Environments, Extensions and Settings — each with `aria-label` and
tooltip. The icons come from the page's own SVG symbol set (`#i-list`,
`#i-book`, `#i-layers`, `#i-box`, `#i-gear`); adding a control means adding
its symbol and its `aria-label`, nothing else. The live count lines
(`#envs-count`, `#exts-count`) are screen-reader text, so runtime updates
still reach assistive tech without cluttering the bar.

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

## Debugging a transcript or tool call

Open the main app with **`?debug=1`** (for example `http://localhost:5173/?debug=1`),
then reproduce the problem. A **Debug transcript** panel below the conversation records
this tab from page load, including every emitted text fragment and typed turn, not just
the eight recent turns. Use **Next error** to open and focus a failure, then **Copy all
events (redacted JSONL)** to paste the entire timeline into an agent chat. Each line is
one event with a timestamp, sequence and elapsed time. Copy does not depend on which
rows are expanded. If clipboard permission fails, a selected, redacted text box is the
manual fallback.

The panel stays in the main app so it observes the actual conversation, not a second
page's session. It is hidden and does not collect events without `?debug=1`. Capture is
memory-only: **copy before reloading or closing the tab**. Previous visits, other tabs,
audio recordings and server console history are not included. Debug does **not** enable
input transcription or change provider configuration: spoken words are absent unless
the provider already emits their transcription. The export carries that disclosure too.

For live tools, follow the same `callId` through `tool.wire-request` (original provider
arguments), `tool.request` (normalized arguments), `tool.route` (shared executor or
pre-execution refusal), `tool.result` (complete result/error and execution duration),
and `tool.delivery`. Approval, containment and environment refusals remain in the
executor's result, not a summary substituted for it. Malformed/early calls are marked
refused or dropped. **`transport-accepted` means the local transport accepted a send;
it does not prove provider acknowledgement or model consumption.** `not-sent` is a
known refusal; `unknown` means a send threw. Missing result/delivery events mean pending
or unknown, not success. Session and connection identifiers distinguish reconnects.
Typed turns carry their full HTTP response and displayed outcome; their resolver does
not receive execution results back. Server and page timestamps come from their own
clocks; execution duration is measured on the server. The start/health events identify
the page/server build and provider when available.

Details on screen are **unredacted**. Only the copy/export path strips sensitive field
values (including credentials, cookies and headers), embedded credential assignments,
private keys and long opaque strings. Repeated opaque values get consistent redaction
aliases so call correlation survives. Results are otherwise verbatim, without clipping
or summarizing. Redaction deliberately over-matches some identifiers and paths; it
cannot recognize every short secret hidden in arbitrary prose. **Review before sharing**:
ordinary personal information, file contents and paths may remain. There is no automatic
upload and no extra paid transcription. This feature needs the updated API server as
well as a refreshed page; an older server cannot supply detailed tool-boundary events.

Checks: `node --test tests/debug-transcript.test.mjs tests/live-openai-browser.test.mjs`.
The browser checks drive real missing-file failures through both providers' adapters,
the real server/executor and the native clipboard, using a loopback vendor fixture and
synthetic media/credentials. They do not claim an authenticated model round-trip.

## The two paths, stated separately

The largest gap in this product was invisible because one word — *live* — covered two different things:
the **audio** path and the **turn** path. They are not the same, so they are not written as one:

<!-- BEGIN GENERATED: providers — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
Registered resolvers: `gemini`, `script`

* `registerResolver(name, fn)` is the seam; `resolveTurn(transcript, provider = "script")` picks one.
* The **script** provider handles `write`, `read` and `list`: `"create a file called hello.txt with hi"` → `{"verb":"write","name":"hello.txt","content":"hi"}`.
* The verbs it produces, driven one utterance each: `write`, `read`, `list`, `make-tool`, `tool`. An utterance matching **none** of them is **unresolved**, by design: `"book me a flight to Lisbon"` → `"the script resolver only knows create/read…"`. (This line used to say *"anything else is unresolved"*, which was a TYPED universal beside a derived example — false the moment `make-tool` and `tool` started resolving.)
* The live voice providers (`gemini`, `openai`) live behind a **different** seam, `registerLiveProvider` in `lib/live-session.mjs`; none of them is a turn resolver — see the tool path below.
<!-- END GENERATED: providers -->

<!-- BEGIN GENERATED: live-session — values below are derived and re-checked; the prose around them is written by a person and is only as true as its last reading -->
`lib/live-session.mjs` is present. Registered live providers, with the model each one's handshake names (captured from the provider against a recording transport — never dialed): `gemini` → `models/gemini-3.8-live`, `openai` → `gpt-realtime`. The library fallback is `gemini`, overridable by `VOICEBOX_LIVE_PROVIDER`; the server's `/live` route instead passes the agent-settings provider explicitly.
<!-- END GENERATED: live-session -->
| `AGENT.md` / `AGENTS.md` at the declared root | `lib/project-instruction.mjs` | read once per live session as project context for the system prompt — bounded at 32 KiB; absence is normal, unreadable is named |

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

### How tool calling works (exists-and-driven)

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

**The live voice can discover and use approved extensions.** Ask “list extensions”, then
“use Web Search to search for Saturn”. `list_extensions` reads the current inventory;
`call_extension` invokes its exact tool name with optional `url`, `path`, or `content`.
An extension approved during a conversation is discoverable without reconnecting. Pending,
refused and merely present extensions remain non-runnable; the model cannot approve them.
See [extension discovery and use](docs/07-extension-admission.md#model-discovery-and-use)
for the argument and permission boundaries.

### What exists by default, and what it refuses (exists-and-driven)

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
* admitted tools at run time (`lib/extensions.mjs`): `approval-audit-unwritable`, `approval-no-proposal`, `approval-plan-changed`, `approval-unavailable`, `bad-descriptor`, `bad-redirect`, `bad-tool-name`, `bounds-invalid`, `extension-not-admitted`, `fetch-failed`, `invalid-id`, `missing-description`, `missing-name`, `no-tools`, `outside-root`, `over-budget`, `params-invalid`, `params-unknown-tool`, `protected-audit`, `redirect-host-not-allowed`, `redirect-without-location`, `too-many-redirects`, `unknown-primitive`
* task admission/readback (`core/tasks.ts`, `lib/tasks.mjs`): `agent-environment-mismatch`, `agent-not-configured`, `agent-required`, `executor-unavailable`, `invalid-task`, `invalid-task-address`, `invalid-task-context`, `task-audit-unavailable`, `task-authority-field`, `task-call-id-conflict`, `task-call-id-required`, `task-cancelled`, `task-capacity-exhausted`, `task-context-unavailable`, `task-deadline`, `task-environment-changed`, `task-environment-unverified`, `task-input-over-budget`, `task-invalid-result`, `task-not-found`, `task-not-running`, `task-output-over-budget`, `task-owner-mismatch`, `task-owner-unconfirmed`, `task-owner-unverified`, `task-persistence-failed`, `task-root-replaced`, `task-root-unavailable`, `unbounded-executor`, `unknown-tool`, `unsupported-runtime-capability`

**Listable at run time** — `GET /api/extensions` answers `{ placement, extensions, proposals, present, catalogueCount }` (probed: placement `machine`, catalogueCount 5); `GET /api/extensions/catalogue` previews the gate's verdict on every stranger before anything is staged; `GET /api/extensions/{proposals|catalogue}/<id>/plan` is the disclosure — source, declared, enforced-by-which-mechanism, what it gets, what it cannot have — before any decision.

**What the process itself can reach** — `GET /api/probe` runs `tools/sandbox-probe.mjs` on this environment and answers an **observed** report (probed: HTTP 200, sections `identity`, `sandboxHints`, `filesystem`, `limits`, `tools`, `network`), cached with its `when` and recorded as an activity in the environment's own audit. It reports files, network and limits as facts with the method beside them — a different question from "which tools are admitted", answered by a different instrument.

**Admission is the host's act**, probed from where the page stands: `POST /api/extensions/admit` with no token → HTTP 403, `host-token-required`.
<!-- END GENERATED: tools -->

### How to add one (exists-and-driven, with one designed-not-built step)

A tool is a **descriptor** — data, never code — carrying `id`, `name`, `capabilities`, `bounds` and a
`tools` array whose entries each name one primitive from the table above (shape:
`ExtensionDescriptor` in `core/extensions.ts`). Two doors, one gate:

1. **Propose.** The model says *"create a tool called clock that tells the time"* (the `make-tool`
   verb), or anything POSTs a descriptor to `/api/extensions/proposals`, or you sideload a catalogue
   entry with `POST /api/extensions/sideload {id, confirm: true}`, or you create and locally add a new extension
   via the room UI or `tools/create-extension.mjs` (`POST /api/extensions/local`). All land as a **pending**
   file in `proposals/` under the workspace (or directly admit when run with host authority). Nothing loads without admission.
2. **Read the plan.** `GET /api/extensions/proposals/<id>/plan` — what it declares, what would be
   enforced and by which mechanism, what it would be handed, what it cannot have.
3. **Approve with a one-time host code.** In **Extensions → Waiting for review** (or **Found here**),
   open **Review and approve on the host**, then **Request approval code**. Review the exact plan
   in the server terminal (or run `node tools/approval-code.mjs` on the host) and enter its eight-digit code in the page. It expires after two minutes,
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
5. **Reconfigure or remove it.** Running extensions can be updated (`POST /api/extensions/reconfigure`, `PATCH /api/extensions/:id`) or withdrawn (`DELETE /api/extensions/:id`, `POST /api/extensions/revoke`) via the UI settings-style dialog directly in the room (authorized seamlessly via the in-room session token — which establishes local session context for the developer on this machine, not a remote secret; the boundary is local-vs-remote, and remote callers require the host token `x-voicebox-host-token`), updating bounds, tool parameters (keyed by tool name — `tools[i].params` is what `callHttp` reads) or revoking tools without discovering or supplying hidden `.token` files. Re-admitting a changed descriptor for the same id is an update, not a no-op: the same gate re-runs, the descriptor is replaced, and the registry is rebuilt — so a corrected `params.url` is the URL the next call actually uses.

Where an extension **may** act today is *driven* in the loop block above — through the root-scoped
primitives in **the active project root**, the same root a turn writes into; and on the network only
at the hosts in `bounds.hosts`, at most `bounds.maxRequests` times, redirects included. Where it
**may not**: spawn a process, evaluate code, import code, leave that root — each refused by name,
never silently; the generated list above is the authority for which names exist.

> This paragraph said the opposite until 2026-09-23 — that a tool acted in a separate extension
> workspace rather than the declared root. That was true when written and stopped being true when
> the roots were unified; **the generated block above corrected itself and this sentence did not**,
> because nothing watches prose. It is the limit in [`docs/08-how-it-runs.md`](docs/08-how-it-runs.md)
> demonstrated on this page.

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

There is no config file. What is on or off is decided by which provider is named, which key is
present, and which descriptors the host has admitted — the ledger is the switch.

### Configured agents and harness distinction (exists-and-driven)

The architecture distinguishes the **runtime** (node, deno, browser), the **configured agent** (named instance with permanent ID, model, prompt, reach and bounds), and the **execution environment** (filesystem root, sandboxing, and reach). See `core/harness-config.ts` and `lib/harness-config.mjs`.
- One harness engine (e.g. Pi) can have multiple configured agent instances in the same environment.
- Stable agent IDs are permanent; renaming an agent's display label updates its title without retargeting tasks.
- Stdio CLI adapters are explicitly refused in browser runtimes (`unsupported-runtime-capability`).
- Configured agent records are secret-free; credentials belong to the environment owner, never agent configs.
- Browser-local registries run entirely in-browser with zero server dependency.
- Endpoints: `GET /api/agents`, `POST /api/agents`, `PATCH /api/agents/:id`, and `GET /api/harnesses` (combines host discovery with matching configured agents, feeding D3).

## The agent loop

Separate from both of those paths, and the thing that actually runs when a turn arrives: the loop from
**speech or typing → a decision → an execution → a result → a record**.

The loop operates across two execution paths:
- **Typed turns**: submitted via the composer on **`POST /api/turn`**, which carries `{ transcript }`, asks the registered resolver seam (`lib/resolver.mjs`), and passes the resulting action to the executor.
- **Live turns**: streamed over the **`/live`** WebSocket, where model tool calls (`toolCall`) are mapped via `commandToAction()` directly into the shared executor, returning tool outputs over the wire.

Key invariants:
- **What decides** is a **resolver seam** — a provider registered by name that turns a transcript into an
  **action**, or into an explicit *unresolved* sentence. The server never parses language itself; that is what
  the seam is for. Two resolvers are registered: the deterministic `script` provider (create/read/list/tools)
  and the model-backed `gemini` provider (requires `GEMINI_API_KEY`).
- **Who executes** is **the executor the server calls** — the one place that touches the build environment. It
  resolves every path *inside the active root* before touching it, records a tool *proposal* without loading
  it, and invokes tools through the runtime's admission, bounds and budget.
- **Loading a tool** is an explicit host-authorized admission step (`POST /api/extensions/admit` with the host token, or a single-use console code via `POST /api/extensions/approve` / `node tools/approval-code.mjs`).
- **Where the result goes** is back on the turn response (or live tool response frame), and into the active root for the verbs that write. A
  tool that declines answers **refused with a reason** — a result, not an exception.
- **What gets recorded** is the **audit in the active root**: a write records an attempt entry and a completed outcome entry; pre-flight refusals record a single refusal entry.
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
  that knows create/read/list/tools, plus the registered model-backed resolver (`gemini`).
  The resolver is a provider seam (`registerResolver(name, fn)`).
- **The action executor** — writes/reads/lists files in **the active project root** on disk, which the
  environment page declares (or `VOICEBOX_WORKSPACE` at boot). It used to say `workspace/`, <!-- docs-check: names the mechanism --> which
  stopped being true the moment the default root was retired: the loop has no root of its own, and a
  sentence naming one was the last piece of the second root left standing in the docs.

What does not work yet:

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
- The room's folder handles (`#open-folder`) provide read/write handles persisted across reloads in IndexedDB, supporting several directories at once with a "Restore access" button when permission regresses to prompt.

Checks: `npm run test:e1m0` <!-- docs-check: names the mechanism --> (25 acceptance checks, driven in a real headless Chromium).
Evidence, including what the platform actually does with a dropped folder and the two
behaviours that cannot be driven headlessly: [docs/evidence/picked-root-20260919/RECEIPT.md](docs/evidence/picked-root-20260919/RECEIPT.md).

### Room interface construction

The room frontend (`public/index.html`, `public/fused.js`, `public/style.css`) is built with modern web platform primitives:
- Native `<dialog>` elements with `closedby="any"` light-dismiss and unified geometry-check fallback.
- `container: env-dialog / inline-size;` container queries for dialog-width responsive form layouts.
- Semantic `<search>` landmark element enclosing file filtering.
- The room's file list uses aligned, full-width buttons with separate name/size columns, a bounded scroll area, and a two-column layout only when its own container is wide enough. Folder chips use the same light/dark tokens; root labels, arrival marks and permission controls keep their existing behavior.
- `node --test tests/room-explorer-ui.test.mjs` drives native read/filter/folder controls, keyboard activation, long filenames, empty/no-project states, and light/dark layouts at phone, desktop and narrow-container widths.
- Scroll containment (`overscroll-behavior: contain`) and layout stabilization (`scrollbar-gutter: stable`).
- Keyboard-accessible scrollable code region (`<pre id="file-body" tabindex="0">`).
- IME composition safety on utterance input and turn submissions.
- Change log and commit links: build stamp commit hashes in `#build` link to GitHub commits; `public/changelog.html` and `GET /api/changelog` surface recent commits directly from the room.

Next step: wire the first live model resolver behind the seam (Gemini Live),
then grow the action set toward the build environment.
