import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionApprovals, APPROVAL_TTL_MS } from "../lib/extension-approval.mjs";

const REPO = path.dirname(fileURLToPath(import.meta.url)) + "/..";

test("extension approval: host-only code, exact plan, single use, expiry, attempts and bounded requests", () => {
  let time = 0, output = "";
  const store = createExtensionApprovals({ now: () => time, display: (line) => { output += line + "\n"; } });
  const plan = { id: "clock", tools: [{ name: "clock", primitive: "now" }] };
  const issue = () => {
    output = "";
    const r = store.request(plan);
    const code = output.match(/: (\d{8}) /)?.[1];
    assert(code);
    assert(!JSON.stringify(r).includes(code), "code leaked in page response");
    return { ...r, code };
  };
  let r = issue();
  assert.deepEqual(store.consume(r.requestId, r.code, plan), { ok: true });
  assert.equal(store.consume(r.requestId, r.code, plan).refused, "approval-used");
  r = issue();
  assert.equal(store.consume(r.requestId, r.code, { ...plan, id: "other" }).refused, "approval-plan-changed");
  assert.equal(store.consume(r.requestId, r.code, plan).refused, "approval-used");
  r = issue();
  time += APPROVAL_TTL_MS;
  assert.equal(store.consume(r.requestId, r.code, plan).refused, "approval-expired");
  r = issue();
  const wrong = r.code === "00000000" ? "11111111" : "00000000";
  for (let i = 1; i <= 5; i++) assert.equal(store.consume(r.requestId, wrong, plan).refused,
    i < 5 ? "approval-code-invalid" : "approval-attempts-exhausted");
  assert.equal(store.consume(r.requestId, r.code, plan).refused, "approval-used");
  assert.equal(store.consume("unknown", r.code, plan).refused, "approval-unknown");
  for (let i = 4; i < 32; i++) issue();
  assert.equal(store.request(plan).refused, "approval-rate-limited");
  time += APPROVAL_TTL_MS * 2;
  assert.equal(store.request(plan).ok, true);
});

test("pending approval file lifecycle and CLI tools/approval-code.mjs (voicebox-beads-62f)", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vb-approval-file-"));
  const pendingFile = path.join(scratch, ".pending-approval.json");
  let time = Date.now();
  const store = createExtensionApprovals({
    now: () => time,
    display: () => {},
    pendingFile: () => pendingFile,
  });

  const plan = { id: "weather", name: "Weather Tool", declared: ["network"], tools: [{ name: "get_weather" }] };

  try {
    // 1. CLI with no pending requests outputs "No pending extension approval requests."
    const noReqOutput = execFileSync(process.execPath, [path.join(REPO, "tools/approval-code.mjs")], {
      env: { ...process.env, VOICEBOX_EXTENSIONS_DIR: scratch },
      encoding: "utf8",
    });
    assert.match(noReqOutput, /No pending extension approval requests/);

    // 2. Request an approval: file is written with mode 0600
    const resp = store.request(plan);
    assert.equal(resp.ok, true);
    assert.ok(existsSync(pendingFile), "pending approval file must be created on request");

    // Mode must be 0600 (read/write by owner only)
    const stat = statSync(pendingFile);
    assert.equal(stat.mode & 0o777, 0o600, "pending approval file must have mode 0600");

    const content = JSON.parse(readFileSync(pendingFile, "utf8"));
    assert.equal(content.requestId, resp.requestId);
    assert.equal(content.plan.id, "weather");
    assert.match(content.code, /^\d{8}$/);
    assert.equal(content.expiresAt, time + APPROVAL_TTL_MS);

    // Security invariant: the response returned by store.request() NEVER contains the code
    assert(!JSON.stringify(resp).includes(content.code), "approval code must NEVER leak into API response");

    // 3. CLI outputs active request details and code
    const cliOutput = execFileSync(process.execPath, [path.join(REPO, "tools/approval-code.mjs")], {
      env: { ...process.env, VOICEBOX_EXTENSIONS_DIR: scratch },
      encoding: "utf8",
    });
    assert.match(cliOutput, /EXTENSION APPROVAL REQUEST/);
    assert.match(cliOutput, /Weather Tool/);
    assert.match(cliOutput, new RegExp(`Approval code:\\s*${content.code}`));
    assert.match(cliOutput, /Enter this 8-digit code in the room UI/);

    // 4. Consuming the code removes the pending file
    const consumed = store.consume(resp.requestId, content.code, plan);
    assert.equal(consumed.ok, true);
    assert.equal(existsSync(pendingFile), false, "pending approval file must be deleted upon consume");

    // 5. Expiry test: CLI removes expired file and outputs expiration message
    writeFileSync(pendingFile, JSON.stringify({
      requestId: "test-expired",
      plan: { id: "weather", name: "Weather Tool" },
      code: "12345678",
      expiresAt: Date.now() - 5000,
    }), { mode: 0o600 });

    // CLI detects expired request, deletes file, and reports expiration
    const expiredCli = execFileSync(process.execPath, [path.join(REPO, "tools/approval-code.mjs")], {
      env: { ...process.env, VOICEBOX_EXTENSIONS_DIR: scratch },
      encoding: "utf8",
    });
    assert.match(expiredCli, /expired at/);
    assert.equal(existsSync(pendingFile), false, "CLI must clean up expired pending approval file");

    // 6. Attempts exhausted deletes file
    time = Date.now();
    const resp3 = store.request(plan);
    assert.ok(existsSync(pendingFile));
    for (let i = 1; i <= 5; i++) {
      store.consume(resp3.requestId, "00000000", plan);
    }
    assert.equal(existsSync(pendingFile), false, "pending approval file must be deleted when attempts exhausted");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
