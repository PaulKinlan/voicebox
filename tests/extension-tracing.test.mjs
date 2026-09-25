// tests/extension-tracing.test.mjs — Verify rich detailed extension lifecycle logging (voicebox-beads-4gv)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callTool, setHostHooks } from "../lib/extensions.mjs";
import { colorizeTags, TAG_COLORS, RESET_COLOR } from "../lib/logger.mjs";

test("extension logging: detailed traces on invocation and refusal", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vb-ext-trace-"));
  const workspace = path.join(scratch, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  t.after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  setHostHooks({
    activeRoot: () => ({ project: "test", root: { kind: "machine", path: workspace, environment: "env_test" } }),
  });

  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => { logs.push(args.join(" ")); origLog.apply(console, args); };
  console.error = (...args) => { errors.push(args.join(" ")); origError.apply(console, args); };
  t.after(() => {
    console.log = origLog;
    console.error = origError;
  });

  // 1. Invocation of unknown tool logs invocation and refusal trace
  const unknownRes = await callTool("missing_calc", { query: "42" });
  assert.equal(unknownRes.ok, false);
  assert.ok(logs.some((l) => l.includes("[extension] calling 'missing_calc' args={\"query\":\"42\"}")));
  assert.ok(errors.some((e) => e.includes("[extension:refused] unknown-tool: no tool 'missing_calc' in the loaded set")));
});

test("color-coded extension tags: colorizeTags applies distinct ANSI styling for extension channels", () => {
  const netLog = colorizeTags("[extension:network] fetch https://example.com", true);
  assert.equal(netLog, `${TAG_COLORS["extension:network"]}[extension:network]${RESET_COLOR} fetch https://example.com`);

  const wasmLog = colorizeTags("[extension:wasm] diff executed in 2ms", true);
  assert.equal(wasmLog, `${TAG_COLORS["extension:wasm"]}[extension:wasm]${RESET_COLOR} diff executed in 2ms`);

  const refusedLog = colorizeTags("[extension:refused] host-not-allowed: forbidden", true);
  assert.equal(refusedLog, `${TAG_COLORS["extension:refused"]}[extension:refused]${RESET_COLOR} host-not-allowed: forbidden`);

  const callLog = colorizeTags("[extension] calling 'web_search'", true);
  assert.equal(callLog, `${TAG_COLORS.extension}[extension]${RESET_COLOR} calling 'web_search'`);
});
