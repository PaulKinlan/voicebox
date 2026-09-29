// tests/room-folder-doors.test.mjs — the drawer's doors and its drop target, measured in the room.
//
//   node --test tests/room-folder-doors.test.mjs
//
//   voicebox-beads-9rua — `#open-folder`, `#open-opfs-folder` and `#close-folder` are the affordances that
//   decide what the file list IS, and they read as stray text: `.quiet` is the page's resting button, which
//   is right in a header row and wrong beside a list of cards. They now wear the card shape — an edge, the
//   card surface, the one hover tint — and the two folder doors carry the folder glyph. Asserted as
//   COMPUTED STYLE on the running page rather than as class names in the source: the claim is what a person
//   sees, and a class that renders nothing would satisfy the source-level version of this test.
//
//   voicebox-beads-n4kw — while a directory is dragged over the workspace the target must be unmistakable
//   (a dashed ring, a tint, a glow, and copy that says what dropping does) and it must leave cleanly. The
//   old handler removed the cue on ANY `dragleave`, including the one the platform delivers as the pointer
//   crosses onto a CHILD of the panel — so the cue flickered while the folder was still over the page. The
//   fix counts the drag (enter/leave, balancing across children) and treats a leave with nowhere to go as a
//   leave from the panel. Both halves are driven here, plus a REAL drop through CDP's platform drag path —
//   which is also how this test gets a directory handle without a native picker dialog.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
let root;
let dropped;

test.before(async () => {
  // A scratch root with one file: the room is in its writable state, and there is a real `.file-open` card
  // to compare the buttons' surface against.
  root = mkdtempSync(path.join(os.tmpdir(), "voicebox-doors-root-"));
  writeFileSync(path.join(root, "notes.txt"), "a note\n");
  dropped = mkdtempSync(path.join(os.tmpdir(), "voicebox-doors-dropped-"));
  mkdirSync(path.join(dropped, "inner"), { recursive: true });
  writeFileSync(path.join(dropped, "dropped-in.txt"), "opened by the drop\n");
  server = await startServer({ env: { VOICEBOX_INSTANCE: "folder-doors", VOICEBOX_WORKSPACE: root } });
});

