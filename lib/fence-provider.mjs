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
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxHomesDir } from "./state-dirs.mjs";

const ROOT = path.dirname(fileURLToPath(new URL("../server.mjs", import.meta.url)));
const FENCE = path.join(ROOT, "tools", "fence.sh");
const PROBE = path.join(ROOT, "tools", "sandbox-probe.mjs");
// Read at USE time, never at import: a caller that sets VOICEBOX_SANDBOX_HOMES after this
// module loads (a test's before-hook, an operator's restart) must get the value it set. An
// import-time capture is a private copy of a fact that lives elsewhere (voicebox-beads-y5k),
// and the fixture-isolation finding is exactly that: homes were captured before test.before
// could override them, so the suite wrote fences into the REAL ~/sandbox-homes and passed.
// The fact now LIVES in ./state-dirs.mjs (which reads it per call); this module asks.

/** Pick a free loopback port by binding 0 and reading it back — never a fixed port. */
export function freePort() {
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
  const home = path.join(sandboxHomesDir(), descriptor.key);
  mkdirSync(home, { recursive: true });
  const port = await freePort();

  // A real route from child to parent, independent of internet/DNS availability.
  // The random marker identifies THIS listener, not another service on a coincident port.
  const marker = randomBytes(16).toString("hex");
  const sockets = new Set();
  const witness = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.end(marker);
  });
  let probeReport;
  try {
    await new Promise((resolve, reject) => {
      witness.once("error", reject);
      witness.listen(0, "127.0.0.1", resolve);
    });
    // SELF-PROBE AT BOOT: system node INSIDE the fence reads the marker. The
    // extra arguments name an owned loopback witness, never a caller-supplied host.
    probeReport = await new Promise((resolve, reject) => {
      execFile(
        FENCE,
        [home, String(port), "/usr/bin/node", "/probes/sandbox-probe.mjs", String(witness.address().port), marker],
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
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => witness.close(resolve));
  }

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
  // Each is TRI-STATE: true / false / undefined (the probe never saw that path — not measured). A
  // measured false is a violation; an absent measurement is "not measured", never a verdict.
  const treeReadOnly = dirs["/srv/voicebox"]?.writable?.value === false ? true : dirs["/srv/voicebox"]?.writable?.value === true ? false : undefined;
  const hostHomeGone = dirs["/home"]?.listable === false || dirs["/root"]?.listable === false ? true : ("/home" in dirs || "/root" in dirs) ? false : undefined;
  const sandboxWritable = dirs["/home/voice"]?.writable?.value === true || dirs["/home/voice/workspace"]?.writable?.value === true ? true
    : dirs["/home/voice"]?.writable?.value === false || dirs["/home/voice/workspace"]?.writable?.value === false ? false : undefined;
  // FILES: fenced ONLY when every measured condition holds. A measured violation (the tree writable,
  // the host's home present, the sandbox's home not writable) is a NAMED not-fenced state, never
  // masked by another axis passing. An axis the probe cannot measure says "not measured".
  const filesMeasured = [treeReadOnly, hostHomeGone, sandboxWritable].every((v) => typeof v === "boolean");
  const filesViolations = [
    treeReadOnly === false ? "the source tree is writable (expected read-only)" : null,
    hostHomeGone === false ? "the host's home is reachable (expected absent)" : null,
    sandboxWritable === false ? "the sandbox home is not writable (expected writable)" : null,
  ].filter(Boolean);
  axes.files = {
    verdict: !filesMeasured ? "not measured" : filesViolations.length === 0 ? "fenced" : "not-fenced",
    measured: filesMeasured,
    how: "probe: /srv/voicebox read-only, host /home absent, sandbox home writable",
    ...(filesViolations.length ? { violations: filesViolations } : {}),
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

  // A reachable owned parent route is measurable even when the parent has no
  // internet. Keep that witness separate from external reach; neither proves
  // unrestricted networking. Absent facts differ from failed attempts.
  // METADATA-ONLY OBSERVATIONS (voicebox-beads-7yv): a TCP attempt to the link-local metadata
  // service is a measurement OF THE ATTEMPT, with private-route scope — never proof of
  // unrestricted internet and never proof credentials were read. Three outcomes, named:
  //   connected (ok:true)   — happened and passed, scoped as above
  //   failed (ok:false)     — happened and did not pass; this is NOT evidence the fence bounds it
  //   absent                — the probe never attempted it; not measured, never a verdict
  const network = probe?.network ?? {};
  const parentLoopback = network.parentLoopback;
  const tcp = [network.outboundTcp443IpLiteral?.ok, network.outboundTcp80ByName?.ok];
  const outbound = tcp.some((ok) => ok === true);
  const dnsOk = typeof network.dns?.value === "string";
  const meta = network.cloudMetadataService ?? null;
  const metadataAttempted = meta != null && (typeof meta.ok === "boolean" || meta.error != null);
  const metadataConnected = meta?.ok === true;
  const networkMeasured = typeof parentLoopback?.ok === "boolean" || tcp.some((ok) => typeof ok === "boolean")
    || dnsOk || typeof network.dns?.error === "string" || metadataAttempted;
  const metadataNote = metadataAttempted
    ? "metadata-service observations are private-route scope — not unrestricted-internet reachability and not proof credentials were read. "
    : "";
  const attemptedChannels = [
    tcp.some((ok) => ok !== undefined) ? "outbound TCP" : null,
    dnsOk || network.dns?.error != null ? "DNS" : null,
    metadataAttempted ? "metadata-service TCP" : null,
  ].filter(Boolean);
  const attemptedText = `probe: owned parent loopback marker, plus separate attempts (${attemptedChannels.join(", ") || "no network path"})`;
  axes.network = {
    verdict: parentLoopback?.ok === true || outbound || dnsOk || metadataConnected ? "passes" : networkMeasured ? "unknown" : "not measured",
    measured: networkMeasured,
    how: attemptedText,
    evidence: {
      parentLoopback,
      outbound,
      dns: dnsOk,
      ...(metadataAttempted ? { metadataTcp: { connected: metadataConnected, ...(meta?.error ? { error: String(meta.error).slice(0, 120) } : {}) } } : {}),
    },
    note: (parentLoopback?.ok === true
      ? "the owned parent loopback endpoint is reachable — this fence does not bound that route; internet reach is separate"
      : "no parent loopback route was confirmed; external TCP / DNS results do not establish unrestricted network access")
      + (metadataAttempted ? " " + metadataNote.trim() : ""),
  };

  // CREDENTIALS: the probe reads /proc/self/status for seccomp/CapEff. NoNewPrivs/seccomp off is the
  // honest answer for L1: the fence bounds files+PIDs, not syscalls or ambient credentials.
  const seccomp = probe?.sandboxHints?.seccomp?.value;
  const capEff = probe?.sandboxHints?.capEff?.value;
  axes.credentials = {
    verdict: seccomp === "0" ? "passes" : seccomp !== undefined ? "partial" : "not measured",
    measured: seccomp !== undefined,
    how: "probe: /proc/self/status seccomp + CapEff",
    evidence: { seccomp, capEff },
    note: "no ambient credential store is fenced at L1 — a process here reads what its uid can read",
  };

  // RUNTIME: the tools the probe found — the environment's capability, observed.
  axes.runtime = {
    verdict: "present",
    measured: true,
    how: "probe: tool binaries executed and reported",
    evidence: { tools: Object.keys(probe?.tools ?? {}) },
  };

  // THE LEVEL IS DERIVED, NEVER STAMPED (gemini review, voicebox-beads-8ny): nobody passes a level
  // in — the report earns what its measurements show. The fence's two axes fenced PLUS the kernel
  // lockdown (seccomp filter mode AND an all-zero capability set) earns L1.5; the fence alone earns
  // L1; measured-and-did-not-pass reads "not-earned" (the axes name the violation); and a probe
  // that never measured the fence's axes reads "unmeasured". A unit that silently failed to apply
  // seccomp therefore reports L1, never the L1.5 it was asked for — the claim stays about the box.
  const fenceEarned = axes.files.verdict === "fenced" && axes.processes.verdict === "fenced";
  const lockdownEarned = seccomp === "2" && typeof capEff === "string" && /^0+$/.test(capEff);
  const level = fenceEarned && lockdownEarned ? "L1.5" : fenceEarned ? "L1" : axes.files.measured && axes.processes.measured ? "not-earned" : "unmeasured";

  return {
    probe: probe?.probe ?? "sandbox-probe/1",
    when: probe?.when ?? new Date().toISOString(),
    level,
    /** Provenance: this report was MEASURED by the probe, not declared — the read path trusts only
     *  a report carrying this, so a hand-edited descriptor cannot echo a claim as a measurement. */
    measuredBy: "probe",
    axes,
  };
}
