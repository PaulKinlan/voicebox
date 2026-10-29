// scripts/stray-sweep.mjs — kill the servers and browsers a killed gate left behind (voicebox-beads-9xqs).
//
// WHY THIS EXISTS. A gate's per-file child leads its OWN process group so a per-file timeout can take a wedged file and
// its browser down together. The fixtures inside that file lead groups of their own (`tests/lib/server.mjs` and
// `tests/lib/cdp.mjs` both spawn detached, deliberately: a fixture must outlive a test that forgets to stop it). So when
// the GATE ITSELF is killed — `timeout --kill-after` escalates to SIGKILL at rc 137, the reaper kills a spinning lane, a
// person closes the terminal hard — nothing sends the fixture a signal it can handle: no group kill reaches a detached
// grandchild, and SIGKILL cannot be handled at all. The reaper found the result on 2026-10-28: `node …/server.mjs`,
// 121 minutes old, 0% CPU, 106 MB, holding a port in a worktree whose gate had finished hours earlier.
//
// WHAT THIS DOES, and what it deliberately does not. It attributes a process to ONE worktree by its CWD, which is the
// only field a leftover fixture carries that no other lane shares: two lanes running gates on this box have different
// worktrees, so a sweep scoped to `root` cannot touch the other lane's servers. It only considers process shapes a
// fixture produces (`server.mjs`, a browser), only processes that started at or after a caller-supplied instant (so a
// server someone started by hand an hour ago is not swept by a gate run that began a minute ago), and never itself or its
// ancestors. It is not the fleet-wide janitor: `scripts/reap-stale-servers.mjs` reaps by age across every worktree and is
// the right tool for "nobody is looking"; this is the right tool for "the run that owns these is over".
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

/** The cmdlines a test fixture produces. Chrome's helper and test binaries are named for what they are. */
export const FIXTURE_SHAPES = Object.freeze([
  /(?:^|\/)server\.mjs(?:\s|$)/,
  /(?:^|\/)(?:chrome|chromium|chrome_crashpad_handler|headless_shell)(?:\s|$)/,
  /--headless(?:=|\s|$)/,
]);

/**
 * Process start time in ms since the epoch, from `/proc/<pid>/stat` field 22 (clock ticks since boot) and
 * `/proc/uptime`. Returns null when the process is gone or the fields are unreadable — never a guess.
 */
export function startMsOf(pid, { procRoot = "/proc", uptimeSec = null } = {}) {
  try {
    const stat = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    // The comm field is parenthesised and may contain spaces, so count from the LAST ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]); // field 22 overall, 20th after comm+state
    const boot = uptimeSec ?? Number(readFileSync(path.join(procRoot, "uptime"), "utf8").split(" ")[0]);
    if (!Number.isFinite(ticks) || !Number.isFinite(boot)) return null;
    const ticksPerSec = 100; // USER_HZ; Linux's fixed value for this field
    // Epoch ms of the process's start: the machine booted (now - uptime) and the process has run `ticks` since then.
    // Subtracting instead of adding puts every start time near the epoch, which silently filters every victim out.
    return Math.round(Date.now() - boot * 1000 + (ticks / ticksPerSec) * 1000);
  } catch {
    return null;
  }
}

/**
 * Every process that looks like a leaked fixture of `root`, as `{ pid, cmdline, cwd, startMs }`.
 *
 * `since` is the instant the run that may have leaked them began: a process older than that is somebody else's and is
 * left alone. `exclude` is a pid list (this process and its ancestors) that can never be a victim.
 */
export function strayChildren({
  root,
  since = 0,
  exclude = [],
  shapes = FIXTURE_SHAPES,
  procRoot = "/proc",
  uptimeSec = null,
  readCwd = (pid) => readlinkSync(path.join(procRoot, String(pid), "cwd")),
} = {}) {
  if (!root) throw new Error("strayChildren: root is required — a sweep with no worktree would be a box-wide kill");
  const wanted = path.resolve(root);
  const skip = new Set(exclude.map(Number).filter(Number.isFinite));
  let pids;
  try {
    pids = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const found = [];
  for (const name of pids) {
    const pid = Number(name);
    if (skip.has(pid)) continue;
    let cmdline;
    try {
      cmdline = readFileSync(path.join(procRoot, name, "cmdline"), "utf8").replace(/\0/g, " ").trim();
    } catch {
      continue;
    }
    if (!cmdline || !shapes.some((shape) => shape.test(cmdline))) continue;
    let cwd;
    try {
      cwd = readCwd(pid);
    } catch {
      continue; // gone, or not ours to read
    }
    if (path.resolve(cwd) !== wanted) continue;
    const startMs = startMsOf(pid, { procRoot, uptimeSec });
    if (startMs !== null && startMs < since) continue;
    found.push({ pid, cmdline, cwd: wanted, startMs });
  }
  return found;
}

/** SIGKILL each stray's whole process group (a fixture may have children of its own), then the pid as a fallback. */
export function killStrays(victims, { kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  const killed = [];
  for (const { pid } of victims) {
    try {
      kill(-pid, "SIGKILL");
      killed.push(pid);
      continue;
    } catch {
      /* not a group leader, or already gone */
    }
    try {
      kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      /* already gone */
    }
  }
  return killed;
}

/** `strayChildren` + `killStrays`, with this process and its ancestors always excluded. */
export function sweepStrays({ root, since = 0, procRoot = "/proc", ...rest } = {}) {
  const ancestors = [];
  for (let pid = process.pid; pid > 1; ) {
    ancestors.push(pid);
    try {
      const stat = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); // field 4: ppid
    } catch {
      break;
    }
  }
  const victims = strayChildren({ root, since, exclude: ancestors, procRoot, ...rest });
  return { victims, killed: killStrays(victims) };
}
