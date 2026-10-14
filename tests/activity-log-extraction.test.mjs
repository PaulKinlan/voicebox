// tests/activity-log-extraction.test.mjs — the work activity log and the project-change flash live in
// public/components/activity-log-ui.mjs, not inline in public/fused.js (voicebox-beads-uei2.2).
//
// The owner tests keep driving the surface end to end and are unchanged: tests/ux-bubble-stage.test.mjs
// drives window.__voiceboxFlashProjectChange(:811) and the panel, and tests/acp-console-ui.test.mjs and
// tests/system-error-ui.test.mjs feed the paths that log through it. This file covers the ways THIS
// extraction can rot while those stay green:
//   1. a LEFTOVER COPY of a moved function in the host;
//   2. a DANGLING INTERNAL REFERENCE — the host still touching state that moved into the module. This is
//      not hypothetical: the host's clear handler called `workActivitySeenIds.clear()`, and moving that
//      set left the button throwing a ReferenceError at click time. It is a mutant here, and it is why
//      the module exposes `clearActivityLog()` instead of the host reaching in;
//   3. the redaction vocabulary being DUPLICATED into the module instead of injected. It stays in the
//      host because the changelog dialog, the tool-failure path and the system-error path redact through
//      the same function;
//   4. the injected deps not really being used (driven standalone with spies);
//   5. the page globals' shape drifting (window.__voiceboxAppendActivity / __voiceboxOnActivity /
//      __voiceboxFlashProjectChange).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "public", "components", "activity-log-ui.mjs");
const HOST_PATH = path.join(ROOT, "public", "fused.js");

const MOVED_DEFINITIONS = [
  "let projectFlashTimer",
  "const workActivitySeenIds",
  "let workActivitySeq",
  "function updateActivityBadge",
  "function appendWorkActivity",
  "async function refreshActivityLog",
  "function triggerProjectChangeFlash",
];
// State that moved: the host must not name it at all, because a reference that survives the move is a
// runtime error waiting for the click that reaches it, and no static check would call it a leftover copy.
const MOVED_STATE = ["workActivitySeenIds", "workActivitySeq", "projectFlashTimer"];

const hasMarker = (text, marker) => new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(text);

function assertMovedOutOfHost(hostSource, moduleSource) {
  for (const marker of MOVED_DEFINITIONS) {
    assert.ok(!hasMarker(hostSource, marker), `${marker} must no longer be inline in fused.js`);
    assert.ok(hasMarker(moduleSource, marker), `the extracted module must carry ${marker}`);
  }
  for (const marker of MOVED_STATE) {
    assert.ok(!hasMarker(hostSource, marker), `fused.js must not reference ${marker} at all any more: that state moved`);
  }
  // The vocabulary stays host-side and single-owned.
  assert.ok(hasMarker(hostSource, "function sanitizePlainActivityText"), "the redaction vocabulary stays in the host");
  assert.ok(!hasMarker(moduleSource, "function sanitizePlainActivityText"), "the module must not keep its own copy of the redaction vocabulary");
  assert.ok(hasMarker(hostSource, "let lastPaintedRootKey"), "lastPaintedRootKey belongs to root painting, not to this surface");
}

