// public/components/audio-device-controller.mjs — the audio device selector and its routing, extracted
// from public/fused.js (voicebox-beads-uei2.6, a slice of the fused.js decomposition scoped in
// voicebox-beads-uei2).
//
// OWNS: what microphone/speaker was CHOSEN, what is AVAILABLE and what is HAPPENING — the #mic-select /
// #out-select pickers, the #mic-device-state / #out-device-state readouts, the "voicebox.devices"
// preference, and the route policy when a chosen device leaves (stop, never silently fall back). The
// comment carrying that contract — conflating the three facts is how a page names a device it is not
// using — travels with the code it governs.
//
// DOES NOT OWN: the elements, the listener binder, the live client or the store. `els`/`on` are the
// host's; `storage` is injected by the same seam the hotkey controller uses; the module never reaches
// for a global element or the page's own localStorage.
//
// `getLiveClient` is a LIVE ACCESSOR, NOT A VALUE (voicebox-beads-w1f9): the host passes
// `() => window.__voiceboxLiveClient`, because the client is replaced between rooms and created after
// this controller. A snapshot captured here would keep naming the boot-time client while every
// assertion about the surface stayed green.
export function createAudioDeviceController({ els, on, getLiveClient, storage = localStorage }) {
// ── devices: what was chosen, what is available, what is happening ────────
//
// Three separate facts per row, because conflating them is how a page ends up
// naming a device it is not using. The preference is stored as an id AND a
// name: the id is what getUserMedia and setSinkId take, the name is the only
// thing that can still name a device that has left the machine (isocan's
// lesson, kept). Device choice is a preference, never a grant.
const DEVICE_KEY = "voicebox.devices";

const devices = {
  prefs: { mic: { id: "", name: "" }, out: { id: "", name: "" } },
  inputs: [],
  outputs: [],
  namesVisible: false,
  canChooseOutput: true,
  // The routing decision, made explicitly rather than inherited: when the
  // chosen output disappears mid-reply this page STOPS playback and says so. It
  // does not silently move a private reply to the system speakers, because a
  // name change that implies a stop while sound keeps coming out somewhere else
  // is the audible version of a lying label.
  policy: "stop",
};

function loadPrefs() {
  try {
    const saved = JSON.parse(storage.getItem(DEVICE_KEY) ?? "null");
    if (saved?.mic) devices.prefs.mic = { id: String(saved.mic.id ?? ""), name: String(saved.mic.name ?? "") };
    if (saved?.out) devices.prefs.out = { id: String(saved.out.id ?? ""), name: String(saved.out.name ?? "") };
  } catch { /* no storage, or someone else's shape: start from the default */ }
}

function savePrefs() {
  try { storage.setItem(DEVICE_KEY, JSON.stringify(devices.prefs)); } catch { /* private mode */ }
}

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], names: false };
  const all = await navigator.mediaDevices.enumerateDevices();
  const named = all.some((d) => d.label);
  return {
    inputs: all.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, name: d.label })),
    outputs: all.filter((d) => d.kind === "audiooutput").map((d) => ({ id: d.deviceId, name: d.label })),
    names: named,
  };
}

function fillPicker(select, list, pref, what, namesVisible) {
  if (!select) return;
  const options = [{ id: "", name: "System default" }, ...list.filter((d) => d.id !== "")];
  // An absent choice stays visible by its saved name rather than being replaced
  // by "System default": the preference is what the person set.
  if (pref.id && !options.some((option) => option.id === pref.id)) {
    // "not connected" is a CLAIM, and it is only sayable when the device list
    // can actually name devices. With names hidden the honest suffix is that
    // this is the name the person saved.
    options.push({ id: pref.id, name: `${pref.name || "chosen device"} · ${namesVisible ? "not connected" : "saved"}` });
  }
  const wanted = options.map((option) => `${option.id}\u0000${option.name}`).join("|");
  if (select.dataset.shape === wanted) return; // no rebuild of an unchanged picker
  select.dataset.shape = wanted;
  select.replaceChildren(...options.map((option) => {
    const el = document.createElement("option");
    el.value = option.id;
    el.textContent = option.name || `unnamed ${what}`;
    return el;
  }));
  select.value = pref.id ?? "";
}

