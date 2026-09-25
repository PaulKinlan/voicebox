#!/usr/bin/env node
/**
 * sandbox-probe/1 — report what is ACTUALLY available inside this environment.
 *
 * Paul's question, made executable: a user gains confidence from a report of
 * the real boundary, not from a claim about it. Run this INSIDE whatever
 * sandbox is under test (plain host, bwrap, systemd-run transient unit,
 * container, …) and read the JSON it prints. Every check is individually
 * caught: a probe that dies on the first denied syscall reports nothing.
 *
 * Design rules:
 *  - Report facts with the METHOD beside them, never verdicts. "outbound
 *    TCP 443 to one well-known host: connected" is a fact; "network is
 *    safe" is a claim this script is not allowed to make.
 *  - Distinguish false, absent, and refused. Each result is
 *    { value | error: message } — an error is the boundary showing itself.
 *  - Sandbox KIND is a hint list, never a conclusion: the evidence that
 *    would distinguish bubblewrap / container / systemd unit / bare host is
 *    reported and the reader decides.
 *
 * Zero dependencies. `node sandbox-probe.mjs` — JSON on stdout, pretty
 * with SANDBOX_PROBE_PRETTY=1. The fence host may append its owned loopback
 * port and 32-hex marker; this measures one parent route, not internet access.
 */
import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const WHEN = new Date().toISOString();

/** Run a command; return stdout or the failure as data. Never throws. */
async function softly(command, args = [], opts = {}) {
  try {
    const { stdout } = await exec(command, args, { timeout: opts.timeoutMs ?? 5000, ...opts });
    return { value: stdout.trim().slice(0, opts.maxChars ?? 2000) };
  } catch (err) {
    return { error: err.code === "ENOENT" ? `${command}: not present` : `${command}: ${err.message.slice(0, 200)}` };
  }
}

/** Read a file; return contents or the failure as data. */
function readSoftly(p, maxChars = 4000) {
  try {
    return { value: fs.readFileSync(p, "utf8").slice(0, maxChars) };
  } catch (err) {
    return { error: `${p}: ${err.code ?? err.message}` };
  }
}

export function isPidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}

/** Sweep orphaned .sandbox-probe-<pid>-* markers left by killed processes (voicebox-beads-ebq). */
export function sweepOrphanedProbeMarkers(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const match = entry.name.match(/^\.sandbox-probe-(\d+)-/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (isPidDead(pid)) {
        try {
          fs.unlinkSync(path.join(dirPath, entry.name));
        } catch {
          /* ignore unlink failure (e.g. read-only or race) */
        }
      }
    }
  } catch {
    /* dirPath may be unreadable, non-existent, or not a directory */
  }
}

/** Does this path exist, and can this process write there? PROBE BY DOING:
 *  create and unlink a uniquely named file, so a read-only mount is
 *  discovered rather than guessed from mount flags. */
function writeProbe(p) {
  sweepOrphanedProbeMarkers(p);
  const file = path.join(p, `.sandbox-probe-${process.pid}-${WHEN.replace(/[^0-9]/g, "")}`);
  let unlinked = false;
  const cleanup = () => {
    if (!unlinked) {
      try { fs.unlinkSync(file); } catch {}
      unlinked = true;
    }
  };
  try {
    fs.writeFileSync(file, "probe\n");
    cleanup();
    return { value: true };
  } catch (err) {
    cleanup();
    return { value: false, error: `${err.code ?? err.message}` };
  }
}

/** TCP connect, optionally requiring an exact marker through EOF, with a total deadline. */
function tcpConnect(host, port, ms = 3000, expected) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false, received = "";
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    const timer = setTimeout(() => done({ ok: false, error: `timed out after ${ms}ms` }), ms);
    socket.on("connect", () => { if (expected === undefined) done({ ok: true }); });
    socket.on("data", (chunk) => {
      if (settled || expected === undefined) return;
      received += chunk.toString("utf8");
      if (received.length > expected.length) done({ ok: false, error: "parent-witness-mismatch" });
    });
    socket.on("end", () => done(received === expected ? { ok: true } : { ok: false, error: "parent-witness-mismatch" }));
    socket.on("close", () => done({ ok: false, error: "closed before the parent marker completed" }));
    socket.on("error", (err) => done({ ok: false, error: err.code ?? err.message }));
  });
}

