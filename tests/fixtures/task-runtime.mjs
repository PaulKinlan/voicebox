// HOST-ONLY TEST PRELOAD. Not a configured agent, ACP adapter, sandbox, or model.
// Fixed task labels, no eval/spawn/network. The only fixture IO is beneath its owned controls dir.
import fs from "node:fs";
import path from "node:path";
import { installTaskExecutor } from "../../lib/tasks.mjs";
import { registerLiveProvider } from "../../lib/live-session.mjs";

const controls = process.env.VOICEBOX_TASK_FIXTURE;
if (!controls) throw new Error("the task fixture needs its own controls directory");
fs.mkdirSync(controls, { recursive: true });
const starts = path.join(controls, "starts.jsonl");

installTaskExecutor({
  check({ input }) {
    if (input.agent === "unbounded-cli") return { ok: false, refused: "unbounded-executor", why: "a configured CLI has no observed boundary; descriptor metadata does not sandbox an agent" };
    if (input.agent !== "closed-fixture" || !["hold", "finish"].includes(input.task)) return { ok: false, refused: "executor-unavailable", why: "only the two fixed lifecycle fixture tasks exist" };
    return { ok: true, mechanism: "closed-host-fixture: no untrusted code, no task filesystem/network/CLI access", bounds: { deadlineMs: 120000, maxOutputBytes: 128 } };
  },
  run({ input, signal }) {
    const auditDir = path.join(process.env.VOICEBOX_WORKSPACE, ".audit");
    const events = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n").map(JSON.parse));
    const admitted = events.findLast((e) => e.task?.created?.input.task === input.task);
    const running = admitted && events.some((e) => e.task?.address === admitted.task.address && e.task.state === "running");
    if (!admitted || !running) throw new Error("fixture dispatch preceded persisted admission/running record");
    fs.appendFileSync(starts, JSON.stringify({ task: input.task, admissionOnDiskBeforeDispatch: true, runningOnDiskBeforeDispatch: true }) + "\n");
    if (input.task === "finish") return "closed fixture completed";
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearInterval(timer); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(new Error("fixture aborted")); };
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(controls, "release"))) { cleanup(); resolve("held fixture completed"); }
      }, 20);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  },
});

// Exercise the real /live transport/concurrency without paid credentials or a claim of ASR.
registerLiveProvider("gemini", ({ emit }) => ({
  start() { queueMicrotask(() => { emit({ type: "transport-open" }); emit({ type: "ready" }); }); },
  sendText(text) { emit({ type: "output-text", text: `fixture voice turn: ${text}` }); },
  sendAudio() { emit({ type: "output-text", text: "fixture received an audio frame; this is not speech recognition" }); },
  sendToolResponse() {},
  interrupt() {},
  close() { emit({ type: "closed", code: 1000, reason: "fixture closed" }); },
}));
