// tests/lib/server.mjs — start the server on an EPHEMERAL port and hand back its real address.
//
// WHY THIS EXISTS: a suite that pins a port cannot run beside another suite, and the failure shows up
// in a DIFFERENT lane as an unexplained block — "astra cannot run the whole gate" is what that looks
// like from the outside, and the person seeing it has no way to tell it is your test holding 8831.
// Port 0 asks the OS for a free port; the server reports the one it got on its own startup line; the
// suite reads it and never collides with anything, including itself.
//
// Nothing here is browser-specific: it is the shared spawn-and-wait that every HTTP suite in this repo
// was hand-rolling, with the port made correct rather than constant.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Spawn `server.mjs` on an ephemeral port.
 *
 * @returns {Promise<{port: number, base: string, child: import("node:child_process").ChildProcess, stop: () => Promise<void>}>}
 */
/**
 * **Every child this helper spawns is reaped, even when a test never reaches its
 * `stop()`** (`voicebox-beads-6io`).
 *
 * A suite that hangs, throws, or is killed leaves the spawned server behind: the
 * orphan holds its port and its scratch directory, and the next lane's fixture
 * meets a server it did not start. The process-level handler is the last line of
 * defence — synchronous, because `exit` allows nothing else — and `stop()` uses
 * the same reaper so there is one way a child dies.
 */
const LIVE_CHILDREN = new Set();

function reap(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL"); // the group: the server may have children of its own
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  LIVE_CHILDREN.delete(child);
}

process.on("exit", () => {
  for (const child of LIVE_CHILDREN) reap(child);
});

/**
 * READY IS THE STARTUP BANNER — `voicebox on http://127.0.0.1:<port>` (voicebox-beads-4oj6).
 *
 * server.mjs prints that line only once `listen()` has succeeded (bindWithRetry resolves on
 * 'listening'), and every route and upgrade handler is attached before listen() is called, so the line
 * is already proof of what a suite needs: the socket is bound, and a request sent now is answered. The
 * `/api/health` poll that used to follow it guarded nothing further — it was the readiness check of the
 * hand-rolled spawns this helper replaced (b9282b1), which pinned a port and ignored stdout, and so could
 * only knock until something answered. It had also stopped being free: the build identity /api/health
 * reports is now answered off the boot path, and a health poll here would put those git subprocesses
 * back on every boot. scripts/docs-check.mjs already keeps the same rule for its own probe server:
 * readiness is the server's own stdout line, not a route.
 *
 * The pattern demands a NON-DIGIT after the port, so a banner split across two stdout chunks is never
 * read as a truncated port (`:518` of `:51883`). The poll would have turned that misread into a loud
 * failure; without it, the parse itself has to be exact.
 *
 * Lines printed AFTER the banner — the bootstrap URL under VOICEBOX_LOOPBACK_AUTH=1 (voicebox-beads-kkc)
 * — may arrive in a later chunk than the banner: `stdout()` is a live read of everything received so
 * far, and a suite that needs such a line waits for it (tests/loopback-auth.test.mjs polls for it).
 */
const BANNER = /voicebox on http:\/\/127\.0\.0\.1:(\d+)\D/;

/**
 * STOP RETURNS ONCE THE CHILD HAS EXITED (voicebox-beads-4oj6). It used to return the moment the signal
 * was SENT, so a caller's cleanup — `rmSync` of the directories it handed the server — raced a process
 * still alive for a few more milliseconds, and still able to write into them. The kill itself is
 * unchanged: the whole group, SIGKILL, through the one reaper above. What is new is the wait for `exit`,
 * BOUNDED so a wedged process cannot hang a suite: past STOP_BOUND_MS the group is sent SIGKILL again and
 * stop() returns without deleting anything — a leaked directory is recoverable, a delete that races a
 * live writer is not.
 *
 * Then the scratch extensions directory THIS HELPER made (only ever when the caller supplied none) is
 * removed: one was left in the temp dir per startServer() call — 855 of them on the machine that
 * measured this. A directory the caller supplied (`extensionsDir`, or env.VOICEBOX_EXTENSIONS_DIR) stays
 * the caller's and is never touched: suites start a second server on the same directory to prove that
 * state persists.
 */
const STOP_BOUND_MS = 2000;

/** Resolves true once `child` has exited, or false if it has not within `boundMs`. */
function exitOf(child, boundMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, boundMs);
    child.once("exit", onExit);
  });
}

