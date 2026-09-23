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
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { freePort, measureBoundary } from "./fence-provider.mjs";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(new URL("../server.mjs", import.meta.url)));
const FENCE_UNIT = path.join(ROOT, "tools", "fence-unit.sh");
// Read LAZILY, per call: an env pin resolved at import is a copy of a fact that can change after
// boot (voicebox-beads-y5k) — a test that sets it in before() must see its own value.
// TRAP: the value must live OUTSIDE /tmp — PrivateTmp hides /tmp inside the unit's namespace and
// the home fails to bind (status 226/NAMESPACE). os.tmpdir() scratch dirs are the classic victim.
const sandboxHomes = () => process.env.VOICEBOX_SANDBOX_HOMES ?? path.join(os.homedir(), "sandbox-homes");

/** Is a systemd --user manager reachable? Checked by asking it, once per call — never assumed. */
async function userManagerAvailable() {
  try {
    await run("systemd-run", ["--user", "--collect", "--wait", "--pipe", "/usr/bin/true"], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

const unitName = (key) => `voicebox-fence-${String(key).replace(/[^A-Za-z0-9_.-]/g, "_")}`;

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
  const home = path.join(sandboxHomes(), descriptor.key);
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  const unit = unitName(descriptor.key);

  // BOOT: the transient unit's Exec is the fence running the environment server. --collect drops
  // the unit when it exits; the server holds it open. A boot failure surfaces as a serve failure
  // below — systemd-run itself returns once the unit is queued.
  try {
    await run(FENCE_UNIT, [home, String(port), unit], { timeout: 15000 });
  } catch (err) {
    return { ok: false, refused: "unit-refused", why: `the transient unit did not start — ${String(err?.stderr ?? err?.message ?? err).slice(0, 300)}` };
  }

  // COLLECT: the environment serves its OWN probe report; the host reads it over HTTP. The serve
  // is the boot proof: an origin that answers /probe with a measured report is up by definition.
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  let probeReport = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/probe`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        probeReport = await res.json();
        break;
      }
      lastError = new Error(`/probe answered ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!probeReport) {
    await stopUnitFence(descriptor.key);
    return { ok: false, refused: "serve-failed", why: `the unit started but the environment never served its probe — ${lastError?.message ?? "no answer"}` };
  }

  const boundary = measureBoundary(probeReport, "L1.5");
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
    fence: { mechanism: "systemd-run --user + bwrap", homes: home, port, unit },
  };
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
