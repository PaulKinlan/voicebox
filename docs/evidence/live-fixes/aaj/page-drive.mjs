// Browser evidence for aaj's README step 1: the Harnesses dialog on the REAL page,
// driven with real input, screenshot captured.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const OUT = path.dirname(new URL(import.meta.url).pathname);
const scratchExtensions = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-ext-aaj-page-"));

const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, PORT: "0", VOICEBOX_RESOLVER: "script", VOICEBOX_HARNESS: "pi", VOICEBOX_EXTENSIONS_DIR: scratchExtensions },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderrLog = "";
child.stderr.on("data", (c) => { stderrLog += String(c); });
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no port in 20s")), 20000);
  child.stdout.on("data", (chunk) => {
    const m = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { clearTimeout(timer); resolve(Number(m[1])); }
  });
  child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}\n${stderrLog}`)); });
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(50); }

const { launch } = await import(path.join(ROOT, "tests/lib/cdp.mjs"));
const page = await launch({ width: 1280, height: 900 });
await page.goto(`${base}/`);
await sleep(1500); // page boot: live session flag, header icons
await page.click("#harnesses-open");
await page.waitFor(() => document.querySelectorAll("#harnesses-dialog article, #harnesses-dialog [data-harness]").length > 0, { label: "harness rows" });
const rows = await page.evaluate(() => [...document.querySelectorAll("#harnesses-dialog [data-harness]")].map((r) => ({ id: r.dataset.harness, text: r.innerText.slice(0, 60) })));
const admission = await (await fetch(`${base}/api/agents`)).json();
await page.screenshot(path.join(OUT, "harnesses-dialog.png"));
fs.writeFileSync(path.join(OUT, "page-drive.json"), JSON.stringify({ base, rows, admission: admission.agents.map((a) => ({ id: a.id, admission: a.admission })) }, null, 2) + "\n");
console.error("rows:", JSON.stringify(rows));
console.error("admission rows:", admission.agents.filter((a) => a.admission).length);
child.kill("SIGTERM");
process.exit(rows.length > 0 ? 0 : 1);
