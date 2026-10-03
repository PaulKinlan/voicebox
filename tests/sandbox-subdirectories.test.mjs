import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { gitEnv } from "../tools/tree-dirt.mjs";

function initSubRepo(dir, branch = "main", commitMsg = "initial commit", fileName = "README.md", content = "# Subrepo\n") {
  mkdirSync(dir, { recursive: true });
  const opts = { cwd: dir, env: gitEnv(), stdio: "ignore" };
  execFileSync("git", ["init", "-b", branch], opts);
  execFileSync("git", ["config", "user.email", "test@voicebox.local"], opts);
  execFileSync("git", ["config", "user.name", "Voicebox Test"], opts);
  writeFileSync(path.join(dir, fileName), content, "utf8");
  execFileSync("git", ["add", fileName], opts);
  execFileSync("git", ["commit", "-m", commitMsg], opts);
}

test("sandbox subdirectories: git_status, git_log, git_diff, grep, exec, and open_workspace across subrepos", async (t) => {
  const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), "vb-sandbox-root-"));
  const repoAlpha = path.join(sandboxRoot, "repo-alpha");
  const repoBeta = path.join(sandboxRoot, "repo-beta");

  initSubRepo(repoAlpha, "main", "alpha initial commit", "alpha.txt", "alpha token 123\n");
  initSubRepo(repoBeta, "feat/beta", "beta feature commit", "beta.txt", "beta token 456\n");
  // Make repo-beta dirty
  writeFileSync(path.join(repoBeta, "beta.txt"), "beta token 456\ndirty line\n", "utf8");

  const srv = await startServer({
    env: {
      VOICEBOX_WORKSPACE: sandboxRoot,
      VOICEBOX_SANDBOX_HOMES: sandboxRoot,
    },
  });
  t.after(async () => {
    await srv.stop();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  // 1. Sandbox root is NOT a .git repo itself, but contains repo-alpha and repo-beta.
  // git_status at root auto-discovers subrepositories instead of refusing with not-a-git-repo!
  {
    const res = await fetch(`${srv.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "git status" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.ok, true);
    assert.ok(Array.isArray(body.result.subrepositories), "expected subrepositories array");
    assert.equal(body.result.subrepositories.length, 2);
    const alpha = body.result.subrepositories.find((r) => r.dir === "repo-alpha");
    const beta = body.result.subrepositories.find((r) => r.dir === "repo-beta");
    assert.ok(alpha);
    assert.equal(alpha.branch, "main");
    assert.equal(alpha.dirty, false);
    assert.ok(beta);
    assert.equal(beta.branch, "feat/beta");
    assert.equal(beta.dirty, true);
  }

  // 2. Explicit subdirectory git_status via transcript and via action.dir
  {
    const res = await fetch(`${srv.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "git status in repo-beta" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.action.verb, "git_status");
    assert.equal(body.action.dir, "repo-beta");
    assert.equal(body.result.ok, true);
    assert.equal(body.result.dir, "repo-beta");
    assert.equal(body.result.branch, "feat/beta");
    assert.equal(body.result.dirty, true);
    assert.ok(body.result.files.some((f) => f.path === "beta.txt"));
  }

  // 3. Explicit subdirectory git_log via transcript ("git log in repo-beta")
  {
    const res = await fetch(`${srv.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "git log in repo-beta" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.action.verb, "git_log");
    assert.equal(body.action.dir, "repo-beta");
    assert.equal(body.result.ok, true);
    assert.equal(body.result.dir, "repo-beta");
    assert.equal(body.result.commits[0].message, "beta feature commit");
  }

  // 4. Explicit subdirectory git_diff via transcript ("git diff in repo-beta")
  {
    const res = await fetch(`${srv.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "git diff in repo-beta" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.action.verb, "git_diff");
    assert.equal(body.action.dir, "repo-beta");
    assert.equal(body.result.ok, true);
    assert.equal(body.result.dir, "repo-beta");
    assert.match(body.result.diff, /\+dirty line/);
  }

  // 5. Subdirectory-scoped grep via transcript and GET /api/grep?dir=...
  {
    const res = await fetch(`${srv.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "grep token in repo-alpha" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.action.verb, "grep");
    assert.equal(body.action.dir, "repo-alpha");
    assert.equal(body.result.ok, true);
    assert.equal(body.result.count, 1);
    assert.equal(body.result.matches[0].file, "repo-alpha/alpha.txt");

    const getRes = await fetch(`${srv.base}/api/grep?q=token&dir=repo-beta`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.ok, true);
    assert.equal(getBody.count, 1);
    assert.equal(getBody.matches[0].file, "repo-beta/beta.txt");
  }

  // 6. Command execution in a subdirectory via transcript ("run git status in repo-beta") and turn dir context
  {
    const res = await fetch(`${srv.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "run git status --short in repo-beta" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.action.verb, "exec");
    assert.equal(body.action.cwd, "repo-beta");
    assert.equal(body.result.ok, true);
    assert.match(body.result.stdout, /beta\.txt/);
  }

  // 7. open_workspace supports relative subdirectory ("repo-alpha") and "sandbox"
  {
    const resSub = await fetch(`${srv.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "open workspace repo-alpha" }),
    });
    assert.equal(resSub.status, 200);
    const bodySub = await resSub.json();
    assert.equal(bodySub.result.ok, true);
    assert.equal(bodySub.result.project, "repo-alpha");
    assert.ok(bodySub.result.files.includes("alpha.txt"));

    const resSandbox = await fetch(`${srv.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "open sandbox" }),
    });
    assert.equal(resSandbox.status, 200);
    const bodySandbox = await resSandbox.json();
    assert.equal(bodySandbox.result.ok, true);
    assert.equal(bodySandbox.result.project, "sandbox");
    assert.deepEqual(bodySandbox.result.subrepositories, ["repo-alpha", "repo-beta"]);
  }
});

test("mini-app persistence and harness configure aliases in server.mjs", async (t) => {
  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "vb-miniapp-srv-"));
  const srv = await startServer({
    env: {
      VOICEBOX_WORKSPACE: scratchRoot,
    },
  });
  t.after(async () => {
    await srv.stop();
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  // 1. Launching a mini-app with the same title twice updates in place rather than duplicating
  const launch1 = await fetch(`${srv.base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: { verb: "mini_app", title: "Counter Widget", html: "<h1>v1</h1>" },
    }),
  }).then((r) => r.json());
  assert.equal(launch1.result.ok, true);
  assert.equal(launch1.result.created, true);
  assert.equal(launch1.result.miniApp.appId, "app_counter-widget");
  assert.equal(launch1.result.miniApp.slug, "counter-widget");

  const launch2 = await fetch(`${srv.base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: { verb: "mini_app", title: "Counter Widget", html: "<h1>v2</h1>" },
    }),
  }).then((r) => r.json());
  assert.equal(launch2.result.ok, true);
  assert.equal(launch2.result.updated, true);
  assert.equal(launch2.result.miniApp.appId, "app_counter-widget");

  const listApps = await fetch(`${srv.base}/api/mini-apps`).then((r) => r.json());
  assert.equal(listApps.ok, true);
  assert.equal(listApps.count, 1);
  assert.equal(listApps.apps[0].appId, "app_counter-widget");

  const getApp = await fetch(`${srv.base}/api/mini-apps?id=counter-widget`).then((r) => r.json());
  assert.equal(getApp.ok, true);
  assert.equal(getApp.miniApp.html, "<h1>v2</h1>");

  const delApp = await fetch(`${srv.base}/api/mini-apps?id=counter-widget`, { method: "DELETE" }).then((r) => r.json());
  assert.equal(delApp.ok, true);

  // 2. POST /api/harnesses/configure supports { id: "antigravity", agentId, name, url } and { id: "claude-agent-acp" }
  const cfgAgy = await fetch(`${srv.base}/api/harnesses/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "antigravity",
      agentId: "custom-agy",
      name: "Custom Anti-Gravity",
      url: "http://127.0.0.1:3284",
    }),
  }).then((r) => r.json());
  assert.equal(cfgAgy.ok, true);
  assert.equal(cfgAgy.activeHarness, "antigravity");

  const agentsRes = await fetch(`${srv.base}/api/agents?harness=antigravity`).then((r) => r.json());
  assert.equal(agentsRes.ok, true);
  const customAgy = agentsRes.agents.find((a) => a.id === "custom-agy");
  assert.ok(customAgy, "expected custom-agy in registered agents");
  assert.equal(customAgy.name, "Custom Anti-Gravity");
  assert.equal(customAgy.url, "http://127.0.0.1:3284");
});
