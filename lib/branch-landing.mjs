// lib/branch-landing.mjs — Git Candidate Branch & Diff Landing Inspector.
//
// Lets operators inspect candidate branches created by coding agents, view their
// changed files and unified diffs against `main`, check merge compatibility, and
// either land (merge) them or keep them separate.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { gitEnv } from "./git-env.mjs";

const GIT_TIMEOUT_MS = 5000;

const html = fs.readFileSync(
  new URL("../public/apps/landing-inspector.html", import.meta.url),
  "utf8",
);

export const LANDING_INSPECTOR_APP_ID = "branch-landing-inspector";

export const LANDING_INSPECTOR_MINI_APP = Object.freeze({
  appId: LANDING_INSPECTOR_APP_ID,
  title: "Branch Landing Inspector",
  html,
});

export function getLandingInspectorMiniApp() {
  return { ...LANDING_INSPECTOR_MINI_APP };
}

/**
 * Validate that a branch ref name is safe to pass to git commands.
 */
export function isValidBranchRef(branchName) {
  if (typeof branchName !== "string") return false;
  const trimmed = branchName.trim();
  if (!trimmed || trimmed !== branchName) return false;
  if (trimmed.startsWith("-")) return false;
  if (trimmed.includes("..") || trimmed.includes("@{") || trimmed.includes("\\")) return false;
  if (/[\s~^:?*[\]\x00-\x1f\x7f]/.test(trimmed)) return false;
  if (trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.endsWith(".lock")) return false;
  return true;
}

function runGit(repoPath, args, { allowNonZero = false } = {}) {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      env: gitEnv(),
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, status: 0, stdout };
  } catch (err) {
    if (allowNonZero && typeof err.stdout === "string") {
      return {
        ok: true,
        status: err.status ?? 1,
        stdout: err.stdout,
        stderr: typeof err.stderr === "string" ? err.stderr : "",
      };
    }
    return {
      ok: false,
      status: err.status ?? 1,
      error: err,
      stderr: typeof err.stderr === "string" ? err.stderr.trim() : String(err.message || err),
    };
  }
}

function ensureGitRepo(repoPath) {
  if (!repoPath || typeof repoPath !== "string" || !fs.existsSync(repoPath)) {
    return {
      ok: false,
      refused: "not-a-git-repo",
      why: "The project folder does not exist or is not a Git repository.",
    };
  }
  const probe = runGit(repoPath, ["rev-parse", "--git-dir"]);
  if (!probe.ok) {
    return {
      ok: false,
      refused: "not-a-git-repo",
      why: "The specified folder is not a Git repository.",
    };
  }
  return { ok: true };
}

/**
 * List candidate branches in `repoPath` compared against `baseBranch` (defaults to "main").
 */
export function listCandidateBranches(repoPath, { baseBranch = "main" } = {}) {
  const repoCheck = ensureGitRepo(repoPath);
  if (!repoCheck.ok) return repoCheck;

  if (!isValidBranchRef(baseBranch)) {
    return {
      ok: false,
      refused: "invalid-branch-name",
      why: `Base branch name "${baseBranch}" is not a valid Git branch reference.`,
    };
  }

  const refList = runGit(repoPath, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)|%(objectname:short)|%(subject)|%(committerdate:iso8601)",
    "refs/heads",
  ]);
  if (!refList.ok) {
    return {
      ok: false,
      refused: "git-ref-scan-failed",
      why: refList.stderr || "Could not list local branches in the repository.",
    };
  }

  const lines = refList.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const branches = [];
  for (const line of lines) {
    const [name, commit, subject, updatedAt] = line.split("|");
    if (!name || name === baseBranch) continue;

    let ahead = 0;
    let behind = 0;
    const revCounts = runGit(repoPath, [
      "rev-list",
      "--left-right",
      "--count",
      `${baseBranch}...${name}`,
    ]);
    if (revCounts.ok) {
      const parts = revCounts.stdout.trim().split(/\s+/);
      behind = Number.parseInt(parts[0], 10) || 0;
      ahead = Number.parseInt(parts[1], 10) || 0;
    }

    let filesChanged = 0;
    const diffNames = runGit(repoPath, [
      "diff",
      "--name-status",
      `${baseBranch}...${name}`,
    ]);
    if (diffNames.ok) {
      filesChanged = diffNames.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean).length;
    }

    branches.push({
      name,
      commit: commit || "",
      subject: subject || "",
      updatedAt: updatedAt || "",
      ahead,
      behind,
      filesChanged,
    });
  }

  return {
    ok: true,
    baseBranch,
    branches,
  };
}

/**
 * Inspect changed files, additions/deletions, merge readiness, and unified diff
 * for `branchName` relative to `baseBranch`.
 */
