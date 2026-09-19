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
| **One writer per root, several roots per project** — the root serialises, not the project | Paul's scenario is two live agents on one project (his phone on a walk, the chat session); "serial within a project" rested on a premise he falsified — one conversation | Sessions multiply (per instance and root), and the audit needs per-instance sequencing because two machines have no shared clock |
| **`undoKind` is declared per project, and the tiers scale with it** | *"We got worlds where you may never have git available"* — and "cheap to undo" is a false promise where nothing can be undone | A project with no undo has a narrower unprompted scope, which has to be visible rather than surprising |
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
│  · sessions per (instance, root)   · confirmation gate    │
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

**Driven against pi as it actually is (k3, `docs/03-architecture-k3.md`): compliant mode does not
exist today.** Two drives against the real bridge produced **zero `session/request_permission`**
for ordinary tool calls — the protocol path is wired end to end and **pi never uses it**. pi's only
built-in gate is *project trust*, which guards **input loading**, not what the model asks tools to
do afterwards, and in non-interactive modes it does not appear at all. So the honest statement has
**four** shapes, and the fourth is what a reader should assume until told otherwise:

| Shape | What enforces | Available when |
|---|---|---|
| **Mediated** | the host owns the tool surface, so it has the plan **by construction** | the harness is built that way |
| **Compliant** | the harness asks, and the host answers | **after** an extension exists that hooks tool calls and asks — k3 names it: a pi extension calling `ctx.ui.confirm()`, *"a small, named piece of work, not a discovery"* |
| **Environmental** | a container with only the files and credentials the task needs | whenever the environment is disposable — and it depends on **nobody's compliance** |
| **Disclosure** | nothing: the tier table describes what the agent *should* do | **everything else** — and the UI must say so per session, not imply otherwise |

**The design's position: mediated is the target for the default harness; compliant mode requires the
extension above and is not claimed until it exists; and until one of the first three is in force the
tier table is presented as a disclosure.** The brief's minimalism makes this feasible — *one* harness
built by us can expose its tools through the host, which is far easier than auditing an adapter
zoo. A harness that cannot be mediated is still usable, but the UI carries the downgrade
explicitly, in the same spirit as the provider badge: **the guarantee is a property of the mode,
and the user is told which one is running.** §3.2 and §3.7 are written in terms of both.

> *"We have **environment configuration** and **by default the first environment is the browser**...
> your **local safe environment**, and then maybe a **hosted cloud server environment** as well."*
> — Paul, 2026-09-19 (N11)

### 1.1b Three environments, one host role

Paul's axis is **environments**; the placements below are how each one is *implemented*. The
order is his, and it is not arbitrary: **the browser is first because it is the safest** — the
mechanisms in §3.2a are structural there, enforced by the platform rather than by us. Building
the riskiest environment first would have been the wrong way round.

> *"The harness should be on the client and also running on the server... I want to access this
> through a website, I do want to be able to use OPFS... but also we're on the server as well."*
> — Paul, 2026-09-19

A requirement, not a different design, and it is satisfiable by one rule:

> **The host is wherever the files are. The browser is always a client.** Authority — the tier
> table, the confirmations, the audit — is **co-located with the data it governs**, never in the
> renderer.

| Placement | Where the files are | Where the host runs | Root | What `do` can mean |
|---|---|---|---|---|
| **browser — "the first environment"** (E1) | **OPFS** in the page's origin | a dedicated **worker** in that page — same tier table, same audit code | an OPFS directory handle | wasm and JS tools, file reads and writes, generated assets; no processes, and **no harness** (see the transport fact below) |
| **local safe** (E2) | a checkout on his machine | a local process on that machine | a realpath (or its worktree) | whatever the project's toolchain can: spawn processes, run tests, git |
| **remote** (E3) | a checkout on a machine that is *not* where the browser is | a process on **that** machine | a realpath on that machine | as local, minus nothing — today's Telegram-to-agent shape |
| **hosted cloud** (E4, later) | a checkout on **somebody else's** machine | a process there | a realpath there | as local, with everything below attached |

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
3. **The browser placement is a peer world, not a cache — and there are two ways to use it.**
   OPFS is **per-origin and per-browser-profile**: the files a page holds are invisible to every
   other placement, including the session Paul talks to over Telegram. So a browser project is not
   a copy of anything; it is **a separate project with a separate history**, and the two shapes
   below are different products, not one with a footnote:

   | | **Peer** | **Window** |
   |---|---|---|
   | Files live in | this browser's OPFS | a machine, reached over an authenticated channel |
   | Visible to his other sessions (chat, Telegram, another device) | **never** — unless he exports or syncs, which is an ordinary Tier 2 egress act | **always** |
   | Works with no host reachable | **yes** — the page *is* the host | no |
   | Whose history it is | the tab's | his |

   Both make the walk work; what differs is **whether the history is his or the tab's**. So the
   window is the recommendation wherever a host is reachable (§5 decision 4), the peer is a real
   mode for offline, throwaway or deliberately device-local work — and **every project says which
   one it is, in the UI**, because a user who assumes the wrong one loses work. Two browsers each
   holding a project called `isocan` are **two projects**: identity carries the placement
   (`isocan@phone`, `isocan@box`), not just the name.
4. **The browser cannot host the harness — a transport fact, not a capability gap.** The adapter is
   a **stdio process spawner**, so a page cannot run it (k3 drove the topology:
   `browser ⇄ WebSocket ⇄ bridge on a machine ⇄ stdio ⇄ pi child`). It is **one harness, one ACP
   protocol, two transports**, and the capability declaration must record it that way — otherwise
   the browser environment quietly grows capabilities that do not exist. For E1 that means its
   *tools* run in the page (Wasm, §1.8) while *harness* work arrives through a bridge on a machine
   when one is reachable — and E1-M0 deliberately needs neither.
