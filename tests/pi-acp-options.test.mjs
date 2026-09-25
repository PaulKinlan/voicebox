// tests/pi-acp-options.test.mjs — Verify real Pi consumption of configured options or refuse unsupported claims (voicebox-beads-ozf)
//
// Acceptance:
//   1. Determine which options the installed adapter contract supports (model, thought_level, prompt/persona, reach).
//   2. Refuse unsupported configuration explicitly before effects (adapter mismatch, pinnedVersion mismatch, transport mismatch, custom model options).
//   3. Keep needed reach distinct from granted effect authority (scoped decider denies tools outside reach.tools before consulting host authority).
//   4. Credential-free protocol/effect controls distinguish two configured instances (e.g. read-only reviewer vs builder).
//   5. Do not claim real model execution from fixture output.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPiAcpExecutor } from "../lib/pi-acp.mjs";
import { ACP_AGENT } from "../lib/acp-client.mjs";

// HERMETIC BY DEFAULT (voicebox-beads-4iv, 2026-09-25): the unit lane must not depend on the
// machine's installed adapter. This fixture PREFERRED the installed pi-acp when present, so
// today's pi update (adapter 0.0.33 -> 0.0.34 on this box) silently moved these option-layer
// tests onto the real adapter — whose version gate refuses every run() BEFORE the
// model/thinking layers these tests exist to pin. Red for every lane, on pristine main too.
// The stub matches the ACP_AGENT pin by construction, so what gets verified here is the
// executor's layered refusal logic, on any machine, at any installed version. The real
// adapter's version gate is the probe's and the live lane's business (and re-pinning
// ACP_AGENT to 0.0.34 is the surface owner's verification decision, recorded on 4iv).
// VOICEBOX_ACP_ADAPTER still overrides — a deliberate opt-in to machine dependence.
const adapterDir = (() => {
  const candidate = process.env.VOICEBOX_ACP_ADAPTER;
  if (candidate && fs.existsSync(path.join(candidate, "package.json")) && fs.existsSync(path.join(candidate, "dist/index.js"))) return candidate;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-pi-acp-stub-")));
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: ACP_AGENT.name, version: ACP_AGENT.version }));
  fs.writeFileSync(path.join(dir, "dist/index.js"), "// stub for protocol harness unit tests\n");
  return dir;
})();

function createProtocolHarness(options = {}) {
  const sent = [];
  const state = {
    initialized: false,
    session: null,
    modelId: null,
    thoughtLevel: null,
    prompt: null,
    receivedPermissions: [],
  };

  const transport = {
    onMessage(fn) { state.receive = fn; },
    onClose(fn) { state.close = fn; },
    send(m) {
      sent.push(m);
      queueMicrotask(() => {
        if (m.method === "initialize") {
          state.initialized = true;
          state.receive({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: ACP_AGENT.name, version: ACP_AGENT.version } } });
        } else if (m.method === "session/new") {
          state.session = "test-session-123";
          state.receive({ jsonrpc: "2.0", id: m.id, result: { sessionId: state.session, configOptions: [], models: { availableModels: [] }, modes: { availableModes: [] } } });
        } else if (m.method === "session/set_config_option") {
          if (m.params.configId === "model") {
            if (options.unsupportedModels?.includes(m.params.value)) {
              state.receive({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown modelId: ${m.params.value}` } });
              return;
            }
            state.modelId = m.params.value;
            state.receive({ jsonrpc: "2.0", id: m.id, result: { configOptions: [] } });
          } else if (m.params.configId === "thought_level") {
            if (options.unsupportedThinking?.includes(m.params.value)) {
              state.receive({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown thinking level: ${m.params.value}` } });
              return;
            }
            state.thoughtLevel = m.params.value;
            state.receive({ jsonrpc: "2.0", id: m.id, result: { configOptions: [] } });
          } else {
            state.receive({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `Unknown config option: ${m.params.configId}` } });
          }
        } else if (m.method === "session/prompt") {
          state.prompt = m.params.prompt?.[0]?.text;
          // If the test requests a permission check during prompt:
          if (options.requestPermission) {
            state.receive({
              jsonrpc: "2.0",
              id: "perm-call-1",
              method: "session/request_permission",
              params: {
                sessionId: state.session,
                ...(options.requestPermission.params ?? {
                  title: `Permission: ${options.requestPermission.tool}`,
                  toolCall: { name: options.requestPermission.tool, args: options.requestPermission.args ?? {} },
                }),
                options: [{ optionId: "opt-allow", kind: "allow_once" }, { optionId: "opt-deny", kind: "reject_once" }],
              },
            });
          }
          state.receive({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: state.session,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: options.answerText ?? "task completed text" },
              },
            },
          });
          state.receive({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
        } else if (m.id === "perm-call-1") {
          state.receivedPermissions.push(m.result);
        }
      });
    },
    close() {},
  };

  return { transport, sent, state };
}

