// voicebox-beads-cwx5.10: an ACP agent is DATA. These tests drive lib/acp-agents.mjs against a real child
// process that speaks ACP on stdio (tests/fixtures/fake-acp-agent.mjs) — no model, no network, no account.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_ACP_AGENTS, RESERVED_ADAPTER_IDS, acpAgentChildEnv, createAcpAgentExecutor, loadAcpAgentSpecs,
  resolveAcpCommand, validateAcpAgentSpec,
} from "../lib/acp-agents.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const scratch = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a spec is validated as the command line it is", () => {
  const ok = validateAcpAgentSpec({ id: "muse-acp", command: "muse-code-acp", args: ["--stdio"], keepEnv: ["MUSE_TOKEN"] });
  assert.equal(ok.ok, true);
  assert.deepEqual({ ...ok.spec, args: [...ok.spec.args], keepEnv: [...ok.spec.keepEnv] },
    { id: "muse-acp", label: "muse-acp", command: "muse-code-acp", args: ["--stdio"], keepEnv: ["MUSE_TOKEN"], handshakeTimeoutMs: 120000, source: "host" });
  assert.ok(Object.isFrozen(ok.spec) && Object.isFrozen(ok.spec.args));
  for (const bad of [
    null, [], { command: "x" }, { id: "X", command: "x" }, { id: "a", command: "x" }, { id: "ok-id" },
    { id: "ok-id", command: "" }, { id: "ok-id", command: "a\nb" }, { id: "ok-id", command: "x", args: "acp" },
    { id: "ok-id", command: "x", args: [1] }, { id: "ok-id", command: "x", args: Array(33).fill("a") },
    { id: "ok-id", command: "x", keepEnv: ["lower"] }, { id: "ok-id", command: "x", handshakeTimeoutMs: 5 },
  ]) {
    const checked = validateAcpAgentSpec(bad);
    assert.equal(checked.refused, "acp-agent-spec-invalid", JSON.stringify(bad));
    assert.ok(checked.why);
  }
  // A spec cannot take over a name another executor already answers to: an existing row keeps what it runs.
  for (const id of RESERVED_ADAPTER_IDS.filter((name) => /^[a-z][a-z0-9-]+$/.test(name))) {
    assert.equal(validateAcpAgentSpec({ id, command: "x" }).ok, false, id);
  }
  for (const builtin of BUILTIN_ACP_AGENTS) assert.equal(validateAcpAgentSpec(builtin).ok, true, builtin.id);
  assert.deepEqual(BUILTIN_ACP_AGENTS.find((s) => s.id === "antigravity-acp").args, ["acp"]);
});

test("the host's file adds agents, replaces a built-in, and a bad entry is named without stopping the rest", (t) => {
  const hostDir = scratch(t, "vb-acp-agents-");
  assert.deepEqual(loadAcpAgentSpecs({ hostDir, file: undefined }).specs.map((s) => s.id), BUILTIN_ACP_AGENTS.map((s) => s.id), "no file: the built-ins");
  fs.writeFileSync(path.join(hostDir, "acp-agents.json"), JSON.stringify({ agents: [
    { id: "muse-acp", label: "Muse", command: "/opt/muse/bin/muse-code-acp" },
    { id: "gemini-acp", command: "gemini", args: ["--experimental-acp"] },
    { id: "claude", command: "evil" },
    { id: "broken" },
  ] }));
  const loaded = loadAcpAgentSpecs({ hostDir, file: undefined });
  const byId = Object.fromEntries(loaded.specs.map((s) => [s.id, s]));
  assert.equal(byId["muse-acp"].label, "Muse");
  assert.deepEqual([...byId["gemini-acp"].args], ["--experimental-acp"], "the host's spec replaces the built-in with the same id");
  assert.equal(byId["gemini-acp"].source, path.join(hostDir, "acp-agents.json"));
  assert.equal(byId.claude, undefined);
  assert.equal(loaded.problems.length, 2);
  assert.match(loaded.problems.join("\n"), /'claude' is an adapter Voicebox already provides/);

  const elsewhere = path.join(hostDir, "mine.json");
  fs.writeFileSync(elsewhere, "not json");
  const broken = loadAcpAgentSpecs({ hostDir, file: elsewhere });
  assert.match(broken.problems[0], /is not JSON/);
  assert.equal(broken.specs.length, BUILTIN_ACP_AGENTS.length, "an unreadable file leaves the built-ins");
});

test("a command resolves from PATH or as an absolute path, and never relative to the task's folder", (t) => {
  const bin = scratch(t, "vb-acp-bin-");
  fs.writeFileSync(path.join(bin, "agy"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "notexec"), "x", { mode: 0o644 });
  assert.equal(resolveAcpCommand("agy", `/nonexistent${path.delimiter}${bin}`), path.join(bin, "agy"));
  assert.equal(resolveAcpCommand("agy", "/nonexistent"), null);
  assert.equal(resolveAcpCommand("notexec", bin), null);
  assert.equal(resolveAcpCommand(path.join(bin, "agy"), ""), path.join(bin, "agy"));
  assert.equal(resolveAcpCommand("./agy", bin), null);
  assert.equal(resolveAcpCommand("sub/agy", bin), null);
});

