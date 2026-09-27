// tests/wasm-room-ui.test.mjs — the extensions/tools view renders the admitted wasm shelf
// as its own callable-now section with descriptions and execution status (voicebox-beads-ri4k).
// Drives the real page in Chromium against the real isocan shelf (skipped without it).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const REAL_SHELF = path.join(os.homedir(), ".isocan", "modules", "wasm-tools");
const hasShelf = existsSync(REAL_SHELF);

test("wasm room ui: the shelf renders callable-now rows with descriptions, distinct from the catalogue", { skip: !hasShelf && "no isocan shelf installed on this box", timeout: 60000 }, async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-ri4k-ui-"));
  const root = path.join(scratch, "workspace");
  mkdirSync(root, { recursive: true });
  let server, page;
  try {
    server = await startServer({
      extensionsDir: path.join(scratch, "extensions"),
      env: { VOICEBOX_WORKSPACE: root, VOICEBOX_WASM_SHELF_DIR: REAL_SHELF },
    });
    page = await launch({ width: 1280, height: 900 });
    await page.goto(server.base);
    await page.waitFor(() => document.querySelector("#exts-open"));
    await page.click("#exts-open");
    await page.waitFor(() => document.querySelectorAll("#ext-shelf li").length > 0, { label: "shelf rows" });

    const shelf = await page.evaluate(() => ({
      rows: [...document.querySelectorAll("#ext-shelf li")].map((r) => r.innerText.replace(/\s+/g, " ").slice(0, 140)),
      callableCount: (document.querySelector("#ext-shelf").innerText.match(/Callable now/g) || []).length,
    }));
    assert.ok(shelf.rows.length >= 2, `the shelf section lists the admitted tools: ${JSON.stringify(shelf.rows)}`);
    assert.ok(shelf.callableCount >= 2, `the rows say CALLABLE NOW: ${JSON.stringify(shelf.rows)}`);
    assert.match(shelf.rows.join(" "), /hash/, "the hash tool is named");

    // The catalogue section must NOT re-list the shelf as a stranger awaiting review.
    const catalogueText = await page.evaluate(() => document.querySelector("#ext-catalogue")?.innerText ?? "");
    assert.doesNotMatch(catalogueText, /wasm-shelf-/, "the shelf must not be double-listed as catalogue strangers");

    await page.screenshot(path.join(scratch, "shelf-section.png"));
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (server) await server.stop(); } catch {}
  }
});
