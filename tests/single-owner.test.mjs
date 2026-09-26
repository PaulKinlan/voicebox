// tests/single-owner.test.mjs — the gate that keeps one fact from having two answers, driven.
//
// Two halves, and both are needed:
//   * the REAL tree is checked here as an assertion (the same check a person runs by hand, and the one
//     the unit lane runs before every push) — so a fourth copy of a declared fact fails somebody's
//     suite, not a reviewer's attention;
//   * the CHECK ITSELF is driven against a scratch copy, where a copy of a fact is ADDED and then
//     REMOVED. Without that half, "it passes" says nothing: a check that cannot fail is a description
//     of the code. `tests/docs-touched.test.mjs` taught this repository the same lesson, and the
//     fixture here inherits its one piece of hard-won hygiene: git's own environment is stripped,
//     because a fixture that inherits GIT_DIR commits into the repository being pushed.
//
//   node --test tests/single-owner.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(REPO, "scripts", "single-owner.mjs");
const roots = [];

const cleanEnv = { ...process.env };
for (const key of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).trim().split("\n")) delete cleanEnv[key];

test.after(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A real copy of this tree's lib/ — the owner module travels with it, so the check has someone to ask. */
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "single-owner-")));
  roots.push(dir);
  cpSync(path.join(REPO, "lib"), path.join(dir, "lib"), { recursive: true });
  return dir;
}

function run(root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, "--root", root], { env: cleanEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("the tree this repository ships has exactly one computing site per declared fact", () => {
  const r = run(REPO);
  assert.equal(r.code, 0, `the real tree must pass its own check:\n${r.out}`);
  assert.match(r.out, /\d+ declared fact\(s\) across \d+ source file\(s\)/, "it must say what it looked at");
  assert.match(r.out, /lib\/state-dirs\.mjs/, "and who the owner is");
});

test("a fourth copy of a fact is REFUSED — the variable, the file and the owner are all named", () => {
  const dir = fixture();
  writeFileSync(path.join(dir, "lib", "fourth-copy.mjs"), 'export const host = process.env.VOICEBOX_EXTENSIONS_DIR ?? "elsewhere";\n');
  const r = run(dir);
  assert.equal(r.code, 1, `a second answer must not pass:\n${r.out}`);
  assert.match(r.out, /lib\/fourth-copy\.mjs:1/, "the site that copied it");
  assert.match(r.out, /VOICEBOX_EXTENSIONS_DIR/, "the fact's variable");
  assert.match(r.out, /lib\/state-dirs\.mjs/, "the owner to ask instead");
  assert.match(r.out, /extensionsDir\(\)/, "and the question to ask it");
});

test("rebuilding the DEFAULT is the same defect and is refused too — the value, not just the variable", () => {
  const dir = fixture();
  writeFileSync(path.join(dir, "lib", "second-default.mjs"), 'import path from "node:path";\nexport const ws = path.join(ROOT, "workspace");\n');
  const r = run(dir);
  assert.equal(r.code, 1, `the default is the same answer as the unset variable:\n${r.out}`);
  assert.match(r.out, /lib\/second-default\.mjs:2/);
  assert.match(r.out, /rebuilds the default/);
  assert.match(r.out, /workspaceDir\(\)/);
});

test("remove the copy and the same fixture passes — so the red was the copy, not the fixture", () => {
  const dir = fixture();
  const file = path.join(dir, "lib", "fourth-copy.mjs");
  writeFileSync(file, 'export const host = process.env.VOICEBOX_EXTENSIONS_DIR ?? "elsewhere";\n');
  assert.equal(run(dir).code, 1, "the copy is refused while it is there");
  rmSync(file);
  const r = run(dir);
  assert.equal(r.code, 0, `and nothing else in this fixture is a violation:\n${r.out}`);
});

test("prose that names the facts is NOT a copy: comments are documentation, not code", () => {
  const dir = fixture();
  const prose = [
    "// The host directory is set with process.env.VOICEBOX_EXTENSIONS_DIR, and the fallback is",
    '// path.join(ROOT, "extensions"); the workspace is process.env.VOICEBOX_WORKSPACE.',
    '/* and the shelf default is path.join(os.homedir(), ".isocan", "modules", "wasm-tools") */',
    "export const documented = true; // not a copy either",
  ].join("\n");
  writeFileSync(path.join(dir, "lib", "prose-only.mjs"), `${prose}\n`);
  const r = run(dir);
  assert.equal(r.code, 0, `a check that goes red for its own documentation is a check somebody turns off:\n${r.out}`);
});

test("an owner that does not answer for a fact it declares is refused — the declaration cannot be empty", () => {
  const dir = fixture();
  const owner = path.join(dir, "lib", "state-dirs.mjs");
  const text = readFileSync(owner, "utf8");
  const mutated = text.replace(
    "value: () => (set(process.env[env]) ? process.env[env] : defaulted()),",
    "value: () => defaulted(),",
  );
  assert.notEqual(mutated, text, "the mutation must actually change the owner, or this test proves nothing");
  writeFileSync(owner, mutated);
  const r = run(dir);
  assert.equal(r.code, 1, `a fact with no implementation is not a pass:\n${r.out}`);
  assert.match(r.out, /does not answer for every fact it declares/);
});

test("a tree with no owner module is REFUSED, by name — a missing owner is not a green tree", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "single-owner-empty-")));
  roots.push(dir);
  const r = run(dir);
  assert.equal(r.code, 1, `nothing owns the facts there:\n${r.out}`);
  assert.match(r.out, /no owner module at lib\/state-dirs\.mjs/);
});
