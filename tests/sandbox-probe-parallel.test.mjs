// tests/sandbox-probe-parallel.test.mjs — the probe's independent checks run TOGETHER, bounded, and
// the report reads exactly as it did when they ran in turn (voicebox-beads-4wez).
//
//   node --test tests/sandbox-probe-parallel.test.mjs
//
// Measured before this bead: runProbe() took ~4.8s here — 29 `--version` children awaited one at a
// time, then six network attempts awaited one at a time, 4s of it waiting out a dead IP literal.
// Now the network attempts are dialled at once, the children run at most 8 at a time, and the two
// sections overlap. These cases hold that WITHOUT the network and without the machine's real
// binaries — every dial is answered by a stand-in and every probed binary is a stand-in script —
// and they COUNT concurrency from an ordered event log rather than inferring it from timings, so
// a loaded box stretches the run without changing what is counted:
//   · every network attempt is dialled before any of them settles (the section costs its slowest
//     attempt, not their sum);
//   · at most 8 children are in flight (a sandbox's process limit must not turn a present tool into
//     an EAGAIN "absent"), and more than one is (bounded, not serial);
//   · the network section starts while tools are still running (the sections overlap);
//   · the IP-literal attempt dials an IP literal on 443 — no DNS in its path;
//   · the report's keys, in order, and each field's shape are what the consumers read
//     (core/tier-table.ts OUTBOUND_FIELDS, lib/fence-provider.mjs measureBoundary, server.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "../tools/sandbox-probe.mjs";

const PROBE = fileURLToPath(new URL("../tools/sandbox-probe.mjs", import.meta.url));
// The probe's tool list, in the order the report must carry it.
const WANTED = [
  "sh", "bash", "node", "python3", "pip", "deno", "bun", "git", "curl", "wget",
  "ssh", "gcc", "cc", "make", "docker", "podman", "bwrap", "systemctl",
  "ps", "ls", "cat", "cp", "mv", "rm", "sudo", "su", "mount", "iptables", "nft",
];
const WIDTH = 8;
const SLEEP = ["/bin/sleep", "/usr/bin/sleep"].find((p) => existsSync(p));
// Each stand-in binary runs this long: long enough that "in flight together" is unambiguous.
const TOOL_SECS = 0.3;
// Each stand-in network attempt settles after this long.
const DIAL_MS = 300;

const failure = (code) => Object.assign(new Error(code), { code });

