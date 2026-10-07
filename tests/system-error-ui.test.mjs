// tests/system-error-ui.test.mjs — Verify UI system error visibility, diagnostics, and debug config (voicebox-beads-kusd).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("browser UI: system error visibility, diagnostic details, and debug config toggle", { timeout: 35000 }, async (t) => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vb-sys-err-ui-")));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const page = await launch({ width: 1200, height: 900 });
  t.after(() => page.close());

  // Listen to console errors in browser
  const consoleMessages = [];
  await page.send("Runtime.enable");

  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.querySelector("#utterance") !== null, { label: "page loaded" });

  // Hook console.error in page
  await page.evaluate(() => {
    window.__capturedConsole = [];
    const origError = console.error;
    const origDebug = console.debug;
    console.error = (...args) => {
      window.__capturedConsole.push({ level: "error", text: args.map(String).join(" ") });
      origError(...args);
    };
    console.debug = (...args) => {
      window.__capturedConsole.push({ level: "debug", text: args.map(String).join(" ") });
      origDebug(...args);
    };
  });

  // 1. Open Activity Log panel
  await page.evaluate(() => {
    document.querySelector("#sqeh-toggle-activity")?.click();
  });
  await page.waitFor(() => {
    const p = document.querySelector("#activity-log-panel");
    return p && !p.hidden;
  }, { label: "activity panel open" });

  // 2. Inspect Settings dialog & Debug Logging checkbox
  await page.evaluate(() => {
    const s = document.querySelector("#settings");
    s?.showModal();
  });

  const initialDebugState = await page.evaluate(() => {
    const cb = document.querySelector("#setting-debug-enabled");
    const st = document.querySelector("#setting-debug-state");
    return {
      checked: Boolean(cb?.checked),
      text: st?.textContent ?? "",
    };
  });
  assert.equal(initialDebugState.checked, false, "debug logging must be off by default");
  assert.match(initialDebugState.text, /standard error reporting/i);

  // Toggle debug logging ON
  await page.evaluate(() => {
    const cb = document.querySelector("#setting-debug-enabled");
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const toggledDebugState = await page.evaluate(() => {
    const cb = document.querySelector("#setting-debug-enabled");
    const st = document.querySelector("#setting-debug-state");
    return {
      checked: Boolean(cb?.checked),
      text: st?.textContent ?? "",
      stored: window.localStorage.getItem("voiceboxDebug"),
    };
  });
  assert.equal(toggledDebugState.checked, true, "debug checkbox should be checked");
  assert.equal(toggledDebugState.stored, "1", "debug setting should be persisted in localStorage");
  assert.match(toggledDebugState.text, /detailed error diagnostics/i);

  // Close Settings dialog
  await page.evaluate(() => {
    document.querySelector("#settings")?.close();
  });

  // 3. Trigger a system error event via window.__voiceboxOnSystemError
  await page.evaluate(() => {
    window.__voiceboxOnSystemError({
      summary: "System error reported by live assistant",
      detail: "Spoken: 'A system error occurred.' | Input was: 'open unknown workspace'",
      stack: "Error: Workspace not found\n    at resolveWorkspace (server.mjs:123:45)",
    });
  });

  // 4. Trigger a tool failure via window.__voiceboxOnToolCalls
  await page.evaluate(() => {
    window.__voiceboxOnToolCalls([
      {
        name: "edit_file",
        ok: false,
        refused: "pattern-not-found",
        why: "could not find exact text match for oldText in 'src/app.js'",
        error: "refused: pattern-not-found",
        stack: "Error: pattern-not-found\n    at edit (server.mjs:456:78)",
        args: { name: "src/app.js", oldText: "const old = 1;", newText: "const next = 2;" },
      },
    ]);
  });

  // 5. Verify errors appeared in Activity Feed (#activity-log-panel)
  await page.waitFor(() => {
    const items = document.querySelectorAll("#activity-log-list .activity-item-error");
    return items.length >= 2;
  }, { label: "two error items in activity log" });

  const activityEntries = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("#activity-log-list .activity-item-error"));
    return items.map((el) => ({
      kind: el.querySelector(".activity-kind")?.textContent ?? "",
      summary: el.querySelector(".activity-summary")?.textContent ?? "",
      detail: el.querySelector(".activity-detail")?.textContent ?? "",
    }));
  });

  assert.equal(activityEntries.length, 2, "must have exactly two error items with no duplicate entries");

  const toolErrorEntry = activityEntries.find((e) => e.summary.includes("edit file failed"));
  assert.ok(toolErrorEntry, "tool error entry must appear in activity log");
  assert.match(toolErrorEntry.kind, /Tool/i, "kind chip must reflect the tool label");
  assert.match(toolErrorEntry.detail, /could not find exact text match/);
  assert.match(toolErrorEntry.detail, /server\.mjs:456:78/, "stack trace must be visible when debug is enabled");

  const sysErrorEntry = activityEntries.find((e) => e.summary.includes("System error reported"));
  assert.ok(sysErrorEntry, "system error entry must appear in activity log");
  assert.match(sysErrorEntry.kind, /System/i, "kind chip must reflect system error label");
  assert.match(sysErrorEntry.detail, /A system error occurred/);

  // 6. Verify errors appeared in Session History (#session-log)
  const sessionLogText = await page.evaluate(() => {
    return document.querySelector("#session-log")?.textContent ?? "";
  });
  assert.match(sessionLogText, /system error/i, "session history must log system error turn");
  assert.match(sessionLogText, /voice tool: edit file/i, "session history must log failed voice tool turn");

  // 7. Verify Developer Console captured error and debug traces
  const captured = await page.evaluate(() => window.__capturedConsole ?? []);
  const errorLogs = captured.filter((c) => c.level === "error");
  const debugLogs = captured.filter((c) => c.level === "debug");

  assert.ok(errorLogs.length >= 2, `expected at least 2 console.error logs, got ${errorLogs.length}`);
  assert.ok(debugLogs.length >= 1, `expected console.debug logs when debug enabled, got ${debugLogs.length}`);
  assert.ok(errorLogs.some((c) => c.text.includes("[voicebox:system-error]") || c.text.includes("[voicebox:tool-failure]")));
});
