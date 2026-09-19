// public/pcm.js — PCM16 <-> Float32 conversion, pure functions, no DOM.
//
// The boundary that the tests can actually pin: the wire is little-endian
// PCM16 mono; the AudioWorklet hands over Float32 in [-1, 1]. Off-by-one,
// rounding, clipping and endianness are all decided here, once, so the
// browser path and the tests agree by construction rather than by eye.

/** Clamp and round a float sample to int16. */
export function floatToInt16Sample(value) {
  const v = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  // 32767 for the positive end so +1 does not wrap to -32768.
  return Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
}

/** Float32Array (mono) -> little-endian PCM16 bytes (ArrayBuffer). */
export function floatToPcm16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = floatToInt16Sample(input[i]);
  return out.buffer;
}

/** Little-endian PCM16 bytes -> Float32Array in [-1, 1). */
export function pcm16ToFloat(bytes) {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error(`PCM16 payload must have an even byte length, got ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** True when the payload is a non-empty, even-length PCM16 buffer. */
export function isPcm16(bytes) {
  return (bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) && bytes.byteLength > 0 && bytes.byteLength % 2 === 0;
}
