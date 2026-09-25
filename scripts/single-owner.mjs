#!/usr/bin/env node
// scripts/single-owner.mjs — one fact, one computing site.
//
//   node scripts/single-owner.mjs                # check the tree you are standing in
//   node scripts/single-owner.mjs --root <dir>   # check another tree (the fixture in the test does)
//
// WHY THIS EXISTS (bead voicebox-beads-y5k). A component that answers from its own copy of a fact
// instead of asking the owner of the fact is how two answers to one question start disagreeing. The
// bead names the recognition rule — "ask of any component: is this answering about itself?" — and one
// of its signals is mechanically answerable: TWO PLACES COMPUTING THE SAME ANSWER.
//
// So the facts declare themselves, and this check derives everything from that declaration.
// `lib/state-dirs.mjs` exports `FACTS`, one entry per fact, carrying the variable's name and the shape
// of its default. Three things follow, and each one can fail:
//
//   1. every read of the fact's variable must be IN the owner — a fourth copy of
//      `process.env.VOICEBOX_EXTENSIONS_DIR` anywhere else in the tree is refused, by name;
//   2. every rebuild of the fact's DEFAULT must be in the owner — `path.join(ROOT, "extensions")` is
//      the same answer as the variable when the variable is unset, so it is the same defect;
//   3. the owner must actually answer for every fact it declares — driven, not read: the variable is
//      set to a probe value and the fact's own `value()`/`declared()` must return it (and null when
//      the variable is absent). A declaration with no implementation is refused, not passed.
//
// A FOURTH COPY GOES RED HERE, and `tests/single-owner.test.mjs` proves it: it adds one to a copy of
// the tree and watches this refuse, then removes it and watches this pass.
//
// WHAT IT DOES NOT DO — the limits, named because a check is only as wide as its own pattern:
//   * it sees the VARIABLE and the DEFAULT, not the fact. A second answer computed from a different
//     input is invisible to it; this narrows the class, it does not close it;
//   * it does not scan `tests/`. A test SUPPLIES these facts — it points the variable at a scratch
//     directory, in-process or in a child. The rule is about the shipped tree, where one fact must
//     have one answer. The same reason excludes docs/ (prose and evidence), .beads/ (task state),
//     workspace/ (a root the product writes) and node_modules;
//   * it is not a general duplicate detector. It answers for the facts the owner declares, and for
//     nothing else;
//   * COMMENTS ARE NOT SCANNED. Naming the variable in prose is how a reader learns the fact exists,
//     so a comment that quotes it is documentation, not a copy — and a check that goes red for its own
//     documentation is a check somebody turns off. Code only. (The first run of this script failed on
//     the comment you are reading, which is why the rule is written down here.)
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OWNER = "lib/state-dirs.mjs";
const SCANNABLE = new Set([".mjs", ".js", ".cjs", ".mts", ".cts", ".ts"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "docs", "tests", "workspace", ".beads"]);

const requested = (() => {
  const i = process.argv.indexOf("--root");
  return i >= 0 ? process.argv[i + 1] : null;
})();
const ROOT = path.resolve(requested ?? process.cwd());

/** Every source file under `dir`, as a path relative to ROOT. */
function sources(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sources(path.join(dir, entry.name), out);
    } else if (SCANNABLE.has(path.extname(entry.name))) {
      out.push(path.relative(ROOT, path.join(dir, entry.name)));
    }
  }
  return out;
}

/** What a read of a named environment variable looks like — both shapes docs-check accepts. */
const readsLike = (env) =>
  new RegExp(`(?:globalThis\\s*\\.\\s*)?process\\s*\\??\\.\\s*env\\s*\\??\\.\\s*${env}\\b`);

