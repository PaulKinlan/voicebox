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
import { gitEnv } from "../lib/git-env.mjs";
import { hostSnapshot, isLoadavg, loadavg1m } from "../lib/host-load.mjs";

/** The repository this script lives in: the aggregate asks git about THIS tree, never about the caller's. */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * THE ARTIFACT SHAPE'S VERSION, BUMPED WHENEVER THE SHAPE CHANGES MEANING. v2 adds the `host` block and the
 * per-file `loadavg_1m` of the browser tier (voicebox-beads-zjpm.6): a run that cannot say what the box was
 * doing cannot attribute a slow or failed file, and before v2 an idle box and a box at loadavg 27 were the
 * same artifact. v3 adds the per-file `conditions` arms and the `condition_verdict` the sealer derives from
 * them (voicebox-beads-zjpm.5.2): a browser file that fails only under load used to leave nothing behind but
 * a timeout, so "does this file fail alone?" was answered by RE-RUNNING it. Old artifacts are still audited
 * as the shape they declared — a v1 or v2 manifest has no conditions because it did not claim any, while a
 * manifest that carries conditions must carry valid ones (`conditionProblems`). `verify` therefore stays
 * useful over the checks directory's history instead of turning every artifact written before today into a
 * refusal.
 */
export const MANIFEST_VERSION = 3;
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
 * THE THREE CONDITIONS A BROWSER FILE CAN BE RUN UNDER (v3, voicebox-beads-zjpm.5.2). `standalone` is the file
 * alone on the box, `heavy_slot` is the file while the heavy-job queue's slot is held (the holder is named),
 * and `shard_concurrency` is the file inside the shard pool at its real width. The names are a closed set: an
 * arm labelled anything else is refused, because a comparison against an unnamed condition is not a
 * comparison — it is a note.
 */
export const CONDITIONS = Object.freeze(["standalone", "heavy_slot", "shard_concurrency"]);
/**
 * What the arms TOGETHER say, in a vocabulary a reader can group by. `incomplete` is not a failure and not a
 * pass: it says an arm was skipped or could not be measured, so no comparison was made — exactly the state
 * that must never read as agreement.
 */
export const CONDITION_PATTERN = Object.freeze(["standalone_only_fails", "concurrency_only_fails", "heavy_slot_only_fails", "all_agree", "mixed", "incomplete"]);
const CONDITION_KEYS = Object.freeze(["condition", "status", "secs", "loadavg_1m", "worker_count", "command", "counts", "reason", "holder"]);

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

/**
 * Does `base` name a commit in THIS repository? Asked with git's local plumbing stripped (`gitEnv`), because
 * a pre-push hook exports GIT_DIR and it outranks `-c`/`cwd` — a measurement of a tree must not be steerable
 * by the environment of whatever ran it (voicebox-beads-bp8). Exported so the refusal is drivable without a
 * repository that lacks the ref.
 */
export function baseNamesACommit(base, root = ROOT) {
  try {
    return Boolean(
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd: root, env: gitEnv(), encoding: "utf8" }).trim(),
    );
  } catch {
    return false;
  }
}

