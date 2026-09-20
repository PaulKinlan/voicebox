// tests/settings-dialog.test.mjs — settings are a REAL MODAL DIALOG, driven.
//
//   node --test tests/settings-dialog.test.mjs
//
// The defect, in Paul's words: he likes WHERE the settings button is, but clicking it "just pops over
// down" and makes him scroll to it — on a phone he expects a dialog over the front of the screen,
// dismissible, cancelable, with the background frosted out. The cause was structural: the panel was a
// block in the document flow, so opening it displaced everything below it.
//
// So the assertions here are about the PROPERTIES A MODAL HAS, not about the markup: it is in the top
// layer and the room behind is inert, it does not move the page, Esc cancels it, clicking outside
// dismisses it, focus is trapped and handed back, the page behind cannot scroll, and it fits a phone.
// And — the part that is easy to miss — the device rows still tell the truth inside it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startServer } from "./lib/server.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let page;

const state = () =>
  page.evaluate(() => {
    const dialog = document.getElementById("settings");
    const rect = dialog.getBoundingClientRect();
    return {
      open: dialog.open,
      modal: dialog.matches(":modal"),
      returnValue: dialog.returnValue,
      position: getComputedStyle(dialog).position,
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height },
      activeId: document.activeElement?.id ?? document.activeElement?.tagName,
      activeInside: dialog.contains(document.activeElement),
      htmlOverflow: getComputedStyle(document.documentElement).overflowY,
      scrollY: window.scrollY,
      backdropFilter: getComputedStyle(dialog, "::backdrop").backdropFilter,
      closedBySupported: "closedBy" in HTMLDialogElement.prototype,
    };
  });

const openSettings = async () => {
  await page.click("#settings-open");
  await page.waitFor(() => document.getElementById("settings").open, { label: "the settings dialog to open" });
};

test.before(async () => {
  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_INSTANCE: "settings-test" },
  });
  BASE = server.base;
  page = await launch();
  // Give the page something to scroll, so "the page behind does not scroll" is a real assertion
  // rather than a tautology on a short page.
  await page.goto(`${BASE}/`);
  await page.evaluate(() => {
    const filler = document.createElement("div");
    filler.style.height = "300vh";
    document.body.appendChild(filler);
  });
  await page.waitFor(() => window.__voiceboxFused !== undefined || document.getElementById("settings-open") !== null, { label: "the page to be interactive" });
});

test.after(async () => {
  await page?.close();
  await server?.stop();
});

test("it is a modal, over the page rather than in it — and opening it does not move the page", { timeout: 90000 }, async () => {
  // LAYOUT position, not a viewport rect: `page.click` scrolls the button into view first (it has to,
  // to click it at real coordinates), so a viewport rect would measure the harness, not the dialog.
  const before = await page.evaluate(() => {
    const composer = document.querySelector(".composer");
    return { composerTop: composer.offsetTop, contentHeight: document.documentElement.scrollHeight };
  });
  const closed = await state();
  assert.equal(closed.open, false, "the dialog is open before anyone opened it");

  await openSettings();
  const open = await state();

  // THE THREE THINGS THAT MAKE IT A MODAL rather than a panel: it is in the top layer, focus is
  // inside it, and the rest of the page is inert (that is what `:modal` means).
  assert.equal(open.modal, true, "the dialog is not in the top layer — this is not a modal");
  assert.equal(open.position, "fixed", "a modal is out of flow; this one is still positioned in it");
  assert.equal(open.activeInside, true, "focus is outside the dialog it just opened");

  // THE SPECIFIC COMPLAINT: the old panel was in the document flow, so it pushed the page down.
  const after = await page.evaluate(() => {
    const composer = document.querySelector(".composer");
    return { composerTop: composer.offsetTop, contentHeight: document.documentElement.scrollHeight };
  });
  assert.equal(after.composerTop, before.composerTop, "opening settings moved the page content");
  assert.equal(after.contentHeight, before.contentHeight, "opening settings changed the page's height");

  // And the button keeps its place: it is exactly where Paul said he likes it.
  const gear = await page.evaluate(() => {
    const el = document.getElementById("settings-open");
    const rect = el.getBoundingClientRect();
    return { inVoiceActions: Boolean(el.closest(".voice-actions")), hasGearIcon: Boolean(el.querySelector("use[href='#i-gear']")), visible: rect.width > 0 && rect.height > 0 };
  });
  assert.equal(gear.inVoiceActions, true, "the settings button moved out of the control line");
  assert.equal(gear.hasGearIcon, true, "the settings button lost its gear");
  assert.equal(gear.visible, true, "the settings button is not visible");
});

