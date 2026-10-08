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

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../lib/redact.mjs";
import { gitEnv } from "../lib/git-env.mjs";
import { selectReviewStation, computeReviewCacheKey, NIGHTLY_PROJECT_AUDIT_STATIONS } from "../tools/factory-issue-router.mjs";

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
    // Supports nested parentheses in skip reason (e.g. step-summary forms)
    if (
      /^(published|duplicate|failed|actionable|total|clean|skipped|new|regressed):\s*\d+$/i.test(trimmed) ||
      /^issues:\s*\d+\s+published,\s*\d+\s+duplicate(?:,\s*\d+\s+skipped)?(?:,\s*\d+\s+failed)?$/i.test(trimmed) ||
      /^skipped:\s*[0-9a-f]{8,64}\s*\(.+\)$/i.test(trimmed)
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

/**
 * Locate delta report produced specifically by this attempt in runDir.
 * Enforces attempt provenance: ambient reports in persistent directories are strictly ignored.
 */
export function locateRunDeltaReport(runDir, rootDir, station) {
  const targetName = path.basename(rootDir);
  const candidateReportName = `${targetName}-${station}-delta.md`;
  const candidateReportPath = path.join(runDir, candidateReportName);
  return existsSync(candidateReportPath) ? candidateReportPath : "";
}

/**
 * Verifies that a station delta report was genuinely produced by the current station attempt:
 * - File exists and is non-empty.
 * - Hash differs from pre-run hash (report was modified or freshly created).
 * - Frontmatter header matches target name (or voicebox).
 * - If header declares a station, it matches the requested station.
 * - Generated timestamp is present, valid, and >= run start time.
 */
export function validateStationReportProvenance(reportPath, { targetName, station, startTime, hashBefore = null, rootDir = ROOT }) {
  if (!existsSync(reportPath)) {
    return { ok: false, error: "report_not_found" };
  }
  let content = "";
  try {
    content = readFileSync(reportPath, "utf8");
  } catch (e) {
    return { ok: false, error: "report_unreadable" };
  }
  if (!content.trim()) {
    return { ok: false, error: "report_empty" };
  }

  // Hash check: if pre-run file existed, ensure content was rewritten
  const hashAfter = createHash("sha256").update(content).digest("hex");
  if (hashBefore && hashAfter === hashBefore) {
    return { ok: false, error: "report_unchanged_from_prior_attempt" };
  }

  // Header and Target Check
  const headerMatch = content.match(/^# Software Factory Delta Report:\s*([^\n]+)/m);
  if (!headerMatch) {
    return { ok: false, error: "missing_factory_delta_header" };
  }
  const headerTarget = headerMatch[1].trim();
  const validTarget = headerTarget.toLowerCase().includes(targetName.toLowerCase()) || headerTarget.toLowerCase().includes("voicebox");
  if (!validTarget) {
    return { ok: false, error: `target_mismatch: header '${headerTarget}' does not match '${targetName}'` };
  }

  // Station check if present in header
  if (headerTarget.includes(" / ")) {
    const reportedStation = headerTarget.split(" / ")[1].trim();
    if (reportedStation !== station) {
      return { ok: false, error: `station_mismatch: header specifies '${reportedStation}', expected '${station}'` };
    }
  }

  // Timestamp check
  const genMatch = content.match(/^Generated:\s*([^\n]+)/m);
  if (!genMatch) {
    return { ok: false, error: "missing_generated_timestamp" };
  }
  const reportTime = new Date(genMatch[1]).getTime();
  if (isNaN(reportTime) || reportTime < startTime - 5000) {
    return { ok: false, error: `stale_report_timestamp: generated at ${genMatch[1]}, run started at ${new Date(startTime).toISOString()}` };
  }

  return { ok: true, hash: hashAfter, generated: genMatch[1] };
}

export const APPROVED_GIT_HOSTS = new Set(["github.com", "github.int.exe.xyz", "ssh.github.com"]);

export function getCheckoutRepoIdentity(cwd = ROOT, env = process.env) {
  try {
    const cleanEnv = gitEnv(env);
    const remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, env: cleanEnv, encoding: "utf8" }).trim();
    const m = remoteUrl.match(/^(?:https?:\/\/([a-zA-Z0-9.-]+)(?::\d+)?\/|git@([a-zA-Z0-9.-]+):)([^/:]+\/[^/:]+?)(?:\.git)?$/i);
    if (m) {
      const host = (m[1] || m[2] || "").toLowerCase();
      if (APPROVED_GIT_HOSTS.has(host)) {
        return m[3].toLowerCase();
      }
    }
  } catch {}
  return "";
}

export function calculateDiffHash(diffContent, station, factoryRef, repo = "") {
  return computeReviewCacheKey({ diffContent, station, factoryRef, repo });
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
    } else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/factory-review-trigger.mjs [options]
