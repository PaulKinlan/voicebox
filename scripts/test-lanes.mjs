#!/usr/bin/env node
// scripts/test-lanes.mjs — which test files are UNIT and which are LIVE.
//
// WHY TWO LANES (voicebox-beads-6qu, measured 2026-09-23): the pre-push gate ran
// the whole suite with the default runner, and node runs test FILES
// concurrently. Live tests — ones that launch a real Chromium over CDP or a real
// server process — then interfere with their neighbours: `extension-approval-ui`
// failed INSIDE the suite twice at ~20.5s while passing 1/1 alone AND passing in
// a serial run of the entire suite at load average 36, HIGHER than during any
// refusal. So the mechanism is the suite's own concurrency, not the box, and the
// fix is to keep the slow, resource-owning files out of the concurrent pass.
//
// THE RULE THAT KEEPS THIS HONEST: a file is classified by what it IMPORTS or
// SPAWNS, read from its code with comments stripped (a file that merely mentions
// a browser in a comment is a unit test), and every file lands in exactly one
// lane. `--check` fails if a test file is in neither or in both, so a new test
// cannot silently escape the lanes the way it could escape a hand-kept list.
//
// CODE, NOT DATA (voicebox-beads-k96l, 2026-09-28): stripping comments was not
// enough. This classifier's own test was filed LIVE ("a browser over CDP") and run
// in the serial lane, because it WRITES fixture test files whose source text
// imports ./lib/cdp.mjs — and any test that writes live-looking fixture source was
// misfiled the same way. So each file is now LEXED (strings, templates, regexes
// and comments told apart, not guessed at by a regex) and read by role:
//   · a comment is not code — a trailing one included — and a glob such as
//     "tests/*.mjs" inside a string, or a "/*" inside a regex, no longer opens a
//     "comment" that hides the code after it (the old regex strip did exactly that);
//   · what a test WRITES is data: a string or template literal in the content
//     argument of writeFileSync/writeFile/appendFileSync/appendFile is not read
//     for a launch. The PATH it writes to still is, and so is ${…} code inside it
//     and any literal inside a call or a function among its arguments;
//   · a launch NAME (createServer, callWasmTool) counts where the code uses it,
//     not in a test title or an assertion message — unless the file hands source
//     text to an evaluator (node -e/-p, a shell, eval/Function/vm, an eval
//     Worker), and then every literal it keeps is read as code, as before;
//   · a helper counts by its FILE NAME in any string the file does not write: a
//     static or a dynamic import, a path handed to a spawn, a path.join segment,
//     one built in a template literal (`${ROOT}/server.mjs`) included.
// Every doubt resolves to LIVE, because the costs are not symmetric: a live test
// misfiled as unit is the 6qu flake back inside the concurrent lane, while a unit
// test misfiled as live costs seconds. So a literal staged in a variable and
// written later is still read, and a file the lexer cannot read to its end is
// read raw, comments and all. The limits, named: a test that writes a script and
// then RUNS it must name the launch in its own code — a written file is not
// followed into the child process that runs it — and a launch NAME inside a
// program piped to a child's stdin is not seen (a helper PATH there still is).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "tests");

/**
 * What makes a file LIVE: it starts a browser, or a server of its own. A PATH signal
 * is the helper's FILE NAME in any quoted value the file does not write — a static or
 * dynamic import, a spawn argument, a `path.join(…, "lib", "cdp.mjs")` segment — and a
 * NAME signal (`name: true`) counts only where its code uses the identifier
 * (voicebox-beads-k96l, the header above).
 */
