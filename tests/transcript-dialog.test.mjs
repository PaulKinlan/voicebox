// tests/transcript-dialog.test.mjs — bead voicebox-beads-qab1.
//
// Verifies the session transcript & diagnostic modal dialog:
// 1. recordDebug captures events in a bounded ring buffer (MAX_EVENTS = 200) even when ?debug=1 is inactive
// 2. Secrets (AIza..., sk-..., Bearer tokens, headers, passwords) are redacted on export
// 3. formatSessionTranscript formats #session-log turns in chronological order ("said → did")
// 4. openTranscriptDialog populates #transcript-dialog-turns and #transcript-dialog-debug,
//    opens #transcript-dialog via showModal() (with open-attribute fallback), and wires copy/close actions
// 5. public/index.html and public/style.css declare the accessible <dialog id="transcript-dialog">
//
//   node --test tests/transcript-dialog.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  debugEnabled,
  MAX_EVENTS,
  recordDebug,
  getDebugEvents,
  clearDebugEvents,
  exportDebug,
  formatSessionTranscript,
  openTranscriptDialog,
} from "../public/debug-transcript.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

function createMockElement(tag, id = "") {
  const listeners = new Map();
  const attrs = new Map();
  return {
    tagName: tag.toUpperCase(),
    id,
    value: "",
    textContent: "",
    open: false,
    hidden: false,
    children: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    async trigger(type, event = {}) {
      for (const fn of listeners.get(type) ?? []) {
        await fn(event);
      }
    },
    setAttribute(name, val) {
      attrs.set(name, String(val));
      if (name === "open") this.open = true;
    },
    removeAttribute(name) {
      attrs.delete(name);
      if (name === "open") this.open = false;
    },
    getAttribute(name) {
      return attrs.get(name) ?? null;
    },
    focus() {
      this.focused = true;
    },
    select() {
      this.selected = true;
    },
  };
}

function createTurnItem(said, did) {
  return {
    textContent: `${said} ${did}`,
    querySelector(selector) {
      if (selector === ".said") return { textContent: said };
      if (selector === ".did") return { textContent: did };
      return null;
    },
  };
}

test("recordDebug captures events in the bounded ring buffer even without ?debug=1", () => {
  clearDebugEvents();
  assert.equal(debugEnabled, false, "unit test runs without ?debug=1");

  recordDebug({ type: "turn.request", transcript: "create a file called notes.md" });
  recordDebug({ type: "turn.result", status: 200, ok: true });
  const captured = getDebugEvents();
  assert.equal(captured.length, 2, "events are recorded into the ring buffer even when debugEnabled is false");
  assert.equal(captured[0].type, "turn.request");
  assert.equal(captured[1].type, "turn.result");

  // Ring buffer bounds to MAX_EVENTS (200), evicting oldest entries
  clearDebugEvents();
  for (let i = 0; i < MAX_EVENTS + 25; i++) {
    recordDebug({ type: "turn.step", index: i });
  }
  const bounded = getDebugEvents();
  assert.equal(bounded.length, MAX_EVENTS, `ring buffer must cap at MAX_EVENTS (${MAX_EVENTS})`);
  assert.equal(bounded[0].index, 25, "oldest 25 events should be evicted");
  assert.equal(bounded[bounded.length - 1].index, MAX_EVENTS + 24, "newest event should be retained");
});

