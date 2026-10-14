// tests/mic-hotkey-extraction.test.mjs — the microphone hotkey controller lives in
// public/components/mic-hotkey-controller.mjs, not inline in public/fused.js (voicebox-beads-uei2.4).
//
// The owner test (tests/mic-hotkey.test.mjs) keeps driving the FEATURE end to end: default 'M', the
// composer/modal guards, reconfiguring, and persistence across a reload. Those assertions are unchanged.
// This test exists for the four ways an EXTRACTION can rot while that feature test stays green:
//   1. the surface still works, but through a LEFTOVER COPY in fused.js — so the effect is counted, and a
//      listener-free clone proves the count is about wiring rather than markup;
//   2. the move was not really made — so fused.js must no longer carry the moved markers, statically (a
//      dead leftover copy is invisible to every behaviour assertion and this repo has no lint gate);
//   3. the storage dependency was not really injected — so the module is driven standalone with a stub
//      store and must write there and not to the page's real one;
//   4. the live accessor became a snapshot — `window.__voiceboxHotkey.get()` is read by the Document-PiP
//      companion (public/pip-mic.mjs) long after init, so the value is re-read after it changes.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "public", "components", "mic-hotkey-controller.mjs");
const HOST_PATH = path.join(ROOT, "public", "fused.js");

