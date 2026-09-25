import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverHarnesses } from "../lib/harness-inventory.mjs";
import { ACP_AGENT } from "../lib/acp-client.mjs";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vb-harnesses-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adapter = path.join(dir, "adapter");
  mkdirSync(adapter);
  mkdirSync(path.join(adapter, "dist"));
  writeFileSync(path.join(adapter, "package.json"), JSON.stringify({ name: "pi-acp", version: ACP_AGENT.version }));
  writeFileSync(path.join(adapter, "dist", "index.js"), "// adapter entry\n");
  const command = (name, body, mode = 0o700) => writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode });
  command("pi", `test "$1" = "--version" || exit 3; echo ${ACP_AGENT.piVersion}`);
  command("claude", "exit 7");
  command("codex", "echo ignored", 0o600);
  command("gemini", "echo private-output-must-not-leak");
  command("opencode", `(/bin/sleep 1; echo escaped > '${path.join(dir, "escaped")}') & wait`);
  return { env: { PATH: dir, VOICEBOX_ACP_ADAPTER: adapter, VOICEBOX_HARNESS_TOOLS: "" }, command, dir };
}

test("host inventory separates version-only presence, broken installs, unknown identity and absence", async (t) => {
  const { env, dir } = fixture(t);
  const before = Date.now();
  const report = await discoverHarnesses({ env, timeoutMs: 500 });
  assert.ok(Date.now() - before < 5000);
  assert.equal(report.entries.length, 7);
  const rows = Object.fromEntries(report.entries.map((r) => [r.id, r]));
  assert.equal(rows.pi.state, "present");
  assert.equal(rows.pi.version, ACP_AGENT.piVersion);
  assert.equal(rows.pi.toolCatalogue.status, "unknown");
  assert.equal(Object.hasOwn(rows.pi.toolCatalogue, "tools"), false);
  assert.equal(rows.pi.delegation.ok, true);
  assert.match(rows.pi.delegation.mechanism, /stdio-acp-client/);
  assert.equal(rows.claude.state, "unrunnable");
  assert.match(rows.claude.why, /exit 7/);
  assert.equal(rows.codex.state, "unrunnable");
  assert.equal(rows.gemini.state, "unknown");
  assert.equal(rows.opencode.state, "unrunnable");
  assert.match(rows.opencode.why, /exceeded 500ms/);
  assert.equal(rows.aider.state, "absent");
  assert.equal(rows["pi-acp"].version, ACP_AGENT.version);
  assert.equal(rows["pi-acp"].state, "unknown");
  assert.ok(!JSON.stringify(report).includes("private-output"));
  assert.ok(!JSON.stringify(report).includes(env.PATH));
  await delay(1200);
  assert.equal(existsSync(path.join(dir, "escaped")), false, "version-check descendants must be killed too");
});

test("no guessed identity, project PATH lookup, or fallback for a broken configured Pi", async (t) => {
  const { env, dir, command } = fixture(t);
  const report = await discoverHarnesses({ env: { ...env, PATH: ".:", VOICEBOX_ACP_PI: path.join(dir, "missing"), VOICEBOX_ACP_ADAPTER: dir }, timeoutMs: 500 });
  assert.equal(report.entries.find((r) => r.id === "pi").state, "unrunnable");
  assert.equal(report.entries.find((r) => r.id === "claude").state, "absent");
  assert.equal(report.entries.find((r) => r.id === "pi-acp").state, "absent");
  writeFileSync(path.join(dir, "package.json"), '{"name":"other","version":"1.2.3"}');
  const unknown = await discoverHarnesses({ env: { ...env, PATH: "", VOICEBOX_ACP_ADAPTER: dir } });
  assert.equal(unknown.entries.find((r) => r.id === "pi-acp").state, "unknown");
  command("aider", "printf '%09000d' 1");
  const oversized = await discoverHarnesses({ env, timeoutMs: 100 });
  assert.equal(oversized.entries.find((r) => r.id === "aider").state, "unrunnable");
  await assert.rejects(discoverHarnesses({ timeoutMs: Infinity }));
});

