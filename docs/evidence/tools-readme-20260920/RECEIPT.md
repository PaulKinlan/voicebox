# Receipt — the agent loop and the tool surface, generated and proven mutable

**Beads:** `journal-8jl` (tool calling + default tools in the README), `voicebox-beads-8uc` (the agent loop as a concept).
**Tree:** `docs/8jl-tool-calling`, base `origin/main`. **Lane:** qwen2 (fable). **Date:** 2026-09-20.

## What was built

`scripts/docs-check.mjs` generates four new blocks into `README.md` and `docs/07-architecture.md`
(checked in `npm test` by `tests/docs-drift.test.mjs`):

| block | derived from |
|---|---|
| `loop` | **one real turn driven** on a scratch root against the real server: refused before a root is declared, root declared, write succeeds, `read ..` refused and logged, audit read back; then a tool proposed by transcript, plan read, admitted with the host token, called, listed |
| `tool-path` | the route probe; `SpeechRecognition` present in `public/fused.js`; each live provider's handshake **captured from the provider against a recording transport** (never dialed); a regex over the `/live` handler for `resolveTurn(`/`execute(`/`callTool(` |
| `tools` | `PRIMITIVES`, `PRIMITIVE_NEEDS`, `GETS` and `admit().cannotHave` imported from `core/extensions.ts`; every `catalogue/*.json` run through the real `admit()`; every `rule:`/`refused:` name collected from source; `GET /api/extensions`, `/catalogue` and a token-less `POST /admit` probed |
| `config` | every `process.env.X` read in `server.mjs` and `lib/`, with the file; meaning from a table in the script, and an unlisted variable prints as undocumented |

## Proof by mutation — `mutate.sh`, run on clean `6d2ba31`

Every mutation: check exits 1; reverted byte-exact; check exits 0; tree ends with 0 dirty files.

| # | mutation | red? | the line that changed in the generated block |
|---|---|---|---|
| 1 | tool ADDED (`catalogue/mutant.json`) | exit 1 | catalogue count 4 → 5, new row |
| 2 | tool REMOVED (`catalogue/notes.json`) | exit 1 | count 4 → 3, `notes` row gone, `catalogueCount 4` → 3 in the runtime line |
| 3 | tool RENAMED (`read_notes` → `read_note`) | exit 1 | the `notes` row's tool name |
| 4 | primitive interface CHANGED (`GETS.read`) | exit 1 | two rows of the primitive table |
| 5 | live handshake DECLARES a tool (gemini) | exit 1 | `gemini → tools: **none**` → `` `mutant_tool` `` |
| 6 | `/live` handler CALLS `execute()` | exit 1 | tool-path row: `tools **no**` → `tools **yes**` |
| 7 | env var ADDED (`VOICEBOX_PORT`) | exit 1 | new config row, marked *undocumented* |
| 8 | refusal RENAMED (`network-unbounded`) | exit 1 | the gate's refusal list |

Reproduce: `sh docs/evidence/tools-readme-20260920/mutate.sh` from the repo root on a clean tree.
To see *which line* a mutation moves: apply it, `node scripts/docs-check.mjs --write`, `git diff README.md`, `git checkout -- .`.

## Defects found by building the instrument (fixed in the same commit)

1. **The `/live` line was false.** `07-architecture.md` said the upgrade *"closed without an HTTP response"*; it was probed after `probeServer()`'s `finally` had killed the server. Probed by hand: a live server answers **101**. The probe now runs before the kill.
2. **`using model (not found — the check could not read it)`** in the README: a regex over `lib/live-session.mjs`, stale since the constants moved into the provider files. Now read from the handshake the provider sends.
3. **`--write` could never seed a new block**: the empty-block guard read the file before the replacement, so every fresh marker pair was refused as blank.
4. **The probe was dialing Gemini for real** whenever `GEMINI_API_KEY` was in the shell (the `/live` upgrade probe creates a session). The child now gets blank keys and no `LIVE_PROVIDER`/`VOICEBOX_PROVIDER`/`VOICEBOX_INSTANCE`.

## Finding stated in the document, not fixed here

**Admitted tools act in the extension workspace, not the declared root.** Driven: the turn wrote
`hello.txt` into the root declared over `/api/root` and logged to its `.audit/`; the admitted tool
`peek` (`list-files`) listed `["audit.jsonl"]` — `VOICEBOX_WORKSPACE` — and its act went to that
workspace's `audit.jsonl`. `lib/extensions.mjs` resolves `WORKSPACE` at import time and has no view
of `server.mjs`'s `active` root. The `loop` block says "two roots, not one" and flips (going red) when
they become one. Routed to the loop lane.

## Gate

`npm test` (163 tests incl. the docs-drift check), `git status --porcelain` empty, `node scripts/docs-check.mjs` → `OK — 14 generated blocks across 3 documents`. See the landing report for the SHA.

## Limits

- The `loop` block drives the **typed** path only; the live path is characterised by capture and a source regex, not driven (no vendor session is opened by a docs check, by design).
- The refusal list is collected by regex over three files; a fourth file that names refusals in another shape will not be seen until the regex or the table grows.
- The `dictated` row asserts only that `SpeechRecognition` appears in `public/fused.js`; it does not drive a browser.