function renderDevices() {
  const { prefs, inputs, outputs, canChooseOutput, namesVisible } = devices;
  fillPicker(els.micSelect, inputs, prefs.mic, "microphone", namesVisible);
  fillPicker(els.outSelect, outputs, prefs.out, "output", namesVisible);

  const micNamesHidden = !namesVisible;
  // A picker with one option and no explanation is a picker that looks broken.
  // Chrome hands out no ids or labels until the origin has microphone access,
  // so the honest row says WHY the list is short rather than showing a dead
  // control. Same for outputs, where the browser may not route at all.
  const inputIdsUsable = inputs.some((d) => d.id);
  const outputIdsUsable = outputs.some((d) => d.id);
  const micPresent = inputs.some((d) => d.id === prefs.mic.id);
  const outPresent = outputs.some((d) => d.id === prefs.out.id);

  const listening = els.stage?.dataset.voice === "listening";
  const speaking = els.stage?.dataset.voice === "speaking";
  const capture = Boolean(getLiveClient()?.state?.capture);

  const micName = prefs.mic.name || "System default";
  let mic = "";
  if (!prefs.mic.id && !inputIdsUsable) mic = listening ? "Listening through System default" : "Mic off · this browser lists no named microphones until you allow access";
  else if (!prefs.mic.id) mic = listening ? "Listening through System default" : "Mic off";
  else if (micNamesHidden && !micPresent) mic = `${micName} · not checked yet — device names can be hidden until microphone access is allowed`;
  else if (listening) mic = `Listening through ${micName}`;
  else if (micPresent) mic = `${micName} · mic off`;
  else mic = `${micName} is not connected. Mic off.`;
  if (els.micDeviceState) els.micDeviceState.textContent = mic;

  let out = "";
  if (canChooseOutput && !outputIdsUsable && !prefs.out.id) out = speaking
    ? "Reply playing through the system output · this browser lists no named outputs until you allow access"
    : "No reply playing · this browser lists no named outputs until you allow access";
  else if (!canChooseOutput) out = "This browser uses system output. Change the output in your device's sound settings.";
  else if (!prefs.out.id) out = speaking ? "Reply playing through System default" : "No reply playing";
  else if (speaking && outPresent) out = `Reply playing through ${prefs.out.name || "the chosen output"}`;
  else if (!outPresent) {
    out = `${prefs.out.name || "The chosen output"} is not connected. `;
    out += speaking ? "Reply playback stopped." : "No reply playing.";
  } else out = "No reply playing";

  if (els.outDeviceState) els.outDeviceState.textContent = out;
  if (els.outSelect) els.outSelect.disabled = !canChooseOutput;

  // The client owns the voice-state line (it is derived from real capture and
  // playback); this page owns DEVICE facts, which the client cannot know. Each
  // fact now sits in the row it belongs to, inside the settings dialog, where a
  // person is when they wonder what they have — not in a second voice under the
  // microphone repeating what the rows already say (coord, 2026-09-20).
}

async function refreshDevices() {
  const before = { mic: devices.prefs.mic.id, out: devices.prefs.out.id };
  const listed = await listDevices();
  devices.inputs = listed.inputs;
  devices.outputs = listed.outputs;
  devices.canChooseOutput = getLiveClient()?.canChooseOutput?.() ?? false;
  devices.namesVisible = listed.names === true;

  // INPUT: a chosen microphone that has left is named; capture is never moved to
  // another device silently, and the output row is untouched.
  if (before.mic && !listed.inputs.some((d) => d.id === before.mic)) {
    if (els.stage?.dataset.voice === "listening" || getLiveClient()?.state?.capture) {
      await getLiveClient()?.stopCapture?.();
    }
  }

  // OUTPUT: the decided policy is to STOP rather than fall back. Name where the
  // audio actually is, and keep Stop reply working.
  if (before.out && !listed.outputs.some((d) => d.id === before.out)) {
    if (devices.policy === "stop" && getLiveClient()?.state?.playbackActive) {
      getLiveClient().stopPlayback?.();
    }
  }
  renderDevices();
}

on(els.micSelect, "change", async () => {
  const choice = devices.inputs.find((d) => d.id === els.micSelect.value);
  devices.prefs.mic = { id: els.micSelect.value, name: choice?.name ?? "" };
  savePrefs();
  if (getLiveClient()?.state?.capture) {
    try {
      await getLiveClient().stopCapture?.();
      await getLiveClient().startCapture?.({ deviceId: devices.prefs.mic.id || null });
    } catch { /* startCapture surfaces any error via onError */ }
  }
  renderDevices();
});

on(els.outSelect, "change", async () => {
  const choice = devices.outputs.find((d) => d.id === els.outSelect.value);
  const previous = { ...devices.prefs.out };
  devices.prefs.out = { id: els.outSelect.value, name: choice?.name ?? "" };
  savePrefs();
  if (els.outDeviceState) els.outDeviceState.textContent = `Switching output to ${devices.prefs.out.name || "System default"}…`;
  const applied = await getLiveClient()?.setOutputDevice?.(devices.prefs.out.id || "");
  if (applied && !applied.ok) {
    devices.prefs.out = previous;
    savePrefs();
    // REPAINT FIRST, THEN SAY WHY (voicebox-beads-cqrd). The row is repainted from the RESTORED
    // preference, and renderDevices() writes the generic "No reply playing" line while doing it — so a
    // refusal written before this call was the one line the reader never saw. The refusal goes last.
    renderDevices();
    // The picker is put back explicitly as well: fillPicker() deliberately skips rebuilding an unchanged
    // option list, so it cannot undo the value the person just picked here. Without this the row says the
    // switch failed while the control beside it still names the device that is NOT in use — the same lie
    // one control to the left, measured on main as selectValue "out-b" against a preference of "out-a".
    if (els.outSelect) els.outSelect.value = devices.prefs.out.id ?? "";
    if (els.outDeviceState) els.outDeviceState.textContent = `Could not use ${choice?.name || "that output"}. ${applied.reason}.`;
    return;
  }
  renderDevices();
});
  // The page global the host publishes (window.__voiceboxDevices) is built from these accessors rather
  // than from the record itself: the three device facts stay readable by whoever asks, and the record
  // stays private to the module that owns it.
  return {
    loadPrefs,
    refresh: refreshDevices,
    micId: () => devices.prefs.mic.id || null,
    outputId: () => devices.prefs.out.id || null,
    state: () => ({ ...devices.prefs, policy: devices.policy }),
  };
}
