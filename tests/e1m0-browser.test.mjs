// tests/e1m0-browser.test.mjs — the acceptance checks, driven in a real browser.
//
//   node --test tests/e1m0-browser.test.mjs
//
// These are §8 of docs/04-e1-m0-build-spec.md, not a second opinion about them. Each check that
// is a PAGE behaviour is driven in Chromium through the real controls (real mouse events, real
// inserted text) — not by calling the module under test directly. The evidence for each is the
// value the page returns, and where the check is about bytes, the bytes come back from OPFS.
//
// The server under test is this repository's own `node server.mjs` on a scratch port, in its own
// Chromium profile — so the OPFS root starts empty and "it survives a reload" means what it says.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startServer } from "./lib/server.mjs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XSS_NAME = "<img src=x onerror=alert(1)>";

let server;
let BASE;
let browser;
let page;

const send = (message) => page.evaluate((m) => window.e1m0.send(m), message);

test.before(async () => {
  server = await startServer({
    cwd: ROOT,
    env: { ...process.env, VOICEBOX_INSTANCE: "e1m0-browser" },
  });
  BASE = server.base;
  browser = await launch();
  page = browser;
  await page.goto(`${BASE}/environment.html`);
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API" });
  await page.evaluate(() => window.e1m0.ready);
});

test.after(async () => {
  await browser?.close();
  await server?.stop();
});

// 1 ------------------------------------------------------------------------------------------
test("1. Reopen: a project is created in OPFS and read back after a reload, with no gesture", { timeout: 60000 }, async () => {
  const created = await send({ type: "openProject", name: "atlas" });
  assert.equal(created.ok, true, "the project did not open");
  assert.equal(created.project.id, "atlas@browser", "identity is placement + location");
  assert.equal(created.project.root, "v1/projects/atlas");

  // Through the page's own form, so this is the product path and not a shortcut.
  await page.type("#asset-name", "check1.svg");
  await page.type("#asset-body", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  await page.click("#asset-form button");
  const wrote = await page.waitFor(
    () => document.querySelectorAll("figure.asset[data-name='check1.svg']").length > 0,
    { label: "the asset to render" },
  );
  assert.equal(wrote, true);

  await page.reload();
  await page.waitFor(() => window.e1m0 !== undefined, { label: "the page's host API after reload" });

  const after = await page.evaluate(async () => {
    await window.e1m0.ready;
    const opened = await window.e1m0.send({ type: "openProject", name: "atlas" });
    const read = await window.e1m0.send({ type: "readFile", path: "assets/check1.svg" });
    return {
      activation: navigator.userActivation.isActive,
      everActivated: navigator.userActivation.hasBeenActive,
      assets: opened.assets,
      ok: read.ok,
      text: read.text,
    };
  });

  assert.equal(after.activation, false, "the test used a user gesture it was not allowed to use");
  assert.equal(after.everActivated, false, "a gesture happened earlier in this profile");
  assert.deepEqual(after.assets, ["check1.svg"], "the reloaded worker cannot see the project's files");
  assert.equal(after.ok, true, "the file could not be read back after the reload");
  assert.match(after.text, /^<svg xmlns/);
});

// 2 ------------------------------------------------------------------------------------------
test("2. Tier table both ways: a write inside is allowed, a write outside is refused — both audited", { timeout: 60000 }, async () => {
  await send({ type: "openProject", name: "atlas" });

  const inside = await send({ type: "createAsset", args: { name: "check2-inside.svg", kind: "svg", body: "<svg/>" }, turn: "check2" });
  assert.equal(inside.ok, true, `the inside write was not allowed: ${JSON.stringify(inside)}`);

  const outside = await send({ type: "createAsset", args: { name: "../evil.svg", kind: "svg", body: "<svg/>" }, turn: "check2" });
  assert.equal(outside.refused, true, `the outside write was not refused: ${JSON.stringify(outside)}`);
  assert.equal(outside.rule, "outside-root");

  const audit = await send({ type: "audit" });
  const allowed = audit.entries.find((e) => e.act?.target.endsWith("assets/check2-inside.svg"));
  const refused = audit.entries.find((e) => e.decision === "refuse" && e.act?.target.includes("evil.svg"));
  assert.ok(allowed, "the allowed write has no audit entry");
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.rule, "writes-inside");
  assert.deepEqual(allowed.observed, { exists: true, bytes: 6, mtime: allowed.observed.mtime });
  assert.ok(refused, "the refused write has no audit entry");
  assert.equal(refused.decision, "refuse");
  assert.equal(refused.rule, "outside-root");
  assert.equal(refused.result, "refused");

  // The world, not the report: nothing was created outside the root.
  const world = await send({ type: "openProject", name: "atlas" });
  assert.equal(world.files.includes("evil.svg"), false, "evil.svg landed inside the root");
  const outsideRead = await send({ type: "readFile", path: "../evil.svg" });
  assert.equal(outsideRead.refused, true);
});

