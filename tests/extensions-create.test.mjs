// tests/extensions-create.test.mjs — Create and locally add new extensions (voicebox-beads-b1p).
//
// WHAT THIS PROVES:
// 1. Core library: createExtension validates descriptors, computes plan disclosure,
//    and stages pending proposals with source "local".
// 2. Admission gate: a declared capability is NOT an enforced one — declaring unmediated
//    capabilities like 'exec', 'eval', 'import' is refused by the admission gate.
// 3. Host-owned admission gate over HTTP:
//    - Unauthenticated POST /api/extensions/local with { admit: true } is REFUSED (403 host-token-required).
//    - Unauthenticated POST /api/extensions/local stages as a pending proposal in workspace/proposals/.
//    - Authenticated POST /api/extensions/local with x-voicebox-host-token admits and loads the tool.
// 4. CLI tool tools/create-extension.mjs:
//    - Stages a proposal with --stage.
//    - Admits with host token using --admit.
//
//   node --test tests/extensions-create.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("createExtension library: descriptor validation and proposal staging", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-create-ext-lib-"));
  const workspace = path.join(scratch, "workspace");
  const hostDir = path.join(scratch, "extensions");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(hostDir, { recursive: true });

  const prevWs = process.env.VOICEBOX_WORKSPACE;
  const prevExt = process.env.VOICEBOX_EXTENSIONS_DIR;
  process.env.VOICEBOX_WORKSPACE = workspace;
  process.env.VOICEBOX_EXTENSIONS_DIR = hostDir;

  try {
    const { createExtension, validateExtensionDescriptor } = await import("../lib/extensions.mjs");

    // 1. Validation catches malformed descriptors
    assert.equal(validateExtensionDescriptor(null).ok, false);
    assert.equal(validateExtensionDescriptor({ id: "BAD ID" }).refused, "invalid-id");
    assert.equal(validateExtensionDescriptor({ id: "valid-id" }).refused, "missing-name");
    assert.equal(validateExtensionDescriptor({ id: "valid-id", name: "Name" }).refused, "missing-description");
    assert.equal(validateExtensionDescriptor({ id: "valid-id", name: "Name", description: "Desc", tools: [] }).refused, "no-tools");
    assert.equal(validateExtensionDescriptor({ id: "valid-id", name: "Name", description: "Desc", tools: [{ name: "bad-name", primitive: "now" }] }).refused, "bad-tool-name");
    assert.equal(validateExtensionDescriptor({ id: "valid-id", name: "Name", description: "Desc", tools: [{ name: "good_name", primitive: "unknown_prim" }] }).refused, "unknown-primitive");

    // 2. Valid local extension creates a staged proposal
    const validDesc = {
      id: "local-time",
      name: "Local Time Tool",
      description: "Reports current time",
      tools: [
        {
          name: "get_current_time",
          description: "Get current timestamp",
          primitive: "now",
          params: {},
        },
      ],
    };

    const staged = createExtension(validDesc, "local");
    assert.equal(staged.ok, true);
    assert.equal(staged.id, "local-time");
    assert.equal(staged.state, "pending");
    assert.equal(staged.plan.gate.decision, "admitted");

    const proposalFile = path.join(workspace, "proposals", "local-time.json");
    assert.equal(existsSync(proposalFile), true, "proposal file must exist in workspace/proposals/");
    const saved = JSON.parse(readFileSync(proposalFile, "utf8"));
    assert.equal(saved.source, "local");
    assert.equal(saved.state, "pending");
  } finally {
    if (prevWs) process.env.VOICEBOX_WORKSPACE = prevWs; else delete process.env.VOICEBOX_WORKSPACE;
    if (prevExt) process.env.VOICEBOX_EXTENSIONS_DIR = prevExt; else delete process.env.VOICEBOX_EXTENSIONS_DIR;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("host-owned admission gate: declared capability is NOT an enforced one", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-gate-refusal-"));
  const workspace = path.join(scratch, "workspace");
  const hostDir = path.join(scratch, "extensions");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(hostDir, { recursive: true });

  const prevWs = process.env.VOICEBOX_WORKSPACE;
  const prevExt = process.env.VOICEBOX_EXTENSIONS_DIR;
  process.env.VOICEBOX_WORKSPACE = workspace;
  process.env.VOICEBOX_EXTENSIONS_DIR = hostDir;

  try {
    const { createAndAdmitExtension, createExtension } = await import("../lib/extensions.mjs");

    // Declaring 'exec' must be refused by the gate: no mechanism bounds a spawned child
    const execDesc = {
      id: "local-sh",
      name: "Shell Runner",
      description: "Attempts to run shell commands",
      capabilities: ["exec"],
      tools: [
        {
          name: "run_sh",
          description: "Run command",
          primitive: "now",
          params: {},
        },
      ],
    };

    const execPlan = createExtension(execDesc, "local");
    assert.equal(execPlan.plan.gate.decision, "refused");
    assert.equal(execPlan.plan.gate.rule, "exec-absent");
    assert.match(execPlan.plan.gate.why, /no mechanism/);

    const admitRefused = createAndAdmitExtension(execDesc, "host");
    assert.equal(admitRefused.ok, false);
    assert.equal(admitRefused.refused, "exec-absent");
  } finally {
    if (prevWs) process.env.VOICEBOX_WORKSPACE = prevWs; else delete process.env.VOICEBOX_WORKSPACE;
    if (prevExt) process.env.VOICEBOX_EXTENSIONS_DIR = prevExt; else delete process.env.VOICEBOX_EXTENSIONS_DIR;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("HTTP API /api/extensions/local: unauthenticated staging vs host-token admission", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-api-create-"));
  const workspace = path.join(scratch, "workspace");
  const hostDir = path.join(scratch, "extensions");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(hostDir, { recursive: true });

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_EXTENSIONS_DIR: hostDir,
    },
    cwd: scratch,
  });

  try {
    const token = readFileSync(path.join(hostDir, ".host-token"), "utf8").trim();
    const base = server.base;

    const descriptor = {
      id: "local-api-tool",
      name: "Local API Tool",
      description: "Fetches from local server endpoint",
      capabilities: ["network"],
      bounds: { hosts: ["127.0.0.1"], maxRequests: 10 },
      tools: [
        {
          name: "local_fetch",
          description: "Fetch local endpoint",
          primitive: "http-get",
          params: { url: `${base}/api/health` },
        },
      ],
    };

    // 1. Direct admission WITHOUT host token is REFUSED 403
    const directNoAuth = await fetch(`${base}/api/extensions/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ descriptor, admit: true }),
    });
    assert.equal(directNoAuth.status, 403);
    const directNoAuthBody = await directNoAuth.json();
    assert.equal(directNoAuthBody.refused, "host-token-required");

    // 2. Staging as local proposal WITHOUT host token succeeds 200
    const stageRes = await fetch(`${base}/api/extensions/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ descriptor }),
    });
    assert.equal(stageRes.status, 200);
    const stageBody = await stageRes.json();
    assert.equal(stageBody.ok, true);
    assert.equal(stageBody.id, "local-api-tool");
    assert.equal(stageBody.state, "pending");

    // Inventory lists it under proposals
    const invRes = await fetch(`${base}/api/extensions`);
    const inv = await invRes.json();
    const prop = inv.proposals?.find((p) => p.id === "local-api-tool");
    assert.ok(prop, "staged proposal must appear in inventory proposals");
    assert.equal(prop.source, "local");
    assert.equal(prop.state, "pending");

    // 3. Direct admission WITH host token succeeds 200
    const directWithAuth = await fetch(`${base}/api/extensions/local`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voicebox-host-token": token,
      },
      body: JSON.stringify({ descriptor, admit: true }),
    });
    assert.equal(directWithAuth.status, 200);
    const directWithAuthBody = await directWithAuth.json();
    assert.equal(directWithAuthBody.ok, true);
    assert.equal(directWithAuthBody.decision, "admitted");

    // It is now RUNNING in inventory
    const invAfter = await (await fetch(`${base}/api/extensions`)).json();
    const running = invAfter.extensions?.find((e) => e.id === "local-api-tool");
    assert.ok(running, "admitted extension must appear in running extensions");
    assert.deepEqual(running.tools, ["local_fetch"]);
  } finally {
    await server.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("CLI tools/create-extension.mjs: stage and admit with --workspace and --extensions flags", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-cli-create-"));
  const workspace = path.join(scratch, "workspace");
  const hostDir = path.join(scratch, "extensions");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(path.join(hostDir, ".host-token"), "test-host-token-xyz");

  const cli = path.join(REPO, "tools/create-extension.mjs");
  const cleanEnv = { ...process.env };
  delete cleanEnv.VOICEBOX_WORKSPACE;
  delete cleanEnv.VOICEBOX_EXTENSIONS_DIR;

  try {
    // 1. Stage proposal via CLI with explicit --workspace and --extensions flags
    const stageOut = execFileSync(
      process.execPath,
      [cli, "--id", "cli-tool", "--name", "CLI Tool", "--desc", "Tool created via CLI", "--primitive", "now", "--workspace", workspace, "--extensions", hostDir, "--stage"],
      { env: cleanEnv, encoding: "utf8" },
    );
    assert.match(stageOut, /Staged local extension proposal 'cli-tool'/);
    assert.equal(existsSync(path.join(workspace, "proposals/cli-tool.json")), true, "proposal must land in designated --workspace");

    // 2. Admit via CLI with explicit --workspace and --extensions flags
    const admitOut = execFileSync(
      process.execPath,
      [cli, "--id", "cli-tool-admit", "--name", "Admitted CLI Tool", "--desc", "Admitted tool", "--primitive", "now", "--workspace", workspace, "--extensions", hostDir, "--admit"],
      { env: cleanEnv, encoding: "utf8" },
    );
    assert.match(admitOut, /Created and admitted local extension 'cli-tool-admit'/);
    assert.equal(existsSync(path.join(hostDir, "cli-tool-admit.json")), true, "admitted file must land in designated --extensions");
    assert.equal(existsSync(path.join(hostDir, ".ledger.jsonl")), true, "ledger must land in designated --extensions");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