test.after(async () => {
  await server?.stop?.();
  for (const dir of [root, dropped]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The centre of an element, scrolled into view — a real drag needs real viewport coordinates. */
const centreOf = (page, id) =>
  page.evaluate((elementId) => {
    const node = document.getElementById(elementId);
    node.scrollIntoView({ block: "center", inline: "center" });
    const box = node.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }, id);

test("the folder doors wear the card shape and the folder glyph, and stay usable at phone width", { timeout: 90000 }, async () => {
  const page = await launch({ width: 1100, height: 900 });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => document.querySelector(".file-open[data-file='notes.txt']"), { label: "the room's listing" });

    // ── THE GLYPH AND THE CLASS, as the DOM and as the paint ──────────────────
    const doors = await page.evaluate(() => {
      const read = (id) => {
        const el = document.getElementById(id);
        const style = getComputedStyle(el);
        return {
          hidden: el.hidden,
          quiet: el.classList.contains("quiet"),
          icons: [...el.querySelectorAll("svg.icon use")].map((u) => u.getAttribute("href")),
          borderStyle: style.borderTopStyle,
          borderWidth: style.borderTopWidth,
          background: style.backgroundColor,
          colour: style.color,
          height: Math.round(el.getBoundingClientRect().height),
        };
      };
      return {
        open: read("open-folder"),
        scratch: read("open-opfs-folder"),
        close: read("close-folder"),
        card: getComputedStyle(document.querySelector(".file-open")).backgroundColor,
        wrap: getComputedStyle(document.getElementById("room-folder-row")).flexWrap,
        accent: getComputedStyle(document.getElementById("new-file")).color,
      };
    });

    for (const [name, door] of [["#open-folder", doors.open], ["#open-opfs-folder", doors.scratch]]) {
      assert.equal(door.hidden, false, `${name} is hidden in a browser with a picker`);
      assert.equal(door.quiet, true, `${name} is not a .quiet button`);
      assert.deepEqual(door.icons, ["#i-folder"], `${name} does not carry the stroked folder glyph — got ${JSON.stringify(door.icons)}`);
      assert.equal(door.borderStyle, "solid", `${name} has no edge — border-style ${door.borderStyle}`);
      assert.equal(door.borderWidth, "1px", `${name} has no 1px edge — border-width ${door.borderWidth}`);
      assert.equal(door.background, doors.card, `${name} does not sit on the same surface as the file cards (${door.background} vs ${doors.card})`);
      assert.ok(door.height >= 44, `${name} is ${door.height}px tall — under the page's 44px target`);
    }
    // The way back is a route, not a folder: it wears the shape and no glyph.
    assert.equal(doors.close.quiet, true, "#close-folder is not a .quiet button");
    assert.equal(doors.close.borderStyle, "solid", "#close-folder has no edge");
    assert.deepEqual(doors.close.icons, [], "#close-folder wears a folder glyph it does not open");
    assert.equal(doors.wrap, "wrap", "the row does not wrap, so two doors cannot share a phone line");

    // ── THE HOVER TINT, from a real pointer ──────────────────────────────────
    const rest = await page.evaluate(() => {
      const style = getComputedStyle(document.getElementById("open-folder"));
      return { colour: style.color, background: style.backgroundColor };
    });
    const at = await centreOf(page, "open-folder");
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await page.waitFor(
      (expected) => getComputedStyle(document.getElementById("open-folder")).color !== expected,
      { args: [rest.colour], label: "the door to answer the pointer" },
    );
    const hovered = await page.evaluate(() => {
      const style = getComputedStyle(document.getElementById("open-folder"));
      return { colour: style.color, background: style.backgroundColor };
    });
    assert.notEqual(hovered.background, rest.background, "hovering changes the words and not the surface");
    assert.notEqual(hovered.colour, rest.colour, "hovering does not tint the words");

    // ── PHONE WIDTH: the row wraps and nothing leaves the viewport ────────────
    await page.emulateViewport({ width: 380, height: 780 });
    const phone = await page.evaluate(() => {
      const row = document.getElementById("room-folder-row");
      return [...row.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => {
        const box = b.getBoundingClientRect();
        return { id: b.id, left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
      });
    });
    for (const button of phone) {
      assert.ok(button.left >= 0, `${button.id} starts ${-button.left}px off the left edge at 380px wide`);
      assert.ok(button.right <= 380, `${button.id} runs to ${button.right}px in a 380px viewport`);
    }
    await page.clearViewport();
  } finally {
    await page.close();
  }
});

test("the drop target glows while a folder is over the panel, survives a move onto a child, and leaves when the drag does", { timeout: 90000 }, async () => {
  const page = await launch({ width: 1100, height: 900 });
  try {
    await page.goto(`${server.base}/`);
    await page.waitFor(() => document.querySelector(".file-open[data-file='notes.txt']"), { label: "the room's listing" });

    // A REAL drag enters the panel (CDP's platform drag path; no drop yet, so the folder is not adopted).
    const at = await centreOf(page, "made-list");
    const data = { items: [], files: [dropped], dragOperationsMask: 1 };
    await page.send("Input.dispatchDragEvent", { type: "dragEnter", x: at.x, y: at.y, data });
    await page.send("Input.dispatchDragEvent", { type: "dragOver", x: at.x, y: at.y, data });
    await page.waitFor(() => document.getElementById("made-list").classList.contains("dropping"), { label: "the drop cue over the panel" });

    const lit = await page.evaluate(() => {
      const made = document.getElementById("made-list");
      const style = getComputedStyle(made);
      return {
        hintShown: document.getElementById("drop-hint").hidden === false,
        hint: document.getElementById("drop-hint").textContent.trim(),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        background: style.backgroundColor,
        shadow: style.boxShadow,
      };
    });
    assert.equal(lit.hintShown, true, "the drop copy is not shown while a folder is over the panel");
    assert.match(lit.hint, /drop the folder/i, `the drop copy does not say what dropping does: ${JSON.stringify(lit.hint)}`);
    assert.equal(lit.outlineStyle, "dashed", `the target has no dashed ring — outline-style ${lit.outlineStyle}`);
    assert.equal(lit.outlineWidth, "2px", `the ring is ${lit.outlineWidth}, not the 2px the cue promises`);
    assert.notEqual(lit.shadow, "none", "the target has no glow");
    await page.waitFor(
      () => getComputedStyle(document.getElementById("made-list")).backgroundColor !== "rgba(0, 0, 0, 0)",
      { label: "the backdrop tint to arrive" },
    );

    // ── A MOVE ONTO A CHILD IS NOT A LEAVE (the flicker the bead is about) ────
    const moved = await page.evaluate(() => {
      const made = document.getElementById("made-list");
      const row = document.querySelector(".file-open");
      // The enter/leave pair a real drag delivers when the pointer crosses a card: balanced, and inside
      // the panel — so the cue must stay exactly as it was.
      row.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, relatedTarget: document.getElementById("file-count") }));
      row.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, relatedTarget: document.getElementById("file-count") }));
      return { dropping: made.classList.contains("dropping"), hintShown: document.getElementById("drop-hint").hidden === false };
    });
    assert.deepEqual(moved, { dropping: true, hintShown: true }, `the cue left while the folder was still over the panel: ${JSON.stringify(moved)}`);

    // ── A LEAVE WITH NOWHERE TO GO CLEARS IT, and the resting style is restored ──
    const left = await page.evaluate(() => {
      const made = document.getElementById("made-list");
      made.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true })); // relatedTarget null: off the page
      const style = getComputedStyle(made);
      return { dropping: made.classList.contains("dropping"), hintShown: document.getElementById("drop-hint").hidden === false, outlineStyle: style.outlineStyle, background: style.backgroundColor };
    });
    assert.equal(left.dropping, false, "the cue stayed after the drag left the panel");
    assert.equal(left.hintShown, false, "the drop copy stayed after the drag left the panel");
    assert.equal(left.outlineStyle, "none", `the ring survived the drag — outline-style ${left.outlineStyle}`);
    await page.waitFor(() => getComputedStyle(document.getElementById("made-list")).backgroundColor === "rgba(0, 0, 0, 0)", { label: "the tint to leave with the drag" });

    // ── AND A REAL DROP ADOPTS THE FOLDER, clearing the cue on the way ───────
    await page.dropFolder("#made-list", dropped);
    await page.waitFor(() => document.querySelector(".folder-chip[data-folder]") !== null, { label: "the dropped folder to be adopted" });
    const after = await page.evaluate(() => ({
      dropping: document.getElementById("made-list").classList.contains("dropping"),
      hintShown: document.getElementById("drop-hint").hidden === false,
      cards: [...document.querySelectorAll("#files .file-open")].map((b) => b.dataset.path),
    }));
    assert.equal(after.dropping, false, "the cue survived the drop");
    assert.equal(after.hintShown, false, "the drop copy survived the drop");
    assert.ok(after.cards.includes("dropped-in.txt"), `the dropped folder's files are not listed: ${JSON.stringify(after.cards)}`);
  } finally {
    await page.close();
  }
});