// ---------------------------------------------------------------- sections

function identity() {
  return {
    when: WHEN,
    user: os.userInfo().username,
    uid: process.getuid?.() ?? null,
    euid: process.geteuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    groups: (() => { try { return os.userInfo().groups; } catch { return null; } })(),
    cwd: process.cwd(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  };
}

/** Evidence that hints at the sandbox KIND. Hints, not conclusions: each
 *  entry says WHERE it was read from, so a reader can weigh it. */
function sandboxHints() {
  const hints = {};
  // A file only a container runtime creates.
  hints.dockerenv = fs.existsSync("/.dockerenv")
    ? { value: "/.dockerenv present — running inside a Docker/Podman container" }
    : { value: false };
  // systemd transient units and services carry this; a bare shell does not.
  hints.invocationId = readSoftly("/run/systemd/units-invocation-id", 200);
  hints.systemdEnv = process.env.INVOCATION_ID
    ? { value: `INVOCATION_ID=${process.env.INVOCATION_ID} — inside a systemd unit` }
    : { value: false };
  // bubblewrap leaves mount entries whose source is the host paths it bound.
  const mountinfo = readSoftly("/proc/self/mountinfo", 12000);
  if (mountinfo.value) {
    const bwrapish = mountinfo.value.split("\n").filter((l) =>
      /\/(usr|etc|home)[\s/]|\btmpfs\b.*\/(tmp|home|run)\b|\bproc\b/.test(l)).slice(0, 12);
    hints.mountSample = { value: bwrapish, note: "first 12 relevant /proc/self/mountinfo lines" };
    hints.mountCount = { value: mountinfo.value.split("\n").length };
  } else hints.mountSample = mountinfo;
  // Kernel lockdown of the process itself (seccomp / no-new-privs), read
  // from the kernel, not from a flag somebody passed.
  const status = readSoftly("/proc/self/status", 4000);
  if (status.value) {
    const field = (name) => (status.value.match(new RegExp(`^${name}:\\t(.*)$`, "m")) ?? [])[1] ?? null;
    hints.seccomp = { value: field("Seccomp"), note: "0=off 1=strict 2=filter, from /proc/self/status" };
    hints.noNewPrivs = { value: field("NoNewPrivs") };
    hints.capEff = { value: field("CapEff"), note: "effective capability mask, from /proc/self/status" };
  }
  // Environment variables runtimes set on themselves.
  hints.envMarks = {
    value: Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      /^(container|DOCKER|KUBERNETES|SRT|BWRAP|FLATPAK|SNAP|npm_lifecycle)/i.test(k))),
  };
  return hints;
}

function filesystem() {
  const home = os.homedir();
  // Extra paths the FENCE names as interesting (its mounts, its workspace),
  // passed as SANDBOX_PROBE_PATHS="path1:path2" — the same paths a person
  // would check by hand, so the report reads like the check they meant.
  const extra = (process.env.SANDBOX_PROBE_PATHS ?? "").split(":").filter(Boolean);
  const attempts = {};
  for (const label of ["/", "/tmp", home, "/etc", "/usr", "/var", "/root", "/home", process.cwd(), ...extra]) {
    attempts[label] = { readable: readSoftly(path.join(label === "/" ? "/" : label, ".")).value !== undefined ? undefined : undefined, ...(() => {
      try { fs.readdirSync(label === "/" ? "/" : label, { withFileTypes: true }); return { listable: true }; }
      catch (err) { return { listable: false, error: err.code ?? err.message }; }
    })(), writable: writeProbe(label === "/" ? "/tmp" : label === "/" ? "/tmp" : label) };
  }
  const mounts = readSoftly("/proc/self/mounts", 6000);
  const passwd = readSoftly("/etc/passwd", 300);
  return {
    home,
    pathEntries: (process.env.PATH ?? "").split(":").filter(Boolean),
    dirs: attempts,
    canReadPasswd: passwd.value !== undefined ? { value: true } : { value: false, error: passwd.error },
    mountsReadable: mounts.value !== undefined ? { value: true, lines: mounts.value.split("\n").length } : { value: false, error: mounts.error },
  };
}

