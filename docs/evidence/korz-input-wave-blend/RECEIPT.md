# Receipt — the mic-open + speech waveform blend (voicebox-beads-korz)

**Bead:** voicebox-beads-korz (P2) — 5i2i blend-case defect found by voicebox-dsflash1's review of e055453.
**Branch:** `fix/korz-input-wave-blend` off `origin/main` (`6b68e6c`).
**Driven:** 2026-09-29, real headless Chromium over CDP, the served page, the real `meters()` render loop.

## The defect, reproduced

`drawInputWave` passed the wave through `meterLevel` — the outer ring's curve, which **clamps at 1** and so
saturates at an energy of 0.277 — while a played-back chunk's energy is routinely above that. Every bar of a real
agent-speech envelope therefore arrived as exactly `1`, and the metre's own per-frame peak re-scale always drew
that `1` at the top. The blend then took `Math.max(output[i], input[i])`, so a microphone quieter than the
playback could never contribute a pixel.

Measured on the served page, four passages of full-duplex audio (agent speech at 0.50 / 0.25 / 0.45 / 0.30 with
a microphone open at 0.05 / 0.14 / 0.04 / 0.20, each held for 20 animation frames so the wave settles):

| probe | before | after |
|---|---|---|
| **flat envelope, four levels** — bar heights per passage | `39.1, 39.1, 39.1, 39.1` — **one distinct path**, 64/64 bars at the ceiling in every passage | `41.0, 35.0, 38.7, 39.1` — four different heights: the level is in the picture |
| **syllable-shaped passages** — bars at the ceiling (of 64) | 29, 8, 26, 8 | 2, 0, 0, 3 |
| **syllable-shaped passages** — bar spread (min–max units) | 15.8–39.1, 15.0–39.1, … (a flat top at the same height every time) | 12.5–38.9, 12.6–32.4, … (a wave) |
| **the microphone's own reach** — mean bar height, same playback, mic shut 0.00 → open 0.20 | shut 28.11 / open 27.62 (the voice made it *smaller*: the added energy raised the mix's peak and the frame gain cancelled it) | shut → open rises by more than 5% (asserted in the test) |

## What changed

- **The wave has its own spread** (`waveLevel`): the same square-root curve as `meterLevel`, without its clamp.
  The clamp is right for the outer ring and wrong for a wave that is normalised by its own running peak — the
  peak already keeps it inside the circle, and the clamp is what flattened loud audio into a solid bar.
- **The blend is a sum, not a `max`**: both sides are `energy()` from the same module (`public/pcm.js`), so they
  add in the same units. A voice over the agent lifts the wave on its own bars; neither side can erase the other.
- **The blend's scale is fixed** (`MIX_FULL_SCALE = 0.5`, the mixed energy that fills the circle) instead of
  being re-normalised per frame: a quiet passage draws a smaller wave than a loud one, and the microphone
  arriving is a rise you can see. `drawInputWave` takes an optional `{ gain }` for that, and the listening path
  keeps its own AGC untouched — there the wave is the only cue there is, and a whisper must not sit on the floor.

## Shots

- `before-loud-passage.png` / `after-loud-passage.png` — the same 0.50 agent passage with the mic open: a solid
  green block before, three lobes with real valleys after.
- `after-voice-over-agent.png` — the same passage with the microphone louder (0.25): the wave is visibly bigger.
- `before-quiet-passage.png` / `after-quiet-passage.png` — the 0.22 passage, for the level comparison.

## Commands

```sh
node --test tests/mic-waveform-animation.test.mjs   # both tests: 5i2i's, and the blend case the old one never drove
npm run test:unit                                    # the lane the fix must not disturb
node --test tests/mic-hotkey.test.mjs tests/ldxa-barge-in-browser.test.mjs
node scripts/test-lanes.mjs --check
npm run docs:check
```

The regression test drives the served page: four syllable-shaped passages whose energies sit **above** the old
saturation knee, and asserts (a) they do not draw one picture, (b) no frame is a flat-top or a solid bar, and
(c) the microphone opening on the same playback raises the wave — the three things the reviewer measured.