test("pi executor check: refuses unsupported adapter, version, transport, and model options explicitly", () => {
  const executor = createPiAcpExecutor({ adapterDir });

  // 1. Adapter must be pi-acp
  const wrongAdapter = executor.check({
    agentConfig: { harness: "pi", adapter: "claude-code" },
  });
  assert.equal(wrongAdapter.ok, false);
  assert.equal(wrongAdapter.refused, "adapter-not-configured");
  assert.match(wrongAdapter.why, /only supports adapter 'pi-acp'/);

  // 2. Pinned version must match installed pi-acp version
  const wrongVersion = executor.check({
    agentConfig: { harness: "pi", adapter: "pi-acp", pinnedVersion: "999.0.0" },
  });
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.refused, "adapter-version-unsupported");
  assert.match(wrongVersion.why, /pinned adapter version/);

  // 3. Transport must be stdio
  const wrongTransport = executor.check({
    agentConfig: { harness: "pi", adapter: "pi-acp", transport: "websocket" },
  });
  assert.equal(wrongTransport.ok, false);
  assert.equal(wrongTransport.refused, "unsupported-runtime-capability");
  assert.match(wrongTransport.why, /only supports 'stdio' transport/);

  // 4. Custom model options are unsupported by pi-acp
  const unsupportedOptions = executor.check({
    agentConfig: {
      harness: "pi",
      adapter: "pi-acp",
      model: { id: "gemini-2.0-flash", options: { temperature: 0.7 } },
    },
  });
  assert.equal(unsupportedOptions.ok, false);
  assert.equal(unsupportedOptions.refused, "unsupported-model-options");
  assert.match(unsupportedOptions.why, /does not support custom model options/);

  // 5. Valid configured options pass
  const valid = executor.check({
    agentConfig: {
      harness: "pi",
      adapter: "pi-acp",
      pinnedVersion: ACP_AGENT.version,
      transport: "stdio",
      model: { provider: "google", id: "gemini-2.0-flash", thinking: "low" },
      prompt: "You are a helper.",
      reach: { tools: ["read"], root: "active", network: "none" },
      bounds: { deadlineMs: 5000, maxOutputBytes: 1024 },
    },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.bounds.deadlineMs, 5000);
  assert.equal(valid.bounds.maxOutputBytes, 1024);
});