test("the probe dials its network checks together, runs tools bounded, overlaps the two — and its report is unchanged (voicebox-beads-4wez)", async (t) => {
  if (process.platform === "win32" || !existsSync("/bin/sh") || !SLEEP) {
    t.skip("needs /bin/sh and a sleep binary to stand in for the probed tools");
    return;
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-probe-parallel-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const bin = path.join(scratch, "bin");
  const home = path.join(scratch, "home");
  const cwd = path.join(scratch, "cwd");
  const log = path.join(scratch, "events.log");
  for (const dir of [bin, home, cwd]) mkdirSync(dir);
  writeFileSync(log, "");

  // Stand-ins for every probed binary: announce the start, run, announce the end, answer. Appends
  // to one O_APPEND file give ONE order across processes, so in-flight counts are read, not guessed.
  // ONE script behind 29 symlinks, named by $0: a machine that scans every never-seen executable
  // on its first exec (measured here: 29 fresh scripts 4.4s, one script behind links 1.5s) pays
  // that once, and the test measures the probe rather than the scanner. The first three run
  // LONGER, so they finish after tools started behind them — a report keyed in finish order,
  // rather than the probe's order, would then show it.
  const standIn = path.join(scratch, "stand-in");
  writeFileSync(standIn, [
    "#!/bin/sh",
    "name=${0##*/}",
    `echo "tool-start $name" >> "$SANDBOX_PROBE_TEST_LOG"`,
    `case "$name" in ${WANTED.slice(0, 3).join("|")}) ${SLEEP} ${TOOL_SECS + 0.2} ;; *) ${SLEEP} ${TOOL_SECS} ;; esac`,
    `echo "tool-end $name" >> "$SANDBOX_PROBE_TEST_LOG"`,
    `echo "fake-$name 1.0"`,
    "",
  ].join("\n"));
  chmodSync(standIn, 0o755);
  for (const name of WANTED) symlinkSync(standIn, path.join(bin, name));

  // Stand-ins for every dial. Nothing leaves this process: the witness port is never really
  // connected, because every net.connect below is answered here.
  const witnessPort = 45321;
  const marker = "0123456789abcdef0123456789abcdef";
  const events = []; // in-process order of [kind, label], kind "start" | "settle"
  const dials = [];
  const answers = {
    [`127.0.0.1:${witnessPort}`]: (s) => { s.emit("data", Buffer.from(marker)); s.emit("end"); },
    "127.0.0.1:1": (s) => s.emit("error", failure("ECONNREFUSED")),
    // A broken resolver on the by-name side: the literal beside it must still read on its own.
    "example.com:80": (s) => s.emit("error", failure("EAI_AGAIN")),
    "169.254.169.254:80": (s) => s.emit("error", failure("EHOSTUNREACH")),
  };
  t.mock.method(net, "connect", (opts) => {
    const label = `${opts.host}:${opts.port}`;
    dials.push(label);
    events.push(["start", label]);
    appendFileSync(log, `net-start ${label}\n`);
    const socket = new EventEmitter();
    const timer = setTimeout(() => {
      events.push(["settle", label]);
      const answer = answers[label] ?? (opts.port === 443 ? (s) => s.emit("connect") : (s) => s.emit("error", failure("EUNEXPECTED")));
      answer(socket);
    }, DIAL_MS);
    socket.destroy = () => clearTimeout(timer);
    return socket;
  });
  t.mock.method(dns, "resolve", (name) => {
    events.push(["start", `dns:${name}`]);
    return new Promise((resolve) => setTimeout(() => {
      events.push(["settle", `dns:${name}`]);
      resolve(["192.0.2.10"]);
    }, DIAL_MS));
  });

  // The probe reads its witness from argv and its tools from PATH; its write probes land in cwd and
  // HOME — both scratch here, so the repository tree never sees a marker file.
  const saved = { argv: process.argv, cwd: process.cwd(), PATH: process.env.PATH, HOME: process.env.HOME, LOG: process.env.SANDBOX_PROBE_TEST_LOG };
  let report;
  const started = performance.now();
  try {
    process.argv = [process.execPath, PROBE, String(witnessPort), marker];
    process.env.PATH = bin;
    process.env.HOME = home;
    process.env.SANDBOX_PROBE_TEST_LOG = log;
    process.chdir(cwd);
    report = await runProbe();
  } finally {
    process.argv = saved.argv;
    process.chdir(saved.cwd);
    for (const [key, value] of [["PATH", saved.PATH], ["HOME", saved.HOME], ["SANDBOX_PROBE_TEST_LOG", saved.LOG]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.diagnostic(`runProbe took ${Math.round(performance.now() - started)}ms (${WANTED.length} tools × ${TOOL_SECS}s, width ${WIDTH}; dials ${DIAL_MS}ms each)`);
  const lines = readFileSync(log, "utf8").trim().split("\n");

  // NETWORK, TOGETHER: all six attempts (witness, loopback, DNS, literal, by-name, metadata) were
  // dialled before the first of them settled. In turn, each would settle before the next began.
  assert.equal(events.filter(([kind]) => kind === "start").length, 6, `six network attempts, got ${JSON.stringify(events)}`);
  assert.deepEqual(events.slice(0, 6).map(([kind]) => kind), Array(6).fill("start"),
    `every attempt must be in flight before any settles: ${JSON.stringify(events)}`);

  // The literal really is a literal: no DNS in its path, on 443. The rest are the known targets.
  const literal = dials.find((label) => label.endsWith(":443"));
  assert.ok(literal && net.isIP(literal.slice(0, literal.lastIndexOf(":"))) !== 0,
    `the IP-literal check must dial an IP literal (no DNS in its path), dialled ${literal}`);
  assert.deepEqual([...dials].sort(), [`127.0.0.1:${witnessPort}`, "127.0.0.1:1", literal, "169.254.169.254:80", "example.com:80"].sort());

  // TOOLS, BOUNDED: counted from the ordered log.
  let inFlight = 0;
  let maxInFlight = 0;
  for (const line of lines) {
    if (line.startsWith("tool-start ")) maxInFlight = Math.max(maxInFlight, ++inFlight);
    else if (line.startsWith("tool-end ")) inFlight--;
  }
  assert.equal(lines.filter((l) => l.startsWith("tool-end ")).length, WANTED.length, "every stand-in ran to its end");
  assert.ok(maxInFlight <= WIDTH, `at most ${WIDTH} children in flight — a sandbox's process limit must not invent an absent tool (saw ${maxInFlight})`);
  assert.ok(maxInFlight >= 2, `the children run together, not one at a time (saw ${maxInFlight} at once)`);

  // THE SECTIONS OVERLAP: the network was dialled while tools were still running.
  const firstDial = lines.findIndex((l) => l.startsWith("net-start "));
  const lastToolEnd = lines.findLastIndex((l) => l.startsWith("tool-end "));
  assert.ok(firstDial !== -1 && firstDial < lastToolEnd, `the network section must start before the tools finish:\n${lines.join("\n")}`);

  // THE REPORT IS UNCHANGED: keys in the order readers see, fields in the shape they read.
  assert.deepEqual(Object.keys(report), ["probe", "when", "identity", "sandboxHints", "filesystem", "limits", "tools", "network"]);
  assert.deepEqual(Object.keys(report.tools), WANTED, "tools are keyed in the probe's order, not finish order");
  for (const name of WANTED) assert.deepEqual(report.tools[name], { value: `fake-${name} 1.0` });
  const n = report.network;
  assert.deepEqual(Object.keys(n), ["parentLoopback", "loopback", "dns", "outboundTcp443IpLiteral", "outboundTcp80ByName", "cloudMetadataService", "interfaces", "resolvConf"]);
  assert.deepEqual(Object.keys(n.parentLoopback), ["ok", "ms", "endpoint", "method"]);
  assert.equal(n.parentLoopback.ok, true, "the exact marker through EOF is a reached parent");
  assert.equal(n.parentLoopback.endpoint, `127.0.0.1:${witnessPort}`);
  assert.equal(n.parentLoopback.method, "exact parent marker through EOF");
  assert.deepEqual(n.loopback, { reachable: true, note: "ECONNREFUSED — loopback UP, nothing on port 1 (normal)" });
  assert.deepEqual(n.dns, { value: "resolved via 192.0.2.10" });
  assert.deepEqual(Object.keys(n.outboundTcp443IpLiteral), ["ok", "ms"]);
  assert.equal(n.outboundTcp443IpLiteral.ok, true, "the literal reads connected while the by-name side's resolver is down");
  assert.deepEqual(Object.keys(n.outboundTcp80ByName), ["ok", "error", "ms"]);
  assert.equal(n.outboundTcp80ByName.error, "EAI_AGAIN");
  assert.deepEqual(Object.keys(n.cloudMetadataService), ["ok", "error", "ms", "note"]);
  assert.equal(n.cloudMetadataService.error, "EHOSTUNREACH");
  assert.equal(n.cloudMetadataService.note, "169.254.169.254:80 — reachable means credentials may be reachable");
  for (const field of ["parentLoopback", "outboundTcp443IpLiteral", "outboundTcp80ByName", "cloudMetadataService"]) {
    assert.ok(Number.isInteger(n[field].ms) && n[field].ms >= 0, `network.${field}.ms is that attempt's own duration, got ${n[field].ms}`);
  }
});