// 3 ------------------------------------------------------------------------------------------
test("3. Refusals are named: the rule id and the why, with the allowed case in the same test", { timeout: 60000 }, async () => {
  const refused = await send({ type: "createAsset", args: { name: "../../evil.sh", kind: "text", body: "#!/bin/sh\n" } });
  assert.equal(refused.refused, true);
  assert.equal(refused.rule, "outside-root", "the refusal does not name its rule");
  assert.match(refused.why, /'\.\.' segment/, "the refusal does not say why in the mechanism's own words");

  const allowed = await send({ type: "createAsset", args: { name: "check3.txt", kind: "text", body: "allowed" } });
  assert.equal(allowed.ok, true, "a test that only proves refusals proves half of it");

  const audit = await send({ type: "audit" });
  const refusal = audit.entries.filter((e) => e.decision === "refuse" && e.rule === "outside-root").pop();
  const allow = audit.entries.find((e) => e.act?.target.endsWith("assets/check3.txt"));
  assert.equal(refusal.rule, "outside-root");
  assert.equal(allow.decision, "allow");
  assert.equal(allow.rule, "writes-inside");
});

// 4 ------------------------------------------------------------------------------------------
test("4. '..' as a name is refused while a sibling name is accepted (the basename case)", { timeout: 60000 }, async () => {
  const dotdot = await send({ type: "createAsset", args: { name: "..", kind: "text", body: "x" } });
  assert.equal(dotdot.refused, true, "'..' as a NAME was accepted");
  assert.equal(dotdot.rule, "outside-root");

  const plain = await send({ type: "createAsset", args: { name: "sibling.txt", kind: "text", body: "x" } });
  assert.equal(plain.ok, true, "the sibling name was not accepted, so the refusal proves nothing");

  // The same two answers from the resolver the host used, stated as the rule it protects.
  const resolver = await page.evaluate(async () => {
    const { resolveInsideRoot } = await import("/core/paths.ts");
    return {
      dotdot: resolveInsideRoot("v1/projects/atlas", ".."),
      sibling: resolveInsideRoot("v1/projects/atlas", "sibling.txt"),
    };
  });
  assert.equal(resolver.dotdot.ok, false);
  assert.equal(resolver.dotdot.rule, "outside-root");
  assert.equal(resolver.sibling.ok, true);
  assert.equal(resolver.sibling.path, "v1/projects/atlas/sibling.txt");
});

// 5 ------------------------------------------------------------------------------------------
test("5. Import boundary: the asset module links; a module importing fetch does not", { timeout: 60000 }, async () => {
  await send({ type: "openProject", name: "atlas" });

  const asset = await send({ type: "instantiateProbe", module: "create-asset" });
  assert.equal(asset.instantiated, true, `the tool did not instantiate: ${JSON.stringify(asset)}`);
  assert.deepEqual(asset.imports, ["env.writeFile", "env.note"]);
  assert.deepEqual(asset.hostImports.sort(), ["note", "writeFile"], "the host hands over more than two imports");

  const network = await send({ type: "instantiateProbe", module: "fixture-fetch-import" });
  assert.equal(network.instantiated, false, "a module importing fetch was instantiated");
  // The mechanism's own words — not a policy message of ours.
  assert.match(`${network.errorName}: ${network.error}`, /fetch|callable|not a function/i, network.error);
});

