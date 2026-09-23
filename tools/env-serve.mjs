#!/usr/bin/env node
/**
 * env-serve/1 — the process a fenced environment RUNS so that it serves.
 *
 * An environment that only answers a probe once is a measurement, not a place.
 * This is the smallest honest server an environment can run: it probes ITSELF
 * at boot (the same sandbox-probe the host would run), keeps that report, and
 * serves it on the loopback port the fence names in PORT.
 *
 *   GET /health  → { ok:true } — liveness, no measurement
 *   GET /probe   → the environment's own probe report, measured at boot
 *   GET /        → the probe report (an environment's face is its boundary)
 *
 * Zero dependencies. Run INSIDE the fence: /usr/bin/node /srv/voicebox/tools/env-serve.mjs
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 0);
const PROBE = process.env.SANDBOX_PROBE ?? "/probes/sandbox-probe.mjs";

/** Run the probe against this environment; resolve the parsed report or the failure as data. */
function selfProbe() {
  return new Promise((resolve) => {
    execFile("/usr/bin/node", [PROBE], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const text = String(stdout ?? "").trim();
      if (!text) return resolve({ probe: "sandbox-probe/1", when: new Date().toISOString(), error: `the probe printed nothing: ${err?.message ?? "unknown"}` });
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ probe: "sandbox-probe/1", when: new Date().toISOString(), error: "the probe printed something that was not JSON" });
      }
    });
  });
}

const report = await selfProbe();

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, serves: "env-serve/1" }));
  }
  if (url.pathname === "/" || url.pathname === "/probe") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(report));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, refused: "unknown-path", why: "an environment serves its boundary: /health, /probe" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`env-serve/1 listening on 127.0.0.1:${server.address().port}`);
});
