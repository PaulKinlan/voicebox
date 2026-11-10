// tests/turn-exec-authority.test.mjs — voicebox-beads-udjb (TM-EXEC-008 family).
//
//   node --test tests/turn-exec-authority.test.mjs
//
// POST /api/turn accepts an `action` object in the request body and executes it. For `exec` (and the `system` verb)
// that is a host shell command, and the route had no authority check at all: an unauthenticated
// {"action":{"verb":"exec","command":"touch <marker>"}} returned 200 and wrote the marker (voicebox-beads-jp4d
// scouted it on a scratch server). These cases drive the REAL server, because the finding is about the route's door:
// the command does not run without the host token, it does run with it, and a transcript turn — the room's own flow —
// still works, which is the half that must not regress.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";

async function withServer(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voicebox-udjb-"));
  const workspace = path.join(scratch, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const server = await startServer({ cwd: scratch, env: { VOICEBOX_WORKSPACE: workspace } });
  try {
    return await fn({ server, workspace, scratch });
  } finally {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const turn = (server, body, headers = {}) =>
  fetch(`${server.base}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("an explicit exec action without the host token is refused and runs NOTHING (voicebox-beads-udjb)", async () => {
  await withServer(async ({ server, scratch }) => {
    const marker = path.join(scratch, "exec-marker.txt");
    for (const [what, headers] of [
      ["no headers at all", {}],
      ["an Origin claim", { origin: "http://127.0.0.1:1" }],
      ["a guessed in-room session token", { "x-voicebox-session-token": "guessed" }],
    ]) {
      const res = await turn(server, { action: { verb: "exec", command: `touch ${JSON.stringify(marker)}` } }, headers);
      assert.equal(res.status, 403, `${what} must be refused`);
      const body = await res.json();
      assert.equal(body.refused, "host-token-required", `${what} must be refused by name`);
      assert.equal(fs.existsSync(marker), false, `${what}: the command must not have run`);
    }
  });
});

test("the host token opens explicit exec, and the positive control is a real command (voicebox-beads-udjb)", async () => {
  await withServer(async ({ server, scratch }) => {
    const marker = path.join(scratch, "exec-marker-host.txt");
    const res = await turn(
      server,
      { action: { verb: "exec", command: `touch ${JSON.stringify(marker)}` } },
      { "x-voicebox-host-token": server.hostToken },
    );
    assert.equal(res.status, 200, "the host token opens the explicit exec door");
    const body = await res.json();
    assert.equal(body.result?.ok, true, JSON.stringify(body.result));
    // The command really ran: without this the refusal arm above could pass against a door that never worked.
    assert.equal(fs.existsSync(marker), true, "the exec action must have created the marker");
  });
});

test("a transcript turn still works — the room's own flow is not gated (voicebox-beads-udjb)", async () => {
  await withServer(async ({ server, workspace }) => {
    // No action object: this is the page's path. The script resolver handles a plain write, and the file appears.
    fs.writeFileSync(path.join(workspace, "existing.txt"), "here");
    const res = await turn(server, { transcript: "read existing.txt" });
    assert.equal(res.status, 200, "a transcript turn must keep working without the host token");
    const body = await res.json();
    assert.ok(body.action, `the transcript must resolve to an action: ${JSON.stringify(body)}`);
    assert.equal(body.action.verb, "read");
    assert.ok(!JSON.stringify(body).includes("host-token-required"), "the transcript path must not be refused");
  });
});

test("the explicit system verb is gated the same way (voicebox-beads-udjb)", async () => {
  await withServer(async ({ server }) => {
    const res = await turn(server, { action: { verb: "system", command: "uname" } });
    assert.equal(res.status, 403, "an explicit system action runs host commands too");
    assert.equal((await res.json()).refused, "host-token-required");
  });
});
