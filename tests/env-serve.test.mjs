// tests/env-serve.test.mjs — the environment's command surface, driven (voicebox-beads-0vlp).
//
// The claim: a booted environment can RUN general Unix commands and hold a Git identity, bounded
// by its fence — and the host is the door, never a bypass. This file drives BOTH ends: the
// environment server (tools/env-serve.mjs) against a scratch HOME, and the host route
// (/api/environments/<key>/…) forwarding to it. The FENCED case — the same surface inside a real
// L1.5 sandbox — is driven in tests/unit-fence-provider.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENV_SERVE = path.join(ROOT, "tools", "env-serve.mjs");

/** Spawn env-serve as the environment would run it: its own HOME, its own port, no shared state. */
async function spawnEnvironment(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "0vlp-env-home-"));
  mkdirSync(path.join(home, "workspace"), { recursive: true });
  const child = spawn(process.execPath, [ENV_SERVE], {
    cwd: ROOT,
    // XDG_CONFIG_HOME is pinned to the scratch home too: a test must not read or write the
    // caller's git identity while it proves the sandbox owns its own.
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    setTimeout(() => reject(new Error("env-serve printed no port")), 30000);
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } rmSync(home, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${port}`, home };
}

const ask = async (origin, pathname, body, method = "POST") => {
  const answer = await fetch(`${origin}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: answer.status, body: await answer.json() };
};

test("an environment runs general Unix commands — argv and shell — and every bound is named", async (t) => {
  const env = await spawnEnvironment(t);

  // The handshake first: the environment serves its boundary.
  assert.equal((await ask(env.origin, "/health", undefined, "GET")).body.ok, true);

  // argv: exact, no shell interpretation.
  const echoed = await ask(env.origin, "/exec", { argv: ["/bin/echo", "hello", "sandbox"] });
  assert.equal(echoed.body.ok, true);
  assert.equal(echoed.body.exitCode, 0);
  assert.equal(echoed.body.stdout, "hello sandbox\n");
  assert.equal(echoed.body.cwd, realpathSync(path.join(env.home, "workspace")), "commands default to the sandbox workspace");

  // command: a shell, for pipelines. This is what "general Unix commands" means.
  const piped = await ask(env.origin, "/exec", { command: "printf 'a b c\\n' | tr a-z A-Z" });
  assert.equal(piped.body.ok, true);
  assert.equal(piped.body.stdout, "A B C\n");

  // A non-zero exit is NOT a refusal: the command RAN, and the code is the answer.
  const failed = await ask(env.origin, "/exec", { argv: ["/bin/sh", "-c", "exit 7"] });
  assert.equal(failed.body.ok, true);
  assert.equal(failed.body.exitCode, 7);

  // HOME is the sandbox home: a write lands there, nowhere else.
  const wrote = await ask(env.origin, "/exec", { command: "printf confined > $HOME/proof.txt && cat $HOME/proof.txt" });
  assert.equal(wrote.body.ok, true);
  assert.equal(wrote.body.stdout, "confined");
  assert.equal(readFileSync(path.join(env.home, "proof.txt"), "utf8"), "confined");

  // The bounds refuse BY NAME, with the request that caused them.
  const outside = await ask(env.origin, "/exec", { argv: ["/bin/pwd"], cwd: "/etc" });
  assert.equal(outside.body.refused, "exec-cwd-outside-home");
  const malformed = await ask(env.origin, "/exec", {});
  assert.equal(malformed.body.refused, "exec-bad-request");
  const slow = await ask(env.origin, "/exec", { command: "sleep 5", timeoutMs: 200 });
  assert.equal(slow.body.refused, "exec-timeout", "the deadline is enforced, and the child is killed as a group");
  assert.ok(slow.body.durationMs < 3000, `timeout must be bounded (took ${slow.body.durationMs}ms)`);
  const loud = await ask(env.origin, "/exec", { command: "head -c 20000 /dev/zero", maxBytes: 1024 });
  assert.equal(loud.body.refused, "exec-output-over-budget");
});

