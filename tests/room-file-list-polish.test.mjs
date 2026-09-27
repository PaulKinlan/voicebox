// tests/room-file-list-polish.test.mjs — four UI facts about the room's file list, driven.
//
// Paul asked for four polish items on 2026-09-26 (voicebox-beads-y4c2, io3a, 35eg, r2tn). All four are
// RENDERING facts, so prose cannot pin them — this drives the real page and measures the boxes:
//
//   y4c2 — a long name stays on ONE line and truncates with an ellipsis; a wrapped name makes its row
//          taller than its neighbours and breaks the grid's rhythm;
//   io3a — the delete control is a compact ICON **inside the file's card**, not a wide word beside it;
//   35eg — a folder is visually distinct (its own icon AND a tinted card), and a file never carries
//          the folder cue;
//   r2tn — the list is height-bounded and scrolls, so a full folder cannot push the room off screen.
//
//   node --test tests/room-file-list-polish.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A name long enough that the old rule (overflow-wrap: anywhere) would wrap it in a narrow card — the
// widest card the list builds is min(100%, 720px) and the acceptance harness renders it at 320px.
const LONG = "an-extremely-long-file-name-that-wants-two-lines-in-a-narrow-card-and-breaks-the-grid.txt";
const FILLERS = 20; // 20 cards at ~54px is well past the 40svh/24rem bound, so the list must scroll

let server;
let BASE;
let page;
let scratch;
let workspace;

async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await check();
    if (r) return r;
    await sleep(50);
  }
  assert.fail(`no ${label} within ${ms}ms`);
}

test.before(async () => {
  scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-room-polish-")));
  workspace = path.join(scratch, "root");
  mkdirSync(path.join(workspace, "assets"), { recursive: true });
  writeFileSync(path.join(workspace, LONG), "long\n");
  writeFileSync(path.join(workspace, "notes.txt"), "notes\n");
  for (let i = 0; i < FILLERS; i += 1) writeFileSync(path.join(workspace, `filler-${String(i).padStart(2, "0")}.txt`), `filler ${i}\n`);

  server = await startServer({ cwd: ROOT, env: { VOICEBOX_WORKSPACE: workspace, VOICEBOX_INSTANCE: "room-polish" } });
  BASE = server.base;
  page = await launch();
  await page.goto(`${BASE}/`);
  await until(() => page.evaluate(() => document.querySelector('.file-open[data-file="notes.txt"]') !== null), "the room to list the seeded files");
});

