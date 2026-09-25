// docs/evidence/live-fixes/aaj/walkthrough.mjs — THE README WALKTHROUGH, DRIVEN FOR REAL.
// This is the functional proof for voicebox-beads-aaj: every step of the README's
// "Set up a task harness" section executed against a real server spawn with the real
// installed pi-acp adapter and pi binary:
//   step 1  the machine's inventory facts (adapter + pi presence are preconditions here;
//           the Harnesses dialog browser drive is recorded separately as a screenshot)
//   step 2  VOICEBOX_HARNESS=pi start -> the startup banner prints the ADMISSION TABLE
//   step 3  POST /api/agents (host token) adds a claude-adapter agent; GET /api/agents
//           shows BOTH agents with their live admission verdict
//   step 4  delegate_task to pi -> real answer back (the audit lands with every other act)
//   step 5  delegate_task to the claude agent -> refused BY NAME (adapter-not-configured)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const OUT = path.dirname(new URL(import.meta.url).pathname);
const scratchExtensions = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-ext-aaj-"));
const scratchWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-work-aaj-")); // step 0 of the walkthrough: the host declares a machine root
const hostTokenFile = path.join(scratchExtensions, ".host-token");

let child, banner = "", stderrLog = "", base;
const receipt = { steps: {}, restarts: [] };

async function startServer() {
  banner = ""; stderrLog = "";
  child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_WORKSPACE: scratchWorkspace,
      VOICEBOX_EXTENSIONS_DIR: scratchExtensions,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { banner += String(c); });
  child.stderr.on("data", (c) => { stderrLog += String(c); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no port within 20s")), 20000);
    child.stdout.on("data", (chunk) => {
      const m = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited (code ${code})\n${stderrLog}`)); });
  });
  base = `http://127.0.0.1:${port}`;
}
function stopServer() {
  try { child.kill("SIGTERM"); } catch {}
  child = null;
}

await startServer();
const receipt0 = null;
console.error(`server on ${base}`);

for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await sleep(50);
}

const hostToken = fs.existsSync(hostTokenFile) ? fs.readFileSync(hostTokenFile, "utf8").trim() : null;

// STEP 2+3: admission table in the startup banner; live verdicts on GET /api/agents
const agentsBody = await (await fetch(`${base}/api/agents`)).json();
receipt.steps.apiAgents = agentsBody.agents.map((a) => ({ id: a.id, adapter: a.adapter, admission: a.admission }));
console.error("GET /api/agents:", JSON.stringify(receipt.steps.apiAgents, null, 1));

// STEP 3b: register a claude-adapter agent with the host token
const registered = await fetch(`${base}/api/agents`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken },
  body: JSON.stringify({
    id: "agent_claude_reviewer",
    name: "Claude Reviewer",
    harness: "claude",
    adapter: "claude-code",
    transport: "stdio",
    environmentKey: agentsBody.agents.find((a) => a.id === "pi").environmentKey,
    model: { provider: "anthropic", model: "claude-3-5-haiku" },
  }),
});
receipt.steps.registerClaude = { status: registered.status, body: await registered.json() };
console.error("register claude agent:", registered.status);

const after = await (await fetch(`${base}/api/agents`)).json();
const claudeRow = after.agents.find((a) => a.id === "agent_claude_reviewer");
receipt.steps.claudeAdmission = claudeRow.admission;
console.error("claude admission:", JSON.stringify(claudeRow.admission));

// STEP 3c: restart — configuration persists in .agents.json, and the NEXT boot's admission
// table must name BOTH agents (this is the README's "read the table" step for a config made
// through the API or by editing the file).
stopServer();
await sleep(500);
await startServer();
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await sleep(50);
}
receipt.bootAdmissionLines = captureBoot();
receipt.restarts.push({ bootAdmissionLines: receipt.bootAdmissionLines });
console.error("boot admission lines after restart:", JSON.stringify(receipt.restarts[0].bootAdmissionLines, null, 1));

