// tests/project-switch-live-error.test.mjs — regression suite for voicebox-beads-704x:
// switching projects via voice in Gemini Live (models/gemini-3.8-live-extended-thinking)
// must never fail with "A system error occurred."
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMANDS,
  commandToAction,
  functionDeclarations,
  liveSystemInstruction,
  normalizeWorkspaceTarget,
} from "../lib/commands.mjs";
import {
  parseOpenWorkspaceTurn,
  recoverLiveSystemErrorTurn,
  resolveTurn,
  resolveWorkspaceCandidate,
} from "../lib/resolver.mjs";
import { createGeminiProvider } from "../lib/live-providers/gemini.mjs";
import { parseRoomFolderTurn } from "../public/room-folder-ops.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("open_workspace schema declares name, folder, dir, path, target, and project so Gemini Live tool planner never fails on parameter names", () => {
  const decl = functionDeclarations().find((d) => d.name === "open_workspace");
  assert.ok(decl, "open_workspace is declared in functionDeclarations()");
  const props = decl.parameters.properties;
  for (const key of ["path", "target", "project", "name", "folder", "dir"]) {
    assert.equal(props[key]?.type, "string", `open_workspace declares string parameter '${key}'`);
  }
  assert.match(liveSystemInstruction(), /open_workspace/, "liveSystemInstruction explicitly instructs calling open_workspace");
  assert.match(liveSystemInstruction(), /Never claim a system error occurred/i);
});

test("commandToAction maps open_workspace and switch_project/change_project aliases across all parameter shapes", () => {
  assert.deepEqual(
    commandToAction("open_workspace", { name: "voicebox" }),
    { verb: "open_workspace", name: "", target: "self" },
  );
  assert.deepEqual(
    commandToAction("open_workspace", { folder: "the voice box project" }),
    { verb: "open_workspace", name: "", target: "self" },
  );
  assert.deepEqual(
    commandToAction("open_workspace", { dir: "repo-alpha" }),
    { verb: "open_workspace", name: "", target: "repo-alpha" },
  );
  assert.deepEqual(
    commandToAction("switch_project", { project: "voicebox" }),
    { verb: "open_workspace", name: "", target: "self", project: "voicebox" },
  );
  assert.deepEqual(
    commandToAction("change_project", { name: "my-sibling-app" }),
    { verb: "open_workspace", name: "", target: "my-sibling-app" },
  );
});

test("createGeminiProvider places agent instruction and liveSystemInstruction BEFORE projectInstruction so AGENTS.md does not overshadow live tool declarations", () => {
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-704x";
  try {
    const sent = [];
    const transport = {
      refused: { audioBeforeReady: 0, afterClose: 0 },
      connect(_url, { onEvent }) {
        this._onEvent = onEvent;
        return true;
      },
      send(kind, payload) {
        sent.push({ kind, payload: JSON.parse(payload) });
        return true;
      },
      close() {},
      get connected() {
        return true;
      },
    };
    createGeminiProvider({
      model: "models/gemini-3.8-live-extended-thinking",
      emit() {},
      log() {},
      transport,
      tools: functionDeclarations(),
      instruction: "AGENT_BASE_INSTRUCTION",
      systemInstruction: liveSystemInstruction(),
      projectInstruction: "PROJECT_AGENTS_MD_CONTENT",
    });
    transport._onEvent({ kind: "open" });
    const setup = sent.find((s) => s.kind === "handshake")?.payload?.setup;
    assert.ok(setup, "handshake sent");
    const parts = setup.systemInstruction?.parts ?? [];
    assert.equal(parts.length, 3);
    assert.equal(parts[0].text, "AGENT_BASE_INSTRUCTION");
    assert.match(parts[1].text, /You are the voice of voicebox/, "liveSystemInstruction is second, before projectInstruction");
    assert.equal(parts[2].text, "PROJECT_AGENTS_MD_CONTENT", "projectInstruction comes after live tool declarations");
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  }
});

test("normalizeWorkspaceTarget and parseOpenWorkspaceTurn handle natural spoken requests and pasted UI root banners", async () => {
  assert.equal(normalizeWorkspaceTarget("Hey, can you change to the voice box project, please?"), "self");
  assert.equal(normalizeWorkspaceTarget("the voicebox project"), "self");
  assert.equal(normalizeWorkspaceTarget("voice box"), "self");
  assert.equal(
    normalizeWorkspaceTarget("Active project root set to /Users/paulkinlan/Code/voicebox\nvoicebox"),
    "/Users/paulkinlan/Code/voicebox",
  );
  assert.equal(normalizeWorkspaceTarget("the acme-web project"), "acme-web");

  const r1 = await resolveTurn("Hey, can you change to the voice box project, please?", "script");
  assert.equal(r1.verb, "open_workspace");
  assert.equal(r1.target, "self");

  const r2 = await resolveTurn("can you switch to the acme-app project", "script");
  assert.equal(r2.verb, "open_workspace");
  assert.equal(r2.target, "acme-app");

  const r3 = parseOpenWorkspaceTurn("Active project root set to /Users/paulkinlan/Code/voicebox\nvoicebox");
  assert.equal(r3?.verb, "open_workspace");
  assert.equal(r3?.target, "/Users/paulkinlan/Code/voicebox");

  // And parseRoomFolderTurn must not misparse project switching as a local file read:
  assert.equal(parseRoomFolderTurn("Hey, can you change to the voice box project, please?"), null);
  assert.equal(parseRoomFolderTurn("open the voicebox project"), null);
});

