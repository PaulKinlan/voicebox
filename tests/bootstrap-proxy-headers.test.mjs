// tests/bootstrap-proxy-headers.test.mjs — voicebox-beads-jbh2.
//
//   node --test tests/bootstrap-proxy-headers.test.mjs
//
// THE DEFECT: the dev front's ?bootstrap= middleware forwarded ANY method and path to the API with nothing but a
// cookie header — no Origin, no Sec-Fetch-Site. server.mjs reads absent browser headers as "a caller that is not a
// browser" (that absence is what browserMutationRefused exists to catch), so appending one query parameter to a
// mutating call minted machine-caller context for it. The ticket exchange is a GET on the page route; nothing else
// belongs on this hop.
//
// This drives the middleware itself against a recording upstream — no Vite server, no browser — so the assertion is
// about the headers the API would actually receive.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Writable } from "node:stream";

/** A recording upstream: it remembers the last request and answers 200 so the middleware has something to pipe. */
async function recordingUpstream() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream answer");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { seen, port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Pull the bootstrap middleware out of the real vite.config.js.
 *
 * ONCE FOR THE WHOLE FILE: API_TARGET is captured at import time from process.env.PORT, so a per-test upstream would
 * leave every test after the first pointing at a closed port. That is an order dependency, and it bit this file
 * before the fixtures were shared — the fourth case passed alone and failed in the file.
 */
async function bootstrapMiddleware(apiPort) {
  process.env.PORT = String(apiPort);
  const config = (await import("../vite.config.js")).default;
  const resolved = typeof config === "function" ? await config({ command: "serve", mode: "development" }) : config;
  const plugin = (resolved.plugins ?? []).flat(Infinity).find((p) => p && p.name === "loopback-bootstrap-proxy");
  assert.ok(plugin, "vite.config.js must still declare the loopback-bootstrap-proxy plugin");
  let middleware = null;
  plugin.configureServer({ middlewares: { use: (fn) => { middleware = fn; } } });
  assert.equal(typeof middleware, "function", "the plugin installs one middleware");
  return middleware;
}

/**
 * Drive the middleware with a fake req and a real Writable for res, reporting whether it called next().
 *
 * The response has to be a genuine stream: the middleware pipes the upstream into it, and a hand-rolled object fails
 * with "dest.once is not a function" before the assertion is reached (written, then measured).
 */
function drive(middleware, { method = "GET", url = "/", headers = {} }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = new Writable({
      write(chunk, _enc, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    res.writeHead = (status, hdrs) => { res.status = status; res.headers = hdrs; };
    const finish = (passedThrough) => resolve({ passedThrough, status: res.status, body: Buffer.concat(chunks).toString() });
    res.on("finish", () => finish(false));
    res.on("error", reject);
    const next = () => finish(true);
    try {
      middleware({ method, url, headers }, res, next);
    } catch (err) {
      reject(err);
    }
  });
}

const BROWSER = {
  host: "localhost:5173",
  cookie: "vb_session=cookie-value",
  origin: "http://localhost:5173",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "user-agent": "Mozilla/5.0 (test)",
  accept: "text/html",
};

let upstream = null;
let middleware = null;

test.before(async () => {
  upstream = await recordingUpstream();
  middleware = await bootstrapMiddleware(upstream.port);
});
test.beforeEach(() => { upstream.seen.length = 0; });
test.after(async () => { await upstream.close(); });

test("a ?bootstrap= NAVIGATION still reaches the API, and now carries the browser's own context (voicebox-beads-jbh2)", async () => {
  {
    const outcome = await drive(middleware, { method: "GET", url: "/?bootstrap=ticket-1", headers: BROWSER });
    assert.equal(outcome.passedThrough, false, "a redemption must be forwarded, not handed to Vite");
    assert.equal(outcome.status, 200, "the upstream's answer comes back verbatim");
    assert.equal(upstream.seen.length, 1);

    const sent = upstream.seen[0];
    assert.equal(sent.url, "/?bootstrap=ticket-1", "the ticket rides through untouched");
    assert.equal(sent.headers.cookie, "vb_session=cookie-value", "the cookie still goes, or nothing can be redeemed");
    assert.equal(sent.headers["sec-fetch-site"], "same-origin", "Sec-Fetch-Site must survive the hop: absence reads as a non-browser caller upstream");
    assert.equal(sent.headers["sec-fetch-mode"], "navigate");
    assert.equal(sent.headers["sec-fetch-dest"], "document");
    assert.equal(sent.headers["x-voicebox-proxied-origin"], "http://localhost:5173", "the browser's own Origin is preserved as evidence");
    assert.equal(sent.headers.origin, "http://127.0.0.1:" + upstream.port, "and the Origin itself is this front's, per the /api hop's rule");
  }
});

test("a MUTATING request cannot ride ?bootstrap= into the API — it falls through to the ordinary hop (voicebox-beads-jbh2)", async () => {
  {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const outcome = await drive(middleware, { method, url: "/api/branches/merge?bootstrap=1", headers: BROWSER });
      assert.equal(outcome.passedThrough, true, `${method} must NOT be intercepted by the bootstrap hop`);
    }
    assert.deepEqual(upstream.seen, [], "and nothing reached the API through this middleware: the ordinary hop judges it");
  }
});

test("a request without ?bootstrap= is untouched — the middleware is not a general proxy (voicebox-beads-jbh2)", async () => {
  {
    const outcome = await drive(middleware, { method: "GET", url: "/", headers: BROWSER });
    assert.equal(outcome.passedThrough, true, "only a ticketed navigation is this middleware's business");
    assert.deepEqual(upstream.seen, []);
  }
});

test("a foreign Origin on a ticketed navigation is forwarded as itself, never laundered (voicebox-beads-jbh2)", async () => {
  {
    const hostile = { ...BROWSER, origin: "http://evil.example", host: "localhost:5173", "sec-fetch-site": "cross-site" };
    await drive(middleware, { method: "GET", url: "/?bootstrap=ticket-2", headers: hostile });
    const sent = upstream.seen[0];
    assert.equal(sent.headers.origin, "http://evil.example", "a foreign Origin is NOT rewritten into this front's: the same rule the /api hop applies");
    assert.equal(sent.headers["x-voicebox-proxied-origin"], "http://evil.example");
    assert.equal(sent.headers["sec-fetch-site"], "cross-site", "and the browser's own verdict rides along");
  }
});