export async function startServer({ env = {}, cwd = ROOT, readyTimeoutMs = 20000, extensionsDir = null } = {}) {
  // A SCRATCH EXTENSIONS DIRECTORY PER SERVER, because that is where the HOST TOKEN lives (mode 0600,
  // host-generated, served by no route — voicebox-beads-m2i). Two things follow: a suite never touches
  // Paul's real one, and a suite that spawns the server IS the host, so it can read the token and act
  // with host authority — which is what declaring a root now requires (voicebox-beads-cfn).
  const suppliedExtensions = extensionsDir ?? env.VOICEBOX_EXTENSIONS_DIR ?? null;
  // Made here only when the caller supplied none — and then it is this helper's to remove, in stop().
  const ownedScratch = suppliedExtensions === null ? mkdtempSync(path.join(os.tmpdir(), "voicebox-ext-")) : null;
  const scratchExtensions = suppliedExtensions ?? ownedScratch;
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd,
    // THE DEFAULTS LIVE HERE, so a lane cannot forget them. Spreading `process.env` means a developer's
    // shell leaks into every fixture that does not override it — and this project's own development
    // flags are exactly the ones that break tests: `VOICEBOX_RESOLVER=live` (what a voice-path
    // developer exports) makes turns stop writing, and `VOICEBOX_WORKSPACE` declares a root the fixture
    // did not ask for. Nine suites each remembering a pin is nine chances to forget; one default is one
    // chance to get it right. A caller that genuinely wants either value still passes it in `env`,
    // which is spread last.
    //
    // (Found by the reviewer's per-suite property check: nine of ten pinned suites failed wholesale
    // under `VOICEBOX_PROVIDER=live` (the resolver's old name), because d8af9a0 pinned the root in ten files and the provider in
    // one. Per-suite solo runs are the reliable instrument for this; whole-gate runs are noisy.)
    env: {
      ...process.env,
      PORT: "0",
      VOICEBOX_RESOLVER: env.VOICEBOX_RESOLVER ?? env.VOICEBOX_PROVIDER ?? "script",
      VOICEBOX_WORKSPACE: env.VOICEBOX_WORKSPACE ?? undefined, // undefined = omitted: no root from the shell
      VOICEBOX_EXTENSIONS_DIR: scratchExtensions,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let noise = "";
  let out = ""; // everything the server prints on stdout — a suite that needs the STARTUP LINES
  // (e.g. the bootstrap URL the loopback-auth gate prints, voicebox-beads-kkc) reads them here
  // instead of re-spawning the server by hand.
  // Registered the moment it exists: a test that never reaches stop() must still be reaped.
  LIVE_CHILDREN.add(child);

  child.stderr.on("data", (chunk) => {
    noise += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
  });

  // One way a child dies (the reaper, voicebox-beads-6io) and now one way it is waited for: the caller's
  // stop(), and the failure path below, which has no caller to hand a stop() to.
  const stop = async () => {
    reap(child);
    if (!(await exitOf(child, STOP_BOUND_MS))) {
      reap(child); // still not gone: SIGKILL the group once more, and leave the directory standing
      return;
    }
    if (ownedScratch) {
      try {
        rmSync(ownedScratch, { recursive: true, force: true });
      } catch {
        /* best effort: a directory left behind is a leak, never a failed test */
      }
    }
  };

  let port;
  try {
    port = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => settle(reject, new Error(`the server printed no port within ${readyTimeoutMs}ms${noise ? `\n${noise}` : ""}`)),
        readyTimeoutMs,
      );
      function onData(chunk) {
        buffer += String(chunk);
        const match = buffer.match(BANNER);
        if (match) settle(resolve, Number(match[1]));
      }
      function onExit(code) {
        settle(reject, new Error(`the server exited before binding (code ${code})${noise ? `\n${noise}` : ""}`));
      }
      function settle(done, value) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        done(value);
      }
      child.stdout.on("data", onData);
      child.on("exit", onExit);
    });
  } catch (error) {
    await stop(); // it never became ready, and the caller never receives a stop() to call
    throw error;
  }

  const base = `http://127.0.0.1:${port}`;

  // The host token, read the way the person's shell reads it: from the host's own directory. A suite
  // that declares a root sends this header; a suite that impersonates the PAGE does not.
  const tokenFile = path.join(scratchExtensions, ".host-token");
  const hostToken = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : null;

  return {
    port,
    base,
    child,
    hostToken,
    extensionsDir: scratchExtensions,
    stdout: () => out,
    stderr: () => noise,
    stop,
  };
}
