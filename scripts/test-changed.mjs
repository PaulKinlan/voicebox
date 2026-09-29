#!/usr/bin/env node
// scripts/test-changed.mjs — fast scoped test execution for inner-loop development (voicebox-beads-p9bf).
//
// Inspects changed files against git HEAD or a base ref, maps them to the tests/*.test.mjs
// files that import or exercise them, and runs only the relevant scoped tests.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../lib/git-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = path.join(ROOT, "tests");

const SOURCE_PREFIXES = ["core/", "lib/", "public/", "tools/", "scripts/", "server.mjs"];
export const isSourceFile = (f) => SOURCE_PREFIXES.some((prefix) => f === prefix || f.startsWith(prefix));

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
export function getIntermediateImporters(changedFile) {
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
    try {
      const serverContent = readFileSync(serverPath, "utf8");
      if (serverContent.includes(baseName) || serverContent.includes(norm) || serverContent.includes(`/${stem}.`)) {
        importers.add("server.mjs");
      }
    } catch {}
  }
  return [...importers];
}

/** Map changed files to the test files that import or exercise them */
export function mapToTests(changedFiles, allTestFiles = null) {
  const tests = allTestFiles ?? readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.mjs"));
  const matched = new Set();
  const fileQueue = new Set(changedFiles);

  for (const f of changedFiles) {
    for (const importer of getIntermediateImporters(f)) {
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

  return [...matched].sort();
}

/** Partition mapped tests into unit, server, and browser lanes using test-lanes authority */
export function partitionTests(matchedTests) {
  const getLane = (lane) => {
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/test-lanes.mjs"), "--lane", lane], {
        cwd: ROOT, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return new Set(out ? out.split(/\s+/).map((f) => path.basename(f)) : []);
    } catch (e) {
      console.error(`[test:changed] failed to query test-lanes.mjs --lane ${lane}: ${e.message}`);
      process.exit(1);
    }
  };

  const unitSet = getLane("unit");
  const serverSet = getLane("server");
  const browserSet = getLane("browser");

  const matchedUnit = [];
  const matchedServer = [];
  const matchedBrowser = [];

  for (const file of matchedTests) {
    if (unitSet.has(file)) matchedUnit.push(file);
    else if (browserSet.has(file)) matchedBrowser.push(file);
    else if (serverSet.has(file)) matchedServer.push(file);
    else matchedUnit.push(file); // fallback to unit
  }

  return { unit: matchedUnit, server: matchedServer, browser: matchedBrowser };
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

export function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const jsonOutput = args.includes("--json");
  const allowUnmapped = args.includes("--allow-unmapped");
  let customBase = null;

  const filesArg = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base" && args[i + 1]) {
      customBase = args[++i];
    } else if (!args[i].startsWith("--")) {
      filesArg.push(args[i]);
    }
  }

  const changedFiles = filesArg.length > 0 ? filesArg : getChangedFiles(customBase);

  if (changedFiles.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ changed: [], tests: [], unmapped: [], lanes: { unit: [], server: [], browser: [] } }));
    } else {
      console.log("[test:changed] No changed files detected against git base.");
    }
    return 0;
  }

  // F1 Guard: Ensure every modified source file maps to at least one test
  const allTests = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.mjs"));
  const unmappedSources = changedFiles.filter((f) => isSourceFile(f) && mapToTests([f], allTests).length === 0);

  if (unmappedSources.length > 0 && !allowUnmapped) {
    console.error("[test:changed] REFUSED: unmapped-source-file");
    console.error("The following changed source file(s) have no mapped tests:");
    for (const f of unmappedSources) console.error(`  · ${f}`);
    console.error("Every changed source file must map to at least one test. Refusing to report green on unverified code.");
    console.error("Remedy: add a test for the changed file, pass --allow-unmapped, or run the full suite (npm test).");
    process.exit(1);
  }

  const relevant = checkStaticRelevance(changedFiles);
  const matchedTests = mapToTests(changedFiles, allTests);
  const partitioned = partitionTests(matchedTests);

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
  process.exit(main());
}
