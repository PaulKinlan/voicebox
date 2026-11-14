// tests/resolver-no-model.test.mjs — with no model configured there is NO turn brain to fall back to.
//
// voicebox-beads-cwx5.24: the server used to default its turn resolver to "script", a keyless regex
// parser, so a room with no model key looked as if it worked. Voicebox answers turns with a model; the
// script parser is a test/development resolver that must be chosen by name. This pins the contract the
// route relies on: `resolveTurn` with no provider refuses with NO_MODEL_NOTE, never a scripted action,
// while page-driving system commands (mute, stop speaking) still resolve.
//
// UNIT lane on purpose: the decision lives entirely in `resolveTurn`, which POST /api/turn calls with
// `effectiveProvider()` (null when no key and no VOICEBOX_RESOLVER).
import test from "node:test";
import assert from "node:assert/strict";
import { resolveTurn, NO_MODEL_NOTE } from "../lib/resolver.mjs";

test("no provider: a turn the script parser would have answered is refused, naming the missing key", async () => {
  for (const provider of [null, undefined, ""]) {
    const action = await resolveTurn("create a file called hello.txt with hi", provider);
    assert.equal(action.verb, undefined, "no scripted action is invented without a model");
    assert.equal(action.unresolved, NO_MODEL_NOTE);
    assert.equal(action.refused, "no-model");
    assert.match(action.unresolved, /GEMINI_API_KEY/);
  }
});

test("no provider: system commands still resolve, because they drive the page rather than answer the turn", async () => {
  const action = await resolveTurn("stop speaking", null);
  assert.equal(action.verb, "system");
});

test("the script resolver still answers when it is chosen by name", async () => {
  const action = await resolveTurn("create a file called hello.txt with hi", "script");
  assert.equal(action.verb, "write");
});
