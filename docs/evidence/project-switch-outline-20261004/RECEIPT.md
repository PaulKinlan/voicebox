# Receipt — the project/route switch cue (voicebox-beads-6omi)

**Bead:** voicebox-beads-6omi ("Change server route causes horrible jumping animation, needs subtle outline animation").
**Branch:** `fix/6omi-project-switch-outline` off `origin/main` (`35b1239`).
**Driven:** 2026-10-04, real headless Chromium over CDP, the served page.

## What was wrong, measured

The switch ran `project-switch-flash` on the whole stage: a 650ms box-shadow ring spreading 0 → 8px with a
28px glow at the halfway point, plus `border-radius: 20px` applied **only** while flashing. `.where` (the
header chip) wore the same keyframe, so its own quiet `0 1px 3px` shadow was replaced by the ring and then
vanished. Frame-by-frame measurements of `.stage`, `.where`, `.head`, `.room` and `.made-list` (before, every
frame during the cue, and after) show exactly what changed:

| measurement | before | after |
|---|---|---|
| `.stage` border-radius | `0px` → `20px` (corners pop in, then out) | `0px` in every sample |
| `.stage` box-shadow | `none` → a spreading ring (`0 0 0 5.24px`, growing to 8px + 28px glow) | `none` in every sample |
| `.where` box-shadow | resting `0 1px 3px` → the ring → gone | one value, unchanged |
| animation | `project-switch-flash` | `project-switch-outline` (stage) / `project-switch-chip` (chip) |
| **any rect, width, height, x, y, padding, margin** | **never changed** | never changed |

That last row is the reason the report reads "jumping": nothing *reflowed* — the picture was a ~1000×1100
rounded rectangle that grew and shrank once per switch, with the corners appearing and disappearing. A test
that only asserted "no geometry moved" would have been green on the defect, so the witness binds both halves.

## The fix

`public/style.css`, following the room's established `arrive` cue shape (a fade on a property that cannot move
anything):

- `project-switch-outline` — a 2px accent outline at a 6px offset fades in (18%) and back to transparent
  (100%). An outline cannot reflow, the width is declared only while the attribute is present, and both ends
  are transparent, so the rule arriving and leaving is invisible.
- `project-switch-chip` — the header chip tints to the accent and settles back to *its own* resting border,
  background and colour, so removing the `data-flash` attribute at 650ms (`fused.js`'s timer) is invisible.
- No radius, no box-shadow, no size, no padding anywhere in either keyframe.

## Shots

- `before-ring.png` — 300ms into the old cue: the whole stage ringed by the spreading accent glow.
- `after-outline.png` — the same moment after the fix: a hairline accent outline around the stage, nothing else.
- `probe-before.json` / `probe-after.json` — the frame-by-frame measurements the table above is read from.

## Commands

```sh
node --test tests/project-switch-outline.test.mjs   # the new witness (live lane)
npm run test:unit                                   # 438 pass / 0 fail in 5.65s
node scripts/test-lanes.mjs --check                 # 58 unit, 95 live
npm run docs:check
```

The witness (`tests/project-switch-outline.test.mjs`) drives a real switch (the Browser scratchpad button)
and the production cue, and asserts: the cue is **visible** (a non-transparent accent outline appears) — so
deleting it fails the test rather than passing by silence; **nothing moves** (rects, width, height, x, y are
identical in every sample); and the two old signatures are gone (the stage's radius stays `0px` and its shadow
stays `none` across the whole animation). Falsified by restoring the old CSS: it fails naming the radius pop
(`["0px","20px"]`).
