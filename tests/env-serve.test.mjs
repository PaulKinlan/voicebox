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

/** Spawn env-serve as the environment would run it: its own HOME, its own port, no shared state.
 *  voicebox-beads-pehr: the fixture boots PAIRED — minted a bearer the same way the fence's boot
 *  channel would carry it. An unpaired boot (bearer: null) is its own case below. */
async function spawnEnvironment(t, { bearer = "vbx_fixture_bearer_pehr" } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "0vlp-env-home-"));
  mkdirSync(path.join(home, "workspace"), { recursive: true });
  const child = spawn(process.execPath, [ENV_SERVE], {
    cwd: ROOT,
    // XDG_CONFIG_HOME is pinned to the scratch home too: a test must not read or write the
    // caller's git identity while it proves the sandbox owns its own.
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PORT: "0", ...(bearer ? { VOICEBOX_BEARER: bearer } : {}) },
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
  return { origin: `http://127.0.0.1:${port}`, home, bearer };
}

const ask = async (origin, pathname, body, method = "POST", bearer = "vbx_fixture_bearer_pehr") => {
  const answer = await fetch(`${origin}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
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

  // PAIR first (pehr): the host records the bearer it will use when calling this environment —
  // the fixture env was booted minted with it, so the door opens for the host and nobody else.
  const pair = await fetch(`${server.base}/api/pair/complete`, {
    method: "POST", headers: hostHeaders,
    body: JSON.stringify({ envKey: key, bearer: env.bearer }),
  }).then((r) => r.json());
  assert.equal(pair.ok, true, `pairing the host to the fixture environment: ${JSON.stringify(pair)}`);

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

// ── The door's gate (voicebox-beads-pehr) ────────────────────────────────────────────────
// The mutating doors (/exec, /git/config POST, /git/init) answer only with the pairing bearer
// this boot was minted. These tests drive env-serve DIRECTLY (own HOME, own port) so the gate
// is pinned without a fence, a host, or a boot.

test("the gate: no bearer or a wrong bearer is 403 unauthenticated, and the credential is never echoed", async (t) => {
  const env = await spawnEnvironment(t);

  const noHeader = await ask(env.origin, "/exec", { argv: ["node", "-p", "1"] }, "POST", null);
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.body.refused, "unauthenticated");

  const wrong = await ask(env.origin, "/exec", { argv: ["node", "-p", "1"] }, "POST", "vbx_wrong_same_length_padding_xx");
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.refused, "unauthenticated");
  assert.doesNotMatch(wrong.body.why ?? "", /vbx_/, "the credential is never echoed in a refusal");

  // The same gate stands on the git doors, not just /exec — one class, not one route.
  const gitWrite = await ask(env.origin, "/git/config", { name: "No Auth" }, "POST", null);
  assert.equal(gitWrite.status, 403);
  assert.equal(gitWrite.body.refused, "unauthenticated");
  const gitInit = await ask(env.origin, "/git/init", {}, "POST", "vbx_wrong_same_length_padding_xx");
  assert.equal(gitInit.status, 403);
  assert.equal(gitInit.body.refused, "unauthenticated");

  // The open routes stay open without a credential: the boundary report is not the door.
  const health = await fetch(`${env.origin}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.exec, true, "a paired boot names its door open");
  const gitRead = await ask(env.origin, "/git/config", undefined, "GET", null);
  assert.equal(gitRead.status, 200);
});

test("exec-unpaired: a boot minted no bearer keeps every door closed, by name, with the remedy", async (t) => {
  const env = await spawnEnvironment(t, { bearer: null });

  const health = await fetch(`${env.origin}/health`).then((r) => r.json());
  assert.equal(health.ok, true, "an unpaired boot still answers its boundary report");
  assert.equal(health.exec, false, "and names its door closed");

  for (const [path, body] of [["/exec", { argv: ["node", "-p", "1"] }], ["/git/config", { name: "x" }], ["/git/init", {}]]) {
    const r = await ask(env.origin, path, body, "POST", "vbx_fixture_bearer_pehr");
    assert.equal(r.status, 403, `${path} refuses on an unpaired boot`);
    assert.equal(r.body.refused, "exec-unpaired", `${path} names the remedy class`);
    assert.match(r.body.why, /pair it.*re-boot/s, `${path} says how the door opens`);
  }
});

test("the paired door still runs: bearer-carrying exec and git identity work end to end", async (t) => {
  const env = await spawnEnvironment(t);

  const exec = await ask(env.origin, "/exec", { argv: ["node", "-p", "6*7"] });
  assert.equal(exec.status, 200);
  assert.equal(exec.body.ok, true);
  assert.equal(exec.body.stdout.trim(), "42", "arguments pass to the binary verbatim — no shell");

  const set = await ask(env.origin, "/git/config", { name: "Gate Keeper", email: "gate@example.invalid" });
  assert.equal(set.body.ok, true);
  assert.equal(set.body.config.name, "Gate Keeper");
  const get = await ask(env.origin, "/git/config", undefined, "GET");
  assert.equal(get.body.config.email, "gate@example.invalid");

  const init = await ask(env.origin, "/git/init", {});
  assert.equal(init.body.ok, true);
  assert.equal(existsSync(path.join(env.home, "workspace", ".git")), true, "the repo exists in the sandbox home");
});
