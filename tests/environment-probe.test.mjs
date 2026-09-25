// tests/environment-probe.test.mjs — AUTO-PROBE: the environment's report, observed and recorded.
//
//   node --test tests/environment-probe.test.mjs
//
// Paul's condition on "automatically": the probe runs code inside the environment unprompted, so the
// ACT must be visible in the record. These three hold that: the probe answers a real report (not a
// manifest), the act is appended to the environment's own audit, and the registry carries the report
// so the list can show it without re-running code on every read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

let server;
let BASE;
let scratch;
let workspace;

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-probe-"));
  workspace = path.join(scratch, "workspace");
  // The workspace must EXIST before boot so the server declares it the active machine root —
  // otherwise the environment has no loggable root and the probe's act has nowhere to be recorded.
  mkdirSync(workspace, { recursive: true });
  server = await startServer({ env: { VOICEBOX_WORKSPACE: workspace }, cwd: scratch });
  BASE = server.base;
});

test.after(async () => {
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("GET /api/probe returns an OBSERVED report (identity, tools, network), with its when", async () => {
  const res = await fetch(`${BASE}/api/probe`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const probe = body.probe;
  assert.ok(probe.when, "the report carries when it was taken");
  assert.equal(probe.probe, "sandbox-probe/1", "the report names the probe that produced it");
  // Observed, not configured: the identity and the tools are read from inside the environment.
  assert.ok(probe.identity?.platform, "the report observed the platform it ran on");
  assert.ok(probe.tools && typeof probe.tools === "object", "the report lists tools as data");
  assert.ok(probe.network && typeof probe.network === "object", "the report lists the network axes as data");
  // Cached with its when: a second read does not re-run the probe.
  const again = await (await fetch(`${BASE}/api/probe`)).json();
  assert.equal(again.cached, true, "a repeat read serves the cached report rather than re-running code");
  assert.equal(again.probe.when, probe.when, "the cached report is the same observation");
});

test("the probe's act is recorded in the environment's own audit (it ran unprompted)", async () => {
  // The server declares its workspace as the active machine root on boot (VOICEBOX_WORKSPACE), so
  // the audit lives in that root's .audit/.
  await fetch(`${BASE}/api/probe`);
  const auditDir = path.join(workspace, ".audit");
  assert.ok(existsSync(auditDir), "the environment keeps an audit in its root");
  const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length > 0, "the audit has at least one writer's file");
  const entries = files.flatMap((f) =>
    readFileSync(path.join(auditDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  );
  const probeAct = entries.find((e) => e.kind === "activity" && /probed itself/.test(e.activity?.doing ?? ""));
  assert.ok(probeAct, "the audit records that the environment probed itself, and when");
  assert.match(probeAct.activity?.target ?? "", /sandbox-probe/, "the record names what ran");
});

test("the registry carries the probed report, so the list shows it without re-running", async () => {
  await fetch(`${BASE}/api/probe`);
  const { environments } = await (await fetch(`${BASE}/api/environments`)).json();
  const local = environments.find((e) => e.key === "local");
  assert.ok(local.capability, "the local environment's row carries the capability report");
  assert.equal(local.capability.probe, "sandbox-probe/1");
  assert.ok(local.capability.when, "the report in the row carries its freshness marker");
});

test("sandbox probe sweeps dead-PID markers and preserves live ones (voicebox-beads-ebq)", async () => {
  const { sweepOrphanedProbeMarkers, isPidDead } = await import("../tools/sandbox-probe.mjs");
  const testDir = mkdtempSync(path.join(os.tmpdir(), "voicebox-probe-sweep-"));
  try {
    let deadPid = 9999999;
    while (!isPidDead(deadPid)) deadPid++;

    const deadMarker = path.join(testDir, `.sandbox-probe-${deadPid}-20260925180000000`);
    const liveMarker = path.join(testDir, `.sandbox-probe-${process.pid}-20260925180000000`);
    const unrelatedFile = path.join(testDir, "normal-file.txt");

    writeFileSync(deadMarker, "probe\n");
    writeFileSync(liveMarker, "probe\n");
    writeFileSync(unrelatedFile, "data\n");

    sweepOrphanedProbeMarkers(testDir);

    assert.equal(existsSync(deadMarker), false, "dead PID probe marker must be swept");
    assert.equal(existsSync(liveMarker), true, "live PID probe marker must be preserved");
    assert.equal(existsSync(unrelatedFile), true, "unrelated files must not be touched");

    rmSync(liveMarker, { force: true });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
