// lib/cli-harness-executor.mjs — Task executors for CLI and API agent harnesses
// (Anti-Gravity, Codex CLI, Gemini CLI, OpenCode).
//
// Matches the check() and run() contract of createPiAcpExecutor (lib/pi-acp.mjs)
// and createClaudeAcpExecutor (lib/claude-acp.mjs): synchronous preflight check()
// with named refusals, bounded execution in the declared root directory, streaming
// progress updates, and AbortSignal cancellation.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  snapshotProjectWorkspace,
  buildProjectAwareTaskPrompt,
  integrateHarnessOutput,
} from "./harness-project-loop.mjs";
import { redactSecrets } from "./redact.mjs";
import { DEFAULT_TASK_BUDGET_MS } from "../core/tasks.ts";

/**
 * The default whole-task budget for a CLI harness (voicebox-beads-cwx5.9). It was 120s, which killed any
 * real coding task; a CLI run is now bounded by this budget AND by silence (below), so a working process
 * gets its time and a hung one is still stopped early.
 */
export const CLI_EXECUTOR_TIMEOUT_CEILING_MS = DEFAULT_TASK_BUDGET_MS;
/** How long a CLI harness may print nothing at all before it is judged stuck. */
export const CLI_EXECUTOR_SILENCE_MS = 300000;
/** The bound on the ANSWER kept from a run. Output past it is still streamed to the console as it arrives. */
export const CLI_EXECUTOR_MAX_OUTPUT_BYTES = 65536;
/** Prefixed to an answer whose beginning was dropped to stay inside the output bound. */
export const CLI_OUTPUT_TRUNCATED_NOTE = "[earlier output dropped: only the end of a long run is kept]\n";

/**
 * Keep the END of a stream within `maxBytes` of UTF-8: a long run's result is at the bottom, and the
 * whole stream has already been shown to the person line by line. Cuts on a character boundary.
 */
export function keepTail(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, dropped: false };
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1; // not inside a multi-byte character
  return { text: buf.subarray(start).toString("utf8"), dropped: true };
}

const error = (refused, why) => Object.assign(new Error(why), { refused });

function isExecutableFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchPathDirs(commands, pathString, extraDirs = []) {
  const dirs = [
    ...String(pathString ?? "").split(path.delimiter).filter((d) => d && path.isAbsolute(d)),
    ...extraDirs.filter((d) => d && path.isAbsolute(d)),
  ];
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const cmd of commands) {
      const candidate = path.join(dir, cmd);
      if (isExecutableFile(candidate)) {
        return { binary: candidate, command: cmd };
      }
    }
  }
  return null;
}

