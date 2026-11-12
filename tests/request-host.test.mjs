// tests/request-host.test.mjs — the server answers only to its own names (voicebox-beads-cwx5).
//
// The finding, measured before the fix: a request shaped the way a DNS-rebinding page's requests are shaped
// (`Host: evil.example:<port>`, a matching Origin, `Sec-Fetch-Site: same-origin`, a JSON body) passed the JSON
// door and the browser-mutation check, and `POST /api/exec` RAN the command. The control arm below sends the
// same request to the server's own name and expects it to run, so the refusal is the Host and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer } from "./lib/server.mjs";
import { createHostGate, normalizeHost, parseAllowedHosts } from "../lib/request-host.mjs";

test("the gate allows the loopback names on any port and exactly the configured hosts", () => {
  const gate = createHostGate({ extraHosts: ["tunnel.example", "voice.example:8443"] });
  for (const ok of ["127.0.0.1:8787", "localhost:8787", "LOCALHOST:8787", "[::1]:8787", "localhost:5173", "127.0.0.1:49152", "127.0.0.1", "localhost", "192.168.1.20:5173", "100.64.0.7:5173", "[fd7a:115c:a1e0::1]:5173", "box.tailnet.ts.net", "box.tailnet.ts.net:8443", "tunnel.example", "voice.example:8443"]) {
    assert.equal(gate.allowed(ok), true, `${ok} must be allowed`);
  }
  for (const bad of [
    "evil.example:8787", "evil.example", "127.0.0.1.evil.example:8787", "localhost.evil.example", "evil.localhost:8787",
    "127.0.0.1:8787.evil.example", "127.0.0.1:8787, evil.example", "user@127.0.0.1:8787", "127.0.0.1:8787/x",
    "1.2.3.4.evil.example", "1.2.3:80", " ", "", undefined, null, 7, ["127.0.0.1:8787"],
    "voice.example", "tunnel.example:8787", "ts.net", "evil-ts.net", "box.ts.net.evil.example",
  ]) {
    assert.equal(gate.allowed(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(createHostGate().allowed("tunnel.example"), false, "nothing but loopback and tailnet names is allowed unless configured");
  assert.equal(JSON.stringify(gate.refusal()).includes("evil"), false);
});

test("VOICEBOX_ALLOWED_HOSTS is a comma list of host[:port]; anything else is reported, not guessed at", () => {
  assert.deepEqual(parseAllowedHosts(" Box.Tailnet.ts.net , voice.example:8443,"), { hosts: ["box.tailnet.ts.net", "voice.example:8443"], refused: [] });
  assert.deepEqual(parseAllowedHosts("https://voice.example, *, a b"), { hosts: [], refused: ["https://voice.example", "*", "a b"] });
  assert.deepEqual(parseAllowedHosts(undefined), { hosts: [], refused: [] });
  assert.equal(normalizeHost("[::1]:80"), "[::1]:80");
});

test("a request addressed to a foreign Host runs nothing; the same request to the server's own name does", async (t) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "voicebox-request-host-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const server = await startServer({ env: { VOICEBOX_WORKSPACE: path.join(scratch, "workspace") }, cwd: scratch });
  t.after(() => server.stop());
  const port = Number(new URL(server.base).port);

  const send = (method, pathname, headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
  // What a rebinding page's request looks like to the server: every browser header says "same origin".
  const rebound = (host) => ({ host, origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json" });

  const marker = path.join(scratch, "marker");
  const viaExec = await send("POST", "/api/exec", rebound(`evil.example:${port}`), JSON.stringify({ command: `touch ${marker}-exec` }));
  const viaTurn = await send("POST", "/api/turn", rebound(`evil.example:${port}`), JSON.stringify({ transcript: `run command touch ${marker}-turn` }));
  for (const answer of [viaExec, viaTurn]) {
    assert.equal(answer.status, 403, answer.text);
    assert.equal(JSON.parse(answer.text).refused, "host-not-allowed");
    assert.equal(answer.text.includes("evil.example"), false, "the refusal does not echo the name it was offered");
  }
  assert.equal(existsSync(`${marker}-exec`), false, "POST /api/exec ran a command for a foreign Host");
  assert.equal(existsSync(`${marker}-turn`), false, "POST /api/turn ran a command for a foreign Host");

  // Reads and the page itself are refused too: a rebinding page must not read files or the room's HTML.
  assert.equal((await send("GET", "/", { host: `evil.example:${port}` })).status, 403);
  assert.equal((await send("GET", "/api/health", { host: `evil.example:${port}` })).status, 403);

  // THE CONTROL: the identical request, addressed to the server's own name, is answered as before.
  const own = await send("POST", "/api/exec", rebound(`127.0.0.1:${port}`), JSON.stringify({ command: `touch ${marker}-own` }));
  assert.equal(own.status, 200, own.text);
  assert.equal(existsSync(`${marker}-own`), true, "the control request must still run");
  assert.equal((await send("GET", "/api/health", { host: `localhost:${port}` })).status, 200);

  // A WebSocket upgrade is not bound by CORS at all; it is refused on the raw socket and closed.
  const upgrade = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let seen = "";
    socket.on("data", (chunk) => { seen += chunk; });
    socket.on("close", () => resolve(seen));
    socket.on("error", reject);
    socket.write(`GET /live HTTP/1.1\r\nHost: evil.example:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  assert.match(upgrade, /^HTTP\/1\.1 403 /);
});
