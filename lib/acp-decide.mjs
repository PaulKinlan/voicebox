/**
 * @summary The permission decision an ACP agent's tool requests get: the agent row's declared reach, then the host's decider, else the workspace boundary.
 */
// One decision for every ACP agent that is not Pi (voicebox-beads-cwx5.10). It was written inside the Claude
// executor; the config-driven executor (lib/acp-agents.mjs) needs the same answer, and two copies of an
// authority check drift. Moved verbatim, with the agent's label and the host decider passed in.
//
// ORDER: (1) a tool outside the agent row's `reach.tools` is refused by name before anything else is asked;
// (2) a host that supplied its own decider decides; (3) otherwise a request is allowed only when every path it
// names stays inside the task's working directory or the system temp directory.
import os from "node:os";
import path from "node:path";
import { containedIn } from "./path-auth.mjs";

/**
 * `cwd` is the task's working directory (the active root). `agentConfig.reach.tools`, when non-empty, is the
 * allowlist. `report(note)` receives a "using tool" progress line. Returns `decide(asked)` for createAcpClient.
 */
export function createWorkspaceDecide({ cwd, agentConfig = null, report = null, agentLabel = "agent", hostDecide = null }) {
  const allowedTools = Array.isArray(agentConfig?.reach?.tools) && agentConfig.reach.tools.length > 0
    ? new Set(agentConfig.reach.tools)
    : null;
  const decide = async (asked) => {
    if (allowedTools !== null) {
      const toolName = (typeof asked?.toolCall?.name === "string" && asked.toolCall.name.trim()) ||
        (typeof asked?.toolCall?.title === "string" && asked.toolCall.title.trim() && !asked.toolCall.title.includes(" ") ? asked.toolCall.title.trim() : null);
      const nameLower = toolName ? toolName.toLowerCase() : "";
      let allowed = false;
      if (toolName && allowedTools.has(toolName)) {
        allowed = true;
      } else if (nameLower && allowedTools.has(nameLower)) {
        allowed = true;
      } else if (toolName) {
        const isReadOrList = ["read", "glob", "grep", "ls"].includes(nameLower);
        const isWriteOrEdit = ["write", "edit", "multiedit", "notebookedit"].includes(nameLower);
        const isBash = nameLower === "bash";
        if (isReadOrList && (allowedTools.has("read") || allowedTools.has("list"))) {
          allowed = true;
        } else if (isWriteOrEdit && (allowedTools.has("write") || allowedTools.has("edit"))) {
          allowed = true;
        } else if (isBash && allowedTools.has("bash")) {
          allowed = true;
        }
      }
      if (!allowed) {
        return { allow: false, reason: `tool-not-in-agent-reach: tool '${toolName ?? "unknown"}' is not in declared reach [${Array.from(allowedTools).join(", ")}]` };
      }
    }
    if (typeof asked?.toolCall?.title === "string" && asked.toolCall.title.trim()) {
      try { report?.(`${agentLabel}: using tool ${asked.toolCall.title.trim()}`); } catch {}
    }
    if (typeof hostDecide === "function") return hostDecide(asked);

    const candidatePaths = [];
    if (Array.isArray(asked?.toolCall?.locations)) {
      for (const loc of asked.toolCall.locations) {
        const raw = typeof loc?.path === "string" ? loc.path : (typeof loc?.uri === "string" && loc.uri.startsWith("file://") ? loc.uri.slice(7) : null);
        if (raw && raw.trim()) candidatePaths.push(raw.trim());
      }
    }
    if (typeof asked?.toolCall?.rawInput?.file_path === "string" && asked.toolCall.rawInput.file_path.trim()) {
      candidatePaths.push(asked.toolCall.rawInput.file_path.trim());
    }
    if (typeof asked?.toolCall?.rawInput?.path === "string" && asked.toolCall.rawInput.path.trim()) {
      candidatePaths.push(asked.toolCall.rawInput.path.trim());
    }

    const tmpDir = os.tmpdir();
    for (const p of candidatePaths) {
      const resolved = path.resolve(cwd, p);
      if (!containedIn(cwd, resolved, { allowEqual: true }) &&
          !containedIn(tmpDir, resolved, { allowEqual: true }) &&
          !containedIn("/tmp", resolved, { allowEqual: true })) {
        return { allow: false, reason: `outside-workspace-root: path '${p}' escapes workspace '${cwd}'` };
      }
    }
    return { allow: true, reason: "workspace-delegated-task" };
  };
  return decide;
}
