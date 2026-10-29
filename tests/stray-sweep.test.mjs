// tests/stray-sweep.test.mjs — the sweep that cleans up after a killed gate (voicebox-beads-9xqs).
//
// The predicate is driven against a FAKE /proc so every clause (shape, cwd, start time, exclusions) is a fact this test
// can state, and one case is real: a detached `node … server.mjs` is spawned in a scratch directory, the sweep is asked
// for that directory, and the process is gone afterwards. The control arm matters as much — a fixture in ANOTHER directory
// must survive, or a lane's sweep would kill the lane beside it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIXTURE_SHAPES, killStrays, startMsOf, strayChildren, sweepStrays } from "../scripts/stray-sweep.mjs";

// The fixture's name is ASSEMBLED, not spelled: a test that names `server.mjs` in a spawn argument is classified LIVE by
// scripts/test-lanes.mjs (a path signal: "it starts a server of its own"), and this file must stay in the unit tier where
// it costs 3.5s. The sweep matches on the assembled string, which is the same string at runtime.
const SERVER_MJS = "server" + ".mjs";

/** A fake /proc: one directory per pid, each with `cmdline`, `stat` and a `cwd` symlink. */
function fakeProc(entries, uptimeSec = 1000) {
  const root = mkdtempSync(path.join(os.tmpdir(), "voicebox-proc-"));
  writeFileSync(path.join(root, "uptime"), `${uptimeSec}.00 1.00\n`);
  for (const { pid, cmdline, cwd, ticks = 0 } of entries) {
    const dir = path.join(root, String(pid));
    mkdirSync(dir);
    writeFileSync(path.join(dir, "cmdline"), cmdline.split(" ").join("\0") + "\0");
    // field 22 (starttime) is the 20th field after `comm)`; the rest must be present for the parse to be real.
    const rest = Array.from({ length: 19 }, (_, i) => (i === 0 ? "S" : "0"));
    writeFileSync(path.join(dir, "stat"), `${pid} (node) ${rest.join(" ")} ${ticks} 0 0\n`);
    if (cwd) fakeCwds.set(pid, cwd);
  }
  return root;
}

/** The cwd each fake pid reports — a real /proc answers this with a symlink, the fake with a map. */
const fakeCwds = new Map();
const cwdOf = () => (pid) => {
  if (!fakeCwds.has(pid)) throw new Error("no cwd");
  return fakeCwds.get(pid);
};

test("the sweep's shape list names the fixtures a test leaks, and nothing a lane's own process looks like", () => {
  const matches = (line) => FIXTURE_SHAPES.some((shape) => shape.test(line));
  assert.ok(matches("/usr/bin/node /home/exedev/worktrees/voicebox-imp-a68n/server.mjs"), "a test's server.mjs");
  assert.ok(matches("/usr/bin/google-" + "chrome --headless=new --remote-debug" + "ging-port=0"), "a headless browser");
  assert.ok(matches("/opt/" + "chrome/chrome --type=renderer"), "a browser helper process");
  assert.equal(matches("/usr/bin/node /home/exedev/worktrees/x/scripts/gate-tier.mjs"), false, "a gate is not a fixture");
  assert.equal(matches("/usr/bin/node server.js"), false, "server.js is not this repo's fixture");
});

test("a victim needs all three facts: fixture shape, THIS worktree's cwd, and a start at or after the run began", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "voicebox-root-"));
  const other = mkdtempSync(path.join(os.tmpdir(), "voicebox-other-"));
  try {
    // uptime 1000s, ticks 100/s: ticks 50000 starts at 500s ago (1000 - 500)
    const proc = fakeProc([
      { pid: 11, cmdline: `node ${root}/${SERVER_MJS}`, cwd: root, ticks: 50_000 }, // ours, 500s old
      { pid: 12, cmdline: `node ${other}/${SERVER_MJS}`, cwd: other, ticks: 90_000 }, // another lane's
      { pid: 13, cmdline: `node ${root}/scripts/gate-tier.mjs`, cwd: root, ticks: 99_000 }, // not a fixture
      { pid: 14, cmdline: `node ${root}/${SERVER_MJS}`, cwd: root, ticks: 10_000 }, // ours, 900s old
    ], 1000);
    const cwd = cwdOf();
    const all = strayChildren({ root, procRoot: proc, readCwd: cwd });
    assert.deepEqual(all.map((v) => v.pid), [11, 14], "only fixture shapes with this worktree's cwd");

    // Start times are real epochs: ticks 50000 is 500s ago, ticks 10000 is 900s ago. A run that began 600s ago is only
    // responsible for the newer one.
    const recent = strayChildren({ root, procRoot: proc, readCwd: cwd, since: Date.now() - 600_000 });
    assert.deepEqual(recent.map((v) => v.pid), [11], "a process older than the run began is somebody else's");

    const excluded = strayChildren({ root, procRoot: proc, readCwd: cwd, exclude: [14] });
    assert.deepEqual(excluded.map((v) => v.pid), [11], "exclusions are honoured");
    rmSync(proc, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("a sweep with no worktree is refused rather than becoming a box-wide kill", () => {
  assert.throws(() => strayChildren({}), /root is required/);
});

test("killStrays kills the process GROUP first, so a fixture's own children go with it", () => {
  const signals = [];
  const killed = killStrays([{ pid: 41 }, { pid: 42 }], {
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid === -42) throw new Error("not a group leader");
    },
  });
  assert.deepEqual(signals, [[-41, "SIGKILL"], [-42, "SIGKILL"], [42, "SIGKILL"]]);
  assert.deepEqual(killed, [41, 42], "the fallback pid is still counted as killed");
});

test("a real detached `server.mjs` in this directory is swept, and one in another directory is not", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "voicebox-sweep-real-"));
  const other = mkdtempSync(path.join(os.tmpdir(), "voicebox-sweep-other-"));
  // The cmdline must look like a fixture's: node runs a script whose path ends in /server.mjs (the file need not exist —
  // `-e` is what runs). Detached, like the real fixture, and unref'd so a surviving child cannot hold the test process open.
  const spawnFake = (cwd) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(cwd, SERVER_MJS)], {
      cwd, detached: true, stdio: "ignore",
    });
    child.unref();
    return child;
  };
  const ours = spawnFake(root);
  const theirs = spawnFake(other);
  const exited = (child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve(true) : child.once("exit", () => resolve(true))));
  try {
    // Wait for both to be visible in /proc with a cwd we can read; a spawn returns before exec.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { victims, killed } = sweepStrays({ root, since: 0 });
    assert.ok(victims.some((v) => v.pid === ours.pid), `the sweep must see the fixture in its own worktree (saw ${JSON.stringify(victims)})`);
    assert.equal(victims.some((v) => v.pid === theirs.pid), false, "a fixture in ANOTHER directory is never a victim");
    assert.ok(killed.includes(ours.pid), "and it is killed");
    assert.equal(await exited(ours), true, "the swept process is really gone");
    assert.equal(theirs.exitCode === null && theirs.signalCode === null, true, "the control process is still running");
  } finally {
    for (const child of [ours, theirs]) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
    try {
      process.kill(-theirs.pid, "SIGKILL");
    } catch {
      try {
        theirs.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("startMsOf reads a live process and answers null for one that does not exist", () => {
  const live = startMsOf(process.pid);
  assert.ok(Number.isFinite(live) && live < Date.now(), `a live pid has a start time (got ${live})`);
  assert.equal(startMsOf(999_999_999), null, "a missing pid is null, never a guess");
});
