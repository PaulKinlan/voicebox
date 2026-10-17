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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIER_WORKERS } from "../scripts/test-shards.mjs";
import { findBrowserBinary } from "../lib/browser-binaries.mjs";
import { runOwnedShard } from "./lib/run-owned-shard.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = path.join(root, "tools/browser-shard-runner.mjs");
// The cheapest browser-lane file measured on this tree (~0.2s): this test is about the runner's
// accounting, not about any one fixture's behaviour.
const PROBE = "tests/wasm-room-ui.test.mjs";
const WEDGE_RUNNER = path.join(root, "tests/fixtures/nested-shard-wedge.mjs");
const HELD_FILE_PRELOAD = new URL("./fixtures/held-shard-file.mjs", import.meta.url).href;

const runRunner = (args, env = {}, options = {}) =>
  runOwnedShard(options.entry ?? RUNNER, args, {
    cwd: root, env: { ...process.env, ...env }, ...options,
  });

// ps includes zombies, which are already terminated but still hold a PID until collected.
// Check the whole detached group, not just its leader: a surviving renderer/child is a leak.
function activeInGroup(pgid) {
  const result = spawnSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8", timeout: 1000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").some((line) => {
    const [, group, state] = /^\s*(\d+)\s+(\S+)/.exec(line) ?? [];
    return Number(group) === pgid && !state?.startsWith("Z");
  });
}

