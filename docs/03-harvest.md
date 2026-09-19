# Harvest: what to lift, from where, at what cost

Research by **qwen2** (2026-09-19), against `origin/main` @ `62217c6`. This is the
analysis the brief owes on Chrome Agent Platform, and the wider question behind it:
for each project that has something Voicebox should inherit — **what specifically is
reusable, where it lives, and what it would cost to lift.**

Evidence rather than opinion. Every claim below carries a path, a module name, or a
number that was measured rather than recalled; the measurements say how. Where I
conclude something should **not** be reused, the reason is given, because the brief's
principle is *light, not a framework* and the tempting list is longer than the useful
one.

**Scope note.** The environment is ds-flash-2's lane (`design/ds-flash-2-environment`,
PR #1) and the interface is astra's. This document does not propose an architecture.
It prices the parts.

> **Read this before the lift list.** A constraint arrived *after* this document was written:
> Paul, 2026-09-19 — *"I want to make sure that we're **not using isocan**… Use isocan as the
> **inspiration**."* So isocan is prior art, not a dependency: nothing may be imported from it,
> vendored from it, or coupled to `@isocan/core` or `@isocan/api`. **§8 is re-marked and
> re-costed against that line**, item by item, as *pattern* / *technique* /
> *would-require-the-dependency*. Every **finding** in this document is unaffected, and two get
> more valuable rather than less (§8.2) — a constraint that removes code but leaves findings is
> cheap, because the findings were always the more transferable half. The estimate is not
> unaffected: it moved from two–three weeks to **three–four**, and the whole increase sits in the
> three items that were cheap *because* they were code that already ran.

---

## 0. Method, so the numbers are checkable

Measured on 2026-09-19 on this machine (32 cores, node v24.21.0) against the working
copies at:

| repo | remote | commit measured |
| --- | --- | --- |
| `~/isocan` | `github.com/PaulKinlan/isocan` | `6d7dad15` + later fleet landings |
| `~/chrome-agent-platform` | `github.com/PaulKinlan/chrome-agent-platform` | `da569876` |
| `~/fauxmium` | `github.com/PaulKinlan/fauxmium` | working copy |
| `~/web-resilience` | `github.com/PaulKinlan/web-resilience` | working copy |
| `~/wasm-vs-js` | (benchmarks) | working copy |
| pi | local install | `0.85.1`, docs read from `~/.local/share/mise/installs/pi/0.85.1/pi/docs` |

Line and byte counts are `wc -l` / `stat -c%s` on the files named. The two numbers
carried over from yesterday's performance baseline (`cap-evidence/isocan-6oe-20260918/perf-sw-baseline-first-numbers.md`)
are marked as such, with the caveat that they are Node's V8 compile cost, not
Chrome's, measured at one load.

**One instrument warning, because it cost a wrong number yesterday and the lesson
transfers.** Anything counted by grepping source text can count the wrong population:
a census of `test/deep.ts` that matched every `file: "…"` string returned 70 where the
module actually exports 46, because the file exports *two* lists. Where a number below
comes from a text scan rather than from running the code, it says so.

### These numbers were independently re-counted by a lane that did not write them

**Receipt: `cap-evidence/harvest-verification-20260919/RECOUNT.md`** (ds-flash-1b, 2026-09-19),
counted from the artefacts at CAP `8b44c769` and isocan `5e7f7bbc` — *later* commits than the
ones measured here, so the figures held across a moving tree as well as across a second counter.
**Five of the seven were exact.** The store service-worker bundle was additionally **rebuilt from
scratch** — real `npm ci` + `deno install` + `build:production`, no symlinked `node_modules` —
and came out at **exactly 2,998,629 bytes again**, with `dist.complete` recording the same size
and sha256. The two that needed tightening were the CAS layering (manifests, licences and SBOM
are *siblings* of `cas/`, not inside it) and the provenance of the readiness-gate frame counts (a
retained 2026-09-12 measurement, not one taken for this document); both are corrected in place
above, and **no recommendation changed**. Recorded here because a number that only its author ever
checked is testimony, and the point of this document is to be evidence.

---

## 1. The needs, as the brief states them

Quoted from `docs/00-brief.md` including the section added after PR #1, because scoring
against a paraphrase is how a harvest ends up answering a question nobody asked.

| # | Need | Source |
| --- | --- | --- |
| N1 | **Voice-first** — conversation is the interface, and stays available while he does something else | original brief; *"me and you keep talking"* |
| N2 | **CAP not used at runtime**, but an analysis owed against two axes: **weight** and **extensibility** | *"Runtime no — but you do the analysis… it's not an extensible platform like pi is"* |
| N3 | **One harness shape, two placements** — client *and* server; isocan is the precedent and he is unsure it generalises | *"The harness should be on the client and also running on the server. Isocan as a project does that really well — but with isocan, I'm not sure."* |
| N4 | **OPFS on the client; the real filesystem on the server; secure reachability from elsewhere** | *"I do want to be able to use OPFS… But then also, we're on the server as well… how do I access all the files from the server — securely, talking to it."* |
| N5 | **A canvas** — somewhere the build is visible, with his doubt about it carried deliberately | *"I kind of need the canvas part of this thing… but maybe that's where I'm kind of making some mistakes."* |
| N6 | **Builds locally and server-side** | brief, principle 2 and the environment section |
| N7 | **Extensible platform** — new tools and skills drop in; extensions add tools into the agent loop | brief, principle 4 |
| N8 | **Model-extensible** — Gemini 3.8 Live first, OpenAI Realtime alongside, Fable through pi | brief, principle 3 and the models section |
| N9 | **Light, not a framework** — the reference point is the pi harness | *"I'm really inspired by the pi harness where it's only got pi harness"* |

---

## 2. isocan — the voice UI and system, and the only working precedent for N3

Isocan is the richest **prior art** here and the only project that already runs **one
harness shape in two placements**, which is N3 and the thing Paul is unsure generalises.
It is also where the voice work is youngest and best tested, so the cost of lifting is
mostly *separating* it from isocan's vocabulary rather than rewriting it.

### 2.1 What is there, measured

`packages/voice-agent/` — the node side, plus the page it serves:

