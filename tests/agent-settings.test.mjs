// tests/agent-settings.test.mjs — the agent you are talking to: provider, voice, personality.
//
//   node --test tests/agent-settings.test.mjs
//
// Two traps shape this file, both named before a line was written:
//
//   1. A SETTING THAT SILENTLY DOES NOTHING is worse than no setting — the person believes they
//      changed something and the page agrees with them. So `applied` is never the request echoed
//      back: a setting nothing reads yet reports `null` WITH A REASON, and the checks below assert
//      exactly that, because it is the assertion that would fail if someone wired a picker to a
//      field and called it done.
//
//   2. A PERSONALITY THAT CAN DELETE THE SAFETY INSTRUCTION. If a personality replaced the system
//      instruction, choosing one could remove the sentences saying what the agent may do, where its
//      root is, and how a refusal is spoken. The composition is structural — the base is a module
//      constant and the composer takes no base parameter — and the last check asserts the ARITY,
//      which is the part no future edit can quietly change.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import {
  AGENT_BASE_INSTRUCTION,
  DEFAULT_AGENT_SETTINGS,
  PERSONALITIES,
  PROVIDERS,
  composeAgentInstruction,
  validateAgentSettings,
} from "../core/agent-settings.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server;
let BASE;

test.before(async () => {
  // A private instance on an ephemeral port: this suite changes settings, so it must not touch
  // anybody's running server.
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_WORKSPACE: undefined, VOICEBOX_INSTANCE: "agent-settings-test" } });
  BASE = server.base;
});

test.after(async () => {
  await server?.stop();
});