5. **The remote placement changes transport, not authority.** Loopback plus a token is right when
   client and files share a machine; a browser on a phone talking to a server needs an
   authenticated remote channel (TLS, a paired credential, an explicit pairing flow) — and the
   tier table, the confirmations and the audit stay **on the machine that holds the files**,
   because that is where they mean anything.

### 1.2 What holds state

| State | Lives in | Survives page reload | Survives host restart |
|---|---|---|---|
| The project (files, git) | disk, in the project | yes | yes |
| Project registry (`id`, `path`, `lastUsed`) | host, `~/.voicebox/projects.json` | yes | yes |
| Conversation transcript (per (instance, root)) | host | **yes** | yes (append-only file) |
| Harness session id (per (instance, root)) | host | **yes** | yes — resumed with `session/load` |
| Pending confirmation (bound to instance, project, root, plan) | host | **yes** | no (a restart clears it — deliberately) |
| Other live instances of a project | host | yes | no (they re-announce on reconnect) |
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

One adapter. The host spawns it per **(instance, root)** session with a **declared working directory** and
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

**Unconditional, and the only such guarantee in this section.** After k3's drives this is not a
nicety: it is **the only hard lever the host always has** —
everything else in this section depends on the harness choosing to ask or to answer. `session/cancel`,
the process-group signal, and the refusal to continue are **unconditional**; treat any guarantee that
rests on the harness's cooperation as conditional on the mode (§1.1a).

The same applies to failure in the other direction: **a harness that exits mid-turn is an error
turn, not a dead session.** The host reports it, records it, and can start a fresh session for
that (instance, root) — because a harness dying is a thing that happens under load, and a design
that treats it as fatal turns a retry into a lost conversation.

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
                                                     "instances": [ { "id": "phone", "root": "…/isocan-walk" },
                                                                    { "id": "chat",  "root": "…/isocan-wt" } ],
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

**The environment order is Paul's (N11): browser first, then local safe, then — later, and with
the trust questions below answered — hosted cloud.** The capability milestones below still
describe *what can be done* at each step; they no longer imply *where* it happens first.

**A note for honesty's sake:** the machine placement already exists as a skeleton, because it is
the cheapest thing to drive and the easiest to break while testing (§3.5a's findings came from
exactly that). That makes it a **development convenience**, not the product's first environment —
the first environment he opens is the browser.

**One trust question the hosted-cloud environment adds, and it is not a detail:** *his files on
somebody else's machine.* A project there needs the provider named, the operator's access
disclosed the way a cloud harness's is (§1.3), and a per-project setting that can forbid it (§5
decision 2) — the same disclosure discipline, one level further out. §5 keeps the server side an
open question on purpose, because Paul named it as the part he cannot yet reason about.

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

### 1.7 How a tool becomes available

> *"You obviously build extensions like we can with pi and then just have the model register
> them."* ... *"We will create the tools and we will create the objects, the nouns — and the verbs
> are based off us somehow."* — Paul, 2026-09-19 (N10/N11)

Two ideas that are one design: an environment is **what can run here**, and an extension is **a
new thing that could**. The seam between them is the capability declaration, and it runs in one
direction only:

```
model authors an extension  →  registration: a DECLARATION  →  admission by the ENVIRONMENT  →  `do` may use it
   (pi-style, in the conversation)      name · capabilities · bounds · replayClass        (fails closed)
```

- **Authoring is the model's.** Writing a tool in the conversation is ordinary Tier 1 work inside
  a project: it is a file, it is reported, it is revertible.
- **Registration is a declaration, not a permission.** A tool declares what it needs —
  `capabilities` (read, write, exec, wasm, network), `bounds`, and a `replayClass` — in the same
  spirit as the harness declaring its capabilities, and for the same reason: an undeclared need
  cannot be granted.
- **Admission belongs to the environment, never to the model.** A tool whose descriptor is not
  admitted is not a capability, and **fails closed** — the rule that came back from the harvest,
  where a store held nine descriptors all `admitted: false` and executed nothing. The same
  discipline stops a freshly written tool from being usable merely because it exists.
- **A tool's authority is what the environment enforces, never what the tool declares.** See
  below: the declaration is a *request and a record*, and every capability it names must have a
  named mechanism behind it before the tool runs at all.
- **Tools accumulate, and they travel only as far as their capabilities do.** A `wasm` tool runs
  in the browser and on a machine; an `exec` tool is *not available* in the browser — not broken,
  absent — and the UI says which is which rather than letting a verb fail at the moment it is used.
- **Nouns and verbs come from the conversation (N10).** New objects and new verbs land in a
  registry that is **data**, like the tier table and for the same reason: it is the thing a
  reader, an auditor or a later model can inspect instead of inferring from prose.

#### Who declares, and what makes it true

Asked of this pipeline: are capabilities **declared by the author**, **derived by the
environment**, or **enforced regardless of declaration**? The answer is the third, with the first
two as conveniences — and the distinction matters because the alternative is the day's recurring
mistake in a new costume:

> **A declaration treated as a fact is a rewrite, not a check** — the same shape as
> `path.basename` being called containment. A tool whose descriptor says `network: none` can still
> call `fetch`. If the declaration is what makes it true, the boundary is a report.

So a **capability is not a permission the tool claims; it is the interface the tool is given.**
Tools are not handed ambient authority (`fetch`, `fs`, a shell) and trusted to behave; they are
handed the specific host-provided functions they are allowed to use, and nothing else — which is
§1.1a's **mediated mode, applied one level down**, from the harness to the tool.