test("the child environment drops Voicebox's own model keys unless the spec keeps one, and leaves the host's alone", () => {
  const hostEnv = { PATH: "/usr/bin", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a", GOOGLE_API_KEY: "gg", OTHER: "kept" };
  const plain = acpAgentChildEnv(validateAcpAgentSpec({ id: "x-acp", command: "x" }).spec, { hostEnv });
  for (const name of ["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"]) assert.equal(name in plain, false, `${name} must be absent, not undefined`);
  assert.equal(plain.OTHER, "kept");
  const keeps = acpAgentChildEnv(validateAcpAgentSpec({ id: "x-acp", command: "x", keepEnv: ["GEMINI_API_KEY"] }).spec, { hostEnv });
  assert.equal(keeps.GEMINI_API_KEY, "g");
  assert.equal("OPENAI_API_KEY" in keeps, false);
  assert.equal(hostEnv.GEMINI_API_KEY, "g", "the host's own environment is not touched");
});

test("check: an agent that is not installed is refused by name, with the remedy; an installed one states what would run", (t) => {
  const bin = scratch(t, "vb-acp-check-");
  const missing = createAcpAgentExecutor({ id: "antigravity-acp", label: "Antigravity", command: "agy", args: ["acp"] }, { pathEnv: bin });
  const refused = missing.check({});
  assert.equal(refused.refused, "adapter-unavailable");
  assert.match(refused.why, /Antigravity is not installed.*'agy'.*acp-agents\.json/s);
  fs.writeFileSync(path.join(bin, "agy"), "#!/bin/sh\n", { mode: 0o755 });
  const ok = missing.check({ agentConfig: { adapter: "antigravity-acp", transport: "stdio", bounds: { deadlineMs: 5000, maxOutputBytes: 100 } } });
  assert.equal(ok.ok, true);
  assert.match(ok.mechanism, new RegExp(`stdio-acp-client: Antigravity \\(${path.join(bin, "agy")} acp\\)`));
  assert.deepEqual(ok.bounds, { deadlineMs: 5000, maxOutputBytes: 100 });
  assert.equal(missing.check({ agentConfig: { adapter: "pi-acp" } }).refused, "adapter-not-configured");
  assert.equal(missing.check({ agentConfig: { adapter: "antigravity-acp", transport: "websocket" } }).refused, "unsupported-runtime-capability");
  assert.throws(() => createAcpAgentExecutor({ id: "claude", command: "x" }), { refused: "acp-agent-spec-invalid" });
});

test("run: a spec is enough to delegate to a real ACP process — handshake, prompt, permissions and environment", async (t) => {
  const cwd = scratch(t, "vb-acp-run-");
  const saved = { ...process.env };
  Object.assign(process.env, { GEMINI_API_KEY: "host-key", OPENAI_API_KEY: "host-key", FAKE_KEEP_ME: "1" });
  t.after(() => { for (const k of ["GEMINI_API_KEY", "OPENAI_API_KEY", "FAKE_KEEP_ME", "FAKE_ACP_PROTOCOL"]) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } });
  const notes = [];
  const executor = createAcpAgentExecutor(
    { id: "fake-acp", label: "Fake", command: FAKE, args: ["acp", "--flag"], keepEnv: ["OPENAI_API_KEY"], handshakeTimeoutMs: 20000 },
    { root: { path: cwd } },
  );
  assert.equal(executor.check({}).ok, true);
  const text = await executor.run({ input: { task: "say what you are" }, bounds: { deadlineMs: 20000, maxOutputBytes: 65536 }, report: (n) => notes.push(n), agentConfig: { adapter: "fake-acp" } });
  const answer = JSON.parse(text);
  assert.deepEqual(answer.argv, ["acp", "--flag"], "the spec's args reach the agent");
  assert.equal(answer.cwd, cwd, "the session opens in the task's root");
  assert.equal(answer.prompt, "say what you are");
  assert.equal(answer.inside, "selected", "a write inside the workspace is allowed");
  assert.equal(answer.outside, "cancelled", "a write outside it is refused");
  assert.deepEqual(answer.env, { GEMINI_API_KEY: false, OPENAI_API_KEY: true, ANTHROPIC_API_KEY: false, FAKE_KEEP_ME: true },
    "Voicebox's model keys are scoped out unless the spec keeps one; everything else is inherited");
  assert.ok(notes.some((n) => n.includes("initializing fake-acp")), "progress names the agent by its spec id");

  // The agent row's reach is honoured for any ACP agent: a tool outside it is refused before the workspace check.
  const narrow = JSON.parse(await executor.run({ input: { task: "x" }, bounds: { deadlineMs: 20000, maxOutputBytes: 65536 }, agentConfig: { adapter: "fake-acp", reach: { tools: ["read"] } } }));
  assert.equal(narrow.inside, "cancelled", "write is not in reach [read]");

  // The protocol version is the one compatibility check.
  process.env.FAKE_ACP_PROTOCOL = "2";
  await assert.rejects(executor.run({ input: { task: "x" }, bounds: { deadlineMs: 20000, maxOutputBytes: 65536 } }), { refused: "acp-protocol-unsupported" });
});
