// lib/system-tools.mjs — General-purpose System & Sandbox CLI Tool Discovery and Execution.
//
// Enables Voicebox to discover and safely execute any CLI tool installed on the host
// or inside the active sandbox environment (e.g. bd, gh, glab, jira, linear, git, jj,
// node, npm, rg, jq, python3, custom issue trackers, or project scripts).

import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "./git-env.mjs";

const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_BYTES = 65536;

/**
 * Curated catalogue of common developer, issue-tracker, runtime, search,
 * container, and agent CLIs checked during discovery.
 */
export const CURATED_SYSTEM_TOOLS = [
  // Issue Trackers & Forges
  { name: "bd", category: "issue-tracker" },
  { name: "gh", category: "issue-tracker" },
  { name: "glab", category: "issue-tracker" },
  { name: "jira", category: "issue-tracker" },
  { name: "linear", category: "issue-tracker" },
  { name: "hub", category: "issue-tracker" },
  { name: "tea", category: "issue-tracker" },

  // Version Control
  { name: "git", category: "vcs" },
  { name: "jj", category: "vcs" },
  { name: "hg", category: "vcs" },

  // Runtimes & Package Managers
  { name: "node", category: "runtime" },
  { name: "npm", category: "runtime" },
  { name: "npx", category: "runtime" },
  { name: "pnpm", category: "runtime" },
  { name: "yarn", category: "runtime" },
  { name: "bun", category: "runtime" },
  { name: "deno", category: "runtime" },
  { name: "python3", category: "runtime" },
  { name: "python", category: "runtime" },
  { name: "uv", category: "runtime" },
  { name: "cargo", category: "runtime" },
  { name: "go", category: "runtime" },

  // Search & Data
  { name: "rg", category: "search-data" },
  { name: "fd", category: "search-data" },
  { name: "jq", category: "search-data" },
  { name: "yq", category: "search-data" },
  { name: "sqlite3", category: "search-data" },
  { name: "duckdb", category: "search-data" },
  { name: "curl", category: "search-data" },

  // Containers & Sandboxes
  { name: "docker", category: "containers" },
  { name: "podman", category: "containers" },
  { name: "bwrap", category: "containers" },

  // Agent CLIs
  { name: "pi", category: "agent" },
  { name: "claude", category: "agent" },
  { name: "codex", category: "agent" },
  { name: "gemini", category: "agent" },
  { name: "antigravity", category: "agent" },
  { name: "agy", category: "agent" },
  { name: "agentapi", category: "agent" },
  { name: "opencode", category: "agent" },
  { name: "aider", category: "agent" },
];

const CURATED_CATEGORY_BY_NAME = new Map(
  CURATED_SYSTEM_TOOLS.map((entry) => [entry.name, entry.category]),
);

const SYSTEM_BULK_BIN_DIRS = new Set([
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
]);

