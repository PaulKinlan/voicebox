// lib/tool-index.mjs — Unified Tool & Capability Index (voicebox-beads-x863)
//
// Aggregates every capability available to Voicebox into one searchable,
// normalized index:
//   1. Native tools (COMMANDS from lib/commands.mjs)
//   2. WASM tools (digest-pinned modules from lib/wasm-shelf.mjs)
//   3. Extensions (admitted, pending/proposed, and catalogue templates from lib/extensions.mjs)
//   4. System CLI binaries (discovered on PATH + common user bin dirs + workspace bin/scripts)
//   5. Project scripts (package.json "scripts" in the active project root)
//   6. Mini-App Web MCP tools (registered by active room mini-apps)
//   7. Agent Harnesses (configured/discovered coding agents for delegate_task)
//
// Also provides runSystemCommand() so any installed CLI tool (bd, git, gh, rg,
// pytest, cargo, etc.) or project script can be executed inside the active
// project workspace under bounded timeout and output limits.

import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { COMMANDS } from "./commands.mjs";
import { readShelf } from "./wasm-shelf.mjs";
import * as defaultExtensions from "./extensions.mjs";
import { wasmShelfDir } from "./state-dirs.mjs";

export const SYSTEM_CLI_CATALOGUE = [
  { name: "bd", category: "issue-tracker", description: "Beads distributed issue tracker CLI (bd ready, bd show, bd create, bd update, bd close)", keywords: ["beads", "issue", "issues", "tracker", "tasks", "todo", "bug", "ticket"] },
  { name: "git", category: "vcs", description: "Git distributed version control CLI", keywords: ["version control", "commit", "branch", "diff", "status", "log", "repo"] },
  { name: "gh", category: "issue-tracker", description: "GitHub CLI for issues, pull requests, releases, and repo workflows", keywords: ["github", "issue", "issues", "tracker", "pr", "pull request", "tasks"] },
  { name: "glab", category: "issue-tracker", description: "GitLab CLI for issues, merge requests, and pipelines", keywords: ["gitlab", "issue", "issues", "tracker", "mr", "tasks"] },
  { name: "linear", category: "issue-tracker", description: "Linear CLI for issue tracking and project management", keywords: ["issue", "issues", "tracker", "tasks", "ticket"] },
  { name: "jira", category: "issue-tracker", description: "Jira CLI for issue tracking and sprint management", keywords: ["issue", "issues", "tracker", "tasks", "ticket"] },
  { name: "node", category: "runtime", description: "Node.js JavaScript runtime and test runner (node --test)", keywords: ["javascript", "js", "mjs", "test", "check", "run"] },
  { name: "npm", category: "build", description: "Node package manager and script runner (npm test, npm run)", keywords: ["package", "scripts", "test", "check", "build", "install"] },
  { name: "npx", category: "build", description: "Execute Node package binaries", keywords: ["package", "execute", "runner"] },
  { name: "pnpm", category: "build", description: "Fast disk-efficient Node.js package manager", keywords: ["package", "scripts", "build", "install"] },
  { name: "yarn", category: "build", description: "Yarn package manager and script runner", keywords: ["package", "scripts", "build", "install"] },
  { name: "bun", category: "runtime", description: "Bun JavaScript/TypeScript runtime, bundler, and test runner", keywords: ["javascript", "typescript", "test", "build"] },
  { name: "deno", category: "runtime", description: "Deno JavaScript/TypeScript runtime", keywords: ["javascript", "typescript", "sandbox"] },
  { name: "python3", category: "runtime", description: "Python 3 interpreter and standard library CLI", keywords: ["python", "py", "script"] },
  { name: "pytest", category: "build", description: "Python test runner (pytest)", keywords: ["python", "test", "check", "assert"] },
  { name: "uv", category: "build", description: "Fast Python package and environment manager", keywords: ["python", "package", "venv", "pip"] },
  { name: "cargo", category: "build", description: "Rust package manager and build tool (cargo test, cargo build)", keywords: ["rust", "build", "test", "check", "wasm"] },
  { name: "go", category: "build", description: "Go programming language tool (go test, go build, go run)", keywords: ["golang", "build", "test", "check"] },
  { name: "rg", category: "search", description: "ripgrep fast recursive regex code search CLI", keywords: ["grep", "search", "find", "regex", "files"] },
  { name: "fd", category: "search", description: "fd fast file and directory finder", keywords: ["find", "search", "files", "directory"] },
  { name: "jq", category: "data", description: "Command-line JSON processor and query tool", keywords: ["json", "parse", "filter", "query", "format"] },
  { name: "yq", category: "data", description: "Command-line YAML/JSON/XML processor", keywords: ["yaml", "json", "parse", "query"] },
  { name: "curl", category: "system", description: "Transfer data from or to a server over HTTP/HTTPS", keywords: ["http", "fetch", "url", "api", "request", "web"] },
  { name: "make", category: "build", description: "GNU Make build automation tool", keywords: ["build", "compile", "Makefile", "task"] },
  { name: "docker", category: "system", description: "Docker container runtime CLI", keywords: ["container", "image", "sandbox"] },
  { name: "sqlite3", category: "data", description: "SQLite command-line database shell", keywords: ["sql", "database", "db", "query"] },
  { name: "ffmpeg", category: "data", description: "Audio and video conversion and processing CLI", keywords: ["audio", "video", "media", "convert", "wav", "mp3"] },
  { name: "claude", category: "agent-cli", description: "Claude Code CLI coding agent", keywords: ["anthropic", "agent", "coding", "assistant", "harness"] },
  { name: "codex", category: "agent-cli", description: "OpenAI Codex CLI coding agent", keywords: ["openai", "agent", "coding", "assistant", "harness"] },
  { name: "gemini", category: "agent-cli", description: "Google Gemini CLI coding agent", keywords: ["google", "agent", "coding", "assistant", "harness"] },
  { name: "pi", category: "agent-cli", description: "Pi coding agent CLI", keywords: ["agent", "coding", "assistant", "harness"] },
  { name: "antigravity", category: "agent-cli", description: "Antigravity agent CLI", keywords: ["agent", "coding", "assistant", "harness"] },
  { name: "agy", category: "agent-cli", description: "Antigravity (agy) shorthand CLI", keywords: ["antigravity", "agent", "coding", "harness"] },
  { name: "agentapi", category: "agent-cli", description: "AgentAPI CLI for managing and messaging agent conversations", keywords: ["agent", "subagent", "orchestration"] },
  { name: "opencode", category: "agent-cli", description: "OpenCode CLI coding agent", keywords: ["agent", "coding", "assistant", "harness"] },
];

