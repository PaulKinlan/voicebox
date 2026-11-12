// tests/task-budget.test.mjs — a delegated task is bounded by SILENCE and by a BUDGET (voicebox-beads-cwx5.9).
//
// Every stdio harness used to be killed at 60s or 120s of wall clock, and a CLI harness at 64 KiB of output,
// whether or not it was working. These tests are about what replaced that:
//   1. the default budget an agent is configured with, the ceiling, and the lift of the old saved defaults;
//   2. a CLI harness that keeps printing runs past the silence bound, one that prints nothing is stopped as
//      stuck, and a long run keeps the END of its output instead of being killed for its length.
// The ACP half (silence re-armed by session/update, paused for a permission) is in tests/acp-client.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_TASK_BUDGET_MS, MAX_TASK_BUDGET_MS, taskBounds } from "../core/tasks.ts";
import { validateConfiguredAgent } from "../core/harness-config.ts";
import { createAgentRegistry, liftLegacyDeadline } from "../lib/harness-config.mjs";
import {
  createCodexExecutor, keepTail,
  CLI_EXECUTOR_MAX_OUTPUT_BYTES, CLI_EXECUTOR_TIMEOUT_CEILING_MS, CLI_OUTPUT_TRUNCATED_NOTE,
} from "../lib/cli-harness-executor.mjs";

const NODE_RUNTIME = "node";
const stdioAgent = (extra = {}) => ({ id: "a1", name: "A", harness: "codex", adapter: "codex-cli", transport: "stdio", environmentKey: "local", ...extra });

// ── 1. the configured budget ─────────────────────────────────────────────────────────────────────────
test("the budget is minutes, inside the task core's own ceiling", () => {
  assert.equal(DEFAULT_TASK_BUDGET_MS, 30 * 60 * 1000);
  assert.equal(MAX_TASK_BUDGET_MS, 60 * 60 * 1000);
  assert.ok(taskBounds({ deadlineMs: DEFAULT_TASK_BUDGET_MS, maxOutputBytes: 65536 }), "the default must be admissible as a task bound");
  assert.ok(taskBounds({ deadlineMs: MAX_TASK_BUDGET_MS, maxOutputBytes: 65536 }));
  assert.equal(CLI_EXECUTOR_TIMEOUT_CEILING_MS, DEFAULT_TASK_BUDGET_MS);
});

test("a stdio agent defaults to the task budget, may be given up to an hour, and no more", () => {
  const runtime = NODE_RUNTIME;
  const plain = validateConfiguredAgent(stdioAgent(), runtime);
  assert.equal(plain.ok, true, plain.why);
  assert.equal(plain.agent.bounds.deadlineMs, DEFAULT_TASK_BUDGET_MS);
  assert.equal(validateConfiguredAgent(stdioAgent({ bounds: { deadlineMs: MAX_TASK_BUDGET_MS } }), runtime).ok, true);
  const over = validateConfiguredAgent(stdioAgent({ bounds: { deadlineMs: MAX_TASK_BUDGET_MS + 1 } }), runtime);
  assert.equal(over.ok, false);
  assert.match(over.why, /between 100 and 3600000 ms/);
});

test("the old saved defaults (60s, 120s) are lifted on load; a deliberate value and a non-stdio agent are left alone", () => {
  assert.equal(liftLegacyDeadline(stdioAgent({ bounds: { deadlineMs: 60000, maxOutputBytes: 1 } })).bounds.deadlineMs, DEFAULT_TASK_BUDGET_MS);
  assert.equal(liftLegacyDeadline(stdioAgent({ bounds: { deadlineMs: 120000 } })).bounds.deadlineMs, DEFAULT_TASK_BUDGET_MS);
  assert.equal(liftLegacyDeadline(stdioAgent({ bounds: { deadlineMs: 90000 } })).bounds.deadlineMs, 90000, "a value nobody defaulted to was chosen");
  assert.equal(liftLegacyDeadline({ transport: "in-process", bounds: { deadlineMs: 60000 } }).bounds.deadlineMs, 60000);
  assert.equal(liftLegacyDeadline(stdioAgent({ bounds: { deadlineMs: 60000, maxOutputBytes: 7 } })).bounds.maxOutputBytes, 7, "only the deadline moves");

  const saved = JSON.stringify([stdioAgent({ id: "old", bounds: { deadlineMs: 120000, maxOutputBytes: 65536 } }), stdioAgent({ id: "chosen", bounds: { deadlineMs: 5000, maxOutputBytes: 65536 } })]);
  const registry = createAgentRegistry({ storage: { getItem: () => saved, setItem() {} }, runtime: NODE_RUNTIME });
  const byId = Object.fromEntries(registry.list().map((a) => [a.id, a.bounds.deadlineMs]));
  assert.deepEqual(byId, { old: DEFAULT_TASK_BUDGET_MS, chosen: 5000 });
});

