#!/usr/bin/env node
/**
 * scripts/factory-review-watcher.mjs — pre-merge review watcher & backstop (voicebox-beads-xacp).
 *
 * Automatically monitors active candidate branches meeting the conjunctive ownership predicate:
 * (active bead assigned to voicebox-* AND matching owned origin/fleet/* candidate ref).
 *
 * Runs bounded under fleet-heavy timeout 900, capping at 1 station per review diff,
 * persisting exact 4-tuple cache (diffHash:station:factoryRef:repo), and recording verdicts.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runReviewTrigger } from "./factory-review-trigger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/** Excluded merger and coord artifact branch patterns */
export const ARTIFACT_BRANCH_PATTERNS = [
  /^fleet\/rescued-/,
  /^fleet\/backup-/,
  /^fleet\/merger-/,
  /^fleet\/temp-/,
];

export function runReviewWatcher(args = process.argv.slice(2), { env = process.env, rootDir = ROOT, mockBeads = null } = {}) {
  let repo = env.VOICEBOX_FACTORY_REPO || "PaulKinlan/voicebox";
  let privateDir = env.VOICEBOX_FACTORY_PRIVATE_DIR || path.join(homedir(), ".voicebox", "factory-reports");
  // Default to dry-run mode so unattended 15-minute watcher ticks evaluate diffs without filing public GitHub issues.
  // Explicit --publish or --file-issues is required to file public issues.
  let publish = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--publish" || a === "--file-issues") {
      publish = true;
    } else if (a === "--dry-run") {
      publish = false;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--private-dir" && args[i + 1]) {
      privateDir = args[++i];
    } else if (a === "--repo" && args[i + 1]) {
      repo = args[++i];
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: scripts/factory-review-watcher.sh [options]

Options:
  --publish, --file-issues Publish findings as public GitHub issues (default: dry-run plan mode)
  --dry-run                Inspect candidate branches without filing issues (default)
  --force                  Force re-scan of candidate diffs
  --private-dir <dir>      Directory for watcher cursor and state
  --repo <owner/repo>      Target repository (default: PaulKinlan/voicebox)
  --help, -h               Show this help message`);
      return { ok: true, exitCode: 0, help: true };
    }
  }

  mkdirSync(privateDir, { recursive: true });
  const cursorFile = path.join(privateDir, "review-watcher-cursor.json");
  let cursor = { processedBranches: {}, lastMainSha: "" };
  if (existsSync(cursorFile)) {
    try {
      cursor = JSON.parse(readFileSync(cursorFile, "utf8"));
    } catch {}
  }

  // 1. Fetch remote origin refs to ensure fresh view of branches
  try {
    execFileSync("git", ["fetch", "origin", "--prune"], {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
      timeout: 60000,
    });
  } catch {}

  // 2. Discover Active Candidate Branches with AND Ownership Predicate:
  // (Bead assigned to voicebox-* AND explicit candidate ref matching owned fleet/*)
  const candidateTasks = [];
  let beadsList = mockBeads;
  if (!beadsList) {
    try {
      const raw = execFileSync("bd", ["list", "--json"], {
        cwd: rootDir,
        encoding: "utf8",
        env,
        timeout: 30000,
      });
      beadsList = JSON.parse(raw);
    } catch {
      beadsList = [];
    }
  }

  for (const b of beadsList) {
    const assignee = String(b.assignee || "").toLowerCase();
    const isVoiceboxAssignee = assignee.startsWith("voicebox-");
    const status = String(b.status || "").toLowerCase();
    const labels = Array.isArray(b.labels) ? b.labels.map((l) => String(l).toLowerCase()) : [];
    const isReviewState = status === "in_progress" || status === "open" || labels.includes("merge-queue");

    if (!isVoiceboxAssignee || !isReviewState) {
      continue;
    }

    // Look for explicit candidate branch in bead description or comments
    const textBlob = `${b.title || ""} ${b.description || ""}`;
    const branchMatch = textBlob.match(/(?:fleet\/[a-zA-Z0-9._-]+)/);
    if (!branchMatch) {
      continue;
    }

    const branchName = branchMatch[0];

    // Exclude merger/coord artifact branches
    if (ARTIFACT_BRANCH_PATTERNS.some((re) => re.test(branchName))) {
      continue;
    }

    // Verify branch exists on origin remote
    const remoteRef = `refs/remotes/origin/${branchName}`;
    let tipSha = "";
    try {
      tipSha = execFileSync("git", ["rev-parse", "--verify", remoteRef], {
        cwd: rootDir,
        encoding: "utf8",
        env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
      }).trim();
    } catch {
      continue; // Remote branch does not exist
    }

    // Find merge-base with origin/main
    let baseSha = "";
    try {
      baseSha = execFileSync("git", ["merge-base", "origin/main", tipSha], {
        cwd: rootDir,
        encoding: "utf8",
        env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
      }).trim();
    } catch {
      continue;
    }

    if (baseSha && tipSha && baseSha !== tipSha) {
      candidateTasks.push({
        beadId: b.id,
        branch: branchName,
        remoteRef,
        baseSha,
        tipSha,
      });
    }
  }

  console.log(`[review-watcher] Discovered ${candidateTasks.length} active owned candidate branch(es).`);

  let scannedCount = 0;
  let watcherErrors = 0;

  for (const task of candidateTasks) {
    const { beadId, branch, baseSha, tipSha } = task;
    const taskKey = `${branch}@${tipSha}`;

    if (!force && cursor.processedBranches[taskKey]) {
      continue;
    }

    console.log(`[review-watcher] Evaluating candidate branch ${branch} for bead ${beadId} (${baseSha.slice(0, 7)}..${tipSha.slice(0, 7)})`);

    const triggerRes = runReviewTrigger([
      "--base", baseSha,
      "--tip", tipSha,
      "--bead", beadId,
      "--repo", repo,
      "--private-dir", path.join(privateDir, "review-scans"),
      ...(!publish ? ["--dry-run"] : []),
      ...(force ? ["--force"] : []),
    ], {
      env,
      rootDir,
    });

    if (!triggerRes.ok) {
      console.error(`[review-watcher] Review scan failed for candidate ${branch}: exit ${triggerRes.exitCode}`);
      watcherErrors++;
    } else {
      scannedCount++;
      if (publish) {
        cursor.processedBranches[taskKey] = {
          beadId,
          baseSha,
          tipSha,
          station: triggerRes.station,
          verdict: triggerRes.verdict,
          scannedAt: new Date().toISOString(),
        };
        try {
          writeFileSync(cursorFile, JSON.stringify(cursor, null, 2), "utf8");
        } catch {}
      }
    }
  }

  // 3. Backstop: Evaluate newly landed commits on origin/main
  try {
    const currentMainSha = execFileSync("git", ["rev-parse", "origin/main"], {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
    }).trim();

    if (cursor.lastMainSha && cursor.lastMainSha !== currentMainSha) {
      // Fail-closed rewrite check: assert cursor.lastMainSha is an ancestor of currentMainSha
      const isAncestor = spawnSync("git", ["merge-base", "--is-ancestor", cursor.lastMainSha, currentMainSha], {
        cwd: rootDir,
        env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
      }).status === 0;

      if (!isAncestor) {
        console.error(`[review-watcher] Refusing backstop scan: lastMainSha '${cursor.lastMainSha}' is not an ancestor of origin/main '${currentMainSha}' (origin rebased or rewritten). Halting requiring operator reconciliation.`);
        watcherErrors++;
      } else {
        console.log(`[review-watcher] Backstop: origin/main moved (${cursor.lastMainSha.slice(0, 7)}..${currentMainSha.slice(0, 7)}). Evaluating landed diff...`);
        const backstopRes = runReviewTrigger([
          "--base", cursor.lastMainSha,
          "--tip", currentMainSha,
          "--repo", repo,
          "--private-dir", path.join(privateDir, "review-scans"),
          ...(!publish ? ["--dry-run"] : []),
          ...(force ? ["--force"] : []),
        ], {
          env,
          rootDir,
        });

        if (backstopRes.ok && publish) {
          cursor.lastMainSha = currentMainSha;
          try {
            writeFileSync(cursorFile, JSON.stringify(cursor, null, 2), "utf8");
          } catch {}
        }
      }
    } else if (!cursor.lastMainSha) {
      // Initialize backstop cursor to current main without scanning all history
      cursor.lastMainSha = currentMainSha;
      if (publish) {
        try {
          writeFileSync(cursorFile, JSON.stringify(cursor, null, 2), "utf8");
        } catch {}
      }
    }
  } catch {}

  const ok = watcherErrors === 0;
  return { ok, exitCode: ok ? 0 : 1, scannedCount, watcherErrors, cursor };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = runReviewWatcher();
  process.exit(res.exitCode);
}
