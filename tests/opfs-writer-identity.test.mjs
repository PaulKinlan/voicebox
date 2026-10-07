// tests/opfs-writer-identity.test.mjs — voicebox-beads-826z: two realms must never share one
// audit writer file.
//
// Measured before the fix (reviewer's repro): two realms defaulted to the same 'phone' instance,
// wrote <root>/.audit/phone-<hash>.jsonl from both sides, and a burst of 6 existing lines + 20
// reads per realm came back 27 physical lines — 19 lost, with torn lines in the merged read. The
// audit design is one file per (root, writer); the fix gives every realm its own writer identity
// (browser/ui/ui.ts passes a per-tab id in the worker URL; browser/worker.ts adopts it). These
// tests pin: distinct identities lose nothing across a concurrent cross-realm burst; the default
// param-less workers DO share a file (the documented residual hazard, and the negative control);
// and the page's own worker runs under the sessionStorage-backed per-tab identity.
//
//   node --test tests/opfs-writer-identity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

let server;
test.before(async () => { server = await startServer({ env: { VOICEBOX_INSTANCE: "opfs-writer-identity" } }); });
test.after(async () => { await server?.stop?.(); });

async function withPage(t, fn, args = []) {
  const page = await launch();
  try {
    await page.goto(`${server.base}/environment.html`);
    await page.waitFor(() => window.e1m0 !== undefined, { label: "e1m0" });
    return await page.evaluate(fn, ...args);
  } finally {
    await page.close().catch(() => {});
  }
}

// A second realm: a worker constructed the way browser/ui/ui.ts constructs it (identity in the
// URL) or without it (the hazard shape). Returns a send() bound to that worker.
const spawnRealm = (instance) => {
  const url = instance ? `/browser/worker.ts?instance=${encodeURIComponent(instance)}` : "/browser/worker.ts";
  const worker = new Worker(url, { type: "module" });
  const waiters = new Map();
  worker.onmessage = (event) => {
    const data = event.data;
    if (data && data.id && waiters.has(data.id)) { waiters.get(data.id)(data); waiters.delete(data.id); }
  };
  let next = 1;
  return (message) => new Promise((resolve) => {
    const id = next++;
    waiters.set(id, resolve);
    worker.postMessage({ ...message, id });
  });
};

test("two realms with distinct identities lose nothing in a cross-realm burst", async (t) => {
  const result = await withPage(t, async (spawnSource) => {
    const spawnRealm = eval(`(${spawnSource})`);
    const a = spawnRealm("tab-alpha");
    const b = spawnRealm("tab-beta");
    await a({ type: "openProject", name: "twotab" });
    await b({ type: "openProject", name: "twotab" });
    await a({ type: "createAsset", args: { name: "seed.txt", kind: "text", body: "seed" } });

    // The merged view interleaves files by (instance, seq), so the burst is not a tail SLICE —
    // count per instance before and after, and take the delta.
    const countByInstance = (entries) => {
      const counts = {};
      for (const e of entries) counts[e.instance] = (counts[e.instance] ?? 0) + 1;
      return counts;
    };
    const beforeCounts = countByInstance((await a({ type: "auditAll" })).merged);
    // The two-tab burst: 20 reads per realm, fully concurrent across realms.
    await Promise.all([
      ...Array.from({ length: 20 }, () => a({ type: "readFile", path: "assets/seed.txt" })),
      ...Array.from({ length: 20 }, () => b({ type: "readFile", path: "assets/seed.txt" })),
    ]);
    const afterCounts = countByInstance((await a({ type: "auditAll" })).merged);
    const byInstance = {};
    for (const key of new Set([...Object.keys(beforeCounts), ...Object.keys(afterCounts)])) {
      byInstance[key] = (afterCounts[key] ?? 0) - (beforeCounts[key] ?? 0);
    }
    const added = Object.values(byInstance).reduce((sum, n) => sum + n, 0);

    // The durable truth is the FILES: one per realm, every burst line present, none torn.
    const { opfsStorage } = await import("/browser/storage.ts");
    const storage = await opfsStorage("v1/projects/twotab");
    const names = (await storage.listChildren("v1/projects/twotab/.audit", 100)).entries.map((e) => e.name);
    const files = {};
    for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
      files[name] = await storage.readLines(`v1/projects/twotab/.audit/${name}`);
    }
    return { added, byInstance, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])) };
  }, [spawnRealm.toString()]);

  t.diagnostic(`byInstance: ${JSON.stringify(result.byInstance)} files: ${JSON.stringify(result.files)}`);
  assert.equal(result.added, 40, `cross-realm burst lost entries: ${result.added}/40 (byInstance: ${JSON.stringify(result.byInstance)})`);
  assert.equal(result.byInstance["tab-alpha"], 20, "realm alpha's entries are not all under its own identity");
  assert.equal(result.byInstance["tab-beta"], 20, "realm beta's entries are not all under its own identity");
  const fileNames = Object.keys(result.files);
  assert.ok(fileNames.some((n) => n.startsWith("tab-alpha-")), `no alpha writer file: ${fileNames}`);
  assert.ok(fileNames.some((n) => n.startsWith("tab-beta-")), `no beta writer file: ${fileNames}`);
});

