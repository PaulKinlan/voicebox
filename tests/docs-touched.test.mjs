// tests/docs-touched.test.mjs — the gate that watches the HAND-WRITTEN half of the docs, driven.
//
// Every case runs `scripts/docs-touched.mjs` against a REAL scratch git repository with its own
// documents and its own history — never against voicebox itself, because a check that can only be
// run against the tree it lives in is a check nobody can make fail on purpose. (That is why the
// script takes its root from the cwd it is given; the same lesson isocan's nightly machinery
// learned when a root resolved from `import.meta.url` made every fixture a test of isocan.)
//
//   node --test tests/docs-touched.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { namedPaths } from "../scripts/docs-touched.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/docs-touched.mjs", import.meta.url));
const roots = [];

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repository whose README describes `lib/described.mjs` and nothing else. */
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docs-touched-"));
  roots.push(dir);
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "lib/described.mjs"), "export const described = true;\n");
  writeFileSync(path.join(dir, "lib/quiet.mjs"), "export const quiet = true;\n");
  writeFileSync(path.join(dir, "README.md"), "# Fixture\n\nThe loop lives in `lib/described.mjs` and answers for itself.\n");
  writeFileSync(path.join(dir, "docs/08-how-it-runs.md"), "# How it runs\n\nSee `lib/described.mjs`.\n");
  git(["init", "-q", "-b", "main"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base"], dir);
  const base = git(["rev-parse", "HEAD"], dir);
  return {
    dir,
    base,
    /** Commit a change; `trailer` is the recorded excuse the gate accepts. */
    change(files, message, trailer) {
      for (const [rel, text] of Object.entries(files)) appendFileSync(path.join(dir, rel), text);
      git(["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A"], dir);
      const args = ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message];
      if (trailer) args.push("--trailer", trailer);
      git(args, dir);
    },
    run() {
      try {
        return { code: 0, out: execFileSync("node", [script, this.base], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    },
  };
}

test.after(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a described file changes and no document moves: REFUSED, naming both sides", () => {
  const f = fixture();
  f.change({ "lib/described.mjs": "\n// moved\n" }, "change the described file");
  const r = f.run();
  assert.equal(r.code, 1, `the gate must refuse:\n${r.out}`);
  assert.match(r.out, /lib\/described\.mjs/, "it must name the file that moved");
  assert.match(r.out, /README\.md/, "and the document that describes it, or nobody knows where to look");
  assert.match(r.out, /docs\/08-how-it-runs\.md/, "every document naming it, not just the first");
});

test("the same change with a document in it: allowed", () => {
  const f = fixture();
  f.change({ "lib/described.mjs": "\n// moved\n", "README.md": "\nAnd it does something new.\n" }, "change it and say so");
  const r = f.run();
  assert.equal(r.code, 0, `the gate must allow:\n${r.out}`);
});

test("the same change with a recorded reason instead: allowed, and the reason is printed", () => {
  const f = fixture();
  f.change({ "lib/described.mjs": "\n// a comment\n" }, "tidy", "Docs-checked: a comment — nothing a document describes changed");
  const r = f.run();
  assert.equal(r.code, 0, `an explicit, recorded excuse must pass:\n${r.out}`);
  assert.match(r.out, /nothing a document describes changed/, "and it must be printed, or it is not auditable");
});

test("a file no document names: allowed, and it says nothing was described", () => {
  const f = fixture();
  f.change({ "lib/quiet.mjs": "\n// moved\n" }, "change an undescribed file");
  const r = f.run();
  assert.equal(r.code, 0, `an undescribed file is not this gate's business:\n${r.out}`);
  assert.match(r.out, /none of them described/);
});

test("a document changing on its own: allowed", () => {
  const f = fixture();
  f.change({ "README.md": "\nA clarification.\n" }, "prose only");
  const r = f.run();
  assert.equal(r.code, 0, `a docs-only change is the thing we are asking for:\n${r.out}`);
});

test("a filename with more than one dot is seen — the gate was blind to every *.test.mjs", () => {
  // The first regex allowed ONE dot (`[\w-]+\.[a-z]+`), so `channel.test.mjs` matched nowhere and every
  // `tests/*.test.mjs` this repository names in prose — including this file — was invisible. Found by
  // asking the mechanism whether it covered its own new files. RED on the old pattern, green on this one.
  const named = namedPaths("see `tests/docs-touched.test.mjs`, `tools/wasm-tools/sbom.cdx.json`, `.githooks/pre-push` and `lib/extensions.mjs`");
  assert.ok(named.has("tests/docs-touched.test.mjs"), "a doubled extension must be seen");
  assert.ok(named.has("tools/wasm-tools/sbom.cdx.json"), "so must a dotted name deeper in a path");
  assert.ok(named.has(".githooks/pre-push"), "and a nested path with no extension at all");
  assert.ok(named.has("lib/extensions.mjs"), "without losing the ordinary case");
});

test("a described file with a doubled extension is refused like any other", () => {
  // The bug above, through the gate rather than through the regex: a document naming a *.test.mjs file,
  // that file changing, and no document moving.
  const f = fixture();
  mkdirSync(path.join(f.dir, "tests"), { recursive: true });
  writeFileSync(path.join(f.dir, "tests/suite.test.mjs"), "// the suite\n");
  f.change({ "README.md": "\nThe suite lives in `tests/suite.test.mjs`.\n" }, "describe the test file");
  f.base = git(["rev-parse", "HEAD"], f.dir); // the description is the BASE; the change under test comes next
  f.change({ "tests/suite.test.mjs": "\n// moved\n" }, "change the described test file");
  const r = f.run();
  assert.equal(r.code, 1, `a doubled-extension file is described like any other:\n${r.out}`);
  assert.match(r.out, /tests\/suite\.test\.mjs/);
});

test("an unknown base is skipped by name, not counted as a pass or a failure", () => {
  const f = fixture();
  f.change({ "lib/described.mjs": "\n// moved\n" }, "change the described file");
  const r = (() => {
    try {
      return { code: 0, out: execFileSync("node", [script, "refs/heads/no-such-base"], { cwd: f.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  })();
  assert.equal(r.code, 0, "not knowing the base is not the change's fault");
  assert.match(r.out, /skipped/, "but it must say so rather than printing OK");
});
