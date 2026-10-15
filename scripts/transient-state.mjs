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
//   ABSENCE       the assertion asserts that something did NOT happen. A delay before an absence is the whole
//                 point of the assertion (the negative controls in changelog-dialog-extraction and
//                 opfs-scratch-room are exactly this), not a race.
//   IN-PAGE       the delay runs INSIDE page.evaluate(): it is the page's own timeline being measured, not the
//                 test waiting for the page.
//   NO-ASYNC      the assertion reads no page or global state — a fixture asserting its own arithmetic observes
//                 nothing that can arrive late.
//   DELAYED-READ  the delay precedes a page read asserted on the following statement (offered under --list for review).
//   NOT-IMMEDIATE the statement immediately after the delay is not an assertion.
//
// A loop alone is NOT a clearance clause: a real poll re-checks the observable AFTER sleeping, before
// asserting, which breaks the immediate-delay shape. Merely enclosing a fixed sleep and an assertion in a
// loop without an intervening condition is flagged as a candidate refusal.
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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path, { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
  while (start < lines.length && (lines[start].trim() === "" || lines[start].trim().startsWith("//"))) start++;
  if (start >= lines.length) return { text: "", line: null, endIdx: start };
  const parts = [];
  let balance = 0;
  let endIdx = start;
  for (let i = start; i < lines.length && i - start < 15; i++) {
    const line = lines[i];
    parts.push(line.trim());
    for (const ch of line) {
      if (ch === "(" || ch === "[") balance++;
      else if (ch === ")" || ch === "]") balance--;
    }
    endIdx = i;
    if (balance <= 0 && (line.trim().endsWith(";") || line.trim().endsWith("}") || /^}\s*;?\s*(?:\/\/.*)?$/.test(line.trim()))) break;
  }
  return { text: parts.join(" "), line: start + 1, endIdx };
}

