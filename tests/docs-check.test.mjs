// tests/docs-check.test.mjs — unit tests for automated component and route inventory generation (voicebox-beads-2pe6).

import test from "node:test";
import assert from "node:assert/strict";
import { moduleInventory, renderInventoryTable, probeLiveUpgrade, ProbeFailure } from "../scripts/docs-check.mjs";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_SCRIPT = path.join(ROOT, "scripts", "docs-check.mjs");

test("inventory extraction extracts all public/components and lib/routes modules with @summary", () => {
  const components = moduleInventory("public/components");
  assert.equal(components.missingSummary.length, 0, `all public/components must have @summary, missing: ${components.missingSummary.join(", ")}`);
  assert.ok(components.items.length >= 11, `expected >= 11 components, found ${components.items.length}`);
  for (const item of components.items) {
    assert.ok(item.path.startsWith("public/components/"), `path must start with prefix: ${item.path}`);
    assert.ok(item.summary && item.summary.length > 5, `summary must be a non-trivial string: ${item.path}`);
  }

  const routes = moduleInventory("lib/routes");
  assert.equal(routes.missingSummary.length, 0, `all lib/routes must have @summary, missing: ${routes.missingSummary.join(", ")}`);
  assert.ok(routes.items.length >= 12, `expected >= 12 routes, found ${routes.items.length}`);
  for (const item of routes.items) {
    assert.ok(item.path.startsWith("lib/routes/"), `path must start with prefix: ${item.path}`);
    assert.ok(item.summary && item.summary.length > 5, `summary must be a non-trivial string: ${item.path}`);
  }
});

