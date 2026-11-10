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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

  // Script linkage
  assert.match(html, /<script\s+src="\/apps\/agent-monitor\.js"><\/script>/);

  const js = fs.readFileSync(
    new URL("../public/apps/agent-monitor.js", import.meta.url),
    "utf8",
  );
  // Endpoints for live polling, harness connection, and multi-harness delegation
  assert.match(js, /\/api\/harnesses/);
  assert.match(js, /\/api\/harnesses\/configure/);
  assert.match(js, /\/api\/tasks/);
  assert.match(js, /\/api\/tasks\/delegate/);

  // WebMCP tool registrations
  assert.match(js, /window\.voicebox\?\.registerTool/);
  assert.match(js, /get_agent_progress/);
  assert.match(js, /delegate_multi_harness/);
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

test("agent-monitor mini-app: the delegate tool ASKS THE ROOM, and only the room's approval reaches the host (voicebox-beads-j6im)", { timeout: 60000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  // A DECLARED MACHINE ROOT, so the approved delegation has somewhere to land: POST /api/tasks/delegate refuses
  // "task-root-unavailable" without one (D1 — the host's explicitly declared root, never a page's), and then the
  // approved arm could not tell "the room's request reached the host" from "the host had nowhere to put it".
  const workspace = mkdtempSync(path.join(tmpdir(), "vb-agent-monitor-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const declared = await fetch(`${server.base}/api/root`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-voicebox-host-token": server.hostToken },
    body: JSON.stringify({ project: "agent-monitor", root: { kind: "machine", path: workspace } }),
  });
  assert.equal(declared.status, 200, `declaring the machine root: ${await declared.text()}`);

  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  // THIS TEST MUST BE THE ROOM (voicebox-beads-j6im landed after it was written). `POST /api/tasks/delegate` is a
  // HOST ACTION in public/relay-policy.mjs: app code may ASK for it, and only the room performs it after a person
  // approves. A harness with no room can therefore only ever time out — which is correct, and it is exactly the
  // authority the security fix removed from app code. So this drives the same frames the real room drives over the
  // same MessagePort, rebuilds the body with the same public/relay-body.mjs, and checks the SERVER's state (not the
  // app's own optimistic rendering) to show which of the two answers actually changed anything.
  const outcome = await page.evaluate(
    async (base, appDescriptor) => {
      const { relayBody } = await import(`${base}/relay-body.mjs`);
      const serverTasks = async () => (await (await fetch("/api/tasks")).json()).tasks ?? [];
      return new Promise((resolve, reject) => {
        const outer = document.createElement("iframe");
        outer.src = `${base}/mini-app-bridge.html`;
        const asked = [];
        let refusalAnswer = null;
        let approvedAnswer = null;
        let tasksAfterRefusal = null;
        let tasksAfterApproval = null;
        const dispatched = [];
        const channel = new MessageChannel();
        const port = channel.port1;
        const callDelegate = (callId) =>
          port.postMessage({
            type: "call_tool",
            callId,
            name: "delegate_multi_harness",
            args: { agents: ["pi", "claude", "antigravity"], task: "Audit performance across modules" },
          });

        window.addEventListener("message", async (e) => {
          if (e.origin !== window.location.origin) return;
          const msg = e.data;
          if (msg?.type === "bridge_ready") {
            outer.contentWindow.postMessage({ type: "mini_app_port" }, window.location.origin, [channel.port2]);
            port.postMessage({ type: "load_app", appId: appDescriptor.appId, html: appDescriptor.html });
          } else if (msg?.type === "app_ready" && msg?.appId === appDescriptor.appId) {
            callDelegate("call-refused");
          } else if (msg?.type === "host_action_request") {
            asked.push({ action: msg.action, route: msg.route, method: msg.method, path: msg.path });
            if (asked.length === 1) {
              // ARM 1 — A PERSON DECLINES. The app is told so, and nothing is sent.
              port.postMessage({ type: "host_action_result", callId: msg.callId, ok: false, error: "the person declined" });
              return;
            }
            // ARM 2 — A PERSON APPROVES: the room rebuilds the body exactly as public/components/mini-app-surface.mjs
            // does and performs the request itself, with the room's own origin, which the app never holds.
            const carried = relayBody(msg.body, { maxBytes: 65536 });
            if (!carried.ok) {
              port.postMessage({ type: "host_action_result", callId: msg.callId, ok: false, error: carried.error });
              return;
            }
            port.postMessage({ type: "host_action_state", callId: msg.callId, state: "executing" });
            const response = await fetch(new URL(msg.path, base), {
              method: msg.method,
              ...(msg.contentType ? { headers: { "content-type": msg.contentType } } : {}),
              body: carried.body,
            });
            const bodyText = await response.text();
            dispatched.push({ path: msg.path, status: response.status, bodyText: bodyText.slice(0, 300) });
            port.postMessage({
              type: "host_action_result",
              callId: msg.callId,
              ok: true,
              status: response.status,
              headers: { "content-type": response.headers.get("content-type") || "application/json" },
              bodyText,
            });
          } else if (msg?.type === "tool_result" && msg?.callId === "call-refused") {
            refusalAnswer = msg;
            tasksAfterRefusal = await serverTasks();
            callDelegate("call-approved");
          } else if (msg?.type === "tool_result" && msg?.callId === "call-approved") {
            approvedAnswer = msg;
            tasksAfterApproval = await serverTasks();
            port.postMessage({ type: "call_tool", callId: "call-progress", name: "get_agent_progress", args: {} });
          } else if (msg?.type === "tool_result" && msg?.callId === "call-progress") {
            resolve({ asked, refusalAnswer, approvedAnswer, tasksAfterRefusal, tasksAfterApproval, progress: msg, dispatched });
          }
        });

        document.body.appendChild(outer);
        setTimeout(() => reject(new Error(`timed out waiting for agent-monitor WebMCP tools; asked: ${JSON.stringify(asked)}`)), 25000);
      });
    },
    server.base,
    AGENT_MONITOR_MINI_APP,
  );

  // THE APP ASKED, TWICE, FOR EXACTLY ONE ROUTE — app code has no other way to reach it.
  assert.equal(outcome.asked.length, 2, `both delegate calls must ask the room, got ${JSON.stringify(outcome.asked)}`);
  for (const ask of outcome.asked) {
    assert.equal(ask.route, "POST /api/tasks/delegate");
    assert.equal(ask.method, "POST");
    assert.equal(ask.path, "/api/tasks/delegate");
    assert.match(ask.action, /delegate/i);
  }

  // ARM 1: the person declined. The app answered, and the SERVER HAS NOTHING — the app's own optimistic rendering
  // is not the host's state, which is the whole reason this arm reads /api/tasks instead of the app's reply.
  assert.ok(outcome.refusalAnswer, "a declined host action must still answer the app");
  assert.deepEqual(outcome.tasksAfterRefusal, [], "a declined host action must not launch anything on the host");

  // ARM 2: the person approved. The host really delegated, and the app's answer reflects that.
  assert.equal(outcome.approvedAnswer.ok, true);
  assert.equal(outcome.approvedAnswer.result.launchedCount, 3);
  assert.deepEqual(outcome.approvedAnswer.result.agents, ["pi", "claude", "antigravity"]);
  // COUNT, NOT EXACTLY THREE: which harnesses a machine can actually launch is machine state — on this box `pi`
  // answers "adapter-unavailable" (no pi-acp installed) and only the ones with a working adapter create tasks. An
  // exact count here would turn a missing adapter into a red test for every lane, which is the machine-state
  // pathology docs/speed.md names. What must be true on ANY machine: the approved request reached the host and
  // created the work it was asked to create.
  assert.ok(
    outcome.tasksAfterApproval.length >= 1,
    `an approved host action must reach the host, got ${JSON.stringify(outcome.tasksAfterApproval)}; dispatched=${JSON.stringify(outcome.dispatched)}`,
  );
  for (const task of outcome.tasksAfterApproval) {
    assert.equal(task.task ?? task.prompt, "Audit performance across modules", `every launched task carries the prompt: ${JSON.stringify(task)}`);
  }

  // And the read tool still works through the relay, over the same bridge.
  assert.equal(outcome.progress.ok, true);
  assert.ok(Array.isArray(outcome.progress.result.activeHarnesses));
  // The app's board is NOT the host's list, and this test does not pretend otherwise: the app renders optimistically
  // (it draws three rows before the route answers, including for the refused arm), so its count legitimately
  // exceeds the host's. The boundary is the host's state, asserted above; this only proves the read tool answers.
  assert.ok(outcome.progress.result.tasks.length >= 1, "the progress tool must report the board it rendered");
  assert.equal(outcome.progress.result.tasks[0].prompt, "Audit performance across modules");
});
