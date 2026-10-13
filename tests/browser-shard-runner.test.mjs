// tests/browser-shard-runner.test.mjs — the browser tier's runner, driven as a child process.
//
// WHY THIS EXISTS (voicebox-beads-zjpm.3): the runner is the only thing that decides which browser files
// ran and how they ended, and it had no test naming it, so `node scripts/test-changed.mjs --gate` refused
// the change that added its coverage markers ("tools/browser-shard-runner.mjs changed and maps to no test
// file"). The refusal was right. A runner whose file set can silently change is the exact thing the shard
// queue asserts against (`assertExactCoverage`), and its LOG is what `fleet-check` reads for coverage, so
// the marker lines are part of the contract too, not decoration.
//
// It is a BROWSER-lane test, and the classifier knows that by name: the runner launches Chromium, so a
// test that spawns it owns a browser. That is why scripts/test-lanes.mjs names it among the browser
// signals rather than guessing from a comment.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = path.join(root, "tools/browser-shard-runner.mjs");
// The cheapest browser-lane file measured on this tree (~0.2s): this test is about the runner's
// accounting, not about any one fixture's behaviour.
const PROBE = "tests/wasm-room-ui.test.mjs";

const runRunner = (args, env = {}) =>
  spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 240_000,
    killSignal: "SIGKILL",
  });

test("the runner emits a hub marker per file, and publishes a tier record a manifest can fold in", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-"));
  const recordPath = path.join(dir, "browser-tier.json");
  try {
    const res = runRunner(["--only", PROBE, "--workers", "1"], { VOICEBOX_GATE_TIER_RECORD: recordPath });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    // The markers are the hub's vocabulary, anchored at line start. A marker nested inside other text is
    // not a marker to the extractor, so the anchor is the assertion.
    const lines = res.stdout.split("\n");
    assert.ok(lines.includes(`fast-gate: running: ${PROBE}`), "the dispatched file is named before it runs");
    assert.ok(lines.includes(`fast-gate: passed: ${PROBE}`), "its terminal status is named after it");
    assert.match(res.stdout, /\[shards\] coverage ok: 1 result\(s\) for 1 queued file\(s\)/);

    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.tier, "browser");
    assert.equal(record.files.length, 1);
    const [entry] = record.files;
    assert.equal(entry.path, PROBE);
    assert.ok(["passed", "failed", "unknown"].includes(entry.status), entry.status);
    assert.equal(entry.timeout_ms, 300_000, "the record carries the bound the child ran under");
    assert.ok(entry.secs > 0);
    // A tier record is not a manifest: it names its own tier and carries no roster claim, because only the
    // one aggregator (scripts/gate-manifest.mjs) may answer for the whole gate's scope.
    assert.equal(record.classifier, undefined);
    assert.equal(record.reconciled, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not in the browser lane is refused before a browser opens", () => {
  const res = runRunner(["--only", "tests/test-lanes.test.mjs"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /is not in the browser lane; nothing to run/);
  assert.equal(res.stdout.includes("fast-gate:"), false, "nothing was dispatched, so nothing claims to have run");
});
