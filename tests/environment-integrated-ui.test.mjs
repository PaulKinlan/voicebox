// tests/environment-integrated-ui.test.mjs — voicebox-beads-dnwa:
// UX: integrate environment and workspace root configuration into main UI.
//
// Paul verbatim: "a little while ago I asked us not to have that environments page a separate page.
// It should just be kind of integrated into the main UI."
//
// ACCEPTANCE:
// Environment configuration accessible and usable within main UI without visiting separate environments page.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
let BASE;
let scratch;
let testRoot;
let page;

test.before(async () => {
  scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-env-integrated-")));
  testRoot = path.join(scratch, "sample-project");
  mkdirSync(testRoot);
  server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: undefined,
      VOICEBOX_SANDBOX_HOMES: undefined,
      VOICEBOX_INSTANCE: "env-integrated-test",
    },
    cwd: scratch,
  });
  BASE = server.base;
  page = await launch({ width: 1280, height: 900 });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("integrated environment flow: configure machine root and browser workspace in main UI dialog without navigating away", { timeout: 60000 }, async () => {
  await page.goto(`${BASE}/`);

  // Wait for main UI to load
  await page.waitFor(() => document.getElementById("root-kind") && document.getElementById("envs-open"), {
    label: "the main room UI",
  });

  // Verify initial state: no root declared
  const initialRoot = await page.evaluate(() => document.getElementById("root-kind")?.textContent?.trim() ?? "");
  assert.equal(initialRoot, "no folder chosen yet");

  // Verify in-room button to configure environment exists in empty state and is visible
  await page.waitFor(() => document.getElementById("configure-env-btn"), {
    label: "configure environment button in room",
  });

  // 1. Open the environments dialog from within the main UI
  await page.click("#configure-env-btn");
  await page.waitFor(() => document.getElementById("envs")?.hasAttribute("open"), {
    label: "environments modal dialog to open",
  });

  // Verify active root status inside dialog
  const dialogRootBefore = await page.evaluate(() => document.getElementById("env-active-root-val")?.textContent?.trim() ?? "");
  assert.equal(dialogRootBefore, "no folder chosen yet");

  // 2. Set machine root using the integrated input and button
  await page.evaluate((dirPath) => {
    const input = document.getElementById("env-root-path-input");
    input.value = dirPath;
  }, testRoot);

  await page.click("#env-declare-root-btn");

  // Wait for status message in dialog
  await page.waitFor(
    () => {
      const status = document.getElementById("env-root-status")?.textContent ?? "";
      return status.includes("Machine root set to") || status.includes("turns save here now");
    },
    { label: "machine root declaration status" },
  );

  // Assert active root in dialog reflects the new root
  const dialogRootAfter = await page.evaluate(() => document.getElementById("env-active-root-val")?.textContent?.trim() ?? "");
  assert.ok(dialogRootAfter.includes("sample-project"), `dialog root should show sample-project, got: ${dialogRootAfter}`);

  // Close the dialog using Close button
  await page.click("#envs-close");
  await page.waitFor(() => !document.getElementById("envs")?.hasAttribute("open"), {
    label: "environments modal to close",
  });

  // Assert main room header chip updated immediately to reflect machine folder
  await page.waitFor(
    () => {
      const text = document.getElementById("root-kind")?.textContent ?? "";
      return text.includes("machine folder") && text.includes("sample-project");
    },
    { label: "header chip to update to machine folder" },
  );

  // 3. Re-open via header button and switch to browser workspace (OPFS)
  await page.click("#envs-open");
  await page.waitFor(() => document.getElementById("envs")?.hasAttribute("open"), {
    label: "environments modal to re-open",
  });

  await page.click("#env-use-browser-btn");

  await page.waitFor(
    () => {
      const status = document.getElementById("env-root-status")?.textContent ?? "";
      return status.includes("browser storage");
    },
    { label: "browser storage switch status" },
  );

  const dialogRootOpfs = await page.evaluate(() => document.getElementById("env-active-root-val")?.textContent?.trim() ?? "");
  assert.ok(dialogRootOpfs.includes("browser storage"), `dialog root should show browser storage, got: ${dialogRootOpfs}`);

  await page.click("#envs-close");

  // Assert header chip updated to browser storage
  await page.waitFor(
    () => {
      const text = document.getElementById("root-kind")?.textContent ?? "";
      return text.includes("browser storage");
    },
    { label: "header chip to update to browser storage" },
  );

  // 4. Assert URL stayed on main UI throughout the entire flow (no separate page visited)
  const currentPath = await page.evaluate(() => location.pathname);
  assert.equal(currentPath, "/", "user remained strictly on the main UI root without visiting separate environment.html");
});
