import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A new server/browser per test file, closed even when an assertion fails. The room's real
// Settings module is allowed to finish boot before observing the subsequent open requests.
test("gear, system command and dock share Settings modal/aria/device/agent/key refresh once per open", { timeout: 90000 }, async () => {
  const server = await startServer({ cwd: root, env: { VOICEBOX_WORKSPACE: undefined, VOICEBOX_INSTANCE: "settings-open-paths" } });
  let page;
  try {
    page = await launch({ width: 1000, height: 800 });
    await page.goto(server.base + "/");
    await page.waitFor(() => window.__voiceboxHotkey !== undefined && (document.getElementById("agent-provider-state")?.textContent ?? "Not asked yet") !== "Not asked yet", { label: "Settings wired and boot agent state loaded" });
    await page.evaluate(() => {
      const counts = { agent: 0, keys: 0, devices: 0 };
      window.__settingsOpenCounts = counts;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        const pathname = new URL(String(args[0]), location.href).pathname;
        if (pathname === "/api/agent-settings") counts.agent++;
        if (pathname === "/api/keys") counts.keys++;
        return originalFetch(...args);
      };
      if (navigator.mediaDevices?.enumerateDevices) {
        const originalEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
        navigator.mediaDevices.enumerateDevices = (...args) => { counts.devices++; return originalEnumerate(...args); };
      }
    });
    const evidence = process.env.SETTINGS_OPEN_EVIDENCE_DIR;
    if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot(path.join(evidence, "before.png")); }
    const routes = [
      ["gear", () => page.click("#settings-open")],
      ["system", () => page.evaluate(() => window.__voiceboxOnSystemCommand({ command: "open_panel", target: "settings" }))],
      // This dock control is hidden in the default room layout; dispatch its real DOM click
      // listener directly, rather than guessing screen coordinates for a hidden button.
      ["dock", () => page.evaluate(() => document.getElementById("sqeh-dock-settings").click())],
    ];
    for (const [name, open] of routes) {
      const before = await page.evaluate(() => {
        // Make a stale row visible before EACH route, so a GET/enumeration call alone is
        // insufficient: its real response must replace all three stale UI states.
        document.getElementById("mic-device-state").textContent = "Stale mic state";
        document.getElementById("agent-provider-state").textContent = "Stale agent state";
        document.getElementById("api-key-gemini-status").textContent = "Stale key state";
        return { ...window.__settingsOpenCounts };
      });
      await open();
      await page.waitFor((n) => {
        const c = window.__settingsOpenCounts;
        const d = document.getElementById("settings");
        return d?.open && d.matches(":modal") && document.getElementById("settings-open").getAttribute("aria-expanded") === "true"
          && c.agent === n.agent + 1 && c.keys === n.keys + 1 && c.devices === n.devices + 1
          && document.getElementById("mic-device-state").textContent !== "Stale mic state"
          && document.getElementById("agent-provider-state").textContent !== "Stale agent state"
          && document.getElementById("api-key-gemini-status").textContent !== "Stale key state";
      }, { args: [before], label: `${name} opens modal and applies three real refresh responses exactly once` });
      const state = await page.evaluate(() => ({
        modal: document.getElementById("settings").matches(":modal"),
        expanded: document.getElementById("settings-open").getAttribute("aria-expanded"),
        provider: document.getElementById("agent-provider-state").textContent,
        keyStatus: document.getElementById("api-key-gemini-status").textContent,
        activeInside: document.getElementById("settings").contains(document.activeElement),
        counts: { ...window.__settingsOpenCounts },
      }));
      assert.equal(state.modal, true);
      assert.equal(state.expanded, "true");
      assert.equal(state.activeInside, true);
      assert.notEqual(state.provider, "Not asked yet");
      assert.match(state.keyStatus, /Configured|Not configured/);
      if (evidence) {
        await page.screenshot(path.join(evidence, `${name}-open.png`));
        await page.evaluate(() => document.getElementById("api-key-gemini-status").scrollIntoView({ block: "center" }));
        await page.screenshot(path.join(evidence, `${name}-keys.png`));
      }
      // Calling the SAME entry a second time while already open must not attach a second
      // listener, fire another refresh, or throw showModal's already-open error.
      await open();
      assert.deepEqual(await page.evaluate(() => ({ ...window.__settingsOpenCounts })), state.counts, `${name} repeat-open must not refetch`);
      await page.press("Escape");
      await page.waitFor(() => !document.getElementById("settings").open
        && document.getElementById("settings-open").getAttribute("aria-expanded") === "false"
        && document.activeElement?.id === "settings-open", { label: `${name} Esc restores focus and aria` });
    }
  } finally { await page?.close(); await server.stop(); }
});
