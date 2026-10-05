#!/usr/bin/env node
// scripts/single-owner.mjs — one fact, one computing site.
//
//   node scripts/single-owner.mjs                # check the tree you are standing in
//   node scripts/single-owner.mjs --root <dir>   # check another tree (the fixture in the test does)
//
// WHY THIS EXISTS (bead voicebox-beads-y5k). A component that answers from its own copy of a fact
// instead of asking the owner of the fact is how two answers to one question start disagreeing.
// The bead names the recognition rule — "ask of any component: is this answering about itself?" — and one
// of its signals is mechanically answerable: TWO PLACES COMPUTING THE SAME ANSWER.
//
// So the facts declare themselves, and this check derives everything from that declaration.
// There are now TWO kinds of declaration, each with its own owner module:
//
//   * ENV FACTS — `lib/state-dirs.mjs` exports `FACTS`, one entry per directory fact, carrying the
//     variable's name and the shape of its default. Three things follow, and each one can fail:
//       1. every read of the fact's variable must be IN the owner — a fourth copy of
//          `process.env.VOICEBOX_EXTENSIONS_DIR` anywhere else in the tree is refused, by name;
//       2. every rebuild of the fact's DEFAULT must be in the owner — `path.join(ROOT, "extensions")` is
//          the same answer as the variable when the variable is unset, so it is the same defect;
//       3. the owner must actually answer for every fact it declares — driven, not read: the variable is
//          set to a probe value and the fact's own `value()`/`declared()` must return it (and null when
//          the variable is absent). A declaration with no implementation is refused, not passed.
//
//   * CODE-SHAPE SITES (voicebox-beads-q0a3) — `lib/path-auth.mjs` exports `SITES`, one entry per
//     authorization fact that has no environment variable because it is a SHAPE of code: the lexical
//     containment refusal, the raw prefix compare, the segment-wise dotfile denial. The site declares
//     the patterns that identify a second computing site, and this check refuses them anywhere but the
//     owner. A site may name `skipDirs` (the page tree — core/paths.ts is that placement's lexical
//     owner, and the page cannot import lib/) and `except` files (a DIFFERENT fact that shares a shape,
//     with the reason written down — a named exemption is a recorded decision, and the check prints
//     every one it honoured). The owner must answer here too, driven: the path-auth module's own
//     exports are exercised against a scratch tree (an allowed control, a `..` escape, a dotfile, a
//     symlink out) and a refusal that does not arrive by name fails the check.
//
// A FOURTH COPY GOES RED HERE, and `tests/single-owner.test.mjs` proves it: it adds one to a copy of
// the tree and watches this refuse, then removes it and watches this pass.
//
// WHAT IT DOES NOT DO — the limits, named because a check is only as wide as its own pattern:
//   * it sees the VARIABLE and the DEFAULT (env facts) and the DECLARED SHAPES (sites), not the fact
//     itself. A second answer computed from a different input in a different shape is invisible to it;
//     this narrows the class, it does not close it;
//   * it does not scan `tests/`. A test SUPPLIES these facts — it points the variable at a scratch
//     directory, in-process or in a child. The rule is about the shipped tree, where one fact must
//     have one answer. The same reason excludes docs/ (prose and evidence), .beads/ (task state),
//     workspace/ (a root the product writes) and node_modules;
//   * it is not a general duplicate detector. It answers for the facts the owners declare, and for
//     nothing else;
//   * COMMENTS ARE NOT SCANNED. Naming the variable in prose is how a reader learns the fact exists,
//     so a comment that quotes it is documentation, not a copy — and a check that goes red for its own
//     documentation is a check somebody turns off. Code only. (The first run of this script failed on
//     the comment you are reading, which is why the rule is written down here.)
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OWNERS = [
  { module: "lib/state-dirs.mjs", export: "FACTS", kind: "env" },
  { module: "lib/path-auth.mjs", export: "SITES", kind: "site" },
];
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

/**
 * Does the path-auth owner ANSWER? Driven, not read — the module's own exports are exercised against
 * a scratch tree, and every refusal must arrive BY NAME: an allowed control, a `..` escape, a dotfile
 * (leaf and nested), a symlink out of the root, a new file created through a symlinked directory, and
 * the resolved-path door the mini-app store uses. A copy of this module that stopped refusing any of
 * these is a declaration with no implementation, and the check refuses it.
 */