test("CLI displays the same declared tools and unknowns without enabling delegation", (t) => {
  const { env, command, dir } = fixture(t);
  command("opencode", "exit 2");
  const file = path.join(dir, "tools.json");
  const pi = { source: "Operator fixture", scope: "Declared, not observed", tools: [{ name: "read", description: "Read a file." }] };
  writeFileSync(file, JSON.stringify({ pi }));
  const options = { env: { ...env, VOICEBOX_HARNESS_TOOLS: file }, encoding: "utf8", timeout: 10000 };
  const cli = fileURLToPath(new URL("../tools/list-harnesses.mjs", import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, [cli, "--json"], options));
  assert.deepEqual(report.entries.find((row) => row.id === "pi").toolCatalogue, { status: "declared", ...pi });
  const text = execFileSync(process.execPath, [cli], options);
  assert.match(text, /Declared tools \(1\) — host metadata, not live permissions/);
  assert.match(text, /Source: Operator fixture/);
  assert.match(text, /Scope: Declared, not observed/);
  assert.match(text, /read: Read a file\./);
  assert.match(text, /Tools — unknown/);
  assert.match(text, /No Voicebox task adapter is configured/);
  assert.ok(!text.includes("undefined"));
});

test("harness page: click lists host facts, cache does not spawn twice, lost server marks old data stale", { timeout: 30000 }, async (t) => {
  const { env, command, dir } = fixture(t);
  command("opencode", "exit 2");
  const server = await startServer({ env });
  t.after(() => server.stop());
  const page = await launch({ width: 390, height: 844 });
  t.after(() => page.close());
  await page.goto(`${server.base}/harnesses.html`);
  assert.match(await page.evaluate(() => document.querySelector("#status").textContent), /Not checked/);
  await page.click("#check");
  await page.waitFor(() => document.querySelectorAll("article").length === 7, { label: "seven inventory rows" });
  const body = await page.evaluate(() => document.body.innerText);
  assert.match(body, new RegExp(`Pi coding agent — present \\(${ACP_AGENT.piVersion.replace(/\./g, "\\.")}\\)`));
  assert.match(body, /Claude Code — unrunnable/);
  assert.match(body, /Gemini CLI — unknown/);
  assert.match(body, /A browser cannot start a local CLI/);
  const rows = await page.evaluate(() => [...document.querySelectorAll("article")].map((row) => ({
    id: row.dataset.harness, refusal: row.dataset.delegationRefusal, text: row.innerText,
  })));
  for (const row of rows) {
    if (row.id === "pi" || row.id === "pi-acp") {
      assert.equal(row.refusal, "none");
      assert.match(row.text, /stdio-acp-client: pi-acp adapter/);
    } else {
      assert.equal(row.refusal, "adapter-not-configured");
      assert.match(row.text, /No Voicebox task adapter is configured/);
    }
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  command("pi", "exit 77");
  const cached = await (await fetch(`${server.base}/api/harnesses?command=anything`)).json();
  assert.equal(cached.entries.find((r) => r.id === "pi").state, "present");
  assert.ok(!JSON.stringify(cached).includes(dir));
  await server.stop();
  await page.click("#check");
  await page.waitFor(() => document.querySelector("#status").textContent.includes("Inventory unavailable"), { label: "unavailable is visible" });
  assert.match(await page.evaluate(() => document.querySelector("#status").textContent), /stale/);
});

test("native tool disclosures show only declared metadata, preserve refusals, and distinguish empty from unknown", { timeout: 30000 }, async (t) => {
  const { env, command, dir } = fixture(t);
  const file = path.join(dir, "tools.json");
  const calls = path.join(dir, "version-calls");
  command("pi", `test "$1" = "--version" || exit 3; echo version >> '${calls}'; echo ${ACP_AGENT.piVersion}`);
  command("claude", 'test "$1" = "--version" || exit 3; echo "2.0.0 (Claude Code)"');
  command("opencode", "exit 2");
  const project = path.join(dir, "project");
  mkdirSync(project);
  const pi = { source: "Operator fixture, not an observed session", scope: "Declared coding tools; extensions and permissions not inspected", tools: [
    { name: "read", description: "Read a file in the harness's own environment." },
    { name: "bash", description: "Run a shell command subject to that harness's configuration." },
  ] };
  const hostile = '<img src=x onerror="globalThis.metadataRan=true">';
  writeFileSync(file, JSON.stringify({ pi, claude: { source: hostile, scope: "Fixture declarations only", tools: [{ name: "Read", description: hostile }] }, gemini: { ...pi, tools: [] } }));
  const serverEnv = { ...env, VOICEBOX_WORKSPACE: project, VOICEBOX_HARNESS_TOOLS: file };
  let server = await startServer({ env: serverEnv });
  t.after(() => server.stop());
  const page = await launch({ width: 1200, height: 900 });
  t.after(() => page.close());
  const evidence = process.env.VOICEBOX_HARNESS_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  await page.goto(`${server.base}/harnesses.html`);
  await page.click("#check");
  await page.waitFor(() => document.querySelectorAll("article").length === 7);
  const piSelector = '[data-harness="pi"] details';
  assert.equal(await page.evaluate((s) => document.querySelector(s).open, piSelector), false);
  if (evidence) await page.screenshot(path.join(evidence, "catalogues-collapsed.png"));
  await page.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.matches('[data-harness="pi"] summary')), true);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.waitFor((s) => document.querySelector(s).open, { args: [piSelector], label: "keyboard opens declared tools" });
  const visible = await page.evaluate((s) => {
    const details = document.querySelector(s);
    return { text: details.innerText, names: [...details.querySelectorAll("dt")].map((el) => el.textContent), descriptions: [...details.querySelectorAll("dd")].map((el) => ({ text: el.textContent, visible: el.checkVisibility() })) };
  }, piSelector);
  assert.deepEqual(visible.names, pi.tools.map((tool) => tool.name));
  assert.deepEqual(visible.descriptions, pi.tools.map((tool) => ({ text: tool.description, visible: true })));
  assert.ok(visible.text.includes(`Source: ${pi.source}`));
  assert.ok(visible.text.includes(`Scope: ${pi.scope}`));
  assert.match(visible.text, /not a live session inspection/);
  await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: "center" }), piSelector);
  if (evidence) await page.screenshot(path.join(evidence, "catalogue-keyboard-open-desktop.png"));
  await page.click(`${piSelector} summary`);
  assert.equal(await page.evaluate((s) => document.querySelector(s).open, piSelector), false);
  await page.emulateViewport({ width: 390, height: 844, mobile: true, scale: 1 });
  await page.click(`${piSelector} summary`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(await page.evaluate((s) => document.querySelector(`${s} summary`).getBoundingClientRect().height >= 44, piSelector));
  await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: "start" }), piSelector);
  if (evidence) await page.screenshot(path.join(evidence, "catalogue-open-mobile.png"));
  await page.click('[data-harness="claude"] summary');
  assert.equal(await page.evaluate(() => document.querySelector('[data-harness="claude"] dd').textContent), hostile);
  assert.equal(await page.evaluate(() => document.querySelectorAll("article img, article script").length), 0);
  assert.equal(await page.evaluate(() => globalThis.metadataRan === undefined), true);
  assert.equal(await page.evaluate(() => document.querySelector('[data-harness="claude"]').dataset.delegationRefusal), "adapter-not-configured");
  await page.click('[data-harness="gemini"] summary');
  assert.match(await page.evaluate(() => document.querySelector('[data-harness="gemini"] details').innerText), /host declared an empty list/i);
  assert.match(await page.evaluate(() => document.querySelector('[data-harness="codex"]').innerText), /Tools — unknown/);
  // Neither a query parameter nor a file change bypasses the existing snapshot cache.
  writeFileSync(file, '{"private-parser-fragment": invalid}');
  const cached = await (await fetch(`${server.base}/api/harnesses?VOICEBOX_HARNESS_TOOLS=/not-used`)).json();
  assert.deepEqual(cached.entries.find((row) => row.id === "pi").toolCatalogue, { status: "declared", ...pi });
  assert.equal(readFileSync(calls, "utf8"), "version\n", "inventory was reused, not rerun as a task");
  assert.ok(!JSON.stringify(cached).includes(dir));
  await server.stop();
  server = await startServer({ env: serverEnv });
  await page.goto(`${server.base}/harnesses.html`);
  await page.click("#check");
  await page.waitFor(() => document.querySelectorAll("article").length === 7);
  const invalid = await page.evaluate(() => document.querySelector('[data-harness="pi"]').innerText);
  assert.match(invalid, /Pi coding agent — present/);
  assert.match(invalid, /Tools — unknown/);
  assert.match(invalid, /Tool metadata invalid/);
  assert.ok(!invalid.includes("private-parser-fragment"));
  assert.equal(await page.evaluate(() => document.querySelectorAll("details").length), 0, "invalid data is not an empty successful catalogue");
  if (evidence) await page.screenshot(path.join(evidence, "catalogue-invalid-mobile.png"));
});