test("credential-free protocol controls: distinguish two configured agent instances (reviewer vs builder)", async () => {
  let harnessA;
  let harnessB;

  const executorA = createPiAcpExecutor({
    adapterDir,
    transportFactory: () => {
      harnessA = createProtocolHarness();
      return { transport: harnessA.transport };
    },
  });

  const executorB = createPiAcpExecutor({
    adapterDir,
    transportFactory: () => {
      harnessB = createProtocolHarness();
      return { transport: harnessB.transport };
    },
  });

  // Instance A: Read-only reviewer with gemini low thinking
  const agentA = {
    id: "agent_reviewer",
    name: "Code Reviewer",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    model: { provider: "google", id: "gemini-2.0-flash", thinking: "low" },
    prompt: "You are an expert read-only code reviewer.",
    reach: { tools: ["read"], root: "active", network: "none" },
    bounds: { deadlineMs: 10000, maxOutputBytes: 4096 },
  };

  // Instance B: Builder with gpt-4o high thinking
  const agentB = {
    id: "agent_builder",
    name: "System Builder",
    harness: "pi",
    adapter: "pi-acp",
    transport: "stdio",
    model: { provider: "openai", id: "gpt-4o", thinking: "high" },
    prompt: "You are a code builder and repair agent.",
    reach: { tools: ["read", "write", "bash"], root: "active", network: "none" },
    bounds: { deadlineMs: 10000, maxOutputBytes: 4096 },
  };

  const resA = await executorA.run({
    input: { task: "Check syntax in index.js" },
    agentConfig: agentA,
    root: { path: "/work" },
  });
  assert.equal(resA, "task completed text");
  assert.equal(harnessA.state.modelId, "google/gemini-2.0-flash");
  assert.equal(harnessA.state.thoughtLevel, "low");
  assert.match(harnessA.state.prompt, /\[System Instructions: You are an expert read-only code reviewer\.\]/);
  assert.match(harnessA.state.prompt, /Check syntax in index\.js/);

  const resB = await executorB.run({
    input: { task: "Implement feature X" },
    agentConfig: agentB,
    root: { path: "/work" },
  });
  assert.equal(resB, "task completed text");
  assert.equal(harnessB.state.modelId, "openai/gpt-4o");
  assert.equal(harnessB.state.thoughtLevel, "high");
  assert.match(harnessB.state.prompt, /\[System Instructions: You are a code builder and repair agent\.\]/);
  assert.match(harnessB.state.prompt, /Implement feature X/);
});

test("effect controls: needed reach is distinct from granted effect authority", async () => {
  // Host effect authority grants everything requested
  const hostDecider = async () => ({ allow: true });

  // 1. Instance with reach.tools = ["read"] requests tool 'write'
  let harnessRead;
  const executorRead = createPiAcpExecutor({
    adapterDir,
    decide: hostDecider,
    transportFactory: () => {
      harnessRead = createProtocolHarness({ requestPermission: { tool: "write", args: { path: "file.txt" } } });
      return { transport: harnessRead.transport };
    },
  });

  await executorRead.run({
    input: { task: "Attempt write" },
    agentConfig: {
      id: "agent_read_only",
      harness: "pi",
      adapter: "pi-acp",
      reach: { tools: ["read"], root: "active", network: "none" },
    },
    root: { path: "/work" },
  });

  // Even though hostDecider would allow, the tool was outside agentConfig.reach.tools:
  // Wire must receive cancellation (denial)
  assert.equal(harnessRead.state.receivedPermissions.length, 1);
  assert.deepEqual(harnessRead.state.receivedPermissions[0], { outcome: { outcome: "cancelled" } });

  // 2. Instance with reach.tools = ["read", "write"] requests tool 'write'
  let harnessWrite;
  const executorWrite = createPiAcpExecutor({
    adapterDir,
    decide: hostDecider,
    transportFactory: () => {
      harnessWrite = createProtocolHarness({ requestPermission: { tool: "write", args: { path: "file.txt" } } });
      return { transport: harnessWrite.transport };
    },
  });

  await executorWrite.run({
    input: { task: "Authorized write" },
    agentConfig: {
      id: "agent_read_write",
      harness: "pi",
      adapter: "pi-acp",
      reach: { tools: ["read", "write"], root: "active", network: "none" },
    },
    root: { path: "/work" },
  });

  // Tool is within reach and host allows: wire receives selection grant
  assert.equal(harnessWrite.state.receivedPermissions.length, 1);
  assert.deepEqual(harnessWrite.state.receivedPermissions[0], { outcome: { outcome: "selected", optionId: "opt-allow" } });

  // 3. Installed-adapter-shaped request (toolCall.title/rawInput.title with no toolCall.name)
  let harnessAdapterShape;
  let hostDecisions = 0;
  const executorAdapterShape = createPiAcpExecutor({
    adapterDir,
    decide: async () => { hostDecisions++; return { allow: true }; },
    transportFactory: () => {
      harnessAdapterShape = createProtocolHarness({
        requestPermission: {
          params: {
            toolCall: {
              toolCallId: "pi-ui-owned-confirm",
              title: "Permission: write",
              kind: "other",
              status: "pending",
              rawInput: { method: "confirm", title: "Permission: write", message: "Write the file" },
            },
          },
        },
      });
      return { transport: harnessAdapterShape.transport };
    },
  });

  await executorAdapterShape.run({
    input: { task: "Adapter-shaped write" },
    agentConfig: {
      id: "agent_read_only_adapter_shape",
      harness: "pi",
      adapter: "pi-acp",
      reach: { tools: ["read"], root: "active", network: "none" },
    },
    root: { path: "/work" },
  });

  // Bypassed name, but parsed title: tool 'write' is outside reach ['read'], denied before outer policy
  assert.equal(hostDecisions, 0, "host decider must not be called when tool is outside declared reach");
  assert.equal(harnessAdapterShape.state.receivedPermissions.length, 1);
  assert.deepEqual(harnessAdapterShape.state.receivedPermissions[0], { outcome: { outcome: "cancelled" } });

  // 4. Explicit empty tool reach cannot become unrestricted tool access
  let harnessEmptyTools;
  let emptyHostDecisions = 0;
  const executorEmptyTools = createPiAcpExecutor({
    adapterDir,
    decide: async () => { emptyHostDecisions++; return { allow: true }; },
    transportFactory: () => {
      harnessEmptyTools = createProtocolHarness({ requestPermission: { tool: "write", args: { path: "file.txt" } } });
      return { transport: harnessEmptyTools.transport };
    },
  });

  await executorEmptyTools.run({
    input: { task: "Empty tools write" },
    agentConfig: {
      id: "agent_empty_tools",
      harness: "pi",
      adapter: "pi-acp",
      reach: { tools: [], root: "active", network: "none" },
    },
    root: { path: "/work" },
  });

  assert.equal(emptyHostDecisions, 0, "host decider must not be called when reach.tools is empty []");
  assert.equal(harnessEmptyTools.state.receivedPermissions.length, 1);
  assert.deepEqual(harnessEmptyTools.state.receivedPermissions[0], { outcome: { outcome: "cancelled" } });
});