const DEFAULT_HARNESS_DEFINITIONS = [
  { id: "pi", name: "Pi", description: "Pi coding agent via pi-acp adapter (background task delegation)" },
  { id: "claude", name: "Claude Code", description: "Claude Code coding agent via claude-agent-acp adapter (background task delegation)" },
  { id: "antigravity", name: "Antigravity", description: "Google Antigravity coding agent harness" },
  { id: "codex", name: "Codex", description: "OpenAI Codex coding agent harness" },
  { id: "gemini", name: "Gemini CLI", description: "Google Gemini CLI coding agent harness" },
  { id: "opencode", name: "OpenCode", description: "OpenCode coding agent harness" },
];

const QUERY_SYNONYMS = {
  "issue": ["bd", "beads", "gh", "glab", "linear", "jira", "issue-tracker", "delegate_task"],
  "issues": ["bd", "beads", "gh", "glab", "linear", "jira", "issue-tracker"],
  "tracker": ["bd", "beads", "gh", "glab", "linear", "jira", "issue-tracker"],
  "beads": ["bd", "issue-tracker"],
  "task": ["bd", "beads", "delegate_task", "list_agents"],
  "tasks": ["bd", "beads", "delegate_task", "list_agents"],
  "hash": ["hash", "sha256", "digest", "wasm"],
  "sha256": ["hash", "digest", "wasm"],
  "wasm": ["wasm", "hash", "diff"],
  "test": ["test", "npm", "node", "pytest", "cargo", "go", "run_command", "exec"],
  "check": ["test", "check", "npm", "node", "run_command", "exec", "single-owner", "docs-check"],
  "search": ["grep_files", "search_tools", "rg", "fd", "web-search", "web_search"],
  "git": ["git", "git_status", "git_diff", "git_log", "gh"],
};

