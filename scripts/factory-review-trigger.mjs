#!/usr/bin/env node
/**
 * Local Software Factory Review Trigger Adapter (voicebox-beads-cbxo).
 *
 * Runs locally on the project VM during lane review (IN_REVIEW).
 * Features & Invariants:
 * 1. Takes explicit merge-base and tip (base..tip).
 * 2. Maps changed files to at most ONE diff-relevant station (Security > Perf > UX > Docs > Ops).
 * 3. Mixed diffs run the top station and explicitly record secondary matching stations as
 *    DEFERRED for the nightly line (never silently claimed as covered).
 * 4. Caches verdicts by change-set fingerprint (diff hash + station + factory revision).
 * 5. Bounded execution via VM heavy queue (fleet-heavy timeout 900).
 * 6. Passes private delta markdown report to h1u0 publisher (scripts/factory-triage.mjs --file-issues)
 *    to publish actionable findings across all severities to public GitHub issues.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../lib/redact.mjs";
import { selectReviewStation, computeReviewCacheKey } from "../tools/factory-issue-router.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/**
 * Comprehensive secret and token sanitizer for logs and summaries.
 */
export function sanitizeLogOutput(text = "") {
  let sanitized = redactSecrets(String(text));
  sanitized = sanitized.replace(/(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{22,})/g, "[REDACTED]");
  return sanitized;
}

/**
 * Extract safe, sanitized summary lines from publisher stdout (anchored counts and issue URLs).
 */
export function parsePublisherSummary(stdout = "") {
  const safeLines = [];
  for (const line of String(stdout).split("\n")) {
    const trimmed = line.trim();
    // 1. Anchored count tallies and structured skip receipts:
    // e.g. "published: 2", "issues: 1 published, 0 duplicate, 1 skipped", "skipped: 5939431590a57344 (identity mismatch: ...)"
    if (
      /^(published|duplicate|failed|actionable|total|clean|skipped|new|regressed):\s*\d+$/i.test(trimmed) ||
      /^issues:\s*\d+\s+published,\s*\d+\s+duplicate(?:,\s*\d+\s+skipped)?(?:,\s*\d+\s+failed)?$/i.test(trimmed) ||
      /^skipped:\s*[0-9a-f]{8,64}\s*\([^)]+\)$/i.test(trimmed)
    ) {
      safeLines.push(sanitizeLogOutput(trimmed));
    } else {
      // 2. Extracted validated issue URLs (ignoring any surrounding text or leaked payloads)
      const urlMatch = trimmed.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+/);
      if (urlMatch) {
        safeLines.push(urlMatch[0]);
      }
    }
  }
  return safeLines.join("\n");
}

