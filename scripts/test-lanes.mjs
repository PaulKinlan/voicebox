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
//   · a launch NAME (createServer) counts where the code uses it,
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
/**
 * A harness path is DATA until something CONSUMES it (voicebox-beads-l79v, voicebox-beads-oktn).
 * The PATH signals used to match a quoted path anywhere in the file's text, so a pure unit test that merely
 * NAMED the CDP helper as fixture data was filed in the serial browser lane and hidden from the unit fast
 * gate. Each path signal now requires an EDGE that makes it behaviour: an import/require, a write, a
 * direct, variable-bound, or aliased spawn/exec/fork, or a constructed path (path.join/resolve,
 * fileURLToPath, new URL). Tracing uses the token stream from lex(source) (ignoring comments) to bind
 * variables and enforce argument positioning (so unrelated spawns and options properties like env.args do
 * not promote data fixtures, voicebox-beads-oktn).
 */
const SPAWNS = new Set(["spawn", "spawnSync"]);
const EXEC_FILES = new Set(["execFile", "execFileSync", "fork"]);
const EXECS = new Set(["exec", "execSync"]);
const ALL_WRITES = new Set(["writeFileSync", "writeFile", "appendFileSync", "appendFile", "createWriteStream"]);

function parseCallArgs(code, at) {
  const args = [[]];
  const nest = [];
  let j = at + 1;
  if (code[j]?.v !== "(") return null;
  nest.push("(");
  j++;
  for (; j < code.length; j++) {
    const tok = code[j];
    const { k, v } = tok;
    if (k === "punct" && (v === "(" || v === "[" || v === "{" || v === "${")) {
      nest.push(v);
      args[args.length - 1].push(tok);
    } else if (k === "punct" && (v === ")" || v === "]" || v === "}")) {
      nest.pop();
      if (nest.length === 0) break;
      args[args.length - 1].push(tok);
    } else if (k === "punct" && v === "," && nest.length === 1) {
      args.push([]);
    } else {
      args[args.length - 1].push(tok);
    }
  }
  return { args, endAt: j };
}

