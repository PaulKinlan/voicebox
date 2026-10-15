import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { attachConditionRecord, measureSuite, writeConditionRecord } from "../scripts/suite-conditions.mjs";
import { TIER_WORKERS } from "../scripts/test-shards.mjs";
import { createManifest, recordFile } from "../scripts/gate-manifest.mjs";
import { classify } from "../scripts/test-lanes.mjs";
import { mapToTests } from "../scripts/test-changed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suite = "tests/suite-condition-verdict.test.mjs";
const ok = { code: 0, signal: null, timedOut: false, secs: 0.1, counts: { tests: 1, pass: 1, fail: 0, skipped: 0 } };
const roster = [suite, ...Array.from({ length: TIER_WORKERS.unit - 1 }, (_, n) => `tests/peer-${n}.test.mjs`)];

test("suite-load-holder.mjs rejects invalid load targets before starting burner workers and maps to this focused test", () => {
  const holder = "scripts/suite-load-holder.mjs";
  const child = spawnSync(process.execPath, [holder, "-1"], { cwd: ROOT, timeout: 5000, encoding: "utf8" });
  assert.equal(child.error, undefined, "the holder exits itself rather than hanging behind the heavy queue");
  assert.equal(child.status, 2, "an invalid target is refused before worker threads are created");
  assert.equal(child.stdout, "", "no READY handshake is claimed for an invalid target");
  assert.ok(mapToTests([holder]).includes("suite-conditions.test.mjs"), "the changed-source mapper names this test for the holder");
});

test("three independent arms produce measured records, a named disagreement and a bounded artifact", async () => {
  let calls = 0;
  let stopped = false;
  const record = await measureSuite(suite, {
    tier: "unit", timeoutMs: 1000, targetLoad: 1, readLoad: () => 2, roster, parentHoldsSlot: false,
    runFile: async () => { calls++; return ok; },
    peer: async () => ({ ready: true, holder: "test-peer", isAlive: () => true, stop: () => { stopped = true; } }),
    runTier: async ({ files, workers }) => {
      assert.equal(files[0], suite);
      assert.equal(files.length, workers, "the shard arm uses the existing tier worker width");
      return { files: [{ path: suite, status: "failed", secs: 0.2 }] };
    },
  });
  assert.equal(calls, 2, "standalone and peer-held each run exactly once; shard dispatch is separate");
  assert.equal(stopped, true, "the peer is cleaned up even when the shard disagrees");
  assert.deepEqual(record.conditions.map((arm) => arm.condition), ["standalone", "heavy_slot", "shard_concurrency"]);
  assert.deepEqual(record.conditions.map((arm) => arm.status), ["passed", "passed", "failed"], "a disagreement stays visible in measured arms");
  assert.equal(Object.hasOwn(record, "verdict"), false, "the optional diagnostic cannot masquerade as a gate verdict");
  const manifest = createManifest({ gate: "fast", tree: "a".repeat(40), sha: "abc1234", classified: classify() });
  const folded = recordFile(manifest, { path: suite, dispatch: "ran", status: "passed", secs: 0.2,
    counts: { tests: 1, pass: 1, fail: 0, skipped: 0 }, selection: "changed", conditions: record.conditions });
  assert.equal(folded.condition_verdict.pattern, "concurrency_only_fails", "the schema owner derives the comparison; the runner only supplies arms");
  for (const arm of record.conditions) {
    assert.ok(Number.isInteger(arm.worker_count) && arm.worker_count > 0);
    assert.match(arm.command, /node/);
    if (arm.condition === "heavy_slot") assert.equal(arm.holder, "test-peer");
    assert.equal(typeof arm.loadavg_1m, "object");
    assert.ok(Object.hasOwn(arm.loadavg_1m, "start") && Object.hasOwn(arm.loadavg_1m, "end"));
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-condition-test-"));
  try {
    const artifact = writeConditionRecord(record, dir);
    assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), record);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a holder reporting READY but dropping below target during the suite is not a loaded pass", async () => {
  const readings = [2, 2, 2, 2, 0, 2, 2];
  const record = await measureSuite(suite, {
    tier: "unit", roster, timeoutMs: 1000, targetLoad: 1, parentHoldsSlot: false,
    readLoad: () => readings.shift() ?? 2,
    runFile: async () => ok,
    peer: async () => ({ ready: true, holder: "test-peer", isAlive: () => true, stop() {} }),
    runTier: async () => ({ files: [{ path: suite, status: "passed", secs: 0.1 }] }),
  });
  assert.equal(record.conditions[1].status, "unknown");
});

