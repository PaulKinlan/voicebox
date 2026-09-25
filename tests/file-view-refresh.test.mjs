// tests/file-view-refresh.test.mjs — refresh button in file view to reload contents (voicebox-beads-d4s).
//
// Paul (2026-09-25): add a refresh button to the file view interface to reload the
// file contents. Visible, accessible, with loading/error states.
//
// What each check proves, driven over CDP in a real browser:
//   1. Initial state: #file-refresh is present, labelled, and disabled when empty; #file-facts is live region.
//   2. Opening a file enables #file-refresh.
//   3. In-flight loading state: button disabled, aria-busy='true', 'Reloading…' text, reader loading state.
//   4. Close during load: late response does NOT re-open the closed reader.
//   5. Switch file during load: opening another file is not overwritten by an earlier in-flight response.
//   6. Changing the file on disk and clicking #file-refresh reloads the new content into #file-body.
//   7. Deleting the file on disk and clicking #file-refresh transitions to an error state
//      (data-error="true", error reason shown), and #file-refresh remains enabled for retries.
//   8. Re-creating the file and clicking #file-refresh clears error state and restores content.
//   9. Closing the reader disables #file-refresh and resets reader state.

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
  testDir = server.extensionsDir;

  const rootDir = path.join(testDir, "project-root");
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(path.join(rootDir, "test.txt"), "initial content v1");
  writeFileSync(path.join(rootDir, "other.txt"), "other file content");

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

test("initial state: #file-refresh is present and disabled when nothing is open; #file-facts is live region", async () => {
  const initial = await page.evaluate(() => {
    const btn = document.getElementById("file-refresh");
    const reader = document.getElementById("reader");
    const facts = document.getElementById("file-facts");
    return {
      exists: Boolean(btn),
      disabled: btn?.disabled,
      ariaLabel: btn?.getAttribute("aria-label"),
      readerState: reader?.dataset.state,
      factsRole: facts?.getAttribute("role"),
      factsLive: facts?.getAttribute("aria-live"),
    };
  });

  assert.equal(initial.exists, true, "#file-refresh button must exist in DOM");
  assert.equal(initial.disabled, true, "#file-refresh must be disabled when no file is open");
  assert.match(initial.ariaLabel ?? "", /Reload file contents|Refresh/i, "must have accessible aria-label");
  assert.equal(initial.readerState, "empty", "reader should start in empty state");
  assert.equal(initial.factsRole, "status", "file-facts must have role=status for live announcements");
  assert.equal(initial.factsLive, "polite", "file-facts must have aria-live=polite");
});

test("opening a file enables #file-refresh with initial content", async () => {
  await page.waitFor(() => document.querySelector(".file-open") !== null, { label: "file list items" });
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".file-open")];
    rows.find((b) => b.textContent.includes("test.txt"))?.click();
  });
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