function checkConsumes(src, name) {
  const nameLitRe = new RegExp(`^["'\`][^"'\\\`]*\\b${name}["'\`]$`);
  const nameWordRe = new RegExp(`\\b${name}\\b`);
  if (!nameWordRe.test(src)) return false;

  const tokens = lex(src);
  if (!tokens) return true; // conservative fallback if lex fails
  const code = tokens.filter(({ k }) => k !== "com");

  const matchesLit = (t) =>
    (t.k === "str" && nameLitRe.test(src.slice(t.s, t.e))) ||
    (t.k === "tpl" && nameWordRe.test(src.slice(t.s, t.e)));

  function isPathExpr(exprTokens) {
    if (exprTokens.length === 0) return false;
    if (exprTokens.length === 1) {
      const t = exprTokens[0];
      if (t.k === "str" && nameLitRe.test(src.slice(t.s, t.e))) return true;
      if (t.k === "word" && matchedVars.has(t.v)) return true;
      return false;
    }
    if (exprTokens[0]?.v === "[" && exprTokens.at(-1)?.v === "]") {
      for (const t of exprTokens) {
        if (t.k === "str" && nameLitRe.test(src.slice(t.s, t.e))) return true;
        if (t.k === "word" && matchedVars.has(t.v)) return true;
      }
      return false;
    }
    for (let k = 0; k < exprTokens.length; k++) {
      const t = exprTokens[k];
      if (t.k === "word" && (t.v === "join" || t.v === "resolve" || t.v === "fileURLToPath" || t.v === "URL")) {
        for (const tok of exprTokens) {
          if (tok.k === "str" && nameLitRe.test(src.slice(tok.s, tok.e))) return true;
          if (tok.k === "word" && matchedVars.has(tok.v)) return true;
        }
        return false;
      }
    }
    return false;
  }

  // Step 1: Trace variables that hold matching path literals or arrays/constructions of them
  const matchedVars = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < code.length; i++) {
      const t = code[i];
      if (t.k === "word" && (t.v === "const" || t.v === "let" || t.v === "var")) {
        let j = i + 1;
        while (j < code.length && code[j].k !== "punct" && code[j].v !== ";") {
          if (code[j].k === "word" && code[j + 1]?.v === "=") {
            const varName = code[j].v;
            const nest = [];
            let k = j + 2;
            const exprTokens = [];
            for (; k < code.length; k++) {
              const cur = code[k];
              if (cur.k === "punct" && (cur.v === "(" || cur.v === "[" || cur.v === "{" || cur.v === "${")) nest.push(cur.v);
              else if (cur.k === "punct" && (cur.v === ")" || cur.v === "]" || cur.v === "}")) nest.pop();
              else if (cur.k === "punct" && (cur.v === "," || cur.v === ";") && nest.length === 0) break;
              exprTokens.push(cur);
            }
            if (isPathExpr(exprTokens) && !matchedVars.has(varName)) {
              matchedVars.add(varName);
              changed = true;
            }
            j = k;
          } else {
            j++;
          }
        }
      }
    }
  }

  // Step 2: Check for consuming edges
  for (let i = 0; i < code.length; i++) {
    const t = code[i];

    // Edge 0: template containing staged import edge (e.g. staged-fixture.test.mjs)
    if (t.k === "tpl") {
      const txt = src.slice(t.s, t.e);
      if (new RegExp(`(?:\\bfrom|\\bimport)\\b[^;]{0,160}?["'\`][^"'\`]*\\b${name}["'\`]`).test(txt)) {
        return true;
      }
    }

    // Edge 1: import ... from "..." or import "..." or import("...")
    if (t.k === "word" && t.v === "import") {
      if (code[i + 1]?.v === "(") {
        const parsed = parseCallArgs(code, i);
        if (parsed) {
          const arg0 = parsed.args[0] || [];
          if (arg0.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
        }
      }
      for (let j = i + 1; j < code.length && code[j].v !== ";"; j++) {
        if (matchesLit(code[j])) return true;
      }
    }

    // Edge 2: require("...")
    if (t.k === "word" && t.v === "require" && code[i + 1]?.v === "(") {
      const parsed = parseCallArgs(code, i);
      if (parsed) {
        const arg0 = parsed.args[0] || [];
        if (arg0.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
      }
    }

    // Edge 3: path.join, path.resolve
    if (t.k === "word" && (t.v === "join" || t.v === "resolve") && code[i - 1]?.v === "." && code[i - 2]?.v === "path") {
      if (code[i + 1]?.v === "(") {
        const parsed = parseCallArgs(code, i);
        if (parsed) {
          for (const arg of parsed.args) {
            if (arg.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
          }
        }
      }
    }

    // Edge 4: fileURLToPath, new URL
    if (t.k === "word" && t.v === "fileURLToPath" && code[i + 1]?.v === "(") {
      const parsed = parseCallArgs(code, i);
      if (parsed) {
        const arg0 = parsed.args[0] || [];
        if (arg0.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
      }
    }
    if (t.k === "word" && t.v === "URL" && code[i - 1]?.v === "new" && code[i + 1]?.v === "(") {
      const parsed = parseCallArgs(code, i);
      if (parsed) {
        const arg0 = parsed.args[0] || [];
        if (arg0.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
      }
    }

    // Edge 5: write* (arg 0 only)
    if (t.k === "word" && ALL_WRITES.has(t.v) && code[i + 1]?.v === "(") {
      const parsed = parseCallArgs(code, i);
      if (parsed) {
        const arg0 = parsed.args[0] || [];
        if (arg0.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
      }
    }

    // Edge 6: exec, execSync (arg 0)
    if (t.k === "word" && EXECS.has(t.v) && code[i + 1]?.v === "(") {
      const parsed = parseCallArgs(code, i);
      if (parsed) {
        const arg0 = parsed.args[0] || [];
        if (arg0.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
      }
    }

    // Edge 7: execFile, execFileSync, fork (arg 0, or arg 1 array)
    if (t.k === "word" && EXEC_FILES.has(t.v) && code[i + 1]?.v === "(") {
      const parsed = parseCallArgs(code, i);
      if (parsed) {
        const arg0 = parsed.args[0] || [];
        if (arg0.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
        const arg1 = parsed.args[1] || [];
        if (arg1[0]?.v !== "{") {
          if (arg1.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
        }
      }
    }

    // Edge 8: spawn, spawnSync (arg 0, or positional arg 1 without "{")
    if (t.k === "word" && SPAWNS.has(t.v) && code[i + 1]?.v === "(") {
      const parsed = parseCallArgs(code, i);
      if (parsed) {
        const arg0 = parsed.args[0] || [];
        if (arg0.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
        const arg1 = parsed.args[1] || [];
        if (arg1.length > 0 && arg1[0]?.v !== "{") {
          if (arg1.some((tok) => matchesLit(tok) || (tok.k === "word" && matchedVars.has(tok.v)))) return true;
        }
      }
    }
  }

  return false;
}

const consumes = (name) => ({
  test(src) {
    return checkConsumes(src, name);
  },
});

const BROWSER_SIGNALS = [
  { what: "a browser over CDP", re: consumes("cdp\\.mjs") },
  // The shard runner IS a browser launch — it spawns one Chromium per file it dispatches — so a test that
  // spawns it owns a browser and must not be filed in the concurrent lane beside three of its siblings
  // (voicebox-beads-zjpm.3). Named by PATH, like the helpers above, because the launch is on the other
  // side of the spawn.
  { what: "a browser via the shard runner", re: consumes("browser-shard-runner\\.mjs") },
  { what: "a browser via page-acceptance", re: consumes("page-acceptance\\.mjs") },
  { what: "a browser over raw CDP", re: /--remote-debugging-port|DevToolsActivePort/ },
];

const SERVER_SIGNALS = [
  { what: "a server process", re: consumes("server\\.mjs") },
  { what: "a server via task-fixture", re: consumes("task-fixture\\.mjs") },
  { what: "a server via createServer", re: /\bcreateServer\b/, name: true },
  // `callWasmTool` used to be a live signal because the wasm cell was a worker that could outlive its
  // test by ~52s at ~3 cores (voicebox-beads-6io), which is why tests/wasm-shelf.test.mjs stayed out of
  // the concurrent unit lane. u2lx (6ffe613) made the cell a child process SIGKILLed at the deadline
  // (measured: dies at 5031ms, suite 65.5s → 10.3s), so the reason is gone and voicebox-beads-0i14
  // moved the file to the unit lane it belongs in. The NAME rule above (`createServer`) is unchanged.
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
function topLaneDeclaration(source, tokens) {
  // The lexer retains leading comment tokens before read() blanks them. An unreadable file still honors a
  // top-of-file declaration: its raw-code fallback must not silently bypass a declared unit boundary.
  const comments = [];
  if (tokens) {
    for (const token of tokens) {
      if (token.k !== "com") break;
      comments.push(source.slice(token.s, token.e));
    }
  } else {
    const header = source.match(/^(?:(?:\s*\/\/[^\n]*(?:\n|$))|(?:\s*\/\*[\s\S]*?\*\/))*/)?.[0] ?? "";
    comments.push(...header.split("\n").filter((line) => /^\s*\/\//.test(line)));
  }
  const directives = comments.map((text) => text.trim()).filter((text) => /^\/\/\s*@lane\b/.test(text));
  if (directives.length === 0) return { declaredLane: null, declarationError: null };
  if (directives.length > 1) return { declaredLane: null, declarationError: "multiple top-of-file @lane declarations" };
  const lane = directives[0].match(/^\/\/\s*@lane\s+(unit|server|browser)\s*$/)?.[1] ?? null;
  return { declaredLane: lane, declarationError: lane ? null : `invalid declaration ${directives[0]} (expected // @lane unit|server|browser)` };
}

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
  const views = { text: text.join(""), code: code.join(""), ...topLaneDeclaration(source, tokens) };
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
    const declaration = views ?? topLaneDeclaration(source, null);
    const reading = ({ name }) => (!views ? source : name && !views.evaluates ? views.code : views.text);

    // Any browser launch puts the test in the browser lane (strictly serial, CDP contention):
    const browserLaunch = BROWSER_SIGNALS.find((signal) => signal.re.test(reading(signal)));
    if (browserLaunch) {
      const entry = { file, lane: "browser", why: browserLaunch.what, declaredLane: declaration.declaredLane, declarationError: declaration.declarationError };
      browser.push(entry);
      live.push(entry);
      continue;
    }

    // Otherwise, any server launch puts it in the server lane (concurrent):
    const serverLaunch = SERVER_SIGNALS.find((signal) => signal.re.test(reading(signal)));
    if (serverLaunch) {
      const entry = { file, lane: "server", why: serverLaunch.what, declaredLane: declaration.declaredLane, declarationError: declaration.declarationError };
      server.push(entry);
      live.push(entry);
      continue;
    }

    unit.push({ file, lane: "unit", why: null, declaredLane: declaration.declaredLane, declarationError: declaration.declarationError });
  }
  return { unit, live, server, browser };
}

/** Report exact file-level boundaries without pinning global counts that change whenever a file is added. */
export function checkDeclaredLanes({ unit, server, browser }) {
  const problems = [];
  for (const entry of [...unit, ...server, ...browser]) {
    if (entry.declarationError) problems.push(`${entry.file}: ${entry.declarationError}`);
    else if (entry.declaredLane && entry.lane !== entry.declaredLane) {
      problems.push(`${entry.file}: declared @lane ${entry.declaredLane}, classified ${entry.lane} (${entry.why ?? "no browser/server launch signal"})`);
    }
  }
  return problems;
}

// THE CLI RUNS ONLY WHEN THIS FILE IS THE PROGRAM (voicebox-beads-hhkg). `classify()` is the one
// owner of "which file is in which lane", and the browser tier's shard runner asks it in process
// rather than parsing this file's stdout back into paths. Before this guard the CLI ran on IMPORT
// too, so an importer inherited the caller's `--lane`/`--check` argv and printed a lane dump as a
// side effect of loading a module. `classify()` itself still runs at top level: it is pure, it reads
// the tests directory, and it prints nothing.
const CLI = import.meta.main;
const laneArg = process.argv.includes("--lane") ? process.argv[process.argv.indexOf("--lane") + 1] : null;
const { unit, live, server, browser } = classify();

if (CLI && process.argv.includes("--check")) {
  const seen = new Set();
  const problems = [];
  for (const { file } of [...unit, ...live]) {
    if (seen.has(file)) problems.push(`${file} is in both lanes`);
    seen.add(file);
  }
  if (unit.length + live.length !== seen.size) problems.push("a file is in neither lane");
  if (server.length + browser.length !== live.length) problems.push("server and browser do not partition live");
  const allTests = readdirSync(TESTS).filter((file) => file.endsWith(".test.mjs"));
  for (const file of allTests) if (!seen.has(file)) problems.push(`${file} is in neither lane`);
  problems.push(...checkDeclaredLanes({ unit, server, browser }));
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

if (CLI && (laneArg === "unit" || laneArg === "live" || laneArg === "server" || laneArg === "browser")) {
  const map = { unit, live, server, browser };
  const files = map[laneArg].map(({ file }) => `tests/${file}`);
  console.log(files.join(" "));
  process.exit(0);
}

if (CLI) {
  console.log(`unit: ${unit.length} files\nlive: ${live.length} files`);
  for (const { file, why } of live) console.log(`  live  ${file} — ${why}`);
}
