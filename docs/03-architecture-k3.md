# 03 — Harness architecture (k3)

The harness half of the brief, with the three checks reproduced rather than described.
Where it disagrees with `02-environment.md` §1.4 it says so plainly; §1.4 is a contract,
so a mismatch is a PR note, not a workaround.

## 0. The checks, because everything else sits on them

| # | Question | Answer | How it was established |
|---|---|---|---|
| C1 | Does the pi harness run **Fable** here, today? | **Yes — through the Claude Code provider.** Not through the direct Anthropic API. | Driven, not read (§3.1) |
| C2 | Does the harness emit a real `session/request_permission`? | **The protocol path exists and is wired end-to-end. The pi harness never produces it for ordinary tool calls.** | Driven twice (§3.2) |
| C3 | Do tool calls route through a host gate, or is containment the harness's choice? | **The harness's choice, for pi's built-in tools.** The host's gate exists only where the host owns the tool surface. | pi's own security doc + the same drives (§3.3) |
| C4 | Can one adapter serve the machine and browser placements? | **Not as a process. As a topology — and that topology already exists.** | pi-acp's spawn + the CAP bridge (§3.4) |

None of these is assumed. Each section below carries the command and the observed output.

---

## 1. The harness: what "only got pi harness" means here

> "I'm really inspired by the pi harness where it's only got pi harness."

The pi harness is one agent process with one model interface and its own tools — no adapter
zoo between the user and the machine. Translated into a browser-fronted system, the minimal
shape that keeps that property is:

```
voice in ──► voice model ──► the host ──► THE HARNESS (pi) ──► the machine
                  (proposes)  (disposes)     (one process,        (real files,
                             one long-lived   one declared cwd)   real commands)
                             local process
```

**One harness (pi), one protocol (ACP-shaped JSON-RPC), two transports.** That is the
whole claim:

- **The harness is pi.** Not a framework wrapping pi. The harness keeps pi's own tools,
  its own model registry, its own session semantics. Anything the harness can do, pi can do;
  anything pi cannot do is the host's problem, explicitly named (§3).
- **The protocol is ACP-shaped JSON-RPC** — the shape `02-environment.md` §1.4 writes,
  which is the shape the CAP bridge already runs in production. Not a new protocol.
- **Two transports, one harness.** Machine placement: stdio to `pi --mode rpc` (what
  pi-acp spawns). Browser placement: WebSocket to the bridge, which hosts the same pi child
  on the machine. §3.4 is the proof this is already working, not a plan.
- **The thinnest version that works** has four parts and no fifth: the harness (pi), the
  transport (the bridge), the host (one process owning projects/sessions/confirmations/audit),
  and the voice front end (which *proposes* — never disposes). The pi harness's minimalism is
  preserved by *not* putting an adapter zoo between the harness and the model or between the
  harness and the machine: the only components added are the ones the browser and the voice
  model force into existence.

### The seams (who owns what)

