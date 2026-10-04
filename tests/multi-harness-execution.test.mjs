// tests/multi-harness-execution.test.mjs — Discovery and task execution across
// Claude, Pi, Anti-Gravity (antigravity / agy / agentapi), Codex (codex),
// Gemini CLI (gemini), and OpenCode (opencode).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverHarnesses } from "../lib/harness-inventory.mjs";
import { ACP_AGENT } from "../lib/acp-client.mjs";
import {
  createAntigravityExecutor,
  createCodexExecutor,
  createGeminiCliExecutor,
  createOpenCodeExecutor,
  describeCliAdapterInstall,
  locateAntigravity,
  locateCodex,
  locateGeminiCli,
  locateOpenCode,
} from "../lib/cli-harness-executor.mjs";
import {
  buildProjectAwareTaskPrompt,
  diffProjectSnapshots,
  integrateHarnessOutput,
  runWithProjectLoop,
  snapshotProjectWorkspace,
} from "../lib/harness-project-loop.mjs";

function createScratchHarnessBin(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-multi-harness-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const binDir = path.join(rootDir, "bin");
  const workspaceDir = path.join(rootDir, "workspace");
  const adapterDir = path.join(rootDir, "pi-acp");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(adapterDir, "dist"), { recursive: true });

  fs.writeFileSync(
    path.join(adapterDir, "package.json"),
    JSON.stringify({ name: "pi-acp", version: ACP_AGENT.version }),
  );
  fs.writeFileSync(path.join(adapterDir, "dist", "index.js"), "// mock pi-acp entry\n");

  const writeExecutable = (name, scriptBody) => {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
    return file;
  };

  writeExecutable(
    "pi",
    `if [ "$1" = "--version" ]; then echo "${ACP_AGENT.piVersion}"; exit 0; fi\necho "pi-ok:$*"`,
  );
  writeExecutable(
    "claude",
    `if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\necho "claude-ok:$*"`,
  );
  writeExecutable(
    "antigravity",
    `if [ "$1" = "--version" ]; then echo "antigravity 1.4.2"; exit 0; fi\necho "antigravity-ran in $(pwd) args:$*"`,
  );
  writeExecutable(
    "codex",
    `if [ "$1" = "--version" ]; then echo "codex-cli 0.42.0"; exit 0; fi\necho "codex-ran in $(pwd) args:$*"`,
  );
  writeExecutable(
    "gemini",
    `if [ "$1" = "--version" ]; then echo "0.18.1"; exit 0; fi\necho "gemini-ran in $(pwd) args:$*"`,
  );
  writeExecutable(
    "opencode",
    `if [ "$1" = "--version" ]; then echo "0.9.5"; exit 0; fi\necho "opencode-ran in $(pwd) args:$*"`,
  );

  return { rootDir, binDir, workspaceDir, adapterDir, writeExecutable };
}

test("discoverHarnesses discovers antigravity, codex, gemini, pi, and claude in PATH", async (t) => {
  const { binDir, adapterDir } = createScratchHarnessBin(t);
  const report = await discoverHarnesses({
    env: {
      PATH: binDir,
      VOICEBOX_ACP_ADAPTER: adapterDir,
      VOICEBOX_HARNESS_TOOLS: "",
    },
    timeoutMs: 2000,
  });

  assert.equal(report.ok, true);
  const byId = Object.fromEntries(report.entries.map((entry) => [entry.id, entry]));

  assert.equal(byId.pi?.state, "present");
  assert.equal(byId.pi?.version, ACP_AGENT.piVersion);
  assert.equal(byId.pi?.delegation?.ok, true);

  assert.equal(byId.claude?.state, "present");
  assert.equal(byId.claude?.version, "2.1.0");

  assert.equal(byId.antigravity?.state, "present");
  assert.equal(byId.antigravity?.version, "1.4.2");
  assert.equal(byId.antigravity?.delegation?.ok, true);
  assert.equal(byId.antigravity?.delegation?.adapter, "antigravity");

  assert.equal(byId.codex?.state, "present");
  assert.equal(byId.codex?.version, "0.42.0");
  assert.equal(byId.codex?.delegation?.ok, true);
  assert.equal(byId.codex?.delegation?.adapter, "codex-cli");

  assert.equal(byId.gemini?.state, "present");
  assert.equal(byId.gemini?.version, "0.18.1");
  assert.equal(byId.gemini?.delegation?.ok, true);
  assert.equal(byId.gemini?.delegation?.adapter, "gemini-cli");

  assert.equal(byId.opencode?.state, "present");
  assert.equal(byId.opencode?.version, "0.9.5");
  assert.equal(byId.opencode?.delegation?.ok, true);
  assert.equal(byId.opencode?.delegation?.adapter, "opencode");

  assert.ok(!JSON.stringify(report).includes(binDir), "inventory report must never leak raw PATH directories");
});

