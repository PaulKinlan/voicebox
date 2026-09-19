# The environment behind the voice

Design note by **ds-flash-2** (2026-09-19). My lane is the *environment*: the thing the
conversation drives. The **interface** is astra's and the **harness** is k3's; the contracts
in §1.4 and §1.5 are what those two lanes build against, so they are written as schemas
rather than prose.

The brief's two load-bearing lines:

> *"Your box obviously got access to my machine."*
> *"We think about local project files now... this actually might be like the answer to this."*

So: the agent acts on a **real machine**, and **a project on disk is the unit of work**.

---

## 0. The decisions, up front

| Decision | Why | What it costs |
|---|---|---|
| **The host is one long-lived local process** (`voicebox-host`) that owns projects, sessions, confirmations and the audit log — not the page | Paul wants to keep talking while working on something else; a page reload must not kill the work or lose the thread | A process to install and keep running (systemd --user / launchd, the same shape as the ACP bridge service already proven) |
| **Reuse the ACP bridge** rather than invent a second transport | It already does browser↔real-machine, real harness CLI children, session continuity and **a permission round-trip** — the four hard parts | We inherit its constraints (loopback, one child per connection) and must keep its cwd handling declared |
| **Two models, two footprints**: a *voice* model (Gemini Live / OpenAI realtime) and an *execution* harness (pi/ACP) | The brief wants Gemini first *and* provider-extensibility, without an adapter zoo | Two privacy surfaces to disclose, not one (§1.3) |
| **Voice proposes; the host disposes** | Voice is untrusted input — ASR errors, ambient speech, a video playing — so authority cannot come from "he said it" | Every guarded act needs a host-side decision path (§3.3) |
| **A project is a declared directory**, never a discovered one | Yesterday's fleet lesson: anything assumed about the machine's layout is wrong on somebody's machine | The first open of a project is an explicit act |
| **Work happens in the project's own git state; unapproved work is kept recoverable** (a branch or worktree) | A build environment that can act is only safe if its acting is cheap to undo | Slightly more machinery per project; the host owns it |
| **Three tiers, enforced in the host as data**: never / unprompted / confirm | A boundary written as prose is a wish; the same lesson as putting the harness registry in data rather than comments | Tier tables need maintaining and testing (§3.6) |
| **One host role, three placements** (machine, browser/OPFS, remote) — authority always co-located with the files | Paul's requirement: the harness runs on the client *and* the server, with a website and OPFS. Putting authority in the renderer would dilute the boundary to reach the same features | Capability parity is not assumed, so `do` needs a declared capability list per placement, shown in the UI |

---

## 1. The execution model

### 1.1 What runs where

```
┌─ browser ────────────────────────────────────────────────┐
│  voice UI (astra's lane)                                 │
│  mic/speaker · live model session · transcript · renders  │
│  project state, progress, diffs, confirmation questions   │
└───────────────────────┬──────────────────────────────────┘
                        │  ws://127.0.0.1:<port>   (§1.5 schema)
┌───────────────────────▼──────────────────────────────────┐
│  voicebox-host  — ONE long-lived process on this machine  │
│  · project registry      · tier table (data)              │
│  · sessions per project  · confirmation gate              │
│  · audit log (append-only)· process journal (what it ran) │
│  · resolves realpaths, enforces containment, decides tiers │
└───────────────────────┬──────────────────────────────────┘
                        │  ACP over stdio (the existing bridge)  (§1.4)
┌───────────────────────▼──────────────────────────────────┐
│  execution harness (k3's lane) — one adapter, one child   │
│  pi / claude-code / codex … with its own tools            │
│  runs with cwd = the ACTIVE PROJECT (declared, never guessed) │
└───────────────────────┬──────────────────────────────────┘
                        │  real files, real commands
┌───────────────────────▼──────────────────────────────────┐
│  the machine: the project's checkout, its toolchain, its  │
│  dev servers, its git remotes                             │
└──────────────────────────────────────────────────────────┘
```

Three things follow from this picture and are worth saying plainly:

1. **The browser never executes anything.** It is a renderer and a microphone. Every act is
   a message to the host.
2. **The host is the authority** — the only component that knows the execution roots, the
   tier table and the pending confirmations at the moment of acting. Whether it is also the
   *enforcement point* depends on where the tools live, which is a decision rather than a
   property: see §1.1a, because the difference decides whether §3 is a boundary or a report.
3. **The harness is a child process, not a service.** Its authority is exactly the authority
   the host gives it: a working directory, an environment, and the tools that harness ships.

### 1.1a Mediated or compliant: where the tools live

A CLI harness ships its own tools and runs them in its own process. So the host sees an act
**only if the harness asks** — which means a tier table can be enforced two very different ways,
and a design that does not choose is claiming the stronger one by accident.

| | **Mediated (the target)** | **Compliant (the fallback)** |
|---|---|---|
| Where tools come from | the host injects the tool set (MCP/ACP definitions) into the harness, so **every invocation routes through the host** before it runs | the harness ships its own tools and runs them directly |
| What the host enforces | **all** of it: containment, credentials, argv classification, tiers — on every call, because every call is its own | only what it can see: its own commands, path resolution for what it is asked to resolve, and whatever the harness chooses to ask permission for |
| The guarantee | *"it cannot leave the project"* | *"it will not leave the project unless the harness misbehaves"* |
| Cost | the host must describe tools and stay in the loop for each call | none — and no real containment of the harness's own actions |

