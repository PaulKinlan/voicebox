// tests/system-commands.test.mjs — System voice commands & multi-harness delegation tests.
//
//   node --test tests/system-commands.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SYSTEM_COMMAND_CATALOGUE, parseSystemCommand } from "../lib/system-commands.mjs";
import { KNOWN_VERBS, resolveTurn, script } from "../lib/resolver.mjs";
import { startServer } from "./lib/server.mjs";

test("SYSTEM_COMMAND_CATALOGUE exposes structured voice command entries", () => {
  assert.ok(Array.isArray(SYSTEM_COMMAND_CATALOGUE));
  assert.equal(SYSTEM_COMMAND_CATALOGUE.length, 6);
  const commands = new Set(SYSTEM_COMMAND_CATALOGUE.map((entry) => entry.command));
  for (const expectedCommand of [
    "copy",
    "paste",
    "open_panel",
    "switch_theme",
    "stop_speaking",
    "clear_activity",
  ]) {
    assert.ok(commands.has(expectedCommand), `expected catalogue to contain '${expectedCommand}'`);
  }
  for (const entry of SYSTEM_COMMAND_CATALOGUE) {
    assert.equal(typeof entry.command, "string");
    assert.equal(typeof entry.category, "string");
    assert.ok(Array.isArray(entry.phrases) && entry.phrases.length > 0);
    assert.equal(typeof entry.description, "string");
  }
});

test("parseSystemCommand deterministically parses clipboard, navigation, theme, and session commands", () => {
  // Copy variants
  assert.deepEqual(parseSystemCommand("copy"), { verb: "system", command: "copy", target: "selection" });
  assert.deepEqual(parseSystemCommand("copy that!"), { verb: "system", command: "copy", target: "selection" });
  assert.deepEqual(parseSystemCommand("copy selection"), { verb: "system", command: "copy", target: "selection" });
  assert.deepEqual(parseSystemCommand("copy the file"), { verb: "system", command: "copy", target: "file" });
  assert.deepEqual(parseSystemCommand("copy last reply"), { verb: "system", command: "copy", target: "reply" });
  assert.deepEqual(parseSystemCommand("copy hello world to clipboard"), {
    verb: "system",
    command: "copy",
    target: "literal",
    text: "hello world",
  });

  // Paste variants
  assert.deepEqual(parseSystemCommand("paste"), { verb: "system", command: "paste", target: "active" });
  assert.deepEqual(parseSystemCommand("paste from clipboard"), {
    verb: "system",
    command: "paste",
    target: "active",
  });
  assert.deepEqual(parseSystemCommand("paste to notes.txt"), {
    verb: "system",
    command: "paste",
    target: "file",
    file: "notes.txt",
  });
  assert.deepEqual(parseSystemCommand("paste into file src/index.js"), {
    verb: "system",
    command: "paste",
    target: "file",
    file: "src/index.js",
  });

  // Panel & drawer commands
  assert.deepEqual(parseSystemCommand("clear activity"), { verb: "system", command: "clear_activity" });
  assert.deepEqual(parseSystemCommand("clear work log"), { verb: "system", command: "clear_activity" });
  assert.deepEqual(parseSystemCommand("open settings"), {
    verb: "system",
    command: "open_panel",
    target: "settings",
  });
  assert.deepEqual(parseSystemCommand("open files"), {
    verb: "system",
    command: "open_panel",
    target: "files",
  });
  assert.deepEqual(parseSystemCommand("open harnesses"), {
    verb: "system",
    command: "open_panel",
    target: "harnesses",
  });
  assert.deepEqual(parseSystemCommand("open activity log"), {
    verb: "system",
    command: "open_panel",
    target: "activity",
  });
  assert.deepEqual(parseSystemCommand("open agent tracker"), {
    verb: "system",
    command: "open_panel",
    target: "agent-tracker",
  });
  assert.deepEqual(parseSystemCommand("close panel"), {
    verb: "system",
    command: "open_panel",
    target: "close",
  });

  // Theme & audio session commands
  assert.deepEqual(parseSystemCommand("dark mode"), {
    verb: "system",
    command: "switch_theme",
    mode: "dark",
  });
  assert.deepEqual(parseSystemCommand("switch to light mode"), {
    verb: "system",
    command: "switch_theme",
    mode: "light",
  });
  assert.deepEqual(parseSystemCommand("system theme"), {
    verb: "system",
    command: "switch_theme",
    mode: "system",
  });
  assert.deepEqual(parseSystemCommand("stop speaking"), {
    verb: "system",
    command: "stop_speaking",
    mode: "interrupt",
  });
  assert.deepEqual(parseSystemCommand("mute"), {
    verb: "system",
    command: "stop_speaking",
    mode: "mute",
  });
  assert.deepEqual(parseSystemCommand("unmute"), {
    verb: "system",
    command: "stop_speaking",
    mode: "unmute",
  });

  // Non-system phrases return null
  assert.equal(parseSystemCommand(""), null);
  assert.equal(parseSystemCommand("create a file called hello.txt with hi"), null);
  assert.equal(parseSystemCommand("open notes.txt in the ui"), null);
});

