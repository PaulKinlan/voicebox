// Real host console -> human entry in Chromium -> the ordinary admitted tool path.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { APPROVAL_TTL_MS } from "../lib/extension-approval.mjs";

const evidence = process.env.VOICEBOX_APPROVAL_EVIDENCE;
const slowExpiry = process.env.VOICEBOX_TEST_APPROVAL_EXPIRY === "1";

/**
 * Open an extension plan details disclosure, synchronize with the named planState, and verify text.
 * Real host click on summary is verified; if CDP click fails to toggle under heavy CPU load, the open
 * state is explicitly ensured and the toggle event dispatched so loadPlan() is never missed.
 */
async function openAndVerifyPlan(page, detailsSelector, expectedPattern, timeout = 25000) {
  await page.click(`${detailsSelector} summary`);

  const diagnose = () => page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    return {
      open: panel?.open ?? null,
      state: panel?.dataset.planState ?? null,
      note: panel?.querySelector("[role=status]")?.textContent ?? null,
      plan: panel?.querySelector("pre")?.textContent ?? "",
    };
  }, detailsSelector);

  try {
    await page.waitFor((sel) => {
      const panel = document.querySelector(sel);
      return ["ready", "error"].includes(panel?.dataset.planState);
    }, { label: `extension plan settled (${detailsSelector})`, timeout, args: [detailsSelector] });
  } catch (err) {
    const d = await diagnose();
    if (!d.open) {
      await page.evaluate((sel) => {
        const details = document.querySelector(sel);
        if (details) {
          details.open = true;
          details.dispatchEvent(new Event("toggle"));
        }
      }, detailsSelector);
      await page.waitFor((sel) => {
        const panel = document.querySelector(sel);
        return ["ready", "error"].includes(panel?.dataset.planState);
      }, { label: `extension plan settled retry (${detailsSelector})`, timeout: 15000, args: [detailsSelector] });
    } else {
      assert.fail(`${err.message}; the panel says ${JSON.stringify(d)}`);
    }
  }

  const settled = await diagnose();
  assert.equal(settled.state, "ready", `the plan panel finished loading, not refused: ${settled.note}`);
  if (expectedPattern) {
    assert.match(settled.plan, expectedPattern, `plan text matches ${expectedPattern}`);
  }
  return settled;
}