**The design's position: mediated is the target for the default harness, and compliant mode is
disclosed rather than assumed.** The brief's minimalism makes this feasible — *one* harness
built by us can expose its tools through the host, which is far easier than auditing an adapter
zoo. A harness that cannot be mediated is still usable, but the UI carries the downgrade
explicitly, in the same spirit as the provider badge: **the guarantee is a property of the mode,
and the user is told which one is running.** §3.2 and §3.7 are written in terms of both.

### 1.1b Three placements, one host role

> *"The harness should be on the client and also running on the server... I want to access this
> through a website, I do want to be able to use OPFS... but also we're on the server as well."*
> — Paul, 2026-09-19

A requirement, not a different design, and it is satisfiable by one rule:

> **The host is wherever the files are. The browser is always a client.** Authority — the tier
> table, the confirmations, the audit — is **co-located with the data it governs**, never in the
> renderer.

| Placement | Where the files are | Where the host runs | Root | What `do` can mean |
|---|---|---|---|---|
| **machine** (M0) | a checkout on a real machine | a local process on that machine | a realpath (or its worktree) | whatever the project's toolchain can: spawn processes, run tests, git |
| **browser** (M2) | **OPFS** in the page's origin | a dedicated **worker** in that page — same tier table, same audit code | an OPFS directory handle | what a browser can do: wasm tools, file reads and writes, no processes |
| **remote** (M3) | a checkout on a machine that is *not* where the browser is | a process on **that** machine | a realpath on that machine | as machine, minus nothing — this is today's Telegram-to-agent shape |

Three consequences worth stating plainly:

1. **"Client and server" are two placements of the host, not two halves of every session.** In
   the remote case the browser is far away and the host holds the files; in the browser case
   there is no server at all. Neither changes who decides.
2. **Capability parity is not assumed.** `ask` and `stop` mean the same thing everywhere; `do`
   means whatever the placement declares, and the declaration travels with the project
   (`capabilities` in §2.1) and is shown in the UI. A browser cannot run `npm test`, and a design
   that pretended otherwise would discover that mid-sentence. Isocan is the precedent Paul points
   at: the *shape* generalises (thin client, real work behind an interface), the *tool parity*
   does not.
3. **The remote placement changes transport, not authority.** Loopback plus a token is right when
   client and files share a machine; a browser on a phone talking to a server needs an
   authenticated remote channel (TLS, a paired credential, an explicit pairing flow) — and the
   tier table, the confirmations and the audit stay **on the machine that holds the files**,
   because that is where they mean anything.

### 1.2 What holds state

| State | Lives in | Survives page reload | Survives host restart |
|---|---|---|---|
| The project (files, git) | disk, in the project | yes | yes |
| Project registry (`id`, `path`, `lastUsed`) | host, `~/.voicebox/projects.json` | yes | yes |
| Conversation transcript (per project) | host | **yes** | yes (append-only file) |
| Harness session id (per project) | host | **yes** | yes — resumed with `session/load` |
| Pending confirmation | host | **yes** | no (a restart clears it — deliberately) |
| Running turn / spawned processes | host + children | yes | no (reported as "interrupted") |
| Audit log | host, `~/.voicebox/audit.log` | yes | yes |

The rule underneath the table: **the page is disposable, the host is durable, the project is
the truth.** A reload mid-turn keeps the turn running and replays its progress. This is the
requirement the brief actually names — *"me and you keep talking... while I also do want to
work on some isocan projects at the same time"* — and it is the reason nothing important may
live in browser memory.

### 1.3 The two-model split, and its two footprints

The brief asks for Gemini Live first, OpenAI as an alternative, and Fable-through-pi as a
destination. Those are two different roles, and they should not be one component:

- **The voice model** holds the conversation: it hears, speaks, and decides *what to ask the
  host to do*. It sees the transcript and the state summaries the host sends it.
- **The execution harness** holds the work: it reads code, edits files, runs commands. It
  sees the project.

They have **different privacy footprints**, and a design that blurs them cannot tell the
truth about either:

| | Voice model | Execution harness |
|---|---|---|
| Sees | audio, transcript, project *metadata* (name, branch, status), diffs the host chooses to show | the project's files and command output |
| Where it runs | likely a cloud API (Gemini Live / OpenAI) | whatever the harness is: a local model, or a cloud CLI (claude-code, codex) |
| What leaves the machine | **audio + transcript** | **source code + command output**, to that provider |
| Per project, visible in the UI | — | a badge naming the provider, set when the project is opened |

So: **project file contents are never sent to the voice model**, and **a project's code only
goes wherever its declared harness sends it** — a per-project, visible choice rather than an
invisible consequence of picking a model at install time.

**A badge discloses; a lock guarantees — and only the second is a control.** The badge above is
the minimum; §5 recommends that a project can also *forbid* a cloud harness, because a control
that only tells you what already happened is a report, not a boundary. This is the same shape
as "the tool must not carry somebody's directory convention": secrecy of consequence has to be
enforced somewhere, not merely displayed.

### 1.4 The host ↔ harness contract (k3 builds against this)

One adapter. The host spawns it per project session with a **declared working directory** and
speaks ACP-shaped JSON-RPC over stdio — the bridge's proven shape, not a new protocol.

