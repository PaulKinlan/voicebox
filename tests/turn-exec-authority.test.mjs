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

// ── the transcript path can reach the shell too (voicebox-beads-zqsr) ────────────────────────────────────────────
//
// udjb gated only an EXPLICIT action, on the argument that a transcript turn is "the room's own flow". Half right:
// the page cannot hold the HOST token, but it does hold the ROOM token and its own request helper already sends it
// (public/fused.js sends x-voicebox-session-token on every call, /api/turn included). So the transcript path is
// gated on the room credential, which costs the page nothing and closes the credential-free shell.

async function roomSessionToken(base) {
  const html = await (await fetch(`${base}/`)).text();
  const match = /<meta name="voicebox-session-token" content="([0-9a-f]{8,})"/.exec(html);
  assert.ok(match, "the room's session token is no longer served in the page; this test's premise changed");
  return match[1];
}

test("a transcript that resolves to exec is refused without the room's own credential (voicebox-beads-zqsr)", async () => {
  await withServer(async ({ server, scratch }) => {
    const marker = path.join(scratch, "transcript-marker.txt");
    for (const [what, headers] of [
      ["no headers at all", {}],
      ["an Origin claim", { origin: "http://127.0.0.1:1" }],
      ["a guessed in-room session token", { "x-voicebox-session-token": "guessed" }],
    ]) {
      const res = await turn(server, { transcript: `run command touch ${JSON.stringify(marker)}` }, headers);
      assert.equal(res.status, 403, `${what} must not reach the shell through a transcript`);
      const body = await res.json();
      assert.equal(body.refused, "room-session-required", `${what} must be refused by name`);
      assert.match(body.why, /x-voicebox-session-token/, "the refusal names the credential it wants");
      assert.equal(fs.existsSync(marker), false, `${what}: the command must not have run`);
    }
  });
});

test("the room's own session token still runs an exec transcript — the page's flow is not broken (voicebox-beads-zqsr)", async () => {
  await withServer(async ({ server, scratch }) => {
    const marker = path.join(scratch, "transcript-marker-room.txt");
    const token = await roomSessionToken(server.base);
    const res = await turn(server, { transcript: `run command touch ${JSON.stringify(marker)}` }, { "x-voicebox-session-token": token });
    assert.equal(res.status, 200, "the room's own turn must run");
    const body = await res.json();
    assert.equal(body.action?.verb, "exec");
    assert.equal(body.result?.ok, true, JSON.stringify(body.result));
    assert.equal(fs.existsSync(marker), true, "the command really ran: the positive control");
    // The host token is the other legitimate holder, and it is the only one the page cannot present.
    const byHost = path.join(scratch, "transcript-marker-host.txt");
    const hostRes = await turn(server, { transcript: `run command touch ${JSON.stringify(byHost)}` }, { "x-voicebox-host-token": server.hostToken });
    assert.equal(hostRes.status, 200);
    assert.equal(fs.existsSync(byHost), true);
  });
});

test("a transcript with a read verb still needs no credential at all (voicebox-beads-zqsr)", async () => {
  await withServer(async ({ server, workspace }) => {
    fs.writeFileSync(path.join(workspace, "plain.txt"), "the room's dictation must keep working");
    for (const transcript of ["read plain.txt", "list files"]) {
      const res = await turn(server, { transcript });
      assert.equal(res.status, 200, `'${transcript}' must not need a credential: the page cannot always hold one`);
      const body = await res.json();
      assert.notEqual(body.refused, "room-session-required", `'${transcript}' is not an exec verb`);
    }
  });
});
