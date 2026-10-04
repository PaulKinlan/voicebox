// tests/canonical-git-health.test.mjs — canonical git config integrity & auto-repair (voicebox-beads-6p3y)
//
// Paul (2026-10-04): "Canonical checkout ~/voicebox was converted to a BARE repo...
// add a deterministic health check and auto-repair: if core.bare=true is detected,
// warn and auto-heal to core.bare=false."
//
// Real filesystem integration test:
//   1. Creates an isolated scratch git repo.
//   2. Simulates accidental core.bare=true flip (which breaks git status/worktree ops).
//   3. Runs checkAndRepairCanonicalGitConfig to auto-heal.
//   4. Verifies git status and worktree operations are restored to normal.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAndRepairCanonicalGitConfig } from "../scripts/reap-stale-servers.mjs";
import { gitEnv } from "../lib/git-env.mjs";

test("canonical-git-health: auto-heals core.bare=true on real repository and restores worktree operations", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-git-health-"));
  const env = gitEnv();

  try {
    // 1. Initialize scratch repo
    execFileSync("git", ["init", tmpDir], { env });
    execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test User"], { env });
    execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@example.com"], { env });

    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Scratch Repo\n");
    execFileSync("git", ["-C", tmpDir, "add", "README.md"], { env });
    execFileSync("git", ["-C", tmpDir, "commit", "-m", "Initial commit"], { env });

    // Initial status works
    const statusBefore = execFileSync("git", ["-C", tmpDir, "status", "--porcelain"], { env, encoding: "utf8" });
    assert.equal(statusBefore.trim(), "");

    // 2. Corrupt with core.bare=true
    execFileSync("git", ["-C", tmpDir, "config", "core.bare", "true"], { env });

    // Verify git status fails on bare repo
    let statusFailed = false;
    try {
      execFileSync("git", ["-C", tmpDir, "status"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      statusFailed = true;
      assert.match(err.stderr || err.message, /work tree/i);
    }
    assert.equal(statusFailed, true, "git status must fail when core.bare=true");

    // 3. Dry-run warns without repairing
    const dryRunResult = checkAndRepairCanonicalGitConfig({ canonicalDir: tmpDir, dryRun: true });
    assert.equal(dryRunResult.ok, false);
    assert.equal(dryRunResult.dryRun, true);
    assert.equal(dryRunResult.repaired, false);

    const bareStill = execFileSync("git", ["-C", tmpDir, "config", "core.bare"], { env, encoding: "utf8" }).trim();
    assert.equal(bareStill, "true", "dry-run must not modify configuration");

    // 4. Auto-heal
    const repairResult = checkAndRepairCanonicalGitConfig({ canonicalDir: tmpDir, dryRun: false });
    assert.equal(repairResult.ok, true);
    assert.equal(repairResult.repaired, true);

    const bareRepaired = execFileSync("git", ["-C", tmpDir, "config", "core.bare"], { env, encoding: "utf8" }).trim();
    assert.equal(bareRepaired, "false", "core.bare must be healed to false");

    // 5. Worktree operations restored
    const statusAfter = execFileSync("git", ["-C", tmpDir, "status", "--porcelain"], { env, encoding: "utf8" });
    assert.equal(statusAfter.trim(), "", "git status must work cleanly after auto-repair");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