test("the environment's Git identity lives IN the sandbox home, and the workspace can become a repository", async (t) => {
  const env = await spawnEnvironment(t);

  const set = await ask(env.origin, "/git/config", { name: "Sandbox Voice", email: "voice@example.invalid" });
  assert.equal(set.body.ok, true);
  assert.deepEqual(set.body.config, { name: "Sandbox Voice", email: "voice@example.invalid" });
  assert.equal(existsSync(path.join(env.home, ".gitconfig")), true, "the identity is a file in the sandbox home");
  assert.match(readFileSync(path.join(env.home, ".gitconfig"), "utf8"), /Sandbox Voice/);

  const read = await ask(env.origin, "/git/config", undefined, "GET");
  assert.deepEqual(read.body.config, { name: "Sandbox Voice", email: "voice@example.invalid" });
  // …and the running environment sees it too, because git reads the same HOME.
  const viaGit = await ask(env.origin, "/exec", { argv: ["/usr/bin/git", "config", "--global", "--get", "user.email"] });
  assert.equal(viaGit.body.stdout.trim(), "voice@example.invalid");

  const bad = await ask(env.origin, "/git/config", { email: "not-an-email" });
  assert.equal(bad.body.refused, "git-config-bad-request");

  const init = await ask(env.origin, "/git/init", {});
  assert.equal(init.body.ok, true, JSON.stringify(init.body));
  assert.equal(init.body.already, false, JSON.stringify(init.body));
  assert.equal(existsSync(path.join(env.home, "workspace", ".git")), true);
  const again = await ask(env.origin, "/git/init", {});
  assert.equal(again.body.already, true, "init is idempotent");
  const status = await ask(env.origin, "/exec", { argv: ["/usr/bin/git", "-C", path.join(env.home, "workspace"), "status", "--porcelain"] });
  assert.deepEqual(status.body.stdout, "");
});

