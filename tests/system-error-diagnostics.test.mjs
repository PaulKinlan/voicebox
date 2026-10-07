// tests/system-error-diagnostics.test.mjs — Verify structured system error and tool failure diagnostics (voicebox-beads-kusd).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDebugEnabled, setDebugEnabled } from "../public/debug-transcript.js";
import { redactSecrets, redactObject } from "../lib/redact.mjs";
import { startServer } from "./lib/server.mjs";

test("debug config: isDebugEnabled and setDebugEnabled toggle debug state cleanly", () => {
  try {
    setDebugEnabled(true);
    assert.equal(isDebugEnabled(), true);
    setDebugEnabled(false);
    assert.equal(isDebugEnabled(), false);
  } finally {
    setDebugEnabled(null);
  }
});

test("redactSecrets: scrubs credentials and tokens from error messages and diagnostic traces", () => {
  const rawError = "Error: Authentication failed with api key sk-ant-secret1234567890abcdef at http://host/api";
  const scrubbed = redactSecrets(rawError);
  assert.doesNotMatch(scrubbed, /secret1234567890/);
  assert.match(scrubbed, /\[redacted\]/);

  const bearerTrace = "Request failed: Bearer token-value-9876543210 expired";
  const scrubbedBearer = redactSecrets(bearerTrace);
  assert.doesNotMatch(scrubbedBearer, /token-value-9876543210/);
  assert.match(scrubbedBearer, /\[redacted\]/);

  const obj = redactObject({
    apiKey: "AIzaSySecretApiKey1234567890",
    name: "tool_test",
    args: { key: "sk-proj-nestedkey12345" },
  });
  assert.equal(obj.apiKey, "[redacted]");
  assert.equal(obj.name, "tool_test");
  assert.equal(obj.args.key, "[redacted]");
});

test("tool failures carry structured diagnostic why and error properties", async (t) => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vb-sys-err-diag-")));
  const workspace = path.join(scratch, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  const server = await startServer({
    env: {
      VOICEBOX_WORKSPACE: workspace,
      VOICEBOX_RESOLVER: "script",
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  // Execute an action via /api/turn that fails (edit non-existent file)
  const res = await fetch(`${server.base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: {
        verb: "edit",
        name: "missing_file.txt",
        oldText: "old",
        newText: "new",
      },
    }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.result?.ok, false, "execution result must indicate failure");
  assert.equal(data.result?.refused, "not-found", "result must have structured refused code");
  assert.ok(data.result?.why?.includes("missing_file.txt"), "result must have human-readable why");
  assert.ok(data.result?.error?.includes("refused: not-found"), "result must have error string");

  // Verify that /api/activity recorded the error with kind="error" and status="error"
  const actRes = await fetch(`${server.base}/api/activity`);
  assert.equal(actRes.status, 200);
  const actData = await actRes.json();
  const entries = actData.entries ?? actData.activity ?? [];
  const errorEntry = entries.find((e) => e.kind === "error" || e.status === "error");
  assert.ok(errorEntry, "server workActivityLog must record the tool failure as an error entry");
  assert.ok(errorEntry.summary.includes("edit: not-found") || errorEntry.summary.includes("missing_file.txt"));
});
