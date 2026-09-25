# How it runs — the operating model tonight

**A snapshot, not a spec.** [`07-architecture.md`](07-architecture.md) says what the pieces are; this says
what starts what, on which ports, and what must stay true while it runs. `02-environment.md` is the design
record for where this is going; this file is where it is.

## The operating model

There is **no service to install and nothing to keep running**. The system is one Node process serving a
static page and three API routes, plus — in development only — a Vite process in front of it for HMR.

```
developer ──browser──> Vite (dev only, :5173) ──proxy /api──> server.mjs (:8787)
                             │                                   │
                             └── serves public/ ──────────────────┴── reads/writes the active project root
```

The active project root is wherever the environment declares it (or the boot-time workspace
variable, which is a declaration too) — the server's `GET /api/root` answers where, so this
diagram does not have to.

In production there is no Vite: `node server.mjs` serves the same `public/` directory itself, from disk (including `changelog.html` and `GET /api/changelog`).

## Ports, and why

| port | who | why |
|---|---|---|
| **8787** | `server.mjs` (`PORT` overrides) | the zero-dependency server. **Binds `127.0.0.1` only** — see the single-host rule. |
| **5173** | Vite (`npm run dev`), `strictPort: true` | dev only. A server that silently lands on another port gets measured as the wrong server, so Vite **exits** rather than drifting. |
| **8794 / 8790 / 8792 / 8796** | ad-hoc inspection servers | not part of the system; they are how a person looks at it from another machine. |

## The single-host rule

**The server binds loopback and is reached from the same machine.** That is not a limitation to be worked
around casually — it is the rule the whole environment design rests on (the design's §1.1b: *the host is
wherever the files are, and the browser is always a client*). Two consequences worth stating:

- A page loaded from **another origin** is a client of this host only if it can reach loopback, which is why
  the dev server proxies rather than the page fetching cross-origin.
- **Serving this on `0.0.0.0` is a different product**, with a different trust story, and it is not this tree.

## The dev environment

```bash
npm run serve      # node server.mjs — the real thing, no dependencies, port 8787
npm run dev        # Vite in front: :5173, proxies /api, HMR as you edit
npm run docs:check # the docs drift check (see below)
```

Three things about the dev loop that are easy to get wrong and are therefore written here:

- **The tailnet door has a firewall half.** The dev front is also served over Tailscale Serve at
  `https://<node>.<tailnet>.ts.net/` (vite.config.js allows the `.ts.net` Host). If a peer sees
  `ERR_CONNECTION_ABORTED` on that URL **while every local check passes**, the cause is `ufw`
  refusing incoming on `tailscale0` — a local test to the machine's own tailnet address never
  crosses the interface the firewall is refusing, so "it works here" proves nothing. Fix:
  `sudo ufw allow in on tailscale0`.

- **Vite is dev-only.** `server.mjs` stays zero-dependency and remains the production path; nothing in it
  imports Vite, and it runs with no `node_modules` at all. That is verified by serving the page on a machine
  with nothing installed.
- **A write goes where you are standing, and says what was observed** (voicebox-beads-s61). The room's own
  commands for a picked folder name a FILE, so a bare name means "here, in the folder on screen" — for the
  write *and* the read — while a name that already carries a path is honoured as itself. This is the same
  rule the listing and the reader follow, and it was not: standing in `proposals`, "create a file called x"
  wrote x at the folder's root, quietly ignoring which folder the person was looking at. The write line then
  reports the size the FILE SYSTEM reported (read back after `close()`), not the number of bytes the code
  intended to write, and whether the storage is durable — because "saved" and "saved durably" are different
  promises. If the read-back disagrees, the write is refused by name rather than reported as a success.
- **One frame makes the list move without the page asking.** The server sends `{type:"tool"}` when a live
  model runs a command; `public/live-voice.js` forwards it and `public/fused.js` re-reads the file list. That
  is the whole path from "the model wrote a file" to "the file is on screen": no polling, no refresh, and the
  opening reader and scroll position survive the re-read (voicebox-beads-a93).
- **Live task frames mount the task card immediately.** The server sends `{type:"task"}` when a task is
  delegated; `public/live-voice.js` forwards it to `public/fused.js` which dynamically displays the task card
  with agent name, address, and live status without manual status checks (voicebox-beads-8fv.4).
- **Fleet addressability across environments.** Agents are addressed by `environmentKey/agentId` (e.g. `local/pi`, `env_b/worker`) or `environmentKey/agentId:sessionId` (`core/fleet.ts`, `lib/fleet.mjs`). If an environment is stopped or unreachable, requests to it refuse by name (`environment-unreachable`) without blind rerouting. Existing session contact reaches active interactive sessions without creating replacement sessions (voicebox-beads-8fv.3).
- **WASM shelf tools discoverable and invocable via extensions.** Admitted shelf tools (e.g. `hash.wasm`, `diff.wasm`) surface in `list_extensions` with their measured boundary (zero imports, admitted digest, buffer-abi) and execute through `call_extension` via `lib/wasm-shelf.mjs`, decoding Hirschberg line diffs into structured blocks without separate wasm-specific tooling routes (voicebox-beads-9nk).
- **The proxy's `/live` entry and the transport behind it.** Vite proxies `/live` with `ws: true`; the
  zero-dependency server hands the upgrade to `lib/ws-server.mjs`, which runs the session in
  `lib/live-session.mjs`. The proxy entry and the route are two halves of one path — and the route table
  above is generated by probing the server, so if that ever stops being true, the doc changes rather than
  the reader being misled.