test("the backdrop is frosted, with a solid fallback where blur is unavailable", { timeout: 90000 }, async () => {
  const view = await state();
  assert.match(view.backdropFilter, /blur\(/, `the backdrop is not frosted: ${view.backdropFilter}`);
  assert.equal(view.backdropFilter.includes("saturate"), true, "the backdrop lost its saturation pass");

  // The fallback is a documented @supports branch; this browser supports blur, so the honest check is
  // that the rule EXISTS and is a solid scrim (asserting the rendered style would test the path the
  // browser is not taking).
  // The DECLARATION, not the rule text: the @supports condition itself contains "blur(1px)", so
  // matching against the whole rule would test the condition it is negating.
  const fallback = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .filter((rule) => rule.cssText?.startsWith("@supports not (backdrop-filter"))
      .map((rule) => ({ condition: rule.conditionText, style: rule.cssRules?.[0]?.style?.cssText ?? "" })),
  );
  assert.equal(fallback.length, 1, "there is no @supports fallback for the frosting");
  assert.match(fallback[0].style, /background:/, "the fallback rule has no background");
  assert.equal(/backdrop-filter/.test(fallback[0].style), false, "the fallback declares a blur it cannot render");
  assert.match(fallback[0].style, /light-dark\(/, "the fallback is not theme-aware");
});

test("Esc cancels it and returns focus to the gear", { timeout: 90000 }, async () => {
  assert.equal((await state()).open, true, "the dialog was not open for the Esc check");
  await page.press("Escape");
  await page.waitFor(() => document.getElementById("settings").open === false, { label: "Esc to close the dialog" });
  const after = await state();
  assert.equal(after.open, false);
  assert.equal(after.activeId, "settings-open", `focus went to '${after.activeId}' instead of back to the gear`);
});

test("clicking outside dismisses it (and the mechanism is named)", { timeout: 90000 }, async () => {
  await openSettings();
  const before = await state();
  // A point near the top-left corner: the backdrop, never the dialog.
  await page.clickAt(8, 8);
  await page.waitFor(() => document.getElementById("settings").open === false, { label: "light dismiss to close the dialog" });
  const after = await state();
  assert.equal(after.open, false, "clicking the backdrop did not dismiss the dialog");
  assert.equal(after.activeId, "settings-open", "light dismiss did not hand focus back");
  console.log(`[settings] light dismiss handled by: ${before.closedBySupported ? "native closedby" : "the documented geometry fallback"}`);
});

test("focus is trapped while it is open: the room behind cannot take it", { timeout: 90000 }, async () => {
  await openSettings();

  // THE PROPERTY THAT MATTERS: an element behind the modal cannot take focus at all. (The platform
  // implements this with inertness, not by forbidding Tab — so the check is "focus cannot go there",
  // which is what a person experiences, rather than "activeElement never changes".)
  const behind = await page.evaluate(() => {
    const target = document.querySelector(".composer input");
    target.focus();
    return { wantBehind: target.id, tookFocus: document.activeElement === target, active: document.activeElement?.id || document.activeElement?.tagName };
  });
  assert.equal(behind.tookFocus, false, `an element behind the modal took focus (${behind.wantBehind})`);
  // INSIDE the dialog, not on one particular control: the property is "the room behind cannot take
  // focus", and naming a specific element made this check fail the first time the dialog gained rows.
  const stillInside = await page.evaluate(() => document.getElementById("settings").contains(document.activeElement));
  assert.equal(stillInside, true, "focus left the dialog after trying to focus the page behind it");

  // And Tab stays among the dialog's own controls. Passing through BODY is the browser's way of
  // saying "focus went to the chrome"; landing on another PAGE element is the bug.
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await page.press("Tab");
    const where = await page.evaluate(() => {
      const dialog = document.getElementById("settings");
      const active = document.activeElement;
      return { inside: dialog.contains(active), html: active === document.body || active === document.documentElement, what: (active?.id || active?.tagName || "none") };
    });
    seen.push(where);
    assert.equal(where.inside || where.html, true, `Tab ${i + 1} landed on a page element outside the dialog: '${where.what}'`);
  }
  assert.ok(new Set(seen.filter((s) => s.inside).map((s) => s.what)).size >= 3, `focus never moved inside the dialog: ${JSON.stringify(seen)}`);
  assert.ok(seen.some((s) => s.inside), "focus never came back into the dialog");

  await page.press("Escape");
  await page.waitFor(() => document.getElementById("settings").open === false, { label: "the dialog to close" });
});

test("the page behind cannot scroll while it is open, and can again after", { timeout: 90000 }, async () => {
  await openSettings();
  const open = await state();
  assert.equal(open.htmlOverflow, "hidden", "the page behind a modal is still scrollable");

  // A REAL GESTURE, not window.scrollBy: `overflow: hidden` on the root stops user scrolling but
  // still permits programmatic scrolling (that is the documented difference from `overflow: clip`),
  // and "the page behind does not scroll" is a claim about the person, not about the script.
  // Measured before-and-after, because earlier checks in this suite legitimately scrolled the page.
  const beforeWheel = await page.evaluate(() => window.scrollY);
  await page.wheel(600);
  const afterWheel = await page.evaluate(() => window.scrollY);
  assert.equal(afterWheel, beforeWheel, `the page behind scrolled by ${afterWheel - beforeWheel}px on a wheel gesture while the modal was open`);

  await page.press("Escape");
  await page.waitFor(() => document.getElementById("settings").open === false, { label: "the dialog to close" });
  const closed = await state();
  assert.notEqual(closed.htmlOverflow, "hidden", "the page is still scroll-locked after the dialog closed");
  const beforeFree = await page.evaluate(() => window.scrollY);
  await page.wheel(400);
  const afterFree = await page.evaluate(() => window.scrollY);
  assert.ok(afterFree > beforeFree, "the page cannot scroll again after the dialog closed");
  await page.evaluate(() => window.scrollTo(0, 0));
});

