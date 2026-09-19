# Dynamic tools, OpenClaw, and where tools run

Research by **qwen2** (2026-09-19), answering three questions from Paul's latest, routed by
coord. Companion to [`03-harvest.md`](03-harvest.md) — same method: paths and quoted source
rather than opinion, and what could not be settled is named rather than smoothed.

Paul's words, since the three questions are one seam seen from three sides:

> *"You obviously build extensions like we can with pi and then just have the model register
> them. That would actually be pretty cool."*

> *"We have to think about how we can do dynamic tool creation, because you start off without
> anything… We will create the tools and we will create the objects, the nouns — and the verbs
> are based off us somehow. I don't know how to do this. I want to build those extensions and
> have them work locally somehow."*

> *"I don't know how to deal with the server side of things… we also have access to an
> environment that is on the server."*

**Sourcing, stated up front.** §1 is from pi's own documentation read off the local install
(`0.85.1`, `~/.local/share/mise/installs/pi/0.85.1/pi/docs/extensions.md`, with line numbers)
and its shipped examples — i.e. primary source, and the version this lane is running inside.
**§2 is from OpenClaw's published documentation and site found by web search; its source was
not read**, so every claim there is what the project says about itself and is marked as such.
§3 is reasoning over the two plus isocan's and CAP's source.

---

## 1. pi's extension model *is* the dynamic-tool mechanism, and it is already runtime

The short answer: **`/reload` is not the path, and no file needs to be written for a tool to
become callable this session.** `docs/extensions.md:1369`:

> *"`pi.registerTool()` works both during extension load and after startup. You can call it
> inside `session_start`, command handlers, or other event handlers. New tools are refreshed
> immediately in the same session, so they appear in `pi.getAllTools()` and are callable by
> the LLM **without `/reload`**."*

And the discovery list is not the only door: tools can also arrive via `settings.json`
`packages` (`npm:@foo/bar@1.0.0`, `git:github.com/user/repo@v1`) and `extensions` (explicit
paths) — `extensions.md:109-138`.

### 1.1 What the model needs in its own context to know the tool exists

Three mechanisms, all documented, and this is the part Paul's "just have the model register
them" depends on:

- **`promptSnippet`** — opts the tool into a one-line entry in the `Available tools` section
  (`extensions.md:1373`; and `:1917` — *"If omitted, custom tools are left out of that section"*,
  so a model-authored tool that forgets it is invisible in the prompt while still callable).
- **`promptGuidelines`** — appends tool-specific bullets to the default `Guidelines` section
  *when the tool is active* (`:1373`).
- Tools "appear in the system prompt" generally (`:1915`), and `pi.setActiveTools()` enables or
  disables tools at runtime, **including dynamically added ones** (`:1371`).

There is a documented footgun that matters *more* when the author is the model
(`extensions.md:1375`, repeated at `:1921`):

> *"`promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name
> prefix. Each guideline must name the tool it refers to — avoid 'Use this tool when…' because
> the LLM cannot tell which tool 'this' means."*

A model writing its own guidelines is a model writing "Use this tool when…" unless something
makes it name the tool. That is a small, concrete thing to enforce in whatever generates the
definition — and it is cheaper to enforce than to discover, because the failure is silent: the
tool exists, is callable, and is never chosen.

### 1.2 The definition the model has to emit