**Admission therefore requires a named enforcement mechanism per capability.** If the environment
cannot say *how* it enforces a declared capability, it does not admit the tool — the same
fails-closed rule, applied to the mechanism rather than the descriptor:

| Capability | Enforced in the browser (E1) by | Enforced on a machine (E2) by |
|---|---|---|
| `read` / `write` | handle-scoped access: a tool gets the OPFS handles it may touch, not a filesystem | the substrate's path scope (`--allow-read/-write=<root>`) **plus a host-side resolve pass**, because the substrate's scope is lexical and a symlink inside the root defeats it (measured: `root/link-outside` read `/etc/hostname`) |
| `wasm` | **the import boundary**: a module can call only what the host exports to it | the same, plus process isolation if it runs out-of-process |
| `network` | the realm's egress policy — CSP `connect-src`, default `'none'` (§3.5a) | **the substrate's `--allow-net=<hosts>`**: measured, an allow-listed host answers and another is `NotCapable`. A plain Node host has no equivalent at all — `fetch` succeeds under `--permission` — so the substrate is the mechanism here, not the policy |
| `import` (remote code) | CSP `script-src` (no inline) | **`--no-remote` is mandatory**: measured, a dynamic remote import fetched and executed **with no flags at all**, because the module loader sits outside the permission model. Unset, the row above is false from inside the runtime |
| `exec` | **impossible: there is no process to spawn**, so the capability is *absent*, not promised | **absent for dynamic tools too.** Measured: with `--allow-run`, a spawned `/bin/sh` read a file outside the root — printed `MACHINE-SECRET`. `--allow-run` is not "exec scope", it is the machine, so it is **never granted to model-authored code**; a tool needing `exec` needs a container that bounds the child |

Three consequences, each of which closes a hole the declaration alone would leave open:

1. **The declaration is an audit record and a request.** It is what the environment checks itself
   against, what the user sees, and what a reviewer reads later — never the thing that makes an
   act safe.
2. **Under-declaring is caught by enforcement, not by trust.** A tool that declares no network and
   reaches the network is stopped by the policy, and the attempt is a **finding** rather than an
   incident. This is a §3.6 test, and it needs a positive control: a tool that declares an
   allow-listed host and reaches it must **succeed**, or the test proves only that refusals work.
3. **Unenforceable means absent.** On a plain local machine, a capability the environment cannot
   enforce is not granted and the tool is not admitted there — so the honest answer to *"can this
   tool run here?"* is a property of the environment, not of the tool's optimism. A capability the
   platform cannot enforce is **absent, not promised**.

#### The loop that must never run ungated

k3 measured the inside of the harness: **a tool's self-declaration is the last word — there is no
sandbox there.** So the enforcement seam is not inside the harness at all; it is **who owns the
extension directory and who triggers `/reload`**. Therefore:

> **The model proposes tool source; the host reviews it, and the host reloads.** That is a Tier 2 act
> whose `resolved` is **the file content** — the resolved-plan rule applied to the highest-reach act
> in the system.

And the failure to name plainly, in k3's words: *"the one thing that must not happen is the loop
running ungated, because then the tool proposal — the act with the most reach in the whole system —
bypasses the only table meant to govern it."*

#### The substrate is a named thing, not "the toolchain"

The question gemini's review put to this section — *if a model writes a dynamic tool file, **what
executes it?*** — is the difference between an extension system and `eval` with a file browser. The
answer is now a named substrate with a declared flag set, and it is not a detail: on E1 the
substrate is **Wasm's import boundary** (free, and the strongest); on E2 it is **a capability-based
runtime that is invoked with an explicit permission set**, measured against the cases that matter
(`docs/evidence/substrate-20260919/RECEIPT.md`, with the probe alongside it):

- `--no-prompt` and `--no-remote` always; `--allow-read/-write` scoped to the execution root,
  **plus the host's resolve pass** because the substrate's path scope follows a symlink out;
- `--allow-net=<hosts>` only where the environment can back it, host-scoped (verified: one host
  answers, another is `NotCapable`);
- **`--allow-run`, `--allow-ffi` and `--allow-env` are never granted to model-authored code**;
- and a runtime whose permission model does not cover the network cannot be the substrate at all —
  Node's covers files and child processes, and lets `fetch` through.


---

### 1.8 E1-M0: when the browser environment can be said to exist

Not a build plan — a definition. The browser is the first environment (N11), so this is the first
thing that has to be real, and the enforcement table in §1.7 decides what is in it and what is
simply absent.

**It exists when all five of these are true:**

1. **A project can be created in OPFS and reopened after a reload** — a directory the user granted
   (handle persisted, re-acquired on return, which may need a click), registered with `placement:
   browser`, `capabilities`, `undoKind: written-file-list` (§2.1). "Create a project" works as a
   spoken or typed verb (N13).
2. **The tier table is data the code reads, and it is enforced in both directions** — a Tier 2 act
   refuses without an answer and proceeds with one.
3. **The audit is append-only and survives the reload** — an entry for every act *including the
   refusals*, carrying `(instance, project, root, turn)`. (Hash-chaining is an autonomy-stage
   requirement, §3.8, not an M0 one.)
