// tests/claude-acp.test.mjs — voicebox-beads-a74y: claude-code adapter executor.
// HERMETIC (the 4iv lesson): stub adapter package + in-process protocol harness.
// The stub matches CLAUDE_ACP_AGENT by construction; VOICEBOX_CLAUDE_ACP_ADAPTER
// overrides deliberately. The one real-adapter smoke is env-gated.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createClaudeAcpExecutor,
  claudeChildEnv,
  describeClaudeAdapterInstall,
  resolveClaudeCli,
  CLAUDE_ACP_AGENT,
} from "../lib/claude-acp.mjs";

function stubAdapterDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-claude-acp-stub-"));
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: CLAUDE_ACP_AGENT.name,
    version: CLAUDE_ACP_AGENT.version,
    bin: { "claude-agent-acp": "dist/index.js" },
  }));
  fs.writeFileSync(path.join(dir, "dist/index.js"), "// stub entry for protocol unit tests\n");
  return dir;
}

function protocolHarness(options = {}) {
  const sent = [];
  const state = { initialized: false, session: null, modelId: null, prompt: null, permissions: [] };
  const transport = {
    onMessage(fn) { state.receive = fn; },
    onClose(fn) { state.close = fn; },
    send(m) {
      sent.push(m);
      queueMicrotask(() => {
        if (m.method === "initialize") {
          state.initialized = true;
          state.receive({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: CLAUDE_ACP_AGENT.name, version: CLAUDE_ACP_AGENT.version } } });
        } else if (m.method === "session/new") {
          state.session = "claude-test-session";
          state.receive({ jsonrpc: "2.0", id: m.id, result: { sessionId: state.session, configOptions: [], models: { availableModels: [] }, modes: { availableModes: [] } } });
        } else if (m.method === "session/set_config_option") {
          if (options.unsupportedModel && m.params.configId === "model") {
            state.receive({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Unknown modelId" } });
            return;
          }
          state.modelId = m.params.value;
          state.receive({ jsonrpc: "2.0", id: m.id, result: { configOptions: [] } });
        } else if (m.method === "session/prompt") {
          state.prompt = m.params.prompt?.[0]?.text;
          if (options.requestPermission) {
            state.receive({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: {
              sessionId: state.session,
              title: `Permission: ${options.requestPermission.tool}`,
              toolCall: { name: options.requestPermission.tool },
              options: [{ optionId: "a", kind: "allow_once" }],
            } });
          }
          state.receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId: state.session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: options.reply ?? "claude done" } } } });
          state.receive({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
        } else if (m.id === "perm-1") {
          state.permissions.push(m.result);
        }
      });
    },
    close() {},
  };
  return { transport, sent, state };
}

