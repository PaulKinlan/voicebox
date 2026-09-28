#!/usr/bin/env node
/**
 * env-serve/1 — the process a fenced environment RUNS so that it serves.
 *
 * An environment that only answers a probe once is a measurement, not a place.
 * This is the smallest honest server an environment can run: it probes ITSELF
 * at boot (the same sandbox-probe the host would run), keeps that report, and
 * serves it on the loopback port the fence names in PORT.
 *
 *   GET  /health      → { ok:true, serves, exec, bootMarker? } — liveness + whether the door is open
 *   GET  /probe       → the environment's own probe report, measured at boot
 *   GET  /            → the probe report (an environment's face is its boundary)
 *   POST /exec        → run a command INSIDE this environment, bounded — PAIRING BEARER required
 *   GET  /git/config  → the global git identity inside this environment
 *   POST /git/config  → set it (name / email) — PAIRING BEARER required
 *   POST /git/init    → make the workspace a git repository (idempotent) — PAIRING BEARER required
 *
 * AUTH (voicebox-beads-pehr): the mutating doors answer only with the pairing bearer this boot
 * was minted (VOICEBOX_BEARER, carried by the boot channel beside VOICEBOX_BOOT_MARKER). Without
 * the gate, any same-machine process reaching this loopback port could run commands inside the
 * fence — the fence bounds WHAT a command touches; nothing else bounds WHO asks. A boot minted
 * no bearer keeps the doors closed with `exec-unpaired` — pair, then re-boot. /health, /probe
 * and the git read stay open either way: they are the boundary report, not the door. The
 * credential is verified timing-safe and never echoed in a refusal.
 *
 * THE COMMAND SURFACE IS INSIDE THE FENCE (voicebox-beads-0vlp). The caller names an argv, or a
 * shell command when it wants pipelines; the fence is what bounds the child — a read-only source
 * tree, a writable sandbox home, no host home, and (in the L1.5 composition) seccomp + no
 * capabilities. Every outcome is a value: a non-zero exit is `ok:true` with the code, because the
 * command RAN; refusals are reserved for requests that cannot run or that crossed a bound
 * (`exec-bad-request`, `exec-cwd-outside-home`, `exec-timeout`, `exec-output-over-budget`,
 * `exec-spawn-failed`). Output is capped by the same request, and a killed child is killed as a
 * PROCESS GROUP so a shell's grandchildren die with it.
 *
 * Zero dependencies. Run INSIDE the fence: /usr/bin/node /srv/voicebox/tools/env-serve.mjs
 */
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildFenceChildEnv } from "../lib/fence-child-env.mjs";

const PORT = Number(process.env.PORT ?? 0);
const PROBE = process.env.SANDBOX_PROBE ?? "/probes/sandbox-probe.mjs";
const HOME = process.env.HOME ?? "/home/voice";
const WORKSPACE = path.join(HOME, "workspace");
// BOOT IDENTITY: the marker this boot was launched with (xqg's per-boot pattern). /health answers
// with it, so the host that minted it can tell THIS environment from a stranger that grabbed the
// recycled port first — an open port answering 200 is not proof of who is answering.
const BOOT_MARKER = process.env.VOICEBOX_BOOT_MARKER ?? null;
// THE DOOR'S CREDENTIAL (voicebox-beads-pehr): the pairing bearer at boot time, held in memory
// only. A re-pairing takes effect on the next boot — the same restart contract as the boot marker.
const BEARER = process.env.VOICEBOX_BEARER ?? null;