| file | lines | bytes | what it is |
| --- | --- | --- | --- |
| `src/voice-harness.ts` | **5,271** | 234,637 | the standing server: provider session, tool implementations, file and memory brokers, permission gate, transcript log |
| `src/main.ts` | **3,461** | 149,388 | the page: OPFS store, `persist()`, the UI, the settings and device panels |
| `src/live.ts` | **1,173** | 46,431 | **the provider face** — model setup, tool surface, call planner. Pure data and pure functions |
| `src/voice.css` | 1,168 | 45,829 | the voice UI's styles |
| `src/voiceAudio.ts` | **560** | 22,099 | capture, playback, and the `Resampler` |
| `voice.html` | 479 | 29,907 | the page shell |
| `src/cli.ts` | 230 | 10,311 | **one entry point, two modes** |
| `src/voice.ts`, `help.ts`, `agent-key.ts`, `rc-rows.ts`, `theme.ts` | 217/153/108/97/93 | | identity, help text, theming |
| `test/` | 15 files, **8,360 lines** | | |

`packages/modules/talk/` — the browser module, the *client* placement of the same shape:

| file | lines | bytes |
| --- | --- | --- |
| `src/live.ts` | **1,179** | 46,687 |
| `src/web.tsx` | 828 | 34,991 |
| `src/audio.ts` | 562 | 22,001 |
| `test/talk.test.ts` | 257 | 12,336 |

Roughly **12,700 lines of source and 8,600 lines of test**. That is the size of the
thing, and it is the reason the lift list below is selective rather than wholesale.

### 2.2 The most valuable thing isocan has: `live.ts`, and why it answers N8 and N3 at once

> **Under the line Paul drew after this was written — *"use isocan as the inspiration"* — nothing
> below may be imported or vendored.** `live.ts` imports nine names from `@isocan/core` and a type
> from `@isocan/api`, so it is precisely the case the constraint bites on. What survives is the
> *shape*, and the fact that isocan had to perform a deliberate extraction to get it is the
> evidence that the shape is worth the effort. See §8 item 1 for the re-costed version.

`packages/voice-agent/src/live.ts` is the one file here that was **extracted on purpose
to be shared**, and its own header states the reason:

> *"This used to live inside `voice-harness.ts`, beside the node-only session plumbing,
> which was fine while the harness was the only speaker. The web browser module (which
> carries its own copy) opens the same provider socket and must send the SAME setup,
> declare the SAME tools and map tool calls to the SAME operations — a second spelling
> would be the house bug (one string, two spellings) wearing a module hat."*
>
> *"Everything here is pure data and pure functions: no node imports, no daemon, no
> fetch."*

**That is N3's mechanism, already built and already reasoned about.** One provider face,
no node imports, usable in a browser and in a process. It is also most of N8: the model
setup is a value (`LIVE_MODEL = "models/gemini-3.8-live"` at `live.ts:118` — the exact
model the brief names), and the tool surface and call planner are data, so a second
provider is a second spelling of the same data rather than a second harness.

**Its dependency surface is small, and that is the finding — but it is not zero, which under the
line is what matters.** Its entire external surface is nine
named imports from `@isocan/core` plus one type:

```
BROWSER_MIME, DEFAULT_COMMAND_CATALOGUE, DRAWING_MIME, DRAWING_PROPERTIES,
drawingSvg, inkBounds, normalizeSiteUrl, siteLabel, type InkStroke
```

Every one of those is a *canvas* concern (drawing strokes, site labels, the command
catalogue) — i.e. the part of `live.ts` that is isocan-specific is its **tool list**, not
its provider plumbing.

**That split is the durable finding, and it survives the constraint even though the lift does
not.** It says what a from-scratch provider face is made of: the setup message, the tool
declarations and the call planner are provider concerns and carry nothing isocan-specific, while
the tool *list* is where a product's vocabulary lives. So reimplementation is not 1,173 lines of
unknown shape — it is a known shape whose only product-specific part is the list you would be
writing anyway.

~~Estimate: 1,173 lines in, a few hundred out, one to two days including the OpenAI Realtime
spelling that isocan never built.~~ **Superseded by the line Paul drew after this was written:**
nothing may be imported or vendored, so this is a reimplementation — **3–5 days**, per §8 item 1.
The OpenAI Realtime spelling is new work under any reading, since isocan never built it.

### 2.3 `voiceAudio.ts` — lift it, do not rewrite it, and the reason is a bug history

560 lines containing capture, playback and the `Resampler`. The resampler exists because
a 44.1 kHz `AudioContext` answered **98% zeros** — speech that measured as silence — and
the fix was not obvious: `voiceAudio.ts:345` constructs `new Resampler(readyContext.sampleRate / 16000)`
against a provider that outputs 24 kHz (`:476` `new AudioContext({ sampleRate: 24000 })`,
`:496` `createBuffer(1, pcm.length, 24000)`). Two beads (`isocan-xsh.9`, `isocan-xsh.10`)
were spent on its boundary conditions, including epsilon-rounded indices.

This is the cheapest 560 lines in the harvest and the most expensive to reproduce, because
the cost is not in the code but in knowing which device sample rates break it. **Lift
whole, with its tests** (`packages/voice-agent/test/voiceresample.test.ts`).

### 2.4 The readiness gate — a small file's worth of hard-won behaviour

Yesterday's `isocan-xsh.8.5`/`8.4` fix (`d421632b`) is worth naming separately because it
is exactly the kind of thing a rewrite loses silently. Audio is gated on the provider's
own `setupComplete`, **not** on the socket being open; frames the gate refuses are counted
rather than dropped in silence; `audioUpFrames` increments *after* `socket.send` returns so
it means accepted rather than handed over; and the periodic stats line reports
`gatedBeforeSetup` and `lostAtSocket` beside it.

**The measured defect behind it — and the qualifier is load-bearing, so it travels with the
number.** These are **retained measurements, not re-taken for this harvest**: astra's
`readiness-defect.json` and `REPORT.md` for `isocan-xsh.8.5`, dated **2026-09-12**, record that a
local **500 ms delayed-ack keyless control sent 192 of 208 audio frames before `setupComplete`**,
and that a **real-key control sent 128 before acknowledgement and dropped 48 page frames** while
the provider transport was opening. The real control *answered*, so the bead is explicit that this
is a **readiness-contract defect, not a demonstrated historical silence** — the frames were lost,
and separately proved that a turn can come back missing its beginning. A voice harness written from
scratch will reproduce the defect, and will not notice, because the symptom is a turn that is
silently missing its first word.

There were **two** call sites — the node harness and `packages/modules/talk/src/web.tsx:483`
— which is the N3 duality showing up as a duplicated failure. Voicebox should have one.

### 2.5 `cli.ts` — the pi-shaped thing isocan already grew

`packages/voice-agent/src/cli.ts` is 230 lines and its header is a design argument for
N9 that isocan arrived at independently:

