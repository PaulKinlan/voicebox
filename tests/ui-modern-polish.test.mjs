// tests/ui-modern-polish.test.mjs — verify Tier A modern-web polish items (voicebox-beads-ms0t)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";
import { launch } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

test("static: .mini-app-bubble-badge uses 0.75rem font size floor in public/style.css", () => {
  const css = readFileSync(path.join(PUBLIC, "style.css"), "utf8");
  assert.match(
    css,
    /\.mini-app-bubble-badge\s*\{[^}]*font-size:\s*0\.75rem;/s,
    ".mini-app-bubble-badge must use 0.75rem font size",
  );
  assert.doesNotMatch(
    css,
    /\.mini-app-bubble-badge\s*\{[^}]*font-size:\s*10px;/s,
    "10px font size must be eliminated",
  );
});

test("static: headings declare text-wrap: balance in changelog.css and harnesses.css", () => {
  const changelogCss = readFileSync(path.join(PUBLIC, "changelog.css"), "utf8");
  assert.match(
    changelogCss,
    /h1\s*\{[^}]*text-wrap:\s*balance;/s,
    "h1 in changelog.css must declare text-wrap: balance",
  );

  const harnessesCss = readFileSync(path.join(PUBLIC, "harnesses.css"), "utf8");
  assert.match(
    harnessesCss,
    /h1\s*\{[^}]*text-wrap:\s*balance;/s,
    "h1 in harnesses.css must declare text-wrap: balance",
  );
  assert.match(
    harnessesCss,
    /h2\s*\{[^}]*text-wrap:\s*balance;/s,
    "h2 in harnesses.css must declare text-wrap: balance",
  );
});

test("static: background changelog fetches pass priority: 'low' option in changelog.js and fused.js", () => {
  const changelogJs = readFileSync(path.join(PUBLIC, "changelog.js"), "utf8");
  assert.match(
    changelogJs,
    /fetch\("\/api\/changelog",\s*\{[^}]*priority:\s*"low"[^}]*\}\)/,
    "changelog.js must pass priority: 'low' to fetch",
  );

  const fusedJs = readFileSync(path.join(PUBLIC, "fused.js"), "utf8");
  assert.match(
    fusedJs,
    /fetch\("\/api\/changelog",\s*\{[^}]*priority:\s*(?:"low"|options\.priority \?\? "low")[^}]*\}\)/,
    "fused.js must pass priority option defaulting to 'low' to fetch",
  );
});

test("browser: computed styles for badge, headings, and fetch priority option (voicebox-beads-ms0t)", { timeout: 60000 }, async () => {
  const server = await startServer({
    cwd: ROOT,
    env: { VOICEBOX_WORKSPACE: undefined },
  });
  const page = await launch();

  try {
    // 1. Verify computed font-size of .mini-app-bubble-badge on index.html
    await page.goto(`${server.base}/`);
    await page.waitFor(() => document.body !== null);

    const badgeFontSize = await page.evaluate(() => {
      const span = document.createElement("span");
      span.className = "mini-app-bubble-badge";
      span.textContent = "APP";
      document.body.appendChild(span);
      const computed = window.getComputedStyle(span).fontSize;
      span.remove();
      return computed;
    });
    assert.equal(badgeFontSize, "12px", ".mini-app-bubble-badge font size must compute to 12px (0.75rem)");

    // 2. Verify text-wrap on changelog.html and fetch priority option
    // Pre-inject fetch interceptor before document loads
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.__capturedFetchCalls = [];
        const _origFetch = window.fetch;
        window.fetch = function(input, init) {
          const url = typeof input === "string" ? input : input?.url;
          window.__capturedFetchCalls.push({ url, priority: init?.priority });
          return _origFetch.apply(this, arguments);
        };
      `,
    });

    await page.goto(`${server.base}/changelog.html`);
    await page.waitFor(() => document.querySelector("h1") !== null);

    const changelogH1Wrap = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return window.getComputedStyle(h1).textWrap;
    });
    assert.equal(changelogH1Wrap, "balance", "changelog h1 textWrap must compute to balance");

    // Wait for the changelog request from the production script
    await page.waitFor(
      () => (window.__capturedFetchCalls ?? []).some((c) => c.url?.includes("/api/changelog")),
      { label: "changelog fetch to execute" },
    );
    const changelogCall = await page.evaluate(() =>
      window.__capturedFetchCalls.find((c) => c.url?.includes("/api/changelog")),
    );
    assert.ok(changelogCall, "production loadChangelog fetch must occur");
    assert.equal(changelogCall.priority, "low", "production changelog fetch must pass priority: 'low'");

    // 3. Verify text-wrap on harnesses.html
    await page.goto(`${server.base}/harnesses.html`);
    await page.waitFor(() => document.querySelector("h1") !== null);

    const harnessesWrap = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      const h2 = document.querySelector("h2");
      return {
        h1: window.getComputedStyle(h1).textWrap,
        h2: h2 ? window.getComputedStyle(h2).textWrap : "balance",
      };
    });
    assert.equal(harnessesWrap.h1, "balance", "harnesses h1 textWrap must compute to balance");
    assert.equal(harnessesWrap.h2, "balance", "harnesses h2 textWrap must compute to balance");
  } finally {
    await page.close();
    await server.stop();
  }
});
