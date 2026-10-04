// tests/branch-landing.test.mjs — Unit tests for Candidate Branch & Diff Landing Inspector.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LANDING_INSPECTOR_APP_ID,
  LANDING_INSPECTOR_MINI_APP,
  getLandingInspectorMiniApp,
  isValidBranchRef,
  listCandidateBranches,
  inspectBranchDiff,
  landCandidateBranch,
  keepBranchSeparate,
} from "../lib/branch-landing.mjs";
import {
  ID_PATTERNS,
  JARGON,
  identifiersInRenderedText,
} from "../tools/rendered-plain-language.mjs";

const BANNED_JARGON_WORDS = [
  "sandbox",
  "iframe",
  "srcdoc",
  "opfs",
  "ipc",
  "json",
  "rpc",
  "wasm",
  "idempotence",
  "worktree",
];

const BANNED_TICKET_SUBSTRINGS = [
  "8l9g",
  "dtjf",
  "3si2",
  "hn7x",
  "lmvn",
  "xgnm",
  "zjdd",
  "keb7",
  "bavl",
  "tjih",
  "2vza",
  "von8",
  "0jxa",
  "sqeh",
  "2meg",
  "3rcy",
];

function scanPlainLanguage(rawHtml) {
  const withoutStyleAndComments = rawHtml
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const hits = [...identifiersInRenderedText(withoutStyleAndComments)];

  for (const [re, label, remedy] of ID_PATTERNS) {
    const m = withoutStyleAndComments.match(re);
    if (m) hits.push({ token: m[0], label, remedy });
  }
  for (const [word, remedy] of JARGON) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(withoutStyleAndComments)) {
      hits.push({ token: word, label: "jargon", remedy });
    }
  }
  for (const word of BANNED_JARGON_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(rawHtml)) {
      hits.push({ token: word, label: "banned-jargon", remedy: "use plain language" });
    }
  }
  for (const id of BANNED_TICKET_SUBSTRINGS) {
    if (rawHtml.toLowerCase().includes(id.toLowerCase())) {
      hits.push({ token: id, label: "ticket-id", remedy: "remove ticket id substring" });
    }
  }
  return hits;
}

function git(cwd, args) {
  // Sanitize GIT_* repo-context vars (measured: inherited GIT_DIR inside a
  // pre-push gate redirected every temp-repo git op at the voicebox repo —
  // 277 branches instead of 1).
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE", "GIT_COMMON_DIR"]) delete env[k];
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createTempGitRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-branch-landing-"));
  git(tmpDir, ["init", "-b", "main"]);
  git(tmpDir, ["config", "user.name", "Voicebox Test"]);
  git(tmpDir, ["config", "user.email", "test@voicebox.local"]);
  git(tmpDir, ["config", "commit.gpgsign", "false"]);

  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Project\nInitial line\n", "utf8");
  git(tmpDir, ["add", "README.md"]);
  git(tmpDir, ["commit", "-m", "Initial commit on main"]);

  // Create candidate branch feat/agent-patch
  git(tmpDir, ["checkout", "-b", "feat/agent-patch"]);
  fs.writeFileSync(
    path.join(tmpDir, "README.md"),
    "# Project\nInitial line\nAdded by candidate branch\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(tmpDir, "notes.txt"),
    "Agent verification notes\nSecond line\n",
    "utf8",
  );
  git(tmpDir, ["add", "README.md", "notes.txt"]);
  git(tmpDir, ["commit", "-m", "feat: update readme and add notes"]);

  // Return to main
  git(tmpDir, ["checkout", "main"]);
  return tmpDir;
}