function probeVersionSync(binary, versionPattern, env) {
  try {
    const res = spawnSync(binary, ["--version"], {
      env,
      timeout: 1500,
      maxBuffer: 8192,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.error || res.status !== 0) return null;
    const text = String(res.stdout ?? "").trim();
    if (!versionPattern) return text || null;
    const match = text.match(versionPattern);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function hasSystemPath(pathString) {
  const entries = String(pathString ?? "").split(path.delimiter);
  return entries.includes("/usr/bin") || entries.includes("/bin");
}

function defaultExtraDirs(pathString, includeJetski = false) {
  if (!hasSystemPath(pathString)) return [];
  return [
    ...(includeJetski ? [path.join(os.homedir(), ".gemini", "jetski")] : []),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "go", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

export function locateAntigravity({ env = process.env, cliPath } = {}) {
  const explicit = cliPath ?? env?.VOICEBOX_ANTIGRAVITY_CLI ?? "";
  if (explicit) {
    if (isExecutableFile(explicit)) {
      return {
        ok: true,
        binary: explicit,
        command: path.basename(explicit),
        via: "explicit",
      };
    }
    return {
      ok: false,
      refused: "adapter-unavailable",
      why: `VOICEBOX_ANTIGRAVITY_CLI points at ${explicit}, which is not an executable file.`,
    };
  }
  const rawPath = env?.PATH ?? "";
  const found = searchPathDirs(["antigravity", "agy", "agentapi"], rawPath, defaultExtraDirs(rawPath, true));
  if (!found) {
    return {
      ok: false,
      refused: "adapter-unavailable",
      why: "Anti-Gravity CLI (antigravity, agy, or agentapi) was not found in PATH — install Anti-Gravity or set VOICEBOX_ANTIGRAVITY_CLI.",
    };
  }
  return {
    ok: true,
    binary: found.binary,
    command: found.command,
    via: "path",
  };
}

export function locateCodex({ env = process.env, cliPath } = {}) {
  const explicit = cliPath ?? env?.VOICEBOX_CODEX_CLI ?? "";
  if (explicit) {
    if (isExecutableFile(explicit)) {
      return {
        ok: true,
        binary: explicit,
        command: path.basename(explicit),
        via: "explicit",
      };
    }
    return {
      ok: false,
      refused: "adapter-unavailable",
      why: `VOICEBOX_CODEX_CLI points at ${explicit}, which is not an executable file.`,
    };
  }
  const rawPath = env?.PATH ?? "";
  const found = searchPathDirs(["codex"], rawPath, defaultExtraDirs(rawPath));
  if (!found) {
    return {
      ok: false,
      refused: "adapter-unavailable",
      why: "Codex CLI (codex) was not found in PATH — install @openai/codex or set VOICEBOX_CODEX_CLI.",
    };
  }
  return {
    ok: true,
    binary: found.binary,
    command: found.command,
    via: "path",
  };
}

export function locateGeminiCli({ env = process.env, cliPath } = {}) {
  const explicit = cliPath ?? env?.VOICEBOX_GEMINI_CLI ?? "";
  if (explicit) {
    if (isExecutableFile(explicit)) {
      return {
        ok: true,
        binary: explicit,
        command: path.basename(explicit),
        via: "explicit",
      };
    }
    return {
      ok: false,
      refused: "adapter-unavailable",
      why: `VOICEBOX_GEMINI_CLI points at ${explicit}, which is not an executable file.`,
    };
  }
  const rawPath = env?.PATH ?? "";
  const found = searchPathDirs(["gemini"], rawPath, defaultExtraDirs(rawPath));
  if (!found) {
    return {
      ok: false,
      refused: "adapter-unavailable",
      why: "Gemini CLI (gemini) was not found in PATH — install @google/gemini-cli or set VOICEBOX_GEMINI_CLI.",
    };
  }
  return {
    ok: true,
    binary: found.binary,
    command: found.command,
    via: "path",
  };
}

export function locateOpenCode({ env = process.env, cliPath } = {}) {
  const explicit = cliPath ?? env?.VOICEBOX_OPENCODE_CLI ?? "";
  if (explicit) {
    if (isExecutableFile(explicit)) {
      return {
        ok: true,
        binary: explicit,
        command: path.basename(explicit),
        via: "explicit",
      };
    }
    return {
      ok: false,
      refused: "adapter-unavailable",
      why: `VOICEBOX_OPENCODE_CLI points at ${explicit}, which is not an executable file.`,
    };
  }
  const rawPath = env?.PATH ?? "";
  const found = searchPathDirs(["opencode"], rawPath, defaultExtraDirs(rawPath));
  if (!found) {
    return {
      ok: false,
      refused: "adapter-unavailable",
      why: "OpenCode CLI (opencode) was not found in PATH — install opencode or set VOICEBOX_OPENCODE_CLI.",
    };
  }
  return {
    ok: true,
    binary: found.binary,
    command: found.command,
    via: "path",
  };
}

function resolvePromptText({ task, input, agentConfig }) {
  let promptText = "";
  if (typeof task === "string") {
    promptText = task;
  } else if (task && typeof task === "object") {
    promptText = task.prompt ?? task.task ?? "";
  }
  if (!promptText && input && typeof input === "object") {
    promptText = input.task ?? input.prompt ?? "";
  }
  if (!promptText && task != null) {
    promptText = String(task);
  }
  if (agentConfig?.prompt && typeof agentConfig.prompt === "string" && agentConfig.prompt.trim()) {
    promptText = `[System Instructions: ${agentConfig.prompt.trim()}]\n\n${promptText}`;
  }
  return promptText;
}

function resolveWorkingDirectory(root, optionsRoot) {
  const candidate = typeof root === "function"
    ? root()
    : (root ?? (typeof optionsRoot === "function" ? optionsRoot() : optionsRoot));
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  if (candidate && typeof candidate.path === "string" && candidate.path.trim()) return candidate.path;
  if (candidate?.root && typeof candidate.root.path === "string" && candidate.root.path.trim()) return candidate.root.path;
  return process.cwd();
}

function spawnBoundedCli({
  binary,
  args,
  cwd,
  env,
  deadlineMs,
  maxOutputBytes,
  silenceMs = CLI_EXECUTOR_SILENCE_MS,
  signal,
  report,
  onUpdate,
  onConsole,
  label,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(error("task-cancelled", "task was cancelled before execution"));
      return;
    }

    let settled = false;
    let timedOut = false;
    let wentSilent = false;
    let stdout = "";
    let stderr = "";
    let dropped = false;
    // The answer bound, less room for the note that says its beginning was dropped.
    const keepBytes = Math.max(1, maxOutputBytes - Buffer.byteLength(CLI_OUTPUT_TRUNCATED_NOTE));
    const keep = (text) => {
      const kept = keepTail(text, keepBytes);
      if (kept.dropped) dropped = true;
      return kept.text;
    };

    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killChild = () => {
      try { child.kill("SIGKILL"); } catch {}
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, deadlineMs);
    // Silence is the early signal that a run is stuck; any output at all re-arms it.
    const quiet = Math.min(silenceMs, deadlineMs);
    let silence;
    const heard = () => {
      clearTimeout(silence);
      silence = setTimeout(() => { wentSilent = true; killChild(); }, quiet);
    };
    heard();

    const onAbort = () => {
      killChild();
      if (!settled) {
        settled = true;
        clearTimeout(timer); clearTimeout(silence);
        reject(error("task-cancelled", "the person asked to stop this task"));
      }
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (report) report(`running ${label} in ${cwd}`);
    if (onUpdate) onUpdate({ status: "running", progress: `running ${label}` });

    child.stdout.on("data", (chunk) => {
      heard();
      const text = chunk.toString("utf8");
      stdout = keep(stdout + text);
      const trimmedChunk = text.trim();
      if (trimmedChunk) {
        if (onConsole) {
          // Redact at the PRODUCER (voicebox-beads-fcx9): consumers used to receive raw chunks.
          onConsole({ source: "stdout", text: redactSecrets(trimmedChunk), agent: label });
        } else {
          if (report) report(trimmedChunk);
          if (onUpdate) onUpdate({ status: "running", progress: trimmedChunk });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      heard();
      const text = chunk.toString("utf8");
      stderr = keep(stderr + text);
      const trimmedChunk = text.trim();
      if (trimmedChunk && onConsole) {
        onConsole({ source: "stderr", text: redactSecrets(trimmedChunk), agent: label });
      }
    });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(silence);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(error("adapter-unavailable", `Failed to start ${label}: ${err.message ?? err}`));
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(silence);
      if (signal) signal.removeEventListener("abort", onAbort);

      if (signal?.aborted) {
        reject(error("task-cancelled", "the person asked to stop this task"));
        return;
      }
      if (timedOut) {
        reject(error("task-deadline", `${label} timed out after ${deadlineMs}ms`));
        return;
      }
      if (wentSilent) {
        reject(error("task-deadline", `${label} printed nothing for ${quiet}ms and was stopped as stuck`));
        return;
      }

      const body = stdout.trim() || stderr.trim();
      const trimmedOut = dropped && body ? CLI_OUTPUT_TRUNCATED_NOTE + body : body;
      const summary = trimmedOut.slice(0, 400);
      const ok = code === 0;
      const status = ok ? "completed" : "failed";
      if (onUpdate) {
        onUpdate({ status, progress: summary });
      }
      resolve({
        ok,
        status,
        code: code ?? 1,
        output: trimmedOut,
        summary,
        answer: trimmedOut,
        toString() {
          return trimmedOut;
        },
      });
    });
  });
}

function createCliExecutorForSpec(spec, options = {}) {
  const timeoutMs = options.timeoutMs ?? CLI_EXECUTOR_TIMEOUT_CEILING_MS;
  const maxOutputBytes = options.maxOutputBytes ?? CLI_EXECUTOR_MAX_OUTPUT_BYTES;

  function check(args = {}) {
    const requestedHarness = args.harness ?? args.agentConfig?.harness ?? args.input?.harness ?? args.input?.agent;
    if (requestedHarness && !spec.validHarnesses.has(requestedHarness)) {
      return {
        ok: false,
        refused: "adapter-not-configured",
        why: `${spec.harness} executor only serves ${Array.from(spec.validHarnesses).join("/")}, not '${requestedHarness}'.`,
      };
    }
    const agentConfig = args.agentConfig;
    if (agentConfig) {
      if (agentConfig.adapter && !spec.validAdapters.has(agentConfig.adapter)) {
        return {
          ok: false,
          refused: "adapter-not-configured",
          why: `${spec.harness} executor only supports adapter '${spec.adapter}', not '${agentConfig.adapter}'.`,
        };
      }
      if (agentConfig.transport && agentConfig.transport !== "stdio") {
        return {
          ok: false,
          refused: "unsupported-runtime-capability",
          why: `${spec.adapter} adapter only supports 'stdio' transport, not '${agentConfig.transport}'.`,
        };
      }
    }

    const activeEnv = args.env ?? options.env ?? process.env;
    const located = spec.locate({ env: activeEnv, cliPath: options.cliPath });
    if (!located.ok) return located;

    const installedVersion = probeVersionSync(located.binary, spec.versionPattern, activeEnv);
    if (agentConfig?.pinnedVersion && installedVersion && agentConfig.pinnedVersion !== installedVersion) {
      return {
        ok: false,
        refused: "adapter-version-unsupported",
        why: `pinned version '${agentConfig.pinnedVersion}' does not match installed ${spec.harness} ${installedVersion}.`,
      };
    }

    const requestedDeadline = args.bounds?.deadlineMs ?? agentConfig?.bounds?.deadlineMs;
    const requestedOutput = args.bounds?.maxOutputBytes ?? agentConfig?.bounds?.maxOutputBytes;
    return {
      ok: true,
      harness: spec.harness,
      adapter: spec.adapter,
      binary: located.binary,
      installedVersion,
      mechanism: `stdio-cli: ${spec.adapter} (${located.command})`,
      bounds: {
        deadlineMs: Math.min(timeoutMs, typeof requestedDeadline === "number" ? requestedDeadline : CLI_EXECUTOR_TIMEOUT_CEILING_MS),
        maxOutputBytes: Math.min(maxOutputBytes, typeof requestedOutput === "number" ? requestedOutput : CLI_EXECUTOR_MAX_OUTPUT_BYTES),
      },
    };
  }

  async function run(args = {}) {
    const activeEnv = args.env ?? options.env ?? process.env;
    const checked = check({ ...args, env: activeEnv });
    if (!checked.ok) {
      throw error(checked.refused, checked.why);
    }

    const cwd = resolveWorkingDirectory(args.root, options.root);
    const beforeSnapshot = snapshotProjectWorkspace(cwd);

    const basePromptText = resolvePromptText({
      task: args.task,
      input: args.input,
      agentConfig: args.agentConfig,
    });
    const shouldEnrich = Boolean(
      options.enrichProjectContext || args.enrichProjectContext || args.includeProjectContext,
    );
    const promptText = shouldEnrich
      ? buildProjectAwareTaskPrompt({
          task: basePromptText,
          rootPath: cwd,
          includeProjectContext: true,
        })
      : basePromptText;
    const cliArgs = spec.buildArgs(promptText, checked.binary);

    const cliResult = await spawnBoundedCli({
      binary: checked.binary,
      args: cliArgs,
      cwd,
      env: activeEnv,
      deadlineMs: checked.bounds.deadlineMs,
      maxOutputBytes: checked.bounds.maxOutputBytes,
      silenceMs: options.silenceMs,
      signal: args.signal,
      report: args.report,
      onUpdate: args.onUpdate,
      onConsole: args.onConsole,
      label: spec.adapter,
    });

    const projectIntegration = integrateHarnessOutput(cwd, {
      harness: spec.harness,
      taskId: args.taskId ?? null,
      prompt: basePromptText,
      output: cliResult.output,
      beforeSnapshot,
      saveReport: Boolean(options.saveReport || args.saveReport),
    });

    if (typeof args.onProjectIntegration === "function") {
      args.onProjectIntegration(projectIntegration);
    }

    return {
      ...cliResult,
      changedFiles: projectIntegration.changedFiles,
      createdFiles: projectIntegration.createdFiles,
      modifiedFiles: projectIntegration.modifiedFiles,
      deletedFiles: projectIntegration.deletedFiles,
      projectIntegration,
      toString() {
        return cliResult.output;
      },
    };
  }

  return Object.freeze({ check, run });
}

const ANTIGRAVITY_SPEC = {
  harness: "antigravity",
  adapter: "antigravity",
  validHarnesses: new Set(["antigravity", "agy", "agentapi"]),
  validAdapters: new Set(["antigravity", "agy", "agentapi"]),
  versionPattern: /(?:antigravity|agy|agentapi)?\s*v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i,
  locate: locateAntigravity,
  buildArgs(prompt, binary) {
    const cmd = path.basename(binary);
    if (cmd === "agentapi") {
      return ["run", "--", prompt];
    }
    // Keep the usual option/value shape, but bind a leading-dash value so an older parser cannot treat it as a flag.
    return prompt.startsWith("-") ? [`--prompt=${prompt}`] : ["--prompt", prompt];
  },
};

const CODEX_SPEC = {
  harness: "codex",
  adapter: "codex-cli",
  validHarnesses: new Set(["codex", "codex-cli"]),
  validAdapters: new Set(["codex", "codex-cli"]),
  versionPattern: /(?:codex-cli|codex)?\s*v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i,
  locate: locateCodex,
  buildArgs(prompt) {
    return ["exec", "--skip-git-repo-check", "--", prompt];
  },
};

const GEMINI_SPEC = {
  harness: "gemini",
  adapter: "gemini-cli",
  validHarnesses: new Set(["gemini", "gemini-cli"]),
  validAdapters: new Set(["gemini", "gemini-cli"]),
  versionPattern: /(?:gemini-cli|gemini)?\s*v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i,
  locate: locateGeminiCli,
  buildArgs(prompt) {
    // yargs may parse a dash-prefixed separate value as another option; bind it in one argv entry.
    return [`--prompt=${prompt}`];
  },
};

const OPENCODE_SPEC = {
  harness: "opencode",
  adapter: "opencode",
  validHarnesses: new Set(["opencode"]),
  validAdapters: new Set(["opencode"]),
  versionPattern: /(?:opencode)?\s*v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i,
  locate: locateOpenCode,
  buildArgs(prompt) {
    return ["run", "--", prompt];
  },
};

export function createAntigravityExecutor(options = {}) {
  return createCliExecutorForSpec(ANTIGRAVITY_SPEC, options);
}

export function createCodexExecutor(options = {}) {
  return createCliExecutorForSpec(CODEX_SPEC, options);
}

export function createGeminiCliExecutor(options = {}) {
  return createCliExecutorForSpec(GEMINI_SPEC, options);
}

export function createOpenCodeExecutor(options = {}) {
  return createCliExecutorForSpec(OPENCODE_SPEC, options);
}

export function describeCliAdapterInstall(harnessOrAdapter, options = {}) {
  const key = String(harnessOrAdapter ?? "").trim().toLowerCase();
  if (ANTIGRAVITY_SPEC.validAdapters.has(key)) {
    return createAntigravityExecutor(options).check(options);
  }
  if (CODEX_SPEC.validAdapters.has(key)) {
    return createCodexExecutor(options).check(options);
  }
  if (GEMINI_SPEC.validAdapters.has(key)) {
    return createGeminiCliExecutor(options).check(options);
  }
  if (OPENCODE_SPEC.validAdapters.has(key)) {
    return createOpenCodeExecutor(options).check(options);
  }
  return {
    ok: false,
    refused: "adapter-not-configured",
    why: `No CLI task adapter is implemented for '${harnessOrAdapter}'.`,
  };
}