> *"There is deliberately only one of these. A person starts the agent with a command they
> can remember (`npm start -w @isocan/voice-agent`, or `npx voice-agent`), and `isocan rc`
> starts **the same file** with `--acp` when a summons arrives. Two entry points would mean
> two things that had to agree about the port, the home, the identity and the page, and the
> day they drifted is the day the summons opened a second microphone nobody was talking into."*
>
> *"This used to be a verb of the CLI (`isocan voice`), and the reason it is not any more is
> the same reason the page is not a route of the web app: neither the app nor the CLI needs
> to know how the voice agent works in order to point at it."*

**One binary, two modes: standing server, or ACP adapter.** That is the harness shape N3
wants, and it is already de-featured out of a larger CLI. Lift the *pattern* — it costs
nothing and prevents a class of drift bug.

### 2.6 The OPFS store — N4's client half, built and honest about its limits

`packages/voice-agent/src/main.ts` carries Paul's own ruling as a comment at `:2350`:

> *"the agent's own state (memory, and whatever else the page produces), while a
> DirectoryHandle is for reading the person's files. OPFS is per-origin, persistent, and
> needs no permission prompt, which is the whole reason it exists; the harness is the
> model-facing side and asks for what it needs rather than keeping a copy."*

And it does the two things that make it honest rather than convenient:
- **`navigator.storage.persist()` is requested and the answer is shown** (`main.ts:2502`) —
  because unpersisted origin storage can be evicted under pressure, and memory a
  housekeeping pass can delete is not memory.
- **The store is visible and deletable in the UI** (`:2361-2365`), with the per-origin,
  per-browser limitation *stated to the person* rather than hidden.
- A browser without OPFS, or a private window, still gets a working session: the store
  falls back to tab memory **and the note says so** instead of pretending the entries will
  be there tomorrow.

The broker pattern that goes with it — `createMemoryBroker` at `voice-harness.ts:591`,
wired at `:2445` — is the harness *asking the page* over a socket rather than holding a
copy. Same shape as the file tools. **That is N4's client half, and the seam is the part
worth copying**, not the code.

**A tension to name — and it is sharper than a tension, because one side is unreachable
from the other.** ds-flash-2's environment design puts state in a long-lived host process;
isocan's ruling puts the agent's own state in the page's OPFS. Those are not two answers to
one question, because **there is no path between them**. OPFS is per-origin and per-browser,
readable only by pages and workers of that origin in that profile. A host process has no
origin. A Telegram-driven session has no browser. Isocan's own source states the consequence
plainly, at `main.ts:2361-2364`:

> *"**The store is visible and deletable in the UI**, because it is per-origin and
> per-browser: **the terminal cannot read it**, and a different profile sees a different
> store. That is inherent — so the person gets the list and the delete, here, rather than a
> store they cannot inspect."*

*Inherent* is the operative word: this is not a missing feature that a bridge would fix. It
is what the storage primitive is.

**So the reconciling reading is not "OPFS is the cache and the server is the record"** — that
framing implies one authoritative copy reachable two ways, and here there are two disjoint
stores with no authoritative copy either can see. Anything written to OPFS is invisible to
every other door, permanently, until something explicitly moves it.

**And isocan already chose this, deliberately, in the opposite direction from what N4 needs.**
The migration it built runs *host → page*: `readLegacyMemories(home)`
(`voice-harness.ts:514`) offers the old harness file once, the page imports it into OPFS, and
`retireLegacyMemories(home)` (`:539`, used at `:3196` and `:3686`) retires the file
afterwards. State was moved **out of the terminal's reach** on purpose, under Paul's own
2026-09-13 ruling, and the transcript was left behind on the host (`voiceLogFile`, `:117-118`)
precisely because other surfaces consume it. That split is coherent for isocan, whose voice
agent is driven from its own page and has one door.

Voicebox wants several doors — a browser, a machine, and *"talking to it over Telegram while
it has access to the machine"*. **The ruling is right for a page-driven agent and wrong for a
multi-door one**, so it needs narrowing rather than inheriting: OPFS is the right home for
what only this client needs (device and UI preferences, the offline draft, a render cache),
and the wrong home for anything another door must read (memory, session state, the audit
log). Note that isocan has **no precedent for the reverse migration** — page → host — because
it never needed one. That direction is new work, and it is the piece that makes browser-only
mode and paired mode two views of one world instead of two worlds.

### 2.7 ACP — N4's secure reachability, already proven twice

`packages/cli/src/acp.ts` (**493 lines**), `packages/cli/src/rc.ts` (**202 lines**),
`packages/voice-agent/src/rc-rows.ts` (**97 lines**). ACP 1 client with `session/load` and
`session/prompt`, enrolments, and a permission round-trip. ds-flash-2's design already
proposes reusing it and names the four hard parts it solves: browser↔real-machine, real
harness CLI children, session continuity, and a permission round-trip. **792 lines for all
four is the best ratio in this harvest.**

### 2.8 What isocan does *not* answer

Its canvas (N5) is oriented to UI artefacts, which is exactly Paul's doubt, and §7 engages
with it. And the harness (`voice-harness.ts`, 5,271 lines) is saturated with isocan's
operation vocabulary — `Operation` values, one reducer, canvas items, presence, badges —
which is N6's problem: a *build* environment produces diffs, logs and exit codes, not
canvas operations. See §6.

---

## 3. Chrome Agent Platform — scored against the needs, on both of Paul's axes

Paul's verdict is *"Runtime no"*, with two axes of scepticism: **weight** and
**extensibility**. Taking them in turn, because they have different answers.

### 3.1 Extensibility: he is right, and the reason is that CAP solves a different problem

**pi's model is discovery.** From `docs/extensions.md` (3,023 lines): an extension is *a
TypeScript module*, auto-discovered from `~/.pi/agent/extensions/` (global) or
`.pi/extensions/` (project-local), hot-reloadable with `/reload`. The API surface an
extension touches is small and concrete: `pi.registerTool()`, `pi.registerCommand()`,
event interception (block or modify tool calls, inject context, customise compaction),
`ctx.ui` for select/confirm/input/notify, `ctx.ui.custom()` for full components, and
`pi.appendEntry()` for state that survives restarts. Its own documented use cases are
permission gates, git checkpointing, path protection, file watchers, webhooks.

**Adding a tool to pi is writing a file.** That is what "an extensible platform like pi is"
means, and it is why N7 and N9 point the same way.

**CAP's model is admission.** A tool in CAP is a frozen descriptor — `extension/lib/jwt-decode-tools.js`
is representative, and every field is load-bearing for governance:

