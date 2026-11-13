#!/usr/bin/env node
// A minimal ACP agent over stdio, for tests/acp-agents.test.mjs. It is NOT a model: it answers the handshake,
// opens one session, and on a prompt asks permission for two writes (one inside the session's cwd, one outside)
// and reports, as its answer, what it was launched with and what it was allowed.
//   FAKE_ACP_PROTOCOL   the protocolVersion to answer initialize with (default 1)
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const waiting = new Map();
let cwd = null;
let nextId = 1000;
const ask = (params) => new Promise((resolve) => {
  const id = `perm-${nextId++}`;
  waiting.set(id, resolve);
  send({ jsonrpc: "2.0", id, method: "session/request_permission", params });
});

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === undefined && waiting.has(message.id)) {
    waiting.get(message.id)(message.result);
    waiting.delete(message.id);
    return;
  }
  if (message.method === "initialize") {
    return send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: Number(process.env.FAKE_ACP_PROTOCOL ?? 1),
      agentInfo: { name: "fake-acp-agent", version: "9.9.9" },
    } });
  }
  if (message.method === "session/new") {
    cwd = message.params.cwd;
    return send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-session" } });
  }
  if (message.method === "session/prompt") {
    const options = [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }];
    const inside = await ask({ sessionId: "fake-session", options, toolCall: { title: "write", locations: [{ path: `${cwd}/inside.txt` }] } });
    const outside = await ask({ sessionId: "fake-session", options, toolCall: { title: "write", locations: [{ path: "/etc/outside.txt" }] } });
    const answer = {
      argv: process.argv.slice(2),
      cwd,
      prompt: message.params.prompt?.[0]?.text ?? null,
      inside: inside?.outcome?.outcome,
      outside: outside?.outcome?.outcome,
      env: Object.fromEntries(["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "FAKE_KEEP_ME"].map((k) => [k, k in process.env])),
    };
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(answer) } } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
});
