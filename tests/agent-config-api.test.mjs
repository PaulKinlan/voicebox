// tests/agent-config-api.test.mjs — bead voicebox-beads-8fv.2 API integration.
//
// Tests:
// 1. GET /api/agents returns secret-free configured agents.
// 2. POST /api/agents requires host token, validates and registers agent.
// 3. PATCH /api/agents/:id updates/renames agent while preserving stable ID.
// 4. GET /api/harnesses integrates configured agents into discovery without parallel inventory (D3).
//
//   node --test tests/agent-config-api.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { script, makeGeminiResolver, makeOpenAIResolver, makeClaudeResolver } from "../lib/resolver.mjs";
import { parseRoomFolderTurn } from "../public/room-folder-ops.js";

test("API: GET /api/agents, POST /api/agents, PATCH /api/agents/:id, and GET /api/harnesses", async () => {
  const server = await startServer();
  try {
    const base = server.base;
    const extensionsDir = path.join(process.cwd(), "extensions");
    const tokenFile = path.join(extensionsDir, ".host-token");
    const hostToken = server.hostToken ?? (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "");

    // 1. GET /api/agents (ambient, no token needed)
    const listRes = await fetch(`${base}/api/agents`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.ok, true);
    assert.ok(Array.isArray(listBody.agents));
    // Default pi agent is present
    const piAgent = listBody.agents.find((a) => a.harness === "pi");
    assert.ok(piAgent, "default Pi agent should be listed");
    assert.equal(typeof piAgent.id, "string");
    assert.equal(typeof piAgent.environmentKey, "string");

    // 2. POST /api/agents without host token or local origin -> 403
    const unauthorized = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "agent_unauthorized",
        name: "Unauthorized Agent",
        harness: "pi",
        adapter: "pi-acp",
        transport: "stdio",
        environmentKey: "local",
      }),
    });
    assert.equal(unauthorized.status, 403);
    const unauthBody = await unauthorized.json();
    assert.equal(unauthBody.refused, "host-token-required");

    if (hostToken) {
      // 3. POST /api/agents with host token -> 201 Created
      const registered = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-voicebox-host-token": hostToken,
        },
        body: JSON.stringify({
          id: "agent_api_test",
          name: "API Test Agent",
          harness: "pi",
          adapter: "pi-acp",
          transport: "stdio",
          environmentKey: "local",
          description: "Configured via HTTP API",
          bounds: { deadlineMs: 40000, maxOutputBytes: 32768 },
        }),
      });
      assert.equal(registered.status, 201);
      const regBody = await registered.json();
      assert.equal(regBody.ok, true);
      assert.equal(regBody.agent.id, "agent_api_test");
      assert.equal(regBody.agent.name, "API Test Agent");

      // 4. PATCH /api/agents/:id -> rename agent
      const renamed = await fetch(`${base}/api/agents/agent_api_test`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-voicebox-host-token": hostToken,
        },
        body: JSON.stringify({ name: "Renamed API Agent" }),
      });
      assert.equal(renamed.status, 200);
      const renameBody = await renamed.json();
      assert.equal(renameBody.ok, true);
      assert.equal(renameBody.agent.id, "agent_api_test");
      assert.equal(renameBody.agent.name, "Renamed API Agent");
    }

    // 5. GET /api/harnesses includes configuredAgents array for each entry
    const harnessesRes = await fetch(`${base}/api/harnesses`);
    assert.equal(harnessesRes.status, 200);
    const harnessesBody = await harnessesRes.json();
    assert.equal(harnessesBody.ok, true);
    assert.ok(Array.isArray(harnessesBody.entries));
    const piHarness = harnessesBody.entries.find((h) => h.id === "pi");
    if (piHarness) {
      assert.ok(Array.isArray(piHarness.configuredAgents), "harness entry must include configuredAgents array");
      assert.ok(piHarness.configuredAgents.length > 0, "configured Pi agents must be attached to Pi harness");
    }
  } finally {
    await server.stop();
  }
});