```js
export const JWT_DECODE_TOOL = Object.freeze({
  toolId: "jwt_decode_bounded",
  sourceKind: "bundled-package",
  packageId: "core-jwt-decode",
  version: "1.0.0",
  canonicalNameClaim: false,
  admitted: false,          canExecute: false,      canGrant: false,
  availability: "disabled",
  capabilities: Object.freeze(["compute", "data.read"]),
  replayClass: "read-only",
  spdxLicense: "MIT",       licenceStatus: "owner-authorized",
  bounds: Object.freeze({
    tokenUtf8Bytes: 16384,  jsonDepth: 32,
    outputUtf8BytesIncludingLf: 32768, workerWallMilliseconds: 2000,
  }),
});
```

Adding a tool to CAP means a descriptor, a package row (`extension/lib/bundled-tool-packages.js`,
data in `bundled-tool-packages.data.js`), a licence status, an admission decision, and a
dispatcher. **That is not an extensibility surface; it is a supply-chain control.** It is
the right control for a product that ships bundled third-party code to end users, and it is
the wrong shape for *"give it new tools and skills when you need them."*

**Conclusion on axis 2: Paul's scepticism is correct and it is not a criticism of CAP.** The
two projects answer different questions — CAP asks *may this run*, pi asks *how do I add
this*. Voicebox needs pi's answer at runtime and may later want a fragment of CAP's.

### 3.2 Weight: measured, not adjectival

The numbers that make "too heavyweight" concrete:

| artefact | measured |
| --- | --- |
| `extension/wasm/cas` | **11 MB (10,744,087 bytes), 38 `.wasm` files** — a content-addressed store of the binaries themselves |
| `extension/wasm/manifests`, `licenses/`, `sbom/` | **38 manifests, 16 licences, 19 SBOM entries — *siblings* of `cas/` under `extension/wasm/`, not inside it.** Named separately because the layering is the point: the governance metadata is a parallel tree keyed to the store, which is what makes it a supply-chain system rather than a folder of binaries |
| `extension/wasm/manifests` | per-tool manifests (`cap.bundled.avif-1.0.0.manifest.json`, `awk`, `base64`, …) plus `licenses/` and `sbom/` |
| `wasm-tools/descriptors/foundation-descriptors.json` | **9 tool descriptors — all 9 `admitted: false`, all 9 `availability: "disabled"`, all 9 `dispatcherKind: "none"`, all 9 `availabilityReason: "package-execution-unwired"`** |
| store service-worker bundle | **2,998,629 bytes against `STORE_SW_BUDGET_BYTES = 3_000_000`** (`scripts/bundle-budget.mjs:16`, asserted equal to 3,000,000 by `tests/bundle-budget.test.ts`) — **1,371 bytes of headroom** (measured 2026-09-18, and reproduced from a clean `npm ci` + `deno install` + `build:production` by the independent recount; two source comments still say "~10 bytes under", which was true when written) |
| the budget gate | `tests/bundle-budget.test.ts`, 232 lines, with the constitution number pinned by a test that asserts it equals 3,000,000 |

**The single most important line in this harvest:** the Wasm tool catalogue is *described*
and not *wired*. Nine descriptors, zero dispatchers, eleven megabytes of content-addressed
binaries, manifests and an SBOM. So "take CAP's WebAssembly modules" does not mean inheriting
working tools — it means inheriting a **governance model and a store full of artefacts nothing
executes**. Anyone pricing that lift as "CAP already has Wasm tools" is pricing it wrong by
the whole dispatcher, which is the part that does not exist.

Weight also has a runtime cost, and it was measured yesterday rather than assumed: the store
SW bundle's **V8 compile is 42.61 ms at 2,998,629 bytes**, on a slope of **15.8 ms per MB**
across three real bundles (546 KB → 3.90 ms, 1.22 MB → 12.64 ms, 2.99 MB → 42.61 ms; five
fresh processes each). Minification roughly **doubles cost per byte** (0.71 → 1.42 ms/100 KB),
so a byte budget measures a different thing in a dev build than a store build. Caveat carried:
that is Node's V8 compiling an ES module, not Chrome starting a service worker, at one load.

### 3.3 Scored, part by part

| CAP part | Where it lives | Meets which need | Cost to lift | Verdict |
| --- | --- | --- | --- | --- |
| **Tool descriptor *vocabulary***: `capabilities`, `replayClass`, `bounds` | `extension/lib/jwt-decode-tools.js`; `wasm-tools/descriptors/foundation-descriptors.json` (schemaVersion 2) | N7, N6 — a tool that declares whether it is read-only and what its limits are is what makes a tier table data instead of prose | **Low.** Three fields, no machinery. `bounds` in particular (`tokenUtf8Bytes`, `outputUtf8BytesIncludingLf`, `workerWallMilliseconds`) is the shape every bounded tool wants | **TAKE the three fields** |
| **Admission machinery**: `admitted`, `canExecute`, `canGrant`, `availability`, `availabilityReason`, `canonicalNameClaim`, `spdxLicense`, `licenceStatus`, `packageId`, `sourceKind`, `dispatcherKind` | same files, plus `extension/lib/bundled-tool-packages.js` | **none of N1–N9** | High, and it is the weight Paul named | **LEAVE.** Voicebox has one user and one machine; there is no third-party supply chain to admit against. If it ever ships bundled tools to strangers, revisit |
| **Wasm CAS + manifests + SBOM** | `extension/wasm/cas` (11 MB / 10,744,087 bytes / 38 `.wasm` files) with `manifests/` (38), `licenses/` (16) and `sbom/` (19) as **siblings** under `extension/wasm/` | none, given zero dispatchers | 11 MB of artefacts, a 73-entry parallel governance tree, and a loader that does not exist | **LEAVE** |
| **Bounded Python tool** | `extension/lib/python-tool.js` (**52 lines**), `python-execution.js` (`PYTHON_EXEC_BOUNDS`, `runPython`) | **N6** — a build environment needs a compute tool | **Low and instructive.** 52 lines, fails closed with an honest "unavailable" rather than fabricating a result, and the runtime is an *injection seam* (`getPythonRuntime`) supplied by the build lane | **TAKE the shape**, not the runtime: fails-closed + injection seam + explicit bounds. Note it is deliberately **not** a WASI binary — separate Emscripten/JS-glue dispatcher, and the WASI import allowlist is not widened. For Voicebox, a local Python on the server is simpler and needs no admission at all |
| **ACP harness integration** | `docs/ACP-INTEGRATION-RESEARCH.md` (2026-09-12, status *Approved Architecture & Implementation Plan*, epic `chrome-agent-platform-qlho`); target harnesses **`pi` (primary / verified fixture), `claude-code`, `codex`, `antigravity`, `voice`** | **N3, N4, N6** — and `voice` is already a named target harness | **Medium, but the research is the valuable part.** JSON-RPC 2.0, `protocolVersion: 1`, newline-delimited over stdio, one JSON-RPC message per WebSocket text frame. The implementation is inside the extension's SW/Agent-Worker loop, which Voicebox is not reusing | **TAKE the document and the protocol facts**; take isocan's 792-line ACP *client* (§2.7) rather than CAP's |
| **Census-and-gate discipline** | `scripts/capability-lifecycle.ts` (259 lines), `tests/capability-gates.test.ts` (65), `tests/bundle-budget.test.ts` (232), `docs/admissions/` | none directly — but it is *how* CAP keeps a 3 MB bundle from drifting | Low as a practice, high as code | **TAKE the practice, leave the code.** Specifically: a budget that is a number in one place, asserted by a test that names the top contributors when it fails, with a recorded falsification (set the gate to 1 MB and watch it fail). Voicebox will want a cold-start budget, not a byte budget, and this is the template |
| **beads wiring** | `.beads/` (embedded Dolt), `AGENTS.md:108-113` (`bd ready` → `bd update --claim` → `bd close`), `.agents/skills/beads-flow` | none — it is fleet process, not product | Low | **Optional, and not a product decision.** Useful if Voicebox is built by the fleet; irrelevant to what ships |
| **Skills** | `extension/skills/skills-panel.js`; `skills/{web-resilience-audit,web-resilience-fix}` | N7 | Low — but note the only two skills present are *web-resilience's*, i.e. imported from §5 | **Take nothing here**; pi's `docs/skills.md` (232 lines) is the lighter model and the brief's reference point |