test("alphabetized sorting: items and generated tables sort in strictly ascending order", () => {
  const components = moduleInventory("public/components").items;
  const paths = components.map((c) => c.path);
  const sorted = [...paths].sort();
  assert.deepEqual(paths, sorted, "components must be sorted in strictly ascending alphabetical order");

  const table = renderInventoryTable(components, "Component Module");
  const tableRows = table.split("\n").filter((l) => l.startsWith("| `"));
  const rowPaths = tableRows.map((r) => r.match(/`([^`]+)`/)[1]);
  assert.deepEqual(rowPaths, sorted, "table rows must follow strictly ascending alphabetical order");
});

test("comment marker preservation: uppercase and name-prefixed delimiters are preserved during replace", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "voicebox-markers-"));
  try {
    const docPath = path.join(tempDir, "test-doc.md");

    // Case 1: Uppercase delimiters
    const upperDoc = [
      "# Header",
      "<!-- BEGIN GENERATED COMPONENT INVENTORY -->",
      "old content",
      "<!-- END GENERATED COMPONENT INVENTORY -->",
      "tail",
    ].join("\n");
    writeFileSync(docPath, upperDoc);

    const { replaceBlock } = await import(CHECK_SCRIPT);
    const table = "| Module | Description |\n|---|---|\n| `foo.mjs` | Foo component. |";
    const resUpper = replaceBlock(readFileSync(docPath, "utf8"), "component-inventory", table);
    assert.ok(resUpper.found, "uppercase delimiter block must be found");
    assert.match(resUpper.text, /<!-- BEGIN GENERATED COMPONENT INVENTORY -->/, "opening uppercase marker must be preserved");
    assert.match(resUpper.text, /<!-- END GENERATED COMPONENT INVENTORY -->/, "closing uppercase marker must be preserved");
    assert.match(resUpper.text, /`foo\.mjs`/, "table content must be inserted between markers");

    // Case 2: Prefixed delimiters
    const prefixedDoc = [
      "# Header",
      "<!-- BEGIN GENERATED: component-inventory -->",
      "old content",
      "<!-- END GENERATED: component-inventory -->",
      "tail",
    ].join("\n");
    const resPrefixed = replaceBlock(prefixedDoc, "component-inventory", table);
    assert.ok(resPrefixed.found, "prefixed delimiter block must be found");
    assert.match(resPrefixed.text, /<!-- BEGIN GENERATED: component-inventory/, "prefixed opening marker must be matched");
    assert.match(resPrefixed.text, /<!-- END GENERATED: component-inventory -->/, "prefixed closing marker must be matched");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failure when a component lacks a @summary header: reports actionable error", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "voicebox-summary-fail-"));
  try {
    writeFileSync(path.join(tempDir, "valid.mjs"), "/**\n * @summary Valid component\n */\nexport const x = 1;\n");
    writeFileSync(path.join(tempDir, "invalid.mjs"), "// Just a plain comment without summary\nexport const y = 2;\n");

    const inv = moduleInventory(tempDir, "temp");
    assert.equal(inv.items.length, 1);
    assert.equal(inv.items[0].file, "valid.mjs");
    assert.equal(inv.missingSummary.length, 1);
    assert.equal(inv.missingSummary[0], path.join("temp", "invalid.mjs"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failure when a component has misplaced @summary tag not in top-of-file JSDoc header (Finding P2)", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "voicebox-misplaced-summary-"));
  try {
    writeFileSync(path.join(tempDir, "misplaced.mjs"), "export const a = 1;\n/**\n * @summary Misplaced summary.\n */\n");
    writeFileSync(path.join(tempDir, "line-comment.mjs"), "// @summary Line comment summary\nexport const b = 2;\n");

    const inv = moduleInventory(tempDir, "temp");
    assert.equal(inv.items.length, 0, "no modules with misplaced summaries should be accepted");
    assert.equal(inv.missingSummary.length, 2, "both files with misplaced summaries must be flagged");
    assert.ok(inv.missingSummary.includes(path.join("temp", "misplaced.mjs")));
    assert.ok(inv.missingSummary.includes(path.join("temp", "line-comment.mjs")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ═══════════ a probe that cannot measure is not a document that drifted (voicebox-beads-97cx) ═══════════
// The two failures need opposite fixes ("the docs are stale, run --write" vs "the check could not see the
// tree"), so the probe must REJECT rather than resolving a plausible-looking line that the document then
// states as fact. Driven against a real socket, because the bug was in what the socket answered.
test("the /live upgrade probe REJECTS as a probe failure when nothing answers, instead of resolving a line the document would state as fact (voicebox-beads-97cx)", async () => {
  const silent = http.createServer(() => { /* accept the socket, never answer: the settle branch */ });
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = silent.address();
    await assert.rejects(
      () => probeLiveUpgrade(port),
      (e) => {
        assert.ok(e instanceof ProbeFailure, `must be a ProbeFailure, not a document-drift refusal: ${e?.constructor?.name}: ${e?.message}`);
        assert.match(e.message, /DID NOT SETTLE/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => silent.close(resolve));
  }
});

test("the /live upgrade probe still MEASURES a server that answers, so a real answer is not turned into a probe failure (voicebox-beads-97cx)", async () => {
  const answering = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not an upgrade");
  });
  await new Promise((resolve) => answering.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = answering.address();
    const line = await probeLiveUpgrade(port);
    assert.equal(typeof line, "string");
    assert.match(line, /GOT HTTP 200/, "a measured non-upgrade answer is a fact about the route, not a probe failure");
  } finally {
    await new Promise((resolve) => answering.close(resolve));
  }
});

test("the /live upgrade probe REJECTS when nothing is listening, and still MEASURES a server that accepts then destroys the socket (voicebox-beads-umml)", async () => {
  // Nothing listening: a closed port must not resolve "the server destroys it" — the probe never reached a
  // server, and that sentence becomes a documented fact about the route when it does.
  const closed = http.createServer(() => {});
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    () => probeLiveUpgrade(deadPort),
    (e) => {
      assert.ok(e instanceof ProbeFailure, `a refused connection must be a ProbeFailure: ${e?.constructor?.name}: ${e?.message}`);
      assert.match(e.message, /COULD NOT CONNECT \(ECONNREFUSED\)/);
      return true;
    },
  );

  // A server that ACCEPTS and then destroys the socket is a real measurement: established, then closed.
  const destroying = http.createServer(() => {});
  destroying.on("connection", (socket) => socket.destroy());
  await new Promise((resolve) => destroying.listen(0, "127.0.0.1", resolve));
  try {
    const line = await probeLiveUpgrade(destroying.address().port);
    assert.equal(typeof line, "string");
    assert.match(line, /CLOSED WITHOUT AN HTTP RESPONSE/, "an accepted-then-destroyed socket is the measurement this line exists for");
  } finally {
    await new Promise((resolve) => destroying.close(resolve));
  }
});
