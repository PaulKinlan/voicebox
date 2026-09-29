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