test("two param-less workers still share the default file (negative control: the hazard shape)", async (t) => {
  const result = await withPage(t, async (spawnSource) => {
    const spawnRealm = eval(`(${spawnSource})`);
    const a = spawnRealm(null); // no identity — the pre-fix default
    const b = spawnRealm(null);
    await a({ type: "openProject", name: "shareddefault" });
    await b({ type: "openProject", name: "shareddefault" });
    await a({ type: "createAsset", args: { name: "seed.txt", kind: "text", body: "seed" } });
    await Promise.all([
      ...Array.from({ length: 20 }, () => a({ type: "readFile", path: "assets/seed.txt" })),
      ...Array.from({ length: 20 }, () => b({ type: "readFile", path: "assets/seed.txt" })),
    ]);
    const { opfsStorage } = await import("/browser/storage.ts");
    const storage = await opfsStorage("v1/projects/shareddefault");
    const names = (await storage.listChildren("v1/projects/shareddefault/.audit", 100)).entries.map((e) => e.name);
    const jsonl = names.filter((n) => n.endsWith(".jsonl"));
    let present = 0;
    for (const n of jsonl) present += (await storage.readLines(`v1/projects/shareddefault/.audit/${n}`)).length;
    return { files: jsonl, present };
  }, [spawnRealm.toString()]);

  // The deterministic hazard: ONE file for two writers (the fix's first test asserts the opposite).
  assert.equal(result.files.length, 1, `param-less workers must share one file (the hazard), got: ${result.files}`);
  assert.ok(result.files[0].startsWith("phone-"), `the shared file is the M0 default writer: ${result.files[0]}`);
  t.diagnostic(`hazard burst: ${result.present} physical lines (loss is timing-dependent; the shared file is the assertion)`);
});

