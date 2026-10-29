// tests/environments-fence-authority.test.mjs — voicebox-beads-e5u6.
//
//   node --test tests/environments-fence-authority.test.mjs
//
// POST /api/environments with fence:true / fence:"l15" BOOTS: it mints a vbx_ call bearer and
// spawns a bwrap fence or a systemd --user unit on the host. Before e5u6 the only door was the
// JSON Content-Type check — any local process (and any cross-site form that could pass it) could
// mint and boot. The boot is the host's act, so it now takes the same authority the privileged
// environment surfaces already hold: the host token or an authorized in-room session.
//
// These cases need neither bwrap nor systemd: the refusal lands BEFORE any boot is attempted,
// and that ordering is part of what is asserted — nothing is minted, nothing is listed, and no
// sandbox home is created for the refused key.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./lib/server.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let scratch;
let homes;
const previousHomes = process.env.VOICEBOX_SANDBOX_HOMES;

test.before(() => {
  scratch = mkdtempSync(path.join(os.homedir(), ".voicebox-fence-auth-test-"));
  homes = path.join(scratch, "sandbox-homes");
  mkdirSync(homes, { recursive: true });
  process.env.VOICEBOX_SANDBOX_HOMES = homes;
});

test.after(() => {
  try {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  } finally {
    if (previousHomes === undefined) delete process.env.VOICEBOX_SANDBOX_HOMES;
    else process.env.VOICEBOX_SANDBOX_HOMES = previousHomes;
  }
});

async function declareFence(base, fence, headers = {}) {
  const res = await fetch(`${base}/api/environments`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ label: "uncredentialed fence", kind: "fence", origin: "http://127.0.0.1:1", fence }),
  });
  return { status: res.status, body: await res.json() };
}

for (const fence of [true, "l15"]) {
  test(`fence:${JSON.stringify(fence)} without authority is refused and NOTHING boots (voicebox-beads-e5u6)`, async () => {
    const ws = path.join(scratch, `ws-${String(fence)}`);
    mkdirSync(ws, { recursive: true });
    const server = await startServer({ env: { VOICEBOX_WORKSPACE: ws }, cwd: scratch });
    try {
      const refused = await declareFence(server.base, fence);
      assert.equal(refused.status, 403, `expected 403, got ${refused.status}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.ok, false);
      assert.equal(refused.body.refused, "host-token-required");

      // Nothing was recorded: the read-back list holds no row for the refused declaration.
      const { environments } = await (await fetch(`${server.base}/api/environments`)).json();
      assert.equal(environments.find((e) => e.label === "uncredentialed fence"), undefined,
        "a refused fence boot must not leave a row in the registry");

      // Nothing was spawned: no sandbox home appeared for any key (the refusal precedes the boot).
      assert.deepEqual(readdirSync(homes), [], "a refused fence boot must not create a sandbox home");
    } finally {
      await server.stop();
    }
  });
}

test("a spoofed LOOPBACK Origin is not authority either (rev-e5u6's bypass, voicebox-beads-e5u6)", async () => {
  // Origin is a plain header: any local process can write the server's own origin on a raw
  // socket (docs/13 §1). The first version of this gate accepted it via hasExtensionAuthority's
  // local-page clause; the reviewer reproduced the bypass on the pinned sha. The fence boot now
  // takes a credential — host token or the in-room session token — never a header claim.
  const ws = path.join(scratch, "ws-spoofed-origin");
  mkdirSync(ws, { recursive: true });
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: ws }, cwd: scratch });
  try {
    const spoofed = await declareFence(server.base, "l15", {
      origin: server.base, // the server's OWN loopback origin — the forgery
      "sec-fetch-site": "same-origin",
    });
    assert.equal(spoofed.status, 403, `spoofed loopback Origin must not boot: ${JSON.stringify(spoofed.body)}`);
    assert.equal(spoofed.body.refused, "host-token-required");
    const crossSite = await declareFence(server.base, true, {
      origin: "http://evil.example",
      "sec-fetch-site": "cross-site",
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.refused, "host-token-required");
  } finally {
    await server.stop();
  }
});

test("the openly-served in-room session token is NOT authority (rev-e5u6 round 2, voicebox-beads-e5u6)", async () => {
  // The page's session token is minted into GET / with no gate (loopback auth defaults OFF), so
  // any local process can scrape and replay it — this test does exactly that, and the boot must
  // still refuse. The token distinguishes browser contexts; spawning a sandbox needs the host
  // token, the one credential that lives only in the host's 0600 directory.
  const ws = path.join(scratch, "ws-session");
  mkdirSync(ws, { recursive: true });
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: ws }, cwd: scratch });
  try {
    const html = await (await fetch(`${server.base}/`)).text();
    const token = html.match(/name="voicebox-session-token" content="([^"]+)"/)?.[1];
    assert.ok(token && token !== "__VOICEBOX_SESSION_TOKEN__", "the served page carries a minted session token");
    const replayed = await declareFence(server.base, "l15", { "x-voicebox-session-token": token });
    assert.equal(replayed.status, 403, `a scraped session token must not boot: ${JSON.stringify(replayed.body)}`);
    assert.equal(replayed.body.refused, "host-token-required");

    // The host token DOES pass the gate — what happens past it is the fence's own business
    // (502 unit-unavailable where no systemd --user manager exists, a booted fence where it
    // does); the gate is what is on test.
    const withToken = await declareFence(server.base, "l15", { "x-voicebox-host-token": server.hostToken });
    assert.notEqual(withToken.status, 403, `the host token must pass the gate: ${JSON.stringify(withToken.body)}`);
    assert.notEqual(withToken.body.refused, "host-token-required");
  } finally {
    await server.stop();
  }
});

test("declaring WITHOUT fence stays on the JSON door (no authority needed, nothing boots)", async () => {
  const ws = path.join(scratch, "ws-plain");
  mkdirSync(ws, { recursive: true });
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: ws }, cwd: scratch });
  try {
    const declared = await fetch(`${server.base}/api/environments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "plain box", kind: "server", origin: "http://127.0.0.1:1" }),
    }).then((r) => r.json());
    assert.equal(declared.ok, true, `plain declare must keep working: ${JSON.stringify(declared)}`);
    assert.equal(declared.environment.label, "plain box");
    assert.equal(declared.booted, undefined, "a plain declare boots nothing");
  } finally {
    await server.stop();
  }
});
