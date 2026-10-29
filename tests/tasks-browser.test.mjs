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

test("D1 browser: handle first, unrelated live transport/text turn, independent page, reload and observed environment death", { timeout: 120000 }, async (t) => {
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
    // WHAT THIS ARM WAITS ON, AND WHY IT CHANGED (voicebox-beads-18lh). The union gate failed here with a bare
    // "timed out waiting for unrelated native text form turn completed; last value false", so the first thing
    // measured was whether that deadline was simply too small for the shard queue. It is not: driven four-way
    // with six CPU burners beside it (loadavg 7.05 on 8 vCPU, against the 8.5 the union gate recorded), the
    // turn itself settled after 564ms, 604ms, 564ms and 776ms - about 20x inside the 15s default it was using.
    // The deadline was never the defect here and is not raised as if it were.
    //
    // What the arm DID get wrong is the observable:
    //
    //   1. It waited for ONE of the report's two terminal values. The page writes its own refusals as
    //      `tone === "bad"` WITH a sentence in the same element, so a refusal and a turn that never finished
    //      produced the identical silent timeout. A failure has to say what the page said - the rule
    //      tests/ux-bubble-stage.test.mjs records as voicebox-beads-rtsr. Driven: with `/api/turn` answering 503
    //      the arm now fails with `#turn-report says {"tone":"bad","text":"“list files” the turn did not reach
    //      the server: closed box: the turn route is refusing"}`, where the old form printed "last value false".
    //   2. A good report LINGERS - `setReport` keeps it for REPORT_FADE_DELAY_MS (8s) before clearing it - so a
    //      report left by an earlier turn could satisfy the wait with no new turn at all. The page prepends one
    //      `#session-log` entry per finished turn and never clears that list, so the wait is anchored to a NEW
    //      entry for THIS turn as well as to a settled report. Driven: with a stale good report planted and no
    //      turn sent, the old predicate is satisfied and the new one is not.
    //   3. Nothing asserted that the click had reached the page at all. The submit handler clears `#utterance`
    //      synchronously in the click's own task, so the field is read before the click (after typing, where a
    //      lost click would leave the field empty and `#send` disabled) and re-read straight after it. A real
    //      mouse click that an overlay swallows now fails on that read with the page's state attached, instead
    //      of looking exactly like a slow turn.
    //
    // The settle deadline is 30s - about 40x the measured settle - and is stated rather than inherited so a
    // stuck arm cannot silently take the CDP default; the test's own bound is sized to accommodate it. It is
    // not the fix and is not claimed as one.
    const TEXT_TURN_SETTLE_MS = 30_000;
    await first.type("#utterance", "list files");

    // PRECONDITION, WAITED TOO (voicebox-beads-i9k0). `page.type` clicks the field and then inserts, so a lost
    // click and a late insert look identical the instant afterwards: the 2026-10-29 02:15 full gate read `''`
    // here at load 6.5 while the same file passed standalone. Waiting for the text distinguishes "the insert has
    // not landed yet" (a slow box) from "it never will" (a lost click, which now fails as a named timeout).
    // `#send` is then read, not waited, because both values persist until the form submits.
    await first.waitFor(() => document.querySelector("#utterance")?.value === "list files", { label: "the text form to hold the typed turn" });
    const beforeSend = await first.evaluate(() => ({
      text: document.querySelector("#utterance")?.value ?? null,
      sendDisabled: document.querySelector("#send")?.disabled ?? null,
    }));
    assert.equal(
      beforeSend.text,
      "list files",
      "the text form must hold the turn text before it is sent: page.type clicks the field and then inserts, so an empty field means the typing lost the click",
    );
    assert.equal(
      beforeSend.sendDisabled,
      false,
      "and #send must be able to act on it: it is disabled whenever the field is empty, so a click here would do nothing at all",
    );

    // EVIDENCE FIRST: whatever goes wrong, the next reader gets the page's own state, the page's own /live
    // frames and a screenshot, instead of "last value false" (voicebox-beads-rtsr).
    const turnsBefore = await first.evaluate(() => document.querySelectorAll("#session-log li").length);
    const turnEvidence = async () => {
      const seen = await first.evaluate(() => ({
        formSubmitted: document.querySelector("#utterance")?.value === "",
        utteranceText: document.querySelector("#utterance")?.value ?? null,
        sendLabel: document.querySelector("#send")?.textContent ?? null,
        sendDisabled: document.querySelector("#send")?.disabled ?? null,
        reportTone: document.querySelector("#turn-report")?.dataset.tone ?? null,
        reportText: (document.querySelector("#turn-report")?.textContent ?? "").trim(),
        sessionLogEntries: document.querySelectorAll("#session-log li").length,
        logLines: [...document.querySelectorAll("#session-log li")].slice(0, 3).map((li) => li.textContent.trim()),
      }));
      const frames = first
        .events("Network.webSocketFrameReceived")
        .filter((frame) => frame.response.opcode === 1)
        .map((frame) => {
          try {
            return JSON.parse(frame.response.payloadData);
          } catch {
            return { unparsed: frame.response.payloadData };
          }
        })
        .slice(-6);
      const screenshot = path.join(output, `06-text-turn-${Date.now()}.png`);
      await first.screenshot(screenshot, { fullPage: true }).catch(() => {});
      return [
        `page state: ${JSON.stringify(seen, null, 2)}`,
        `the page's own /live socket received (last 6 text frames): ${JSON.stringify(frames, null, 2)}`,
        `screenshot: ${screenshot}`,
      ].join("\n");
    };

    await first.click("#send");

    // THE TURN STARTED? The form's own submit handler clears the field synchronously in the click's task (and
    // `page.click` waits for the dispatched events plus its own settle), so this is a read of a state the click
    // writes, not a race: text still in the field after the click means the real-mouse click never reached the
    // button - an overlay swallowing it - which is a UI failure, not a slow turn, and it is named as one.
    const afterSend = await first.evaluate(() => document.querySelector("#utterance")?.value ?? null);
    // LAZY, and that matters twice over (found while reproducing this failure at eight-way concurrency, where
    // the capture ran on PASSING runs too): an eagerly-evaluated message captures a screenshot on every green
    // run, which costs the tier a full-page render, litters the evidence directory with screenshots nobody
    // asked for - and, on a test whose subject is timing, perturbs the very run it is measuring. The capture
    // happens only on the failure path, in both places.
    if (afterSend !== "") {
      throw new Error(
        `the click must submit the form: #utterance still holds the text, so the turn never started.\n${await turnEvidence()}`,
      );
    }

    // THE TURN FINISHED, and said so: a NEW #session-log entry for this turn, with the report settled either
    // way. `tone === "bad"` is then asserted below with the page's own sentence in the message.
    let turnReport;
    try {
      await first.waitFor(
        (before) => {
          const tone = document.querySelector("#turn-report")?.dataset.tone;
          const entries = document.querySelectorAll("#session-log li").length;
          return entries > before && (tone === "good" || tone === "bad");
        },
        { label: "the native text form turn to be recorded and report an outcome", timeout: TEXT_TURN_SETTLE_MS, args: [turnsBefore] },
      );
      turnReport = await first.evaluate(() => ({
        tone: document.querySelector("#turn-report")?.dataset.tone ?? null,
        text: (document.querySelector("#turn-report")?.textContent ?? "").trim(),
      }));
    } catch (error) {
      throw new Error(
        `the native text form turn did not settle within ${TEXT_TURN_SETTLE_MS}ms of the click.\n` +
          `${await turnEvidence()}\nUnderlying wait error: ${error.message}`,
      );
    }
    assert.equal(
      turnReport.tone,
      "good",
      `the page's own text form must answer the turn while the task is held; #turn-report says ${JSON.stringify(turnReport)}`,
    );
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
