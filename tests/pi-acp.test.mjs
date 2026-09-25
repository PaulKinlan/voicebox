import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createPiAcpExecutor, openPiAcpProbe } from "../lib/pi-acp.mjs";
import { ACP_AGENT } from "../lib/acp-client.mjs";
import { TaskInterrupted } from "../lib/task-interrupted.mjs";
import { freshExecute, taskFixture } from "./lib/task-fixture.mjs";

const config = { adapterDir: process.env.VOICEBOX_ACP_ADAPTER, piBinary: process.env.VOICEBOX_ACP_PI };
const skip = !config.adapterDir || !config.piBinary ? "real pi-acp diagnostic requires VOICEBOX_ACP_ADAPTER and VOICEBOX_ACP_PI; no provider acceptance" : false;
async function until(read, predicate) {
  for (let i = 0; i < 400; i++) { const value = await read(); if (predicate(value)) return value; await delay(20); }
  assert.fail("owned ACP diagnostic did not settle");
}

test("pi-acp real executor admits configured Pi and refuses unconfigured harnesses", async () => {
  const executor = createPiAcpExecutor(config);
  const claudeRefusal = executor.check({ input: { agent: "claude", task: "help" } });
  assert.equal(claudeRefusal.refused, "adapter-not-configured");
  assert.match(claudeRefusal.why, /No Voicebox task adapter is configured/);

  const unknownRefusal = executor.check({ input: { agent: "unknown-bot", task: "help" } });
  assert.equal(unknownRefusal.refused, "adapter-not-configured");

  const piAdmission = executor.check({ input: { agent: "pi", task: "calculate" } });
  if (config.adapterDir && config.piBinary) {
    assert.equal(piAdmission.ok, true);
    assert.equal(piAdmission.mechanism, "stdio-acp-client: pi-acp adapter with pi coding agent");
    assert.ok(piAdmission.bounds.deadlineMs > 0);
    assert.ok(piAdmission.bounds.maxOutputBytes > 0);
  }
});

test(`real ${ACP_AGENT.name} ${ACP_AGENT.version} / pi ${ACP_AGENT.piVersion}: isolated handshake, auth refusal, actual death and version mismatch`, { skip, timeout: 40000 }, async (t) => {
  const probe = await openPiAcpProbe(config);
  t.after(() => probe.close());
  assert.equal(probe.info.protocolVersion, 1);
  assert.equal(probe.info.agentInfo.version, ACP_AGENT.version);
  await assert.rejects(probe.newSession(), { refused: "acp-authentication-required" });
  process.kill(probe.pid, "SIGKILL");
  const ended = await probe.exited;
  assert.ok(ended.outcome instanceof TaskInterrupted);
  assert.equal(ended.outcome.refused, "harness-ended-outcome-unknown");
  assert.throws(() => process.kill(probe.pid, 0), { code: "ESRCH" });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-acp-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-acp", version: "999" }));
  await assert.rejects(openPiAcpProbe({ ...config, adapterDir: dir }), { refused: "adapter-version-unsupported" });
  // pi --version reads its adjacent manifest; check the actual binary in an altered install.
  fs.copyFileSync(fs.realpathSync(config.piBinary), path.join(dir, "pi"), fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(path.join(dir, "pi"), 0o700);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "999" }));
  await assert.rejects(openPiAcpProbe({ ...config, piBinary: path.join(dir, "pi") }), { refused: "harness-version-unsupported" });
});

test("D1 real TCP diagnostic only: killed ACP process is interrupted and second connection reads without replay", { skip, timeout: 40000 }, async (t) => {
  const runtime = fileURLToPath(new URL("./fixtures/acp-diagnostic-runtime.mjs", import.meta.url));
  const f = await taskFixture(t, { runtime });
  const owner = await f.pair("diagnostic owner");
  const other = await f.pair("other owner");
  const base = f.server.base;
  const refused = await freshExecute(base, owner, "delegate_task", { agent: "claude", task: "real task is NOT admitted" }, "refused");
  assert.equal(refused.body.refused, "adapter-not-configured");
  const startsFile = path.join(f.controls, "acp-starts.jsonl");
  assert.equal(fs.existsSync(startsFile), false);
  const input = { agent: "diagnostic-only", task: "hold an isolated handshake, no model task" };
  const admitted = await freshExecute(base, owner, "delegate_task", input, "diagnostic-call");
  assert.equal(admitted.body.task.state, "queued");
  const starts = () => fs.existsSync(startsFile) ? fs.readFileSync(startsFile, "utf8").trim().split("\n").map(JSON.parse) : [];
  const [start] = await until(starts, (list) => list.length === 1);
  t.after(() => { try { process.kill(start.pid, "SIGKILL"); } catch {} });
  assert.equal(start.agentInfo.version, ACP_AGENT.version);
  const address = admitted.body.task.address;
  const second = await freshExecute(base, owner, "task_status", { address });
  assert.notEqual(second.localPort, admitted.localPort);
  assert.equal(second.body.task.state, "running");
  assert.equal((await freshExecute(base, other, "task_status", { address })).body.refused, "task-owner-mismatch");
  process.kill(start.pid, "SIGKILL");
  const done = await until(() => freshExecute(base, owner, "task_status", { address }), (r) => r.body.task?.state === "interrupted");
  assert.equal(done.body.task.reason, "harness-ended-outcome-unknown");
  assert.throws(() => process.kill(start.pid, 0), { code: "ESRCH" });
  const repeat = await freshExecute(base, owner, "delegate_task", input, "diagnostic-call");
  assert.equal(repeat.body.task.address, address);
  assert.equal(repeat.body.task.state, "interrupted");
  assert.equal(starts().length, 1);
});
