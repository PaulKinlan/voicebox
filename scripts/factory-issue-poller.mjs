#!/usr/bin/env node
/**
 * Local Software Factory Inbound Issue Poller (voicebox-beads-cbxo).
 *
 * Runs locally on the project VM to monitor inbound GitHub issues, run targeted
 * factory stations, and post safe, sanitized triage comments directly on the triggering issue.
 *
 * Rules & Invariants:
 * 1. Durable Idempotent Cursor: tracks highestIssueNumber and processed issue IDs to avoid duplicate work.
 * 2. Loop Hazard Guard: skips any issue published by factory sinks or triage tools (matching body
 *    fingerprint markers or factory: / factory/ title prefixes) independent of author association.
 * 3. Same-Issue Comments ONLY: posts safe triage comments on the existing inbound issue. Never files
 *    replacement issues or automatic beads.
 * 4. Zero Credential Leakage: sanitizes all tokens/keys and embeds <!-- factory-triage-comment: <fp> -->
 *    for post-review promotion via h1u0.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeIssue } from "../tools/factory-issue-router.mjs";
import { formatTriageComment } from "../tools/factory-issue-commenter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export function pollInboundIssues(args = process.argv.slice(2), { env = process.env, rootDir = ROOT } = {}) {
  let repo = env.VOICEBOX_FACTORY_REPO || "PaulKinlan/voicebox";
  let privateDir = env.VOICEBOX_FACTORY_PRIVATE_DIR || path.join(homedir(), ".voicebox", "factory-reports");
  let cursorFile = path.join(privateDir, "factory-issue-cursor.json");
  let limit = 30;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo" && args[i + 1]) {
      repo = args[++i];
    } else if (a === "--cursor-file" && args[i + 1]) {
      cursorFile = args[++i];
    } else if (a === "--private-dir" && args[i + 1]) {
      privateDir = args[++i];
    } else if (a === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10) || 30;
    } else if (a === "--dry-run") {
      dryRun = true;
    }
  }

  mkdirSync(privateDir, { recursive: true });

  // 1. Read Cursor (supports both object map and legacy array format)
  let cursor = { highestIssueNumber: 0, processedIssues: {} };
  if (existsSync(cursorFile)) {
    try {
      const parsedCursor = JSON.parse(readFileSync(cursorFile, "utf8"));
      cursor.highestIssueNumber = parsedCursor.highestIssueNumber || 0;
      if (Array.isArray(parsedCursor.processedIssues)) {
        cursor.processedIssues = {};
        for (const id of parsedCursor.processedIssues) {
          cursor.processedIssues[id] = { updatedAt: "" };
        }
      } else {
        cursor.processedIssues = parsedCursor.processedIssues || {};
      }
    } catch {}
  }

  // 2. Fetch issues via gh CLI
  let issues = [];
  try {
    const raw = execFileSync("gh", [
      "issue",
      "list",
      "--state", "all",
      "--json", "number,title,body,author,createdAt,updatedAt,labels,authorAssociation",
      "--limit", String(limit),
      "--repo", repo,
    ], { encoding: "utf8", env });
    issues = JSON.parse(raw);
  } catch (err) {
    console.error(`[issue-poller] Failed to list issues for ${repo}: ${err.message}`);
    return { ok: false, exitCode: 1, error: err.message };
  }

  console.log(`[issue-poller] Fetched ${issues.length} issue(s) from ${repo}. Highest recorded: #${cursor.highestIssueNumber}`);

  let newProcessed = 0;
  for (const issue of issues) {
    const num = issue.number;
    const updatedAt = String(issue.updatedAt || issue.createdAt || "");
    const prevRecord = cursor.processedIssues[num];

    // Revisit if issue was updated or never processed
    if (prevRecord && prevRecord.updatedAt && prevRecord.updatedAt === updatedAt) {
      continue;
    }

    console.log(`[issue-poller] Evaluating issue #${num}: "${issue.title}" (updatedAt: ${updatedAt})`);

    // Loop hazard guard & routing
    const routing = routeIssue(issue);
    if (!routing.ok) {
      console.log(`[issue-poller] Skipping issue #${num}: ${routing.reason}`);
      cursor.processedIssues[num] = { updatedAt, skipped: true, reason: routing.reason };
      continue;
    }

    const stations = routing.agents || [];
    console.log(`[issue-poller] Issue #${num} routed to stations: [${stations.join(", ")}]`);

    if (stations.length === 0) {
      cursor.processedIssues[num] = { updatedAt, skipped: true };
      continue;
    }

    // Run scans into issue-specific temp dir
    const issueRunDir = path.join(privateDir, `issue-${num}`);
    mkdirSync(issueRunDir, { recursive: true });

    let scanSuccess = true;
    if (!dryRun) {
      for (const st of stations) {
        console.log(`[issue-poller] Running station '${st}' for issue #${num}...`);
        try {
          const res = spawnSync("factory", ["run", st, "--target", rootDir, "--sink", "file", "--station-only"], {
            cwd: rootDir,
            env: { ...env, VOICEBOX_FACTORY_PRIVATE_DIR: issueRunDir },
            encoding: "utf8",
          });
          if (res.status !== 0) {
            console.warn(`[issue-poller] Station '${st}' returned status ${res.status}`);
          }
        } catch (e) {
          console.error(`[issue-poller] Station run error: ${e.message}`);
          scanSuccess = false;
        }
      }

      // Fetch existing comments on issue for fingerprint dedupe
      let existingComments = [];
      try {
        const commentData = execFileSync("gh", [
          "issue", "view", String(num),
          "--json", "comments",
          "--repo", repo,
        ], { encoding: "utf8", env });
        const parsed = JSON.parse(commentData);
        existingComments = parsed.comments || [];
      } catch (e) {
        console.error(`[issue-poller] Failed to fetch comments for issue #${num}: ${e.message}. Refusing to comment without verified deduplication.`);
        continue; // Fail closed, retry next poll cycle
      }

      // Format safe triage comment with fingerprint deduplication
      const triageResult = formatTriageComment({
        stations,
        findingsDir: issueRunDir,
        commitSha: "HEAD",
        existingComments,
      });

      let postSuccess = true;
      if (triageResult.exitCode === 2 || triageResult.newFindings === 0) {
        console.log(`[issue-poller] Issue #${num}: all ${triageResult.totalFindings} finding(s) already commented. Skipping duplicate comment.`);
      } else if (triageResult.comment) {
        console.log(`[issue-poller] Posting triage comment (${triageResult.newFindings} new findings) to issue #${num}...`);
        try {
          execFileSync("gh", ["issue", "comment", String(num), "--body", triageResult.comment, "--repo", repo], {
            encoding: "utf8",
            env,
          });
          console.log(`[issue-poller] Successfully posted triage comment to issue #${num}`);
        } catch (e) {
          console.error(`[issue-poller] Failed to post comment on issue #${num}: ${e.message}`);
          postSuccess = false;
        }
      }

      if (!scanSuccess || !postSuccess) {
        console.warn(`[issue-poller] Issue #${num} encountered an error during scan or comment post. Not recording as processed.`);
        continue;
      }
    } else {
      console.log(`[issue-poller] DRY-RUN: would scan stations [${stations.join(", ")}] and comment on issue #${num}`);
    }

    cursor.processedIssues[num] = {
      updatedAt,
      lastPolled: new Date().toISOString(),
    };
    if (num > cursor.highestIssueNumber) {
      cursor.highestIssueNumber = num;
    }
    newProcessed++;
  }
  cursor.lastPolled = new Date().toISOString();
  writeFileSync(cursorFile, JSON.stringify(cursor, null, 2), "utf8");

  console.log(`[issue-poller] Finished polling. Processed ${newProcessed} new issue(s). Cursor saved.`);
  return { ok: true, exitCode: 0, processedCount: newProcessed, cursor };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = pollInboundIssues();
  process.exit(res.exitCode ?? (res.ok ? 0 : 1));
}
