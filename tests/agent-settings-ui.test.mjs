// tests/agent-settings-ui.test.mjs — the agent's settings as a person sees them.
//
//   node --test tests/agent-settings-ui.test.mjs
//
// The API checks (tests/agent-settings.test.mjs) prove the payload separates requested from applied.
// THIS file proves the dialog tells the same truth, because the failure mode the whole feature was
// built around — "a setting that silently does nothing" — is a UI failure: the payload can be
// perfectly honest while the picker next to it implies the change took effect.
//
// NO AMBIENT CREDENTIALS, IN EITHER DIRECTION. The first version of this file asserted the
// "in use" row, which is only true where the provider's key happens to be set — so on a machine
// without keys it failed while the UI was being honest ("Cannot be used: GEMINI_API_KEY is not set"),
// and the gate that runs on a fresh machine saw two reds that were the test's fault. (Found by
// astra's whole-gate run, not by me: my machine has the keys.) So the suite now CREATES both states
// on its own private servers — fixture keys for the available path, explicit blanks for the refusal
// path. The fixture values are presence-only: nothing here opens a live session, so no vendor is
// called and no real credential is needed. Blanking also overrides a machine that HAS keys, which is
// what makes the assertions the same on every machine.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";
import { startServer } from "./lib/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Presence-only fixture values: the server checks `Boolean(process.env[key])` to say whether a
// provider is configured, and this suite never opens a live session, so no vendor is contacted.
//
// THE WHOLE ENVIRONMENT IS PINNED, not just the keys. `startServer` spreads the caller's environment,
// so a fixture that overrode only the two keys would still be branching on whatever the shell
// happens to export — and two of those inputs change this suite's behaviour directly:
//   · VOICEBOX_WORKSPACE declares an active root at boot — UNSET here with `undefined`, which
//     Node omits from the child environment. (Blanking it with "" does not work and the failure is
//     instructive: the server reads `process.env.VOICEBOX_WORKSPACE ?? join(ROOT, "workspace")`, so
//     an empty string IS the workspace path and the server dies on `mkdir ''`. "Absent" and "empty"
//     are different states, and only one of them means "no declaration".)
//   · VOICEBOX_PROVIDER selects the turn resolver (scripted here, so a shell that sets a live
//     provider cannot make this suite reach a vendor)
// A test that reads ambient state is a test that reports on the machine, not on the code.
const PINNED_ENV = {
  GEMINI_API_KEY: "fixture-key-presence-only",
  OPENAI_API_KEY: "fixture-key-presence-only",
  VOICEBOX_WORKSPACE: undefined, // omitted from the child env: no root arrives from the shell
  VOICEBOX_PROVIDER: "script",
};
const NO_KEYS = { ...PINNED_ENV, GEMINI_API_KEY: "", OPENAI_API_KEY: "" };
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
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "agent-ui-test", ...PINNED_ENV } });
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

test("with a provider that cannot run, the row NAMES the reason — and the voices are still listed", { timeout: 90000 }, async () => {
  // The other direction, created by this suite rather than by whatever machine it runs on: a server
  // with no provider keys must make the dialog say WHICH key is missing. This is what a fresh clone
  // sees, so it is the state most likely to be seen by a person and the least likely to be tested.
  const bare = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "agent-ui-nokeys", ...NO_KEYS } });
  let barePage;
  try {
    barePage = await launch();
    await barePage.goto(`${bare.base}/`);
    await barePage.waitFor(() => document.getElementById("settings-open") !== null, { label: "the room (no keys)" });
    await barePage.click("#settings-open");
    await barePage.waitFor(() => document.getElementById("settings").open, { label: "the settings dialog (no keys)" });
    await sleep(500);

    const view = await barePage.evaluate(() => ({
      provider: document.getElementById("agent-provider-state").textContent,
      providerOptions: [...document.getElementById("agent-provider").options].map((o) => o.label),
      voiceOptions: [...document.getElementById("agent-voice").options].map((o) => o.value),
      personalities: [...document.getElementById("agent-personality").options].map((o) => o.value),
      baseNote: document.getElementById("agent-base-note").textContent,
    }));

    assert.match(view.provider, /Cannot be used: .*is not set/, `the row does not name the missing key: ${view.provider}`);
    assert.match(view.provider, /GEMINI_API_KEY|OPENAI_API_KEY/, "the row does not say which key is missing");
    // The picker still works: a person can choose, and the row tells them why it cannot run yet.
    assert.ok(view.voiceOptions.includes("Kore"), "the voices disappeared along with the provider");
    assert.ok(view.personalities.includes("plain"), "the personalities disappeared along with the provider");
    assert.ok(view.providerOptions.some((label) => /not available/.test(label)), "the picker does not mark the unusable provider");
    // And the read-only base is still shown: it does not depend on any provider being configured.
    assert.match(view.baseNote, /editable here: no/);
    // The pinning is asserted, not assumed: this suite's servers must have NO root declared, so a
    // shell exporting VOICEBOX_WORKSPACE cannot change what these fixtures measure.
    const root = await fetch(`${bare.base}/api/root`).then((r) => r.json());
    assert.equal(root.declared, false, `the fixture inherited a root from the shell: ${JSON.stringify(root.root)}`);
  } finally {
    await barePage?.close();
    await bare.stop();
  }
});
