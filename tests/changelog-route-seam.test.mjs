import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChangelogRoutes } from "../lib/routes/changelog.mjs";
import { assertRouteGroupWiring } from "./lib/route-table.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const record = (sha, subject = "fix: repaired route") => `\x1e${sha}\x1f${sha.slice(0, 7)}\x1f${subject}\x1fAuthor\x1f2026-10-12T00:00:00Z\x1f2026-10-12\x1fWhy it changed\nDocs-checked: still true\nCo-authored-by: A\nSigned-off-by: B\x1f\n1\t2\tsrc/file.mjs\n`;
const response = () => ({});
const json = (res, status, payload) => { res.status = status; res.body = payload; return res; };

// THE OLD GUARD, kept on purpose (voicebox-beads-r9hv.5): it proved the group's table position by naming the
// entry that FOLLOWED it — `"HEAD /api/health"` — so extracting the health group would have failed this test
// while routing was intact. It guards nothing now; it is asserted to FAIL on the neighbour-extraction mutant
// below, which is what shows the new guard fixes a real recurrence rather than rephrasing it.
const theOldAdjacencyGuard = (source) =>
  assert.match(source, /\.\.\.changelogRoutes,\s*(?:\/\/[^\n]*\n\s*)*"HEAD \/api\/health":/, "only existing health comments may separate these table entries");

test("changelog factory is the only GET handler at its original host table position", () => {
  const source = readFileSync(path.join(repo, "server.mjs"), "utf8");
  assert.match(source, /createChangelogRoutes\(\{ repoRoot: ROOT, json, execFileAsync \}\)/);
  // ORDER, NOT ADJACENCY: the anchors are spread GROUPS (...branchRoutes, ...doctorRoutes), so extracting
  // any neighbour cannot red this guard. It asserts the group is spread once, keeps its place, and is not
  // shadowed — the things that can actually change dispatch.
  assertRouteGroupWiring(source, {
    group: "...changelogRoutes",
    order: ["...branchRoutes", "...doctorRoutes"],
    shadow: ["GET /api/changelog"],
  });
  assert.doesNotMatch(source, /const changelogCache =/, "the sole cache must move out of the host");

  // SELF-PROVING MUTANTS. This test previously had none, so its guard could rot silently.
  const withoutSpread = source.replace("  ...changelogRoutes,\n", "");
  assert.notEqual(withoutSpread, source, "the missing-spread mutant must actually change the source");
  assert.throws(() => assertRouteGroupWiring(withoutSpread, { group: "...changelogRoutes", order: ["...branchRoutes", "...doctorRoutes"] }), { name: "AssertionError" });

  const duplicatedSpread = source.replace("  ...changelogRoutes,\n", "  ...changelogRoutes,\n  ...changelogRoutes,\n");
  assert.notEqual(duplicatedSpread, source, "the duplicate-spread mutant must actually change the source");
  assert.throws(() => assertRouteGroupWiring(duplicatedSpread, { group: "...changelogRoutes", order: ["...branchRoutes", "...doctorRoutes"] }), { name: "AssertionError" },
    "a second spread must be refused: the last duplicate key wins silently");

  const swapped = source.replace("  ...doctorRoutes,\n  ...changelogRoutes,", "  ...changelogRoutes,\n  ...doctorRoutes,");
  assert.notEqual(swapped, source, "the swapped-order mutant must actually change the source");
  assert.throws(() => assertRouteGroupWiring(swapped, { group: "...changelogRoutes", order: ["...branchRoutes", "...doctorRoutes"] }), { name: "AssertionError" },
    "changelog must keep its place after the branches and doctor groups");

  const shadowed = source.replace("  ...changelogRoutes,\n", '  ...changelogRoutes,\n  "GET /api/changelog": () => null,\n');
  assert.notEqual(shadowed, source, "the shadowing mutant must actually change the source");
  assert.throws(() => assertRouteGroupWiring(shadowed, { group: "...changelogRoutes", shadow: ["GET /api/changelog"] }), { name: "AssertionError" });

  // THE RECURRENCE, REPRODUCED: extract the neighbouring health group the way the ADR's root/health slice
  // will, by turning its literal key into a spread. Same source for both, so the pair is the evidence: the OLD
  // guard dies on it (the voicebox-beads-91tp defect), the NEW guard passes. Conditional on the literal still
  // existing: once that group really is extracted the LIVE source is the extraction and is guarded directly,
  // and an unconditional `replace` would no-op and red this test for the very change it is waiting for.
  if (source.includes('  "HEAD /api/health": ')) {
    const healthExtracted = source.replace('  "HEAD /api/health": ', "  ...healthRoutes, // ");
    assert.notEqual(healthExtracted, source, "the neighbour-extraction mutant must actually change the source");
    assert.throws(() => theOldAdjacencyGuard(healthExtracted), { name: "AssertionError" },
      "the old guard must fail on a neighbour extraction — that is voicebox-beads-91tp");
    assertRouteGroupWiring(healthExtracted, {
      group: "...changelogRoutes",
      order: ["...branchRoutes", "...doctorRoutes"],
      shadow: ["GET /api/changelog"],
    });
  }
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
