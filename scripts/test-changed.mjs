#!/usr/bin/env node
// scripts/test-changed.mjs — fast scoped test execution for inner-loop development (voicebox-beads-p9bf).
//
// Inspects changed files against git HEAD or a base ref, maps them to the tests/*.test.mjs
// files that import or exercise them, and runs only the relevant scoped tests.

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../lib/git-env.mjs";
import { classify } from "./test-lanes.mjs";
import { buildQueue, ISOLATED, TIER_WORKERS } from "./test-shards.mjs";
import { sweepStrays } from "./stray-sweep.mjs";
import { artifactDir, createManifest, emitMarker, finalizeManifest, ManifestRefusal, recordFile, sealManifest, tapCounts, testChildEnv, verdictOf, writeManifest } from "./gate-manifest.mjs";
import { isExclusiveRouteChanges, routeAffected, ROUTE_SERVER_SMOKE, isSourcePath } from "./infra-affected.mjs";

export { isExclusiveRouteChanges, routeAffected, ROUTE_SERVER_SMOKE, isSourcePath };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = path.join(ROOT, "tests");

export const isSourceFile = isSourcePath;

const git = (args, options = {}) => {
  try {
    return execFileSync("git", args, { cwd: ROOT, env: gitEnv(), encoding: "utf8", ...options }).trim();
  } catch (e) {
    return "";
  }
};

/** Determine remote base ref (origin/main or origin/master) */
export function getBaseRef(requestedBase = null) {
  if (requestedBase) return requestedBase;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(["rev-parse", "--verify", `${candidate}^{commit}`])) {
      return candidate;
    }
  }
  return "HEAD";
}

/** Get list of changed files from git diff and untracked status */
export function getChangedFiles(baseRef = null) {
  const base = getBaseRef(baseRef);
  const files = new Set();

  // Committed changes against base
  if (base && base !== "HEAD") {
    const diffOut = git(["diff", "--name-only", `${base}...HEAD`]);
    if (diffOut) diffOut.split("\n").map((f) => f.trim()).filter(Boolean).forEach((f) => files.add(f));
  }

  // Staged and unstaged changes against HEAD
  const headDiff = git(["diff", "--name-only", "HEAD"]);
  if (headDiff) headDiff.split("\n").map((f) => f.trim()).filter(Boolean).forEach((f) => files.add(f));

  const cachedDiff = git(["diff", "--cached", "--name-only"]);
  if (cachedDiff) cachedDiff.split("\n").map((f) => f.trim()).filter(Boolean).forEach((f) => files.add(f));

  // Untracked files
  const untracked = git(["status", "--porcelain"]);
  if (untracked) {
    for (const line of untracked.split("\n")) {
      if (line.startsWith("?? ")) {
        const file = line.slice(3).trim();
        if (file && !file.startsWith(".beads/")) files.add(file);
      }
    }
  }

  return [...files].sort();
}

/** Check if static checks are relevant for given changed files */
export function checkStaticRelevance(changedFiles) {
  let singleOwner = false;
  let docsCheck = false;
  let docsTouched = false;

  for (const file of changedFiles) {
    if (file === "lib/state-dirs.mjs" || file === "scripts/single-owner.mjs" || file === "server.mjs" || file === "lib/extensions.mjs" || file === "lib/wasm-shelf.mjs") {
      singleOwner = true;
    }
    if (file.endsWith(".md") || file.startsWith("docs/")) {
      docsCheck = true;
      docsTouched = true;
    }
  }

  return { singleOwner, docsCheck, docsTouched };
}