const BROWSER_SIGNALS = [
  { what: "a browser over CDP", re: /["'`][^"'`]*\bcdp\.mjs["'`]/ },
  { what: "a browser via page-acceptance", re: /\bpage-acceptance\.mjs\b/ },
];

const SERVER_SIGNALS = [
  { what: "a server process", re: /["'`][^"'`]*\bserver\.mjs["'`]/ },
  { what: "a server via task-fixture", re: /["'`][^"'`]*\btask-fixture\.mjs["'`]/ },
  { what: "a server via createServer", re: /\bcreateServer\b/, name: true },
  { what: "worker threads or wasm execution", re: /\bcallWasmTool\b/, name: true },
];

const LAUNCHES = [...BROWSER_SIGNALS, ...SERVER_SIGNALS];

/** The calls whose CONTENT argument is data the test writes, not code it runs. */
const WRITES = new Set(["writeFileSync", "writeFile", "appendFileSync", "appendFile"]);

/**
 * A file that hands source text to an evaluator: then a literal it keeps may be the
 * code that launches, so its NAME signals are read in its strings as well.
 */
const EVALUATES = {
  // in the strings it keeps: node -e/-p/--eval/--print, a shell's -c (combined too: bash -lc,
  // node -pe), --input-type, vm, a data: module
  text: /["'`](?:-[a-z]*[cep]|--eval|--print)["'`]|["'`]--(?:eval|print|input-type)=|["'`](?:node:)?vm["'`]|data:(?:text|application)\/(?:java|ecma)script/,
  // in its code: eval, Function, vm, an eval Worker, a shell
  code: /(?<![\w$.])(?:eval|Function)\s*\(|\bnew\s+Function\b|\bvm\s*\.|\beval\s*:\s*true\b|\bshell\s*:\s*(?!false\b)|(?<![\w$])execSync\s*\(|(?<![\w$.])exec\s*\(/,
};

/** Words after which a `/` opens a regex literal instead of dividing. */
const BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
/** Keywords whose parenthesised head a statement follows — so a `/` after the `)` opens a regex too. */
const HEADS = new Set(["if", "for", "while", "with"]);
const OPENS = { ")": "(", "]": "[", "}": "{" };
const isIdStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || (c > "\x7f" && /\p{ID_Start}/u.test(c));
const isIdPart = (c) => isIdStart(c) || (c >= "0" && c <= "9") || (c > "\x7f" && /[\p{ID_Continue}\u200c\u200d]/u.test(c));

/** Where the regex literal opening at `i` ends — or -1 if its line ends first, so it was a division. */
function regexEnd(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length && src[j] !== "\n"; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "[") inClass = true;
    else if (src[j] === "]") inClass = false;
    else if (src[j] === "/" && !inClass) {
      for (j++; j < src.length && isIdPart(src[j]); j++);
      return j;
    }
  }
  return -1;
}

/**
 * Just enough of a JavaScript lexer to tell CODE from COMMENTS and LITERALS
 * (voicebox-beads-k96l). Returns the tokens in source order — `word`, `punct`, `num`,
 * `str` (quotes included), `tpl` (a template's static text, delimiters excluded), `re`
 * and `com` — or null when the file cannot be read to its end: an unterminated comment
 * or literal, or a bracket that closes what was never opened. Null is not an error;
 * it sends the file to the raw reading, which over-reads — the safe direction.
 * A `/` is told apart as a parser would, by the token before it: a division after a
 * value, `)`, `]` or `}`; a regex anywhere else — after `return` or an `if (…)` head
 * too. The one guess that can miss, named: a regex opening a statement right after a
 * block's `}`.
 */
function lex(src) {
  const tokens = [];
  const open = []; // brackets still open: "${" for a template substitution, "head" for `if (`
  const n = src.length;
  let i = 0;
  let afterValue = false; // a "/" here divides; anywhere else it opens a regex literal
  const push = (k, s, e, v) => tokens.push({ k, s, e, v });
  /** Static template text from `i` to the closing backtick or the next "${"; false at EOF. */
  const template = () => {
    for (const s = i; i < n; i++) {
      if (src[i] === "\\") {
        i++;
      } else if (src[i] === "`") {
        push("tpl", s, i++);
        afterValue = true;
        return true;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        push("tpl", s, i);
        push("punct", i, i + 2, "${");
        open.push("${");
        i += 2;
        afterValue = false;
        return true;
      }
    }
    return false;
  };
  if (src.startsWith("#!")) {
    i = src.includes("\n") ? src.indexOf("\n") : n;
    push("com", 0, i);
  }
  while (i < n) {
    const c = src[i];
    const s = i;
    let end;
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i) < 0 ? n : src.indexOf("\n", i);
      push("com", s, i);
    } else if (c === "/" && src[i + 1] === "*") {
      end = src.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
      push("com", s, i);
    } else if (c === '"' || c === "'") {
      for (i++; src[i] !== c; i++) {
        if (i >= n || src[i] === "\n") return null;
        if (src[i] === "\\") i += src[i + 1] === "\r" && src[i + 2] === "\n" ? 2 : 1;
      }
      push("str", s, ++i);
      afterValue = true;
    } else if (c === "`") {
      i++;
      if (!template()) return null;
    } else if (c === "/" && !afterValue && (end = regexEnd(src, i)) > 0) {
      i = end;
      push("re", s, i);
      afterValue = true;
    } else if (isIdStart(c)) {
      while (++i < n && isIdPart(src[i]));
      const word = src.slice(s, i);
      push("word", s, i, word);
      afterValue = !BEFORE_REGEX.has(word);
    } else if (c >= "0" && c <= "9") {
      while (++i < n && (isIdPart(src[i]) || src[i] === "."));
      push("num", s, i);
      afterValue = true;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      i++;
      let value = false; // after ")", "]" or "}" a "/" divides — but after `if (…)` it opens a regex
      if (c === "(" || c === "[" || c === "{") open.push(c === "(" && HEADS.has(tokens.at(-1)?.v) ? "head" : c);
      else if (c === ")" || c === "]" || c === "}") {
        const top = open.pop();
        if (c === "}" && top === "${") {
          push("punct", s, i, "}");
          if (!template()) return null;
          continue;
        }
        if ((top === "head" ? "(" : top) !== OPENS[c]) return null;
        value = top !== "head";
      }
      push("punct", s, i, c);
      afterValue = value;
    }
  }
  return open.length === 0 ? tokens : null;
}

/**
 * The literals a write call WRITES: those in its CONTENT argument — after the first
 * top-level comma — that flow straight into the text. One inside a nested call or a
 * grouping, or after a function, may be an argument the code acts on (the path in
 * `spawnSync(…, ["server.mjs"]).stdout`, a callback's spawn), so it is read.
 */
function writtenLiterals(tokens) {
  const code = tokens.filter(({ k }) => k !== "com");
  const written = [];
  for (let at = 0; at < code.length; at++) {
    if (code[at].k !== "word" || !WRITES.has(code[at].v) || code[at + 1]?.v !== "(") continue;
    const nest = []; // brackets open inside the call, its own "(" first
    let content = false;
    for (let j = at + 1; j < code.length; j++) {
      const { k, v } = code[j];
      if (k === "punct" && (v === "(" || v === "[" || v === "{" || v === "${")) nest.push(v);
      else if (k === "punct" && (v === ")" || v === "]" || v === "}")) {
        nest.pop();
        if (nest.length === 0) break;
      } else if (k === "punct" && v === "," && nest.length === 1) content = true;
      else if ((k === "word" && v === "function") || (v === "=" && code[j + 1]?.v === ">")) break;
      else if (content && (k === "str" || k === "tpl") && nest.lastIndexOf("(") === 0) written.push(code[j]);
    }
  }
  return written;
}

/**
 * The readings the signals are matched against, or null when the file does not lex.
 * TEXT is the file without its comments and without the literals it writes — PATH
 * signals are read there. CODE is TEXT without any literal at all — NAME signals are
 * read there, or in TEXT when the file evaluates source text it holds.
 */
function read(source) {
  const tokens = lex(source);
  if (!tokens) return null;
  const text = source.split("");
  const code = source.split("");
  const blank = (chars, s, e) => {
    for (let at = s; at < e; at++) if (chars[at] !== "\n") chars[at] = " ";
  };
  for (const { k, s, e } of tokens) {
    if (k === "com") {
      blank(text, s, e);
      blank(code, s, e);
    } else if (k === "str") blank(code, s + 1, e - 1);
    else if (k === "tpl" || k === "re") blank(code, s, e);
  }
  for (const { k, s, e } of writtenLiterals(tokens)) {
    if (k === "str") blank(text, s + 1, e - 1);
    else blank(text, s, e);
  }
  const views = { text: text.join(""), code: code.join("") };
  views.evaluates = EVALUATES.text.test(views.text) || EVALUATES.code.test(views.code);
  return views;
}

export function classify(root = TESTS) {
  const unit = [];
  const live = [];
  const server = [];
  const browser = [];
  /**
   * A repository with no `tests/` classifies as empty rather than throwing:
   * the GATE FIXTURES drive this script inside a disposable repo to test the
   * refusal mechanics, and a fixture has no tests to sort. The real repository
   * always has them, and `npm test` would fail loudly if it did not.
   */
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  for (const file of entries.filter((f) => f.endsWith(".test.mjs")).sort()) {
    const source = readFileSync(path.join(root, file), "utf8");
    const views = read(source);
    const reading = ({ name }) => (!views ? source : name && !views.evaluates ? views.code : views.text);

    // Any browser launch puts the test in the browser lane (strictly serial, CDP contention):
    const browserLaunch = BROWSER_SIGNALS.find((signal) => signal.re.test(reading(signal)));
    if (browserLaunch) {
      const entry = { file, why: browserLaunch.what };
      browser.push(entry);
      live.push(entry);
      continue;
    }

    // Otherwise, any server or wasm launch puts it in the server lane (concurrent):
    const serverLaunch = SERVER_SIGNALS.find((signal) => signal.re.test(reading(signal)));
    if (serverLaunch) {
      const entry = { file, why: serverLaunch.what };
      server.push(entry);
      live.push(entry);
      continue;
    }

    unit.push({ file, why: null });
  }
  return { unit, live, server, browser };
}

const laneArg = process.argv.includes("--lane") ? process.argv[process.argv.indexOf("--lane") + 1] : null;
const { unit, live, server, browser } = classify();

if (process.argv.includes("--check")) {
  const seen = new Set();
  const problems = [];
  for (const { file } of [...unit, ...live]) {
    if (seen.has(file)) problems.push(`${file} is in both lanes`);
    seen.add(file);
  }
  if (unit.length + live.length !== seen.size) problems.push("a file is in neither lane");
  if (server.length + browser.length !== live.length) problems.push("server and browser do not partition live");
  if (problems.length > 0) {
    console.error(`[lanes] ${problems.join("; ")}`);
    process.exit(1);
  }
  // Coverage only: this runs inside GATE FIXTURES too, which have no tests and
  // must still pass — the pin that the known victims stay LIVE belongs in the
  // test suite (tests/test-lanes.test.mjs), not in a check the gate runs on
  // every repository state.
  console.log(`[lanes] ok: ${unit.length} unit, ${live.length} live`);
  process.exit(0);
}

if (laneArg === "unit" || laneArg === "live" || laneArg === "server" || laneArg === "browser") {
  const map = { unit, live, server, browser };
  const files = map[laneArg].map(({ file }) => `tests/${file}`);
  console.log(files.join(" "));
  process.exit(0);
}

console.log(`unit: ${unit.length} files\nlive: ${live.length} files`);
for (const { file, why } of live) console.log(`  live  ${file} — ${why}`);