test.after(async () => {
  await page?.close();
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("y4c2: a long file name stays on ONE line and truncates, and its row is the same height as its neighbours", async () => {
  const facts = await page.evaluate((longName) => {
    const el = document.querySelector(`.file-open[data-file="${longName}"]`);
    const name = el.querySelector(".file-name");
    const cs = getComputedStyle(name);
    const neighbour = document.querySelector('.file-open[data-file="notes.txt"]');
    return {
      whiteSpace: cs.whiteSpace,
      textOverflow: cs.textOverflow,
      overflow: cs.overflow,
      lines: name.getClientRects().length,
      rowHeight: Math.round(el.getBoundingClientRect().height),
      neighbourHeight: Math.round(neighbour.getBoundingClientRect().height),
      text: name.textContent,
      truncated: name.scrollWidth > name.clientWidth + 1,
    };
  }, LONG);

  assert.equal(facts.whiteSpace, "nowrap", "the name must not be allowed to wrap");
  assert.equal(facts.textOverflow, "ellipsis", "a truncated name must say so with an ellipsis");
  assert.equal(facts.lines, 1, `the name rendered on ${facts.lines} lines`);
  assert.equal(facts.text, LONG, "truncation is a rendering fact — the element's text stays the disk's name, verbatim");
  assert.ok(facts.truncated, "the fixture must actually be longer than the card, or this test proves nothing");
  assert.equal(facts.rowHeight, facts.neighbourHeight, `the long row is ${facts.rowHeight}px against ${facts.neighbourHeight}px — a taller row is the broken grid`);
});

test("io3a: the delete control is a compact ICON inside the file's card, not a word beside it", async () => {
  const control = await page.evaluate(() => {
    const button = document.querySelector('.file-delete[data-file="notes.txt"]');
    const card = button.closest("li").querySelector('.file-open[data-file="notes.txt"]');
    const cb = card.getBoundingClientRect();
    const bb = button.getBoundingClientRect();
    const meta = card.querySelector(".file-meta").getBoundingClientRect();
    return {
      hasIcon: Boolean(button.querySelector("svg")),
      text: button.textContent.trim(),
      label: button.getAttribute("aria-label"),
      inside: bb.left >= cb.left - 1 && bb.right <= cb.right + 1 && bb.top >= cb.top - 1 && bb.bottom <= cb.bottom + 1,
      width: Math.round(bb.width),
      height: Math.round(bb.height),
      noOverlap: meta.right <= bb.left + 1,
      folderHasNone: document.querySelector('.file-delete[data-file="assets"]') === null,
    };
  });

  assert.equal(control.hasIcon, true, "the control must be an icon");
  assert.equal(control.text, "", "an icon button must not also shout a word");
  assert.match(control.label, /^Delete notes\.txt$/, "the accessible name must still carry the file's name");
  assert.equal(control.inside, true, "the control must sit INSIDE the file's card (Paul: inside the file name div)");
  assert.ok(control.width <= 48 && control.height <= 48, `compact means compact — got ${control.width}x${control.height}`);
  assert.equal(control.noOverlap, true, "the card must reserve the control's lane, or the size would collide with the name");
  assert.equal(control.folderHasNone, true, "folders still have no delete control (no recursive delete in this bead)");
});

test("35eg: a folder's glyph is PAINTED (stroked with the accent, never filled black) in BOTH themes, and a file never wears the cue", async () => {
  const look = await page.evaluate(() => {
    const folder = document.querySelector('.file-open[data-kind="directory"]');
    const file = document.querySelector('.file-open[data-file="notes.txt"]');
    const icon = folder.querySelector("svg");
    const ic = getComputedStyle(icon);
    const accent = getComputedStyle(folder.querySelector(".file-meta")).color; // the same row resolves var(--accent) here
    return {
      folderIcon: Boolean(icon),
      fileIcon: Boolean(file.querySelector("svg use")),
      fill: ic.fill,
      stroke: ic.stroke,
      strokeWidthPx: parseFloat(ic.strokeWidth),
      accent,
      folderBackground: getComputedStyle(folder).backgroundColor,
      fileBackground: getComputedStyle(file).backgroundColor,
      folderBorder: getComputedStyle(folder).borderTopColor,
      fileBorder: getComputedStyle(file).borderTopColor,
      folderName: folder.querySelector(".file-name").textContent,
      folderLabel: folder.getAttribute("aria-label"),
    };
  });

  assert.equal(look.folderIcon, true, "a folder needs a cue that survives greyscale — the icon");
  // PAINTED, not merely present. A glyph with no fill:none/stroke inherits the SVG default: the path
  // FILLS, paints black, and disappears against a dark card. The reviewer of the parallel 35eg branch
  // found exactly that; these assertions are the shape they asked for, measured on the element itself.
  assert.equal(look.fill, "none", "the glyph must be STROKED — a filled path paints black by default");
  assert.notEqual(look.stroke, "none", "the glyph must have a stroke colour");
  assert.equal(look.stroke, look.accent, "the stroke must resolve to the accent this very row already uses");
  assert.ok(look.strokeWidthPx > 0, `the stroke needs a width — got ${look.strokeWidthPx}`);
  assert.equal(look.fileIcon, false, "a file row must not wear the folder's icon");
  assert.notEqual(look.folderBackground, look.fileBackground, "the folder card must be visually distinct, not just bold");
  assert.notEqual(look.folderBorder, look.fileBorder, "the folder's border must differ too");
  assert.equal(look.folderName, "assets", "the folder's name stays the disk's name, verbatim");
  assert.match(look.folderLabel, /folder$/, "and the accessible name says folder");

  // THE FAILURE MODE IS THEME-DEPENDENT, so prove the paint in the dark theme too: the same glyph must
  // take the DARK theme's accent (the page's accent changes with the theme), and be stroked, not filled.
  const dark = await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    const folder = document.querySelector('.file-open[data-kind="directory"]');
    const ic = getComputedStyle(folder.querySelector("svg"));
    return {
      fill: ic.fill,
      stroke: ic.stroke,
      accent: getComputedStyle(folder.querySelector(".file-meta")).color,
      card: getComputedStyle(folder).backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
    };
  });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

  assert.equal(dark.fill, "none", "dark mode must not turn the glyph into a filled shape");
  assert.equal(dark.stroke, dark.accent, "in dark mode the glyph must take the dark theme's accent, not the SVG default");
  assert.notEqual(dark.stroke, dark.page, "the stroke must not match the page background — that is the glyph vanishing");
});

test("r2tn: the list is height-bounded and scrolls instead of pushing the room off screen", async () => {
  const bound = await page.evaluate(() => {
    const list = document.getElementById("files");
    const cs = getComputedStyle(list);
    const r = list.getBoundingClientRect();
    return {
      overflowY: cs.overflowY,
      height: Math.round(r.height),
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      cards: document.querySelectorAll("#files .file-open").length,
      cap: Math.round(Math.min(window.innerHeight * 0.4, 384)),
    };
  });

  assert.ok(bound.cards >= FILLERS, `the fixture must fill the list (${bound.cards} cards)`);
  assert.equal(bound.overflowY, "auto", "the list must scroll rather than grow");
  assert.ok(bound.height <= bound.cap + 1, `the list is ${bound.height}px against a ${bound.cap}px bound`);
  assert.ok(bound.scrollHeight > bound.clientHeight, "with this many files the list must actually scroll — otherwise it grew, or it hid rows silently");
});

test("t3gq: every JS-built decorative glyph in the list is aria-hidden, matching the page's static convention", async () => {
  const icons = await page.evaluate(() => {
    const all = [...document.querySelectorAll("#files .icon")];
    return {
      total: all.length,
      hidden: all.filter((el) => el.getAttribute("aria-hidden") === "true").length,
      staticSpriteUses: [...document.querySelectorAll('svg[aria-hidden="true"] use')].length > 0,
    };
  });
  assert.ok(icons.total > 0, "the fixture must render icons, or this test proves nothing");
  assert.equal(icons.hidden, icons.total, "every glyph the icon() helper builds must be hidden from the accessibility tree");
});
