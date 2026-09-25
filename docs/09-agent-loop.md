# The agent loop

What actually runs when a person speaks or types a turn. Six questions, in the order they happen:
**what starts a turn → what decides → who executes → where the result goes → what gets recorded → where it can fail.**

> **Reading rule for this page.** It names the *mechanism* (`the resolver seam`, `the executor the server calls`),
> and gives paths only where the path is the stable identifier. Paths move; the seam does not. Where the reader
> needs to check a claim, the check is a **route** or a **file in the active root**, not a line number.

## 1. What starts a turn

Two doors, two paths:

- the **composer** in the page (typed, or sent from the picture-in-picture window) — lands on **`POST /api/turn`**, which carries **`{ transcript }`** and returns the action and execution result;
- the **live voice session** (`/live`), which streams PCM audio back and forth with the model (Gemini Live or OpenAI Realtime). When the live model requests an action, its tool calls (`toolCall`) are mapped via `commandToAction()` directly into the shared executor on the server, and tool responses stream back to the model over the socket.

A typed turn on `POST /api/turn` takes one string and nothing else:

```json
{ "transcript": "create a file called hello.txt with hi",
  "action":  { "verb": "write", "name": "hello.txt", "content": "hi" },
  "result":  { "ok": true, "action": "wrote hello.txt (2 bytes)", "file": "hello.txt", "root": { … } } }
```

There is no session id, no conversation history and no per-connection state in the turn route: **a turn is stateless by construction**, and the state that persists is the audit and the files in the root.

*(Driven: a command typed in the picture-in-picture composer reaches this route and its refusal text arrives back on the page — that is what the "list files" case shows when no root is declared.)*

The live voice session and the typed turn route share the same executor; they differ in how actions are prompted and resolved.

## 2. What decides

**The resolver seam** — `lib/resolver.mjs`. A resolver turns a transcript into an **action**:

```
{ verb, name, content? }        // something to do
{ unresolved: "why not" }       // nothing to do, and the reason
```

- resolvers are **registered by name** (`registerResolver`), and `resolveTurn(transcript, provider)` asks one;
- the provider defaults to the one configured on the server, and an unknown name is an **explicit** unresolved
  answer rather than a silent fallback;
- **the server never parses language itself.** That is the point of the seam: swap the decider, keep the
  executor.

**Registered resolvers today:**
- the deterministic **`script`** resolver — handles `write`, `read`, `list`, `make-tool`, `tool`, `delete`, `edit`, `diff`, `grep`.
- the model-backed **`gemini`** resolver — turns arbitrary language into structured actions via the Gemini API (`GEMINI_API_KEY`). When the key is missing, it returns an explicit unresolved answer (`"the gemini resolver has no GEMINI_API_KEY"`).

## 3. Who executes

**The executor in the server** — the one place that touches the build environment. Both the typed turn route (`POST /api/turn`) and the live voice session (`/live`) dispatch actions through this shared executor (`execute(action)`):

- a **tool proposal** is recorded as a *proposal* under `proposals/` — and is **not loaded**; loading is a separate admission step;
- **loading an extension** is an explicit host-authorized admission step (`POST /api/extensions/admit` with the host token, or `POST /api/extensions/approve` with a single-use console code from `tools/approval-code.mjs`);
- an **invocation** goes to the extension runtime (admission, bounds, budget), which may answer **refused** with a reason;
- **list / read / write / delete / edit / grep** are resolved **inside the active root** first — the path is checked against the root before anything is touched.

## 4. Where the result goes

- back on the **turn response** (`{ ok, action, … }`, or a refusal with `refused` and `why`);
- into the **active root** as a file, for the verbs that write;
- and when a call goes to a tool, through the **channel contract** (`lib/channel.mjs`), whose answer shape
  includes a **refusal with a reason** — a tool that declines is a result, not an exception.

## 5. What gets recorded

**The audit**, written into the **active root** (not into the product's own tree, and not into whatever
directory the process happened to start in). It lands in **`.audit/`**, one file per root kind —
`.audit/machine-<hash>.jsonl` (or the page-owned log).

A successful write records **two entries**:
1. an `attempt` entry (`decision: "attempt"`, `result: "pending"`);
2. an `allow` outcome entry (`decision: "allow"`, `result: "ok"`), linking back to the attempt's sequence number (`attempt: 1`).

Pre-flight refusals (such as `outside-root` or `root-not-declared`) record a single refusal entry without an applying attempt.

Entries are built by the audit module's constructor, serialized, and merged by sequence number, so a resumed
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
| the `script` deterministic resolver | **wired** |
| the model-backed `gemini` resolver | **registered** (requires `GEMINI_API_KEY`) |
| `/live` provider tool calls → shared executor | **wired** (Gemini Live & OpenAI Realtime) |
| audit of attempts, outcomes, and refusals into the active root | **wired** |
| tool proposal (`make-tool`) | **wired** (staged under `proposals/`) |
| host-authorized tool admission | **wired** (token-gated or one-time code via `tools/approval-code.mjs`) |
| tool invocation through the extension runtime | **wired** |

## How to check any of this in a minute

- `GET /api/health` — the root facts the refusals are built from.
- **The whole loop in three requests** (measured, on a declared root):
  - `{"transcript":"list files"}` → `action {verb:"list"}` → `result {ok:true, files:[…], root:{…}}`
  - `{"transcript":"create a file called hello.txt with hi"}` → `{verb:"write"}` → the file in the root
  - `{"transcript":"book me a flight to Lisbon"}` → **`action: null`**, and the resolver's own sentence:
    *"the script resolver only knows create/read/list — got: … Wire a model resolver to go further."*
- The `.audit/` file in the root — the same turns, as they were recorded.
- The active root's audit — the same turn, as it was recorded.