test("claude executor admits harness claude/claude-code and refuses others by name", () => {
  const dir = stubAdapterDir();
  const executor = createClaudeAcpExecutor({ adapterDir: dir, claudeCli: process.execPath });
  for (const harness of ["claude", "claude-code"]) {
    const r = executor.check({ input: { agent: harness, task: "x" } });
    assert.equal(r.ok, true, harness);
    assert.match(r.mechanism, /local install/, "must say WHICH adapter source ran");
    assert.match(r.mechanism, new RegExp(process.execPath), "must name the explicit CLI");
    assert.ok(r.bounds.deadlineMs > 0 && r.bounds.maxOutputBytes > 0);
  }
  const bad = executor.check({ input: { agent: "codex" } });
  assert.equal(bad.refused, "adapter-not-configured");
  const pinned = executor.check({ agentConfig: { adapter: "claude-code", pinnedVersion: "9.9.9" } });
  assert.equal(pinned.refused, "adapter-version-unsupported");
  const transport = executor.check({ agentConfig: { adapter: "claude-code", transport: "http" } });
  assert.equal(transport.refused, "unsupported-runtime-capability");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("model capability is NOT refused at check — the adapter's answer is the truth at run", async () => {
  const dir = stubAdapterDir();
  const harness = protocolHarness({ unsupportedModel: true });
  const executor = createClaudeAcpExecutor({
    adapterDir: dir,
    transportFactory: () => ({ transport: harness.transport, kill: () => {} }),
  });
  const admitted = executor.check({ agentConfig: { adapter: "claude-code", model: "unheard-of-model" }, input: {} });
  assert.equal(admitted.ok, true, "check must not fabricate a capability verdict (see NOTE in claude-acp.mjs)");
  await assert.rejects(
    executor.run({ input: { task: "t" }, agentConfig: { model: "unheard-of-model" } }),
    (err) => err.refused === "model-unsupported",
    "the adapter's refusal must surface named",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("claude run: initialize → session → prompt with persona prefix, CLAUDE_CODE_EXECUTABLE env honored", async () => {
  const dir = stubAdapterDir();
  const harness = protocolHarness({ reply: "42" });
  let seenEnv;
  const executor = createClaudeAcpExecutor({
    adapterDir: dir,
    claudeCli: process.execPath,
    transportFactory: (ctx) => { seenEnv = ctx.env.CLAUDE_CODE_EXECUTABLE; return { transport: harness.transport, kill: () => {} }; },
  });
  const text = await executor.run({ input: { task: "what is 6*7?" }, agentConfig: { prompt: "answer tersely" } });
  assert.equal(typeof text, "string");
  assert.match(text, /42/);
  assert.equal(seenEnv, process.execPath, "explicit CLI flows as CLAUDE_CODE_EXECUTABLE");
  assert.match(harness.state.prompt, /\[System Instructions: answer tersely\]/);
  assert.match(harness.state.prompt, /what is 6\*7\?/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reach scoping denies out-of-reach tools before the host decides", async () => {
  const dir = stubAdapterDir();
  const harness = protocolHarness({ requestPermission: { tool: "write_file" } });
  let hostAsked = 0;
  const executor = createClaudeAcpExecutor({
    adapterDir: dir,
    transportFactory: () => ({ transport: harness.transport, kill: () => {} }),
    decide: async () => { hostAsked++; return { allow: true }; },
  });
  await executor.run({ input: { task: "edit" }, agentConfig: { reach: { tools: ["read_file"] } } });
  assert.equal(hostAsked, 0, "out-of-reach must never consult the permission host");
  assert.ok(harness.state.permissions.length >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("install resolution: local dir first, pinned npx only when PATH has npx, named refusal when neither", () => {
  const dir = stubAdapterDir();
  const local = describeClaudeAdapterInstall({ adapterDir: dir });
  assert.equal(local.ok, true); assert.equal(local.via, "local");
  const savedPath = process.env.PATH;
  try {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "vb-npx-"));
    fs.writeFileSync(path.join(bin, "npx"), "#!/bin/sh\n");
    process.env.PATH = bin;
    const npx = describeClaudeAdapterInstall({ adapterDir: path.join(dir, "missing") });
    assert.equal(npx.ok, true); assert.equal(npx.via, "npx");
    assert.deepEqual(npx.args, ["-y", `${CLAUDE_ACP_AGENT.name}@${CLAUDE_ACP_AGENT.version}`], "npx must PIN the version");
    process.env.PATH = "/nonexistent-dir";
    const none = describeClaudeAdapterInstall({ adapterDir: path.join(dir, "missing") });
    assert.equal(none.ok, false); assert.match(none.why, /npx is not on PATH/);
  } finally { process.env.PATH = savedPath; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI resolution: explicit file required; absent config reports the bundled SDK fallback, never a claimed CLI", () => {
  const missing = resolveClaudeCli({ claudeCli: "/no/such/claude" });
  assert.equal(missing.ok, false); assert.match(missing.why, /not a file/);
  const fallback = resolveClaudeCli({});
  assert.ok(!fallback.ok || typeof fallback.ran === "string");
  if (!fallback.path) assert.match(fallback.ran, /bundled/);
});

test("live claude smoke (opt-in only): VOICEBOX_LIVE_CLAUDE=1 runs ONE trivial prompt", { skip: process.env.VOICEBOX_LIVE_CLAUDE !== "1" && "no live claude acceptance; recorded on the bead when run", timeout: 120000 }, async () => {
  const executor = createClaudeAcpExecutor({});
  const admission = executor.check({ input: { agent: "claude-code" } });
  assert.equal(admission.ok, true);
  const text = await executor.run({ input: { task: "Reply with exactly: OK" }, bounds: { deadlineMs: 60000 } });
  assert.match(String(text), /OK/);
});

// ── voicebox-beads-nz60: the host's ANTHROPIC_API_KEY must not reach the adapter child ───────────
// WHY: an inherited key overrides claude.ai login inside the adapter and can stall the prompt
// (measured on the sibling implementation's review; this box carries the key). The two tests below
// split the question deliberately: the first is the pure rule (and pins ABSENCE, not
// present-with-undefined, because those are different child environments), the second proves `run()`
// actually builds the child env through that rule — captured from the transportFactory, which is the
// same seam the child is spawned from, without spawning anything.
test("claude child env: the key is ABSENT (not undefined-valued) by default, and only an explicit opt-back keeps it (voicebox-beads-nz60)", () => {
  const hostEnv = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-host", OTHER: "kept" };
  const child = claudeChildEnv({ hostEnv, extraEnv: { CLAUDE_EXTRA: "y" } });
  assert.equal("ANTHROPIC_API_KEY" in child, false, "the key must be ABSENT — present-with-undefined is a different child env");
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.OTHER, "kept");
  assert.equal(child.CLAUDE_EXTRA, "y");
  assert.equal(hostEnv.ANTHROPIC_API_KEY, "sk-ant-host", "the host object is never mutated");

  // A caller cannot re-add it through extraEnv without an opt-back.
  const sneaky = claudeChildEnv({ hostEnv: {}, extraEnv: { ANTHROPIC_API_KEY: "sk-ant-caller" } });
  assert.equal("ANTHROPIC_API_KEY" in sneaky, false, "extraEnv is not a second door for the key");

  // The two opt-back forms, and the forms that must NOT work.
  assert.equal(claudeChildEnv({ hostEnv: { ANTHROPIC_API_KEY: "k", VOICEBOX_CLAUDE_KEEP_API_KEY: "1" } }).ANTHROPIC_API_KEY, "k");
  assert.equal(claudeChildEnv({ hostEnv: { ANTHROPIC_API_KEY: "k" }, keepApiKey: true }).ANTHROPIC_API_KEY, "k");
  for (const flag of ["true", "0", "yes", ""]) {
    assert.equal("ANTHROPIC_API_KEY" in claudeChildEnv({ hostEnv: { ANTHROPIC_API_KEY: "k", VOICEBOX_CLAUDE_KEEP_API_KEY: flag } }), false, `flag '${flag}' must not keep the key`);
  }
  assert.equal("ANTHROPIC_API_KEY" in claudeChildEnv({ hostEnv: { ANTHROPIC_API_KEY: "k" }, keepApiKey: false }), false);

  // The CLI path still flows, and never re-adds the key.
  const withCli = claudeChildEnv({ hostEnv: { ANTHROPIC_API_KEY: "k" }, cliPath: "/usr/bin/claude" });
  assert.equal(withCli.CLAUDE_CODE_EXECUTABLE, "/usr/bin/claude");
  assert.equal("ANTHROPIC_API_KEY" in withCli, false);
});

test("claude run: the spawned child env carries NO ANTHROPIC_API_KEY by default, and carries it only with the opt-back (voicebox-beads-nz60)", async () => {
  const dir = stubAdapterDir();
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedFlag = process.env.VOICEBOX_CLAUDE_KEEP_API_KEY;
  const captured = [];
  const capture = (harness) => (ctx) => { captured.push(ctx.env); return { transport: harness.transport, kill: () => {} }; };
  try {
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-must-not-reach-the-child";
    delete process.env.VOICEBOX_CLAUDE_KEEP_API_KEY;

    const executor = createClaudeAcpExecutor({ adapterDir: dir, transportFactory: capture(protocolHarness({ reply: "ok" })) });
    await executor.run({ input: { task: "hi" } });
    assert.equal("ANTHROPIC_API_KEY" in captured[0], false, "run() must pass a child env with the key ABSENT");
    assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-host-must-not-reach-the-child", "the host's own environment is untouched");

    // A caller that means it: the programmatic opt-back.
    const keepExecutor = createClaudeAcpExecutor({ adapterDir: dir, keepApiKey: true, transportFactory: capture(protocolHarness({ reply: "ok" })) });
    await keepExecutor.run({ input: { task: "hi" } });
    assert.equal(captured[1].ANTHROPIC_API_KEY, "sk-ant-host-must-not-reach-the-child", "keepApiKey: true is an explicit opt-back");

    // An owner's shell: the environment opt-back.
    process.env.VOICEBOX_CLAUDE_KEEP_API_KEY = "1";
    const flagExecutor = createClaudeAcpExecutor({ adapterDir: dir, transportFactory: capture(protocolHarness({ reply: "ok" })) });
    await flagExecutor.run({ input: { task: "hi" } });
    assert.equal(captured[2].ANTHROPIC_API_KEY, "sk-ant-host-must-not-reach-the-child", "VOICEBOX_CLAUDE_KEEP_API_KEY=1 is an explicit opt-back");
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedFlag === undefined) delete process.env.VOICEBOX_CLAUDE_KEEP_API_KEY; else process.env.VOICEBOX_CLAUDE_KEEP_API_KEY = savedFlag;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bounds: the claude ceiling admits a 120s deadline that pi's 60s clamp would refuse (voicebox-beads-hmco)", () => {
  const dir = stubAdapterDir();
  const executor = createClaudeAcpExecutor({ adapterDir: dir, claudeCli: process.execPath });
  const admitted = executor.check({ input: { agent: "claude" }, bounds: { deadlineMs: 120000 } });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(admitted.bounds.deadlineMs, 120000, "the claude ceiling admits the full 120s");
});

test("bounds: a claude run with a 120s deadline completes over the scripted harness — the ceiling plumbs to the client (voicebox-beads-hmco)", { timeout: 20000 }, async () => {
  const dir = stubAdapterDir();
  const harness = protocolHarness({ reply: "OK" });
  const executor = createClaudeAcpExecutor({
    adapterDir: dir,
    claudeCli: process.execPath,
    transportFactory: () => ({ transport: harness.transport, kill: () => {} }),
  });
  const text = await executor.run({
    input: { task: "Reply with exactly: OK" },
    bounds: { deadlineMs: 120000 },
    agentConfig: { id: "agent_claude_ceiling", harness: "claude", adapter: "claude-code" },
  });
  assert.match(String(text), /OK/, "a 120s deadline must be admitted and run, not refused as unbounded");
});
