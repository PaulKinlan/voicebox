#!/usr/bin/env node
/**
 * scripts/factory-nightly-publisher.mjs — publishes nightly factory findings to public GitHub issues (voicebox-beads-xacp).
 *
 * Enforces strict SAME-RUN manifest completion barrier, target verification,
 * timestamp window validation, path canonical containment, and failure-safe cursor.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { containedIn } from "../lib/path-auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export function publishNightlyFindings(args = process.argv.slice(2), { env = process.env, rootDir = ROOT } = {}) {
  let repo = env.VOICEBOX_FACTORY_REPO || "PaulKinlan/voicebox";
  let findingsDir = env.VOICEBOX_FINDINGS_DIR || path.join(homedir(), "agents", "findings");
  let runsDir = env.VOICEBOX_RUNS_DIR || path.join(homedir(), "agents", "runs");
  let privateDir = env.VOICEBOX_FACTORY_PRIVATE_DIR || path.join(homedir(), ".voicebox", "factory-reports");
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--findings-dir" && args[i + 1]) {
      findingsDir = args[++i];
    } else if (a === "--runs-dir" && args[i + 1]) {
      runsDir = args[++i];
    } else if (a === "--private-dir" && args[i + 1]) {
      privateDir = args[++i];
    } else if (a === "--repo" && args[i + 1]) {
      repo = args[++i];
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: scripts/factory-nightly-publisher.sh [options]

Options:
  --dry-run              Output publication plan without filing GitHub issues
  --force                Bypass cursor and re-evaluate current batch
  --findings-dir <dir>   Directory containing station delta reports (default: ~/agents/findings)
  --runs-dir <dir>       Directory containing station run artifacts (default: ~/agents/runs)
  --private-dir <dir>    Private directory for cursor and attempt logs (default: ~/.voicebox/factory-reports)
  --repo <owner/repo>    Target GitHub repository (default: PaulKinlan/voicebox)
  --help, -h             Show this help message`);
      return { ok: true, exitCode: 0, help: true };
    }
  }

  // 1. Guard against active running service
  try {
    const serviceCheck = spawnSync("systemctl", ["is-active", "fleet-factory.service"], { encoding: "utf8" });
    if (serviceCheck.stdout?.trim() === "active") {
      console.log(`[nightly-publisher] fleet-factory.service is actively running. Refusing to publish partial batch.`);
      return { ok: false, exitCode: 1, error: "service_active" };
    }
  } catch {}

  // 2. Validate SAME-RUN manifest barrier (voicebox-factory-line.json)
  const manifestPath = path.join(findingsDir, "voicebox-factory-line.json");
  if (!existsSync(manifestPath)) {
    console.error(`[nightly-publisher] Error: Missing line manifest at ${manifestPath}. Nightly run has not produced a completion receipt.`);
    return { ok: false, exitCode: 1, error: "missing_manifest" };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`[nightly-publisher] Error: Invalid line manifest JSON at ${manifestPath}: ${e.message}`);
    return { ok: false, exitCode: 1, error: "invalid_manifest" };
  }

  if (manifest.target !== "voicebox-factory") {
    console.error(`[nightly-publisher] Error: Manifest target '${manifest.target}' does not match 'voicebox-factory'`);
    return { ok: false, exitCode: 1, error: "foreign_manifest_target" };
  }

  if (manifest.line !== "project-audit") {
    console.error(`[nightly-publisher] Error: Manifest line '${manifest.line}' is not 'project-audit'`);
    return { ok: false, exitCode: 1, error: "wrong_line" };
  }

  if (manifest.complete !== true) {
    console.error(`[nightly-publisher] Error: Manifest indicates incomplete line run (complete !== true).`);
    return { ok: false, exitCode: 1, error: "incomplete_run" };
  }

  // Check freshness (manifest generated within the last 24h)
  const generatedTime = new Date(manifest.generated).getTime();
  if (isNaN(generatedTime) || Date.now() - generatedTime > 24 * 60 * 60 * 1000) {
    console.error(`[nightly-publisher] Error: Manifest generated timestamp (${manifest.generated}) is older than 24 hours. Stale batch.`);
    return { ok: false, exitCode: 1, error: "stale_manifest" };
  }

  // All stations in manifest must have status PASS
  const stations = manifest.stations || [];
  if (stations.length === 0) {
    console.error(`[nightly-publisher] Error: Manifest contains zero station records.`);
    return { ok: false, exitCode: 1, error: "empty_stations" };
  }

  const failedStations = stations.filter((s) => s.status !== "PASS");
  if (failedStations.length > 0) {
    console.error(`[nightly-publisher] Error: Nightly batch has failed stations: ${failedStations.map((s) => s.station).join(", ")}. Refusing partial publication.`);
    return { ok: false, exitCode: 1, error: "failed_stations", failed: failedStations };
  }

  // 3. Check Idempotent Batch Cursor
  const cursorFile = path.join(privateDir, "nightly-cursor.json");
  let cursor = { lastPublishedBatch: "" };
  if (existsSync(cursorFile)) {
    try {
      cursor = JSON.parse(readFileSync(cursorFile, "utf8"));
    } catch {}
  }

  if (!force && cursor.lastPublishedBatch === manifest.generated) {
    console.log(`[nightly-publisher] Batch '${manifest.generated}' already successfully published. Skipping duplicate run.`);
    return { ok: true, exitCode: 0, skippedDuplicate: true, batch: manifest.generated };
  }

  // 4. Verify Voicebox Target Directory & Remote Origin
  let verifiedTarget = "";
  const candidateTarget = path.join(homedir(), "worktrees", "voicebox-factory");
  const fallbackTarget = path.join(homedir(), "voicebox");
  for (const t of [candidateTarget, fallbackTarget, rootDir]) {
    if (existsSync(t)) {
      try {
        const originUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
          cwd: t,
          encoding: "utf8",
          env: { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
        }).trim();
        if (originUrl.toLowerCase().includes("paulkinlan/voicebox")) {
          verifiedTarget = t;
          break;
        }
      } catch {}
    }
  }

  if (!verifiedTarget) {
    console.error(`[nightly-publisher] Error: Could not verify local checkout for target repository ${repo}`);
    return { ok: false, exitCode: 1, error: "unverified_target_checkout" };
  }

  // 5. Publish Station Delta Reports with Strict Provenance & Batch Window Checks
  const triageScript = path.join(rootDir, "scripts", "factory-triage.mjs");
  if (!existsSync(triageScript)) {
    console.error(`[nightly-publisher] Error: Missing publisher script at ${triageScript}`);
    return { ok: false, exitCode: 1, error: "missing_triage_script" };
  }

  let processedCount = 0;
  let publishErrors = 0;

  for (const st of stations) {
    const stationName = st.station;
    const runDir = st.run_dir;

    // Report candidates: primary is in findingsDir, fallback is in station run_dir
    const reportCandidates = [
      path.join(findingsDir, `voicebox-factory-${stationName}-delta.md`),
      path.join(runDir, `voicebox-factory-${stationName}-delta.md`),
      path.join(runDir, `voicebox-factory-delta.md`),
    ];

    let reportPath = "";
    for (const cand of reportCandidates) {
      if (existsSync(cand)) {
        reportPath = cand;
        break;
      }
    }

    if (!reportPath) {
      const explicitZero = st.findings_count === 0 && (st.criticals ?? 0) === 0 && (st.highs ?? 0) === 0;
      if (explicitZero) {
        console.log(`[nightly-publisher] Station '${stationName}' has no delta report but explicitly declared findings_count=0. Clean pass.`);
        continue;
      } else {
        console.error(`[nightly-publisher] Error: Station '${stationName}' has no delta report and did not declare findings_count=0 (findings_count=${st.findings_count}, criticals=${st.criticals}). Failing closed.`);
        publishErrors++;
        continue;
      }
    }

    // Canonical containment check: reportPath must resolve inside findingsDir or runDir (reject ../ and symlink escapes)
    let realReport;
    try {
      realReport = realpathSync(reportPath);
      const realFindings = realpathSync(findingsDir);
      const realRuns = existsSync(runsDir) ? realpathSync(runsDir) : "";
      const insideFindings = containedIn(realFindings, realReport);
      const insideRuns = realRuns ? containedIn(realRuns, realReport) : false;
      if (!insideFindings && !insideRuns) {
        console.error(`[nightly-publisher] Error: Report path ${realReport} escapes authorized findings/runs directories.`);
        publishErrors++;
        continue;
      }
    } catch (e) {
      console.error(`[nightly-publisher] Error: Failed to resolve realpath for ${reportPath}: ${e.message}`);
      publishErrors++;
      continue;
    }

    // Batch window check: report mtime must be <= generated + 60s AND >= generated - 3h
    const stStat = statSync(realReport);
    const mtime = stStat.mtimeMs;
    const minMtime = generatedTime - 3 * 60 * 60 * 1000;
    const maxMtime = generatedTime + 60 * 1000;

    if (mtime < minMtime || mtime > maxMtime) {
      console.error(`[nightly-publisher] Error: Station '${stationName}' report mtime (${new Date(mtime).toISOString()}) is outside batch window [${new Date(minMtime).toISOString()} .. ${new Date(maxMtime).toISOString()}]. Stale or future report.`);
      publishErrors++;
      continue;
    }

    // Target frontmatter verification: Report must explicitly mention voicebox-factory or voicebox
    try {
      const headerSnippet = readFileSync(realReport, "utf8").slice(0, 500);
      if (!headerSnippet.includes("voicebox-factory") && !headerSnippet.includes("voicebox")) {
        console.error(`[nightly-publisher] Error: Station '${stationName}' report does not target Voicebox. Header check failed.`);
        publishErrors++;
        continue;
      }
    } catch (e) {
      console.error(`[nightly-publisher] Error reading report header for '${stationName}': ${e.message}`);
      publishErrors++;
      continue;
    }

    console.log(`[nightly-publisher] Processing verified station report: ${path.basename(realReport)} (${stationName})`);

    const pubArgs = [
      triageScript,
      "--report", realReport,
      "--repo", repo,
      "--target", verifiedTarget,
      "--include-low",
    ];

    // Deliberate cross-target allowance only when verifiedTarget origin is proven to match repo
    if (path.basename(verifiedTarget).toLowerCase() !== repo.split("/")[1]?.toLowerCase()) {
      pubArgs.push("--allow-foreign-target");
    }

    if (!dryRun) {
      pubArgs.push("--file-issues");
    }

    try {
      const res = spawnSync(process.execPath, pubArgs, {
        cwd: rootDir,
        encoding: "utf8",
        env,
        timeout: 180000,
      });

      const stdout = res.stdout || "";
      const hasSkippedFindings =
        /skipped:\s*[0-9a-f]{8,64}/i.test(stdout) ||
        /,\s*[1-9]\d*\s+skipped/i.test(stdout);
      const hasFailedFindings =
        /,\s*[1-9]\d*\s+FAILED/i.test(stdout) ||
        /failed:\s*[0-9a-f]{8,64}/i.test(stdout);

      if (hasSkippedFindings || hasFailedFindings) {
        console.error(`[nightly-publisher] Warning: Publisher had skipped or failed findings for '${stationName}' (exit ${res.status}):\n${stdout}`);
        publishErrors++;
      } else if (res.status === 0 || res.status === 2) {
        processedCount++;
        console.log(`[nightly-publisher] Successfully processed ${stationName} (exit: ${res.status})`);
      } else {
        console.error(`[nightly-publisher] Warning: Publisher returned non-zero exit ${res.status} for ${stationName}:\n${res.stderr || stdout}`);
        publishErrors++;
      }
    } catch (e) {
      console.error(`[nightly-publisher] Execution error publishing ${stationName}: ${e.message}`);
      publishErrors++;
    }
  }

  // 6. Update Batch Cursor only on complete success
  if (publishErrors > 0) {
    console.error(`[nightly-publisher] Batch completed with ${publishErrors} error(s). Cursor not updated to allow retry.`);
    return { ok: false, exitCode: 1, processedCount, publishErrors };
  }

  if (!dryRun) {
    mkdirSync(privateDir, { recursive: true });
    cursor.lastPublishedBatch = manifest.generated;
    cursor.lastPublishedTime = new Date().toISOString();
    try {
      writeFileSync(cursorFile, JSON.stringify(cursor, null, 2), "utf8");
    } catch (e) {
      console.warn(`[nightly-publisher] Warning: Failed to write cursor file: ${e.message}`);
    }
  }

  console.log(`[nightly-publisher] Finished processing ${processedCount} station delta report(s) with 0 errors.`);
  return { ok: true, exitCode: 0, processedCount, batch: manifest.generated, dryRun };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = publishNightlyFindings();
  process.exit(result.exitCode);
}
