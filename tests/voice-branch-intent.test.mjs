// tests/voice-branch-intent.test.mjs — voicebox-beads-xo5d, end to end through the real turn.
//
//   node --test tests/voice-branch-intent.test.mjs
//
// The defect: "land branch" / "keep branch separate" returned { ok: true } and did NOTHING — the
// page handler was an empty async () => ({ ok: true }) and the server said "Ran land_branch.".
// These drives post the transcript to /api/turn exactly as a spoken turn arrives, against a server
// whose declared workspace is a scratch git repo, and assert the act happened IN THE REPO — the
// merge is a fact on disk, not a message. Each test gets its OWN repo: a kept-separate branch is
// still ahead of main, so sharing one repo would leak one test's branches into the next.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { gitEnv } from "../lib/git-env.mjs";

let scratch;
let server;

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeWorkspaceRepo(candidates = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-voice-branch-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Voicebox Test"]);
  git(dir, ["config", "user.email", "test@voicebox.local"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(dir, "README.md"), "# Project\ninitial\n", "utf8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "initial"]);
  for (const { name, file, content } of candidates) {
    git(dir, ["checkout", "-b", name]);
    writeFileSync(path.join(dir, file), content, "utf8");
    git(dir, ["add", file]);
    git(dir, ["commit", "-m", `candidate ${name}`]);
    git(dir, ["checkout", "main"]);
  }
  return dir;
}

const turn = (transcript) =>
  fetch(`${server.base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  }).then((r) => r.json());

async function declareWorkspace(repoDir) {
  const declared = await fetch(`${server.base}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "voice-branch", root: { kind: "machine", path: repoDir } }),
  }).then((r) => r.json());
  assert.equal(declared.ok, true, `root declaration failed: ${JSON.stringify(declared)}`);
}

test.before(async () => {
  scratch = mkdtempSync(path.join(os.homedir(), ".voicebox-voice-branch-test-"));
  server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "ws") }, cwd: scratch });
});

test.after(async () => {
  await server?.stop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test('"land branch" with one waiting candidate LANDS it — the merge is on disk (xo5d)', async (t) => {
  const repo = makeWorkspaceRepo([{ name: "feat/voice-land", file: "landed.txt", content: "landed by voice\n" }]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  await declareWorkspace(repo);

  const answer = await turn("land branch");
  assert.equal(answer.result?.ok, true, JSON.stringify(answer.result));
  assert.equal(answer.result?.branchIntent?.outcome, "executed", JSON.stringify(answer.result?.branchIntent));
  assert.equal(answer.result?.branchIntent?.branch, "feat/voice-land");
  assert.match(answer.result?.say ?? "", /Landed feat\/voice-land into main/);

  // The fact, not the message: main carries the branch's file.
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.equal(readFileSync(path.join(repo, "landed.txt"), "utf8"), "landed by voice\n");
});

test('"land branch" with nothing waiting SAYS so — no invented success (xo5d)', async (t) => {
  const repo = makeWorkspaceRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  await declareWorkspace(repo);

  const answer = await turn("land branch");
  assert.equal(answer.result?.ok, true, JSON.stringify(answer.result));
  assert.equal(answer.result?.branchIntent?.outcome, "none");
  assert.match(answer.result?.say ?? "", /no candidate branches/i);
});

test('"keep branch separate" executes without merging (xo5d)', async (t) => {
  const repo = makeWorkspaceRepo([{ name: "feat/keep-me", file: "kept.txt", content: "kept separate\n" }]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  await declareWorkspace(repo);

  const answer = await turn("keep branch separate");
  assert.equal(answer.result?.ok, true, JSON.stringify(answer.result));
  assert.equal(answer.result?.branchIntent?.outcome, "executed", JSON.stringify(answer.result?.branchIntent));
  assert.equal(answer.result?.branchIntent?.branch, "feat/keep-me");
  assert.match(answer.result?.say ?? "", /stay separate/);
  assert.equal(existsSync(path.join(repo, "kept.txt")), false, "keep-separate must not merge");
});

test('"land branch" with several waiting answers ambiguous and lands nothing (xo5d)', async (t) => {
  const repo = makeWorkspaceRepo([
    { name: "feat/first", file: "a.txt", content: "a\n" },
    { name: "feat/second", file: "b.txt", content: "b\n" },
  ]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  await declareWorkspace(repo);

  const answer = await turn("land branch");
  assert.equal(answer.result?.ok, true, JSON.stringify(answer.result));
  assert.equal(answer.result?.branchIntent?.outcome, "ambiguous", JSON.stringify(answer.result?.branchIntent));
  assert.match(answer.result?.say ?? "", /2 candidate branches/);
  assert.equal(existsSync(path.join(repo, "a.txt")), false, "ambiguous must land nothing");
  assert.equal(existsSync(path.join(repo, "b.txt")), false, "ambiguous must land nothing");
});
