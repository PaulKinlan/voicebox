// tests/tool-index.test.mjs — Unified Tool & Capability Index + Voice-First Self-Editing & Exec
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createToolIndex, listTools, searchTools, runSystemCommand } from "../lib/tool-index.mjs";
import { parseRoomFolderTurn } from "../public/room-folder-ops.js";
import { startServer } from "./lib/server.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("listTools aggregates native, wasm, extension, system, script, mini_app, and harness capabilities", async () => {
  const index = await listTools({
    rootPath: REPO_ROOT,
    miniAppTools: [{ name: "roll_dice", description: "Roll a 6-sided die in the active mini-app", appId: "app_1" }],
    harnesses: [{ id: "pi", name: "Pi Coding Agent", status: "ready", binary: "pi" }],
  });

  assert.equal(index.ok, true);
  assert.ok(index.count > 20, `expected >20 tools, got ${index.count}`);
  assert.ok(index.counts.native >= 20, `expected >=20 native commands, got ${index.counts.native}`);
  assert.ok(index.counts.system >= 1, `expected >=1 system tool, got ${index.counts.system}`);
  assert.ok(index.counts.script >= 1, `expected >=1 package.json script, got ${index.counts.script}`);
  assert.equal(index.counts.mini_app, 1);
  assert.equal(index.counts.harness, 1);

  const nativeWrite = index.tools.find((t) => t.kind === "native" && t.name === "write_file");
  assert.ok(nativeWrite, "write_file should be in native tools");
  assert.equal(nativeWrite.status, "ready");

  const nativeOpen = index.tools.find((t) => t.kind === "native" && t.name === "open_workspace");
  assert.ok(nativeOpen, "open_workspace should be in native tools");

  const sysNode = index.tools.find((t) => t.kind === "system" && t.name === "node");
  assert.ok(sysNode, "node should be discovered in system tools");

  const scriptTestUnit = index.tools.find((t) => t.kind === "script" && t.name === "test:unit");
  assert.ok(scriptTestUnit, "npm run test:unit should be discovered in project scripts");
  assert.match(scriptTestUnit.invokeHint, /npm run test:unit/);

  // Filtering by kind
  const onlyNative = await listTools({ rootPath: REPO_ROOT, kind: "native" });
  assert.equal(onlyNative.ok, true);
  assert.ok(onlyNative.tools.every((t) => t.kind === "native"));
});

test("searchTools ranks exact, prefix, substring, description, and synonym matches", async () => {
  const trackerSearch = await searchTools("issue tracker", { rootPath: REPO_ROOT });
  assert.equal(trackerSearch.ok, true);
  assert.ok(trackerSearch.count >= 1, "searching 'issue tracker' should match tools");
  const hasBdOrGh = trackerSearch.tools.some((t) => t.name === "bd" || t.name === "gh" || t.tags?.includes("beads"));
  assert.ok(hasBdOrGh, `expected bd or gh in issue tracker results, got ${trackerSearch.tools.map((t) => t.name).join(", ")}`);

  const testSearch = await searchTools("test:unit", { rootPath: REPO_ROOT });
  assert.equal(testSearch.ok, true);
  assert.equal(testSearch.tools[0].name, "test:unit", "exact name match should rank first");

  const selfSearch = await searchTools("open voicebox codebase", { rootPath: REPO_ROOT });
  assert.equal(selfSearch.ok, true);
  assert.ok(selfSearch.tools.some((t) => t.name === "open_workspace"), "open_workspace should match 'open voicebox codebase'");

  const idx = createToolIndex({ rootPath: REPO_ROOT });
  const viaInstance = await idx.search("git");
  assert.ok(viaInstance.tools.some((t) => t.name === "git" || t.name === "git_status"));
});