test("the host is the door: local authority is required, the command runs in the environment, and the crossing is named", async (t) => {
  const env = await spawnEnvironment(t);
  const ws = mkdtempSync(path.join(os.tmpdir(), "0vlp-host-ws-"));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: ws }, cwd: ROOT });
  t.after(async () => { await server.stop(); rmSync(ws, { recursive: true, force: true }); });

  const declared = await fetch(`${server.base}/api/environments`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "command surface", kind: "server", origin: env.origin }),
  }).then((r) => r.json());
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const key = declared.environment.key;
  const door = `${server.base}/api/environments/${key}`;
  const hostHeaders = { "content-type": "application/json", "x-voicebox-host-token": server.hostToken };

  // NO authority, no command — the page cannot hand a sandbox a command it does not own.
  const unauthed = await fetch(`${door}/exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "echo no" }) });
  assert.equal(unauthed.status, 403);
  assert.equal((await unauthed.json()).refused, "host-token-required");

  // With authority: the host forwards to the environment and returns ITS outcome.
  const exec = await fetch(`${door}/exec`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ command: "printf via-host" }) }).then((r) => r.json());
  assert.equal(exec.ok, true, JSON.stringify(exec));
  assert.equal(exec.stdout, `via-host`, "the command ran in the ENVIRONMENT, whose stdout is the answer");

  const gitSet = await fetch(`${door}/git/config`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ name: "Through The Door" }) }).then((r) => r.json());
  assert.equal(gitSet.ok, true);
  assert.equal(gitSet.config.name, "Through The Door");
  const gitGet = await fetch(`${door}/git/config`, { headers: hostHeaders }).then((r) => r.json());
  assert.equal(gitGet.config.name, "Through The Door");
  const init = await fetch(`${door}/git/init`, { method: "POST", headers: hostHeaders, body: "{}" }).then((r) => r.json());
  assert.equal(init.ok, true);

  // A key that names nothing is refused by name, not by an empty success.
  const unknown = await fetch(`${server.base}/api/environments/env_0000000000000000/exec`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ command: "echo no" }) }).then((r) => r.json());
  assert.equal(unknown.refused, "unknown-environment");
});

test("fence child env: minimal measured whitelist excludes ambient secrets (voicebox-beads-4uw0)", async () => {
  const { buildFenceChildEnv } = await import("../lib/fence-child-env.mjs");
  const hostEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    USER: "alice",
    LOGNAME: "alice",
    SHELL: "/bin/bash",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GEMINI_API_KEY: "gem-secret",
    OPENAI_API_KEY: "open-secret",
    BRAVE_API_KEY: "brave-secret",
    VOICEBOX_BEARER: "vbx_secret_bearer",
    VOICEBOX_HOST_TOKEN: "host_token_secret",
    VOICEBOX_BOOT_MARKER: "boot_marker_secret",
    GIT_DIR: "/repo/.git",
    GIT_WORK_TREE: "/repo",
    GIT_AUTHOR_NAME: "Host User",
    SSH_AUTH_SOCK: "/tmp/ssh.sock",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "gh-secret",
  };

  const child = buildFenceChildEnv({ home: "/home/voice", hostEnv });

  // Whitelisted variables are present with isolated values
  assert.equal(child.PATH, "/usr/bin:/bin");
  assert.equal(child.HOME, "/home/voice");
  assert.equal(child.XDG_CONFIG_HOME, "/home/voice/.config");
  assert.equal(child.GIT_CONFIG_GLOBAL, "/home/voice/.gitconfig");
  assert.equal(child.USER, "alice");
  assert.equal(child.SHELL, "/bin/bash");
  assert.equal(child.LANG, "en_US.UTF-8");
  assert.equal(child.TERM, "xterm-256color");
  assert.equal(child.TMPDIR, "/tmp");
  assert.equal(child.VOICEBOX_FENCE, "1");

  // Every secret and host repository binding is strictly ABSENT (not undefined-valued)
  for (const secret of [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "BRAVE_API_KEY",
    "VOICEBOX_BEARER",
    "VOICEBOX_HOST_TOKEN",
    "VOICEBOX_BOOT_MARKER",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_AUTHOR_NAME",
    "SSH_AUTH_SOCK",
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
  ]) {
    assert.equal(secret in child, false, `${secret} must be absent from fence child env`);
  }

  assert.equal(Object.isFrozen(child), true, "fence child env must be frozen");
  assert.equal(hostEnv.ANTHROPIC_API_KEY, "sk-ant-secret", "hostEnv is never mutated");
});

test("env-serve /exec live: spawned command environment excludes ambient parent secrets (voicebox-beads-4uw0)", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "4uw0-env-home-"));
  mkdirSync(path.join(home, "workspace"), { recursive: true });

  const child = spawn(process.execPath, [ENV_SERVE], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      PORT: "0",
      ANTHROPIC_API_KEY: "sk-ant-ambient-secret",
      GEMINI_API_KEY: "gem-ambient-secret",
      GIT_DIR: "/ambient/git/dir",
      VOICEBOX_HOST_TOKEN: "ambient-host-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    setTimeout(() => reject(new Error("env-serve printed no port")), 30000);
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} rmSync(home, { recursive: true, force: true }); });

  const origin = `http://127.0.0.1:${port}`;
  const out = await ask(origin, "/exec", { command: "env" });
  assert.equal(out.body.ok, true);

  const envLines = out.body.stdout.split("\n").filter(Boolean);
  const childKeys = new Set(envLines.map((l) => l.split("=")[0]));

  assert.equal(childKeys.has("ANTHROPIC_API_KEY"), false, "ANTHROPIC_API_KEY must not leak into exec command");
  assert.equal(childKeys.has("GEMINI_API_KEY"), false, "GEMINI_API_KEY must not leak into exec command");
  assert.equal(childKeys.has("GIT_DIR"), false, "GIT_DIR must not leak into exec command");
  assert.equal(childKeys.has("VOICEBOX_HOST_TOKEN"), false, "VOICEBOX_HOST_TOKEN must not leak into exec command");

  assert.equal(childKeys.has("PATH"), true, "PATH must be present in child env");
  assert.equal(childKeys.has("HOME"), true, "HOME must be present in child env");
  assert.equal(childKeys.has("VOICEBOX_FENCE"), true, "VOICEBOX_FENCE marker must be present");
});