let server;
let BASE;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "mic-hotkey-extraction-test" } });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.getElementById("mic") !== null, { label: "the mic button" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

// ── the static arms, as named guards so their mutants can drive them ────────────────────────────────
// A moved marker that is still in the host means the module is not the owner yet (a dead copy), so this
// asserts the move in BOTH directions rather than only that the module exists.
// The marker must be a TOKEN, not a substring: a plain `includes("function loadHotkey")` also matches
// `function loadHotkeyRenamed`, which is exactly the kind of near-miss this guard exists to catch.
const hasMarker = (text, marker) => new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(text);

function assertMovedOutOfHost(hostSource, moduleSource) {
  for (const marker of ["let micHotkey", "const HOTKEY_KEY", "function updateHotkeyUI", "function loadHotkey", "function setHotkey", "on(els.micHotkey"]) {
    assert.ok(!hasMarker(hostSource, marker), `${marker} must no longer be inline in fused.js`);
    assert.ok(hasMarker(moduleSource, marker), `the extracted module must carry ${marker}`);
  }
}

function assertStorageIsInjected(moduleSource) {
  assert.match(moduleSource, /export function initMicHotkeyController\(\{ els, on, storage = localStorage \}\)/, "the module takes storage as a dependency");
  assert.doesNotMatch(moduleSource, /localStorage\.(get|set)Item/, "the module must use the injected storage, never the localStorage global directly");
  assert.match(moduleSource, /storage\.getItem\(HOTKEY_KEY\)/, "loadHotkey reads through the injected storage");
  assert.match(moduleSource, /storage\.setItem\(HOTKEY_KEY, micHotkey\)/, "setHotkey writes through the injected storage");
}

test("the controller is really in the module and really gone from the host, and its storage is injected", () => {
  const host = readFileSync(HOST_PATH, "utf8");
  const mod = readFileSync(MODULE_PATH, "utf8");
  assertMovedOutOfHost(host, mod);
  assertStorageIsInjected(mod);
  assert.match(host, /initMicHotkeyController\(\{ els, on, storage: localStorage \}\)/, "the host wires it once and hands it storage");
  assert.match(host, /window\.__voiceboxHotkey = \{ get: micHotkeyController\.getHotkey, set: micHotkeyController\.setHotkey \};/,
    "the page global keeps its exact shape: public/pip-mic.mjs reads .get()");

  // NEGATIVE MUTANTS: the guards above must fail when the thing they check is undone.
  const hostWithLeftover = host.replace("const micHotkeyController", 'on(els.micHotkey, "input", () => { setHotkey("M"); });\nconst micHotkeyController');
  assert.notEqual(hostWithLeftover, host, "the leftover-copy mutant must actually change the host source");
  assert.throws(() => assertMovedOutOfHost(hostWithLeftover, mod), { name: "AssertionError" }, "a leftover inline copy must be caught");

  const modUsingGlobalStorage = mod.replace("storage.getItem(HOTKEY_KEY)", "localStorage.getItem(HOTKEY_KEY)");
  assert.notEqual(modUsingGlobalStorage, mod, "the global-storage mutant must actually change the module source");
  assert.throws(() => assertStorageIsInjected(modUsingGlobalStorage), { name: "AssertionError" }, "using the localStorage global must be caught");

  const modWithoutInjection = mod.replace("{ els, on, storage = localStorage }", "{ els, on }");
  assert.throws(() => assertStorageIsInjected(modWithoutInjection), { name: "AssertionError" }, "dropping the injected storage must be caught");

  const modWithoutMove = mod.replace("function loadHotkey()", "function loadHotkeyRenamed()");
  assert.notEqual(modWithoutMove, mod, "the renamed-marker mutant must actually change the module source");
  assert.throws(() => assertMovedOutOfHost(host, modWithoutMove), { name: "AssertionError" }, "a module that no longer carries the moved marker must be caught");
});

test("the real page paints the hotkey and toggles the mic exactly once, with the flash", async () => {
  // Paint: default 'M' on the badge, the aria shortcut and the title (the module's updateHotkeyUI()).
  const initial = await page.evaluate(() => ({
    badge: document.getElementById("mic-hotkey-badge")?.textContent,
    aria: document.getElementById("mic")?.getAttribute("aria-keyshortcuts"),
    title: document.getElementById("mic")?.getAttribute("title"),
    field: document.getElementById("mic-hotkey")?.value,
  }));
  assert.equal(initial.badge, "M", "the badge must render the default hotkey");
  assert.equal(initial.aria, "M", "aria-keyshortcuts must carry the default hotkey");
  assert.match(initial.title ?? "", /hotkey:\s*M/i, "the title must name the default hotkey");
  assert.equal(initial.field, "M", "the settings field must show the default hotkey");

  // Reconfigure through the field the module listens on (an input event, exactly what typing fires).
  await page.evaluate(() => {
    const field = document.getElementById("mic-hotkey");
    field.value = "v";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const afterInput = await page.evaluate(() => ({
    badge: document.getElementById("mic-hotkey-badge")?.textContent,
    state: document.getElementById("mic-hotkey-state")?.textContent,
    aria: document.getElementById("mic")?.getAttribute("aria-keyshortcuts"),
    stored: localStorage.getItem("voicebox-mic-hotkey"),
  }));
  assert.equal(afterInput.badge, "V", "reconfiguring must repaint the badge");
  assert.match(afterInput.state ?? "", /V/, "the state description must name the new hotkey");
  assert.equal(afterInput.aria, "V", "the aria shortcut must follow the new hotkey");
  assert.equal(afterInput.stored, "V", "the choice must persist under the same key as before the extraction");

  // A listener-free clone must do nothing: the module listens on the element the host handed it, not on
  // the document — which is what makes the count below evidence about wiring rather than markup.
  const cloneEffect = await page.evaluate(() => {
    const real = document.getElementById("mic-hotkey");
    const clone = real.cloneNode(true);
    clone.value = "z";
    real.parentNode.appendChild(clone);
    clone.dispatchEvent(new Event("input", { bubbles: true }));
    const out = { badge: document.getElementById("mic-hotkey-badge")?.textContent };
    clone.remove();
    return out;
  });
  assert.equal(cloneEffect.badge, "V", "a listener-free clone must not change the hotkey (the listener is on the host-supplied element)");

  // The effect, counted: one keypress, one mic click, one flash.
  await page.evaluate(() => {
    window.__micClicks = 0;
    window.__hotkeyFlashes = 0;
    const mic = document.getElementById("mic");
    mic.addEventListener("click", () => { window.__micClicks++; });
    new MutationObserver((records) => {
      for (const r of records) if (mic.classList.contains("hotkey-active")) window.__hotkeyFlashes++;
    }).observe(mic, { attributes: true, attributeFilter: ["class"] });
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86 });
  const count = await page.evaluate(() => ({ clicks: window.__micClicks, flashes: window.__hotkeyFlashes }));
  assert.equal(count.clicks, 1, "one press of the configured hotkey must reach the mic exactly ONCE — a leftover copy in fused.js makes this two");
  assert.ok(count.flashes >= 1, "the press must flash the mic (the hotkey-active feedback moved with the surface)");

  // A key that is not the hotkey must do nothing: the dispatcher still owns the match decision.
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81 });
  assert.equal(await page.evaluate(() => window.__micClicks), 1, "a non-hotkey press must not click the mic");
});

test("driven standalone with a stub store, the module never touches the page's real storage and its accessor stays live", async () => {
  const result = await page.evaluate(async () => {
    const { initMicHotkeyController } = await import("/components/mic-hotkey-controller.mjs");
    const written = [];
    const stubStorage = {
      getItem: (k) => (k === "voicebox-mic-hotkey" ? "j" : null),
      setItem: (k, v) => { written.push([k, v]); },
    };
    const clicks = { n: 0 };
    const els = {
      micHotkey: document.createElement("input"),
      micHotkeyState: document.createElement("span"),
      micHotkeyBadge: document.createElement("span"),
      mic: { classList: { add() {}, remove() {} }, setAttribute() {}, title: "", click: () => { clicks.n++; } },
    };
    const listeners = [];
    const controller = initMicHotkeyController({ els, on: (el, type, fn) => listeners.push([el, type, fn]), storage: stubStorage });
    controller.loadHotkey();
    const loaded = controller.getHotkey();
    const badgeAfterLoad = els.micHotkeyBadge.textContent;
    const realBefore = localStorage.getItem("voicebox-mic-hotkey");
    controller.setHotkey("k");
    const matches = [controller.matchesHotkey("k"), controller.matchesHotkey("K"), controller.matchesHotkey("q")];
    controller.toggleMic();
    const realAfter = localStorage.getItem("voicebox-mic-hotkey");
    return { loaded, badgeAfterLoad, written, realBefore, realAfter, matches, clicks: clicks.n, listeners: listeners.map(([, type]) => type) };
  });

  assert.equal(result.loaded, "J", "the injected store supplies the startup value (the module never reads the real one)");
  assert.equal(result.badgeAfterLoad, "J", "loading through the injected store must repaint the badge");
  assert.deepEqual(result.written, [["voicebox-mic-hotkey", "K"]], "setHotkey must write to the INJECTED store");
  assert.equal(result.realBefore, "V", "the page's real storage still holds what the page set earlier");
  assert.equal(result.realAfter, "V", "the standalone module must not have touched the page's real storage");
  assert.deepEqual(result.matches, [true, true, false], "the match is case-insensitive and follows the CURRENT value");
  assert.equal(result.clicks, 1, "toggleMic must click the mic once");
  assert.deepEqual(result.listeners, ["input", "keydown"], "the module attaches exactly the field's own two listeners");
});