// AN ABSENCE IS NOT A RACE. The expected side says the thing is not there, or the assertion is explicitly a
// negating form: a delay before it waits for the absence to be OBSERVABLE.
const ABSENCE_EXPECTED = /,\s*(null|undefined|false|0|""|''|\[\]|\{\})\s*[,)]/;
const ABSENCE_FORM = /assert\.(?:notEqual|notStrictEqual|notDeepEqual)\(|assert\.ok\(\s*!|\.length\s*,\s*0\s*[,)]/;
const READS_PAGE_STATE = /page\.|window\.|document|__[a-zA-Z]/;

/** Clear a candidate by a NAMED clause, or hand it back for review. Order matters: the innermost scope first. */
export function classifyDelay({ lines, idx }) {
  const opener = enclosingOpener(lines, idx);
  let after = statementAfter(lines, idx);
  // The loop's closing brace is not a wait: if the final statement in the loop is a fixed sleep,
  // an assertion immediately after the loop still samples page state once, with no post-sleep re-check.
  if (/^\s*(for|while)\s*\(/.test(opener.text.trim()) && /^}\s*;?\s*(?:\/\/.*)?$/.test(after.text)) {
    const following = statementAfter(lines, after.endIdx);
    if (/^assert\./.test(following.text.trim())) after = following;
  }
  let assertStmt = after;
  let isDelayedRead = false;

  // LOOK-THROUGH FOR DELAYED PAGE READS (voicebox-beads-omja): if the statement after the delay is a variable
  // declaration reading page state (e.g. `const status = await page.evaluate(...)`), check whether the
  // statement immediately following it is the assertion checking that variable. A delay followed by a read and
  // immediate assert is the same defect shape as a delay followed directly by an assert.
  if (!/^assert\./.test(after.text.trim().replace(/^await\s+/, ""))) {
    const varMatch = after.text.trim().match(/^(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?.*?(page\.|window\.|document|__[a-zA-Z])/);
    if (varMatch) {
      const stmt2 = statementAfter(lines, after.endIdx);
      if (/^assert\./.test(stmt2.text.trim().replace(/^await\s+/, "")) && stmt2.text.includes(varMatch[1])) {
        assertStmt = stmt2;
        isDelayedRead = true;
      }
    }
  }

  if (!/^assert\./.test(assertStmt.text.trim().replace(/^await\s+/, ""))) {
    return { cleared: true, clause: "NOT-IMMEDIATE", detail: "the statement after the delay is not an assertion" };
  }
  const operands = comparedOperands(assertStmt.text);
  if (ABSENCE_EXPECTED.test(operands) || ABSENCE_FORM.test(assertStmt.text)) {
    return { cleared: true, clause: "ABSENCE", detail: "the assertion asserts that something did NOT happen" };
  }
  if (/evaluate\s*\(/.test(opener.text)) {
    return { cleared: true, clause: "IN-PAGE", detail: `the delay runs inside page.evaluate (line ${opener.line})` };
  }
  if (!READS_PAGE_STATE.test(operands) && !isDelayedRead) {
    return { cleared: true, clause: "NO-ASYNC", detail: "the assertion reads no page or global state" };
  }
  if (assertStmt !== after) {
    return {
      cleared: true,
      clause: "DELAYED-READ",
      detail: `delay precedes a page read asserted at line ${assertStmt.line} (offered under --list for review)`,
      statement: assertStmt,
    };
  }
  return {
    cleared: false,
    clause: null,
    detail: /^\s*(for|while)\s*\(/.test(opener.text.trim())
      ? `a FIXED delay inside a loop (line ${opener.line}) immediately precedes a page assertion; no post-sleep condition re-checks its observable`
      : "a FIXED delay immediately before an assertion on page state, with nothing saying what it waits for",
    statement: assertStmt,
  };
}

// ── THE REVIEW LIST, deliberately separate and non-deciding (see the header) ──────────────────────────
const EXACT_STATUS = /assert\.(?:equal|strictEqual|deepEqual)\(\s*([^,]{1,120}?),\s*("[^"\n]{0,60}"|'[^'\n]{0,60}'|\d{1,4})\s*[,)]/g;

// Read only the first argument to a wait: arrow parameters and callback calls have nested parentheses.
// A regex ending at the first ')' silently loses window.__status in `waitForFunction(() => window.__status)`.
function firstCallArgument(source, open) {
  let parens = 0, brackets = 0, braces = 0, quote = "", escaped = false;
  let lineComment = false, blockComment = false;
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) { if (ch === "*" && next === "/") { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") parens++;
    else if (ch === ")") { if (parens === 0) return source.slice(open + 1, i); parens--; }
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    else if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "," && parens === 0 && brackets === 0 && braces === 0) return source.slice(open + 1, i);
  }
  return ""; // an incomplete wait cannot clear an assertion
}

/** Ignore the optional failure MESSAGE, but inspect both compared operands for page reads. */
function comparedOperands(statement) {
  const match = /^\s*assert\.(\w+)\s*\(/.exec(statement);
  if (!match) return statement; // unknown syntax stays fail-closed
  const open = match[0].length - 1;
  const first = firstCallArgument(statement, open);
  if (!first) return statement;
  if (match[1] === "ok") return first;
  if (!["equal", "strictEqual", "deepEqual", "notEqual", "notStrictEqual", "notDeepEqual"].includes(match[1])) {
    return statement; // unfamiliar assertion signature: do not discard possibly relevant operands
  }
  const comma = open + 1 + first.length;
  if (statement[comma] !== ",") return statement;
  const second = firstCallArgument(statement, comma);
  return second ? `${first}, ${second})` : statement; // closing delimiter preserves ABSENCE_EXPECTED's expected-value check
}

const PAGE_ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));
let pageWriters;
function writerIndex() {
  if (pageWriters) return pageWriters;
  pageWriters = new Map();
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:js|mjs|ts)$/.test(entry.name)) {
        const lines = readFileSync(path, "utf8").split("\n");
        lines.forEach((line, index) => {
          for (const match of line.matchAll(/\b(?:window|globalThis)\.(__[A-Za-z]\w*)\s*(?:=(?!=|>)|\+\+|--|\+=|-=)/g)) {
            if (!pageWriters.has(match[1])) pageWriters.set(match[1], `${relative(ROOT, path)}:${index + 1}`);
          }
        });
      }
    }
  };
  visit(PAGE_ROOT);
  return pageWriters;
}