### 3.4 Where CAP's weight *is* justified — the honest half

It would be easy to write "CAP is all weight" and it would be wrong. Three things CAP has
that a light harness will otherwise discover the hard way:

1. **`replayClass`** — declaring a tool read-only versus state-changing is what makes an
   undo story possible at all, and what lets a permission gate be a table instead of a
   special case per tool. ds-flash-2's three tiers (never / unprompted / confirm) are the
   same idea, and CAP has the vocabulary already tested against real tools.
2. **`bounds` as data** — `workerWallMilliseconds: 2000`, `outputUtf8BytesIncludingLf: 32768`.
   Every tool that runs somebody else's code needs these, and writing them per-tool ad hoc is
   how a harness ends up with no timeout anywhere. `PYTHON_EXEC_BOUNDS` is a good example of
   the discipline *and* of it being revisited: stdin/stdout are `Number.POSITIVE_INFINITY`
   there by an explicit later decision (recorded as `dptw`) with only the wall-clock fence
   kept — so the bounds are argued, not inherited.
3. **Fails-closed honesty.** `python-tool.js`'s rule — *"Until the runtime is admitted,
   `pythonTool` fails closed with an honest 'unavailable' — it never fabricates a result"* —
   is a small sentence and a large discipline, and it is the same one that makes a voice
   agent trustworthy: a tool that cannot run must say so in words, not return an empty
   success.

**None of the three requires the admission machinery.** They are fields and a convention,
which is why the verdict above is *take the vocabulary, leave the pipeline*.

### 3.5 The answer to N2, in one paragraph

CAP should not be a runtime dependency, and Paul's instinct is right on both axes — but for
a reason worth stating precisely, because it changes what to copy. **CAP is an admission
platform and Voicebox needs a discovery platform.** The weight is not incidental bulk; it is
the cost of answering *may this third-party code run in a shipped product*, which is a real
question CAP answers well and a question Voicebox does not have. What transfers is small and
concrete: three descriptor fields (`capabilities`, `replayClass`, `bounds`), the fails-closed
convention, the ACP protocol research, and the budget-gate practice. What does not transfer is
everything that makes CAP CAP: the CAS, the SBOM, licence status, package rows, dispatcher
kinds, and a 3 MB service-worker budget with 1,371 bytes to spare.

---

## 4. pi — the standard for N9, and the thing to imitate rather than lift

pi is not a source of code here (it is the harness this lane is running inside, and the brief
points at it as a *shape*). What is worth harvesting is the specific property that makes it
feel light, because "minimalism" is otherwise an adjective:

- **One harness, no adapter zoo** — the brief's own words, and isocan's `cli.ts` arrived at
  the same place from the other direction (§2.5).
- **Extension = a file, discovered, hot-reloaded.** `~/.pi/agent/extensions/` or
  `.pi/extensions/`; `/reload`. No descriptor, no registration service, no admission.
- **A small, concrete API**: `registerTool`, `registerCommand`, event interception, `ctx.ui`,
  `appendEntry`. Documented in 3,023 lines — but the *surface* is six functions, and the
  documentation is long because the events are many, not because the contract is.
- **Skills are smaller than extensions**: `docs/skills.md` is 232 lines against 3,023. A skill
  is instructions; an extension is code. Keeping those two apart is most of why the model
  stays light, and CAP's skills panel does not make the distinction as sharply.
- **The SDK is a separate, larger surface** (`docs/sdk.md`, 1,224 lines) — i.e. embedding pi is
  a deliberate step up, not the default. Relevant to N3's server placement: the server side may
  want the SDK while the client wants the extension model.

**Cost to lift: zero, and that is the point.** What Voicebox takes from pi is the *decision*
that an extension is a file. If it takes CAP's descriptor instead, it has chosen the other
axis and should say so.

**One thing to check before imitating:** the brief wants *Fable through the pi harness*.
That is N8's third leg and it means pi is not only a design reference but a **runtime
peer** — the execution harness behind the voice, reached the way ds-flash-2's design reaches
a harness child. CAP's ACP research already lists `pi` as *"primary / verified test fixture"*,
so the integration is proven from CAP's side and from isocan's (`acp.ts`, §2.7), and Voicebox
would be the third client of the same protocol rather than an inventor of one.

---

## 5. The three smaller sources — specific, and each worth one thing

### 5.1 web-resilience — the evaluation discipline (N6's "how do we know it works")

`~/web-resilience`: `skills/web-resilience-audit` (URL → scenario matrix via **raw CDP** →
structured per-scenario findings: network failures, console errors, font status, perf,
screenshots, page text) and `skills/web-resilience-fix` (findings → remediation → re-run the
audit → **report the delta**). Directories: `eval/`, `fixtures/`, `guides/`, `harness/`,
`skills/`.