4. **One tool runs end to end inside the root, and cannot reach the network** — with tests that
   show the refusals *and* a positive control that succeeds (§3.0's second habit).
5. **The page is the host.** Close the tab and the project is intact; reopen and it continues. If
   closing a tab loses the project, the environment does not exist yet.

**The one tool, and why it is that tool.** *Create an asset*: a name and content in, a file in the
project, the artefact rendered in front of him (N12). It is the smallest tool that exercises every
enforcement row — it writes inside a handle-scoped root and it must not reach the network — and it
is also the product's feel, so the first thing built is the thing he described.

**The row that decides the shape:** `network` is enforced by the realm's egress policy, and a
plain worker inherits the document's policy without losing ambient `fetch`. So the M0 tool runs as
a **Wasm module whose imports are the only interface it has** (§1.7: the import boundary, the
strongest of the four), which is also why the Wasm path is worth building first rather than last.

**Absent at E1-M0, and deliberately:** `exec` (no processes to spawn, §1.7); project-code egress
(no rule is admitted until the policy exists and is tested); the harness and the voice model (M0
is text, and k3's design is not a dependency of this environment existing); several live instances
(§2.3 is E2 and later); autonomy (§3.8 is a road, not a step).

**Three things the interface must say out loud, rather than letting the user infer them** — each
is an honest answer to something the platform does not promise:

- **"Grant access to continue" — but only for a *picked* directory.** Two different things were
  conflated here until astra caught it: an **OPFS** project (`navigator.storage.getDirectory()`) is
  **origin-private and needs no gesture at all** — measured at page load with
  `userActivation.isActive === false`: create, write and read back all succeeded — while a
  **picked** directory (File System Access, which is how a *window onto local files* is opened) is
  user-visible and its permission may need re-granting. So the peer project has **no** permissions
  dance; the picked-folder case has one, and *an unexplained gesture reads as a bug*.
- **The durability state of the project** — held persistently, or held until the browser decides
  otherwise. The browser may decline the request to persist, so the state is not decoration, it is
  the truthful answer to a question whose answer varies.
- **Which kind of undo this project has.** For an E1 project that is **`written-file-list`, not
  git** — a browser project is not a checkout, and yesterday's lesson applies directly: a project
  that may never have git must *know* which undo it has. The agent revising its own writes must be
  revertible by replaying the list, which is a different mechanism from a worktree and has to be
  said in those words.

**What not to ship, from today's evidence rather than from taste** — five ways the first
implementation can look finished and not be:

1. **Any outside string interpolated into HTML.** The skeleton executed `<img src=x onerror=…>`
   through three `innerHTML` sinks, one of them stored. Text nodes, or escaped; §3.5a.
2. **Containment by normalising.** `basename('..')` is `'..'`, so a "cleaned" name escaped the
   workspace. Resolve, compare, refuse — never tidy and proceed; §3.2.
3. **A bad frame that kills the worker.** Malformed JSON, an unknown type or a throwing handler
   must produce an error and an audit entry, with the worker still serving; §3.5a's second half.
4. **A capability admitted on its declaration.** A tool declaring `network: none` that calls
   `fetch` is stopped by the policy *and filed as a finding* — and the positive control must show
   an allow-listed host succeeding; §1.7, §3.6.
5. **A peer project whose world is invisible by accident.** *"This project lives in this browser
   only"* is a label, not a discovery the user makes after losing work; §1.1b.

**E1-M0 has no dependencies, and this is the list an implementer will read as one:** it needs
**neither the harness** (§1.1b's transport fact — no bridge, no pi, no k3 extension) **nor any
compliant-mode work** (§1.1a) **nor the server side** (§5). Its tools run in the page; the tier
table, the audit and the project records run in the same worker; that is the whole of it.

**Two things that could make it indefinable, and how they stand:** persistent storage is a
**request the browser may decline** — measured: `persisted()` is false by default and `persist()`
returned false on a plain origin — so the durability state is required rather than decorative; and
quota, which measured 10.7 GB here, is generous but not infinite. (The OPFS handle itself needs no
gesture, per the measurement above; only a picked directory does.) Whatever the server side turns
out to be (§5) is not needed for this — E1 stands alone, which is the point of it being first.

## 2. The local-project unit

### 2.1 What a project is

A project is a **declared directory** plus a session, and nothing more:

```jsonc
{ "id": "isocan",                      // short name, unique among registered projects
  "path": "/home/paulkinlan/isocan",   // a DECLARED location: a realpath on a machine, or the
                                       // name of an OPFS directory in an origin (§1.1b)
  "executionRoot": "/home/paulkinlan/isocan",  // the root THIS instance works in (§2.3/§2.4)
  "roots": [ "/home/paulkinlan/isocan",        // every root open on this project, one writer each
             "/home/paulkinlan/worktrees/isocan-walk" ],   // e.g. the phone session's worktree
  "undoKind": "worktree",              // git-branch | worktree | written-file-list | none (§2.4)
  "placement": "machine",              // machine | browser | remote  (§1.1b)
  "capabilities": ["read", "write", "exec", "wasm"],   // what `do` can mean here (§1.1b)
  "lastUsed": "2026-09-19T11:40:00Z",
  "harness": "pi",
  "sessionId": "ses_…",                // the harness session for THIS project
  "worktree": null }                    // set when the host keeps work recoverable (§2.4)
```

- **Identity is placement + location.** On a machine that means the realpath, so two paths to one
  checkout are one project. In a browser it means the origin plus the OPFS directory name — there is
  no realpath to compare, and no way for another placement to reach it, which is why `placement`
  is part of the identity rather than metadata about it (`isocan@phone` ≠ `isocan@box`, §1.1b).
- **`executionRoot` is the containment root**, and it is whatever the placement says it is — an
  OPFS directory handle in E1, a realpath on a machine — and it is not always the checkout: when the
  host
  works in a worktree (§2.4) that directory *is* the root for every containment check, every
  diff and every state message. Containment is always **relative to one root — the active
  project's execution root** — never the union of registered projects, or a nested or
  side-by-side project would hand the harness another project's files.
- **One writer per root; several roots per project.** Two writers on one tree is the failure this
  fleet already has evidence for — so the *root* is what serialises (§2.3), not the project. A
  project may have several roots open at once (his phone session's worktree and this chat
  session's), each with exactly one writer, and merging them is an explicit act.
- **`undoKind` is declared, not assumed.** A git project can hand the agent a worktree to break;
  a project with no git gets a written-file revert list; a project with neither says `none`, and
  the tiers narrow accordingly (§2.4).
- **"Create a project" is a verb (N13).** It makes a **new sandboxed root** in the current
  environment — a fresh OPFS directory, or a new directory on the machine — distinct from every
  other project, with its own session, audit and undo scope.
- **Awareness is registry metadata, not filesystem access.** A new project *knows the others
  exist*: the registry is readable, so it can reason about what is local and can ask. Reading
  another project's **files** is still contained (§3.2, Tier 0 relative to its own root) unless he
  confirms an explicit act — because "it knows about them" is a feature and "it can read them" is
  a hole.
- **No discovery.** The host never scans the filesystem for repositories; a directory becomes
  a project when it is declared. (This is the same rule as the cwd fix: the machine's layout
  is never assumed.)
- **Removal is dropping a record**, never touching the directory.

### 2.2 Open, activate, detach, close

| Act | What happens | What does not happen |
|---|---|---|
| **open** | on a machine: verify the path exists and is a directory, resolve realpath. In a browser: take the OPFS directory (origin-private, no gesture) or a picked handle. Register, then create a session lazily on first use | nothing is cloned, scaffolded or modified |
| **activate** | the active project changes; the UI is told the new state | other projects' sessions are untouched |
| **detach** (implicit, on switching away) | the session stays alive and resumable | **no process is killed** for switching |
| **close** | the session is ended explicitly; processes the host started for it are stopped | files are untouched by closing |

"Open" attaches to what the developer already has. Creating a new project (scaffolding,
cloning) is a later milestone and a **confirmed** act, because it writes outside an existing
root by definition.

### 2.3 Several at once: the unit of serialisation is the execution root

> *"If I'm on my walk, an instance of the web page, and your instance in the chat session"*
> — Paul, 2026-09-19

Two live agents on **one project** at the same time. The earlier version of this section said
*serial within a project, parallel across projects*, reasoned from the voice channel being
serial — and that premise is now false: there are **several conversations**, so the serialisation
cannot be the project.

**What actually must not interleave is a change to the same working tree.** So:

| Unit | Rule |
|---|---|
| **Execution root** (§2.1) | **Exactly one writer at a time.** This is the only thing that serialises, because it is the only thing that can be corrupted by interleaving |
| **Project** | A container of roots, sessions and history. Several roots may be active concurrently — that is what makes the walk work |
| **Session** | One per **(instance, root)**. A session is a conversation, and two instances are two conversations; they must not resume each other's harness session |
| **Reads (`ask`)** | Never serialised anywhere. Any number of instances may read the same project |
| **A resolved plan** | Not serialised, but **ordered**: plans in different roots run concurrently; plans in one root queue behind the root's writer |

So Paul's scenario works by construction: **his phone session and this chat session each get
their own execution root** (their own worktree, §2.4) inside the same project. They work at the
same time, on the same project, without touching each other's files — and the way their work
meets is an ordinary merge he can see and refuse.

**Where a second root is impossible** — a non-git project, where the only root *is* the checkout
— the rule degrades honestly rather than silently: the second instance may **read and propose**,
and its writes **queue** behind the current writer, with the UI saying which of the two it is.
Two writers, one tree, is the failure this fleet already has evidence for; a queue is cheap, and
hiding it would not be.

#### What two writers change about the machinery

- **Confirmations.** A question is bound to an (instance, project, root, plan). It may be
  answered from **any live instance of the same project** — walking home, the phone is what he
  has — but the *answering instance* is recorded, and the `via` provenance rule (§3.4) is
  unchanged. A confirmation is never answerable from a *different* project, and never from the
  voice model.
- **Undo scopes are per root.** "Undo everything the agent did" means everything in *one*
  worktree; combining two roots is an act (a merge) rather than an undo.
- **The audit log has more than one writer, and this is where append-only earns its keep.** Every
  entry carries `(instance, project, root, turn)` and a **per-instance monotonic sequence** as
  well as a wall clock — because there is no global total order across two machines and pretending
  otherwise would produce a log that looks authoritative and is wrong. Readers order by instance
  sequence and treat the wall clock as a hint.
- **State must say who else is here.** Any instance showing a project shows the other live
  instances and which root each holds — the UI half of a rule that exists for safety reasons.

#### Still serial, and by design

- **One voice channel per instance.** You can only be talking to one agent at a time, and an
  instruction means the instance's active project unless it names another. Ambiguity asks rather
  than picks.
- **Two writers on one root**: never.

### 2.4 Separability, and keeping work cheap to undo

- **cwd**: on a machine, every turn runs with the project's realpath as its declared cwd; in a
  browser, the turn is scoped to the OPFS handle. Either way the harness cannot
  wander into another project because it is never told about one.
- **Session isolation**: one harness session per **(instance, root)** — two instances must not
  resume each other's conversation, and context must not bleed between roots or projects.
- **Recoverability**: work the agent does unprompted (Tier 1) is **kept reversible** — for a
  git project the host may work in a branch or a worktree, so "undo everything the agent did
  this evening" is one command and never a conversation. Where the project is not a git
  repo, the host records the files it wrote so a revert list exists.
- **Every project declares its undo kind, and the UI says which one it has.** *"We got worlds where
  you may never have git available"* — so this is a requirement rather than a hedge:
  `git-branch` (work on a branch), `worktree` (the agent gets its own checkout, the default for
  git projects), `written-file-list` (no git: the host records every file it wrote, and undo
  replays that list), or `none`. **The tiers scale with it**: with no undo at all, the unprompted
  scope narrows to acts that are reversible *by their nature* (running tests, reading, drafting
  changes for review), because Tier 1's promise — "cheap to undo" — would otherwise be false.
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

### 3.0 The rule the rest of this section is built on

**A guard must be a mechanism, not a description.** Written once it sounds like a slogan; written
three times in one day, in three different costumes, it is the thing to check every claim against.
All three of these are in this document:

| The claim | What looks like a guard | What is actually a guard |
|---|---|---|
| "It cannot leave the project root" | `path.basename(name)`, `join`, `normalize` — rewrites that happen to look correct, and `basename('..')` is `'..'` | `realpath(candidate)` resolved and **compared** against the root, refusing on any answer but yes (§3.2) |
| "Nothing outside can run in the page" | `connect-src`, which restricts what a page may **reach** | `script-src` without `'unsafe-inline'`, which restricts what it may **execute** — different jobs, and only one stops the attack (§3.5a) |
| "This tool cannot reach the network" | the tool's own declaration, `network: none` | the interface the tool is **given**, plus the realm's egress policy — the declaration is a record, never the enforcement (§1.7) |
| "Nothing dangerous is imported or evaluated" | a **regex** over source text — CAP's first evaluator gate was text-only and **missed eight live alias sites** | an **AST**: the thing that sees what the text *means*, not what it spells |

Two habits follow, and they are the reason this section is written the way it is:

- **Ask what enforces it, not what states it.** If the answer is a comment, a descriptor, a
  variable name or a helper that tidies input, there is no guard yet.
- **Give every authority one home, or record why it has none.** CAP grew **three digest verifiers in
  three places** before anyone noticed, found by mutation rather than by review. An authority with
  several homes has none: if two places can decide the same thing, the property is whatever the
  weaker one allows and nobody owns the difference. A day-one rule, not a cleanup.
- **Test in both directions.** A suite of refusals proves nothing until one request *succeeds* —
  the containment test needs `..` as a **name** as well as a path segment, and the capability test
  needs an allow-listed host actually reached. Otherwise the test proves that refusals work, which
  is not the property anyone wanted.

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
**It is also the destination Paul wants** (*"in the long run I want to get to full autonomy YOLO
mode... I hate having to have permissions"*) — so it is a design that gets built, not a corner:
§3.8 is the path to it, and it is a path rather than a switch on purpose.

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
| Creating a symlink whose **target** resolves outside the execution root | containment checks the link target as well as the link's location, before creation — **and, because a dynamic tool can create such a link inside its own writable root, the host re-resolves the root and refuses the run when one points out** (measured: a substrate path scope alone is defeated by exactly this) |
| Touch credential material (`~/.ssh`, `~/.config/**credentials**`, keychains, browser profiles, `.env*`, service-account files) | path + pattern deny-list, applied to reads as well; matches are reported, never echoed |
| `sudo`, `su`, machine-wide config changes, global package installs | command classification before execution |
| Kill processes the host did not start | the process journal is the only source of pids it may signal |
| `curl … \| sh`, or any fetch-and-execute of remote code | command classification (fetch + interpreter in one pipeline) |
| Send anything to the network from the host itself (exfiltration surface) | the host makes no outbound requests; the harness does what its own tools do, inside a project |
| Publish, deploy, spend money, message a human | these are **Tier 2** — but a Tier 0 blanket ban applies when the instruction arrives from *content* rather than from Paul (§3.3) |

**Resolving is not rewriting, and normalising is not checking.** The skeleton demonstrated the
failure mode in forty lines: its containment was `path.basename(action.name)`, which is not a
check but a *side effect* — `path.basename('..') === '..'`, so `path.join(workspace, '..')` is the
parent directory and a transcript of *"create a file called ../../../tmp/evil.sh"* resolved
somewhere else entirely. A containment rule is only a rule when it **resolves the real path and
refuses** — it must never "clean up" an input and then proceed, because the cleanup is what
produced the escape. `basename`, `join`, `normalize` and `replace('../', '')` are rewrites; the
check is `realpath(candidate)` compared against the root, and its answer is yes or no.

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
| Audit | an append-only file | **IndexedDB in the same worker**. Mirroring it to a machine host is **not free and not automatic**: it is the page sending data out, which is a Tier 2 egress act (§3.5a) — so a peer world's audit is the record *for that world*, and a paired host's audit the record for its own |
| Durability | the filesystem he can look at | OPFS, which a browser may evict. A peer project therefore requests persistent storage (`navigator.storage.persist()`), **shows its durability state**, and can be **exported as an archive in one act** — the mitigation that makes peer mode acceptable rather than a hostage situation |

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
- it refers to a project this instance is bound to, and arrived **after** the question (≤ 30 s window);
- the answering instance is recorded on the audit entry (§2.3) — any live instance of the same
  project may answer, because walking home the phone is what he has;
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

#### The renderer is a sink, and that is the other half of the same policy

Driving the skeleton (2026-09-19) proved this one rather than arguing it: **`<img src=x
onerror=...>` typed into the page's own text field executed**, through three separate `innerHTML`
sinks — the transcript echo, the server's own error and note strings, and an action's file name,
which makes that one **stored** as well as reflected. Two things follow.

- **The policy has to cover scripts, not only connections.** A CSP that restricts `connect-src`
  does nothing about `onerror=`; the browser placement needs **`script-src` without
  `'unsafe-inline'`** (and no `unsafe-eval`), alongside the egress allow-list. Restricting what a
  page may reach and what it may execute are two different jobs, and the second is the one this
  surface is actually attacked through.
- **Nothing that arrives from outside is ever rendered as markup.** The transcript (voice is
  untrusted by §3.1, so this is not a surprise — it is the same rule applied one layer up), the
  host's own error and note strings, file names, repository content, and the harness's output all
  reach the renderer from outside it. They are text: inserted as text nodes, escaped if they must
  become markup, never interpolated into HTML.

#### The host survives a bad turn

The same drive found the request path had no error handling, so a malformed input was a **remote
kill** rather than an error. On a machine that is a dead host; in the browser placement it is a
dead **worker holding the project**. So it is a named property, checked in §3.6 rather than
assumed: any frame — malformed JSON, unknown type, a handler that throws — produces an error
message and an audit entry, and the worker restarts with its OPFS project intact. A turn that can
end the session is not a turn, it is a crash with a chat interface.
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
- **Path tests**: `..` escapes, symlinks pointing out of the root, and absolute paths elsewhere —
  each refused on the resolved path. **Including `..` as a *name*** rather than a path segment
  (`path.basename('..')` is `'..'`, the case that walked out of the skeleton's workspace), because
  that is the shape a normalising implementation gets wrong while looking correct.
- **Host-survives tests**: malformed JSON, an unknown message type, a frame with a missing field
  and a handler that throws — each yielding an error and an audit entry with the host (or the
  browser worker) still serving the next request.
- **Substrate tests (§1.7)**: read inside the root **succeeds**; read outside, a symlink pointing out, `Deno.env`, `dlopen` and a remote dynamic import are each **refused by the substrate's own word**; `--allow-net=<host>` reaches that host and another is refused; and with no flag set, everything is `NotCapable` — the default-deny posture is itself the positive control's counterpart.
- **Capability enforcement tests (§1.7), both directions**: a tool that **under-declares** —
  descriptor says no network, the code calls `fetch` — is stopped by the policy and recorded as a
  finding; and a tool that declares an allow-listed host and reaches it **succeeds**, because a
  suite of refusals proves nothing until one request is allowed. Plus the admission check itself:
  a tool declaring a capability the environment has **no mechanism** for is refused rather than
  run.
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

### 3.8 The road to autonomy

> *"In the long run I want to get to full autonomy YOLO mode, cuz that's how I work. I hate having
> to have permissions."* — Paul, 2026-09-19

§3.2's principle stands — it is a second design, not a setting — and this is that design, written
as a **path** rather than a switch, because every precondition below is a property of the
*environment* rather than of the model's trustworthiness.

**Autonomy is not "Tier 2 becomes Tier 1".** It is: **the confirmation gate is replaced by
reversibility and blast-radius controls.** Nobody is there to say no, so the safety has to come
from the act being undoable, or from its consequences being contained. That reframing is what
makes the preconditions listable.

#### Preconditions — all four, before a project can be autonomous anywhere

1. **A disposable environment.** The agent's root lives somewhere with nothing else in it: no
   credentials present to steal, no other projects, no LAN, no personal files. The browser
   placement (§1.1b) is intrinsically closer to this; on a machine it means a container or VM with
   the project mounted and little else. **Tier 0 does not vanish — it becomes structurally
   satisfied**, which is precisely why the sandbox is the precondition rather than a nicety.
2. **Every in-scope act is reversible.** Work in a worktree or branch, a commit per step, a trash
   instead of `rm`, and no history rewrites inside the scope. `undoKind: none` (§2.4) means the
   project is not a candidate, because reversibility is the thing replacing consent.
3. **Caps, with automatic stops.** Tokens per window, wall clock per turn and per day, disk
   growth, process count. A runaway that is reversible is still a runaway.
4. **An outer stop.** The host can stop the agent — and **Paul can stop the host**, from outside
   anything the agent can reach. A kill switch that the thing being killed can decline is not one.

#### What changes when it is on

- **No confirmations.** The audit becomes the *only* record, so it has to be one worth trusting:
  append-only, every entry carrying `(instance, project, root, turn)`, and **hash-chained** so a
  later reader can tell it was not rewritten. That is cheap, and without it "what did it do while I
  was out?" has no answer.
- **The undo rules take the gate's place.** Work is committed, revertible, and never destructive
  by construction — the same three properties that made Tier 1 safe, now covering Tier 2's acts.

#### What is irreversibly different

A mistake is discovered **after** it happened. Prevention is gone; the design's job becomes damage
control — and that is fine for most acts, but **not for the ones with no undo at all**: pushing to
a shared remote, sending a message to a person, spending money, deleting something outside the
reversible scope. So autonomy carries a **deferred-approval queue** rather than an exception: the
agent proposes those acts, records them, and **carries on with other work** — which is how autonomy
actually functions in practice, and it means "no permissions" does not have to mean "no judgement
about consequences".

#### How a project arrives there

1. **Standard mode.** Everything asks. The host records what it asked about, and what the answer
   was.
2. **Dry-run autonomy.** The host reports the pattern — *"in the last two weeks, 94% of
   confirmations were yes, all of four kinds, all inside the worktree"*. Evidence, not vibes, and
   it costs nothing but a report.
3. **A named scope, granted deliberately.** Not a toggle: which kinds of act, which paths, which
   spend ceiling, which window — **expiring by default**, renewed by a decision rather than
   assumed.
4. **Reviewed, and self-narrowing.** The scope narrows automatically on any attempt to leave it:
   a Tier 0 refusal attempt inside an autonomous run is evidence the scope is wrong, not noise to
   be filtered.

#### The anti-pattern, stated plainly

**Autonomy on a machine that is not disposable is not autonomy — it is the same risk with the
alarm disconnected.** The placement table in §1.1b already gives the answer: run it on a
disposable box, or in the browser over OPFS, where the sandbox is the platform's rather than ours.

---

## 4. What I need from the other lanes

**From astra (interface):** the reference is isocan's voice agent, not a debug view (N12) — his
words about the bare skeleton were that it looks *"terrible"*, and he wants **assets appearing as
they are created**, *"not too explicit"*. That is a direction rather than a spec: the environment's
job is to make things **materialise** (progress → artefacts in front of him), and the interface's
job is the same one isocan solved. Everything below still holds. Plus: every project must show
**which world it is in** — *"this project
lives in this browser only"* versus *"this project lives on <machine>; all your sessions can see
it"* — because that is the sentence that stops work being lost, and it is the peer/window
distinction from §1.1b rendered where the user meets it. Plus: the confirmation UI must render
`confirm_request.resolved` (paths, counts, effects) rather than the spoken words, and must be able to answer **typed/clicked**
when `source: "content"`. **And treat every string from outside the page as text, never markup** —
the transcript, the host's error and note strings, file names, repository content and harness
output: this is the sink that the skeleton's own drive proved (§3.5a), and it is your lane's
half of the browser placement's security. Three additions from the concurrency model (§2.3): show **who else is
working on this project** and which root each instance holds; show the project's **`undoKind`**
(and the narrower behaviour when it is `none`); and show **placement + capabilities + mediated
flag**, because those are part of what the user is being promised. Everything else in §1.5 is
yours to shape.

**From k3 (harness):** one adapter; `session/new|load|prompt` with a **declared cwd**;
streaming `session/update`; and a real `session/request_permission` for acts outside the
project so the host can gate them. If the harness cannot emit permission requests, the host's
Tier 2 must be implemented as a wrapper around the tools it offers instead — worth knowing
early, because it changes where the gate lives. Two additions from §1.1b: the harness should
**declare the capabilities it has in a given placement** (`exec`, `wasm`, `network`), and it
should run in **at least the machine placement and the browser placement** — if those cannot
share one adapter, say so early, because that is a second harness rather than a second setting.
Third: §2.3 requires **several concurrent sessions in one project, each with a different cwd**
(the phone's worktree and the chat's) — if the harness is one-session-per-process, the first
question I need answered is how concurrency is expressed, because the environment depends on it.
And fourth, which the substrate finding makes urgent: **does the harness run its tools in-process
or through a substrate it can scope?** If a harness executes model-authored tools inside its own
privileged process, then mediated mode (§1.1a) cannot be built on top of it, and the environment
needs the tool boundary rather than the harness boundary. That is now the most load-bearing
unknown in this document.

**From whoever builds the first environment (browser) and the local one:** the core — project records, the tier table, capability lists,
the audit writer, path resolution — must be **pure data and small functions with a narrow
dependency surface**, because the same code has to run in a machine process *and* in a page
worker, and a core that can only run in one of them becomes two implementations that drift.
qwen2's harvest found a precedent worth reusing rather than rewriting: isocan's
`packages/voice-agent/src/live.ts` is 1,173 lines of pure data and functions shared between the
browser module and the harness, with nine dependencies doing the work. And a capability rule from
the same harvest: a Wasm tool is a capability only when its descriptor is **admitted** — CAP's own
store currently holds 9 descriptors that are all `admitted: false`, so taking the *format* (three
fields: `capabilities`, `replayClass`, `bounds`) and the fails-closed convention is the lift;
budgeting by **cold-start milliseconds**, not megabytes. And the extension seam of §1.6a is the
place where N10 and N11 meet: **a registration is a declaration and admission belongs to the
environment**, so the registry has to exist early — a tool that cannot say what it needs cannot be
safely admitted, and a model-authored tool that is not declared is not a capability. **For every
capability, name the mechanism that enforces it, or the tool is refused** (§1.7): "enforced" is the
only answer that makes the extension system a platform rather than a permissions form.

**From Paul:** the decisions in §5 (now five) — plus one thing he named as unresolved that this
document deliberately does **not** answer.

**Open, and kept open: the server side.** *"I don't know how to deal with the server side of
things... we also have access to an environment that is on the server."* What is unresolved is not
the transport (E3/E4 above describe that) but the **trust and ownership questions**: whose machine
it is, who else can see the files, what the agent may do there that it may not do locally, and how
a project on a server relates to the same project on his laptop. A design that quietly answered
those by assuming a shape would answer them wrong — so they are recorded as questions with a
placeholder, and E3/E4 are marked later rather than assumed.

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

**4. The walk: a peer project in the browser, or a window onto a host?**
OPFS is per-origin and per-browser-profile, so a browser project is **not visible to any other
session** — including the one he talks to over Telegram. That makes this two products, not one
setting:
- **(A) always through a host** — the browser is a client, and everything he makes is his;
- **(B) a peer world in the page** — self-contained and offline-capable, **and invisible
  everywhere else**;
- **(C) both**: whichever reaches what he is doing, chosen per project and labelled.

**Recommend C, and proceed on C** — because his walk works in both, and the difference is not
convenience but **whose history it is**: the window shape keeps every session looking at the same
project, the peer shape keeps working when nothing is reachable but the history lives in one
browser profile. So: **window by default wherever a host is reachable, peer where he asks for it**,
with the UI saying which one a project is, and a one-act export for a peer so eviction cannot
strand it. Trade-off: the peer shape is the only one where *"the agent you talk to from your walk
cannot see it at all"* is the intended behaviour rather than a fault — which is exactly why it
must be labelled rather than inferred.

**5. Autonomy's first stage: dry-run, or straight to a named scope?**
Options: (A) grant a scope when he asks for it; **(B) run dry-run autonomy first — everything still
asks, the host records the pattern, and the first scope is proposed from that evidence**;
(C) something else he has in mind.
**Recommend B, and proceed on B**: it costs a report rather than a permission and it turns the
first scope from a guess into a reading, which matters precisely because the act it unlocks has no
gate behind it. Trade-off: it delays the thing he actually wants by the length of one honest
report. Options A and C are one word each, and §3.8 is the rest of the path either way.
