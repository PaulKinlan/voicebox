// tests/modal-panels.test.mjs — Ensure extensions, environments, and harnesses panels
// open as modal dialogs (<dialog>) directly within the main room (voicebox-beads-snk, voicebox-beads-f1o).
//
// WHAT THIS PROVES (driven in real Chromium):
//   1. Modality & Top Layer:
//      - Extensions (#exts), Environments (#envs), and Harnesses (#harnesses-dialog)
//        are native <dialog> elements in the room.
//      - Each opens as a modal dialog using showModal() when its header trigger is clicked.
//      - aria-expanded reflects open state ("true" when open, "false" when closed).
//   2. Keyboard, Light-Dismiss & Focus Restoration:
//      - Esc key cancels/closes each dialog and returns focus to its trigger button.
//      - The close button in the header closes each dialog and returns focus to its trigger button.
//      - Clicking the backdrop (light-dismiss) closes each dialog.
//   3. Frosted Backdrop & Responsive Layout:
//      - dialog::backdrop has frosted styling (blur + saturate).
//      - Mobile viewport (390px width) fits inside viewport without horizontal document scroll.
//   4. Harnesses Modal Integration:
//      - Opening harnesses dialog fetches and renders host harnesses directly in the room modal.
//      - Tool catalogues within the modal expand and display without leaving the room.
//
//   node --test tests/modal-panels.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
let page;

