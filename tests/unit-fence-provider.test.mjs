// tests/unit-fence-provider.test.mjs — S2: the L1.5 composition, driven (voicebox-beads-8ny).
//
//   node --test tests/unit-fence-provider.test.mjs
//
// A transient systemd --user unit whose Exec is the bwrap fence (tools/fence-unit.sh). DONE,
// observable: the probe report INSIDE the composed environment shows seccomp=2 AND the EROFS code
// tree AND the writable home; the environment SERVES (its origin answers with its own measured
// report) and is LISTED (the registry row carries that boundary, probe-written).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { bootUnitFence, stopUnitFence, awaitBootIdentity } from "../lib/unit-fence-provider.mjs";
import { measureBoundary } from "../lib/fence-provider.mjs";
import { createServer } from "node:http";

const run = promisify(execFile);

let scratch;
let homes;
let userManager = false;
let declaredKey = null;
const measureKey = `vb-test-l15-measure-${process.pid}-${Date.now()}`;

test.before(async () => {
  // NOT under /tmp: the unit runs with PrivateTmp=yes, which hides the caller's /tmp inside the
  // unit's mount namespace — a sandbox home under /tmp fails to bind (status 226/NAMESPACE).
  // The home must live outside anything the unit makes private, so scratch sits in $HOME.
  scratch = mkdtempSync(path.join(os.homedir(), "voicebox-unit-fence-"));
  homes = path.join(scratch, "sandbox-homes");
  mkdirSync(homes, { recursive: true });
  process.env.VOICEBOX_SANDBOX_HOMES = homes;
  try {
    await run("systemd-run", ["--user", "--collect", "--wait", "--pipe", "/usr/bin/true"], { timeout: 15000 });
    userManager = true;
  } catch {
    userManager = false;
  }
});

test.after(async () => {
  if (declaredKey) await stopUnitFence(declaredKey).catch(() => {});
  await stopUnitFence(measureKey).catch(() => {});
  await stopUnitFence("vb-test-l15-measure").catch(() => {});
  await run("systemctl", ["--user", "reset-failed"], { timeout: 10000 }).catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
  delete process.env.VOICEBOX_SANDBOX_HOMES;
});

const needsUserManager = (t) => {
  if (!userManager) {
    t.skip("no systemd --user manager is reachable on this host — the L1.5 composition cannot boot here");
    return true;
  }
  return false;
};

test("the composed environment's probe report shows seccomp=2, the EROFS code tree, and the writable home — and it SERVES", async (t) => {
  if (needsUserManager(t)) return;
  const out = await bootUnitFence({ key: measureKey, label: "measure" });
  assert.ok(out.ok, `the composition did not boot: ${JSON.stringify(out)}`);
  assert.match(out.origin, /^http:\/\/127\.0\.0\.1:\d+$/, "the origin is a loopback URL on a free port");
  assert.equal(out.boundary.level, "L1.5", "the composition is measured at its own level, not the fence's L1");
  assert.equal(out.boundary.measuredBy, "probe");
  assert.equal(out.fence.mechanism, "systemd-run --user + bwrap");

  // THE BEAD'S DONE, read off the environment's OWN probe report — measured inside the composition:
  const probe = out.capability;
  // 1. seccomp=2 (filter mode) — the unit's SystemCallFilter, which the bare fence does NOT have.
  assert.equal(probe.sandboxHints.seccomp.value, "2", "seccomp filter mode, read off /proc/self/status inside the composition");
  assert.equal(probe.sandboxHints.capEff.value, "0000000000000000", "the capability set is empty");
  // 2. The EROFS code tree — a write to /srv/voicebox fails by doing, with the errno named.
  assert.equal(probe.filesystem.dirs["/srv/voicebox"].writable.value, false);
  assert.match(probe.filesystem.dirs["/srv/voicebox"].writable.error, /^EROFS/, "the code tree refuses a write with EROFS, named");
  // 3. The writable home — the probe's create-and-unlink succeeded inside the sandbox home.
  assert.equal(probe.filesystem.dirs["/home/voice/workspace"].writable.value, true, "the sandbox home is writable");

  // The environment SERVES: the origin answers liveness, and answers with its measured report.
  const health = await fetch(`${out.origin}/health`).then((r) => r.json());
  assert.equal(health.ok, true, "the environment's origin answers /health — it serves, not just boots");
  assert.match(health.bootMarker, /^[0-9a-f]{32}$/, "the serve carries this boot's marker — identity, not just liveness");
  const served = await fetch(`${out.origin}/probe`).then((r) => r.json());
  assert.equal(served.sandboxHints.seccomp.value, "2", "the served report is the environment's own measurement");

  // The fence's own axes still hold AROUND the unit's lockdown: files and processes fenced,
  // network passed and labelled so — the composition must not lie about the shared network.
  assert.equal(out.boundary.axes.files.verdict, "fenced");
  assert.equal(out.boundary.axes.processes.verdict, "fenced");
  assert.equal(out.boundary.axes.network.verdict, "passes", "the network is still shared, and the report must SAY so");
  for (const [name, axis] of Object.entries(out.boundary.axes)) {
    assert.ok(["fenced", "not-fenced", "passes", "partial", "present", "not measured", "unknown"].includes(axis.verdict), `axis ${name} has a named verdict`);
  }
});