test("the runner takes the browser width from the ONE OWNER, and carries no default of its own", async () => {
  // WHY THIS ARM EXISTS (voicebox-beads-q4j6). `scripts/gate-tier.mjs` spawns this runner with NO
  // `--workers`, so a fallback inside the runner IS the full gate's browser width - which is how
  // `TIER_WORKERS.browser` and the number the tier actually ran at became two facts that had drifted apart,
  // with the gate's own log line printing the wrong one. Behaviour below proves the runner now reads the
  // owner's number when nothing overrides it; the source arm refuses the literals that could drift again
  // (a second `?? 2` would pass the behavioural arm by coincidence, and a `?? 4` would pass it only until
  // someone changed the owner).
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-"));
  const recordPath = path.join(dir, "browser-tier.json");
  const env = { ...process.env, VOICEBOX_GATE_TIER_RECORD: recordPath };
  // The override must be ABSENT, not empty: `??` keeps an empty string, and Number("") is 0.
  delete env.VOICEBOX_SHARD_WORKERS;
  try {
    const res = await runRunner(["--only", PROBE], env);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /warm browser started/, "the probe's custom window dimensions require a standalone browser");
    assert.ok(
      res.stdout.includes(`[shards] ${TIER_WORKERS.browser} worker(s)`),
      `with no --workers and no env override, the runner runs at the one owner's width — stdout was ${JSON.stringify(res.stdout.slice(0, 400))}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const source = readFileSync(RUNNER, "utf8");
  assert.match(source, /VOICEBOX_SHARD_WORKERS \?\? TIER_WORKERS\.browser/, "the runner reads TIER_WORKERS.browser - the one owner in scripts/test-shards.mjs");
  assert.equal(
    /VOICEBOX_SHARD_WORKERS\s*\?\?\s*\d/.test(source),
    false,
    "and it carries no numeric default beside the owner: the gate spawns it without --workers, so that literal would be the real width while the gate logs the owner's",
  );
});

test("the runner emits a hub marker per file, and publishes a tier record a manifest can fold in", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-"));
  const recordPath = path.join(dir, "browser-tier.json");
  try {
    const res = await runRunner(["--only", PROBE, "--workers", "1"], { VOICEBOX_GATE_TIER_RECORD: recordPath });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    // The markers are the hub's vocabulary, anchored at line start. A marker nested inside other text is
    // not a marker to the extractor, so the anchor is the assertion.
    const lines = res.stdout.split("\n");
    assert.ok(lines.includes(`[shards] running ${PROBE}`), "progress is a plain line");
    assert.ok(lines.includes(`fast-gate: passed: ${PROBE}`), "its terminal status is published as a marker");
    // The hub's extractor reads `running:` as proof the suite EXECUTED, so publishing it for a file a kill
    // can interrupt is a coverage claim nothing can retract (see scripts/gate-manifest.mjs).
    assert.equal(lines.some((l) => l.startsWith("fast-gate: running:")), false, "a killed file must leave no coverage claim");
    assert.match(res.stdout, /\[shards\] coverage ok: 1 result\(s\) for 1 queued file\(s\)/);

    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.tier, "browser");
    assert.equal(record.files.length, 1);
    const [entry] = record.files;
    assert.equal(entry.path, PROBE);
    assert.ok(["passed", "failed", "unknown"].includes(entry.status), entry.status);
    assert.equal(entry.timeout_ms, 300_000, "the record carries the bound the child ran under");
    assert.ok(entry.secs > 0);
    // WHAT THE BOX WAS DOING AROUND THIS FILE (voicebox-beads-zjpm.6): both ends of the child's own window,
    // each a reading or an honest null (a platform that reports no load average) — never a zero standing in
    // for "not measured". And a PASSING file gets no load line in the log, because the line means "read this
    // failure", so it must not appear for a file nobody has to read.
    assert.ok(entry.loadavg_1m, "the record names the window the file ran in");
    assert.deepEqual(Object.keys(entry.loadavg_1m), ["start", "end"], "both ends, and nothing else");
    for (const end of ["start", "end"]) {
      assert.ok(entry.loadavg_1m[end] === null || entry.loadavg_1m[end] >= 0, `${end} is a non-negative reading or null, got ${entry.loadavg_1m[end]}`);
    }
    assert.equal(res.stdout.includes("host loadavg"), false, "a passing file gets no load line — the line belongs to failures");
    // A tier record is not a manifest: it names its own tier and carries no roster claim, because only the
    // one aggregator (scripts/gate-manifest.mjs) may answer for the whole gate's scope.
    assert.equal(record.classifier, undefined);
    assert.equal(record.reconciled, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nested fixture deadline lets its runner reap separately detached groups and preserves the red verdict", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-wedge-"));
  let owned;
  try {
    const result = await runRunner([], { VOICEBOX_C0IN_FIXTURE_DIR: dir }, {
      entry: WEDGE_RUNNER, timeoutMs: 4000, graceMs: 5000,
      onOutput({ stdout, expire }) {
        if (stdout.includes("[shards] running synthetic held file")) expire();
      },
    });
    owned = JSON.parse(readFileSync(path.join(dir, "pids.json"), "utf8"));
    for (const [role, pid] of Object.entries({ runner: owned.runner, warm: owned.warm, file: owned.file })) {
      const until = Date.now() + 1000;
      while (activeInGroup(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(activeInGroup(pid), false, `${role} process group ${pid} survived its fixture's timeout`);
    }
    assert.equal(existsSync(owned.profile), false, "the nested runner also reaps its warm profile");
    assert.equal(result.timedOut, true, "a held nested file must expire its fixture's deadline");
    assert.notEqual(result.status, 0, "a timed-out fixture cannot become a passing gate");
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.doesNotMatch(result.stdout, /^fast-gate: passed:/m);
  } finally {
    // An intentionally broken implementation must not leak the negative-control descendants.
    if (owned) for (const pid of [owned.warm, owned.file]) {
      const args = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
      if (args.status === 0 && args.stdout.includes(`${owned.token}-`)) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held real browser file times out UNKNOWN and reaps its runner, Chromium and test groups", { timeout: 40000 }, async (t) => {
  if (!findBrowserBinary()) return t.skip("Chromium is not installed");
  const file = "tests/acp-browser.test.mjs";
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-real-wedge-"));
  const pidFile = path.join(dir, "held-file-pids");
  const heldPids = () => existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").map(Number).filter(Boolean) : [];
  const pgidOf = (pid) => {
    const ps = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
    return ps.status === 0 ? Number(ps.stdout.trim()) || 0 : 0;
  };
  const groupOf = (pid) => {
    const pgid = pgidOf(pid);
    assert.ok(pgid > 0, `cannot identify file child ${pid}'s process group`);
    return pgid;
  };
  let runnerPid, warmPid, filePgid, profile, expire, armed = false, armError;
  const arm = () => {
    if (armed || !runnerPid || !warmPid || !expire) return;
    const heldPid = heldPids().find((pid) => pid !== runnerPid && pid !== warmPid);
    if (!heldPid) return; // the runner's --only argv must never stand in for a file child
    try {
      const child = spawnSync("ps", ["-o", "args=", "-p", String(heldPid)], { encoding: "utf8", timeout: 1000 });
      assert.equal(child.status, 0, `held PID ${heldPid} must still be an ACP file child`);
      assert.match(child.stdout, /acp-browser\.test\.mjs/, "the recorded PID belongs to the ACP file child");
      const profiles = readdirSync(dir).filter((name) => name.startsWith("voicebox-shard-chrome-"));
      assert.equal(profiles.length, 1, "a real warm Chromium profile exists before timeout");
      profile = path.join(dir, profiles[0]);
      filePgid = groupOf(heldPid); // snapshot before the signal can reparent the child to init
      assert.notEqual(filePgid, runnerPid, "held file lives in the test supervisor's separate group");
      assert.notEqual(filePgid, warmPid, "test child does not share the warm browser's group");
      armed = true;
      expire(); // the same path the 240s fixture deadline takes, without waiting 240s
    } catch (error) {
      armError = error;
      armed = true;
      expire(); // still release our browser if the readiness assertion fails
    }
  };
  const observer = watch(dir, arm);
  const readinessFallback = setInterval(arm, 200); // bounded predicate if fs.watch coalesces the PID-file event
  try {
    const result = await runRunner(["--only", file, "--workers", "1"], {
      TMPDIR: dir,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${HELD_FILE_PRELOAD}`.trim(),
      VOICEBOX_SHARD_HELD_PID_FILE: pidFile,
      VOICEBOX_GATE_TIER_RECORD: path.join(dir, "tier.json"),
    }, {
      timeoutMs: 24000, graceMs: 5000,
      onOutput({ stdout, pid, expire: expireNow }) {
        runnerPid = pid;
        warmPid = Number(/\[shards\] warm browser started for worker 0 pid=(\d+)/.exec(stdout)?.[1]) || warmPid;
        expire = expireNow;
        arm(); // also covers a PID file created before this output callback
      },
    });
    observer.close();
    assert.ifError(armError);
    assert.ok(armed && runnerPid && warmPid && filePgid && profile, `no distinct real runner/browser/file groups before deadline: ${result.stdout}`);
    assert.equal(result.timedOut, true);
    assert.notEqual(result.status, 0, "a timed-out fixture is never a pass");
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.ok(result.stdout.includes(`[shards] running ${file}`), "the held file was dispatched");
    assert.ok(result.stdout.includes(`fast-gate: unknown: ${file}`), "the actual runner reports no test counts as UNKNOWN");
    assert.match(result.stdout, /\[shards\] FAILED: tests\/acp-browser\.test\.mjs \(exit \d+: no test counts were reported\)/);
    assert.equal(result.stdout.split("\n").includes(`fast-gate: passed: ${file}`), false, "timeout must not publish a passing marker");
    const record = JSON.parse(readFileSync(path.join(dir, "tier.json"), "utf8"));
    assert.deepEqual(record.files.map(({ path: name, status, counts }) => ({ name, status, counts })), [
      { name: file, status: "unknown", counts: null },
    ]);
    const until = Date.now() + 1200;
    while ([runnerPid, warmPid, filePgid].some(activeInGroup) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    for (const [role, pgid] of Object.entries({ runner: runnerPid, chromium: warmPid, file: filePgid })) {
      assert.equal(activeInGroup(pgid), false, `${role} process group ${pgid} survived the nested fixture timeout`);
    }
    assert.equal(existsSync(profile), false, "the runner removed its actual warm Chromium profile");
  } finally {
    clearInterval(readinessFallback);
    observer.close();
    // A failing guard must not itself strand a Chrome or test child. Never target our own group.
    const selfGroup = pgidOf(process.pid);
    const groups = [warmPid, runnerPid, filePgid];
    for (const pid of heldPids()) if (pid !== runnerPid && pid !== warmPid) groups.push(pgidOf(pid));
    for (const pgid of new Set(groups.filter((id) => id && id !== selfGroup))) {
      let running = true; // a failed ps lookup is not evidence a group has exited
      try { running = activeInGroup(pgid); } catch { /* still attempt to reap our known group */ }
      if (running) {
        try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two real default-option files reuse one warm browser and still report independent results", async (t) => {
  if (!findBrowserBinary()) return t.skip("Chromium is not installed");
  const first = "tests/acp-browser.test.mjs";
  const second = "tests/opfs-append.test.mjs";
  const res = await runRunner(["--only", first, "--only", second, "--workers", "1"], {
    VOICEBOX_SHARED_CDP_URL: "ws://127.0.0.1:1/inherited-must-not-escape",
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal((res.stdout.match(/\[shards\] warm browser started for worker 0 pid=/g) ?? []).length, 1, "one warm process spans two test-file Node processes");
  for (const file of [first, second]) assert.ok(res.stdout.includes(`fast-gate: passed: ${file}`), `${file} still executed and passed`);
  assert.match(res.stdout, /coverage ok: 2 result\(s\) for 2 queued file\(s\)/);
});

test("a real picked-folder permission check keeps its dedicated Chromium", async (t) => {
  if (!findBrowserBinary()) return t.skip("Chromium is not installed");
  // An off-the-record warm context keeps the dropped folder's read grant across reload,
  // breaking N20's named needs-gesture assertion. Run the actual check through the normal
  // shard path, not --cold-browsers: source eligibility must refuse the pool itself.
  const file = "tests/n20-picked-root.test.mjs";
  const res = await runRunner(["--only", file, "--workers", "1"]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.ok(res.stdout.includes(`fast-gate: passed: ${file}`), "the picked-folder assertions ran and passed");
  assert.doesNotMatch(res.stdout, /\[shards\] warm browser started/, "native folder permissions need a dedicated browser process");
  assert.match(res.stdout, /tests=6 pass=6 fail=0 skipped=0 files-failed=0/, "all six checks kept their assertions");
});

test("a crashed warm Chromium is replaced before the next file and the first failure stays red", { timeout: 60000 }, async (t) => {
  if (!findBrowserBinary()) return t.skip("Chromium is not installed");
  // buildQueue orders the longer OPFS file before the shorter ACP file, regardless of CLI order.
  const first = "tests/opfs-append.test.mjs";
  const next = "tests/acp-browser.test.mjs";
  const child = spawn(process.execPath, [RUNNER, "--only", first, "--only", next, "--workers", "1"], {
    cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env },
  });
  let output = "", killed = false;
  const watch = (chunk) => {
    output += String(chunk);
    const pid = Number(/\[shards\] warm browser started for worker 0 pid=(\d+)/.exec(output)?.[1]);
    if (!killed && pid && output.includes(`[shards] running ${first}`)) {
      killed = true;
      process.kill(-pid, "SIGKILL"); // Chromium owns its own process group; the runner and file remain alive.
    }
  };
  child.stdout.on("data", watch);
  child.stderr.on("data", watch);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      reject(new Error(`warm crash control exceeded 55s: ${output.slice(-1000)}`));
    }, 55_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => { clearTimeout(timer); resolve(status); });
  });
  assert.equal(killed, true, output);
  assert.equal(code, 1, "the first file's browser crash cannot be laundered into a green tier");
  assert.ok(output.includes(`fast-gate: failed: ${first}`), output.slice(-1000));
  assert.ok(output.includes(`fast-gate: passed: ${next}`), output.slice(-1000));
  assert.equal((output.match(/\[shards\] warm browser started for worker 0 pid=/g) ?? []).length, 2, `the next file gets a fresh process:\n${output.slice(-3000)}`);
});

test("a phase invocation runs exactly its own slice, namespaces its tier record, and says so", async () => {
  // The live-tier supervisor runs this tier twice — the parallel queue beside the server pool, then the
  // isolated files alone — so the phase must be explicit in the log, in the record's name, and in what is
  // queued. The two invocations together are the lane; that partition is splitQueue's property, held by
  // tests/test-shards.test.mjs.
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-phase-"));
  const recordPath = path.join(dir, "tier.json");
  try {
    const res = await runRunner(["--parallel-only", "--only", PROBE, "--workers", "1"], { VOICEBOX_GATE_TIER_RECORD: recordPath });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /phase parallel, wall/);
    assert.ok(res.stdout.includes(`fast-gate: passed: ${PROBE}`));

    // One record PER PHASE: if both invocations wrote one path the second would overwrite the first and the
    // union would be short by a whole phase.
    const phased = path.join(dir, "tier.parallel.json");
    const record = JSON.parse(readFileSync(phased, "utf8"));
    assert.equal(record.phase, "parallel");
    assert.deepEqual(record.files.map((f) => f.path), [PROBE]);
    assert.throws(() => readFileSync(recordPath, "utf8"), "the un-namespaced path must not be written by a phase run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a phase refuses a file outside it, and the two phases may not be asked for at once", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-phase2-"));
  const recordPath = path.join(dir, "tier.json");
  try {
    // PROBE is a parallel file, so the isolated phase has nothing to run — and nothing may open a browser.
    const wrongPhase = await runRunner(["--isolated-only", "--only", PROBE], { VOICEBOX_GATE_TIER_RECORD: recordPath });
    assert.equal(wrongPhase.status, 2);
    assert.match(wrongPhase.stderr, /is not in the browser lane's isolated phase/);
    assert.throws(() => readFileSync(recordPath, "utf8"), "a refusal writes no tier record");

    const both = await runRunner(["--parallel-only", "--isolated-only"]);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /mutually exclusive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not in the browser lane is refused before a browser opens", async () => {
  const res = await runRunner(["--only", "tests/test-lanes.test.mjs"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /is not in the browser lane; nothing to run/);
  assert.equal(res.stdout.includes("fast-gate:"), false, "nothing was dispatched, so nothing claims to have run");
});

// ── THE BOX, IN THE TIER RECORD AND IN THE FAILURE BLOCK (voicebox-beads-zjpm.6) ────────────────
// The same file measured 12.2s at four-way idle and 39.1s in a loaded gate, and the artifact held only the
// 39.1s, so the one question worth asking about a red browser file — was it the file or the box — needed a
// re-run to answer. These two arms hold both halves: the record carries the window the file ran in, and the
// failure block prints it. The negative half matters as much: a PASSING file must not grow a load line, or
// the line stops meaning "read this one".
test("the tier record carries the load window each file ran in", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-load-"));
  const recordPath = path.join(dir, "browser-tier.json");
  try {
    const res = await runRunner(["--only", PROBE, "--workers", "1"], { VOICEBOX_GATE_TIER_RECORD: recordPath });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const [entry] = JSON.parse(readFileSync(recordPath, "utf8")).files;
    assert.ok(entry.loadavg_1m, "the record names the window the file ran in");
    assert.deepEqual(Object.keys(entry.loadavg_1m), ["start", "end"], "both ends, and nothing else");
    for (const end of ["start", "end"]) {
      // A reading or an honest null (a platform that reports no load average). Never a zero standing in for
      // "not measured": this assert is what stops a 0 being written by a template that defaulted.
      assert.ok(entry.loadavg_1m[end] === null || entry.loadavg_1m[end] >= 0, `${end} is a non-negative reading or null, got ${entry.loadavg_1m[end]}`);
    }
    assert.equal(res.stdout.includes("host loadavg"), false, "a passing file gets no load line — the line belongs to failures");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a FAILING file's block prints what the box was doing, and says it is not a waiver", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-shard-loadfail-"));
  const recordPath = path.join(dir, "browser-tier.json");
  try {
    // A real failure through the real runner, without waiting five minutes: the bound is a flag, so the child
    // is killed and the file ends `unknown`/failed exactly as a starved file would.
    const res = await runRunner(["--only", PROBE, "--workers", "1", "--file-timeout-ms", "1"], { VOICEBOX_GATE_TIER_RECORD: recordPath });
    assert.notEqual(res.status, 0, "a killed file is a red file");
    const block = res.stdout.slice(res.stdout.indexOf(`[shards] ---- output of ${PROBE} ----`));
    assert.ok(block.length > 0, `the failure block is printed: ${res.stdout}`);
    assert.match(
      block,
      /\[shards\] host loadavg \(1m\) start (\d+(\.\d+)?|\?) end (\d+(\.\d+)?|\?) on \d+ cpu\(s\) — a reading, not a waiver: a loaded box is still a red gate/,
      `the load line sits inside the failure block: ${block.slice(0, 400)}`,
    );
    const failed = JSON.parse(readFileSync(recordPath, "utf8")).files.find((f) => f.path === PROBE);
    assert.ok(failed.loadavg_1m && "start" in failed.loadavg_1m, "and the record keeps the window even though the child was killed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