/** Length-gated timing-safe compare; the credential is never echoed back in a refusal. */
function bearerOk(header) {
  if (!BEARER || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(BEARER);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

const EXEC_LIMITS = { timeoutMs: [100, 60000], maxBytes: [1024, 1048576] };
const EXEC_DEFAULTS = { timeoutMs: 10000, maxBytes: 262144 };
const ARG_MAX = 64;
const ARG_LEN_MAX = 4096;

/**
 * The environment a command runs with: minimal, measured, and stripped of ambient secrets (voicebox-beads-4uw0).
 *
 * An inherited process.env leaks host secrets (e.g. API keys, tokens, session credentials) into the
 * sandbox child process. The child environment is pinned to the minimal set of variables that Unix
 * commands and git actually require, with HOME/XDG pinned to the sandbox home.
 */
const CHILD_ENV = buildFenceChildEnv({ home: HOME, hostEnv: process.env });

const SH_BIN = fs.existsSync("/usr/bin/sh") ? "/usr/bin/sh" : "/bin/sh";

/** Run the probe against this environment; resolve the parsed report or the failure as data. */
function selfProbe() {
  return new Promise((resolve) => {
    execFile(process.execPath, [PROBE], { timeout: 20000, maxBuffer: 8 * 1024 * 1024, env: CHILD_ENV }, (err, stdout) => {
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

/** Read a JSON body with a byte bound. Resolves `{ ok:false }` for unreadable/oversize bodies. */
function readJson(req, limit = 65536) {
  return new Promise((resolve) => {
    let size = 0, over = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { over = true; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return resolve({ ok: false, why: `the body exceeded ${limit} bytes` });
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ ok: false, why: "the body was not JSON" });
      }
    });
    req.on("error", () => resolve({ ok: false, why: "the body could not be read" }));
  });
}

/** A path that must resolve inside HOME; the sandbox home is the only writable tree by construction. */
function resolveCwd(raw) {
  const candidate = raw === undefined || raw === null || raw === "" ? WORKSPACE : String(raw);
  let real, realHome;
  try {
    real = fs.realpathSync(path.resolve(HOME, candidate));
    realHome = fs.realpathSync(HOME);
  } catch {
    return { refused: "exec-cwd-missing", why: `\`${candidate}\` is not a directory in this environment` };
  }
  const rel = path.relative(realHome, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { refused: "exec-cwd-outside-home", why: `cwd \`${candidate}\` is outside HOME (${HOME}) — the sandbox home is the only writable tree` };
  }
  if (!fs.statSync(real).isDirectory()) return { refused: "exec-cwd-missing", why: `\`${candidate}\` is not a directory` };
  return { ok: true, cwd: real };
}

/** Parse `{ argv | command, cwd?, timeoutMs?, maxBytes? }` into a bounded execution request. */
function parseExec(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, refused: "exec-bad-request", why: "send { argv: [...] } or { command: \"...\" }" };
  }
  let argv = null;
  if (Array.isArray(body.argv)) {
    if (body.argv.length === 0 || body.argv.length > ARG_MAX || body.argv.some((a) => typeof a !== "string" || a.length === 0 || a.length > ARG_LEN_MAX)) {
      return { ok: false, refused: "exec-bad-request", why: `argv must be 1..${ARG_MAX} non-empty strings of at most ${ARG_LEN_MAX} characters` };
    }
    argv = [...body.argv];
  } else if (typeof body.command === "string" && body.command.trim()) {
    if (body.command.length > 65536) return { ok: false, refused: "exec-bad-request", why: "command is bounded to 65536 characters" };
    argv = [SH_BIN, "-c", body.command];
  } else {
    return { ok: false, refused: "exec-bad-request", why: "send { argv: [...] } or { command: \"...\" }" };
  }
  const timeoutMs = body.timeoutMs === undefined ? EXEC_DEFAULTS.timeoutMs : Number(body.timeoutMs);
  const maxBytes = body.maxBytes === undefined ? EXEC_DEFAULTS.maxBytes : Number(body.maxBytes);
  if (!Number.isInteger(timeoutMs) || timeoutMs < EXEC_LIMITS.timeoutMs[0] || timeoutMs > EXEC_LIMITS.timeoutMs[1]) {
    return { ok: false, refused: "exec-bad-request", why: `timeoutMs must be an integer between ${EXEC_LIMITS.timeoutMs[0]} and ${EXEC_LIMITS.timeoutMs[1]}` };
  }
  if (!Number.isInteger(maxBytes) || maxBytes < EXEC_LIMITS.maxBytes[0] || maxBytes > EXEC_LIMITS.maxBytes[1]) {
    return { ok: false, refused: "exec-bad-request", why: `maxBytes must be an integer between ${EXEC_LIMITS.maxBytes[0]} and ${EXEC_LIMITS.maxBytes[1]}` };
  }
  const cwd = resolveCwd(body.cwd);
  if (!cwd.ok) return { ok: false, ...cwd };
  return { ok: true, value: { argv, cwd: cwd.cwd, timeoutMs, maxBytes } };
}

/** Run a parsed request INSIDE this environment. Resolves an outcome, never throws. */
function runExec({ argv, cwd, timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = "", stderr = "", bytes = 0, refusal = null;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: CHILD_ENV, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ ok: false, refused: "exec-spawn-failed", why: String(err?.message ?? err).slice(0, 300) });
    }
    const killGroup = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => { if (!refusal) { refusal = "exec-timeout"; killGroup(); } }, timeoutMs);
    const take = (chunk, append) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { if (!refusal) { refusal = "exec-output-over-budget"; killGroup(); } return; }
      append(chunk.toString("utf8"));
    };
    child.stdout.on("data", (chunk) => take(chunk, (s) => (stdout += s)));
    child.stderr.on("data", (chunk) => take(chunk, (s) => (stderr += s)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, refused: "exec-spawn-failed", why: String(err?.message ?? err).slice(0, 300), argv });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - started);
      if (refusal === "exec-timeout") {
        return resolve({ ok: false, refused: "exec-timeout", why: `the command did not finish within ${timeoutMs}ms — killed as a process group`, stdout, stderr, durationMs, exitCode: code, signal, argv });
      }
      if (refusal === "exec-output-over-budget") {
        return resolve({ ok: false, refused: "exec-output-over-budget", why: `output exceeded ${maxBytes} bytes — killed as a process group`, stdout, stderr, durationMs, exitCode: code, signal, argv });
      }
      // A non-zero exit is NOT a refusal: the command ran, and its code is the answer.
      resolve({ ok: true, exitCode: code, signal, stdout, stderr, durationMs, cwd, argv });
    });
  });
}

