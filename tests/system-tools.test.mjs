import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  discoverSystemTools,
  parseCommandLine,
  resolveSystemBinary,
  runSystemCommand,
} from "../lib/system-tools.mjs";

describe("system-tools: CLI discovery and execution", () => {
  const tempDirs = [];

  function makeScratchDir(prefix = "voicebox-sys-tools-") {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function writeExecutable(dir, name, body) {
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    writeFileSync(filePath, body, "utf8");
    chmodSync(filePath, 0o755);
    return filePath;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("discoverSystemTools discovers system binaries (node, git), mock issue trackers on PATH, and project scripts", () => {
    const projectRoot = makeScratchDir("vb-proj-");
    const customBinDir = makeScratchDir("vb-bin-");

    // Create mock issue tracker binaries in customBinDir
    const bdPath = writeExecutable(
      customBinDir,
      "bd",
      "#!/bin/sh\necho 'bd mock'\n",
    );
    const ghPath = writeExecutable(
      customBinDir,
      "gh",
      "#!/bin/sh\necho 'gh mock'\n",
    );
    const customTrackerPath = writeExecutable(
      customBinDir,
      "custom-tracker",
      "#!/bin/sh\necho 'custom-tracker mock'\n",
    );

    // Create package.json with scripts and a scripts/ helper in projectRoot
    writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({
        name: "scratch-project",
        scripts: {
          test: "node --test",
          lint: "node scripts/check.mjs",
        },
      }),
      "utf8",
    );
    writeExecutable(
      path.join(projectRoot, "scripts"),
      "check.mjs",
      "#!/usr/bin/env node\nconsole.log('ok');\n",
    );

    const env = {
      ...process.env,
      PATH: `${customBinDir}${path.delimiter}${process.env.PATH || ""}`,
    };

    const discovered = discoverSystemTools({ env, cwd: projectRoot });
    assert.equal(discovered.ok, true);
    assert.ok(Array.isArray(discovered.available));
    assert.ok(Array.isArray(discovered.projectScripts));
    assert.ok(Array.isArray(discovered.pathDirs));

    const byName = new Map(discovered.available.map((item) => [item.name, item]));

    // Built-in system tools
    assert.ok(byName.has("node"), "expected 'node' to be discovered");
    assert.equal(byName.get("node").category, "runtime");
    assert.ok(byName.has("git"), "expected 'git' to be discovered");
    assert.equal(byName.get("git").category, "vcs");

    // Mock issue trackers in temporary PATH directory
    assert.ok(byName.has("bd"), "expected 'bd' to be discovered");
    assert.equal(byName.get("bd").category, "issue-tracker");
    assert.equal(byName.get("bd").path, bdPath);

    assert.ok(byName.has("gh"), "expected 'gh' to be discovered");
    assert.equal(byName.get("gh").category, "issue-tracker");
    assert.equal(byName.get("gh").path, ghPath);

    assert.ok(byName.has("custom-tracker"), "expected 'custom-tracker' to be discovered");
    assert.equal(byName.get("custom-tracker").category, "issue-tracker");
    assert.equal(byName.get("custom-tracker").path, customTrackerPath);

    // Project scripts from package.json and scripts/
    const scriptNames = discovered.projectScripts.map((s) => s.name);
    assert.ok(scriptNames.includes("test"));
    assert.ok(scriptNames.includes("lint"));
    assert.ok(scriptNames.includes("check.mjs"));
  });

  it("parseCommandLine splits quoted arguments cleanly and refuses unquoted shell operators", () => {
    const parsed = parseCommandLine('my-tracker create --title "Fix audio worklet" --priority 1');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.executable, "my-tracker");
    assert.deepEqual(parsed.args, ["create", "--title", "Fix audio worklet", "--priority", "1"]);

    // Semicolons inside quotes are safe literal arguments, not shell operators
    const quotedCode = parseCommandLine('node -e "console.log(1); console.log(2)"');
    assert.equal(quotedCode.ok, true);
    assert.equal(quotedCode.executable, "node");
    assert.deepEqual(quotedCode.args, ["-e", "console.log(1); console.log(2)"]);

    // Unquoted shell operators are refused
    for (const unsafe of [
      "git status; rm -rf /",
      "bd list | cat",
      "bd ready && echo pwned",
      "echo $(whoami)",
      "echo `id`",
    ]) {
      const res = parseCommandLine(unsafe);
      assert.equal(res.ok, false, `expected '${unsafe}' to be refused`);
      assert.equal(res.refused, "shell-operators-not-allowed");
    }
  });

  it("runSystemCommand executes installed CLI tools and custom issue trackers inside rootPath", async () => {
    const rootPath = makeScratchDir("vb-exec-root-");
    const customBinDir = makeScratchDir("vb-exec-bin-");

    // Initialize a minimal git repo in rootPath
    const initRes = await runSystemCommand(rootPath, {
      command: "git",
      args: ["init"],
    });
    assert.equal(initRes.ok, true);
    assert.equal(initRes.exitCode, 0);

    writeFileSync(path.join(rootPath, "README.md"), "# Scratch Repo\n", "utf8");

    // Run `git status --short` via single command string
    const statusRes = await runSystemCommand(rootPath, {
      command: "git status --short",
    });
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.command, "git");
    assert.deepEqual(statusRes.args, ["status", "--short"]);
    assert.match(statusRes.stdout, /\?\? README\.md/);

    // Run `node -e ...`
    const nodeRes = await runSystemCommand(rootPath, {
      command: "node",
      args: ["-e", "process.stdout.write(JSON.stringify({ cwd: process.cwd(), ci: process.env.CI }))"],
    });
    assert.equal(nodeRes.ok, true);
    const payload = JSON.parse(nodeRes.stdout);
    assert.equal(payload.ci, "1");
    assert.ok(payload.cwd.endsWith(path.basename(rootPath)));

    // Create a custom issue tracker CLI in customBinDir and run `my-tracker list --open`
    writeExecutable(
      customBinDir,
      "my-tracker",
      `#!/usr/bin/env node
const args = process.argv.slice(2);
console.log(JSON.stringify({
  tool: "my-tracker",
  args,
  issues: [{ id: "ISS-101", title: "Generalize system CLI execution", status: "open" }]
}));
`,
    );

    const env = {
      ...process.env,
      PATH: `${customBinDir}${path.delimiter}${process.env.PATH || ""}`,
    };

    const trackerRes = await runSystemCommand(rootPath, {
      command: "my-tracker list --open",
      env,
    });
    assert.equal(trackerRes.ok, true);
    assert.equal(trackerRes.command, "my-tracker");
    assert.deepEqual(trackerRes.args, ["list", "--open"]);
    const trackerData = JSON.parse(trackerRes.stdout);
    assert.equal(trackerData.tool, "my-tracker");
    assert.deepEqual(trackerData.args, ["list", "--open"]);
    assert.equal(trackerData.issues[0].id, "ISS-101");
  });

  it("runSystemCommand strips hook Git plumbing while preserving the supplied environment", async () => {
    const rootPath = makeScratchDir("vb-git-env-root-");
    const other = makeScratchDir("vb-git-env-other-");
    const env = { ...process.env, GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other,
      GIT_INDEX_FILE: path.join(other, "index"), CI: "fixture" };
    const init = await runSystemCommand(rootPath, { command: "git init", env });
    assert.equal(init.ok, true, init.stderr);
    const status = await runSystemCommand(rootPath, { command: "git rev-parse --show-toplevel", env });
    assert.equal(status.stdout, rootPath, "git answers about the declared root, not the hook repository");
    const child = await runSystemCommand(rootPath, { command: "node", env,
      args: ["-e", "console.log(JSON.stringify({ ci: process.env.CI, dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE }))"] });
    assert.equal(child.ok, true);
    assert.deepEqual(JSON.parse(child.stdout), { ci: "fixture" }, "descendant git cannot inherit hook plumbing either");
    assert.equal(env.GIT_DIR, path.join(other, ".git"), "the caller's environment is not mutated");
  });

  it("runSystemCommand refuses missing rootPath, missing tools, and commands exceeding timeoutMs", async () => {
    const rootPath = makeScratchDir("vb-refusal-root-");

    // 1. Missing or non-existent rootPath -> root-not-declared
    const noRootRes = await runSystemCommand("", { command: "git status" });
    assert.equal(noRootRes.ok, false);
    assert.equal(noRootRes.refused, "root-not-declared");

    const missingDirRes = await runSystemCommand(path.join(rootPath, "does-not-exist"), {
      command: "git status",
    });
    assert.equal(missingDirRes.ok, false);
    assert.equal(missingDirRes.refused, "root-not-declared");

    // 2. Non-existent tool -> tool-not-installed
    const notInstalledRes = await runSystemCommand(rootPath, {
      command: "nonexistent-tracker-cli-9999",
      args: ["list"],
    });
    assert.equal(notInstalledRes.ok, false);
    assert.equal(notInstalledRes.refused, "tool-not-installed");
    assert.match(notInstalledRes.why, /nonexistent-tracker-cli-9999/);

    // 3. Command exceeding timeoutMs -> command-timed-out
    const slowRes = await runSystemCommand(rootPath, {
      command: "node",
      args: ["-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 150,
    });
    assert.equal(slowRes.ok, false);
    assert.equal(slowRes.refused, "command-timed-out");
    assert.equal(slowRes.command, "node");
    assert.ok(slowRes.durationMs < 5000, `expected fast timeout termination, got ${slowRes.durationMs}ms`);

    // 4. Path traversal in executable -> invalid-command
    const traversalRes = await runSystemCommand(rootPath, {
      command: "../outside-script.sh",
    });
    assert.equal(traversalRes.ok, false);
    assert.equal(traversalRes.refused, "invalid-command");
    assert.equal(resolveSystemBinary("../outside-script.sh", { cwd: rootPath }), null);
  });
});
