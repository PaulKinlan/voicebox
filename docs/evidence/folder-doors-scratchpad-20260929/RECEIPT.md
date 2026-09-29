# Receipt — the browser scratchpad default, the drawer's doors, and the drop cue

**Beads:** voicebox-beads-vnos (P2), voicebox-beads-9rua (P3), voicebox-beads-n4kw (P3)
**Branch:** `fix/vnos-scratchpad-default` off `origin/main` (`a10ca02`)
**Driven:** 2026-09-29, real headless Chromium over CDP, `tests/lib/cdp.mjs` + `tests/lib/server.mjs`;
two instances per capture (one with nothing declared, one with a machine root).

## What was driven, and what was seen

### vnos — a create turn with no folder open lands in the browser scratchpad

| Scene | What the run saw |
|---|---|
| The state the bug lives in | `#root-kind` reads `no folder chosen yet`; the server refuses a turn with `nothing to write into` — this is the state in which no file could be made at all before the change |
| The empty state | `The environment page is where you choose the folder that turns save into — or say "create a file called notes.md with hello" and it lands in this browser's scratchpad.`; the two file-making samples are shown and `list files` is not |
| Composer title | `a turn that makes a file lands in this browser's scratchpad; anything else needs a project folder` |
| `create a file called walk-notes.md with the tide was out past the point` | `wrote walk-notes.md (31 bytes observed) in Browser Scratchpad (OPFS) — this browser may evict it (storage here is best-effort)` |
| The drawer | `#files` holds `walk-notes.md`; `#file-count` reads `1 file`; the listing line reads `In "scratchpad" — turns save here.` (not `read-only`, which is what it said before) |
| The bytes | read straight out of OPFS by the harness: `the tide was out past the point` |
| The control | `list files`, sent before anything was open, still reaches the server and still refuses by name (`nothing to write into`) — the fallback is specific, not a page that swallows every turn |

**Not proven here:** that a *declared* root is never bypassed — the live suite drives that by construction
(the fallback condition is `activeRoot === null || listingRefusal.refused === "root-not-declared"`), and
`tests/room-page-owned-root.test.mjs` and `tests/one-root.test.mjs` cover a declared root's own paths.

### 9rua — the drawer's doors

`#open-folder` and `#open-opfs-folder` carry `<svg class="icon"><use href="#i-folder"/></svg>`, both are
`.quiet`, and on the running page each computes to `1px solid` edge, the same background as a `.file-open`
card, and a 44px height. `#close-folder` wears the same shape and no glyph (it is a route, not a folder).
Hovering `#open-opfs-folder` with a real mouse move tints its words, its glyph and its surface — the shot
below is that moment, with `#open-folder` beside it at rest. At 380px wide the row wraps and no door leaves
the viewport.

### n4kw — the drop cue

A real directory drag from CDP's platform path puts `.made.dropping` on the panel: a `2px dashed` accent
ring at 4px offset, a 7% backdrop tint, and two glow shadows that add **no box** — nothing in the panel
moves while the pointer is over it. The helper copy reads `Drop the folder to open it here — the room reads
it in this tab.` A synthetic enter/leave pair on a file row (what the platform delivers when the pointer
crosses a card) leaves the cue up; a leave with nowhere to go clears it and restores `outline: none` and a
transparent background; a real `drop` clears it and adopts the dropped folder (its files appear in the
drawer).

## The commands that produced this

```sh
node --test tests/room-scratchpad-default.test.mjs            # vnos, in the room
node --test tests/room-folder-doors.test.mjs                  # 9rua + n4kw, in the room
npm run test:unit                                             # 320 pass / 0 fail
npm run accept                                                # ALL CLEAR (private + shared phases)
node scripts/test-lanes.mjs --check                           # 40 unit, 82 live
```

Neighbours re-driven because this change touches the same surfaces: `room-folders`, `opfs-persistence`,
`room-file-list-polish`, `room-explorer-ui`, `room-page-owned-root` — all green.

## Shots

- `01-scratchpad-empty-state.png` — nothing declared: the scratchpad route named, the samples that work.
- `02-scratchpad-after-write.png` — after the create turn: report line, `1 file`, `walk-notes.md`, the
  scratchpad chip at read/write, and `In "scratchpad" — turns save here.`
- `03-folder-doors-hover.png` — the doors at rest and one hovered, each with the stroked folder glyph.
- `04-drop-cue.png` — the panel while a folder is dragged over it.
- `observations.json` — the same facts as data, as the capture script read them.