test("it fits a phone: the dialog is inside the viewport, and it scrolls inside itself", { timeout: 90000 }, async () => {
  await page.emulateViewport({ width: 390, height: 844, mobile: true });
  await page.goto(`${BASE}/`);
  await openSettings();
  const view = await state();

  assert.ok(view.rect.top >= 0, `the dialog starts above the viewport (top ${view.rect.top})`);
  assert.ok(view.rect.bottom <= 844, `the dialog runs past the bottom of the phone viewport (bottom ${view.rect.bottom})`);
  assert.ok(view.rect.left >= 0 && view.rect.right <= 390, "the dialog is wider than the phone viewport");
  assert.ok(view.rect.height <= 844 * 0.86, `the dialog takes the whole screen (${view.rect.height} of 844)`);

  // A long list scrolls inside the dialog rather than pushing the dialog off the screen.
  const scrollsInside = await page.evaluate(async () => {
    const form = document.querySelector(".settings-form");
    const filler = document.createElement("div");
    filler.style.height = "200vh";
    form.appendChild(filler);
    const before = form.scrollTop;
    form.scrollBy(0, 300);
    await new Promise((r) => requestAnimationFrame(r));
    const after = form.scrollTop;
    const dialogRect = document.getElementById("settings").getBoundingClientRect();
    filler.remove();
    return { scrolled: after - before, stillInside: dialogRect.bottom <= window.innerHeight + 1, overscroll: getComputedStyle(form).overscrollBehavior };
  });
  assert.ok(scrollsInside.scrolled > 0, "a long settings list does not scroll inside the dialog");
  assert.equal(scrollsInside.stillInside, true, "the dialog grew past the viewport instead of scrolling inside itself");
  assert.equal(scrollsInside.overscroll, "contain", "scroll chaining from the dialog would move the page behind");

  await page.press("Escape");
  await page.clearViewport();
  await page.goto(`${BASE}/`);
});

test("the device rows still tell the truth inside the dialog", { timeout: 90000 }, async () => {
  // Seed a chosen microphone that is NOT present — the "unplugged" case the rows exist for — and let
  // the page's own render path say what happened. This is the behaviour that must survive the move
  // into a dialog: the panel is a container change, not a rewrite.
  await page.evaluate(() => {
    localStorage.setItem("voicebox.devices", JSON.stringify({ mic: { id: "mic-that-left", name: "Desk microphone" }, out: { id: "", name: "" } }));
  });
  await page.reload();
  await openSettings();

  const rows = await page.evaluate(() => {
    const dialog = document.getElementById("settings");
    const mic = document.getElementById("mic-select");
    const out = document.getElementById("out-select");
    return {
      dialogContainsRows: dialog.contains(mic) && dialog.contains(out),
      micOptions: mic.options.length,
      outOptions: out.options.length,
      micState: document.getElementById("mic-device-state").textContent,
      outState: document.getElementById("out-device-state").textContent,
      micLabel: document.getElementById("mic-label").textContent,
      outLabel: document.getElementById("out-label").textContent,
      // The three facts per DEVICE row — the dialog also carries the agent rows now (provider, voice,
      // personality), so this counts the two rows with device pickers rather than every `.device-row`.
      rows: [mic.closest(".device-row"), out.closest(".device-row")].map((row) => ({
        heading: row.querySelector("h3")?.textContent ?? null,
        picker: Boolean(row.querySelector("select")),
        state: row.querySelector(".device-state")?.textContent ?? null,
      })),
    };
  });

  assert.equal(rows.dialogContainsRows, true, "the device pickers are outside the dialog");
  assert.equal(rows.rows.length, 2, "the two device rows are not both inside the dialog");
  for (const row of rows.rows) {
    assert.ok(row.heading, "a device row lost its heading");
    assert.equal(row.picker, true, "a device row lost its picker");
    assert.ok(row.state && row.state.length > 0, `device row '${row.heading}' lost its state line`);
  }
  assert.match(rows.micLabel + rows.micState, /Desk microphone|not connected|not checked yet/, "the missing microphone is not named");
  assert.ok(rows.outState.length > 0, "the output row lost its state");

  await page.press("Escape");
  await page.waitFor(() => document.getElementById("settings").open === false, { label: "the dialog to close" });
  await page.evaluate(() => localStorage.removeItem("voicebox.devices"));
});
