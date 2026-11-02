// tests/landing-inspector-actions.test.mjs — voicebox-beads-wmiq / q376, driven in a real browser.
//
//   node --test tests/landing-inspector-actions.test.mjs
//
// The defect: the inspector's "Keep separate" button printed success without ever calling the
// server (wmiq), and "Land" posted to /api/branches/land — a route that does not exist — and
// marked the branch landed anyway (q376). These drives open the REAL inspector page in a real
// browser against a real server whose workspace is a scratch git repo, click the REAL buttons,
// and assert the facts where they live: the recorded decision on the server's disk, the merge in
// the repo, and the server's annotation surviving a page reload.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { gitEnv } from "../lib/git-env.mjs";

let scratch;
let server;
let workspaceRepo;
let decisionsFile;

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeWorkspaceRepo(candidates = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voicebox-inspector-actions-"));
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

test.before(async () => {
  scratch = mkdtempSync(path.join(os.homedir(), ".voicebox-inspector-actions-test-"));
  decisionsFile = path.join(scratch, "ws", "branch-decisions.json");
  workspaceRepo = makeWorkspaceRepo([
    { name: "feat/keep-me", file: "kept.txt", content: "kept\n" },
    { name: "feat/land-me", file: "landed.txt", content: "landed\n" },
    { name: "feat/doomed", file: "doomed.txt", content: "doomed\n" },
    // The room-mounted drive's own candidates (voicebox-beads-j6im): landing them happens ONLY through the room's
    // consent prompt, so they must not be the branches the standalone-page drives already merged.
    { name: "feat/room-land-me", file: "room-landed.txt", content: "room landed\n" },
    { name: "feat/room-deny-me", file: "room-denied.txt", content: "room denied\n" },
  ]);
  server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "ws") }, cwd: scratch });
  const declared = await fetch(`${server.base}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "inspector-actions", root: { kind: "machine", path: workspaceRepo } }),
  }).then((r) => r.json());
  assert.equal(declared.ok, true, `root declaration failed: ${JSON.stringify(declared)}`);
});

test.after(async () => {
  await server?.stop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (workspaceRepo) rmSync(workspaceRepo, { recursive: true, force: true });
});

test('clicking "Keep separate" records the decision on the SERVER and it survives a reload (wmiq)', async (t) => {
  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());
  await page.goto(`${server.base}/apps/landing-inspector.html`);

  // The list renders the server candidates (not the built-in preview fixtures).
  await page.waitFor(
    () => !!document.querySelector('.branch-item[data-branch-name="feat/keep-me"]'),
    { label: "candidate rows from the server" },
  );
  // Select it, then click the real button.
  await page.click('.branch-item[data-branch-name="feat/keep-me"]');
  await page.waitFor(
  () => document.getElementById("selected-branch-heading")?.textContent.includes("feat/keep-me"),
    { label: "selection rendered" },
  );
  await page.click("#keep-separate-btn");
  await page.waitFor(
    () => document.getElementById("review-action-status")?.textContent.includes("Kept feat/keep-me separate"),
    { label: "keep confirmation shown" },
  );

  // The server-side fact: the decision is recorded on disk.
  assert.equal(existsSync(decisionsFile), true, "the decisions ledger must exist after a keep-separate");
  const decisions = JSON.parse(readFileSync(decisionsFile, "utf8"));
  const keys = Object.keys(decisions);
  assert.equal(keys.length, 1);
  assert.ok(keys[0].endsWith("::feat/keep-me"), `decision key names the branch: ${keys[0]}`);
  assert.equal(decisions[keys[0]].decision, "kept-separate");

  // A RELOAD reads the server's annotation, not the old in-memory mark.
  await page.reload();
  await page.waitFor(
    () => document.querySelector('.branch-item[data-branch-name="feat/keep-me"] .branch-decision')?.textContent === "Kept separate",
    { label: "kept-separate badge after reload" },
  );
});

test('clicking "Land" merges for real through /api/branches/merge (q376)', async (t) => {
  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());
  await page.goto(`${server.base}/apps/landing-inspector.html`);
  await page.waitFor(
    () => !!document.querySelector('.branch-item[data-branch-name="feat/land-me"]'),
    { label: "candidate rows from the server" },
  );
  await page.click('.branch-item[data-branch-name="feat/land-me"]');
  await page.waitFor(
    () => document.getElementById("selected-branch-heading")?.textContent.includes("feat/land-me"),
    { label: "selection rendered" },
  );
  await page.click("#land-branch-btn");
  await page.waitFor(
    () => document.getElementById("review-action-status")?.textContent.includes("Landed feat/land-me"),
    { label: "land confirmation shown" },
  );

  // The merge is a fact in the repo, not a message.
  assert.equal(git(workspaceRepo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.equal(readFileSync(path.join(workspaceRepo, "landed.txt"), "utf8"), "landed\n");
});

test("a failed action says so and marks nothing (wmiq/q376)", async (t) => {
  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());
  await page.goto(`${server.base}/apps/landing-inspector.html`);
  await page.waitFor(
    () => !!document.querySelector('.branch-item[data-branch-name="feat/doomed"]'),
    { label: "candidate rows" },
  );
  // Select it, THEN delete the branch on the host: the page's state is stale, the server refuses
  // branch-not-found, and the page must show the refusal and mark nothing.
  await page.click('.branch-item[data-branch-name="feat/doomed"]');
  await page.waitFor(
    () => document.getElementById("selected-branch-heading")?.textContent.includes("feat/doomed"),
    { label: "selection rendered" },
  );
  git(workspaceRepo, ["branch", "-D", "feat/doomed"]);
  await page.click("#keep-separate-btn");
  await page.waitFor(
    () => /Could not keep/.test(document.getElementById("review-action-status")?.textContent ?? ""),
    { label: "refusal shown" },
  );
  const marked = await page.evaluate(
    (name) => document.querySelector(`.branch-item[data-branch-name="${name}"] .branch-decision`)?.textContent ?? "",
    "feat/doomed",
  );
  assert.notEqual(marked, "Kept separate", "a refused keep-separate must not render the decision badge");
});

test("ROOM-MOUNTED inspector shows the server's real candidates through the fetch relay, never the fabricated ones (v1k6)", async (t) => {
  // The reviewer's repro: in the room the inspector is mounted via mini-app-bridge.html whose
  // inner frame is sandboxed WITHOUT allow-same-origin — fetch('/api/...') from it fails, and the
  // app kept showing the built-in preview rows while 23 real branches sat in the API. The bridge
  // now relays same-origin fetches; this drive mounts the inspector THE ROOM'S WAY and asks its
  // own published tool for the list.
  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());
  await page.goto(`${server.base}/`);
  await page.waitFor(
    () => typeof window.__voiceboxOpenBranchInspector === "function" && !!window.__voiceboxMiniAppRegistry,
    { label: "room booted" },
  );
  await page.evaluate(() => window.__voiceboxOpenBranchInspector());
  await page.waitFor(
    () => window.__voiceboxMiniAppRegistry.getAllTools().some((t) => t.name === "list_candidate_branches"),
    { label: "inspector tools registered through the bridge", timeout: 30000 },
  );
  const out = await page.evaluate(
    () => window.__voiceboxMiniAppRegistry.executeTool("list_candidate_branches", {}),
  );
  assert.equal(out.ok, true, `tool call failed: ${JSON.stringify(out).slice(0, 300)}`);
  const names = (out.result?.branches ?? []).map((b) => b.name);
  assert.ok(names.includes("feat/keep-me"), `the room surface must list the server's real branch — got ${JSON.stringify(names)}`);
  assert.ok(!names.includes("feat/voice-greeting-polish"), `a fabricated fixture branch is on the room surface: ${JSON.stringify(names)}`);
});

