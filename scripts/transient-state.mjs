#!/usr/bin/env node
// scripts/transient-state.mjs — the checker for the shape voicebox-beads-zjpm.5 found BY HAND: "wait on A,
// assert B", where B is written by an ASYNC path that A says nothing about.
//
//   node scripts/transient-state.mjs                 # scan the browser lane, as the classifier sees it
//   node scripts/transient-state.mjs <file> [...]    # scan named files (the test drives it this way)
//
// WHY THIS EXISTS. The failure is a whole class, not an incident: the same tree is green in the shard queue
// and red standalone, and three separate beads (jeye, y1db, 18lh) were the same defect found three times by
// a red gate on an unrelated union. The audit that found it took hand-reading rather than a grep, and this
// file is the reason why: the mechanical signals are noisy in the SAME direction. "A fixed delay, then an
// assertion" is also the CORRECT shape whenever the asserted observable is written synchronously with
// whatever the delay was for, and it is the accidental shape of every poll-loop helper — three surface-form
// scans over the tiers produced 100 / 36 / 50 candidates and hand-reading cleared all but one.
//
// SO THE SCAN ENCODES THE DISCRIMINATOR, NOT THE SURFACE FORM. It is tightened to the one statement shape
// that can be wrong — a FIXED delay immediately before an assertion — and every candidate must then be
// cleared by a NAMED clause, or it is printed as a review item:
//
//   ABSENCE   the assertion asserts that something did NOT happen. A delay before an absence is the whole
//             point of the assertion (the negative controls in changelog-dialog-extraction and
//             opfs-scratch-room are exactly this), not a race.
//   POLL      the delay is a poll interval inside a loop that re-checks its own condition. The loop is the
//             wait; the delay is how often it looks.
//   IN-PAGE   the delay runs INSIDE page.evaluate(): it is the page's own timeline being measured, not the
//             test waiting for the page.
//   NO-ASYNC  the assertion reads no page or global state — a fixture asserting its own arithmetic observes
//             nothing that can arrive late.
//
// IT MUST NOT BE A GATE THAT IS RED BECAUSE OF THE BASE. The repository's existing delays are cleared by
// name and printed WITH the clause that clears them; the exit code is 1 only when a candidate cannot be
// cleared, i.e. when a NEW site of the jeye/y1db shape appears. That is the whole value: the next one is
// caught in review, by name and file:line, instead of by a red gate on someone else's union.
//
// NOT WIRED INTO THE PUSH HOOK, deliberately: the second half of the audit's acceptance (an exact-string or
// exact-count assertion on a status observable the test never waits for, cross-referenced against the page
// code that writes it) is a REVIEW LIST rather than a decision — it produced 12 candidates on this tree, all
// of which need a human to say whether the writer is synchronous. A gate that fails on those would be red
// for the base, which is the failure this repository keeps finding. `--list` prints them.
import { readFileSync } from "node:fs";
import { classify } from "./test-lanes.mjs";
import { rosterOf } from "./gate-manifest.mjs";

// THE DELAYS THIS LOOKS FOR: a FIXED number of milliseconds, awaited, in one statement. A delay the test
// computes (`sleep(delayMs)`) is not a fixed sleep and is not this shape.
const FIXED_DELAY = [
  /await\s+sleep\(\s*\d+\s*\)/,
  /await\s+new\s+Promise\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\(\s*\w+\s*,\s*\d+\s*\)\s*\)/,
  /await\s+new\s+Promise\(\s*function[^)]*\)\s*\{[^}]*setTimeout\([^,]+,\s*\d+/,
];

/** The line that OPENS the block the delay sits in — the innermost `{` above it that is still unclosed. */
function enclosingOpener(lines, idx) {
  let depth = 0;
  for (let i = idx - 1; i >= 0 && idx - i < 40; i--) {
    const line = lines[i];
    for (let c = line.length - 1; c >= 0; c--) {
      if (line[c] === "}") depth++;
      else if (line[c] === "{") {
        if (depth > 0) depth--;
        else return { text: line, line: i + 1 };
      }
    }
  }
  return { text: "", line: null };
}

/** The statement that follows the delay: from the next non-blank line to the line that balances its parens. */
function statementAfter(lines, idx) {
  let start = idx + 1;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length) return { text: "", line: null };
  const parts = [];
  let balance = 0;
  for (let i = start; i < lines.length && i - start < 12; i++) {
    const line = lines[i];
    parts.push(line.trim());
    for (const ch of line) {
      if (ch === "(" || ch === "[") balance++;
      else if (ch === ")" || ch === "]") balance--;
    }
    if (balance <= 0) break;
  }
  return { text: parts.join(" "), line: start + 1 };
}