function assertHostContract(hostSource, moduleSource) {
  assert.match(hostSource, /import \{ initActivityLog \} from "\.\/components\/activity-log-ui\.mjs";/, "the host imports the factory");
  assert.match(
    hostSource,
    /const activityLog = initActivityLog\(\{\s*sanitizePlainActivityText,\s*isDebugEnabled,\s*createBoundedSeenSet,\s*\}\);/,
    "wired at one site, with the vocabulary, the debug gate and the seen-set factory injected",
  );
  assert.match(
    hostSource,
    /const \{ appendWorkActivity, refreshActivityLog, triggerProjectChangeFlash, updateActivityBadge \} = activityLog;/,
    "the host keeps the call sites readable through the factory's returns (the same shape as the changelog dialog's opener)",
  );
  for (const g of ["__voiceboxFlashProjectChange", "__voiceboxAppendActivity", "__voiceboxOnActivity"]) {
    assert.ok(hasMarker(hostSource, g), `the page global ${g} must survive the move`);
  }
  assert.match(hostSource, /activityLog\.clearActivityLog\(\);/, "clearing the log goes through the log's own operation");
  assert.match(moduleSource, /export function initActivityLog\(\{ sanitizePlainActivityText, isDebugEnabled, createBoundedSeenSet \}\)/, "the module's seam");
  assert.match(moduleSource, /return \{ appendWorkActivity, refreshActivityLog, triggerProjectChangeFlash, updateActivityBadge, clearActivityLog \};/, "and its whole surface");
}

test("the surface is in the module and gone from the host, and no host code still reaches into it", () => {
  const host = readFileSync(HOST_PATH, "utf8");
  const mod = readFileSync(MODULE_PATH, "utf8");
  assertMovedOutOfHost(host, mod);
  assertHostContract(host, mod);

  // NEGATIVE MUTANTS.
  const hostWithLeftover = host.replace("const activityLog = initActivityLog({", "function appendWorkActivity(e) { return e; }\nconst activityLog = initActivityLog({");
  assert.notEqual(hostWithLeftover, host);
  assert.throws(() => assertMovedOutOfHost(hostWithLeftover, mod), { name: "AssertionError" }, "a leftover inline copy must be caught");

  // The bug this slice actually hit: the host clear handler reaching for the moved set.
  const hostWithDangling = host.replace("activityLog.clearActivityLog();", "workActivitySeenIds.clear();\n    activityLog.clearActivityLog();");
  assert.notEqual(hostWithDangling, host);
  assert.throws(() => assertMovedOutOfHost(hostWithDangling, mod), { name: "AssertionError" }, "a surviving reference to moved state must be caught");

  const modWithCopy = mod.replace("export function initActivityLog(", "function sanitizePlainActivityText(raw) { return String(raw); }\nexport function initActivityLog(");
  assert.notEqual(modWithCopy, mod);
  assert.throws(() => assertMovedOutOfHost(host, modWithCopy), { name: "AssertionError" }, "a duplicated redaction vocabulary must be caught");

  const hostWithoutDestructure = host.replace("const { appendWorkActivity, refreshActivityLog, triggerProjectChangeFlash, updateActivityBadge } = activityLog;\n", "");
  assert.notEqual(hostWithoutDestructure, host);
  assert.throws(() => assertHostContract(hostWithoutDestructure, mod), { name: "AssertionError" }, "a dropped destructure must be caught");

  const hostWithoutGlobal = host.replace("window.__voiceboxOnActivity = appendWorkActivity;\n", "");
  assert.notEqual(hostWithoutGlobal, host);
  assert.throws(() => assertHostContract(hostWithoutGlobal, mod), { name: "AssertionError" }, "a dropped page global must be caught");
});

let server;
let base;
let page;

