// tests/branch-landing-mount.test.mjs — the landing inspector as the ROOM mounts it (voicebox-beads-rsjn).
//
// WHY THIS FILE EXISTS AT ALL: the room used to import public/branch-landing-ui.mjs and ~350 lines of
// tests kept that module green, but after voicebox-beads-ludu the app loads no such module — public/fused.js
// drops createBranchLandingController and the voice command reaches
// openBranchLandingInspector(), which fetches /apps/landing-inspector.html and mounts it through the
// mini-app surface. The coverage had stayed on the dead path, which is how two follow-up findings
// (v1k6, ulhi) landed green: nothing was testing the path a person actually uses.
//
// WHAT COUNTS AS "THE REAL APP", AND WHY IT IS NOT THE RESPONSE STATUS (voicebox-beads-xm6o):
// openBranchLandingInspector() reads the body and falls back to an inline placeholder whenever the text
// is empty — so a 200 with an empty body mounts the PLACEHOLDER, not the inspector. The first version
// of this file pinned the status and the surface, and a reviewer was right that it stayed green in that
// state. So the assertion is now on the html the room hands the app runtime: the mini-app surface sends
// it over a MessageChannel port (`mini_app_init`), which this test captures, and the placeholder cannot
// satisfy it because it carries none of the inspector's controls. That also removes any dependence on
// reading inside the sandboxed iframe, which has an opaque origin by design.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

/** Markers only public/apps/landing-inspector.html carries — the inline placeholder in fused.js has none. */
const INSPECTOR_MARKERS = ["refresh-branches-btn", "land-branch-btn", "keep-separate-btn", "/apps/landing-inspector.js"];
/** The placeholder's own sentence, so a fallback mount can be named rather than merely not-matching. */
const PLACEHOLDER_MARKER = "Review and land candidate task branches.";

/**
 * Capture the html the mini-app surface hands its runtime: the surface posts `mini_app_init` (and the
 * bridge `load_app`) over a MessageChannel it creates itself, so wrapping the constructor catches every
 * mount in the page without touching the app's internals.
 */
function captureMountedHtml() {
  const captured = [];
  const RealChannel = window.MessageChannel;
  window.MessageChannel = function wrapped() {
    const channel = new RealChannel();
    const post = channel.port1.postMessage.bind(channel.port1);
    channel.port1.postMessage = (data, ...rest) => {
      if (data && typeof data === "object" && typeof data.html === "string") captured.push(data);
      return post(data, ...rest);
    };
    return channel;
  };
  return captured;
}

test("branch-landing: the voice command's mount fetches the real inspector app and hands the app runtime its html (voicebox-beads-rsjn, voicebox-beads-xm6o)", { timeout: 90000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  const outcome = await page.evaluate(async (markers) => {
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

    const RealChannel = window.MessageChannel;
    const mounted = [];
    window.MessageChannel = function wrapped() {
      const channel = new RealChannel();
      const post = channel.port1.postMessage.bind(channel.port1);
      channel.port1.postMessage = (data, ...rest) => {
        if (data && typeof data === "object" && typeof data.html === "string") mounted.push({ type: data.type, html: data.html });
        return post(data, ...rest);
      };
      return channel;
    };

    const opener = window.__voiceboxOpenBranchInspector;
    if (typeof opener !== "function") return { error: "the room exposes no __voiceboxOpenBranchInspector" };
    await opener();
    // The html crosses the bridge's MessageChannel after its handshake, so it is not available the
    // instant opener() resolves: wait for it, bounded, instead of reading whatever is there.
    const deadline = Date.now() + 20000;
    while (mounted.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));

    const container = document.getElementById("mini-app-container");
    const title = document.getElementById("mini-app-title");
    const html = mounted.map((entry) => entry.html).join("\n");
    return {
      requested,
      responses,
      mountedTypes: mounted.map((entry) => entry.type),
      containerHidden: container ? container.hidden : null,
      title: title ? title.textContent : null,
      hasInspectorMarkers: markers.every((marker) => html.includes(marker)),
      hasPlaceholderMarker: html.includes("Review and land candidate task branches."),
      htmlLength: html.length,
    };
  }, INSPECTOR_MARKERS);

  assert.equal(outcome.error, undefined, outcome.error);
  assert.ok(
    outcome.requested.some((url) => url === "/apps/landing-inspector.html"),
    `the mount must fetch the real inspector app; fetched: ${JSON.stringify(outcome.requested)}`,
  );
  assert.deepEqual(outcome.responses, [{ ok: true, status: 200 }], `the inspector app must be served; got ${JSON.stringify(outcome.responses)}`);
  assert.equal(outcome.containerHidden, false, "the mini-app surface must be visible after the mount");
  assert.equal(outcome.title, "Branch Landing Inspector", "the surface must carry the inspector's title");
  // THE assertion voicebox-beads-xm6o was right about: a 200 with an empty body satisfies every check
  // above while mounting the placeholder, so the html itself has to be inspected.
  assert.ok(outcome.mountedTypes.length > 0, "the surface must hand the app runtime its html (no mount message was captured)");
  assert.equal(
    outcome.hasPlaceholderMarker,
    false,
    "the room mounted the inline PLACEHOLDER, not the inspector — the app fetch returned a body that fused.js treats as empty",
  );
  assert.equal(
    outcome.hasInspectorMarkers,
    true,
    `the mounted html must be public/apps/landing-inspector.html (missing at least one of ${JSON.stringify(INSPECTOR_MARKERS)}); got ${outcome.htmlLength} bytes`,
  );
});

test("branch-landing: an empty 200 from the app fetch mounts the placeholder, which this file's own assertions reject (voicebox-beads-xm6o)", { timeout: 90000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const page = await launch({ width: 1100, height: 800 });
  t.after(() => page.close());

  await page.goto(`${server.base}/`);

  // The reviewer's state, reproduced deliberately: status 200, body empty. fused.js's `if (html)` is what
  // decides, so this is a fallback mount — and the point of the test is that the assertions in the test
  // above would now FAIL, which is what makes them about the inspector rather than about a mount.
  const outcome = await page.evaluate(async () => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input) === "/apps/landing-inspector.html") return new Response("", { status: 200 });
      return realFetch(input, init);
    };

    const RealChannel = window.MessageChannel;
    const mounted = [];
    window.MessageChannel = function wrapped() {
      const channel = new RealChannel();
      const post = channel.port1.postMessage.bind(channel.port1);
      channel.port1.postMessage = (data, ...rest) => {
        if (data && typeof data === "object" && typeof data.html === "string") mounted.push(data.html);
        return post(data, ...rest);
      };
      return channel;
    };

    await window.__voiceboxOpenBranchInspector();
    const deadline = Date.now() + 20000;
    while (mounted.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const html = mounted.join("\n");
    return {
      mounted: mounted.length,
      hasInspectorMarkers: ["refresh-branches-btn", "land-branch-btn", "keep-separate-btn", "/apps/landing-inspector.js"].every((marker) => html.includes(marker)),
      hasPlaceholderMarker: html.includes("Review and land candidate task branches."),
    };
  });

  assert.equal(outcome.mounted, 1, "an empty 200 still mounts something — the fallback");
  assert.equal(outcome.hasPlaceholderMarker, true, "an empty 200 must reach the placeholder (that is fused.js's documented fallback)");
  assert.equal(outcome.hasInspectorMarkers, false, "an empty 200 must NOT look like the real inspector — otherwise the test above cannot tell them apart");
});
