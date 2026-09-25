// tests/tree-dirt.test.mjs — the mechanism behind voicebox-beads-bp8, driven against a real
// repository rather than asserted. The rule: a process that writes must write outside anything
// another process measures. The failure it exists for: a Dolt backup written into the served tree
// by a process whose cwd WAS that tree, turning `git status --porcelain` dirty for a reason no
// author caused — and every check afterwards pointing at the wrong thing.
//
// So these are world-not-transcript tests: a child process really writes into a fixture repo, the
// measurement really examines the git status before and after, and the guard is asked about paths
// that really resolve (including through a symlink) — a regex over source would be the "looks like
// a guard" row of §3.0, not this.
//
// AND THE FIXTURE ITSELF IS SUBJECT TO THE RULE (field finding, 2026-09-25): git exports GIT_DIR
// into every child a hook starts, GIT_DIR outranks `-C`, and this fixture's `git config` therefore
// wrote user.name 'Tree-dirt fixture' into the real voicebox checkout during a gate run. Every git
// command here runs through gitEnv(), and the last test below pins that an ambient GIT_DIR cannot
// steer either the fixture or the measurement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INSIDE_MEASURED_TREE, dirtDelta, gitEnv, makeScratchDir, outsideTree, porcelainLines } from "../tools/tree-dirt.mjs";

function fixtureRepo({ commit = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "voicebox-tree-dirt-"));
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", env: gitEnv() });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Tree-dirt fixture");
  if (commit) {
    writeFileSync(path.join(repo, "tracked.txt"), "here\n");
    git("add", ".");
    git("commit", "-qm", "fixture");
  }
  return { dir, repo, git };
}

test("a writer whose cwd is the measured tree is named by the before/after delta", () => {
  const { dir, repo } = fixtureRepo();
  try {
    const before = porcelainLines(repo);
    assert.deepEqual(before, [], "the fixture repo starts clean");

    // The bp8 instance itself: a process with the repo as its cwd writes a backup/ directory
    // into it, exactly as the Dolt backup did into the served tree.
    execFileSync(process.execPath, ["-e", `
      const { mkdirSync, writeFileSync } = require("node:fs");
      mkdirSync("backup", { recursive: true });
      writeFileSync("backup/manifest", "5:__DOLT__:fixture");
      writeFileSync("backup/backup_state.json", JSON.stringify({ last_dolt_commit: "fixture" }));
    `], { cwd: repo });

    const { added, preExisting } = dirtDelta(before, porcelainLines(repo));
    assert.deepEqual(preExisting, [], "nothing was dirty before the writer ran");
    assert.ok(added.includes("?? backup/manifest"), `the backup manifest was not named as this run's writing: ${JSON.stringify(added)}`);
    assert.ok(added.includes("?? backup/backup_state.json"), `the backup state file was not named: ${JSON.stringify(added)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dirt that predates the run is reported as pre-existing, never as this run's writing", () => {
  const { dir, repo } = fixtureRepo();
  try {
    writeFileSync(path.join(repo, "left-behind.txt"), "not mine\n");
    const before = porcelainLines(repo);
    writeFileSync(path.join(repo, "during.txt"), "mine\n");

    const { added, preExisting } = dirtDelta(before, porcelainLines(repo));
    assert.deepEqual(added, ["?? during.txt"], "only the file written during the run is this run's");
    assert.deepEqual(preExisting, ["?? left-behind.txt"], "the file that predates the run is reported as pre-existing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scratch destination that resolves inside the measured tree is refused by name", () => {
  const { dir, repo } = fixtureRepo();
  try {
    const inside = outsideTree(path.join(repo, "scratch"), repo);
    assert.equal(inside.ok, false, "a destination inside the measured tree was allowed");
    assert.equal(inside.refused, INSIDE_MEASURED_TREE, "the refusal did not name the rule");

    // Containment is a path boundary, not a string prefix: a sibling whose name starts with the
    // tree's is outside it — the `/srv/tree-other` startsWith `/srv/tree` case.
    const sibling = path.join(dir, "repo-other");
    mkdirSync(sibling);
    assert.equal(outsideTree(sibling, repo).ok, true, "a name-prefix sibling was wrongly treated as inside");

    // And a path that RESOLVES into the tree through a symlink is inside, whatever it is called.
    const link = path.join(dir, "looks-outside");
    symlinkSync(repo, link);
    const throughLink = outsideTree(path.join(link, "scratch"), repo);
    assert.equal(throughLink.ok, false, "a symlink carried the destination back inside the measured tree");
    assert.equal(throughLink.refused, INSIDE_MEASURED_TREE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the guard's own scratch is outside the measured tree, and it is the process that removes it", () => {
  const { dir, repo } = fixtureRepo();
  try {
    const scratch = makeScratchDir("vb-tree-dirt-test-", { tree: repo });
    assert.ok(existsSync(scratch), "the scratch directory was not created");
    assert.equal(outsideTree(scratch, repo).ok, true, "the guard handed out a directory inside the measured tree");
    rmSync(scratch, { recursive: true, force: true });
    assert.equal(existsSync(scratch), false, "the owner did not remove its scratch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the beads sync dir is not a writer's artefact", () => {
  const { dir, repo } = fixtureRepo();
  try {
    mkdirSync(path.join(repo, ".beads"), { recursive: true });
    writeFileSync(path.join(repo, ".beads", "issues.jsonl"), "{}\n");
    assert.deepEqual(porcelainLines(repo), [], ".beads/ dirt was counted as a writer's output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The field finding, pinned: a git hook exports GIT_DIR into every child it starts, and GIT_DIR
// OUTRANKS `-C` — so without gitEnv() this file's own fixture wrote its identity into the real
// voicebox checkout, and the measurement could be answered by the wrong repository. This test runs
// under a deliberately poisoned GIT_DIR and asserts neither can happen.
test("an ambient GIT_DIR cannot steer the fixture or the measurement", () => {
  // The field shape: the ambient variable is already set (by a hook) BEFORE any fixture exists,
  // so fixture creation itself must be isolation-safe, not just later reads.
  const ambient = fixtureRepo({ commit: false }); // a different repo with no HEAD/index of its own
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  let measured = null;
  try {
    process.env.GIT_DIR = path.join(ambient.repo, ".git");
    measured = fixtureRepo(); // created UNDER the poisoned env — the exact shape that escaped to the field

    // (1) The fixture's own git commands must write the FIXTURE, not the ambient repo.
    execFileSync("git", ["-C", measured.repo, "config", "user.name", "only-the-fixture"], { env: gitEnv() });
    assert.equal(
      execFileSync("git", ["-C", measured.repo, "config", "--local", "user.name"], { encoding: "utf8", env: gitEnv() }).trim(),
      "only-the-fixture",
      "the fixture's config write did not land in the fixture",
    );
    assert.equal(
      execFileSync("git", ["-C", ambient.repo, "config", "--local", "user.name"], { encoding: "utf8", env: gitEnv() }).trim(),
      "Tree-dirt fixture",
      "the ambient GIT_DIR steered the fixture's config write into another repository",
    );

    // (2) The measurement must answer about the tree it was handed. With ambient's empty repo
    // steering it, the clean measured tree would read as `?? tracked.txt` instead of empty.
    assert.deepEqual(porcelainLines(measured.repo), [], "an ambient GIT_DIR made the measurement read the wrong repository");
  } finally {
    if (saved.GIT_DIR === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.GIT_DIR;
    if (saved.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.GIT_WORK_TREE;
    if (measured) rmSync(measured.dir, { recursive: true, force: true });
    rmSync(ambient.dir, { recursive: true, force: true });
  }
});