// ── 2. the CLI executor ──────────────────────────────────────────────────────────────────────────────
function fakeCodex(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-task-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin"); const work = path.join(dir, "work");
  fs.mkdirSync(bin); fs.mkdirSync(work);
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.42.0"; exit 0; fi\n${body}\n`, { mode: 0o755 });
  return { env: { PATH: `${bin}:${process.env.PATH}` }, work };
}

test("keepTail keeps the end within the byte bound and never splits a character", () => {
  assert.deepEqual(keepTail("short", 10), { text: "short", dropped: false });
  assert.deepEqual(keepTail("0123456789", 4), { text: "6789", dropped: true });
  const kept = keepTail("ab" + "é".repeat(5), 5); // é is two bytes: a 5-byte window would start mid-character
  assert.equal(kept.text, "éé");
  assert.ok(Buffer.byteLength(kept.text) <= 5);
});

test("a CLI harness with no configured deadline gets the task budget, not 120s", (t) => {
  const { env } = fakeCodex(t, "echo done");
  const checked = createCodexExecutor({ env }).check();
  assert.equal(checked.ok, true, checked.why);
  assert.deepEqual(checked.bounds, { deadlineMs: DEFAULT_TASK_BUDGET_MS, maxOutputBytes: CLI_EXECUTOR_MAX_OUTPUT_BYTES });
  assert.equal(createCodexExecutor({ env }).check({ bounds: { deadlineMs: 5000 } }).bounds.deadlineMs, 5000, "a configured deadline still wins when shorter");
});

test("a CLI harness that keeps printing outlives the silence bound", async (t) => {
  const { env, work } = fakeCodex(t, "for i in 1 2 3 4 5 6; do echo step $i; sleep 0.1; done; echo finished");
  const result = await createCodexExecutor({ env, silenceMs: 300 }).run({ input: { task: "x" }, root: { path: work } });
  assert.equal(result.ok, true);
  assert.match(result.output, /finished$/, "600ms of visible work must survive a 300ms silence bound");
});

test("a CLI harness that prints nothing is stopped as stuck, by name", async (t) => {
  const { env, work } = fakeCodex(t, "echo starting; exec sleep 30");
  const started = Date.now();
  await assert.rejects(
    createCodexExecutor({ env, silenceMs: 200 }).run({ input: { task: "x" }, root: { path: work } }),
    (err) => err.refused === "task-deadline" && /printed nothing for 200ms and was stopped as stuck/.test(err.message),
  );
  assert.ok(Date.now() - started < 5000, "silence, not the 30 minute budget, ended it");
});

test("a long run is not killed for its length: the end of the output is kept and marked", async (t) => {
  // ~200 KiB, three times the answer bound. This run used to be killed with acp-output-over-budget.
  const { env, work } = fakeCodex(t, "i=0; while [ $i -lt 4000 ]; do echo \"line $i ...........................................\"; i=$((i+1)); done; echo THE-RESULT");
  const seen = [];
  const result = await createCodexExecutor({ env }).run({ input: { task: "x" }, root: { path: work }, onConsole: (line) => seen.push(line.text) });
  assert.equal(result.ok, true);
  assert.ok(result.output.startsWith(CLI_OUTPUT_TRUNCATED_NOTE), "the answer says its beginning was dropped");
  assert.match(result.output, /THE-RESULT$/);
  assert.ok(Buffer.byteLength(result.output) <= CLI_EXECUTOR_MAX_OUTPUT_BYTES, "the kept answer still fits the task's output bound");
  assert.ok(seen.join("\n").includes("line 0 "), "the dropped beginning was still streamed to the console");
});
