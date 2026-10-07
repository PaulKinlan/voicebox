// tests/acp-console-ui.test.mjs — Verify ACP / Claude Code console output and activity in browser UI (voicebox-beads-i8kg).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";
import { ACP_AGENT } from "../lib/acp-client.mjs";

test("browser UI: ACP progress, console output, and session history update live without leaking secrets", { timeout: 35000 }, async (t) => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vb-acp-ui-")));
  const workspace = path.join(scratch, "project");
  fs.mkdirSync(workspace, { recursive: true });

  // Provide mock pi-acp adapter that emits stderr console logs and reports stages
  const adapterDir = path.join(scratch, "pi-acp-stub");
  fs.mkdirSync(path.join(adapterDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(adapterDir, "package.json"), JSON.stringify({ name: "pi-acp", version: ACP_AGENT.version }));

  // Script that acts as ACP adapter: emits diagnostic stderr lines then responds to JSON-RPC on stdin
  const adapterScript = `
const readline = require("readline");
process.stderr.write("Starting agent compiler build process...\\n");
process.stderr.write("Loaded configuration token sk-ant-secrettoken123456789\\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (!msg || msg.id === undefined) return;
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "${ACP_AGENT.name}", version: "${ACP_AGENT.version}" } } }) + "\\n");
    } else if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } }) + "\\n");
    } else if (msg.method === "session/prompt") {
      // Emit a tool call session update, then complete
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call", title: "SearchFiles" } } }) + "\\n");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Analysis completed successfully." } } } }) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
      }, 300);
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
    }
  } catch (e) {}
});
`;
  fs.writeFileSync(path.join(adapterDir, "dist", "index.js"), adapterScript);

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
      VOICEBOX_HARNESS: "pi",
      VOICEBOX_ACP_ADAPTER: adapterDir,
      VOICEBOX_SANDBOX_HOMES: path.join(scratch, "sandbox-homes"),
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const page = await launch({ width: 1200, height: 900 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);
  await page.waitFor(() => window.__voiceboxTaskCard !== undefined, { label: "task card controller" });

  // Open Activity panel
  await page.evaluate(() => {
    const actBtn = document.querySelector("#sqeh-toggle-activity");
    actBtn?.click();
  });

  // Verify activity panel is visible
  await page.waitFor(() => {
    const panel = document.querySelector("#activity-log-panel");
    return panel && !panel.hidden;
  }, { label: "activity log panel open" });

  // Delegate task via composer input: "ask pi to inspect build"
  await page.evaluate(() => {
    const input = document.querySelector("#utterance");
    const form = document.querySelector("#text-form");
    input.value = "ask pi to inspect build";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  // Wait for task card to appear
  await page.waitFor(() => {
    const card = document.querySelector("#task-card");
    return card && !card.hidden && document.querySelector("#task-card-agent")?.textContent === "pi";
  }, { label: "task card visible" });

  // Wait for activity panel to receive console or agent activity
  await page.waitFor(() => {
    const list = document.querySelector("#activity-log-list");
    return list && list.children.length > 0;
  }, { label: "activity items present" });

  // Verify live progress and console output appear in activity feed
  const activityItems = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("#activity-log-list .activity-item"));
    return items.map((li) => ({
      kind: li.querySelector(".activity-kind")?.textContent ?? "",
      summary: li.querySelector(".activity-summary")?.textContent ?? "",
      detail: li.querySelector(".activity-detail")?.textContent ?? "",
    }));
  });

  assert.ok(activityItems.length > 0, "must have logged activity items");

  // Check that no secret token exists in any activity item
  const allActivityText = JSON.stringify(activityItems);
  assert.doesNotMatch(allActivityText, /secrettoken/i, "secret tokens must not appear in activity text");
  assert.match(allActivityText, /\[redacted/i, "secret tokens must be replaced with [redacted]");

  // Wait for task card answer
  await page.waitFor(() => {
    const answer = document.querySelector("#task-card-answer");
    return answer && answer.textContent.includes("Analysis completed successfully");
  }, { label: "task card completed answer", timeout: 15000 });

  // Verify Task card console output was rendered
  const taskConsole = await page.evaluate(() => {
    const c = document.querySelector("#task-card-console .task-console-text");
    return c?.textContent ?? "";
  });
  assert.ok(taskConsole.length > 0, "task card console block must be populated");
  assert.doesNotMatch(taskConsole, /secrettoken/i, "task card console must not leak secrets");

  // Verify Session history (#session-log) recorded the agent completion turn
  const sessionLogText = await page.evaluate(() => {
    const log = document.querySelector("#session-log");
    return log?.textContent ?? "";
  });

  assert.match(sessionLogText, /agent: pi/i, "session history must log agent completion turn");
  assert.match(sessionLogText, /Analysis completed successfully/, "session history must record agent answer");
});
