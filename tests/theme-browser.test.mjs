// tests/theme-browser.test.mjs — the theme preference module, driven in a real browser.
//
// voicebox-beads-ri9x (first slice of voicebox-beads-mvxl) moved the theme block out of fused.js into
// public/theme.mjs. That move is only safe if the behaviours the block owned still happen in a page,
// so this file drives them instead of asserting them in prose: the tri-state model, the two controls
// that change it, the system-scheme listener, and — the path that only a RELOAD can exercise — the
// stored preference being re-applied at boot. That last one is why this file exists at all:
// tests/ux-bubble-stage.test.mjs already drives the settings select and reads localStorage, but
// nothing ever reloaded with a stored value, so the boot read (the highest-risk thing this extraction
// moved, because it runs on every page load) had no cover.
//
// NOT driven here, deliberately: the system-command path (executeBrowserSystemCommand with
// switch_theme). That path is broken independently of this extraction — see voicebox-beads-ucak,
// where the producer emits `mode` and the client guards on `theme` — so asserting it here would make
// this file red for a reason that is not this bead's. It belongs with ucak's fix.
//
//   node --test tests/theme-browser.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("theme preference: defaults light, both controls persist, a reload restores, and system follows the OS", { timeout: 90000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-theme-"));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\n", "utf8");

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_SANDBOX_HOMES: path.join(scratch, "sandbox-homes"),
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const rootRes = await fetch(`${server.base}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "theme-browser-test", root: { kind: "machine", path: workspace } }),
  });
  assert.equal(rootRes.ok, true, "declared workspace root");

  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.getElementById("theme-toggle") !== null && document.documentElement.dataset.theme !== undefined, {
    label: "the page booted and the theme was applied",
  });

  const read = () =>
    page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.themeMode,
      stored: localStorage.getItem("voicebox:theme"),
      stateText: document.getElementById("theme-select-state")?.textContent?.trim() ?? null,
      toggleAria: document.getElementById("theme-toggle")?.getAttribute("aria-pressed") ?? null,
      toggleLabel: document.getElementById("theme-toggle")?.getAttribute("aria-label") ?? null,
      toggleIcon: document.getElementById("theme-toggle")?.querySelector("use")?.getAttribute("href") ?? null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    }));

  // ── 1. A fresh profile is light, and nothing is stored yet ───────────────────────────────────
  const initial = await read();
  assert.equal(initial.theme, "light", "a first visit is light");
  assert.equal(initial.mode, "light", "a first visit records the light preference, not 'system'");
  assert.equal(initial.stored, null, "a first visit stores nothing");
  assert.equal(initial.toggleIcon, "#i-moon", "light mode offers the moon, i.e. 'switch to dark mode'");
  assert.equal(initial.toggleAria, "false", "the toggle reports itself not pressed in light mode");

  // ── 2. The settings select persists a choice ────────────────────────────────────────────────
  await page.evaluate(() => {
    const select = document.getElementById("theme-select");
    select.value = "dark";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const dark = await read();
  assert.equal(dark.theme, "dark", "selecting dark applies dark");
  assert.equal(dark.mode, "dark", "selecting dark records the dark preference");
  assert.equal(dark.stored, "dark", "selecting dark persists it");
  assert.equal(dark.stateText, "Dark mode", "the state label follows the select");
  assert.equal(dark.toggleIcon, "#i-sun", "dark mode offers the sun, i.e. 'switch to light mode'");
  assert.equal(dark.toggleAria, "true", "the toggle reports itself pressed in dark mode");
  assert.notEqual(dark.bodyBg, initial.bodyBg, "the page actually repainted, not just the attribute");

  // ── 3. A RELOAD re-applies the stored choice (the boot read this extraction moved) ──────────
  await page.reload();
  await page.waitFor(() => document.getElementById("theme-select")?.value !== undefined, { label: "reloaded" });
  const afterReload = await read();
  assert.equal(afterReload.stored, "dark", "the stored choice survived the reload");
  assert.equal(afterReload.theme, "dark", "the reload re-applied the stored theme — this is the boot read");
  assert.equal(afterReload.mode, "dark", "the reload re-applied the stored preference");
  assert.equal(afterReload.toggleIcon, "#i-sun", "the controls are re-synced to the restored theme");
  assert.equal(afterReload.bodyBg, dark.bodyBg, "the restored theme is the same paint as before the reload");

  // ── 4. The toggle button flips and persists (driven directly: it is hidden in the top header) ─
  await page.evaluate(() => document.getElementById("theme-toggle").click());
  const toggled = await read();
  assert.equal(toggled.theme, "light", "clicking the toggle while dark switches to light");
  assert.equal(toggled.mode, "light", "the toggle records the light preference");
  assert.equal(toggled.stored, "light", "the toggle persists its choice");
  assert.equal(toggled.toggleAria, "false", "the toggle reports itself not pressed after the flip");

  await page.evaluate(() => document.getElementById("theme-toggle").click());
  const toggledBack = await read();
  assert.equal(toggledBack.theme, "dark", "clicking again returns to dark");
  assert.equal(toggledBack.stored, "dark", "the second flip persists too");

  // ── 5. System mode follows the OS, and keeps following it ───────────────────────────────────
  await page.evaluate(() => {
    const select = document.getElementById("theme-select");
    select.value = "system";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const systemLight = await read();
  assert.equal(systemLight.mode, "system", "selecting system records the system preference");
  assert.equal(systemLight.stored, "system", "system is persisted as its own state, not deleted");

  // Drive the OS scheme the way a person's evening would: the media feature, in the real browser.
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await page.waitFor(() => document.documentElement.dataset.theme === "dark", { label: "system mode followed prefers-color-scheme: dark" });
  const systemDark = await read();
  assert.equal(systemDark.mode, "system", "the preference is STILL system — the OS moved, the choice did not");
  assert.equal(systemDark.stored, "system", "following the OS does not rewrite the stored preference");

  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page.waitFor(() => document.documentElement.dataset.theme === "light", { label: "system mode followed prefers-color-scheme: light" });
  const systemBack = await read();
  assert.equal(systemBack.mode, "system", "still system after the OS went back");
  assert.notEqual(systemDark.bodyBg, systemBack.bodyBg, "the two system states really paint differently");
});
