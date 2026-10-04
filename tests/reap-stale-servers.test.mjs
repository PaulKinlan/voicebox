// tests/reap-stale-servers.test.mjs — the reaper's selection contract (voicebox-beads-<tbd>)
//
// The reaper SIGKILLs leaked lane servers. Its danger is over-matching: a wrong
// kill takes down a live gate's server or Paul's own process. These tests pin
// every clause of isVictim + selectVictims: kill only voicebox-scoped, old-
// enough, unpinned server shapes; the gate lock skips the whole round; self is
// skipped; out-of-scope is never touched; the canonical checkout gets the long
// floor. Pure — no /proc, no network, no real processes.

import test from "node:test";
import assert from "node:assert/strict";
import { isVictim, selectVictims, checkAndRepairCanonicalGitConfig } from "../scripts/reap-stale-servers.mjs";

const WT = "/home/paulkinlan/worktrees/vb-test";
const CANON = "/home/paulkinlan/voicebox";
const OUT = "/home/paulkinlan/other-project";
const HOUR = 3600;

const victim = (over = {}) => isVictim({ args: "node server.mjs", cwd: WT, ageSec: 5 * HOUR, env: "", markerExists: false, ...over });

test("old scoped server: victim", () => {
  assert.equal(victim(), true);
});

test("young server (under the 4h floor): skipped", () => {
  assert.equal(victim({ ageSec: 3 * HOUR }), false);
  assert.equal(victim({ ageSec: HOUR }), false);
});

test("canonical checkout gets the 24h floor, not 4h", () => {
  assert.equal(victim({ cwd: CANON, ageSec: 5 * HOUR }), false, "5h-old canonical must survive");
  assert.equal(victim({ cwd: CANON + "/sub", ageSec: 25 * HOUR }), true, "25h-old canonical is a victim");
});

test("out-of-scope cwd is never a victim, however old", () => {
  assert.equal(victim({ cwd: OUT, ageSec: 999 * HOUR }), false);
});

test("pinned via VOICEBOX_PINNED=1 is skipped", () => {
  assert.equal(victim({ env: "VOICEBOX_PINNED=1\nPATH=/bin" }), false);
});

test("pinned via .pinned-server marker is skipped", () => {
  assert.equal(victim({ markerExists: true }), false);
});

test("non-server shapes are skipped even when old and scoped", () => {
  assert.equal(victim({ args: "editor.js --watch" }), false);
  assert.equal(victim({ args: "node --test tests/foo.test.mjs" }), false, "a test runner is not a server");
});

test("server shapes all match: server.mjs, vite, serve, deno run", () => {
  assert.equal(victim({ args: "node ./server.mjs" }), true);
  assert.equal(victim({ args: "node node_modules/.bin/vite --port 5174" }), true);
  assert.equal(victim({ args: "node .npm/_npx/x/bin/serve playground -l 8080" }), true);
  assert.equal(victim({ args: "deno run --config deno.json task.ts" }), true);
});

test("scope: /tmp/voicebox-* fixtures are in scope; stale /vb-<id>/ fragments are in scope", () => {
  assert.equal(victim({ cwd: "/tmp/voicebox-d1-http-qjE0iI", ageSec: 99 * HOUR }), true);
  assert.equal(victim({ cwd: "/home/paulkinlan/worktrees/vb-tee (deleted)", ageSec: 99 * HOUR }), true);
  assert.equal(victim({ cwd: "/tmp", ageSec: 99 * HOUR }), false);
});

test("FLEET-WIDE by declaration: a cap worktree server is a victim (astra's blocker pin)", () => {
  assert.equal(victim({ cwd: "/home/paulkinlan/worktrees/cap-x", ageSec: 99 * HOUR }), true);
  assert.equal(
    victim({ cwd: "/home/paulkinlan/worktrees/audiofeed-ds-flash-review-rqp", ageSec: 127 * HOUR }),
    true,
    "the audiofeed process that motivated the fleet-wide declaration must stay a victim",
  );
});

// ── selectVictims: the ps-lines layer ────────────────────────────────────────

const line = (pid, args, ageSec, ppid = 1) => `${pid} ${ppid} ${ageSec} node ${args}`;

test("selectVictims picks the old scoped server and skips the young neighbour", () => {
  const r = selectVictims({
    lines: [line(101, "server.mjs", 5 * HOUR), line(102, "server.mjs", HOUR)],
    cwdFor: () => WT,
  });
  assert.deepEqual(r.victims.map((v) => v.pid), [101]);
});

test("gate lock held skips the whole round", () => {
  const r = selectVictims({
    lines: [line(108, "server.mjs", 99 * HOUR)],
    cwdFor: () => WT,
    gateLockHeld: true,
  });
  assert.deepEqual(r.victims, []);
  assert.match(r.skipped, /gate lock/);
});

test("self and parent pids are skipped", () => {
  const r = selectVictims({
    lines: [line(300, "server.mjs", 99 * HOUR, 300)],
    cwdFor: () => WT,
    selfPid: 300,
  });
  assert.deepEqual(r.victims, []);
});

test("unresolvable cwd (process died) is skipped, not a crash", () => {
  const r = selectVictims({
    lines: [line(302, "server.mjs", 99 * HOUR)],
    cwdFor: () => null,
  });
  assert.deepEqual(r.victims, []);
});

// ── checkAndRepairCanonicalGitConfig (voicebox-beads-6p3y) ───────────────────

test("canonical git config: non-existent directory is skipped", () => {
  const res = checkAndRepairCanonicalGitConfig({ canonicalDir: "/nonexistent/path/never" });
  assert.equal(res.ok, true);
  assert.match(res.skipped, /missing/);
});

test("canonical git config: core.bare=false returns ok without repair", () => {
  const calls = [];
  const execGit = (args) => {
    calls.push(args);
    return "false";
  };
  const res = checkAndRepairCanonicalGitConfig({ canonicalDir: CANON, execGit });
  assert.equal(res.ok, true);
  assert.equal(res.repaired, false);
  assert.deepEqual(calls, [["-C", CANON, "config", "core.bare"]]);
});

test("canonical git config: dry-run warns when core.bare=true without modifying config", () => {
  const calls = [];
  const execGit = (args) => {
    calls.push(args);
    return "true";
  };
  const res = checkAndRepairCanonicalGitConfig({ canonicalDir: CANON, dryRun: true, execGit });
  assert.equal(res.ok, false);
  assert.equal(res.repaired, false);
  assert.equal(res.dryRun, true);
  assert.deepEqual(calls, [["-C", CANON, "config", "core.bare"]]);
});

test("canonical git config: auto-heals core.bare=true to false and unsets worktree", () => {
  const calls = [];
  const execGit = (args) => {
    calls.push(args);
    if (args[2] === "config" && args[3] === "core.bare" && args.length === 4) return "true";
    return "";
  };
  const res = checkAndRepairCanonicalGitConfig({ canonicalDir: CANON, dryRun: false, execGit });
  assert.equal(res.ok, true);
  assert.equal(res.repaired, true);
  assert.deepEqual(calls, [
    ["-C", CANON, "config", "core.bare"],
    ["-C", CANON, "config", "core.bare", "false"],
    ["-C", CANON, "config", "--unset", "core.worktree"],
  ]);
});
