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
import { startServer } from "./lib/server.mjs";
import { bootFence, measureBoundary } from "../lib/fence-provider.mjs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let scratch;
let homes;

test.before(() => {
  // NOT os.tmpdir(): under a systemd --user unit with PrivateTmp=yes the caller's /tmp is
  // HIDDEN in the unit's mount namespace, so a sandbox home under /tmp fails to bind and the
  // unit dies 226/NAMESPACE before the fence runs (k3's S2 finding, 2026-09-23 — the scratch
  // lives in $HOME for that reason, and is removed in after()).
  scratch = mkdtempSync(path.join(os.homedir(), ".voicebox-fence-test-"));
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
  // THE PIN THE POLLUTION NEEDED: the fence's home is under THIS suite's scratch, not the
  // real ~/sandbox-homes. Without it, an import-time capture of VOICEBOX_SANDBOX_HOMES passes
  // every other assertion while writing into the operator's home directory (it did).
  assert.ok(
    out.home.path.startsWith(homes),
    `the fence's home is ${out.home.path} — OUTSIDE this suite's scratch (${homes}); the env var was captured before the override`,
  );
  assert.equal(out.boundary.level, "L1");

  // The decisive case: files and processes FENCED, network PASSED — each named with its measurement.
  assert.equal(out.boundary.axes.files.verdict, "fenced");
  assert.equal(out.boundary.axes.files.measured, true);
  assert.equal(out.boundary.axes.processes.verdict, "fenced");
  assert.equal(out.capability.network.parentLoopback.ok, true, "the fenced probe must read this parent's marker, even without internet");
  assert.equal(out.boundary.axes.network.evidence.parentLoopback.ok, true);
  assert.equal(out.boundary.axes.network.verdict, "passes", "the network is shared, and the report must SAY so");
  assert.equal(out.boundary.axes.network.measured, true);
  assert.ok(/shared|does not bound/i.test(out.boundary.axes.network.note), "the network axis is labelled as not bounded");
  // No axis reads "denied" by silence: each carries a verdict and whether it was measured.
  for (const [name, axis] of Object.entries(out.boundary.axes)) {
    assert.ok(["fenced", "not-fenced", "passes", "partial", "present", "not measured", "unknown"].includes(axis.verdict), `axis ${name} has a named verdict`);
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
  assert.equal(report.axes.network.measured, false, "absent fields are not failed measurements");
  assert.equal(report.axes.network.verdict, "not measured");
});

for (const [name, network, verdict, measured] of [
  ["absent network", {}, "not measured", false],
  ["invalid witness arguments", { parentLoopback: { error: "invalid parent witness arguments — no connection attempted" } }, "not measured", false],
  ["unreachable parent", { parentLoopback: { ok: false, error: "ECONNREFUSED" } }, "unknown", true],
  ["wrong parent marker", { parentLoopback: { ok: false, error: "parent-witness-mismatch" } }, "unknown", true],
  ["offline parent reached", { parentLoopback: { ok: true }, dns: { error: "ENETUNREACH" }, outboundTcp443IpLiteral: { ok: false } }, "passes", true],
  ["external DNS only", { dns: { value: "resolved via 192.0.2.1" } }, "passes", true],
]) test(`network evidence: ${name}`, () => {
  const axis = measureBoundary({ network }).axes.network;
  assert.equal(axis.verdict, verdict);
  assert.equal(axis.measured, measured);
  assert.deepEqual(axis.evidence.parentLoopback, network.parentLoopback, "failed/unavailable witnesses keep their named cause");
  assert.match(axis.note, /internet reach is separate|do not establish unrestricted/, "one route is not unrestricted internet");
});

test("the actual fenced probe rejects a wrong marker, not merely a connected TCP port", async () => {
  let contacts = 0;
  const sockets = new Set();
  const witness = createServer((socket) => {
    contacts++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.end("wrong marker");
  });
  try {
    await new Promise((resolve, reject) => { witness.once("error", reject); witness.listen(0, "127.0.0.1", resolve); });
    const { stdout } = await promisify(execFile)(path.join(REPO, "tools/fence.sh"), [
      path.join(homes, "vb-test-wrong-marker"), "0", "/usr/bin/node", "/probes/sandbox-probe.mjs",
      String(witness.address().port), "a".repeat(32),
    ], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    const network = JSON.parse(stdout).network;
    assert.equal(contacts, 1, "the child really contacted the owned listener");
    assert.equal(network.parentLoopback.ok, false);
    assert.equal(network.parentLoopback.error, "parent-witness-mismatch");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => witness.close(resolve));
  }
});

test("MUTATION (the reviewer's): a fence whose tree is writable reports not-fenced, with the violation named", () => {
  // The reviewer mutated fence.sh's ro-bind to a writable bind and the files axis still read "fenced"
  // — the middle branch let hostHomeGone alone produce it. Now: the measured violation (treeReadOnly
  // false) MUST flip the axis to not-fenced and name the violation, even when the other conditions pass.
  const violated = measureBoundary({
    probe: "sandbox-probe/1",
    when: "now",
    filesystem: { dirs: { "/srv/voicebox": { writable: { value: true } }, "/home/voice": { writable: { value: true } }, "/home": { listable: false } } },
    sandboxHints: { mountSample: { value: ["bwrap"] } },
    network: {},
    tools: {},
  });
  assert.equal(violated.axes.files.verdict, "not-fenced", "a writable tree must NOT read as fenced");
  assert.equal(violated.axes.files.measured, true);
  assert.ok(violated.axes.files.violations?.some((v) => /writable/.test(v)), "the violation is named, not hidden");

  // And an unmeasured axis (a probe that never saw the paths) is not measured, not denied, not fenced.
  const unmeasured = measureBoundary({ probe: "sandbox-probe/1", when: "now", filesystem: { dirs: {} }, sandboxHints: {}, network: {}, tools: {} });
  assert.equal(unmeasured.axes.files.verdict, "not measured");
});

test("declared-and-booted through the registry, the measured boundary survives the read (probe-written, not a file claim)", async () => {
  // The seam wired: POST /api/environments with fence:true boots the fence and stores the MEASURED
  // boundary; GET /api/environments returns it still carrying the probe's report — because the probe
  // is the one writer the read path trusts.
  const ws = path.join(scratch, "server-ws");
  mkdirSync(ws, { recursive: true });
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: ws }, cwd: scratch });
  try {
    const declared = await fetch(`${server.base}/api/environments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "fenced box", kind: "fence", fence: true }),
    }).then((r) => r.json());
    assert.equal(declared.ok, true, `boot failed: ${JSON.stringify(declared)}`);
    assert.equal(declared.booted, true);
    assert.equal(declared.environment.boundary?.measuredBy, "probe", "the stored boundary is the probe's, provenance-tagged");
    assert.equal(declared.environment.boundary?.axes?.network?.verdict, "passes");
    assert.equal(declared.environment.boundary?.axes?.network?.evidence?.parentLoopback?.ok, true);

    const { environments } = await (await fetch(`${server.base}/api/environments`)).json();
    const row = environments.find((e) => e.label === "fenced box");
    assert.ok(row, "the booted fence is in the list");
    assert.equal(row.boundary?.measuredBy, "probe", "the measured boundary survives the read — it is a measurement, not a file claim");
    assert.equal(row.boundary?.axes?.network?.evidence?.parentLoopback?.ok, true, "the actual route witness survives the registry read");
    assert.ok(row.boundary?.when, "the report's freshness marker travels with it");
  } finally {
    await server.stop();
  }
});

// voicebox-beads-7yv — a metadata-only TCP observation is the THIRD outcome: the attempt
// HAPPENED (so the axis is measured), but a private-route connect is not unrestricted
// internet, and a failed connect is NOT evidence the fence bounds the network. Absent
// evidence stays absent. Nothing here implies credentials were actually read.
test("metadata-only TCP observation: connected is measured, scoped, and never unrestricted", () => {
  const report = measureBoundary({ probe: "sandbox-probe/1", when: "now", filesystem: { dirs: {} }, network: { cloudMetadataService: { ok: true } }, sandboxHints: {}, tools: {} });
  const axis = report.axes.network;
  assert.equal(axis.measured, true, "an attempted connect is a measurement");
  assert.equal(axis.verdict, "passes", "a connected private route means the fence does not bound it");
  assert.equal(axis.evidence.metadataTcp.connected, true);
  assert.match(axis.note, /private-route scope/);
  // The scope disclaimer must be present — and it must be a DISCLAIMER, not a claim:
  assert.match(axis.note, /not unrestricted-internet reachability/);
  assert.match(axis.note, /not proof credentials were read/);
  assert.match(axis.how, /metadata-service/);
});

test("metadata-only TCP observation: FAILED is happened-and-did-not-pass — measured, never 'passes', never a bound", () => {
  const report = measureBoundary({ probe: "sandbox-probe/1", when: "now", filesystem: { dirs: {} }, network: { cloudMetadataService: { ok: false, error: "connect ETIMEDOUT" } }, sandboxHints: {}, tools: {} });
  const axis = report.axes.network;
  assert.equal(axis.measured, true, "a failed attempt still HAPPENED — it is measured");
  assert.equal(axis.verdict, "unknown", "a failed metadata connect must not read as passes");
  assert.equal(axis.evidence.metadataTcp.connected, false);
  assert.match(axis.evidence.metadataTcp.error, /ETIMEDOUT/);
  assert.match(axis.note, /private-route scope/);
  // And it must not claim the fence bounds the network off one failed connect:
  assert.doesNotMatch(axis.verdict ?? "", /fenced/);
});

test("metadata ABSENT stays absent: not measured, no metadata evidence rendered", () => {
  const report = measureBoundary({ probe: "sandbox-probe/1", when: "now", filesystem: { dirs: {} }, network: {}, sandboxHints: {}, tools: {} });
  const axis = report.axes.network;
  assert.equal(axis.measured, false);
  assert.equal(axis.evidence.metadataTcp, undefined, "absent evidence must not render as an observation");
  assert.doesNotMatch(axis.how, /metadata-service/);
});