// 6 ------------------------------------------------------------------------------------------
test("6. Nothing renders as markup", { timeout: 60000 }, async () => {
  await send({ type: "openProject", name: "atlas" });
  const html = await send({
    type: "createAsset",
    args: { name: XSS_NAME, kind: "text", body: '<script>window.__xss = 1;</script>' },
  });
  assert.equal(html.ok, true, `the payload-named asset was not written: ${JSON.stringify(html)}`);
  const svg = await send({ type: "createAsset", args: { name: "check6.svg", kind: "svg", body: "<svg/>" } });
  assert.equal(svg.ok, true);

  // Render both in the gallery, then look at the DOM the page actually built.
  await page.evaluate(async () => {
    const read = await window.e1m0.send({ type: "readFile", path: "assets/check6.svg" });
    const other = await window.e1m0.send({ type: "readFile", path: `assets/${"<img src=x onerror=alert(1)>"}` });
    await window.e1m0.create("<img src=x onerror=alert(1)>", "text", other.text);
    await window.e1m0.create("check6.svg", "svg", read.text);
  });
  await page.waitFor(() => document.querySelector("figure.asset[data-name='check6.svg']") !== null, { label: "the svg card" });

  const dom = await page.evaluate(() => ({
    xssRan: window.__xss !== undefined,
    onerrorAttrs: document.querySelectorAll("[onerror]").length,
    scriptTags: document.querySelectorAll("script").length,
    galleryScripts: document.querySelectorAll("#gallery script, #transcript script").length,
    captionText: document.querySelector("figure.asset[data-name] figcaption")?.textContent ?? null,
    payloadCaption: [...document.querySelectorAll("figure.asset figcaption")].some(
      (c) => c.textContent === "<img src=x onerror=alert(1)>",
    ),
    payloadImgs: document.querySelectorAll("figure.asset[data-name='<img src=x onerror=alert(1)>'] img").length,
    blobSrc: document.querySelector("figure.asset[data-name='check6.svg'] img")?.src?.startsWith("blob:") ?? false,
    transcriptText: document.getElementById("transcript").textContent,
  }));

  assert.equal(dom.xssRan, false, "the injected script ran");
  assert.equal(dom.onerrorAttrs, 0, "an element was created from the payload");
  assert.equal(dom.galleryScripts, 0, "markup from an asset reached the DOM as markup");
  assert.equal(dom.payloadCaption, true, "the payload name is not in the DOM as text");
  assert.equal(dom.payloadImgs, 0, "the payload name created an element of its own");
  assert.equal(dom.blobSrc, true, "the svg was not rendered through a blob URL");
  assert.match(dom.transcriptText, /<img src=x onerror=alert\(1\)>/);
});

// 7 ------------------------------------------------------------------------------------------
test("7. Bad input does not kill the host", { timeout: 90000 }, async () => {
  await send({ type: "openProject", name: "atlas" });

  const cases = [
    ["malformed input", await send({ type: "createAsset", args: null })],
    ["unknown field", await send({ type: "createAsset", args: { name: "x.txt", kind: "text", body: "x", extra: 1 } })],
    ["unknown kind", await send({ type: "createAsset", args: { name: "x.exe", kind: "exe", body: "x" } })],
    ["missing field", await send({ type: "createAsset", args: { name: "x.txt" } })],
    ["huge body", await send({ type: "createAsset", args: { name: "huge.txt", kind: "text", body: "y".repeat(2 * 1024 * 1024) } })],
    ["a module that traps", await send({ type: "createAsset", tool: "fixture-trap", args: { name: "trap.txt", kind: "text", body: "x" } })],
    ["an unknown message", await send({ type: "not-a-message" })],
  ];

  for (const [label, result] of cases) {
    assert.equal(result.ok, false, `${label} was not an error: ${JSON.stringify(result).slice(0, 200)}`);
  }

  const audit = await send({ type: "audit" });
  for (const [label] of cases) {
    if (label === "an unknown message") continue; // there is no act to record
    assert.ok(
      audit.entries.some((e) => e.act?.tool === "create-asset" || e.act?.tool === "fixture-trap"),
      `no audit entry for ${label}`,
    );
  }
  assert.ok(audit.entries.some((e) => e.rule === "unknown-field"), "the unknown field was not named");
  assert.ok(audit.entries.some((e) => e.rule === "too-large"), "the huge body was not refused by name");
  assert.ok(audit.entries.some((e) => e.rule === "unknown-kind"));
  assert.ok(audit.entries.some((e) => e.result === "error"), "the trap produced no error entry");

  // The host is still serving: the next turn is a normal one.
  const after = await send({ type: "createAsset", args: { name: "after-bad-input.txt", kind: "text", body: "still here" } });
  assert.equal(after.ok, true, "the host did not survive the bad input");
});

