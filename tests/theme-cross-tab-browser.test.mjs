// Cross-tab theme preference is an observable page behavior, not a storage-only assertion.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const snapshot = `({
  mode: document.documentElement.dataset.themeMode,
  theme: document.documentElement.dataset.theme,
  select: document.querySelector('#theme-select')?.value,
  state: document.querySelector('#theme-select-state')?.textContent.trim(),
  label: document.querySelector('#theme-toggle')?.getAttribute('aria-label'),
  pressed: document.querySelector('#theme-toggle')?.getAttribute('aria-pressed'),
  icon: document.querySelector('#theme-toggle use')?.getAttribute('href'),
  bg: getComputedStyle(document.body).backgroundColor,
  stored: localStorage.getItem('voicebox:theme'),
  echoes: window.__themeEchoes ?? 0,
  storageEvents: window.__themeEvents ?? 0,
})`;

test("theme: a second real tab follows choice, OS, removal and poisoned storage without echo", { timeout: 90000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-theme-tabs-"));
  const workspace = path.join(scratch, "workspace");
  fs.mkdirSync(workspace);
  const server = await startServer({ env: {
    VOICEBOX_WORKSPACE: workspace,
    VOICEBOX_RESOLVER: "script",
    VOICEBOX_SANDBOX_HOMES: path.join(scratch, "homes"),
  } });
  t.after(async () => { await server.stop(); fs.rmSync(scratch, { recursive: true, force: true }); });
  const rootRes = await fetch(`${server.base}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "theme-tabs", root: { kind: "machine", path: workspace } }),
  });
  assert.equal(rootRes.ok, true);

  const a = await launch({ width: 1100, height: 800 });
  t.after(() => a.close());
  await a.goto(`${server.base}/`);
  await a.waitFor(() => document.querySelector("#theme-select")?.value === "light", { label: "tab A loaded" });
  const { targetId } = await a.sendBrowser("Target.createTarget", { url: "about:blank" });
  const { sessionId: bId } = await a.sendBrowser("Target.attachToTarget", { targetId, flatten: true });
  await Promise.all([a.sendTo(bId, "Page.enable", {}), a.sendTo(bId, "Runtime.enable", {})]);
  await a.sendTo(bId, "Page.navigate", { url: `${server.base}/` });
  const b = async (expression) => {
    const result = await a.sendTo(bId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, `tab B evaluation: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  const untilB = (predicate) => b(`new Promise((resolve, reject) => {
    // A CROSS-TAB BROADCAST IS A MESSAGE-HOP, NOT A CPU COMPUTATION (voicebox-beads-i9k0): 6s was enough
    // on a quiet box and not enough at load 12, where this failed the 2026-10-28 00:14 full gate with
    // 'tab B did not reach #theme-select === light' while the same tree passed standalone.
    const end = Date.now() + 30000;
    const timer = setInterval(() => {
      if (${predicate}) { clearInterval(timer); resolve(${snapshot}); }
      else if (Date.now() > end) { clearInterval(timer); reject(Error(${JSON.stringify('tab B did not reach: ' + predicate)})); }
    }, 25);
  })`);
  await untilB("document.querySelector('#theme-select')?.value === 'light'");
  await b(`(() => {
    window.__themeEchoes = 0; window.__themeEvents = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && key === 'voicebox:theme') window.__themeEchoes++;
      return original.call(this, key, value);
    };
    addEventListener('storage', (e) => { if (e.key === 'voicebox:theme') window.__themeEvents++; });
  })()`);
  await a.evaluate(() => { window.__themeEvents = 0; addEventListener("storage", () => window.__themeEvents++); });
  const light = await b(snapshot);
  await a.evaluate(() => {
    const select = document.querySelector("#theme-select");
    select.value = "dark";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const dark = await untilB("document.documentElement.dataset.themeMode === 'dark'");
  assert.equal(dark.theme, "dark");
  assert.equal(dark.select, "dark");
  assert.equal(dark.state, "Dark mode");
  assert.equal(dark.pressed, "true");
  assert.equal(dark.icon, "#i-sun");
  assert.equal(dark.label, "Switch to light mode");
  assert.notEqual(dark.bg, light.bg, "tab B visibly repainted without reload");
  assert.equal(dark.echoes, 0, "receiving tab does not write the choice back");
  assert.equal(dark.storageEvents, 1);
  assert.equal(await a.evaluate(() => window.__themeEvents), 0, "writer does not receive its own storage event");
  await fs.promises.writeFile("/tmp/audioflake-vtf3-tab-b-dark.png", Buffer.from((await a.sendTo(bId, "Page.captureScreenshot", { format: "png" })).data, "base64"));

  await a.evaluate(() => { const s = document.querySelector("#theme-select"); s.value = "light"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  const restored = await untilB("document.documentElement.dataset.themeMode === 'light'");
  assert.equal(restored.bg, light.bg);
  await a.evaluate(() => { const s = document.querySelector("#theme-select"); s.value = "system"; s.dispatchEvent(new Event("change", { bubbles: true })); });
  const systemLight = await untilB("document.documentElement.dataset.themeMode === 'system'");
  assert.equal(systemLight.stored, "system", "system remains pinned in storage");
  await a.sendTo(bId, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  const systemDark = await untilB("document.documentElement.dataset.theme === 'dark'");
  assert.equal(systemDark.mode, "system");
  assert.notEqual(systemDark.bg, systemLight.bg);
  assert.equal(systemDark.echoes, 0);
  await fs.promises.writeFile("/tmp/audioflake-vtf3-tab-b-system-dark.png", Buffer.from((await a.sendTo(bId, "Page.captureScreenshot", { format: "png" })).data, "base64"));

  await a.evaluate(() => localStorage.setItem("unrelated", "ok"));
  assert.equal((await b(snapshot)).mode, "system", "unrelated key ignored");
  await a.evaluate(() => sessionStorage.setItem("voicebox:theme", "light"));
  assert.equal((await b(snapshot)).mode, "system", "sessionStorage does not affect tab B");
  await a.evaluate(() => localStorage.setItem("voicebox:theme", "poisoned"));
  const invalid = await untilB("document.documentElement.dataset.themeMode === 'light'");
  assert.equal(invalid.theme, "light", "invalid value resolves to site light default despite dark OS");
  assert.equal(invalid.stored, "poisoned", "recipient does not rewrite invalid storage");
  assert.equal(invalid.echoes, 0);
  await a.evaluate(() => localStorage.setItem("voicebox:theme", "dark"));
  await untilB("document.documentElement.dataset.themeMode === 'dark'");
  await a.evaluate(() => localStorage.removeItem("voicebox:theme"));
  const removed = await untilB("document.documentElement.dataset.themeMode === 'light'");
  assert.equal(removed.stored, null);
  assert.equal(removed.echoes, 0);
  await a.evaluate(() => localStorage.setItem("voicebox:theme", "dark"));
  await untilB("document.documentElement.dataset.themeMode === 'dark'");
  await a.evaluate(() => localStorage.clear());
  const cleared = await untilB("document.documentElement.dataset.themeMode === 'light'");
  assert.equal(cleared.stored, null);
  assert.equal(cleared.echoes, 0);

  // Help boots the SAME module without controls; its page must follow the room after navigation.
  await a.sendTo(bId, "Page.navigate", { url: `${server.base}/help.html` });
  await untilB("document.querySelector('.help-page') && document.documentElement.dataset.themeMode === 'light'");
  const helpLight = await b("getComputedStyle(document.documentElement).colorScheme");
  await a.evaluate(() => { const s = document.querySelector('#theme-select'); s.value = 'dark'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  const helpDark = await untilB("document.documentElement.dataset.themeMode === 'dark'");
  assert.equal(helpDark.theme, "dark", "Help follows without reload via shared initTheme");
  assert.notEqual(await b("getComputedStyle(document.documentElement).colorScheme"), helpLight, "Help native surfaces follow dark mode");
  await fs.promises.writeFile("/tmp/audioflake-vtf3-help-dark.png", Buffer.from((await a.sendTo(bId, "Page.captureScreenshot", { format: "png" })).data, "base64"));
});