The reusable property is named in its own README: an eval framework with **competitive
isolation** — *"the skills are validated against independent ground truth, never against their
own output."*

**Why Voicebox needs it:** a voice agent that builds things will be evaluated by whether the
build worked, and the failure mode of every agent eval is grading against its own transcript.
The audit→fix→**re-audit→delta** loop is the shape, and it is provider-agnostic.

**Cost to lift: low for the pattern, medium for the code.** The CDP scenario matrix is
web-specific; the *loop* is not. Take the loop and the isolation rule; leave the scenarios
unless Voicebox builds websites (which, given `html` artefacts in isocan's voice agent, it
might).

### 5.2 wasm-vs-js — the evidence for whether Wasm belongs at all (N7)

`~/wasm-vs-js` measures, per its README: cold **transfer, compile, instantiate, initialize and
first useful output**; warm-up trajectories, steady runtime, **tail latency**; calls, copied
bytes, strings, references, callbacks and **boundary batching**; worker startup, message
transfer, shared memory; DOM updates and complete journeys; source, generated glue, raw,
**gzip and Brotli** sizes. It tests JS, linear-memory Wasm, WasmGC and mixed implementations,
and results stay grouped by workload, track, lifecycle phase, browser, device, build and cache
state *"because those conditions can change the answer"*. Timing begins only after output and
fixed-work checks pass, and an unsupported measurement is `unavailable` or `blocked` —
**numeric zero means the instrument measured zero**, which is a distinction most benchmark
suites lose.

**Why it matters to Voicebox:** the brief asks for Wasm modules from CAP. This repo is the
answer to *when that is worth it*, and it is a large, careful, Deno-based suite whose whole
thesis is that the answer depends on conditions. **Do not lift the suite.** Lift the
*conclusion discipline*: if Voicebox admits a Wasm tool, it should be because a measurement
said the crossing cost is repaid for that workload, and this is where such a measurement would
come from. Yesterday's number is a small related data point — 15.8 ms per MB of V8 compile, so
a 26 KB module costs ≈0.41 ms to compile, which is not where Wasm's cost lives (crossings and
instantiation are).

### 5.3 fauxmium — the "generate anything" precedent, and a warning

`~/fauxmium`: `browser.js`, `cli/`, `config/`, `extension/`, `index.js`, `lib/`, `pages/`,
`prompts/`. Launches Chrome, **intercepts navigations and image requests**, and routes them to
a local proxy that asks models to generate HTML and images for the requested URL — *"an
effectively infinite web"*.

**What is reusable:** the interception-plus-local-proxy pattern is a working answer to "the
agent produces an artefact and the browser shows it as though it were real", which is close to
N5's *build visible* and to isocan's `html`-kind item. It ships as `npx fauxmium`, so the
distribution shape is also a precedent.

**The warning, and it is the reason this section is short:** fauxmium generates a *fake* web.
Voicebox's brief is the opposite — *"Not a sandbox demo: it drives a build system that can
produce software."* The temptation is to reuse the generation pipeline and end up with
artefacts that look built and are not. **Take the interception pattern if a preview surface is
wanted; take nothing from its relationship to truth.**

---

## 6. Do NOT reuse — the tempting list, with reasons

| Tempting thing | Where it is | Why not |
| --- | --- | --- |
| **isocan's `voice-harness.ts` wholesale** | `packages/voice-agent/src/voice-harness.ts`, 5,271 lines / 234 KB | It is saturated with isocan's vocabulary: `Operation` values through one reducer, canvas items, presence, badges, passes, the daemon's door. Lifting it means lifting a canvas platform. **Mine it for four things instead** — the broker pattern (`createMemoryBroker`, `:591`), the permission gate, the transcript log (`voiceLogFile`, `:117-118`, `~/.isocan/voice/log.json`, capped in-memory window of 200 with the file as the record), and the readiness gate (§2.4) |
| **isocan's operation/reducer model for a build** | `packages/core` | N6 is a *build*: files, commands, exit codes, diffs, test output. Isocan's model is a *canvas*: spatial items with versions. Forcing a build into spatial ops is the mistake the brief half-names in N5. A build wants an append-only log of acts and a diff view — which is what ds-flash-2's host already proposes |
| **CAP's Wasm CAS, SBOM, licence status, package rows, dispatcher kinds** | §3.2, §3.3 | 11 MB of artefacts, zero wired dispatchers, and a governance model for shipping third-party code to strangers. Voicebox has one user and one machine |
| **CAP's 3 MB service-worker budget as a number** | `tests/bundle-budget.test.ts`, `STORE_SW_BUDGET_BYTES = 3_000_000` | It is a *proxy*, and yesterday's mandate was explicit that a proxy should follow the evidence. The measured relationship is 15.8 ms of V8 compile per MB, so the honest budget for Voicebox is a **cold-start budget in milliseconds** with bytes as one input. Copying 3,000,000 would be inheriting a number whose reason lives in a different product |
| **`packages/modules/talk/src/live.ts` — the deliberate duplicate** | 1,179 lines, header: *"COPY of packages/voice-agent/src/live.ts — duplicated deliberately (Paul, 16 Sep 2026) so the talk module carries no dependency on the harness package. The harness file remains the owner; when either changes, reconcile the two by hand."* | **Do not repeat this.** It is a real decision with a real cost, visible in the tree: a hand-reconciliation rule between two 1,170-line files. Yesterday's readiness-gate fix had to be applied to *both* call sites, and a harness-only fix would have left the browser path sending audio into the setup window. Voicebox should have **one** provider face imported by both placements — which is what `live.ts` was extracted to enable in the first place, and what the copy then undid |
| **fauxmium's generation-as-truth** | §5.3 | The brief's principle 2 is the opposite. Artefacts that look built and are not would be the worst failure mode of a voice agent, because voice makes it harder to inspect what happened |
| **A second ACP implementation** | CAP's is inside its SW/Agent-Worker loop | isocan's `acp.ts` + `rc.ts` + `rc-rows.ts` is 792 lines, standalone, and already drives real harness children with a permission round-trip. CAP's research doc is the map; isocan's client is the part |

---

## 7. The canvas doubt (N5), engaged rather than answered

Paul's words carry the doubt deliberately: *"I kind of need the canvas part of this thing.
It's very much focused on the UI versus the build — but maybe that's where I'm kind of making
some mistakes."* The brief says engaging with the doubt is worth more than drawing a better
canvas. So, three observations from the source rather than an opinion.

