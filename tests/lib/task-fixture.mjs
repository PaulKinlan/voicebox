import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";
import { readJsonlFile } from "./jsonl.mjs";

export async function post(base, route, body, headers = {}) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

// agent:false + Connection:close: each call opens and authenticates a genuinely NEW TCP connection.
export function freshExecute(base, pairing, tool, args, callId = "readback") {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ envKey: pairing.envKey, tool, args });
    let localPort;
    const request = http.request(`${base}/api/execute`, {
      method: "POST", agent: false,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close", authorization: `Bearer ${pairing.bearer}`, "x-voicebox-call-id": callId },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => { try { resolve({ status: response.statusCode, body: JSON.parse(text), localPort }); } catch (error) { reject(error); } });
    });
    request.on("socket", (socket) => socket.on("connect", () => { localPort = socket.localPort; }));
    request.on("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("owned task request timed out")));
    request.end(body);
  });
}

export async function taskFixture(t, { runtime = true, env: extraEnv = {} } = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-d1-http-")));
  const workspace = path.join(scratch, "root-a");
  const secondRoot = path.join(scratch, "root-b");
  const hostDir = path.join(scratch, "host");
  const controls = path.join(scratch, "controls");
  for (const dir of [workspace, secondRoot, hostDir, controls]) fs.mkdirSync(dir);
  const preload = typeof runtime === "string" ? runtime : fileURLToPath(new URL("../fixtures/task-runtime.mjs", import.meta.url));
  let server;
  const env = {
    VOICEBOX_WORKSPACE: workspace, VOICEBOX_EXTENSIONS_DIR: hostDir,
    VOICEBOX_TASK_FIXTURE: controls, VOICEBOX_LIVE_PROVIDER: "gemini",
    GEMINI_API_KEY: "", OPENAI_API_KEY: "",
    NODE_OPTIONS: runtime ? `--import=${preload}` : "",
    ...extraEnv,
  };
  async function stop() {
    if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
    const exited = once(server.child, "exit");
    await server.stop();
    await exited;
  }
  t.after(async () => { await stop(); fs.rmSync(scratch, { recursive: true, force: true }); });
  async function start() {
    server = await startServer({ env, cwd: scratch });
    // Routing metadata only: the owned server gets a different ephemeral port on restart.
    // Existing /environments cannot edit an origin; the fixture host updates its own file.
    const registry = path.join(workspace, "environments.json");
    if (fs.existsSync(registry)) {
      const content = JSON.parse(fs.readFileSync(registry, "utf8"));
      for (const row of content.environments) row.origin = server.base;
      fs.writeFileSync(registry, JSON.stringify(content));
    }
    return server;
  }
  await start();
  async function pair(label) {
    const declared = await post(server.base, "/api/environments", { kind: "server", label, origin: server.base });
    if (declared.status !== 200) throw new Error(`fixture environment declaration refused: ${declared.status}`);
    const envKey = declared.body.environment.key;
    const issued = await post(server.base, "/api/pair", { envKey }, { "x-voicebox-host-token": server.hostToken });
    if (issued.status !== 200) throw new Error(`fixture pairing refused: ${issued.status}`);
    const bearer = issued.body.bearer;
    const stored = await post(server.base, "/api/pair/complete", { envKey, bearer }, { "x-voicebox-host-token": server.hostToken });
    if (stored.status !== 200) throw new Error(`fixture custody refused: ${stored.status}`);
    return { envKey, bearer };
  }
  return {
    get server() { return server; }, workspace, secondRoot, hostDir, controls, pair, stop, start,
    starts() {
      return readJsonlFile(path.join(controls, "starts.jsonl"));
    },
  };
}

/**
 * A MACHINE-SPEED DEADLINE, NOT A SEMANTIC ONE (voicebox-beads-i9k0, voicebox-beads-u32a).
 *
 * These suites wait for a RECORDED state: the assertion is about what the audit says, never about how long the
 * executor took. The deadline therefore bounds only how long a genuinely broken run waits, and every second it is
 * too short buys a false red. Measured on one gate: `task-redaction`'s partial-secret arm reported "condition did not
 * occur" with the FINAL read already showing state:"failed" and the redacted partial — the window expired a moment
 * before the condition it was waiting for was satisfied, because a status read itself costs seconds on a loaded box
 * (the arm spent 15s inside a 4s window). Running longer asserts exactly the same thing.
 *
 * One helper, one deadline, overridable: `VOICEBOX_TASK_POLL_MS=60000 npm run test:unit`.
 */
export const TASK_POLL_MS = Number(process.env.VOICEBOX_TASK_POLL_MS ?? 30_000);

export async function until(read, predicate, timeoutMs = TASK_POLL_MS) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition did not occur within ${timeoutMs}ms: ${JSON.stringify(read())}`);
}