test("branch-landing: listCandidateBranches, inspectBranchDiff, keepBranchSeparate, and landCandidateBranch work end-to-end on a temporary git repo", (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // 1. Validate ref helper
  assert.equal(isValidBranchRef("feat/agent-patch"), true);
  assert.equal(isValidBranchRef("-bad-flag"), false);
  assert.equal(isValidBranchRef("bad..range"), false);
  assert.equal(isValidBranchRef("bad space"), false);

  // 2. List candidate branches
  const listed = listCandidateBranches(repoDir, { baseBranch: "main" });
  assert.equal(listed.ok, true);
  assert.equal(listed.baseBranch, "main");
  assert.equal(listed.branches.length, 1);
  assert.equal(listed.branches[0].name, "feat/agent-patch");
  assert.equal(listed.branches[0].ahead, 1);
  assert.equal(listed.branches[0].behind, 0);
  assert.equal(listed.branches[0].filesChanged, 2);
  assert.match(listed.branches[0].subject, /update readme and add notes/);

  // 3. Inspect branch diff
  const diffResult = inspectBranchDiff(repoDir, "feat/agent-patch", { baseBranch: "main" });
  assert.equal(diffResult.ok, true);
  assert.equal(diffResult.branch, "feat/agent-patch");
  assert.equal(diffResult.baseBranch, "main");
  assert.equal(diffResult.cleanMergePossible, true);
  assert.equal(diffResult.files.length, 2);
  assert.equal(diffResult.totalAdditions, 3);
  assert.equal(diffResult.totalDeletions, 0);
  assert.match(diffResult.diff, /\+Added by candidate branch/);
  assert.match(diffResult.diff, /\+Agent verification notes/);

  const readmeEntry = diffResult.files.find((f) => f.path === "README.md");
  const notesEntry = diffResult.files.find((f) => f.path === "notes.txt");
  assert.deepEqual(readmeEntry, {
    path: "README.md",
    status: "M",
    additions: 1,
    deletions: 0,
  });
  assert.deepEqual(notesEntry, {
    path: "notes.txt",
    status: "A",
    additions: 2,
    deletions: 0,
  });

  // 4. Keep branch separate (non-destructive)
  const kept = keepBranchSeparate(repoDir, "feat/agent-patch", {
    note: "Hold until acceptance review",
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.action, "kept-separate");
  assert.equal(kept.branch, "feat/agent-patch");
  assert.equal(fs.existsSync(path.join(repoDir, "notes.txt")), false);

  // 5. Land candidate branch into main
  const landed = landCandidateBranch(repoDir, "feat/agent-patch", { baseBranch: "main" });
  assert.equal(landed.ok, true);
  assert.equal(landed.action, "landed");
  assert.equal(landed.branch, "feat/agent-patch");
  assert.equal(landed.baseBranch, "main");
  assert.ok(landed.headCommit.length >= 4);
  assert.equal(fs.existsSync(path.join(repoDir, "notes.txt")), true);
});

test("branch-landing: detects merge conflicts and refuses automatic landing", (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // Create a conflicting commit on main
  fs.writeFileSync(
    path.join(repoDir, "README.md"),
    "# Project\nInitial line\nConflicting change on main\n",
    "utf8",
  );
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "main: conflicting readme update"]);

  const inspection = inspectBranchDiff(repoDir, "feat/agent-patch", { baseBranch: "main" });
  assert.equal(inspection.ok, true);
  assert.equal(inspection.cleanMergePossible, false);

  const refusedLand = landCandidateBranch(repoDir, "feat/agent-patch", { baseBranch: "main" });
  assert.equal(refusedLand.ok, false);
  assert.equal(refusedLand.refused, "merge-conflict");
});

test("branch-landing: exports valid Standards-Mode mini-app HTML and passes plain-language gate with zero hits", () => {
  assert.equal(LANDING_INSPECTOR_APP_ID, "branch-landing-inspector");
  assert.equal(LANDING_INSPECTOR_MINI_APP.appId, "branch-landing-inspector");
  assert.equal(LANDING_INSPECTOR_MINI_APP.title, "Branch Landing Inspector");

  const copy = getLandingInspectorMiniApp();
  assert.deepEqual(copy, LANDING_INSPECTOR_MINI_APP);
  assert.notEqual(copy, LANDING_INSPECTOR_MINI_APP);

  const html = LANDING_INSPECTOR_MINI_APP.html;
  assert.match(html, /^<!DOCTYPE html>/i, "must start with Standards-Mode DOCTYPE");
  assert.match(html, /id="branch-list"/);
  assert.match(html, /id="changed-files-list"/);
  assert.match(html, /id="merge-compatibility-badge"/);
  assert.match(html, /id="diff-viewer"/);
  assert.match(html, /id="land-branch-btn"/);
  assert.match(html, /id="keep-separate-btn"/);
  assert.match(html, /window\.voicebox\?\.registerTool/);
  assert.match(html, /list_candidate_branches/);
  assert.match(html, /inspect_branch_diff/);
  assert.match(html, /land_candidate_branch/);

  const rawHtml = fs.readFileSync(
    new URL("../public/apps/landing-inspector.html", import.meta.url),
    "utf8",
  );
  const hits = scanPlainLanguage(rawHtml);
  assert.deepEqual(
    hits,
    [],
    `Expected zero plain-language violations in public/apps/landing-inspector.html, found: ${JSON.stringify(hits)}`,
  );
});
