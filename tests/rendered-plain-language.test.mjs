// tests/rendered-plain-language.test.mjs — the plain-language gate's RENDERED half (voicebox-beads-0ye).
//
// The static check answers "what did we write?"; this answers "what is on the page?" — and the two diverge
// exactly where data arrives. Two proofs live here:
//
//   1. A PREVIOUSLY UNSEEN IDENTIFIER, injected through data rather than written in source, is caught. The
//      id used below appears in no file in this repo, which is the point: if the check only found words it
//      already knew, it could not find the next one.
//   2. THE DIAGNOSTIC ALLOWANCE, both ways round, IN A REAL BROWSER: an identifier in VISIBLE text fails;
//      the same identifier in a `title` attribute (or `data-*`) passes. That is the difference between a
//      diagnostic and a claim about the system, and it is the one part of this area that already worked —
//      pinned here rather than rediscovered later.
//
//   node --test tests/rendered-plain-language.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { refusalVocabulary, identifiersInRenderedText, READ_VISIBLE_TEXT } from "../tools/rendered-plain-language.mjs";
import { launch } from "./lib/cdp.mjs";

test("the vocabulary comes from the payloads the run itself received, not from a list of known words", () => {
  // A payload shaped like the server's refusals, carrying an identifier that exists nowhere in this repo.
  const payload = {
    ok: false,
    refused: "never-seen-before-alpha",
    why: "the thing was not set up",
    nested: { state: "another-unseen-state" },
    files: [{ name: "notes.txt", kind: "file" }], // ordinary data must not enter the vocabulary
  };
  const vocabulary = refusalVocabulary(payload);
  assert.ok(vocabulary.has("never-seen-before-alpha"), `the refusal identifier was not harvested: ${[...vocabulary]}`);
  assert.ok(vocabulary.has("another-unseen-state"), `a nested state identifier was not harvested: ${[...vocabulary]}`);
  assert.ok(!vocabulary.has("notes.txt"), "a file name is data about a file, not a refusal state");
  assert.ok(!vocabulary.has("file"), "a `kind` value that is not identifier-shaped must not be harvested");
});

test("an identifier that arrived in data is caught when it is VISIBLE, and only the visible half", () => {
  const vocabulary = refusalVocabulary({ refused: "never-seen-before-alpha" });
  const visible = identifiersInRenderedText("This list could not be read: never-seen-before-alpha", vocabulary);
  assert.equal(visible.length, 1, `expected one hit, got ${JSON.stringify(visible)}`);
  assert.equal(visible[0].token, "never-seen-before-alpha");
  assert.match(visible[0].remedy, /words/i, "every hit carries the remedy a person would need");

  // and it must not fire when the same text merely CONTAINS something longer (word boundaries matter)
  assert.equal(identifiersInRenderedText("never-seen-before-alphaentifier", vocabulary).length, 0,
    "a longer token that merely starts with the identifier must not be reported as it");
});

test("a bead id spelled into a name is caught — the `seven-cd` case, measured on the served page", () => {
  const hits = identifiersInRenderedText("the browser's own storage for this site · seven-cd", new Set());
  assert.equal(hits.length, 1, `expected the spelled-out id to be caught, got ${JSON.stringify(hits)}`);
  assert.match(hits[0].label, /spelled out/i);
});

test("a ticket id jammed into a word is caught — `7cd`, `0ye` — while measurements are not", () => {
  assert.ok(identifiersInRenderedText("project seven-cd-opfs", new Set()).length >= 1, "the spelled-out id was missed");
  // IN CONTEXT, both attached ids are caught — and the measurements that a shape-only rule fired on stay out
  const attached = identifiersInRenderedText("bead 0ye, ticket 7cd, issue #12ab", new Set()).map((h) => h.token);
  assert.ok(attached.includes("0ye") && attached.includes("7cd") && attached.includes("12ab"), `attached ids were missed: ${JSON.stringify(attached)}`);
  assert.deepEqual(identifiersInRenderedText("2 environments are reachable", new Set()), [],
    "a count followed by a space is not an identifier");
  for (const measurement of ["width: 22rem", "no response within 4s", "1px solid", "100vh", "0.5s"]) {
    assert.deepEqual(identifiersInRenderedText(measurement, new Set()), [],
      `a measurement must not be reported as an identifier: "${measurement}"`);
  }
});

test("ordinary prose does not trip it — no blanket exemptions needed", () => {
  const prose = "This list is read-only and one-time; the page-acceptance project is already here, and 2 environments are reachable.";
  assert.deepEqual(identifiersInRenderedText(prose, new Set()), [],
    "the check must not fail on words a person reads every day");
});

test("in a real browser: visible fails, a title passes — and the reader is the one the gate uses", async () => {
  const page = await launch({ width: 800, height: 600 });
  try {
    const id = "never-seen-before-alpha";
    // (a) the identifier VISIBLE, with the same identifier also present in a title for contrast
    await page.goto(`data:text/html,<body><p>This list could not be read: ${id}</p><span title="${id}">details</span></body>`);
    const readVisible = new Function(`return ${READ_VISIBLE_TEXT};`); // the driver wraps a function, the module exports an expression
    const visibleText = await page.evaluate(readVisible);
    const visibleHits = identifiersInRenderedText(String(visibleText), refusalVocabulary({ refused: id }));
    assert.equal(visibleHits.length, 1, `a VISIBLE identifier must fail: read "${visibleText}"`);

    // (b) the SAME identifier only in a title / data attribute: a diagnostic, and it must pass
    await page.goto(`data:text/html,<body><p>This list could not be read: the folder did not answer</p><span title="${id}" data-state="${id}">details</span><code>${id} --as-a-command-argument</code></body>`);
    const cleanText = await page.evaluate(readVisible);
    const cleanHits = identifiersInRenderedText(String(cleanText), refusalVocabulary({ refused: id }));
    assert.deepEqual(cleanHits, [],
      `an identifier in a title, a data-* attribute, or a code sample must pass: read "${cleanText}"`);
    assert.match(String(cleanText), /the folder did not answer/, "the plain sentence is what remains readable");
  } finally {
    await page.close();
  }
});