**1. Isocan already splits the two things a canvas is asked to be.** Artefacts go on the
canvas as items — including, since `a770255c`, *pages the voice builds itself*: `kind: 'html'`
with the full markup in `text`, embedded as an interactive item (`packages/modules/talk/src/live.ts:800-815`,
declared at `:139-153`). Process goes in a log — `voiceLogFile` at `voice-harness.ts:117-118`,
persisted to `~/.isocan/voice/log.json`, surviving harness restarts, with the in-memory window
capped at 200 and the file kept as the record, exposed machine-readably at `GET /log`.

**That split is the answer to the doubt, and isocan arrived at it without naming it.** A canvas
is right for *what was made*; it is wrong for *what happened*. A build is mostly the second
thing — commands, exit codes, diffs, test output — and every attempt to spatialise a timeline
produces a wall of cards nobody reads.

**2. So the honest reading of N5 may be narrower than "the canvas".** What Paul wants is that
the building is *visible* while he is talking about something else (N1: the conversation stays
available). Visibility for a build is: what ran, what changed, what failed, and the artefact
when there is one. Three of those four are a **log and a diff**, not a canvas. The fourth —
the artefact — is where isocan's canvas genuinely earns its place, and where a page, a diagram
or a prototype is better as a thing you can look at beside the conversation than as a line in a
transcript.

**3. The risk of taking the canvas wholesale is that it imports the UI orientation Paul is
worried about.** Isocan's canvas vocabulary is spatial: items, areas, groups, placement,
versions, presence. Its own project index shows where the work went — `design-competition`,
`design-lint`, `design-partner`, `ui-refresh` are all `docs/projects/` entries, and every
project doc is fronted by a `journey.md` written as an acceptance suite for something a person
looks at. That is a design tool, and it is a good one. A build environment that inherits its
vocabulary will keep finding itself asking how a failing test is an item with a width and a
height.

**Recommendation, offered as a scoping rather than a decision:** take the *artefact surface*
(something made can be looked at, beside the conversation) and the *log/diff surface* (what
happened is inspectable and survives a reload), and treat "canvas" as the name of the first
one only. Whether the artefact surface is spatial is then a UI question for astra's lane with
one constraint attached: **it must not become the place where process is recorded**, because
that is the mistake the doubt is pointing at.

---

## 8. The lift list, re-marked against the line Paul drew

> **A constraint arrived after this document was written, and it changes this section rather
> than the findings.** Paul, 2026-09-19: *"I want to make sure that we're **not using
> isocan**… that's not the project we're using for the server interaction, right? I just want
> the UI to **look like it** now… **Use isocan as the inspiration**."*
>
> So: **isocan is inspiration and prior art, not a dependency.** Nothing may be imported from
> it, vendored from it, or coupled to `@isocan/core` or `@isocan/api`. That invalidates the
> framing this section originally had — several items were costed as *separation work on code
> that already runs*, which is only cheap if importing it is allowed. **Every finding elsewhere
> in this document is unaffected**, and two of them get more valuable (§8.2).

Each item is now marked with what it actually is under that line:

- **PATTERN** — an architecture or shape to reimplement. Reading isocan's version is the point;
  copying it is not allowed.
- **TECHNIQUE** — a convention, a discipline, a web-platform API, or a vocabulary. Nothing to
  copy; it was never isocan's property.
- **WOULD REQUIRE THE DEPENDENCY** — cannot be taken at all under the line. Only its pattern
  survives, and the cost column reflects reimplementing it.

| # | Item | Kind | From (as prior art) | Cost under the line | Serves |
| --- | --- | --- | --- | --- | --- |
| 1 | **Provider face**: model setup, tool surface and call planner as pure data and functions, browser-safe, shared verbatim by both placements | **WOULD REQUIRE THE DEPENDENCY** → its **PATTERN** | `isocan/packages/voice-agent/src/live.ts`, 1,173 L, imports 9 names from `@isocan/core` + a type from `@isocan/api` | **3–5 days**, was 1–2. Reimplement, not strip. The provider *facts* are still free: `docs/projects/voice-agent/design.md` §1 is a dated audit of the Gemini Live API that can be **read**, which is inspiration and saves the research | N8, N3 |
| 2 | **Capture, playback and the resampler** | **PATTERN** (and see §8.1) | `isocan/.../src/voiceAudio.ts`, 560 L — **zero imports of any kind**, plus `test/voiceresample.test.ts` | **2–4 days**, was "hours". The DSP is not the cost; re-finding the boundary conditions is, and those are documented in two beads (`isocan-xsh.9`, `isocan-xsh.10`) which are findings and travel freely | N1 |
| 3 | **The readiness gate** — audio gated on the provider's own `setupComplete`, refused frames counted, `send` counted only after it returns | **TECHNIQUE** | `voice-harness.ts` `send()` + `talk/src/web.tsx:483`, commit `d421632b` | **half a day**, unchanged — and *more* valuable now (§8.2) | N1 |
| 4 | **One binary, two modes** (standing server / `--acp` adapter) | **PATTERN** | `isocan/.../src/cli.ts`, 230 L, and the argument in its header comment | **hours**, unchanged. Was already marked "the pattern, not the file" | N3, N9 |
| 5 | **ACP client** — browser↔machine, real harness children, session continuity, permission round-trip | **WOULD REQUIRE THE DEPENDENCY** → **PATTERN over a public protocol** | `isocan/packages/cli/src/acp.ts` (493 L, imports `@isocan/api` + two local modules), `rc.ts` (202 L, imports `@isocan/api` + `@isocan/rc`), `rc-rows.ts` (97 L) | **3–5 days**, was 1–2. The protocol is **not isocan's** — ACP is an open standard with `@agentclientprotocol/sdk` — so this is implementing a client against a spec, with isocan's as prior art for the four hard parts. Cost rises, but not to "invent a protocol" | N3, N4, N6 |
| 6 | **OPFS store discipline**: `persist()` requested *and the answer shown*, store visible and deletable with its per-origin limit stated, tab-memory fallback that says so | **TECHNIQUE** (web-platform APIs) | `isocan/.../src/main.ts:2350-2412`, `:2502` | **1 day**, unchanged | N4 |
| 7 | **Three descriptor fields** — `capabilities`, `replayClass`, `bounds` — as data on each tool | **TECHNIQUE** (vocabulary; CAP's, not isocan's) | CAP `extension/lib/jwt-decode-tools.js` | **hours**, unchanged | N6, N7 |
| 8 | **Fails-closed convention + injection seam** | **TECHNIQUE** | CAP `extension/lib/python-tool.js`, 52 L | **hours**, unchanged | N6, N9 |
| 9 | **Budget-gate practice**, applied to a *cold-start ms* budget rather than bytes | **TECHNIQUE** | CAP `tests/bundle-budget.test.ts`, 232 L, as template | **1 day**, unchanged | N2, N6 |
| 10 | **Audit → fix → re-audit → delta**, validated against ground truth that is not its own output | **PATTERN** | `web-resilience/skills/*`, `eval/` | **2–3 days**, unchanged | N6 |
| 11 | *Maybe* the interception-and-preview surface | **PATTERN** | `fauxmium/browser.js`, `lib/` | unclear; scope first | N5 |

