// tests/mic-waveform-animation.test.mjs — dynamic mic button waveform animation (voicebox-beads-5i2i, 6vs4).
//
// WHAT THIS SUITE PROVES (driven in real browser over CDP):
//   1. Gating & Styling:
//      - When voice is off, .input-wave is hidden (display: none), #input-path has no d, .mic-glyph is visible
//      - When voice is listening, .input-wave is shown, .mic-glyph is hidden, fill is var(--accent)
//      - When voice is speaking, .input-wave is shown, .mic-glyph is hidden, fill is var(--good)
//   2. Dynamic Real-Time Animation:
//      - In speaking mode, #input-path renders an active SVG path (M...Z)
//      - As output energy varies across frames, #input-path dynamically animates (d updates, no freeze/flatline)
//   3. Barge-In Blended Mode (voicebox-beads-6vs4):
//      - When capture > 0.02 and speaking, output energy and mic input blend dynamically
//      - Bars do not clamp to ceiling (top y = 10.90) across the entire width, producing distinct dynamic frames
//   4. Buffer Allocation Pin (voicebox-beads-6vs4):
//      - 28 input samples render exactly 55 L segments (2n - 1)
//      - 64 output samples render exactly 127 L segments (2n - 1)
//      - Reverting inputDisplay to fixed 28 causes coordinates beyond index 27 to fail or become NaN
//      - All path coordinates are asserted to be finite numbers in every frame
//   5. Clean Reset:
//      - Returning stage to voice=off clears the waveform path through the meters loop

import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

