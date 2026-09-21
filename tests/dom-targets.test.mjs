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
import { existsSync, readFileSync } from "node:fs";
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
  assert.ok(clientFiles.length >= 3, "must specify at least 3 client files to guard");

  // Elements created dynamically at runtime by client scripts before being queried.
  // Every entry MUST provide a concrete why (>=20 chars) stating where and how it is created.
  const DYNAMICALLY_CREATED = [
    {
      id: "pip-open",
      why: "Created dynamically in pip-mic.mjs:70 via document.createElement('button') before DOM attach",
    },
  ];

  for (const entry of DYNAMICALLY_CREATED) {
    assert.ok(entry.id && typeof entry.id === "string", "each dynamic entry must have a string id");
    assert.ok(
      typeof entry.why === "string" && entry.why.length >= 20,
      `dynamic entry '${entry.id}' must provide a concrete why (>=20 chars), got '${entry.why}'`,
    );
  }
  const dynamicIds = new Set(DYNAMICALLY_CREATED.map((e) => e.id));

  const targetMap = new Map();
  const missing = [];
  let scannedFiles = 0;

  for (const f of clientFiles) {
    const filePath = path.join(PUBLIC, f);
    assert.ok(existsSync(filePath), `client file ${f} must exist under public/`);
    const code = readFileSync(filePath, "utf8");
    scannedFiles++;

    const recordTarget = (id, line) => {
      if (!id || dynamicIds.has(id)) return;
      // Skip hex colors (e.g. #fff, #141c34) if any matched standalone hash pattern
      if (/^[0-9a-fA-F]{3,8}$/.test(id)) return;
      if (!targetMap.has(id)) targetMap.set(id, new Set());
      targetMap.get(id).add(`${f}:${line}`);
      if (!htmlIds.has(id)) {
        missing.push({ file: f, id, line });
      }
    };

    // Pattern 1: getElementById("literal") or $("literal") or $("#literal")
    // Supports single quotes, double quotes, and backticks, with optional leading '#'
    const reGet = /(?:getElementById|\$)\s*\(\s*["'`]#?([a-zA-Z0-9_-]+)["'`]\s*\)/g;
    for (const m of code.matchAll(reGet)) {
      const line = code.slice(0, m.index).split("\n").length;
      recordTarget(m[1], line);
    }

    // Pattern 2: querySelector("#literal") or querySelectorAll("#literal")
    // Supports single quotes, double quotes, and backticks
    const reQuery = /querySelector(?:All)?\s*\(\s*["'`]#([a-zA-Z0-9_-]+)["'`]\s*\)/g;
    for (const m of code.matchAll(reQuery)) {
      const line = code.slice(0, m.index).split("\n").length;
      recordTarget(m[1], line);
    }

    // Pattern 3: String concatenation ('#' + "literal" or "#" + 'literal')
    const reConcat = /["'`]#["'`]\s*\+\s*["'`]#?([a-zA-Z0-9_-]+)["'`]/g;
    for (const m of code.matchAll(reConcat)) {
      const line = code.slice(0, m.index).split("\n").length;
      recordTarget(m[1], line);
    }

    // Pattern 4: Selector held in a constant (const s = "#literal"; querySelector(s))
    const reConst = /(?:const|let|var)\s+[a-zA-Z0-9_$]+\s*=\s*["'`]#([a-zA-Z0-9_-]+)["'`]/g;
    for (const m of code.matchAll(reConst)) {
      const line = code.slice(0, m.index).split("\n").length;
      recordTarget(m[1], line);
    }

    // Pattern 5: Template literals with standalone hash (`#literal`)
    const reTemplate = /`#([a-zA-Z0-9_-]+)`/g;
    for (const m of code.matchAll(reTemplate)) {
      const line = code.slice(0, m.index).split("\n").length;
      recordTarget(m[1], line);
    }

    // Pattern 6: Object map tables of element IDs (e.g. const WANTED = { key: "id", ... })
    const wantedMatch = code.match(/const\s+WANTED\s*=\s*\{([\s\S]*?)\};/);
    if (wantedMatch) {
      const wantedBlock = wantedMatch[1];
      const wantedLine = code.slice(0, wantedMatch.index).split("\n").length;
      for (const m of wantedBlock.matchAll(/:\s*["']([a-zA-Z0-9_-]+)["']/g)) {
        recordTarget(m[1], wantedLine);
      }
    }
  }

  // Count assertion: guard MUST verify a non-trivial number of files and targets.
  // Cannot pass by finding nothing or having neutered regex patterns.
  assert.ok(scannedFiles >= 3, `must scan at least 3 client files (scanned ${scannedFiles})`);
  assert.ok(
    targetMap.size >= 40,
    `guard must find and verify at least 40 DOM targets in client JS (observed only ${targetMap.size})`,
  );

  assert.deepEqual(
    missing,
    [],
    `Client scripts query DOM elements missing from served HTML: ${JSON.stringify(missing)}`,
  );
});
