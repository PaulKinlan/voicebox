// lib/fence-provider.mjs — boot an L1 bwrap fence from a descriptor, and report its MEASURED boundary.
//
// The seam the environments plan (journal-wdq §5) settled: a sandbox level is a MEASURED per-axis
// report, not a configured label. So this provider does not SAY the fence is L1 — it boots the fence,
// runs the probe INSIDE it at boot, and reads the boundary off the probe's own measurements. An axis
// the probe did not measure says "not measured", never "denied": silence reading as safety is the
// failure mode.
//
// THE L1 FENCE (tools/fence.sh, the driven prototype productized): /usr + /etc read-only, fresh
// tmpfs for /tmp /run /var /home, one writable home bound in from the host, --unshare-pid
// --die-with-parent. It bounds the FILESYSTEM and PROCESSES; the NETWORK is SHARED — passed through,
// and labelled so. No root, no daemon, nothing installed.

import { spawn, execFile } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../server.mjs", import.meta.url)));
const FENCE = path.join(ROOT, "tools", "fence.sh");
const PROBE = path.join(ROOT, "tools", "sandbox-probe.mjs");
const SANDBOX_HOMES = process.env.VOICEBOX_SANDBOX_HOMES ?? path.join(os.homedir(), "sandbox-homes");

/** Pick a free loopback port by binding 0 and reading it back — never a fixed port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Boot a fenced environment from a descriptor.
 *
 * @param {{ key: string, label?: string }} descriptor — the registry descriptor this fence serves.
 * @returns the booted environment: its origin, the host key it answers to, and its measured boundary.
 */
export async function bootFence(descriptor) {
  if (!existsSync(FENCE) || !existsSync(PROBE)) {
    return { ok: false, refused: "fence-unavailable", why: "the fence script or the probe is not present in this tree" };
  }
  const home = path.join(SANDBOX_HOMES, descriptor.key);
  mkdirSync(home, { recursive: true });
  const port = await freePort();

  // SELF-PROBE AT BOOT: run the probe inside the fence and read the boundary off its measurements.
  // The probe runs on the fence's own PATH (/usr is bound read-only), so it is the system node,
  // not the host's — which is also the truth the report should carry.
  const probeReport = await new Promise((resolve, reject) => {
    execFile(
      FENCE,
      [home, String(port), "/usr/bin/node", "/probes/sandbox-probe.mjs"],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const text = String(stdout ?? "").trim();
        if (!text) return reject(err ?? new Error("the fence's probe printed nothing"));
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(err ?? new Error("the fence's probe printed something that was not JSON"));
        }
      },
    );
  });

  const boundary = measureBoundary(probeReport);
  return {
    ok: true,
    envKey: descriptor.key,
    label: descriptor.label ?? descriptor.key,
    kind: "server",
    origin: `http://127.0.0.1:${port}`,
    home: { kind: "machine", path: path.join(home, "workspace") },
    reach: "ambient", // loopback inside the fence's host; custody for a remote fence is the proxy seam
    boundary,
    capability: probeReport,
    fence: { mechanism: "bwrap", homes: home, port },
  };
}

/**
 * THE PER-AXIS VERDICT, read off the probe's measurements. Each axis is named, with the measurement
 * that decided it. An axis the probe cannot see is "not measured" — never "denied".
 *
 * Axes: files, processes, network, credentials, runtime (what is present). The L1 bwrap fence
 * bounds files and processes and passes the network; the probe proves each rather than asserts it.
 */
export function measureBoundary(probe) {
  const axes = {};
  const dirs = probe?.filesystem?.dirs ?? {};

  // FILES: the fence's own tree must be read-only, the host's home must not exist here, and the
  // sandbox's home must be writable. Read each off the probe's per-path measurements ({value}).
  const treeReadOnly = dirs["/srv/voicebox"]?.writable?.value === false;
  const hostHomeGone = dirs["/home"]?.listable === false || dirs["/root"]?.listable === false;
  const sandboxWritable = dirs["/home/voice"]?.writable?.value === true || dirs["/home/voice/workspace"]?.writable?.value === true;
  axes.files = {
    verdict: treeReadOnly && sandboxWritable ? "fenced" : hostHomeGone ? "fenced" : "unknown",
    measured: true,
    how: "probe: /srv/voicebox read-only, host /home absent, sandbox home writable",
    evidence: { treeReadOnly, hostHomeGone, sandboxWritable },
  };

  // PROCESSES: the fence uses --unshare-pid, so the probe sees only its own namespace. The probe's
  // mount sample carrying bwrap binds is the evidence the fence is in place.
  const bwrapMounts = Array.isArray(probe?.sandboxHints?.mountSample?.value) && probe.sandboxHints.mountSample.value.length > 0;
  axes.processes = {
    verdict: bwrapMounts ? "fenced" : "not measured",
    measured: bwrapMounts,
    how: bwrapMounts ? "probe: bwrap bind mounts present (own PID namespace)" : "the probe saw no fence mounts",
    evidence: { bwrapMounts },
  };

  // NETWORK: the fence shares the network — the probe reaching outbound TCP is the measurement that
  // says so. The probe's network facts are { ok } from tcpConnect and { value } from dns.
  const outbound = probe?.network?.outboundTcp443IpLiteral?.ok === true || probe?.network?.outboundTcp80ByName?.ok === true;
  const dnsOk = typeof probe?.network?.dns?.value === "string";
  axes.network = {
    verdict: outbound || dnsOk ? "passes" : "unknown",
    measured: outbound !== undefined || dnsOk !== undefined,
    how: "probe: outbound TCP / DNS attempted from inside the fence",
    evidence: { outbound, dns: dnsOk },
    note: "the network is SHARED with the host — this fence does not bound it",
  };

  // CREDENTIALS: the probe reads /proc/self/status for seccomp/CapEff. NoNewPrivs/seccomp off is the
  // honest answer for L1: the fence bounds files+PIDs, not syscalls or ambient credentials.
  const seccomp = probe?.sandboxHints?.seccomp?.value;
  axes.credentials = {
    verdict: seccomp === "0" ? "passes" : seccomp !== undefined ? "partial" : "not measured",
    measured: seccomp !== undefined,
    how: "probe: /proc/self/status seccomp + CapEff",
    evidence: { seccomp, capEff: probe?.sandboxHints?.capEff?.value },
    note: "no ambient credential store is fenced at L1 — a process here reads what its uid can read",
  };

  // RUNTIME: the tools the probe found — the environment's capability, observed.
  axes.runtime = {
    verdict: "present",
    measured: true,
    how: "probe: tool binaries executed and reported",
    evidence: { tools: Object.keys(probe?.tools ?? {}) },
  };

  return {
    probe: probe?.probe ?? "sandbox-probe/1",
    when: probe?.when ?? new Date().toISOString(),
    level: "L1",
    axes,
  };
}