**Not in the list, deliberately:** the Wasm CAS, the admission pipeline, isocan's
harness and operation model, the `talk` duplicate, and any byte budget copied as a number.

### 8.1 The constraint bites on three of eleven items — and they are the three I called cheapest

Items **1, 2 and 5** are the only ones that were costed as lifts. Everything else was already a
pattern or a technique, and their costs do not move. So the correction is concentrated, and it is
worth saying plainly because it inverts the shape of the original list: **the items that looked
like the best value per unit of cost were the best value precisely because they were code that
already ran.** Under the line, they are the expensive ones.

**Revised total for items 1–10: three to four weeks of one person**, against the two to three
originally stated. The increase is entirely in items 1, 2 and 5. What the harness becomes at the
end of it is unchanged — two providers, browser and machine, client storage and server action,
bounded tools that fail closed, and a way to prove whether it got faster — but it is *written*
rather than *separated*, and the estimate should not inherit the earlier optimism.

**One distinction worth putting to Paul rather than deciding for him**, because it is a large cost
lever and only he can pull it. "Not using isocan" could mean either:

- **(i) no architectural dependency** — voicebox must not be coupled to isocan as a platform, but
  isocan's Apache-2.0 code may be copied with attribution where it is genuinely self-contained;
  or
- **(ii) no isocan code at all** — everything is reimplemented from the pattern.

This document assumes **(ii)**, which is the stronger reading and the one coord stated. The case
that makes the choice concrete is item 2: `voiceAudio.ts` has **zero imports** — not one
`@isocan/*` reference, 560 self-contained lines — and isocan carries an **Apache-2.0 `LICENSE`**,
so under (i) it is an attributed copy costing hours, and under (ii) it is a rewrite costing days
whose main risk is re-discovering boundary conditions that two beads already paid for. Neither
reading is wrong; they cost differently, and the difference is largest exactly where the prior art
is most expensive to have learned.

### 8.2 Two findings that get *more* valuable under the line, not less

The constraint removes code and leaves findings, and findings were always the more transferable
half.

**The readiness gate (§2.4) is prior art at its best: a defect somebody else already paid for.**
A from-scratch implementation will gate audio on the socket being open, because that is the
obvious thing to write, and will not notice — the symptom is a turn silently missing its first
word, which reads as a model problem or a microphone problem rather than a readiness problem. The
retained 2026-09-12 measurements (192 of 208 frames before `setupComplete` on a keyless
500 ms delayed-ack control; 128 before acknowledgement and 48 page frames dropped on a real-key
control) are the reason to write the gate correctly the first time. **Reading them costs nothing
and is exactly what "use isocan as the inspiration" means.**

**The deliberate 1,179-line duplicate (§6) is a lesson that only applies to a from-scratch
build.** Its header says *"reconcile the two by hand"*, and yesterday's readiness-gate fix had to
be applied to **both** call sites — a harness-only fix would have left the browser path sending
audio into the provider's setup window. Under the line, voicebox writes both placements anyway,
so the instruction is free to follow: **one provider face, imported by both**, which is what
`live.ts` was extracted to enable in isocan and what the copy then undid.

The same applies to the smaller traps recorded in this document and in
[`04-dynamic-tools.md`](04-dynamic-tools.md): the `promptGuidelines` bullets appended flat with no
tool-name prefix, `prepareArguments` running before schema validation, and the trust gate sitting
on discovery rather than on runtime registration. None of those is code. All of them are things
somebody already found.

---

## 9. What this harvest could not settle

Named rather than smoothed over, since three of these are decisions and not research:

1. **Where the agent's own state lives — and this one is not symmetric, so it should not be
   framed as a choice between two equivalents.** The page's OPFS (isocan's ruling) is
   **unreachable from every other door by construction**, not by omission: `main.ts:2361-2364`
   says *"the terminal cannot read it… That is inherent."* The host process (ds-flash-2's
   design) is reachable from all of them. §2.6 sets out the consequence and the narrowing it
   implies.

   **The bearing on a decision in flight:** describing a browser-only session's page-local
   state as *a cache of a paired host's record of truth* is too generous in one specific
   direction. A cache implies one authoritative copy reachable two ways; here nothing written
   in browser-only mode is reachable from the host at all, so pairing does not retroactively
   make it visible — it has to be **migrated**, explicitly, once, in a direction isocan has no
   precedent for. Browser-only mode is therefore not a degraded view of the same world but **a
   separate world**, and which world the agent is in is decided by which door was used. That
   is still a perfectly good mode to ship — it is the no-install first run — but it should be
   described as *a separate world with an explicit one-time export on pairing*, and the
   design should decide now what is exportable, because memory written before pairing is
   otherwise stranded in it.

   The narrow version of the recommendation, if it is useful: **OPFS holds what only this
   client needs; the host holds everything another door must read; and the export runs page →
   host once, on pairing, with the page's copy demoted to a cache only after the host has
   acknowledged it.** Isocan's `readLegacyMemories`/`retireLegacyMemories` pair is the shape to
   copy, reversed — including its two good properties, that the offer is made once and that
   the old copy is retired rather than left to drift.
2. **Whether the canvas is spatial** — §7 recommends narrowing "canvas" to the artefact surface
   and keeping process in a log and diff. That is a UI question for astra's lane with evidence
   attached, not an answer.
3. **Whether N3 generalises** — Paul's own doubt. The evidence here says the *mechanism*
   generalises (`live.ts` is browser-safe by construction, `cli.ts` is one binary two modes,
   and isocan runs both today) and that the *harness* does not (`voice-harness.ts` is 5,271
   lines of canvas vocabulary). So the precedent generalises if Voicebox lifts the provider
   face and the entry-point pattern and writes its own harness — which is items 1, 4 and 5
   above, and not item 6's neighbour in the "do not reuse" table by accident.
4. **The OpenAI Realtime spelling does not exist.** `live.ts` is Gemini Live; the provider seam
   is real but single-tenant, and isocan's own design doc records OpenAI Realtime as designed
   and never built. N8's second leg is new work, not a lift, and should be costed as such
   rather than discovered during it.
