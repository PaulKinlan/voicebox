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

## The two paths, stated separately

The largest gap in this product was invisible because one word — *live* — covered two different things:
the **audio** path and the **turn** path. They are not the same, so they are not written as one:

<!-- BEGIN GENERATED: providers -->
Registered resolvers: `script` (one — a placeholder)

* `registerResolver(name, fn)` is the seam; `resolveTurn(transcript, provider = "script")` picks one.
* The **script** provider handles `write`, `read` and `list`: `"create a file called hello.txt with hi"` → `{"verb":"write","name":"hello.txt","content":"hi"}`.
* Anything else is **unresolved**, by design: `"book me a flight to Lisbon"` → `"the script resolver only knows create/read…"`.
* Planned, and **not registered**: `gemini-live`, `openai-realtime`.
<!-- END GENERATED: providers -->

<!-- BEGIN GENERATED: live-session -->
`lib/live-session.mjs` is present, using model `(not found — the check could not read it)`.
<!-- END GENERATED: live-session -->


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
default is a decision nobody made, and `workspace/` was exactly that.

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
  environment page declares (or `VOICEBOX_WORKSPACE` at boot). It used to say `workspace/`, which
  stopped being true the moment the default root was retired: the loop has no root of its own, and a
  sentence naming one was the last piece of the second root left standing in the docs.

What does not work yet:

- **No live model.** The resolver is scripted; nothing calls Gemini Live or
  OpenAI Realtime. The seam is `lib/resolver.mjs` — wire a resolver that calls
  the model and returns the same `{ verb, name, content }` shape and the rest
  of the loop is unchanged.
- **No always-on conversation.** While a live session is open the mic streams
  continuously, the model replies, and you can interrupt it — that part landed.
  What is missing is the version with **no press at all** (a wake word or a
  standing session), which is what the brief's "always-on" means.
- **The loop has no root of its own.** It writes into the active project root, which the
  environment declares — OPFS, a folder you picked, or a folder on this machine — and it
  refuses by name when the root belongs to another placement (see the environment page
  below, and `docs/evidence/one-root-20260920/RECEIPT.md`). There is no `workspace/`
  default any more: what used to be two roots is one.

## The browser environment (E1-M0 + N20)

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
  `workspace/` — each labelled with its own authority, each a single bounded listing.
- Failures have names: `needs-gesture`, `permission-denied`, `handle-gone`,
  `root-unreachable`, `not-found`, `not-a-project`.

Checks: `npm run test:e1m0` (25 acceptance checks, driven in a real headless Chromium).
Evidence, including what the platform actually does with a dropped folder and the two
behaviours that cannot be driven headlessly: [docs/evidence/picked-root-20260919/RECEIPT.md](docs/evidence/picked-root-20260919/RECEIPT.md).

Next step: wire the first live model resolver behind the seam (Gemini Live),
then grow the action set toward the build environment.
