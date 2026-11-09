// Legacy (no Fetch Metadata) Origin fallback through the REAL Vite /api proxy (voicebox-beads-3bwx).
// Node supplies synthetic old-browser headers; Chromium cannot be asked to omit Sec-Fetch-Site.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { startServer } from './lib/server.mjs';

const body = JSON.stringify({ appId: 'legacy-browser', tools: [
  { name: 'legacy_hijack', description: 'Must never register', parameters: { type: 'object', properties: {} } },
] });
const getTools = async (base) => (await fetch(`${base}/api/mini-app/tools`).then((r) => r.json())).tools;

test('Vite preserves legacy browser Origin as negative-only evidence before its entitlement rewrite', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voicebox-csrf-proxy-'));
  const workspace = path.join(scratch, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const api = await startServer({ cwd: scratch, env: { VOICEBOX_WORKSPACE: workspace } });
  let vite;
  t.after(async () => {
    await vite?.close();
    await api.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const previousPort = process.env.PORT;
  process.env.PORT = String(api.port);
  try {
    vite = await createViteServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    await vite.listen();
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
  const front = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const file = path.join(workspace, 'keep.txt');
  const cache = path.join(workspace, 'probe.json');
  const declare = await fetch(`${api.base}/api/root`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-voicebox-host-token': api.hostToken },
    body: JSON.stringify({ project: 'legacy-proxy', root: { kind: 'machine', path: workspace } }),
  });
  assert.equal(declare.status, 200);
  const write = await fetch(`${api.base}/api/file`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'keep.txt', content: 'persist\n' }),
  });
  assert.equal(write.status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), 'persist\n');
  assert.equal(fs.existsSync(cache), false);
  assert.deepEqual(await getTools(api.base), []);

  const hostile = 'https://attacker.example';
  for (const [route, content] of [['/api/undo', undefined], ['/api/mini-app/tools', body], ['/api/probe', undefined]]) {
    const headers = { origin: hostile, ...(content ? { 'content-type': 'text/plain' } : {}) };
    const response = await fetch(`${front}${route}`, { method: 'POST', headers, ...(content ? { body: content } : {}) });
    assert.equal(response.status, 403, `old cross-site browser POST ${route} via Vite must not be laundered`);
    assert.equal((await response.json()).refused, 'cross-origin-request-refused');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'persist\n');
  assert.deepEqual(await getTools(api.base), []);
  assert.equal(fs.existsSync(cache), false);

  // A hostile client-supplied header must be clobbered by Vite's actual incoming Origin.
  const spoof = await fetch(`${front}/api/mini-app/tools`, {
    method: 'POST', headers: { origin: hostile, 'content-type': 'text/plain', 'x-voicebox-proxied-origin': front }, body,
  });
  assert.equal(spoof.status, 403);
  assert.deepEqual(await getTools(api.base), []);

  // No Origin on a machine request: Vite removes any client-provided copy and preserves the
  // existing unheaded-machine seam. Valid legacy page Origin: equality to addressed Host passes.
  const unheadedMachine = await fetch(`${front}/api/mini-app/tools`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-voicebox-proxied-origin': hostile }, body,
  });
  assert.equal(unheadedMachine.status, 200);
  const ownPage = await fetch(`${front}/api/mini-app/tools`, {
    method: 'POST', headers: { origin: front, 'content-type': 'application/json' }, body,
  });
  assert.equal(ownPage.status, 200);
  assert.equal((await getTools(api.base)).length, 1);
  const claimedOriginUndo = await fetch(`${front}/api/undo`, { method: 'POST', headers: { origin: front } });
  assert.equal(claimedOriginUndo.status, 403, 'proxy-local Origin alone does not authorize undo');
  assert.equal((await claimedOriginUndo.json()).refused, 'room-session-required');
  assert.equal(fs.existsSync(file), true);
  const html = await fetch(`${api.base}/`).then((response) => response.text());
  const roomToken = html.match(/name="voicebox-session-token" content="([^"]+)"/)?.[1];
  assert.ok(roomToken);
  const ownUndo = await fetch(`${front}/api/undo`, {
    method: 'POST', headers: { origin: front, 'x-voicebox-session-token': roomToken },
  });
  assert.equal(ownUndo.status, 200);
  assert.equal(fs.existsSync(file), false);
  const ownProbe = await fetch(`${front}/api/probe`, { method: 'POST', headers: { origin: front } });
  assert.equal(ownProbe.status, 200);
  assert.equal(fs.existsSync(cache), true);

  // A matching forged proxy header buys NO admission on its own: cross-site metadata still wins.
  const forged = await fetch(`${api.base}/api/mini-app/tools`, {
    method: 'POST', headers: {
      origin: api.base, 'sec-fetch-site': 'cross-site', 'x-voicebox-proxied-origin': api.base,
      'content-type': 'text/plain',
    }, body,
  });
  assert.equal(forged.status, 403);
  const tailscaleStyleFront = 'https://voicebox.example.ts.net';
  // Node fetch deliberately replaces a supplied Host; raw http.request proves the real
  // forwarded Host shape without treating a discarded fetch header as an application failure.
  const httpsHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${api.base}/api/mini-app/tools`, {
      method: 'POST', headers: {
        host: new URL(tailscaleStyleFront).host,
        origin: api.base,
        'x-voicebox-proxied-origin': tailscaleStyleFront,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(httpsHostStatus, 200, 'https front name is compared by host, not by hard-coded http scheme');
});

// ── THE AUTHORITY HOP (voicebox-beads-pdr6) ───────────────────────────────────────────────────────
//
// The finding measured the asymmetry from the outside: through the dev front, a hostile Origin got the
// route's OWN answer (404 refused=extension-not-admitted — authority had been granted), while the same
// request sent straight to the API got 403 refused=host-token-required. The direct answer is the correct
// one: `hasExtensionAuthority()` entitles "the local page" by Origin, and the proxy was manufacturing that
// Origin for anyone. This drives the same pair through the REAL Vite server and the REAL API, with the
// positive control (this front's own page still entitled) beside it.
test('the /api hop entitles only this dev front, so a hostile Origin is refused as itself (voicebox-beads-pdr6)', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voicebox-pdr6-proxy-'));
  const workspace = path.join(scratch, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const api = await startServer({ cwd: scratch, env: { VOICEBOX_WORKSPACE: workspace } });
  let vite;
  t.after(async () => {
    await vite?.close();
    await api.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const previousPort = process.env.PORT;
  process.env.PORT = String(api.port);
  try {
    vite = await createViteServer({ server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    await vite.listen();
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
  const front = `http://127.0.0.1:${vite.httpServer.address().port}`;
  // An authority-gated mutation (server.mjs hasExtensionAuthority → lib/routes/extensions.mjs). The id is not
  // admitted, so an ENTITLED caller gets the route's own 404 and an unentitled one the 403 — the difference the
  // finding measured is exactly which of those answers arrives, not whether something got revoked.
  const revoke = (base, headers) => fetch(`${base}/api/extensions/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ id: 'nope-not-admitted', confirm: true }),
  });
  const answer = async (base, headers) => {
    const response = await revoke(base, headers);
    return { status: response.status, refused: (await response.json()).refused };
  };

  // THE CONTROL: entitlement granted is observable on the direct call (an allowed Origin reaching the route).
  assert.deepEqual(
    await answer(api.base, { origin: api.base }),
    { status: 404, refused: 'extension-not-admitted' },
    'the direct call from the server\'s own page Origin is the entitled answer this test compares against',
  );

  // THE FINDING: the same hostile Origin through the dev front must NOT be entitled.
  assert.deepEqual(
    await answer(front, { origin: 'https://attacker.example' }),
    { status: 403, refused: 'host-token-required' },
    'a hostile Origin through the Vite /api hop was laundered into the room page and the route ran (pdr6)',
  );
  assert.deepEqual(
    await answer(api.base, { origin: 'https://attacker.example' }),
    { status: 403, refused: 'host-token-required' },
    'and the direct call must answer the same way, or the front is still the softer door',
  );

  // A loopback Origin that does not match the addressed Host is unverifiable, not entitled.
  assert.deepEqual(
    await answer(front, { origin: 'http://127.0.0.1:9999' }),
    { status: 403, refused: 'host-token-required' },
    'a falsely-loopback Origin must not buy the authority the WS hops already refuse',
  );

  // THE POSITIVE CONTROL: this front's own page is still entitled through the front, so the fix did not
  // simply close the route for everyone.
  assert.deepEqual(
    await answer(front, { origin: front }),
    { status: 404, refused: 'extension-not-admitted' },
    "the dev front's own page must keep the entitlement its root declaration and settings rely on",
  );

  // A machine caller via the front is not turned into the page: no Origin is minted, so no entitlement.
  assert.deepEqual(
    await answer(front, {}),
    { status: 403, refused: 'host-token-required' },
    'a hop that mints an Origin for an unheaded caller is the same laundering with a different shape',
  );
});