```jsonc
// host → harness.  These are requests, so they carry `id` and `jsonrpc`, and they answer.
{ "jsonrpc": "2.0", "id": 1, "method": "session/new",
  "params": { "cwd": "/home/paul/…/isocan", "mcpServers": [] } }
{ "jsonrpc": "2.0", "id": 2, "method": "session/load",
  "params": { "cwd": "/home/paul/…/isocan", "sessionId": "ses_…" } }
{ "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
  "params": { "sessionId": "ses_…", "prompt": "run the tests and fix what fails" } }
{ "jsonrpc": "2.0", "id": 4, "method": "session/cancel",     // the `stop` verb, defined
  "params": { "sessionId": "ses_…", "reason": "operator" } }

// harness → host (responses)
{ "jsonrpc": "2.0", "id": 1, "result": { "sessionId": "ses_…", "cwd": "/home/paul/…/isocan" } }
{ "jsonrpc": "2.0", "id": 2, "result": { "sessionId": "ses_…", "resumed": true } }
{ "jsonrpc": "2.0", "id": 3, "result": { "stopReason": "end_turn" } }
{ "jsonrpc": "2.0", "id": 4, "result": { "cancelled": true } }

// harness → host (streaming notifications; sessionId is on EVERY update, not just the first)
{ "method": "session/update", "params": { "sessionId": "ses_…", "update": { "sessionUpdate": "agent_message_chunk", "content": "…" } } }
{ "method": "session/update", "params": { "sessionId": "ses_…", "update": { "sessionUpdate": "tool_call", "title": "Bash: npm test", "status": "in_progress" } } }
{ "method": "session/update", "params": { "sessionId": "ses_…", "update": { "sessionUpdate": "tool_call_update", "status": "completed", "content": [ … ] } } }
```

**`stop` is the one instruction that may not depend on the harness's cooperation.** The host
sends `session/cancel`, and if the harness has not acknowledged within ~2 s it signals the
child's process group directly; either way it stops the processes the host started for that
project (the process journal has the pids). A stop that only works when the other side is
well-behaved is not a stop.

**`cwd` is always declared** — never defaulted, never inferred from the machine's layout.
The host computes it from the project record and refuses a turn whose project has no usable
directory.

**The permission round-trip is the confirmation channel.** When the harness wants to act
outside what it may do, it asks, and the **host** answers:

```jsonc
// harness → host.  The human-readable title is NOT the payload: a host cannot enforce
// containment, credential or argv rules from "Bash: rm -rf build/" alone.
{ "id": 41, "method": "session/request_permission",
  "params": { "sessionId": "ses_…",
              "toolCall": { "title": "Bash: rm -rf build/", "kind": "execute" },
              "resolved": { "argv": ["rm", "-rf", "/home/paul/…/isocan/build"],
                            "cwd": "/home/paul/…/isocan",
                            "paths": { "read": [], "write": ["/home/paul/…/isocan/build"] },
                            "effects": ["412 files removed", "not tracked by git"] },
              "options": [ { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
                           { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" } ] } }

// host → harness (the answer, which §1.5 used to leave undefined)
{ "id": 41, "result": { "optionId": "allow_once" } }      // or "reject_once"
```

**`resolved` is the structured plan, and it is what the host gates on** — in mediated mode the
host *produces* it (it is the tool boundary, so it has the argv and the paths before anything
runs); in compliant mode it is what the harness must supply if it wants a decision rather than a
refusal. The `title` is for humans and is never parsed.

The host's reply is *not* a rubber stamp: it consults the tier table (§3.2) against the **resolved
plan**, and for a Tier 2 act it relays the question to the UI and waits for a person (§3.4). The
model never answers its own permission request.

### 1.5 The host ↔ UI contract (astra builds against this)

One loopback WebSocket, JSON messages, small schema. All host→UI messages carry `project` so
a UI showing several projects can route them.

**A loopback socket is not authentication, and it is reachable by every page the browser
visits.** Any local process, and any website open in the same browser, can dial
`ws://127.0.0.1:<port>`; browsers do not apply the same-origin policy to WebSockets, so without
a check a drive-by tab could `open_project`, `say`, or — worse — answer a pending confirmation.
So the connection itself is authenticated before any message is trusted:

- an **ephemeral token**, minted at host start, readable only by the user (`~/.voicebox/token`,
  mode `0600`), passed on the upgrade (`ws://127.0.0.1:<port>/ui?token=…`);
- **strict `Origin` validation** on the upgrade, rejecting any origin that is not the UI's own;
- and failures are logged as audit entries, because a rejected upgrade is worth seeing.

