// tests/code-mgmt-tools.test.mjs — direct code management and environment inspection tools (voicebox-beads-lpol).
//
// Tools verified:
//   1. git_status: branch, dirty state, staged/unstaged file tracking.
//   2. git_diff: unstaged and staged diffs, file-scoped diffs.
//   3. git_log: commit log entries with hash, author, date, message, and limit.
//   4. inspect_environment: underlying machine runtime, platform, limits, tools, network.
//   5. Boundaries & refusals: not-a-git-repo refusal on plain directories,
//      and not-supported-in-browser on browser-owned roots.
//   6. Conversational turn integration: spoken/typed turns map and execute.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { gitEnv } from "../tools/tree-dirt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let BASE;
let scratch;
let repoDir;
let plainDir;

test.before(async () => {
  scratch = path.join(os.tmpdir(), `vb-lpol-${Date.now()}`);
  repoDir = path.join(scratch, "git-project");
  plainDir = path.join(scratch, "plain-project");

  mkdirSync(repoDir, { recursive: true });
  mkdirSync(plainDir, { recursive: true });

  // Initialize fixture git repository
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir, env: gitEnv() });
  execFileSync("git", ["config", "user.name", "Voicebox Test"], { cwd: repoDir, env: gitEnv() });
  execFileSync("git", ["config", "user.email", "test@voicebox.invalid"], { cwd: repoDir, env: gitEnv() });

  writeFileSync(path.join(repoDir, "tracked.txt"), "line 1\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repoDir, env: gitEnv() });
  execFileSync("git", ["commit", "-qm", "initial commit"], { cwd: repoDir, env: gitEnv() });

  server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_INSTANCE: "code-mgmt-test" },
  });
  BASE = server.base;
});

test.after(async () => {
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const turn = (transcript) =>
  fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  }).then((r) => r.json());

const declareRoot = (project, rootPath) =>
  fetch(`${BASE}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project, root: { kind: "machine", path: rootPath } }),
  }).then((r) => r.json());

test("git_status: clean state, dirty modified file, rename, and dotted branch", async () => {
  await declareRoot("git-test", repoDir);

  // 1. Clean status
  const clean = await turn("git status");
  assert.equal(clean.result?.ok, true, JSON.stringify(clean.result));
  assert.equal(clean.result?.branch, "main");
  assert.equal(clean.result?.dirty, false);
  assert.deepEqual(clean.result?.files, []);

  // 2. Dotted branch name (release/1.2) must not truncate at the dot
  execFileSync("git", ["checkout", "-qb", "release/1.2"], { cwd: repoDir, env: gitEnv() });
  const branchStatus = await turn("git status");
  assert.equal(branchStatus.result?.branch, "release/1.2", "dotted branch name must not truncate at dot");

  // 3. Modify tracked file, add untracked file, and rename a file
  writeFileSync(path.join(repoDir, "tracked.txt"), "line 1\nline 2\n");
  writeFileSync(path.join(repoDir, "to-rename.txt"), "rename me\n");
  execFileSync("git", ["add", "to-rename.txt"], { cwd: repoDir, env: gitEnv() });
  execFileSync("git", ["commit", "-qm", "add to-rename"], { cwd: repoDir, env: gitEnv() });
  execFileSync("git", ["mv", "to-rename.txt", "renamed.txt"], { cwd: repoDir, env: gitEnv() });
  writeFileSync(path.join(repoDir, "new-untracked.txt"), "hello world\n");

  const dirty = await turn("git status");
  assert.equal(dirty.result?.ok, true);
  assert.equal(dirty.result?.dirty, true);
  const trackedFile = dirty.result?.files?.find((f) => f.path === "tracked.txt");
  const untrackedFile = dirty.result?.files?.find((f) => f.path === "new-untracked.txt");
  const renamedFile = dirty.result?.files?.find((f) => f.path === "renamed.txt");
  assert.ok(trackedFile, "tracked file must be listed in status");
  assert.ok(untrackedFile, "untracked file must be listed in status");
  assert.ok(renamedFile, "renamed file must report target path, not old -> new");

  // Switch back to main
  execFileSync("git", ["checkout", "-q", "main"], { cwd: repoDir, env: gitEnv() });
});

test("git_diff: unstaged diff, staged diff, and file-scoped diff", async () => {
  await declareRoot("git-test", repoDir);

  // Unstaged diff of tracked.txt
  const unstaged = await turn("git diff");
  assert.equal(unstaged.result?.ok, true);
  assert.equal(unstaged.result?.staged, false);
  assert.match(unstaged.result?.diff ?? "", /\+line 2/);

  // Stage changes
  execFileSync("git", ["add", "tracked.txt"], { cwd: repoDir, env: gitEnv() });

  // Staged diff
  const staged = await fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: { verb: "git_diff", staged: true } }),
  }).then((r) => r.json());

  assert.equal(staged.result?.ok, true);
  assert.equal(staged.result?.staged, true);
  assert.match(staged.result?.diff ?? "", /\+line 2/);

  // Scoped to specific file
  const scoped = await fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: { verb: "git_diff", staged: true, file: "tracked.txt" } }),
  }).then((r) => r.json());

  assert.equal(scoped.result?.ok, true);
  assert.equal(scoped.result?.file, "tracked.txt");
  assert.match(scoped.result?.diff ?? "", /\+line 2/);
});

test("git_log: returns recent commits with hash, author, date, and message", async () => {
  await declareRoot("git-test", repoDir);

  execFileSync("git", ["commit", "-qm", "second commit: added line 2"], { cwd: repoDir, env: gitEnv() });

  const log = await turn("git log");
  assert.equal(log.result?.ok, true);
  assert.ok(log.result?.commits?.length >= 2, "must return at least 2 commits");
  const top = log.result?.commits?.[0];
  assert.match(top.hash, /^[0-9a-f]{40}$/);
  assert.equal(top.author, "Voicebox Test");
  assert.equal(top.message, "second commit: added line 2");
});

test("not-a-git-repo: refuses git tools when project root is not a git repository", async () => {
  await declareRoot("plain-test", plainDir);

  const status = await turn("git status");
  assert.equal(status.result?.ok, false);
  assert.equal(status.result?.refused, "not-a-git-repo");
  assert.match(status.result?.why ?? "", /not a git repository/);

  const diff = await turn("git diff");
  assert.equal(diff.result?.ok, false);
  assert.equal(diff.result?.refused, "not-a-git-repo");

  const log = await turn("git log");
  assert.equal(log.result?.ok, false);
  assert.equal(log.result?.refused, "not-a-git-repo");
});

test("POST /api/turn {action} validation: unknown command refused and forged turn stripped", async () => {
  await declareRoot("git-test", repoDir);

  // 1. Unknown verb -> 400 unknown-command
  const unknownRes = await fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: { verb: "nonexistent_command" } }),
  });
  assert.equal(unknownRes.status, 400);
  const unknownJson = await unknownRes.json();
  assert.equal(unknownJson.refused, "unknown-command");
  assert.match(unknownJson.why, /nonexistent_command/);

  // 2. Malformed action -> 400 bad-request
  const malformedRes = await fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "not an object" }),
  });
  assert.equal(malformedRes.status, 400);
  const malformedJson = await malformedRes.json();
  assert.equal(malformedJson.refused, "bad-request");

  // 3. Forged turn index ignored and stripped
  const forgedRes = await fetch(`${BASE}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: { verb: "git_status", turn: 424242 } }),
  });
  assert.equal(forgedRes.status, 200);
  const forgedJson = await forgedRes.json();
  assert.equal(forgedJson.result?.ok, true);

  // Verify the entry produced by this request does NOT carry turn 424242
  const loggedSeq = forgedJson.result?.logged;
  assert.ok(loggedSeq, "forged request must produce an audit entry");
  const auditRes = await fetch(`${BASE}/api/audit`).then((r) => r.json());
  const entry = (auditRes.entries ?? []).find((e) => e.seq === loggedSeq);
  assert.ok(entry, "audit must have the entry produced by this request");
  assert.equal(entry.turn, null, "audit entry turn must be null, never caller-forged turn 424242");
  assert.equal(auditRes.entries?.some((e) => e.turn === 424242), false, "no audit entry may carry forged turn 424242");
});