/** Find internal modules in lib/tools/core/server that import or reference a file */
export function getIntermediateImporters(changedFile, { isRouteScoped = false } = {}) {
  const norm = changedFile.replace(/^\.\//, "");
  const baseName = path.basename(norm);
  const ext = path.extname(norm);
  const stem = path.basename(norm, ext);
  const importers = new Set();

  const scanDirs = ["lib", "tools", "core"];
  for (const dir of scanDirs) {
    const fullDir = path.join(ROOT, dir);
    if (!existsSync(fullDir)) continue;
    try {
      for (const f of readdirSync(fullDir, { recursive: true })) {
        if (!f.endsWith(".mjs") && !f.endsWith(".js") && !f.endsWith(".ts")) continue;
        const relPath = path.join(dir, f);
        if (relPath === norm) continue;
        try {
          const content = readFileSync(path.join(ROOT, relPath), "utf8");
          if (content.includes(baseName) || content.includes(norm) || content.includes(`/${stem}.`) || content.includes(`/${stem}"`) || content.includes(`/${stem}'`)) {
            importers.add(relPath);
          }
        } catch {}
      }
    } catch {}
  }
  const serverPath = path.join(ROOT, "server.mjs");
  if (existsSync(serverPath) && norm !== "server.mjs") {
    // When changes are exclusively route-scoped (voicebox-beads-ybwq),
    // do not add server.mjs as an unbounded transitive importer for route leaves.
    if (!isRouteScoped || !norm.startsWith("lib/routes/")) {
      try {
        const serverContent = readFileSync(serverPath, "utf8");
        if (serverContent.includes(baseName) || serverContent.includes(norm) || serverContent.includes(`/${stem}.`)) {
          importers.add("server.mjs");
        }
      } catch {}
    }
  }
  return [...importers];
}

/**
 * Detailed route-scoping information partitioned into tier buckets for manifest reporting.
 */
export function getRouteScopeDetails({ changedFiles = [], allTestFiles = null } = {}) {
  const allTests = allTestFiles ?? readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.mjs"));
  const fullServerImporters = [];
  for (const tf of allTests) {
    const fullTestPath = path.join(TESTS_DIR, tf);
    if (existsSync(fullTestPath)) {
      try {
        const content = readFileSync(fullTestPath, "utf8");
        if (
          content.includes("server.mjs") ||
          content.includes("tests/lib/server.mjs") ||
          content.includes("createServer")
        ) {
          fullServerImporters.push(tf);
        }
      } catch {}
    }
  }

  const directTests = mapToTests(changedFiles, allTests);
  const baseScope = routeAffected({ changedFiles, allServerImporters: fullServerImporters, directTests });

  let classified;
  try {
    classified = classify();
  } catch {
    classified = { server: [], browser: [], unit: [] };
  }
  const serverSet = new Set((classified.server ?? []).map((e) => e.file));
  const browserSet = new Set((classified.browser ?? []).map((e) => e.file));

  const unrunServer = baseScope.unrunTransitiveImporters.files.filter((f) => serverSet.has(f));
  const unrunBrowser = baseScope.unrunTransitiveImporters.files.filter((f) => browserSet.has(f));

  return {
    ...baseScope,
    unrunTransitiveImporters: {
      server: { files: unrunServer, count: unrunServer.length },
      browser: { files: unrunBrowser, count: unrunBrowser.length },
      total: baseScope.unrunTransitiveImporters.count,
    },
  };
}

/** Map changed files to the test files that import or exercise them */
export function mapToTests(changedFiles, allTestFiles = null) {
  const tests = allTestFiles ?? readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.mjs"));
  const matched = new Set();
  const fileQueue = new Set(changedFiles);
  const isRouteScoped = isExclusiveRouteChanges(changedFiles);

  for (const f of changedFiles) {
    for (const importer of getIntermediateImporters(f, { isRouteScoped })) {
      fileQueue.add(importer);
    }
  }

  for (const changed of fileQueue) {
    const norm = changed.replace(/^\.\//, "");
    const baseName = path.basename(norm);
    const ext = path.extname(norm);
    const stem = path.basename(norm, ext);

    // If the changed file is itself a test file, it maps directly to itself:
    if ((norm.startsWith("tests/") && norm.endsWith(".test.mjs")) || norm.endsWith(".test.mjs")) {
      matched.add(path.basename(norm));
      continue;
    }

    for (const tf of tests) {
      // Stem matching (e.g. lib/commands.mjs -> tests/commands.test.mjs, commands-*.test.mjs)
      if (tf === `${stem}.test.mjs` || tf.startsWith(`${stem}-`) || tf.startsWith(`${stem}.`)) {
        matched.add(tf);
        continue;
      }

      // Check if test source imports or references the changed file/module
      const fullTestPath = path.join(TESTS_DIR, tf);
      if (existsSync(fullTestPath)) {
        try {
          const content = readFileSync(fullTestPath, "utf8");
          if (
            content.includes(baseName) ||
            content.includes(norm) ||
            content.includes(`/${stem}.`) ||
            content.includes(`/${stem}"`) ||
            content.includes(`/${stem}'`) ||
            content.includes(`/${stem}\``)
          ) {
            matched.add(tf);
          }
        } catch {}
      }
    }
  }

  // When a commit touches exclusively routes, add the bounded server smoke subset
  // only if at least one direct test was matched, so a route without any tests is not falsely considered mapped
  if (isRouteScoped && matched.size > 0) {
    for (const smokeFile of ROUTE_SERVER_SMOKE) {
      if (tests.includes(smokeFile)) {
        matched.add(smokeFile);
      }
    }
  }

  return [...matched].sort();
}

/**
 * Partition mapped tests into unit, server, and browser lanes using test-lanes authority.
 *
 * THE OLD ELSE-BRANCH WAS THE FALSE GREEN (voicebox-beads-zjpm.3): an unclassified match was pushed
 * into `unit` and run there, so a file the classifier had never seen - a new test that the lexer could
 * not read, or a match from outside tests/ - was dispatched to a lane chosen by the fallback rather than
 * by what the file launches, and the run reported a green for a lane the classifier does not know exists.
 * It now comes back as `unclassified`, and the GATE refuses it by name; the developer path keeps a loud
 * warning so inner-loop use is not blocked by a classifier gap it cannot fix in that moment.
 */
export function partitionTests(matchedTests, classified = classify()) {
  // IN PROCESS, NOT THREE CHILD PROCESSES. This used to spawn `node scripts/test-lanes.mjs --lane <t>`
  // three times, and each of those lexes all 221 test files to answer: measured on this tree, the three
  // spawns were ~2.9s of the gate's per-invocation overhead (2.18/1.81/1.59s for one file run directly
  // against 5.89/4.73/4.28s through the gate). The AUTHORITY is unchanged — `classify()` from
  // scripts/test-lanes.mjs is still the one owner of which file is in which lane; only the transport is.
  const names = (lane) => new Set((classified[lane] ?? []).map(({ file }) => file));
  const unitSet = names("unit");
  const serverSet = names("server");
  const browserSet = names("browser");

  const matchedUnit = [];
  const matchedServer = [];
  const matchedBrowser = [];
  const unclassified = [];

  for (const file of matchedTests) {
    if (unitSet.has(file)) matchedUnit.push(file);
    else if (browserSet.has(file)) matchedBrowser.push(file);
    else if (serverSet.has(file)) matchedServer.push(file);
    else unclassified.push(file);
  }

  return { unit: matchedUnit, server: matchedServer, browser: matchedBrowser, unclassified };
}

function runStage(label, command, args) {
  console.log(`[test:changed] ${label}: ${command} ${args.join(" ")}`);
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: "inherit", env: process.env });
    return true;
  } catch (e) {
    console.error(`[test:changed] ${label} FAILED (exit ${e.status ?? 1})`);
    process.exit(e.status ?? 1);
  }
}