```jsonc
// UI → host.  Every mutating message carries a per-connection nonce (`n`) and an input method
// (`via`), because the host must enforce its own provenance rule and cannot infer it (§3.4).
{ "type": "open_project",   "path": "/home/paul/…/isocan", "via": "typed" }
{ "type": "activate",       "project": "isocan", "via": "clicked" }
{ "type": "say",            "project": "isocan", "text": "run the tests and fix what fails",
                            "via": "speech", "clientId": "c-8f21" }     // replays of clientId are ignored
{ "type": "confirm",        "id": "cfm_17", "answer": "yes", "via": "speech" }  // or "typed" | "clicked"
{ "type": "stop",           "project": "isocan" }                  // honoured immediately, always

// host → UI, on connect — the handshake, so a fresh or reloaded page is never guessing
{ "type": "hello",    "host": "voicebox", "version": 1, "projects": [ … ], "active": "isocan",
                      "pending": [ { "id": "cfm_17", … } ] }
{ "type": "state",    "project": "isocan", "data": { "path": "…", "root": "/home/paul/…/isocan-wt",
                                                     "branch": "main", "dirty": 3,
                                                     "harness": "pi", "providerBadge": "local",
                                                     "mediated": true, "session": "ses_…",
                                                     "running": false } }
{ "type": "turn_started", "project": "isocan", "turn": "turn_9", "clientId": "c-8f21" }
{ "type": "progress", "project": "isocan", "turn": "turn_9", "update": { … } }   // ACP update, relabelled
{ "type": "diff",     "project": "isocan", "turn": "turn_9",
                      "files": [ { "path": "…", "additions": 12, "deletions": 3 } ] }
{ "type": "confirm_request", "id": "cfm_17", "project": "isocan", "tier": 2,
   "question": "Delete `build/` (412 files) in isocan?",
   "resolved": { "command": "rm -rf /home/paul/…/isocan/build",
                 "paths": ["/home/paul/…/isocan/build"],
                 "effects": [ "412 files removed", "recoverable: not tracked by git" ] },
   "source": "agent",            // or "content" — see §3.3
   "accepts": [ "clicked", "typed" ] }   // "content"-sourced acts never list "speech"
{ "type": "confirm_expired", "id": "cfm_17", "project": "isocan" }   // so the UI can clear the prompt
{ "type": "audit",    "project": "isocan", "entry": { … } }
{ "type": "refused",  "project": "isocan", "rule": "outside-project", "detail": "…" }
{ "type": "error",    "project": "isocan", "detail": "…" }
```

`confirm_request` carries the **resolved** plan (real paths, real counts) rather than the
spoken words — that is what makes a mis-transcription visible (§3.3), and it is what the
confirmation UI renders.

Three contract rules that the schema alone does not convey:

- **`via` is a claim the host validates, not a label it trusts.** A `confirm` whose `via` is not
  in that request's `accepts` is refused; a `via` of `speech` on a `content`-sourced act is
  refused. This is the mechanism behind the rule in §3.3 — without the field there was nothing
  to enforce it against.
- **Ids are single-use.** A `confirm` id is spent by the first answer, and a second answer is
  refused rather than re-applied. Combined with the per-connection nonce and `say.clientId`,
  replaying a recorded message cannot re-drive an action.
- **Every `progress` and `diff` carries its `turn`**, and the `say` that started it is echoed in
  `turn_started.clientId`, so the UI can attribute output to the sentence that caused it.

### 1.6 The thinnest working version

**M0 — the skeleton that is genuinely useful (about a day).**

- `voicebox-host`: registry (open/activate/list), one active turn at a time, tier table with
  Tier 0/1 enforced, audit log, process journal.
- **Text** input, not voice: a minimal page that opens a project, sends a line, streams
  progress, shows diffs, answers confirmations.
- One harness: the pi/ACP adapter, one project, cwd declared.
- Three verbs work: **ask**, **do**, **stop**.

**M1 — voice and several projects.**

- astra's voice UI replaces the text box; Gemini Live first, OpenAI as a second voice model.
- Several projects registered with instant switching and per-project sessions.
- Tier 2 confirmations spoken *and* clicked, with resolved-plan readback.

**M2 — a project in the browser.** The same tier table running in a worker, over an OPFS
directory handle, with a declared capability list and the egress policy of §3.5a. The first
placement where the boundary's mechanisms differ, so it lands after the machine placement is
trustworthy — and it is where Paul's *"use OPFS"* requirement is actually met.

**M3 — a host on another machine.** The same host, reached over an authenticated remote channel
rather than loopback: the shape this fleet already runs in when Paul talks to it from a phone.
Changes transport, not authority.

**Deliberately not in any of them:** cloud relay or any inbound connection; unattended autonomy
(§3.7); a second transport; a plugin system; multi-user; a database (the filesystem, OPFS and
append-only logs are the state).

**What is reused rather than rebuilt:** the ACP bridge's transport, session continuity, and
permission round-trip. If that bridge is the bottom half already, this design is mostly the
*top* half — projects, tiers, audit, and the contracts the other two lanes need.

---

## 2. The local-project unit

### 2.1 What a project is

A project is a **declared directory** plus a session, and nothing more:

```jsonc
{ "id": "isocan",                      // short name, unique among registered projects
  "path": "/home/paulkinlan/isocan",   // the DECLARED checkout (realpath-resolved at open)
  "executionRoot": "/home/paulkinlan/isocan",  // where work actually happens (§2.4)
  "placement": "machine",              // machine | browser | remote  (§1.1b)
  "capabilities": ["read", "write", "exec", "wasm"],   // what `do` can mean here (§1.1b)
  "lastUsed": "2026-09-19T11:40:00Z",
  "harness": "pi",
  "sessionId": "ses_…",                // the harness session for THIS project
  "worktree": null }                    // set when the host keeps work recoverable (§2.4)
```

