// Subprocess-only process-ownership fixture: models a shard runner that owns two detached groups.
// It is not a top-level .test.mjs file and never enters the browser lane.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.VOICEBOX_C0IN_FIXTURE_DIR;
if (!dir) throw new Error("VOICEBOX_C0IN_FIXTURE_DIR required");
const token = `voicebox-c0in-${process.pid}`;
const startGroup = (role) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", `${token}-${role}`], {
  detached: true, stdio: "ignore",
});
const warm = startGroup("warm");
const file = startGroup("file");
const profile = mkdtempSync(path.join(dir, "voicebox-shard-chrome-"));
writeFileSync(path.join(dir, "pids.json"), JSON.stringify({ runner: process.pid, warm: warm.pid, file: file.pid, profile, token }));
process.once("SIGTERM", () => {
  for (const child of [warm, file]) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(profile, { recursive: true, force: true });
  process.exit(143);
});
console.log("[shards] running synthetic held file");
setInterval(() => {}, 1000);