test.before(async () => {
  server = await startServer({ env: { VOICEBOX_INSTANCE: "modal-panels-test" } });
  page = await launch({ width: 1000, height: 800 });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

// A native <dialog>'s `close` event is dispatched in a SEPARATE task from the one that flips
// `dialog.open` to false (the HTML spec queues an element task to fire it). Asserting the trigger's
// aria-expanded or focus restoration straight after `open === false` therefore races the app's own
// close handler and loses on a contended box — measured as voicebox-beads-tnxm. Wait for the exact
// observable each step goes on to assert, so the wait is the synchronisation rather than a
// wall-clock guess; the named label still fails loudly if the app never gets there.
async function waitForDialogFullyClosed(name, dialogId, triggerId) {
  await page.waitFor(
    (dId, tId) => {
      const dialog = document.getElementById(dId);
      const trigger = document.getElementById(tId);
      return (
        dialog?.open === false &&
        trigger?.getAttribute("aria-expanded") === "false" &&
        document.activeElement === trigger
      );
    },
    { args: [dialogId, triggerId], label: `${name} to close (dialog closed, aria-expanded false, focus returned)` },
  );
}

// A panel whose content arrives after its fetch changes the dialog's geometry: the changelog dialog is
// 197px tall while it says "Loading changes…" and 606px once 30 commit cards are rendered, which moves its
// close button 205px up (measured at 1000x800; dx -10, dy -205) and puts a click resolved before that
// growth inside the content, where the dialog never closes. That is the "timed out waiting for changelog
// to close" flake (voicebox-beads-pca1: 1 of 4 runs under load, on BOTH trees, so not a regression in
// either). `page.click` resolves a target's centre and then dispatches two round trips later, so the wait
// has to be on the dialog's own settling rather than on a longer deadline for the assertion.
//
// This waits for the dialog's shape to stop changing, not for a particular text: any terminal state
// counts, including an empty list or an error, so it does not depend on what an endpoint returned on this
// box. Bounded at 15s because the app's own changelog fetch aborts at 10s and renders its outcome.
// Shape stability alone is NOT enough, and that blind spot is the flake itself under the load it was
// filed for: while a fetch is in flight and nothing has changed yet, two samples a poll apart are
// identical, so a shape-only wait returns with the payload still coming and the close click races the
// relayout it was supposed to avoid (driven with the payload delayed 1200ms: 640x197 twice, then the dialog
// grew to 606px underneath the click; review 380e13b1 P1). A panel that says it is working has to be waited
// on by that statement - terse, and it accepts any terminal outcome, including an empty list or an error,
// because those are finished states too. An absent or already-finished status returns at once, so this
// costs nothing on a panel that is not fetching.
const PANEL_LOADING = {
  "changelog-dialog": { selector: "#changelog-status", working: "Loading changes\u2026" },
  "harnesses-dialog": { selector: "#harnesses-status", working: "Checking host programs\u2026" },
};
async function waitForPanelContentSettled(name, dialogId) {
  const loading = PANEL_LOADING[dialogId];
  if (loading) {
    await page.waitFor(
      (sel, working) => {
        const node = document.querySelector(sel);
        return !node || node.textContent.trim() !== working;
      },
      { args: [loading.selector, loading.working], label: `${name} to stop working`, timeout: 15000 },
    );
  }
  const shape = () =>
    page.evaluate((dId) => {
      const dialog = document.getElementById(dId);
      if (!dialog || !dialog.open) return "not-open";
      const box = dialog.getBoundingClientRect();
      return `${Math.round(box.width)}x${Math.round(box.height)}`;
    }, dialogId);
  let previous = await shape();
  for (let sample = 0; sample < 60; sample += 1) {
    await sleep(250);
    const current = await shape();
    if (current === previous && current !== "not-open") return;
    previous = current;
  }
  throw new Error(`${name} content never settled: still changing shape (last ${previous})`);
}

test("modal panels: extensions, environments, and harnesses open as native modal dialogs in the room", { timeout: 60000 }, async () => {
  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.getElementById("harnesses-open") !== null, { label: "header buttons" });

  const panels = [
    { name: "harnesses", triggerId: "harnesses-open", dialogId: "harnesses-dialog", closeId: "harnesses-close" },
    { name: "changelog", triggerId: "changelog-open", dialogId: "changelog-dialog", closeId: "changelog-close" },
    { name: "environments", triggerId: "envs-open", dialogId: "envs", closeId: "envs-close" },
    { name: "extensions", triggerId: "exts-open", dialogId: "exts", closeId: "exts-close" },
  ];

  for (const { name, triggerId, dialogId, closeId } of panels) {
    // 1. Initially closed
    const initial = await page.evaluate((dId, tId) => {
      const dialog = document.getElementById(dId);
      const trigger = document.getElementById(tId);
      return {
        isDialog: dialog instanceof HTMLDialogElement,
        open: dialog?.open,
        expanded: trigger?.getAttribute("aria-expanded"),
      };
    }, dialogId, triggerId);

    assert.equal(initial.isDialog, true, `${name} must be a native <dialog>`);
    assert.equal(initial.open, false, `${name} should be initially closed`);
    assert.equal(initial.expanded, "false");

    // 2. Open via button click
    await page.click(`#${triggerId}`);
    await page.waitFor((id) => document.getElementById(id)?.open === true, { args: [dialogId], label: `${name} to open` });

    const opened = await page.evaluate((dId, tId) => {
      const dialog = document.getElementById(dId);
      const trigger = document.getElementById(tId);
      return {
        open: dialog?.open,
        expanded: trigger?.getAttribute("aria-expanded"),
      };
    }, dialogId, triggerId);

    assert.equal(opened.open, true, `${name} dialog should be open`);
    assert.equal(opened.expanded, "true");

    // Before anything is clicked inside this dialog, let its own content finish arriving.
    await waitForPanelContentSettled(name, dialogId);

    // 3. Close via close button and verify focus restoration
    await page.click(`#${closeId}`);
    await waitForDialogFullyClosed(name, dialogId, triggerId);

    const closedByBtn = await page.evaluate((dId, tId) => {
      const dialog = document.getElementById(dId);
      const trigger = document.getElementById(tId);
      return {
        open: dialog?.open,
        expanded: trigger?.getAttribute("aria-expanded"),
        focusReturned: document.activeElement === trigger,
      };
    }, dialogId, triggerId);

    assert.equal(closedByBtn.open, false);
    assert.equal(closedByBtn.expanded, "false");
    assert.equal(closedByBtn.focusReturned, true, `closing ${name} must restore focus to its trigger button`);

    // 4. Reopen and close via Esc key
    await page.click(`#${triggerId}`);
    await page.waitFor((id) => document.getElementById(id)?.open === true, { args: [dialogId] });

    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitForDialogFullyClosed(name, dialogId, triggerId);

    const closedByEsc = await page.evaluate((dId, tId) => {
      const dialog = document.getElementById(dId);
      const trigger = document.getElementById(tId);
      return {
        open: dialog?.open,
        expanded: trigger?.getAttribute("aria-expanded"),
        focusReturned: document.activeElement === trigger,
      };
    }, dialogId, triggerId);

    assert.equal(closedByEsc.open, false);
    assert.equal(closedByEsc.focusReturned, true, `Esc on ${name} must restore focus to its trigger button`);

    // 5. Reopen and close via light-dismiss (clicking backdrop)
    await page.click(`#${triggerId}`);
    await page.waitFor((id) => document.getElementById(id)?.open === true, { args: [dialogId] });

    // Click outside the dialog geometry on the backdrop
    await page.clickAt(8, 8);
    await waitForDialogFullyClosed(name, dialogId, triggerId);

    const closedByBackdrop = await page.evaluate((dId) => document.getElementById(dId)?.open, dialogId);
    assert.equal(closedByBackdrop, false, `light-dismiss must close ${name} dialog`);
  }
});

test("modal panels: harnesses modal renders server harnesses directly in the room without navigating away", { timeout: 60000 }, async () => {
  await page.goto(`${server.base}/`);
  await page.waitFor(() => document.getElementById("harnesses-open") !== null, { label: "harnesses button" });

  // Verify we are on the main room page
  const initialUrl = await page.evaluate(() => location.href);
  assert.match(initialUrl, /\/$/);

  // Click Harnesses button
  await page.click("#harnesses-open");
  await page.waitFor(() => document.getElementById("harnesses-dialog")?.open === true);

  // We are STILL on the main room page (did not navigate away!)
  const modalUrl = await page.evaluate(() => location.href);
  assert.equal(modalUrl, initialUrl, "clicking Harnesses must not navigate away from the room");

  // Wait for the harnesses to load inside the modal
  await page.waitFor(
    () => document.querySelectorAll("#harnesses-list .harness-article").length > 0,
    { label: "harness articles in modal" }
  );

  const articles = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("#harnesses-list .harness-article")).map((a) => ({
      harness: a.dataset.harness,
      title: a.querySelector("h3")?.textContent,
    }));
  });

  assert.ok(articles.length >= 3, `modal should list server harnesses, got ${articles.length}`);
  assert.ok(articles.some((a) => a.harness === "pi"), "Pi harness should be in the list");

  // Verify mobile responsiveness (390px viewport, no overflow)
  await page.emulateViewport({ width: 390, height: 844, mobile: true, scale: 1 });
  await sleep(150);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "harnesses modal should not produce horizontal scroll on 390px viewport");

  await page.clearViewport();
  await page.click("#harnesses-close");
  await page.waitFor(() => document.getElementById("harnesses-dialog")?.open === false);
});