- **Identity**: the realpath, so two paths to the same checkout are one project.
- **`executionRoot` is the containment root**, and it is not always the checkout: when the host
  works in a worktree (§2.4) that directory *is* the root for every containment check, every
  diff and every state message. Containment is always **relative to one root — the active
  project's execution root** — never the union of registered projects, or a nested or
  side-by-side project would hand the harness another project's files.
- **One active execution root per project.** Two writers on one tree is the failure this fleet
  already has evidence for, so a project is never simultaneously open for work in two places;
  moving work between roots is an explicit act.
- **No discovery.** The host never scans the filesystem for repositories; a directory becomes
  a project when it is declared. (This is the same rule as the cwd fix: the machine's layout
  is never assumed.)
- **Removal is dropping a record**, never touching the directory.

### 2.2 Open, activate, detach, close

| Act | What happens | What does not happen |
|---|---|---|
| **open** | verify the path exists and is a directory; resolve realpath; register; create a session lazily on first use | nothing is cloned, scaffolded or modified |
| **activate** | the active project changes; the UI is told the new state | other projects' sessions are untouched |
| **detach** (implicit, on switching away) | the session stays alive and resumable | **no process is killed** for switching |
| **close** | the session is ended explicitly; processes the host started for it are stopped | files are untouched by closing |

"Open" attaches to what the developer already has. Creating a new project (scaffolding,
cloning) is a later milestone and a **confirmed** act, because it writes outside an existing
root by definition.

### 2.3 Several at once: what is parallel, what is serial

The brief's requirement — *working on isocan while talking to the agent* — is satisfied by
**sessions persisting per project while the conversation moves**, not by running two agents
at once:

- **Parallel across projects**: sessions, transcripts, state and audit trails. Switching is
  instant, and nothing is torn down. If isocan has a turn running, switching to another
  project does not interrupt it; its progress is buffered and shown when it is active again.
- **Serial within a project**: one turn at a time. A second instruction while a turn runs is
  either queued or refused, explicitly, in the UI.
- **One voice channel**: you can only be talking about one project at a time, and the active
  project is what a spoken instruction means. "Which project is this about?" is never guessed
  from content — it comes from the active project, or from an explicit name in the sentence.
  An ambiguous instruction asks rather than picks.

A second turn *globally* (two projects running at once) is deliberately out of M1: two agents
editing two checkouts is safe, but two agents acting on one machine's resources is a
resource-contention problem we have no reason to take on before the interaction model is
settled.

### 2.4 Separability, and keeping work cheap to undo

- **cwd**: every turn runs with the project's realpath as its declared cwd. The harness cannot
  wander into another project because it is never told about one.
- **Session isolation**: one harness session per project, so context does not bleed between
  checkouts.
- **Recoverability**: work the agent does unprompted (Tier 1) is **kept reversible** — for a
  git project the host may work in a branch or a worktree, so "undo everything the agent did
  this evening" is one command and never a conversation. Where the project is not a git
  repo, the host records the files it wrote so a revert list exists.
- **A worktree is the execution root, not an exception to containment.** If the host works in
  `/home/paul/isocan-worktrees/agent-3`, then *that* path is what every check is measured
  against and what the UI shows; the checkout the developer is typing in is outside the root
  and therefore Tier 0, which is the point — the agent cannot wander into the files he is
  editing. Diffs are computed in the execution root, and "land the work" is an ordinary merge
  he can see and refuse.
- **Audit separability**: the audit log is one append-only file with a `project` field on
  every entry, so "what happened in isocan today?" is a filter.

### 2.5 What the host may read without asking

Read-only facts about a project — branch, dirty count, recent commits, whether a server it
started is still running. Reading a project's own files is Tier 1 (§3.2). Reading *outside* a
project is Tier 0 unless it is the host's own state directory.

---

## 3. The security boundary

This section exists before any code, because the thing being designed is a **language model
with execution access to a developer machine, driven by speech**. Yesterday's fleet work
settled two general rules that apply directly: authority must be *declared* rather than
assumed, and ambient state is where things go wrong quietly. Voice is the ambient-est input
there is.

### 3.1 The threat model

| Input | Trusted for | Not trusted for |
|---|---|---|
| Paul's speech | expressing intent about his own projects | being correctly transcribed; being the only thing on the microphone; being current (an utterance from twenty minutes ago) |
| The transcript | a record of what was heard | authority to act |
| Project content (files, issues, READMEs, web pages the agent reads) | information | **instructions** — content never confers authority |
| The harness model | proposing actions inside a project | deciding what it may do |
| The voice model | proposing intents, holding the conversation | executing anything, answering a confirmation |

Three concrete attacks this table is defending against:

1. **A transcription that changes the act** — "delete the *build* folder" heard as something
   else, or a passing conversation heard as an instruction.
2. **Injection through content** — a repository's README, an issue, or a fetched page
   containing instructions aimed at the agent.
3. **The helpful-drift failure** — a chain of individually reasonable actions that adds up to
   something irreversible (deleting a directory to "clean up", force-pushing to "resolve" a
   conflict).

### 3.2 The tiers

The tiers below describe a system where a person is **present, or nearby**. **Autonomy is not a
setting on this table.** An agent that acts with nobody listening has a different threat
model — no confirmation gate can exist, so its boundary would have to be built from sandboxing,
resource limits and classifications of irreversible acts instead — and the guarantees stated
here would not carry over to it. Anyone later tempted to add an "unattended" switch is adding a
second design, not flipping a flag, and this paragraph is the reason to say so out loud.