From `extensions.md:1383-1401` — note that this is **data, not a compiled module**:

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does",
  promptSnippet: "Summarize or transform text according to action",
  promptGuidelines: ["Use my_tool when the user asks to summarize previously generated text."],
  parameters: Type.Object({                       // TypeBox — a value, not a .ts file
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) { return args; },        // compat shim; runs BEFORE schema validation (:1393, :2033)
  async execute(toolCallId, params, signal, onUpdate, ctx) { /* … */ },
});
```

**This is the single most important fact for Paul's requirement.** The parameter schema is a
TypeBox *value*, so a model can emit a tool definition as JSON-shaped data. What it cannot emit
that way is `execute` — a function body. That is the real boundary, and §1.4 is about it.

### 1.3 There is a shipped example that does exactly this

`examples/extensions/dynamic-tools.ts`, whose own header reads:

> *"Demonstrates registering tools after session initialization. — Registers one tool during
> `session_start` — Registers additional tools at runtime via `/add-echo-tool <name>`"*

It keeps a `Set` of registered names, refuses duplicates, validates the name against
`/^[a-z0-9_]+$/`, and registers via a `pi.registerCommand` handler. **That is the whole shape
of "the model creates a tool": a command the model can call, which registers a tool.** Neighbouring
examples worth reading for the same problem: `kimi-deferred-tools.ts`, `tool-override.ts`,
`tools.ts`, `truncated-tool.ts`.

Also, line 1 of `extensions.md`, which is the project stating the intent plainly:

> *"pi can create extensions. Ask it to build one for your use case."*

### 1.4 What breaks first when the author is the model, ranked

Not discovery, not typing, not the reload boundary — all three are solved (§1.1–1.3). In order
of how fast they bite:

**(1) The permission model, and specifically that its one gate is on the wrong door.**
`extensions.md:111`:

> *"**Security:** Extensions run with your full system permissions and can execute arbitrary
> code. Only install from sources you trust."*
>
> *"Extensions are auto-discovered from trusted locations. Project-local `.pi/extensions`
> entries load only after the project is trusted."*

So the trust boundary is on **discovery** — a project-local extension loads only once the
project is trusted, and `ctx.isProjectTrusted()` exists (`:994`) for extension code to ask.
**`registerTool()` at runtime has no equivalent gate**: an in-process registration inherits the
harness's full authority immediately, with no trust check, because it never passed through a
discovered location. For a person typing `/add-echo-tool` that is fine — the person is the
authority. For a model authoring a tool, the one gate pi has is bypassed by the dynamic path.
**This is the thing that breaks first, and it is a design gap to fill rather than a bug to
report:** Voicebox needs a registration-time decision (who may add a tool, and what a
model-added tool may touch) that pi does not need because pi assumes the person at the keyboard
is the author.

**(2) `execute` is code, and a model cannot emit it as data.** The schema is a TypeBox value;
the body is a function. So a model-authored tool needs one of: a fixed set of interpreters it
parameterises (the model picks a primitive and fills in bounds — this is CAP's `python-tool.js`
shape, 52 lines, with `getPythonRuntime` as the injection seam); or generated source written to
a file and loaded, which lands squarely in *"arbitrary code with full system permissions"*; or
generated source evaluated in-process, which is the same thing without the audit trail.
**The first is the only one compatible with "light, not a framework" and with N9.** Worth
saying plainly to Paul: *dynamic tool creation* is cheap when the verbs are a closed set of
parameterised primitives, and expensive when each new verb is new code. His own phrasing — *"we
will create the objects, the nouns — and the verbs are based off us somehow"* — may already be
pointing at that split, with nouns as data and verbs as a fixed repertoire.

**(3) `prepareArguments` runs *before* schema validation** (`:1393`, and `:2033` states it
explicitly: *"it runs before schema validation and before `execute()`"*). A useful compatibility
shim — its documented purpose is resuming an older session whose stored arguments no longer match
the current schema — and an escape hatch if the shim itself is model-authored, because it can
reshape arguments before anything checks them. Keep it out of model-authored definitions.

**(4) Persistence is a different feature from registration, and the gap between them is where
the admission question lives.** An in-process `registerTool` dies with the session. To make a
tool *survive*, it must be written into a discovery location — `~/.pi/agent/extensions/*.ts` or
`.pi/extensions/*.ts` — which is precisely the arbitrary-code case, and which for project-local
paths re-enters the trust gate on the next load. So "I want to build those extensions and have
them work locally somehow" is **two requirements**: (a) a tool for this conversation, which is
already free; and (b) a tool that persists, which is a code-writing act needing a decision about
who may write where. Conflating them is how a light harness acquires an admission pipeline it
did not want — which is the CAP trajectory the harvest documents.

**(5) Name and shape collisions at runtime.** `dynamic-tools.ts` guards duplicates with a `Set`
and validates `/^[a-z0-9_]+$/`; a model will generate `search`, `search2`, `search_files`,
`find_files` across a long session. Cheap to bound, annoying to retrofit, and it degrades the
one thing the mechanism exists for — the model knowing which tool it has.

### 1.5 The harvest consequence

`03-harvest.md` §3.1 concluded *pi is discovery, CAP is admission, and Voicebox only has the
first question*. §1.4(1) and (4) refine that rather than contradict it: **pi's discovery model
is the right runtime, and it has exactly one gap for Voicebox — it assumes the author is the
person.** The minimal thing to add is a registration-time authority decision, not a descriptor
pipeline. CAP's `admitted`/`canExecute`/`canGrant` triad is what that decision looks like when
it grows up; Voicebox needs the *question*, and can start with a boolean and a reason string.

---

## 2. "OpenClaw" — a real project, and the delta is narrower than it looks

Paul named a real thing. **OpenClaw** (`github.com/openclaw/openclaw`, `openclaw.ai`,
`docs.openclaw.ai`), stewarded by the OpenClaw Foundation, described as an independent
501(c)(3) with no paid tier. Everything below is **from its published documentation and site,
not from its source** — treat it as the project's own account of itself.

What it says it is:

- **A Gateway**: one process that *"runs it as a personal assistant on a laptop or as a shared
  team deployment; configuration is the only difference."* And: *"The Gateway is just the
  control plane — the product is the assistant."*
- **Channels it meets you on**: Discord, Google Chat, iMessage, Matrix, Microsoft Teams, Signal,
  Slack, **Telegram**, WhatsApp, Zalo *"and 20+ more"*, plus native apps for macOS, iOS,
  Android, Windows, Linux.
- **Agent harnesses as runtimes**: *"State, memory, and credentials live on your hardware.
  Models and agent harnesses (Claude, Codex, …)."* Public config uses `agentRuntime.id` on
  provider or model entries — `"auto"`, `"openclaw"`, a **registered plugin harness id**, or a
  **supported CLI backend alias**; the bundled Codex plugin registers `codex`, the bundled
  Anthropic plugin provides the `claude-cli` backend. Its own glossary: *"A harness is the
  implementation that provides an agent runtime."*
- **A headless path**: `openclaw agent exec` *"runs one embedded agent turn without connecting
  to a Gateway… the recommended headless entry point for CI and coding automation."*
- **CLI backends as fallback**: local AI CLIs run *"as a text-only fallback when API providers
  are down, rate-limited, or temporarily misbehaving"*, with an **MCP loopback bridge** for CLI
  backend tool access.
- **A full voice stack** — spoken conversation, including phone calls; and *"It can speak and
  listen on macOS/iOS/Android, and can render a live **Canvas** you control."*
- **Tools, skills, cron, webhooks, automation**; memory via **local Markdown files**.

### 2.1 The delta, which is the useful answer

Line up OpenClaw against the brief's needs and it already claims most of them:

| Need | OpenClaw, by its own documentation |
| --- | --- |
| N1 voice-first, stays available | a full voice stack; channels mean the conversation is not tied to a window |
| N3 client *and* server, one harness shape | **Gateway + harness runtimes + `agent exec` headless** — literally two placements of one shape |
| N4 server holds the filesystem, reachable securely from elsewhere | Gateway on your machine, Telegram as a channel, state and credentials on your hardware |
| N5 a canvas | *"can render a live Canvas you control"* |
| N7 extensible platform | tools, skills, **plugin harnesses**, channel plugins |
| N8 model-extensible | `agentRuntime.id` across providers and CLI backends |

**What it does not claim, and what Paul's "but we can build it on the fly, dynamic" adds:** its
tools, skills and plugins are **authored and configured** — a registry you add to, not a surface
the model extends mid-conversation. So the delta is *precisely* §1: **the model as the author of
a tool that becomes callable in the same session, with a registration-time authority decision
that pi does not need and OpenClaw does not have.**

That is a much better-scoped project than "build OpenClaw", and it is worth saying to Paul in
those terms: the interesting gap is one mechanism, not a platform. Two further notes from the
same reading, both relevant to open questions elsewhere in this repo:

- **Its memory is local Markdown files** — i.e. host-side, human-readable, reachable from every
  channel. That is independent evidence for the narrowing in `03-harvest.md` §2.6/§9.1: the
  agent's own state belongs where all the doors can read it, not in one origin's storage. (This
  journal system is the same shape, and it is what makes a Telegram-driven session and a desktop
  session one world rather than two.)
- **Its harness vocabulary matches the brief's**, including *"a harness is the implementation
  that provides an agent runtime"* and CLI backends reached over an **MCP loopback bridge**.
  That is a third answer to §3 below, from a project that shipped it.

**Not verified, and not relied on:** a third-party guide claims 333K+ GitHub stars. Star counts
from blog posts are not evidence and are not used anywhere in this document.

---

## 3. Where tools *run* when part of the agent is somewhere else — OPEN, deliberately

Paul named this twice and left it open, and coord asked for a careful unanswered question rather
than a confident wrong one. So: the options, what each costs, the one piece of running evidence
that exists, and what none of them answers. **This is not resolved and should not be read as a
recommendation.**

### 3.1 The four placements on offer

**(a) Tools run where the harness runs.** Browser is a renderer; every act is a message to the
host. This is ds-flash-2's environment design, and it is the simplest thing that can work: one
authority, one filesystem, one audit log. **Cost:** browser-only mode has no tools at all, and
capabilities that only exist in a page — DOM state, OPFS, the rendered artefact, the person's
selection — are unreachable from the server no matter what it is granted.

**(b) Tools run where the capability is, and the harness routes the call.** A tool declares its
placement; the host dispatches to the page or to itself. **This is not hypothetical — isocan
ships it, twice.** `createMemoryBroker` (`packages/voice-agent/src/voice-harness.ts:591`, wired
at `:2445`) and the file broker (`:862`) are the harness *asking the page over a socket* and
waiting, because the capability (OPFS memory, a granted `DirectoryHandle`) lives in the browser
and cannot be lifted out. The page answers; the harness never holds a copy. **Cost:** two
execution contexts, a round trip per call, and a trust boundary on the way back (§3.2).

**(c) A bridge: tools live in one place and are lent to the other.** OpenClaw's CLI backends get
tool access through an **MCP loopback bridge**; CAP has `extension/lib/mcp-run-tools.js`. This
is (b) with a protocol in the middle instead of a bespoke socket, which costs a hop and buys
interoperability with anything else that speaks MCP.

**(d) Duplicate the tool surface per placement.** Listed for completeness and **recommended
against with evidence**: `packages/modules/talk/src/live.ts` is a deliberate 1,179-line copy of
`packages/voice-agent/src/live.ts` whose header says *"reconcile the two by hand"*, and
yesterday's readiness-gate fix had to be applied to **both** call sites — a harness-only fix
would have left the browser path sending audio into the provider's setup window. One provider
face, imported by both placements.

### 3.2 What none of the four answers, and these are the real questions

1. **Authority when execution is remote from the decision.** If a tool executes in the page, who
   decides it may? The host cannot see the call. Isocan's answer is that authority stays
   host-side even when execution is page-side — the permission gate and the person's
   confirmation live in the harness, and the broker is a *channel*, not a decider. That is a
   workable pattern with a file path, but it only covers tools the host already knows about. A
   **model-authored** tool (§1.4(1)) has no host-side decision at all, which is the gap in one
   sentence: *dynamic registration and remote execution compose into a call nobody authorised.*
2. **Trust in the result.** A page-executed tool's return value crosses back into the agent's
   context. It came from a context that can be navigated, scripted by the artefact it is
   rendering, or closed mid-call. Who validates it, and what does a tool result from an
   untrusted origin mean for a subsequent destructive act? CAP's `replayClass` (`read-only`
   versus state-changing) is the vocabulary for reasoning about this; nothing here implements it.
3. **Placement as data exists and was never wired.** CAP's descriptors carry `dispatcherKind` —
   literally the placement field — and **all 9 Wasm descriptors have `dispatcherKind: "none"`**
   with `availabilityReason: "package-execution-unwired"` (`wasm-tools/descriptors/foundation-descriptors.json`).
   So the one project here that designed for placement-designed dispatch left it unimplemented,
   which is weak evidence that it is harder than it looks and strong evidence that the field
   alone does not make it work.
4. **Liveness.** A page can be closed, backgrounded or navigated mid-call. Isocan handles the
   audio version of this by counting receipt separately from delivery (`providerAudioInFrames`
   on receipt, `pageAudioOutBytes` only on delivery) and by having the broker `abandon()`
   pending questions on page close. A tool call needs the same treatment, and "the tool did not
   answer" has to be distinguishable from "the tool answered no".
5. **What browser-only mode actually is.** If (a), it is a demo. If (b) or (c), it is a real
   placement with a smaller capability set — and then the honest description of its state is the
   one in `03-harvest.md` §9.1: **a separate world, not a cache**, until an explicit export
   runs.

### 3.3 The smallest thing that would settle it

Not a decision now, but a cheap experiment: take **one** capability that can only exist in the
page (OPFS read is the obvious one), implement it as an isocan-style broker — host asks, page
answers, host decides — and then ask a model-authored tool (§1) to call it. If that round trip
can be made to carry an authority decision and a validated result, (b) works and the rest is
enumeration. If it cannot, the answer is (a) and browser-only mode is a demo, which is a
legitimate product decision but should be made knowingly.

---

## 4. What this changes in the harvest

Three amendments to `03-harvest.md`, listed rather than folded in so the earlier document stays
readable as what it was:

1. **The harvest's §3.1 — "pi is discovery, CAP is admission" — needs one clause added.** Named
   explicitly because *this* document has its own §3.1, and a bare section number spanning two files
   is exactly the ambiguity a reader should not have to resolve. pi's discovery model is
   the right *runtime* for N7 and it already supports runtime registration without a reload or a
   file. Its gap for Voicebox is narrow and specific: **it assumes the author of the extension is
   the person at the keyboard.** What to add is a registration-time authority decision — a
   boolean and a reason string to start — not CAP's descriptor pipeline.
2. **The lift list gains an item, and it is nearly free.** `examples/extensions/dynamic-tools.ts`
   is a working pattern for "a command the model can call, which registers a tool": duplicate
   guard, name validation, `registerCommand` → `registerTool`. Cost: hours. It should be lifted
   *with* the authority decision attached, because lifting it without one is how a light harness
   acquires an unauthorised code path.
3. **§9's unsettled list gains a fifth item**, and it is the one Paul named twice: where tools
   run when part of the agent is elsewhere (§3). Isocan's brokers are the only running evidence
   available, CAP designed the field and left it `"none"`, OpenClaw ships a bridge — and none of
   the three answers what happens when the tool was authored by the model.
