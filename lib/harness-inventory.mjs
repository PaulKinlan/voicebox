// Read-only host inventory, not configured agents or permission to delegate.
import { spawn } from "node:child_process";
import { access, lstat, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiAcpExecutor } from "./pi-acp.mjs";
import { readHarnessTools } from "./harness-tools.mjs";

const CLIS = [
  ["pi", "Pi coding agent", "Coding assistant with its own tools and model configuration; pi-acp adapts it to ACP.", /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/],
  ["claude", "Claude Code", "Anthropic coding CLI with its own project permissions and authentication.", /^(\d+\.\d+\.\d+(?:-[\w.-]+)?) \(Claude Code\)$/],
  ["codex", "Codex CLI", "OpenAI coding CLI with its own approval and execution settings.", /^codex-cli (\d+\.\d+\.\d+(?:-[\w.-]+)?)$/],
  ["gemini", "Gemini CLI", "Google coding CLI with its own tools and authentication.", /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/],
  ["opencode", "OpenCode", "Coding CLI with its own provider and tool configuration.", /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/],
  ["aider", "Aider", "Terminal pair-programming CLI; ACP support is not established here.", /^aider (\d+\.\d+\.\d+(?:-[\w.-]+)?)$/],
];

async function locate(command, searchPath) {
  // Never execute from the current project through an empty/relative PATH entry.
  for (const dir of searchPath.split(path.delimiter).filter(path.isAbsolute)) {
    const file = path.join(dir, command);
    try { await lstat(file); return file; }
    catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e; }
  }
  return null;
}

function versionCheck(file, timeoutMs, env) {
  return new Promise((resolve) => {
    let timedOut = false, error = null, stdout = "", bytes = 0;
    const child = spawn(file, ["--version"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      // A wrapper's children must not outlive the bounded version check.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    };
    const deadline = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    function charge(chunk) {
      bytes += chunk.length;
      if (bytes > 8192) { error = { code: "output-limit" }; kill(); return false; }
      return true;
    }
    child.stdout.on("data", (chunk) => { if (charge(chunk)) stdout += chunk.toString(); });
    child.stderr.on("data", charge); // Raw errors may contain secrets; discard them.
    child.on("error", (e) => { error = e; });
    child.on("close", (code) => {
      clearTimeout(deadline);
      kill();
      resolve({ error: error ?? (!timedOut && code === 0 ? null : { code }), timedOut, text: stdout.trim() });
    });
  });
}

export async function discoverHarnesses({ env = process.env, timeoutMs = 3000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error("version checks require a 1–10000ms deadline");
  // pi installs extensions here. Metadata is evidence of installation, NOT a runnable adapter.
  const adapterDir = env.VOICEBOX_ACP_ADAPTER ?? path.join(os.homedir(), ".pi/agent/npm/node_modules/pi-acp");
  const piExecutor = createPiAcpExecutor({ adapterDir, env });
  const entries = await Promise.all(CLIS.map(async ([id, name, description, versionPattern]) => {
    const row = { id, name, description, command: id, state: "unknown", version: null,
      capabilities: "Purpose described above; project access, tools, authentication and ACP support are not measured.",
      delegation: id === "pi" ? piExecutor.check({ input: { agent: "pi" } }) : { ok: false, refused: "adapter-not-configured", why: "No Voicebox task adapter is configured for this CLI; configure an adapter before delegating." } };
    let file;
    try { file = id === "pi" && env.VOICEBOX_ACP_PI ? env.VOICEBOX_ACP_PI : await locate(id, env.PATH ?? ""); }
    catch { return { ...row, why: "PATH could not be inspected; check host directory permissions and retry." }; }
    if (!file) return { ...row, state: "absent", why: "Not found in this server's absolute PATH directories; install it or correct the server PATH." };
    try {
      if (!path.isAbsolute(file) || !(await stat(file)).isFile()) throw new Error("not a file");
      await access(file, constants.X_OK);
    } catch { return { ...row, state: "unrunnable", why: "Found a command or configured path, but it is not an accessible executable file; repair the install or permissions." }; }
    const { error, timedOut, text } = await versionCheck(file, timeoutMs, env);
    if (error) return { ...row, state: "unrunnable", why: timedOut
      ? `The version check exceeded ${timeoutMs}ms and was killed; run ${id} --version in the host shell to diagnose.`
      : `The version check failed (${typeof error.code === "number" ? `exit ${error.code}` : "spawn or output error"}); run ${id} --version in the host shell to diagnose.` };
    const match = text.match(versionPattern);
    if (!match) return { ...row, why: "A command exists, but its version response is not recognized; inspect the host install. Identity and readiness are unknown." };
    return { ...row, state: "present", version: match[1], why: "Version check passed only; no model task, authentication or ACP handshake was attempted." };
  }));
  const adapter = { id: "pi-acp", name: "Pi ACP adapter", command: "pi-acp", description: "Adapts Pi's coding agent to Agent Client Protocol.",
    state: "unknown", version: null, capabilities: "ACP adapter package; no handshake or model task tested by inventory.", delegation: piExecutor.check({ input: { agent: "pi-acp" } }) };
  try {
    const pkg = JSON.parse(await readFile(path.join(adapterDir, "package.json"), "utf8"));
    if (pkg.name !== "pi-acp" || typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) {
      adapter.why = "Configured package metadata is not recognized as pi-acp; check VOICEBOX_ACP_ADAPTER on the host.";
    } else {
      adapter.version = pkg.version;
      adapter.why = "Installed package metadata found; runnable state unknown. Inventory does not start an ACP session.";
    }
  } catch (e) {
    adapter.state = e.code === "ENOENT" ? "absent" : "unknown";
    adapter.why = "Adapter metadata unavailable; install pi-acp or set VOICEBOX_ACP_ADAPTER to its package directory on the host.";
  }
  entries.push(adapter);
  const catalogues = await readHarnessTools(env.VOICEBOX_HARNESS_TOOLS, entries.map((row) => row.id));
  for (const row of entries) row.toolCatalogue = catalogues[row.id];
  return { ok: true, observedAt: new Date().toISOString(), scope: "Voicebox server machine only", entries,
    note: "Known CLI names in absolute PATH plus the Pi ACP package location; not an exhaustive machine scan. Tool catalogues are host-supplied declarations, not observed session tools or permissions. A matching version is not identity attestation or task readiness. No configured default, fleet discovery or model task is supplied. Listing tools does not enable delegation." };
}

// ponytail: one 60s snapshot per server, single-flight to bound repeated HTTP probes.
// Add explicit authenticated refresh only if operators need fresher observations.
export function createHarnessInventory() {
  let pending, expires = 0;
  return () => {
    if (!pending || Date.now() >= expires) {
      expires = Date.now() + 60000;
      pending = discoverHarnesses().catch((e) => { pending = null; throw e; });
    }
    return pending;
  };
}
