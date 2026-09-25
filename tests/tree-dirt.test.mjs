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
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INSIDE_MEASURED_TREE, dirtDelta, makeScratchDir, outsideTree, porcelainLines } from "../tools/tree-dirt.mjs";

function fixtureRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "voicebox-tree-dirt-"));
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Tree-dirt fixture");
  writeFileSync(path.join(repo, "tracked.txt"), "here\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  return { dir, repo };
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
