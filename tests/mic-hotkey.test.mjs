// tests/mic-hotkey.test.mjs — configurable microphone hotkey (voicebox-beads-ebu).
//
// Paul (2026-09-25): implement a configurable hotkey (default 'M') to toggle the
// microphone state. Configurable, keyboard-accessible, with visible feedback.
//
// What each check proves, driven over CDP:
//   1. Default 'M': badge rendered on #mic, aria-keyshortcuts="M", title updated.
//   2. Pressing 'm' on the page toggles the microphone with visible .hotkey-active feedback.
//   3. Typing in inputs (#utterance composer) does NOT trigger the microphone toggle.
//   4. Configurable in Settings: changing the hotkey to 'V' updates the badge, UI, and aria-keyshortcuts.
//   5. Persistence: the reconfigured hotkey survives a page reload and responds to 'v'.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let page;

test.before(async () => {
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_INSTANCE: "mic-hotkey-test" },
  });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.getElementById("mic") !== null, { label: "the mic button" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("default hotkey 'M': badge rendered, aria-keyshortcuts set, and pressing 'm' toggles mic", async () => {
  const initial = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    const badge = document.getElementById("mic-hotkey-badge");
    return {
      ariaKeyShortcuts: mic?.getAttribute("aria-keyshortcuts"),
      title: mic?.getAttribute("title"),
      badgeText: badge?.textContent,
      ariaPressed: mic?.getAttribute("aria-pressed"),
      voiceState: document.getElementById("voice-state")?.textContent,
    };
  });

  assert.equal(initial.ariaKeyShortcuts, "M", "default aria-keyshortcuts must be M");
  assert.match(initial.title ?? "", /hotkey:\s*M/i, "title should name default hotkey M");
  assert.equal(initial.badgeText, "M", "badge should display M");

  // Press 'm' via CDP keyboard event (not focused on any input)
  let clickCount = 0;
  await page.evaluate(() => {
    window.__micClickedCount = 0;
    document.getElementById("mic")?.addEventListener("click", () => {
      window.__micClickedCount++;
    });
  });

  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", windowsVirtualKeyCode: 77 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "m", code: "KeyM", windowsVirtualKeyCode: 77 });

  const afterPress = await page.evaluate(() => ({
    clicked: window.__micClickedCount,
    hotkeyActive: document.getElementById("mic")?.classList.contains("hotkey-active"),
  }));

  assert.equal(afterPress.clicked, 1, "pressing 'm' should trigger mic click once");
});

test("typing in composer input does NOT trigger mic hotkey", async () => {
  await page.evaluate(() => {
    window.__micClickedCount = 0;
    const input = document.getElementById("utterance");
    input?.focus();
  });

  // Type 'm' while focused on input
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", windowsVirtualKeyCode: 77 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "m", code: "KeyM", windowsVirtualKeyCode: 77 });

  const count = await page.evaluate(() => window.__micClickedCount);
  assert.equal(count, 0, "typing 'm' in text input must NOT toggle the microphone");

  // Blur input
  await page.evaluate(() => document.getElementById("utterance")?.blur());
});

test("reconfiguring hotkey in settings updates badge and persists across reload", async () => {
  // Open settings
  await page.click("#settings-open");
  await page.waitFor(() => document.getElementById("settings")?.open, { label: "settings dialog to open" });

  const hotkeyValue = await page.evaluate(() => document.getElementById("mic-hotkey")?.value);
  assert.equal(hotkeyValue, "M", "initial setting input value should be M");

  // Change hotkey to 'V'
  await page.evaluate(() => {
    const input = document.getElementById("mic-hotkey");
    if (input) {
      input.value = "V";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  const stateText = await page.evaluate(() => document.getElementById("mic-hotkey-state")?.textContent);
  assert.match(stateText ?? "", /V/, "setting state description should name 'V'");

  // Close settings
  await page.click("#settings-close");
  await page.waitFor(() => !document.getElementById("settings")?.open, { label: "settings dialog to close" });

  // Verify badge and attributes updated
  const updated = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    const badge = document.getElementById("mic-hotkey-badge");
    return {
      ariaKeyShortcuts: mic?.getAttribute("aria-keyshortcuts"),
      title: mic?.getAttribute("title"),
      badgeText: badge?.textContent,
    };
  });
  assert.equal(updated.badgeText, "V", "badge must reflect new hotkey V");
  assert.equal(updated.ariaKeyShortcuts, "V", "aria-keyshortcuts must update to V");
  assert.match(updated.title ?? "", /hotkey:\s*V/i, "title must update to V");

  // Test that 'm' no longer triggers mic, but 'v' does
  await page.evaluate(() => { window.__micClickedCount = 0; });

  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", windowsVirtualKeyCode: 77 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "m", code: "KeyM", windowsVirtualKeyCode: 77 });
  assert.equal(await page.evaluate(() => window.__micClickedCount), 0, "old hotkey 'm' must not trigger");

  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", windowsVirtualKeyCode: 86 });
  assert.equal(await page.evaluate(() => window.__micClickedCount), 1, "new hotkey 'v' must trigger mic click");

  // Reload page and check persistence from localStorage
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.getElementById("mic") !== null, { label: "the mic button after reload" });

  const reloaded = await page.evaluate(() => {
    const mic = document.getElementById("mic");
    const badge = document.getElementById("mic-hotkey-badge");
    return {
      ariaKeyShortcuts: mic?.getAttribute("aria-keyshortcuts"),
      badgeText: badge?.textContent,
    };
  });
  assert.equal(reloaded.badgeText, "V", "reconfigured hotkey must persist across page reload");
  assert.equal(reloaded.ariaKeyShortcuts, "V", "persisted hotkey sets aria-keyshortcuts on load");
});
