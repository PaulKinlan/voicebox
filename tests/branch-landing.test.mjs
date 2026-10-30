// tests/branch-landing.test.mjs — Unit tests for Candidate Branch & Diff Landing Inspector.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../lib/git-env.mjs";
import {
  LANDING_INSPECTOR_APP_ID,
  LANDING_INSPECTOR_MINI_APP,
  getLandingInspectorMiniApp,
  isValidBranchRef,
  listCandidateBranches,
  inspectBranchDiff,
  landCandidateBranch,
  keepBranchSeparate,
  executeBranchIntent,
} from "../lib/branch-landing.mjs";
import { createBranchRoutes } from "../lib/routes/branches.mjs";
import { createBranchLandingController } from "../public/branch-landing-ui.mjs";
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
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
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

  // 4. Keep branch separate (non-destructive) — RECORDED on disk since wmiq: a decision the
  // operator was told was recorded must survive a refresh, so the call takes the ledger file.
  const decisionsFile = path.join(repoDir, ".voicebox-test-decisions.json");
  const kept = keepBranchSeparate(repoDir, "feat/agent-patch", {
    note: "Hold until acceptance review",
    decisionsFile,
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.action, "kept-separate");
  assert.equal(kept.branch, "feat/agent-patch");
  assert.equal(fs.existsSync(path.join(repoDir, "notes.txt")), false);

  // The decision rides the next listing — this is what a refreshed inspector reads.
  const relisted = listCandidateBranches(repoDir, { baseBranch: "main", decisionsFile });
  assert.equal(relisted.branches[0].statusDecision, "kept-separate");
  assert.equal(relisted.branches[0].decisionNote, "Hold until acceptance review");

  // Without a ledger the call refuses rather than pretend to have recorded.
  const unrecorded = keepBranchSeparate(repoDir, "feat/agent-patch", { note: "x" });
  assert.equal(unrecorded.ok, false);
  assert.equal(unrecorded.refused, "no-decisions-store");

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
  assert.match(html, /<script\s+type="module"\s+src="\/apps\/landing-inspector\.js"><\/script>/);

  const js = fs.readFileSync(
    new URL("../public/apps/landing-inspector.js", import.meta.url),
    "utf8",
  );
  assert.match(js, /window\.voicebox\?\.registerTool/);
  assert.match(js, /list_candidate_branches/);
  assert.match(js, /inspect_branch_diff/);
  assert.match(js, /land_candidate_branch/);

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

test("branch-landing: a poisoned GIT_DIR does not steer candidate branch discovery or fixture creation (voicebox-beads-n48i)", (t) => {
  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-foreign-repo-"));
  t.after(() => {
    fs.rmSync(foreignDir, { recursive: true, force: true });
  });
  git(foreignDir, ["init", "-b", "main"]);
  git(foreignDir, ["config", "user.name", "Foreign Repo"]);
  git(foreignDir, ["config", "user.email", "foreign@example.invalid"]);
  git(foreignDir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(foreignDir, "foreign.txt"), "foreign data\n", "utf8");
  git(foreignDir, ["add", "foreign.txt"]);
  git(foreignDir, ["commit", "-m", "commit in foreign repo"]);

  const savedGitDir = process.env.GIT_DIR;
  const savedGitWorkTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = path.join(foreignDir, ".git");
    process.env.GIT_WORK_TREE = foreignDir;

    // createTempGitRepo() and listCandidateBranches() must operate exclusively on the new temp repo,
    // completely immune to the poisoned ambient GIT_DIR.
    const repoDir = createTempGitRepo();
    t.after(() => {
      fs.rmSync(repoDir, { recursive: true, force: true });
    });

    const candidates = listCandidateBranches(repoDir, { baseBranch: "main" });
    assert.equal(candidates.ok, true);
    assert.equal(candidates.branches.length, 1);
    assert.equal(candidates.branches[0].name, "feat/agent-patch");
    assert.match(candidates.branches[0].subject, /update readme and add notes/);
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
    if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = savedGitWorkTree;
  }
});

