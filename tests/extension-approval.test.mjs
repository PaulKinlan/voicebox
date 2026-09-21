import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionApprovals, APPROVAL_TTL_MS } from "../lib/extension-approval.mjs";

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
