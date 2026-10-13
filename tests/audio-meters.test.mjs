import test from "node:test";
import assert from "node:assert/strict";
import {
  closedCurve,
  drawInputWave,
  drawOutputRing,
  meterLevel,
  mixSpeechAndMic,
  ringAt,
  waveLevel,
  INPUT_BARS_PAGE,
  OUTPUT_SAMPLES,
  RENDER_POINTS,
} from "../public/audio-meters.mjs";

test("meterLevel produces a square-root spread clamped between 0 and 1", () => {
  assert.equal(meterLevel(0), 0);
  assert.equal(meterLevel(-5), 0);
  assert.equal(meterLevel(NaN), 0);
  assert.equal(meterLevel(Infinity), 0);

  // Small speech energy (0.01) is spread to ~0.19
  const small = meterLevel(0.01);
  assert.ok(small > 0.15 && small < 0.25, `expected ~0.19, got ${small}`);

  // Normal speech energy (0.04) is spread to ~0.38
  const normal = meterLevel(0.04);
  assert.ok(normal > 0.35 && normal < 0.45, `expected ~0.38, got ${normal}`);

  // Loud speech saturates at 1.0
  assert.equal(meterLevel(1.0), 1.0);
  assert.equal(meterLevel(5.0), 1.0);
});

test("ringAt implements mirrored continuous traversal across ring history", () => {
  const samples = new Float32Array([0.1, 0.5, 0.9]);
  assert.equal(ringAt([], 0), 0);

  // Position 0 gives samples[0]
  assert.equal(Math.round(ringAt(samples, 0) * 10) / 10, 0.1);

  // Position at mid gives peak
  const mid = ringAt(samples, 1.5);
  assert.ok(mid >= 0.8 && mid <= 0.9);

  // Position wrapping smoothly folds back without step discontinuity
  const wrapped = ringAt(samples, 3);
  assert.equal(Math.round(wrapped * 10) / 10, 0.1);
});

test("closedCurve generates valid Catmull-Rom SVG path data with Z closure", () => {
  assert.equal(closedCurve([]), "");

  const points = [
    [10, 10],
    [20, 20],
    [30, 10],
    [20, 0],
  ];
  const d = closedCurve(points);
  assert.ok(d.startsWith("M10.00,10.00"), "starts with moveto");
  assert.ok(d.includes("C"), "contains cubic Bezier curves");
  assert.ok(d.endsWith("Z"), "ends with path close");
});

test("mixSpeechAndMic blends output and input arrays with fixed scale gain", () => {
  const output = new Float32Array(OUTPUT_SAMPLES).fill(0.2);
  const input = new Float32Array(INPUT_BARS_PAGE).fill(0.1);

  const mix = mixSpeechAndMic(output, input);
  assert.equal(mix.samples.length, OUTPUT_SAMPLES);
  assert.ok(Number.isFinite(mix.gain));
  assert.ok(mix.gain > 0);

  for (let i = 0; i < OUTPUT_SAMPLES; i++) {
    // 0.2 + 0.1 = 0.3
    assert.ok(Math.abs(mix.samples[i] - 0.3) < 1e-5);
  }
});

test("drawOutputRing and drawInputWave populate SVG path d attribute on mock elements", () => {
  let outputD = "";
  let inputD = "";

  const mockOutputPath = {
    setAttribute(name, val) {
      if (name === "d") outputD = val;
    },
    removeAttribute(name) {
      if (name === "d") outputD = "";
    },
  };

  const mockInputPath = {
    setAttribute(name, val) {
      if (name === "d") inputD = val;
    },
    removeAttribute(name) {
      if (name === "d") inputD = "";
    },
  };

  const samples = new Float32Array(OUTPUT_SAMPLES).fill(0.05);

  drawOutputRing(samples, { pathEl: mockOutputPath });
  assert.ok(outputD.startsWith("M"));
  assert.ok(outputD.endsWith("Z"));

  drawInputWave(samples, { pathEl: mockInputPath });
  assert.ok(inputD.startsWith("M"));
  assert.ok(inputD.endsWith("Z"));

  // Null clears path
  drawOutputRing(null, { pathEl: mockOutputPath });
  assert.equal(outputD, "");

  drawInputWave(null, { pathEl: mockInputPath });
  assert.equal(inputD, "");
});