test.before(async () => {
  server = await startServer({ cwd: ROOT, env: { VOICEBOX_INSTANCE: "activity-log-extraction-test" } });
  base = server.base;
  page = await launch();
  await page.goto(`${base}/`);
  await page.waitFor(() => typeof window.__voiceboxAppendActivity === "function", { label: "the host to wire the activity log" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("the real page appends, scrubs with the host's vocabulary, dedupes, caps, clears and flashes", async () => {
  const result = await page.evaluate(async () => {
    const list = () => document.getElementById("activity-log-list");
    const badge = () => document.getElementById("sqeh-activity-badge");
    const empty = () => document.getElementById("activity-log-empty");
    document.getElementById("activity-log-clear").click();
    const afterClear = { items: list().children.length, badgeHidden: badge().hidden };

    window.__voiceboxAppendActivity({ id: "t-one", kind: "note", summary: "first" });
    const afterOne = { items: list().children.length, badge: badge().textContent, badgeHidden: badge().hidden, emptyHidden: empty().hidden };
    window.__voiceboxAppendActivity({ id: "t-one", kind: "note", summary: "duplicate id is dropped" });
    const afterDuplicate = list().children.length;

    // The vocabulary is the HOST's function: if the module had kept a copy of its own, these words
    // would come through unscrubbed and this arm would fail.
    window.__voiceboxAppendActivity({ id: "t-scrub", label: "sandbox and worktree and opfs", summary: "sandbox" });
    const scrubbed = list().firstElementChild.textContent;

    // The 60-item cap.
    for (let i = 0; i < 70; i += 1) window.__voiceboxAppendActivity({ id: `cap-${i}`, kind: "cap", summary: `cap ${i}` });
    const capped = list().children.length;

    // The flash: markers on, an activity entry recorded, and the markers cleared by the module's timer.
    // Cleared first: the list is at its cap above, so a count delta there would be 0 and measure nothing.
    document.getElementById("activity-log-clear").click();
    window.__voiceboxFlashProjectChange("switched-root");
    const flashDuring = { body: document.body.dataset.projectFlash, reason: document.body.dataset.projectFlashReason, entries: list().children.length, firstText: list().firstElementChild.textContent };

    // Clearing must forget the duplicate-id memory too: re-appending the same id must add again.
    document.getElementById("activity-log-clear").click();
    const cleared = { items: list().children.length, badgeHidden: badge().hidden };
    window.__voiceboxAppendActivity({ id: "t-one", kind: "note", summary: "same id after a clear" });
    const reAdded = { items: list().children.length, badge: badge().textContent };

    // The close control is the shell's, and still closes the panel.
    document.getElementById("activity-log-close").click();
    const panelHidden = document.getElementById("activity-log-panel").hidden;

    return {
      afterClear, afterOne, afterDuplicate, scrubbed, capped, flashDuring, cleared, reAdded, panelHidden,
      globalsMatch: window.__voiceboxOnActivity === window.__voiceboxAppendActivity,
      hasFlashGlobal: typeof window.__voiceboxFlashProjectChange === "function",
    };
  });

  assert.deepEqual(result.afterClear, { items: 0, badgeHidden: true }, "clearing empties the list and hides the badge");
  assert.equal(result.afterOne.items, 1, "an append adds one item");
  assert.equal(result.afterOne.badge, "1", "the badge counts the items");
  assert.equal(result.afterOne.badgeHidden, false, "the badge shows when there are items");
  assert.equal(result.afterOne.emptyHidden, true, "the empty placeholder hides when there are items");
  assert.equal(result.afterDuplicate, 1, "an entry that repeats an id already seen is dropped (the bounded set travelled with the surface)");
  assert.match(result.scrubbed, /workspace and workspace and browser storage/, "labels are scrubbed by the HOST's vocabulary, which is injected, not copied");
  assert.equal(result.capped, 60, "the list is capped at 60 items");
  assert.equal(result.flashDuring.body, "true", "the flash sets the body marker");
  assert.equal(result.flashDuring.reason, "switched-root", "the flash records why");
  assert.equal(result.flashDuring.entries, 1, "the flash logs one activity entry");
  assert.match(result.flashDuring.firstText, /Switched workspace to switched-root/, "and the entry names the new workspace, through the injected vocabulary");
  assert.deepEqual(result.cleared, { items: 0, badgeHidden: true }, "the clear control still empties the list through activityLog.clearActivityLog()");
  assert.equal(result.reAdded.items, 1, "after a clear the same id can be logged again — the clear really forgot the duplicate-id memory");
  assert.equal(result.panelHidden, true, "the close control (shell-owned) still closes the panel");
  assert.equal(result.globalsMatch, true, "window.__voiceboxOnActivity is the same function as window.__voiceboxAppendActivity");
  assert.equal(result.hasFlashGlobal, true, "window.__voiceboxFlashProjectChange survives the move");

  // The flash's timer clears the markers — the timer travelled into the module with the flash.
  await page.waitFor(() => document.body.dataset.projectFlash === undefined, { label: "the flash markers to clear" });
  const cleared = await page.evaluate(() => ({ body: document.body.dataset.projectFlash ?? null, reason: document.body.dataset.projectFlashReason ?? null }));
  assert.deepEqual(cleared, { body: null, reason: null }, "the module's timer clears the flash markers");
});

test("driven standalone, the module uses the injected vocabulary, debug gate and seen-set factory", async () => {
  const result = await page.evaluate(async () => {
    const { initActivityLog } = await import("/components/activity-log-ui.mjs");
    const calls = { sanitize: [], createSeenSet: [], debug: 0 };
    const made = [];
    const makeSeenSet = (limit) => {
      calls.createSeenSet.push(limit);
      const set = new Set();
      const stub = { has: (k) => set.has(k), add: (k) => set.add(k), clear: () => set.clear(), size: () => set.size };
      made.push(stub);
      return stub;
    };
    let debugOn = false;
    const log = initActivityLog({
      sanitizePlainActivityText: (raw) => { calls.sanitize.push(String(raw)); return `S[${raw}]`; },
      isDebugEnabled: () => { calls.debug += 1; return debugOn; },
      createBoundedSeenSet: makeSeenSet,
    });
    document.getElementById("activity-log-list").replaceChildren();

    log.appendWorkActivity({ id: "s-1", kind: "probe", summary: "hello" });
    log.appendWorkActivity({ id: "s-1", kind: "probe", summary: "duplicate" });
    log.appendWorkActivity({ id: "s-error", kind: "error", summary: "boom", stack: "at line 1" });
    const withoutStack = document.querySelectorAll("#activity-log-list .activity-detail").length;
    debugOn = true;
    log.appendWorkActivity({ id: "s-stack", kind: "probe", summary: "with stack", stack: "at line 2" });
    const withStack = document.querySelectorAll("#activity-log-list .activity-detail").length;

    return {
      calls,
      seenSetCalls: made.length,
      text: document.getElementById("activity-log-list").textContent,
      items: document.getElementById("activity-log-list").children.length,
      withoutStack, withStack,
      // AFTER the reads above: this clears the very list they measure, so it goes last.
      setClearedByClear: (() => { made[0].add("x"); log.clearActivityLog(); return made[0].size(); })(),
      updateBadge: typeof log.updateActivityBadge,
      clearActivityLog: typeof log.clearActivityLog,
      refreshActivityLog: typeof log.refreshActivityLog,
      triggerProjectChangeFlash: typeof log.triggerProjectChangeFlash,
    };
  });

  assert.deepEqual(result.calls.createSeenSet, [200], "the module builds its seen-set through the injected factory, at the same bound the host used");
  assert.ok(result.calls.sanitize.length >= 4, "the injected vocabulary is the only sanitiser: every label/summary/detail went through it");
  assert.match(result.text, /S\[hello\]/, "and its output is what gets rendered, not the raw text");
  assert.equal(result.items, 3, "the duplicate id was dropped by the INJECTED set (4 appends, 3 items)");
  assert.equal(result.setClearedByClear, 0, "clearActivityLog() empties the injected set");
  assert.equal(result.withoutStack, 0, "with the debug gate false, a stack is not rendered");
  assert.equal(result.withStack, 1, "with the debug gate true, it is — the gate is the injected one");
  assert.ok(result.calls.debug >= 2, "the gate is consulted rather than assumed");
  for (const fn of ["updateBadge", "clearActivityLog", "refreshActivityLog", "triggerProjectChangeFlash"]) {
    assert.equal(result[fn], "function", `the module must expose ${fn}`);
  }
});