// ── HOST ACTIONS IN THE ROOM (voicebox-beads-j6im) ────────────────────────────────────────────────
//
// The finding: the fetch relay gave the sandboxed app the room page's own Origin, server.mjs treats that
// Origin as the operator, and the bridge then ran `git merge` for app code. These two drives are the
// boundary, measured in a real browser against a real repo:
//
//   * a landing asked from inside the sandbox does NOT touch the repo, and does not even leave the page —
//     the room asks the person first, in a bar outside the iframe;
//   * an Allow is what lands it, and the app still reports the SERVER's own answer (the ulhi rule);
//   * a Deny lands nothing and tells the app why.

test("the room asks before it lands, and only an Allow merges the branch (j6im)", async (t) => {
  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());
  await page.goto(`${server.base}/`);
  await page.waitFor(
    () => typeof window.__voiceboxOpenBranchInspector === "function" && !!window.__voiceboxMiniAppRegistry,
    { label: "room booted" },
  );
  await page.evaluate(() => window.__voiceboxOpenBranchInspector());
  await page.waitFor(
    () => window.__voiceboxMiniAppRegistry.getAllTools().some((x) => x.name === "land_candidate_branch"),
    { label: "inspector tools registered through the bridge", timeout: 30000 },
  );

  // The app's own list first (a landing needs the branch it knows about, and this is the room's real read path).
  const listed = await page.evaluate(
    () => window.__voiceboxMiniAppRegistry.executeTool("list_candidate_branches", {}),
  );
  assert.ok(
    (listed.result?.branches ?? []).some((b) => b.name === "feat/room-land-me"),
    `the room surface must know the branch before it can land it — got ${JSON.stringify(listed).slice(0, 300)}`,
  );

  // Ask the app to land, exactly as a click inside the sandbox does — and do not await it yet.
  await page.evaluate(() => {
    window.__j6imLand = window.__voiceboxMiniAppRegistry.executeTool("land_candidate_branch", {
      branch: "feat/room-land-me",
    });
  });

  await page.waitFor(() => !!document.querySelector(".mini-app-consent"), {
    label: "the room's consent prompt",
    timeout: 15000,
  });
  const prompt = await page.evaluate(() => ({
    text: document.querySelector(".mini-app-consent")?.textContent ?? "",
    // The prompt lives in the room's DOM, NOT inside the app's frame: app HTML cannot draw over it.
    insideAppFrame: !!document.querySelector("#mini-app-outer-frame")?.contentDocument?.querySelector?.(".mini-app-consent"),
    focused: document.activeElement?.className ?? "",
  }));
  assert.match(prompt.text, /branch-landing-inspector/, `the prompt must name the app: ${prompt.text}`);
  assert.match(prompt.text, /POST \/api\/branches\/merge/, `the prompt must name the route: ${prompt.text}`);
  assert.match(prompt.text, /feat\/room-land-me/, `the prompt must name the branch: ${prompt.text}`);
  assert.equal(prompt.insideAppFrame, false, "the consent prompt must be the room's, not the app's");
  assert.match(prompt.focused, /deny/, "the safe answer must hold focus, so a stray Enter cannot land a branch");

  // Nothing has happened yet: the merge is a fact in the repo, not a message.
  assert.equal(
    existsSync(path.join(workspaceRepo, "room-landed.txt")),
    false,
    "the branch was merged before anyone approved it",
  );

  await page.click(".mini-app-consent-allow");
  const out = await page.evaluate(() => window.__j6imLand);
  assert.equal(out.ok, true, `the approved landing failed: ${JSON.stringify(out).slice(0, 300)}`);
  assert.equal(out.result?.action, "landed");
  // The app reports the SERVER's answer, and the repo is where the claim is checkable.
  assert.equal(readFileSync(path.join(workspaceRepo, "room-landed.txt"), "utf8"), "room landed\n");
  assert.equal(git(workspaceRepo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.equal(
    await page.evaluate(() => !document.querySelector(".mini-app-consent")),
    true,
    "the prompt must go away once it has been answered",
  );
});

test("a Deny sends nothing and tells the app why (j6im)", async (t) => {
  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());
  await page.goto(`${server.base}/`);
  await page.waitFor(
    () => typeof window.__voiceboxOpenBranchInspector === "function" && !!window.__voiceboxMiniAppRegistry,
    { label: "room booted" },
  );
  await page.evaluate(() => window.__voiceboxOpenBranchInspector());
  await page.waitFor(
    () => window.__voiceboxMiniAppRegistry.getAllTools().some((x) => x.name === "land_candidate_branch"),
    { label: "inspector tools registered through the bridge", timeout: 30000 },
  );

  const listed = await page.evaluate(
    () => window.__voiceboxMiniAppRegistry.executeTool("list_candidate_branches", {}),
  );
  assert.ok(
    (listed.result?.branches ?? []).some((b) => b.name === "feat/room-deny-me"),
    `the room surface must know the branch before it can land it — got ${JSON.stringify(listed).slice(0, 300)}`,
  );
  await page.evaluate(() => {
    window.__j6imDeny = window.__voiceboxMiniAppRegistry.executeTool("land_candidate_branch", {
      branch: "feat/room-deny-me",
    });
  });
  await page.waitFor(() => !!document.querySelector(".mini-app-consent"), {
    label: "the room's consent prompt",
    timeout: 15000,
  });
  await page.click(".mini-app-consent-deny");

  const out = await page.evaluate(() => window.__j6imDeny);
  // The bridge's envelope says the tool RAN (ok:true); the tool's own result is the app's answer, and the app's
  // answer must be a refusal that names the denial — not "Landed …" (the ulhi rule).
  assert.equal(out.ok, true, `the tool call itself failed: ${JSON.stringify(out).slice(0, 300)}`);
  assert.equal(out.result?.ok, false, `a denied landing reported success: ${JSON.stringify(out.result).slice(0, 300)}`);
  assert.match(
    String(out.result?.error ?? ""),
    /denied/i,
    `the app must be told why: ${JSON.stringify(out.result).slice(0, 300)}`,
  );
  assert.equal(
    existsSync(path.join(workspaceRepo, "room-denied.txt")),
    false,
    "a denied landing merged the branch anyway",
  );
  assert.equal(git(workspaceRepo, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
});
