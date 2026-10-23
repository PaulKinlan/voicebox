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

test("audit reader: parallel read dispatch proven by a start-barrier, not a wall-clock ratio (voicebox-beads-rw7o, voicebox-beads-dkw4)", async () => {
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

  // START-BARRIER PROOF (voicebox-beads-dkw4): every read holds until ALL FOUR have started.
  // mapConcurrent (items.length <= limit) dispatches each read synchronously before its first
  // await, so the barrier opens in microtasks: the pass path runs no timer and compares no
  // wall-clock ratio, so it cannot flip under host load. A waterfall dispatch can never open
  // it — read 2 starts only after read 1 settles, and read 1 waits for started === 4 — and
  // the stall guard below turns that into a loud failure instead of a hung tier. The removed
  // concurrent < sequential * 0.75 ratio measured the machine, not the code: under loadavg ~16
  // both arms slow together and it failed at 188.8ms vs 197.7ms on an unchanged tree.
  let started = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let openBarrier = () => {};
  const allStarted = new Promise((resolve) => { openBarrier = resolve; });

  const instrumentedStore = {
    async listChildren() {
      return listing;
    },
    async readLines(filePath) {
      started++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (started === writerNames.length) openBarrier();
      await allStarted;
      inFlight--;
      const name = filePath.split("/").pop();
      return fileContents[name] || [];
    },
  };

  const targetFiles = listing.entries.filter((file) => file.kind === "file" && file.name.endsWith(".jsonl"));

  // Stall guard: the FAILURE detector for a waterfall dispatch, bounding how long broken
  // dispatch may hang this tier. It is never the pass criterion — the barrier opens without it.
  let failStalled = () => {};
  const stalled = new Promise((_, reject) => {
    failStalled = () => reject(new Error(`only ${started}/${writerNames.length} reads dispatched — dispatch is a waterfall, reads are not parallel`));
  });
  const stallGuard = setTimeout(() => failStalled(), 5000);
  let loaded;
  try {
    loaded = await Promise.race([
      mapConcurrent(targetFiles, MAX_CONCURRENT_AUDIT_READS, async (file) => {
        const lines = await instrumentedStore.readLines(`v1/projects/atlas/.audit/${file.name}`);
        return { name: file.name, lines };
      }),
      stalled,
    ]);
  } finally {
    clearTimeout(stallGuard);
  }

  assert.equal(started, writerNames.length, "every writer file's read was dispatched");
  assert.equal(maxInFlight, writerNames.length, "all four reads were in flight simultaneously — dispatch is parallel, not a waterfall");
  // Full-content equality (voicebox-beads-kant): names, order AND every JSONL line. The previous
  // test deep-equalled complete loaded objects against an independently read sequential output;
  // a mutant that discards or corrupts entries (e.g. returns lines: []) must fail here, not pass.
  assert.deepEqual(
    loaded,
    writerNames.map((name) => ({ name, lines: fileContents[name] })),
    "the dispatch returns every writer's full JSONL lines in input order — dropped or wrong entries are a failure",
  );

  // Instrument honesty (deterministic negative control): the same in-flight counter driven by
  // a genuinely sequential loop reads exactly 1, so the parallel proof above is not vacuous.
  let seqInFlight = 0;
  let seqMax = 0;
  for (const file of targetFiles) {
    seqInFlight++;
    seqMax = Math.max(seqMax, seqInFlight);
    await Promise.resolve();
    seqInFlight--;
  }
  assert.equal(seqMax, 1, "a genuinely sequential loop shows max in-flight exactly 1");
});
