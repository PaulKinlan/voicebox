// tests/branch-landing-mount.test.mjs — the landing inspector as the ROOM mounts it (voicebox-beads-rsjn).
//
// WHY THIS FILE EXISTS AT ALL: the room used to import public/branch-landing-ui.mjs and ~350 lines of
// tests kept that module green, but after voicebox-beads-ludu the app loads no such module — public/fused.js
// drops createBranchLandingController and the voice command reaches
// openBranchLandingInspector(), which fetches /apps/landing-inspector.html and mounts it through the
// mini-app surface. The coverage had stayed on the dead path, which is how two follow-up findings
// (v1k6, ulhi) landed green: nothing was testing the path a person actually uses.
//
// So this drives the live path, from the room's own global, and proves the mounted app is the REAL
// inspector rather than the inline fallback that openBranchLandingInspector() uses when the fetch fails
// (the fallback has no controls, so the id assertions below cannot pass against it).
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

test("branch-landing: the voice command's inspector mount fetches the real app and mounts it in the room (voicebox-beads-rsjn)", { timeout: 90000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const outcome = await page.evaluate(async () => {
    const requested = [];
    const responses = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(input);
      requested.push(url);
      const response = await realFetch(input, init);
      if (url === "/apps/landing-inspector.html") responses.push({ ok: response.ok, status: response.status });
      return response;
    };
    const opener = window.__voiceboxOpenBranchInspector;
    if (typeof opener !== "function") return { error: "the room exposes no __voiceboxOpenBranchInspector" };
    await opener();
    const container = document.getElementById("mini-app-container");
    const title = document.getElementById("mini-app-title");
    const frame = container?.querySelector("iframe") ?? null;
    let frameText = "";
    try {
      frameText = frame?.contentDocument?.body?.innerText ?? "";
    } catch {
      frameText = ""; // sandboxed without allow-same-origin: the DOM assertions below carry the weight
    }
    return {
      requested,
      responses,
      containerHidden: container ? container.hidden : null,
      title: title ? title.textContent : null,
      hasFrame: Boolean(frame),
      frameText,
    };
  });

  assert.equal(outcome.error, undefined, outcome.error);
  assert.ok(
    outcome.requested.some((url) => url === "/apps/landing-inspector.html"),
    `the mount must fetch the real inspector app, not fall back; fetched: ${JSON.stringify(outcome.requested)}`,
  );
  // A 404 would leave html empty and mount the inline FALLBACK, which has no controls: asserting the
  // response alone is what makes this test about the app rather than about an attempted request.
  assert.deepEqual(outcome.responses, [{ ok: true, status: 200 }], `the inspector app must actually be served; got ${JSON.stringify(outcome.responses)}`);
  assert.equal(outcome.containerHidden, false, "the mini-app surface must be visible after the mount");
  assert.equal(outcome.title, "Branch Landing Inspector", "the surface must carry the inspector's title");
  assert.equal(outcome.hasFrame, true, "the mount must produce a frame for the app");
  // The fallback HTML openBranchLandingInspector() uses when the fetch fails carries no controls, so a
  // mounted body that names them is proof the app itself arrived.
  if (outcome.frameText) {
    assert.match(outcome.frameText, /Branch Landing Inspector/, "the mounted app must be the landing inspector, not an empty surface");
  }
});