// ════════════════ THE GATE MODE (voicebox-beads-zjpm.3) ════════════════
//
// `--gate` is the same selection as the developer path with three differences that matter, and each is
// the reason the fast verdict is quotable at all:
//   1. STRICT: an unclassified test file and an unmapped changed source are REFUSED, by name. There is no
//      `--allow-unmapped` in the gate — a gate that may be told to ignore a path it cannot map has no
//      scope, and its PASS is a statement about nothing.
//   2. PER-FILE DISPATCH: every selected file runs in its own process, so the artifact records that
//      file's own exit, TAP counts, and duration. One `node --test a b c` gives a single aggregate and
//      cannot answer "which file is this PASS about".
//   3. RECORDED: the run writes scripts/gate-manifest.mjs's artifact and emits the `fast-gate:` markers
//      the hub's coverage extractor reads, so the log and the artifact say the same thing.

/** The gate artifact directory — the owner is scripts/gate-manifest.mjs, which the aggregate writes to too. */
export { artifactDir };

/**
 * The per-file children a gate has IN FLIGHT. A child leads its own process group (below) so that a
 * per-file timeout takes down the browser or server it started with it — which means nothing else kills it
 * when the GATE is signalled. `killRunningChildren` is how a caller (scripts/gate-tier.mjs, which runs each
 * tier under the pre-push gate's bounded `timeout`) takes them with it instead of orphaning them for the
 * reaper. The fast gate does not install a handler; its outer queue (`fleet-gate`) owns the process group.
 */
const RUNNING_CHILDREN = new Set();