function nativeCategoryFor(cmdName) {
  if (["write_file", "read_file", "list_files", "delete_file", "edit_file", "diff_file", "grep_files", "undo_last_action"].includes(cmdName)) {
    return "files";
  }
  if (cmdName.startsWith("git_")) return "vcs";
  if (cmdName.includes("extension")) return "extensions";
  if (cmdName.includes("agent") || cmdName === "delegate_task") return "agents";
  if (cmdName.includes("mini_app")) return "mini-app";
  if (cmdName === "list_tools" || cmdName === "search_tools") return "tools";
  return "system";
}

function buildSearchPaths(rootPath = null, env = process.env) {
  const home = os.homedir();
  const extra = [
    ...(rootPath ? [path.join(rootPath, "node_modules", ".bin")] : []),
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, "go", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const fromEnv = String(env?.PATH ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set([...extra, ...fromEnv])];
}

function isExecutableFile(filePath) {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBinaryOnPaths(binName, searchPaths) {
  for (const dir of searchPaths) {
    const candidate = path.join(dir, binName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function collectExtensionItems(extensionsSource) {
  const items = [];
  const extMod = extensionsSource ?? defaultExtensions;
  const seenExtensionIds = new Set();

  // 1. Support mock or custom objects with .list()
  if (typeof extMod?.list === "function") {
    const listed = extMod.list() ?? [];
    for (const ext of listed) {
      const id = ext.id || ext.name;
      if (!id) continue;
      seenExtensionIds.add(id);
      const toolName = ext.tool || ext.tools?.[0]?.name || ext.tools?.[0] || id;
      const rawStatus = ext.status || ext.state || (ext.admitted ? "admitted" : "proposed");
      const status = rawStatus === "pending" ? "proposed" : rawStatus;
      items.push({
        id: `extension:${toolName}`,
        name: String(toolName),
        kind: "extension",
        category: ext.category || ext.capabilities?.[0] || ext.declared?.[0] || "extension",
        status,
        description: ext.description || `Extension ${ext.name || id}`,
        invocation: { tool: "call_extension", args: { name: String(toolName) } },
        metadata: { extensionId: id, source: ext.source ?? "local" },
      });
    }
  } else {
    // 2. Standard inventory() shape from lib/extensions.mjs
    const inv = typeof extMod?.inventory === "function"
      ? extMod.inventory()
      : (extMod && typeof extMod === "object" && Array.isArray(extMod.extensions) ? extMod : null);
    if (inv) {
      for (const ext of inv.extensions ?? []) {
        seenExtensionIds.add(ext.id);
        const details = Array.isArray(ext.toolDetails) && ext.toolDetails.length > 0
          ? ext.toolDetails
          : (ext.tools ?? [ext.id]).map((t) => (typeof t === "string" ? { name: t, description: ext.description ?? "" } : t));
        for (const t of details) {
          const toolName = t.name || ext.id;
          items.push({
            id: `extension:${toolName}`,
            name: toolName,
            kind: "extension",
            category: ext.declared?.[0] || "extension",
            status: "admitted",
            description: t.description || ext.name || `Admitted extension tool ${toolName}`,
            invocation: { tool: "call_extension", args: { name: toolName } },
            metadata: {
              extensionId: ext.id,
              source: ext.source ?? "local",
              declared: ext.declared ?? [],
              primitive: t.primitive ?? null,
            },
          });
        }
      }
      for (const prop of inv.proposals ?? []) {
        seenExtensionIds.add(prop.id);
        const status = prop.state === "refused" || prop.refusal ? "refused" : "proposed";
        items.push({
          id: `extension:proposal:${prop.id}`,
          name: prop.name || prop.id,
          kind: "extension",
          category: prop.declared?.[0] || "extension",
          status,
          description: prop.description || `Proposed extension '${prop.name || prop.id}' (${status})`,
          invocation: { tool: "call_extension", args: { name: prop.id } },
          metadata: { extensionId: prop.id, source: prop.source ?? "model", state: prop.state },
        });
      }
    }
  }

  // 3. Built-in catalogue templates
  const catList = typeof extMod?.catalogue === "function"
    ? extMod.catalogue()
    : (Array.isArray(extMod?.catalogue) ? extMod.catalogue : []);
  for (const entry of catList ?? []) {
    if (!entry?.id || entry.error) continue;
    // WASM shelf tools are indexed under kind: "wasm"
    if (String(entry.id).startsWith("wasm-shelf-")) continue;
    if (seenExtensionIds.has(entry.id)) continue;
    items.push({
      id: `extension:catalogue:${entry.id}`,
      name: entry.id,
      kind: "extension",
      category: entry.declared?.[0] || "catalogue",
      status: "catalogue",
      description: entry.description || entry.name || `Catalogue extension ${entry.id}`,
      invocation: { tool: "propose_extension", args: { catalogueId: entry.id } },
      metadata: { catalogueId: entry.id, declared: entry.declared ?? [], runsIn: entry.runsIn ?? "host" },
    });
  }

  return items;
}

/**
 * List all indexed tools across native commands, WASM modules, extensions,
 * system CLI binaries, project scripts, mini-app tools, and agent harnesses.
 */
export function listTools(options = {}) {
  const {
    kind = "",
    category = "",
    status = "",
    rootPath = null,
    extensions = defaultExtensions,
    wasmDir = null,
    shelfDir = null,
    miniAppTools = [],
    harnesses = null,
    env = process.env,
  } = options;

  const tools = [];

  // 1. Native tools from lib/commands.mjs
  for (const cmd of COMMANDS) {
    tools.push({
      id: `native:${cmd.name}`,
      name: cmd.name,
      kind: "native",
      category: nativeCategoryFor(cmd.name),
      status: "ready",
      description: cmd.description,
      invocation: { tool: cmd.name, verb: cmd.verb },
      parameters: cmd.parameters,
    });
  }

  // 2. WASM tools from lib/wasm-shelf.mjs
  const resolvedWasmDir = wasmDir ?? shelfDir ?? wasmShelfDir();
  if (resolvedWasmDir && existsSync(resolvedWasmDir)) {
    const shelf = readShelf(resolvedWasmDir);
    if (shelf.ok) {
      for (const t of shelf.tools) {
        const wasmStatus = t.admitted && t.abi ? "ready" : (t.admitted ? "undriven-abi" : "refused");
        tools.push({
          id: `wasm:${t.id}`,
          name: t.id,
          kind: "wasm",
          category: t.capability || "compute",
          status: wasmStatus,
          description: t.description || `WASM module ${t.id}`,
          invocation: { tool: "call_extension", args: { name: t.id, input: "<text>" } },
          metadata: {
            digest: t.digest,
            capability: t.capability,
            abi: t.abi ?? null,
            ...(t.refused ? { refused: t.refused, why: t.why } : {}),
          },
        });
      }
    }
  }

  // 3. Extensions (admitted, proposed, catalogue)
  tools.push(...collectExtensionItems(extensions));

  // 4. System CLI binaries + workspace bin/scripts
  const searchPaths = buildSearchPaths(rootPath, env);
  const seenSystemNames = new Set();
  for (const item of SYSTEM_CLI_CATALOGUE) {
    const binPath = resolveBinaryOnPaths(item.name, searchPaths);
    if (!binPath) continue;
    seenSystemNames.add(item.name);
    tools.push({
      id: `system:${item.name}`,
      name: item.name,
      kind: "system",
      category: item.category,
      status: "ready",
      description: item.description,
      invocation: { tool: "run_command", args: { command: `${item.name} --help` } },
      metadata: { path: binPath, keywords: item.keywords ?? [] },
    });
  }

  if (rootPath && existsSync(rootPath)) {
    for (const sub of ["bin", "scripts"]) {
      const dir = path.join(rootPath, sub);
      if (!existsSync(dir)) continue;
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || !entry.isFile()) continue;
        const fullPath = path.join(dir, entry.name);
        const isScriptExt = /\.(mjs|js|sh|py)$/i.test(entry.name);
        if (!isExecutableFile(fullPath) && !isScriptExt) continue;
        if (seenSystemNames.has(entry.name)) continue;
        seenSystemNames.add(entry.name);
        const relPath = `${sub}/${entry.name}`;
        const runCmd = /\.(mjs|js)$/i.test(entry.name)
          ? `node ${relPath}`
          : /\.py$/i.test(entry.name)
            ? `python3 ${relPath}`
            : `./${relPath}`;
        tools.push({
          id: `system:${entry.name}`,
          name: entry.name,
          kind: "system",
          category: "project-tool",
          status: "ready",
          description: `Workspace script/executable at ${relPath}`,
          invocation: { tool: "run_command", args: { command: runCmd } },
          metadata: { path: fullPath, relativePath: relPath },
        });
      }
    }

    // 5. Project package.json scripts
    const pkgPath = path.join(rootPath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg?.scripts && typeof pkg.scripts === "object") {
          for (const [scriptName, scriptCmd] of Object.entries(pkg.scripts)) {
            if (typeof scriptCmd !== "string") continue;
            tools.push({
              id: `script:${scriptName}`,
              name: scriptName,
              displayName: `npm run ${scriptName}`,
              kind: "script",
              category: "project-script",
              status: "ready",
              description: `Project package.json script (npm run ${scriptName}): ${scriptCmd}`,
              invokeHint: `run_command({ command: "npm run ${scriptName}" })`,
              invocation: { tool: "run_command", args: { command: `npm run ${scriptName}` } },
              metadata: { script: scriptName, command: scriptCmd },
            });
          }
        }
      } catch {}
    }
  }

  // 6. Mini-App Web MCP tools
  const resolvedMiniAppTools = Array.isArray(miniAppTools)
    ? miniAppTools
    : (typeof miniAppTools?.getAllTools === "function"
      ? miniAppTools.getAllTools()
      : (typeof miniAppTools?.listTools === "function" ? miniAppTools.listTools() : []));
  for (const t of resolvedMiniAppTools ?? []) {
    if (!t?.name) continue;
    tools.push({
      id: `mini-app:${t.name}`,
      name: t.name,
      kind: "mini-app",
      category: "mini-app",
      status: "ready",
      description: t.description || `Mini-app Web MCP tool ${t.name}`,
      invocation: { tool: t.name },
      parameters: t.parameters ?? t.inputSchema ?? { type: "object", properties: {} },
      metadata: { appId: t.appId ?? null },
    });
  }

  // 7. Agent Harnesses
  const harnessList = Array.isArray(harnesses)
    ? harnesses
    : (Array.isArray(harnesses?.entries) ? harnesses.entries : DEFAULT_HARNESS_DEFINITIONS);
  const seenHarnesses = new Set();
  for (const h of harnessList) {
    const id = h?.id || h?.harness;
    if (!id || seenHarnesses.has(id)) continue;
    seenHarnesses.add(id);
    const hStatus = h.status || (h.available || (Array.isArray(h.configuredAgents) && h.configuredAgents.length > 0) ? "ready" : "available");
    tools.push({
      id: `harness:${id}`,
      name: h.name || id,
      kind: "harness",
      category: "agent-harness",
      status: hStatus,
      description: h.description || `Coding agent harness (${id}) for background task delegation`,
      invocation: { tool: "delegate_task", args: { agent: id, task: "<instructions>" } },
      metadata: {
        harness: id,
        configuredAgents: Array.isArray(h.configuredAgents) ? h.configuredAgents.length : 0,
      },
    });
  }

  const countsByKind = {
    native: 0,
    wasm: 0,
    extension: 0,
    system: 0,
    script: 0,
    "mini-app": 0,
    mini_app: 0,
    harness: 0,
  };
  for (const t of tools) {
    countsByKind[t.kind] = (countsByKind[t.kind] ?? 0) + 1;
    if (t.kind === "mini-app") countsByKind.mini_app = countsByKind["mini-app"];
  }

  const kindFilter = String(kind ?? "").trim().toLowerCase().replace(/_/g, "-");
  const categoryFilter = String(category ?? "").trim().toLowerCase();
  const statusFilter = String(status ?? "").trim().toLowerCase();

  const filtered = tools.filter((t) => {
    if (kindFilter && t.kind.toLowerCase() !== kindFilter) return false;
    if (categoryFilter && String(t.category ?? "").toLowerCase() !== categoryFilter) return false;
    if (statusFilter && String(t.status ?? "").toLowerCase() !== statusFilter) return false;
    return true;
  });

  return {
    ok: true,
    count: filtered.length,
    totalCount: tools.length,
    counts: countsByKind,
    countsByKind,
    tools: filtered,
  };
}

/**
 * Search the unified tool index by keyword, capability, or natural-language query.
 * Supports both `searchTools("query", options)` and `searchTools({ query, ...options })`.
 */
export function searchTools(queryOrOptions = {}, maybeOptions = {}) {
  const options = typeof queryOrOptions === "string"
    ? { ...maybeOptions, query: queryOrOptions }
    : (queryOrOptions ?? {});
  const {
    query = "",
    kind = "",
    category = "",
    status = "",
    limit = 25,
    ...context
  } = options;

  const base = listTools({ kind, category, status, ...context });
  const rawQuery = String(query ?? "").trim().toLowerCase();
  if (!rawQuery) {
    return {
      ok: true,
      query: "",
      count: base.tools.length,
      counts: base.countsByKind,
      countsByKind: base.countsByKind,
      tools: base.tools.slice(0, Math.max(1, Number(limit) || 25)),
    };
  }

  const rawTokens = rawQuery.split(/[\s,._/-]+/).filter(Boolean);
  const expandedTokens = new Set(rawTokens);
  for (const tok of rawTokens) {
    for (const syn of QUERY_SYNONYMS[tok] ?? []) {
      expandedTokens.add(syn.toLowerCase());
    }
  }
  if (rawQuery.includes("issue tracker")) {
    for (const syn of QUERY_SYNONYMS.tracker) expandedTokens.add(syn);
  }

  const scored = [];
  for (const tool of base.tools) {
    let score = 0;
    const nameLower = String(tool.name ?? "").toLowerCase();
    const displayLower = String(tool.displayName ?? "").toLowerCase();
    const idLower = String(tool.id ?? "").toLowerCase();
    const kindLower = String(tool.kind ?? "").toLowerCase();
    const catLower = String(tool.category ?? "").toLowerCase();
    const descLower = String(tool.description ?? "").toLowerCase();
    const keywords = (tool.metadata?.keywords ?? []).map((k) => String(k).toLowerCase());
    const scriptCmdLower = String(tool.metadata?.command ?? "").toLowerCase();

    if (nameLower === rawQuery || displayLower === rawQuery || idLower === rawQuery) score += 120;
    else if (nameLower.startsWith(rawQuery) || displayLower.startsWith(rawQuery)) score += 75;
    else if (nameLower.includes(rawQuery) || displayLower.includes(rawQuery)) score += 50;

    if (catLower === rawQuery || kindLower === rawQuery) score += 60;
    if (descLower.includes(rawQuery)) score += 35;

    for (const tok of expandedTokens) {
      if (nameLower === tok || idLower.endsWith(`:${tok}`)) score += 100;
      else if (nameLower.startsWith(tok)) score += 60;
      else if (nameLower.split(/[\s_:/-]+/).includes(tok)) score += 45;

      if (catLower === tok || kindLower === tok || catLower.includes(tok)) score += 40;
      if (keywords.includes(tok)) score += 55;
      if (descLower.includes(tok) || scriptCmdLower.includes(tok)) score += 20;
    }

    if (score > 0) {
      // Slight tie-breaker boost for ready/admitted tools
      if (tool.status === "ready" || tool.status === "admitted") score += 2;
      scored.push({ tool, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  const matches = scored.map((s) => s.tool);
  const matchCountsByKind = {};
  for (const t of matches) {
    matchCountsByKind[t.kind] = (matchCountsByKind[t.kind] ?? 0) + 1;
  }

  return {
    ok: true,
    query: String(query ?? ""),
    count: matches.length,
    counts: matchCountsByKind,
    countsByKind: matchCountsByKind,
    tools: matches.slice(0, Math.max(1, Number(limit) || 25)),
  };
}

/**
 * Create a bound tool index instance with default context options.
 */
export function createToolIndex(defaultOptions = {}) {
  return {
    list: (opts = {}) => listTools({ ...defaultOptions, ...opts }),
    listTools: (opts = {}) => listTools({ ...defaultOptions, ...opts }),
    search: (queryOrOpts = {}, maybeOpts = {}) =>
      typeof queryOrOpts === "string"
        ? searchTools(queryOrOpts, { ...defaultOptions, ...maybeOpts })
        : searchTools({ ...defaultOptions, ...queryOrOpts }),
    searchTools: (queryOrOpts = {}, maybeOpts = {}) =>
      typeof queryOrOpts === "string"
        ? searchTools(queryOrOpts, { ...defaultOptions, ...maybeOpts })
        : searchTools({ ...defaultOptions, ...queryOrOpts }),
    runCommand: (opts = {}) =>
      runSystemCommand(opts.rootPath ?? defaultOptions.rootPath, { ...defaultOptions, ...opts }),
    runSystemCommand: (opts = {}) =>
      runSystemCommand(opts.rootPath ?? defaultOptions.rootPath, { ...defaultOptions, ...opts }),
  };
}

function containedOrEqual(base, target) {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Execute an installed CLI tool or shell command inside the active project workspace.
 */
export async function runSystemCommand(
  rootPath,
  {
    command,
    cwd = "",
    timeoutMs = 20000,
    maxOutputBytes = 65536,
    env = process.env,
  } = {},
) {
  if (!rootPath || typeof rootPath !== "string" || !rootPath.trim()) {
    return {
      ok: false,
      refused: "root-not-declared",
      error: "refused: root-not-declared",
      why: "Declare or open a project workspace before running commands.",
    };
  }
  const cmdStr = typeof command === "string" ? command.trim() : "";
  if (!cmdStr) {
    return {
      ok: false,
      refused: "missing-argument",
      error: "refused: missing-argument",
      why: "run_command requires a non-empty command string.",
    };
  }

  let realRoot;
  try {
    realRoot = realpathSync(rootPath);
  } catch {
    return {
      ok: false,
      refused: "root-missing",
      error: "refused: root-missing",
      why: `Workspace root '${rootPath}' does not exist on disk.`,
    };
  }

  let targetCwd = realRoot;
  let normalizedRelCwd = ".";
  if (typeof cwd === "string" && cwd.trim() && cwd.trim() !== ".") {
    const trimmedCwd = cwd.trim();
    const resolvedCwd = path.resolve(realRoot, trimmedCwd);
    if (!containedOrEqual(realRoot, resolvedCwd)) {
      return {
        ok: false,
        refused: "outside-root",
        error: "refused: outside-root",
        why: `cwd '${cwd}' escapes the active project workspace.`,
      };
    }
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      return {
        ok: false,
        refused: "not-a-directory",
        error: "refused: not-a-directory",
        why: `cwd '${cwd}' does not exist or is not a directory inside the active workspace.`,
      };
    }
    const realCwd = realpathSync(resolvedCwd);
    if (!containedOrEqual(realRoot, realCwd)) {
      return {
        ok: false,
        refused: "outside-root",
        error: "refused: outside-root",
        why: `cwd '${cwd}' resolves outside the active project workspace.`,
      };
    }
    targetCwd = realCwd;
    normalizedRelCwd = path.relative(realRoot, realCwd).split(path.sep).join("/") || ".";
  }

  const searchPaths = buildSearchPaths(realRoot, env);
  const childEnv = {
    ...env,
    PATH: searchPaths.join(path.delimiter),
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };

  const startedAt = performance.now();
  return await new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmdStr], {
      cwd: targetCwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdoutBuf.length < maxOutputBytes) {
        const remaining = maxOutputBytes - stdoutBuf.length;
        stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, remaining)]);
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderrBuf.length < maxOutputBytes) {
        const remaining = maxOutputBytes - stderrBuf.length;
        stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, remaining)]);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        refused: "exec-failed",
        error: "refused: exec-failed",
        why: `Failed to spawn command: ${err?.message ?? err}`,
        command: cmdStr,
        cwd: normalizedRelCwd,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - startedAt);
      const stdout = stdoutBuf.toString("utf8").trim();
      const stderr = stderrBuf.toString("utf8").trim();
      const combined = stdout && stderr ? `${stdout}\n${stderr}` : (stdout || stderr);
      if (timedOut) {
        resolve({
          ok: false,
          refused: "command-timeout",
          error: "refused: command-timeout",
          why: `Command '${cmdStr}' timed out after ${timeoutMs}ms.`,
          command: cmdStr,
          cwd: normalizedRelCwd,
          exitCode: code ?? null,
          stdout,
          stderr,
          output: combined,
          durationMs,
        });
        return;
      }
      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0,
        ...(exitCode !== 0
          ? {
              refused: "command-failed",
              error: `command exited with code ${exitCode}`,
              why: stderr || stdout || `Command '${cmdStr}' exited with status ${exitCode}`,
            }
          : {}),
        command: cmdStr,
        cwd: normalizedRelCwd,
        exitCode,
        stdout,
        stderr,
        output: combined,
        durationMs,
        action: `ran: ${cmdStr} (exit ${exitCode})`,
      });
    });
  });
}
