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
    env: { ...process.env, PORT: "0", ...env },
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
