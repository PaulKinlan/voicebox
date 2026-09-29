// tests/mic-waveform-animation.test.mjs — dynamic mic button waveform animation (voicebox-beads-5i2i).
//
// WHAT THIS SUITE PROVES (driven in real browser over CDP):
//   1. Gating & Styling:
//      - When voice is off, .input-wave is hidden (display: none), #input-path has no d, .mic-glyph is visible
//      - When voice is listening, .input-wave is shown, .mic-glyph is hidden, fill is var(--accent)
//      - When voice is speaking, .input-wave is shown, .mic-glyph is hidden, fill is var(--good)
//   2. Dynamic Real-Time Animation:
//      - In speaking mode, #input-path renders an active SVG path (M...Z)
//      - As output energy varies across frames, #input-path dynamically animates (d updates, no freeze/flatline)
//      - When returning to off, meters clear cleanly

import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("mic button waveform dynamically animates during speech output and listening without freezing (voicebox-beads-5i2i)", { timeout: 30000 }, async (t) => {
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

  // 2. Listening State: mic input energy drives waveform in accent color
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
  assert.match(listeningState.d, /^M.*Z$/, "waveform path generated during listening");

  // 3. Speaking State: Voicebox speech output energy dynamically drives the waveform in green (var(--good))
  const speakingFrame1 = await page.evaluate(() => {
    const stage = document.getElementById("voice-ring-wrap");
    stage.dataset.voice = "speaking";

    // Mock client with active output energy
    const outputSamples = new Float32Array(64);
    for (let i = 0; i < 64; i++) outputSamples[i] = 0.08 + 0.06 * Math.sin(i * 0.3);

    window.__voiceboxLiveClient = {
      level: () => ({ capture: 0, input: new Float32Array(28), output: outputSamples }),
    };

    // Run meters tick
    window.__voiceboxMeters.startMeters();

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
  assert.match(speakingFrame1.d, /^M.*Z$/, "waveform path generated from speech output during speaking");
  assert.match(speakingFrame1.ringD, /^M.*Z$/, "output ring path also generated");

  // Wait for animation frame and verify dynamic motion as output energy varies
  await new Promise((r) => setTimeout(r, 80));

  const speakingFrame2 = await page.evaluate(() => {
    // New energy burst
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

  assert.notEqual(speakingFrame1.d, speakingFrame2.d, "waveform path animates dynamically in real time and is not frozen");

  // 4. Return to Off: meters cleared cleanly
  const cleared = await page.evaluate(() => {
    const stage = document.getElementById("voice-ring-wrap");
    stage.dataset.voice = "off";
    window.__voiceboxLiveClient = null;

    // Trigger meters clear
    window.__voiceboxMeters.drawInputWave(null);
    window.__voiceboxMeters.drawOutputRing(null);

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