function isExecutableFile(candidate) {
  try {
    if (!candidate || !existsSync(candidate)) return false;
    const st = statSync(candidate);
    if (!st.isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExistingDirectory(candidate) {
  try {
    if (!candidate || !existsSync(candidate)) return false;
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function inferToolCategory(name) {
  if (CURATED_CATEGORY_BY_NAME.has(name)) {
    return CURATED_CATEGORY_BY_NAME.get(name);
  }
  if (/tracker|issue|ticket|bead|bug|todo|jira|linear/i.test(name)) {
    return "issue-tracker";
  }
  return "custom";
}

/**
 * Build the ordered list of existing binary search directories from `extraPaths`,
 * `env.PATH`, project-local bin directories, and standard user/system bin locations.
 */
export function collectSearchPathDirs({
  env = process.env,
  cwd = process.cwd(),
  extraPaths = [],
  includeProjectBins = false,
} = {}) {
  const home = env?.HOME || os.homedir();
  const envPathEntries = String(env?.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);

  const projectDirs = [];
  if (includeProjectBins && cwd && isExistingDirectory(cwd)) {
    const resolvedCwd = path.resolve(cwd);
    projectDirs.push(
      path.join(resolvedCwd, "bin"),
      path.join(resolvedCwd, "scripts"),
      path.join(resolvedCwd, "node_modules", ".bin"),
    );
  }

  const strictPathOnly = env?.VOICEBOX_STRICT_PATH === "1";
  const standardUserAndSystemDirs = strictPathOnly
    ? []
    : [
        ...(home
          ? [
              path.join(home, ".local", "bin"),
              path.join(home, "go", "bin"),
              path.join(home, ".cargo", "bin"),
            ]
          : []),
        path.dirname(process.execPath),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ];

  const rawCandidates = [
    ...(Array.isArray(extraPaths) ? extraPaths : []),
    ...envPathEntries,
    ...projectDirs,
    ...standardUserAndSystemDirs,
  ];

  const seen = new Set();
  const result = [];
  for (const dir of rawCandidates) {
    if (!dir || typeof dir !== "string") continue;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (isExistingDirectory(resolved)) {
      result.push(resolved);
    }
  }
  return result;
}

/**
 * Resolve an executable name or project-relative script path to an absolute executable file path.
 */
export function resolveSystemBinary(
  executable,
  { env = process.env, cwd = process.cwd(), extraPaths = [] } = {},
) {
  if (!executable || typeof executable !== "string") return null;
  const trimmed = executable.trim();
  if (!trimmed) return null;

  // Reject any path traversal segments
  if (trimmed.split(/[\\/]/).includes("..")) {
    return null;
  }

  // Relative path inside `cwd` (e.g. ./scripts/check.sh or bin/my-tool)
  if (trimmed.includes("/")) {
    if (path.isAbsolute(trimmed)) {
      return isExecutableFile(trimmed) ? trimmed : null;
    }
    if (!cwd || !isExistingDirectory(cwd)) return null;
    const resolvedRoot = path.resolve(cwd);
    const candidate = path.resolve(resolvedRoot, trimmed);
    // The owned containment primitive (lib/path-auth.mjs, voicebox-beads-q0a3) — the raw
    // prefix compare it replaced was a private copy with no realpath story at all.
    if (!containedIn(resolvedRoot, candidate)) {
      return null;
    }
    return isExecutableFile(candidate) ? candidate : null;
  }

  const searchDirs = collectSearchPathDirs({
    env,
    cwd,
    extraPaths,
    includeProjectBins: true,
  });

  for (const dir of searchDirs) {
    const candidate = path.join(dir, trimmed);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Parse a command string into `{ ok: true, executable, args }` while handling single
 * and double quotes and refusing unquoted shell control/chaining operators.
 */
export function parseCommandLine(commandLine) {
  if (!commandLine || typeof commandLine !== "string" || !commandLine.trim()) {
    return {
      ok: false,
      refused: "missing-command",
      why: "Specify a non-empty command to execute.",
    };
  }

  const tokens = [];
  let current = "";
  let quote = null;
  let hasTokenContent = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    const next = commandLine[i + 1];

    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < commandLine.length) {
        current += commandLine[++i];
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      hasTokenContent = true;
      continue;
    }

    if (ch === "\\" && i + 1 < commandLine.length) {
      current += commandLine[++i];
      hasTokenContent = true;
      continue;
    }

    // Refuse unquoted shell chaining, redirection, or subshell expansion operators
    if (
      ch === ";" ||
      ch === "|" ||
      ch === "`" ||
      ch === ">" ||
      ch === "<" ||
      (ch === "&" && next === "&") ||
      (ch === "$" && next === "(")
    ) {
      return {
        ok: false,
        refused: "shell-operators-not-allowed",
        why: "Unquoted shell operators (;, |, &&, ||, >, <, `, $()) are not permitted; pass a single command and its arguments.",
      };
    }

    if (/\s/.test(ch)) {
      if (hasTokenContent || current.length > 0) {
        tokens.push(current);
        current = "";
        hasTokenContent = false;
      }
      continue;
    }

    current += ch;
    hasTokenContent = true;
  }

  if (quote) {
    return {
      ok: false,
      refused: "unclosed-quote",
      why: "Command contains an unclosed quote.",
    };
  }

  if (hasTokenContent || current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return {
      ok: false,
      refused: "missing-command",
      why: "Specify a non-empty command to execute.",
    };
  }

  return {
    ok: true,
    executable: tokens[0],
    args: tokens.slice(1),
    tokens,
  };
}

/**
 * Discover installed CLI tools across `PATH` and standard user/system directories,
 * plus custom executables in non-system PATH directories and project scripts in `cwd`.
 */
export function discoverSystemTools({
  env = process.env,
  cwd = process.cwd(),
  extraPaths = [],
} = {}) {
  const pathDirs = collectSearchPathDirs({
    env,
    cwd,
    extraPaths,
    includeProjectBins: false,
  });

  const available = [];
  const seenNames = new Set();

  // 1. Check curated system/developer/issue-tracker tools across all search directories
  for (const tool of CURATED_SYSTEM_TOOLS) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, tool.name);
      if (isExecutableFile(candidate)) {
        available.push({
          name: tool.name,
          category: tool.category,
          path: candidate,
        });
        seenNames.add(tool.name);
        break;
      }
    }
  }

  // 2. Scan custom/user PATH directories (e.g. extraPaths, temp bin dirs, ~/.local/bin)
  // so custom issue trackers or sandbox tools are discovered automatically.
  const customScanDirs = [
    ...(Array.isArray(extraPaths) ? extraPaths : []),
    ...String(env?.PATH ?? "")
      .split(path.delimiter)
      .map((d) => d.trim())
      .filter(Boolean),
  ]
    .map((d) => path.resolve(d))
    .filter((d) => !SYSTEM_BULK_BIN_DIRS.has(d) && isExistingDirectory(d));

  const scannedDirs = new Set();
  for (const dir of customScanDirs) {
    if (scannedDirs.has(dir)) continue;
    scannedDirs.add(dir);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.length > 250) continue;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (seenNames.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (isExecutableFile(fullPath)) {
        available.push({
          name: entry.name,
          category: inferToolCategory(entry.name),
          path: fullPath,
        });
        seenNames.add(entry.name);
      }
    }
  }

  // 3. Discover project-local scripts from package.json, scripts/, and bin/
  const projectScripts = [];
  if (cwd && isExistingDirectory(cwd)) {
    const resolvedCwd = path.resolve(cwd);
    const pkgJsonPath = path.join(resolvedCwd, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        if (pkg && pkg.scripts && typeof pkg.scripts === "object") {
          for (const [name, scriptCmd] of Object.entries(pkg.scripts)) {
            projectScripts.push({
              name,
              source: "package.json",
              command: `npm run ${name}`,
              script: String(scriptCmd),
            });
          }
        }
      } catch {
        // Ignore malformed package.json
      }
    }

    for (const subDir of ["scripts", "bin"]) {
      const targetDir = path.join(resolvedCwd, subDir);
      if (!isExistingDirectory(targetDir)) continue;
      try {
        for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || !entry.isFile()) continue;
          const fullPath = path.join(targetDir, entry.name);
          projectScripts.push({
            name: entry.name,
            source: subDir,
            path: fullPath,
            relativePath: path.posix.join(subDir, entry.name),
          });
        }
      } catch {
        // Ignore unreadable script directory
      }
    }
  }

  return {
    ok: true,
    available,
    projectScripts,
    pathDirs,
  };
}