test("branch-landing: createBranchRoutes provides candidate inspection and landing endpoints", async (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  let capturedStatus = 0;
  let capturedBody = null;
  const jsonMock = (_res, status, body) => {
    capturedStatus = status;
    capturedBody = body;
    return body;
  };
  const answerOnceMock = (_res, fn) => fn();

  const routes = createBranchRoutes({
    repoRoot: repoDir,
    json: jsonMock,
    readJsonBody: async () => ({ branch: "feat/agent-patch" }),
    answerOnce: answerOnceMock,
    // This test drives the LANDING seam, not the authority wall (voicebox-beads-gi60): the
    // authority contract is pinned in tests/branches-route.test.mjs and the real protocol gate in
    // tests/timing-safe.test.mjs. The permissive stub lets the merge step reach the lander here.
    hasExtensionAuthority: () => true,
    decisionsFile: path.join(repoDir, ".voicebox-test-decisions.json"),
  });

  assert.ok(routes["GET /api/branches/candidates"]);
  assert.ok(routes["GET /api/branches/diff"]);
  assert.ok(routes["POST /api/branches/merge"]);
  assert.ok(routes["POST /api/branches/keep-separate"]);

  // 1. GET /api/branches/candidates
  await routes["GET /api/branches/candidates"]({}, {}, new URL("http://localhost/api/branches/candidates"));
  assert.equal(capturedStatus, 200);
  assert.equal(capturedBody.ok, true);
  assert.equal(capturedBody.branches.length, 1);
  assert.equal(capturedBody.branches[0].name, "feat/agent-patch");

  // 2. GET /api/branches/diff
  await routes["GET /api/branches/diff"]({}, {}, new URL("http://localhost/api/branches/diff?branch=feat/agent-patch"));
  assert.equal(capturedStatus, 200);
  assert.equal(capturedBody.ok, true);
  assert.equal(capturedBody.cleanMergePossible, true);
  assert.equal(capturedBody.files.length, 2);

  // 3. POST /api/branches/keep-separate
  await routes["POST /api/branches/keep-separate"]({}, {});
  assert.equal(capturedStatus, 200);
  assert.equal(capturedBody.ok, true);
  assert.equal(capturedBody.action, "kept-separate");

  // 4. POST /api/branches/merge
  await routes["POST /api/branches/merge"]({}, {});
  assert.equal(capturedStatus, 200);
  assert.equal(capturedBody.ok, true);
  assert.equal(capturedBody.action, "landed");
});

test("branch-landing: main room UI does not clutter header with unrequested branch-landing dialog", () => {
  const indexHtml = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  assert.equal(
    indexHtml.includes('id="branches-open"'),
    false,
    "branches-open button should not exist in public/index.html",
  );
  assert.equal(
    indexHtml.includes('id="branch-landing-dialog"'),
    false,
    "branch-landing-dialog should not exist in public/index.html",
  );
});

test("branch-landing: createBranchLandingController exports clean interface and manages state", () => {
  let opened = false;
  let closed = false;
  const mockDialog = {
    showModal: () => { opened = true; },
    close: () => { closed = true; },
    addEventListener: () => {},
  };
  const mockBtn = {
    setAttribute: () => {},
    removeAttribute: () => {},
    addEventListener: () => {},
    focus: () => {},
  };
  const mockBadge = { textContent: "" };

  const controller = createBranchLandingController({
    openBtn: mockBtn,
    badgeEl: mockBadge,
    dialog: mockDialog,
  });

  assert.equal(typeof controller.fetchCandidates, "function");
  assert.equal(typeof controller.openDialog, "function");
  assert.equal(typeof controller.closeDialog, "function");
  assert.equal(typeof controller.selectBranch, "function");
  assert.equal(typeof controller.landSelectedBranch, "function");
  assert.equal(typeof controller.keepSelectedBranchSeparate, "function");

  controller.openDialog();
  assert.equal(opened, true);
});

// voicebox-beads-xo5d — the voiced "land branch" / "keep branch separate" act, decided where the
// workspace git lives. Each outcome is driven against a real scratch repo: nothing waiting, one
// waiting (executed for real — the merge is verified in the repo, not in the message), several
// waiting (never a guess), and a branch with nothing to land (ahead 0 is not a candidate).

function createRepoWithCandidates(count) {
  const repoDir = createTempGitRepo(); // starts with feat/agent-patch, 1 ahead of main
  for (let i = 2; i <= count; i++) {
    git(repoDir, ["checkout", "-b", `feat/candidate-${i}`]);
    fs.appendFileSync(path.join(repoDir, "notes.txt"), `candidate ${i}\n`, "utf8");
    git(repoDir, ["add", "notes.txt"]);
    git(repoDir, ["commit", "-m", `candidate ${i}`]);
    git(repoDir, ["checkout", "main"]);
  }
  return repoDir;
}

test("executeBranchIntent: nothing waiting is said as nothing, not as a success (xo5d)", (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  // Land the one candidate first so nothing is left waiting.
  const landed = landCandidateBranch(repoDir, "feat/agent-patch", { baseBranch: "main" });
  assert.equal(landed.ok, true);

  const none = executeBranchIntent(repoDir, "land", { baseBranch: "main" });
  assert.equal(none.ok, true);
  assert.equal(none.outcome, "none");
  assert.match(none.say, /no candidate branches/i);
});

test("executeBranchIntent: one waiting branch lands FOR REAL (xo5d)", (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const out = executeBranchIntent(repoDir, "land", { baseBranch: "main" });
  assert.equal(out.ok, true);
  assert.equal(out.outcome, "executed");
  assert.equal(out.branch, "feat/agent-patch");
  assert.match(out.say, /Landed feat\/agent-patch into main/);

  // The merge is a fact in the repo, not a message: main now carries the branch's file.
  const head = git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(head, "main");
  assert.equal(fs.readFileSync(path.join(repoDir, "notes.txt"), "utf8").includes("Agent verification notes"), true,
    "main must contain the landed branch's content");
  const none = executeBranchIntent(repoDir, "land", { baseBranch: "main" });
  assert.equal(none.outcome, "none", "a landed branch is no longer waiting");
});