Options:
  --base <base>       Base git ref or commit SHA (default: merge-base with origin/main)
  --tip <tip>         Tip git ref or commit SHA (default: HEAD)
  --bead <id>         Bead issue ID to receive review verdict comments
  --dry-run           Plan and select stations without executing or publishing
  --force             Bypass cache and force re-execution
  --repo <owner/repo> Target repository for publication (default: PaulKinlan/voicebox)
  --private-dir <dir> Directory for private delta reports (default: ~/.voicebox/factory-reports)
  --help, -h          Show this help message`);
      return { ok: true, exitCode: 0, help: true };
    }
  }

  if (dryRun) {
    console.log(`[review-trigger] DRY-RUN mode active.`);
  }

  const cleanEnv = gitEnv(env);

  // Pre-execution validation: Refuse execution if checkout origin is known on an approved host and differs from target repo.
  // Must execute BEFORE cache lookup so cached results from previous runs cannot falsely pass on mismatched repos.
  const checkoutRepo = getCheckoutRepoIdentity(rootDir, cleanEnv);
  if (checkoutRepo && checkoutRepo !== repo.toLowerCase()) {
    console.error(`[review-trigger] Refusing execution: checkout origin '${checkoutRepo}' does not match target repo '${repo}'`);
    return { ok: false, exitCode: 1, error: `checkout origin '${checkoutRepo}' does not match target repo '${repo}'` };
  }

  if (!baseRef) {
    // Resolve default merge base against origin/main or HEAD~1
    try {
      baseRef = execFileSync("git", ["merge-base", "origin/main", tipRef], { cwd: rootDir, env: cleanEnv, encoding: "utf8" }).trim();
    } catch {
      baseRef = "HEAD~1";
    }
  }

  // 1. Get changed files
  let diffFilesRaw = "";
  let diffContent = "";
  try {
    diffFilesRaw = execFileSync("git", ["diff", "--name-only", `${baseRef}..${tipRef}`], { cwd: rootDir, env: cleanEnv, encoding: "utf8" }).trim();
    diffContent = execFileSync("git", ["diff", `${baseRef}..${tipRef}`], { cwd: rootDir, env: cleanEnv, encoding: "utf8" });
  } catch (err) {
    console.error(`[review-trigger] git diff failed between ${baseRef} and ${tipRef}: ${sanitizeLogOutput(err.message)}`);
    return { ok: false, exitCode: 1, error: sanitizeLogOutput(err.message) };
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

  const cacheKey = computeReviewCacheKey({ diffContent, station, factoryRef, repo });
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

  // 4. Bounded execution via fleet-heavy / timeout 900 under per-target exclusive lock
  const runId = `run-${Date.now()}`;
  const runDir = path.join(privateDir, runId);
  mkdirSync(runDir, { recursive: true });
  const runLog = path.join(runDir, `${station}.log`);
  const targetName = path.basename(rootDir);

  const startTime = Date.now();
  const lockDir = path.join(homedir(), ".voicebox", "factory-reports");
  mkdirSync(lockDir, { recursive: true });
  const targetLockPath = path.join(lockDir, `${targetName}.lock`);

  const findingsDir = path.join(homedir(), "agents", "findings");
  const defaultReportName = `${targetName}-delta.md`;
  const defaultReportPath = path.join(findingsDir, defaultReportName);
  const hashBefore = existsSync(defaultReportPath)
    ? createHash("sha256").update(readFileSync(defaultReportPath)).digest("hex")
    : null;

  const isolatedReportName = `${targetName}-${station}-delta.md`;
  const isolatedReportPath = path.join(runDir, isolatedReportName);

  console.log(`[review-trigger] Executing station '${station}' under target lock ${targetName}.lock (runDir: ${runDir})...`);

  let runExit = 0;
  try {
    const hasFleetHeavy = existsSync("/usr/local/bin/fleet-heavy") || spawnSync("which", ["fleet-heavy"]).status === 0;
    const innerCmd = hasFleetHeavy
      ? ["fleet-heavy", "timeout", "900", "factory", "run", station, "--target", rootDir, "--sink", "file"]
      : ["timeout", "-k", "30", "900", "factory", "run", station, "--target", rootDir, "--sink", "file"];

    // Hold per-target exclusive lock covering BOTH factory invocation AND exact report copy into runDir
    const runnerScript = `
      set -uo pipefail
      exec 200>"$1"
      flock -x 200
      shift
      "$@"
      rc=$?
      if [ $rc -eq 0 ] && [ -f "$DEFAULT_REPORT" ]; then
        cp -f "$DEFAULT_REPORT" "$ISOLATED_REPORT"
      fi
      exit $rc
    `;

    const res = spawnSync("bash", ["-c", runnerScript, "_", targetLockPath, ...innerCmd], {
      cwd: rootDir,
      env: {
        ...env,
        VOICEBOX_FACTORY_PRIVATE_DIR: runDir,
        DEFAULT_REPORT: defaultReportPath,
        ISOLATED_REPORT: isolatedReportPath,
      },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    writeFileSync(runLog, `${res.stdout || ""}\n${res.stderr || ""}`, "utf8");
    runExit = res.status ?? 1;
  } catch (e) {
    console.error(`[review-trigger] Station run execution failed: ${sanitizeLogOutput(e.message)}`);
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

  // 5. Verify isolated report provenance, target, and station identity
  const valRes = validateStationReportProvenance(isolatedReportPath, {
    targetName,
    station,
    startTime,
    hashBefore,
    rootDir,
  });

  if (!valRes.ok) {
    console.error(`[review-trigger] Station report provenance check failed: ${valRes.error}`);
    if (existsSync(isolatedReportPath)) {
      rmSync(isolatedReportPath, { force: true });
    }
    return { ok: false, exitCode: 1, error: valRes.error, station };
  }

  const candidateReportName = isolatedReportName;
  const foundReportPath = isolatedReportPath;

  let publishExit = 0;
  let safeSummary = "";

  if (foundReportPath) {
    if (checkoutRepo && checkoutRepo !== repo.toLowerCase()) {
      console.error(`[review-trigger] Refusing publication: checkout origin '${checkoutRepo}' does not match target repo '${repo}'`);
      publishExit = 1;
    } else {
      console.log(`[review-trigger] Calling h1u0 publisher (scripts/factory-triage.mjs --file-issues --include-low) for ${candidateReportName}...`);
      try {
        const triageScript = path.join(rootDir, "scripts", "factory-triage.mjs");
        if (existsSync(triageScript)) {
          const publisherArgs = [
            triageScript,
            "--report", foundReportPath,
            "--repo", repo,
            "--file-issues",
            "--include-low",
          ];

          // Deliberate cross-target validation: If the worktree directory name differs from the repo name
          // (e.g. 'voicebox-miniapps' vs 'voicebox'), but we validated that the worktree's origin remote matches
          // the target repository, pass --allow-foreign-target so the publisher admits the local worktree report.
          const repoName = repo.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
          const targetDirName = path.basename(rootDir).toLowerCase();
          if (checkoutRepo && checkoutRepo === repo.toLowerCase() && targetDirName !== repoName) {
            console.log(`[review-trigger] Worktree '${targetDirName}' verified as checkout of '${repo}'; passing --allow-foreign-target`);
            publisherArgs.push("--allow-foreign-target");
          }

          const pubRes = spawnSync("node", publisherArgs, {
            cwd: rootDir,
            env: { ...env, VOICEBOX_FACTORY_PRIVATE_DIR: runDir },
            encoding: "utf8",
            timeout: 120000,
          });
          publishExit = pubRes.status ?? 1;
          safeSummary = parsePublisherSummary(pubRes.stdout || "");
          console.log(`[review-trigger] Publisher summary:\n${safeSummary || "(no summary emitted)"}`);
          if (pubRes.stderr) console.error(`[review-trigger] Publisher stderr:\n${sanitizeLogOutput(pubRes.stderr)}`);
        } else {
          console.error(`[review-trigger] Error: scripts/factory-triage.mjs is absent; cannot publish delta report.`);
          publishExit = 1;
        }
      } catch (e) {
        console.error(`[review-trigger] Publisher invocation error: ${sanitizeLogOutput(e.message)}`);
        publishExit = 1;
      }
    }
  } else {
    console.error(`[review-trigger] Error: No delta report produced by station '${station}' (execution unconfirmed, failing closed).`);
    publishExit = 1;
  }

  // Distinguish genuine clean/no-action exit 2 from runs with skipped/unverifiable findings
  // Sibling publisher returns 0 when some findings were published even if others were skipped.
  // PASS requires zero skipped and zero failed findings across both exit 0 and exit 2.
  const hasSkippedFindings =
    /skipped:\s*[0-9a-f]{8,64}/i.test(safeSummary) ||
    /,\s*[1-9]\d*\s+skipped/i.test(safeSummary);
  const publishOk = (publishExit === 0 || publishExit === 2) && !hasSkippedFindings;
  const ok = runExit === 0 && publishOk;
  const verdict = ok ? "PASS" : "FAILED";
  const exitCode = ok ? 0 : 1;

  // 6. Record on Bead if requested
  if (beadId) {
    let defNote = "";
    if (deferred.length > 0) {
      const nightlyStations = deferred.filter((d) => NIGHTLY_PROJECT_AUDIT_STATIONS.has(d.station)).map((d) => d.station);
      const unscheduledStations = deferred.filter((d) => !NIGHTLY_PROJECT_AUDIT_STATIONS.has(d.station)).map((d) => d.station);
      const parts = [];
      if (nightlyStations.length > 0) {
        parts.push(`deferred for nightly project-audit: ${nightlyStations.join(", ")}`);
      }
      if (unscheduledStations.length > 0) {
        parts.push(`NOT SCHEDULED NIGHTLY (manual follow-up required): ${unscheduledStations.join(", ")}`);
      }
      defNote = ` (${parts.join("; ")})`;
    }
    const beadMsg = `Factory review: station '${station}', verdict ${verdict}${defNote}, cacheKey ${cacheKey.slice(0, 10)}`;
    try {
      spawnSync("bd", ["comment", beadId, beadMsg], { cwd: rootDir, encoding: "utf8" });
      console.log(`[review-trigger] Recorded review verdict on bead ${beadId}`);
    } catch (e) {
      console.warn(`[review-trigger] Could not comment on bead ${beadId}: ${sanitizeLogOutput(e.message)}`);
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
