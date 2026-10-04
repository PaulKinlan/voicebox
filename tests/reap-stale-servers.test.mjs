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
import { isVictim, selectVictims, configSaysBare, repairCanonicalBare } from "../scripts/reap-stale-servers.mjs";

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

// ── canonical health: core.bare detection (voicebox-beads-6p3y) ─────────────

test("configSaysBare: true detection (the 6p3y incident)", () => {
  const realShape = `[core]
	repositoryformatversion = 0
	filemode = true
	bare = true
[remote "origin"]
	url = https://github.com/PaulKinlan/voicebox.git
`;
  assert.equal(configSaysBare(realShape), true, "the measured incident shape must detect");
  assert.equal(configSaysBare("[core]\n\tbare = true\n"), true);
});

test("configSaysBare: healthy config does not detect", () => {
  assert.equal(configSaysBare("[core]\n	bare = false\n"), false);
  assert.equal(configSaysBare("[core]\n	repositoryformatversion = 0\n"), false);
  assert.equal(configSaysBare(""), false);
  // 'bare' as a substring of another key must not match
  assert.equal(configSaysBare("[core]\n	barefoo = true\n"), false);
});


// ── WIRING: repairCanonicalBare driven against a real scratch repo ─────────
// (astra's rmgq REVISE: the first version shipped with the helper green and
// the wiring dead — readFileSync unimported, ReferenceError swallowed by its
// own catch, presenting as 'healthy no-op'. These tests drive the real
// function against a real scratch repo so the wiring cannot ship dead again.)

test("WIRING: repairCanonicalBare fixes a scratch bare repo (core.bare=false + core.worktree set)", async () => {
  const { mkdtempSync, writeFileSync, readFileSync: rf, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { execFileSync: git } = await import("node:child_process");
  const scratch = mkdtempSync(path.join(tmpdir(), "vb-reap-bare-"));
  try {
    git("git", ["init", scratch], { stdio: "ignore" });
    const cfg = path.join(scratch, ".git", "config");
    writeFileSync(cfg, rf(cfg, "utf8").replace("bare = false", "bare = true"));
    assert.match(rf(cfg, "utf8"), /^\s*bare\s*=\s*true/m, "scratch must start bare");

    const result = repairCanonicalBare({ canonical: scratch });
    assert.match(result, /REPAIRED/);
    const after = rf(cfg, "utf8");
    assert.doesNotMatch(after, /^\s*bare\s*=\s*true/m, "bare=true must be gone");
    assert.match(after, /^\s*worktree\s*=\s*/m, "core.worktree must be set explicitly");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("WIRING: a healthy canonical is a no-op (config untouched)", async () => {
  const { mkdtempSync, readFileSync: rf, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { execFileSync: git } = await import("node:child_process");
  const scratch = mkdtempSync(path.join(tmpdir(), "vb-reap-healthy-"));
  try {
    git("git", ["init", scratch], { stdio: "ignore" });
    const cfg = path.join(scratch, ".git", "config");
    const before = rf(cfg, "utf8");
    const result = repairCanonicalBare({ canonical: scratch });
    assert.equal(result, null, "healthy config returns null");
    assert.equal(rf(cfg, "utf8"), before, "config untouched");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
