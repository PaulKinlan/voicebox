// tests/dom-targets.test.mjs — bead voicebox-beads-sor.
//
// The guard that stops an element rebuild from deleting a writer's target:
//   Every static getElementById("...") / $("...") / querySelector("#...")
//   called by client JS must target an element that exists in the served HTML.
//
// Prevents the regression where a surface rebuild deleted #caption while
// public/live-voice.js onText was actively writing to it.
//
//   node --test tests/dom-targets.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

test("dom-targets: every element ID queried by client JS exists in the served HTML", () => {
  const indexHtml = readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const envHtml = readFileSync(path.join(PUBLIC, "environment.html"), "utf8");
  const allHtml = indexHtml + "\n" + envHtml;

  const htmlIds = new Set([...allHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  // Specifically assert #caption is present in index.html
  assert.ok(htmlIds.has("caption"), "index.html must contain #caption for live voice output text");

  // Client files served to browser that interact with the DOM
  const clientFiles = ["fused.js", "live-voice.js", "audio-client.js", "pip-mic.mjs"];

  // Elements created dynamically at runtime by client scripts before being queried
  const DYNAMICALLY_CREATED = new Set([
    "pip-open", // created dynamically in pip-mic.mjs:70
  ]);

  const missing = [];

  for (const f of clientFiles) {
    const code = readFileSync(path.join(PUBLIC, f), "utf8");

    // Match getElementById("literal") or $("literal")
    const reGet = /(?:getElementById|\$)\s*\(\s*["']([a-zA-Z0-9_-]+)["']\s*\)/g;
    for (const m of code.matchAll(reGet)) {
      const id = m[1];
      if (DYNAMICALLY_CREATED.has(id)) continue;
      if (!htmlIds.has(id)) {
        missing.push({ file: f, id, line: code.slice(0, m.index).split("\n").length });
      }
    }

    // Match querySelector("#literal") or querySelectorAll("#literal")
    const reQuery = /querySelector(?:All)?\s*\(\s*["']#([a-zA-Z0-9_-]+)["']\s*\)/g;
    for (const m of code.matchAll(reQuery)) {
      const id = m[1];
      if (DYNAMICALLY_CREATED.has(id)) continue;
      if (!htmlIds.has(id)) {
        missing.push({ file: f, id, line: code.slice(0, m.index).split("\n").length });
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Client scripts query DOM elements missing from served HTML: ${JSON.stringify(missing)}`,
  );
});