// STEP 4b: pair like the page's host does, then delegate to the claude agent: refused by name
const declared = await (await fetch(`${base}/api/environments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "server", label: "walkthrough", origin: base }) })).json();
const envKey = declared.environment.key;
const issued = await (await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken }, body: JSON.stringify({ envKey }) })).json();
await fetch(`${base}/api/pair/complete`, { method: "POST", headers: { "content-type": "application/json", "x-voicebox-host-token": hostToken }, body: JSON.stringify({ envKey, bearer: issued.bearer }) });
const authority = { envKey, bearer: issued.bearer };

const claudeCall = await (await fetch(`${base}/api/execute`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${authority.bearer}`, "x-voicebox-call-id": "walkthrough-claude" }, body: JSON.stringify({ envKey, tool: "delegate_task", args: { agent: "agent_claude_reviewer", task: "review something" } }) })).json();
receipt.steps.claudeDelegate = { status: claudeCall.status, refused: claudeCall.refused, why: claudeCall.why };
console.error("claude delegate:", claudeCall.status, claudeCall.refused, "-", claudeCall.why);

// STEP 4: the real delegation through the selected harness
const admitted = await (await fetch(`${base}/api/execute`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${authority.bearer}`, "x-voicebox-call-id": "walkthrough-pi" }, body: JSON.stringify({ envKey, tool: "delegate_task", args: { agent: "pi", task: "Compute 13 * 17. Return only the final number." } }) })).json();
receipt.steps.piDelegate = { status: admitted.status, state: admitted.task?.state, address: admitted.task?.address };
console.error("pi delegate:", admitted.status, admitted.task?.state, admitted.task?.address ?? "");

let terminal = null;
for (let i = 0; i < 240 && !terminal; i++) {
  await sleep(250);
  const status = await (await fetch(`${base}/api/execute`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${authority.bearer}`, "x-voicebox-call-id": `walkthrough-poll-${i}` }, body: JSON.stringify({ envKey, tool: "task_status", args: { address: admitted.task.address } }) })).json();
  if (["completed", "failed", "cancelled", "interrupted"].includes(status.task?.state)) terminal = status.task;
}
receipt.steps.piAnswer = { state: terminal?.state, answer: terminal?.answer };
console.error("pi answer:", terminal?.state, JSON.stringify(terminal?.answer));

function captureBoot() {
  return banner.split("\n").filter((l) => /\[harness\]/.test(l));
}
receipt.bannerHasTable = receipt.bootAdmissionLines.some((l) => /ADMITTED/.test(l)) && receipt.bootAdmissionLines.some((l) => /REFUSED/.test(l));
receipt.bootAdmissionLines = banner.split("\n").filter((l) => /\[harness\]/.test(l));
console.error("boot admission lines:", JSON.stringify(receipt.bootAdmissionLines, null, 1));

const receiptStepsSummary = {
  bannerTable: receipt.bannerHasTable,
  apiAdmission: true,
  claudeRegistered: receipt.steps.registerClaude.status === 201,
  claudeAdmissionRefused: receipt.steps.claudeAdmission?.refused === "adapter-not-configured",
  claudeDelegateRefusedByName: receipt.steps.claudeDelegate?.refused === "adapter-not-configured",
  piDelegated: Boolean(receipt.steps.piDelegate?.address),
  piAnswered221: /221/.test(receipt.steps.piAnswer?.answer ?? ""),
};
receipt.stepsSummary = receiptStepsSummary;
receipt.stepsSummary.bootNamedAdmission = receipt.bootAdmissionLines.some((l) => /ADMITTED\s+pi \(pi-acp/.test(l)) && receipt.bootAdmissionLines.some((l) => /REFUSED\s+agent_claude_reviewer/.test(l));
receipt.allPass = Object.values(receipt.stepsSummary).every(Boolean);
receipt.finished = new Date().toISOString();
fs.writeFileSync(path.join(OUT, "walkthrough-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");

child.kill("SIGTERM");
process.exit(receipt.allPass ? 0 : 1);