export function killRunningChildren(signal = "SIGTERM") {
  for (const child of RUNNING_CHILDREN) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Run ONE test file in its own process and report what it actually said. The child leads its own process
 * group so a timeout can take down the browser or server it started with it — a SIGKILL to the file alone
 * would orphan every Chromium it launched, which is the reaper's problem instead of ours.
 */
export function runOneFile(file, { timeoutMs = 240_000, cwd = ROOT, spawnChild = spawn } = {}) {
  return new Promise((resolve) => {
    const at = Date.now();
    // THE CHILD IS A TOP-LEVEL TEST RUN, NOT A NESTED ONE — `testChildEnv` owns that fact and why
    // (scripts/gate-manifest.mjs): without it the child is SKIPPED and exits 0 with no summary at all.
    const child = spawnChild(process.execPath, ["--test", "--test-reporter=tap", file], {
      cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: testChildEnv(),
    });
    RUNNING_CHILDREN.add(child);
    let out = "";
    const eat = (chunk) => {
      out += String(chunk);
    };
    child.stdout.on("data", eat);
    child.stderr.on("data", eat);
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    let settled = false;
    const settle = (code, signal, note = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      RUNNING_CHILDREN.delete(child);
      resolve({ file, code, signal, timedOut, counts: tapCounts(out), secs: (Date.now() - at) / 1000, out: note + out });
    };
    // 'exit' can precede the final stdout 'data' chunk; the TAP summary is not complete until 'close'
    // confirms both pipes have drained. A truly silent child still has no counts and remains UNKNOWN.
    child.on("close", (code, signal) => settle(code, signal));
    child.on("error", (error) => settle(null, null, `the file could not be spawned: ${error.message}\n`));
  });
}

/**
 * A finished child's terminal status. `unknown` is NOT a synonym for failure and it is not a pass: it is
 * "this child never told us how it ended" — a kill, a crash before the reporter's summary, an exit 0 with
 * no summary at all. The gate refuses on it, and the log says `fast-gate: unknown:` so the hub's coverage
 * extraction degrades to UNKNOWN rather than counting the file as covered.
 */
export function statusOf(result) {
  const reported = result.counts.tests >= 0;
  if (result.timedOut) return "timeout";
  if (result.code === 0 && reported) return "passed";
  if (result.code !== 0 && reported) return "failed";
  return "unknown";
}

/**
 * One run of the gate: select nothing, dispatch what was selected, account for the rest, write the
 * artifact, and answer with an exit code. Returns `{ code, manifest }` so a test can drive the whole
 * thing in-process rather than by parsing this script's stdout.
 */
export async function runGate({
  changedFiles = [],
  matchedTests = [],
  partitioned = { unit: [], server: [], browser: [], unclassified: [] },
  unmappedSources = [],
  base = "",
  gate = "fast",
  dir = null,
  workers = process.env.VOICEBOX_FAST_WORKERS ? Number(process.env.VOICEBOX_FAST_WORKERS) : null,
  timeoutMs = Number(process.env.VOICEBOX_FAST_FILE_SECS ?? 240) * 1000,
  dryRun = false,
  classified = classify(),
  tree = null,
  sha = "",
  treeDirty = null,
  runner = runOneFile,
  // A KILLED GATE LEAVES FIXTURES BEHIND (voicebox-beads-9xqs): the per-file child leads its own group so a per-file
  // timeout can take a wedged file with it, and the fixtures inside lead groups of their own — so when THIS process is
  // SIGKILLed nothing can reach them, and a `server.mjs` keeps a port for hours (the reaper found one 121 minutes old).
  // A finished run sweeps the fixtures it started in this worktree. Off inside a test process (a gate-under-test runs
  // beside sibling files whose fixtures share this worktree) unless the caller asks for it explicitly.
  sweep = !process.env.NODE_TEST_CONTEXT,
  // The worktree the sweep is scoped to. A test drives its own scratch directory so it can never sweep a sibling file's
  // fixture: attribution is by cwd, so a directory nobody else runs in is a directory with only this run's fixtures.
  sweepRoot = ROOT,
} = {}) {
  const startedAt = Date.now();
  const sweepNow = () => {
    if (!sweep) return [];
    try {
      return sweepStrays({ root: sweepRoot, since: startedAt }).killed;
    } catch {
      return []; // a sweep must never turn a run's verdict into a crash
    }
  };
  /**
   * The previous run's leak: a gate SIGKILLed at its bound (`timeout --kill-after`, rc 137) runs no handler at all, so
   * no process of ours can clean it up — the leak is only reachable by the NEXT run in the same worktree. That is what
   * this is for, and why it is bounded by the same four hours the fleet-wide janitor uses: anything older is
   * `scripts/reap-stale-servers.mjs`'s subject, anything newer could be the run before this one, and a server a person
   * wants kept carries `VOICEBOX_PINNED=1` or the worktree's `.pinned-server` marker (honoured in stray-sweep.mjs).
   */
  const SWEEP_PREVIOUS_SECS = Number(process.env.VOICEBOX_STRAY_PREVIOUS_SECS ?? 4 * 3600);
  const sweepPrevious = () => {
    if (!sweep || !(SWEEP_PREVIOUS_SECS > 0)) return [];
    try {
      // A WINDOW, not a permission: `until: startedAt` cannot touch a fixture this run starts, and `since` carries the
      // four-hour bound. Filtering after the kill would be too late — the sweep kills what it finds.
      return sweepStrays({ root: sweepRoot, since: startedAt - SWEEP_PREVIOUS_SECS * 1000, until: startedAt }).killed;
    } catch {
      return [];
    }
  };
  const onSignal = (signal) => {
    killRunningChildren(signal);
    sweepNow();
    setTimeout(() => process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 0)), 2500).unref();
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  const handlers = new Map(signals.map((signal) => [signal, () => onSignal(signal)]));
  for (const [signal, handler] of handlers) process.once(signal, handler);
  // A KILLED RUN'S FIXTURES ARE UNREACHABLE FROM INSIDE IT, so the run that follows is the only cleaner they get.
  sweepPrevious();
  try {
  const manifest = createManifest({ gate, tree, sha, classified, changed: changedFiles, base, treeDirty: treeDirty, unmapped: [...unmappedSources] });
  const selection = (name) => (changedFiles.includes(`tests/${name}`) ? "changed" : "dependency");
  const ordered = [
    ...partitioned.unit.map((f) => ["unit", f]),
    ...partitioned.server.map((f) => ["server", f]),
    ...partitioned.browser.map((f) => ["browser", f]),
  ].filter(([, f]) => !partitioned.unclassified.includes(f));

  const selected = new Set(ordered.map(([, f]) => f));
  // The selection REASON is a per-file claim and only the changed-path map can make it: `changed` means the
  // test file itself changed, `dependency` means a changed source maps to it, and a file the map did not
  // pick is `not-selected`. Without this, an omitted file inherited the aggregator's `changed` default, so a
  // gate over 9 changed paths published 223 files as directly changed (voicebox-beads-zjpm.3).
  const selectionOf = (entry) => (selected.has(path.basename(entry.path)) ? selection(path.basename(entry.path)) : "not-selected");
  const problems = [];
  if (partitioned.unclassified.length > 0) {
    problems.push(...partitioned.unclassified.map((f) => `${f} is mapped by a change but is in NO lane (unclassified)`));
  }
  if (unmappedSources.length > 0) {
    problems.push(...unmappedSources.map((f) => `${f} changed and maps to no test file (unmapped source)`));
  }

  if (problems.length > 0) {
    console.error("[test:changed] REFUSED: " + problems.join("; "));
    for (const p of problems) console.error(`  · ${p}`);
    console.error("[test:changed] The gate does not have an --allow-unmapped escape: a PASS measured over an");
    console.error("[test:changed] unknown scope is a statement about nothing. Add the test (or the lane), or run the full suite.");
    console.log(emitMarker("unmapped", [...unmappedSources, ...partitioned.unclassified]));
    console.log(emitMarker("unknown", ["the gate refused before dispatching: " + problems.length + " mapped path(s) with no lane or no test"]));
  }

  if (dryRun || problems.length > 0) {
    // Nothing ran, so every classified file is omitted with the reason that is true of it.
    const reason = problems.length > 0 ? "refused: unmapped or unclassified changed path" : "dry-run: nothing dispatched";
    for (const entry of manifest.classifier.files) recordFile(manifest, { path: entry.path, dispatch: "omitted", reason, selection: selectionOf(entry) });
    manifest.verdict = problems.length > 0 ? "refused" : dryRun ? "dry-run" : "pass";
    sealManifest(manifest);
    const written = writeManifest(manifest, artifactDir(dir));
    console.log(`[test:changed] manifest: ${written}`);
    return { code: problems.length > 0 ? 1 : 0, manifest, written };
  }

  // Static checks first — they are one `git diff` and they decide whether the dispatched tests are even
  // the question. A failure here is `unknown` for coverage, never a silent narrowing to "no suites".
  const relevant = checkStaticRelevance(changedFiles);
  for (const [label, script] of [
    ["single-owner", "scripts/single-owner.mjs"],
    ["docs-check", "scripts/docs-check.mjs"],
    ["docs-touched", "scripts/docs-touched.mjs"],
  ]) {
    const needed = (label === "single-owner" && relevant.singleOwner) || (label !== "single-owner" && (relevant.docsCheck || relevant.docsTouched));
    if (!needed || !existsSync(path.join(ROOT, script))) continue;
    const rc = runStageOnly(script);
    if (rc !== 0) {
      for (const entry of manifest.classifier.files) {
        recordFile(manifest, { path: entry.path, dispatch: "omitted", reason: `not dispatched: the ${label} stage failed (exit ${rc})`, selection: selectionOf(entry) });
      }
      console.log(emitMarker("unknown", [`the ${label} stage failed before any test was dispatched`]));
      manifest.verdict = "fail";
      manifest.static_failure = { stage: label, exit: rc };
      sealManifest(manifest);
      const written = writeManifest(manifest, artifactDir(dir));
      console.log(`[test:changed] manifest: ${written}`);
      return { code: rc, manifest, written };
    }
  }

  const results = [];
  let cursor = 0;
  const runTierFiles = async (tier, files) => {
    const run = async (file) => {
      const relPath = `tests/${file}`;
      // NOT `fast-gate: running:` — the hub's extractor reads that marker as proof the suite EXECUTED, so a
      // run that is killed before this file finishes would leave a coverage claim it cannot retract (see
      // the note in scripts/gate-manifest.mjs; measured: a killed 19-file run reported coverage KNOWN over
      // a file that was only ever printed as running). Progress is a plain line; only terminal states are
      // published as markers.
      console.log(`[test:changed] running ${relPath}`);
      const result = await runner(relPath, { timeoutMs });
      const status = statusOf(result);
      results.push({ file, status, result });
      if (status === "passed") console.log(emitMarker("passed", [relPath]));
      else if (status === "failed") console.log(emitMarker("failed", [relPath]));
      else console.log(emitMarker("unknown", [`${relPath} (${status}${result.timedOut ? ` after ${timeoutMs}ms` : ", no summary reported"})`]));
      console.log(
        `[test:changed] ${status.toUpperCase().padEnd(7)} ${String(Math.round(result.secs * 1000)).padStart(7)}ms ` +
          `tests=${result.counts.tests} pass=${result.counts.pass} fail=${result.counts.fail} skipped=${result.counts.skipped} ${relPath}`,
      );
      if (status !== "passed") {
        const tail = result.out.split("\n").slice(-40).join("\n");
        console.log(`[test:changed] ---- output of ${relPath} ----\n${tail}\n[test:changed] ---- end ${relPath} ----`);
      }
      recordFile(manifest, {
        path: relPath,
        dispatch: "ran",
        status,
        counts: result.counts.tests >= 0 ? result.counts : null,
        timeout_ms: timeoutMs,
        secs: result.secs,
        selection: selection(file),
      });
    };
    // The files that measure the box run alone, on an otherwise idle gate — the same partition the
    // browser tier uses (scripts/test-shards.mjs owns ISOLATED), reused rather than re-derived.
    const alone = files.filter((f) => ISOLATED.has(`tests/${f}`));
    // THE PARALLEL POOL IS THE TIER'S OWN QUEUE, ORDERED HEAVIEST-FIRST BY ITS ONE OWNER. `buildQueue`
    // (scripts/test-shards.mjs) is the queue `tools/browser-shard-runner.mjs` already runs the browser tier
    // from, so this is the same order, not a second opinion about it. The order is a TIE-BREAK for
    // work-stealing, not a schedule: it selects and omits nothing, it decides which file is in flight when
    // the queue empties, and the tail is the only part work-stealing cannot fix. Measured on the fast
    // gate's 159-file fused.js scope (2026-10-14, voicebox-beads-buy8): the server tier's 32.4s
    // `env-serve.test.mjs` was fifth in the alphabetical queue, and replaying the exact recorded per-file
    // durations in this order takes the modeled tier-serial total from 207.4s to 181.7s — against 179.2s
    // for a longest-first ideal, which is what "the order is nearly free and the tail is not" means here.
    const parallel = buildQueue(
      files.filter((f) => !ISOLATED.has(`tests/${f}`)).map((f) => `tests/${f}`),
      { cwd: ROOT },
    ).map((p) => p.replace(/^tests\//, ""));
    // THE CONCURRENCY IS THE TIER'S OWN — `TIER_WORKERS`, the one owner both dispatchers read — and
    // VOICEBOX_FAST_WORKERS overrides it for a loaded box. The old default here was 2, a number no tier
    // runs at: measured on the same 159-file scope, that cost 273s of wall clock where the tier's own
    // concurrency costs 190s (voicebox-beads-buy8).
    const concurrency = Math.max(1, workers ?? TIER_WORKERS[tier] ?? 1);
    cursor = 0;
    const workerLoop = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= parallel.length) return;
        await run(parallel[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, parallel.length) }, () => workerLoop()));
    for (const file of alone) await run(file);
  };

  for (const tier of ["unit", "server", "browser"]) {
    const files = ordered.filter(([t]) => t === tier).map(([, f]) => f);
    if (files.length > 0) await runTierFiles(tier, files);
  }

  // Every classified file that was not selected is OMITTED BY NAME WITH ITS REASON. This is the
  // reconciliation the artifact is for: a fast gate's scope is a decision, and an unexplained gap is
  // what lets a narrow run be quoted as a wide one.
  const routeScope = getRouteScopeDetails({ changedFiles });
  if (routeScope.applies) {
    manifest.route_scoping = {
      routes: routeScope.routes,
      smoke_tests: routeScope.smoke,
      bypassed_server_importers: routeScope.unrunTransitiveImporters.total,
    };
  }

  const getOmittedReason = (entry) => {
    if (gate === "full") return "not selected: the full roster should have been dispatched";
    const file = path.basename(entry.path);
    if (routeScope.applies && routeScope.unrunTransitiveImporters.total > 0) {
      if (
        routeScope.unrunTransitiveImporters.server.files.includes(file) ||
        routeScope.unrunTransitiveImporters.browser.files.includes(file)
      ) {
        return `fast-only: route-scoped change (${routeScope.routes.join(", ")}) bypassed transitive server importer (server boot verified by ${routeScope.smoke.join(", ")})`;
      }
    }
    return "fast-only: not selected by the changed-path map";
  };

  for (const entry of manifest.classifier.files) {
    if (!selected.has(path.basename(entry.path))) {
      recordFile(manifest, {
        path: entry.path,
        dispatch: "omitted",
        reason: getOmittedReason(entry),
        selection: gate === "full" ? "full-roster" : selectionOf(entry),
      });
    }
  }

  const bad = results.filter((r) => r.status !== "passed");
  manifest.unmapped = [...unmappedSources];
  try {
    // Sealed first, verdict second: `verdictOf` answers from `reconciled` and `summary`, which only exist
    // once the manifest is closed. It carries the rule in ONE place — zero dispatched is `empty` and never
    // `pass`; timeout and unknown are not a pass either (voicebox-beads-zjpm.3).
    finalizeManifest(manifest);
    manifest.verdict = verdictOf(manifest);
  } catch (e) {
    if (!(e instanceof ManifestRefusal)) throw e;
    console.error("[test:changed] REFUSED: the gate manifest does not reconcile:");
    for (const p of e.problems ?? []) console.error(`  · ${p}`);
    console.log(emitMarker("unknown", [`the gate manifest does not reconcile: ${(e.problems ?? []).join("; ")}`]));
    manifest.verdict = "refused";
    const written = writeManifest(manifest, artifactDir(dir));
    console.log(`[test:changed] manifest: ${written}`);
    return { code: 1, manifest, written };
  }

  const written = writeManifest(manifest, artifactDir(dir));
  const s = manifest.summary;
  console.log(
    `[test:changed] manifest ${written} — tree ${tree ? tree.slice(0, 12) : "?"} roster ${manifest.classifier.roster.slice(0, 12)}: ` +
      `classified ${s.classified}, dispatched ${s.dispatched}, omitted ${s.omitted}, passed ${s.passed}, failed ${s.failed}`,
  );
  if (s.dispatched === 0) {
    console.log("[test:changed] EMPTY: 0 test files were dispatched — this run measured nothing (every file is omitted by name above).");
    console.log("[test:changed] EMPTY is not a PASS: a change with no mapped test, or no change at all, has demonstrated nothing about the tree.");
  }
  if (bad.length === 0 && results.length > 0) console.log("[test:changed] ALL SCOPED TESTS GREEN (every dispatched file has a terminal status).");
  return { code: bad.length > 0 ? 1 : 0, manifest, written };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    sweepNow();
  }
}

