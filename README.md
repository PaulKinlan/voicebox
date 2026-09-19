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

Seeded 2026-09-19 from a spoken brief. Design in progress.


## Running (the skeleton loop)

```sh
node server.mjs            # serves the page on http://127.0.0.1:8787
```

Open the page in Chrome, press the mic, and speak — e.g. *"create a file called
hello.txt with hello world"*, *"read hello.txt"*, *"list files"*. A text field
does the same without a mic. Every turn is captured, resolved to an action, and
the result is written into `workspace/` — a real directory on disk.

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
- **The action executor** — writes/reads/lists files in `workspace/` on disk.
  This is the honest version of "it makes things": it makes files.

What does not work yet:

- **No live model.** The resolver is scripted; nothing calls Gemini Live or
  OpenAI Realtime. The seam is `lib/resolver.mjs` — wire a resolver that calls
  the model and returns the same `{ verb, name, content }` shape and the rest
  of the loop is unchanged.
- **No streaming conversation.** One turn per press; the always-on conversation
  from the brief comes with the live model.
- **The workspace is a flat directory** — no project scaffolding, no shell. (The
  environment page below is where projects exist; the skeleton loop above still writes
  loose files into `workspace/`.)

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
