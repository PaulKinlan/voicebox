// lib/harness-project-loop.mjs — Bidirectional integration loop between agent
// harnesses (Claude Code, Pi, Anti-Gravity, Codex, Gemini CLI, OpenCode) and
// the active project workspace (voicebox-beads-vv7i, voicebox-beads-b9oz).

import fs from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".beads",
  ".audit",
  ".voicebox",
  ".cache",
  ".next",
  "coverage",
]);

function hashBufferFast(buf) {
  let hash = 2166136261;
  const len = Math.min(buf.length, 65536);
  for (let i = 0; i < len; i++) {
    hash ^= buf[i];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function normalizeRootPath(root) {
  if (!root) return "";
  if (typeof root === "function") {
    try {
      return normalizeRootPath(root());
    } catch {
      return "";
    }
  }
  if (typeof root === "string") return root.trim();
  if (typeof root === "object") {
    if (typeof root.path === "string") return root.path.trim();
    if (root.root && typeof root.root.path === "string") return root.root.path.trim();
  }
  return "";
}

/**
 * Capture a fast, bounded snapshot of files and instructions in the project workspace.
 */
export function snapshotProjectWorkspace(rootInput, { maxFiles = 200 } = {}) {
  const rootPath = normalizeRootPath(rootInput);
  if (!rootPath || !fs.existsSync(rootPath)) {
    return {
      ok: false,
      rootPath: rootPath || "",
      files: {},
      fileList: [],
      instructionsSnippet: "",
    };
  }

  const files = {};
  let count = 0;

  function walk(currentDir, relPrefix) {
    if (count >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (count >= maxFiles) break;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const absPath = path.join(currentDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(absPath);
          let hash = "";
          if (stat.size <= 65536) {
            const buf = fs.readFileSync(absPath);
            hash = hashBufferFast(buf);
          }
          files[relPath] = {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            hash,
          };
          count++;
        } catch {
          // Ignore transient files removed mid-scan
        }
      }
    }
  }

  walk(rootPath, "");

  let instructionsSnippet = "";
  for (const candidate of ["AGENTS.md", "AGENT.md", "README.md"]) {
    const candidatePath = path.join(rootPath, candidate);
    try {
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        const content = fs.readFileSync(candidatePath, "utf8").trim();
        if (content) {
          instructionsSnippet = content.slice(0, 2000);
          break;
        }
      }
    } catch {
      // Ignore unreadable instruction files
    }
  }

  return {
    ok: true,
    rootPath,
    files,
    fileList: Object.keys(files).sort(),
    instructionsSnippet,
  };
}

/**
 * Enrich a task prompt with workspace structure and project instructions so
 * delegated harnesses operate with immediate awareness of the project context.
 */
export function buildProjectAwareTaskPrompt({
  task,
  rootPath: rawRoot,
  subDir = "",
  includeProjectContext = true,
} = {}) {
  let baseTask = "";
  if (typeof task === "string") {
    baseTask = task;
  } else if (task && typeof task === "object") {
    baseTask = String(task.prompt ?? task.task ?? "");
  } else if (task != null) {
    baseTask = String(task);
  }

  const rootPath = normalizeRootPath(rawRoot);
  if (!includeProjectContext || !rootPath || !fs.existsSync(rootPath)) {
    return baseTask;
  }

  const snapshot = snapshotProjectWorkspace(rootPath, { maxFiles: 60 });
  const visibleFiles = snapshot.fileList.slice(0, 25);
  const lines = [
    "[Project Workspace Context]",
    `Workspace Root: ${rootPath}`,
  ];
  if (subDir) {
    lines.push(`Active Sub-directory: ${subDir}`);
  }
  if (visibleFiles.length > 0) {
    lines.push(`Project Files (${snapshot.fileList.length} tracked): ${visibleFiles.join(", ")}`);
  }
  if (snapshot.instructionsSnippet) {
    lines.push(`Project Conventions:\n${snapshot.instructionsSnippet.slice(0, 600)}`);
  }
  lines.push("[Task Instructions]", baseTask);
  return lines.join("\n\n");
}

function unwrapFilesMap(snapshotOrMap) {
  if (!snapshotOrMap || typeof snapshotOrMap !== "object") return {};
  if (snapshotOrMap.files && typeof snapshotOrMap.files === "object") {
    return snapshotOrMap.files;
  }
  return snapshotOrMap;
}

/**
 * Compute created, modified, deleted, and changed files between two workspace snapshots.
 */