test("in-flight loading state is observable and disables the button", async () => {
  // Delay /api/file requests in page to inspect the in-flight state
  await page.evaluate(() => {
    window.__realFetch = window.__realFetch ?? window.fetch.bind(window);
    window.__inFlightCount = 0;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/file")) {
        window.__inFlightCount++;
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            window.__inFlightCount--;
            window.__realFetch(input, init).then(resolve, reject);
          }, 350);
        });
      }
      return window.__realFetch(input, init);
    };
  });

  // Trigger reload
  await page.evaluate(() => document.getElementById("file-refresh")?.click());

  // Check state while request is in flight
  const loadingState = await page.evaluate(() => {
    const btn = document.getElementById("file-refresh");
    const reader = document.getElementById("reader");
    const facts = document.getElementById("file-facts");
    return {
      inFlight: window.__inFlightCount,
      disabled: btn?.disabled,
      busy: btn?.getAttribute("aria-busy"),
      text: btn?.textContent,
      readerLoading: reader?.dataset.loading,
      factsText: facts?.textContent,
    };
  });

  assert.equal(loadingState.disabled, true, "button must be disabled while reload is in flight");
  assert.equal(loadingState.busy, "true", "aria-busy must be true while in flight");
  assert.equal(loadingState.text, "Reloading…", "button text must show Reloading… while in flight");
  assert.equal(loadingState.readerLoading, "true", "reader dataset.loading must be true while in flight");
  assert.equal(loadingState.factsText, "Reloading…", "facts line must announce Reloading… to live region");

  // Wait for settlement
  await page.waitFor(() => document.getElementById("file-refresh")?.getAttribute("aria-busy") === null, {
    label: "reload to settle",
  });

  const settledState = await page.evaluate(() => {
    const btn = document.getElementById("file-refresh");
    const reader = document.getElementById("reader");
    return {
      disabled: btn?.disabled,
      busy: btn?.getAttribute("aria-busy"),
      text: btn?.textContent,
      readerLoading: reader?.dataset.loading,
    };
  });

  assert.equal(settledState.disabled, false, "button must be re-enabled after settlement");
  assert.equal(settledState.busy, null, "aria-busy must be removed after settlement");
  assert.equal(settledState.text, "Reload", "button text must revert to Reload");
  assert.equal(settledState.readerLoading, "false", "reader dataset.loading must be false after settlement");
});

test("close during load does not re-open the reader on late response", async () => {
  // Trigger slow reload
  await page.evaluate(() => document.getElementById("file-refresh")?.click());
  // Immediately close reader while reload is in flight
  await page.evaluate(() => document.getElementById("reader-close")?.click());

  const immediately = await page.evaluate(() => ({
    readerState: document.getElementById("reader")?.dataset.state,
    refreshDisabled: document.getElementById("file-refresh")?.disabled,
  }));
  assert.equal(immediately.readerState, "empty");
  assert.equal(immediately.refreshDisabled, true);

  // Wait for late response to arrive
  await new Promise((r) => setTimeout(r, 600));

  const afterLateResponse = await page.evaluate(() => ({
    readerState: document.getElementById("reader")?.dataset.state,
    bodyText: document.getElementById("file-body")?.textContent,
    refreshDisabled: document.getElementById("file-refresh")?.disabled,
  }));

  assert.equal(afterLateResponse.readerState, "empty", "late response must NOT re-open the closed reader");
  assert.equal(afterLateResponse.bodyText, "", "body must remain empty");
  assert.equal(afterLateResponse.refreshDisabled, true);
});

test("switch file during load does not overwrite newer selection", async () => {
  // Re-open first file (test.txt)
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".file-open")];
    buttons.find((b) => b.textContent.includes("test.txt"))?.click();
  });
  await page.waitFor(() => document.getElementById("reader")?.dataset.state === "ready");

  // Trigger reload on test.txt
  await page.evaluate(() => document.getElementById("file-refresh")?.click());

  // Immediately switch to other.txt
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".file-open")];
    buttons.find((b) => b.textContent.includes("other.txt"))?.click();
  });

  // Wait for all in-flight requests to settle
  await new Promise((r) => setTimeout(r, 800));

  const current = await page.evaluate(() => ({
    title: document.getElementById("reader-title")?.textContent,
    body: document.getElementById("file-body")?.textContent,
  }));

  assert.equal(current.title, "other.txt", "title must remain other.txt");
  assert.equal(current.body, "other file content", "content must remain other.txt content and not be overwritten");

  // Restore the original fetch
  await page.evaluate(() => {
    if (window.__realFetch) {
      window.fetch = window.__realFetch;
      delete window.__realFetch;
      delete window.__inFlightCount;
    }
  });
});

test("clicking #file-refresh reloads updated disk content", async () => {
  // Switch back to test.txt
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".file-open")];
    buttons.find((b) => b.textContent.includes("test.txt"))?.click();
  });
  await page.waitFor(() => document.getElementById("file-body")?.textContent === "initial content v1");

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
      text: body?.textContent,
      error: reader?.dataset.error,
    };
  });

  assert.equal(state.disabled, false, "#file-refresh should return to enabled");
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