const settings = () => fetch(`${BASE}/api/agent-settings`).then((r) => r.json());
const update = (body) =>
  fetch(`${BASE}/api/agent-settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

// ── 1. the base cannot be removed, and cannot be passed in ───────────────────────────────────────

test("no personality can remove the base instruction — and the composer cannot even be handed one", () => {
  const baseSentences = AGENT_BASE_INSTRUCTION.split(". ").map((s) => s.trim()).filter(Boolean);

  for (const id of Object.keys(PERSONALITIES)) {
    const composed = composeAgentInstruction(id);
    assert.ok(composed.startsWith(AGENT_BASE_INSTRUCTION.split(" ")[0]), `${id} does not start with the base`);
    for (const sentence of baseSentences) {
      assert.ok(composed.includes(sentence.replace(/\.$/, "")), `${id} dropped part of the base: '${sentence.slice(0, 40)}…'`);
    }
  }

  // An unknown personality is not an error and cannot be a bypass: it composes the base alone.
  assert.equal(composeAgentInstruction("not-a-personality"), AGENT_BASE_INSTRUCTION);

  // THE STRUCTURAL FACT: one parameter, and it is the personality. There is no argument through which
  // a base could be replaced, which is what makes trap 2 unrepresentable rather than forbidden.
  assert.equal(composeAgentInstruction.length, 1, "the composer grew a parameter — check that a base cannot now be passed in");

  // And when a layer IS added, it is marked subordinate rather than left to compete.
  const warm = composeAgentInstruction("warm");
  assert.ok(warm.includes(PERSONALITIES.warm.layer), "the tone layer is missing");
  assert.ok(
    warm.indexOf("subordinate") > warm.indexOf(AGENT_BASE_INSTRUCTION.slice(0, 40)),
    "the tone layer is not marked as subordinate to the base",
  );
});

test("the request is checked by name, and a provider change does not carry a foreign voice across", () => {
  const cases = [
    [{ provider: "anthropic" }, "unknown-provider"],
    [{ personality: "sarcastic" }, "unknown-personality"],
    [{ voice: "Kore", provider: "openai" }, "voice-not-offered-by-provider"],
    [{ model: "gpt-5" }, "unknown-field"],
    [null, "bad-request"],
  ];
  for (const [input, refused] of cases) {
    const result = validateAgentSettings(input, DEFAULT_AGENT_SETTINGS);
    assert.equal(result.ok, false, `${JSON.stringify(input)} was accepted`);
    assert.equal(result.refused, refused, `expected ${refused}, saw ${result.refused}`);
    assert.ok(result.why.length > 20, `${refused} came with no explanation`);
  }

  // A voice belongs to a provider: changing provider without naming a voice drops back to that
  // provider's default rather than asking it for a voice it does not have.
  const sw = validateAgentSettings({ provider: "openai" }, { provider: "gemini", voice: "Kore", personality: "warm" });
  assert.equal(sw.ok, true);
  assert.equal(sw.value.voice, null, "a Gemini voice was carried into an OpenAI session");

  // And an explicit null means "use the provider's default", not "keep whatever was there".
  const cleared = validateAgentSettings({ voice: null }, { provider: "gemini", voice: "Kore", personality: "plain" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.voice, null);
});

test("voices are per provider: no list contains another provider's voice", () => {
  const gemini = PROVIDERS.gemini.voices.map((v) => v.id);
  const openai = PROVIDERS.openai.voices.map((v) => v.id);
  assert.ok(gemini.length > 0 && openai.length > 0, "a provider lost its voices");
  for (const id of gemini) assert.equal(openai.includes(id), false, `'${id}' is offered by both providers`);
  for (const id of openai) assert.equal(gemini.includes(id), false, `'${id}' is offered by both providers`);
});

// ── 2. requested vs applied, driven through the server ──────────────────────────────────────────

test("the payload separates requested, applied and pending — and the base is not editable", async () => {
  const view = await settings();
  assert.equal(view.ok, true);
  assert.deepEqual(Object.keys(view.requested).sort(), ["personality", "provider", "voice"]);
  assert.equal(view.base.editable, false, "the surface claims the base instruction is editable");
  assert.equal(view.base.instruction, AGENT_BASE_INSTRUCTION, "the surface shows something other than the real base");
  assert.ok(view.personalities.length >= 2, "no personalities are offered");
  assert.ok(view.persisted.includes("memory"), "the payload implies durability it does not have");

  // Every provider says whether it can be used AT ALL, and one that cannot says why — the same rule as
  // "do not offer an option that fails when chosen".
  for (const capability of view.capabilities) {
    assert.equal(typeof capability.available, "boolean");
    if (!capability.available) assert.match(capability.why, /is not set/, `unavailable ${capability.id} has no reason`);
  }
});

test("a stored setting IS reported as applied once the session seam carries it — never as the request alone", async () => {
  const put = await update({ voice: "Kore", personality: "warm" });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.requested, { provider: "gemini", voice: "Kore", personality: "warm" });

  // THE TRAP-1 ASSERTION, INVERTED BY THE HANDOFF: since the provider seam carries both, a stored
  // voice/personality IS applied to the next session — and pending says NOTHING is pending (null,
  // so "nothing pending" is distinguishable from "the field is gone").
  assert.equal(put.body.applied.voice, "Kore", "a voice the session carries is not reported as applied");
  assert.equal(put.body.pending.voice, null, "a pending reason for a carried voice is a stale claim");
  assert.equal(put.body.applied.instruction, "warm", "a personality the session carries is not reported as applied");
  assert.equal(put.body.pending.personality, null);

  // It survives a re-read (stored, not just echoed), and a fresh GET separates the two the same way.
  const view = await settings();
  assert.equal(view.requested.voice, "Kore");
  assert.equal(view.applied.voice, "Kore");
});

test("the provider IS applied — the setting reaches the session that starts next", async () => {
  const put = await update({ provider: "openai", voice: "verse" });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.applied.provider, "openai", "the chosen provider is not the one a session would dial");
  assert.equal(put.body.applied.model, PROVIDERS.openai.model, "the model does not follow the provider");
  assert.equal(put.body.runningSession, null, "no session was started, so none should be reported as running");

  // Back to Gemini, and the voice rule bites in both directions.
  const foreign = await update({ provider: "gemini", voice: "verse" });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.refused, "voice-not-offered-by-provider");
  assert.match(foreign.body.why, /Puck|Charon|Kore|Fenrir|Aoede/, "the refusal does not name the voices Gemini does offer");

  // A REFUSED UPDATE LEAVES THE PREVIOUS SETTINGS ALONE — the same discipline as a refused root
  // declaration, and the reason the check above could not corrupt this one.
  const after = await settings();
  assert.equal(after.requested.provider, "openai", "a refused update changed the provider anyway");
  assert.equal(after.requested.voice, "verse", "a refused update changed the voice anyway");

  const back = await update({ provider: "gemini", voice: "Kore" });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.applied.provider, "gemini");
});
