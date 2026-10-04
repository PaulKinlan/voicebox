// tests/caption-fade.test.mjs — the caption fade lifecycle (voicebox-beads-drcy).
//
// The live caption stays visible while the turn moves, then fades out after a
// dwell; new text resets the fade; clearing the caption cancels it entirely.
// Driven here with a fake element and REAL short timers, so the timer
// lifecycle (schedule → fire → reset cancels → clear cancels) is exercised,
// not simulated.

import test from "node:test";
import assert from "node:assert/strict";
import { createCaptionFade, CAPTION_DWELL_MS_DEFAULT, CAPTION_FADE_CLASS } from "../public/caption-fade.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeElement() {
  const classes = new Set();
  return {
    classes,
    textContent: "",
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

test("caption fade: dwell default is inside the calibrated 5-8s window and the class name is stable", () => {
  assert(CAPTION_DWELL_MS_DEFAULT >= 5000 && CAPTION_DWELL_MS_DEFAULT <= 8000);
  assert.equal(CAPTION_FADE_CLASS, "caption-fade");
});

test("caption fade: reset schedules the fade class after the dwell", async () => {
  const el = fakeElement();
  const fade = createCaptionFade(() => el, { dwellMs: 20 });
  assert.equal(fade.dwell, 20);
  fade.reset();
  assert.equal(fade.pending, true, "a fade is pending right after reset");
  assert.equal(el.classes.has("caption-fade"), false, "not faded while inside the dwell");
  await sleep(60);
  assert.equal(fade.pending, false, "the timer fired and cleared itself");
  assert.equal(el.classes.has("caption-fade"), true, "faded after the dwell");
});

test("caption fade: new text during the dwell resets it — active speech never fades", async () => {
  const el = fakeElement();
  const fade = createCaptionFade(() => el, { dwellMs: 30 });
  fade.reset();
  await sleep(15); // most of the dwell gone
  fade.reset(); // the user kept speaking (onText calls reset on every chunk)
  await sleep(25); // the ORIGINAL dwell has long passed
  assert.equal(el.classes.has("caption-fade"), false, "no fade while the turn is still moving");
  assert.equal(fade.pending, true, "the restarted dwell is pending");
  await sleep(40);
  assert.equal(el.classes.has("caption-fade"), true, "fade lands after the restarted dwell");
});

test("caption fade: reset removes an already-faded class (the readout comes back)", async () => {
  const el = fakeElement();
  const fade = createCaptionFade(() => el, { dwellMs: 10 });
  fade.reset();
  await sleep(40);
  assert.equal(el.classes.has("caption-fade"), true);
  fade.reset(); // new text arrives after the fade
  assert.equal(el.classes.has("caption-fade"), false, "visible again immediately");
});

test("caption fade: clear cancels the pending fade and the class (new session, no fade on empty)", async () => {
  const el = fakeElement();
  const fade = createCaptionFade(() => el, { dwellMs: 20 });
  fade.reset();
  fade.clear();
  assert.equal(fade.pending, false, "clear cancels the timer");
  assert.equal(el.classes.has("caption-fade"), false);
  await sleep(50);
  assert.equal(el.classes.has("caption-fade"), false, "still not faded long after — the timer is really gone");
});

test("caption fade: dwell 0 disables the fade entirely (configurable off switch)", async () => {
  const el = fakeElement();
  const fade = createCaptionFade(() => el, { dwellMs: 0 });
  fade.reset();
  assert.equal(fade.pending, false, "no timer scheduled");
  await sleep(30);
  assert.equal(el.classes.has("caption-fade"), false, "nothing ever fades");
});

test("caption fade: a missing caption element never throws (defensive resolve)", async () => {
  const fade = createCaptionFade(() => null, { dwellMs: 10 });
  fade.reset();
  await sleep(40);
  fade.clear();
  assert.equal(fade.pending, false);
});
