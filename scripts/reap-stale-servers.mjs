#!/usr/bin/env node
// scripts/reap-stale-servers.mjs (voicebox-beads-<filed>): reap lane-spawned servers
// and previews that their lanes leaked.
//
// WHY THIS EXISTS (2026-09-30): lanes spawn servers with setsid/nohup and die;
// the servers outlive them. Measured on the box: one wedged `node server.mjs`
// pegged 100% of a core for 4d19h, a 35-process test cluster from a single
// worktree, and ~80 leaked node/vite/serve/deno processes aged 2-10 days —
// 29Gi of swap and hours of a core. cap-reap-chrome.sh is the same class of
// fix for browsers; this is the one for voicebox servers.
//
// SCOPE (decided 2026-09-30, Paul's directive was box-wide): this reaper is
// FLEET-WIDE. ~/worktrees is the whole fleet's worktree root (cap, audiofeed,
// isocan, webai, sotw, uplift, voicebox...), and the incident that motivated
// this script was box-wide — leaked servers from ANY project's lane. The
// scope is declared here and pinned in tests, not left as an accident of the
// roots list (astra's rmgq review blocker).
//
// CONTRACT (a process is a victim only if EVERY clause of isVictim holds);
// the clauses are a pure predicate, unit-tested in tests/reap-stale-servers.test.mjs:
//   1. node or deno, running a server/preview shape.
//   2. cwd inside the fleet's world (~/worktrees — all projects, ~/voicebox-wt,
//      ~/voicebox, /tmp/voicebox-*, or a stale /vb-<id>/ fragment whose
//      worktree was removed).
//   3. older than the age floor: 4h for fleet worktrees, 24h for the canonical
//      voicebox checkout (a deliberate front lives there).
//   4. not pinned: no VOICEBOX_PINNED=1 in environ, no .pinned-server marker in cwd.
//   5. the gate lock (/tmp/voicebox-gate.lock) not freshly held (<1h) — a live
//      gate's servers are untouchable while it runs.
//   6. not this script or its parent.
// /tmp sweep: voicebox-cdp-* and vb-accept-* fixture dirs older than 6h.
//
// Modes: `--dry-run` prints victims without killing.

import { readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const GATE_LOCK = process.env.VOICEBOX_GATE_LOCK ?? "/tmp/voicebox-gate.lock";
const WORKTREE_FLOOR_MS = 4 * 60 * 60 * 1000; // 4h — 36x the longest measured lane
const CANONICAL_FLOOR_MS = 24 * 60 * 60 * 1000; // 24h — a deliberate canonical front
const TMP_DIR_FLOOR_MS = 6 * 60 * 60 * 1000; // 6h for /tmp fixture dirs
const CANONICAL = path.join(HOME, "voicebox");
const SERVER_SHAPE = /server\.mjs|vite|(^|[\s/])serve |deno run|\.bin\/serve/;
const SCOPE_ROOTS = [
  path.join(HOME, "worktrees"),
  path.join(HOME, "voicebox-wt"),
  CANONICAL,
];

/** THE pure predicate. Everything killable is exactly this. */
export function isVictim({ args, cwd, ageSec, env = "", markerExists = false }) {
  if (!/^(node|deno)(\s|$)/.test(args) && !args.startsWith("node ") && !args.startsWith("deno ")) return false;
  if (!SERVER_SHAPE.test(args)) return false;
  const inScope = SCOPE_ROOTS.some((r) => cwd === r || cwd.startsWith(r + path.sep)) ||
    /voicebox-(cdp|d1-http|dev|wt)|\/vb-[a-z0-9]+/.test(cwd) || /^\/tmp\/voicebox-/.test(cwd);
  if (!inScope) return false;
  if (env.includes("VOICEBOX_PINNED=1") || markerExists) return false;
  const floor = cwd === CANONICAL || cwd.startsWith(CANONICAL + path.sep) ? CANONICAL_FLOOR_MS : WORKTREE_FLOOR_MS;
  return ageSec * 1000 >= floor;
}

/** Select victims from `ps -eo pid,ppid,etimes,args` lines. `cwdFor` and
 *  `envFor`/`markerFor` default to /proc reads; tests inject fakes. */
export function selectVictims({ lines, gateLockHeld = false, selfPid = process.pid, cwdFor, envFor, markerFor }) {
  const victims = [];
  if (gateLockHeld) return { victims, skipped: "gate lock held — whole round skipped" };
  const _cwdFor = cwdFor ?? ((pid) => {
    try {
      return execFileSync("readlink", ["-f", `/proc/${pid}/cwd`], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  });
  const _envFor = envFor ?? ((pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", "\n");
    } catch {
      return "";
    }
  });
  const _markerFor = markerFor ?? ((cwd) => existsSync(path.join(cwd, ".pinned-server")));

  for (const lineText of lines) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(lineText);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const ageSec = Number(m[3]);
    const args = m[4];
    if (pid === selfPid || ppid === selfPid) continue;
    const cwd = _cwdFor(pid);
    if (!cwd) continue;
    if (isVictim({ args, cwd, ageSec, env: _envFor(pid), markerExists: _markerFor(cwd) })) {
      victims.push({ pid, cwd, ageSec, args: args.slice(0, 120) });
    }
  }
  return { victims };
}

/** /tmp fixture dirs (voicebox-cdp-*, vb-accept-*) older than 6h. `entries`
 *  injects a readdir for tests; production reads /tmp. */
export function staleTmpDirs({ entries, now = Date.now() } = {}) {
  let names = entries;
  if (!names) {
    try {
      names = readdirSync("/tmp");
    } catch {
      return [];
    }
  }
  const out = [];
  for (const name of names) {
    if (!/^voicebox-(cdp|d1-http)-/.test(name) && !/^vb-accept-/.test(name)) continue;
    const full = path.join("/tmp", name);
    try {
      if (now - statSync(full).mtimeMs > TMP_DIR_FLOOR_MS) out.push(full);
    } catch { /* raced away */ }
  }
  return out;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  // The gate lock's EXISTENCE is not proof a gate is live — a crashed gate can
  // leave the file behind (measured: a 4h-old zero-byte lock). A gate's live
  // phase is minutes (budgets total ~9 min); treat the lock as held only when
  // it is younger than an hour, else reap normally and leave the file alone.
  let gateLockHeld = false;
  try {
    const lockAge = Date.now() - statSync(GATE_LOCK).mtimeMs;
    gateLockHeld = lockAge < 60 * 60 * 1000;
  } catch { /* no lock file */ }
  const psOut = execFileSync("ps", ["-eo", "pid,ppid,etimes,args", "--no-headers"], { encoding: "utf8" });
  const { victims, skipped } = selectVictims({ lines: psOut.split("\n"), gateLockHeld });

  if (skipped) {
    console.log(`[reap] ${skipped}`);
    return;
  }
  for (const v of victims) {
    const desc = `pid=${v.pid} age=${Math.round(v.ageSec / 360) / 10}h cwd=${v.cwd} :: ${v.args}`;
    if (dryRun) console.log(`[reap:dry-run] would kill ${desc}`);
    else {
      try {
        process.kill(v.pid, "SIGKILL");
        console.log(`[reap] killed ${desc}`);
      } catch (e) {
        console.log(`[reap] failed pid=${v.pid}: ${e.message}`);
      }
    }
  }
  for (const dir of staleTmpDirs()) {
    if (dryRun) console.log(`[reap:dry-run] would rm -rf ${dir}`);
    else {
      try {
        rmSync(dir, { recursive: true, force: true });
        console.log(`[reap] removed ${dir}`);
      } catch (e) {
        console.log(`[reap] failed ${dir}: ${e.message}`);
      }
    }
  }
  if (!victims.length) console.log("[reap] nothing to reap");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("reap-stale-servers.mjs")) {
  main();
}