export function diffProjectSnapshots(beforeInput = {}, afterInput = {}) {
  const beforeMap = unwrapFilesMap(beforeInput);
  const afterMap = unwrapFilesMap(afterInput);

  const createdFiles = [];
  const modifiedFiles = [];
  const deletedFiles = [];

  for (const [relPath, afterMeta] of Object.entries(afterMap)) {
    const beforeMeta = beforeMap[relPath];
    if (!beforeMeta) {
      createdFiles.push(relPath);
    } else {
      const sizeChanged = beforeMeta.size !== afterMeta.size;
      const hashChanged =
        Boolean(beforeMeta.hash && afterMeta.hash) && beforeMeta.hash !== afterMeta.hash;
      const mtimeChanged =
        !beforeMeta.hash && !afterMeta.hash && beforeMeta.mtimeMs !== afterMeta.mtimeMs;
      if (sizeChanged || hashChanged || mtimeChanged) {
        modifiedFiles.push(relPath);
      }
    }
  }

  for (const relPath of Object.keys(beforeMap)) {
    if (!(relPath in afterMap)) {
      deletedFiles.push(relPath);
    }
  }

  createdFiles.sort();
  modifiedFiles.sort();
  deletedFiles.sort();
  const changedFiles = Array.from(
    new Set([...createdFiles, ...modifiedFiles, ...deletedFiles]),
  ).sort();

  return {
    createdFiles,
    modifiedFiles,
    deletedFiles,
    changedFiles,
  };
}

/**
 * Summarize harness analysis output together with observed workspace mutations.
 */
export function extractAnalysisSummary(output = "", diff = {}) {
  const cleanOutput = String(output ?? "").trim();
  const firstLine = cleanOutput.split(/\r?\n/).find((l) => l.trim()) || "";
  const created = Array.isArray(diff?.createdFiles) ? diff.createdFiles : [];
  const modified = Array.isArray(diff?.modifiedFiles) ? diff.modifiedFiles : [];
  const deleted = Array.isArray(diff?.deletedFiles) ? diff.deletedFiles : [];
  const changed = Array.isArray(diff?.changedFiles) ? diff.changedFiles : [];

  const fileParts = [];
  if (created.length > 0) fileParts.push(`created ${created.length} (${created.slice(0, 3).join(", ")})`);
  if (modified.length > 0) fileParts.push(`modified ${modified.length} (${modified.slice(0, 3).join(", ")})`);
  if (deleted.length > 0) fileParts.push(`deleted ${deleted.length} (${deleted.slice(0, 3).join(", ")})`);
  const mutationNote =
    changed.length > 0
      ? `Workspace changes: ${fileParts.join("; ")}`
      : "No workspace files changed";

  if (!firstLine) return mutationNote;
  return `${firstLine.slice(0, 240)} — ${mutationNote}`;
}

/**
 * Observe post-run workspace state, compute file diffs, optionally persist a
 * Markdown report in the project, and return a structured integration record.
 */
export function integrateHarnessOutput(
  rootInput,
  {
    harness = "unknown",
    taskId = null,
    prompt = "",
    output = "",
    beforeSnapshot = null,
    saveReport = false,
    reportPath = null,
  } = {},
) {
  const rootPath = normalizeRootPath(rootInput);
  const afterSnapshot = rootPath
    ? snapshotProjectWorkspace(rootPath)
    : { ok: false, rootPath: "", files: {}, fileList: [] };
  const diff = beforeSnapshot
    ? diffProjectSnapshots(beforeSnapshot, afterSnapshot)
    : { createdFiles: [], modifiedFiles: [], deletedFiles: [], changedFiles: [] };

  let reportFile = null;
  if (saveReport && rootPath && fs.existsSync(rootPath)) {
    const targetReport = reportPath
      ? path.isAbsolute(reportPath)
        ? reportPath
        : path.join(rootPath, reportPath)
      : path.join(
          rootPath,
          ".voicebox",
          "harness-reports",
          `${taskId || `${harness}-latest`}.md`,
        );
    try {
      fs.mkdirSync(path.dirname(targetReport), { recursive: true });
      const reportBody = [
        `# Harness Analysis Report (${harness})`,
        "",
        `- **Task**: ${String(prompt || "").trim() || "Ad-hoc task"}`,
        `- **Changed Files (${diff.changedFiles.length})**: ${diff.changedFiles.join(", ") || "none"}`,
        ...(diff.createdFiles.length > 0 ? [`- **Created**: ${diff.createdFiles.join(", ")}`] : []),
        ...(diff.modifiedFiles.length > 0 ? [`- **Modified**: ${diff.modifiedFiles.join(", ")}`] : []),
        ...(diff.deletedFiles.length > 0 ? [`- **Deleted**: ${diff.deletedFiles.join(", ")}`] : []),
        "",
        "## Output",
        "",
        String(output || "").trim() || "(no output)",
        "",
      ].join("\n");
      fs.writeFileSync(targetReport, reportBody, "utf8");
      reportFile = targetReport;
    } catch {
      reportFile = null;
    }
  }

  return {
    ok: true,
    harness,
    taskId,
    rootPath,
    createdFiles: diff.createdFiles,
    modifiedFiles: diff.modifiedFiles,
    deletedFiles: diff.deletedFiles,
    changedFiles: diff.changedFiles,
    reportFile,
    savedReportFile: reportFile,
    summary: extractAnalysisSummary(output, diff),
  };
}

