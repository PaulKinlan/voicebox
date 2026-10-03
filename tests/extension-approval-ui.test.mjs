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
      for (let i = 0; i < 100; i++) {
        const code = terminal.match(new RegExp(`${requestId} approve [^\\n]+: (\\d{8}) `))?.[1];
        if (code) return code;
        await sleep(20);
      }
      throw new Error("No approval code appeared on the host console");
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
    await page.waitFor(() => document.querySelector("#ext-waiting .ext-approve-btn"), { label: "waiting proposal 1-click button" });
    await page.click("#ext-waiting details.ext-plan summary");
    await page.waitFor(() => document.querySelector("#ext-waiting .ext-plan pre")?.textContent.includes("approvalclock"), { label: "extension plan loaded" });
    assert.equal(await page.evaluate(() => {
      const dialog = document.getElementById("exts");
      return dialog.scrollWidth <= dialog.clientWidth && getComputedStyle(document.querySelector(".ext-plan pre")).whiteSpace === "pre-wrap";
    }), true, "the phone approval plan wraps without horizontal overflow");
    if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot(path.join(evidence, "awaiting-code.png")); }
    await page.click("#ext-waiting .ext-approve-btn");
    await page.waitFor(() => document.querySelector("#ext-running")?.textContent.includes("approvalclock"), { label: "human-approved extension running" });
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