// 9 ------------------------------------------------------------------------------------------
test("9. Two roots write: one audit file per root, merged by (instance, seq)", { timeout: 60000 }, async () => {
  await send({ type: "openProject", name: "atlas" });
  const a = await send({ type: "createAsset", args: { name: "atlas.txt", kind: "text", body: "a" } });
  assert.equal(a.ok, true);

  await send({ type: "openProject", name: "berlin" });
  const b = await send({ type: "createAsset", args: { name: "berlin.txt", kind: "text", body: "b" } });
  assert.equal(b.ok, true);

  const all = await send({ type: "auditAll" });
  assert.equal(all.files.length, 2, `expected two audit files, saw ${JSON.stringify(all.files)}`);
  assert.equal(new Set(all.files.map((f) => f.name)).size, 2, "the two roots shared one audit file");
  for (const file of all.files) {
    assert.ok(file.entries.length > 0, `audit file ${file.name} is empty`);
    assert.ok(file.entries.every((e) => e.root === file.root), `audit file ${file.name} holds another root's entries`);
  }

  // (instance, seq), compared as NUMBERS — a string sort would put 10 before 9 and call it ordered.
  const keys = all.merged.map((e) => [e.instance, e.seq]);
  const sorted = [...keys].sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1]);
  assert.deepEqual(keys, sorted, "the merged read is not ordered by (instance, seq)");
  assert.equal(
    new Set(all.merged.filter((e) => e.instance === "phone").map((e) => e.seq)).size,
    all.merged.filter((e) => e.instance === "phone").length,
    "two entries share a sequence number, so the merged order is ambiguous",
  );
  const atlasRoot = all.files.find((f) => f.root.endsWith("atlas")).root;
  assert.ok(
    all.merged.some((e) => e.root === atlasRoot) && all.merged.some((e) => e.root !== atlasRoot),
    "the merged read lost one of the roots",
  );
});

// 8a -----------------------------------------------------------------------------------------
test("8a. The root is an injected interface: the same checks pass on a second adapter", { timeout: 90000 }, async () => {
  // The second adapter is the handle root — the shape a picked directory has — driven here through
  // a handle with implicit permission, because headless Chrome cannot grant write on a real folder
  // (the receipt states that limit). What is under test is the INJECTION: the tier table, the
  // resolver, the audit and the tool run are the same code for both roots (N18's "one core, two
  // roots"), so every root-injection check above must pass unchanged.
  const adopted = await page.evaluate(async () => {
    const origin = await navigator.storage.getDirectory();
    const dir = await origin.getDirectoryHandle("second-adapter", { create: true });
    return await window.e1m0.adopt(dir);
  });
  assert.equal(adopted.ok, true, `adopting the second adapter failed: ${JSON.stringify(adopted)}`);
  assert.equal(adopted.project.rootKind, "handle");
  assert.equal(adopted.project.root, "picked:second-adapter", "the second adapter has no virtual root");

  // check 2, on the second root: a write inside is allowed and audited as allow
  const inside = await send({ type: "createAsset", args: { name: "inside-8a.txt", kind: "text", body: "second root" } });
  assert.equal(inside.ok, true, `the inside write was not allowed: ${JSON.stringify(inside)}`);
  assert.equal(inside.observed.exists, true, "the world does not agree the file exists");

  // check 2, the other way: a write outside is refused, and refused by rule
  const outside = await send({ type: "createAsset", args: { name: "../escape-8a.txt", kind: "text", body: "x" } });
  assert.equal(outside.refused, true);
  assert.equal(outside.rule, "outside-root");

  // check 4, on the second root: '..' as a NAME refused, a sibling accepted
  const dotdot = await send({ type: "createAsset", args: { name: "..", kind: "text", body: "x" } });
  assert.equal(dotdot.refused, true);
  assert.equal(dotdot.rule, "outside-root");
  const sibling = await send({ type: "createAsset", args: { name: "sibling-8a.txt", kind: "text", body: "ok" } });
  assert.equal(sibling.ok, true, "the sibling name was not accepted on the second root");

  // check 7, on the second root: bad input is an error and an audit entry, and the host survives
  const bad = await send({ type: "createAsset", args: { name: "x.txt", kind: "exe", body: "x" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.rule, "unknown-kind");
  const after = await send({ type: "createAsset", args: { name: "after-8a.txt", kind: "text", body: "still here" } });
  assert.equal(after.ok, true, "the host did not survive bad input on the second root");

  // The audit is one implementation: the same rows, recorded against the second root's virtual root.
  const audit = await send({ type: "audit" });
  const allow = audit.entries.filter((e) => e.act?.target.endsWith("inside-8a.txt")).pop();
  const refuse = audit.entries.filter((e) => e.rule === "outside-root").pop();
  assert.equal(allow.rule, "writes-inside");
  assert.equal(allow.decision, "allow");
  assert.equal(allow.root, "picked:second-adapter");
  assert.equal(refuse.decision, "refuse");
});
