// lib/project-instruction.mjs — reads the project's own instruction file (AGENT.md, then
// AGENTS.md) from INSIDE the declared machine root, bounded, with named outcomes.
//
// WHY ROOT-SCOPED AND NAMED. The instruction becomes part of the system prompt, so the file it
// comes from must be inside the containment boundary the host declared — a root-scoped resolve
// first, and a refusal keeps its name (`..` refused, absolute refused). The outcome is always
// named: which file was read, or exactly why none was (no root, no such file, unreadable).
//
// THE NAMED LIMIT: read at session start, bounded at 32 KiB, truncation named. A file changed
// mid-session applies at the next session; the reader does not watch the file.
import { readFileSync } from "node:fs";
import { resolveInsideRoot } from "../core/paths.ts";

const NAMES = ["AGENT.md", "AGENTS.md"];
const MAX_BYTES = 32768;

/**
 * @param {string} rootPath - the declared MACHINE root's path (page-held roots live in the
 *                            browser and carry no server-side instruction file).
 * @returns {{ file: string, text: string, truncated: boolean }
 *          | { file: null, reason: string }}
 */
export function readProjectInstruction(rootPath) {
  if (typeof rootPath !== "string" || !rootPath) {
    return { file: null, text: null, reason: "no project root is declared, so no project instruction is read" };
  }
  for (const name of NAMES) {
    const resolved = resolveInsideRoot(rootPath, name);
    if (!resolved.ok) continue; // an escape attempt is a wrong-shaped candidate, not the file
    let raw;
    try { raw = readFileSync(resolved.path, "utf8"); }
    catch (err) {
      if (err.code === "ENOENT") continue; // this name is simply absent; try the next
      // An UNREADABLE file is the named refusal (EACCES and friends): it exists but the
      // process may not read it — never silently omitted, never treated as absent.
      return { file: name, text: null, reason: `${name} is unreadable (${err.code ?? err.message})` };
    }
    if (!raw.trim()) continue; // an empty file is no instruction
    const bytes = Buffer.byteLength(raw, "utf8");
    return {
      file: name,
      text: raw.slice(0, MAX_BYTES),
      truncated: bytes > MAX_BYTES,
    };
  }
  return { file: null, text: null, reason: "no AGENT.md or AGENTS.md at the project root" };
}
