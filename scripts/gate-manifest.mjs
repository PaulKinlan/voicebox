#!/usr/bin/env node
// scripts/gate-manifest.mjs — the gate's coverage record: what was CLASSIFIED, what was DISPATCHED,
// what was not, and why, as one artifact a later reader can check without re-running anything.
//
// WHY THIS EXISTS (voicebox-beads-zjpm.3, ADR voicebox-beads-zjpm.1). A gate's log is evidence only
// while somebody is reading it, and the failure it invites is silent NARROWING: a fast gate that runs
// 3 of 221 classified files, finishes in 56s, exits 0, and is then quoted as "PASS" for a tree nobody
// tested. Measured on this VM: a cached fast verdict said PASS in 56s while its own coverage field said
// UNKNOWN, and a full gate could say PASS while the acceptance phase had never reached the shared
// front. Both are the same defect — a verdict that does not say what it measured.
//
// So the roster is recorded, decided, and RECONCILED, and the reconciliation is the gate:
//
//   * EVERY classified file is accounted for — dispatched once, or omitted BY NAME WITH A REASON.
//     A file that is classified but neither is MISSING; a file that was dispatched but is not in the
//     roster is UNCLASSIFIED; a file named twice is a DUPLICATE. Each is a refusal, not a note.
//   * A dispatched file needs a TERMINAL status and a duration. A child whose exit was lost is not a
//     pass — it is the "looks finished because nobody looked" case.
//   * A file that reports PASSED with ZERO tests is refused. A harness that selected nothing has not
//     demonstrated anything, and an empty run is the cheapest way to look green.
//   * The roster identity is a HASH of the classifier's own output (file, tier and the reason it was
//     put there), so a manifest can only be compared to a tree whose roster hash matches. A classifier
//     that moves a file between tiers changes the hash; a manifest that does not is stale by construction.
//
// THE MARKER VOCABULARY IS NOT OURS. `fleet-check` reads the gate log with the hub's
// `remote/check-coverage.py`, which recognises lines that ARE, at line start, one of
//     fast-gate: running|ran|passed|completed|failed: <paths>
//     fast-gate: unmapped: <paths>
//     fast-gate: unknown: <reason>
// `emitMarker` produces exactly those shapes and nothing else, because a marker that is nearly right is
// read as no marker at all and the coverage silently degrades to UNKNOWN.
//
// A NOTE ON `running`, MEASURED AGAINST THE HUB'S OWN EXTRACTOR (voicebox-beads-zjpm.3): check-coverage.py
// unions EVERY marker it matches — `running` included — into the set of suites it believes executed. So a
// `running:` line for a file that never finished is read as COVERAGE. Measured on a real killed run (a
// 19-file selection stopped at file 19): the extractor answered `coverage: KNOWN, indeterminate: false`
// and listed `tests/pre-push.test.mjs` — a file that had been printed as running and then SIGTERMed — so
// the hub reported every changed path as demonstrated. A process that can be killed cannot retract a line
// it has already written, so the gate DOES NOT PUBLISH `running:` at all: it prints its progress in a
// plain line and only ever publishes TERMINAL per-file markers (passed/failed/unknown) plus `unmapped:`
// and `unknown:` for a refusal or an incomplete dispatch. `emitMarker` still supports `running` because the
// vocabulary belongs to the hub, and a caller whose runs cannot be killed may use it; this gate's runs can.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_VERSION = 1;
export const TIERS = Object.freeze(["unit", "server", "browser"]);
export const GATES = Object.freeze(["fast", "full"]);
/**
 * How a file came to be selected: the changed-path map, a transitive dependency, the whole roster, or
 * nothing at all (a fast gate omits the files its changed-path map did not pick). `not-selected` exists so
 * that the omitted case has an honest value: `recordFile` used to default an absent reason to `changed`, so a
 * fast gate over 9 changed paths recorded all 223 classified files as directly changed — a scope claim the
 * manifest's own `changed` list contradicted (voicebox-beads-zjpm.3).
 */
