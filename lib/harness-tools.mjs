// Operator-declared catalogue data, never tool execution or session permission evidence.
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const MAX_BYTES = 256 * 1024;
function text(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
}

export async function readHarnessTools(file, harnessIds) {
  const unknown = (why) => Object.fromEntries(harnessIds.map((id) => [id, { status: "unknown", why }]));
  if (!file) return unknown("No tool metadata supplied. Set VOICEBOX_HARNESS_TOOLS on the server to a catalogue file; ACP does not enumerate a harness's tools.");
  if (!path.isAbsolute(file)) return unknown("Tool metadata path must be absolute. Correct VOICEBOX_HARNESS_TOOLS on the server.");
  let handle, raw;
  try {
    // Nonblocking + regular-file check refuses FIFOs/devices; never follow a metadata symlink.
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("not bounded regular data");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error("metadata grew beyond its bound");
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return unknown("Tool metadata unavailable. Supply a readable regular file (no symlink), at most 256 KiB, in VOICEBOX_HARNESS_TOOLS on the server.");
  } finally {
    await handle?.close();
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid catalogue");
    const result = unknown("No tool metadata declared for this harness. Add its entry to the server's VOICEBOX_HARNESS_TOOLS file.");
    for (const [id, catalogue] of Object.entries(data)) {
      if (!harnessIds.includes(id) || !catalogue || !text(catalogue.source, 512) ||
          !text(catalogue.scope, 1024) || !Array.isArray(catalogue.tools) || catalogue.tools.length > 128) {
        throw new Error("invalid harness entry");
      }
      const names = new Set();
      const tools = catalogue.tools.map((tool) => {
        if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(tool.name) ||
            names.has(tool.name) || !text(tool.description, 4096)) throw new Error("invalid tool entry");
        names.add(tool.name);
        // Project only the display fields. Config, arguments, credentials and extra fields do not belong here.
        return { name: tool.name, description: tool.description };
      });
      result[id] = { status: "declared", source: catalogue.source, scope: catalogue.scope, tools };
    }
    return result;
  } catch {
    // No raw parser errors, file paths or supplied content in the public response.
    return unknown("Tool metadata invalid. Check the catalogue format in the harness inventory guide, correct the file, then retry after the 60-second cache expires.");
  }
}