export function runReviewTrigger(args = process.argv.slice(2), { env = process.env, rootDir = ROOT } = {}) {
  let baseRef = "";
  let tipRef = "HEAD";
  let repo = env.VOICEBOX_FACTORY_REPO || "PaulKinlan/voicebox";
  let privateDir = env.VOICEBOX_FACTORY_PRIVATE_DIR || path.join(homedir(), ".voicebox", "factory-reports");
  let beadId = env.REVIEW_BEAD || "";
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base" && args[i + 1]) {
      baseRef = args[++i];
    } else if (a === "--tip" && args[i + 1]) {
      tipRef = args[++i];
    } else if (a === "--repo" && args[i + 1]) {
      repo = args[++i];
    } else if (a === "--private-dir" && args[i + 1]) {
      privateDir = args[++i];
    } else if (a === "--bead" && args[i + 1]) {
      beadId = args[++i];
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--force") {
      force = true;
    }
  }

  if (!baseRef) {
    // Resolve default merge base against origin/main or HEAD~1
    try {
      baseRef = execFileSync("git", ["merge-base", "origin/main", tipRef], { cwd: rootDir, encoding: "utf8" }).trim();
    } catch {
      baseRef = "HEAD~1";
    }
  }

  // 1. Get changed files
  let diffFilesRaw = "";
  let diffContent = "";
  try {
    diffFilesRaw = execFileSync("git", ["diff", "--name-only", `${baseRef}..${tipRef}`], { cwd: rootDir, encoding: "utf8" }).trim();
    diffContent = execFileSync("git", ["diff", `${baseRef}..${tipRef}`], { cwd: rootDir, encoding: "utf8" });
  } catch (err) {
    console.error(`[review-trigger] git diff failed between ${baseRef} and ${tipRef}: ${err.message}`);
    return { ok: false, exitCode: 1, error: err.message };
  }

  const changedFiles = diffFilesRaw.split("\n").map((f) => f.trim()).filter(Boolean);
  if (changedFiles.length === 0) {
    console.log(`[review-trigger] Clean diff (${baseRef}..${tipRef}): 0 changed files. Nothing to scan.`);
    return { ok: true, exitCode: 0, changedFiles: [], station: null };
  }

  // 2. Select at most ONE relevant station
  const selection = selectReviewStation(changedFiles);
  const { station, category, deferred } = selection;

  console.log(`[review-trigger] Diff changes: ${changedFiles.length} file(s) across categories: [${selection.matchedCategories.join(", ")}]`);
  console.log(`[review-trigger] Selected primary station: '${station}' (category: ${category})`);
  if (deferred.length > 0) {
    const defNames = deferred.map((d) => `'${d.station}' (${d.category})`).join(", ");
    console.log(`[review-trigger] Bounded review cap (max 1): Deferred secondary stations for nightly line: ${defNames}`);
  }

  // 3. Resolve pinned factory ref & Cache Key
  let factoryRef = "1e970d595748a7c38b7fd39417e055165d7edecd";
  try {
    const agentsHead = path.join(homedir(), "agents", ".git", "refs", "heads", "main");
    if (existsSync(agentsHead)) {
      factoryRef = readFileSync(agentsHead, "utf8").trim().slice(0, 40);
    }
  } catch {}

  const cacheKey = computeReviewCacheKey({ diffContent, station, factoryRef });
  const cacheFile = path.join(privateDir, "review-cache.json");
  mkdirSync(privateDir, { recursive: true });

  let cache = {};
  if (existsSync(cacheFile)) {
    try {
      cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    } catch {}
  }

  if (!force && cache[cacheKey] && cache[cacheKey].exitCode === 0) {
    console.log(`[review-trigger] Cache HIT for key ${cacheKey.slice(0, 12)} (station: ${station}). Reusing prior verdict: ${cache[cacheKey].verdict}`);
    return { ok: true, exitCode: 0, cached: true, ...cache[cacheKey] };
  }

  if (dryRun) {
    console.log(`[review-trigger] DRY-RUN complete: would run '${station}' under heavy queue and publish to repo '${repo}'`);
    return { ok: true, exitCode: 0, dryRun: true, station, deferred, cacheKey };
  }

  // 4. Bounded execution via fleet-heavy / timeout 900
  const runId = `run-${Date.now()}`;
  const runDir = path.join(privateDir, runId);
  mkdirSync(runDir, { recursive: true });
  const runLog = path.join(runDir, `${station}.log`);

  console.log(`[review-trigger] Executing station '${station}' with --sink file --station-only (runDir: ${runDir})...`);

  let runExit = 0;
  try {
    const hasFleetHeavy = existsSync("/usr/local/bin/fleet-heavy") || spawnSync("which", ["fleet-heavy"]).status === 0;
    const cmd = hasFleetHeavy
      ? ["fleet-heavy", "timeout", "900", "factory", "run", station, "--target", rootDir, "--sink", "file", "--station-only"]
      : ["timeout", "-k", "30", "900", "factory", "run", station, "--target", rootDir, "--sink", "file", "--station-only"];

    const res = spawnSync(cmd[0], cmd.slice(1), {
      cwd: rootDir,
      env: { ...env, VOICEBOX_FACTORY_PRIVATE_DIR: runDir },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    writeFileSync(runLog, `${res.stdout || ""}\n${res.stderr || ""}`, "utf8");
    runExit = res.status ?? 1;
  } catch (e) {
    console.error(`[review-trigger] Station run execution failed: ${e.message}`);
    runExit = 1;
  }

  if (runExit !== 0) {
    const verdict = runExit === 124 || runExit === 137 || runExit === 143 ? "TIMEOUT/KILL" : "FAILED";
    console.error(`[review-trigger] Station '${station}' finished with non-zero exit ${runExit} (${verdict})`);
    // Never cache failed executions; invalidate any stale entry
    if (cache[cacheKey]) {
      delete cache[cacheKey];
      writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
    }
    return { ok: false, exitCode: runExit, verdict, station };
  }

  // 5. Locate Delta Report and publish via h1u0 publisher
  // Strictly enforce attempt provenance: the report MUST be produced in this attempt's runDir
  const targetName = path.basename(rootDir);
  const candidateReportName = `${targetName}-${station}-delta.md`;
  const candidateReportPath = path.join(runDir, candidateReportName);
  const foundReportPath = existsSync(candidateReportPath) ? candidateReportPath : "";

  let publishExit = 0;
  if (foundReportPath) {
    console.log(`[review-trigger] Calling h1u0 publisher (scripts/factory-triage.mjs --file-issues --include-low) for ${candidateReportName}...`);
    try {
      const triageScript = path.join(rootDir, "scripts", "factory-triage.mjs");
      if (existsSync(triageScript)) {
        const pubRes = spawnSync("node", [triageScript, "--report", foundReportPath, "--repo", repo, "--file-issues", "--include-low"], {
          cwd: rootDir,
          env: { ...env, VOICEBOX_FACTORY_PRIVATE_DIR: runDir },
          encoding: "utf8",
        });
        publishExit = pubRes.status ?? 1;
        const safeSummary = parsePublisherSummary(pubRes.stdout || "");
        console.log(`[review-trigger] Publisher summary:\n${safeSummary || "(no summary emitted)"}`);
        if (pubRes.stderr) console.error(`[review-trigger] Publisher stderr:\n${sanitizeLogOutput(pubRes.stderr)}`);
      } else {
        console.error(`[review-trigger] Error: scripts/factory-triage.mjs is absent; cannot publish delta report.`);
        publishExit = 1;
      }
    } catch (e) {
      console.error(`[review-trigger] Publisher invocation error: ${e.message}`);
      publishExit = 1;
    }
  } else {
    console.log(`[review-trigger] Notice: No delta report produced by station '${station}' (clean pass).`);
  }

  const ok = runExit === 0 && (publishExit === 0 || publishExit === 2);
  const verdict = ok ? "PASS" : "FAILED";
  const exitCode = ok ? 0 : 1;

  // 6. Record on Bead if requested
  if (beadId) {
    const defNote = deferred.length > 0 ? ` (deferred for nightly: ${deferred.map((d) => d.station).join(", ")})` : "";
    const beadMsg = `Factory review: station '${station}', verdict ${verdict}${defNote}, cacheKey ${cacheKey.slice(0, 10)}`;
    try {
      spawnSync("bd", ["comment", beadId, beadMsg], { cwd: rootDir, encoding: "utf8" });
      console.log(`[review-trigger] Recorded review verdict on bead ${beadId}`);
    } catch (e) {
      console.warn(`[review-trigger] Could not comment on bead ${beadId}: ${e.message}`);
    }
  }

  // 7. Store cache entry (STRICT: only successful passes are cached so failures are never replayed)
  if (ok) {
    cache[cacheKey] = {
      station,
      category,
      exitCode: 0,
      verdict: "PASS",
      deferred,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
  } else {
    if (cache[cacheKey]) {
      delete cache[cacheKey];
      writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf8");
    }
  }

  console.log(`[review-trigger] Completed review trigger for '${station}': ${verdict}`);
  return { ok, exitCode, verdict, station, deferred, cacheKey };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = runReviewTrigger();
  process.exit(res.exitCode ?? (res.ok ? 0 : 1));
}
