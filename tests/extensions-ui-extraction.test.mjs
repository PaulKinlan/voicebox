// tests/extensions-ui-extraction.test.mjs — the extension surface is a module now
// (voicebox-beads-v25a), and this file holds the two ways that can go wrong quietly.
//
// WHAT THIS FILE DOES AND DOES NOT PROVE. Correction (voicebox-beads-w1f9, found by an
// independent review of this very file): an earlier version re-initialised the module with its
// OWN stub accessor, which only proves the module re-calls whatever accessor it is handed. It
// stayed GREEN when fused.js passed a stale `new Map(lastToolStatus)` snapshot — i.e. against the
// exact mutant coord's Stage 2 GO asked for. A control that cannot fail for the real wiring is not
// a control. So the liveness assertions now run against the REAL PAGE: fused.js's own wiring, its
// own map, and the room loop's own hook. The module-side check remains only as a narrower unit
// assertion, and it makes no claim about integration.
//
// 1. LISTENER OMISSION. If the surface is extracted but never wired, every assertion that reads
//    rendered rows still passes — the rows are whatever the last render left behind — while the
//    dialog stops opening. So the assertion that bites is the dialog-open one.
//
// 2. LATE TOOL-STATUS SNAPSHOT, driven end to end. getToolStatus() feeds the WASM shelf's latency
//    readout. If the accessor is captured rather than read, the readout freezes on its first value
//    while everything else stays green. The test drives the page's own __voiceboxOnToolCalls twice
//    with different durations and requires the rendered row to follow.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

// The readout needs an admitted shelf entry, and the real isocan shelf is not installed on every
// box (its absence is why tests/wasm-room-ui.test.mjs skips). This fabricates the one row the
// readout attaches to, so the integration control runs everywhere rather than skipping.
const FAKE_SHELF = {
  id: "wasm-shelf-demo",
  name: "demo tool",
  source: "wasm-shelf",
  tools: ["echo"],
  toolDetails: [{ name: "echo", description: "echoes what it is given" }],
};

const STUB_EXTENSIONS = () => {
  const real = window.fetch.bind(window);
  window.__v25aRealFetch = real;
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    const json = (body) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    if (url.includes("/api/extensions/catalogue")) return json({ catalogue: [] });
    if (url.includes("/api/extensions")) return json({ extensions: [window.__v25aShelf] });
    return real(input, init);
  };
};

test("extensions ui extraction: the real wired page reads tool status live, not once (w1f9)", async () => {
  const server = await startServer();
  let page;
  try {
    page = await launch({ width: 1280, height: 900 });
    await page.goto(server.base);
    await page.waitFor(() => document.querySelector("#exts-open"));

    // --- 1. POSITIVE: the wired page opens its dialog.
    const wired = await page.evaluate(async () => {
      const dlg = document.getElementById("exts");
      document.getElementById("exts-open").click();
      await new Promise((r) => setTimeout(r, 400));
      return { open: dlg.open };
    });
    assert.equal(wired.open, true, "the wired surface must open its dialog");

    // --- 2. NEGATIVE (listener omission): same click, listeners dropped. Must NOT open.
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

    // --- 3. INTEGRATION LIVENESS on the real page: fused.js's wiring, its map, the room's hook.
    await page.evaluate((shelf) => {
      window.__v25aShelf = shelf;
    }, FAKE_SHELF);
    await page.evaluate(STUB_EXTENSIONS);

    await page.waitFor(() => typeof window.__voiceboxOnToolCalls === "function", {
      label: "the page hook window.__voiceboxOnToolCalls is ready",
    });

    // Drive the page's OWN hook - the seam live-voice.js forwards to - so fused.js's
    // lastToolStatus is written by fused.js's own code, not by the test.
    await page.evaluate(() => {
      window.__voiceboxOnToolCalls(
        [{ name: "echo", ok: true }],
        { calls: [{ name: "echo", ok: true, durationMs: 21 }] },
      );
    });

    await page.click("#exts-open");
    await page.waitFor(
      () => /21ms/.test(document.querySelector("#ext-shelf")?.innerText ?? ""),
      { label: "the shelf readout shows the first measured latency (21ms)", timeout: 8000 },
    );

    // The host runs the tool again. Only fused.js's map changes; nothing re-initialises.
    await page.evaluate(() => {
      window.__voiceboxOnToolCalls(
        [{ name: "echo", ok: true }],
        { calls: [{ name: "echo", ok: true, durationMs: 99 }] },
      );
    });
    await page.waitFor(
      () => /99ms/.test(document.querySelector("#ext-shelf")?.innerText ?? ""),
      { label: "the readout follows the SECOND run (99ms) through the real wiring", timeout: 8000 },
    );

    const rendered = await page.evaluate(
      () => document.querySelector("#ext-shelf")?.innerText.replace(/\s+/g, " ") ?? "",
    );
    assert.match(
      rendered,
      /99ms/,
      `the real page must show the updated latency: ${rendered}`,
    );
    assert.doesNotMatch(
      rendered,
      /21ms/,
      `the stale value must be gone after the second run: ${rendered}`,
    );

    // --- 4. NARROW UNIT CHECK, no integration claim: given a live accessor the module re-calls it.
    // It needs the full element map the real page provides, because renderExtensions renders every
    // section; a partial els map makes it return without touching the shelf, which would look like a
    // liveness failure when it is nothing of the sort.
    const unit = await page.evaluate(async () => {
      const mod = await import("/extensions-ui.mjs");
      let reads = 0;
      const statuses = new Map([["echo", { ok: true, at: Date.now(), durationMs: 7 }]]);
      const els = {};
      for (const [key, id] of Object.entries({
        extShelf: "ext-shelf",
        extCatalogue: "ext-catalogue",
        extRunning: "ext-running",
        extFailed: "ext-failed",
        extWaiting: "ext-waiting",
        extPresent: "ext-present",
        extRefused: "ext-refused",
        extCount: "exts-count",
        extNote: "ext-note",
      }))
        els[key] = document.getElementById(id);
      mod.initExtensionsUI({
        els,
        request: async (url) =>
          String(url).includes("catalogue")
            ? { catalogue: [] }
            : { extensions: [window.__v25aShelf] },
        on: () => {},
        installLightDismissFallback: () => {},
        getToolStatus: (name) => {
          reads += 1;
          return statuses.get(name) ?? null;
        },
      });
      await mod.renderExtensions();
      const first = document.getElementById("ext-shelf").innerText ?? "";
      return { first, reads };
    });
    assert.match(unit.first, /7ms/, `the module renders whatever it is handed: ${unit.first}`);
    assert.ok(unit.reads > 0, "the module must call the injected accessor while rendering");
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      await server.stop();
    } catch {}
  }
});