/**
 * Execute any installed CLI command non-interactively inside `rootPath` with bounded
 * timeout and output size.
 */
export async function runSystemCommand(
  rootPath,
  {
    command,
    args = [],
    input = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    env = process.env,
  } = {},
) {
  if (!rootPath || typeof rootPath !== "string" || !isExistingDirectory(rootPath)) {
    return {
      ok: false,
      refused: "root-not-declared",
      why: "Declare or open a project workspace before running system commands.",
    };
  }
  const resolvedRoot = path.resolve(rootPath);

  if (!command || typeof command !== "string" || !command.trim()) {
    return {
      ok: false,
      refused: "missing-command",
      why: "Specify a command to execute.",
    };
  }

  let executable = command.trim();
  let parsedArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];

  if (parsedArgs.length === 0 && /\s/.test(executable)) {
    const parsed = parseCommandLine(executable);
    if (!parsed.ok) return parsed;
    executable = parsed.executable;
    parsedArgs = parsed.args;
  } else if (/\s/.test(executable)) {
    const parsed = parseCommandLine(executable);
    if (!parsed.ok) return parsed;
    executable = parsed.executable;
    parsedArgs = [...parsed.args, ...parsedArgs];
  } else {
    const validated = parseCommandLine(executable);
    if (!validated.ok) return validated;
    executable = validated.executable;
  }

  if (executable.split(/[\\/]/).includes("..")) {
    return {
      ok: false,
      refused: "invalid-command",
      why: "Command executable path must not contain traversal segments ('..').",
    };
  }

  const resolvedBinary = resolveSystemBinary(executable, {
    env,
    cwd: resolvedRoot,
  });
  if (!resolvedBinary) {
    return {
      ok: false,
      refused: "tool-not-installed",
      command: executable,
      args: parsedArgs,
      why: `Command '${executable}' was not found on this system's PATH.`,
    };
  }

  const numericTimeout = Number(timeoutMs);
  const clampedTimeout = Number.isFinite(numericTimeout)
    ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(numericTimeout)))
    : DEFAULT_TIMEOUT_MS;

  const numericMaxBytes = Number(maxOutputBytes);
  const clampedMaxBytes =
    Number.isFinite(numericMaxBytes) && numericMaxBytes > 0
      ? Math.trunc(numericMaxBytes)
      : DEFAULT_MAX_OUTPUT_BYTES;

  const searchDirs = collectSearchPathDirs({
    env,
    cwd: resolvedRoot,
    includeProjectBins: true,
  });

  const augmentedEnv = {
    // Hooks export GIT_DIR etc.; even descendant git commands must answer about rootPath.
    ...gitEnv(env),
    PATH: searchDirs.join(path.delimiter),
    CI: env?.CI ?? "1",
    NO_COLOR: "1",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: "0",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
  };

  const startedAt = Date.now();

  return new Promise((resolve) => {
    let timedOut = false;
    let spawnError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const stdoutChunks = [];
    const stderrChunks = [];

    const child = spawn(resolvedBinary, parsedArgs, {
      cwd: resolvedRoot,
      env: augmentedEnv,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Process group already exited
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already exited
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, clampedTimeout);

    child.stdin.on("error", () => {});
    if (input !== undefined && input !== null && String(input).length > 0) {
      child.stdin.end(String(input));
    } else {
      child.stdin.end();
    }

    child.stdout.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stdoutBytes < clampedMaxBytes) {
        const remaining = clampedMaxBytes - stdoutBytes;
        if (buf.length <= remaining) {
          stdoutChunks.push(buf);
          stdoutBytes += buf.length;
        } else {
          stdoutChunks.push(buf.subarray(0, remaining));
          stdoutBytes = clampedMaxBytes;
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });

    child.stderr.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stderrBytes < clampedMaxBytes) {
        const remaining = clampedMaxBytes - stderrBytes;
        if (buf.length <= remaining) {
          stderrChunks.push(buf);
          stderrBytes += buf.length;
        } else {
          stderrChunks.push(buf.subarray(0, remaining));
          stderrBytes = clampedMaxBytes;
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });

    child.on("error", (err) => {
      spawnError = err;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      killGroup();

      const durationMs = Date.now() - startedAt;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trimEnd();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trimEnd();
      const output = (stdout || stderr).trim();
      const action = `ran ${executable}${parsedArgs.length ? ` ${parsedArgs.join(" ")}` : ""}`.trim();

      if (timedOut) {
        resolve({
          ok: false,
          refused: "command-timed-out",
          command: executable,
          args: parsedArgs,
          timeoutMs: clampedTimeout,
          durationMs,
          stdout,
          stderr,
          output,
          why: `Command '${executable}' exceeded the ${clampedTimeout}ms timeout and was killed.`,
        });
        return;
      }

      if (spawnError) {
        resolve({
          ok: false,
          refused: "spawn-failed",
          command: executable,
          args: parsedArgs,
          durationMs,
          stdout,
          stderr,
          output: String(spawnError.message || spawnError),
          why: `Command '${executable}' failed to start: ${spawnError.message || spawnError}`,
        });
        return;
      }

      const exitCode = typeof code === "number" ? code : 1;
      resolve({
        ok: exitCode === 0,
        command: executable,
        resolvedPath: resolvedBinary,
        args: parsedArgs,
        exitCode,
        stdout,
        stderr,
        output,
        truncated,
        durationMs,
        action,
      });
    });
  });
}
