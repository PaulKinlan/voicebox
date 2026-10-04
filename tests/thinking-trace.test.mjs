// tests/thinking-trace.test.mjs — bead voicebox-beads-vg0g.
//
// Drives the thinking trace UI and DOM rendering across its lifecycle:
// 1. Initial idle/hidden state
// 2. Real-time streaming thinking trace updates & word count summary
// 3. Collapsible header toggling via click
// 4. Settling when model transitions to speaking
// 5. Clean reset when user initiates a new turn
//
//   node --test tests/thinking-trace.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { launch } from "./lib/cdp.mjs";
import { startServer } from "./lib/server.mjs";

const EVIDENCE_DIR = path.join(os.tmpdir(), "voicebox-evidence", "vg0g-thinking-trace");
mkdirSync(EVIDENCE_DIR, { recursive: true });

test("thinking-trace: UI displays thinking activity, streams real-time trace, toggles, settles on speaking, and resets", async () => {
  const server = await startServer({ env: { VOICEBOX_RESOLVER: "script" } });
  const page = await launch({ fakeMedia: true });

  try {
    await page.goto(server.base);
    await page.waitFor(() => document.querySelector("#server-dot")?.getAttribute("data-ok") === "true", {
      label: "page loaded",
    });

    // 1. Initial idle state: container must be hidden
    const initial = await page.evaluate(() => {
      const container = document.getElementById("thinking-container");
      const trace = document.getElementById("thinking-trace");
      const header = document.getElementById("thinking-header");
      const body = document.getElementById("thinking-body");
      return {
        exists: Boolean(container && trace && header && body),
        hidden: container ? container.hidden : null,
        status: container ? container.dataset.status : null,
        traceText: trace ? trace.textContent : null,
      };
    });

    assert.ok(initial.exists, "all thinking trace elements (#thinking-container, #thinking-trace, #thinking-header, #thinking-body) must exist");
    assert.equal(initial.hidden, true, "#thinking-container must be hidden initially");
    assert.equal(initial.status, "idle", "status must be idle initially");
    assert.equal(initial.traceText, "", "trace text must be empty initially");

    // 2. Live thinking trace stream begins
    await page.evaluate(() => {
      window.__voiceboxOnLiveThought("Analyzing the files in the workspace...");
    });

    const thinking1 = await page.evaluate(() => {
      const container = document.getElementById("thinking-container");
      const trace = document.getElementById("thinking-trace");
      const summary = document.getElementById("thinking-summary");
      return {
        hidden: container.hidden,
        status: container.dataset.status,
        traceText: trace.textContent,
        summaryText: summary.textContent,
      };
    });

    assert.equal(thinking1.hidden, false, "#thinking-container must become visible when thinking begins");
    assert.equal(thinking1.status, "thinking", "#thinking-container status must be 'thinking'");
    assert.equal(thinking1.traceText, "Analyzing the files in the workspace...");
    assert.ok(thinking1.summaryText.includes("Thinking"), `summary must indicate thinking: got '${thinking1.summaryText}'`);

    // Stream a second chunk of thoughts
    await page.evaluate(() => {
      window.__voiceboxOnLiveThought(" Step 2: reading source code and constructing response.");
    });

    const thinking2 = await page.evaluate(() => {
      const trace = document.getElementById("thinking-trace");
      const summary = document.getElementById("thinking-summary");
      return {
        traceText: trace.textContent,
        summaryText: summary.textContent,
      };
    });

    assert.equal(
      thinking2.traceText,
      "Analyzing the files in the workspace... Step 2: reading source code and constructing response.",
      "thinking trace must accumulate streamed reasoning tokens in real time"
    );

    // 3. Test collapse / expand toggle
    await page.evaluate(() => {
      document.getElementById("thinking-header").click();
    });

    const collapsed = await page.evaluate(() => {
      const header = document.getElementById("thinking-header");
      const body = document.getElementById("thinking-body");
      return {
        expanded: header.getAttribute("aria-expanded"),
        bodyHidden: body.hidden,
      };
    });

    assert.equal(collapsed.expanded, "false", "header must reflect aria-expanded=false when collapsed");
    assert.equal(collapsed.bodyHidden, true, "body must be hidden when collapsed");

    // Click again to re-expand
    await page.evaluate(() => {
      document.getElementById("thinking-header").click();
    });

    const expanded = await page.evaluate(() => {
      const header = document.getElementById("thinking-header");
      const body = document.getElementById("thinking-body");
      return {
        expanded: header.getAttribute("aria-expanded"),
        bodyHidden: body.hidden,
      };
    });

    assert.equal(expanded.expanded, "true", "header must reflect aria-expanded=true when re-expanded");
    assert.equal(expanded.bodyHidden, false, "body must be visible when expanded");

    // Capture screenshot evidence while thinking
    await page.screenshot(path.join(EVIDENCE_DIR, "thinking-trace-active.png"));

    // 4. Model transitions to speaking
    await page.evaluate(() => {
      window.__voiceboxOnLiveText("I have analyzed the workspace and found the requested details.", "model");
    });

    const speakingState = await page.evaluate(() => {
      const container = document.getElementById("thinking-container");
      const summary = document.getElementById("thinking-summary");
      const caption = document.getElementById("caption");
      return {
        containerStatus: container.dataset.status,
        summaryText: summary.textContent,
        captionText: caption.textContent,
      };
    });

    assert.equal(speakingState.containerStatus, "settled", "container status must settle when speaking starts");
    assert.ok(speakingState.summaryText.startsWith("Thought for "), `summary must transition to 'Thought for Xs', got: ${speakingState.summaryText}`);
    assert.equal(speakingState.captionText, "I have analyzed the workspace and found the requested details.");

    await page.screenshot(path.join(EVIDENCE_DIR, "thinking-trace-settled.png"));

    // 5. Clean reset when user initiates a new turn
    await page.evaluate(() => {
      window.__voiceboxClearThinkingTrace();
    });

    const resetState = await page.evaluate(() => {
      const container = document.getElementById("thinking-container");
      const trace = document.getElementById("thinking-trace");
      const summary = document.getElementById("thinking-summary");
      return {
        hidden: container.hidden,
        status: container.dataset.status,
        traceText: trace.textContent,
        summaryText: summary.textContent,
      };
    });

    assert.equal(resetState.hidden, true, "container must be hidden after reset");
    assert.equal(resetState.status, "idle", "container status must be idle after reset");
    assert.equal(resetState.traceText, "", "trace text must be cleared after reset");
    assert.equal(resetState.summaryText, "Reasoning trace", "summary text must reset to default");

    await page.screenshot(path.join(EVIDENCE_DIR, "thinking-trace-reset.png"));
  } finally {
    await page.close();
    await server.stop();
  }
});
