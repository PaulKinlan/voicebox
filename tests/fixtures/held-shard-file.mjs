// Opt-in NODE_OPTIONS preload for the real-Chromium nested-runner timeout guard.
// Match argv[1], not any argument: the runner's --only flag names the same file but must not hang.
import { appendFileSync } from "node:fs";

if (process.env.VOICEBOX_SHARD_HELD_PID_FILE && process.argv[1]?.endsWith("tests/acp-browser.test.mjs")
    && process.execArgv.some((arg) => arg.startsWith("--test-isolation"))) {
  appendFileSync(process.env.VOICEBOX_SHARD_HELD_PID_FILE, `${process.pid}\n`);
  // Hold the nested file open until its owner sends SIGTERM; do not suppress the file's signal
  // reaper or test an unrelated child-side escalation here.
  setInterval(() => {}, 1000);
}