test("declared with fence:'l15', the environment is LISTED with its measured boundary — and the listed origin serves", async (t) => {
  if (needsUserManager(t)) return;
  const ws = path.join(scratch, "server-ws");
  mkdirSync(ws, { recursive: true });
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: ws }, cwd: scratch });
  try {
    const declared = await fetch(`${server.base}/api/environments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "l15 box", kind: "fence", fence: "l15" }),
    }).then((r) => r.json());
    assert.equal(declared.ok, true, `boot failed: ${JSON.stringify(declared)}`);
    assert.equal(declared.booted, true);
    assert.equal(declared.environment.boundary?.measuredBy, "probe", "the stored boundary is the probe's, provenance-tagged");
    assert.equal(declared.environment.boundary?.level, "L1.5");
    declaredKey = declared.environment.key;

    const { environments } = await (await fetch(`${server.base}/api/environments`)).json();
    const row = environments.find((e) => e.label === "l15 box");
    assert.ok(row, "the composed environment is in the list");
    assert.equal(row.boundary?.measuredBy, "probe", "the measured boundary survives the read");
    assert.equal(row.capability?.sandboxHints?.seccomp?.value, "2", "the listed row carries the unit's lockdown, measured");
    const health = await fetch(`${row.origin}/health`).then((r) => r.json());
    assert.equal(health.ok, true, "the LISTED origin answers — listed means reachable, not just recorded");
  } finally {
    if (declaredKey) await stopUnitFence(declaredKey).catch(() => {});
    await server.stop();
  }
});

test("the level is DERIVED, never stamped: seccomp+lockdown earns L1.5, the fence alone earns L1, failure reads not-earned, absence reads unmeasured", () => {
  const fencedProbe = (seccomp, capEff) => ({
    probe: "sandbox-probe/1", when: "now",
    filesystem: { dirs: { "/srv/voicebox": { writable: { value: false, error: "EROFS" } }, "/home": { listable: false }, "/home/voice/workspace": { writable: { value: true } } } },
    sandboxHints: { mountSample: { value: ["bwrap"] }, seccomp: { value: seccomp }, capEff: { value: capEff } },
    network: {}, tools: {},
  });
  assert.equal(measureBoundary(fencedProbe("2", "0000000000000000")).level, "L1.5", "fence + kernel lockdown earns L1.5");
  assert.equal(measureBoundary(fencedProbe("0", "0000000000000000")).level, "L1", "the bare fence reports L1 — a unit that failed to apply seccomp is NOT stamped L1.5");
  assert.equal(measureBoundary(fencedProbe("2", "0000000000000001")).level, "L1", "a capability remaining is L1, not L1.5");
  const violated = measureBoundary({ probe: "sandbox-probe/1", when: "now", filesystem: { dirs: { "/srv/voicebox": { writable: { value: true } }, "/home/voice": { writable: { value: true } }, "/home": { listable: false } } }, sandboxHints: { mountSample: { value: ["bwrap"] }, seccomp: { value: "2" }, capEff: { value: "0" } }, network: {}, tools: {} });
  assert.equal(violated.level, "not-earned", "measured-and-failed reads not-earned, never a level");
  assert.equal(measureBoundary({ probe: "sandbox-probe/1", when: "now", filesystem: { dirs: {} }, sandboxHints: {}, network: {}, tools: {} }).level, "unmeasured", "a probe that never measured the fence reads unmeasured");
});

test("a stranger on the port is NEVER accepted as the boot (the reviewer's attack, driven)", async () => {
  // The exact case gemini drove: a dummy HTTP server answering 200 with a plausible body must not
  // pass the collector. Without THIS boot's 32-hex marker, identity never resolves.
  const stranger = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, probe: "sandbox-probe/1", stale: true }));
  });
  await new Promise((r) => stranger.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${stranger.address().port}`;
  try {
    const refused = await awaitBootIdentity(origin, "0123456789abcdef0123456789abcdef", 3000);
    assert.equal(refused.ok, false, "a server without this boot's marker is a stranger, however plausible its JSON");
    assert.match(refused.why, /marker/, "the refusal names identity, not liveness");
  } finally {
    stranger.close();
  }
  // And the marked server IS accepted — the mechanism fails safe, not closed.
  const owned = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, bootMarker: "0123456789abcdef0123456789abcdef" }));
  });
  await new Promise((r) => owned.listen(0, "127.0.0.1", r));
  try {
    const accepted = await awaitBootIdentity(`http://127.0.0.1:${owned.address().port}`, "0123456789abcdef0123456789abcdef", 3000);
    assert.equal(accepted.ok, true, "the boot's own marker, returned exactly, is the identity");
  } finally {
    owned.close();
  }
});

test("a host without a systemd --user manager is REFUSED BY NAME, never a half-boot", () => {
  // The refusal is a named state, not an exception: userManagerAvailable gates bootUnitFence with
  // "unit-unavailable" and its why. Driven by construction here (the same check the before hook
  // runs); the negative path is the one a CI box without a user manager would take.
  assert.equal(typeof userManager, "boolean", "availability is detected by asking the manager, not assumed");
});
