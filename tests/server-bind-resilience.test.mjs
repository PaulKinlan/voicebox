// tests/server-bind-resilience.test.mjs — a taken port must not kill the server.
//
//   node --test tests/server-bind-resilience.test.mjs
//
// WHAT THIS IS FOR, and the honest note about how it was found. Coord's report: the API server dies
// when a landing changes `lib/` under a `--watch` supervisor — the new process loses the bind, the
// port goes dead, and Paul spent an evening reading a UI with no loop behind it. Three actors hit it
// in one night.
//
// I COULD NOT REPRODUCE THE `--watch` TRIGGER ITSELF on this machine: forcing a restart by rewriting
// `lib/resolver.mjs` with identical bytes produced a clean rebind and `/api/health` answered at every
// poll. So there is no timing lottery here pretending to be a reproduction. What IS measured is the
// MECHANISM that produces the dead port — the old code died with an uncaught EADDRINUSE and, under
// `--watch`, nothing restarts it until the next file change — and that is what these checks pin:
//
//   1. a held port at boot is retried, and the server binds when the holder leaves;
//   2. if the port stays held past the deadline, the process exits with a NAMED sentence rather than
//      a stack trace, so whoever started it can tell a taken port from a crash;
//   3. the reported path — a landing-triggered `--watch` restart — leaves a port that answers.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server.mjs");

/** Kill a whole process group and wait for it: a forked supervisor does not die with its parent. */
async function reap(child) {
  const done = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  await Promise.race([done, sleep(2000)]);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** A free port, picked by the OS and released: no suite may pin one. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Hold a port for `ms`, the way a supervisor's outgoing child or a stale copy would.
 *
 * The connections are DESTROYED before closing: a bare net server that never answers keeps any
 * probe connection open, and `close()` waits for it — which hung this test's own teardown rather
 * than the thing under test.
 */
async function holdPort(port, ms) {
  const blocker = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    blocker.closeAllConnections?.();
    await new Promise((resolve) => blocker.close(resolve));
  };
  setTimeout(() => void release(), ms);
  return { release };
}

const health = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })).status;
  } catch {
    return 0;
  }
};

test("a port held at boot is retried, and the server binds when the holder lets go", { timeout: 60000 }, async () => {
  const port = await freePort();
  const { release } = await holdPort(port, 1500);

  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    detached: true, // its own group, so the teardown below can reap all of it
    env: { ...process.env, PORT: String(port), VOICEBOX_BIND_RETRY_MS: "150", VOICEBOX_BIND_DEADLINE_MS: "10000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += String(d)));
  child.stderr.on("data", (d) => (output += String(d)));

  try {
    // The server must NOT have exited while the port was held — that is the whole defect.
    assert.equal(child.exitCode, null, `the server exited instead of retrying:\n${output}`);

    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = (await health(port)) === 200;
      if (!up) await sleep(250);
    }
    assert.equal(up, true, `the server never answered after the port was released:\n${output}`);
    // The stable contract (the gate may assert on it too): a `[bind]` line naming the port and the
    // condition, per attempt, so the eventual message can say how long it waited and for what.
    assert.match(output, /\[bind\] waiting for 127\.0\.0\.1:\d+ to be released/, "the retry was silent — nobody would know it happened");
    assert.match(output, /EADDRINUSE/, "the retry does not name the condition it is waiting on");
    assert.match(output, /voicebox on http:\/\/127\.0\.0\.1:\d+/, "the server did not announce its address");
  } finally {
    await release().catch(() => {});
    await reap(child);
  }
});

test("a port held past the deadline is a NAMED refusal, not a stack trace", { timeout: 60000 }, async () => {
  const port = await freePort();
  const { release } = await holdPort(port, 30000);

  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    detached: true,
    env: { ...process.env, PORT: String(port), VOICEBOX_BIND_RETRY_MS: "100", VOICEBOX_BIND_DEADLINE_MS: "800" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += String(d)));
  child.stderr.on("data", (d) => (output += String(d)));

  const exited = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    setTimeout(() => resolve(null), 15000);
  });

  try {
    assert.notEqual(exited, null, `the server neither bound nor gave up:\n${output}`);
    assert.match(output, /\[bind\] giving up/, "a held port was not reported in words");
    assert.match(output, new RegExp(`\\[bind\\] giving up after waiting \\d+ms for 127\\.0\\.0\\.1:${port}`), "the message does not say how long it waited or which port");
    assert.match(output, /ss -ltnp/, "the message does not say how to find the holder");
    assert.equal(
      /at Server\.setupListenHandle/.test(output),
      false,
      "the failure is still a raw stack trace, which is the thing that leaves a dead port unexplained",
    );
  } finally {
    await release().catch(() => {});
    await reap(child);
  }
});

test("the reported path: a landing-triggered --watch restart leaves a port that answers", { timeout: 90000 }, async () => {
  const port = await freePort();
  const watched = path.join(ROOT, "lib", "resolver.mjs");
  const original = readFileSync(watched);

  // `--watch` FORKS: the supervisor is the parent and the server is its child, so killing the parent
  // alone left a live supervisor holding the port — which hung this very file rather than the thing
  // under test. Its own process group is killed as a group.
  const child = spawn(process.execPath, ["--watch", SERVER], {
    cwd: ROOT,
    detached: true,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += String(d)));
  child.stderr.on("data", (d) => (output += String(d)));

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = (await health(port)) === 200;
      if (!up) await sleep(250);
    }
    assert.equal(up, true, `the supervised server never came up:\n${output}`);

    // A landing's shape: a file under lib/ changes. Identical bytes, so the tree stays clean; the
    // mtime is what the watcher sees.
    writeFileSync(watched, original);
    await sleep(250);

    const deadline = Date.now() + 20000;
    let answered = false;
    while (Date.now() < deadline && !answered) {
      answered = (await health(port)) === 200;
      if (!answered) await sleep(250);
    }
    assert.equal(answered, true, `the port never answered again after the restart:\n${output}`);
    assert.match(output, /Restarting/, "the watcher never restarted, so this check did not exercise the path");
  } finally {
    await reap(child);
  }
});
