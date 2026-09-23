// tests/modern-web-room.test.mjs — bead voicebox-beads-8ht.
//
// Verification of modern web guidance pass on Voicebox room:
// 1. Container queries on dialog.envs for component-isolated responsive form layout
// 2. Elimination of dead duplicate CSS clobbering in .env-add and .mic
// 3. Scroll containment (overscroll-behavior: contain) and CLS prevention (scrollbar-gutter: stable)
// 4. Keyboard accessibility on scrollable code block (<pre id="file-body" tabindex="0">)
// 5. Semantic <search> landmark for file filtering
// 6. Unified light-dismiss fallback for all dialogs (including #exts on Safari)
// 7. IME composition safety on utterance input and submission
//
//   node --test tests/modern-web-room.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

test("html: search landmark replaces generic div for file filtering (Baseline Widely Available)", () => {
  const html = readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  assert.match(
    html,
    /<search\s+class="list-tools"\s+id="list-tools"\s+hidden>/,
    "list-tools must use semantic <search> element instead of generic <div>",
  );
  assert.doesNotMatch(
    html,
    /<div\s+class="list-tools"/,
    "generic <div> for search landmark must be removed",
  );
});

test("html: scrollable code block has tabindex='0' and accessible region role for keyboard users", () => {
  const html = readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  assert.match(
    html,
    /<pre\s+id="file-body"\s+tabindex="0"\s+role="region"\s+aria-label="File contents"><\/pre>/,
    "#file-body must be keyboard focusable (tabindex=0) and identified as an accessible region",
  );
});

test("css: dialog.envs establishes an inline-size container context for component queries", () => {
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");
  assert.match(
    css,
    /dialog\.envs\s*\{[^}]*container:\s*env-dialog\s*\/\s*inline-size;/s,
    "dialog.envs must define a container-type for component-level queries",
  );
  assert.match(
    css,
    /@container\s+env-dialog\s*\(inline-size\s*<\s*380px\)\s*\{[^}]*\.env-add\s*\{[^}]*flex-direction:\s*column;/s,
    ".env-add must stack fields via container query rather than viewport query",
  );
});

test("css: dead duplicated .env-add and .env-note overrides are removed", () => {
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");
  // Check that the duplicate un-wrapped flex rule from old dropdown days is gone
  assert.doesNotMatch(
    css,
    /\.env-add\s*\{\s*display:\s*flex;\s*gap:\s*6px;\s*padding:\s*8px\s+12px;\s*border-top:\s*1px\s+solid\s+var\(--line\);\s*\}/,
    "the legacy duplicate .env-add override must be removed",
  );
  // Check that duplicate .mic declaration in body:has(#reader) is deduplicated
  const micInReader = css.match(/body:has\(#reader\[data-state="ready"\]\)\s*\.mic\s*\{[^}]*\}/g) ?? [];
  assert.equal(
    micInReader.length,
    1,
    `body:has(#reader) .mic should only be declared once, found ${micInReader.length}`,
  );
});

test("css: scrollable containers contain overscroll and stabilize scrollbar gutters", () => {
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");
  assert.match(
    css,
    /#file-body\s*\{[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/s,
    "#file-body must declare overscroll-behavior: contain and scrollbar-gutter: stable",
  );
  assert.match(
    css,
    /#session-log\s*\{[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/s,
    "#session-log must declare overscroll-behavior: contain and scrollbar-gutter: stable",
  );
  assert.match(
    css,
    /\.env-cap-list\s*\{[^}]*overscroll-behavior:\s*contain;/s,
    ".env-cap-list must declare overscroll-behavior: contain",
  );
});

test("fused.js: light-dismiss fallback covers #exts alongside #envs and #settings", () => {
  const js = readFileSync(path.join(PUBLIC, "fused.js"), "utf8");
  assert.match(
    js,
    /installLightDismissFallback\s*\(\s*els\.exts\s*\);/,
    "light dismiss fallback must be installed for els.exts",
  );
  assert.match(
    js,
    /installLightDismissFallback\s*\(\s*els\.envs\s*\);/,
    "light dismiss fallback must be installed for els.envs",
  );
  assert.match(
    js,
    /installLightDismissFallback\s*\(\s*els\.settings\s*\);/,
    "light dismiss fallback must be installed for els.settings",
  );
});

test("fused.js: IME composition prevents premature utterance input and submit", () => {
  const js = readFileSync(path.join(PUBLIC, "fused.js"), "utf8");
  assert.match(
    js,
    /on\(els\.utterance,\s*"input",\s*\(event\)\s*=>\s*\{[^}]*if\s*\(event\?\.isComposing\)\s*return;/s,
    "input event must guard against IME isComposing",
  );
  assert.match(
    js,
    /on\(els\.form,\s*"submit",\s*\(event\)\s*=>\s*\{[^}]*if\s*\(event\?\.isComposing\)\s*return;/s,
    "submit event must guard against IME isComposing",
  );
});
