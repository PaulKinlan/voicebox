// public/audio-meters.mjs — Real-time audio waveform and circular ring meters (voicebox-beads-uei2.1)

export const OUTPUT_SAMPLES = 64;
export const INPUT_BARS_PAGE = 28;
export const OUTPUT_CENTRE = 120;
export const OUTPUT_BASE = 62; // hugs the button (radius ~55 in these units)
export const OUTPUT_AMPLITUDE = 13; // a contour hugging the button, lightly textured by real audio
export const RENDER_POINTS = 160; // drawn points around the ring (Catmull-Rom through denser points)

const RING_COS = new Float64Array(RENDER_POINTS);
const RING_SIN = new Float64Array(RENDER_POINTS);
for (let i = 0; i < RENDER_POINTS; i++) {
  const angle = (i / RENDER_POINTS) * Math.PI * 2 - Math.PI / 2;
  RING_COS[i] = Math.cos(angle);
  RING_SIN[i] = Math.sin(angle);
}

let ringPhase = 0;
let ringTarget = 0;
let ringSeen = null;
let ringFlowPhase = 0;
const ringRadii = new Float64Array(RENDER_POINTS).fill(OUTPUT_BASE);

let inputDisplay = new Float32Array(INPUT_BARS_PAGE);
let inputInit = false;
let inputPeak = 0;
export const INPUT_GATE = 0.12;

/**
 * Mean-absolute energy from real speech is small (~0.01 quiet, ~0.03-0.1 talking).
 * Square root spreads quiet speech and saturates loud audio.
 */
export function meterLevel(value) {
  const energy = Number(value);
  if (!Number.isFinite(energy) || energy <= 0) return 0;
  return Math.min(1, Math.sqrt(energy) * 1.9);
}

export const waveLevel = (value) => Math.sqrt(Math.max(0, Number(value) || 0)) * 1.9;

export const MIX_FULL_SCALE = 0.5;
export const MIX_GAIN = 1 / waveLevel(MIX_FULL_SCALE);

/**
 * Sample the ring with a MIRRORED (triangle-folded) traversal.
 */
export function ringAt(samples, position) {
  if (!samples || samples.length === 0) return 0;
  const n = samples.length;
  const turn = ((position / n) % 1 + 1) % 1;
  const folded = turn <= 0.5 ? turn * 2 : (1 - turn) * 2;
  const at = folded * (n - 1);
  const i = Math.floor(at);
  const j = Math.min(n - 1, i + 1);
  const t = at - i;
  return samples[i] * (1 - t) + samples[j] * t;
}

/**
 * Closed Catmull-Rom through the points, as cubic Béziers.
 */
export function closedCurve(points) {
  if (!Array.isArray(points) || points.length === 0) return "";
  const n = points.length;
  const at = (i) => points[(i % n + n) % n];
  let d = `M${at(0)[0].toFixed(2)},${at(0)[1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

export function drawOutputRing(samples, { pathEl = null } = {}) {
  const path = pathEl || (typeof document !== "undefined" ? document.getElementById("output-path") : null);
  if (!path) return;
  if (!samples) {
    path.removeAttribute?.("d");
    ringSeen = null;
    ringPhase = 0;
    ringTarget = 0;
    ringFlowPhase = 0;
    ringRadii.fill(OUTPUT_BASE);
    return;
  }
  const newest = samples[samples.length - 1];
  if (ringSeen === null || Math.abs(newest - ringSeen) > 1e-6) {
    ringSeen = newest;
    ringTarget += 1;
  }
  ringPhase += (ringTarget - ringPhase) * 0.14;
  ringFlowPhase += 0.045;

  const points = new Array(RENDER_POINTS);
  for (let i = 0; i < RENDER_POINTS; i++) {
    const position = ringPhase + (i / RENDER_POINTS) * OUTPUT_SAMPLES;
    const target = OUTPUT_BASE + meterLevel(ringAt(samples, position)) * OUTPUT_AMPLITUDE;
    ringRadii[i] += (target - ringRadii[i]) * (target > ringRadii[i] ? 0.35 : 0.16);
    const shown = ringRadii[i];
    const level = Math.max(0, Math.min(1, (shown - OUTPUT_BASE) / OUTPUT_AMPLITUDE));
    const harmonic = level > 0.01 ? Math.sin((i / RENDER_POINTS) * Math.PI * 6 + ringFlowPhase) * level * 1.8 : 0;
    const radius = shown + harmonic;
    points[i] = [OUTPUT_CENTRE + RING_COS[i] * radius, OUTPUT_CENTRE + RING_SIN[i] * radius];
  }
  path.setAttribute?.("d", closedCurve(points));
}

export function drawInputWave(samples, { gain: givenGain = null, pathEl = null } = {}) {
  const path = pathEl || (typeof document !== "undefined" ? document.getElementById("input-path") : null);
  if (!path) return;
  if (!samples) {
    path.removeAttribute?.("d");
    inputInit = false;
    return;
  }
  const n = samples.length;
  if (!inputInit || inputDisplay.length !== n) {
    inputDisplay = new Float32Array(n);
    inputInit = true;
  }
  const middle = 50;
  const maxHalf = 46;

  let gain = givenGain;
  if (gain === null) {
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, waveLevel(samples[i]));
    inputPeak = Math.max(peak, inputPeak * 0.94);
    gain = inputPeak >= INPUT_GATE ? 1 / inputPeak : 1;
  }
  let top = "";
  let bottom = "";
  for (let i = 0; i < n; i++) {
    const target = Math.min(maxHalf, waveLevel(samples[i]) * gain * maxHalf * 0.85);
    inputDisplay[i] += (target - inputDisplay[i]) * (target > inputDisplay[i] ? 0.6 : 0.12);
    const half = Math.max(0.8, inputDisplay[i]);
    const x = ((i / (n - 1)) * 108 - 4).toFixed(2);
    top += `${i ? "L" : "M"}${x},${(middle - half).toFixed(2)}`;
    bottom = `L${x},${(middle + half).toFixed(2)}` + bottom;
  }
  path.setAttribute?.("d", `${top}${bottom}Z`);
}

export function mixSpeechAndMic(output, input) {
  const n = output.length;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const at = Math.min(input.length - 1, Math.floor((i / n) * input.length));
    samples[i] = output[i] + (input[at] ?? 0);
  }
  return { samples, gain: MIX_GAIN };
}