/** The tree this run measured, from git — the aggregate CLI's default label. */
export function gitTree(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Compute the source tree SHA for a git tree, omitting root README.md and docs/**.
 * Code changes in lib/, public/, scripts/, tools/, or tests/ strictly change this hash,
 * while markdown documentation changes leave it invariant (voicebox-beads-83ge).
 */
export function computeSourceTree(tree, cwd = process.cwd()) {
  if (!tree) return null;
  try {
    const raw = execFileSync("git", ["ls-tree", tree], { cwd, env: gitEnv(), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const lines = raw.split("\n").filter((l) => {
      if (!l.trim()) return false;
      const tab = l.indexOf("\t");
      if (tab === -1) return true;
      const name = l.slice(tab + 1);
      return name !== "README.md" && name !== "docs";
    });
    return (
      execFileSync("git", ["mktree"], {
        cwd,
        env: gitEnv(),
        input: lines.length ? lines.join("\n") + "\n" : "",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim() || null
    );
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
export function createManifest({ gate, tree, sourceTree = null, cwd = process.cwd(), sha = "", classified, changed = [], unmapped = [], base = "", treeDirty = null, startedAt = new Date().toISOString() }) {
  if (!GATES.includes(gate)) throw new ManifestRefusal([`unknown gate kind '${gate}' (want ${GATES.join("|")})`]);
  if (!tree) throw new ManifestRefusal(["a manifest needs the tree SHA it describes"]);
  const roster = rosterOf(classified);
  const resolvedSourceTree = sourceTree ?? computeSourceTree(tree, cwd);
  return {
    version: MANIFEST_VERSION,
    gate,
    tree,
    source_tree: resolvedSourceTree,
    sourceTree: resolvedSourceTree,
    sha,
    started_at: startedAt,
    finished_at: null,
    secs: null,
    base,
    tree_dirty: treeDirty,
    classifier: { roster: rosterHash(roster), files: roster, counts: rosterCounts(roster) },
    changed: [...changed],
    unmapped: [...unmapped],
    host: hostSnapshot(startedAt),
    files: [],
    summary: null,
    reconciled: false,
    problems: [],
  };
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * The load readings a BROWSER file's record may carry: both ends of its own window, each a reading or an
 * honest null. Anything else is refused by name — a record whose load context is `{}`, `"27"` or `-1` is an
 * artifact that looks like evidence and is not, which is the one shape this whole bead exists to stop.
 */
function fileLoadProblems(load) {
  if (load === null || load === undefined) return [];
  const problems = [];
  if (typeof load !== "object" || Array.isArray(load)) {
    return [`loadavg_1m must be null or {start, end} (got ${JSON.stringify(load)})`];
  }
  for (const end of ["start", "end"]) {
    if (!(end in load)) problems.push(`loadavg_1m is missing '${end}' — both ends of the file's window are the evidence`);
    else if (!isLoadavg(load[end])) problems.push(`loadavg_1m.${end} must be a non-negative reading or null (got ${JSON.stringify(load[end])})`);
  }
  const extra = Object.keys(load).filter((k) => k !== "start" && k !== "end");
  if (extra.length) problems.push(`loadavg_1m carries unexpected ${extra.join(", ")} (want exactly start, end)`);
  return problems;
}

/**
 * ONE CONDITION ARM'S SOUNDNESS. Every field here exists because its absence would let a reader believe a
 * comparison that was never made: a status with no duration, a worker count nobody recorded, a command nobody
 * can re-run, a `skipped`/`unknown` arm with no reason, or a `heavy_slot` arm that does not say WHO held the
 * slot — the burners are a proxy for the slot, a proxy is a claim, and an unnamed holder is a claim nobody
 * made. `counts` is optional and validated when present, because an arm that failed should say how many tests
 * ran, exactly as a failing file's record does.
 */
function conditionProblems(conditions) {
  if (conditions === undefined || conditions === null) return [];
  if (!Array.isArray(conditions)) return [`conditions must be an array of per-condition arms (got ${JSON.stringify(conditions)})`];
  const problems = [];
  const seen = new Set();
  for (const arm of conditions) {
    const where = `conditions[${arm && typeof arm === "object" ? JSON.stringify(arm.condition ?? "?") : "?"}]`;
    if (!arm || typeof arm !== "object" || Array.isArray(arm)) {
      problems.push(`${where} must be an object`);
      continue;
    }
    const extra = Object.keys(arm).filter((k) => !CONDITION_KEYS.includes(k));
    if (extra.length) problems.push(`${where} carries unexpected ${extra.join(", ")} (want exactly ${CONDITION_KEYS.join(", ")})`);
    if (!CONDITIONS.includes(arm.condition)) {
      problems.push(`${where} names an unknown condition '${arm.condition}' (expected one of ${CONDITIONS.join(", ")})`);
    } else if (seen.has(arm.condition)) {
      problems.push(`${where} is named twice — one arm per condition`);
    } else {
      seen.add(arm.condition);
    }
    if (!STATUS.includes(arm.status)) {
      problems.push(`${where} status '${arm.status}' is not terminal (expected one of ${STATUS.join(", ")})`);
      continue;
    }
    // A SKIPPED ARM never ran and an UNKNOWN one could not be measured: neither can have a duration, so neither
    // is asked for one. Every other state has a real elapsed time and must carry it.
    if (arm.status !== "skipped" && arm.status !== "unknown" && !Number.isFinite(arm.secs)) problems.push(`${where} recorded no duration — an arm whose duration was not measured is not a measurement`);
    if (arm.counts !== undefined) {
      const counts = arm.counts;
      if (!counts || typeof counts !== "object" || Array.isArray(counts)) problems.push(`${where} counts must be {tests, pass, fail, skipped}`);
      else {
        for (const key of ["tests", "pass", "fail", "skipped"]) {
          if (!isCount(counts[key])) problems.push(`${where} counts.${key} must be a non-negative integer (got ${JSON.stringify(counts[key])})`);
        }
      }
    }
    if (!Number.isInteger(arm.worker_count) || arm.worker_count < 1) problems.push(`${where} worker_count must be a positive integer (got ${JSON.stringify(arm.worker_count)})`);
    if (typeof arm.command !== "string" || !arm.command.trim()) problems.push(`${where} must carry the command it ran, so whoever reads the artifact can repeat the arm`);
    if ((arm.status === "skipped" || arm.status === "unknown") && !arm.reason) problems.push(`${where} is ${arm.status} with no reason — an arm that did not run must say why, and "unknown" is a statement about the measurement only`);
    if (arm.condition === "heavy_slot" && (typeof arm.holder !== "string" || !arm.holder.trim())) problems.push(`${where} must name the holder of the heavy slot — the burners that stand in for the slot are a proxy, and a proxy is a claim`);
    for (const p of fileLoadProblems(arm.loadavg_1m)) problems.push(`${where}: ${p}`);
  }
  if (conditions.length < CONDITIONS.length) {
    problems.push(`a condition check with ${conditions.length} arm(s) is not a check — all ${CONDITIONS.length} are what make it a comparison`);
  } else {
    for (const c of CONDITIONS) if (!seen.has(c)) problems.push(`conditions is missing the '${c}' arm`);
  }
  return problems;
}

/**
 * WHAT THE ARMS TOGETHER SAY, DERIVED AND NEVER STATED. Computed in one place so the write path and the sealer
 * cannot disagree about it, and so a runner's own opinion of its run is never what the artifact carries. An
 * arm that was skipped or could not be measured makes the whole answer `incomplete` with both other fields
 * null: a comparison missing one side must not read as agreement.
 */
export function conditionVerdictFrom(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return null;
  if (conditions.some((a) => a?.status === "unknown" || a?.status === "skipped")) {
    return { pattern: "incomplete", disagreement: null, agrees_with_shard: null };
  }
  const byName = new Map(conditions.map((a) => [a?.condition, a]));
  const failed = CONDITIONS.filter((c) => byName.has(c) && byName.get(c).status !== "passed");
  const pattern = failed.length === 0
    ? "all_agree"
    : failed.length > 1
      ? "mixed"
      : failed[0] === "standalone"
        ? "standalone_only_fails"
        : failed[0] === "heavy_slot"
          ? "heavy_slot_only_fails"
          : "concurrency_only_fails";
  const standalone = byName.get("standalone");
  const shard = byName.get("shard_concurrency");
  return {
    pattern,
    disagreement: pattern !== "all_agree",
    agrees_with_shard: standalone && shard ? (standalone.status === "passed") === (shard.status === "passed") : null,
  };
}

/**
 * THE FAILING ARM MUST BE NAMED (voicebox-beads-a8a2, which exists because of the cost of NOT naming it). A v2
 * evidence record says a file failed; if it does not also name WHICH arm failed, the only way to find out is to
 * re-run the file — the cost the evidence field was added to remove, paid again on a box whose load nobody can
 * reproduce. Deliberately narrow: version-gated so pre-a8a2 evidence still audits as the shape it declared,
 * required only for `failed` and only where a failure was counted, and never for `timeout` or `unknown`, where a
 * crash or a kill has no arm to name and its own bounded tail is the name.
 */
function evidenceArmProblems(path, entry) {
  const ev = entry?.failure_evidence;
  if (!ev || typeof ev !== "object") return [];
  if (Number(ev.version) < 2) return [];
  if (!("test" in ev)) return [`${path}: failure_evidence version ${ev.version} carries no 'test' key — the field that names the arm that failed`];
  const stated = typeof ev.test === "string" && ev.test.trim() !== "";
  const fails = Number.isFinite(entry?.counts?.fail) ? entry.counts.fail : null;
  if (entry?.status === "failed" && fails !== 0 && !stated) {
    return [`${path} failed with evidence version ${ev.version} but names no failing arm — a failure nobody can name costs a re-run, which is exactly what that field exists to remove`];
  }
  return [];
}

/**
 * The `host` block's own soundness. A v2 manifest must carry one (a run that cannot say what the box was
 * doing cannot attribute a slow or failed file); a v1 manifest is audited as the shape it declared, because
 * the checks directory holds artifacts written before this field existed and `verify` is for reading history.
 */
function hostProblems(manifest) {
  const host = manifest.host;
  if (host === null || host === undefined) {
    return Number(manifest.version) >= 2
      ? [`manifest version ${manifest.version} carries no host block — the box's load, its cores and the moment of reading are what attribute a slow or failed file, and their absence here is a lie about what was measured`]
      : [];
  }
  const problems = [];
  if (typeof host !== "object" || Array.isArray(host)) return [`host must be an object (got ${JSON.stringify(host)})`];
  for (const key of ["cpus", "available_parallelism"]) {
    if (!Number.isInteger(host[key]) || host[key] <= 0) problems.push(`host.${key} must be a positive integer (got ${JSON.stringify(host[key])})`);
  }
  const load = host.loadavg_1m;
  if (!load || typeof load !== "object" || Array.isArray(load)) {
    problems.push(`host.loadavg_1m must be {before, max, after} (got ${JSON.stringify(load)})`);
  } else {
    for (const key of ["before", "max", "after"]) {
      if (!(key in load)) problems.push(`host.loadavg_1m is missing '${key}'`);
      else if (!isLoadavg(load[key])) problems.push(`host.loadavg_1m.${key} must be a non-negative reading or null (got ${JSON.stringify(load[key])})`);
    }
    const extra = Object.keys(load).filter((k) => !["before", "max", "after"].includes(k));
    if (extra.length) problems.push(`host.loadavg_1m carries unexpected ${extra.join(", ")} (want exactly before, max, after)`);
  }
  if (typeof host.sampled_at !== "string" || !Number.isFinite(Date.parse(host.sampled_at))) {
    problems.push(`host.sampled_at must be a timestamp (got ${JSON.stringify(host.sampled_at)})`);
  }
  return problems;
}

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

  // THE THREE-CONDITION CHECK IS VALIDATED ON THE WRITE PATH, not only when the artifact is read back: a runner
  // that feeds a malformed arm to `recordFile` is told now, by name, instead of after the landing it was meant
  // to justify. The same validation runs again in `reconcile`, because a manifest can also arrive from a record
  // built elsewhere (v3, voicebox-beads-zjpm.5.2).
  const conditions = entry.conditions;
  if (conditions !== undefined && dispatch !== "ran") {
    throw new ManifestRefusal([`${file}: a '${dispatch}' record cannot carry a condition check — arms are dispatched work, and a file that did not run was not run under any condition`]);
  }
  const conditionProblemsForFile = conditions === undefined ? [] : conditionProblems(conditions).map((p) => `${file}: ${p}`);
  if (conditionProblemsForFile.length) throw new ManifestRefusal(conditionProblemsForFile);
  const derived = conditionVerdictFrom(conditions);
  // A STATED VERDICT IS A CLAIM ABOUT THE ARMS, SO IT IS CHECKED AGAINST THEM. This is where "disagreement:
  // false" beside an arm that was never measured is refused instead of printed: the derived answer for an
  // unmeasured arm is `incomplete` with nulls, and anything else is a runner asserting a comparison it did not
  // make.
  if (entry.condition_verdict !== undefined && derived) {
    const stated = entry.condition_verdict ?? {};
    for (const key of ["pattern", "disagreement", "agrees_with_shard"]) {
      if ((stated[key] ?? null) !== derived[key]) {
        throw new ManifestRefusal([`${file}: the stated condition verdict's '${key}' is ${JSON.stringify(stated[key] ?? null)} but the arms say ${JSON.stringify(derived[key])} — the sealer derives this block, nobody states it`]);
      }
    }
  }
  for (const p of evidenceArmProblems(file, { ...entry, status })) throw new ManifestRefusal([p]);

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
    // WHAT THE BOX WAS DOING AROUND THIS FILE. The browser tier publishes both ends of its own window (the
    // runner samples os.loadavg()[0] when it spawns the file and again when the child settles); the unit and
    // server tiers publish nothing, and `null` says exactly that — an absence of evidence, not an idle box.
    loadavg_1m: entry.loadavg_1m ?? null,
    // THE THREE ARMS, when this file was condition-checked (v3). Present only on a record that RAN: arms are
    // dispatched work, so an omitted or skipped file carrying them is refused below rather than stored as a
    // measurement nobody made.
    ...(conditions !== undefined ? { conditions } : {}),
    ...(derived ? { condition_verdict: derived } : {}),
    reason: entry.reason ?? null,
    ...(entry.failure_evidence ? { failure_evidence: entry.failure_evidence } : {}),
  };
  const badLoad = fileLoadProblems(record.loadavg_1m);
  if (badLoad.length) throw new ManifestRefusal(badLoad.map((p) => `${file}: ${p}`));
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
      loadavg_1m: entry.loadavg_1m ?? null,
      selection: entry.selection ?? "full-roster",
      failure_evidence: entry.failure_evidence,
      // A TIER MAY CARRY THE CONDITION ARMS IT RAN (v3): fix-85lx's condition CLI is the producer, this is the
      // one fold, and the sealer derives the verdict from them either way (`condition_verdict` on the way in is
      // accepted only when it matches what the arms say).
      conditions: entry.conditions,
      condition_verdict: entry.condition_verdict,
    });
  }
  return manifest;
}

/**
 * The decision. Every problem is named; an empty list is the ONLY thing that may be reported as
 * reconciled, and the caller turns a non-empty list into a refusal (never into a green).
 */
export function reconcile(manifest) {
  const problems = [...hostProblems(manifest)];
  const roster = new Map(manifest.classifier.files.map((r) => [r.path, r]));
  const seen = new Set();
  const dispatched = new Set();

  for (const f of manifest.files) {
    for (const p of fileLoadProblems(f.loadavg_1m)) problems.push(`${f.path}: ${p}`);
    // THE ARMS AND THE FAILING ARM, validated again here for a manifest built by any route (v3 / a8a2).
    if (f.conditions !== undefined && f.dispatch !== "ran") {
      problems.push(`${f.path} is '${f.dispatch}' and carries a condition check — arms are dispatched work (conditions on a non-ran record)`);
    }
    for (const p of conditionProblems(f.conditions)) problems.push(`${f.path}: ${p}`);
    for (const p of evidenceArmProblems(f.path, f)) problems.push(p);
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
  // THE RUN'S OWN READING, BEFORE THE DECISION. `after` is taken here; `max` is the highest of every reading
  // this manifest holds — the two manifest ends plus every per-file window the browser tier published — so a
  // spike that happened mid-run survives into the artifact instead of being averaged away. Readings that are
  // null (not measured) are dropped rather than counted as zero.
  if (manifest.host && typeof manifest.host === "object") {
    const load = manifest.host.loadavg_1m;
    if (load && typeof load === "object") {
      load.after = loadavg1m();
      const readings = [load.before, load.after, ...manifest.files.flatMap((f) => (f.loadavg_1m ? [f.loadavg_1m.start, f.loadavg_1m.end] : []))];
      const measured = readings.filter((n) => Number.isFinite(n));
      load.max = measured.length ? Math.max(...measured) : null;
    }
  }
  const started = Date.parse(manifest.started_at);
  const ended = Date.parse(manifest.finished_at);
  manifest.secs = Number.isFinite(started) && Number.isFinite(ended) ? Math.round((ended - started) / 100) / 10 : null;
  // THE DERIVED BLOCK IS THE SEALER'S, RECOMPUTED AT SEAL TIME (v3): the artifact carries what the arms
  // together say, so it cannot be a runner's opinion that drifted from its own measurements. A record with no
  // arms keeps no block, and `verdictOf` never reads any of this — the arms DESCRIBE, the file's own status
  // still decides.
  for (const f of manifest.files) {
    const derived = conditionVerdictFrom(f.conditions);
    if (derived) f.condition_verdict = derived;
  }
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
export function manifestFromTierRecords({ gate = "full", tree, sourceTree = null, sha = "", classified, records = [], changed = [], unmapped = [], base = "", treeDirty = null, omittedReason = null, dir = null }) {
  if (!tree) throw new ManifestRefusal(["aggregate needs the tree SHA the records describe (--tree)"]);
  const manifest = createManifest({ gate, tree, sourceTree, sha, classified, changed, unmapped, base, treeDirty });
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
export function aggregateTierRecords({ tierDir = null, records = [], gate = "full", tree, sourceTree = null, sha = "", classified, changed = [], unmapped = [], base = "", treeDirty = null, omittedReason = null, problems = [], dir = null }) {
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
    sourceTree,
    sha,
    classified,
    records: texts.map((text) => JSON.parse(text)),
    changed,
    unmapped,
    base,
    treeDirty,
    omittedReason,
    dir,
  });
  // A FULL-GATE RECEIPT DESCRIBES A COMMIT, SO A DIRTY RUN IS NOT ONE. The tiers run over the WORKING TREE,
  // and the artifact is keyed by the committed tree: when the two differ the receipt is a claim about bytes
  // nobody measured. The fast gate may run over uncommitted work (that is its job) and records
  // `tree_dirty: true` without refusing — a landing receipt refuses, and says why. The fact is computed by
  // the caller that can see the worktree (scripts/pre-push.sh passes --tree-dirty), so this fold never has to
  // guess.
  const dirtyProblems = [];
  if (treeDirty === true && gate === "full") {
    dirtyProblems.push(
      "the working tree was DIRTY when this gate ran: a full-gate receipt is keyed by a tree, and a dirty run's bytes are not that tree — refusing (the fast gate may run over uncommitted bytes and records tree_dirty: true; a landing receipt describes a commit)",
    );
  }
  if (tierProblems.length > 0 || problems.length > 0 || dirtyProblems.length > 0) {
    // THE PROBLEM IS EVIDENCE, NOT A CRASH: the artifact is still written (that is the run a later reader
    // has to audit), and the refusal is the exit code with the reason named.
    //
    // AND THE FILE ON DISK MUST SAY WHAT THE EXIT CODE SAYS. `manifestFromTierRecords` has already written
    // the artifact by the time a caller's own problems are known (a scope that could not be read, a tier
    // that wrote no record), so the artifact is REWRITTEN here. Measured: an aggregate refused for a base
    // that names no commit still left `"reconciled": true` on disk — a receipt contradicting the gate that
    // produced it, which is the defect this bead exists to remove.
    manifest.problems = [...problems, ...tierProblems, ...dirtyProblems, ...manifest.problems];
    manifest.reconciled = false;
    manifest.verdict = "refused";
    if (written) writeManifest(manifest, dir);
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
    const sourceTree = flag("source-tree", null);
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
      // THE BASE MUST NAME A COMMIT BEFORE THE MAP IS ASKED, because the mapping's `--json` developer path
      // answers a base it cannot resolve with an EMPTY change set — git's "ambiguous argument" goes to
      // stderr while the process still exits 0 (measured: `--base no/such/ref --json --allow-unmapped`
      // prints `{"changed":[],"unmapped":[]}`). Read as an answer, that would skip the unmapped-source
      // refusal for a typo'd or unfetched base and the artifact would say `pass` about a scope nobody read.
      // Unknown is not empty, and a gate that cannot say what it measured cannot call itself a pass.
      if (!baseNamesACommit(changedBase)) {
        scopeProblems.push(
          `--changed-base '${changedBase}' does not name a commit in this repository, so the changed set is UNKNOWN — refusing: a scope that cannot be read is not an empty scope`,
        );
      } else {
        const probe = spawnSync(process.execPath, [fileURLToPath(new URL("./test-changed.mjs", import.meta.url)), "--base", changedBase, "--json", "--allow-unmapped"], { encoding: "utf8" });
        try {
          const answer = JSON.parse(probe.stdout);
          changed = answer.changed ?? [];
          unmapped = answer.unmapped ?? [];
        } catch {
          scopeProblems.push(`the changed-path map could not be computed against '${changedBase}' (exit ${probe.status}) — whether every changed source has a test is NOT known here, and an unknown scope is not an empty one`);
        }
      }
    }
    const { manifest, written } = aggregateTierRecords({
      tierDir,
      records,
      gate,
      tree,
      sourceTree,
      sha: flag("sha", ""),
      classified,
      changed,
      unmapped,
      base: changedBase ?? "",
      treeDirty: argv.includes("--tree-dirty") ? true : null,
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
  if (command === "source-tree") {
    const target = file || gitTree();
    const st = computeSourceTree(target);
    if (!st) {
      console.error(`gate-manifest: unable to compute source-tree for '${target}'`);
      process.exit(1);
    }
    console.log(st);
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
