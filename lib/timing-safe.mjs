// lib/timing-safe.mjs — one owner for asking "is this caller-supplied secret ours?"
//
// voicebox-beads-sseh / GH #26. Three sites used to answer that question with `===`, one of
// them already length-gated by hand, and a fourth (the loopback session cookie) answered it
// with its own inline constant-time compare. One question, several computing sites, is how
// two answers to the same question start disagreeing — so the comparison lives here now and
// the sites ask this module.
//
// What this buys, stated honestly rather than oversold: for two strings of equal length it
// removes the byte-by-byte early exit, so a caller cannot learn how many leading characters
// it guessed correctly from how long the answer took. What it does NOT buy: the length gate
// still reveals the expected length, and under this project's accepted local posture no
// practical timing exploit was ever asserted — this is template hardening, not the fix for a
// demonstrated attack.
//
// The gate is load-bearing in a second, unglamorous way: `crypto.timingSafeEqual` THROWS on
// buffers of different length, so comparing unequal lengths without it would turn a bad token
// into a crashed request. Equal lengths, then the constant-time compare; anything else is a
// rejection.
import { timingSafeEqual } from "node:crypto";

/**
 * Compare a caller-supplied secret against ours in constant time.
 *
 * Accepts only the identical string. Rejects, without throwing, anything that is not a
 * string, anything of a different length, and any content mismatch. The caller keeps its own
 * surrounding rules (truthiness, fail-closed reads); this answers exactly one question.
 *
 * @param {unknown} provided - the untrusted value, straight from a header or body
 * @param {unknown} expected - our secret, read from where it lives
 * @returns {boolean} true only when both are strings and identical
 */
export function timingSafeStringEqual(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