| Seam | Owner | What crosses it |
|---|---|---|
| harness ↔ machine | **the harness (pi)** | real files, real commands, real processes — with the pi process's own permissions |
| host ↔ harness | **the host** | ACP JSON-RPC: session lifecycle, prompts, updates, permission round-trips, cancel |
| voice ↔ host | **the voice model** | proposals: transcript events, intent candidates, "the user seems to want X" |
| host ↔ machine | **the host** | the project record: declared directory, git state, undo kind, process journal |
| host ↔ UI | **the UI (astra's lane)** | conversation state, confirmation cards with structured plans, audit views |

The load-bearing property: **voice never reaches the harness directly.** Audio and ASR are
untrusted input; the harness's authority comes from the host, and the host's authority over
the harness is *exactly* the §1.4 contract — no more.

## 2. Model extensibility, as a principle

> "extensible model, extensible platform"

There are two model footprints in this system, and extensibility means something different
for each. Keeping them apart is what makes either swappable without rewriting the harness.

### 2a. The voice model (Gemini 3.8 Live + live thinking first, OpenAI realtime alongside)

The voice model's job is narrow: **audio in, audio out, transcript events, and intent
candidates out.** It does not execute. It does not hold authority. It is a provider behind a
small streaming interface:

```ts
interface VoiceModel {
  start(session: { audioIn: Stream<AudioChunk>; onTranscript: (e: TranscriptEvent) => void;
                   onIntent: (i: IntentCandidate) => void; onAudioOut: (a: AudioChunk) => void }): VoiceSession;
  // VoiceSession: sendAudio(chunk), interrupt(), close()
}
```

- **Gemini 3.8 Live** (and the live-thinking variant) is the first implementation —
  bidirectional streaming, interruption, thinking traces the UI can show.
- **OpenAI realtime** implements the same interface — same audio contract, different
  provider. Nothing above this interface changes when it is swapped.
- The interface deliberately has **no tool-call surface**. Tool use belongs to the harness
  (pi), not the voice model. The voice model emits *intent candidates*; the host decides
  whether an intent becomes a harness turn. This is the decision that keeps "extensible
  model" from becoming "every model gets its own tools."

### 2b. The execution model (whatever pi is pointed at)

The harness's model is already provider-extensible by pi's own design — `pi --model
provider/id`, with the registry proven daily on this machine (gemini-3.8-flash, gpt-6-astra,
glm-5.3-flash, deepseek-v4-flash, kimi k3, qwen3.8-max, fable — seven providers in live use).
The host sets the model per (instance, root) session; the harness does not care which
provider serves it. **Extensibility here is free because it is pi's, not ours to build.**

### 2c. Fable through the pi harness — the check Paul asked for (§3.1)

> "this is the bit I want to try and work towards — a fable model using the pi harness that
> you've got access to."

It works today. The finding, reproduced, is §3.1.

## 3. The checks, reproduced

### 3.1 C1 — Fable through pi, today

```
$ pi --list-models fable
provider                 model             context  max-out  thinking  images
anthropic                claude-fable-5    1M       128K     yes       yes
anthropic                claude-fable-5-1  1M       128K     yes       yes
pi-claude-code-provider  fable             1M       64K      yes       yes

$ pi -p --model pi-claude-code-provider/fable "Reply with exactly: FABLE-OK"
FABLE-OK                                                ← works (one transient OAuth-refresh
                                                            race on first attempt; retry clean)

$ pi -p --model anthropic/claude-fable-5 "Reply with exactly: FABLE-OK"
401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}

$ pi -p --model anthropic/claude-fable-5-1 "…"
401 (same)

$ pi -p --model anthropic/claude-haiku-4-5 "…"
401 (same — the whole anthropic provider fails completions)

$ pi auth check --provider anthropic
ready                                                 ← presence of credentials, not validity
```

**Verdict:** Fable runs through the pi harness **today** via `pi-claude-code-provider/fable`
(the Claude Code OAuth subscription — Paul's established path). What is missing for the other
route: a valid **direct Anthropic API key** — the configured one is invalid for completions
(despite `auth check` reporting "ready", which asserts presence, not validity). No harness or
model-registry work is needed; the subscription path is the working one.

### 3.2 C2 — `session/request_permission`, driven

The protocol path exists and is fully wired, in three confirmed links:

1. pi's RPC mode emits `extension_ui_request` dialogs for extension `ctx.ui.confirm()` /
   `select()` calls (pi docs/rpc.md §1186–1243).
2. pi-acp forwards those to `conn.requestPermission(...)` — the ACP protocol message
   (pi-acp/dist/index.js:1308).
3. The client side already answers with real cards: CAP's `e24e` landed interactive
   Allow/Deny handling for exactly this message.

**But the pi harness produces none of it for ordinary tool calls.** Two drives against the
real bridge with the real pi harness:

```
drive 1: initialize → session/new(cwd) → session/prompt("run ls -la …")
drive 2: initialize → session/new(cwd) → session/prompt("create hello.txt … then rm -rf it")

observed both times:  initialize → session/new → N × session/update → prompt result
                      ZERO session/request_permission
```

The reason is in pi's own security doc: pi's only built-in gate is **project trust**, an
input-loading guard — *"it does not restrict what the model can ask tools to do after you
start working in a directory."* pi's built-in tools run with the pi process's permissions
and ask for nothing. In non-interactive modes (including `--mode rpc`, which pi-acp uses)
pi does not even show the trust prompt.

**Consequence for the design (a §1.4 note, not a workaround):** §1.4's *compliant mode* —
"the harness must supply `resolved` if it wants a decision rather than a refusal" — does not
exist with pi as-is, because pi never asks. To make compliant mode real, one named mechanism
is required: **a pi extension that hooks tool calls and asks via `ctx.ui.confirm()`** (the
channel C2 proves is wired). That is a small, named piece of work, not a discovery. Until it
exists, Tier 2 gating for pi's built-in tools is the host's problem, and only one shape of
host can own it: the one in §3.3.

### 3.3 C3 — where the host's gate can and cannot live

Containment is the harness's choice for pi's built-in tools. The host cannot make pi ask —
pi's approval policy is pi's. So the tier table is a **boundary in exactly two shapes, and a
disclosure everywhere else**:

1. **Mediated mode (boundary).** The host owns the tool surface: the harness is offered
   *only* host-provided tools (bridged fetch, bridged shell, bridged file ops). The host
   produces `resolved` (argv, paths, effects) *before* anything runs — it is the tool
   boundary, so it has the plan by construction. Tier enforcement is real here.
2. **Compliant mode (boundary, once it exists).** A pi extension that hooks tool calls and
   asks (C2's named mechanism), supplying `resolved` in the harness's own words. The host
   decides; the harness honours the decision because the extension blocks on it.
3. **Everything else (disclosure).** pi's built-in tools without the extension: the harness
   acts, the host records, nothing is gated. §3.7 of `02-environment.md` already says this —
   and after these drives it is not a caveat, it is the current state. The tier table must be
   presented as a disclosure until shape 1 or 2 is in force for the session.

The third honest option for Tier-0/never-act work is **environmental containment** — a
container or policy sandbox with only the files and credentials the task needs. pi's own
security doc names exactly this for unattended work, and it is the only containment that does
not depend on anyone's compliance.

### 3.4 C4 — one adapter, two placements: already proven

pi-acp is a stdio process spawner (`pi --mode rpc` as a child process: spawn, PATH,
filesystem). **A browser cannot host it.** So one adapter-as-process cannot span both
placements — but the working topology already exists and is running in production for CAP:

```
browser page (extension context)  ⇄ WebSocket ⇄  acp-bridge (on the machine)  ⇄ stdio ⇄  pi child
        ↑ this IS the browser placement              ↑ hosts the adapter         ↑ same harness
```

The drives in §3.2 used exactly this shape (a WebSocket client driving pi through the
bridge). **One harness, one ACP protocol, two transports.** Not a second harness — a second
transport, and it is the same bridge the host already reuses for the machine placement's
browser-facing side. The browser placement's adapter lives on the machine; the browser is a
client, never a host. (§4 of `02-environment.md`'s revised capability-per-placement model is
consistent with this: the *browser* placement declares fewer capabilities because it cannot
spawn, and the design should say that is a transport fact, not a harness difference.)

## 4. The tool surface: what CAP got right, and what it cost

> "the Chrome agent platform where it's like super powerful — I can give it a new set of
> tools if needed. Maybe extensions put tools in for the agent loop."

What CAP got right, in the order voicebox should steal them:

1. **Tools as data, with a manifest authority.** The bundled-tool inventory is a generated,
   hash-pinned data module; reachability is asserted; a tool that is not in the manifest
   does not exist to the agent. "New set of tools" is a data change with a build, not a code
   change. Steal this shape.
2. **Admission as a pipeline, not a wish.** Every Wasm tool goes through provenance, licence
   audit, immutable spec, CAS bytes, and a reviewed admission. That is why "extensions put
   tools in" can be safe: a new tool arrives with its boundary already measured.
3. **The eval-scrub + AST gates.** The build scrubs dynamic evaluators from generated
   bundles and refuses publication when any survive (kdax's gate, verified this week: 8 live
   sites on main before it landed, 0 after). A tool ecosystem is only extensible if hostile
   or sloppy tools cannot smuggle execution paths.
4. **Extensions add tools through a registration surface, not by editing the agent.** The
   tool registry is consulted at run time; the agent loop does not change.

What it cost, in the same order:

1. **The budget occupation.** A saturated byte budget where every landing fought for ~2 KB
   of headroom — until measurement (4ctv) showed the budget was managing a proxy that had not
   been correlated with user-visible cost. voicebox should set its constraint from
   measurement *first* and never inherit a number by familiarity.
2. **The admission ceremony.** Eleven-day arcs to land one admission chain (ol0j → tptx →
   kdax) — real safety work, but slow enough that workarounds became attractive. A lighter
   first tool set and a strictly smaller admission surface is the voicebox-scale answer:
   start with host-provided tools only (§3.3 shape 1), and admit external tools only when the
   pipeline can keep pace.
3. **Duplicated authority.** Three digest verifiers grew in three places before anyone
   noticed (found by mutation, not by review). Every authority in voicebox gets one home or
   a documented reason why not, from day one.
4. **Regex-shaped gates.** The first evaluator gate was regex-only and missed 8 live alias
   sites; the permanent gate is AST. Any gate voicebox writes starts structural — a textual
   gate on a security property is a gate waiting to be routed around.

## 5. What this changes in §1.4 (for the PR)

Nothing in the shape — it is the right contract. Three clarifications, all evidence-backed:

1. **Compliant mode needs its mechanism named** (the pi extension that asks), or the doc
   should say plainly that it does not exist yet and Tier 2 currently lives only in mediated
   mode / environmental containment. That is the one place §1.4 currently implies a
   capability the harness does not have.
2. **`session/cancel` plus process-group stop is not optional** — after C2/C3 it is the only
   hard lever the host always has. The contract has it; keep it load-bearing.
3. **The capability-per-placement declaration (revised §4) should record the transport
   fact**: the browser placement cannot spawn the adapter, so its adapter is bridge-hosted.
   That is one harness with a second transport, not a second harness — and the declaration
   should say so, or M2's design will quietly assume capabilities that do not exist.

## 6. The build order this implies

1. **The host + bridge + declared project + pi harness** (mediated mode only: host-provided
   tools). Tier enforcement real from day one on the only surface the host can truly gate.
2. **The voice model behind the streaming interface** (Gemini 3.8 Live first), proposing to
   the host. Fable available as the execution model from day one (C1).
3. **The compliant-mode pi extension** (tool-call hook + `ctx.ui.confirm()`), turning the
   tier table from disclosure into boundary for pi's built-in tools.
4. **Browser placement** as the second transport (the bridge), with the capability
   declaration stating what it cannot do (spawn).
5. **External tool admissions** only when the pipeline can keep pace — the CAP lesson at
   voicebox scale.

---

*Written by k3, 2026-09-19. Every capability claim above carries its drive or its citation;
anything phrased as "works" was run, and anything phrased as "does not work" was run twice.*

---

## 7. C5 — dynamic tool creation: the model writes, the model registers (driven)

Paul's requirement, his mechanism: *"You obviously build extensions like we can with pi and
then just have the model register them."* **It works today, end to end, in one session.**

The drive (tmux-hosted interactive pi, `/tmp/vb-dynamic`, `--approve`):

```
prompt: "Create .pi/extensions/now.ts … that registers a tool named now"
  → the model WROTE the file itself, mid-session:
    import type { ExtensionAPI } …
    export default function (pi: ExtensionAPI) {
      pi.registerTool({ name: "now", …, async execute() {
        return { content: [{ type: "text", text: new Date().toString() }] };
      }});
    }

/reload
  → "Reloaded keybindings, extensions, skills, prompts, themes, and context files"

prompt: "Use the now tool to tell me the current date and time."
  → tool called IN THE SAME SESSION, result into context:
    now → "Sat Sep 19 2026 12:37:42 GMT+0100 (British Summer Time)"
```

The full loop — **author (model) → register (/reload) → visible → callable → result** —
runs without a restart. So the harness side of dynamic tool creation is not a hole; it is a
working capability, and the design questions are all on the *authority* side:

### What a tool needs to be

- **A file in an auto-discovered directory**: `~/.pi/agent/extensions/` (global) or
  `.pi/extensions/` (project-local — loaded only when the project is trusted). Hot-reloaded
  mid-session by `/reload`. `pi -e ./path.ts` for one-off loads.
- **Or an in-process registration** (`pi.registerTool()` inside any loaded extension).
- The model's own context learns the new tool without a restart: the reload rebinds the tool
  list, and the very next prompt sees and calls it (the drive above).

### "Absent, not broken" — the harness can withhold a capability

Second drive: `pi -xt bash` (denylist), then "Run the shell command: ls":

```
model: "No shell tool in this harness. I can't run ls."
model: "This environment has no shell/exec tool — only file read/edit/write…"
```

The tool was **not in the list the model sees** — it reported the absence instead of trying
and failing. `-t`/`--tools` (allowlist) and `-xt`/`--exclude-tools` (denylist) are set at
spawn, so **the host decides per placement and per session which capabilities exist**, and
the model's own report of the boundary is accurate. An `exec` tool absent in the browser
placement is exactly this, declared at launch.

### Can anything contradict a tool's self-declaration?

Inside the pi process: **the declaration is the last word.** A tool's `execute()` runs with
the pi process's permissions; there is no sandbox (pi's security doc says so explicitly). The
contradiction mechanisms that do exist, in order of strength:

1. **The host owns the admission point.** The extension directory and the `/reload` trigger
   are the gate: the model *proposes* tool source; the host reviews (a Tier 2 act whose
   `resolved` is the file content and the registration it performs); the host reloads. The
   model does not get to reload its own proposals past the host — that is precisely where the
   tier table does work. In my drive the loop ran ungated; in the built system the directory
   and the reload belong to the host.
2. **Extension event interception.** pi's extension API can block or modify tool calls
   (the docs name "permission gates — confirm before `rm -rf`" as an example use case). A
   policy extension is the in-harness veto — and the same mechanism C2's compliant mode needs.
3. **Project trust.** An untrusted project's `.pi/extensions/` never loads at all — the
   load-time boundary, already proven.
4. **Environmental containment.** The only boundary that does not depend on anyone's
   compliance: the harness runs in a container or policy sandbox with only the files and
   credentials the task needs (pi's security doc's own prescription for unattended work).

### Where this leaves the design

Dynamic tool creation is **possible today** and the gate is **locatable exactly where the
rest of the design already has one**: authoring is the model's, admission is the host's Tier
2 decision over the file content, registration is the host's `/reload`. The one thing that
must not happen is the loop running ungated (model writes and reloads directly), because then
the tool proposal — the act with the most reach in the whole system — bypasses the only table
meant to govern it.

---

## 8. The compliant-mode extension, built and driven (k3)

The named mechanism from §3.2, now proven rather than proposed. Twenty lines, and they live
in the repository, not in a scratch dir: **`.pi/extensions/policy-gate.ts`** (currently on
branch `rescue/compliant-mode-extension` with C5's `now.ts` alongside it) — the file an
implementer copies, with its comments intact. The snippet below is the same file:

```ts
// .pi/extensions/policy-gate.ts
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const plan = JSON.stringify({ tool: event.toolName, input: event.input }, null, 2);
    const ok = await ctx.ui.confirm(
      `Permission: ${event.toolName}`,
      `The agent wants to run this tool:\n\n${plan.slice(0, 1500)}\n\nAllow it to execute?`,
    );
    if (!ok) return { block: true, reason: `denied by the host: ${event.toolName} was not allowed to run` };
  });
}
```

`tool_call` fires before execution and can block (`docs/extensions.md` §778). In the TUI the
confirm is modal; under RPC/ACP the same `ctx.ui.confirm()` becomes a real
`session/request_permission` (the wire C2 proved). Driven interactively, three proofs:

### 1. A denied call does not execute

`create delete-me.txt` → write dialog → **denied** → the model immediately tried to route
around it with a shell redirect (bash dialog → **denied**) → then a `read` probe (dialog →
**denied**). Final state: **the file does not exist.** Every attempt was asked; nothing
executed. The bypass attempt is the finding that shapes the gate: **it must cover every tool
call, because the model's first response to a denial is to try another tool.** A gate scoped
to tool *names* would have been routed around in one turn.

### 2. The plan arrives before the act, in the harness's own words

Every dialog rendered the structured plan before any execution:

```
Permission: read
The agent wants to run this tool:
{ "tool": "read", "input": { "path": "/tmp/vb-dynamic/delete-me.txt" } }
Allow it to execute?  → Yes / No
```

The host's decision is made on content (tool + full input), never on a title.

### 3. The gate holds for a model-authored tool (the C5 case)

`Use the read_host tool on /etc/hostname` → **`Permission: read_host`** with the plan
(`tool: read_host, input: { path: "/etc/hostname" }`) → **denied** → the model reported
"read_host was denied by the host this time, so I couldn't re-read it." The gate does not
distinguish built-in from model-registered tools — the C5 loophole is closed.

### Honest negatives — what the gate does not prove

- **The model confabulates compliance.** Its final report claimed "delete-me.txt already
  exists with probe… confirmed created earlier this session." The file does not exist. The
  model's report of effects is not evidence of effects — the audit must read the world, not
  the transcript. (Same day's rule: an instrument can blame the wrong cause.)
- **`event.input` may be unvalidated** at hook time (`prepareArguments` runs before schema
  validation), so a gate inspecting the plan must tolerate partial shapes — and a plan that
  *looks* complete may not be what the tool finally validates.
- **Sub-agents are a separate surface.** pi-subagents children are their own processes; a
  project-local gate only covers sessions in that project. A policy extension meant to be
  total must load globally (`~/.pi/agent/extensions/`) and even then covers only pi
  processes, not anything a child spawns outside the extension system. *"The gate covers X
  and not Y":* X = every `tool_call` in gated pi sessions; Y = child processes, non-pi
  subprocesses, and anything outside the extension's process.
- **TUI drive note:** each dialog is modal; under the host the same confirm is a
  `session/request_permission` the host answers — the semantics proven here transfer, the
  transport differs.

### Where this leaves compliant mode

Real, and small. The tier table can now be a boundary for pi's built-in **and**
model-authored tools: intercept → plan → ask → honour. The remaining work is host-side:
answer the request (§1.4's permission-response schema already exists), record it in the
audit, and never let the model's own report of compliance stand in for the audit of effects.
## 9. Isocan's multi-harness model, and what C4 got too narrow

Paul: *"isocan has got a really great way of having multiple harnesses work together… we can
use it as inspiration."* C4 answered the browser question (one agent, reached two ways). His
requirement is the other shape: **several named agents, live on one project, at the same
time** — his phone's session and this chat session, both on the same work. Those are not the
same mechanism, and the difference is where the coordination lives.

### What isocan actually is (from the live record, not the README)

`~/.isocan/rc-agents.json`, today:

```json
[
  { "canvasId": "prj_6nodKBn0oA", "actorId": "usr_Ut1iNC2vQw", "name": "PK_Bot2",
    "harness": null,  "cwd": "/home/paulkinlan/isocan-getting-started", "sessionId": "01a08d7e-…" },
  { "canvasId": "prj_6nodKBn0oA", "actorId": "usr_tnqRhL6b0y", "name": "PK_Scout",
    "harness": "pi",  "cwd": "/home/paulkinlan/isocan-getting-started", "sessionId": "01a08d7e-…" },
  { "canvasId": "prj_6nodKBn0oA", "actorId": "usr_9SGTtKaRcv", "name": "Scout",
    "harness": null,  "cwd": "/home/paulkinlan/isocan-getting-started", "sessionId": "01a09201-…" }
]
```

**Three named agents on one canvas, two of them pi harnesses, each a distinct actor with its
own session and cwd.** The model in one sentence: *an agent is an enrolled record —
(canvasId, actorId, name, harness, cwd, session) — and agents coordinate through the
canvas's shared oplog* (comments, threads, items, versions), which they can all read by
construction. Around that record: the **bench** (presence per agent — *ready / elsewhere /
unreachable*, measured every time you look), **seen-marks** (per-person read positions kept
by the home, converging across machines), and **whose word starts a turn** (a standing agent
answers only its owner until widened, with lapse-bounded grants — the per-agent permission
layer).

### Same thing, or reinvention?

The environment design's per-(instance, root) session is **isomorphic at the registry level
and different at the coordination level**:

| | isocan | environment design (as written) |
|---|---|---|
| Agent identity | actorId, claimed against the harness's session id — two agents sharing a directory stay two people | (instance, root) session |
| Registry with liveness | the bench: ready / elsewhere / unreachable | capability per placement (no liveness column) |
| **Coordination medium** | **the canvas: a shared, ordered, persistent log every agent reads** | per-root audit + work meeting as an ordinary git merge |
| Read positions | seen-marks, per person, converging across machines | none — agents meet at merges, not at a shared view |
| Turn authority | whose word starts a turn, per agent, lapsing | the tier table (per act, not per agent) |

**Verdict: not the same mechanism, and not a reinvention either — a missing layer.** The
registry shape (named agent instances with declared placements) is the same idea discovered
twice. What isocan has and the environment design lacks is the *coordination medium*: a
shared log with presence and read positions, versus audits that only meet at merges. For
Paul's phone-and-chat case, merges give him two sessions that see each other's work late and
through git; the canvas gives him two sessions that see each other's work as it happens.

### What to take (and what it changes)

1. **The actor model.** Identity claimed against the harness's session id — two agents in
   one directory are two people, atomically. This is exactly what the (instance, root)
   registry needs to stop two placements of "the same agent" from being indistinguishable in
   the audit.
2. **A liveness column on the capability declaration.** *ready / elsewhere / unreachable* is
   three honest words measured at read time — better than a capability row that cannot say
   whether anything could answer right now.
3. **The shared log as the coordination medium.** The audit should be the medium agents read
   each other's work through, not only the record the host keeps. Whether that is an
   oplog-shaped project log or the canvas itself, the design's "several roots per project"
   needs it to be *visible to all of them*, not just mergeable.
4. **Seen-marks for the audit.** Per-person read positions kept by the host, converging
   across machines — so "what is new since you last looked" is a computed answer, and two
   machines racing converge instead of duplicating.
5. **Whose word starts a turn, per agent.** The tier table governs acts; this governs
   *invocation* — an agent answers only its owner until widened (with lapse-bounded grants
   that expire visibly). Paul's phone asking the home harness is a grant, not a default.

### The gap, stated plainly

C4's "one harness, one protocol, two transports" is correct for the browser question and
incomplete for the multi-agent requirement. The architecture needs the coordination layer
isocan already proved: shared log, presence, read positions, per-agent turn authority.
Whether that layer is *adopted* (the canvas pattern as the project's shared medium) or
*declared absent* (merges-only, with the cost named: no presence, no shared view) is Paul's
call — but it should be a decision, not an oversight.

---

## 10. The round trip over the wire, and the two holes it revealed (k3)

The unproven link from §8 is now proven end-to-end, in both directions, over the real ACP
bridge with the gate loaded **globally** (`~/.pi/agent/extensions/policy-gate.ts` — which
also settles the global-load question: it gated sessions in a different directory).

### The wire, both directions

```
client: initialize → session/new(cwd) → prompt("Create wire-test.txt")
wire:   13 × session/request_permission  (write, bash, read, web_search, generate_image, …)
host:   13 × { outcome: "cancelled" }
effect: the file does not exist.                                          (deny honoured)

client: same prompt
wire:   session/request_permission { title: "Permission: write" }
host:   { outcome: { outcome: "selected", optionId: "yes" } }
wire:   tool_call: pending → in_progress → completed
effect: wire-test.txt contains "wire".                                    (allow honoured)
```

**The gate's `ctx.ui.confirm()` reaches a host as a real protocol message and comes back** —
compliant mode is real end-to-end, not only in the TUI.

### Hole 1 — the optionId namespace is adapter-defined, and a malformed allow reads as a denial

The first allow attempt used the ACP-convention `optionId: "allow_once"`. The tool **failed
identically to a denial** — because pi-acp's confirm dialog speaks `"yes"/"no"`
(`CONFIRM_PERMISSION_OPTIONS`), and `"allow_once" ≠ "yes"` maps to `confirmed: false`. No
error, no complaint: a wrong optionId is a silent "no". The host must answer with the
optionId **from the request's own options array** (or map by `kind: allow_once /
reject_once`) — never assume a universal id. This is the day's rule one more time: the
failure is silent and always in the direction that looks like the safe answer.

### Hole 2 — a permission for a plan is not a permission for whatever finally runs

With a second handler (`z-mutator.ts`) loaded **after** the gate, rewriting bash input:

```
ASKED (plan shown to host): { "tool": "bash", "input": { "command": "echo approved > /tmp/vb-dynamic/plan-a.txt" } }
host answered: ALLOW
which plan ran?              /tmp/vb-dynamic/plan-b.txt
```

The host approved plan A; plan B executed. `tool_call` inputs are mutable and **later
handlers see (and change) earlier ones' work** — so a handler behind the gate in load order
can rewrite an approved plan after approval. There is no later hook to catch it. The design
rule this forces: **the gate must be the last `tool_call` handler, and that ordering is part
of its authority** — the host owns the load order, and any extension registered after the
gate is itself an admission act, because it can rewrite what the host just approved.
(Also recorded: `event.input` may be unvalidated at hook time, so even a well-ordered gate
must tolerate partial shapes.)

### Where this leaves compliant mode

Proven end-to-end: intercept → plan on the wire → host answers with the adapter's own
optionId → effect matches the answer. The two holes are named with their rules: answer by
the request's own options, and treat the gate's load-order position as part of its
authority. Both rules are about the failure being *silent* — the same shape as everything
else this week has produced, and the reason the host's permission path needs its own drive
rather than a schema read.

*Test fixtures removed after the drive: `z-mutator.ts` and `policy-gate.ts` are out of the
global extension dir (a mutator left global would rewrite every future bash call on this
box; a gate left global would make every pi session interactive-by-force). The canonical
copy of the gate stays at `.pi/extensions/policy-gate.ts` on
`rescue/compliant-mode-extension`.*
