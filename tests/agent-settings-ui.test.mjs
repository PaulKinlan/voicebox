// tests/agent-settings-ui.test.mjs — the agent's settings as a person sees them.
//
//   node --test tests/agent-settings-ui.test.mjs
//
// The API checks (tests/agent-settings.test.mjs) prove the payload separates requested from applied.
// THIS file proves the dialog tells the same truth, because the failure mode the whole feature was
// built around — "a setting that silently does nothing" — is a UI failure: the payload can be
// perfectly honest while the picker next to it implies the change took effect.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";
import { startServer } from "./lib/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server;
let page;

const state = () =>
  page.evaluate(() => ({
    provider: document.getElementById("agent-provider-state").textContent,
    providerOptions: [...document.getElementById("agent-provider").options].map((o) => o.value),
    voiceOptions: [...document.getElementById("agent-voice").options].map((o) => o.value),
    voice: document.getElementById("agent-voice-state").textContent,
    personality: document.getElementById("agent-personality-state").textContent,
    personalityOptions: [...document.getElementById("agent-personality").options].map((o) => o.value),
    base: document.getElementById("agent-base").textContent,
    baseNote: document.getElementById("agent-base-note").textContent,
  }));

const choose = (id, value) =>
  page.evaluate((pickerId, chosen) => {
    const picker = document.getElementById(pickerId);
    picker.value = chosen;
    picker.dispatchEvent(new Event("change"));
  }, id, value);

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "agent-ui-test" } });
  page = await launch();
  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.getElementById("settings-open") !== null, { label: "the room" });
  await page.click("#settings-open");
  await page.waitFor(() => document.getElementById("settings").open, { label: "the settings dialog" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("the dialog shows what is APPLIED, and says where the request and the reality differ", { timeout: 90000 }, async () => {
  await page.evaluate(() => void window.__voiceboxLoadAgent?.());
  await sleep(400);
  const view = await state();

  // PROVIDER: applied, and the only row that can say what a session is using.
  assert.match(view.provider, /In use for the next session: Gemini Live/, `the provider row does not state what will be used: ${view.provider}`);
  assert.match(view.provider, /models\/gemini-3\.8-live/, "the provider row does not name the model");
  assert.match(view.provider, /No live session is open|A live session is using/, "the row does not say whether a session is running");

  // VOICE and PERSONALITY: stored, and SAID not to be applied. This is the trap-1 assertion at the
  // level a person reads — if someone later wires the picker straight through, these two lines fail.
  assert.match(view.voice, /not applied/, `the voice row claims more than the system does: ${view.voice}`);
  assert.match(view.personality, /not applied/, `the personality row claims more than the system does: ${view.personality}`);
  assert.match(view.baseNote, /editable here: no/, "the dialog does not say the base is read-only");

  // THE BASE IS SHOWN, and it is not editable: no control in the dialog carries that text.
  assert.match(view.base, /You are voicebox/, "the base instruction is not shown");
  const editableControlsHoldingTheBase = await page.evaluate((base) =>
    [...document.querySelectorAll("#settings input, #settings textarea, #settings [contenteditable]")]
      .filter((el) => (el.value ?? el.textContent ?? "").includes(base.slice(0, 40))).length, view.base);
  assert.equal(editableControlsHoldingTheBase, 0, "a personality could edit the mandatory base through a control in this dialog");
});

test("voices follow the provider — a Gemini voice is never offered to an OpenAI session", { timeout: 90000 }, async () => {
  const gemini = await state();
  assert.ok(gemini.voiceOptions.includes("Kore"), "the Gemini voices are missing");
  assert.equal(gemini.voiceOptions.includes("verse"), false, "a Gemini session is offered an OpenAI voice");

  await choose("agent-provider", "openai");
  await sleep(500);
  const openai = await state();
  assert.ok(openai.voiceOptions.includes("verse"), `the OpenAI voices are missing: ${JSON.stringify(openai.voiceOptions)}`);
  assert.equal(openai.voiceOptions.includes("Kore"), false, "an OpenAI session is offered a Gemini voice");
  assert.match(openai.provider, /OpenAI Realtime/, "the provider row did not follow the change");

  // And a refusal is shown by name in the row a person is looking at, not swallowed.
  const refused = await page.evaluate(async () => {
    const answer = await fetch("/api/agent-settings", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: "Kore" }),
    }).then((r) => r.json());
    return answer;
  });
  assert.equal(refused.refused, "voice-not-offered-by-provider", JSON.stringify(refused));
  assert.match(refused.why, /alloy|verse|shimmer/, "the refusal does not name the voices that provider offers");

  await choose("agent-provider", "gemini");
  await sleep(400);
  const back = await state();
  assert.ok(back.voiceOptions.includes("Kore"), "switching back did not restore the Gemini voices");
});
