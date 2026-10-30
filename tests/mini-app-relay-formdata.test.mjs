// tests/mini-app-relay-formdata.test.mjs — a FormData body crosses the fetch relay for real
// (voicebox-beads-ctmt), driven in a real browser the reviewer's way.
//
// The finding: relayBody accepted a FormData ({ok:true, body: formData}) and the frame SDK then handed it
// to bridgePort.postMessage — Chrome's structured clone throws DataCloneError on a FormData, so the request
// died AFTER the policy had accepted it: no error the app could catch at the write site, no request at the
// server. The fix carries an entries ENVELOPE across the port and rebuilds the FormData on the bridge; this
// file mounts a probe app through the REAL bridge page (sandboxed, opaque origin) and POSTs a FormData
// through the relayed fetch — the HTTP status the server answers is the proof the body crossed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("a FormData body crosses the fetch relay (no DataCloneError; the server answers)", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-relay-formdata-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "workspace") }, cwd: scratch });
  t.after(() => server.stop());

  const page = await launch();
  t.after(() => page.close());
  await page.goto(`${server.base}/mini-app-bridge.html?appId=formdata-probe`);
  await page.evaluate(() => {
    window.__results = [];
    window.addEventListener("message", (e) => {
      if (e.data?.probe) window.__results.push(e.data);
    });
  });
  const appHtml = `<!doctype html><script>
    const report = (name, value) => parent.postMessage({ probe: true, name, value }, "*");
    const form = new FormData();
    form.set("field", "value");
    // The defect's own shape: POST a FormData through the relayed fetch. Before the fix this rejected with
    // DataCloneError (the port could not clone the body); anything with an HTTP status PROVES the crossing.
    fetch("/api/health", { method: "POST", body: form })
      .then((r) => report("form-post", "HTTP " + r.status))
      .catch((e) => report("form-post", String(e)));
    fetch("/api/health").then((r) => report("control", "HTTP " + r.status)).catch((e) => report("control", String(e)));
  <\/script>`;
  await page.evaluate((h) => window.postMessage({ type: "load_app", appId: "formdata-probe", html: h }, "*"), appHtml);
  await page.waitFor(
    () => window.__results?.some((m) => m.name === "form-post") && window.__results?.some((m) => m.name === "control"),
    { label: "form POST and control answered", timeout: 30000 },
  );
  const results = await page.evaluate(() => window.__results);
  const formPost = results.find((m) => m.name === "form-post")?.value ?? "";
  const control = results.find((m) => m.name === "control")?.value ?? "";
  assert.match(control, /^HTTP \d+$/u, `the GET control must reach the server (got: ${control})`);
  assert.match(formPost, /^HTTP \d+$/u, `the FormData POST must cross the port and reach the server (got: ${formPost}) — a DataCloneError here is the ctmt defect`);
});