test("resolver exports KNOWN_VERBS with 'system' and resolves system commands", async () => {
  assert.ok(KNOWN_VERBS.includes("system"));
  const scripted = script("copy last reply");
  assert.deepEqual(scripted, { verb: "system", command: "copy", target: "reply" });

  const resolved = await resolveTurn("paste into file draft.md", "script");
  assert.deepEqual(resolved, {
    verb: "system",
    command: "paste",
    target: "file",
    file: "draft.md",
  });
});

test("Server integration: POST /api/turn system commands, multi-harness configure, and /api/tasks/delegate", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vb-sys-cmds-test-"));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: workspace } });
  try {
    const base = server.base;

    // 1. POST /api/turn executes system commands and returns systemCommand + say
    const copyRes = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "copy that" }),
    });
    assert.equal(copyRes.status, 200);
    const copyBody = await copyRes.json();
    assert.equal(copyBody.action?.verb, "system");
    assert.equal(copyBody.result?.ok, true);
    assert.equal(copyBody.result?.action, "system:copy");
    assert.equal(copyBody.systemCommand?.command, "copy");
    assert.equal(copyBody.systemCommand?.target, "selection");
    assert.equal(copyBody.say, "Copied to clipboard.");

    const pasteRes = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "paste to notes.txt" }),
    });
    assert.equal(pasteRes.status, 200);
    const pasteBody = await pasteRes.json();
    assert.equal(pasteBody.systemCommand?.command, "paste");
    assert.equal(pasteBody.systemCommand?.target, "file");
    assert.equal(pasteBody.systemCommand?.file, "notes.txt");
    assert.equal(pasteBody.say, "Pasted from clipboard.");

    // 2. Multi-harness concurrent connections via POST /api/harnesses/configure & GET /api/harnesses
    const cfgMultiRes = await fetch(`${base}/api/harnesses/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harnesses: ["pi", "claude", "codex"], harness: "pi" }),
    });
    assert.equal(cfgMultiRes.status, 200);
    const cfgMultiBody = await cfgMultiRes.json();
    assert.equal(cfgMultiBody.ok, true);
    assert.equal(cfgMultiBody.activeHarness, "pi");
    assert.deepEqual(cfgMultiBody.activeHarnesses, ["pi", "claude", "codex"]);

    // Add another harness without disconnecting existing ones
    const cfgAddRes = await fetch(`${base}/api/harnesses/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "gemini" }),
    });
    assert.equal(cfgAddRes.status, 200);
    const cfgAddBody = await cfgAddRes.json();
    assert.equal(cfgAddBody.activeHarness, "gemini");
    assert.ok(cfgAddBody.activeHarnesses.includes("pi"));
    assert.ok(cfgAddBody.activeHarnesses.includes("claude"));
    assert.ok(cfgAddBody.activeHarnesses.includes("gemini"));

    // Disconnect a single harness with active: false
    const cfgOffRes = await fetch(`${base}/api/harnesses/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "codex", active: false }),
    });
    assert.equal(cfgOffRes.status, 200);
    const cfgOffBody = await cfgOffRes.json();
    assert.equal(cfgOffBody.ok, true);
    assert.ok(!cfgOffBody.activeHarnesses.includes("codex"));
    assert.ok(cfgOffBody.activeHarnesses.includes("pi"));

    const getHarnessesRes = await fetch(`${base}/api/harnesses`);
    assert.equal(getHarnessesRes.status, 200);
    const getHarnessesBody = await getHarnessesRes.json();
    assert.ok(Array.isArray(getHarnessesBody.activeHarnesses));
    assert.ok(getHarnessesBody.activeHarnesses.includes("pi"));

    // 3. POST /api/tasks/delegate and GET /api/tasks
    const emptyTaskRes = await fetch(`${base}/api/tasks/delegate`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ task: "   " }),
    });
    assert.equal(emptyTaskRes.status, 400);
    const emptyTaskBody = await emptyTaskRes.json();
    assert.equal(emptyTaskBody.refused, "invalid-task");

    const delegateRes = await fetch(`${base}/api/tasks/delegate`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        task: "Check repository structure",
        agents: ["pi", "claude"],
      }),
    });
    assert.equal(delegateRes.status, 200);
    const delegateBody = await delegateRes.json();
    assert.equal(delegateBody.ok, true);
    assert.ok(Array.isArray(delegateBody.delegated));
    assert.equal(delegateBody.delegated.length, 2);
    assert.equal(delegateBody.delegated[0].agent, "pi");
    assert.equal(delegateBody.delegated[1].agent, "claude");

    const tasksRes = await fetch(`${base}/api/tasks`);
    assert.equal(tasksRes.status, 200);
    const tasksBody = await tasksRes.json();
    assert.equal(tasksBody.ok, true);
    assert.ok(Array.isArray(tasksBody.tasks));
  } finally {
    await server.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
