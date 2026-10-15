// lib/host-load.mjs — WHAT THE BOX WAS DOING while a gate ran (voicebox-beads-zjpm.6).
//
// WHY ONE OWNER. The gate recorded per-file durations and test counts and NOTHING about the machine under
// them, so "this file is flaky" and "this box was at loadavg 27" read identically in the artifact, and
// settling which one it was meant re-running the suite — the thing docs/12-pre-push-gate.md refuses, because
// a failure has to capture what it saw rather than be re-run until it agrees. (Measured 2026-10-15, while
// this was being written: eight concurrent copies of one browser file on this 8-vCPU box pushed loadavg to
// 27.8 and two of the eight runs failed by losing a click; the gate log for the real failure that started
// the investigation contained no load reading at all.) Exactly one module reads the box, so the manifest
// writer and the tier runner cannot disagree about what "load" means.
//
// THE AVERAGE IS A 1-MINUTE AVERAGE, AND IT LAGS. os.loadavg()[0] is not "how busy is it right now": a burst
// that starts and ends inside one file can be under-read at BOTH ends, so every reading is kept with the
// moment it was taken, `max` in a manifest is the maximum of READINGS rather than a claim about the whole
// run, and the per-file record keeps both ends. An instantaneous number would be a measurement nobody made.
//
// NULL IS AN ABSENCE, NOT A ZERO. A platform that does not report a load average (Windows) answers null, and
// 0 is a real reading on an idle box — so a reader can tell "idle" from "not measured", which is the whole
// point of recording it.
import os from "node:os";

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/** The 1-minute load average, or null where the platform does not report one. */
export function loadavg1m() {
  const [one] = os.loadavg();
  return round2(one);
}

/** The counts the box reports about itself: how many CPUs, and how many a runner may actually use. */
export function hostCores() {
  return { cpus: os.cpus().length, available_parallelism: os.availableParallelism() };
}

/**
 * A manifest's `host` block, taken at one moment. `after` and `max` stay null until the run ends: a run that
 * has not finished has not been measured yet, and a null is not a zero.
 */
export function hostSnapshot(sampledAt = new Date().toISOString()) {
  return { ...hostCores(), loadavg_1m: { before: loadavg1m(), max: null, after: null }, sampled_at: sampledAt };
}

/** A reading is a non-negative number or an honest null — never a string, a NaN or a negative. */
export function isLoadavg(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}