export const SELECTION = Object.freeze(["changed", "dependency", "full-roster", "not-selected"]);
export const DISPATCH = Object.freeze(["ran", "omitted", "skipped"]);
/** Terminal states of a dispatch. `unknown` is the honest answer when a child was lost or timed out. */
export const STATUS = Object.freeze(["passed", "failed", "skipped", "timeout", "unknown"]);

/**
 * The environment a gate child process runs in. ONE owner for this fact, because both runners
 * (scripts/test-changed.mjs's per-file gate and tools/browser-shard-runner.mjs) must agree on it: Node
 * marks a spawned `--test` run as NESTED through NODE_TEST_CONTEXT, and a nested run whose parent is a
 * `node:test` file is SKIPPED outright — "node:test run() is being called recursively within a test file.
 * skipping running files." The child then exits 0 with no TAP summary at all, which every honest reader in
 * this tree classifies as `unknown`, and the runner that spawned it reports a FAILURE for a file that was
 * never run. Measured while testing this gate (voicebox-beads-zjpm.3): the shard runner failed a file for
 * "no test counts were reported" when driven from inside a test file.
 */
export function testChildEnv(base = process.env) {
  const env = { ...base };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** The marker prefix the hub's check-coverage.py matches at line start. Not a local style choice. */
export const MARKER_PREFIX = "fast-gate:";

/** The tree this run measured, from git — the aggregate CLI's default label. */
export function gitTree(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export class ManifestRefusal extends Error {
  constructor(problems) {
    super(`gate manifest refused: ${problems.join("; ")}`);
    this.name = "ManifestRefusal";
    this.problems = problems;
  }
}

/** The classifier's output, normalised to one roster entry per file. Throws if a file is in two lanes. */
export function rosterOf(classified) {
  const entries = [];
  const seen = new Map();
  for (const tier of TIERS) {
    for (const { file, why = null } of classified?.[tier] ?? []) {
      if (seen.has(file)) {
        throw new ManifestRefusal([`${file} is classified in both '${seen.get(file)}' and '${tier}'`]);
      }
      seen.set(file, tier);
      entries.push({ path: `tests/${file}`, tier, why });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path) || a.tier.localeCompare(b.tier));
}

/**
 * The roster's identity: a hash over file, tier AND reason, so two classifiers that disagree about why a
 * file is live are two different classifiers. Reasons are included deliberately — a file moved between
 * the browser and server lanes changes what may run beside it, which is a different gate even when the
 * file list is identical.
 */
export function rosterHash(roster) {
  const canonical = roster.map(({ path: p, tier, why }) => `${tier}\t${p}\t${why ?? ""}`).join("\n");
  return createHash("sha256").update(`gate-manifest/roster/v${MANIFEST_VERSION}\n${canonical}`).digest("hex");
}

export function rosterCounts(roster) {
  const counts = { unit: 0, server: 0, browser: 0, total: roster.length };
  for (const { tier } of roster) counts[tier] += 1;
  return counts;
}

/** A fresh manifest for one gate run on one tree. `files` is filled by `recordFile`. */
export function createManifest({ gate, tree, sha = "", classified, changed = [], unmapped = [], base = "", treeDirty = null, startedAt = new Date().toISOString() }) {
  if (!GATES.includes(gate)) throw new ManifestRefusal([`unknown gate kind '${gate}' (want ${GATES.join("|")})`]);
  if (!tree) throw new ManifestRefusal(["a manifest needs the tree SHA it describes"]);
  const roster = rosterOf(classified);
  return {
    version: MANIFEST_VERSION,
    gate,
    tree,
    sha,
    started_at: startedAt,
    finished_at: null,
    secs: null,
    base,
    tree_dirty: treeDirty,
    classifier: { roster: rosterHash(roster), files: roster, counts: rosterCounts(roster) },
    changed: [...changed],
    unmapped: [...unmapped],
    files: [],
    summary: null,
    reconciled: false,
    problems: [],
  };
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * Record one file's fate. Refuses, by name, a file that is not in the roster, a duplicate, a tier that
 * disagrees with the classifier, or a dispatched file with no terminal status — the four shapes that
 * make a manifest look complete while saying nothing.
 */
export function recordFile(manifest, entry) {
  const roster = new Map(manifest.classifier.files.map((r) => [r.path, r]));
  const { path: file } = entry ?? {};
  if (!file) throw new ManifestRefusal(["a file record needs a path"]);
  const known = roster.get(file);
  if (!known) throw new ManifestRefusal([`${file} is not in this classifier's roster — an unclassified path is not a result`]);
  if (manifest.files.some((f) => f.path === file)) throw new ManifestRefusal([`${file} was recorded twice`]);
  if (entry.tier && entry.tier !== known.tier) {
    throw new ManifestRefusal([`${file} is recorded as '${entry.tier}' but the classifier says '${known.tier}'`]);
  }
  const dispatch = entry.dispatch ?? "ran";
  if (!DISPATCH.includes(dispatch)) throw new ManifestRefusal([`${file}: unknown dispatch '${dispatch}'`]);

  // THE SELECTION REASON IS A CLAIM, SO IT IS REQUIRED, NEVER DEFAULTED. It used to fall through
  // `entry.selection ?? "changed"`, which is the one value a caller is least likely to have meant: in a fast
  // gate the overwhelming majority of the roster is OMITTED, so the default quietly asserted that every
  // classified file had been changed directly. Only the caller knows whether the changed path, a dependency
  // or the roster selected a file; a record that does not say is refused rather than answered for.
  const selection = entry.selection;
  if (!SELECTION.includes(selection)) {
    throw new ManifestRefusal([
      selection === undefined || selection === null
        ? `${file}: no selection reason — only the caller knows whether the changed path, a dependency or the roster picked this file, and a default would record a claim nothing made`
        : `${file}: unknown selection '${selection}' (expected one of ${SELECTION.join(", ")})`,
    ]);
  }

  // THE STATUS IS CARRIED THROUGH, NOT RE-DERIVED AT THE END. It used to be validated here as a local and
  // then stored as `entry.status ?? "omitted"`, so a `skipped` record was written with status `omitted` —
  // the dispatch and the status disagreed, the summary counted it as skipped and the record said otherwise
  // (caught by the focused test for skip reasons, which is why that test exists).
  let status = entry.status ?? null;
  if (dispatch !== "ran") {
    if (!entry.reason) {
      throw new ManifestRefusal([`${file}: '${dispatch}' needs a reason — an omitted file with no reason is an unexplained gap`]);
    }
    status = entry.status ?? (dispatch === "omitted" ? "omitted" : "skipped");
    if (status !== "omitted" && status !== "skipped") {
      throw new ManifestRefusal([`${file}: a ${dispatch} file's status is '${status}', not omitted/skipped`]);
    }
  } else {
    if (!STATUS.includes(entry.status)) {
      throw new ManifestRefusal([`${file}: a dispatched file needs a terminal status (got ${JSON.stringify(entry.status)})`]);
    }
    if (!Number.isFinite(entry.secs)) {
      throw new ManifestRefusal([`${file}: dispatched with no duration — a lost child is not a verdict`]);
    }
    status = entry.status;
  }

  const record = {
    path: file,
    tier: known.tier,
    why: known.why ?? null,
    selection,
    dispatch,
    status,
    counts: entry.counts ?? null,
    timeout_ms: entry.timeout_ms ?? null,
    secs: Number.isFinite(entry.secs) ? Math.round(entry.secs * 1000) / 1000 : null,
    reason: entry.reason ?? null,
  };
  manifest.files.push(record);
  return record;
}

/**
 * Fold a TIER RECORD (what one tier's runner dispatched, e.g. tools/browser-shard-runner.mjs's
 * `VOICEBOX_GATE_TIER_RECORD`) into a manifest. A tier knows its own files and nothing about the roster
 * the other tiers cover, so it publishes records and the ONE aggregator reconciles — a tier must never
 * write a manifest of its own, because a partial manifest that happens to reconcile is a wide claim from
 * a narrow run.
 */
export function recordTier(manifest, record) {
  const files = Array.isArray(record) ? record : (record?.files ?? []);
  for (const entry of files) {
    const file = String(entry.path ?? "").startsWith("tests/") ? entry.path : `tests/${entry.path}`;
    recordFile(manifest, {
      path: file,
      dispatch: "ran",
      status: entry.status,
      counts: entry.counts ?? null,
      timeout_ms: entry.timeout_ms ?? null,
      secs: entry.secs,
      selection: entry.selection ?? "full-roster",
    });
  }
  return manifest;
}

/**
 * The decision. Every problem is named; an empty list is the ONLY thing that may be reported as
 * reconciled, and the caller turns a non-empty list into a refusal (never into a green).
 */
export function reconcile(manifest) {
  const problems = [];
  const roster = new Map(manifest.classifier.files.map((r) => [r.path, r]));
  const seen = new Set();
  const dispatched = new Set();

  for (const f of manifest.files) {
    if (!roster.has(f.path)) {
      problems.push(`${f.path} was recorded but is not in the classifier roster (unclassified)`);
      continue;
    }
    if (seen.has(f.path)) problems.push(`${f.path} is recorded more than once (duplicate)`);
    seen.add(f.path);

    const classifiedAs = roster.get(f.path).tier;
    if (f.tier !== classifiedAs) {
      problems.push(`${f.path} is recorded as '${f.tier}' but the classifier says '${classifiedAs}' (malformed tier)`);
    }

    if (f.dispatch === "ran") {
      dispatched.add(f.path);
      if (!STATUS.includes(f.status)) {
        problems.push(`${f.path} was dispatched with status '${f.status}', which is not terminal (malformed status)`);
      }
      if (!Number.isFinite(f.secs)) {
        problems.push(`${f.path} was dispatched and no duration was recorded — the child's exit was lost`);
      }
      if (f.status === "passed") {
        const tests = f.counts?.tests;
        if (!isCount(tests)) {
          problems.push(`${f.path} passed but reported no test counts (malformed marker)`);
        } else if (tests === 0) {
          problems.push(`${f.path} passed with ZERO tests — an empty run demonstrates nothing (zero-test result)`);
        }
        if (isCount(f.counts?.fail) && f.counts.fail > 0) {
          problems.push(`${f.path} passed with ${f.counts.fail} failing test(s) (contradictory counts)`);
        }
      }
      if (f.status === "failed" && !f.counts) {
        problems.push(`${f.path} failed but reported no counts — the failure needs a shape, not just a colour`);
      }
    } else if (!f.reason) {
      problems.push(`${f.path} is '${f.dispatch}' with no reason (omission without a reason)`);
    }
    if (manifest.gate === "full" && f.dispatch !== "ran") {
      problems.push(`${f.path} was not dispatched in a FULL gate (${f.dispatch}: ${f.reason ?? "no reason"}) — a full gate has no omitted scope`);
    }
  }

  for (const { path: file } of manifest.classifier.files) {
    if (!seen.has(file)) {
      problems.push(`${file} is in the classifier roster but appears in no record (missing — dispatched OR omitted with a reason)`);
    }
  }

  // A changed SOURCE file that maps to no test is not a roster question — it is a changed path the gate
  // cannot tie to any run, which is exactly the scope claim a PASS must not make silently.
  for (const file of manifest.unmapped ?? []) {
    problems.push(`${file} changed and maps to no test file (unmapped source)`);
  }

  const byStatus = (s) => manifest.files.filter((f) => f.status === s).length;
  const summary = {
    classified: manifest.classifier.files.length,
    recorded: manifest.files.length,
    dispatched: dispatched.size,
    omitted: manifest.files.filter((f) => f.dispatch === "omitted").length,
    skipped: manifest.files.filter((f) => f.dispatch === "skipped").length,
    passed: byStatus("passed"),
    failed: byStatus("failed"),
    timeout: byStatus("timeout"),
    unknown: byStatus("unknown"),
    unmapped: (manifest.unmapped ?? []).length,
    problems: problems.length,
  };
  return { ok: problems.length === 0, problems, summary };
}

/**
 * Close a manifest: reconcile, stamp the summary, and record the outcome WITHOUT throwing. The gate needs
 * the artifact even when it refused — that is precisely the run a later reader has to be able to audit —
 * so sealing is separate from the refusal. `finalizeManifest` is sealing plus the refusal.
 */
export function sealManifest(manifest, { finishedAt = new Date().toISOString() } = {}) {
  manifest.finished_at = finishedAt;
  if (!manifest.started_at) manifest.started_at = finishedAt;
  const started = Date.parse(manifest.started_at);
  const ended = Date.parse(manifest.finished_at);
  manifest.secs = Number.isFinite(started) && Number.isFinite(ended) ? Math.round((ended - started) / 100) / 10 : null;
  const { ok, problems, summary } = reconcile(manifest);
  manifest.reconciled = ok;
  manifest.problems = problems;
  manifest.summary = summary;
  return manifest;
}

/**
 * THE VERDICT RULE, FROZEN IN ONE PLACE (v1, for every orchestrator that folds records): a manifest that does
 * not reconcile is `refused`; a manifest in which ANY dispatched file is not `passed` is `fail` (timeout and
 * unknown included — an unfinished file is not a pass); a manifest that dispatched nothing is `empty` (a run
 * that measured nothing, never a pass); otherwise `pass`. Exported so a supervisor folding per-file records
 * cannot re-derive the rule and get the "unknown is not a pass" half wrong.
 */
export function verdictOf(manifest) {
  if (!manifest.reconciled) return "refused";
  if (manifest.files.some((f) => f.dispatch === "ran" && f.status !== "passed")) return "fail";
  if (!manifest.summary || manifest.summary.dispatched === 0) return "empty";
  return "pass";
}

/** Seal, then REFUSE (`ManifestRefusal`) when anything is not accounted for. */
export function finalizeManifest(manifest, opts) {
  sealManifest(manifest, opts);
  if (!manifest.reconciled) throw new ManifestRefusal(manifest.problems);
  return manifest;
}

/** `<dir>/<tree>.<gate>.manifest.json` — keyed by tree SHA and gate kind, so a verdict cannot drift trees. */
export function manifestPath(dir, tree, gate) {
  return path.join(dir, `${tree}.${gate}.manifest.json`);
}

/**
 * WHERE GATE ARTIFACTS LIVE: the hub's own per-tree record directory, overridable by the caller. ONE owner,
 * because both gates write there — the fast gate's `<tree>.fast.manifest.json`, the full gate's
 * `<tree>.full.manifest.json` — and a second answer to "where do receipts go" is how one of them ends up
 * somewhere nobody looks.
 */
export function artifactDir(explicit = null) {
  return explicit || process.env.VOICEBOX_GATE_ARTIFACT_DIR || path.join(os.homedir(), ".fleet", "checks");
}

/**
 * `<dir>/<tier>.json` — one TIER RECORD per test tier, in the scratch directory the gate owns for the
 * one run. ONE owner of this naming, because the writer (scripts/gate-tier.mjs, tools/browser-shard-runner
 * via `VOICEBOX_GATE_TIER_RECORD`) and the reader (the aggregate below) must agree by construction: a
 * mismatch would present as a MISSING tier — every file in that lane unaccounted for — which is refused,
 * so it fails closed, but it would fail for a reason that is not true of the run.
 */
export function tierRecordPath(dir, tier) {
  return path.join(dir, `${tier}.json`);
}

/**
 * Is one TIER RECORD a complete account of its own lane? Answers for a tier's record against the file list
 * that tier was told to run: a file with no record, a file recorded twice, a dispatched file with no
 * terminal status or no duration — each named. This is the ANSWER A TIER CAN GIVE ABOUT ITSELF; the union
 * reconciliation (`reconcile`) is the one that can speak for the whole roster, and it stays the owner of
 * that question. Used by scripts/gate-tier.mjs so an incomplete tier is refused by the stage that ran it,
 * with the run's own names, rather than only at the end.
 */
export function coverageGaps(record, files) {
  const problems = [];
  const wanted = new Set(files);
  const seen = new Set();
  for (const entry of record?.files ?? []) {
    const file = String(entry.path ?? "");
    if (!wanted.has(file)) {
      problems.push(`${file} was recorded but is not in the ${record?.tier ?? "?"} tier (unexpected path)`);
      continue;
    }
    if (seen.has(file)) problems.push(`${file} was recorded twice (duplicate)`);
    seen.add(file);
    if (!STATUS.includes(entry.status)) problems.push(`${file} has no terminal status (got ${JSON.stringify(entry.status)})`);
    if (!Number.isFinite(entry.secs)) problems.push(`${file} was recorded with no duration — the child's exit was lost`);
  }
  for (const file of files) if (!seen.has(file)) problems.push(`${file} is in the ${record?.tier ?? "?"} lane but appears in no record (missing)`);
  return problems;
}

/** Write atomically (tmp + rename), so a reader never sees a half-written manifest. Returns the path. */
export function writeManifest(manifest, dir) {
  mkdirSync(dir, { recursive: true });
  const target = manifestPath(dir, manifest.tree, manifest.gate);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, target);
  return target;
}

export function readManifest(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The hub's coverage extractor reads the gate LOG, so the log carries these lines. `kind` is one of the
 * hub's vocabulary: running, ran, passed, completed, failed, unmapped, unknown.
 */
export function emitMarker(kind, values = []) {
  // `running` is deliberately never emitted by the gate's own dispatch: see the note above. It stays
  // supported because the vocabulary is the hub's, not ours.
  const body = Array.isArray(values) ? values.join(" ") : String(values);
  return `${MARKER_PREFIX} ${kind}:${body ? ` ${body}` : ""}`;
}

/** The hub's patterns, quoted so a marker this file emits can be proven to match them (tests). */
export const HUB_MARKER_PATTERNS = Object.freeze({
  suites: /^fast-gate:\s*(?:running|ran|passed|completed|failed):\s*(.*)$/,
  unmapped: /^fast-gate:\s*unmapped:\s*(.*)$/,
  unknown: /^fast-gate:\s*unknown:\s*(.*)$/,
});

/** Node's TAP summary counts, as printed at the end of a per-file run. -1 is "the reporter said nothing". */
export function tapCounts(text) {
  const n = (kind) => {
    const m = new RegExp(`^# ${kind} (\\d+)$`, "m").exec(text);
    return m ? Number(m[1]) : -1;
  };
  return { tests: n("tests"), pass: n("pass"), fail: n("fail"), skipped: n("skipped") };
}

/**
 * ONE manifest from MANY tier records — the full gate's receipt. The tiers are separate processes (the
 * unit tier, the server pool, and the browser runner PHASED into its parallel and isolated invocations),
 * so no single runner can assert the lane: only this fold can, and it does it against the classifier's
 * roster. A file that no tier recorded is MISSING and refused; a file two tiers both recorded is a
 * DUPLICATE and refused; a path no tier knows is UNCLASSIFIED and refused. `omittedReason` lets a non-full
 * gate account for the files it deliberately did not select, by name, rather than leaving them missing.
 */
export function manifestFromTierRecords({ gate = "full", tree, sha = "", classified, records = [], changed = [], unmapped = [], omittedReason = null, dir = null }) {
  if (!tree) throw new ManifestRefusal(["aggregate needs the tree SHA the records describe (--tree)"]);
  const manifest = createManifest({ gate, tree, sha, classified, changed, unmapped });
  // A CONFLICT BETWEEN RECORDS IS A REFUSAL WITH EVIDENCE, NOT A CRASH. `recordFile` refuses a duplicate
  // by throwing (for a single runner that is the right shape — the bug is in its own code). An aggregate is
  // folding records from SEVERAL processes, so the same condition is a fact about the run: it is collected
  // here, recorded in the artifact and answered with a non-zero exit, because a landing reader needs to see
  // which file two tiers both claimed.
  const conflicts = [];
  for (const record of records) {
    try {
      recordTier(manifest, record);
    } catch (e) {
      if (!(e instanceof ManifestRefusal)) throw e;
      conflicts.push(...(e.problems ?? [e.message]));
    }
  }
  const recorded = new Set(manifest.files.map((f) => f.path));
  for (const entry of manifest.classifier.files) {
    if (recorded.has(entry.path)) continue;
    // A file no record mentions stays MISSING unless the caller says, in words, why it was not selected:
    // silence about part of the roster is not a receipt.
    if (!omittedReason) continue;
    // A file no tier ran is `not-selected` (a full gate cannot reach here with an omission; it refuses
    // first, so `full-roster` is the honest label for the roster-complete case this is written for).
    recordFile(manifest, { path: entry.path, dispatch: "omitted", reason: omittedReason, selection: gate === "full" ? "full-roster" : "not-selected" });
  }
  sealManifest(manifest);
  if (conflicts.length > 0) {
    manifest.problems = [...conflicts, ...manifest.problems];
    manifest.reconciled = false;
  }
  manifest.verdict = verdictOf(manifest);
  const written = dir ? writeManifest(manifest, dir) : null;
  return { manifest, written };
}

/**
 * The FULL gate's union: read the tier records the run wrote (one per tier, named by `tierRecordPath`),
 * fold them, and answer with the manifest — plus the reasons it does not reconcile. Exported so the refusal
 * paths are drivable without spawning a CLI, because a refusal a test cannot reach is a refusal nobody has
 * seen work.
 *
 * A TIER THAT WROTE NOTHING IS DERAILED, NOT EMPTY, and it is named here rather than left to show up as a
 * roster-sized list of MISSING files: the difference between "the browser tier ran and every file failed"
 * and "the browser tier never started" is the first thing a reader of a red landing needs to know.
 */
export function aggregateTierRecords({ tierDir = null, records = [], gate = "full", tree, sha = "", classified, changed = [], unmapped = [], omittedReason = null, problems = [], dir = null }) {
  const tierProblems = [];
  const texts = [...records];
  if (tierDir) {
    for (const tier of TIERS) {
      const file = tierRecordPath(tierDir, tier);
      if (!existsSync(file)) {
        tierProblems.push(`the ${tier} tier wrote no record at ${file} — that tier never completed, and its lane is not accounted for below`);
        continue;
      }
      texts.push(readFileSync(file, "utf8"));
    }
  }
  const { manifest, written } = manifestFromTierRecords({
    gate,
    tree,
    sha,
    classified,
    records: texts.map((text) => JSON.parse(text)),
    changed,
    unmapped,
    omittedReason,
    dir,
  });
  if (tierProblems.length > 0 || problems.length > 0) {
    // THE PROBLEM IS EVIDENCE, NOT A CRASH: the artifact is still written (that is the run a later reader
    // has to audit), and the refusal is the exit code with the reason named.
    manifest.problems = [...problems, ...tierProblems, ...manifest.problems];
    manifest.reconciled = false;
    manifest.verdict = "refused";
  }
  return { manifest, written, tierProblems };
}

if (import.meta.main) {
  const [command, file] = process.argv.slice(2);
  if (command === "aggregate") {
    const argv = process.argv.slice(3);
    const flag = (name, fallback = null) => {
      const at = argv.indexOf(`--${name}`);
      return at === -1 ? fallback : argv[at + 1];
    };
    const records = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === "--record" && argv[i + 1]) records.push(readFileSync(argv[i + 1], "utf8"));
    const gate = flag("gate", "full");
    const tree = flag("tree", null) ?? gitTree();
    const classifiedModule = await import("./test-lanes.mjs");
    const classified = classifiedModule.classify();
    // ── ONE TIER RECORD PER TIER (voicebox-beads-wiby) ─────────────────────────────────────────────
    // The full gate runs its three tiers as three processes, each of which writes its own record into the
    // scratch directory the gate owns for this run. The DERIVATION of the union lives in
    // `aggregateTierRecords` above, so the whole decision — including every refusal — is drivable from a
    // test without spawning this file.
    const tierDir = flag("tier-dir", null);
    // A CHANGED SOURCE THAT MAPS TO NO TEST is recorded on the manifest (and refused by `reconcile`),
    // because a landing is the last place that gap is cheap to see. Off unless the caller names a base, so
    // an aggregate over JSON records alone behaves exactly as it did.
    //
    // ASKED OF THE MAPPING'S OWNER, THROUGH ITS CLI. A `await import("./test-changed.mjs")` here DEADLOCKS:
    // this module is the process entry point and test-changed.mjs imports it, so the dynamic import never
    // settles (measured: node exits 13, "Detected unsettled top-level await", printing nothing at all). The
    // owner's `--json` is the developer path — a report, not a gate decision; the gate's decision is the
    // reconciliation below, which refuses a non-empty `unmapped`.
    const changedBase = flag("changed-base", null);
    let changed = [];
    let unmapped = [];
    const scopeProblems = [];
    if (changedBase) {
      const probe = spawnSync(process.execPath, [fileURLToPath(new URL("./test-changed.mjs", import.meta.url)), "--base", changedBase, "--json", "--allow-unmapped"], { encoding: "utf8" });
      try {
        const answer = JSON.parse(probe.stdout);
        changed = answer.changed ?? [];
        unmapped = answer.unmapped ?? [];
      } catch {
        scopeProblems.push(`the changed-path map could not be computed against '${changedBase}' (exit ${probe.status}) — whether every changed source has a test is NOT known here, and an unknown scope is not an empty one`);
      }
    }
    const { manifest, written } = aggregateTierRecords({
      tierDir,
      records,
      gate,
      tree,
      sha: flag("sha", ""),
      classified,
      changed,
      unmapped,
      omittedReason: flag("omitted-reason", null),
      problems: scopeProblems,
      dir: flag("out", artifactDir()),
    });
    const s = manifest.summary;
    console.log(
      `gate-manifest: aggregate ${gate} ${(tree || "").slice(0, 12)} — classified ${s.classified}, recorded ${s.recorded}, ` +
        `passed ${s.passed}, failed ${s.failed}, unknown ${s.unknown}${s.omitted ? `, omitted ${s.omitted}` : ""}, problems ${s.problems}`,
    );
    if (written) console.log(`gate-manifest: manifest ${written} (verdict ${manifest.verdict}, reconciled ${manifest.reconciled})`);
    if (!manifest.reconciled) {
      console.error(`gate-manifest: REFUSED — ${manifest.problems.length} problem(s) across the tier records:`);
      for (const p of manifest.problems.slice(0, 20)) console.error(`  · ${p}`);
      if (manifest.problems.length > 20) console.error(`  · …and ${manifest.problems.length - 20} more (all of them in ${written})`);
      process.exit(1);
    }
    // A RECONCILED MANIFEST CAN STILL BE A FAILED RUN, and it must say WHICH files: the count alone
    // ("failed 3") sends the reader into the log to find them.
    const notPassed = manifest.files.filter((f) => f.dispatch === "ran" && f.status !== "passed");
    if (manifest.verdict !== "pass") {
      console.error(`gate-manifest: REFUSED — the ${gate} gate's verdict is '${manifest.verdict}'`);
      for (const f of notPassed.slice(0, 20)) console.error(`  · ${f.path} (${f.status}${f.counts ? `: tests=${f.counts.tests} fail=${f.counts.fail}` : ": no counts reported"})`);
      if (manifest.summary.dispatched === 0) console.error("  · nothing was dispatched — a run that measured nothing is never a pass");
      process.exit(1);
    }
    process.exit(0);
  }
  if (command === "verify" && file) {
    const manifest = readManifest(file);
    const { ok, problems, summary } = reconcile(manifest);
    console.log(
      `gate-manifest: ${manifest.gate} ${manifest.tree.slice(0, 12)} — classified ${summary.classified}, ` +
        `dispatched ${summary.dispatched}, omitted ${summary.omitted}, passed ${summary.passed}, failed ${summary.failed}`,
    );
    if (!ok) {
      console.error(`gate-manifest: REFUSED (${problems.length} problem(s)):`);
      for (const p of problems) console.error(`  · ${p}`);
      process.exit(1);
    }
    console.log("gate-manifest: reconciled — every classified file is dispatched once or omitted with a reason");
    process.exit(0);
  }
  console.error("usage: node scripts/gate-manifest.mjs verify <manifest.json>");
  process.exit(2);
}
