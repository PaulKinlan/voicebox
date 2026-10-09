// tests/worker-audit-waterfall.test.mjs — verify parallel audit JSONL reads without waterfalls (voicebox-beads-rw7o)
import test from "node:test";
import assert from "node:assert/strict";
import { mapConcurrent, MAX_CONCURRENT_AUDIT_READS } from "../browser/worker.ts";

test("mapConcurrent: preserves deterministic index order while executing concurrently", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  let active = 0;
  let maxActive = 0;

  const results = await mapConcurrent(items, 4, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    // Introduce artificial jitter: earlier items wait longer to prove output preserves input order
    const delay = (10 - item) * 5;
    await new Promise((r) => setTimeout(r, delay));
    active--;
    return `item-${item}`;
  });

  assert.deepEqual(results, [
    "item-1",
    "item-2",
    "item-3",
    "item-4",
    "item-5",
    "item-6",
    "item-7",
    "item-8",
  ], "output order must match input order regardless of completion order");

  assert.ok(maxActive >= 2, `expected concurrent execution (active >= 2), got ${maxActive}`);
  assert.ok(maxActive <= 4, `expected concurrency bounded by limit (active <= 4), got ${maxActive}`);
});

test("mapConcurrent: fast-paths when items.length <= limit", async () => {
  const items = [10, 20];
  let active = 0;
  let maxActive = 0;

  const results = await mapConcurrent(items, MAX_CONCURRENT_AUDIT_READS, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return item * 2;
  });

  assert.deepEqual(results, [20, 40]);
  assert.equal(maxActive, 2, "both items should be executed concurrently");
});

test("audit reader: multiple writer files are read concurrently rather than sequentially (voicebox-beads-rw7o)", async () => {
  // Simulate an OPFS directory with 4 writer files (alpha, beta, gamma, delta)
  const writerNames = ["writer-alpha.jsonl", "writer-beta.jsonl", "writer-gamma.jsonl", "writer-delta.jsonl"];
  const listing = {
    entries: [
      ...writerNames.map((name) => ({ kind: "file", name })),
      { kind: "file", name: "ignored.txt" },
      { kind: "directory", name: "subfolder" },
    ],
  };

  const fileContents = {
    "writer-alpha.jsonl": ['{"kind":"act","seq":1,"instance":"alpha","turn":"t1"}'],
    "writer-beta.jsonl": ['{"kind":"act","seq":2,"instance":"beta","turn":"t2"}'],
    "writer-gamma.jsonl": ['{"kind":"act","seq":3,"instance":"gamma","turn":"t3"}'],
    "writer-delta.jsonl": ['{"kind":"act","seq":4,"instance":"delta","turn":"t4"}'],
  };

  let activeReads = 0;
  let maxConcurrentReads = 0;
  const readDelayMs = 25;

  const instrumentedStore = {
    async listChildren() {
      return listing;
    },
    async readLines(filePath) {
      activeReads++;
      maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
      const name = filePath.split("/").pop();
      await new Promise((r) => setTimeout(r, readDelayMs));
      activeReads--;
      return fileContents[name] || [];
    },
  };

  // 1. Concurrent read simulation matching browser/worker.ts logFilesFor
  const targetFiles = listing.entries.filter((file) => file.kind === "file" && file.name.endsWith(".jsonl"));
  const t0 = performance.now();
  const loaded = await mapConcurrent(targetFiles, MAX_CONCURRENT_AUDIT_READS, async (file) => {
    const lines = await instrumentedStore.readLines(`v1/projects/atlas/.audit/${file.name}`);
    return { name: file.name, lines };
  });
  const concurrentDurationMs = performance.now() - t0;

  // Assert concurrent execution: all 4 reads ran concurrently
  assert.ok(maxConcurrentReads >= 3, `expected concurrent overlap across writer files, got max ${maxConcurrentReads}`);
  assert.equal(loaded.length, 4);
  assert.deepEqual(loaded.map((f) => f.name), writerNames, "writer file order must be strictly preserved");

  // 2. Negative control: sequential loop comparison
  let seqActiveReads = 0;
  let seqMaxConcurrentReads = 0;
  const seqStore = {
    async readLines(filePath) {
      seqActiveReads++;
      seqMaxConcurrentReads = Math.max(seqMaxConcurrentReads, seqActiveReads);
      const name = filePath.split("/").pop();
      await new Promise((r) => setTimeout(r, readDelayMs));
      seqActiveReads--;
      return fileContents[name] || [];
    },
  };

  const tSeq0 = performance.now();
  const sequentialLoaded = [];
  for (const file of targetFiles) {
    const lines = await seqStore.readLines(`v1/projects/atlas/.audit/${file.name}`);
    sequentialLoaded.push({ name: file.name, lines });
  }
  const sequentialDurationMs = performance.now() - tSeq0;

  assert.equal(seqMaxConcurrentReads, 1, "sequential loop must have max concurrency of exactly 1");
  assert.deepEqual(loaded, sequentialLoaded, "concurrent and sequential outputs must match identically");
  assert.ok(
    concurrentDurationMs < sequentialDurationMs * 0.75,
    `concurrent read (${concurrentDurationMs.toFixed(1)}ms) should be significantly faster than sequential waterfall (${sequentialDurationMs.toFixed(1)}ms)`,
  );
});