test("refusal demonstration: unsupported model returned by adapter fails before prompt", async () => {
  let harness;
  const executor = createPiAcpExecutor({
    adapterDir,
    transportFactory: () => {
      harness = createProtocolHarness({ unsupportedModels: ["custom/nonexistent-model"] });
      return { transport: harness.transport };
    },
  });

  await assert.rejects(
    executor.run({
      input: { task: "Run on missing model" },
      agentConfig: {
        id: "agent_missing_model",
        harness: "pi",
        adapter: "pi-acp",
        model: { id: "custom/nonexistent-model" },
      },
      root: { path: "/work" },
    }),
    (err) => {
      assert.equal(err.refused, "model-unsupported");
      assert.match(err.message, /not supported by the adapter/);
      assert.equal(harness.state.prompt, null, "prompt must not be sent when model configuration fails");
      return true;
    }
  );
});

test("refusal demonstration: unsupported thinking level returned by adapter fails before prompt", async () => {
  let harness;
  const executor = createPiAcpExecutor({
    adapterDir,
    transportFactory: () => {
      harness = createProtocolHarness({ unsupportedThinking: ["ultra-max"] });
      return { transport: harness.transport };
    },
  });

  await assert.rejects(
    executor.run({
      input: { task: "Run on missing thinking" },
      agentConfig: {
        id: "agent_missing_thinking",
        harness: "pi",
        adapter: "pi-acp",
        model: { id: "valid-model", thinking: "ultra-max" },
      },
      root: { path: "/work" },
    }),
    (err) => {
      assert.equal(err.refused, "thinking-level-unsupported");
      assert.match(err.message, /not supported/);
      assert.equal(harness.state.prompt, null, "prompt must not be sent when thinking level configuration fails");
      return true;
    }
  );
});
