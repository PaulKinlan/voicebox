#!/usr/bin/env node
// scripts/docs-touched.mjs — the HAND-WRITTEN half of "the docs describe the system".
//
//   node scripts/docs-touched.mjs                 # check HEAD against origin/main
//   node scripts/docs-touched.mjs <base>          # check HEAD against another base
//
// WHY THIS EXISTS. `scripts/docs-check.mjs` regenerates the blocks marked BEGIN GENERATED and goes red
// when the code moves under them. Everything OUTSIDE those markers is written by a person and has
// nothing watching it — and on 2026-09-20 a paragraph written by hand ("a sandbox-level report of what
// the process can reach is neither, here") was FALSE WITHIN THE HOUR, because `GET /api/probe` landed
// underneath it while the generated block beside it went red and was regenerated. Paul's rule
// (voicebox-beads-ths): "after each update the docs including readme should be updated."
//
// A RULE THAT ASKS POLITELY IS NOT A MECHANISM. So this is the smallest thing that fails loudly:
//
//   the documents already declare what they describe — every file path they name in backticks —
//   and git already knows what a change touched. The gate is the INTERSECTION.
//
// Change a file a document names, without touching any document, and this exits 1 naming both sides.
//
// AND IT MUST NOT BE A GATE THAT ALWAYS FAILS — the failure this repository keeps finding (a gate red
// for a property of the base, blaming the work). Most changes to a described file do not change what
// the document says about it, so there is an explicit, RECORDED way past: a `Docs-checked:` trailer in
// the commit message naming why no document moved. Explicit and readable beats silent and absent — the
// escape hatch is the checklist item, made into a thing a reader can audit later.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// THE CHECKOUT WE WERE PUT IN, never the directory this file lives in. A root resolved from
// `import.meta.url` would make every fixture test a test of voicebox itself — so the mechanism
// could never be driven against a scratch repository, which is how a gate ends up with no test
// that can fail. (The lesson is `scripts/nightly-prs.mjs`'s, in isocan, learned the same way.)
const ROOT = process.cwd();
const TRAILER = "Docs-checked:";

const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const gitTry = (args) => { try { return { ok: true, out: git(args) }; } catch (e) { return { ok: false, out: String(e?.stderr ?? e?.message ?? e).trim() }; } };

/** Every document a person writes in: the root markdown files and docs/, minus generated evidence. */
export function documents() {
  const docs = readdirSync(ROOT).filter((f) => f.endsWith(".md"));
  for (const f of readdirSync(join(ROOT, "docs"))) if (f.endsWith(".md")) docs.push(join("docs", f));
  return docs;
}

/**
 * The file paths a document NAMES in backticks — its own declaration of what it describes.
 *
 * TWO SHAPES, because the most heavily described file in this tree has no slash in it:
 * `lib/extensions.mjs` and a bare `server.mjs` (named by four documents).
 *
 * THIS MATCH IS DELIBERATELY WIDER THAN `docs-check.mjs`'s, and the two are NOT the same question —
 * measured before writing this comment: the bare shape also catches 148 pieces of prose that merely
 * look like a filename (`result.ok`, `bounds.hosts`, `path.basename`, `Deno.env`). That is fatal for
 * "every named path must exist" (docs-check's narrow, nested-only match, which stays narrow) and
 * harmless here, because every caller below filters through `existsSync`: a false positive names no
 * file, so it describes nothing and falls out. One regex per question, each as wide as its own
 * filter allows.
 */
export function namedPaths(text) {
  // A FILENAME MAY CARRY MORE THAN ONE DOT, and the first version of this regex could not see it:
  // `[\w-]+\.[a-z]+` matched `channel.test.mjs` nowhere, so EVERY `tests/*.test.mjs` this repository
  // names in prose — including this gate's own test — was invisible to the gate. Found by asking the
  // mechanism whether it covered its own new files; it did not. Dotted segments now repeat.
  //
  // A nested path may also end WITHOUT an extension (`.githooks/pre-push`): inside a path that already
  // has a slash that is unambiguous enough, and `existsSync` in `describedFiles()` throws away anything
  // that is not a real file anyway.
  const nested = [...text.matchAll(/`((?:[\w.-]+\/)+[\w-]+(?:\.[\w-]+)*)`/g)].map((m) => m[1]);
  const bare = [...text.matchAll(/`([\w-]+(?:\.[\w-]+)+)`/g)].map((m) => m[1]);
  return new Set([...nested, ...bare]);
}

/** path -> the documents that name it (only paths that exist; a missing one is docs-check's finding). */
export function describedFiles() {
  const by = new Map();
  for (const doc of documents()) {
    for (const p of namedPaths(readFileSync(join(ROOT, doc), "utf8"))) {
      if (!existsSync(join(ROOT, p))) continue;
      if (!by.has(p)) by.set(p, []);
      by.get(p).push(doc);
    }
  }
  return by;
}

const isDoc = (file) => file.endsWith(".md");

function main() {
  const base = process.argv[2] ?? "origin/main";
  const ref = gitTry(["rev-parse", "--verify", `${base}^{commit}`]);
  if (!ref.ok) {
    // Not knowing the base is not a pass and not a failure of the change: say so and stand down.
    console.log(`docs-touched: skipped — '${base}' is not a ref here (${ref.out.split("\n")[0]})`);
    return 0;
  }
  const changed = gitTry(["diff", "--name-only", `${base}...HEAD`]);
  if (!changed.ok) {
    console.error(`docs-touched: could not read what changed against ${base}: ${changed.out}`);
    return 1;
  }
  const files = changed.out.split("\n").map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) {
    console.log(`docs-touched: OK — nothing changed against ${base}`);
    return 0;
  }

  const described = describedFiles();
  const moved = files.filter((f) => described.has(f) && !isDoc(f));
  if (moved.length === 0) {
    console.log(`docs-touched: OK — ${files.length} file(s) changed, none of them described by a document`);
    return 0;
  }
  if (files.some(isDoc)) {
    console.log(`docs-touched: OK — ${moved.length} described file(s) changed and ${files.filter(isDoc).length} document(s) changed with them`);
    return 0;
  }

  const messages = gitTry(["log", "--format=%B", `${base}..HEAD`]);
  const excused = messages.ok && messages.out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(TRAILER));
  if (excused && excused.length > 0) {
    console.log(`docs-touched: OK — no document changed, and the change says why:`);
    for (const line of excused) console.log(`  ${line}`);
    return 0;
  }

  console.error("docs-touched: FAILED — these changed files are described by documents nothing in this change touched:");
  for (const file of moved) console.error(`  ${file}  — described in ${described.get(file).join(", ")}`);
  console.error("");
  console.error("Paul's rule (voicebox-beads-ths): every update updates the docs and the README in the same change.");
  console.error("The generated blocks answer for themselves (npm run docs:write); the prose around them does not.");
  console.error("");
  console.error("So either update the document that describes what you moved, or say why it did not need one:");
  console.error(`  git commit --amend --trailer "${TRAILER} <why the prose is still true>"`);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("docs-touched.mjs")) process.exit(main());
