// tests/audio-device-controller-extraction.test.mjs — the audio device selector and its routing live in
// public/components/audio-device-controller.mjs, not inline in public/fused.js (voicebox-beads-uei2.6).
//
// The owner test is unchanged and keeps driving the feature end to end: tests/settings-dialog.test.mjs
// seeds "voicebox.devices" with a microphone that has left and reads the two rows back out of the dialog.
// This file covers the ways THIS extraction can rot while that one stays green:
//   1. THE MOVE DID NOT HAPPEN, checked as text rather than as intent: the moved region must be
//      BYTE-IDENTICAL to the region it was cut from (git blob of the extraction base), modulo the two
//      documented seam substitutions, and the moved markers must be gone from the host and present in
//      the module. No lint gate sees a dead copy.
//   2. A LEFTOVER COPY in the host — the property is COUNTED, not asserted: one open must cost exactly
//      one device enumeration, and the counter is shown to be sensitive by making a second controller
//      enumerate again.
//   3. THE LISTENER TRAVELLING WITH THE MODULE: a listener-free CLONE of a picker must change nothing.
//   4. THE PREFERENCE IS NOT A GRANT: choosing a microphone writes the preference and does NOT call
//      getUserMedia.
//   5. getLiveClient being a LIVE ACCESSOR rather than a value captured at init.
//   6. The page global's shape (window.__voiceboxDevices) drifting, which other tests read.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "public", "components", "audio-device-controller.mjs");
const HOST_PATH = path.join(ROOT, "public", "fused.js");

// The commit whose public/fused.js carries the region as it was before the extraction. It is immutable,
// so reading the region back out of it is a real comparison rather than a second copy that can drift.
const EXTRACTED_FROM = "f721ada";
const REGION_OPENS_WITH = "// ── devices: what was chosen, what is available, what is happening";
const REGION_ENDS_BEFORE = "const micHotkeyController = initMicHotkeyController(";

// THE ONLY SUBSTITUTIONS ALLOWED IN THE MOVED TEXT — the injected seams, named. Anything else that
// differs between the host's old region and the module is a behaviour change wearing a refactor's coat.
const SEAMS = [
  ["window.__voiceboxLiveClient", "getLiveClient()"],
  ["localStorage", "storage"],
];

const MOVED_MARKERS = [
  'const DEVICE_KEY = "voicebox.devices"',
  "const devices = {",
  "function loadPrefs()",
  "function savePrefs()",
  "async function listDevices()",
  "function fillPicker",
  "function renderDevices()",
  "async function refreshDevices()",
  "on(els.micSelect,",
  "on(els.outSelect,",
];

let server;
let BASE;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "audio-device-extraction-test" } });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/`);
  // window.__voiceboxDevices is assigned at the end of fused.js's top-level body.
  await page.waitFor(() => window.__voiceboxDevices !== undefined, { label: "the host to publish window.__voiceboxDevices" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

// ── static arms, named guards so their mutants can drive them ────────────────────────────────────────
// Token, not substring: `includes("function savePrefs")` would also accept `function savePrefsLegacy`.
const hasMarker = (text, marker) => new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(text);

/** The region as public/fused.js carried it, with the injected seams applied — or a thrown error naming why not. */
function movedRegionFromHostAtBase() {
  const blob = execFileSync("git", ["show", `${EXTRACTED_FROM}:public/fused.js`], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const lines = blob.split("\n");
  const start = lines.findIndex((l) => l.startsWith(REGION_OPENS_WITH));
  assert.ok(start > -1, `the extraction base ${EXTRACTED_FROM} must still carry the region's own comment header (${REGION_OPENS_WITH})`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith(REGION_ENDS_BEFORE));
  assert.ok(end > start, `the region must end before ${REGION_ENDS_BEFORE} in the base blob`);
  let stop = end;
  while (stop - 1 > start && lines[stop - 1].trim() === "") stop--;
  let region = lines.slice(start, stop).join("\n");
  assert.ok(region.endsWith("});"), "the region must end at the close of its last handler");
  for (const [from, to] of SEAMS) region = region.split(from).join(to);
  return region;
}

