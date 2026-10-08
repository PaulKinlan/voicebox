# 5bmg — the settings scroll-lock test was also a claim about where the page happened to be

**Bead:** `voicebox-beads-5bmg` (P2, `gate-reliability` / `flake`)
**Branch:** `fleet/roboticon-5bmg` (test-only fix, from `origin/main` `8c6c587`)
**Reproduce:** `node docs/evidence/5bmg-scroll-flake-20261008/drive.mjs <baseline|end|end_fixed|budget|latency>`

## The failure

| Run | Tree | Lane | Failed assertion |
|---|---|---|---|
| `c75902b7…` 13:02Z | `2741beb` (miniapps sodf + two roboticon test fixes) | browser, 232 tests, 229 pass | `tests/settings-dialog.test.mjs:248` — `the page cannot scroll again after the dialog closed` |

Only occurrence in any check log on this VM. Same tree standalone: **8 pass / 0 fail** (the scroll test
takes 1.3s alone, 3.8s in the gate). The tree's other changes are test-side (a CDP cleanup test and a
JSONL test reader) and the miniapps branch changes no dialog, overflow or scroll rule (its diff on every
relevant selector is whitespace plus tokens), so nothing under test explains the red.

## What the test actually asserts

```js
const beforeFree = await page.evaluate(() => window.scrollY);
await page.wheel(400);                         // ONE gesture at a FIXED viewport point (200,300)…
const afterFree = await page.evaluate(() => window.scrollY);   // …then one immediate read
assert.ok(afterFree > beforeFree, "the page cannot scroll again after the dialog closed");
```

Three things are inputs to that assertion and the test checks none of them: where the scroller already
is, whether the point is over a scroll container that swallows the wheel, and whether the wheel's scroll
has been committed yet. `page.wheel()` dispatches the gesture and sleeps a fixed 200 ms.

## Controlled experiment — one variable per run, real browser, same harness as the suite

`drive.mjs` reproduces the test's sequence verbatim (300vh filler, `openSettings()`, locked wheel,
Escape, close-wait, free wheel) and prints every measured value as JSON. Instrumented page state at the
wheel's fixed point (200,300) after close, in the passing case: hit chain `section.voice → main#made →
div.room → body`, nothing scrollable, dialog `display:none`, `htmlOverflowY: visible`,
`docs.scrollHeight 2943`, `innerHeight 713`, `maxScroll 2230`.

| Run | Hostile precondition | before → after | Verdict |
|---|---|---|---|
| `baseline` (test as written) | none | 0 → 400 | **passes** — margin 400px, so the assertion is not merely fragile |
| `end` | scroller parked at `maxScroll` (2230) | 2230 → 2230, `moved 0` | **FAILS deterministically** — no product defect, the wheel had nowhere to go. `documentScrollable.moved 0` in the same run proves the page is genuinely at its end, not locked |
| `end_fixed` | the same hostile precondition, plus the fix (reset → wheel → wait for condition) | 0 → 400, `waitedMs 0` | **passes** |

So the old assertion had a deterministic failure path that needs no load at all: the suite shares ONE
page, earlier checks legitimately scroll it, and this test never reset the scroller before sampling.

## The timing hypothesis, tested and NOT supported

I first suspected the fixed 200 ms sleep was too short under a loaded box, because a polling probe
measured wheel→commit latencies of **687, 255, 38, 191, 98, 98 ms** (load ≈ 6.9). That probe polled
`window.scrollY` every ~5 ms through CDP while the scroll was in flight, so it measured partly itself.
Re-measured without any polling — dispatch one wheel, sleep exactly T, read once, 3 trials per T, under
load ≈ 6.9–7.1:

| Sleep | Committed? |
|---|---|
| 50 ms / 100 ms / 200 ms / 400 ms / 800 ms / 1600 ms | committed in **3/3** trials at every budget |

The scroll lands inside **50 ms**, so a 200 ms sleep is not the cause and the flake is **not** explained
by commit latency. That is recorded here because the first number would have been a comfortable and
wrong explanation.

## The fix (test-only)

`tests/settings-dialog.test.mjs`, inside the same test:

1. `window.scrollTo(0, 0)` and re-read `beforeFree` before the gesture — removes the proven
   deterministic path, and is what `end_fixed` exercises.
2. `await page.waitFor(() => window.scrollY > 0, { label: "the page to scroll again after the dialog closed" })`
   before reading `afterFree` — the assertion shape the file already uses elsewhere (see
   `waitForAppWired`'s note on the click race). It **throws by label** after 15s if the page really is
   still locked, so the claim "the page can scroll again" is still enforced loudly rather than sampled.

`tests/settings-dialog.test.mjs`: **8 pass / 0 fail** with the fix.

## What is still unknown, stated plainly

The scroll-lock red happened once and does not reproduce: not standalone (8/8), not with the hostile
precondition under the old code (that fails for a *different*, now-proven reason), and the fixed sleep
is demonstrably sufficient. **The gate-time trigger is therefore not established by this work.** What is
established: an unsound precondition existed and is now impossible; the assertion still fails loudly on
a real lock; and the timing explanation I first reached for is disproved rather than assumed.
