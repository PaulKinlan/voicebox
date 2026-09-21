// tests/fence-provider.test.mjs — S1: descriptor in, a booted L1 fence out, boundary MEASURED.
//
//   node --test tests/fence-provider.test.mjs
//
// The head of the sandbox-levels epic (voicebox-beads-wpv / dkt), from the environments plan §5: a
// sandbox level is a MEASURED per-axis report, not a configured label. The case that proves it is
// the L1 bwrap fence: it bounds files and processes and PASSES THE NETWORK — so the report must say
// "network: passes" with the measurement, never "fenced". An axis the probe did not measure says
// "not measured", never "denied".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootFence, measureBoundary } from "../lib/fence-provider.mjs";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let scratch;
let homes;

test.before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-fence-"));
  homes = path.join(scratch, "sandbox-homes");
  mkdirSync(homes, { recursive: true });
  process.env.VOICEBOX_SANDBOX_HOMES = homes;
});

test.after(() => {
  rmSync(scratch, { recursive: true, force: true });
  delete process.env.VOICEBOX_SANDBOX_HOMES;
});

test("boots an L1 fence from a descriptor and returns a MEASURED per-axis boundary", async () => {
  const out = await bootFence({ key: "vb-test-measure", label: "measure" });
  assert.ok(out.ok, `the fence did not boot: ${JSON.stringify(out)}`);
  assert.match(out.origin, /^http:\/\/127\.0\.0\.1:\d+$/, "the origin is a loopback URL on a free port");
  assert.equal(out.home.kind, "machine");
  assert.equal(out.boundary.level, "L1");

  // The decisive case: files and processes FENCED, network PASSED — each named with its measurement.
  assert.equal(out.boundary.axes.files.verdict, "fenced");
  assert.equal(out.boundary.axes.files.measured, true);
  assert.equal(out.boundary.axes.processes.verdict, "fenced");
  assert.equal(out.boundary.axes.network.verdict, "passes", "the network is shared, and the report must SAY so");
  assert.equal(out.boundary.axes.network.measured, true);
  assert.ok(/shared|does not bound/i.test(out.boundary.axes.network.note), "the network axis is labelled as not bounded");
  // No axis reads "denied" by silence: each carries a verdict and whether it was measured.
  for (const [name, axis] of Object.entries(out.boundary.axes)) {
    assert.ok(["fenced", "passes", "partial", "present", "not measured", "unknown"].includes(axis.verdict), `axis ${name} has a named verdict`);
    assert.equal(typeof axis.measured, "boolean", `axis ${name} says whether it was measured`);
  }
  // The capability report is the probe's own — observed, not configured.
  assert.equal(out.capability.probe, "sandbox-probe/1");
});

test("a turn's write lands in the sandbox home and reads back off host disk; the host tree is untouched", async () => {
  const out = await bootFence({ key: "vb-test-write", label: "write" });
  assert.ok(out.ok);
  // Write from INSIDE the fence into its home, read it off the host's disk.
  const { execFileSync } = await import("node:child_process");
  execFileSync(path.join(REPO, "tools", "fence.sh"), [path.join(homes, "vb-test-write"), "0", "/usr/bin/node", "-e",
    "require('fs').writeFileSync('/home/voice/workspace/proof.txt', 'from inside\\n')"], { cwd: REPO });
  const onDisk = path.join(homes, "vb-test-write", "workspace", "proof.txt");
  assert.ok(existsSync(onDisk), "the file landed in the sandbox's home");
  assert.equal(readFileSync(onDisk, "utf8"), "from inside\n");
  // The host tree is untouched: nothing leaked into the repo's workspace.
  assert.ok(!existsSync(path.join(REPO, "workspace", "proof.txt")), "the host tree is untouched");
});

test("measureBoundary never lets an unmeasured axis read as denied", () => {
  // A probe with no network field must report the axis as not-measured, not denied.
  const report = measureBoundary({ probe: "sandbox-probe/1", when: "now", filesystem: { dirs: {} }, network: {}, sandboxHints: {}, tools: {} });
  for (const axis of Object.values(report.axes)) {
    assert.notEqual(axis.verdict, "denied", "no axis is ever reported 'denied' — the fence either measured it or says not-measured");
  }
});