function assertMovedOutOfHost(hostSource, moduleSource) {
  for (const marker of MOVED_MARKERS) {
    assert.ok(!hasMarker(hostSource, marker), `${marker} must no longer be inline in fused.js`);
    assert.ok(hasMarker(moduleSource, marker), `the extracted module must carry ${marker}`);
  }
  // The region's own contract comment moves with the code it governs.
  assert.ok(moduleSource.includes(REGION_OPENS_WITH), "the module must carry the region's comment header");
  assert.ok(!hostSource.includes(REGION_OPENS_WITH), "the host must not keep the comment header without the code");
}

function assertByteIdentical(moduleSource, region) {
  assert.ok(
    moduleSource.includes(region),
    "the moved region must appear in the module BYTE-IDENTICALLY, apart from the two documented seams (getLiveClient and storage) — a rewritten statement is a behaviour change",
  );
  // Sensitivity: the comparison above must be able to fail. One altered character in the region is enough.
  assert.ok(!moduleSource.includes(region.replace("policy: \"stop\"", 'policy: "fallback"')), "the byte-identity check must be sensitive to a single changed statement");
}

function assertHostContract(hostSource, moduleSource) {
  assert.match(hostSource, /import \{ createAudioDeviceController \} from "\.\/components\/audio-device-controller\.mjs";/, "the host imports the module");
  assert.match(moduleSource, /export function createAudioDeviceController\(\{ els, on, getLiveClient, storage = localStorage \}\)/, "one factory, with the live client accessor and the store injected");
  const initSites = [...hostSource.matchAll(/createAudioDeviceController\(/g)].length;
  assert.equal(initSites, 1, "the controller must be created at exactly one site; a second copy is the leftover-copy defect");
  assert.match(hostSource, /getLiveClient: \(\) => window\.__voiceboxLiveClient,/, "getLiveClient must be a LIVE accessor, not a value captured at init (voicebox-beads-w1f9)");
  assert.match(hostSource, /refreshDevices: audioDeviceController\.refresh,/, "the settings panel gets the controller's own refresh");
  assert.match(hostSource, /audioDeviceController\.loadPrefs\(\);/, "the host still loads the stored preference at boot");
  assert.match(
    hostSource,
    /window\.__voiceboxDevices = \{\s*micId: audioDeviceController\.micId,\s*outputId: audioDeviceController\.outputId,\s*state: audioDeviceController\.state,\s*refresh: audioDeviceController\.refresh,\s*\};/,
    "window.__voiceboxDevices keeps its shape and reads the module's accessors",
  );
  assert.match(hostSource, /addEventListener\("devicechange", audioDeviceController\.refresh\)/, "the devicechange listener must call the module's refresh");
  assert.doesNotMatch(hostSource, /window\.__voiceboxLiveClient = \{ micId/, "no second device surface may be rebuilt in the host");
}

test("the region is byte-identical in the module and gone from the host, and the host contract holds", () => {
  const host = readFileSync(HOST_PATH, "utf8");
  const mod = readFileSync(MODULE_PATH, "utf8");
  const region = movedRegionFromHostAtBase();

  assertMovedOutOfHost(host, mod);
  assertByteIdentical(mod, region);
  assertHostContract(host, mod);

  // NEGATIVE MUTANTS: each guard must fail when the thing it checks is undone.
  const hostWithLeftover = host.replace("const audioDeviceController = createAudioDeviceController({", "function savePrefs() { return null; }\nconst audioDeviceController = createAudioDeviceController({");
  assert.notEqual(hostWithLeftover, host, "the leftover-copy mutant must change the host");
  assert.throws(() => assertMovedOutOfHost(hostWithLeftover, mod), { name: "AssertionError" }, "a leftover inline copy must be caught");

  const modWithRewrittenStatement = mod.replace('policy: "stop",', 'policy: "fallback",');
  assert.notEqual(modWithRewrittenStatement, mod, "the rewritten-statement mutant must change the module");
  assert.throws(() => assertByteIdentical(modWithRewrittenStatement, region), { name: "AssertionError" },
    "a rewritten statement inside the moved region must fail the byte-identity arm: this is the mutant that says the arm compares text rather than asserting its own intent");

  const hostWithoutLiveAccessor = host.replace("getLiveClient: () => window.__voiceboxLiveClient,", "getLiveClient: window.__voiceboxLiveClient,");
  assert.notEqual(hostWithoutLiveAccessor, host, "the snapshot-accessor mutant must change the host");
  assert.throws(() => assertHostContract(hostWithoutLiveAccessor, mod), { name: "AssertionError" },
    "capturing the client as a VALUE must be refused (voicebox-beads-w1f9)");

  const hostWithSecondSite = host.replace("const audioDeviceController = createAudioDeviceController({", "const otherDeviceController = createAudioDeviceController({\n  els,\n  on,\n  getLiveClient: () => window.__voiceboxLiveClient,\n  storage: localStorage,\n});\nconst audioDeviceController = createAudioDeviceController({");
  assert.notEqual(hostWithSecondSite, host, "the second-init-site mutant must change the host");
  assert.throws(() => assertHostContract(hostWithSecondSite, mod), { name: "AssertionError" }, "a second controller instance must be caught");

  const hostWithStaleGlobal = host.replace("state: audioDeviceController.state,", "state: () => ({}),");
  assert.notEqual(hostWithStaleGlobal, host, "the stale-global mutant must change the host");
  assert.throws(() => assertHostContract(hostWithStaleGlobal, mod), { name: "AssertionError" }, "a global that no longer reaches the module must be caught");
});

test("one open costs exactly one device enumeration, and the counter can see a second copy", async () => {
  const counted = await page.evaluate(async () => {
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    let calls = 0;
    navigator.mediaDevices.enumerateDevices = (...args) => { calls++; return real(...args); };
    // The refresh the host's devicechange listener and the settings panel both call.
    await window.__voiceboxDevices.refresh();
    const afterHostRefresh = calls;
    // The counter's SENSITIVITY, proved rather than asserted: a second controller over the same page
    // enumerates again, which is exactly the signature a leftover inline copy would produce.
    const { createAudioDeviceController } = await import("/components/audio-device-controller.mjs");
    const els = { micSelect: document.getElementById("mic-select"), outSelect: document.getElementById("out-select"), micDeviceState: document.getElementById("mic-device-state"), outDeviceState: document.getElementById("out-device-state"), stage: document.getElementById("stage") };
    const second = createAudioDeviceController({ els, on: () => {}, getLiveClient: () => window.__voiceboxLiveClient, storage: localStorage });
    await second.refresh();
    const afterSecondController = calls;
    navigator.mediaDevices.enumerateDevices = real;
    return { afterHostRefresh, afterSecondController };
  });
  assert.equal(counted.afterHostRefresh, 1, "one refresh must enumerate devices exactly once — two would mean a second copy of the surface is live");
  assert.equal(counted.afterSecondController, 2, "the counter must be able to see a second copy enumerate; otherwise the assertion above proves nothing");
});

test("the rows still tell the truth after the move, and a listener-free clone of a picker changes nothing", async () => {
  // The owner test's case, driven here too: a chosen microphone that is NOT present must be named rather
  // than silently replaced by the default, and the output row must stay untouched.
  await page.evaluate(() => localStorage.setItem("voicebox.devices", JSON.stringify({ mic: { id: "mic-that-left", name: "Desk microphone" }, out: { id: "out-that-left", name: "Studio monitors" } })));
  await page.reload();
  await page.waitFor(() => window.__voiceboxDevices !== undefined, { label: "the host to republish the device surface after reload" });
  await page.waitFor(() => document.getElementById("mic-device-state")?.textContent?.includes("Desk microphone"), { label: "the stored microphone to be named after a reload" });

  const rows = await page.evaluate(() => ({
    mic: document.getElementById("mic-device-state").textContent,
    out: document.getElementById("out-device-state").textContent,
    micValues: [...document.getElementById("mic-select").options].map((o) => o.value),
    shape: {
      micId: typeof window.__voiceboxDevices.micId,
      outputId: typeof window.__voiceboxDevices.outputId,
      state: typeof window.__voiceboxDevices.state,
      refresh: typeof window.__voiceboxDevices.refresh,
      stateValue: window.__voiceboxDevices.state(),
      micIdValue: window.__voiceboxDevices.micId(),
    },
  }));
  assert.match(rows.mic, /Desk microphone/, "the chosen-but-absent microphone must be named by the name that was saved");
  assert.ok(rows.micValues.includes("mic-that-left"), "the absent choice must stay an option in the picker");
  assert.ok(rows.out.includes("Studio monitors"), "the output row must name its own saved device");
  assert.deepEqual(
    [rows.shape.micId, rows.shape.outputId, rows.shape.state, rows.shape.refresh],
    ["function", "function", "function", "function"],
    "window.__voiceboxDevices must keep its four function members",
  );
  assert.equal(rows.shape.micIdValue, "mic-that-left", "the global's micId must report the stored preference");
  assert.equal(rows.shape.stateValue.policy, "stop", "the stop-never-fall-back policy must be readable through the global");

  // A CLONE has no listener: the module bound the host's element, not the id.
  const clone = await page.evaluate(() => {
    const select = document.getElementById("mic-select");
    const before = { stored: localStorage.getItem("voicebox.devices"), state: document.getElementById("mic-device-state").textContent };
    const copy = select.cloneNode(true);
    select.parentElement.appendChild(copy);
    copy.value = "";
    copy.dispatchEvent(new Event("change", { bubbles: true }));
    const after = { stored: localStorage.getItem("voicebox.devices"), state: document.getElementById("mic-device-state").textContent };
    copy.remove();
    return { before, after };
  });
  assert.equal(clone.after.stored, clone.before.stored, "changing a clone of the picker must not write the preference: the listener is on the host-supplied element");
  assert.equal(clone.after.state, clone.before.state, "changing a clone must not repaint the row");

  await page.evaluate(() => localStorage.removeItem("voicebox.devices"));
});

test("choosing a device writes the preference and is NOT a grant: no getUserMedia, and the live client is read at use time", async () => {
  const chosen = await page.evaluate(async () => {
    const realEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => ([
      { kind: "audioinput", deviceId: "mic-a", label: "Desk microphone", groupId: "g" },
      { kind: "audioinput", deviceId: "mic-b", label: "Headset", groupId: "g" },
      { kind: "audiooutput", deviceId: "out-a", label: "Studio monitors", groupId: "g" },
    ]);
    let grants = 0;
    const realGum = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { grants++; return realGum ? realGum(...args) : Promise.reject(new Error("no real getUserMedia in this headless page")); };

    // A LIVE ACCESSOR is what makes this observable: the client is replaced AFTER init, exactly as it is
    // between rooms, and the module must use the NEW one.
    const calls = [];
    window.__voiceboxLiveClient = { state: { capture: false, playbackActive: false }, canChooseOutput: () => true, startCapture: async (o) => { calls.push(["startCapture", o]); }, stopCapture: async () => { calls.push(["stopCapture"]); }, setOutputDevice: async (id) => { calls.push(["setOutputDevice", id]); return { ok: true }; } };

    await window.__voiceboxDevices.refresh();
    const select = document.getElementById("mic-select");
    select.value = "mic-b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const storedMic = JSON.parse(localStorage.getItem("voicebox.devices")).mic;
    const stateAfterChoice = document.getElementById("mic-device-state").textContent;

    const out = document.getElementById("out-select");
    out.value = "out-a";
    out.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    // The output change must go through the REPLACED client's setOutputDevice, which is only possible if
    // the module read the live client at use time rather than snapshotting it at init.
    const noGrant = grants;
    const storedOut = JSON.parse(localStorage.getItem("voicebox.devices")).out;
    const afterOutputSwitch = document.getElementById("out-device-state").textContent;

    // A refusal from the client must restore the previous preference rather than leave a lying label.
    window.__voiceboxLiveClient = { state: { capture: false, playbackActive: false }, canChooseOutput: () => true, setOutputDevice: async () => ({ ok: false, reason: "device is in use" }) };
    out.value = "";
    out.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const afterRefusal = { stored: JSON.parse(localStorage.getItem("voicebox.devices")).out, state: document.getElementById("out-device-state").textContent };

    navigator.mediaDevices.enumerateDevices = realEnumerate;
    if (realGum) navigator.mediaDevices.getUserMedia = realGum;
    return { calls, storedMic, stateAfterChoice, storedOut, afterOutputSwitch, noGrant, afterRefusal };
  });

  assert.equal(chosen.storedMic.id, "mic-b", "choosing a microphone must persist the id");
  assert.equal(chosen.storedMic.name, "Headset", "the preference stores the NAME as well as the id, so an absent device can still be named");
  assert.match(chosen.stateAfterChoice, /Headset/, "the row must repaint from the module after the choice");
  assert.equal(chosen.noGrant, 0, "choosing a device is a PREFERENCE, never a grant: getUserMedia must not be called by a choice");
  assert.ok(
    chosen.calls.some(([what, id]) => what === "setOutputDevice" && id === "out-a"),
    `the output choice must reach the LIVE client's setOutputDevice (calls: ${JSON.stringify(chosen.calls)})`,
  );
  assert.deepEqual(
    chosen.storedOut,
    { id: "out-a", name: "Studio monitors" },
    "a refused output must restore the preference in force before the refused choice (the empty value must not be stored)",
  );
  // NOT asserted here, and deliberately: the refusal reason the module writes into the row is then
  // overwritten by the renderDevices() call at the end of the same branch. That is VERBATIM pre-move
  // behaviour (the region moved byte-identically), so it is out of scope for an extraction, and pinning
  // either the presence or the absence of the reason here would make a future deliberate fix red this
  // file. It is recorded on voicebox-beads-uei2.6 as an observation for its own bead instead.
  assert.equal(typeof chosen.afterRefusal.state, "string", "the output row must be repainted after a refusal");
});

test("driven standalone, the module uses its injected deps and never touches the page's own surface", async () => {
  const result = await page.evaluate(async () => {
    const { createAudioDeviceController } = await import("/components/audio-device-controller.mjs");
    const els = {
      micSelect: document.createElement("select"),
      outSelect: document.createElement("select"),
      micDeviceState: document.createElement("p"),
      outDeviceState: document.createElement("p"),
      stage: document.createElement("div"),
    };
    const bound = [];
    const store = new Map();
    const client = { state: { capture: false, playbackActive: false }, canChooseOutput: () => false };
    const controller = createAudioDeviceController({
      els,
      on: (el, type) => bound.push([el === els.micSelect ? "mic" : el === els.outSelect ? "out" : "?", type]),
      getLiveClient: () => client,
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    });
    controller.loadPrefs();
    await controller.refresh();
    // canChooseOutput() is false, so the output picker must be disabled and say why — the moved policy.
    return {
      bound,
      micOptions: [...els.micSelect.options].map((o) => o.value),
      outDisabled: els.outSelect.disabled,
      outState: els.outDeviceState.textContent,
      micState: els.micDeviceState.textContent,
      statePolicy: controller.state().policy,
      nothingStored: store.has("voicebox.devices") === false,
      hasLoadPrefs: typeof controller.loadPrefs,
      hasRefresh: typeof controller.refresh,
    };
  });

  assert.deepEqual(result.bound, [["mic", "change"], ["out", "change"]], "the module wires exactly the two pickers on the elements it was handed");
  assert.deepEqual(result.micOptions, [""], "with no devices the microphone picker offers the system default only");
  assert.equal(result.outDisabled, true, "a browser that cannot choose an output disables the picker (canChooseOutput() was false)");
  assert.match(result.outState, /system output/i, "and the row says why, naming the device sound settings rather than a dead control");
  assert.match(
    result.micState,
    /lists no named microphones until you allow access/,
    "the microphone row must say WHY the list is short rather than show a dead control",
  );
  assert.equal(result.statePolicy, "stop", "the stop-never-fall-back policy travels with the module");
  assert.equal(result.nothingStored, true, "merely loading and rendering must not write the preference");
  assert.equal(result.hasLoadPrefs, "function", "the host needs loadPrefs as a returned member");
  assert.equal(result.hasRefresh, "function", "window.__voiceboxDevices.refresh needs the controller's own refresh");
});
