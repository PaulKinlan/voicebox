# Receipt — the output ring's contour (voicebox-beads-u03k)

**Bead:** voicebox-beads-u03k — "The landed output ring still seams and snaps (1aa531d): port the d2ji branch's
fold sampling + envelope follower onto main's phase design".
**Branch:** `fix/u03k-output-ring-smooth` off `origin/main` (`a6f7273`).
**Driven:** 5 Oct, real headless Chromium over CDP, the served page.

## Why this exists

`voicebox-beads-d2ji` landed twice. The Wave-5 batch (`1aa531d`) shipped its own smooth ring — data-driven phase
(`ringSeen`/`ringTarget`/`ringPhase`), a carrier (`ringFlowPhase` + a small harmonic) — and the bead was closed.
The second implementation (`08ca3bd`, on the d2ji branch) was built on the pre-wave main and never landed. Measured
with one probe on both trees, the **landed** version still had both defects the bead named: a step where the ring
history wraps, and an amplitude that collapsed in a single frame when speech stopped.

## The measurement (same probe, three revisions)

`ring-probe.mjs` drives the real `drawOutputRing` with scripted rings — a smooth ramp whose ONLY discontinuity is
the wrap (`ring[n-1]` → `ring[0]`), a loud→silent step, and a constant input — and reads the painted `d`.
The seam fixture is ramp-shaped on purpose: an arbitrary mid-data step is a step wherever the sampling grid falls
(it measured 6.5 units once and 1.27 another time for the same defect, purely by phase), so the instrument would
be reporting the phase, not the seam. Units are viewBox units; the amplitude is 13.

| metric | landed (`1aa531d`) | d2ji branch (`08ca3bd`) | **this change (`u03k`)** |
|---|---|---|---|
| wrap seam, adjacent-point step | 5.52 | 0.31 | **0.55** |
| worst single-frame change at onset | 9.52 | 3.25 | **3.25** |
| worst single-frame change at pause | 13.00 | 2.08 | **2.08** |
| frames to settle after true silence | 1 | 19 | **20** |
| distinct paths / 30 frames, constant input | 30 | 15 | **30** |

So the graft takes both halves: the branch's follower (a pause eases over ~20 frames instead of one) and the
branch's mirrored traversal (no wrap adjacency), while **keeping** the landed data-driven phase and its carrier
(a steady note still draws 30/30 distinct frames — the branch alone drops to 15).

## What changed

- `public/fused.js`: `ringAt` now traverses the history as a mirrored triangle fold, so the oldest and newest
  entries are never adjacent; a per-point `ringRadii` follower chases each radius with a fast attack (0.35) and a
  slower decay (0.16); the carrier is kept and driven by the *followed* level, so it cannot put a step back into
  the picture; `null` resets the follower with the phase.
- `public/style.css`: `stroke-width: 1.8`, `stroke-linecap: round`, `will-change: d, opacity` (the `d` is what
  changes every frame), and `pointer-events: none` on the decorative ring.
- `tests/mic-waveform-animation.test.mjs`: a third test drives the real renderer with the three fixtures and
  asserts the seam (≤ 2 units), the settle (≥ 10 frames, no single-frame drop above 4 units), the motion (≥ 20
  distinct frames on a constant input) and the `null` reset.
- `docs/00-architectural-overview.md`: the Zero-Shift UI rule now says what the contour is and what it measured.

## Falsification and gates

- **It can fail on purpose**: with `origin/main`'s `public/fused.js` + `public/style.css` restored, the new test
  fails with `the contour steps 9.51 units between adjacent points — the wrap seam is back`.
- `node --test tests/mic-waveform-animation.test.mjs` → 3/3 (the two existing tests unchanged and green).
- `npm run test:unit` → 443 pass / 0 fail / 2 skipped.
- `node scripts/test-lanes.mjs --check` → 58 unit / 94 live; `npm run docs:check` → OK.
- **Observed while gating, unrelated to this change**: the first unit-lane run failed
  `tests/offline-speech.test.mjs` with `Error: write EPIPE` (the mock child exiting before its stdin is written),
  then passed 5/5 in isolation and green on the re-run. That is exactly the fix stranded on the d2ji branch —
  `voicebox-beads-uck3` — now with a measured gate impact; the tolerance should land.

## Shots

- `ring-after.png` — the ring mid-speech after the change (a shaped contour, no kink, no collapse).
- `landed-1aa531d.json`, `branch-08ca3bd.json`, `graft-u03k.json` — the three runs the table is read from.
