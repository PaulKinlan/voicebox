# Panels & prose sweep — 2026-09-20 — prove branch `sweep/panels-and-prose`

Method: every surface enumerated from the DOM and DRIVEN at 1280×800, 390×844 and 844×480
(screenshots + measured geometry via getBoundingClientRect and `:modal` matching); every prose
claim collected from the served pages and checked against the running server, not intent.
Skill consulted first (modern-web-guidance, dialog/light-dismiss guides; its `<dialog closedby>`
pattern is what main already ships).

## HALF 1 — overlay/panel surfaces, in-flow or out-of-flow

| surface | where it lives | verdict |
|---|---|---|
| Settings (index) | `<dialog closedby="any">`, `showModal()` | **out-of-flow, correct** — `:modal` verified, centred at both viewports, fits 390×844 |
| Tier-2 confirm (environment) | `<dialog closedby="any">` + `::backdrop` | **out-of-flow, correct** — top layer, centred, y=335/800; fits 844×480 with internal scroll. The y=1419 gate is gone |
| Reader pane (index) | in-flow grid child, `data-state` | **in-flow, correct** — a master-detail reader, not an overlay request; the `body:has(#reader[data-state="ready"])` rules shrink the rings so it stays above the fold (measured y=234–372 at 1280×800, 228–366 at 390×844) |
| Recent turns (index) | `hidden` section | **in-flow, correct** — never summoned by typed turns; it is the live-session surface |
| Composer / turn-report / footer | in-flow | **correct** — footer sits below the fold at every viewport, which is what a footer is; the prose inside it is HALF 2 |
| Transcript / gallery / explorer (environment) | in-flow console | **correct** — a console page, not a document; its confirm is the dialog above |
| `<details>` (reader details, about) | native expander | **correct use** |

**Enumeration verdict: the class is CLOSED, not merely quiet.** Every surface a person opens
expecting it to sit over the page already does (`showModal` + `closedby` + `::backdrop`); the
in-flow surfaces are in-flow on purpose and keep themselves visible when opened.

## HALF 2 — prose claims vs the running system

| claim | where | verdict |
|---|---|---|
| "Files are read from disk…" | index footer | **IMPRECISE — fixed**: now "read from **the server's** disk". True for the machine root; the browser-root case refuses turns and says so in the empty state, so the conditional is carried where the person acts |
| "Live voice … takes no tools yet, so it cannot write files" | index footer | **TRUE** — live-voice.js contains no tool references (pinned by test) |
| "typed turns go to the local server and what they write lands there" | index footer | **TRUE** — driven: turn → file on the server's disk → listing |
| root chip states ("checking…", "no root declared", "machine · name") | index header | **TRUE** — each is a driven state |
| "Say or type something that names a file and it lands here" | empty state | **TRUE** — driven |
| environment chooser ("machine is what turns can write into today; picked/OPFS readable but not writable by turns") | environment.html | **TRUE** — matches fused.js's read-only-for-turns empty state and the root facts |
| "escapes the workspace" (retired message) | anywhere served | **GONE** — survives only in evidence receipts, which are history; pinned by test that it never returns to a served page |

`npm run docs:check` OK. Whole gate green; tree clean.