/** Run one static-stage script and return its exit code (used by the gate, which owns the verdict). */
function runStageOnly(script) {
  console.log(`[test:changed] ${script}`);
  try {
    execFileSync(process.execPath, [script], { cwd: ROOT, stdio: "inherit", env: process.env });
    return 0;
  } catch (e) {
    console.error(`[test:changed] ${script} FAILED (exit ${e.status ?? 1})`);
    return e.status ?? 1;
  }
}

/** The tree and sha the manifest is keyed by: what the gate actually measured, never the branch tip. */
export function measuredTree() {
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const sha = git(["rev-parse", "--short", "HEAD"]);
  // The tree SHA names the COMMITTED tree. A dirty worktree is still measured under that label, so the
  // dirt is recorded rather than hidden: a reader must be able to see that this artifact was produced
  // over uncommitted bytes (fleet-check refuses a dirty worktree for exactly this reason).
  const dirty = git(["status", "--porcelain"]) !== "";
  return { tree: tree || null, sha: sha || "", dirty };
}

export async function main() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let jsonOutput = false;
  let gateMode = false;
  let allowUnmapped = false;
  let help = false;
  let customBase = null;
  let manifestDir = null;
  let gateKind = "fast";
  let gateKindSupplied = false;
  let positionalOnly = false;

  const filesArg = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positionalOnly) { filesArg.push(arg); continue; }
    if (arg === "--") { positionalOnly = true; continue; }
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--json") { jsonOutput = true; continue; }
    if (arg === "--gate") { gateMode = true; continue; }
    if (arg === "--allow-unmapped") { allowUnmapped = true; continue; }
    if (["--base", "--manifest-dir", "--gate-kind"].includes(arg)) {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(`[test:changed] REFUSED: missing-option-value ${arg}`);
        return 2;
      }
      i++;
      if (arg === "--base") customBase = value;
      else if (arg === "--manifest-dir") manifestDir = value;
      else { gateKind = value; gateKindSupplied = true; }
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`[test:changed] REFUSED: unknown-option ${arg}`);
      return 2;
    }
    filesArg.push(arg);
  }

  // Help is intentionally before even a git/base query, roster read, manifest write, or test spawn.
  // Unknown/malformed flags above still fail closed even alongside --help.
  if (help) {
    console.log("Usage: node scripts/test-changed.mjs [options] [changed-file ...]");
    console.log("  --dry-run                 Select without dispatching tests");
    console.log("  --json                    Print the developer-mode selection as JSON");
    console.log("  --allow-unmapped          Developer-only escape for unmapped paths");
    console.log("  --base <ref>              Compare against a specific git base");
    console.log("  --gate                    Emit a reconciled fast-gate manifest");
    console.log("  --gate-kind <fast|full>   Gate coverage policy (requires --gate)");
    console.log("  --manifest-dir <path>     Gate artifact directory (requires --gate)");
    console.log("  --help, -h                Show this help without running tests");
    console.log("  --                        Treat remaining arguments as changed-file paths");
    return 0;
  }
  if (!gateMode && (gateKindSupplied || manifestDir !== null)) {
    console.error("[test:changed] REFUSED: --gate-kind and --manifest-dir require --gate");
    return 2;
  }
  if (gateMode && jsonOutput) {
    console.error("[test:changed] REFUSED: --json is developer-only; --gate emits a manifest, not JSON selection");
    return 2;
  }

  // THE GATE HAS NO ALLOW-UNMAPPED ESCAPE (voicebox-beads-zjpm.3). The developer flag exists so an
  // inner-loop run is not blocked by a mapping gap; a GATE that accepts it has declared its own scope
  // unbounded and its PASS untestable. This is refused before any selection is even computed.
  if (gateMode && allowUnmapped) {
    console.error("[test:changed] REFUSED: --allow-unmapped is a developer escape and is not available to the gate");
    console.error("[test:changed]   the gate's PASS must be a statement about a scope it can name and reconcile.");
    return 2;
  }
  if (gateMode && !["fast", "full"].includes(gateKind)) {
    console.error(`[test:changed] REFUSED: --gate-kind must be fast or full (got '${gateKind}')`);
    return 2;
  }

  const changedFiles = filesArg.length > 0 ? filesArg : getChangedFiles(customBase);
  const allTests = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.mjs"));
  const unmappedSources = changedFiles.filter((f) => isSourceFile(f) && mapToTests([f], allTests).length === 0);

  if (gateMode) {
    const matchedTests = mapToTests(changedFiles, allTests);
    // ONE classification for the whole gate: the plan, the partition and the manifest's roster are the
    // same pass, so a file cannot be partitioned by one reading and recorded by another.
    const classified = classify();
    const partitioned = partitionTests(matchedTests, classified);
    const { tree, sha, dirty } = measuredTree();
    if (!tree) {
      console.error("[test:changed] REFUSED: the gate needs the tree SHA it is measuring (not in a git worktree?)");
      return 2;
    }
    console.log(`[test:changed] gate=${gateKind} tree=${tree.slice(0, 12)}${dirty ? " (DIRTY worktree)" : ""} changed=${changedFiles.length} selected=${matchedTests.length}`);
    if (dirty) console.error("[test:changed] WARNING: the worktree is dirty — the artifact is labelled with HEAD's tree and records tree_dirty: true.");
    const { code } = await runGate({
      changedFiles, matchedTests, partitioned, unmappedSources, base: getBaseRef(customBase),
      gate: gateKind, dir: manifestDir, dryRun, tree, sha, treeDirty: dirty, classified,
    });
    return code;
  }

  if (changedFiles.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ changed: [], tests: [], unmapped: [], lanes: { unit: [], server: [], browser: [] } }));
    } else {
      console.log("[test:changed] No changed files detected against git base.");
    }
    return 0;
  }

  if (unmappedSources.length > 0 && !allowUnmapped) {
    console.error("[test:changed] REFUSED: unmapped-source-file");
    console.error("The following changed source file(s) have no mapped tests:");
    for (const f of unmappedSources) console.error(`  · ${f}`);
    console.error("Every changed source file must map to at least one test. Refusing to report green on unverified code.");
    console.error("Remedy: add a test for the changed file, pass --allow-unmapped, or run the full suite (npm test).");
    return 1;
  }

  const relevant = checkStaticRelevance(changedFiles);
  const matchedTests = mapToTests(changedFiles, allTests);
  const partitioned = partitionTests(matchedTests);

  if (partitioned.unclassified.length > 0) {
    console.error(`[test:changed] WARNING: ${partitioned.unclassified.length} mapped test file(s) are in NO lane (a classifier gap): ${partitioned.unclassified.join(", ")}`);
    console.error("[test:changed] WARNING: running them in the unit lane for this inner-loop run; the GATE refuses them (--gate).");
    partitioned.unit.push(...partitioned.unclassified);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      changed: changedFiles,
      unmapped: unmappedSources,
      tests: matchedTests,
      static: relevant,
      lanes: partitioned,
    }, null, 2));
    return 0;
  }

  console.log(`[test:changed] Detected ${changedFiles.length} changed file(s):`);
  for (const f of changedFiles) console.log(`  · ${f}`);

  console.log(`[test:changed] Mapped to ${matchedTests.length} test file(s) across lanes:`);
  console.log(`  · unit (${partitioned.unit.length}): ${partitioned.unit.join(", ") || "(none)"}`);
  console.log(`  · server live (${partitioned.server.length}): ${partitioned.server.join(", ") || "(none)"}`);
  console.log(`  · browser live (${partitioned.browser.length}): ${partitioned.browser.join(", ") || "(none)"}`);

  if (dryRun) {
    console.log("[test:changed] --dry-run: skipping test execution.");
    return 0;
  }

  // 1. Static Checks
  if (relevant.singleOwner && existsSync(path.join(ROOT, "scripts/single-owner.mjs"))) {
    runStage("single-owner", process.execPath, ["scripts/single-owner.mjs"]);
  }
  if (relevant.docsCheck && existsSync(path.join(ROOT, "scripts/docs-check.mjs"))) {
    runStage("docs-check", process.execPath, ["scripts/docs-check.mjs"]);
  }
  if (relevant.docsTouched && existsSync(path.join(ROOT, "scripts/docs-touched.mjs"))) {
    runStage("docs-touched", process.execPath, ["scripts/docs-touched.mjs"]);
  }

  // 2. Unit Tests (concurrent)
  if (partitioned.unit.length > 0) {
    runStage("unit", process.execPath, ["--test", ...partitioned.unit.map((f) => `tests/${f}`)]);
  }

  // 3. Server Tests (concurrency 4)
  if (partitioned.server.length > 0) {
    runStage("server", process.execPath, ["--test", "--test-concurrency=4", ...partitioned.server.map((f) => `tests/${f}`)]);
  }

  // 4. Browser Tests (serial concurrency 1)
  if (partitioned.browser.length > 0) {
    runStage("browser", process.execPath, ["--test", "--test-concurrency=1", ...partitioned.browser.map((f) => `tests/${f}`)]);
  }

  console.log("[test:changed] ALL SCOPED TESTS GREEN.");
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("test-changed.mjs")) {
  process.exit(await main());
}
