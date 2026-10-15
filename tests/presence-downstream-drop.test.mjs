// voicebox-beads-g4nq: an earlier healthy heartbeat must not outvote a later lost machine.
import test from "node:test";
import assert from "node:assert/strict";
import { launch } from "./lib/cdp.mjs";
import { startServer } from "./lib/server.mjs";

test("presence: a machine lost after /api/health is named when its downstream fetch settles", async () => {
  const server = await startServer({ env: { VOICEBOX_RESOLVER: "script" } });
  const page = await launch({ fakeMedia: true });
  let stopped = false;
  try {
    // Pause the actual /api/environments fetch until a successful health response has been observed and
    // the server has been stopped. The resumed fetch genuinely rejects; the page alone paints the note.
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      const originalFetch = window.fetch.bind(window);
      window.__g4nqHealthAnswered = false;
      window.__g4nqEnvPending = false;
      window.__g4nqEnvResumed = false;
      window.fetch = async (...args) => {
        const route = new URL(String(args[0]), location.href).pathname;
        if (route === "/api/environments" && window.__g4nqHealthAnswered) {
          window.__g4nqEnvPending = true;
          await new Promise((release) => { window.__g4nqReleaseEnv = release; });
          window.__g4nqEnvResumed = true;
        }
        const response = await originalFetch(...args);
        if (route === "/api/health" && response.ok) window.__g4nqHealthAnswered = true;
        return response;
      };
    ` });
    await page.goto(server.base);
    await page.waitFor(() => window.__g4nqHealthAnswered && window.__g4nqEnvPending,
      { timeout: 30000, label: "healthy heartbeat followed by waiting environment fetch" });
    await server.stop();
    stopped = true;
    await page.evaluate(() => window.__g4nqReleaseEnv());
    await page.waitFor(
      () => window.__g4nqEnvResumed &&
        document.querySelector("#where-note")?.textContent === "the machine is not answering — fix the host" &&
        document.querySelector("#server-dot")?.getAttribute("data-ok") === "false",
      { timeout: 15000, label: "room to name the lost machine without waiting for the next poll" },
    );
    const observed = await page.evaluate(() => ({
      healthAnswered: window.__g4nqHealthAnswered,
      envResumed: window.__g4nqEnvResumed,
      text: document.querySelector("#where-note")?.textContent,
      title: document.querySelector("#where-note")?.title,
      dot: document.querySelector("#server-dot")?.getAttribute("data-ok"),
    }));
    assert.equal(observed.healthAnswered, true, "the earlier heartbeat DID answer");
    assert.equal(observed.envResumed, true, "the later fetch DID resume after the machine stopped");
    assert.equal(observed.dot, "false", "the latest network evidence overrides the earlier green dot");
    assert.equal(observed.text, "the machine is not answering — fix the host");
    assert.match(observed.title, /source: GET \/api\/environments.*machine-unreachable/);
    assert.doesNotMatch(observed.text, /environment list/);
    if (process.env.VOICEBOX_G4NQ_EVIDENCE) {
      await page.evaluate(() => document.querySelector("#sync-toast-dismiss")?.click());
      await page.screenshot(process.env.VOICEBOX_G4NQ_EVIDENCE);
    }
  } finally {
    await page.close();
    if (!stopped) await server.stop();
  }
});
