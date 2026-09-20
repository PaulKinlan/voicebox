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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Spawn `server.mjs` on an ephemeral port.
 *
 * @returns {Promise<{port: number, base: string, child: import("node:child_process").ChildProcess, stop: () => Promise<void>}>}
 */
export async function startServer({ env = {}, cwd = ROOT, readyTimeoutMs = 20000 } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd,
    // THE DEFAULTS LIVE HERE, so a lane cannot forget them. Spreading `process.env` means a developer's
    // shell leaks into every fixture that does not override it — and this project's own development
    // flags are exactly the ones that break tests: `VOICEBOX_PROVIDER=live` (what a voice-path
    // developer exports) makes turns stop writing, and `VOICEBOX_WORKSPACE` declares a root the fixture
    // did not ask for. Nine suites each remembering a pin is nine chances to forget; one default is one
    // chance to get it right. A caller that genuinely wants either value still passes it in `env`,
    // which is spread last.
    //
    // (Found by the reviewer's per-suite property check: nine of ten pinned suites failed wholesale
    // under `VOICEBOX_PROVIDER=live`, because d8af9a0 pinned the root in ten files and the provider in
    // one. Per-suite solo runs are the reliable instrument for this; whole-gate runs are noisy.)
    env: {
      ...process.env,
      PORT: "0",
      VOICEBOX_PROVIDER: env.VOICEBOX_PROVIDER ?? "script",
      VOICEBOX_WORKSPACE: env.VOICEBOX_WORKSPACE ?? undefined, // undefined = omitted: no root from the shell
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let noise = "";
  child.stderr.on("data", (chunk) => {
    noise += String(chunk);
  });

  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`the server printed no port within ${readyTimeoutMs}ms${noise ? `\n${noise}` : ""}`)),
      readyTimeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited before binding (code ${code})${noise ? `\n${noise}` : ""}`));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${base}/api/health`)).ok;
    } catch {
      /* not up yet */
    }
    if (!up) await sleep(50);
  }
  if (!up) throw new Error(`the server bound ${port} but never answered /api/health`);

  return {
    port,
    base,
    child,
    async stop() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    },
  };
}