/** Run a small git command inside the environment with the sandbox HOME; resolve and parse. */
function runGit(args) {
  return new Promise((resolve) => {
    // CHILD_ENV pins the identity to the SANDBOX home and drops any host GIT_* binding, so
    // `git config --global` writes <HOME>/.gitconfig and `git init` initializes the workspace.
    execFile("/usr/bin/git", args, { timeout: 10000, maxBuffer: 1024 * 1024, env: CHILD_ENV }, (err, stdout, stderr) => {
      resolve({ code: err?.code === undefined ? 0 : err.code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function gitConfigRead() {
  const name = await runGit(["config", "--global", "--get", "user.name"]);
  const email = await runGit(["config", "--global", "--get", "user.email"]);
  return { name: name.code === 0 ? name.stdout.trim() || null : null, email: email.code === 0 ? email.stdout.trim() || null : null };
}

/** Validate a git identity; a control character in a name is a refusal, not a config line. */
function parseGitConfig(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, refused: "git-config-bad-request", why: "send { name?, email? } — at least one field" };
  }
  const out = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return { ok: false, refused: "git-config-bad-request", why: "name must be a string" };
    const name = body.name.trim();
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
      return { ok: false, refused: "git-config-bad-request", why: "name must be 1..200 characters with no control characters" };
    }
    out.name = name;
  }
  if (body.email !== undefined) {
    if (typeof body.email !== "string") return { ok: false, refused: "git-config-bad-request", why: "email must be a string" };
    const email = body.email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320 || /[\u0000-\u001f\u007f]/.test(email)) {
      return { ok: false, refused: "git-config-bad-request", why: "email must look like name@host.tld (at most 320 characters)" };
    }
    out.email = email;
  }
  if (out.name === undefined && out.email === undefined) {
    return { ok: false, refused: "git-config-bad-request", why: "send { name?, email? } — at least one field" };
  }
  return { ok: true, value: out };
}

const report = await selfProbe();

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, serves: "env-serve/2", exec: Boolean(BEARER), ...(BOOT_MARKER ? { bootMarker: BOOT_MARKER } : {}) });
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/probe")) {
    return send(res, 200, report);
  }
  // THE DOOR'S GATE (voicebox-beads-pehr): every mutating route requires the pairing bearer,
  // checked before anything is read or run, never trusted from the body, never echoed back.
  const isDoor = req.method === "POST" && ["/exec", "/git/config", "/git/init"].includes(url.pathname);
  if (isDoor) {
    if (!BEARER) {
      return send(res, 403, { ok: false, refused: "exec-unpaired", why: "this environment booted unpaired, so its work surface is closed — pair it (host-token gated) and re-boot the environment" });
    }
    if (!bearerOk(req.headers.authorization)) {
      return send(res, 403, { ok: false, refused: "unauthenticated", why: "the bearer does not match what this boot was minted — the host pairs, the environment verifies" });
    }
  }
  if (req.method === "POST" && url.pathname === "/exec") {
    const body = await readJson(req);
    if (!body.ok) return send(res, 200, { ok: false, refused: "exec-bad-request", why: body.why });
    const parsed = parseExec(body.value);
    if (!parsed.ok) return send(res, 200, { ok: false, refused: parsed.refused, why: parsed.why });
    return send(res, 200, await runExec(parsed.value));
  }
  if (url.pathname === "/git/config" && req.method === "GET") {
    return send(res, 200, { ok: true, config: await gitConfigRead(), home: HOME });
  }
  if (url.pathname === "/git/config" && req.method === "POST") {
    const body = await readJson(req);
    if (!body.ok) return send(res, 200, { ok: false, refused: "git-config-bad-request", why: body.why });
    const parsed = parseGitConfig(body.value);
    if (!parsed.ok) return send(res, 200, { ok: false, refused: parsed.refused, why: parsed.why });
    try { fs.mkdirSync(HOME, { recursive: true }); } catch { /* the fence made it writable; a failure here is named below */ }
    for (const [key, value] of Object.entries(parsed.value)) {
      const set = await runGit(["config", "--global", key === "name" ? "user.name" : "user.email", value]);
      if (set.code !== 0) {
        return send(res, 200, { ok: false, refused: "git-config-unwritable", why: `git config --global ${key === "name" ? "user.name" : "user.email"} refused: ${set.stderr.trim().slice(0, 200) || `exit ${set.code}`}` });
      }
    }
    return send(res, 200, { ok: true, config: await gitConfigRead(), home: HOME });
  }
  if (url.pathname === "/git/init" && req.method === "POST") {
    try { fs.mkdirSync(WORKSPACE, { recursive: true }); } catch { /* named below when git refuses */ }
    const existing = fs.existsSync(path.join(WORKSPACE, ".git"));
    const init = await runGit(["init", "--quiet", WORKSPACE]);
    if (init.code !== 0) {
      return send(res, 200, { ok: false, refused: "git-init-failed", why: init.stderr.trim().slice(0, 200) || `git init exited ${init.code}` });
    }
    return send(res, 200, { ok: true, already: existing, workspace: WORKSPACE, config: await gitConfigRead() });
  }
  send(res, 404, { ok: false, refused: "unknown-path", why: "an environment serves its boundary (/health, /probe) and its work surface (/exec, /git/config, /git/init)" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`env-serve/1 listening on 127.0.0.1:${server.address().port}`);
});
