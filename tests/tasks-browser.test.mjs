// Real browser + API + microphone/WebSocket transport; CLOSED HOST/VOICE FIXTURES, not ACP or ASR.
// The task witness is test instrumentation, not the unimplemented D8 task-card UI.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { gitEnv } from "../lib/git-env.mjs";
import { launch } from "./lib/cdp.mjs";
import { taskFixture } from "./lib/task-fixture.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
async function call(page, envKey, tool, args, callId) {
  return page.evaluate(async (key, name, values, id) => {
    const response = await fetch("/api/call", {
      method: "POST", headers: { "content-type": "application/json", ...(id ? { "x-voicebox-call-id": id } : {}) },
      body: JSON.stringify({ envKey: key, tool: name, args: values }),
    });
    return response.json();
  }, envKey, tool, args, callId);
}
async function witness(page, task, condition) {
  await page.evaluate((value, note) => {
    let box = document.querySelector("#d1-witness");
    if (!box) {
      box = document.createElement("section");
      box.id = "d1-witness";
      box.style.cssText = "margin:16px;padding:16px;border:2px solid currentColor;background:#fff;color:#111";
      document.body.prepend(box);
    }
    const title = document.createElement("h2");
    title.textContent = "D1 lifecycle witness — TEST INSTRUMENTATION, not the D8 UI";
    const label = document.createElement("p");
    label.textContent = `Closed host/voice fixtures; no ACP, paid model or speech recognition. ${note}`;
    const record = document.createElement("pre");
    record.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;max-height:none;overflow:visible";
    record.textContent = JSON.stringify(value, null, 2);
    box.replaceChildren(title, label, record);
  }, task, condition);
}

