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

test("output ring: speech output wave animation is smooth, continuous, and has zero boundary seams (voicebox-beads-d2ji)", { timeout: 30000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1000, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxMeters?.drawOutputRing !== undefined, { label: "meters on window" });

  const metrics = await page.evaluate(async () => {
    const stage = document.getElementById("voice-ring-wrap");
    stage.dataset.voice = "speaking";
    const path = document.getElementById("output-path");

    const samples = new Float32Array(64);
    for (let i = 0; i < 64; i++) {
      samples[i] = 0.15 + 0.12 * Math.sin((i / 64) * Math.PI * 4);
    }

    const frames = [];
    const tick = () => new Promise((resolve) => requestAnimationFrame(resolve));

    // Sample 10 consecutive frames
    for (let f = 0; f < 10; f++) {
      window.__voiceboxMeters.drawOutputRing(samples);
      await tick();
      frames.push(path.getAttribute("d") ?? "");
    }

    // Measure decay across 4 frames of silence
    const decayFrames = [];
    const silentSamples = new Float32Array(64).fill(0);
    for (let f = 0; f < 4; f++) {
      window.__voiceboxMeters.drawOutputRing(silentSamples);
      await tick();
      decayFrames.push(path.getAttribute("d") ?? "");
    }

    // Reset with null
    window.__voiceboxMeters.drawOutputRing(null);
    const clearedD = path.getAttribute("d");

    return { frames, decayFrames, clearedD };
  });

  // 1. All frames must be non-empty and start with M and end with Z
  assert.equal(metrics.frames.length, 10);
  assert.ok(metrics.frames.every((d) => /^M.*Z$/.test(d)), "every frame must produce a valid closed cubic path");

  // 2. Consecutive frames must animate continuously (no frozen / duplicate frames)
  for (let f = 1; f < metrics.frames.length; f++) {
    assert.notEqual(metrics.frames[f], metrics.frames[f - 1], `frame ${f} must advance continuously from frame ${f - 1}`);
  }

  // 3. Continuity along the curve: extract coordinates and check that point distances are smooth with no sharp seam
  for (const d of metrics.frames) {
    const coords = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.ok(coords.length >= 100, `expected dense cubic bezier points, got ${coords.length}`);
    assert.ok(coords.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), "all coordinates must be finite");
    for (let i = 0; i < coords.length; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[(i + 1) % coords.length];
      const dist = Math.hypot(x2 - x1, y2 - y1);
      assert.ok(dist < 12, `distance between adjacent points must be smooth and bounded, got ${dist}`);
    }
  }

  // 4. Smooth decay: amplitude decays smoothly across frames of silence without snapping
  for (let f = 1; f < metrics.decayFrames.length; f++) {
    assert.notEqual(metrics.decayFrames[f], metrics.decayFrames[f - 1], "decay must transition smoothly across frames");
  }

  // 5. Clean reset
  assert.equal(metrics.clearedD, null, "path attribute must be removed when cleared with null");
});