test("API: GET /api/keys, PUT /api/keys, and POST /api/harnesses/configure", async () => {
  const server = await startServer({
    env: {
      GEMINI_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
  });
  try {
    const base = server.base;

    // 1. GET /api/keys returns secret-free status
    const getKeysRes = await fetch(`${base}/api/keys`);
    assert.equal(getKeysRes.status, 200);
    const getKeysBody = await getKeysRes.json();
    assert.equal(getKeysBody.ok, true);
    assert.equal(getKeysBody.keys.gemini.configured, false);
    assert.equal(getKeysBody.keys.openai.configured, false);
    assert.equal(getKeysBody.keys.anthropic.configured, false);

    // 2. PUT /api/keys sets and persists keys, returning masked hints
    const putKeysRes = await fetch(`${base}/api/keys`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gemini: "AIzaSyTestKey1234567890",
        openai: "sk-proj-test9876543210",
      }),
    });
    assert.equal(putKeysRes.status, 200);
    const putKeysBody = await putKeysRes.json();
    assert.equal(putKeysBody.ok, true);
    assert.equal(putKeysBody.keys.gemini.configured, true);
    assert.equal(putKeysBody.keys.gemini.masked, "••••7890");
    assert.equal(putKeysBody.keys.openai.configured, true);
    assert.equal(putKeysBody.keys.openai.masked, "••••3210");
    assert.equal(putKeysBody.keys.anthropic.configured, false);
    assert.equal(
      fs.existsSync(path.join(server.extensionsDir, ".api-keys.json")),
      true,
      ".api-keys.json should be persisted in hostDir",
    );

    // Clear a key via empty string
    const clearKeyRes = await fetch(`${base}/api/keys`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openai: "" }),
    });
    assert.equal(clearKeyRes.status, 200);
    const clearKeyBody = await clearKeyRes.json();
    assert.equal(clearKeyBody.keys.openai.configured, false);

    // 3. POST /api/harnesses/configure activates a harness in-process without env var restart
    const confRes = await fetch(`${base}/api/harnesses/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        harness: "claude",
        name: "Configured Claude",
        model: { provider: "anthropic", model: "claude-3-7-sonnet" },
      }),
    });
    assert.equal(confRes.status, 200);
    const confBody = await confRes.json();
    assert.equal(confBody.ok, true);
    assert.equal(confBody.activeHarness, "claude");
    assert.equal(
      fs.existsSync(path.join(server.extensionsDir, ".harness-settings.json")),
      true,
      ".harness-settings.json should be persisted in hostDir",
    );

    const harnessesAfter = await (await fetch(`${base}/api/harnesses`)).json();
    assert.equal(harnessesAfter.activeHarness, "claude");
    const claudeEntry = harnessesAfter.entries.find((e) => e.id === "claude");
    assert.ok(claudeEntry, "claude entry should exist in /api/harnesses");
    assert.ok(
      claudeEntry.configuredAgents.some((a) => a.name === "Configured Claude"),
      "POST /api/harnesses/configure should register/update the configured agent",
    );
  } finally {
    await server.stop();
  }
});

test("Natural language file open/show/display/view/read and write/edit preview metadata", async () => {
  // 1. script() and parseRoomFolderTurn() resolve natural language open/show/display/view/read
  for (const phrase of [
    "open notes.txt in the ui",
    "show me notes.txt",
    "display src/app.js in the reader",
    "view README.md",
    "read config.json",
  ]) {
    const resolved = script(phrase);
    assert.equal(resolved.verb, "read", `script("${phrase}") should resolve to verb: "read"`);
    assert.ok(resolved.name, `script("${phrase}") should extract file name`);

    const folderTurn = parseRoomFolderTurn(phrase);
    assert.ok(folderTurn, `parseRoomFolderTurn("${phrase}") should match`);
    assert.equal(folderTurn.verb, "read");
    assert.equal(folderTurn.name, resolved.name);
  }

  // 2. Dynamic API key resolution in makeGeminiResolver / makeOpenAIResolver / makeClaudeResolver
  const savedGemini = process.env.GEMINI_API_KEY;
  const savedOpenai = process.env.OPENAI_API_KEY;
  const savedClaude = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    let seenKey = null;
    const fakeFetch = async (_url, init) => {
      seenKey = init?.headers?.["x-goog-api-key"] ?? null;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ verb: "read", name: "notes.txt", content: null }) }] } }],
        }),
      };
    };

    const geminiResolver = makeGeminiResolver({ fetchImpl: fakeFetch });
    const refusedBefore = await geminiResolver("open notes.txt");
    assert.match(refusedBefore.unresolved, /GEMINI_API_KEY/);

    process.env.GEMINI_API_KEY = "dynamic-gemini-key";
    const resolvedAfter = await geminiResolver("open notes.txt");
    assert.equal(resolvedAfter.verb, "read");
    assert.equal(resolvedAfter.name, "notes.txt");
    assert.equal(seenKey, "dynamic-gemini-key");

    const openaiResolver = makeOpenAIResolver({ fetchImpl: async () => ({ ok: false, status: 401 }) });
    assert.match((await openaiResolver("open notes.txt")).unresolved, /OPENAI_API_KEY/);

    const claudeResolver = makeClaudeResolver({ fetchImpl: async () => ({ ok: false, status: 401 }) });
    assert.match((await claudeResolver("open notes.txt")).unresolved, /ANTHROPIC_API_KEY/);
  } finally {
    if (savedGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedGemini;
    if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOpenai;
    if (savedClaude === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedClaude;
  }

  // 3. Server write, edit, and read return file, bytes, and preview
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vb-preview-test-"));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: workspace } });
  try {
    const base = server.base;
    const writeRes = await fetch(`${base}/api/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "notes.txt", content: "Hello world from voicebox" }),
    });
    assert.equal(writeRes.status, 200);
    const writeBody = await writeRes.json();
    assert.equal(writeBody.ok, true);
    assert.equal(writeBody.file, "notes.txt");
    assert.equal(typeof writeBody.bytes, "number");
    assert.equal(writeBody.preview, "Hello world from voicebox");

    const editRes = await fetch(`${base}/api/file`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "notes.txt", oldText: "world", newText: "friends" }),
    });
    assert.equal(editRes.status, 200);
    const editBody = await editRes.json();
    assert.equal(editBody.ok, true);
    assert.equal(editBody.file, "notes.txt");
    assert.equal(typeof editBody.bytes, "number");
    assert.equal(editBody.preview, "Hello friends from voicebox");

    const turnReadRes = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "open notes.txt in the ui" }),
    });
    assert.equal(turnReadRes.status, 200);
    const turnReadBody = await turnReadRes.json();
    assert.equal(turnReadBody.action?.verb, "read");
    assert.equal(turnReadBody.result?.ok, true);
    assert.equal(turnReadBody.result?.file, "notes.txt");
    assert.equal(turnReadBody.result?.content, "Hello friends from voicebox");
    assert.equal(typeof turnReadBody.result?.bytes, "number");
  } finally {
    await server.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
