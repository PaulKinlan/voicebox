import test from "node:test";
import assert from "node:assert/strict";
import { closeAcpFixture } from "./lib/acp-fixture-cleanup.mjs";

// Model the one property of Node's HTTP server needed here: close() cannot finish while a
// connection is active, whether it was a request in flight or an unanswered preconnect.
// Keep this pure so these guards run in the parallel unit lane, not a second live server file.
for (const [scenario, pageReleasesConnection] of [
  ["page releases its connection", true],
  ["context disposal leaves its connection open", false],
]) {
  test(`ACP fixture teardown releases a held connection when ${scenario}`, { timeout: 2000 }, async () => {
    let pageClosed = false;
    let active = true;
    let accepting = true;
    let finish;
    const release = () => {
      active = false;
      if (finish) finish();
    };
    const server = {
      closeAllConnections() {
        assert.equal(accepting, false, "stop accepting before sweeping held sockets");
        release();
      },
      close(callback) {
        accepting = false;
        finish = () => { finish = undefined; callback(); };
        if (!active) finish();
      },
    };
    const page = { async close() {
      pageClosed = true;
      if (pageReleasesConnection) release();
    } };
    const cleanup = closeAcpFixture(page, server);
    let timer;
    try {
      const result = await Promise.race([
        cleanup.then(() => "closed"),
        new Promise((resolve) => { timer = setTimeout(() => resolve("blocked"), 100); }),
      ]);
      assert.equal(result, "closed", `${scenario}: cleanup must not wait on a held connection`);
      assert.equal(pageClosed, true, "the page is closed before the server");
    } finally {
      clearTimeout(timer);
      release(); // even a deliberately broken cleanup cannot strand the test process
      await cleanup;
    }
  });
}