function writerLocation(file, source, id) {
  // Identifiers came from status assertions and contain no regex metacharacters.
  const writer = new RegExp(`\\b(?:window|globalThis)\\.${id}\\s*(?:=(?!=|>)|\\+\\+|--|\\+=|-=)`);
  const index = source.split("\n").findIndex((line) => writer.test(line));
  if (index >= 0) return `${file}:${index + 1}`;
  return writerIndex().get(id) ?? "unknown (no assignment found in test or public page code)";
}

// Waits can only cover assertions in the SAME test and along a scope that still encloses the assertion.
// Preserve character offsets while masking strings/comments/regex literals so a quoted `test(` cannot
// create a fake scope. Regex quotes are NOT string delimiters: masking past one could hide live assertions.
function lexicalScopes(source) {
  const chars = source.split(""); // UTF-16 offsets must match RegExp match.index, even after emoji in test titles.
  let quote = "", escaped = false, lineComment = false, blockComment = false;
  let regex = false, regexClass = false, regexEscaped = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (lineComment) { if (ch === "\n") lineComment = false; else chars[i] = " "; continue; }
    if (blockComment) { chars[i] = " "; if (ch === "*" && next === "/") { chars[++i] = " "; blockComment = false; } continue; }
    if (quote) {
      if (ch !== "\n") chars[i] = " ";
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (regex) {
      if (ch === "\n") { regex = false; regexClass = regexEscaped = false; continue; }
      chars[i] = " ";
      if (regexEscaped) regexEscaped = false;
      else if (ch === "\\") regexEscaped = true;
      else if (ch === "[") regexClass = true;
      else if (ch === "]") regexClass = false;
      else if (ch === "/" && !regexClass) regex = false;
      continue;
    }
    if (ch === "/" && next === "/") { chars[i] = chars[++i] = " "; lineComment = true; continue; }
    if (ch === "/" && next === "*") { chars[i] = chars[++i] = " "; blockComment = true; continue; }
    if (ch === "/") {
      let prev = i - 1;
      while (prev >= 0 && /\s/.test(chars[prev])) prev--;
      const keyword = chars.slice(Math.max(0, prev - 15), prev + 1).join("");
      const isSpread = prev >= 2 && chars[prev] === "." && chars[prev - 1] === "." && chars[prev - 2] === ".";
      let isStatementSlash = false;
      if (prev >= 0 && chars[prev] === ")") {
        let depth = 1;
        let j = prev - 1;
        while (j >= 0 && depth > 0) {
          if (chars[j] === ")") depth++;
          else if (chars[j] === "(") depth--;
          j--;
        }
        if (depth === 0) {
          while (j >= 0 && /\s/.test(chars[j])) j--;
          const preHeader = chars.slice(Math.max(0, j - 15), j + 1).join("");
          const headerMatch = preHeader.match(/\b(if|while|for(?:\s+await)?)$/);
          if (headerMatch) {
            const hStart = j - headerMatch[1].length + 1;
            let beforeH = hStart - 1;
            while (beforeH >= 0 && /\s/.test(chars[beforeH])) beforeH--;
            if (beforeH < 0 || chars[beforeH] !== ".") {
              isStatementSlash = true;
            }
          }
        }
      }
      let isKeyword = false;
      const kwMatch = keyword.match(/\b(return|case|throw|yield|await|of|in|typeof|void|delete|new|instanceof|else|do)$/);
      if (kwMatch) {
        const kwStart = prev - kwMatch[1].length + 1;
        let beforeKw = kwStart - 1;
        while (beforeKw >= 0 && /\s/.test(chars[beforeKw])) beforeKw--;
        if (beforeKw < 0 || chars[beforeKw] !== ".") {
          isKeyword = true;
        }
      }
      // A slash after an expression is division. Expression-opening punctuation (excluding closing brackets),
      // spread, standalone statement headers, or standalone keywords start regex literals (voicebox-beads-bw70).
      if (
        prev < 0 ||
        "=(:,;!&|?{}[~+*%^<>-".includes(chars[prev]) ||
        isSpread ||
        isStatementSlash ||
        isKeyword
      ) {
        chars[i] = " "; regex = true; continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") { chars[i] = " "; quote = ch; }
  }
  const code = chars.join("");
  const blocks = [], stack = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "{") stack.push(i);
    else if (code[i] === "}" && stack.length) blocks.push({ start: stack.pop(), end: i });
  }
  const tests = [];
  for (const match of code.matchAll(/\b(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) { tests.push({ start: match.index, end: i }); break; }
    }
  }
  const containing = (ranges, index) => ranges.filter((r) => r.start < index && index < r.end)
    .sort((a, b) => b.start - a.start)[0] ?? null;
  return { code, testAt: (index) => containing(tests, index)?.start ?? null,
    blockAt: (index) => containing(blocks, index) };
}

