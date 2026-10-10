// tests/factory-git-env-parity.test.mjs — voicebox-beads-8f8u
//
// The factory scripts hardened their DIRECT git calls with gitEnv (lib/git-env.mjs) but left
// children on the raw ambient environment — the 946i/lumm/a8p5 wrong-repo class at new sites:
//   - scripts/factory-review-watcher.mjs ran `bd list --json` on raw env;
//   - scripts/factory-nightly-publisher.mjs hand-rolled a 3-name GIT_* strip (leaving
//     GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT / GIT_COMMON_DIR to steer its origin check) and
//     passed raw env to its triage publisher child.
// These tests poison the caller environment and prove the children answer about the intended
// repository anyway. Isolated from tests/factory-review-adapter.test.mjs because a8p5's edits
// there were unlanded when this file was written (coord, 2026-10-10).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runReviewWatcher } from "../scripts/factory-review-watcher.mjs";
import { publishNightlyFindings } from "../scripts/factory-nightly-publisher.mjs";

function ownedFixture(t, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function trustedGitFixture(t, root, repoDir) {
  const gitHome = path.join(root, "githome");
  const gitXdg = path.join(gitHome, ".config");
  const gitHooksDir = path.join(root, "empty-hooks");
  for (const dir of [repoDir, gitHome, gitXdg, gitHooksDir]) mkdirSync(dir, { recursive: true });
  const trustedGit = "/usr/bin/git";
  accessSync(trustedGit, constants.X_OK);
  const gitEnvPins = {
    HOME: gitHome,
    XDG_CONFIG_HOME: gitXdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
  };
  const git = (args, cwd) => execFileSync(
    trustedGit,
    ["-c", `core.hooksPath=${gitHooksDir}`, "-c", `init.templateDir=${gitHooksDir}`, ...args],
    { cwd, encoding: "utf8", env: gitEnvPins },
  );
  return { git, gitEnvPins };
}

test("factory-review-watcher: the bd child inherits no GIT_DIR/GIT_WORK_TREE from a poisoned caller (voicebox-beads-8f8u)", (t) => {
  const root = ownedFixture(t, "watcher-poison-");
  const repoDir = path.join(root, "repo");
  const decoyDir = path.join(root, "decoy");
  const fakeBin = path.join(root, "fakebin");
  const recordDir = path.join(root, "records");
  const privateDir = path.join(root, "private");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(privateDir, { recursive: true });

  const { git } = trustedGitFixture(t, root, repoDir);
  git(["init", "-q", "-b", "main", repoDir], root);
  assert.equal(realpathSync(git(["rev-parse", "--show-toplevel"], repoDir).trim()), realpathSync(repoDir),
    "fixture git ops must resolve to the fixture itself");

  // The decoy the poison points at: a different repository entirely.
  const { git: decoyGit } = trustedGitFixture(t, root, decoyDir);
  decoyGit(["init", "-q", "-b", "main", decoyDir], root);

  // Fake bd on the fixture PATH: records the git-plumbing vars it inherits, then answers an
  // empty list so the watcher proceeds with zero candidates and returns without touching git refs.
  writeFileSync(path.join(fakeBin, "bd"), [
    "#!/bin/sh",
    'echo "GIT_DIR=${GIT_DIR-<unset>} GIT_WORK_TREE=${GIT_WORK_TREE-<unset>} GIT_CONFIG_PARAMETERS=${GIT_CONFIG_PARAMETERS-<unset>}" >> "$RECORD_DIR/bd.env"',
    'echo "[]"',
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });

  const poisonEnv = {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    RECORD_DIR: recordDir,
    GIT_DIR: path.join(decoyDir, ".git"),
    GIT_WORK_TREE: decoyDir,
    GIT_CONFIG_PARAMETERS: "'remote.origin.url=https://decoy.invalid/decoy/repo.git'",
  };

  const result = runReviewWatcher(["--private-dir", privateDir], { env: poisonEnv, rootDir: repoDir });
  assert.equal(result.ok, true, `watcher should proceed with the fake bd's empty list: ${JSON.stringify(result)}`);

  const record = readFileSync(path.join(recordDir, "bd.env"), "utf8");
  assert.ok(record.includes("GIT_DIR=<unset>"), `bd child inherited GIT_DIR: ${record}`);
  assert.ok(record.includes("GIT_WORK_TREE=<unset>"), `bd child inherited GIT_WORK_TREE: ${record}`);
  // The class is git's whole local-env-vars list, not just the directory pair — the config
  // injection channel must be gone too.
  assert.ok(record.includes("GIT_CONFIG_PARAMETERS=<unset>"), `bd child inherited GIT_CONFIG_PARAMETERS: ${record}`);
});

test("factory-nightly-publisher: the origin verification cannot be steered by GIT_CONFIG_PARAMETERS (voicebox-beads-8f8u)", (t) => {
  const root = ownedFixture(t, "nightly-poison-");
  const findingsDir = path.join(root, "findings");
  const runsDir = path.join(root, "runs");
  const privateDir = path.join(root, "private");
  const gitHome = path.join(root, "githome");
  const gitXdg = path.join(gitHome, ".config");
  for (const dir of [findingsDir, runsDir, privateDir, gitHome, gitXdg]) mkdirSync(dir, { recursive: true });

  // A valid, fresh, all-PASS manifest whose single station declares findings_count=0: the clean-pass
  // path needs no delta report and spawns no publisher, so the target-verification gate at :139 is
  // the ONLY thing between the poison and a published batch.
  const now = new Date();
  const manifest = {
    target: "voicebox-factory",
    line: "project-audit",
    complete: true,
    generated: now.toISOString(),
    stations: [{ station: "secret-scan", status: "PASS", findings_count: 0, criticals: 0, run_dir: runsDir }],
  };
  writeFileSync(path.join(findingsDir, "voicebox-factory-line.json"), JSON.stringify(manifest));

  // The poison: an injected config entry that rewrites remote.origin.url for EVERY repository the
  // check inspects. The old hand-rolled strip (GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE only) left this
  // in place; gitEnv removes the whole local-env-vars class, including GIT_CONFIG_PARAMETERS.
  const poisonEnv = {
    PATH: "/usr/bin:/bin",
    HOME: gitHome,
    XDG_CONFIG_HOME: gitXdg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_PARAMETERS: "'remote.origin.url=https://decoy.invalid/decoy/repo.git'",
  };

  const result = publishNightlyFindings(
    ["--dry-run", "--findings-dir", findingsDir, "--runs-dir", runsDir, "--private-dir", privateDir],
    // rootDir is this checkout: the publisher's candidate-target loop always finds at least it,
    // and its real origin matches — so a PASS proves the poison did not steer the read.
    { env: poisonEnv, rootDir: path.resolve(new URL("..", import.meta.url).pathname) },
  );

  assert.equal(result.ok, true, `origin verification must answer from the checkout's own config, not the injected one: ${JSON.stringify(result)}`);
  assert.equal(result.dryRun, true);
});
