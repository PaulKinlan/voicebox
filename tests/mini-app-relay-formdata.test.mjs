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
  // The wire is the evidence (voicebox-beads-ppsp): a refusal text names the forwarded content-type
  // HEADER, which a header-only bodyless mutant fakes; the multipart BYTES on the bridge page's real
  // fetch cannot be faked by dropping the body or emptying the FormData.
  await page.send("Network.enable");
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
    // DataCloneError (the port could not clone the body). The target is a JSON route ON PURPOSE
    // (voicebox-beads-9qz0): its 415 refusal names the Content-Type it received, so a rebuilt FormData
    // answers 'multipart/form-data' and a silently BODYLESS relay answers 'sent no Content-Type' — the
    // status alone would pass either way, the why does not.
    fetch("/api/mini-apps", { method: "POST", body: form })
      .then(async (r) => report("form-post", "HTTP " + r.status + " " + (await r.text())))
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
  assert.match(formPost, /^HTTP 415 /u, `the JSON route must refuse the multipart POST by name (got: ${formPost.slice(0, 200)}) — a DataCloneError here is the ctmt defect`);
  assert.match(formPost, /multipart\/form-data/u, `the server must report receiving a multipart body — 'sent no Content-Type' means the relay went out bodyless (got: ${formPost.slice(0, 200)})`);

  // THE WIRE: the bridge page's real fetch must carry the multipart body with the actual field.
  const posts = page
    .events("Network.requestWillBeSent")
    .filter((e) => e.request?.method === "POST" && String(e.request?.url ?? "").includes("/api/mini-apps"));
  assert.equal(posts.length, 1, "exactly one relayed POST to /api/mini-apps is on the wire");
  const { postData } = await page.send("Network.getRequestPostData", { requestId: posts[0].requestId });
  assert.match(postData ?? "", /name="field"/u, "the wire body carries the form field — a header-only or empty-FormData relay cannot produce this");
  assert.match(postData ?? "", /\r?\n\r?\nvalue\r?\n/u, "the wire body carries the field's VALUE as a multipart part");
});
