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

// ── 5lzv: the dormant browser task host gets the same boundary, and console.source is normalized ──

import { createBrowserTaskHost } from "../lib/task-placement.mjs";

test("the (unwired) browser task host scrubs the terminal answer at ITS durable boundary", async () => {
  // The browser host is not wired into the served app today (only its tests import it); the
  // scrub exists so wiring it can never introduce the verbatim-persistence class (fcx9).
  // An in-memory localStorage shim makes the DURABLE surface itself assertable (bare Node has none).
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  const keyBytes = new Uint8Array(32).fill(9);
  const authority = { owner: "redaction-owner", callId: "redaction-call-1" };
  const host = createBrowserTaskHost({
    environment: "env_browser_redact",
    instance: "tab-redact",
    boot: "boot-redact-1",
    keyBytes,
    root: () => ({ kind: "opfs", path: "v1/projects/redact", environment: "env_browser_redact" }),
    executor: () => ({
      check: () => ({ ok: true, mechanism: "test", bounds: { deadlineMs: 5000, maxOutputBytes: 4096 } }),
      run: async ({ report }) => {
        report(`progress mentions ${CANARY} while running`);
        return `the answer kept ${CANARY} in prose`;
      },
    }),
  });

  const admitted = await host.call("delegate_task", { agent: "in-page-agent", task: "leak" }, authority);
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const address = admitted.task.address;
  let view;
  for (let i = 0; i < 100; i++) {
    view = (await host.call("task_status", { address }, authority)).task;
    if (view.state === "completed") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(view.state, "completed");
  assert.ok(view.answer.includes("the answer kept"), "non-secret prose survives");
  assert.ok(!view.answer.includes(CANARY), "the canary reached the browser host's answer");
  assert.ok(view.answer.includes("[redacted]"));
  assert.ok(!String(view.progress ?? "").includes(CANARY), "the canary reached the running-phase progress note");

  // And from a FRESH host instance (the reload path — the view is rebuilt from the persisted record):
  const hostReloaded = createBrowserTaskHost({
    environment: "env_browser_redact",
    instance: "tab-redact",
    boot: "boot-redact-1",
    keyBytes,
    root: () => ({ kind: "opfs", path: "v1/projects/redact", environment: "env_browser_redact" }),
    executor: () => { throw new Error("a reloaded host must not rerun tasks"); },
  });
  const revived = (await hostReloaded.call("task_status", { address }, authority)).task;
  assert.equal(revived.state, "completed");
  assert.ok(!JSON.stringify(revived).includes(CANARY), "the persisted record served the canary to a reloaded host");
  assert.ok(String(revived.answer).includes("[redacted]"));

  // And the durable surface ITSELF, not only the view built from it:
  const rawStored = store.get(`vb_task_${address}`);
  assert.ok(rawStored, "the record must be in localStorage for the reload path to mean anything");
  assert.ok(!rawStored.includes(CANARY), "the canary reached the durable localStorage record");
  assert.ok(rawStored.includes("[redacted]"));
  delete globalThis.localStorage;
});

test("an executor-supplied console source is normalized to the known set (server host)", async (t) => {
  const f = fixture(t, async ({ onConsole }) => {
    // The ONLY console entry carries a hostile source string — it is the one that persists.
    onConsole({ source: "https://attacker.invalid/tracker", text: `a line with ${CANARY}` });
    return "done";
  });
  const admitted = f.admit();
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const { task: view } = await until(
    () => f.status(admitted.task.address),
    (r) => r.ok && r.task.state === "completed",
  );
  assert.equal(view.console.source, "stderr", "an unknown executor-supplied source must normalize to stderr, not persist verbatim");
  assert.ok(view.console.text.includes("[redacted]"));
  const raw = f.raw();
  assert.ok(!raw.includes("attacker.invalid"), "an unknown executor-supplied source was persisted verbatim");
  assert.ok(!raw.includes(CANARY));
});
