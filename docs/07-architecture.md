# Architecture — what this system is tonight

**This is a snapshot, not a spec.** It describes the tree it sits in, including the parts that are
placeholders, and `scripts/docs-check.mjs` fails when the enumerable claims below drift from the code. For
what voicebox is *meant* to be, read [`00-brief.md`](00-brief.md) (Paul's words), [`02-environment.md`](02-environment.md)
(the environment design — a **design record**, not a description of this tree) and [`01-questions.md`](01-questions.md).

The distinction matters more here than in most repositories: `02-environment.md` and
[`05-harvest.md`](05-harvest.md) are **design records** — they describe systems that may not exist yet, and
they are allowed to. This file and [`08-how-it-runs.md`](08-how-it-runs.md) are **snapshots** — they describe
what runs, and a claim in them that the code contradicts is a bug in the document.

## Components

| component | file | authority for | state |
|---|---|---|---|
| the page | `public/index.html`, `public/fused.js`, `public/style.css` | the interface: objects on a canvas, the turn box, the transcript | real, with labelled simulations |
| the server | `server.mjs` | routes, static serving, running actions, the workspace | **zero dependencies** (`node:http`) |
| the turn resolver | `lib/resolver.mjs` | turning a transcript into an action `{ verb, name, content? }` | **one provider, three verbs — a placeholder** |
| the environment core | `core/*.ts` | the tier table, policy, containment, the audit, project records | the E1-M0 library; not yet wired to the page |
| the tool | `tools/create-asset.wat` | the one tool E1-M0 runs, as a Wasm module | present, exercised by `tests/` |
| the dev server | `vite.config.js` | HMR, proxying `/api` (and `/live`, for work not yet landed) | dev only — never the production path |

**What is here tonight:** `lib/live-session.mjs` (the upstream live session) and `lib/ws-server.mjs` (the
WebSocket transport) have landed, and the page loads `live-voice.js`, which opens `/live` and streams PCM
through `pcm-worklet.js`. The generated line below says what the model is; the *turn* path is still the
`script` placeholder, and those two facts are what an earlier version of this file managed to conflate.

<!-- BEGIN GENERATED: live-session -->
`lib/live-session.mjs` is present, using model `(not found — the check could not read it)`.
<!-- END GENERATED: live-session -->

## The turn path, in order

```
page  --POST /api/turn {transcript}-->  server.mjs  --resolveTurn(transcript, provider)-->  lib/resolver.mjs
        <--- {transcript, action, result} ---  server executes the action (write/read/list) in workspace/
```

The server **never parses language itself**: `resolveTurn` returns an action, and the server runs it. That
is the whole seam, and it is why swapping the brain does not touch the page or the server.

<!-- BEGIN GENERATED: providers -->
Registered resolvers: `script` (one — a placeholder)

* `registerResolver(name, fn)` is the seam; `resolveTurn(transcript, provider = "script")` picks one.
* The **script** provider handles `write`, `read` and `list`: `"create a file called hello.txt with hi"` → `{"verb":"write","name":"hello.txt","content":"hi"}`.
* Anything else is **unresolved**, by design: `"book me a flight to Lisbon"` → `"the script resolver only knows create/read…"`.
* Planned, and **not registered**: `gemini-live`, `openai-realtime`.
<!-- END GENERATED: providers -->

## The routes, as they answer

<!-- BEGIN GENERATED: routes -->
The zero-dependency server (`server.mjs`, `node:http`) binds **127.0.0.1** and serves:

| method | path | probed status |
|---|---|---|
| `GET` | `/` | 200 |
| `GET` | `/api/health` | 200 |
| `GET` | `/api/files` | 200 |
| `POST` | `/api/turn` | 200 |

Anything else that exists under `public/` is served from there (`GET /static` and a fall-through), which is how the page, its scripts and the styles arrive. `/api/health` answers `provider: "script"`, `declared: false` and `root: { kind, path }` for the ACTIVE project root — which the environment declares (`POST /api/root`); the loop has no root of its own, and refuses by name (`root-not-declared`) until one is declared.

A WEBSOCKET UPGRADE ON /live CLOSED WITHOUT AN HTTP RESPONSE — the server destroys it (also a form of owning the route).
<!-- END GENERATED: routes -->

## What the page actually loads

<!-- BEGIN GENERATED: page -->
The page loads `fused.js` and `pip-mic.mjs` and `live-voice.js` from `public/`.
Audio worklets loaded by that code: `pcm-worklet.js`.

`app.js` and `verify.mjs` sit in `public/` but are **not** loaded by `index.html`; they are support files, not part of the page's load set.
<!-- END GENERATED: page -->

## The audio path, tonight

<!-- BEGIN GENERATED: live-session -->
`lib/live-session.mjs` is present, using model `(not found — the check could not read it)`.
<!-- END GENERATED: live-session -->

## Where each file's authority lies

- **`server.mjs`** is authoritative for the routes and for what an action *does* (it executes verbs, it does
  not interpret them). It binds `127.0.0.1` only.
- **`lib/resolver.mjs`** is authoritative for the provider list, and for what a transcript means. Its
  contract is one function; a new brain is a `registerResolver` call.
- **`core/`** is authoritative for the tier table, containment and the audit — and it is a **library**: it
  imports nothing outside `core/`, because two copies of it would drift silently (see the design's N18).
- **`public/fused.js`** is authoritative for what the page shows, and it **labels its own simulations on the
  page**: files, the turn submission and the containment refusals are real; the shared view, seen-marks and
  admission are simulated and say so. A reader should trust that label over any prose, including this file.