test("runSystemCommand executes non-interactively inside rootPath and enforces cwd containment and timeout", async () => {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vb-tool-exec-")));
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vb-tool-outside-")));
  try {
    mkdirSync(path.join(scratch, "sub"), { recursive: true });
    writeFileSync(path.join(scratch, "sub", "hello.txt"), "inside-sub\n", "utf8");
    symlinkSync(outside, path.join(scratch, "escape-link"));

    // 1. Basic command execution
    const res = await runSystemCommand(scratch, {
      command: `${ JSON.stringify(process.execPath) } -e "console.log('tool-exec-ok')"`,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /tool-exec-ok/);

    // 2. Relative subdirectory cwd
    const subRes = await runSystemCommand(scratch, {
      command: `${ JSON.stringify(process.execPath) } -e "console.log(require('fs').readFileSync('hello.txt', 'utf8').trim())"`,
      cwd: "sub",
    });
    assert.equal(subRes.ok, true, JSON.stringify(subRes));
    assert.equal(subRes.cwd, "sub");
    assert.match(subRes.stdout, /inside-sub/);

    // 3. Traversal refusal (`..`)
    const escaped = await runSystemCommand(scratch, {
      command: "pwd",
      cwd: "../outside",
    });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.refused, "outside-root");

    // 4. Symlink escape refusal
    const symlinkEscaped = await runSystemCommand(scratch, {
      command: "pwd",
      cwd: "escape-link",
    });
    assert.equal(symlinkEscaped.ok, false);
    assert.equal(symlinkEscaped.refused, "outside-root");

    // 5. Non-zero exit code reported honestly
    const failed = await runSystemCommand(scratch, {
      command: `${ JSON.stringify(process.execPath) } -e "console.error('boom'); process.exit(7)"`,
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.refused, "command-failed");
    assert.equal(failed.exitCode, 7);
    assert.match(failed.stderr, /boom/);

    // 6. Timeout enforcement
    const timedOut = await runSystemCommand(scratch, {
      command: `${ JSON.stringify(process.execPath) } -e "setTimeout(() => {}, 5000)"`,
      timeoutMs: 1000,
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.refused, "command-timeout");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("parseRoomFolderTurn does not hijack 'open voicebox' or 'show all tools' as local file reads", () => {
  assert.equal(parseRoomFolderTurn("open voicebox"), null);
  assert.equal(parseRoomFolderTurn("open self"), null);
  assert.equal(parseRoomFolderTurn("open workspace"), null);
  assert.equal(parseRoomFolderTurn("show tools"), null);
  assert.equal(parseRoomFolderTurn("show all tools"), null);
  // Real file reads still parse as expected:
  assert.deepEqual(parseRoomFolderTurn("read lib/commands.mjs"), { verb: "read", name: "lib/commands.mjs" });
});

test("HTTP GET /api/tools, POST /api/root { self: true }, and /api/turn for list_tools, search_tools, open_workspace, subdirectory list, and exec", async () => {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vb-tool-srv-")));
  const stateDir = path.join(scratch, "state");
  const projDir = path.join(scratch, "proj");
  mkdirSync(path.join(projDir, "lib"), { recursive: true });
  writeFileSync(path.join(projDir, "lib", "helper.mjs"), "export const x = 1;\n", "utf8");

  const srv = await startServer({
    env: {
      VOICEBOX_STATE_DIR: stateDir,
      VOICEBOX_PROVIDER: "script",
    },
  });

  try {
    const turn = (transcript) =>
      fetch(`${srv.base}/api/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript }),
      }).then((r) => r.json());

    // 1. GET /api/tools works without any root declared
    const toolsHttp = await fetch(`${srv.base}/api/tools`).then((r) => r.json());
    assert.equal(toolsHttp.ok, true);
    assert.ok(toolsHttp.count > 20);
    assert.ok(toolsHttp.counts.native >= 20);

    const searchHttp = await fetch(`${srv.base}/api/tools?q=issue+tracker`).then((r) => r.json());
    assert.equal(searchHttp.ok, true);
    assert.ok(searchHttp.count >= 1);

    // 2. Spoken turns for list_tools and search_tools work before a root is declared
    const turnListTools = await turn("what tools do you have");
    assert.equal(turnListTools.action.verb, "list_tools");
    assert.equal(turnListTools.result.ok, true);
    assert.ok(turnListTools.result.count > 20);

    const turnSearchTools = await turn("search tools for git");
    assert.equal(turnSearchTools.action.verb, "search_tools");
    assert.equal(turnSearchTools.result.ok, true);
    assert.ok(turnSearchTools.result.tools.some((t) => t.name === "git" || t.name === "git_status"));

    // 3. Spoken turn 'open voicebox' declares Voicebox's own repo root
    const turnOpenSelf = await turn("open voicebox");
    assert.equal(turnOpenSelf.action.verb, "open_workspace");
    assert.equal(turnOpenSelf.result.ok, true);
    assert.equal(turnOpenSelf.result.project, "voicebox");
    assert.equal(turnOpenSelf.result.root.path, REPO_ROOT);
    assert.ok(turnOpenSelf.result.files.includes("server.mjs"));

    // 4. Subdirectory list ("list files in lib") lists files inside lib/ with relative paths
    const turnListSub = await turn("list files in lib");
    assert.equal(turnListSub.action.verb, "list");
    assert.equal(turnListSub.result.ok, true);
    assert.equal(turnListSub.result.dir, "lib");
    assert.ok(turnListSub.result.files.includes("lib/commands.mjs"), `expected lib/commands.mjs in ${JSON.stringify(turnListSub.result.files)}`);

    // 5. Switch to scratch projDir via open_workspace and run a command + write a nested file
    const turnOpenProj = await turn(`open workspace ${projDir}`);
    assert.equal(turnOpenProj.result.ok, true);
    assert.equal(turnOpenProj.result.root.path, projDir);

    const turnWriteSub = await turn("create file src/new-module.mjs with export const ready = true;");
    assert.equal(turnWriteSub.action.verb, "write");
    assert.equal(turnWriteSub.result.ok, true);
    assert.equal(turnWriteSub.result.file, "src/new-module.mjs");

    const turnExec = await turn("run command node -e \"console.log(21 * 2)\"");
    assert.equal(turnExec.action.verb, "exec");
    assert.equal(turnExec.result.ok, true, JSON.stringify(turnExec.result));
    assert.equal(turnExec.result.exitCode, 0);
    assert.match(turnExec.result.stdout, /42/);

    // 6. POST /api/root with { self: true } from local origin opens Voicebox's own repo
    const selfRootRes = await fetch(`${srv.base}/api/root`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: srv.base,
      },
      body: JSON.stringify({ self: true }),
    });
    assert.equal(selfRootRes.status, 200);
    const selfRootBody = await selfRootRes.json();
    assert.equal(selfRootBody.ok, true);
    assert.equal(selfRootBody.project, "voicebox");
    assert.equal(selfRootBody.root.path, REPO_ROOT);
  } finally {
    await srv.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("runSystemCommand strips hook Git plumbing while preserving the supplied environment (voicebox-beads-946i)", async () => {
  const rootPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vb-tool-git-root-")));
  const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vb-tool-git-other-")));
  try {
    const env = {
      ...process.env,
      GIT_DIR: path.join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: path.join(other, "index"),
      CUSTOM_VAR: "preserve-me",
    };
    const init = await runSystemCommand(rootPath, { command: "git init", env });
    assert.equal(init.ok, true, init.stderr);
    const status = await runSystemCommand(rootPath, { command: "git rev-parse --show-toplevel", env });
    assert.equal(realpathSync(status.stdout.trim()), realpathSync(rootPath), "git answers about the declared root, not the hook repository");
    const child = await runSystemCommand(rootPath, {
      command: `${JSON.stringify(process.execPath)} -e "console.log(JSON.stringify({ custom: process.env.CUSTOM_VAR, dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE }))"`,
      env,
    });
    assert.equal(child.ok, true);
    assert.deepEqual(JSON.parse(child.stdout.trim()), { custom: "preserve-me" }, "descendant git cannot inherit hook plumbing either");
    assert.equal(env.GIT_DIR, path.join(other, ".git"), "the caller's environment is not mutated");
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