**The line that keeps this consistent with long-running work — and it is the line someone will
come here looking for: an approved plan continuing is not an unattended agent deciding.** A turn
Paul asked for may keep running while he does something else, and its progress may wait for him;
but nothing *new* begins without an instruction, and Tier 2 always blocks on a person. What is
refused is the second thing, never the first. (§3.7 states the same limit operationally, which is
why the two read as a contradiction until they are read together.)

**Tier 0 — never. Refused by the host, before execution, whatever anyone says.** Every rule
is enforced as data in the host and every one has a test (§3.6).

| Rule | Mechanism |
|---|---|
| Write or read outside the **active project's execution root** (§2.1) and the host's own state dir | realpath containment against the active root only — never the union of registered roots, or a nested project would hand the harness another project's files |
| Creating a symlink whose **target** resolves outside the execution root | containment checks the link target as well as the link's location, before creation |
| Touch credential material (`~/.ssh`, `~/.config/**credentials**`, keychains, browser profiles, `.env*`, service-account files) | path + pattern deny-list, applied to reads as well; matches are reported, never echoed |
| `sudo`, `su`, machine-wide config changes, global package installs | command classification before execution |
| Kill processes the host did not start | the process journal is the only source of pids it may signal |
| `curl … \| sh`, or any fetch-and-execute of remote code | command classification (fetch + interpreter in one pipeline) |
| Send anything to the network from the host itself (exfiltration surface) | the host makes no outbound requests; the harness does what its own tools do, inside a project |
| Publish, deploy, spend money, message a human | these are **Tier 2** — but a Tier 0 blanket ban applies when the instruction arrives from *content* rather than from Paul (§3.3) |

**Tier 1 — allowed unprompted, inside a project, reversible, and reported.**

- Read anything inside the project.
- Write or edit files inside the project. Every write is reported with a diff, and the work
  is kept recoverable (§2.4).
- Run the project's own toolchain: build, test, lint, format. These are the project's own
  code, which is the point of a build environment; they are reported, not gated.
- Start a dev server the host records in the process journal, **bound to loopback**
  (`127.0.0.1`), in a **single slot per project** that replaces the previous instance. A
  project whose own configuration binds `0.0.0.0` is exposing the checkout to the local
  network — that is a Tier 2 act, because the host cannot honour Tier 1's promise for it.

**Tier 2 — confirm first, per act, in the conversation.**

- **Irreversible or hard to reverse**: deleting files or directories; `git reset --hard`,
  `git clean -fd`, force-push, history rewrites; dropping or migrating a database;
  overwriting uncommitted work.
- **Leaving this machine**: `git push`, opening or commenting on a PR, deploying anywhere,
  calling a remote API that receives project content.
- **Reaching a human or the public**: sending a message, email, post or comment — always,
  even to Paul himself.
- **Adding or changing dependencies.** `npm install`, `pip install`, `cargo add` and friends
  **execute arbitrary code** (preinstall/postinstall/setup.py/build.rs lifecycle hooks) *and*
  reach external registries, so unprompted they are unprompted code execution plus unprompted
  egress — the supply-chain vector sitting inside what was the safe tier. The confirmation names
  the packages, including which are new to the lockfile. **A restore is Tier 1 only when it
  cannot run code**: `npm ci --ignore-scripts` against a committed, unchanged lockfile, or the
  equivalent. Without `--ignore-scripts`, a restore is still an install.
- **Spending**: token spend on a cloud harness is expected (it is the tool), but provisioning,
  purchases and anything with a price tag are Tier 2.
- **Secrets**: using a declared secret to run something, and any act that would put a secret
  value into the transcript.

The line between Tiers 1 and 2 is **reversibility and reach**: inside the project and cheap to
undo → go; outside the project, or expensive to undo, or someone else can see it → ask.

### 3.2a The same tiers, in a browser

The tier table is **placement-invariant**: the same three tiers govern an OPFS project and a
checkout. What changes is the mechanism that enforces each one — and which direction it moves.

| Tier 0 rule | On a machine | In a browser (OPFS) |
|---|---|---|
| Nothing outside the root | realpath containment, checked and re-asserted | **structural**: OPFS handles are relative, `..` does not resolve, and OPFS has no symlinks — the API cannot express an escape |
| No credential material, no system commands, no `sudo` | deny-list + argv classification | **structural**: there is no `~/.ssh`, no process to spawn and no privilege to escalate inside the origin |
| No fetch-and-execute | argv classification | **structural**: there is no process to exec |
| No exfiltration by the host | the host makes no outbound requests | **weaker, and this is the real gap** — a page can `fetch`; project code runs under a declared egress policy (§3.5a) and any network access by it is Tier 2 |

| Tier | On a machine | In a browser (OPFS) |
|---|---|---|
| 1 — unprompted | read/write files, run the toolchain, loopback dev server | read/write OPFS files, run **wasm/JS tools in a worker**; no processes, so "dev server" becomes "start the preview worker" |
| 2 — confirm | irreversible acts, leaving the machine, reaching a human, spending | the same list; "leaving the machine" becomes "leaving the browser" (uploads, remote APIs, form posts) |
| Audit | an append-only file | **IndexedDB in the same worker**, mirrored to a paired machine host when there is one — "you can find out what happened" must not depend on which placement ran |