/**
 * Wrap any harness executor ({ check, run }) in a live project integration loop
 * that snapshots the workspace before execution, streams updates, and integrates
 * file mutations and analysis summaries back into the project result.
 */
export function runWithProjectLoop(
  executor,
  {
    saveReport = false,
    reportPath = null,
    enrichPrompt = false,
    harness: defaultHarness = null,
  } = {},
) {
  if (!executor || typeof executor.run !== "function") {
    throw new Error("runWithProjectLoop requires an executor with a run() method");
  }

  const check =
    typeof executor.check === "function"
      ? (args = {}) => executor.check(args)
      : () => ({ ok: true });

  async function run(args = {}) {
    const rootPath = normalizeRootPath(args.root) || process.cwd();
    const harnessName =
      args.harness ??
      args.agentConfig?.harness ??
      args.input?.harness ??
      args.input?.agent ??
      defaultHarness ??
      "agent";

    const beforeSnapshot = snapshotProjectWorkspace(rootPath);
    const shouldEnrich = Boolean(
      enrichPrompt || args.enrichPrompt || args.includeProjectContext,
    );

    const rawTask = args.task ?? args.input?.task ?? args.input?.prompt ?? "";
    const effectiveTask = shouldEnrich
      ? buildProjectAwareTaskPrompt({
          task: rawTask,
          rootPath,
          includeProjectContext: true,
        })
      : rawTask;

    const effectiveArgs = { ...args };
    if (shouldEnrich) {
      if (typeof args.task === "string") {
        effectiveArgs.task = effectiveTask;
      } else if (args.task && typeof args.task === "object") {
        effectiveArgs.task = { ...args.task, prompt: effectiveTask };
      }
      if (args.input && typeof args.input === "object") {
        effectiveArgs.input = { ...args.input, task: effectiveTask };
      }
    }

    const rawResult = await executor.run(effectiveArgs);
    const outputText =
      typeof rawResult === "string"
        ? rawResult
        : String(rawResult?.output ?? rawResult?.answer ?? rawResult ?? "");

    const projectIntegration = integrateHarnessOutput(rootPath, {
      harness: harnessName,
      taskId: args.taskId ?? null,
      prompt: typeof rawTask === "string" ? rawTask : String(rawTask?.prompt ?? rawTask?.task ?? ""),
      output: outputText,
      beforeSnapshot,
      saveReport: Boolean(saveReport || args.saveReport),
      reportPath: args.reportPath ?? reportPath ?? null,
    });

    if (typeof args.onProjectIntegration === "function") {
      args.onProjectIntegration(projectIntegration);
    }
    if (typeof args.onUpdate === "function" && projectIntegration.changedFiles.length > 0) {
      args.onUpdate({
        status: "completed",
        progress: projectIntegration.summary,
        changedFiles: projectIntegration.changedFiles,
        projectIntegration,
      });
    }

    const baseObj =
      rawResult && typeof rawResult === "object"
        ? { ...rawResult }
        : {
            ok: true,
            status: "completed",
            output: outputText,
            summary: outputText.slice(0, 400),
            answer: outputText,
          };

    return {
      ...baseObj,
      changedFiles: projectIntegration.changedFiles,
      createdFiles: projectIntegration.createdFiles,
      modifiedFiles: projectIntegration.modifiedFiles,
      deletedFiles: projectIntegration.deletedFiles,
      projectIntegration,
      toString() {
        return outputText;
      },
    };
  }

  return Object.freeze({ check, run });
}