test("executeBranchIntent: keep-separate executes without merging (xo5d)", (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const out = executeBranchIntent(repoDir, "keep-separate", { baseBranch: "main", decisionsFile: path.join(repoDir, ".voicebox-test-decisions.json") });
  assert.equal(out.ok, true);
  assert.equal(out.outcome, "executed");
  assert.equal(out.branch, "feat/agent-patch");
  assert.match(out.say, /stay separate/);
  const mainNotes = fs.existsSync(path.join(repoDir, "notes.txt"));
  assert.equal(mainNotes, false, "keep-separate must not merge the branch into main");
});

test("executeBranchIntent: a branch already kept separate is NOT waiting (xo5d + wmiq)", (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  const decisionsFile = path.join(repoDir, ".voicebox-test-decisions.json");

  const kept = executeBranchIntent(repoDir, "keep-separate", { baseBranch: "main", decisionsFile });
  assert.equal(kept.outcome, "executed");
  // The decision persists (wmiq), so the next voice "land branch" finds nothing waiting rather
  // than landing the branch the operator set aside.
  const next = executeBranchIntent(repoDir, "land", { baseBranch: "main", decisionsFile });
  assert.equal(next.outcome, "none", "a kept-separate branch must not be landed by the next voice act");
});

test("executeBranchIntent: several waiting branches is ambiguous — never a guess (xo5d)", (t) => {
  const repoDir = createRepoWithCandidates(2);
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const out = executeBranchIntent(repoDir, "land", { baseBranch: "main" });
  assert.equal(out.ok, true);
  assert.equal(out.outcome, "ambiguous");
  assert.equal(out.count, 2);
  assert.match(out.say, /2 candidate branches/);
  // Nothing merged: main still lacks the candidate content.
  assert.equal(fs.existsSync(path.join(repoDir, "notes.txt")), false, "an ambiguous voice act must not land anything");
});

test("executeBranchIntent: a conflicting branch is refused by name, not landed (xo5d)", (t) => {
  const repoDir = createTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  // Make main and the candidate disagree on the same line.
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Project\nMAIN's line\n", "utf8");
  git(repoDir, ["commit", "-am", "main diverges"]);
  git(repoDir, ["checkout", "feat/agent-patch"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Project\nCANDIDATE's line\n", "utf8");
  git(repoDir, ["commit", "-am", "candidate edits the same line"]);
  git(repoDir, ["checkout", "main"]);

  const out = executeBranchIntent(repoDir, "land", { baseBranch: "main" });
  assert.equal(out.ok, false, `a conflict must refuse: ${JSON.stringify(out)}`);
  assert.equal(out.refused, "merge-conflict");
  assert.match(out.say, /conflict/i);
});

// voicebox-beads-q376 / wmiq — the inspector's buttons answer to the SERVER, never to optimism.
// The shipped file is a browser module with NO exports (an `export` keyword would break the
// landed land-status suite, which vm-evals the source as a classic script). The bootstrap is
// DOM-guarded, so a window-less vm context loads the declarations with no side effects and the
// top-level function lands on the context global.
function loadPostBranchAction() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../public/apps/landing-inspector.js", import.meta.url), "utf8"), context);
  return context.postBranchAction;
}
// postBranchAction is the one fetch seam both buttons and the published room tools share; these
// drives use a fake fetch, so the unit tier covers what used to be a swallowed 404.

test("postBranchAction: a missing route (the old /api/branches/land 404) is a refusal, not a landing (q376)", async () => {
  const postBranchAction = loadPostBranchAction();
  const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, refused: "not-found", why: "no such route" }) });
  const answer = await postBranchAction("/api/branches/land", { branch: "feat/x" }, fakeFetch);
  assert.equal(answer.ok, false);
  assert.equal(answer.refused, "not-found");
  assert.match(answer.why, /no such route/);
});

test("postBranchAction: an unreachable server is a refusal, not a landing (q376)", async () => {
  const postBranchAction = loadPostBranchAction();
  const fakeFetch = async () => { throw new TypeError("fetch failed"); };
  const answer = await postBranchAction("/api/branches/merge", { branch: "feat/x" }, fakeFetch);
  assert.equal(answer.ok, false);
  assert.equal(answer.refused, "server-unreachable");
  assert.match(answer.why, /nothing was recorded/);
});

test("postBranchAction: the server's own refusal is carried through by name (wmiq)", async () => {
  const postBranchAction = loadPostBranchAction();
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, refused: "merge-conflict", why: "conflicts with main" }) });
  const answer = await postBranchAction("/api/branches/merge", { branch: "feat/x" }, fakeFetch);
  assert.equal(answer.ok, false);
  assert.equal(answer.refused, "merge-conflict");
});

test("postBranchAction: only a confirmed ok is a success (wmiq)", async () => {
  const postBranchAction = loadPostBranchAction();
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, action: "kept-separate", branch: "feat/x" }) });
  const answer = await postBranchAction("/api/branches/keep-separate", { branch: "feat/x" }, fakeFetch);
  assert.equal(answer.ok, true);
  assert.equal(answer.data.action, "kept-separate");
});