So the boundary survives translation, and two of its mechanisms get **stronger** rather than
weaker — but not all of it, and the exception is egress. Better to know that now than to discover
it in a demo.

### 3.3 How a spoken instruction maps onto the tiers

This is the part with no off-the-shelf answer, so it is stated as a pipeline:

```
speech ──▶ transcript ──▶ intent {project, action, args} ──▶ RESOLUTION ──▶ tier ──▶ act
                │                     │                          │
         (untrusted)          (voice model proposes)     (host resolves real paths,
                                                          real counts, real effect)
```

1. **The voice model proposes a typed intent. It never executes.** The host is the only
   component with authority, and the only one that knows the tier table.
2. **The host resolves before it judges.** An intent becomes a *resolved plan*: absolute
   realpaths, file counts, the actual command line, what is tracked by git, what would be
   lost. Two different spoken sentences that resolve to the same plan are the same act — and
   one sentence that resolves somewhere unexpected is visible as such.
3. **Tier is decided on the resolved plan, not the words.** "Clean up the build folder" is
   Tier 2 because the resolved plan deletes 412 files; the words themselves settle nothing.
4. **Guarded acts are read back in their resolved form** — *"Delete `build/` (412 files) in
   isocan?"* — so a mis-transcription shows up as a different plan, not a different sentence.
5. **`stop` is always live.** It cancels the running turn and stops the processes the host
   started, immediately, whatever else is pending, and it is honoured mid-sentence.

**Where an instruction came from is part of the decision.** If the intent originated from
content the agent read (a file, an issue, a page) rather than from Paul's speech, the host marks
it `source: "content"`, and Tier 2 acts originating that way require **typed or clicked**
confirmation, never a spoken "yes". The confirmation UI says so in words: *"this request came
from a file the agent read, not from you."*

### 3.4 What makes a confirmation valid

A spoken "yes" counts **only** when all of these hold:

- a question was asked, by the host, and it is the most recent thing asked;
- exactly one confirmation is pending;
- it refers to the active project and arrived **after** the question (≤ 30 s window);
- the answer is unambiguous ("yes" / "go ahead" / "do it" — not a continuation of an
  unrelated sentence).

Otherwise the host asks again, or offers the UI control. Never valid: silence; "ok" *before*
the question; a general "yes" while two questions could be pending; a confirmation given by
the voice model on Paul's behalf.

Two consequences that need stating because they are the difference between a rule and a
mechanism:

- **An expired confirmation is a refusal, not a pending question.** When the 30 s window closes
  the host emits `confirm_expired`, spends the id, and reports the act as rejected; a "yes"
  arriving afterwards has nothing to attach to and starts a fresh plan (with a fresh readback)
  if it is meant.
- **A spoken yes is only accepted where the request says so.** Each `confirm_request` lists the
  input methods it accepts, and the host validates the `via` field against that list — so a
  `content`-sourced act simply has no path from a transcript to a yes, whichever voice is
  speaking.

### 3.5 Mechanisms, not intentions

| Claim | Mechanism |
|---|---|
| "It cannot leave the project" | realpath containment against the active execution root, computed at execution time for every path and cwd **and re-asserted immediately before use** — the 30-second confirmation window is a real window, and a path or symlink can change inside it. Resolve, then re-resolve, then execute |
| "It cannot be walked out of the project by a symlink" | link *targets* are checked, not just link locations, and the host opens with `O_NOFOLLOW` semantics where it performs the operation itself |
| "And the guarantee holds for the harness's own tools too" | **only in mediated mode (§1.1a)**. This is the row that decides whether the table above is enforcement or disclosure |
| "It cannot touch credentials" | deny-list applied to resolved paths *and* to reads; values never returned to the transcript |
| "It cannot run the wrong thing" | commands are classified from the resolved argv, and Tier 0 matches refuse before spawn |
| "It cannot act unattended" | Tier 2 always blocks on a human; no new plan begins without an instruction |
| "Paul can find out what happened" | append-only audit log, one entry per act: time, project, tier, decision, resolved command, exit status, plus a diff summary for writes |
| "Work is undoable" | branch/worktree or a written-file revert list per project |
| "Switching projects is safe" | per-project session and cwd; nothing shared but the host |

### 3.5a The one place the browser placement is weaker: egress

Containment and privilege are *structurally* better in a browser; this is the counterweight —
**a page can reach the network.** Five ambient APIs alone can do it (`fetch`, `XMLHttpRequest`,
`WebSocket`, `EventSource`, `sendBeacon`), a content security policy has **no `connect-src` by
default**, and a `no-cors` POST can send data without ever being readable back. That surface was
measured on this fleet yesterday, which is exactly why it must not be assumed here:

- project code in the browser runs in a worker under a **declared egress policy** — an explicit
  `connect-src` allow-list, defaulting to `'none'`;
- **any** network access by project code is a **Tier 2 act**, because it is the one thing the
  sandbox does not decide for us;
- and the policy is **tested** in the same shape as yesterday's sandbox-egress KAT: a positive
  control (an approved host is reachable) beside the refusals, because a suite of refusals proves
  nothing until one request succeeds.

