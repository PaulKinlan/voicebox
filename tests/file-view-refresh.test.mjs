// tests/file-view-refresh.test.mjs — refresh button in file view to reload contents (voicebox-beads-d4s).
//
// Paul (2026-09-25): add a refresh button to the file view interface to reload the
// file contents. Visible, accessible, with loading/error states.
//
// What each check proves, driven over CDP in a real browser:
//   1. Initial state: #file-refresh is present, labelled, and disabled while no file is open.
//   2. Opening a file enables #file-refresh.
//   3. Changing the file on disk and clicking #file-refresh reloads the new content into #file-body.
//   4. Deleting the file on disk and clicking #file-refresh transitions to an error state
//      (data-error="true", error reason shown), and #file-refresh remains enabled for retries.
//   5. Re-creating the file and clicking #file-refresh recovers to ready state with new content.
//   6. Closing the reader disables #file-refresh and resets reader state.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let page;
let testDir;

test.before(async () => {
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_INSTANCE: "file-refresh-test" },
  });
  BASE = server.base;
  testDir = server.extensionsDir; // isolated scratch dir

  // Declare a root on the server so /api/file reads work
  const rootDir = path.join(testDir, "project-root");
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(path.join(rootDir, "test.txt"), "initial content v1");

  await fetch(`${BASE}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "refresh-test", root: { kind: "machine", path: rootDir } }),
  });

  page = await launch();
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.getElementById("file-refresh") !== null, { label: "the file-refresh button" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("initial state: #file-refresh is present and disabled when nothing is open", async () => {
  const initial = await page.evaluate(() => {
    const btn = document.getElementById("file-refresh");
    const reader = document.getElementById("reader");
    return {
      exists: Boolean(btn),
      disabled: btn?.disabled,
      ariaLabel: btn?.getAttribute("aria-label"),
      readerState: reader?.dataset.state,
    };
  });

  assert.equal(initial.exists, true, "#file-refresh button must exist in DOM");
  assert.equal(initial.disabled, true, "#file-refresh must be disabled when no file is open");
  assert.match(initial.ariaLabel ?? "", /Reload file contents|Refresh/i, "must have accessible aria-label");
  assert.equal(initial.readerState, "empty", "reader should start in empty state");
});

test("opening a file enables #file-refresh with initial content", async () => {
  // Click on the file in the file list to open it
  await page.waitFor(() => document.querySelector(".file-open") !== null, { label: "file list items" });
  await page.click(".file-open");
  await page.waitFor(() => document.getElementById("reader")?.dataset.state === "ready", { label: "reader ready" });

  const state = await page.evaluate(() => {
    const btn = document.getElementById("file-refresh");
    const body = document.getElementById("file-body");
    const reader = document.getElementById("reader");
    return {
      disabled: btn?.disabled,
      text: body?.textContent,
      error: reader?.dataset.error,
    };
  });

  assert.equal(state.disabled, false, "#file-refresh must be enabled when a file is open");
  assert.equal(state.text, "initial content v1", "file content should match disk");
  assert.equal(state.error, "false", "reader should not be in error state");
});

test("clicking #file-refresh reloads updated disk content", async () => {
  // Update file on disk
  const rootDir = path.join(testDir, "project-root");
  writeFileSync(path.join(rootDir, "test.txt"), "updated content v2 after reload");

  // Click #file-refresh
  await page.click("#file-refresh");
  await page.waitFor(() => document.getElementById("file-body")?.textContent === "updated content v2 after reload", {
    label: "reloaded content",
  });

  const state = await page.evaluate(() => {
    const btn = document.getElementById("file-refresh");
    const body = document.getElementById("file-body");
    const reader = document.getElementById("reader");
    return {
      disabled: btn?.disabled,
      busy: btn?.getAttribute("aria-busy"),
      text: body?.textContent,
      loading: reader?.dataset.loading,
      error: reader?.dataset.error,
    };
  });

  assert.equal(state.disabled, false, "#file-refresh should return to enabled");
  assert.equal(state.busy, null, "aria-busy should be cleared after reload");
  assert.equal(state.loading, "false", "data-loading should be false after reload");
  assert.equal(state.text, "updated content v2 after reload", "content should reflect disk update");
  assert.equal(state.error, "false", "reader should remain non-error");
});

test("deleting file on disk and reloading displays error state and keeps #file-refresh enabled", async () => {
  // Delete file on disk
  const rootDir = path.join(testDir, "project-root");
  unlinkSync(path.join(rootDir, "test.txt"));

  // Click #file-refresh
  await page.click("#file-refresh");
  await page.waitFor(() => document.getElementById("reader")?.dataset.error === "true", {
    label: "reader error state",
  });

  const state = await page.evaluate(() => {
    const btn = document.getElementById("file-refresh");
    const copy = document.getElementById("file-copy");
    const body = document.getElementById("file-body");
    const reader = document.getElementById("reader");
    return {
      refreshDisabled: btn?.disabled,
      copyDisabled: copy?.disabled,
      error: reader?.dataset.error,
      text: body?.textContent,
    };
  });

  assert.equal(state.refreshDisabled, false, "#file-refresh must stay enabled in error state to allow retry");
  assert.equal(state.copyDisabled, true, "#file-copy must be disabled when read failed");
  assert.equal(state.error, "true", "reader dataset.error must be true");
  assert.match(state.text ?? "", /not found|not in this project|could not read/i, "body should show failure reason");
});

test("recovering file on disk and clicking #file-refresh clears error state", async () => {
  // Recreate file on disk
  const rootDir = path.join(testDir, "project-root");
  writeFileSync(path.join(rootDir, "test.txt"), "recovered content v3");

  // Click #file-refresh to retry
  await page.click("#file-refresh");
  await page.waitFor(() => document.getElementById("file-body")?.textContent === "recovered content v3", {
    label: "recovered content",
  });

  const state = await page.evaluate(() => {
    const btn = document.getElementById("file-refresh");
    const reader = document.getElementById("reader");
    return {
      disabled: btn?.disabled,
      error: reader?.dataset.error,
    };
  });

  assert.equal(state.disabled, false);
  assert.equal(state.error, "false", "error state must clear on successful reload");
});

test("closing the file resets reader and disables #file-refresh", async () => {
  await page.click("#reader-close");
  await page.waitFor(() => document.getElementById("reader")?.dataset.state === "empty", { label: "reader empty" });

  const state = await page.evaluate(() => {
    const btn = document.getElementById("file-refresh");
    const reader = document.getElementById("reader");
    return {
      disabled: btn?.disabled,
      state: reader?.dataset.state,
    };
  });

  assert.equal(state.disabled, true, "#file-refresh must be disabled after reader is closed");
  assert.equal(state.state, "empty");
});
