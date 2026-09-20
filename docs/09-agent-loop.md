# The agent loop

What actually runs when a person speaks or types a turn. Six questions, in the order they happen:
**what starts a turn → what decides → who executes → where the result goes → what gets recorded → where it can fail.**

> **Reading rule for this page.** It names the *mechanism* (`the resolver seam`, `the executor the server calls`),
> and gives paths only where the path is the stable identifier. Paths move; the seam does not. Where the reader
> needs to check a claim, the check is a **route** or a **file in the active root**, not a line number.

## 1. What starts a turn

Two doors, one route:

- the **composer** in the page (typed, or sent from the pinned window) — a form submit;
- the **live voice session**, whose transcript can be turned into a turn.

The route takes one string and nothing else. There is no session id, no conversation history and no
per-connection state in it: **a turn is stateless by construction**, and the state that persists is the audit
and the files in the root.

Both land on **`POST /api/turn`**, which carries **`{ transcript }`** — not `text`; asking with the wrong field
answers `{"error":"empty transcript"}`, which is how this page learned it — and answers with the result of the
loop below:

```json
{ "transcript": "create a file called hello.txt with hi",
  "action":  { "verb": "write", "name": "hello.txt", "content": "hi" },
  "result":  { "ok": true, "action": "wrote hello.txt (2 bytes)", "file": "hello.txt", "root": { … } } }
```

*(Driven: a command typed in the picture-in-picture composer reaches this route and its refusal text arrives
back on the page — that is what the "list files" case shows when no root is declared.)*

**The live session does not resolve anything by itself.** It carries audio and text; the turn route is what
decides and executes. Treating the live connection as the agent would be a reasonable reading of the UI and it
is not what the code does.

## 2. What decides

**The resolver seam** — `lib/resolver.mjs`. A resolver turns a transcript into an **action**:

```
{ verb, name, content? }        // something to do
{ unresolved: "why not" }       // nothing to do, and the reason
```

- resolvers are **registered by name** (`registerResolver`), and `resolveTurn(transcript, provider)` asks one;
- the provider defaults to the one named at the route, and an unknown name is an **explicit** unresolved
  answer rather than a silent fallback;
- **the server never parses language itself.** That is the point of the seam: swap the decider, keep the
  executor.

**Wired today:** the **`script`** resolver — a small set of verbs with no model. It can build a *tool proposal*
from an utterance (`make-tool`), read, write, list, and invoke a tool by name.
**Not wired:** a model-backed resolver. The seam accepts one; nothing registers one.

## 3. Who executes

**The executor in the server** — the one place that touches the build environment. It is a cascade of
decisions, and each branch reports its own refusal rather than throwing:

- a **tool proposal** is recorded as a *proposal* — and is **not loaded**; loading is a separate admission step;
- an **invocation** goes to the extension runtime (admission, bounds, budget), which may answer **refused**
  with a reason;
- **list / read / write** are resolved **inside the active root** first — the path is checked against the root
  before anything is touched.

## 4. Where the result goes

- back on the **turn response** (`{ ok, action, … }`, or a refusal with `refused` and `why`);
- into the **active root** as a file, for the verbs that write;
- and when a call goes to a tool, through the **channel contract** (`lib/channel.mjs`), whose answer shape
  includes a **refusal with a reason** — a tool that declines is a result, not an exception.

## 5. What gets recorded

**The audit**, written into the **active root** (not into the product's own tree, and not into whatever
directory the process happened to start in). It lands in **`.audit/`**, one file per root kind —
`.audit/machine-<hash>.jsonl` — and the first entry of a turned-on write, as measured, is:

```json
{"kind":"act","seq":1,"instance":"machine",
 "actor":{"name":"voicebox-server","harness":"voicebox","session":null,"cwd":"…"},
 "project":"vb-root-PzPF","root":"…"}
```

An entry is built by the audit module's constructor, serialized, and merged by sequence number, so a resumed
process continues the numbering rather than restarting it.

Refusals are recorded too, where the attempt had a target — the record is what happened, not only what
succeeded.

## 6. Where it can fail — and what the failure looks like

| failure | what the person sees |
|---|---|
| no root declared | a refusal naming the root as the cause, with a `declared: false` fact on the health route |
| the root vanished mid-session | a refusal naming the root, distinct from "no root declared" |
| a path outside the root | a refusal from the reachability check, before anything is touched |
| nothing to do | the resolver's own `unresolved` sentence |
| a tool declines | a refusal with a reason, through the channel contract |
| a tool proposal | recorded, **not loaded** — and it says so |

## Wired today, at a glance

| part | state |
|---|---|
| `POST /api/turn` → resolver → executor | **wired** |
| the `script` resolver and its verbs | **wired** |
| audit of acts and refusals into the active root | **wired** |
| tool invocation through the extension runtime | **wired** |
| the live voice session carrying audio/text | **wired** |
| a model-backed resolver | **not wired** (the seam accepts one) |
| loading a proposed tool | **not wired** — an admission step, and it is named rather than implied |

## How to check any of this in a minute

- `GET /api/health` — the root facts the refusals are built from.
- **The whole loop in three requests** (measured, on a declared root):
  - `{"transcript":"list files"}` → `action {verb:"list"}` → `result {ok:true, files:[…], root:{…}}`
  - `{"transcript":"create a file called hello.txt with hi"}` → `{verb:"write"}` → the file in the root
  - `{"transcript":"book me a flight to Lisbon"}` → **`action: null`**, and the resolver's own sentence:
    *"the script resolver only knows create/read/list — got: … Wire a model resolver to go further."*
- The `.audit/` file in the root — the same turns, as they were recorded.
- The active root's audit — the same turn, as it was recorded.
