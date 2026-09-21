import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { discoverHarnesses } from "../lib/harness-inventory.mjs";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vb-harnesses-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adapter = path.join(dir, "adapter");
  mkdirSync(adapter);
  writeFileSync(path.join(adapter, "package.json"), JSON.stringify({ name: "pi-acp", version: "0.0.33" }));
  const command = (name, body, mode = 0o700) => writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode });
  command("pi", 'test "$1" = "--version" || exit 3; echo 0.85.1');
  command("claude", "exit 7");
  command("codex", "echo ignored", 0o600);
  command("gemini", "echo private-output-must-not-leak");
  command("opencode", `(/bin/sleep 0.3; echo escaped > '${path.join(dir, "escaped")}') & wait`);
  return { env: { PATH: dir, VOICEBOX_ACP_ADAPTER: adapter }, command, dir };
}

test("host inventory separates version-only presence, broken installs, unknown identity and absence", async (t) => {
  const { env, dir } = fixture(t);
  const before = Date.now();
  const report = await discoverHarnesses({ env, timeoutMs: 100 });
  assert.ok(Date.now() - before < 5000);
  assert.equal(report.entries.length, 7);
  const rows = Object.fromEntries(report.entries.map((r) => [r.id, r]));
  assert.equal(rows.pi.state, "present");
  assert.equal(rows.pi.version, "0.85.1");
  assert.equal(rows.pi.delegation.refused, "absent-capability");
  assert.equal(rows.claude.state, "unrunnable");
  assert.match(rows.claude.why, /exit 7/);
  assert.equal(rows.codex.state, "unrunnable");
  assert.equal(rows.gemini.state, "unknown");
  assert.equal(rows.opencode.state, "unrunnable");
  assert.match(rows.opencode.why, /exceeded 100ms/);
  assert.equal(rows.aider.state, "absent");
  assert.equal(rows["pi-acp"].version, "0.0.33");
  assert.equal(rows["pi-acp"].state, "unknown");
  assert.ok(!JSON.stringify(report).includes("private-output"));
  assert.ok(!JSON.stringify(report).includes(env.PATH));
  await delay(400);
  assert.equal(existsSync(path.join(dir, "escaped")), false, "version-check descendants must be killed too");
});

test("no guessed identity, project PATH lookup, or fallback for a broken configured Pi", async (t) => {
  const { env, dir, command } = fixture(t);
  const report = await discoverHarnesses({ env: { ...env, PATH: ".:", VOICEBOX_ACP_PI: path.join(dir, "missing"), VOICEBOX_ACP_ADAPTER: dir }, timeoutMs: 100 });
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
  assert.match(body, /Pi coding agent — present \(0.85.1\)/);
  assert.match(body, /Claude Code — unrunnable/);
  assert.match(body, /Gemini CLI — unknown/);
  assert.match(body, /A browser cannot start a local CLI/);
  assert.match(body, /absent-capability/);
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
