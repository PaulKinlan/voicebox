// tests/audio-device-controller-boot-paint.test.mjs — "the client has not answered yet" is NOT the same
// fact as "this browser cannot choose an output" (voicebox-beads-t1k9).
//
// The output row's first branch is the live client's fact (`canChooseOutput`), and that client is published
// by a DIFFERENT module script (`public/live-voice.js`) than the one that boots this surface
// (`public/fused.js`) — two module scripts whose completion order is not fixed, because fused.js's body
// awaits. So on some boots the refresh runs with no client at all, and the module cached that absence as
// `false`, which painted "This browser uses system output. Change the output in your device's sound
// settings." over a machine that does offer output selection.
//
// The state is forced here rather than waited for: setting the client to null and refreshing IS the boot
// state on the box that loses the race, so the control is deterministic on every box that runs it.
//
// `tests/audio-device-controller-extraction.test.mjs` covers the MOVE (byte-identity, enumeration counts,
// the live accessor); this file covers only what the rows may CLAIM before and after the client answers.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The sentence the browser-without-output-selection case gets. It is a NEGATIVE claim about the machine.
const NO_OUTPUT_SELECTION = "This browser uses system output. Change the output in your device's sound settings.";

let server;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "audio-device-boot-paint-test" } });
  page = await launch();
  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxDevices !== undefined, { label: "the host to publish window.__voiceboxDevices" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

/** Seed the saved output, stub a device list that does NOT contain it, and refresh with the given client. */
async function paintWith(client) {
  await page.evaluate(() => localStorage.setItem("voicebox.devices", JSON.stringify({
    mic: { id: "", name: "" },
    out: { id: "out-that-left", name: "Studio monitors" },
  })));
  // A RELOAD, not just a write: loadPrefs() reads the store once at boot, so a preference written into a
  // running page is never the one on screen (the extraction test reloads for the same reason).
  await page.reload();
  await page.waitFor(() => window.__voiceboxDevices !== undefined, { label: "the host to republish the device surface after reload" });
  return page.evaluate(async (clientChoice) => {
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => ([
      { kind: "audioinput", deviceId: "mic-a", label: "Desk microphone", groupId: "g" },
      { kind: "audiooutput", deviceId: "out-a", label: "Headset earpiece", groupId: "g" },
    ]);
    // `undefined` means "no client yet" — the state the boot refresh can genuinely be in.
    window.__voiceboxLiveClient = clientChoice === undefined
      ? null
      : { state: { capture: false, playbackActive: false }, canChooseOutput: () => clientChoice };
    await window.__voiceboxDevices.refresh();
    const out = document.getElementById("out-device-state").textContent;
    const picker = document.getElementById("out-select");
    navigator.mediaDevices.enumerateDevices = real;
    return { out, pickerDisabled: picker.disabled };
  }, client);
}

test("with no client yet, the row must not claim the machine cannot choose an output (voicebox-beads-t1k9)", async () => {
  const unknown = await paintWith(undefined);
  assert.doesNotMatch(
    unknown.out,
    /This browser uses system output/,
    `before the live client answers, the row must not assert a negative about the machine: it read ${JSON.stringify(unknown.out)}`,
  );
  assert.match(
    unknown.out,
    /Studio monitors is not connected|No reply playing/,
    "the honest line names the saved device and its own presence, which the page DOES know from the device list",
  );
  // Deliberately NOT asserted here: the picker's disabled state. This arm drives the PAGE's controller,
  // which may already hold an answer from an earlier refresh on a boot that won the race, and the last
  // known answer is a legitimate thing to keep. The unknown-for-certain state is pinned by the next arm,
  // on a controller that has never had a client at all.
});

test("a controller that has NEVER had a client must not claim the machine cannot choose an output", async () => {
  // Box-independent, unlike the arm above: a fresh controller with an accessor that never yields a client
  // is the losing-race boot on any machine, so this is the deterministic before/after control.
  const never = await page.evaluate(async () => {
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => ([
      { kind: "audiooutput", deviceId: "out-a", label: "Headset earpiece", groupId: "g" },
    ]);
    const { createAudioDeviceController } = await import("/components/audio-device-controller.mjs");
    const els = {
      micSelect: document.getElementById("mic-select"),
      outSelect: document.getElementById("out-select"),
      micDeviceState: document.getElementById("mic-device-state"),
      outDeviceState: document.getElementById("out-device-state"),
      stage: document.getElementById("stage"),
    };
    const controller = createAudioDeviceController({ els, on: () => {}, getLiveClient: () => null, storage: localStorage });
    controller.loadPrefs();
    await controller.refresh();
    const out = document.getElementById("out-device-state").textContent;
    const pickerDisabled = document.getElementById("out-select").disabled;
    navigator.mediaDevices.enumerateDevices = real;
    // Leave the page's own surface repainted from its own facts before the next arm.
    await window.__voiceboxDevices.refresh();
    return { out, pickerDisabled };
  });
  assert.doesNotMatch(
    never.out,
    /This browser uses system output/,
    `a controller that has never heard from a client must not assert a negative about the machine: it read ${JSON.stringify(never.out)}`,
  );
  assert.equal(never.pickerDisabled, true, "and no capability is offered before one is known");
});

test("the same page state DOES say it once a client answers that this browser cannot choose an output", async () => {
  // The control that keeps the arm above honest: the fix must not be "delete the branch". The page state is
  // identical to the arm above; only the client's ANSWER differs.
  const refused = await paintWith(false);
  assert.equal(refused.out, NO_OUTPUT_SELECTION, "a client that cannot choose an output must still get that sentence, verbatim");
  assert.equal(refused.pickerDisabled, true, "and the picker stays disabled for a browser that cannot choose one");
});

test("a client that CAN choose output names the saved device instead of either negative line", async () => {
  const capable = await paintWith(true);
  assert.match(capable.out, /Studio monitors is not connected/, "a capable browser is told which of its own saved devices is missing");
  assert.doesNotMatch(capable.out, /This browser uses system output|until you allow access/, "and neither fallback sentence is used where it does not apply");
  assert.equal(capable.pickerDisabled, false, "the picker is offered once the capability is known");
});

test("the answer is read at PAINT time, so a client that appears later is used by the next repaint", async () => {
  // This is what makes the fix a paint-time read rather than a warmer cache: the client is replaced after
  // the module was initialised, and the very next repaint must use the NEW answer without a refresh first.
  await page.evaluate(() => localStorage.setItem("voicebox.devices", JSON.stringify({ mic: { id: "", name: "" }, out: { id: "out-that-left", name: "Studio monitors" } })));
  await page.reload();
  await page.waitFor(() => window.__voiceboxDevices !== undefined, { label: "the host to republish the device surface after reload" });
  const later = await page.evaluate(async () => {
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => ([{ kind: "audiooutput", deviceId: "out-a", label: "Headset earpiece", groupId: "g" }]);
    window.__voiceboxLiveClient = null;
    await window.__voiceboxDevices.refresh();
    const withoutClient = document.getElementById("out-device-state").textContent;
    // The client attaches (live-voice.js finishes loading) and something repaints — the mic-change handler
    // is repaint-only work, so it must not need a device re-enumeration to pick the answer up.
    window.__voiceboxLiveClient = { state: { capture: false, playbackActive: false }, canChooseOutput: () => true };
    const { createAudioDeviceController } = await import("/components/audio-device-controller.mjs");
    const els = {
      micSelect: document.getElementById("mic-select"),
      outSelect: document.getElementById("out-select"),
      micDeviceState: document.getElementById("mic-device-state"),
      outDeviceState: document.getElementById("out-device-state"),
      stage: document.getElementById("stage"),
    };
    const controller = createAudioDeviceController({ els, on: () => {}, getLiveClient: () => window.__voiceboxLiveClient, storage: localStorage });
    controller.loadPrefs();
    // A repaint with NO refresh at all: renderDevices is reached through the picker's own handler.
    const select = document.getElementById("mic-select");
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const afterRepaint = document.getElementById("out-device-state").textContent;
    navigator.mediaDevices.enumerateDevices = real;
    return { withoutClient, afterRepaint };
  });
  assert.doesNotMatch(later.withoutClient, /This browser uses system output/, "the unknown state stays honest");
  assert.match(
    later.afterRepaint,
    /Studio monitors is not connected/,
    "a repaint after the client attaches must use the client's answer, not the cached absence of one",
  );
});
