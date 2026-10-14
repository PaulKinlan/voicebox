// tests/environment-root-dialog-extraction.test.mjs — the Environments dialog's root surface is a
// module now (voicebox-beads-mvxl), and this file holds the ways that extraction can be wrong while
// the suite stays green.
//
// WHY THIS FILE EXISTS AT ALL. tests/environment-integrated-ui.test.mjs already drives the machine
// root, the browser workspace and the picker's failure paths end to end through the real page, so the
// BEHAVIOUR of this surface is covered. What it does not cover is the SEAM, and the seam is where an
// extraction rots: the handlers can be wired twice (the old copy left in public/fused.js), or a
// dependency can be handed over as a VALUE instead of a LIVE read. Neither shows up as a red test in a
// suite that only drives behaviour, which is exactly the voicebox-beads-w1f9 lesson: a captured
// accessor stayed green while the readout was wrong.
//
// WHAT THIS FILE PROVES, precisely, on the real page with fused.js's own wiring:
//
//   1. EXACTLY ONE HANDLER. The picked folder is only reachable through `showDirectoryPicker`, so the
//      stub below counts its own invocations. One click on #env-pick-folder-btn must produce exactly
//      ONE call. A second (leftover) copy of the old handler in fused.js produces two, and no
//      behaviour-driven test would notice — the second call just re-picks the same folder.
//
//   2. THE accessor IS LIVE, NOT A SNAPSHOT. `getRoomFolder()` decides whether the status line calls
//      the just-picked folder writable. On a page where NO folder was active when the module was
//      initialised, a snapshot read would say "Opened read-only folder …" about a folder the person
//      can write. The assertion below is the writable sentence, so a snapshot turns it RED.
//
//   3. THE INJECTED renderRoot IS fused.js's OWN. The dialog's "Active root:" line is repainted by the
//      injected dep, so a stub (or a dep wired to the wrong function) leaves it stale.
//
//   4. NEGATIVE CONTROL — the assertions above are not vacuous. Dropping the button's listeners
//      (cloneNode copies markup, never listeners) must make the click do nothing at all, which is why
//      1–3 can only be passing because fused.js called initEnvironmentRootDialog().
//
//   5. THE ax2v ORDERING SURVIVES THE EXTRACTION (voicebox-beads-3auh). gate-recover's ax2v fix moved
//      the repaint (`loadRoot()`/`load()`) ahead of the "Machine root set to …" line, because the dialog
//      could otherwise announce success while its own root line still read the previous root. The
//      extraction was taken from BEFORE that fix, so integrating them naively reverted it. The
//      behavioural half of the guard is gate-recover's own control in tests/environment-integrated-ui.test.mjs
//      (it delays the /api/root GET by 400ms to force the window open) and it was driven RED against the
//      pre-ax2v ordering of THIS module. The static arm below is the deterministic half: a timing-based
//      control only catches a reorder when the delayed fetch actually interleaves, so the ORDER itself is
//      asserted here, inside the one handler that owns it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

// The static arm below reads the module this file is about, so it needs its own path: unlike the
// changelog extraction test this file had no ROOT constant, and referring to one that does not exist is
// how that arm first went red on a CORRECT tree (a ReferenceError, not an assertion).
const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "components", "environment-root-dialog.mjs");

const PICKED = "extraction-probe-folder";

