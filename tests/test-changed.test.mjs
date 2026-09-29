// tests/test-changed.test.mjs — verify scoped test runner for inner-loop development (voicebox-beads-p9bf)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapToTests, checkStaticRelevance, partitionTests, getBaseRef } from "../scripts/test-changed.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(root, "scripts/test-changed.mjs");

test("mapToTests: direct test file changes map directly to themselves", () => {
  const mapped = mapToTests(["tests/commands.test.mjs"]);
  assert.deepEqual(mapped, ["commands.test.mjs"]);
});

test("mapToTests: library changes map to tests referencing the module or stem", () => {
  const mapped = mapToTests(["lib/commands.mjs"]);
  assert.ok(mapped.includes("commands.test.mjs"), "must include commands.test.mjs");
  assert.ok(mapped.length >= 1, "must map to at least one test");
});

test("mapToTests: wasm-shelf changes map to wasm shelf tests", () => {
  const mapped = mapToTests(["lib/wasm-shelf.mjs"]);
  assert.ok(mapped.includes("wasm-shelf.test.mjs"), "must include wasm-shelf.test.mjs");
});

test("mapToTests: maps internal module dependencies transitively (voicebox-beads-p9bf F1)", () => {
  const mappedWasmWorker = mapToTests(["lib/wasm-worker.mjs"]);
  assert.ok(mappedWasmWorker.includes("wasm-shelf.test.mjs"), "wasm-worker must map to wasm-shelf.test.mjs");

  const mappedMiniApp = mapToTests(["core/mini-app.ts"]);
  assert.ok(mappedMiniApp.includes("mini-app-architecture.test.mjs") || mappedMiniApp.includes("mini-app-ui.test.mjs"), "core/mini-app.ts must map to mini-app tests");
});

test("CLI: unmapped source files refuse with unmapped-source-file and exit 1 (voicebox-beads-p9bf F1)", () => {
  const unmappedName = "unmapped_" + "source_module.mjs";
  const unmappedPath = path.join("lib", unmappedName);
  assert.equal(mapToTests([unmappedPath]).length, 0, "unmapped file must map to zero tests");

  const res = spawnSync(process.execPath, [SCRIPT, unmappedPath], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(res.status, 1, "must exit 1 on unmapped source file");
  assert.match(res.stderr, /\[test:changed\] REFUSED: unmapped-source-file/);
  assert.match(res.stderr, new RegExp(unmappedName));

  // Passing --allow-unmapped permits running despite unmapped source:
  const allowed = spawnSync(process.execPath, [SCRIPT, "--allow-unmapped", "--dry-run", unmappedPath], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /\[test:changed\] Detected 1 changed file\(s\):/);
});

test("checkStaticRelevance: flags state-dir changes for single-owner check", () => {
  const rel1 = checkStaticRelevance(["lib/state-dirs.mjs"]);
  assert.equal(rel1.singleOwner, true);
  assert.equal(rel1.docsCheck, false);

  const rel2 = checkStaticRelevance(["lib/commands.mjs"]);
  assert.equal(rel2.singleOwner, false);
  assert.equal(rel2.docsCheck, false);
});

test("checkStaticRelevance: flags markdown and docs changes for docs-check", () => {
  const rel = checkStaticRelevance(["README.md", "docs/07-architecture.md"]);
  assert.equal(rel.docsCheck, true);
  assert.equal(rel.docsTouched, true);
  assert.equal(rel.singleOwner, false);
});

test("partitionTests: partitions mapped tests into disjoint lanes", () => {
  const sampleTests = ["commands.test.mjs", "pre-push.test.mjs", "tasks-http.test.mjs"];
  const { unit, server, browser } = partitionTests(sampleTests);

  const all = [...unit, ...server, ...browser];
  assert.equal(new Set(all).size, all.length, "lanes must be disjoint");
  assert.ok(unit.includes("commands.test.mjs"), "commands.test.mjs is unit");
  assert.ok(browser.includes("pre-push.test.mjs"), "pre-push.test.mjs is browser");
});

test("CLI --dry-run: reports mapped tests and exits 0 without running suites", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--dry-run", "lib/commands.mjs"], {
    cwd: root, encoding: "utf8",
  });
  assert.match(out, /\[test:changed\] Detected 1 changed file\(s\):/);
  assert.match(out, /· lib\/commands\.mjs/);
  assert.match(out, /Mapped to \d+ test file\(s\) across lanes:/);
  assert.match(out, /commands\.test\.mjs/);
  assert.match(out, /--dry-run: skipping test execution\./);
});

test("CLI --json: outputs structured mapping payload", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--json", "lib/state-dirs.mjs"], {
    cwd: root, encoding: "utf8",
  });
  const data = JSON.parse(out);
  assert.deepEqual(data.changed, ["lib/state-dirs.mjs"]);
  assert.ok(data.tests.includes("single-owner.test.mjs"));
  assert.equal(data.static.singleOwner, true);
  assert.equal(data.static.docsCheck, false);
  assert.ok(Array.isArray(data.lanes.unit));
});

test("getBaseRef: resolves valid git base ref", () => {
  const base = getBaseRef();
  assert.ok(typeof base === "string" && base.length > 0);
});
