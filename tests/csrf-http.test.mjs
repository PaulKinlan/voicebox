// One request-level browser CSRF boundary: bodyless and bespoke-parser API routes (voicebox-beads-3bwx).
// Every test owns its server and workspace; no global browser or machine state is shared.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './lib/server.mjs';

const attacker = { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' };

async function isolatedServer(t, env = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voicebox-csrf-http-'));
  const workspace = path.join(scratch, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const server = await startServer({ cwd: scratch, env: { VOICEBOX_WORKSPACE: workspace, ...env } });
  t.after(async () => {
    await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  return { server, workspace };
}

async function postTools(base, appId, headers) {
  return fetch(`${base}/api/mini-app/tools`, {
    method: 'POST', headers,
    body: JSON.stringify({ appId, title: 'CSRF test app', tools: [
      { name: 'csrf_test_tool', description: 'Should not be registered cross-site', parameters: { type: 'object', properties: {} } },
    ] }),
  });
}

const getTools = async (base) => (await fetch(`${base}/api/mini-app/tools`).then((res) => res.json())).tools;

// POST /api/undo reads no request body, so the JSON Content-Type door never sees it.
test('a cross-site browser-simple POST cannot undo a persisted write; machine and same-origin callers can', async (t) => {
  const { server, workspace } = await isolatedServer(t);
  const root = await fetch(`${server.base}/api/root`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-voicebox-host-token': server.hostToken },
    body: JSON.stringify({ project: 'csrf-undo', root: { kind: 'machine', path: workspace } }),
  });
  assert.equal(root.status, 200);
  const file = path.join(workspace, 'keep.txt');
  const wrote = await fetch(`${server.base}/api/file`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'keep.txt', content: 'keep this write\n' }),
  });
  assert.equal(wrote.status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep this write\n');
  assert.equal((await fetch(`${server.base}/api/undo`).then((res) => res.json())).canUndo, true);
  const crossSiteRead = await fetch(`${server.base}/api/undo`, { headers: attacker });
  assert.equal(crossSiteRead.status, 200, 'ordinary reads are not mutation-gated');
  assert.equal((await crossSiteRead.json()).canUndo, true);

  const refused = await fetch(`${server.base}/api/undo`, { method: 'POST', headers: attacker });
  assert.equal(fs.existsSync(file), true, 'a cross-site request must not remove the file');
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).refused, 'cross-origin-request-refused');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep this write\n');
  assert.equal((await fetch(`${server.base}/api/undo`).then((res) => res.json())).canUndo, true);

  const machine = await fetch(`${server.base}/api/undo`, { method: 'POST' });
  assert.equal(machine.status, 200);
  assert.equal(fs.existsSync(file), false);

  // A real page's own Origin is also allowed to perform the ordinary undo action.
  const wroteAgain = await fetch(`${server.base}/api/file`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'keep.txt', content: 'page write\n' }),
  });
  assert.equal(wroteAgain.status, 200);
  const page = await fetch(`${server.base}/api/undo`, {
    method: 'POST', headers: { origin: server.base, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(page.status, 200);
  assert.equal(fs.existsSync(file), false);
});

test('a cross-site POST or cache-miss GET cannot start a probe or write its cache; machine clients can', async (t) => {
  const { server, workspace } = await isolatedServer(t);
  const cache = path.join(workspace, 'probe.json');
  assert.equal(fs.existsSync(cache), false);
  for (const [method, suffix] of [['POST', ''], ['GET', '?refresh=1'], ['GET', '']]) {
    const refused = await fetch(`${server.base}/api/probe${suffix}`, { method, headers: attacker });
    assert.equal(fs.existsSync(cache), false, `${method} /api/probe${suffix} must not write a cross-site probe cache`);
    assert.equal(refused.status, 403, `${method} /api/probe${suffix} must not run a cross-site probe`);
    assert.equal((await refused.json()).refused, 'cross-origin-request-refused');
  }
  const machine = await fetch(`${server.base}/api/probe`, { method: 'POST' });
  assert.equal(machine.status, 200);
  assert.equal(fs.existsSync(cache), true);
});

test('a cross-site text/plain tool registration cannot change the registry; own page and unheaded machine calls can', async (t) => {
  const { server } = await isolatedServer(t);
  const base = server.base;
  const own = { origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  assert.deepEqual(await getTools(base), []);
  for (const headers of [
    { ...attacker, 'content-type': 'text/plain' },
    { origin: attacker.origin, 'content-type': 'text/plain' }, // pre-Fetch-Metadata browser
    { origin: 'http://127.0.0.1:4444', 'sec-fetch-site': 'same-site', 'content-type': 'text/plain' },
    { origin: 'null', 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
    { origin: attacker.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
    { origin: base, 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, // proxied hostile page
    { origin: base, 'sec-fetch-site': 'none', 'content-type': 'text/plain' },
    { origin: base, 'sec-fetch-site': 'unexpected', 'content-type': 'text/plain' },
  ]) {
    const refused = await postTools(base, 'attacker-app', headers);
    assert.deepEqual(await getTools(base), [], 'a cross-site request must not register a tool');
    assert.equal(refused.status, 403, `refuse ${JSON.stringify(headers)}`);
    assert.equal((await refused.json()).refused, 'cross-origin-request-refused');
  }
  const page = await postTools(base, 'own-app', own);
  assert.equal(page.status, 200);
  assert.equal((await getTools(base)).length, 1);
  // Header-matrix case for a trusted same-site dev-front name. The real proxied dev front is
  // separately driven in Chromium; raw headers alone cannot prove the browser's site value.
  const sameSiteLocalFront = await postTools(base, 'dev-app', {
    origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site', 'content-type': 'application/json',
  });
  assert.equal(sameSiteLocalFront.status, 200);
  assert.equal((await getTools(base)).length, 1);
  const machine = await postTools(base, 'machine-app', { 'content-type': 'application/json' });
  assert.equal(machine.status, 200);
  assert.equal((await getTools(base)).length, 1);
  // A valid host token remains machine authority even if a caller supplies browser-shaped headers.
  const host = await postTools(base, 'host-app', {
    ...attacker, 'content-type': 'text/plain', 'x-voicebox-host-token': server.hostToken,
  });
  assert.equal(host.status, 200);
  assert.equal((await getTools(base)).length, 1);
});

test('the opt-in loopback wall remains first for unauthenticated cross-site mutations', async (t) => {
  const { server } = await isolatedServer(t, { VOICEBOX_LOOPBACK_AUTH: '1' });
  const response = await fetch(`${server.base}/api/undo`, { method: 'POST', headers: attacker });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).refused, 'loopback-unauthenticated');
});
