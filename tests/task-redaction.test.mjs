// SECRETS MUST NOT REACH THE DURABLE RECORD — voicebox-beads-fcx9.
//
// lib/tasks.mjs persisted the terminal answer and a failure's partial VERBATIM into the .audit
// JSONL and served them back in task views, while progress/console/detail were already scrubbed.
// And lib/cli-harness-executor.mjs handed raw child chunks to onConsole. The fix redacts at the
// durable boundary (settle) and at the producer.
//
// These tests use a SYNTHETIC canary that matches the redactor's sk- pattern. It is not, and
// must never be, a real credential: do not replace it with anything that was ever issued.
//
//   node --test tests/task-redaction.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { auditFileName } from "../core/audit.ts";
import { reduceTask } from "../core/tasks.ts";
import { createTaskHost } from "../lib/tasks.mjs";
import { createCodexExecutor } from "../lib/cli-harness-executor.mjs";

// Synthetic — matches redactSecrets' sk- pattern, never a real key.
const CANARY = "sk-canary0000000000000000000000";
const environment = "env_0123456789abcdef";

function fixture(t, implementation, deadlineMs = 2000) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-redaction-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const selected = { project: "fixture", root: { kind: "machine", path: dir, environment } };
  const host = createTaskHost({
    environment, instance: "fixture", boot: "boot-one", addressKey: "test-only-host-key-not-a-live-credential",
    root: () => selected,
    executor: () => ({ check: () => ({ ok: true, mechanism: "closed-no-effects-unit-fixture", bounds: { deadlineMs, maxOutputBytes: 4096 } }), run: implementation }),
  });
  const file = path.join(dir, ".audit", auditFileName("fixture", `machine:${dir}`));
  const entries = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : []);
  const raw = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const authority = { owner: "authenticated-owner-A", callId: "call-one" };
  return {
    host, entries, raw, authority,
    admit: (args = { agent: "fixture", task: "do the thing" }) => host.call("delegate_task", args, authority),
    status: (address) => host.call("task_status", { address }, authority),
    record: (address) => reduceTask(entries(), address),
  };
}

async function until(read, predicate, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = read(); if (predicate(value)) return value; await delay(10); }
  assert.fail(`condition did not occur: ${JSON.stringify(read())}`);
}

function assertScrubbed({ text, view, what }) {
  assert.ok(!text.includes(CANARY), `the canary reached the durable .audit JSONL in ${what}`);
  assert.ok(text.includes("[redacted]"), `the redaction marker is missing from the .audit JSONL for ${what}`);
  const rendered = JSON.stringify(view);
  assert.ok(!rendered.includes(CANARY), `the canary reached the task VIEW in ${what}`);
  assert.ok(rendered.includes("[redacted]"), `the redaction marker is missing from the task view for ${what}`);
}

test("a completed answer is redacted at the durable boundary — audit file and task view", async (t) => {
  const f = fixture(t, async () => `work is done; the key I saw was ${CANARY}`);
  const admitted = f.admit();
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const { task: view } = await until(
    () => f.status(admitted.task.address),
    (r) => r.ok && r.task.state === "completed",
  );
  assert.equal(view.state, "completed");
  assert.ok(view.answer.includes("work is done"), "non-secret content must survive unredacted");
  assertScrubbed({ text: f.raw(), view, what: "the completed answer" });
});

test("a failure whose executor output carried a secret never persists it — the over-budget path", async (t) => {
  // The over-budget answer must not reach the durable record in ANY field. NOTE (found while
  // writing this test): D6's `partial: answer` spread in the catch path is DEAD CODE today —
  // `answer` is block-scoped to the try, so the catch sees it as undeclared and the partial is
  // silently dropped (the existing D6 test only checks `progress`). The durable boundary in
  // settle() redacts `partial` regardless, so if the scoping is ever repaired the record stays
  // safe. The resurrection decision is filed as its own bead; this test locks TODAY's behavior:
  // no partial field, and no canary anywhere in the audit.
  const big = `partial work ${CANARY} `.repeat(200); // comfortably over the 4096-byte bound
  const f = fixture(t, async () => big);
  const admitted = f.admit();
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const { task: view } = await until(
    () => f.status(admitted.task.address),
    (r) => r.ok && r.task.state !== "queued" && r.task.state !== "running",
  );
  assert.equal(view.state, "failed", JSON.stringify({ ...view, partial: undefined }));
  assert.equal(view.reason, "task-output-over-budget");
  assert.ok(!f.raw().includes(CANARY), "the canary reached the durable .audit JSONL on the failure path");
  assert.ok(!JSON.stringify(view).includes(CANARY), "the canary reached the task view on the failure path");
});

test("the CLI harness producer redacts onConsole chunks before any consumer sees them", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-redaction-cli-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeCli = path.join(dir, "fake-codex");
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("codex 1.2.3"); process.exit(0); }
console.log("stdout mentions ${CANARY} plainly");
console.error("stderr mentions ${CANARY} plainly");
`);
  fs.chmodSync(fakeCli, 0o755);
  const executor = createCodexExecutor({ cliPath: fakeCli });
  const consoleEntries = [];
  const result = await executor.run({
    input: { task: "say something", context: [] },
    bounds: { deadlineMs: 10000, maxOutputBytes: 4096 },
    onConsole: (entry) => consoleEntries.push(entry),
    root: { kind: "machine", path: dir, environment },
    agentConfig: null,
    harness: "codex",
  });
  assert.ok(consoleEntries.length >= 2, `expected stdout and stderr console entries, got ${JSON.stringify(consoleEntries)}`);
  for (const entry of consoleEntries) {
    assert.ok(!entry.text.includes(CANARY), `the producer handed a raw chunk to onConsole: ${JSON.stringify(entry)}`);
    assert.ok(entry.text.includes("[redacted]"), `the producer's chunk lost its redaction marker: ${JSON.stringify(entry)}`);
  }
  assert.ok(String(result).includes("plainly"), "non-secret content must survive unredacted");
});