async function tools() {
  const wanted = [
    "sh", "bash", "node", "python3", "pip", "deno", "bun", "git", "curl", "wget",
    "ssh", "gcc", "cc", "make", "docker", "podman", "bwrap", "systemctl",
    "ps", "ls", "cat", "cp", "mv", "rm", "sudo", "su", "mount", "iptables", "nft",
  ];
  const found = {};
  for (const bin of wanted) found[bin] = await softly(bin, ["--version"], { maxChars: 80 });
  return found;
}

async function network() {
  const [witnessPort, marker] = process.argv.slice(2);
  let parentLoopback;
  if (witnessPort !== undefined || marker !== undefined) {
    const valid = /^\d+$/.test(witnessPort ?? "") && Number(witnessPort) > 0 && Number(witnessPort) <= 65535
      && /^[a-f0-9]{32}$/.test(marker ?? "");
    parentLoopback = valid
      ? { ...await tcpConnect("127.0.0.1", Number(witnessPort), 1500, marker), endpoint: `127.0.0.1:${witnessPort}`, method: "exact parent marker through EOF" }
      : { error: "invalid parent witness arguments — no connection attempted" };
  }
  const loopback = await tcpConnect("127.0.0.1", 1, 1500).then((r) => ({
    reachable: r.ok || r.error === "ECONNREFUSED",
    note: r.ok ? "connected (something listens on port 1)" : r.error === "ECONNREFUSED" ? "ECONNREFUSED — loopback UP, nothing on port 1 (normal)" : r.error,
  }));
  // DNS: resolve a name that must exist. Failure here is egress facts, not
  // necessarily a rule — a sandbox with no resolver reads differently from
  // one with a dropped socket.
  let dnsResult;
  try {
    const addresses = await dns.resolve("example.com");
    dnsResult = { value: `resolved via ${addresses[0]}` };
  } catch (err) {
    dnsResult = { error: `${err.code ?? err.message}` };
  }
  const outbound443 = await tcpConnect("93.184.216.34", 443, 4000); // example.com, IP literal: no DNS in the path
  const outbound80 = await tcpConnect("example.com", 80, 4000);
  const privateRange = await tcpConnect("169.254.169.254", 80, 1500); // cloud metadata: interesting either way
  const interfaces = os.networkInterfaces();
  return {
    parentLoopback,
    loopback,
    dns: dnsResult,
    outboundTcp443IpLiteral: outbound443,
    outboundTcp80ByName: outbound80,
    cloudMetadataService: { ...privateRange, note: "169.254.169.254:80 — reachable means credentials may be reachable" },
    interfaces,
    resolvConf: readSoftly("/etc/resolv.conf", 600),
  };
}

function limits() {
  const parsed = {};
  const limitsFile = readSoftly("/proc/self/limits", 4000);
  if (limitsFile.value) {
    for (const line of limitsFile.value.split("\n")) {
      const m = line.match(/^(\w[\w() ]+)\s+(.+?)\s+(.+?)\s+(.+?)\s+(.+?)\s*$/);
      if (m) parsed[m[1].trim()] = { soft: m[2].trim(), hard: m[3].trim() };
    }
  } else parsed._error = limitsFile.error;
  return {
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    loadavg: os.loadavg(),
    rlimits: parsed,
  };
}

export async function runProbe() {
  const report = {
    probe: "sandbox-probe/1",
    when: WHEN,
    identity: identity(),
    sandboxHints: sandboxHints(),
    filesystem: filesystem(),
    limits: limits(),
  };

  report.tools = await tools();
  report.network = await network();
  return report;
}

// ------------------------------------------------------------------- main

const isMain = !process.env.SANDBOX_PROBE_NO_MAIN && (
  !process.argv[1] ||
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  path.basename(process.argv[1]) === "sandbox-probe.mjs"
);

if (isMain) {
  sweepOrphanedProbeMarkers(process.cwd());
  const report = await runProbe();
  const pretty = process.env.SANDBOX_PROBE_PRETTY === "1";
  process.stdout.write(JSON.stringify(report, null, pretty ? 2 : 0) + "\n");
}
