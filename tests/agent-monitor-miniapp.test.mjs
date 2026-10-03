// tests/agent-monitor-miniapp.test.mjs — Agent Progress Tracker mini-app tests.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AGENT_MONITOR_APP_ID,
  AGENT_MONITOR_MINI_APP,
  getAgentMonitorMiniApp,
} from "../lib/agent-monitor-app.mjs";
import {
  ID_PATTERNS,
  JARGON,
  identifiersInRenderedText,
} from "../tools/rendered-plain-language.mjs";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const BANNED_JARGON_WORDS = [
  "sandbox",
  "iframe",
  "srcdoc",
  "opfs",
  "ipc",
  "json",
  "rpc",
  "wasm",
  "idempotence",
  "worktree",
];

const BANNED_TICKET_SUBSTRINGS = [
  "dtjf",
  "hn7x",
  "lmvn",
  "xgnm",
  "zjdd",
  "keb7",
  "bavl",
  "tjih",
  "2vza",
  "von8",
  "0jxa",
  "sqeh",
  "2meg",
  "3rcy",
];

function scanPlainLanguage(rawHtml) {
  const withoutStyleAndComments = rawHtml
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const hits = [...identifiersInRenderedText(withoutStyleAndComments)];

  for (const [re, label, remedy] of ID_PATTERNS) {
    const m = withoutStyleAndComments.match(re);
    if (m) hits.push({ token: m[0], label, remedy });
  }
  for (const [word, remedy] of JARGON) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(withoutStyleAndComments)) {
      hits.push({ token: word, label: "jargon", remedy });
    }
  }
  for (const word of BANNED_JARGON_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(rawHtml)) {
      hits.push({ token: word, label: "banned-jargon", remedy: "use plain language" });
    }
  }
  for (const id of BANNED_TICKET_SUBSTRINGS) {
    if (rawHtml.toLowerCase().includes(id.toLowerCase())) {
      hits.push({ token: id, label: "ticket-id", remedy: "remove ticket id substring" });
    }
  }
  return hits;
}

test("agent-monitor mini-app: exports valid Standards-Mode HTML with harness bar, multi-harness dispatch form, live board, and WebMCP tools", () => {
  assert.equal(AGENT_MONITOR_APP_ID, "agent-progress-tracker");
  assert.equal(AGENT_MONITOR_MINI_APP.appId, "agent-progress-tracker");
  assert.equal(AGENT_MONITOR_MINI_APP.title, "Agent Progress Tracker");

  const copy = getAgentMonitorMiniApp();
  assert.deepEqual(copy, AGENT_MONITOR_MINI_APP);
  assert.notEqual(copy, AGENT_MONITOR_MINI_APP);

  const html = AGENT_MONITOR_MINI_APP.html;
  assert.match(html, /^<!DOCTYPE html>/i, "must start with Standards-Mode DOCTYPE");
  assert.match(html, /Agent Progress Tracker/);
  assert.match(html, /id="connected-count"/);
  assert.match(html, /id="refresh-btn"/);
  assert.match(html, /id="harness-bar"/);
  assert.match(html, /id="dispatch-form"/);
  assert.match(html, /name="target-harness"/);
  assert.match(html, /id="task-prompt-input"/);
  assert.match(html, /id="dispatch-submit"/);
  assert.match(html, /id="tasks-board"/);

  // Supports all 5 harnesses
  for (const harness of ["pi", "claude", "antigravity", "codex", "opencode"]) {
    assert.match(html, new RegExp(`value="${harness}"`));
  }

  // Endpoints for live polling, harness connection, and multi-harness delegation
  assert.match(html, /\/api\/harnesses/);
  assert.match(html, /\/api\/harnesses\/configure/);
  assert.match(html, /\/api\/tasks/);
  assert.match(html, /\/api\/tasks\/delegate/);

  // WebMCP tool registrations
  assert.match(html, /window\.voicebox\?\.registerTool/);
  assert.match(html, /get_agent_progress/);
  assert.match(html, /delegate_multi_harness/);
});

test("agent-monitor mini-app: public/apps/agent-monitor.html passes plain-language scan with zero jargon or ticket-ID hits", () => {
  const rawHtml = fs.readFileSync(
    new URL("../public/apps/agent-monitor.html", import.meta.url),
    "utf8",
  );
  const hits = scanPlainLanguage(rawHtml);
  assert.deepEqual(
    hits,
    [],
    `Expected zero plain-language violations in public/apps/agent-monitor.html, found: ${JSON.stringify(hits)}`,
  );
});

test("agent-monitor mini-app: executes WebMCP tools get_agent_progress and delegate_multi_harness inside the bridge", { timeout: 25000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const outcome = await page.evaluate(
    async (base, appDescriptor) => {
      return new Promise((resolve, reject) => {
        const outer = document.createElement("iframe");
        outer.src = `${base}/mini-app-bridge.html`;
        let delegated = null;

        window.addEventListener("message", (e) => {
          if (e.origin !== window.location.origin) return;
          if (e.data?.type === "bridge_ready") {
            outer.contentWindow.postMessage(
              {
                type: "load_app",
                appId: appDescriptor.appId,
                html: appDescriptor.html,
              },
              window.location.origin,
            );
          } else if (e.data?.type === "app_ready" && e.data?.appId === appDescriptor.appId) {
            outer.contentWindow.postMessage(
              {
                type: "call_tool",
                callId: "call-delegate",
                name: "delegate_multi_harness",
                args: {
                  agents: ["pi", "claude", "antigravity"],
                  task: "Audit performance across modules",
                },
              },
              window.location.origin,
            );
          } else if (e.data?.type === "tool_result" && e.data?.callId === "call-delegate") {
            delegated = e.data;
            outer.contentWindow.postMessage(
              {
                type: "call_tool",
                callId: "call-progress",
                name: "get_agent_progress",
                args: {},
              },
              window.location.origin,
            );
          } else if (e.data?.type === "tool_result" && e.data?.callId === "call-progress") {
            resolve({ delegated, progress: e.data });
          }
        });

        document.body.appendChild(outer);
        setTimeout(() => reject(new Error("timed out waiting for agent-monitor WebMCP tools")), 10000);
      });
    },
    server.base,
    AGENT_MONITOR_MINI_APP,
  );

  assert.equal(outcome.delegated.ok, true);
  assert.equal(outcome.delegated.result.launchedCount, 3);
  assert.deepEqual(outcome.delegated.result.agents, ["pi", "claude", "antigravity"]);

  assert.equal(outcome.progress.ok, true);
  assert.ok(Array.isArray(outcome.progress.result.activeHarnesses));
  assert.equal(outcome.progress.result.tasks.length, 3);
  assert.equal(outcome.progress.result.tasks[0].prompt, "Audit performance across modules");
});

