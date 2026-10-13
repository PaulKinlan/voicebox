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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MANIFEST_VERSION = 1;
export const TIERS = Object.freeze(["unit", "server", "browser"]);
export const GATES = Object.freeze(["fast", "full"]);
/** How a file came to be selected: the changed-path map, a transitive dependency, or the whole roster. */
export const SELECTION = Object.freeze(["changed", "dependency", "full-roster"]);
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
    selection: entry.selection ?? "changed",
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

if (import.meta.main) {
  const [command, file] = process.argv.slice(2);
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