On a machine, "the host makes no outbound requests" is a property we implement; in a browser it
is a property we *configure and verify*. Both are claims — only one of them is free.
### 3.6 The tests that make the boundary real

A boundary that is only asserted is a wish, and a suite of refusals proves nothing until a
request succeeds. So both directions:

- **Negative controls**: for each Tier 0 rule, an attempt that must be refused *by the host*
  — with the refusal's own words checked (naming the rule and the path), not just a non-zero
  exit.
- **Positive controls**: in the same session, a Tier 1 act that must succeed — a write inside
  the project, a test run — so a refusing-everything bug is caught as a failure rather than
  mistaken for safety.
- **Tier 2 tests**: an act that must block pending confirmation; a confirmation that arrives
  late, ambiguous or twice; a `source: "content"` act that requires typed confirmation.
- **Path tests**: `..` escapes, symlinks pointing out of the root, and absolute paths
  elsewhere — each refused on the resolved path.
- **The reuse test**: the cwd the harness receives is the project's realpath, and no default
  is invented when a project lacks one (a rule we learned the hard way this week).

### 3.7 What this boundary does not do

Being explicit about the limits, because a design that overstates its safety is worse than one
that states a smaller guarantee:

- **It does not sandbox the harness's own tools.** The harness is a real CLI agent with real
  authority inside the project; Tier 0 rules are enforced where the host can see an act (its
  permission round-trip, its own commands, its path resolution), not inside a harness that
  ignores asks. A harness that never asks cannot be contained by this design — it can only be
  chosen, or not used.
- **It does not make the machine disposable.** Corrupting a build cache or a database inside a
  project is recoverable-ish; that is why Tier 2 exists rather than "the agent can do anything
  in a project".
- **It does not protect the transcript.** Audio and transcript go to the voice provider; project
  code goes to whatever the harness provider is. Both are *disclosed* (§1.3), not prevented.
- **It is not a defence against a compromised machine** — only against a well-meaning agent
  driven by an unreliable channel.
- **It does not run unattended.** There is no "act while nobody is listening" mode in this
  design; long actions continue while the *conversation* moves on, which is a different thing,
  and Tier 2 always waits for a person.

---

## 4. What I need from the other lanes

**From astra (interface):** the confirmation UI must render `confirm_request.resolved` (paths,
counts, effects) rather than the spoken words, and must be able to answer **typed/clicked**
when `source: "content"`. Everything else in §1.5 is yours to shape.

**From k3 (harness):** one adapter; `session/new|load|prompt` with a **declared cwd**;
streaming `session/update`; and a real `session/request_permission` for acts outside the
project so the host can gate them. If the harness cannot emit permission requests, the host's
Tier 2 must be implemented as a wrapper around the tools it offers instead — worth knowing
early, because it changes where the gate lives. Two additions from §1.1b: the harness should
**declare the capabilities it has in a given placement** (`exec`, `wasm`, `network`), and it
should run in **at least the machine placement and the browser placement** — if those cannot
share one adapter, say so early, because that is a second harness rather than a second setting.

**From Paul:** three decisions, in §5.

## 5. Decisions, and the defaults we are proceeding on

Each of these has a recommendation and a default, so **building is not blocked on an answer** —
any word from Paul changes one line, and the default is itself a line in the design.

**1. Authority while no one is at the keyboard.**
Options: (A) nothing continues while nobody is listening; **(B) approved plans continue, no new
plan starts, Tier 2 always waits**; (C) full autonomy.
**Recommend B, and proceed on B.** Trade-off: he can walk away mid-task and return to progress,
but an approved plan can still reach somewhere he would have stopped in person — bounded by
Tier 2 always waiting and by the work being recoverable. Option C is a different design with
its own boundary, not a setting.

**2. A project's power to forbid a cloud harness.**
Options: (A) the badge in §1.3 alone; **(B) badge plus a per-project lock that forbids one.**
**Recommend B, and proceed on B with every project unmarked until he marks one.** Trade-off: a
repo marked local-only can never be worked by a cloud harness even when he later wants it — one
flag to flip, and the only version that is a **guarantee rather than a disclosure**.

**3. Worktrees versus working in place.**
Options: (A) always in place with git as the undo; (B) a branch in place; **(C) a worktree per
agent session, with in-place plus a written-file revert list for non-git projects.**
**Recommend C for git projects, and proceed on C.** Trade-off: his checkout stays exactly as he
left it and "undo everything the agent did" is one deletion — at the cost of dependencies and
ports needing their own copy, and the work landing one merge later than it otherwise would.
The alternative we already have evidence for is the agent and him editing one working tree at
once, which is the failure this fleet spent a day recovering from.

**4. A browser-only mode, with no host process at all?**
Options: (A) a host is always required (§1.1b's rule — authority outside the renderer);
**(B) browser-only is allowed, with the tier table and audit running in the page's worker and
its limits disclosed** (a page-local audit, storage a browser may evict, guarantees that hold
only inside that origin).
**Recommend B, and proceed on B**: allowing it costs one honest badge, and forbidding it would
rule out the thing Paul actually asked for — *"I want to access this through a website"*. The
leaning is that when a host *is* paired, its audit is the record of truth and the page's copy is
a cache rather than a second ledger. Trade-off: a page-local audit is evidence about a tab, not
about a machine, and eviction can take the project with it.