test("D1 browser: handle first, unrelated live transport/text turn, independent page, reload and observed environment death", { timeout: 60000 }, async (t) => {
  const output = process.env.VOICEBOX_D1_EVIDENCE ?? fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-d1-evidence-"));
  fs.mkdirSync(output, { recursive: true });
  const f = await taskFixture(t);
  const owner = await f.pair("browser fixture owner");
  const first = await launch({ width: 1100, height: 850, fakeMedia: true });
  let second;
  t.after(async () => { await first.close(); await second?.close(); });
  try {
    await first.send("Network.enable");
    await first.goto(f.server.base);
    const accepted = await call(first, owner.envKey, "delegate_task", { agent: "closed-fixture", task: "hold" }, "browser-admission");
    assert.equal(accepted.ok, true);
    assert.equal(accepted.task.state, "queued");
    const address = accepted.task.address;
    await witness(first, accepted.task, "Admission returned while the task is held open.");
    await first.screenshot(path.join(output, "01-handle-before-completion.png"), { fullPage: true });

    // Actual UI click -> real browser capture/worklet -> binary /live frame -> fixed fixture reply.
    const productCaptionMissing = await first.evaluate(() => !document.getElementById("caption"));
    await first.click("#mic");
    let audioReply;
    for (let i = 0; i < 125 && !audioReply; i++) {
      for (const frame of first.events("Network.webSocketFrameReceived")) {
        if (frame.response.opcode !== 1) continue;
        const message = JSON.parse(frame.response.payloadData);
        if (message.type === "text" && message.text.includes("fixture received an audio frame")) audioReply = message.text;
      }
      if (!audioReply) await delay(120);
    }
    assert.ok(audioReply, "actual microphone transport must yield an observed /live reply frame");
    assert.equal(await first.evaluate(() => window.__voiceboxLiveClient.snapshot().capture), true);
    const held = await call(first, owner.envKey, "task_status", { address });
    assert.equal(held.task.state, "running");
    await witness(first, { ...held.task, cdpObservedAudioReply: audioReply }, `Real microphone transport answered while the task remained running; fake-media input, not ASR. Raw CDP frame witnessed.${productCaptionMissing ? " Product HTML has no #caption (sor)." : ""}`);
    await first.screenshot(path.join(output, "02-live-transport-while-running.png"), { fullPage: true });
    await first.click("#mic");

    // A second, unrelated /live text turn is answered without waiting for the task.
    const liveText = await first.evaluate(() => new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/live`);
      const timer = setTimeout(() => { socket.close(); reject(new Error("fixture live turn timed out")); }, 5000);
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const msg = JSON.parse(event.data);
        if (msg.type === "state" && msg.state === "ready") socket.send(JSON.stringify({ type: "text", text: "unrelated turn while task is held" }));
        if (msg.type === "text" && msg.text.includes("unrelated turn")) { clearTimeout(timer); socket.close(); resolve(msg.text); }
      };
      socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error("fixture live socket failed")); };
    }));
    assert.match(liveText, /fixture voice turn: unrelated turn/);
    await first.type("#utterance", "list files");
    await first.click("#send");
    await first.waitFor(() => document.querySelector("#turn-report")?.dataset.tone === "good", { label: "unrelated native text form turn completed" });
    assert.equal((await call(first, owner.envKey, "task_status", { address })).task.state, "running");

    await first.reload();
    const reloaded = await call(first, owner.envKey, "task_status", { address });
    assert.equal(reloaded.task.state, "running");
    await witness(first, reloaded.task, "Page reloaded; this is a fresh server read, not restored browser task state.");
    await first.screenshot(path.join(output, "03-reload-retains-record.png"), { fullPage: true });

    // Entirely new Chrome/profile, not the first tab's reconnect. It receives no bearer.
    second = await launch({ width: 1100, height: 850 });
    await second.goto(f.server.base);
    await first.close();
    const independent = await call(second, owner.envKey, "task_status", { address });
    assert.equal(independent.task.state, "running");
    assert.equal(independent.task.address, address);
    await witness(second, independent.task, "Independent browser/profile resolves the first connection's address after that browser closes.");
    await second.screenshot(path.join(output, "04-independent-browser.png"), { fullPage: true });

    await f.stop();
    await f.start();
    await second.goto(f.server.base);
    const interrupted = await call(second, owner.envKey, "task_status", { address });
    assert.equal(interrupted.task.state, "interrupted");
    assert.equal(interrupted.task.reason, "environment-ended-outcome-unknown");
    assert.equal(f.starts().length, 1);
    await witness(second, interrupted.task, "Owned environment process killed and restarted against the same state. Interrupted, one dispatch, no replay.");
    await second.screenshot(path.join(output, "05-interrupted-not-replayed.png"), { fullPage: true });

    fs.writeFileSync(path.join(output, "browser-receipt.json"), JSON.stringify({
      scope: "author real-browser/HTTP/process acceptance with closed host and voice fixtures; not ACP, real-model, ASR or D8 UI acceptance",
      base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, env: gitEnv(), encoding: "utf8" }).trim(),
      dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, env: gitEnv(), encoding: "utf8" }).trim()),
      acceptedState: accepted.task.state, midTaskState: held.task.state,
      cdpObservedAudioReply: audioReply, productCaptionMissing, unrelatedLiveText: liveText, nativeTextFormCompleted: true,
      reloadState: reloaded.task.state, independentBrowserState: independent.task.state,
      afterRestart: interrupted.task.state, reason: interrupted.task.reason, actualDispatches: f.starts().length,
      pairingCondition: "same owned host paired through its real proxy/execute routes; different browser profiles; no bearer delivered to pages; ephemeral origin updated by fixture host on restart",
      screenshots: ["01-handle-before-completion.png", "02-live-transport-while-running.png", "03-reload-retains-record.png", "04-independent-browser.png", "05-interrupted-not-replayed.png"],
    }, null, 2));
  } catch (error) {
    try { await (second ?? first).screenshot(path.join(output, "browser-failure.png"), { fullPage: true }); } catch {}
    throw error;
  }
});