test("resolveWorkspaceCandidate resolves self, already-active root, child subdirectories, and sibling projects", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-704x-ws-"));
  try {
    const parentDir = path.join(scratch, "Code");
    const voiceboxDir = path.join(parentDir, "voicebox");
    const siblingDir = path.join(parentDir, "sibling-project");
    const childDir = path.join(voiceboxDir, "packages-sub");
    const sandboxDir = path.join(scratch, "sandboxes");
    mkdirSync(voiceboxDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    mkdirSync(childDir, { recursive: true });
    mkdirSync(sandboxDir, { recursive: true });

    // 1. Spoken "Hey, can you change to the voice box project, please?" -> voiceboxDir (self)
    const selfRes = resolveWorkspaceCandidate("Hey, can you change to the voice box project, please?", {
      activeRootPath: siblingDir,
      selfRootPath: voiceboxDir,
      sandboxRootPath: sandboxDir,
      exists: existsSync,
      mkdir: mkdirSync,
    });
    assert.equal(selfRes.isSelf, true);
    assert.equal(selfRes.candidate, voiceboxDir);

    // 2. Switching to a sibling project ("the sibling project") from voiceboxDir
    const sibRes = resolveWorkspaceCandidate("the sibling project", {
      activeRootPath: voiceboxDir,
      selfRootPath: voiceboxDir,
      sandboxRootPath: sandboxDir,
      exists: existsSync,
      mkdir: mkdirSync,
    });
    assert.equal(sibRes.candidate, siblingDir);

    // 3. Switching to the already-active root by name ("sibling-project")
    const sameRes = resolveWorkspaceCandidate("sibling-project", {
      activeRootPath: siblingDir,
      selfRootPath: voiceboxDir,
      sandboxRootPath: sandboxDir,
      exists: existsSync,
      mkdir: mkdirSync,
    });
    assert.equal(sameRes.candidate, siblingDir);

    // 4. Switching to a child subdirectory ("packages-sub")
    const childRes = resolveWorkspaceCandidate("packages-sub", {
      activeRootPath: voiceboxDir,
      selfRootPath: voiceboxDir,
      sandboxRootPath: sandboxDir,
      exists: existsSync,
      mkdir: mkdirSync,
    });
    assert.equal(childRes.candidate, childDir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("recoverLiveSystemErrorTurn recovers and executes open_workspace when Gemini Live emits 'A system error occurred.' without a tool call", async () => {
  const executed = [];
  const recovery = await recoverLiveSystemErrorTurn({
    userTranscript: "Hey, can you change to the voice box project, please?",
    modelTranscript: "I'll switch over to the voicebox project now. A system error occurred.",
    toolCallsInTurn: 0,
    executeAction: async (action) => {
      executed.push(action);
      return {
        ok: true,
        action: "opened workspace voicebox (/Users/paulkinlan/Code/voicebox)",
        project: "voicebox",
      };
    },
  });

  assert.equal(recovery.recovered, true);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].verb, "open_workspace");
  assert.equal(executed[0].target, "self");
  assert.equal(recovery.calls.length, 1);
  assert.equal(recovery.calls[0].name, "open_workspace");
  assert.equal(recovery.calls[0].ok, true);

  // Does not fire if a tool call already ran in the turn:
  const skipped = await recoverLiveSystemErrorTurn({
    userTranscript: "Hey, can you change to the voice box project, please?",
    modelTranscript: "A system error occurred.",
    toolCallsInTurn: 1,
    executeAction: async () => ({ ok: true }),
  });
  assert.equal(skipped.recovered, false);
  assert.equal(skipped.reason, "tool-already-called");
});

test("public/fused.js refreshes loadRoot() and clears stale roomFolder when open_workspace succeeds in live or typed turns", () => {
  const fused = readFileSync(path.join(ROOT, "public", "fused.js"), "utf8");
  assert.match(
    fused,
    /if\s*\(switchedWorkspace\)\s*\{\s*if\s*\(roomFolder\)\s*roomFolder\s*=\s*null;\s*listingDir\s*=\s*"";\s*void\s+loadRoot\(\)\.then\(\(\)\s*=>\s*load\(\)\);/,
    "window.__voiceboxOnToolCalls refreshes loadRoot() before load() when open_workspace succeeds",
  );
  assert.match(
    fused,
    /if\s*\(verb\s*===\s*"open_workspace"\)\s*\{\s*if\s*\(roomFolder\)\s*roomFolder\s*=\s*null;\s*listingDir\s*=\s*"";\s*await\s+loadRoot\(\);/,
    "sendTurn refreshes loadRoot() when open_workspace succeeds",
  );
});
