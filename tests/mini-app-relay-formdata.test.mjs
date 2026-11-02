// tests/mini-app-relay-formdata.test.mjs — a FormData body crosses the fetch relay for real
// (voicebox-beads-ctmt), driven in a real browser the reviewer's way.
//
// The finding: relayBody accepted a FormData ({ok:true, body: formData}) and the frame SDK then handed it
// to bridgePort.postMessage — Chrome's structured clone throws DataCloneError on a FormData, so the request
// died AFTER the policy had accepted it: no error the app could catch at the write site, no request at the
// server. The fix carries an entries ENVELOPE across the ports and rebuilds the FormData at the far end.
//
// WHAT CHANGED, AND WHY THIS FILE MOUNTS THROUGH THE ROOM (voicebox-beads-j6im). A mutating request no longer
// rides the relay's own fetch: the bridge forwards it to the room and a person approves it. So the body now
// crosses THREE hops — frame → port envelope → bridge → room → wire — and the multipart bytes on the wire are
// still the proof that nothing in that chain dropped or emptied the body. The target is a JSON route ON PURPOSE
// (voicebox-beads-9qz0): its 415 refusal names the Content-Type it received, so a rebuilt FormData answers
// 'multipart/form-data' and a silently BODYLESS relay answers 'sent no Content-Type'. This file asserts the
// WIRE, which no refusal text can fake.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("a FormData body crosses the fetch relay and the room's consent, and the wire carries it", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-relay-formdata-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "workspace") }, cwd: scratch });
  t.after(() => server.stop());

  const page = await launch();
  t.after(() => page.close());
  await page.send("Network.enable");
  await page.goto(`${server.base}/`);
  await page.waitFor(
    () => typeof window.__voiceboxOnMiniApp === "function" && !!window.__voiceboxMiniAppRegistry,
    { label: "room booted", timeout: 30000 },
  );

  // A probe app mounted THE ROOM'S WAY (sandboxed, opaque origin) that POSTs a FormData through its `fetch`,
  // plus a read that must still ride the relay without a prompt.
  const appHtml = `<!doctype html><script>
    const form = new FormData();
    form.set("field", "value");
    fetch("/api/branches/merge", { method: "POST", body: form }).catch(() => {});
    fetch("/api/health").catch(() => {});
  <\/script>`;
  await page.evaluate((html) => {
    window.__voiceboxOnMiniApp({ appId: "formdata-probe", title: "FormData probe", html });
  }, appHtml);

  // The mutation is HELD for the room's operator: the prompt names the route and the envelope it will carry.
  await page.waitFor(() => !!document.querySelector(".mini-app-consent"), {
    label: "the room's consent prompt",
    timeout: 15000,
  });
  const prompt = await page.evaluate(() => document.querySelector(".mini-app-consent")?.textContent ?? "");
  assert.match(prompt, /POST \/api\/branches\/merge/, `the prompt must name the route: ${prompt}`);
  assert.match(
    prompt,
    /FormData — field=value/,
    `the prompt must describe the form body a person is approving, entry by entry: ${prompt}`,
  );

  await page.click(".mini-app-consent-allow");

  // THE WIRE: the room's real fetch must carry the multipart body with the actual field and value.
  const wanted = () =>
    page.events("Network.requestWillBeSent").filter((e) => {
      const request = e.request ?? {};
      return request.method === "POST" && String(request.url ?? "").endsWith("/api/branches/merge");
    });
  const deadline = Date.now() + 15000;
  while (wanted().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const posts = wanted();
  assert.equal(posts.length, 1, "exactly one approved POST to /api/branches/merge is on the wire");
  const { postData } = await page.send("Network.getRequestPostData", { requestId: posts[0].requestId });
  assert.match(postData ?? "", /name="field"/u, "the wire body carries the form field — a header-only or empty-FormData relay cannot produce this");
  assert.match(postData ?? "", /\r?\n\r?\nvalue\r?\n/u, "the wire body carries the field's VALUE as a multipart part");
  assert.match(
    String(posts[0].request.headers?.["Content-Type"] ?? ""),
    /multipart\/form-data; boundary=/u,
    "the browser must choose the multipart boundary — a body rebuilt as a string would have a bare content-type",
  );

  // The READ rode the relay with no prompt and no approval: it is on the wire too.
  const reads = page
    .events("Network.requestWillBeSent")
    .filter((e) => e.request?.method === "GET" && String(e.request?.url ?? "").endsWith("/api/health"));
  assert.ok(reads.length >= 1, "the approved read did not reach the server through the relay");
  assert.equal(
    await page.evaluate(() => !document.querySelector(".mini-app-consent")),
    true,
    "the prompt must go away once it has been answered",
  );
});
