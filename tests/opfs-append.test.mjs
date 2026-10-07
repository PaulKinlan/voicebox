// tests/opfs-append.test.mjs — voicebox-beads-2g7p: appends to one OPFS file must be ATOMIC.
//
// Measured before the fix, in a real browser: 40 concurrent appendLine calls -> 1 line survived
// (39 silently overwritten — every writer captured the same file size and wrote at the same
// offset). This is the mechanism that ate the page-owned delete's audit entry under gate load
// (voicebox-beads-s4mo): the audit is written through browser/storage.ts's adapter (the module
// the worker actually loads — worker.ts -> storage.ts), the test's readFile polls each record an
// act, and one overlapped the delete's append. The fix serializes appends per (root, file) on a
// promise chain inside browser/storage.ts; these tests pin the guarantee, the interleave it
// protects, and that a failed append neither wedges the chain nor swallows its own rejection.
//
//   node --test tests/opfs-append.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "opfs-append" } }); });
test.after(async () => { await server?.stop?.(); });

async function withPage(t, fn) {
  const page = await launch();
  try {
    await page.goto(`${server.base}/environment.html`);
    return await page.evaluate(fn);
  } finally {
    await page.close().catch(() => {});
  }
}

test("40 concurrent appends to one file keep all 40 lines", async (t) => {
  const result = await withPage(t, async () => {
    const { opfsStorage } = await import("/browser/storage.ts");
    const storage = await opfsStorage("race");
    const N = 40;
    await Promise.all(Array.from({ length: N }, (_, i) => storage.appendLine("race/log.txt", `line-${String(i).padStart(2, "0")}`)));
    const lines = await storage.readLines("race/log.txt");
    return { present: lines.length, distinct: new Set(lines).size, sorted: [...lines].sort() };
  });
  assert.equal(result.present, 40, `lines lost to concurrent appends: ${result.present}/40 present`);
  assert.equal(result.distinct, 40, "a line was duplicated or torn");
  assert.deepEqual(result.sorted[0], "line-00");
  assert.deepEqual(result.sorted[39], "line-39");
});

test("concurrent first-writes to a NOT-YET-EXISTING file all land (the create race)", async (t) => {
  const result = await withPage(t, async () => {
    const { opfsStorage } = await import("/browser/storage.ts");
    const storage = await opfsStorage("fresh-root");
    // No pre-created directory or file: the first append creates both, and concurrent first-writes
    // used to race the create (NotFoundError) on top of racing the size capture.
    const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => storage.appendLine("fresh-root/new/log.txt", `first-${i}`)));
    const rejected = settled.filter((s) => s.status === "rejected").map((s) => String(s.reason));
    const lines = await storage.readLines("fresh-root/new/log.txt");
    return { rejected, present: lines.length };
  });
  assert.deepEqual(result.rejected, [], `concurrent first-writes failed: ${result.rejected.join("; ")}`);
  assert.equal(result.present, 12, `first-write race lost lines: ${result.present}/12 present`);
});

test("appends interleaved with reads (the delete/read overlap shape) lose nothing", async (t) => {
  const result = await withPage(t, async () => {
    const { opfsStorage } = await import("/browser/storage.ts");
    const storage = await opfsStorage("overlap");
    const appends = Array.from({ length: 30 }, (_, i) => storage.appendLine("overlap/log.txt", `entry-${i}`));
    const reads = Array.from({ length: 10 }, async () => { await storage.readLines("overlap/log.txt"); });
    await Promise.all([...appends, ...reads]);
    return (await storage.readLines("overlap/log.txt")).length;
  });
  assert.equal(result, 30, `the read/write interleave lost entries: ${result}/30 present`);
});

test("two ADAPTER INSTANCES over the same file cannot race (the audit-fallback shape)", async (t) => {
  const result = await withPage(t, async () => {
    const { opfsStorage } = await import("/browser/storage.ts");
    // worker.ts builds a fresh opfsStorage("v1/audit-fallback") per fallback append — two adapters,
    // one physical file. The chain key is (root, resolved), so the serialization must hold across
    // instances, not just within one adapter.
    const a = await opfsStorage("two-adapters");
    const b = await opfsStorage("two-adapters");
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).appendLine("two-adapters/shared.txt", `via-${i % 2 === 0 ? "a" : "b"}-${i}`)));
    return (await a.readLines("two-adapters/shared.txt")).length;
  });
  assert.equal(result, 20, `cross-instance appends lost lines: ${result}/20 present`);
});

test("a failed append rejects its caller and does not wedge the chain", async (t) => {
  const result = await withPage(t, async () => {
    const { opfsStorage } = await import("/browser/storage.ts");
    const storage = await opfsStorage("errors");
    let rejected = null;
    try {
      await storage.appendLine("", "never lands"); // an empty path is not a file — the write must fail
    } catch (e) {
      rejected = String(e?.name ?? e);
    }
    // The chain must still carry the NEXT append after the rejection.
    await storage.appendLine("errors/after/log.txt", "the chain survived");
    const lines = await storage.readLines("errors/after/log.txt");
    return { rejected, survived: lines };
  });
  assert.ok(result.rejected, "the failing append did not reject its caller");
  assert.deepEqual(result.survived, ["the chain survived"], "the chain wedged on a rejected append");
});

test("sequential appends are unchanged (negative control)", async (t) => {
  const result = await withPage(t, async () => {
    const { opfsStorage } = await import("/browser/storage.ts");
    const storage = await opfsStorage("seq");
    for (let i = 0; i < 5; i++) await storage.appendLine("seq/log.txt", `s${i}`);
    return await storage.readLines("seq/log.txt");
  });
  assert.deepEqual(result, ["s0", "s1", "s2", "s3", "s4"]);
});