/**
 * The CODE, with every comment blanked out and line numbers preserved. Full-line comments, trailing
 * comments and block comments all go; `://` in a URL and `\/\/` in a regex do not start one.
 * (Deliberately not a parser: the shapes it has to survive are the ones this tree actually writes.)
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, "")) // block: keep its newlines
    .split("\n")
    .map((line) => {
      const m = /(^|[^:\\])\/\//.exec(line);
      return m ? line.slice(0, m.index + m[1].length) : line;
    })
    .join("\n");
}

/** Does the owner answer for this fact? Driven, not read: the declaration must have an implementation. */
function probe(fact) {
  const saved = process.env[fact.env];
  const sentinel = `/single-owner-probe/${fact.id}`;
  const attempt = (run) => {
    try {
      return { ok: true, value: run() };
    } catch (e) {
      return { ok: false, value: String(e?.message ?? e) };
    }
  };
  try {
    process.env[fact.env] = sentinel;
    const answered = attempt(() => fact.value?.());
    const declared = attempt(() => fact.declared?.());
    delete process.env[fact.env];
    const undeclared = attempt(() => fact.declared?.());
    return {
      ok: answered.ok && answered.value === sentinel && declared.ok && declared.value === sentinel && undeclared.ok && undeclared.value === null,
      answered: answered.value,
      declared: declared.value,
      undeclared: undeclared.value,
    };
  } finally {
    if (saved === undefined) delete process.env[fact.env];
    else process.env[fact.env] = saved;
  }
}

async function main() {
  const ownerPath = path.join(ROOT, OWNER);
  if (!existsSync(ownerPath) || !statSync(ownerPath).isFile()) {
    console.error(`single-owner: FAILED — no owner module at ${OWNER} under ${ROOT}; nothing owns these facts.`);
    return 1;
  }
  let owner;
  try {
    owner = await import(pathToFileURL(ownerPath).href);
  } catch (e) {
    console.error(`single-owner: FAILED — could not load ${OWNER} under ${ROOT}: ${e?.message ?? e}`);
    return 1;
  }
  const facts = Object.values(owner.FACTS ?? {}).filter((f) => f && typeof f === "object");
  if (facts.length === 0 || facts.some((f) => typeof f.env !== "string" || typeof f.id !== "string")) {
    console.error(`single-owner: FAILED — ${OWNER} declares no usable FACTS; there is nothing to keep single-owner.`);
    return 1;
  }

  const files = sources();
  const violations = [];
  for (const file of files) {
    if (file === OWNER) continue;
    withoutComments(readFileSync(path.join(ROOT, file), "utf8")).split("\n").forEach((line, i) => {
      for (const fact of facts) {
        const reads = readsLike(fact.env).test(line);
        const rebuilds = fact.recomputed instanceof RegExp && fact.recomputed.test(line);
        if (reads || rebuilds) violations.push({ file, line: i + 1, fact, reads, rebuilds, text: line.trim() });
      }
    });
  }

  const probes = new Map(facts.map((fact) => [fact.id, probe(fact)]));
  const unowned = facts.filter((fact) => !probes.get(fact.id).ok);
  const failed = violations.length > 0 || unowned.length > 0;

  console.log(`single-owner: ${facts.length} declared fact(s) across ${files.length} source file(s) under ${ROOT}`);
  for (const fact of facts) {
    const mine = violations.filter((v) => v.fact === fact).length;
    const verdict = mine === 0 && !unowned.includes(fact) ? "OK  " : "FAIL";
    console.log(`  ${verdict} ${fact.id.padEnd(11)} ${fact.env.padEnd(26)} owner ${OWNER} — ${fact.asks}`);
  }
  if (!failed) {
    console.log("single-owner: OK — every declared fact has exactly one computing site");
    return 0;
  }

  if (unowned.length > 0) {
    console.error("");
    console.error("single-owner: FAILED — the owner does not answer for every fact it declares:");
    for (const fact of unowned) {
      const p = probes.get(fact.id);
      console.error(`  ${OWNER}  ${fact.id} (${fact.env}) — value() returned ${JSON.stringify(p.answered)} with the variable set to a probe, declared() ${JSON.stringify(p.declared)}, and ${JSON.stringify(p.undeclared)} when it was absent.`);
    }
  }
  if (violations.length > 0) {
    console.error("");
    console.error("single-owner: FAILED — a component computed a fact it does not own (voicebox-beads-y5k):");
    for (const v of violations) {
      const how = v.reads ? `reads ${v.fact.env}` : "rebuilds the default";
      console.error(`  ${v.file}:${v.line}  ${v.fact.id.padEnd(11)} ${how} — the owner is ${OWNER}; ask ${v.fact.asks}`);
      console.error(`      ${v.text.slice(0, 120)}`);
    }
    console.error("");
    console.error("The pattern: a component that answers from its own copy of a fact instead of asking the");
    console.error("owner of the fact. Two places computing the same answer is how one of them goes stale.");
    console.error("Route the question through the owner, or move the fact into it — do not keep a copy.");
  }
  return 1;
}

process.exit(await main());
