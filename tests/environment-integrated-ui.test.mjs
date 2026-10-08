// tests/environment-integrated-ui.test.mjs — voicebox-beads-dnwa:
// UX: integrate environment and workspace root configuration into main UI.
//
// Paul verbatim: "a little while ago I asked us not to have that environments page a separate page.
// It should just be kind of integrated into the main UI."
//
// ACCEPTANCE:
// Environment configuration accessible and usable within main UI without visiting separate environments page.
// Drives real file creation & reading in both configured machine root and browser storage workspace.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
let BASE;
let scratch;
let testRoot;
let page;

const say = (page, said) =>
  page.evaluate(async (text) => {
    const until = async (label, ready, ms = 25000) => {
      const deadline = Date.now() + ms;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    const input = document.getElementById("utterance");
    input.value = text;
    document.getElementById("text-form").requestSubmit();
    await until(`the turn “${text}” to settle`, () =>
      (document.querySelector("#session-log li .said")?.textContent ?? "").includes(text) &&
      document.getElementById("send")?.textContent === "Send");
    return {
      line: document.querySelector("#session-log li .did")?.textContent ?? "",
      cards: [...document.querySelectorAll("#files .file-open")].map((b) => b.dataset.file),
    };
  }, said);

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

test("integrated environment flow: configure machine root and browser workspace in main UI dialog without navigating away", { timeout: 90000 }, async () => {
  await page.goto(`${BASE}/`);

  // Wait for main UI to load and initial root check to settle
  await page.waitFor(
    () => {
      const text = document.getElementById("root-kind")?.textContent?.trim() ?? "";
      return text !== "" && text !== "checking which root…" && text !== "folder not reported";
    },
    { label: "initial root check to settle" },
  );

  // Verify initial state: no root declared
  const initialRoot = await page.evaluate(() => document.getElementById("root-kind")?.textContent?.trim() ?? "");
  assert.equal(initialRoot, "no folder chosen yet");

  // Verify in-room button to configure environment exists in empty state and is visible
  await page.waitFor(() => document.getElementById("empty-link"), {
    label: "configure workspace button in room",
  });

  // 1. Open the environments dialog from within the main UI via #empty-link
  await page.click("#empty-link");
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

  // 3. Perform a real file write turn into the configured machine root
  const machineTurn = await say(page, "create file machine-note.txt with hello-from-machine");
  assert.ok(machineTurn.cards.includes("machine-note.txt"), "machine-note.txt appears in files list");
  assert.equal(
    readFileSync(path.join(testRoot, "machine-note.txt"), "utf8"),
    "hello-from-machine",
    "file was written directly to the declared machine directory on disk",
  );

  // 4. Re-open via header button and switch to browser workspace (OPFS)
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

  // 5. Perform a real file write turn into browser storage (OPFS)
  const opfsTurn = await say(page, "create file opfs-note.txt with hello-from-opfs");
  assert.ok(opfsTurn.cards.includes("opfs-note.txt"), "opfs-note.txt appears in browser storage files list");

  // 6. Switch back to machine root and reload: verify machine root survives reload
  await page.click("#envs-open");
  await page.waitFor(() => document.getElementById("envs")?.hasAttribute("open"));
  await page.evaluate((dirPath) => {
    document.getElementById("env-root-path-input").value = dirPath;
  }, testRoot);
  await page.click("#env-declare-root-btn");
  await page.waitFor(() => {
    const status = document.getElementById("env-root-status")?.textContent ?? "";
    return status.includes("Machine root set to");
  });
  await page.click("#envs-close");
  await page.waitFor(() => !document.getElementById("envs")?.hasAttribute("open"));

  // Reload page
  await page.reload();
  await page.waitFor(() => document.getElementById("root-kind"));
  const reloadedRoot = await page.evaluate(() => document.getElementById("root-kind")?.textContent ?? "");
  assert.ok(
    reloadedRoot.includes("machine folder") && reloadedRoot.includes("sample-project"),
    `machine root selection survives reload even with persisted browser folders, got: ${reloadedRoot}`,
  );

  // 7. Assert URL stayed on main UI throughout the entire flow (no separate page visited)
  const currentPath = await page.evaluate(() => location.pathname);
  assert.equal(currentPath, "/", "user remained strictly on the main UI root without visiting separate environment.html");
});
