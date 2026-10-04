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
//   · VOICEBOX_RESOLVER selects the turn resolver (scripted here, so a shell that sets a live
//     provider cannot make this suite reach a vendor)
// A test that reads ambient state is a test that reports on the machine, not on the code.
const PINNED_ENV = {
  GEMINI_API_KEY: "fixture-key-presence-only",
  OPENAI_API_KEY: "fixture-key-presence-only",
  VOICEBOX_WORKSPACE: undefined, // omitted from the child env: no root arrives from the shell
  VOICEBOX_RESOLVER: "script",
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

// THE DIALOG'S OWN LOAD, WAITED FOR RATHER THAN SLEPT PAST (voicebox-beads-g667), where 400-500ms sleeps
// were. Opening the dialog starts a load of the agent settings (fused.js: the settings-open click →
// loadAgentSettings), and every load ends in one redraw of #agent-provider-state — a rewrite even when the
// text is the same, so a MutationObserver sees it. The room's boot-time load is waited out FIRST, so the
// count that follows is the dialog's alone: a boot-time answer can then neither stand in for the dialog's
// load nor land on top of a change made after it.
async function beforeOpeningSettings(p, label) {
  await p.waitFor(() => (document.getElementById("agent-provider-state")?.textContent ?? "Not asked yet") !== "Not asked yet",
    { label: `${label}: the boot-time agent settings to be drawn` });
  await p.evaluate(() => {
    window.__agentSettingsDraws = 0;
    new MutationObserver(() => { window.__agentSettingsDraws += 1; })
      .observe(document.getElementById("agent-provider-state"), { childList: true, characterData: true, subtree: true });
  });
}
const settingsLoadDrawn = (p, label) =>
  p.waitFor(() => window.__agentSettingsDraws >= 1, { label: `${label}: the settings dialog's own load to be answered and drawn` });

// THE CHANGE HAS BEEN ANSWERED (voicebox-beads-g667), where 400-500ms sleeps were. A picker's change PUTs
// the setting, and the page takes the server's answer in ONE synchronous step — it stores what the server
// says is requested (localStorage) and redraws every row (fused.js saveAgentSetting) — so the stored value
// moving to the one just chosen means the rows read next are the answer's. A refusal answered with
// ok:false writes "Refused (…)" into every row instead: an answer too, and the assertions then report it.
// (One sent as a 4xx throws inside request() and draws nothing; the wait then times out naming the change.)
const answered = (key, value) =>
  page.waitFor((k, v) =>
    JSON.parse(localStorage.getItem("voicebox.agent.settings.v1") ?? "null")?.[k] === v ||
    (document.getElementById("agent-provider-state")?.textContent ?? "").startsWith("Refused"),
  { label: `the ${key} change to ${JSON.stringify(value)} to be answered`, args: [key, value] });

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "agent-ui-test", ...PINNED_ENV } });
  page = await launch();
  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.getElementById("settings-open") !== null, { label: "the room" });
  await beforeOpeningSettings(page, "the room");
  await page.click("#settings-open");
  await page.waitFor(() => document.getElementById("settings").open, { label: "the settings dialog" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("the dialog shows what is APPLIED, and says where the request and the reality differ", { timeout: 90000 }, async () => {
  await page.evaluate(() => void window.__voiceboxLoadAgent?.());
  await settingsLoadDrawn(page, "the room"); // where a 400ms sleep was (voicebox-beads-g667)
  const view = await state();

  // PROVIDER: applied, and the only row that can say what a session is using.
  assert.match(view.provider, /In use for the next session: Gemini Live/, `the provider row does not state what will be used: ${view.provider}`);
  assert.match(view.provider, /models\/gemini-3\.8-live/, "the provider row does not name the model");
  assert.match(view.provider, /No live session is open|A live session is using/, "the row does not say whether a session is running");

  // VOICE and PERSONALITY: APPLIED since the handoff — the session carries both. The trap-1
  // assertion inverted: if someone later UNWIRES the seam, these rows go back to a pending reason
  // and this test fails.
  assert.match(view.voice, /Applied/, `the voice row does not say the choice is carried: ${view.voice}`);
  assert.match(view.personality, /Applied/, `the personality row does not say the choice is carried: ${view.personality}`);
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
  await answered("provider", "openai"); // where a 500ms sleep was (voicebox-beads-g667)
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
  await answered("provider", "gemini"); // where a 400ms sleep was (voicebox-beads-g667)
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
    await beforeOpeningSettings(barePage, "the room (no keys)");
    await barePage.click("#settings-open");
    await barePage.waitFor(() => document.getElementById("settings").open, { label: "the settings dialog (no keys)" });
    await settingsLoadDrawn(barePage, "the room (no keys)"); // where a 500ms sleep was (voicebox-beads-g667)

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

test("unified agent settings: model, voice timbre, custom prompt, and local storage persistence (voicebox-beads-bc0i)", { timeout: 90000 }, async () => {
  // Test controls for model, timbre, and custom prompt
  const models = await page.evaluate(() => [...document.getElementById("agent-model").options].map((o) => o.value));
  assert.ok(models.length >= 2, "Gemini models must be populated");

  const timbres = await page.evaluate(() => [...document.getElementById("agent-timbre").options].map((o) => o.value));
  assert.ok(timbres.includes("warm") && timbres.includes("crisp"), "timbres must be populated");

  // Select a timbre
  await choose("agent-timbre", "warm");
  await answered("timbre", "warm"); // where a 400ms sleep was (voicebox-beads-g667)
  const timbreState = await page.evaluate(() => document.getElementById("agent-timbre-state").textContent);
  assert.match(timbreState, /Warm/);

  // Set custom prompt instruction
  await page.evaluate(() => {
    const input = document.getElementById("agent-custom-instruction");
    input.value = "Be brief and technical.";
    input.dispatchEvent(new Event("change"));
  });
  // Where a 400ms sleep was (voicebox-beads-g667): the row the answer redraws, read rather than the stored
  // value — the stored value is what the lines below assert, so it cannot also be what is waited for.
  await page.waitFor(() => /^(Custom prompt active|Refused)/.test(document.getElementById("agent-custom-instruction-state")?.textContent ?? ""),
    { label: "the custom instruction change to be answered and drawn" });

  // Assert local storage has persisted the unified settings
  const localSaved = await page.evaluate(() => {
    return JSON.parse(localStorage.getItem("voicebox.agent.settings.v1") ?? "null");
  });
  assert.ok(localSaved, "settings must be persisted in localStorage");
  assert.equal(localSaved.timbre, "warm");
  assert.equal(localSaved.customInstruction, "Be brief and technical.");

  // Reload page and assert settings are restored from localStorage
  // THE RELOADED DOCUMENT, not the old one (voicebox-beads-g667): page.reload() returns after a fixed 600ms
  // without waiting for the new document, and the old one still shows what was just chosen — every read
  // below would pass against it. So the old document carries a marker, and the reloaded one must not.
  await page.evaluate(() => { window.__beforeReload = true; });
  await page.reload();
  await page.waitFor(() => !window.__beforeReload && document.getElementById("settings-open") !== null, { label: "the reloaded room" });
  await beforeOpeningSettings(page, "the reloaded room");
  await page.click("#settings-open");
  await page.waitFor(() => document.getElementById("settings").open);
  await settingsLoadDrawn(page, "the reloaded room"); // where a 500ms sleep was (voicebox-beads-g667)

  const reloadedTimbre = await page.evaluate(() => document.getElementById("agent-timbre").value);
  const reloadedCustom = await page.evaluate(() => document.getElementById("agent-custom-instruction").value);
  assert.equal(reloadedTimbre, "warm", "persisted timbre must be restored after reload");
  assert.equal(reloadedCustom, "Be brief and technical.", "persisted custom instruction must be restored after reload");
});

test("changing model from settings disconnects active live session and restarts with newly chosen model (voicebox-beads-vgeq)", { timeout: 90000 }, async () => {
  // 1. Establish spy hooks in the browser page for live session activity
  await page.evaluate(() => {
    window.__restarts = [];
    window.__mockLiveActive = true;
    window.__voiceboxIsLiveActive = () => window.__mockLiveActive;
    window.__origDisconnectAndRestartLive = window.__voiceboxDisconnectAndRestartLive;
    window.__voiceboxDisconnectAndRestartLive = async (reason) => {
      window.__restarts.push({
        reason,
        chosenModel: document.getElementById("agent-model").value,
      });
      return true;
    };
  });

  // 2. Change model via settings UI
  const targetModel = "models/gemini-3.8-thinking";
  await choose("agent-model", targetModel);
  await answered("model", targetModel);

  // 3. Verify that disconnect and restart was invoked with 'model-changed'
  const restartCalls = await page.evaluate(() => window.__restarts);
  assert.equal(restartCalls.length, 1, "disconnectAndRestartLive must be called exactly once on model change");
  assert.equal(restartCalls[0].reason, "model-changed");
  assert.equal(restartCalls[0].chosenModel, targetModel);

  // 4. Verify that when live session is NOT active, changing model does NOT call restart
  await page.evaluate(() => {
    window.__mockLiveActive = false;
    window.__restarts = [];
  });
  const defaultModel = "models/gemini-3.8-live";
  await choose("agent-model", defaultModel);
  await answered("model", defaultModel);
  const inactiveRestarts = await page.evaluate(() => window.__restarts);
  assert.equal(inactiveRestarts.length, 0, "must not restart if live session is not active");

  // Restore original hook
  await page.evaluate(() => {
    window.__voiceboxDisconnectAndRestartLive = window.__origDisconnectAndRestartLive;
    delete window.__origDisconnectAndRestartLive;
    delete window.__restarts;
    delete window.__mockLiveActive;
  });
});

test("disconnectAndRestartLive cleanly closes previous socket and opens new live connection (voicebox-beads-vgeq)", { timeout: 90000 }, async () => {
  const result = await page.evaluate(async () => {
    let stopped = false;
    let started = false;
    const client = window.__voiceboxLiveClient;
    const origStop = client.stopCapture;
    const origStart = client.startCapture;
    client.stopCapture = async () => {
      stopped = true;
      return origStop.call(client);
    };
    client.startCapture = async (opts) => {
      started = true;
      return origStart.call(client, opts);
    };

    window.__voiceboxSetCapturingForTest?.(true);
    const restarted = await window.__voiceboxDisconnectAndRestartLive("model-changed");
    window.__voiceboxSetCapturingForTest?.(false);

    client.stopCapture = origStop;
    client.startCapture = origStart;

    return { restarted, stopped, started };
  });

  assert.equal(result.restarted, true, "disconnectAndRestartLive should complete successfully");
  assert.equal(result.stopped, true, "must stop capture on disconnect");
  assert.equal(result.started, true, "must start capture on restart");
});
