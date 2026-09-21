// tests/live-caption-ui.test.mjs — bead voicebox-beads-sor.
//
// Drives the restored #caption element across 5 viewports (desktop, mobile 360/390/430, landscape 844x390),
// verifies layout positioning above the mic, asserts zero horizontal overflow, and captures evidence.
//
//   node --test tests/live-caption-ui.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { launch } from "./lib/cdp.mjs";
import { startServer } from "./lib/server.mjs";

const EVIDENCE_DIR = "/home/paulkinlan/cap-evidence/voicebox-sor-20260921";
mkdirSync(EVIDENCE_DIR, { recursive: true });

const VIEWPORTS = [
  { name: "desktop-1200x800", width: 1200, height: 800, mobile: false },
  { name: "mobile-360x640", width: 360, height: 640, mobile: true },
  { name: "mobile-390x844", width: 390, height: 844, mobile: true },
  { name: "mobile-430x932", width: 430, height: 932, mobile: true },
  { name: "landscape-844x390", width: 844, height: 390, mobile: true },
];

test("live-caption: #caption renders output text properly across all viewports without overflow", async () => {
  const server = await startServer({ env: { VOICEBOX_PROVIDER: "script" } });
  const page = await launch({ fakeMedia: true });

  try {
    await page.goto(server.base);
    await page.waitFor(() => document.querySelector("#server-dot")?.getAttribute("data-ok") === "true", {
      label: "page loaded",
    });

    for (const vp of VIEWPORTS) {
      if (vp.mobile) {
        await page.emulateViewport({ width: vp.width, height: vp.height, mobile: true });
      } else {
        await page.clearViewport();
      }

      // Reset caption to empty before testing load state for this viewport
      await page.evaluate(() => {
        const el = document.querySelector("#caption");
        if (el) el.textContent = "";
      });

      // 1. Initial state: caption element is display:none, while caption-space reserves the slot
      const initial = await page.evaluate(() => {
        const el = document.querySelector("#caption");
        const space = document.querySelector(".caption-space");
        return {
          exists: Boolean(el),
          text: el?.textContent ?? "",
          display: el ? getComputedStyle(el).display : "none",
          height: el ? el.getBoundingClientRect().height : 0,
          spaceMinHeight: space ? parseFloat(getComputedStyle(space).minHeight) : 0,
        };
      });
      assert.ok(initial.exists, `#caption must exist in DOM at ${vp.name}`);
      assert.equal(initial.text, "", `#caption must be empty on load at ${vp.name}`);
      assert.equal(initial.display, "none", `#caption:empty must have display:none on load at ${vp.name}`);
      assert.equal(initial.height, 0, `#caption:empty must have 0 height at ${vp.name}`);
      assert.ok(
        initial.spaceMinHeight >= 24,
        `.caption-space must reserve slot (min-height >= 24px, observed ${initial.spaceMinHeight}px) so mic does not jump at ${vp.name}`,
      );

      // 2. Simulate live output text arriving
      const sampleText = "I made a file called notes.md with the first thing I noticed today.";
      await page.evaluate((text) => {
        const el = document.querySelector("#caption");
        if (el) el.textContent = text;
      }, sampleText);

      // 3. Inspect geometry and layout bounds
      const metrics = await page.evaluate(() => {
        const caption = document.querySelector("#caption");
        const micWrap = document.querySelector("#voice-ring-wrap");
        const stage = document.querySelector(".stage");
        const body = document.body;

        const capBox = caption.getBoundingClientRect();
        const micBox = micWrap.getBoundingClientRect();

        return {
          text: caption.textContent,
          capTop: capBox.top,
          capBottom: capBox.bottom,
          micTop: micBox.top,
          capHeight: capBox.height,
          capWidth: capBox.width,
          stageScrollWidth: stage.scrollWidth,
          stageClientWidth: stage.clientWidth,
          bodyScrollWidth: body.scrollWidth,
          bodyClientWidth: body.clientWidth,
          isAboveMic: capBox.bottom <= micBox.top + 10, // caption positioned above mic
        };
      });

      assert.equal(metrics.text, sampleText, `caption text must match at ${vp.name}`);
      assert.ok(metrics.capHeight > 0, `caption must have positive height when text is present at ${vp.name}`);
      assert.ok(metrics.isAboveMic, `#caption (bottom: ${metrics.capBottom}) must sit above mic stage (top: ${metrics.micTop}) at ${vp.name}`);
      assert.ok(
        metrics.bodyScrollWidth <= metrics.bodyClientWidth,
        `No horizontal overflow on body at ${vp.name} (scroll: ${metrics.bodyScrollWidth}, client: ${metrics.bodyClientWidth})`,
      );

      // Screenshot evidence
      await page.screenshot(path.join(EVIDENCE_DIR, `caption-${vp.name}.png`));
    }
  } finally {
    await page.close();
    await server.stop();
  }
});
