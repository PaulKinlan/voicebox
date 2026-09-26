// tests/claude-acp.test.mjs — the claude-code task adapter (voicebox-beads-a74y).
//
// Mirrors the pi-acp test contract with a SCRIPTED fake adapter transport — no real
// claude CLI, no npx download, no provider. The one real smoke is separate and gated
// on VOICEBOX_CLAUDE_SMOKE=1.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeAcpExecutor, describeClaudeAdapterInstall, CLAUDE_ACP_AGENT } from "../lib/claude-acp.mjs";

/** A fixture package directory that LOOKS like the pinned adapter install. */
function fakeAdapterDir(t, { name = CLAUDE_ACP_AGENT.name, version = CLAUDE_ACP_AGENT.version, withEntry = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-acp-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  if (withEntry) {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "index.js"), "// fixture entry\n");
  }
  return dir;
}

test("describe: explicit adapter path that does not exist refuses adapter-unavailable and never falls through to npx", (t) => {
  const described = describeClaudeAdapterInstall({ adapterDir: "/nonexistent/voicebox-a74y-test", env: { PATH: "/usr/bin" } });
  assert.equal(described.ok, false);
  assert.equal(described.refused, "adapter-unavailable");
  assert.match(described.why, /voicebox-a74y-test/);
});

test("describe: wrong package version refuses adapter-version-unsupported naming the pin", (t) => {
  const dir = fakeAdapterDir(t, { version: "0.0.1" });
  const described = describeClaudeAdapterInstall({ adapterDir: dir });
  assert.equal(described.ok, false);
  assert.equal(described.refused, "adapter-version-unsupported");
  assert.match(described.why, new RegExp(`${CLAUDE_ACP_AGENT.version.replaceAll(".", "\\.")}`));
});

test("describe: a valid local install answers ok with via 'local' and its entry", (t) => {
  const dir = fakeAdapterDir(t);
  const described = describeClaudeAdapterInstall({ adapterDir: dir });
  assert.equal(described.ok, true);
  assert.equal(described.via, "local");
  assert.ok(described.entry.endsWith(path.join("dist", "index.js")));
  assert.equal(described.installedVersion, CLAUDE_ACP_AGENT.version);
});

test("describe: no local install and no npx on PATH refuses adapter-unavailable", () => {
  const described = describeClaudeAdapterInstall({ env: { PATH: "", VOICEBOX_CLAUDE_ACP_ADAPTER: "" } });
  assert.equal(described.ok, false);
  assert.equal(described.refused, "adapter-unavailable");
  assert.match(described.why, /npx/);
});

test("check: refusal contract for wrong harness, foreign adapter, version pin, transport and model options", (t) => {
  const dir = fakeAdapterDir(t);
  const executor = createClaudeAcpExecutor({ adapterDir: dir });

  assert.equal(executor.check({ input: { agent: "pi", task: "x" } }).refused, "adapter-not-configured");
  assert.equal(executor.check({ agentConfig: { harness: "claude", adapter: "pi-acp" } }).refused, "adapter-not-configured");

  const wrongPin = executor.check({ agentConfig: { harness: "claude", adapter: "claude-code", pinnedVersion: "0.0.1" } });
  assert.equal(wrongPin.refused, "adapter-version-unsupported");

  const badTransport = executor.check({ agentConfig: { harness: "claude", adapter: "claude-code", transport: "websocket" } });
  assert.equal(badTransport.refused, "unsupported-runtime-capability");

  const modelOptions = executor.check({ agentConfig: { harness: "claude", adapter: "claude-code", model: { model: "claude-sonnet-4-5", options: { temperature: 0.1 } } } });
  assert.equal(modelOptions.refused, "unsupported-model-options");
});

test("check: admitted check names its REAL adapter source and CLI source, and clamps bounds", (t) => {
  const dir = fakeAdapterDir(t);
  // A fake claude CLI on a synthetic PATH — the mechanism must name the PATH find.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-fixture-"));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(binDir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  const executor = createClaudeAcpExecutor({ adapterDir: dir, env: { PATH: binDir } });

  const admitted = executor.check({ agentConfig: { harness: "claude", adapter: "claude-code", bounds: { deadlineMs: 999999, maxOutputBytes: 999999 } } });
  assert.equal(admitted.ok, true);
  assert.match(admitted.mechanism, /local install/);
  assert.match(admitted.mechanism, /Claude CLI found on PATH/);
  assert.ok(!admitted.mechanism.includes(binDir), "the mechanism names the SOURCE, never the host path (inventory leak rule)");
  assert.equal(admitted.bounds.deadlineMs, 60000, "bounds clamp to the executor ceiling");
  assert.equal(admitted.bounds.maxOutputBytes, 65536);
});

test("check: no CLI anywhere is NOT fatal — the mechanism says bundled fallback and never claims a PATH CLI", (t) => {
  const dir = fakeAdapterDir(t);
  const executor = createClaudeAcpExecutor({ adapterDir: dir, env: { PATH: "", CLAUDE_CODE_EXECUTABLE: "" } });
  const admitted = executor.check({ input: { agent: "claude", task: "x" } });
  assert.equal(admitted.ok, true);
  assert.match(admitted.mechanism, /bundled fallback/);
  assert.ok(!/Claude CLI at/.test(admitted.mechanism), "no CLI was found, so none may be claimed");
});

