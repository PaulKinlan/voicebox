// tests/extensions-ui-extraction.test.mjs — the extension surface is a real module now
// (voicebox-beads-v25a), and the two ways a module extraction silently breaks are both held here.
//
// 1. LISTENER OMISSION. If the surface is extracted but never wired, every assertion that reads
//    rendered rows still passes — the rows are whatever the last render left behind — while the
//    dialog stops opening. So the assertion that bites is the dialog-open one, and it is tested by
//    detaching the trigger's listeners at runtime and re-driving the same click.
//
// 2. LATE TOOL-STATUS SNAPSHOT. getToolStatus() feeds the WASM shelf's latency readout. It is
//    injected by fused.js, which owns the map. An extraction that passed the STATUS OBJECT or a
//    snapshot of the map instead of a live accessor would look green everywhere, including in the
//    existing shelf test, while the readout froze on its first value forever. The test therefore
//    renders, mutates the map behind the module's back, renders again, and requires the readout to
//    follow. Nothing here depends on the isocan shelf being installed: the status path is driven
//    through the module's own request boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("extensions ui extraction: the surface is wired, and reads tool status live rather than once", async () => {
  const server = await startServer();
  let page;
  try {
    page = await launch({ width: 1280, height: 900 });
    await page.goto(server.base);
    await page.waitFor(() => document.querySelector("#exts-open"));

    // --- 1. POSITIVE: the wired surface opens its dialog.
    const wired = await page.evaluate(async () => {
      const dlg = document.getElementById("exts");
      document.getElementById("exts-open").click();
      await new Promise((r) => setTimeout(r, 400));
      return { open: dlg.open };
    });
    assert.equal(wired.open, true, "the wired surface must open its dialog");

    // --- 2. NEGATIVE (listener omission): same click, listeners removed. Must NOT open.
    const omitted = await page.evaluate(async () => {
      const dlg = document.getElementById("exts");
      dlg.close();
      const trigger = document.getElementById("exts-open");
      const clone = trigger.cloneNode(true); // drops every addEventListener the surface installed
      trigger.replaceWith(clone);
      clone.click();
      await new Promise((r) => setTimeout(r, 400));
      return { open: dlg.open };
    });
    assert.equal(
      omitted.open,
      false,
      "with the surface's listeners absent the dialog must NOT open - if this fails the open " +
        "assertion above is vacuous and the extraction could be unwired behind a green suite",
    );

    // --- 3. LIVENESS: tool status crosses by accessor, and the accessor must be read per render.
    const liveness = await page.evaluate(async () => {
      const mod = await import("/extensions-ui.mjs");
      const els = {
        extShelf: document.getElementById("ext-shelf"),
        extCatalogue: document.getElementById("ext-catalogue"),
        extRunning: document.getElementById("ext-running"),
        extFailed: document.getElementById("ext-failed"),
        extWaiting: document.getElementById("ext-waiting"),
        extPresent: document.getElementById("ext-present"),
        extRefused: document.getElementById("ext-refused"),
        extCount: document.getElementById("exts-count"),
        extNote: document.getElementById("ext-note"),
      };
      // Stands in for fused.js's map, and is mutated BEHIND the module to prove it re-reads.
      const statuses = new Map();
      let reads = 0;
      const shelfEntry = {
        id: "wasm-shelf-demo",
        name: "demo tool",
        source: "wasm-shelf",
        tools: ["echo"],
        toolDetails: [{ name: "echo", description: "echoes what it is given" }],
      };
      mod.initExtensionsUI({
        els,
        request: async (url) =>
          String(url).includes("catalogue") ? { catalogue: [] } : { extensions: [shelfEntry] },
        on: () => {},
        installLightDismissFallback: () => {},
        // Deliberately a FUNCTION reading the live map. A snapshot here is the mutant this catches.
        getToolStatus: (name) => {
          reads += 1;
          return statuses.get(name) ?? null;
        },
      });

      statuses.set("echo", { ok: true, at: Date.now(), durationMs: 21 });
      await mod.renderExtensions();
      const first = document.getElementById("ext-shelf").textContent ?? "";
      const readsAfterFirst = reads;

      // The host executes the tool again while the module sits idle. The map changes, nothing else.
      reads = 0;
      statuses.set("echo", { ok: true, at: Date.now(), durationMs: 99 });
      await mod.renderExtensions();
      const second = document.getElementById("ext-shelf").textContent ?? "";

      return { first, second, readsAfterFirst, readsAfterSecond: reads };
    });

    assert.match(liveness.first, /21ms/, `first render must show the measured latency: ${liveness.first}`);
    assert.match(
      liveness.second,
      /99ms/,
      `second render must show the UPDATED latency - if it still reads 21ms the accessor was ` +
        `captured once instead of read live: ${liveness.second}`,
    );
    assert.doesNotMatch(
      liveness.second,
      /21ms/,
      `the stale value must be gone after the status changes: ${liveness.second}`,
    );
    assert.ok(
      liveness.readsAfterSecond > 0,
      "the accessor must be called on every render, not memoised at init",
    );
  } finally {
    await page?.close();
    await server.stop();
  }
});
