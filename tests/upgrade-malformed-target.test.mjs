// tests/upgrade-malformed-target.test.mjs — a malformed upgrade target is ANSWERED and CLOSED.
//
// voicebox-beads-kckr: the upgrade handler parsed `new URL(req.url, base)` bare. An absolute-form
// target like `http://[` throws ERR_INVALID_URL inside the listener; the process-wide
// `uncaughtException` logger caught the throw but nothing destroyed the socket, so the connection
// was RETAINED — a raw-TCP local client could park connections the server had not parsed.
//
// The filed repro counted "one retained connection at 250ms", which is not proof of exhaustion, so
// this test asserts the two things that are decidable: the socket CLOSES (by event, not by a sleep
// and a count) and the PROCESS IS STILL HEALTHY afterwards (another upgrade path still answers).
//
//   node --test tests/upgrade-malformed-target.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startServer } from "./lib/server.mjs";

/** Send raw bytes at the server's listener and report what became of the connection. */
function rawUpgrade(port, requestLine, { holdMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const outcome = { data: "", closed: false, error: null };
    const timer = setTimeout(() => { try { socket.destroy(); } catch {} resolve({ ...outcome, timedOut: true }); }, holdMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${requestLine} HTTP/1.1\r\n` +
        "Host: 127.0.0.1\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => { outcome.data += chunk; });
    // `end` is the peer closing; `close` is the local socket fully closed. Either proves the
    // server let go — the defect was that NEITHER happened.
    socket.on("end", () => { outcome.peerEnded = true; });
    socket.on("close", () => { outcome.closed = true; clearTimeout(timer); resolve(outcome); });
    socket.on("error", (e) => { outcome.error = e.code ?? String(e); });
  });
}

test("a malformed absolute-form upgrade target gets 400 and the socket is CLOSED (voicebox-beads-kckr)", { timeout: 60000 }, async (t) => {
  const server = await startServer({ env: { VOICEBOX_INSTANCE: "upgrade-malformed" } });
  t.after(async () => { await server.stop(); });
  const port = new URL(server.base).port;

  // The filed repro's literal, plus a sibling malformed shape, so the guard is a guard and not a
  // special case for one string.
  for (const target of ["http://[", "http://[::1"]) {
    const outcome = await rawUpgrade(port, `GET ${target}`);
    assert.equal(outcome.timedOut ?? false, false, `'${target}': the socket must not be left open (outcome ${JSON.stringify(outcome)})`);
    assert.equal(outcome.closed, true, `'${target}': the connection must close, not be retained`);
    assert.match(outcome.data, /^HTTP\/1\.1 400 Bad Request/, `'${target}': answered 400, not silence (got ${JSON.stringify(outcome.data.slice(0, 60))})`);
  }

  // THE PROCESS IS STILL HEALTHY, and the normal path still works: a plain HTTP request is served
  // (the malformed upgrades did not poison the server or the event loop).
  const health = await fetch(`${server.base}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true, "the process is still serving after the malformed upgrades");

  // And a WELL-FORMED upgrade is still handled by the same handler — the guard must not swallow
  // the legitimate path. A well-formed /live connection is legitimately HELD OPEN (the server is
  // waiting for the hello entitlement frame), so the decidable claim here is NOT "it closed": it
  // is "the guard did not fire" — no 400, no parse error, the socket accepted and held.
  const good = await rawUpgrade(port, "GET /live", { holdMs: 1500 });
  // POSITIVE, not a negative regex (review nit): a broken /live answering nothing, 404 or 500
  // would have satisfied 'not 400'. The handshake happens before the hello gate, so 101 is the
  // observable that says the guard did not swallow the legitimate path.
  assert.match(good.data ?? "", /^HTTP\/1\.1 101 Switching Protocols/, `a well-formed /live upgrade must complete the handshake (got ${JSON.stringify((good.data ?? "").slice(0, 60))})`);
  assert.equal(good.error ?? null, null, "and it must not error");
});
