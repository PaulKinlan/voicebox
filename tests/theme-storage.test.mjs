import test from "node:test";
import assert from "node:assert/strict";
import { initTheme, THEME_KEY } from "../public/theme.mjs";

function emitter() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    emit(type, data = {}) { for (const listener of [...(listeners.get(type) ?? [])]) listener(data); },
    count(type) { return listeners.get(type)?.size ?? 0; },
  };
}

test("initTheme owns one set of storage, media and UI listeners through re-entry and disposal", () => {
  const saved = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  const media = Object.assign(emitter(), { matches: false });
  const win = Object.assign(emitter(), { matchMedia: () => media });
  const root = { dataset: {} };
  const store = new Map();
  let writes = 0;
  const storage = {
    getItem(key) { return store.get(key) ?? null; },
    setItem(key, value) { writes++; store.set(key, value); },
  };
  globalThis.window = win;
  globalThis.document = { documentElement: root };
  globalThis.localStorage = storage;
  const first = Object.assign(emitter(), { value: "light" });
  const second = Object.assign(emitter(), { value: "light" });
  const toggle = Object.assign(emitter(), { setAttribute() {}, querySelector() { return null; } });
  const state = { textContent: "" };
  let dispose = () => {};
  try {
    dispose = initTheme({ themeSelect: first, themeToggle: toggle, themeSelectState: state });
    const unrelated = () => {};
    win.addEventListener("storage", unrelated);
    assert.equal(win.count("storage"), 2);
    assert.equal(media.count("change"), 1);
    assert.equal(first.count("change"), 1);
    const staleDispose = dispose;
    dispose = initTheme({ themeSelect: second, themeToggle: toggle, themeSelectState: state });
    assert.equal(first.count("change"), 0, "old control detached");
    assert.equal(second.count("change"), 1, "new control bound once");
    assert.equal(toggle.count("click"), 1, "toggle not bound twice");
    assert.equal(media.count("change"), 1, "media listener replaced");
    assert.equal(win.count("storage"), 2, "one owned and one unrelated storage listener");
    staleDispose();
    assert.equal(win.count("storage"), 2, "old disposer cannot remove newer listener");
    second.value = "dark";
    second.emit("change");
    assert.equal(writes, 1, "one user choice writes exactly once");
    assert.equal(root.dataset.theme, "dark");
    win.emit("storage", { key: "other", storageArea: storage, newValue: "light" });
    win.emit("storage", { key: THEME_KEY, storageArea: {}, newValue: "light" });
    assert.equal(root.dataset.theme, "dark", "other keys and storage areas ignored");
    win.emit("storage", { key: THEME_KEY, storageArea: storage, newValue: "system" });
    assert.equal(root.dataset.themeMode, "system");
    media.matches = true;
    media.emit("change");
    assert.equal(root.dataset.theme, "dark", "receiver system listener follows OS");
    media.matches = false;
    media.emit("change");
    assert.equal(root.dataset.theme, "light");
    win.emit("storage", { key: THEME_KEY, storageArea: storage, newValue: "garbage" });
    assert.equal(root.dataset.themeMode, "light", "poisoned choice uses project light fallback");
    win.emit("storage", { key: THEME_KEY, storageArea: storage, newValue: null });
    assert.equal(root.dataset.themeMode, "light", "removal uses light fallback");
    win.emit("storage", { key: THEME_KEY, storageArea: storage, newValue: "dark" });
    assert.equal(root.dataset.theme, "dark");
    store.clear();
    win.emit("storage", { key: null, storageArea: storage, newValue: null });
    assert.equal(root.dataset.theme, "light", "clear uses light fallback");
    assert.equal(writes, 1, "no storage event writes back to localStorage");
    dispose();
    dispose();
    assert.equal(win.count("storage"), 1, "only unrelated listener remains");
    assert.equal(media.count("change"), 0);
    assert.equal(second.count("change"), 0);
    assert.equal(toggle.count("click"), 0);
    win.removeEventListener("storage", unrelated);
  } finally {
    dispose();
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.localStorage = saved.localStorage;
  }
});