test("a REJECTING lock request degrades to a nonce identity instead of hanging the page", async (t) => {
  // The reviewer's finding: a rejection (spec: a not-fully-active document) used to be
  // indistinguishable from "taken", so the suffix loop never terminated and its settled-promise
  // microtasks starved the renderer — a hung tab. The platform state is narrow, so this pins it.
  const page = await launch();
  try {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      Object.defineProperty(Navigator.prototype, "locks", { get() { return { request: () => Promise.reject(new DOMException("not fully active", "InvalidStateError")) }; } });
    ` });
    await page.goto(`${server.base}/environment.html`);
    await page.waitFor(() => window.e1m0 !== undefined, { label: "e1m0 under rejecting locks", timeout: 10000 });
    const result = await page.evaluate(async () => {
      await window.e1m0.ready;
      await window.e1m0.send({ type: "openProject", name: "rejectcase" });
      await window.e1m0.create("a.txt", "text", "x");
      const entries = (await window.e1m0.send({ type: "audit" })).entries;
      return { readyState: document.readyState, instance: entries[0]?.instance };
    });
    assert.equal(result.readyState, "complete", "the page did not finish loading under rejecting locks");
    assert.match(result.instance ?? "", /^tab-[0-9a-f]{8}-[0-9a-f]{4}$/, `no nonce fallback identity: ${result.instance}`);
  } finally {
    await page.close().catch(() => {});
  }
});

test("the page's own worker runs under the per-tab sessionStorage identity", async (t) => {
  const result = await withPage(t, async () => {
    const lineage = sessionStorage.getItem("voicebox-instance");
    await window.e1m0.ready;
    await window.e1m0.send({ type: "openProject", name: "pageidentity" });
    await window.e1m0.create("mine.txt", "text", "by the page");
    const entries = (await window.e1m0.send({ type: "audit" })).entries;
    return { lineage, instances: [...new Set(entries.map((e) => e.instance))] };
  });
  assert.ok(result.lineage, "the page has no tab lineage in sessionStorage");
  assert.equal(result.instances.length, 1, `the page worker's entries carry mixed identities: ${JSON.stringify(result.instances)}`);
  assert.equal(result.instances[0], `tab-${result.lineage}`, `the page worker's identity ${result.instances[0]} is not its claimed tab lineage ${result.lineage}`);
});

test("a window.open'd duplicate tab inherits the lineage but NEVER the writer identity", async (t) => {
  const page = await launch();
  let result;
  try {
    await page.goto(`${server.base}/environment.html`);
    await page.waitFor(() => window.e1m0 !== undefined, { label: "e1m0" });
    // evaluateWithGesture: a gesture-less window.open is popup-blocked in headless Chrome.
    result = await page.evaluateWithGesture(async () => {
    await window.e1m0.ready;
    await window.e1m0.send({ type: "openProject", name: "clonetab" });
    await window.e1m0.create("seed.txt", "text", "seed");
    const mainLineage = sessionStorage.getItem("voicebox-instance");
    const mainEntries = (await window.e1m0.send({ type: "audit" })).entries;
    const mainInstance = mainEntries[0]?.instance;

    // The clone: window.open COPIES this tab's sessionStorage into the new tab — the hazard
    // precondition. Assert the copy really happened, then that the writer identities differ.
    const popup = window.open("/environment.html", "_blank");
    try {
      for (let i = 0; i < 100 && !(popup.e1m0 && popup.sessionStorage.getItem("voicebox-instance")); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const cloneLineage = popup.sessionStorage.getItem("voicebox-instance");
      await popup.e1m0.ready;
      await popup.e1m0.send({ type: "openProject", name: "clonetab" });
      await popup.e1m0.create("via-clone.txt", "text", "from the clone");
      const cloneInstance = (await popup.e1m0.send({ type: "audit" })).entries[0]?.instance;

      // The cross-tab burst through the REAL page workers: 10 reads each, fully concurrent.
      await Promise.all([
        ...Array.from({ length: 10 }, () => window.e1m0.send({ type: "readFile", path: "seed.txt" })),
        ...Array.from({ length: 10 }, () => popup.e1m0.send({ type: "readFile", path: "via-clone.txt" })),
      ]);
      const merged = (await window.e1m0.send({ type: "auditAll" })).merged;
      const reads = merged.filter((e) => e.act?.kind === "read");
      const byInstance = {};
      for (const e of reads) byInstance[e.instance] = (byInstance[e.instance] ?? 0) + 1;
      return { mainLineage, cloneLineage, mainInstance, cloneInstance, byInstance };
    } finally {
      popup.close();
    }
    });
  } finally {
    await page.close().catch(() => {});
  }
  assert.equal(result.cloneLineage, result.mainLineage, "the clone did not inherit the lineage — the hazard precondition itself did not happen");
  assert.ok(result.mainInstance && result.cloneInstance, `a realm has no identity: ${JSON.stringify(result)}`);
  assert.equal(result.mainInstance, `tab-${result.mainLineage}`, `the main tab did not claim the base identity: ${result.mainInstance}`);
  assert.ok(result.cloneInstance.startsWith(`tab-${result.mainLineage}-`), `the clone did not take a suffixed identity: ${result.cloneInstance}`);
  assert.equal(result.byInstance[result.mainInstance] ?? 0, 10, `the main tab's reads: ${JSON.stringify(result.byInstance)}`);
  assert.equal(result.byInstance[result.cloneInstance] ?? 0, 10, `the clone's reads: ${JSON.stringify(result.byInstance)}`);
});
