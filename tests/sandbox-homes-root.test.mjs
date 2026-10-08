// tests/sandbox-homes-root.test.mjs — voicebox-beads-3bxc (Paul P0):
// BUG: sandbox homes root env var honors fresh tilde directory.
//
// Paul verbatim: "the voicebox sandbox homes root environment variable doesn’t work anymore.
// I tried it with a tilde/new directory and yeah it’s not getting picked up as a root.
// So you keep saying no folder chosen".
//
// DIAGNOSIS (read-vs-tilde):
// (a) Variable not read: server.mjs previously only inspected `workspaceDeclared()` (VOICEBOX_WORKSPACE)
//     for the boot root; VOICEBOX_SANDBOX_HOMES was documented in server help as "sandbox home root"
//     but was never checked for boot root declaration, so setting it alone left `active` null.
// (b) Read but tilde not expanded on fresh path: Node's `path.resolve("~/dir")` does not expand `~`
//     (resolving to literal `<cwd>/~/dir`). Furthermore, on a fresh (not yet existing) path,
//     `existsSync()` was false because no directory creation was attempted, causing the server
//     to reject the declaration and leave `active` null. The UI then displayed "no folder chosen yet".

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { expandHome, sandboxHomesDeclared, workspaceDeclared } from "../lib/state-dirs.mjs";
import { resolveWorkspaceCandidate } from "../lib/resolver.mjs";

test("expandHome: expands ~ and ~/ to os.homedir()", () => {
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("~/projects/vb"), path.join(os.homedir(), "projects/vb"));
  assert.equal(expandHome("/absolute/path"), "/absolute/path");
  assert.equal(expandHome("relative/path"), "relative/path");
  assert.equal(expandHome(""), "");
  assert.equal(expandHome(null), null);
});

test("resolver: resolveWorkspaceCandidate expands ~/ in target paths", () => {
  const result = resolveWorkspaceCandidate("~/my-sample-repo", {
    activeRootPath: null,
    selfRootPath: "/app",
    sandboxRootPath: "/sandboxes",
    exists: () => true,
  });
  assert.equal(result.candidate, path.join(os.homedir(), "my-sample-repo"));
});

test("independent proof: (a) VOICEBOX_SANDBOX_HOMES alone declares boot root when workspace is unset", async () => {
  const testDirName = `vb-p0-test-sandbox-${crypto.randomBytes(4).toString("hex")}`;
  const tildePath = `~/${testDirName}`;
  const resolvedPath = path.join(os.homedir(), testDirName);

  assert.equal(existsSync(resolvedPath), false, "precondition: fresh directory does not exist on disk yet");

  const srv = await startServer({
    env: {
      VOICEBOX_WORKSPACE: undefined,
      VOICEBOX_SANDBOX_HOMES: tildePath,
      VOICEBOX_INSTANCE: "sandbox-homes-test-a",
    },
  });

  try {
    // 1. Directory is automatically created for fresh path
    assert.equal(existsSync(resolvedPath), true, "server must auto-create fresh tilde path directory");

    // 2. GET /api/root reports declared root matching the expanded tilde directory
    const res = await fetch(`${srv.base}/api/root`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.ok, true);
    assert.equal(body.declared, true, "root must be declared");
    assert.equal(body.project, testDirName);
    assert.equal(body.root?.kind, "machine");
    assert.equal(body.root?.path, resolvedPath, "root path must equal expanded tilde directory");
  } finally {
    await srv.stop();
    rmSync(resolvedPath, { recursive: true, force: true });
  }
});

test("independent proof: (b) VOICEBOX_WORKSPACE with fresh ~/dir auto-creates and sets boot root", async () => {
  const testDirName = `vb-p0-test-ws-${crypto.randomBytes(4).toString("hex")}`;
  const tildePath = `~/${testDirName}`;
  const resolvedPath = path.join(os.homedir(), testDirName);

  assert.equal(existsSync(resolvedPath), false, "precondition: fresh directory does not exist on disk yet");

  const srv = await startServer({
    env: {
      VOICEBOX_WORKSPACE: tildePath,
      VOICEBOX_SANDBOX_HOMES: undefined,
      VOICEBOX_INSTANCE: "sandbox-homes-test-b",
    },
  });

  try {
    assert.equal(existsSync(resolvedPath), true, "server must auto-create fresh tilde path directory");

    const res = await fetch(`${srv.base}/api/root`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.ok, true);
    assert.equal(body.declared, true);
    assert.equal(body.project, testDirName);
    assert.equal(body.root?.path, resolvedPath);
  } finally {
    await srv.stop();
    rmSync(resolvedPath, { recursive: true, force: true });
  }
});

test("acceptance: setting VOICEBOX_SANDBOX_HOMES to fresh ~/new-directory displays THAT folder in UI without manual selection", { timeout: 60000 }, async () => {
  const testDirName = `vb-p0-acceptance-${crypto.randomBytes(4).toString("hex")}`;
  const tildePath = `~/${testDirName}`;
  const resolvedPath = path.join(os.homedir(), testDirName);

  assert.equal(existsSync(resolvedPath), false, "fresh directory must not exist prior to server start");

  const srv = await startServer({
    env: {
      VOICEBOX_WORKSPACE: undefined,
      VOICEBOX_SANDBOX_HOMES: tildePath,
      VOICEBOX_INSTANCE: "sandbox-homes-ui-test",
    },
  });

  let page;
  try {
    assert.equal(existsSync(resolvedPath), true, "directory must be created on disk");

    page = await launch({ width: 1280, height: 900 });
    await page.goto(`${srv.base}/`);

    // Wait for the room to paint
    await page.waitFor(() => document.getElementById("root-kind") && document.getElementById("send"), {
      label: "the room UI to load",
    });

    // Assert observable UI root display:
    // When a machine folder is active, renderRoot() sets kindEl.textContent = `machine folder · ${projectName}`
    await page.waitFor(
      (expected) => {
        const text = document.getElementById("root-kind")?.textContent ?? "";
        return text.includes("machine folder") && text.includes(expected);
      },
      { label: `the header chip to display 'machine folder · ${testDirName}'`, args: [testDirName] },
    );

    const rootText = await page.evaluate(() => document.getElementById("root-kind")?.textContent ?? "");
    assert.match(rootText, /machine folder/i);
    assert.ok(rootText.includes(testDirName), `root chip must contain '${testDirName}', got: '${rootText}'`);
    assert.ok(!/no folder chosen/i.test(rootText), `root chip must NOT say 'no folder chosen yet', got: '${rootText}'`);
  } finally {
    if (page) await page.close();
    await srv.stop();
    rmSync(resolvedPath, { recursive: true, force: true });
  }
});
