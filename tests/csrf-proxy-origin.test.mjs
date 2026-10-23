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
  const ownUndo = await fetch(`${front}/api/undo`, { method: 'POST', headers: { origin: front } });
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