function parsePath(d) {
  if (!d) return { l: 0, points: [], numbers: [] };
  const l = (d.match(/L/g) ?? []).length;
  const points = [...d.matchAll(/(-?[\d.]+|NaN|undefined|Infinity),(-?[\d.]+|NaN|undefined|Infinity)/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  const numbers = points.flatMap((p) => [p.x, p.y]);
  return { l, points, numbers };
}

test("mic button waveform dynamically animates during speech output, listening, and barge-in blend (voicebox-beads-5i2i, 6vs4)", { timeout: 30000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1000, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxMeters !== undefined, { label: "meters on window" });

  // 1. Initial State (off)
  const initial = await page.evaluate(() => {
    const stage = document.getElementById("voice-ring-wrap");
    const wave = document.querySelector(".input-wave");
    const glyph = document.querySelector(".mic-glyph");
    const path = document.getElementById("input-path");
    return {
      voice: stage?.dataset.voice,
      waveDisplay: wave ? getComputedStyle(wave).display : null,
      glyphDisplay: glyph ? getComputedStyle(glyph).display : null,
      hasPath: Boolean(path?.getAttribute("d")),
    };
  });

  assert.equal(initial.voice, "off", "starts in off state");
  assert.equal(initial.waveDisplay, "none", "input-wave hidden when off");
  assert.notEqual(initial.glyphDisplay, "none", "mic glyph visible when off");
  assert.equal(initial.hasPath, false, "waveform path empty when off");

  // 2. Listening State: mic input energy drives waveform in accent color (28 bars -> 55 L segments)
  const listeningState = await page.evaluate(() => {
    const stage = document.getElementById("voice-ring-wrap");
    stage.dataset.voice = "listening";

    // Feed synthetic input energy (28 bars)
    const inputSamples = new Float32Array(28);
    for (let i = 0; i < 28; i++) inputSamples[i] = 0.05 + 0.04 * Math.sin(i * 0.5);

    window.__voiceboxMeters.drawInputWave(inputSamples);

    const wave = document.querySelector(".input-wave");
    const glyph = document.querySelector(".mic-glyph");
    const path = document.getElementById("input-path");
    const pathStyle = path ? getComputedStyle(path) : null;
    return {
      waveDisplay: getComputedStyle(wave).display,
      glyphDisplay: getComputedStyle(glyph).display,
      fill: pathStyle?.fill,
      d: path?.getAttribute("d") ?? "",
    };
  });

  assert.equal(listeningState.waveDisplay, "block", "input-wave displayed during listening");
  assert.equal(listeningState.glyphDisplay, "none", "mic glyph hidden during listening");
  const parsedListening = parsePath(listeningState.d);
  assert.equal(parsedListening.l, 55, "listening path carries 55 L segments for 28 samples (2n - 1)");
  assert.ok(parsedListening.numbers.length > 0 && parsedListening.numbers.every(Number.isFinite), "all listening coordinates finite");

  // 3. Speaking State (pure output): Voicebox speech output energy dynamically drives waveform in green (var(--good))
  // (64 samples -> 127 L segments, pinning dynamic buffer allocation)
  const speakingFrame1 = await page.evaluate(async () => {
    const stage = document.getElementById("voice-ring-wrap");
    stage.dataset.voice = "speaking";

    const outputSamples = new Float32Array(64);
    for (let i = 0; i < 64; i++) outputSamples[i] = 0.08 + 0.06 * Math.sin(i * 0.3);

    window.__voiceboxLiveClient = {
      level: () => ({ capture: 0, input: new Float32Array(28), output: outputSamples }),
    };

    window.__voiceboxMeters.startMeters();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    const wave = document.querySelector(".input-wave");
    const glyph = document.querySelector(".mic-glyph");
    const path = document.getElementById("input-path");
    const ring = document.getElementById("output-path");
    return {
      waveDisplay: getComputedStyle(wave).display,
      glyphDisplay: getComputedStyle(glyph).display,
      fill: path ? getComputedStyle(path).fill : null,
      d: path?.getAttribute("d") ?? "",
      ringD: ring?.getAttribute("d") ?? "",
    };
  });

  assert.equal(speakingFrame1.waveDisplay, "block", "input-wave displayed during speaking");
  assert.equal(speakingFrame1.glyphDisplay, "none", "mic glyph hidden during speaking");
  const parsedSpeaking1 = parsePath(speakingFrame1.d);
  assert.equal(parsedSpeaking1.l, 127, "speaking path carries 127 L segments for 64 samples (2n - 1)");
  assert.ok(parsedSpeaking1.numbers.every(Number.isFinite), "all speaking coordinates finite");
  assert.match(speakingFrame1.ringD, /^M.*Z$/, "output ring path also generated");

  // Wait for animation frame and verify dynamic motion as output energy varies
  await new Promise((r) => setTimeout(r, 80));

  const speakingFrame2 = await page.evaluate(() => {
    const outputSamples = new Float32Array(64);
    for (let i = 0; i < 64; i++) outputSamples[i] = 0.15 + 0.12 * Math.cos(i * 0.4);

    window.__voiceboxLiveClient = {
      level: () => ({ capture: 0, input: new Float32Array(28), output: outputSamples }),
    };

    const path = document.getElementById("input-path");
    return {
      d: path?.getAttribute("d") ?? "",
    };
  });

  assert.notEqual(speakingFrame1.d, speakingFrame2.d, "waveform path animates dynamically in real time across output frames");
  const parsedSpeaking2 = parsePath(speakingFrame2.d);
  assert.equal(parsedSpeaking2.l, 127, "speaking frame 2 also carries 127 L segments");
  assert.ok(parsedSpeaking2.numbers.every(Number.isFinite), "speaking frame 2 coordinates finite");

  // 4. Barge-In Blended State (voicebox-beads-6vs4): capture = 0.6 with active mic & output energy
  const blendResults = await page.evaluate(async () => {
    const stage = document.getElementById("voice-ring-wrap");
    stage.dataset.voice = "speaking";

    const path = document.getElementById("input-path");
    const frames = [];

    for (let f = 0; f < 4; f++) {
      const out = new Float32Array(64);
      for (let i = 0; i < 64; i++) {
        out[i] = Math.max(0, 0.12 + 0.16 * Math.sin(f * 1.5 + i * 0.25) * Math.cos(f * 0.8 + i * 0.1));
      }
      const inp = new Float32Array(28);
      for (let j = 0; j < 28; j++) {
        inp[j] = Math.max(0, 0.18 + 0.22 * Math.sin(f * 2.1 + j * 0.4) * Math.sin(f * 1.1));
      }

      window.__voiceboxLiveClient = {
        level: () => ({ capture: 0.6, input: inp, output: out }),
      };

      await new Promise((r) => setTimeout(r, 60));
      frames.push(path.getAttribute("d") || "");
    }
    return frames;
  });

  const parsedBlend = blendResults.map(parsePath);
  const distinctBlend = new Set(blendResults).size;
  assert.ok(distinctBlend >= 3, `barge-in blended frames animate dynamically across frames (got ${distinctBlend}/4 distinct paths)`);
  assert.ok(parsedBlend.every((p) => p.l === 127), "all blended frames maintain 127 L segments (64-sample resolution)");
  assert.ok(parsedBlend.every((p) => p.numbers.every(Number.isFinite)), "all blended frame coordinates are finite numbers");

  // Assert the wave is NOT flat-topped to the ceiling: at least some points have y > 12 (not clamped to 10.90)
  for (let i = 0; i < parsedBlend.length; i++) {
    const clampedBars = parsedBlend[i].points.filter((pt) => Math.abs(pt.y - 10.90) < 0.05).length;
    assert.ok(clampedBars < 40, `frame ${i} not saturated to ceiling (clamped bars: ${clampedBars}/128 points)`);
  }

  // 5. Size Switch (28 -> 64 -> 28): verifies re-allocation in both directions
  const switchResults = await page.evaluate(async () => {
    const stage = document.getElementById("voice-ring-wrap");
    const path = document.getElementById("input-path");

    stage.dataset.voice = "listening";
    window.__voiceboxLiveClient = {
      level: () => ({ capture: 0.3, input: new Float32Array(28).fill(0.1), output: new Float32Array(64) }),
    };
    await new Promise((r) => setTimeout(r, 60));
    const d28 = path.getAttribute("d") || "";

    stage.dataset.voice = "speaking";
    window.__voiceboxLiveClient = {
      level: () => ({ capture: 0, input: new Float32Array(28), output: new Float32Array(64).fill(0.1) }),
    };
    await new Promise((r) => setTimeout(r, 60));
    const d64 = path.getAttribute("d") || "";

    stage.dataset.voice = "listening";
    window.__voiceboxLiveClient = {
      level: () => ({ capture: 0.3, input: new Float32Array(28).fill(0.1), output: new Float32Array(64) }),
    };
    await new Promise((r) => setTimeout(r, 60));
    const d28Again = path.getAttribute("d") || "";

    return { d28, d64, d28Again };
  });

  const p28 = parsePath(switchResults.d28);
  const p64 = parsePath(switchResults.d64);
  const p28b = parsePath(switchResults.d28Again);
  assert.equal(p28.l, 55, "listening has 55 L segments (28 samples)");
  assert.equal(p64.l, 127, "speaking reallocates to 127 L segments (64 samples)");
  assert.equal(p28b.l, 55, "returning to listening reallocates back to 55 L segments");

  // 6. Return to Off: meters cleared cleanly through the loop
  await page.evaluate(async () => {
    const stage = document.getElementById("voice-ring-wrap");
    stage.dataset.voice = "off";
    window.__voiceboxLiveClient = null;
    await new Promise((r) => setTimeout(r, 80));
  });

  const cleared = await page.evaluate(() => {
    const wave = document.querySelector(".input-wave");
    const glyph = document.querySelector(".mic-glyph");
    const path = document.getElementById("input-path");
    return {
      waveDisplay: getComputedStyle(wave).display,
      glyphDisplay: getComputedStyle(glyph).display,
      hasPath: Boolean(path?.getAttribute("d")),
    };
  });

  assert.equal(cleared.waveDisplay, "none", "input-wave hidden when off");
  assert.notEqual(cleared.glyphDisplay, "none", "mic glyph restored when off");
  assert.equal(cleared.hasPath, false, "waveform cleared when off");
});

// ── the blend case the first version never exercised (voicebox-beads-korz) ───────────────────────────────
// voicebox-dsflash1's review of the landed 5i2i found that the committed test stubs `capture: 0`, so the branch
// that matters — the agent speaking WHILE the microphone is open — was never driven. This test drives it, on
// the real page, with the shape of the failure named: four passages of agent speech whose energies sit ABOVE
// the meter's old saturation knee (0.277), each with syllables in it, while a microphone quieter than the
// playback is open. The old code drew all four as byte-identical rectangles at 39.1 units on every bar — one
// distinct path, a solid bar across the clipper — because `Math.max(out, inp)` erased the microphone and the
// per-frame peak re-scale erased the level.
test("mic waveform: the speech+microphone blend is alive, unclamped, and keeps the microphone visible (voicebox-beads-korz)", { timeout: 30000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1000, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxMeters?.mixSpeechAndMic !== undefined, { label: "the meters, blend included" });

  const reading = await page.evaluate(async () => {
    const stage = document.getElementById("voice-ring-wrap");
    stage.dataset.voice = "speaking";
    const tick = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    // Bar half-heights from the served path: the top edge's y values, reversed out of the 50-unit middle.
    const heights = () => {
      const d = document.getElementById("input-path")?.getAttribute("d") ?? "";
      const ys = [...d.matchAll(/[ML]([-\d.]+),([-\d.]+)/g)].map((m) => Number(m[2]));
      return ys.slice(0, ys.length / 2).map((y) => Number((50 - y).toFixed(2)));
    };
    // A syllable-shaped envelope at a given level: three lobes across the ring, phase-shifted per passage.
    const envelope = (level, phase, length) =>
      Float32Array.from({ length }, (_, i) => level * (0.55 + 0.45 * Math.sin((i / length) * Math.PI * 6 + phase)));
    const PASSAGES = [
      { output: 0.5, mic: 0.05, phase: 0.0 },
      { output: 0.25, mic: 0.16, phase: 0.9 },
      { output: 0.45, mic: 0.04, phase: 1.8 },
      { output: 0.3, mic: 0.2, phase: 2.7 },
    ];
    const settle = async (output, mic, phase, capture = 0.6) => {
      window.__voiceboxLiveClient = {
        level: () => ({
          capture,
          output: envelope(output, phase, 64),
          input: envelope(mic, phase, 28),
        }),
      };
      for (let i = 0; i < 20; i++) await tick(); // a passage is held: the wave settles before it is read
      return heights();
    };
    const seen = [];
    for (const p of PASSAGES) seen.push(await settle(p.output, p.mic, p.phase));
    // The microphone-visibility control: the SAME passage with the microphone silent.
    const micClosed = await settle(0.5, 0.0, 0.0, 0.01);
    const micOpen = await settle(0.5, 0.2, 0.0, 0.6);
    window.__voiceboxLiveClient = null;
    return { seen, micClosed, micOpen };
  });

  const signature = (h) => h.join(",");
  const spread = (h) => Number((Math.max(...h) - Math.min(...h)).toFixed(2));
  const mean = (h) => Number((h.reduce((a, b) => a + b, 0) / h.length).toFixed(2));

  // NOT FROZEN: four different passages must not draw one picture (the defect was literally one distinct path).
  const distinct = new Set(reading.seen.map(signature)).size;
  assert.ok(distinct >= 3, `four different passages drew ${distinct} distinct path(s) — the blend is frozen: ${JSON.stringify(reading.seen.map(mean))}`);
  // NOT FLAT-TOPPED: within a frame the bars must differ, and must not all sit at the clipper's ceiling.
  for (const [i, h] of reading.seen.entries()) {
    assert.ok(spread(h) > 5, `passage ${i} drew a flat-top (bar spread ${spread(h)} units, ${h.filter((v) => v >= 38.5).length}/${h.length} bars at the ceiling)`);
    assert.ok(h.filter((v) => v >= 38.5).length < h.length / 2, `passage ${i} is a solid bar across the clipper`);
  }
  // AND THE MICROPHONE IS IN IT: the same playback with the microphone open draws a taller wave than with it
  // shut, which is the difference `Math.max` could never show (it kept the louder bar and dropped the voice).
  assert.ok(
    mean(reading.micOpen) > mean(reading.micClosed) * 1.05,
    `the microphone does not reach the wave: open mean ${mean(reading.micOpen)} vs shut mean ${mean(reading.micClosed)}`,
  );
});