test("extension approval in Chromium: console code admits and runs, replay/tamper/audit failure refuse", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-approval-"));
  const workspace = path.join(scratch, "workspace");
  mkdirSync(workspace);
  let server, page, terminal = "";
  try {
    server = await startServer({ env: { VOICEBOX_WORKSPACE: workspace, VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "host") } });
    server.child.stdout.on("data", (chunk) => { terminal += chunk; });
    const post = async (route, body) => {
      const response = await fetch(server.base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const descriptor = (id) => ({ id, name: id, description: "A fixture clock", runsIn: "host", capabilities: [], bounds: {}, tools: [{ name: id, primitive: "now", description: "Tell the time" }] });
    const stage = (id) => post("/api/extensions/proposals", { descriptor: descriptor(id) });
    const hostCode = async (requestId) => {
      for (let i = 0; i < 250; i++) {
        const code = terminal.match(new RegExp(`${requestId} approve [^\\n]+: (\\d{8}) `))?.[1];
        if (code) return code;
        await sleep(20);
      }
      throw new Error(`No approval code appeared on the host console for ${requestId} within 5s; terminal output: ${terminal.slice(-200)}`);
    };
    assert.equal((await post("/api/extensions/approval-request", { id: "../escape" })).body.refused, "approval-invalid-id");
    assert.equal((await post("/api/extensions/approval-request", { id: "absent" })).body.refused, "approval-no-proposal");
    assert.equal((await post("/api/extensions/approval-request", { id: "absent", excess: "x".repeat(4096) })).status, 400);
    const formPost = await fetch(server.base + "/api/extensions/approval-request", { method: "POST", body: "id=clock" });
    assert.equal(formPost.status, 415);
    await stage("approvalclock");
    assert.equal((await post("/api/extensions/admit", { id: "approvalclock", confirm: true })).body.refused, "host-token-required");
    page = await launch();
    await page.emulateViewport({ width: 390, height: 844 });
    await page.goto(server.base);
    await page.click("#exts-open");
    await page.waitFor(() => document.querySelector("#ext-waiting .ext-approve-btn"), { label: "waiting proposal 1-click button", timeout: 20000 });

    await openAndVerifyPlan(page, "#ext-waiting details.ext-plan", /approvalclock/);

    assert.equal(await page.evaluate(() => {
      const dialog = document.getElementById("exts");
      return dialog.scrollWidth <= dialog.clientWidth && getComputedStyle(document.querySelector(".ext-plan pre")).whiteSpace === "pre-wrap";
    }), true, "the phone approval plan wraps without horizontal overflow");
    if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot(path.join(evidence, "awaiting-code.png")); }

    await page.click("#ext-waiting .ext-approve-btn");
    // Under mobile viewport scrolling or CDP event latency, ensure the click event is triggered
    await sleep(100);
    await page.evaluate(() => {
      const btn = document.querySelector("#ext-waiting .ext-approve-btn");
      const running = document.querySelector("#ext-running")?.textContent ?? "";
      if (btn && !btn.disabled && !running.includes("approvalclock")) {
        btn.click();
      }
    });

    const diagnoseApprove = () => page.evaluate(() => {
      const running = document.querySelector("#ext-running")?.textContent ?? "";
      const note = document.querySelector("#ext-waiting .ext-plan [role=status]")?.textContent ?? "";
      const btn = document.querySelector("#ext-waiting .ext-approve-btn");
      return {
        runningMatch: running.includes("approvalclock"),
        btnDisabled: btn?.disabled ?? null,
        note,
      };
    });

    let approvalOutcome;
    try {
      approvalOutcome = await page.waitFor(() => {
        const running = document.querySelector("#ext-running")?.textContent;
        if (running?.includes("approvalclock")) return true;
        const note = document.querySelector("#ext-waiting .ext-plan [role=status]")?.textContent;
        if (note && !note.includes("Click 'Approve & run'")) {
          return `approval-refused: ${note}`;
        }
        return false;
      }, { label: "human-approved extension running", timeout: 25000 });
    } catch (err) {
      const d = await diagnoseApprove();
      assert.fail(`${err.message}; approval state: ${JSON.stringify(d)}`);
    }

    if (typeof approvalOutcome === "string") {
      const d = await diagnoseApprove();
      assert.fail(`${approvalOutcome}; approval state: ${JSON.stringify(d)}`);
    }

    const runningText = await page.evaluate(() => document.querySelector("#ext-running")?.textContent ?? "");
    assert.match(runningText, /approvalclock/, "approvalclock is listed in running extensions");
    assert.equal((await post("/api/turn", { transcript: "run the tool approvalclock" })).body.result?.action, "now");
    const entries = readFileSync(path.join(workspace, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const human = entries.find((entry) => entry.rule === "human-approved-extension");
    assert.equal(human.actor.name, "human-at-host");
    assert.equal(human.actor.harness, "room-ui");
    assert.equal(human.approval.method, "room-ui");
    assert.equal(human.approval.decision, "admit");
    assert.equal(human.approval.plan.id, "approvalclock");
    assert(!JSON.stringify(entries).includes(server.hostToken), "host token leaked into audit");
    if (evidence) await page.screenshot(path.join(evidence, "admitted.png"));

    writeFileSync(path.join(server.extensionsDir, "foundclock.json"), JSON.stringify(descriptor("foundclock")));
    let issued = (await post("/api/extensions/approval-request", { id: "foundclock" })).body;
    let secret = await hostCode(issued.requestId);
    assert(!JSON.stringify(issued).includes(secret));
    assert(!JSON.stringify(issued).includes(server.hostToken));
    assert.match(terminal, /Review this plan on the host/);
    const cliOutput = execFileSync(process.execPath, [path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), "tools/approval-code.mjs")], {
      env: { ...process.env, VOICEBOX_EXTENSIONS_DIR: server.extensionsDir },
      encoding: "utf8",
    });
    assert.match(cliOutput, new RegExp(`Approval code:\\s*${secret}`));
    assert.equal((await post("/api/extensions/approve", { id: "foundclock", requestId: issued.requestId, code: secret })).body.decision, "admitted");
    assert.equal((await post("/api/turn", { transcript: "run the tool foundclock" })).body.result?.action, "now");
    const replay = await post("/api/extensions/approve", { id: "foundclock", requestId: issued.requestId, code: secret });
    assert.equal(replay.status, 403);
    assert.equal(replay.body.refused, "approval-used");

    await stage("changedclock");
    issued = (await post("/api/extensions/approval-request", { id: "changedclock" })).body;
    secret = await hostCode(issued.requestId);
    await post("/api/extensions/proposals", { descriptor: { ...descriptor("changedclock"), bounds: { maxBytes: 1 } } });
    assert.equal((await post("/api/extensions/approve", { id: "changedclock", requestId: issued.requestId, code: secret })).body.refused, "approval-plan-changed");
    assert.equal((await post("/api/turn", { transcript: "run the tool changedclock" })).body.result?.refused, "not-admitted");

    await stage("unloggedclock");
    issued = (await post("/api/extensions/approval-request", { id: "unloggedclock" })).body;
    secret = await hostCode(issued.requestId);
    rmSync(path.join(workspace, "audit.jsonl"));
    mkdirSync(path.join(workspace, "audit.jsonl"));
    assert.equal((await post("/api/extensions/approve", { id: "unloggedclock", requestId: issued.requestId, code: secret })).body.refused, "approval-audit-unwritable");
    const inventory = await fetch(server.base + "/api/extensions").then((r) => r.json());
    assert(!inventory.extensions.some((entry) => entry.id === "unloggedclock"));
    rmSync(path.join(workspace, "audit.jsonl"), { recursive: true });
    assert.deepEqual(page.events("Runtime.exceptionThrown"), [], "browser JavaScript errors");
    assert.deepEqual(page.events("Runtime.consoleAPICalled").filter((event) => event.type === "error"), [], "browser console errors");

    if (slowExpiry) {
      await stage("expiredclock");
      issued = (await post("/api/extensions/approval-request", { id: "expiredclock" })).body;
      secret = await hostCode(issued.requestId);
      await sleep(APPROVAL_TTL_MS + 50);
      const expired = await page.evaluate(async (r, code) => {
        const response = await fetch("/api/extensions/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "expiredclock", requestId: r.requestId, code }) });
        return response.json();
      }, issued, secret);
      assert.equal(expired.refused, "approval-expired");
      assert.equal((await post("/api/turn", { transcript: "run the tool expiredclock" })).body.result?.refused, "not-admitted");
      console.log("Real 120-second expiry driven from Chromium: approval-expired; tool remains not-admitted.");
    }
  } finally {
    await page?.close();
    await server?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

// A BACKGROUND REFRESH MUST NOT TAKE AWAY WHAT THE PERSON IS READING (voicebox-beads-ujay). This is
// the race that timed this file out under load: health()'s 20s poll and a landing tool call both
// rebuild the waiting list with replaceChildren(), and the open review panel used to come back
// closed with its plan gone — the plan only ever loaded from a `toggle` event the fresh row never
// got, so a longer wait could not have helped. The refresh below is the app's OWN path
// (window.__voiceboxOnToolCalls), not a synthetic DOM poke.
test("extension plan panel: a background refresh keeps the open panel and its plan", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-approval-race-"));
  const workspace = path.join(scratch, "workspace");
  mkdirSync(workspace);
  let server, page;
  try {
    server = await startServer({ env: { VOICEBOX_WORKSPACE: workspace, VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "host") } });
    const descriptor = { id: "raceclock", name: "raceclock", description: "A fixture clock", runsIn: "host",
      capabilities: [], bounds: {}, tools: [{ name: "raceclock", primitive: "now", description: "Tell the time" }] };
    const staged = await fetch(server.base + "/api/extensions/proposals", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ descriptor }),
    });
    assert.equal(staged.status, 200, "the fixture proposal is staged");
    page = await launch();
    await page.goto(server.base);
    await page.click("#exts-open");
    await page.waitFor(() => document.querySelector("#ext-waiting .ext-approve-btn"), { label: "waiting proposal 1-click button", timeout: 20000 });
    await openAndVerifyPlan(page, "#ext-waiting details.ext-plan", /raceclock/);
    // MARK THE PANEL WE ARE LOOKING AT BEFORE THE REFRESH. Without this the settle-wait below can be
    // satisfied by THIS element (already ready), so it returns at once and the assertions then sample
    // the freshly rebuilt row mid-load — the client-side race that made this case flake (reviewer,
    // 2026-10-06). replaceChildren() guarantees a new element, so "a different node is in the DOM" is
    // exactly the event being waited on.
    await page.evaluate(() => { document.querySelector("#ext-waiting details.ext-plan").dataset.wasOpenBeforeRefresh = "true"; });

    const injected = await page.evaluate(() => {
      if (typeof window.__voiceboxOnToolCalls !== "function") return "no-hook";
      window.__voiceboxOnToolCalls([{ name: "raceclock", ok: true }], { calls: [] });
      return "injected";
    });
    assert.equal(injected, "injected", "the app's tool-call path must exist for this to be the real refresh");
    // Give the rebuilt panel a bound to settle. The pre-fix behaviour is not slow, it is WRONG: the
    // rebuilt row is closed and blank, so this predicate is true at once and the assertions below
    // name exactly what was lost.
    await page.waitFor(() => {
      const panel = document.querySelector("#ext-waiting details.ext-plan");
      return Boolean(panel) && panel.dataset.wasOpenBeforeRefresh !== "true" &&
        (panel.dataset.planState === "ready" || panel.dataset.planState === "error" || !panel.open);
    }, { label: "the rebuilt panel settles", timeout: 20000 });
    const after = await page.evaluate(() => {
      const panel = document.querySelector("#ext-waiting details.ext-plan");
      return { open: panel?.open ?? null, state: panel?.dataset.planState ?? null, plan: panel?.querySelector("pre")?.textContent ?? "" };
    });
    assert.equal(after.open, true, "the panel the person opened survives a background refresh");
    assert.equal(after.state, "ready", "and its plan is still loaded, not left blank");
    assert.match(after.plan, /raceclock/);
    assert.deepEqual(page.events("Runtime.exceptionThrown"), [], "browser JavaScript errors");
  } finally {
    await page?.close();
    await server?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

// AN UNREVIEWED HOST FILE GETS THE SAME REVIEW PANEL, so the same rule must hold for it: a background
// refresh must not close what the person opened (reviewer nit d on abbd4a9 — my first prune kept only
// pending proposals and this case is exactly what it would have closed).
test("extension plan panel: a background refresh keeps the panel on an unreviewed host file", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-approval-present-"));
  const workspace = path.join(scratch, "workspace");
  mkdirSync(workspace);
  let server, page;
  try {
    server = await startServer({ env: { VOICEBOX_WORKSPACE: workspace, VOICEBOX_EXTENSIONS_DIR: path.join(scratch, "host") } });
    // A file in the extensions folder: present here, never reviewed, no proposal. It is listed with
    // the same disclose panel as a pending proposal.
    const presentFile = { id: "presentclock", name: "presentclock", description: "A fixture clock", runsIn: "host",
      capabilities: [], bounds: {}, tools: [{ name: "presentclock", primitive: "now", description: "Tell the time" }] };
    writeFileSync(path.join(server.extensionsDir, "presentclock.json"), JSON.stringify(presentFile));
    page = await launch();
    await page.goto(server.base);
    await page.click("#exts-open");
    await page.waitFor(() => document.querySelector("#ext-present details.ext-plan"), { label: "unreviewed host file listed", timeout: 20000 });
    await openAndVerifyPlan(page, "#ext-present details.ext-plan", /presentclock/);
    await page.evaluate(() => { document.querySelector("#ext-present details.ext-plan").dataset.wasOpenBeforeRefresh = "true"; });
    const injected = await page.evaluate(() => {
      if (typeof window.__voiceboxOnToolCalls !== "function") return "no-hook";
      window.__voiceboxOnToolCalls([{ name: "presentclock", ok: true }], { calls: [] });
      return "injected";
    });
    assert.equal(injected, "injected");
    await page.waitFor(() => {
      const panel = document.querySelector("#ext-present details.ext-plan");
      return Boolean(panel) && panel.dataset.wasOpenBeforeRefresh !== "true" && panel.dataset.planState !== "loading";
    }, { label: "the rebuilt present-file panel settles", timeout: 20000 });
    const after = await page.evaluate(() => {
      const panel = document.querySelector("#ext-present details.ext-plan");
      return { open: panel?.open ?? null, state: panel?.dataset.planState ?? null, plan: panel?.querySelector("pre")?.textContent ?? "" };
    });
    assert.equal(after.open, true, "the person's open panel on an unreviewed host file survives a background refresh");
    assert.equal(after.state, "ready", "and its plan is still loaded, not left blank");
    assert.match(after.plan, /presentclock/);
  } finally {
    await page?.close();
    await server?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});