test("post-slot attachment is atomic, one-shot, and leaves the gate's failed status untouched", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-pending-conditions-"));
  try {
    const file = path.join(dir, "unit.json");
    const original = { tier: "unit", files: [{ path: suite, status: "failed", counts: { tests: 2, pass: 1, fail: 1 }, condition_request: "pending" }] };
    writeFileSync(file, JSON.stringify(original));
    const measured = { status: "passed", secs: 0.1, loadavg_1m: { start: 1, end: 2 }, worker_count: 1, command: `node --test ${suite}` };
    const record = { suite, tier: "unit", conditions: [{ condition: "standalone", ...measured }, { condition: "heavy_slot", ...measured, status: "failed", holder: "synthetic peer" }, { condition: "shard_concurrency", ...measured, worker_count: TIER_WORKERS.unit }] };
    attachConditionRecord(record, file);
    const updated = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(updated.files[0].status, "failed", "a diagnostic cannot turn the original gate green");
    assert.deepEqual(updated.files[0].counts, original.files[0].counts);
    assert.deepEqual(updated.files[0].conditions, record.conditions);
    assert.equal(Object.hasOwn(updated.files[0], "condition_request"), false);
    assert.throws(() => attachConditionRecord(record, file), /no pending failed suite/, "no retry can overwrite the original one-shot measurement");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("peer holder never reached measured load: incomplete, not a waiver or a guessed pass", async () => {
  let calls = 0;
  const record = await measureSuite(suite, {
    tier: "unit", roster, timeoutMs: 1000, readLoad: () => 2, parentHoldsSlot: false,
    runFile: async () => { calls++; return ok; },
    peer: async () => ({ ready: false, reason: "load target not reached" }),
    runTier: async () => ({ files: [{ path: suite, status: "passed", secs: 0.1 }] }),
  });
  assert.equal(calls, 1, "standalone runs once; failed holder is not retried or mistaken for a measurement");
  assert.equal(record.conditions[1].status, "unknown");
  assert.match(record.conditions[1].reason, /load target not reached/);
});

test("a failed peer launch and a thrown shard runner each leave a named unknown arm", async () => {
  const record = await measureSuite(suite, {
    tier: "unit", roster, timeoutMs: 1000, readLoad: () => 2, parentHoldsSlot: false,
    runFile: async () => ok,
    peer: async () => { throw new Error("unavailable queue"); },
    runTier: async () => { throw new Error("child could not start"); },
  });
  assert.deepEqual(record.conditions.map((arm) => arm.status), ["passed", "unknown", "unknown"]);
  assert.match(record.conditions[1].reason, /unavailable queue/);
  assert.match(record.conditions[2].reason, /child could not start/);
});

test("an unnamed ready peer cannot be called a measured loaded arm", async () => {
  let loadedRuns = 0;
  let stopped = false;
  const record = await measureSuite(suite, {
    tier: "unit", roster, timeoutMs: 1000, readLoad: () => 2, targetLoad: 1, parentHoldsSlot: false,
    runFile: async () => { loadedRuns++; return ok; },
    peer: async () => ({ ready: true, isAlive: () => true, stop: () => { stopped = true; } }),
    runTier: async () => ({ files: [{ path: suite, status: "passed", secs: 0.1 }] }),
  });
  assert.equal(loadedRuns, 1, "the suite only ran alone; an unnamed peer is not loaded evidence");
  assert.equal(stopped, true);
  assert.equal(record.conditions[1].status, "unknown");
  assert.equal(record.conditions[1].holder, "none (peer holder not acquired)");
  assert.match(record.conditions[1].reason, /did not identify itself/);
});

test("gate already holding the heavy slot records UNKNOWN, never pretends peer-held load", async () => {
  const record = await measureSuite(suite, {
    tier: "unit", timeoutMs: 1000, readLoad: () => 2, roster, parentHoldsSlot: true,
    runFile: async () => ok,
    peer: async () => { throw new Error("must not enqueue behind its own slot"); },
    runTier: async () => ({ files: [{ path: suite, status: "passed", secs: 0.1 }] }),
  });
  assert.equal(record.conditions[1].status, "unknown");
  assert.match(record.conditions[1].reason, /parent already holds the heavy slot/);
  assert.equal(Object.hasOwn(record, "verdict"), false);
});