export function inspectBranchDiff(
  repoPath,
  branchName,
  { baseBranch = "main", maxDiffBytes = 65536 } = {},
) {
  const repoCheck = ensureGitRepo(repoPath);
  if (!repoCheck.ok) return repoCheck;

  if (!isValidBranchRef(branchName)) {
    return {
      ok: false,
      refused: "invalid-branch-name",
      why: `Branch name "${branchName}" is not a valid Git branch reference.`,
    };
  }

  if (!isValidBranchRef(baseBranch)) {
    return {
      ok: false,
      refused: "invalid-branch-name",
      why: `Base branch name "${baseBranch}" is not a valid Git branch reference.`,
    };
  }

  const verifyBranch = runGit(repoPath, ["rev-parse", "--verify", branchName]);
  if (!verifyBranch.ok) {
    return {
      ok: false,
      refused: "branch-not-found",
      why: `Candidate branch "${branchName}" does not exist in this repository.`,
    };
  }

  const statusMap = new Map();
  const nameStatusRes = runGit(repoPath, [
    "diff",
    "--name-status",
    `${baseBranch}...${branchName}`,
  ]);
  if (nameStatusRes.ok) {
    for (const rawLine of nameStatusRes.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/\t+/);
      const statusToken = (parts[0] || "M").charAt(0);
      const filePath = parts[parts.length - 1];
      if (filePath) statusMap.set(filePath, statusToken);
    }
  }

  const files = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  const numstatRes = runGit(repoPath, [
    "diff",
    "--numstat",
    `${baseBranch}...${branchName}`,
  ]);
  if (numstatRes.ok) {
    for (const rawLine of numstatRes.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const [addStr, delStr, ...pathParts] = line.split(/\t+/);
      const filePath = pathParts.join("\t");
      if (!filePath) continue;
      const additions = Number.parseInt(addStr, 10) || 0;
      const deletions = Number.parseInt(delStr, 10) || 0;
      totalAdditions += additions;
      totalDeletions += deletions;
      files.push({
        path: filePath,
        status: statusMap.get(filePath) || "M",
        additions,
        deletions,
      });
    }
  }

  const rawDiffRes = runGit(repoPath, ["diff", `${baseBranch}...${branchName}`]);
  let diff = rawDiffRes.ok ? rawDiffRes.stdout : "";
  if (Buffer.byteLength(diff, "utf8") > maxDiffBytes) {
    diff = Buffer.from(diff, "utf8").subarray(0, maxDiffBytes).toString("utf8") + "\n... [diff truncated]";
  }

  let cleanMergePossible = true;
  const mergeBaseRes = runGit(repoPath, ["merge-base", baseBranch, branchName]);
  if (mergeBaseRes.ok) {
    const mergeBase = mergeBaseRes.stdout.trim();
    if (mergeBase) {
      const mergeTreeRes = runGit(
        repoPath,
        ["merge-tree", mergeBase, baseBranch, branchName],
        { allowNonZero: true },
      );
      if (!mergeTreeRes.ok || mergeTreeRes.stdout.includes("<<<<<<< ")) {
        cleanMergePossible = false;
      }
    }
  }

  return {
    ok: true,
    branch: branchName,
    baseBranch,
    files,
    totalAdditions,
    totalDeletions,
    cleanMergePossible,
    diff,
  };
}

/**
 * Merge a candidate branch cleanly into `baseBranch`.
 * Refuses with `merge-conflict` if `inspectBranchDiff` detects conflicts.
 */
export function landCandidateBranch(repoPath, branchName, { baseBranch = "main" } = {}) {
  const inspection = inspectBranchDiff(repoPath, branchName, { baseBranch });
  if (!inspection.ok) return inspection;

  if (!inspection.cleanMergePossible) {
    return {
      ok: false,
      refused: "merge-conflict",
      why: `Candidate branch "${branchName}" has conflicts with "${baseBranch}" and cannot be landed automatically.`,
      branch: branchName,
      baseBranch,
    };
  }

  const checkoutRes = runGit(repoPath, ["checkout", baseBranch]);
  if (!checkoutRes.ok) {
    return {
      ok: false,
      refused: "checkout-failed",
      why: checkoutRes.stderr || `Could not switch to base branch "${baseBranch}".`,
    };
  }

  const mergeRes = runGit(repoPath, ["merge", "--no-edit", branchName]);
  if (!mergeRes.ok) {
    return {
      ok: false,
      refused: "merge-failed",
      why: mergeRes.stderr || `Could not merge "${branchName}" into "${baseBranch}".`,
    };
  }

  const headRes = runGit(repoPath, ["rev-parse", "--short", "HEAD"]);
  const headCommit = headRes.ok ? headRes.stdout.trim() : "";

  return {
    ok: true,
    action: "landed",
    branch: branchName,
    baseBranch,
    headCommit,
  };
}

/**
 * Record a non-destructive decision to keep `branchName` separate from `main`.
 */
export function keepBranchSeparate(repoPath, branchName, { note = "" } = {}) {
  const repoCheck = ensureGitRepo(repoPath);
  if (!repoCheck.ok) return repoCheck;

  if (!isValidBranchRef(branchName)) {
    return {
      ok: false,
      refused: "invalid-branch-name",
      why: `Branch name "${branchName}" is not a valid Git branch reference.`,
    };
  }

  return {
    ok: true,
    action: "kept-separate",
    branch: branchName,
    note: String(note || ""),
  };
}
