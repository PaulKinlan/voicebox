// lib/unit-fence-provider.mjs — S2: the L1.5 composition. Boot a transient systemd --user unit
// whose Exec is the bwrap fence, and read the boundary off the environment's OWN served probe.
//
// The fence alone (L1, lib/fence-provider.mjs) bounds files and processes but carries no kernel
// lockdown: the probe inside reports Seccomp: 0. The unit adds it AROUND the fence — seccomp
// filter (Seccomp: 2), empty capability set (CapEff: 0), PrivateTmp, ProtectSystem=strict with the
// one sandbox home as the writable exception (tools/fence-unit.sh). The composition is measured,
// never claimed: the environment serves its own probe report (tools/env-serve.mjs) and the host
// collects it over HTTP — the serving IS the evidence the environment is up.

import { execFile } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, measureBoundary } from "./fence-provider.mjs";
import { sandboxHomesDir } from "./state-dirs.mjs";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(new URL("../server.mjs", import.meta.url)));
const FENCE_UNIT = path.join(ROOT, "tools", "fence-unit.sh");
// Read LAZILY, per call: an env pin resolved at import is a copy of a fact that can change after
// boot (voicebox-beads-y5k) — a test that sets it in before() must see its own value. The fact now
// lives in ./state-dirs.mjs, which reads the variable per call; this module asks for it.
// TRAP: the value must live OUTSIDE /tmp — PrivateTmp hides /tmp inside the unit's namespace and
// the home fails to bind (status 226/NAMESPACE). os.tmpdir() scratch dirs are the classic victim.

/** Is a systemd --user manager reachable? Checked by asking it, once per call — never assumed. */
async function userManagerAvailable() {
  try {
    await run("systemd-run", ["--user", "--collect", "--wait", "--pipe", "/usr/bin/true"], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// A PER-RUN UNIT NAME, so two lanes running the same test cannot collide (voicebox-beads-6qu).
//
// The name used to be derived from the descriptor key alone — deterministic, and shared by every run of
// the same test. A second run starting while the first was still up therefore got systemd's "Unit
// voicebox-fence-<key>.service was already loaded or has a fragment file", and the check read it as
// "the composition did not boot": a product-shaped failure for a name clash between runs. Measured
// 2026-09-24 in a real pre-push refusal, with the unit already gone by the time anyone looked (nothing
// leaked — the window is the overlap).
//
// The key stays in the name (traceability in `systemctl --user list-units`), and one token per PROCESS
// makes it belong to exactly one run — which also means `stopUnitFence` can only ever stop this run's
// unit, never a neighbour's.
const RUN_TOKEN = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
const unitName = (key) => `voicebox-fence-${String(key).replace(/[^A-Za-z0-9_.-]/g, "_")}-${RUN_TOKEN}`;

/**
 * Boot an L1.5 fenced environment from a descriptor.
 *
 * @param {{ key: string, label?: string }} descriptor — the registry descriptor this fence serves.
 * @returns the booted environment: its origin (ANSWERING — the environment serves its own probe),
 *          the host key it answers to, and its measured boundary (level "L1.5").
 */
export async function bootUnitFence(descriptor) {
  if (!existsSync(FENCE_UNIT)) {
    return { ok: false, refused: "fence-unavailable", why: "the composition script (tools/fence-unit.sh) is not present in this tree" };
  }
  if (!(await userManagerAvailable())) {
    return { ok: false, refused: "unit-unavailable", why: "no systemd --user manager is reachable on this host — the L1.5 composition cannot boot here" };
  }
  const home = path.join(sandboxHomesDir(), descriptor.key);
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  const unit = unitName(descriptor.key);

  // REACQUIRE, do not collide: the unit name is deterministic per key, so a boot of a key that is
  // already live (a crashed earlier run, a re-declare) takes the name over — last boot wins.
  // Best-effort: 'no such unit' is the common case and not an error.
  await stopUnitFence(descriptor.key);

  // BOOT: the transient unit's Exec is the fence running the environment server. --collect drops
  // the unit when it exits; the server holds it open. A boot failure surfaces as a serve failure
  // below — systemd-run itself returns once the unit is queued.
  const bootMarker = randomBytes(16).toString("hex");
  try {
    await run(FENCE_UNIT, [home, String(port), unit], { timeout: 15000, env: { ...process.env, VOICEBOX_BOOT_MARKER: bootMarker } });
  } catch (err) {
    return { ok: false, refused: "unit-refused", why: `the transient unit did not start — ${String(err?.stderr ?? err?.message ?? err).slice(0, 300)}` };
  }

  // COLLECT — but ONLY FROM THE BOOT WE JUST LAUNCHED. An open port answering 200 is not proof of
  // who answers (gemini drove a stale dummy past an unmarked check; the freePort bind-then-close
  // race makes the window real). The serve must return this boot's marker before its /probe is
  // believed — the marker gives the boot proof an IDENTITY, not a URL (xqg's pattern).
  const origin = `http://127.0.0.1:${port}`;
  const identity = await awaitBootIdentity(origin, bootMarker);
  if (!identity.ok) {
    await stopUnitFence(descriptor.key);
    return { ok: false, refused: "serve-failed", why: identity.why };
  }
  let probeReport = null;
  try {
    const res = await fetch(`${origin}/probe`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) probeReport = await res.json();
  } catch { /* identified a moment ago; a lost race here is the same refusal */ }
  if (!probeReport) {
    await stopUnitFence(descriptor.key);
    return { ok: false, refused: "serve-failed", why: "the environment proved its boot identity but its probe did not answer" };
  }

  // The level is DERIVED from the probe, never requested: a unit whose seccomp did not apply
  // reports L1 here, and the row it lands in says so — the claim degrades to what the box earned.
  const boundary = measureBoundary(probeReport);
  return {
    ok: true,
    envKey: descriptor.key,
    label: descriptor.label ?? descriptor.key,
    kind: "server",
    origin,
    home: { kind: "machine", path: path.join(home, "workspace") },
    reach: "ambient",
    boundary,
    capability: probeReport,
    fence: {
      mechanism: "systemd-run --user + bwrap",
      homes: home,
      port,
      unit,
      // THE RUNTIME THE REPORT DESCRIBES: /usr/bin/node inside the fence (v26.8.1 on this box),
      // NOT the suite's runner (mise v24.21.0). A level claim names the box it was measured under.
      runtime: "/usr/bin/node (the fence's system node — the probe describes it, not the host's runner)",
    },
  };
}

/**
 * Wait until `origin` answers /health carrying THIS boot's marker — identity, not liveness.
 * Exported for the negative test: a server that never presents the marker is never accepted.
 */
export async function awaitBootIdentity(origin, bootMarker, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  let lastError = "no answer";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = await res.json();
        if (body?.bootMarker === bootMarker) return { ok: true };
        lastError = "the port answers but never presented this boot's marker — a stranger, not this boot";
      } else {
        lastError = `/health answered ${res.status}`;
      }
    } catch (err) {
      lastError = err?.message ?? "fetch failed";
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, why: `the environment never proved its boot identity — ${lastError}` };
}

/** Stop a booted unit's environment. Best-effort: a unit that already exited is not an error. */
export async function stopUnitFence(key) {
  try {
    await run("systemctl", ["--user", "stop", unitName(key)], { timeout: 10000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 200) };
  }
}
