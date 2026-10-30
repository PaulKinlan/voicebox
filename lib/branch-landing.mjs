// lib/branch-landing.mjs — Git Candidate Branch & Diff Landing Inspector.
//
// Lets operators inspect candidate branches created by coding agents, view their
// changed files and unified diffs against `main`, check merge compatibility, and
// either land (merge) them or keep them separate.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitEnv } from "./git-env.mjs";

const GIT_TIMEOUT_MS = 5000;

// ── Branch DECISIONS persist (voicebox-beads-wmiq) ─────────────────────────
// "Keep separate" used to live in the mini-app's in-memory state: a refresh lost it while the
// operator had been told it was recorded. The decision is a fact about a branch in a repo, so it
// is recorded on disk — one JSON file, keyed by repo path + branch, the file's path handed in by
// the host (state directories are owned by lib/state-dirs.mjs; this module never picks one).

/** Read the recorded decisions. A missing or unreadable file is an EMPTY ledger, never an error. */
export function readBranchDecisions(decisionsFile) {
  if (!decisionsFile) return { ok: true, decisions: {} };
  try {
    const raw = fs.readFileSync(decisionsFile, "utf8");
    const parsed = JSON.parse(raw);
    return { ok: true, decisions: parsed && typeof parsed === "object" ? parsed : {} };
  } catch {
    return { ok: true, decisions: {} };
  }
}

const decisionKey = (repoPath, branch) => `${path.resolve(repoPath)}::${branch}`;

/** Record a decision for a branch. Fails LOUDLY (ok:false) — the caller must not claim it recorded otherwise. */
export function recordBranchDecision(decisionsFile, repoPath, branch, decision, note = "") {
  if (!decisionsFile) {
    return { ok: false, refused: "no-decisions-store", why: "the host did not name a decisions file — the decision would evaporate on refresh" };
  }
  const existing = readBranchDecisions(decisionsFile);
  const decisions = { ...existing.decisions, [decisionKey(repoPath, branch)]: { decision, note: String(note || ""), at: new Date().toISOString() } };
  try {
    fs.mkdirSync(path.dirname(decisionsFile), { recursive: true });
    fs.writeFileSync(decisionsFile, JSON.stringify(decisions, null, 2), "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, refused: "decision-not-recorded", why: `the decision could not be written: ${err?.message ?? err}` };
  }
}

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
export function listCandidateBranches(repoPath, { baseBranch = "main", decisionsFile = null } = {}) {
  const repoCheck = ensureGitRepo(repoPath);
  if (!repoCheck.ok) return repoCheck;
  const decisions = readBranchDecisions(decisionsFile).decisions;

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
      // The recorded decision rides the row, so a REFRESHED inspector still shows "kept separate"
      // (wmiq). ahead === 0 means merged (or never diverged) — no decision annotation needed.
      statusDecision: ahead === 0 ? "landed" : (decisions[decisionKey(repoPath, name)]?.decision ?? "waiting"),
      decisionNote: decisions[decisionKey(repoPath, name)]?.note ?? "",
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
 * With `decisionsFile` the decision is RECORDED on disk (wmiq) — a refresh keeps showing it.
 * Without one the call refuses rather than pretend to have recorded.
 */
export function keepBranchSeparate(repoPath, branchName, { note = "", decisionsFile = null } = {}) {
  const repoCheck = ensureGitRepo(repoPath);
  if (!repoCheck.ok) return repoCheck;

  if (!isValidBranchRef(branchName)) {
    return {
      ok: false,
      refused: "invalid-branch-name",
      why: `Branch name "${branchName}" is not a valid Git branch reference.`,
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

  const recorded = recordBranchDecision(decisionsFile, repoPath, branchName, "kept-separate", note);
  if (!recorded.ok) return recorded;

  return {
    ok: true,
    action: "kept-separate",
    branch: branchName,
    note: String(note || ""),
  };
}

/**
 * Execute a voiced branch intent — "land branch" / "keep branch separate" (voicebox-beads-xo5d).
 *
 * The voice command used to end at an empty page handler: the user heard "Ran land_branch." and
 * nothing happened. The act belongs where the workspace git lives — here. The one ambiguity a
 * voice phrase cannot resolve is WHICH branch when several wait, so the outcomes are honest:
 *
 *   · zero waiting  → outcome "none" (a true statement, not a success claim about an act)
 *   · one waiting   → executed for real through landCandidateBranch / keepBranchSeparate
 *   · several       → outcome "ambiguous", never a guess — landing the wrong branch is the
 *                     expensive kind of helpful
 *
 * "Waiting" means ahead of the base: a branch with ahead === 0 has nothing to land, so it is not
 * a candidate for the voice act even though the inspector lists it.
 *
 * @returns {{ ok: boolean, outcome: string, say: string, ... }} — `say` is the sentence the turn
 *          presents and speaks; refusals carry the underlying refusal's refused/why unchanged.
 */
export function executeBranchIntent(repoPath, intent, { baseBranch = "main", decisionsFile = null } = {}) {
  const candidates = listCandidateBranches(repoPath, { baseBranch, decisionsFile });
  if (!candidates.ok) return { ...candidates, outcome: "refused", say: candidates.why };
  // A branch the operator already kept separate is not waiting — it was decided (wmiq).
  const waiting = candidates.branches.filter((b) => b.ahead > 0 && b.statusDecision !== "kept-separate");
  if (waiting.length === 0) {
    return {
      ok: true,
      outcome: "none",
      say: "There are no candidate branches waiting.",
    };
  }
  if (waiting.length > 1) {
    return {
      ok: true,
      outcome: "ambiguous",
      count: waiting.length,
      branches: waiting.map((b) => b.name),
      say: `${waiting.length} candidate branches are waiting — the branch inspector is open, choose one there.`,
    };
  }
  const branch = waiting[0].name;
  const result =
    intent === "land"
      ? landCandidateBranch(repoPath, branch, { baseBranch })
      : keepBranchSeparate(repoPath, branch, { note: "voice command", decisionsFile });
  if (!result.ok) return { ...result, outcome: "refused", say: result.why };
  return {
    ...result,
    outcome: "executed",
    say:
      intent === "land"
        ? `Landed ${branch} into ${baseBranch} (commit ${result.headCommit || "latest"}).`
        : `${branch} will stay separate.`,
  };
}