test("openTranscriptDialog populates human-readable turns and redacted debug JSONL, and opens the dialog", async () => {
  clearDebugEvents();
  const googleKey = "AIzaSyTestSecretKey1234567890abcdef";
  const openaiKey = "sk-proj-TestSecretToken9876543210abcdef";
  const bearerToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretPayload";

  recordDebug({
    type: "turn.request",
    transcript: "create a file called hello.txt with greeting",
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  recordDebug({
    type: "tool.result",
    severity: "error",
    ok: false,
    note: `keys: ${googleKey} and ${openaiKey} and Bearer ${bearerToken}`,
  });

  // In #session-log, fused.js prepends newest items first; formatSessionTranscript reverses to chronological order
  const logElement = {
    querySelectorAll(sel) {
      if (sel === "li") {
        return [
          createTurnItem("“read hello.txt”", "Read hello.txt (9 bytes)."),
          createTurnItem("“create a file called hello.txt with greeting”", "Wrote hello.txt (9 bytes)."),
        ];
      }
      return [];
    },
  };

  const formatted = formatSessionTranscript(logElement);
  assert.equal(
    formatted,
    "“create a file called hello.txt with greeting” → Wrote hello.txt (9 bytes).\n“read hello.txt” → Read hello.txt (9 bytes).",
  );

  const elements = new Map([
    ["transcript-dialog-turns", createMockElement("textarea", "transcript-dialog-turns")],
    ["transcript-dialog-debug", createMockElement("textarea", "transcript-dialog-debug")],
    ["transcript-dialog-summary", createMockElement("p", "transcript-dialog-summary")],
    ["transcript-copy-status", createMockElement("p", "transcript-copy-status")],
    ["transcript-copy-turns", createMockElement("button", "transcript-copy-turns")],
    ["transcript-copy-debug", createMockElement("button", "transcript-copy-debug")],
    ["transcript-dialog-close", createMockElement("button", "transcript-dialog-close")],
  ]);

  let showModalCalls = 0;
  const dialogElement = {
    ...createMockElement("dialog", "transcript-dialog"),
    showModal() {
      showModalCalls++;
      this.open = true;
    },
    close() {
      this.open = false;
    },
    querySelector(sel) {
      if (sel.startsWith("#")) return elements.get(sel.slice(1)) ?? null;
      return null;
    },
  };

  const result = openTranscriptDialog({ logElement, dialogElement });
  assert.equal(showModalCalls, 1, "openTranscriptDialog must call dialog.showModal()");
  assert.equal(dialogElement.open, true, "dialog must be open");
  assert.equal(result.turnCount, 2);
  assert.equal(result.eventCount, 2);
  assert.equal(result.errorCount, 1);

  const turnsTextarea = elements.get("transcript-dialog-turns");
  const debugTextarea = elements.get("transcript-dialog-debug");
  const summaryEl = elements.get("transcript-dialog-summary");

  assert.equal(turnsTextarea.value, formatted);
  assert.match(summaryEl.textContent, /2 turns · 2 debug events · 1 error/);

  // Verify debug JSONL is populated and secrets are redacted
  assert.ok(debugTextarea.value.includes("turn.request"), "debug JSONL includes turn.request");
  assert.ok(debugTextarea.value.includes("tool.result"), "debug JSONL includes tool.result");
  assert.ok(!debugTextarea.value.includes(googleKey), "AIza... key must be redacted");
  assert.ok(!debugTextarea.value.includes(openaiKey), "sk-... key must be redacted");
  assert.ok(!debugTextarea.value.includes(bearerToken), "Bearer token must be redacted");
  assert.match(debugTextarea.value, /\[redacted/);

  // Verify fallback when showModal is not defined on dialogElement
  const fallbackDialog = {
    ...createMockElement("dialog", "transcript-dialog"),
    querySelector(sel) {
      if (sel.startsWith("#")) return elements.get(sel.slice(1)) ?? null;
      return null;
    },
  };
  openTranscriptDialog({ logElement, dialogElement: fallbackDialog });
  assert.equal(fallbackDialog.open, true, "fallback sets dialog.open = true when showModal is absent");
  assert.equal(fallbackDialog.getAttribute("open"), "", "fallback sets open attribute");

  // Verify copy buttons and close button
  let clipboardText = "";
  const prevClipboard = globalThis.navigator?.clipboard;
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: {
      async writeText(t) {
        clipboardText = t;
      },
    },
    configurable: true,
  });
  try {
    await elements.get("transcript-copy-turns").trigger("click");
    assert.equal(clipboardText, formatted, "Copy turns button copies formatted turns");
    assert.match(elements.get("transcript-copy-status").textContent, /Copied turns/);

    await elements.get("transcript-copy-debug").trigger("click");
    assert.equal(clipboardText, exportDebug(), "Copy debug JSONL button copies redacted JSONL");
    assert.ok(!clipboardText.includes(googleKey));
    assert.match(elements.get("transcript-copy-status").textContent, /Copied all events as redacted JSONL/);

    await elements.get("transcript-dialog-close").trigger("click");
    assert.equal(dialogElement.open, false, "Close button closes the dialog");
  } finally {
    if (prevClipboard !== undefined) {
      Object.defineProperty(globalThis.navigator, "clipboard", { value: prevClipboard, configurable: true });
    }
  }
});

test("html and css: #transcript-dialog and #debug-panel structure and styles are present", () => {
  const html = readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");

  assert.match(
    html,
    /<dialog\s+class="modal transcript-dialog"\s+id="transcript-dialog"\s+closedby="any"\s+aria-labelledby="transcript-dialog-title">/,
    "index.html must include <dialog class=\"modal transcript-dialog\" id=\"transcript-dialog\" closedby=\"any\" aria-labelledby=\"transcript-dialog-title\">",
  );
  for (const id of [
    "transcript-dialog",
    "transcript-dialog-title",
    "transcript-dialog-close",
    "transcript-dialog-summary",
    "transcript-dialog-turns",
    "transcript-dialog-debug",
    "transcript-copy-turns",
    "transcript-copy-debug",
    "transcript-copy-status",
    "debug-panel",
    "debug-copy",
    "debug-next-error",
    "debug-status",
    "debug-copy-status",
    "debug-export",
    "debug-events",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html must contain #${id}`);
  }

  assert.match(css, /dialog\.transcript-dialog\s*\{/, "style.css must style dialog.transcript-dialog");
  assert.match(css, /\.transcript-box-mono\s*\{/, "style.css must style .transcript-box-mono for debug JSONL output");
});