// ── the output ring's contour (voicebox-beads-u03k) ─────────────────────────────────────────────────────
// The ring is the agent's own meter: one radius per data point, drawn as a closed curve. Two defects were
// measured on the version that first landed (1aa531d), with the same fixtures this test now drives:
//   · the history wraps around the circle, so the OLDEST entry sat next to the NEWEST one on screen. On a
//     fixture whose only discontinuity is that wrap, the painted contour jumped 5.5 units — of a 13-unit
//     amplitude — between two adjacent points.
//   · the radius WAS the data's level, so a pause collapsed the whole amplitude in a single frame (13.0
//     units) and the ring was back at rest after one frame.
// The fix grafts two things onto the landed design (which kept its data-driven phase and its carrier):
// a mirrored traversal, so those two entries are never adjacent, and a per-point follower with a fast
// attack and a slower decay.
//
// THE SEAM FIXTURE IS PHASE-INDEPENDENT ON PURPOSE: a smooth ramp whose only discontinuity is between the
// newest entry and the oldest. A step somewhere in the middle of the data would be a step wherever the grid
// happens to sample — measured once at 6.5 and once at 1.27 units for the same defect, purely because the
// phase fell differently — so the instrument would be reporting the phase, not the seam.
test("output ring: the contour is seam-free, settles over many frames, and still moves on a steady note (voicebox-beads-u03k)", { timeout: 30000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const page = await launch({ width: 1000, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxMeters?.drawOutputRing !== undefined, { label: "the meters, ring included" });

  const measured = await page.evaluate(() => {
    const RING = 64;
    const quiet = () => new Float32Array(RING);
    const loud = () => Float32Array.from({ length: RING }, () => 0.5);
    // Smooth ramp; its ONLY jump is between ring[n-1] and ring[0] — the adjacency the wrap creates.
    const rampWithWrap = () => Float32Array.from({ length: RING }, (_, i) => 0.55 - (i / (RING - 1)) * 0.53);
    // The painted radii: closedCurve emits M then cubic C triples whose LAST pair is the endpoint.
    const radii = () => {
      const d = document.getElementById("output-path")?.getAttribute("d") ?? "";
      const pairs = [...d.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      return pairs.filter((_, i) => i === 0 || i % 3 === 0).map(([x, y]) => Math.hypot(x - 120, y - 120));
    };
    const frame = (samples) => { window.__voiceboxMeters.drawOutputRing(samples); return radii(); };
    const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

    // 1. WRAP SEAM: the only discontinuity in the data is the wrap; no adjacent pair may step more than 2 units.
    let seam = 0;
    let points = 0;
    for (let i = 0; i < 40; i++) {
      const r = frame(rampWithWrap());
      points = r.length;
      seam = 0;
      for (let k = 0; k < r.length; k++) seam = Math.max(seam, Math.abs(r[k] - r[(k + 1) % r.length]));
    }

    // 2. PAUSE: loud for 30 frames, then true silence — the ring must settle over many frames, not one.
    for (let i = 0; i < 30; i++) frame(loud());
    const before = mean(frame(loud()));
    const means = [];
    for (let i = 0; i < 60; i++) means.push(mean(frame(quiet())));
    const drops = means.map((v, i) => (i === 0 ? before - v : means[i - 1] - v));
    const worstDrop = Math.max(...drops);
    const target = 62; // OUTPUT_BASE
    const ninetyFive = before - (before - target) * 0.95;
    const framesTo95 = means.findIndex((v) => v <= ninetyFive) + 1 || 60;

    // 3. MOTION: a steady note must still move — the carrier is kept, it is not the thing the fix removes.
    const seen = new Set();
    for (let i = 0; i < 30; i++) { frame(loud()); seen.add(document.getElementById("output-path")?.getAttribute("d") ?? ""); }

    // 4. RESET: null clears the painted contour.
    window.__voiceboxMeters.drawOutputRing(null);
    const afterNull = document.getElementById("output-path")?.getAttribute("d") ?? "";

    return { points, seam: Number(seam.toFixed(2)), worstDrop: Number(worstDrop.toFixed(2)), framesTo95, distinctPaths: seen.size, afterNull };
  });

  assert.ok(measured.points > 0, "the ring painted nothing");
  assert.ok(measured.seam <= 2, `the contour steps ${measured.seam} units between adjacent points — the wrap seam is back`);
  assert.ok(measured.worstDrop <= 4, `the ring dropped ${measured.worstDrop} units in one frame when speech stopped — the pause snapped`);
  assert.ok(measured.framesTo95 >= 10, `the ring settled in ${measured.framesTo95} frames — a pause must ease, not collapse`);
  assert.ok(measured.distinctPaths >= 20, `a steady note drew only ${measured.distinctPaths}/30 distinct frames — the carrier was lost`);
  assert.equal(measured.afterNull, "", "null must clear the painted contour");
});