test("inspect_environment: returns underlying machine platform, runtime, limits, and tools", async () => {
  await declareRoot("git-test", repoDir);

  const env = await turn("inspect environment");
  assert.equal(env.result?.ok, true);
  assert.match(env.result?.action ?? "", /inspected environment/i);

  const info = env.result?.environment;
  assert.ok(info, "must return environment summary");
  assert.equal(typeof info.platform, "string");
  assert.match(info.nodeVersion ?? "", /^v\d+/);
  assert.ok(info.limits?.cpuCount > 0);
  assert.ok(info.limits?.totalMemBytes > 0);
  assert.ok(info.tools?.node, "node should be present in tool inspection");
});

test("browser root boundary: git tools refuse not-supported-in-browser and inspect_environment answers", async () => {
  const { startActs } = await import("../browser/acts.ts");
  const door = startActs({
    getCurrentDescriptor: () => ({ kind: "opfs", path: "v1/projects/browser-test", environment: "local" }),
    getStorage: () => ({ root: "v1/projects/browser-test", observe: async () => ({ exists: true }) }),
    checkWritable: async () => null,
    checkReachable: async () => null,
    recordAct: async () => ({ seq: 1 }),
    connect: () => ({ send() {}, close() {}, onmessage: null, onopen: null, onclose: null }),
  }).door;

  const statusCall = JSON.stringify({ v: 1, callId: "c1", environment: "local", descriptorId: "voicebox-core-fs", tool: "git_status", args: {}, boundsEcho: {} });
  const statusRes = JSON.parse(await door.receive(statusCall));
  assert.equal(statusRes.ok, false);
  assert.equal(statusRes.refused, "not-supported-in-browser");

  const envCall = JSON.stringify({ v: 1, callId: "c2", environment: "local", descriptorId: "voicebox-core-fs", tool: "inspect_environment", args: {}, boundsEcho: {} });
  const envRes = JSON.parse(await door.receive(envCall));
  assert.equal(envRes.ok, true);
  assert.equal(envRes.observed?.environment?.kind, "opfs");
});