## Invariants

These are the things that must stay true; each is checkable, and the first three are checked.

1. **The turn path is exactly one seam.** The server executes actions and never parses language; every verb
   comes from a registered resolver. (`docs-check` reads the provider list from the module that registers it.)
2. **The page's load set is what the document says it is.** (`docs-check` reads `public/index.html`, including the room folders bar, and settings, environments, extensions, and harnesses modals.)
   The room interface (`public/index.html`, `public/fused.js`, `public/style.css`) is built with modern web
   standards: native `<dialog>` modals with `closedby="any"` and unified light-dismiss fallbacks, container queries
   for component-scoped layouts, semantic `<search>` landmarks, and scroll containment (`overscroll-behavior: contain`).
3. **A route a document claims is a route that answers.** (`docs-check` probes a live server on a scratch
   port — the same thing the suite does, because "it serves" and "the doc says it serves" are different
   claims.)
4. **`core/` imports nothing outside `core/`.** (Checked in the test suite; the design's N18 explains why a <!-- docs-check: names the mechanism -->
   second copy is worse than no copy.)
5. **Containment resolves and refuses.** `resolveInsideRoot` rejects any `..` segment and absolute paths;
   `tests/containment-paths.test.mjs` names the escaping case and carries a positive control.
6. **Nothing in `public/` trusts a transcript.** The page's own note says so, and the suite drives an XSS
   payload through the API and asserts it never becomes elements.
7. **Harness configuration distinguishes runtime, agent, and environment.** (`core/harness-config.ts`,
   `lib/harness-config.mjs`). Configured agent records are secret-free, permanent IDs are distinct from
   mutable names and transient task addresses, and stdio CLI adapters are refused in browser runtimes.

## Keeping this document true

```bash
node scripts/docs-check.mjs           # exit 1 when a generated block has drifted; prints which documents
node scripts/docs-check.mjs --write   # regenerate them in place
```

`tests/docs-drift.test.mjs` runs the same check inside the suite, so drift **fails a test** rather than
waiting for someone to remember. The generated blocks are marked `BEGIN GENERATED:` / `END GENERATED:` in
this file, in `07-architecture.md` and in `README.md`; everything outside them is written by a person.

**What this check cannot see**, stated so nobody trusts it further than it goes: it derives the provider
list, the probed routes, the page's scripts and the presence of a live-session file. It cannot tell whether
a *sentence* in prose is still true, and it does not try.

### The hand-written half

```bash
node scripts/docs-touched.mjs          # exit 1 when a change moves a described file and no document moves
```

The rule is Paul's: **every update updates the docs and the README in the same change.** The generated
blocks answer for themselves; the prose around them had nothing watching it — and on 2026-09-20 a
hand-written paragraph in the README was false *within the hour*, because a route landed underneath it
while the generated block beside it went red and was regenerated.

So the documents' own declarations are the mechanism: **every file path a document names in backticks is a
file that document describes.** Change one of those files and touch no document, and the push is refused,
naming the file and every document that names it. It runs first in the pre-push gate, before the suite,
because it costs one `git diff`.

**It must not become a gate that always fails**, so there is an explicit way past, and it is a record
rather than a shrug:

```bash
git commit --amend --trailer "Docs-checked: a comment — nothing a document describes changed"
```

That trailer is the checklist item (*"did this move something a document describes?"*) turned into
something a later reader can audit. Git's own parser decides what counts: it must be a real trailer in
the message's terminal block, and it must carry a non-empty reason. `tests/docs-touched.test.mjs` drives
the gate against a real scratch repository — refusal, the document-in-the-change case, the trailer, an
undescribed file, a docs-only change, and an unknown base — so the gate has checks that can fail.

#### What this gate does NOT do

**It is a prompt, not a proof, and the list below is measured rather than imagined** — every line was
driven against a scratch repository by an independent reviewer (2026-09-23). Read it before trusting the
gate for a job it was never given:

- **It watches described files, not new ones.** A change that *adds* a file no document describes passes
  untouched. Naming a file in a document is what puts it under the gate.
- **Any document satisfies it.** Changing an unrelated markdown file — or editing only a *generated*
  block in the README — counts as "a document moved", even when the prose that describes your change is
  untouched. **The README is not mandatory**; the gate cannot tell which document *should* have moved.
- **One trailer excuses the whole range.** A `Docs-checked:` reason written for a trivial change in one
  commit also excuses a described-code change in another commit in the same push.
- **It sees the paths documents actually write.** `lib/extensions.mjs` and `./lib/extensions.mjs` are
  both understood; the same path with a trailing line number is not, and a path written in a document
  **nested deeper than one level** is not read at all — the document set is the root markdown files plus
  `docs/`, one level.
- **A deleted file stops being described**, because existence is what makes a backticked string a path —
  so removing a file a document names does not trip the gate, though the prose is now wrong.
- **Existence is not absence of collision.** The bare-name pattern also matches prose that looks like a
  filename (`result.ok`, `bounds.hosts`); those are discarded because no such file exists. If a real file
  ever shares a name with a property a document discusses, the gate will treat edits to it as described.
  No such collision exists in this tree today; the case was constructed to find the boundary.

**So: it catches the common, boring mistake — moving code a document talks about and forgetting the
document — and it does not enforce "the docs and the README are correct."** Closing any line above is a
policy decision, not a bug fix, because each one trades a false green for a false red.