// AN ABSENCE IS NOT A RACE. The expected side says the thing is not there, or the assertion is explicitly a
// negating form: a delay before it waits for the absence to be OBSERVABLE.
const ABSENCE_EXPECTED = /,\s*(null|undefined|false|0|""|''|\[\]|\{\})\s*[,)]/;
const ABSENCE_FORM = /assert\.(?:notEqual|notStrictEqual|notDeepEqual)\(|assert\.ok\(\s*!|\.length\s*,\s*0\s*[,)]/;
const READS_PAGE_STATE = /page\.|window\.|document|__[a-zA-Z]/;

/** Clear a candidate by a NAMED clause, or hand it back for review. Order matters: the innermost scope first. */
export function classifyDelay({ lines, idx }) {
  const opener = enclosingOpener(lines, idx);
  const after = statementAfter(lines, idx);
  if (!/^assert\./.test(after.text.replace(/^await\s+/, ""))) {
    return { cleared: true, clause: "NOT-IMMEDIATE", detail: "the statement after the delay is not an assertion" };
  }
  if (ABSENCE_EXPECTED.test(after.text) || ABSENCE_FORM.test(after.text)) {
    return { cleared: true, clause: "ABSENCE", detail: "the assertion asserts that something did NOT happen" };
  }
  if (/^\s*(for|while)\s*\(/.test(opener.text.trim())) {
    return { cleared: true, clause: "POLL", detail: `the delay is a poll interval inside a loop (line ${opener.line})` };
  }
  if (/evaluate\s*\(/.test(opener.text)) {
    return { cleared: true, clause: "IN-PAGE", detail: `the delay runs inside page.evaluate (line ${opener.line})` };
  }
  if (!READS_PAGE_STATE.test(after.text)) {
    return { cleared: true, clause: "NO-ASYNC", detail: "the assertion reads no page or global state" };
  }
  return { cleared: false, clause: null, detail: "a FIXED delay immediately before an assertion on page state, with nothing saying what it waits for", statement: after };
}

// ── THE REVIEW LIST, deliberately separate and non-deciding (see the header) ──────────────────────────
const EXACT_STATUS = /assert\.(?:equal|strictEqual|deepEqual)\(\s*([^,]{1,120}?),\s*("[^"]{0,60}"|\d{1,4})\s*[,)]/g;

function statusCandidates(file, source) {
  const waits = [...source.matchAll(/waitFor\w*\(([\s\S]{0,400}?)\)/g)].map((m) => m[1]).join(" ");
  const out = [];
  for (const m of source.matchAll(EXACT_STATUS)) {
    const expr = m[1].trim();
    if (!READS_PAGE_STATE.test(expr)) continue;
    if (m[2] === "0" || /\.length\s*$/.test(expr)) {
      // An exact zero or an exact count: the jeye/y1db shape when nothing waits for it.
      const idents = expr.match(/__[a-zA-Z]\w+/g) ?? [];
      if (idents.length && idents.some((i) => waits.includes(i))) continue;
      out.push({ file, line: source.slice(0, m.index).split("\n").length, text: m[0].trim().slice(0, 100) });
    }
  }
  return out;
}

function scan(files, { list = false } = {}) {
  const cleared = [];
  const candidates = [];
  const review = [];
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!FIXED_DELAY.some((re) => re.test(lines[i]))) continue;
      const verdict = classifyDelay({ lines, idx: i });
      const where = `${file}:${i + 1}`;
      if (verdict.cleared) cleared.push({ where, ...verdict });
      else candidates.push({ where, ...verdict });
    }
    if (list) review.push(...statusCandidates(file, source));
  }
  return { cleared, candidates, review };
}

function main() {
  const args = process.argv.slice(2);
  const list = args.includes("--list");
  const named = args.filter((a) => !a.startsWith("--"));
  const files = named.length ? named : rosterOf(classify()).filter((e) => e.tier === "browser").map((e) => e.path);
  if (files.length === 0) {
    console.log("transient-state: nothing to scan (no files given and the classifier lists no browser file)");
    return 0;
  }

  const { cleared, candidates, review } = scan(files, { list });
  for (const c of cleared) console.log(`  cleared ${c.where} — ${c.clause}: ${c.detail}`);
  if (list) for (const r of review) console.log(`  review  ${r.file}:${r.line} — exact status assertion, no wait on it: ${r.text}`);

  if (candidates.length === 0) {
    console.log(`transient-state: OK — ${files.length} file(s), ${cleared.length} fixed delay(s), every one cleared by a named clause`);
    return 0;
  }
  console.error(`\ntransient-state: ${candidates.length} candidate(s) that no clause clears — review each: a delay is only a wait if something says what arrived.`);
  for (const c of candidates) {
    console.error(`  ${c.where}: ${c.detail}`);
    console.error(`    after the delay: ${c.statement?.text?.slice(0, 160)}`);
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
