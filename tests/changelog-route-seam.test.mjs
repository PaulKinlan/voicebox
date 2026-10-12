import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChangelogRoutes } from "../lib/routes/changelog.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const record = (sha, subject = "fix: repaired route") => `\x1e${sha}\x1f${sha.slice(0, 7)}\x1f${subject}\x1fAuthor\x1f2026-10-12T00:00:00Z\x1f2026-10-12\x1fWhy it changed\nDocs-checked: still true\nCo-authored-by: A\nSigned-off-by: B\x1f\n1\t2\tsrc/file.mjs\n`;
const response = () => ({});
const json = (res, status, payload) => { res.status = status; res.body = payload; return res; };

test("changelog factory is the only GET handler at its original host table position", () => {
  const source = readFileSync(path.join(repo, "server.mjs"), "utf8");
  assert.match(source, /createChangelogRoutes\(\{ repoRoot: ROOT, json, execFileAsync \}\)/);
  assert.match(source, /\.\.\.changelogRoutes,\s*(?:\/\/[^\n]*\n\s*)*"HEAD \/api\/health":/, "only existing health comments may separate these table entries");
  assert.doesNotMatch(source, /"GET \/api\/changelog":/, "no duplicate inline GET may shadow its cache");
  assert.doesNotMatch(source, /const changelogCache =/, "the sole cache must move out of the host");
});

test("private HEAD/ref-mtime cache, exact git arguments and enrichment survive the extraction", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vb-changelog-seam-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = path.join(root, ".git");
  const ref = path.join(git, "refs/heads/main");
  mkdirSync(path.dirname(ref), { recursive: true });
  writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(ref, "first\n");
  let output = record("a".repeat(40));
  const calls = [];
  let throwNext = false;
  const routes = createChangelogRoutes({
    repoRoot: root, json,
    execFileAsync: async (...args) => {
      calls.push(args);
      if (throwNext) { throwNext = false; throw new Error("synthetic git unavailable"); }
      return { stdout: output };
    },
  });
  assert.deepEqual(Object.keys(routes), ["GET /api/changelog"]);
  const get = async () => { const res = response(); await routes["GET /api/changelog"](null, res); return res; };
  const first = await get();
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.repo, "https://github.com/PaulKinlan/voicebox");
  const commit = first.body.commits[0];
  assert.equal(commit.category, "fix");
  assert.equal(commit.description, "Why it changed");
  assert.equal(commit.body, "Why it changed");
  assert.deepEqual(commit.stats, { filesChanged: 1, insertions: 1, deletions: 2 });
  assert.deepEqual(commit.files, ["src/file.mjs"]);
  assert.equal(commit.url, `https://github.com/PaulKinlan/voicebox/commit/${"a".repeat(40)}`);
  assert.deepEqual(calls[0], ["git", ["log", "-n", "30", "--pretty=format:%x1e%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%as%x1f%b%x1f", "--numstat"], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }]);

  const cached = await get();
  assert.equal(calls.length, 1, "same raw HEAD/ref-mtime key must reuse the private cache");
  assert.strictEqual(cached.body.commits, first.body.commits, "cache hit retains the same parsed value");
  output = record("b".repeat(40), "feat: new state");
  utimesSync(ref, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:01Z"));
  const refreshed = await get();
  assert.equal(calls.length, 2, "changed ref mtime must invalidate the cache");
  assert.equal(refreshed.body.commits[0].sha, "b".repeat(40));
  assert.equal(refreshed.body.commits[0].category, "feature");

  rmSync(path.join(git, "HEAD"));
  throwNext = true;
  const failed = await get();
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { ok: false, error: "synthetic git unavailable", repo: "https://github.com/PaulKinlan/voicebox", commits: [] });
  const recovered = await get();
  assert.equal(recovered.status, 200);
  assert.equal(calls.length, 4, "missing HEAD must not use previous cache or cache the recovery");
  await get();
  assert.equal(calls.length, 5, "worktree .git-file/missing HEAD cache miss is preserved");
});
