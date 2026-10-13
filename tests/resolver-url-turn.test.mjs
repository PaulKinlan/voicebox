// tests/resolver-url-turn.test.mjs — the SYMPTOM, not just the throw: POST /api/turn with a transcript
// whose "gets <url>" cannot be read used to answer 500.
//
// voicebox-beads-lg5z: `script()` raised ERR_INVALID_URL, and the turn route has no handler between the
// resolver and its answer — `answerOnce` turns any throw into `500 {"refused":"server-error"}` — so a
// spoken phrase with a malformed URL was a server error where the contract is `unresolved`. The unit
// test (tests/resolver-script-url.test.mjs) pins the resolver; THIS pins the outcome the caller
// actually sees, on a real server, because that is where the defect was found and reported.
//
// LIVE lane: it starts a real server, with a scratch cwd and scratch root/extensions so it writes
// nothing into this tree. Every case is driven through the route — no assertion restates the unit.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

const SCRATCH = realpathSync(mkdtempSync(path.join(os.tmpdir(), "voicebox-lg5z-")));

let server;

test.before(async () => {
  server = await startServer({
    cwd: SCRATCH,
    env: {
      VOICEBOX_WORKSPACE: path.join(SCRATCH, "workspace"),
      VOICEBOX_EXTENSIONS_DIR: path.join(SCRATCH, "extensions"),
    },
  });
});

test.after(async () => {
  await server?.stop();
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** The status AND the body: a 500 is the defect, so the status is asserted, never swallowed. */
const turn = async (transcript) => {
  const res = await fetch(`${server.base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript }),
  });
  return { status: res.status, body: await res.json() };
};

test("a malformed URL in a tool phrase is an unresolved turn, never a 500", async () => {
  for (const url of ["http://[bad", "http://example.com:99999", "http://999.999.999.999"]) {
    const { status, body } = await turn(`create a tool called fetchy that gets ${url}`);
    assert.equal(status, 200, `${url} must not be a server error: ${JSON.stringify(body)}`);
    assert.equal(body.action, null, `${url} must not resolve to an action`);
    assert.match(String(body.note ?? ""), /host/, `${url} must come back with a reason`);
    assert.match(String(body.note ?? ""), new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${url} must be named back`);
  }
});

test("a URL that does name a host still resolves to the same tool through the route", async () => {
  const { status, body } = await turn("create a tool called fetchy that gets https://api.example.com/data");
  assert.equal(status, 200);
  assert.equal(body.action?.verb, "make-tool");
  assert.deepEqual(body.action.tool.bounds, { hosts: ["api.example.com"], maxRequests: 5 });
  assert.equal(body.action.tool.tools[0].params.url, "https://api.example.com/data");
});