test("environment root dialog extraction: one live-wired handler, and a listener-free button does nothing", { timeout: 90000 }, async () => {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-env-root-extraction-")));
  let server;
  let page;
  try {
    server = await startServer({
      env: {
        VOICEBOX_WORKSPACE: undefined,
        VOICEBOX_SANDBOX_HOMES: undefined,
        VOICEBOX_INSTANCE: "env-root-dialog-extraction",
      },
      cwd: scratch,
    });
    page = await launch({ width: 1280, height: 900 });
    await page.goto(server.base);

    // The room settles before the dialog is used, and nothing is declared: roomFolder is null while
    // the module is initialised. That is the precondition assertion 2 depends on.
    await page.waitFor(
      () => {
        const text = document.getElementById("root-kind")?.textContent?.trim() ?? "";
        return text !== "" && text !== "checking which root…" && text !== "folder not reported";
      },
      { label: "the initial root check to settle" },
    );
    const before = await page.evaluate(() => ({
      root: document.getElementById("root-kind")?.textContent?.trim(),
      hasGetter: typeof window.__voiceboxGetActiveFolder === "function",
      activeFolder: window.__voiceboxGetActiveFolder?.() ?? null,
    }));
    assert.equal(before.root, "no folder chosen yet", "the drive starts with no root declared");
    assert.equal(before.hasGetter, true, "the room's active-folder reader must be on the page for this drive to mean anything");
    assert.equal(before.activeFolder, null, "and with no active room folder — a snapshot would be empty");

    await page.click("#envs-open");
    await page.waitFor(() => document.getElementById("envs")?.hasAttribute("open"), {
      label: "the environments dialog to open",
    });

    // A REAL OPFS directory stands in for the picked folder: it is a genuine FileSystemDirectoryHandle,
    // so the room adopts it exactly as it adopts a folder a person picks, and it is clonable for the
    // IDB persistence the adopt path performs.
    const stub = await page.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const real = await root.getDirectoryHandle(name, { create: true });
      window.__pickerCalls = 0;
      window.__pickerModes = [];
      window.showDirectoryPicker = async ({ mode } = {}) => {
        window.__pickerCalls += 1;
        window.__pickerModes.push(mode ?? null);
        return real;
      };
      return { isDirectoryHandle: real.kind === "directory" };
    }, PICKED);
    assert.equal(stub.isDirectoryHandle, true, "the picker stub must hand over a real directory handle");

    await page.click("#env-pick-folder-btn");
    await page.waitFor(
      () => {
        const el = document.getElementById("env-root-status");
        return (el?.textContent ?? "").includes("Opened");
      },
      { label: "the picked folder to be reported in the dialog", timeout: 15000 },
    );

    const after = await page.evaluate(() => ({
      pickerCalls: window.__pickerCalls,
      pickerModes: window.__pickerModes,
      status: document.getElementById("env-root-status")?.textContent ?? "",
      ok: document.getElementById("env-root-status")?.dataset.ok ?? null,
      activeRootLine: document.getElementById("env-active-root-val")?.textContent?.trim() ?? "",
      activeFolder: window.__voiceboxGetActiveFolder?.()?.name ?? null,
    }));

    // 1. EXACTLY ONE HANDLER: one click, one picker call. Two means a copy of the handler survived the
    //    extraction in fused.js, and every behaviour assertion above would still have passed.
    assert.equal(after.pickerCalls, 1, `one click must reach the picker exactly once, got ${after.pickerCalls}`);
    assert.deepEqual(after.pickerModes, ["readwrite"], "the picker is asked for write access, as before the move");

    // 2. THE LIVE READ: this page had NO folder when the module was initialised, so the writable
    //    wording can only come from reading fused.js's `roomFolder` at click time.
    assert.equal(after.ok, "true", `the dialog reports success: ${after.status}`);
    assert.equal(
      after.status,
      `Opened local folder “${PICKED}” — browser files and edits save here.`,
      "the writable sentence is the live-accessor mutant detector: a snapshot of the empty room folder would say “read-only” here",
    );
    assert.equal(after.activeFolder, PICKED, "the picked folder really became the room's active folder");

    // 3. THE INJECTED renderRoot IS fused.js's own: it is what repaints this dialog's root line.
    assert.match(
      after.activeRootLine,
      new RegExp(`picked folder · ${PICKED}`),
      `the dialog's own root line must be repainted by fused.js's renderRoot, got: ${after.activeRootLine}`,
    );

    // 4. NEGATIVE CONTROL: drop the module's listener by replacing the button with a clone (markup is
    //    copied, listeners are not) and click that. Nothing may happen — which is what makes 1–3
    //    evidence about the module's wiring rather than about markup.
    const omitted = await page.evaluate(async () => {
      const status = document.getElementById("env-root-status");
      const button = document.getElementById("env-pick-folder-btn");
      const clone = button.cloneNode(true);
      button.replaceWith(clone);
      const beforeText = status.textContent;
      const beforeCalls = window.__pickerCalls;
      clone.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { beforeText, afterText: status.textContent, beforeCalls, afterCalls: window.__pickerCalls };
    });
    assert.equal(
      omitted.afterText,
      omitted.beforeText,
      "with the module's listener absent the click must change nothing — if this fails the assertions above are vacuous",
    );
    assert.equal(omitted.afterCalls, omitted.beforeCalls, "and the picker must not be reached a second time");
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      await server?.stop();
    } catch {}
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The deterministic half of the ax2v guard (see point 5 in the header): whatever the timing, this
// module's declare-root handler must clear the path box and repaint the dialog's own root line BEFORE it
// writes the success line. Driven RED by restoring the pre-ax2v order in the module, which is exactly the
// state a naive merge of this extraction with the ax2v fix produces.
test("the extracted declare-root handler repaints before it announces, as ax2v ordered (voicebox-beads-3auh)", () => {
  const src = readFileSync(MODULE, "utf8");
  const start = src.indexOf("on(els.envDeclareRootBtn");
  assert.ok(start > -1, "the module must still own the declare-root handler");

  // Anchor on the CODE, not on prose: the comment above this handler quotes the same sentence ("Machine
  // root set to <path>"), and anchoring on that text measured the comment's position instead of the
  // write's — which made this arm fail on a correct tree when it was first written.
  const success = src.indexOf("Machine root set to ${res.root?.path", start);
  const repaint = src.indexOf("await loadRoot();", start);
  const reload = src.indexOf("await load();", start);
  const clearBox = src.indexOf('els.envRootPathInput.value = ""', start);
  assert.ok(
    success > -1 && repaint > -1 && reload > -1 && clearBox > -1,
    "the handler must still clear the path box, repaint the root line and write the success line",
  );
  assert.ok(
    repaint < success && reload < success,
    "the repaint (loadRoot then load) must run BEFORE the success line is written — otherwise the dialog can announce a root its own root line has not drawn yet, which is the voicebox-beads-ax2v symptom",
  );
  assert.ok(clearBox < repaint, "and the path box must be cleared before those awaits, as ax2v ordered it");
});