// A braceless control statement still guards its immediate body. Its wait does not dominate a later
// assertion in the test even though both share the test's surrounding brace block.
function bracelessGuardedWait(code, waitIndex) {
  for (const match of code.slice(0, waitIndex).matchAll(/\b(?:if|for|while)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0, close = -1;
    for (let i = open; i < waitIndex; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) { close = i; break; }
    }
    if (close !== -1 && /^\s*(?:(?:await|return)\s+)*$/.test(code.slice(close + 1, waitIndex))) return true;
  }
  return /\belse\s+(?:(?:await|return)\s+)*$/.test(code.slice(Math.max(0, waitIndex - 100), waitIndex));
}

function statusCandidates(file, source) {
  const scopes = lexicalScopes(source);
  // Recognize calls in code, not comments or titles. A string-form callback is executable too: inspect its
  // CONTENT for ids while masking any JavaScript comments embedded within that string.
  const waits = [...scopes.code.matchAll(/\b(?:page\.)?waitFor\w*\s*\(/g)].map((m) => {
    const open = m.index + m[0].length - 1;
    const argument = firstCallArgument(source, open).trim();
    const stringCallback = argument.match(/^(['"`])([\s\S]*)\1$/);
    const callbackCode = stringCallback ? lexicalScopes(stringCallback[2]).code : "";
    return {
      index: m.index,
      test: scopes.testAt(m.index),
      block: scopes.blockAt(m.index),
      guarded: bracelessGuardedWait(scopes.code, m.index),
      ids: new Set(`${firstCallArgument(scopes.code, open)} ${callbackCode}`.match(/__[A-Za-z]\w+/g) ?? []),
    };
  });
  const out = [];
  for (const m of source.matchAll(EXACT_STATUS)) {
    if (!scopes.code.startsWith("assert.", m.index)) continue; // a comment/title cannot assert
    const expr = m[1].trim();
    let isPageState = READS_PAGE_STATE.test(expr);
    let idents = expr.match(/__[a-zA-Z]\w+/g) ?? [];
    if (!isPageState) {
      // Look through variable assignments that read page state (voicebox-beads-omja)
      const varMatch = expr.match(/^([a-zA-Z_]\w*)(?:\.[\w.]+)?$/);
      if (varMatch) {
        const varName = varMatch[1];
        const assignRe = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=[^;\\n]*(?:page\\.|window\\.|document|__[a-zA-Z])`);
        if (assignRe.test(source)) {
          isPageState = true;
          const assignIdents = source.match(new RegExp(`(?:const|let|var)\\s+${varName}\\s*=[^;\\n]*(__[a-zA-Z]\\w+)`));
          if (assignIdents) idents.push(assignIdents[1]);
        }
      }
    }
    if (!isPageState) continue;
    // An exact string or count on an unwaited status observable belongs on the review list (voicebox-beads-a2gd)
    const assertedTest = scopes.testAt(m.index);
    if (idents.length && idents.every((id) => waits.some((wait) => wait.index < m.index &&
      wait.test === assertedTest && !wait.guarded && (!wait.block || wait.block.end > m.index) && wait.ids.has(id)))) continue;
    const writers = [...new Set(idents)].map((id) => writerLocation(file, source, id));
    out.push({ file, line: source.slice(0, m.index).split("\n").length,
      text: `${m[0].trim().slice(0, 100)} — writer: ${writers.join(", ") || "unknown (no observable identifier)"} (timing needs review)` });
  }
  return out;
}

export function scan(files, { list = false, root = ROOT } = {}) {
  const cleared = [];
  const candidates = [];
  const review = [];
  const unreadable = [];
  let readCount = 0;
  for (const file of files) {
    const fullPath = path.isAbsolute(file) ? file : path.resolve(root, file);
    let source;
    try {
      source = readFileSync(fullPath, "utf8");
      readCount++;
    } catch (err) {
      unreadable.push({ file, path: fullPath, error: err.message });
      continue;
    }
    const lines = source.split("\n");
    const displayPath = path.isAbsolute(file) && file.startsWith(root) ? relative(root, file) : file;
    for (let i = 0; i < lines.length; i++) {
      if (!FIXED_DELAY.some((re) => re.test(lines[i]))) continue;
      const verdict = classifyDelay({ lines, idx: i });
      const where = `${displayPath}:${i + 1}`;
      if (verdict.cleared) {
        cleared.push({ where, ...verdict });
        if (list && verdict.clause === "DELAYED-READ") {
          review.push({
            file: displayPath,
            line: i + 1,
            text: `fixed delay before delayed read of page state asserted at line ${verdict.statement?.line}: ${verdict.statement?.text?.slice(0, 80)}`,
          });
        }
      } else {
        candidates.push({ where, ...verdict });
      }
    }
    if (list) review.push(...statusCandidates(displayPath, source));
  }
  return { cleared, candidates, review, unreadable, readCount };
}

function main() {
  const args = process.argv.slice(2);
  const list = args.includes("--list");
  const named = args.filter((a) => !a.startsWith("--"));
  const isRoster = named.length === 0;
  const base = isRoster ? ROOT : process.cwd();
  const files = isRoster
    ? rosterOf(classify()).filter((e) => e.tier === "browser").map((e) => path.resolve(ROOT, e.path))
    : named.map((f) => (path.isAbsolute(f) ? f : path.resolve(process.cwd(), f)));
  if (files.length === 0) {
    console.error("transient-state: REFUSED — no files given and the classifier lists no browser file.");
    return 1;
  }

  const { cleared, candidates, review, unreadable, readCount } = scan(files, { list, root: base });

  if (unreadable.length > 0) {
    console.error(`\ntransient-state: REFUSED — could not read ${unreadable.length} of ${files.length} file(s):`);
    for (const u of unreadable) {
      console.error(`  ${u.file} (${u.path}): ${u.error}`);
    }
    return 1;
  }

  if (readCount === 0) {
    console.error(`\ntransient-state: REFUSED — zero files were successfully read (out of ${files.length} requested).`);
    return 1;
  }

  for (const c of cleared) console.log(`  cleared ${c.where} — ${c.clause}: ${c.detail}`);
  if (list) for (const r of review) console.log(`  review  ${r.file}:${r.line} — exact status assertion, no wait on it: ${r.text}`);

  const scopeNote = isRoster ? ` (root: ${ROOT.replace(/\/+$/, "")})` : ` (base: ${base.replace(/\/+$/, "")})`;
  if (candidates.length === 0) {
    console.log(`transient-state: OK — ${readCount} file(s), ${cleared.length} fixed delay(s), every one cleared by a named clause${scopeNote}`);
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
