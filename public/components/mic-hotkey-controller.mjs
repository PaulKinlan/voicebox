/**
 * @summary Configurable microphone push-to-talk and toggle hotkey controller.
 */
// public/components/mic-hotkey-controller.mjs — the configurable microphone hotkey, extracted from
// public/fused.js (voicebox-beads-uei2.4, a slice of the fused.js decomposition scoped in
// voicebox-beads-uei2; the feature itself is voicebox-beads-ebu).
//
// OWNS: the shortcut value and its persistence, the #mic-hotkey field and its two listeners, the
// #mic-hotkey-state / #mic-hotkey-badge / #mic aria-keyshortcuts paint, and the hotkey's OWN semantics —
// whether a key matches, and what a match does (flash the mic, then click it).
//
// DOES NOT OWN, deliberately: WHEN the page looks at a key. The host's global keydown dispatcher keeps its
// guards — modifier keys, an input/textarea/select/contenteditable focused, an open <dialog> — and asks
// this module only after a plain keypress has survived them. Those guards are behaviour the owner test
// pins by name (typing 'm' in the composer must NOT toggle; a press while a modal is open must NOT
// toggle), so moving them here would move the thing that makes them true, for no gain.
//
// `storage` is injected: the module never reaches for the localStorage global itself, so a caller can hand
// it another store and a test can drive it without touching the page's real one.
export function initMicHotkeyController({ els, on, storage = localStorage }) {
  // ── Configurable microphone hotkey (voicebox-beads-ebu) ───────────────────
  const HOTKEY_KEY = "voicebox-mic-hotkey";
  let micHotkey = "M";

  function updateHotkeyUI() {
    if (els.micHotkey && els.micHotkey.value !== micHotkey) {
      els.micHotkey.value = micHotkey;
    }
    if (els.micHotkeyState) {
      els.micHotkeyState.textContent = `Press '${micHotkey}' to toggle mic`;
    }
    if (els.micHotkeyBadge) {
      els.micHotkeyBadge.textContent = micHotkey;
    }
    if (els.mic) {
      els.mic.setAttribute("aria-keyshortcuts", micHotkey);
      els.mic.title = `Speak a turn (hotkey: ${micHotkey})`;
    }
  }

  function loadHotkey() {
    try {
      const saved = storage.getItem(HOTKEY_KEY);
      if (saved && typeof saved === "string" && saved.trim()) {
        micHotkey = saved.trim().charAt(0).toUpperCase();
      }
    } catch {}
    updateHotkeyUI();
  }

  function setHotkey(key) {
    const clean = (key || "M").trim().charAt(0).toUpperCase() || "M";
    micHotkey = clean;
    try { storage.setItem(HOTKEY_KEY, micHotkey); } catch {}
    updateHotkeyUI();
  }

  on(els.micHotkey, "input", () => {
    const val = (els.micHotkey?.value ?? "").trim();
    if (val) {
      setHotkey(val);
    }
  });

  on(els.micHotkey, "keydown", (e) => {
    if (e.key === "Escape" || e.key === "Tab") return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setHotkey(e.key);
    }
  });

  // Moved out of the host's global keydown dispatcher: the match and the effect are the hotkey's own
  // business, the guards that decide whether the dispatcher even asks are not (see the header).
  function matchesHotkey(key) {
    return Boolean(key) && key.toUpperCase() === micHotkey.toUpperCase();
  }

  function toggleMic() {
    if (!els.mic) return;
    els.mic.classList.add("hotkey-active");
    setTimeout(() => els.mic?.classList.remove("hotkey-active"), 300);
    els.mic.click();
  }

  // `getHotkey` is a LIVE accessor, not a value: `window.__voiceboxHotkey.get()` is read by the
  // Document-PiP companion (public/pip-mic.mjs) to label its own control, and that read happens long
  // after init — a value snapshotted here would keep reporting the boot-time key.
  return { loadHotkey, setHotkey, getHotkey: () => micHotkey, matchesHotkey, toggleMic };
}
