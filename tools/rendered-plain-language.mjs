// tools/rendered-plain-language.mjs — WHAT A PERSON CAN ACTUALLY READ (voicebox-beads-0ye).
//
// The existing gate reads SOURCE LITERALS: it answers "what did we write?". The requirement is "what is
// on the page?" — and the two diverge exactly where data arrives: a refusal identifier that comes from a
// payload (`${row.delegation.refused}`) renders to a person while containing no literal for a source
// scan to find. Measured 2026-09-23: a project named `seven-cd` (a bead id, `7cd`, spelled out) rendered
// in the room's header, invisible to a check that reads code.
//
// SO THE VOCABULARY LIVES HERE, ONCE, AND IS USED TWICE — the same lesson as lib/browser-sources.mjs: a
// list that exists in two places drifts. page-acceptance.mjs applies it to source literals (where it
// started) and to rendered text (where it was missing).
//
// WHAT THIS CANNOT DO, said here so a green line is not read as more than it is: it covers the pages and
// the states the harness DRIVES. It cannot prove anything about unvisited dialogs, another provider's
// text, or content inside an inaccessible frame. The harness prints that sentence beside its result.

/** Identifier shapes that must never be VISIBLE. Each carries the remedy a person would need. */
export const ID_PATTERNS = [
  [/\bE\d-M\d\b/, "internal ticket id", "describe the change in words — the id belongs in our docs, not on the page"],
  [/\be1m0\b/i, "internal ticket id", "describe the change in words — the id belongs in our docs, not on the page"],
  [/\bN\d{1,3}\b/, "internal note number", "say the idea, not the note number"],
  [/##?\d{2,6}\b/, "issue reference", "say the idea, not the issue number"],
  // A BEAD ID SPELLED OUT OR ATTACHED — the `seven-cd` case (bead `7cd`), which no digit pattern catches.
  [/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)-[a-z]{1,3}\b/, "ticket id spelled out", "name the thing, not the ticket"],
  // Attached ids (`7cd`, `0ye`) are caught IN CONTEXT — "bead 7cd", "ticket 0ye", "#12ab" — and NOT by
  // shape alone: measured on the first run, a bare shape rule fired on `22rem` (a CSS unit) and `4s` (a
  // duration). A rule that fails on a measurement is a rule somebody switches off, so the context is the
  // rule and there is no exemption list to maintain.
  [/(?:\b(?:bead|ticket|issue|note)\s+|#)(\d[0-9a-z]{0,4})\b/i, "ticket id", "name the thing, not the ticket"],
];

/** Words that mean nothing to a reader, and the plain phrase that replaces each. */
export const JARGON = [
  ["reachableFromThisProcess", "name what can reach it: \"only this page\" / \"the server too\""],
  ["executor", "say what it does: \"the part that runs a tool\" / \"the runner\""],
  ["admitted", "say what happened: \"allowed\" / \"approved for use here\""],
  ["placement", "say where: \"where the tool runs\" / \"its home\""],
  ["envelope", "say what it carries: \"the message\" / \"the request\""],
];

/**
 * EVERY REFUSAL NAME THIS RUN SAW, harvested from the payloads the harness itself received.
 *
 * This is deliberately NOT a pattern: it is the vocabulary the system actually used, so the assertion
 * becomes "the page does not show the identifier the server just sent me" rather than "this text looks
 * like a token". A person's own words — a file called `probe-zero-yankee.txt` — are content, and a
 * pattern-only check fails on them (measured, 2026-09-23).
 *
 * Walks any JSON shape: objects, arrays, nested. Collects only identifier-shaped strings (two or more
 * hyphen-separated lower-case segments) from fields that NAME a refusal state.
 */
export function refusalVocabulary(payload, found = new Set()) {
  if (payload === null || typeof payload !== "object") return found;
  if (Array.isArray(payload)) {
    for (const item of payload) refusalVocabulary(item, found);
    return found;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" && /^(refused|error|state|status|reason|kind|code)$/i.test(key)
        && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(value)) {
      found.add(value);
    }
    if (value && typeof value === "object") refusalVocabulary(value, found);
  }
  return found;
}

/**
 * Identifier-shaped tokens in a block of rendered text, from BOTH sources: the run's own vocabulary
 * (exact) and the documented shapes (pattern). Returns one entry per hit, with the shape's remedy.
 */
export function identifiersInRenderedText(text, vocabulary = new Set()) {
  const hits = [];
  for (const id of vocabulary) {
    // word-boundaried, so `no-page` does not fire inside `no-pages` or a longer token
    const re = new RegExp(`(?:^|[^a-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`);
    if (re.test(text)) hits.push({ token: id, label: "the identifier this run's own refusal used", remedy: "say what happened in words; the identifier belongs in a title attribute or the log" });
  }
  for (const [pattern, label, remedy] of ID_PATTERNS) {
    for (const m of text.matchAll(new RegExp(pattern, "g"))) {
      // a pattern with a capture group names the identifier it found inside a context ("bead 7cd" -> "7cd")
      hits.push({ token: (m[1] ?? m[0]).trim(), label, remedy });
    }
  }
  for (const [word, remedy] of JARGON) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(text)) hits.push({ token: word, label: "jargon", remedy });
  }
  return hits;
}

/**
 * THE READER, as an expression to run in the page. Text nodes of VISIBLE elements: not `innerText` (which
 * would include nothing hidden — true — but also nothing a person cannot read in a title), and not the
 * HTML source (which contains everything). `code`/`pre`/`samp`/`kbd` are skipped BY ELEMENT, with the
 * reason stated: they quote commands and output rather than making claims about the system.
 *
 * It is exported because the check and its test must read the page the SAME way — a test that used its own
 * reader would be testing the test.
 */
export const READ_VISIBLE_TEXT = `(() => {
  const EXEMPT = new Set(["SCRIPT", "STYLE", "TEMPLATE", "CODE", "PRE", "SAMP", "KBD"]);
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === 3) { const t = node.textContent.trim(); if (t) parts.push(t); return; }
    if (node.nodeType !== 1) return;
    if (EXEMPT.has(node.tagName) || node.hidden) return;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return;
    for (const child of node.childNodes) walk(child);
  };
  walk(document.body);
  return parts.join(" · ");
})()`;