async function probePathAuth(mod) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "single-owner-pathauth-"));
  try {
    const root = path.join(scratch, "root");
    const outside = path.join(scratch, "outside");
    mkdirSync(path.join(root, "sub"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(root, "notes.txt"), "control\n");
    symlinkSync(outside, path.join(root, "link-out"));
    symlinkSync(path.join(root, "sub"), path.join(root, "link-in"));
    const rootDesc = { kind: "machine", path: root };

    const drives = [
      ["allowed control", () => mod.authorizeMachinePath(rootDesc, "notes.txt"), (r) => r.ok === true && r.path === path.join(root, "notes.txt")],
      ["dot segment normalises inside", () => mod.authorizeMachinePath(rootDesc, "sub/./notes.txt"), (r) => r.ok === true],
      [".. escape", () => mod.authorizeMachinePath(rootDesc, "../evil.sh"), (r) => r.ok === false && r.refused === "outside-root"],
      ["nested .. escape", () => mod.authorizeMachinePath(rootDesc, "sub/../../evil.sh"), (r) => r.ok === false && r.refused === "outside-root"],
      ["dotfile leaf", () => mod.authorizeMachinePath(rootDesc, ".env"), (r) => r.ok === false && r.refused === "dotfile-refused"],
      ["nested dotfile", () => mod.authorizeMachinePath(rootDesc, "sub/.env"), (r) => r.ok === false && r.refused === "dotfile-refused"],
      ["symlink out", () => mod.authorizeMachinePath(rootDesc, "link-out/evil.sh"), (r) => r.ok === false && r.refused === "outside-root"],
      ["symlink in", () => mod.authorizeMachinePath(rootDesc, "link-in/notes.txt"), (r) => r.ok === true],
      ["new file through a symlinked dir", () => mod.authorizeMachinePath(rootDesc, "link-out/new.txt"), (r) => r.ok === false && r.refused === "outside-root"],
      ["page root refuses by name", () => mod.authorizeMachinePath({ kind: "opfs", path: "v1/projects/x" }, "notes.txt"), (r) => r.ok === false && (r.refused === "root-not-reachable-from-here" || r.refused === "not-reachable-from-this-environment")],
      ["no root at all", () => mod.authorizeMachinePath(null, "notes.txt"), (r) => r.ok === false && r.refused === "root-not-declared"],
      ["resolved-path door: allowed", () => mod.authorizeResolvedPath(root, path.join(root, "sub", "app.html")), (r) => r.ok === true],
      ["resolved-path door: escape", () => mod.authorizeResolvedPath(root, path.join(outside, "app.html")), (r) => r.ok === false && r.refused === "outside-root"],
      ["resolved-path door: dotfile", () => mod.authorizeResolvedPath(root, path.join(root, ".hidden.html")), (r) => r.ok === false && r.refused === "dotfile-refused"],
      ["lexical primitive", () => mod.containedIn(root, path.join(root, "a.txt")) && !mod.containedIn(root, outside), (r) => r === true],
      ["realpath primitive", () => mod.realContainedIn(realpathSync(root), path.join(root, "link-out"), { allowEqual: true }), (r) => r === false],
    ];
    const failed = [];
    for (const [label, drive, expect] of drives) {
      let result;
      try {
        result = { ok: true, value: drive() };
      } catch (e) {
        result = { ok: false, value: String(e?.message ?? e) };
      }
      if (!result.ok || !expect(result.value)) failed.push(`${label} → ${JSON.stringify(result.value)}`);
    }
    return { ok: failed.length === 0, failed };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function loadOwners() {
  for (const owner of OWNERS) {
    const ownerPath = path.join(ROOT, owner.module);
    if (!existsSync(ownerPath) || !statSync(ownerPath).isFile()) {
      console.error(`single-owner: FAILED — no owner module at ${owner.module} under ${ROOT}; nothing owns these facts.`);
      return null;
    }
    try {
      owner.mod = await import(pathToFileURL(ownerPath).href);
    } catch (e) {
      console.error(`single-owner: FAILED — could not load ${owner.module} under ${ROOT}: ${e?.message ?? e}`);
      return null;
    }
    const declared = owner.mod[owner.export];
    const entries = Object.values(declared ?? {}).filter((f) => f && typeof f === "object");
    if (entries.length === 0) {
      console.error(`single-owner: FAILED — ${owner.module} declares no usable ${owner.export}; there is nothing to keep single-owner.`);
      return null;
    }
    if (owner.kind === "env" && entries.some((f) => typeof f.env !== "string" || typeof f.id !== "string")) {
      console.error(`single-owner: FAILED — ${owner.module} declares unusable ${owner.export} entries (env facts need id + env).`);
      return null;
    }
    if (owner.kind === "site" && entries.some((f) => typeof f.id !== "string" || !Array.isArray(f.patterns) || f.patterns.some((p) => !(p?.re instanceof RegExp)))) {
      console.error(`single-owner: FAILED — ${owner.module} declares unusable ${owner.export} entries (sites need id + patterns[].re).`);
      return null;
    }
    owner.entries = entries;
  }
  return OWNERS;
}

async function main() {
  const owners = await loadOwners();
  if (!owners) return 1;
  const envOwner = owners.find((o) => o.kind === "env");
  const siteOwner = owners.find((o) => o.kind === "site");
  const facts = envOwner.entries;
  const sites = siteOwner.entries;

  const files = sources();
  const violations = [];
  const exempted = new Set();
  for (const file of files) {
    const code = withoutComments(readFileSync(path.join(ROOT, file), "utf8")).split("\n");
    code.forEach((line, i) => {
      for (const fact of facts) {
        if (file === envOwner.module) continue;
        const reads = readsLike(fact.env).test(line);
        const rebuilds = fact.recomputed instanceof RegExp && fact.recomputed.test(line);
        if (reads || rebuilds) violations.push({ file, line: i + 1, kind: "env", fact, reads, rebuilds, text: line.trim() });
      }
      for (const site of sites) {
        if (file === siteOwner.module) continue;
        const segments = file.split(path.sep);
        if ((site.skipDirs ?? []).some((dir) => segments.includes(dir))) continue;
        if (Object.prototype.hasOwnProperty.call(site.except ?? {}, file)) {
          exempted.add(`${site.id}: ${file} — ${site.except[file]}`);
          continue;
        }
        for (const pattern of site.patterns) {
          if (pattern.re.test(line)) {
            violations.push({ file, line: i + 1, kind: "site", site, pattern, text: line.trim() });
          }
        }
      }
    });
  }

  const probes = new Map(facts.map((fact) => [fact.id, probe(fact)]));
  const unowned = facts.filter((fact) => !probes.get(fact.id).ok);
  const siteProbe = await probePathAuth(siteOwner.mod);
  const failed = violations.length > 0 || unowned.length > 0 || !siteProbe.ok;

  console.log(`single-owner: ${facts.length} declared fact(s) and ${sites.length} declared site(s) across ${files.length} source file(s) under ${ROOT}`);
  for (const fact of facts) {
    const mine = violations.filter((v) => v.kind === "env" && v.fact === fact).length;
    const verdict = mine === 0 && !unowned.includes(fact) ? "OK  " : "FAIL";
    console.log(`  ${verdict} ${fact.id.padEnd(11)} ${fact.env.padEnd(26)} owner ${envOwner.module} — ${fact.asks}`);
  }
  for (const site of sites) {
    const mine = violations.filter((v) => v.kind === "site" && v.site === site).length;
    const verdict = mine === 0 && siteProbe.ok ? "OK  " : "FAIL";
    console.log(`  ${verdict} ${site.id.padEnd(11)} ${site.patterns.length} shape pattern(s)  owner ${siteOwner.module} — ${site.asks}`);
  }
  for (const note of exempted) {
    console.log(`  EXEMPT ${note}`);
  }
  if (!failed) {
    console.log("single-owner: OK — every declared fact and site has exactly one computing site");
    return 0;
  }

  if (unowned.length > 0) {
    console.error("");
    console.error("single-owner: FAILED — the owner does not answer for every fact it declares:");
    for (const fact of unowned) {
      const p = probes.get(fact.id);
      console.error(`  ${envOwner.module}  ${fact.id} (${fact.env}) — value() returned ${JSON.stringify(p.answered)} with the variable set to a probe, declared() ${JSON.stringify(p.declared)}, and ${JSON.stringify(p.undeclared)} when it was absent.`);
    }
  }
  if (!siteProbe.ok) {
    console.error("");
    console.error("single-owner: FAILED — the site owner does not answer for the site it declares:");
    for (const f of siteProbe.failed) console.error(`  ${siteOwner.module}  ${f}`);
  }
  if (violations.length > 0) {
    console.error("");
    console.error("single-owner: FAILED — a component computed a fact it does not own (voicebox-beads-y5k):");
    for (const v of violations) {
      if (v.kind === "env") {
        const how = v.reads ? `reads ${v.fact.env}` : "rebuilds the default";
        console.error(`  ${v.file}:${v.line}  ${v.fact.id.padEnd(11)} ${how} — the owner is ${envOwner.module}; ask ${v.fact.asks}`);
      } else {
        console.error(`  ${v.file}:${v.line}  ${v.site.id.padEnd(11)} looks like ${v.pattern.what} (${v.pattern.id}) — the owner is ${siteOwner.module}; ask ${v.site.asks}`);
      }
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