test("Anti-Gravity executor: check(), refusal when absent, alias resolution (agy / agentapi), and run() in workspace root", async (t) => {
  const { binDir, workspaceDir, rootDir } = createScratchHarnessBin(t);
  const emptyDir = path.join(rootDir, "empty-bin");
  fs.mkdirSync(emptyDir, { recursive: true });

  // 1. Refuses with adapter-unavailable when absent from PATH
  const absentExecutor = createAntigravityExecutor({ env: { PATH: emptyDir } });
  const absentCheck = absentExecutor.check();
  assert.equal(absentCheck.ok, false);
  assert.equal(absentCheck.refused, "adapter-unavailable");
  assert.match(absentCheck.why, /Anti-Gravity CLI \(antigravity, agy, or agentapi\) was not found in PATH/);

  await assert.rejects(
    () => absentExecutor.run({ task: "do work", root: { path: workspaceDir } }),
    (err) => err.refused === "adapter-unavailable",
  );

  // 2. Passes check() and executes task in target workspace root when present
  const executor = createAntigravityExecutor({ env: { PATH: binDir } });
  const check = executor.check();
  assert.equal(check.ok, true);
  assert.equal(check.harness, "antigravity");
  assert.equal(check.adapter, "antigravity");
  assert.equal(check.installedVersion, "1.4.2");
  assert.ok(check.binary.endsWith("/antigravity"));

  const updates = [];
  const result = await executor.run({
    task: { prompt: "implement feature X" },
    root: () => ({ path: workspaceDir }),
    onUpdate: (u) => updates.push(u),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.match(result.output, /antigravity-ran in .*workspace args:--prompt implement feature X/);
  assert.equal(result.summary, result.output);
  assert.ok(updates.length >= 1);

  // 3. Resolves 'agentapi' alias when 'antigravity' is absent
  const agentApiDir = path.join(rootDir, "agentapi-bin");
  fs.mkdirSync(agentApiDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentApiDir, "agentapi"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "agentapi 2.0.1"; exit 0; fi\necho "agentapi-ran:$*"\n`,
    { mode: 0o755 },
  );
  const locatedApi = locateAntigravity({ env: { PATH: agentApiDir } });
  assert.equal(locatedApi.ok, true);
  assert.equal(locatedApi.command, "agentapi");

  const apiExecutor = createAntigravityExecutor({ env: { PATH: agentApiDir } });
  const apiRes = await apiExecutor.run({ input: { task: "delegate via agentapi" }, root: { path: workspaceDir } });
  assert.equal(apiRes.ok, true);
  assert.match(apiRes.output, /agentapi-ran:run delegate via agentapi/);
});

test("Codex, Gemini CLI, and OpenCode executors: check(), refusal when absent, and run() in workspace root", async (t) => {
  const { binDir, workspaceDir, rootDir } = createScratchHarnessBin(t);
  const emptyDir = path.join(rootDir, "empty-bin-2");
  fs.mkdirSync(emptyDir, { recursive: true });

  // Codex CLI
  const codexAbsent = createCodexExecutor({ env: { PATH: emptyDir } });
  assert.equal(codexAbsent.check().ok, false);
  assert.equal(codexAbsent.check().refused, "adapter-unavailable");
  assert.match(codexAbsent.check().why, /Codex CLI \(codex\) was not found in PATH/);

  const codexUpdates = [];
  const codexExec = createCodexExecutor({ env: { PATH: binDir } });
  const codexCheck = codexExec.check();
  assert.equal(codexCheck.ok, true);
  assert.equal(codexCheck.harness, "codex");
  assert.equal(codexCheck.adapter, "codex-cli");
  assert.equal(codexCheck.installedVersion, "0.42.0");

  const codexResult = await codexExec.run({
    input: { task: "audit repo" },
    root: { path: workspaceDir },
    onUpdate: (u) => codexUpdates.push(u),
  });
  assert.equal(codexResult.ok, true);
  assert.equal(codexResult.status, "completed");
  assert.match(codexResult.output, /codex-ran in .*workspace args:exec --skip-git-repo-check audit repo/);
  assert.ok(codexUpdates.some((u) => u.status === "running"));

  // Gemini CLI
  const geminiAbsent = createGeminiCliExecutor({ env: { PATH: emptyDir } });
  assert.equal(geminiAbsent.check().ok, false);
  assert.equal(geminiAbsent.check().refused, "adapter-unavailable");
  assert.match(geminiAbsent.check().why, /Gemini CLI \(gemini\) was not found in PATH/);

  const geminiExec = createGeminiCliExecutor({ env: { PATH: binDir } });
  const geminiCheck = geminiExec.check();
  assert.equal(geminiCheck.ok, true);
  assert.equal(geminiCheck.harness, "gemini");
  assert.equal(geminiCheck.adapter, "gemini-cli");
  assert.equal(geminiCheck.installedVersion, "0.18.1");

  const geminiResult = await geminiExec.run({
    task: "summarize changes",
    root: { path: workspaceDir },
  });
  assert.equal(geminiResult.ok, true);
  assert.equal(geminiResult.status, "completed");
  assert.match(geminiResult.output, /gemini-ran in .*workspace args:-p summarize changes/);

  // OpenCode CLI
  const opencodeAbsent = createOpenCodeExecutor({ env: { PATH: emptyDir } });
  assert.equal(opencodeAbsent.check().ok, false);
  assert.equal(opencodeAbsent.check().refused, "adapter-unavailable");

  const opencodeExec = createOpenCodeExecutor({ env: { PATH: binDir } });
  const opencodeCheck = opencodeExec.check();
  assert.equal(opencodeCheck.ok, true);
  assert.equal(opencodeCheck.harness, "opencode");
  assert.equal(opencodeCheck.adapter, "opencode");

  const opencodeResult = await opencodeExec.run({
    task: "fix lint",
    root: { path: workspaceDir },
  });
  assert.equal(opencodeResult.ok, true);
  assert.equal(opencodeResult.status, "completed");
  assert.match(opencodeResult.output, /opencode-ran in .*workspace args:run fix lint/);

  // describeCliAdapterInstall helper
  assert.equal(describeCliAdapterInstall("antigravity", { env: { PATH: binDir } }).ok, true);
  assert.equal(describeCliAdapterInstall("codex-cli", { env: { PATH: binDir } }).ok, true);
  assert.equal(describeCliAdapterInstall("gemini-cli", { env: { PATH: binDir } }).ok, true);
  assert.equal(describeCliAdapterInstall("opencode", { env: { PATH: binDir } }).ok, true);
  assert.equal(describeCliAdapterInstall("unknown-adapter", { env: { PATH: binDir } }).refused, "adapter-not-configured");
  assert.equal(locateCodex({ env: { PATH: binDir } }).ok, true);
  assert.equal(locateGeminiCli({ env: { PATH: binDir } }).ok, true);
  assert.equal(locateOpenCode({ env: { PATH: binDir } }).ok, true);
});

test("Bidirectional harness-project live loop: workspace snapshot, prompt enrichment, file diff detection, and report integration", async (t) => {
  const { binDir, workspaceDir, writeExecutable } = createScratchHarnessBin(t);

  // Seed workspace with project instructions and an initial source file
  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), "# Project Rules\nAlways keep modules small and tested.\n");
  fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "src", "index.js"), "export const version = 1;\n");
  fs.writeFileSync(path.join(workspaceDir, "obsolete.txt"), "remove me\n");

  const beforeSnap = snapshotProjectWorkspace(workspaceDir);
  assert.equal(beforeSnap.ok, true);
  assert.ok(beforeSnap.fileList.includes("AGENTS.md"));
  assert.ok(beforeSnap.fileList.includes("src/index.js"));
  assert.match(beforeSnap.instructionsSnippet, /Always keep modules small/);

  // Verify project-aware prompt enrichment includes workspace files & instructions
  const enrichedPrompt = buildProjectAwareTaskPrompt({
    task: "Analyze src/index.js and bump version",
    rootPath: workspaceDir,
    subDir: "src",
    includeProjectContext: true,
  });
  assert.match(enrichedPrompt, /\[Project Workspace Context\]/);
  assert.match(enrichedPrompt, /Active Sub-directory: src/);
  assert.match(enrichedPrompt, /AGENTS\.md/);
  assert.match(enrichedPrompt, /Always keep modules small/);
  assert.match(enrichedPrompt, /Analyze src\/index\.js and bump version/);

  // Configure mock codex binary to mutate workspace files (create, modify, delete) during execution
  writeExecutable(
    "codex",
    [
      `if [ "$1" = "--version" ]; then echo "codex-cli 0.42.0"; exit 0; fi`,
      `echo "export const version = 2;" > src/index.js`,
      `echo "# Architecture Findings" > analysis.md`,
      `/bin/rm -f obsolete.txt`,
      `echo "Completed analysis and updated version to 2."`,
    ].join("\n"),
  );

  const integrationEvents = [];
  const codexExec = createCodexExecutor({ env: { PATH: binDir } });
  const runRes = await codexExec.run({
    input: { task: "Upgrade version and write analysis" },
    root: { path: workspaceDir },
    enrichProjectContext: true,
    onProjectIntegration: (ev) => integrationEvents.push(ev),
  });

  assert.equal(runRes.ok, true);
  assert.deepEqual(runRes.createdFiles, ["analysis.md"]);
  assert.deepEqual(runRes.modifiedFiles, ["src/index.js"]);
  assert.deepEqual(runRes.deletedFiles, ["obsolete.txt"]);
  assert.deepEqual(runRes.changedFiles, ["analysis.md", "obsolete.txt", "src/index.js"]);
  assert.equal(integrationEvents.length, 1);
  assert.match(integrationEvents[0].summary, /created 1 \(analysis\.md\)/);
  assert.match(integrationEvents[0].summary, /modified 1 \(src\/index\.js\)/);
  assert.match(integrationEvents[0].summary, /deleted 1 \(obsolete\.txt\)/);

  // Verify runWithProjectLoop wrapper and persisted report artifact
  const wrapped = runWithProjectLoop(
    {
      check: () => ({ ok: true }),
      run: async ({ root }) => {
        fs.writeFileSync(path.join(root.path, "src", "feature.js"), "export const ok = true;\n");
        return "Added src/feature.js with live project integration.";
      },
    },
    { harness: "pi-acp", saveReport: true, reportPath: ".voicebox/last-analysis.md" },
  );

  const wrappedRes = await wrapped.run({
    input: { task: "Create feature module" },
    root: { path: workspaceDir },
  });
  assert.equal(wrappedRes.ok, true);
  assert.ok(wrappedRes.createdFiles.includes("src/feature.js"));
  assert.ok(wrappedRes.projectIntegration.savedReportFile);
  assert.ok(fs.existsSync(wrappedRes.projectIntegration.savedReportFile));
  const savedReportText = fs.readFileSync(wrappedRes.projectIntegration.savedReportFile, "utf8");
  assert.match(savedReportText, /Harness Analysis Report \(pi-acp\)/);
  assert.match(savedReportText, /\*\*Created\*\*: src\/feature\.js/);

  // Direct diffProjectSnapshots & integrateHarnessOutput verification
  const afterSnap = snapshotProjectWorkspace(workspaceDir);
  const fullDiff = diffProjectSnapshots(beforeSnap, afterSnap);
  assert.ok(fullDiff.createdFiles.includes("analysis.md"));
  assert.ok(fullDiff.createdFiles.includes("src/feature.js"));
  assert.ok(fullDiff.modifiedFiles.includes("src/index.js"));
  assert.ok(fullDiff.deletedFiles.includes("obsolete.txt"));

  const directIntegration = integrateHarnessOutput(workspaceDir, {
    harness: "gemini",
    prompt: "Direct check",
    output: "All checks green",
    beforeSnapshot: beforeSnap,
  });
  assert.equal(directIntegration.ok, true);
  assert.ok(directIntegration.changedFiles.includes("src/feature.js"));
});