/** A scripted ACP server over the in-memory transport — the same shape pi-acp's tests use. */
function createProtocolHarness(options = {}) {
  const state = { modelId: null, prompt: null, receivedPermissions: [] };
  const transport = {
    onMessage(fn) { state.receive = fn; },
    onClose(fn) { state.close = fn; },
    send(m) {
      queueMicrotask(() => {
        if (m.method === "initialize") {
          state.receive({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: CLAUDE_ACP_AGENT.name, version: CLAUDE_ACP_AGENT.version } } });
        } else if (m.method === "session/new") {
          state.receive({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-claude", configOptions: [] } });
        } else if (m.method === "session/set_config_option") {
          state.modelId = m.params.value;
          state.receive({ jsonrpc: "2.0", id: m.id, result: { configOptions: [] } });
        } else if (m.method === "session/prompt") {
          state.prompt = m.params.prompt?.[0]?.text;
          if (options.requestPermission) {
            state.receive({
              jsonrpc: "2.0", id: "perm-1", method: "session/request_permission",
              params: { sessionId: "s-claude", toolCall: { name: options.requestPermission.tool, args: {} } },
              options: [{ optionId: "opt-allow", kind: "allow_once" }, { optionId: "opt-deny", kind: "reject_once" }],
            });
          }
          state.receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-claude", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: options.answerText ?? "claude answer text" } } } });
          state.receive({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
        } else if (m.id === "perm-1") {
          state.receivedPermissions.push(m.result);
        }
      });
    },
    close() {},
  };
  return { transport, state };
}

test("run: parity with pi-acp over a scripted transport — session, prompt, model config, answer", async (t) => {
  const dir = fakeAdapterDir(t);
  let harness;
  const executor = createClaudeAcpExecutor({ adapterDir: dir, transportFactory: () => { harness = createProtocolHarness(); return { transport: harness.transport }; } });

  const answer = await executor.run({
    input: { task: "Summarise the diff" },
    agentConfig: {
      harness: "claude", adapter: "claude-code",
      transport: "stdio",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      prompt: "You are a reviewer.",
      reach: { tools: ["read"], root: "active", network: "none" },
      bounds: { deadlineMs: 10000, maxOutputBytes: 4096 },
    },
    root: { path: "/work" },
  });
  assert.equal(answer, "claude answer text");
  assert.equal(harness.state.modelId, "claude-sonnet-4-5", "claude model ids are NOT provider-prefixed (that is pi's shape)");
  assert.match(harness.state.prompt, /\[System Instructions: You are a reviewer\.\]/);
  assert.match(harness.state.prompt, /Summarise the diff/);
});

test("run: reach scoping denies an out-of-reach tool permission request", async (t) => {
  const dir = fakeAdapterDir(t);
  let harness;
  const executor = createClaudeAcpExecutor({ adapterDir: dir, transportFactory: () => { harness = createProtocolHarness({ requestPermission: { tool: "bash" } }); return { transport: harness.transport }; } });

  const answer = await executor.run({
    input: { task: "try to run a shell command" },
    agentConfig: { harness: "claude", adapter: "claude-code", reach: { tools: ["read"] } },
    root: { path: "/work" },
  });
  assert.equal(answer, "claude answer text");
  assert.equal(harness.state.receivedPermissions.length, 1);
  // Denial is 'cancelled' on the wire (acp-client.mjs deny()) — the out-of-reach tool was NOT granted.
  assert.equal(harness.state.receivedPermissions[0].outcome.outcome, "cancelled", "the out-of-reach tool must not be granted");
});

test("run: a broken adapter install refuses by name before any spawn", async () => {
  const executor = createClaudeAcpExecutor({ adapterDir: "/nonexistent/voicebox-a74y-test" });
  await assert.rejects(
    executor.run({ input: { task: "x" }, agentConfig: { harness: "claude", adapter: "claude-code" }, root: { path: "/work" } }),
    (err) => err.refused === "adapter-unavailable" && /voicebox-a74y-test/.test(err.message),
  );
});

test("run: ANTHROPIC_API_KEY is scoped out of the adapter child by default, kept on explicit request, host env never mutated (a74y/5f5u)", async (t) => {
  const dir = fakeAdapterDir(t);
  const hostEnvKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test-scoped-fixture";
  t.after(() => { if (hostEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = hostEnvKey; });

  const seen = [];
  const capture = (opts) => { seen.push(opts.env.ANTHROPIC_API_KEY ?? null); return { transport: createProtocolHarness().transport }; };

  // Default: the child does NOT inherit the key (the 5f5u stall mechanism).
  const executor = createClaudeAcpExecutor({ adapterDir: dir, transportFactory: capture });
  await executor.run({ input: { task: "x" }, agentConfig: { harness: "claude", adapter: "claude-code" }, root: { path: "/work" } });
  assert.equal(seen[0], null, "default: the adapter child env carries no ANTHROPIC_API_KEY");
  assert.equal(process.env.ANTHROPIC_API_KEY, "sk-test-scoped-fixture", "the HOST env is never mutated");

  // Explicit keep: the caller who wants the key to win gets it, on purpose.
  const keeping = createClaudeAcpExecutor({ adapterDir: dir, transportFactory: capture, keepApiKey: true });
  await keeping.run({ input: { task: "x" }, agentConfig: { harness: "claude", adapter: "claude-code" }, root: { path: "/work" } });
  assert.equal(seen[1], "sk-test-scoped-fixture", "keepApiKey preserves the inherited key for the child");
});

test("run: cancellation settles as task-cancelled, never a hung task", async (t) => {
  const dir = fakeAdapterDir(t);
  const executor = createClaudeAcpExecutor({
    adapterDir: dir,
    transportFactory: () => {
      // A transport that never answers — the abort must end the run.
      return { transport: { onMessage() {}, onClose() {}, send() {}, close() {} } };
    },
  });
  const controller = new AbortController();
  const pending = executor.run({ input: { task: "x" }, agentConfig: { harness: "claude" }, root: { path: "/work" }, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err.refused === "task-cancelled");
});
