// tests/live-required-rates.test.mjs — step 1 of the rate work (journal-6g0).
//
// The defect: the browser captured at 16 kHz, the OpenAI provider declared 24 kHz to its vendor, and the PCM
// was forwarded unchanged — so the provider told OpenAI one thing and sent another, and nothing in the path
// could notice. It hid because Gemini takes 16 kHz: with one implementation nobody had to negotiate.
//
// The fix begins with DECLARATION, not conversion: each provider states the input rate its own protocol
// requires, next to the protocol that requires it, and the host can ask. The page can then be told what to
// capture at, and the browser's own pipeline does the conversion (there is still no hand-rolled resampler).
//
//   node --test tests/live-required-rates.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { inputRateRequiredBy, availableLiveProviders, registerLiveProvider } from "../lib/live-session.mjs";
import { GEMINI_REQUIRED_INPUT_RATE } from "../lib/live-providers/gemini.mjs";
import { OPENAI_REQUIRED_INPUT_RATE } from "../lib/live-providers/openai.mjs";

test("rates: every registered provider declares what its protocol requires — and the two differ", () => {
  for (const name of availableLiveProviders()) {
    const rate = inputRateRequiredBy(name);
    assert.ok(Number.isFinite(rate) && rate > 0, `${name} must declare a usable input rate, got ${rate}`);
  }
  assert.equal(inputRateRequiredBy("gemini"), GEMINI_REQUIRED_INPUT_RATE);
  assert.equal(inputRateRequiredBy("openai"), OPENAI_REQUIRED_INPUT_RATE);
  // THE POINT OF THE WHOLE FINDING: they are not the same rate, which is why one call site cannot assume.
  assert.notEqual(GEMINI_REQUIRED_INPUT_RATE, OPENAI_REQUIRED_INPUT_RATE,
    "if these ever match, the negotiation still has to exist — the next provider will differ again");
});

test("rates: a provider that has not declared a requirement is REFUSED, not defaulted", () => {
  registerLiveProvider("undeclared-rate", () => ({ start() {}, sendAudio() {}, close() {} }));
  assert.throws(
    () => inputRateRequiredBy("undeclared-rate"),
    /has not declared the input rate its protocol requires/,
    "guessing a provider's rate is the defect; the host must refuse to",
  );
});

test("rates: the declaration is next to the protocol, not in the shared path", async () => {
  // A structural assertion, cheap and deliberate: the numbers live in the provider files.
  const fs = await import("node:fs");
  const gemini = fs.readFileSync("lib/live-providers/gemini.mjs", "utf8");
  const openai = fs.readFileSync("lib/live-providers/openai.mjs", "utf8");
  assert.match(gemini, /GEMINI_REQUIRED_INPUT_RATE = 16000/);
  assert.match(openai, /OPENAI_REQUIRED_INPUT_RATE = 24000/);
  assert.match(openai, /client-events/, "the OpenAI rate carries its citation, so it can be checked");
});
