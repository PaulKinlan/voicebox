import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ENGINE_CREDENTIAL_VARS,
  UNSOUND_ENGINES,
  READ_ONLY_CLASSES,
  WRITE_CAPABLE_ENGINES,
  stationClass,
  toolPolicyForClass,
  resolveEngineModel,
  unmetEngineCredentials,
  resolveStationEngine,
  describeStationEngine,
} from "../tools/factory-station-engine.mjs";

/**
 * These tests pin the review-trigger engine policy (voicebox-beads-zljj): a read-only station
 * may be pointed at a host-provisioned model integration, a proposer may not, and a missing
 * engine credential is reported as a named environment failure rather than a silent no-verdict
 * run.
 */

function agentsFixture(t, classes = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "station-engine-agents-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [station, className] of Object.entries(classes)) {
    const dir = path.join(root, "agents", station);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "agent.yaml"),
      `name: ${station}\nclass: ${className}\nplane: [local]\n`,
    );
  }
  return root;
}

test("factory-station-engine: engine credential vars mirror the factory adapter allowlists", () => {
  // lib/child_env.py ENGINE_CREDENTIALS: an engine can only authenticate from these names, so a
  // preflight that looked at any other variable would be claiming an auth path that does not exist.
  assert.deepEqual(ENGINE_CREDENTIAL_VARS.deepseek, ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(ENGINE_CREDENTIAL_VARS.pi, [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
  ]);
  assert.ok(WRITE_CAPABLE_ENGINES.has("pi"));
  assert.ok(!WRITE_CAPABLE_ENGINES.has("deepseek"), "deepseek is payload-only (read-only)");
  assert.ok(READ_ONLY_CLASSES.has("observer"));
  assert.ok(READ_ONLY_CLASSES.has("optimizer"));
});

test("factory-station-engine: station class comes from the agent manifest and defaults safely", (t) => {
  const root = agentsFixture(t, { accessibility: "observer", "perf-review": "proposer" });
  assert.equal(stationClass("accessibility", { agentsDir: root }), "observer");
  assert.equal(stationClass("perf-review", { agentsDir: root }), "proposer");
  // An absent manifest must not be guessed at: the factory keeps its own resolution.
  assert.equal(stationClass("not-a-station", { agentsDir: root }), "unknown");
  assert.equal(toolPolicyForClass("observer"), "read-only");
  assert.equal(toolPolicyForClass("optimizer"), "read-only");
  assert.equal(toolPolicyForClass("proposer"), "worktree-write");
  assert.equal(toolPolicyForClass("unknown"), "unknown");
});

test("factory-station-engine: an engine that cannot deliver the payload is refused, however it was configured", (t) => {
  // The provisioned integration authenticates fine, and that is exactly the trap: a real run on
  // it exited 0 with a schema-valid "no scanner data was supplied" report because the factory's
  // lib/adapters/deepseek.sh never passes the prompt to its API call. A review verdict of
  // "clean" that saw nothing is worse than a refusal, so the engine is refused by name.
  const root = agentsFixture(t, { accessibility: "observer" });
  const selection = resolveStationEngine({
    station: "accessibility",
    agentsDir: root,
    env: { DEEPSEEK_API_KEY: "exe-integration", VOICEBOX_FACTORY_ENGINE: "deepseek" },
  });

  assert.equal(selection.ok, false);
  assert.equal(selection.engine, "deepseek");
  assert.match(selection.error, /cannot deliver the station payload/);
  assert.match(selection.error, /lib\/adapters\/deepseek\.sh/);
  // The refusal must say how to remove it, or the next reader cannot tell when it expires.
  assert.match(selection.error, /Remove after the adapter passes/);
  assert.ok(UNSOUND_ENGINES.has("deepseek"));
  assert.ok(!WRITE_CAPABLE_ENGINES.has("deepseek"));
});

test("factory-station-engine: without an explicit engine the sandboxed pi engine is kept", (t) => {
  const root = agentsFixture(t, { accessibility: "observer" });
  const selection = resolveStationEngine({
    station: "accessibility",
    agentsDir: root,
    env: { ANTHROPIC_API_KEY: "test-key-present" },
  });
  assert.equal(selection.ok, true);
  assert.equal(selection.engine, "pi");
  assert.equal(selection.source, "default");
  assert.equal(selection.toolPolicy, "read-only");
});

test("factory-station-engine: an explicit VOICEBOX_FACTORY_ENGINE overrides the class default", (t) => {
  const root = agentsFixture(t, { accessibility: "observer" });
  const selection = resolveStationEngine({
    station: "accessibility",
    agentsDir: root,
    env: {
      VOICEBOX_FACTORY_ENGINE: "pi",
      ANTHROPIC_API_KEY: "test-key-present",
    },
  });
  assert.equal(selection.engine, "pi");
  assert.equal(selection.source, "env");
  // The pi adapter passes no model flag, so no model is recorded for it.
  assert.equal(selection.model, "");
});

test("factory-station-engine: a missing engine credential is a named environment failure", (t) => {
  const root = agentsFixture(t, { accessibility: "observer" });
  const selection = resolveStationEngine({
    station: "accessibility",
    agentsDir: root,
    env: { VOICEBOX_FACTORY_ENGINE: "pi" },
  });

  assert.equal(selection.ok, false);
  assert.equal(selection.engine, "pi");
  assert.deepEqual(selection.missing, [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
  ]);
  assert.match(selection.error, /no credential in the environment/);
  assert.match(selection.error, /ANTHROPIC_API_KEY/);
});

test("factory-station-engine: a proposer is never pointed at a payload-only engine", (t) => {
  const root = agentsFixture(t, { "perf-review": "proposer" });
  const selection = resolveStationEngine({
    station: "perf-review",
    agentsDir: root,
    env: {
      DEEPSEEK_API_KEY: "exe-integration",
      VOICEBOX_FACTORY_ENGINE: "deepseek",
    },
  });

  // The unsound check runs first, so the refusal names the payload defect; the worktree-write
  // refusal is exercised through a payload engine that is not on the unsound list.
  assert.equal(selection.ok, false);
  assert.equal(selection.toolPolicy, "worktree-write");
  assert.match(selection.error, /cannot deliver the station payload/);

  // `antigravity` is reachable by the gate order (it has an allowlisted credential and is not on
  // the unsound list) and is not write-capable, so it exercises the worktree-write refusal itself.
  const payloadOnly = resolveStationEngine({
    station: "perf-review",
    agentsDir: root,
    env: { VOICEBOX_FACTORY_ENGINE: "antigravity", GEMINI_API_KEY: "test-key-present" },
  });
  assert.equal(payloadOnly.ok, false);
  assert.equal(payloadOnly.toolPolicy, "worktree-write");
  assert.match(payloadOnly.error, /payload-only/);
  assert.match(payloadOnly.error, /worktree-write/);
});

test("factory-station-engine: unknown engines and empty credential values fail closed", () => {
  assert.deepEqual(unmetEngineCredentials("nonesuch", {}), ["unknown engine 'nonesuch'"]);
  // Whitespace-only values are not credentials.
  assert.deepEqual(unmetEngineCredentials("deepseek", { DEEPSEEK_API_KEY: "   " }), ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(unmetEngineCredentials("deepseek", { DEEPSEEK_API_KEY: "exe-integration" }), []);
  assert.equal(resolveEngineModel("deepseek", { DEEPSEEK_MODEL: "deepseek/deepseek-flash" }), "deepseek/deepseek-flash");
  assert.equal(resolveEngineModel("deepseek", {}), "");
});

test("factory-station-engine: describeStationEngine is a single log-safe line without values", (t) => {
  const root = agentsFixture(t, { accessibility: "observer" });
  const selection = resolveStationEngine({
    station: "accessibility",
    agentsDir: root,
    env: { VOICEBOX_FACTORY_ENGINE: "deepseek", DEEPSEEK_API_KEY: "super-secret-value" },
  });
  const line = describeStationEngine(selection);
  assert.match(line, /engine 'deepseek'/);
  assert.match(line, /class observer/);
  assert.ok(!line.includes("super-secret-value"), "the description must never print a credential value");
});
