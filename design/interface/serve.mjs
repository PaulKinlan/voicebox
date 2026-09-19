#!/usr/bin/env node
// Static study server, anchored to this file rather than the caller's cwd.
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.argv[2] ?? 18088);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.md': 'text/plain', '.txt': 'text/plain' };
function stamp() {
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return `${git('branch', '--show-current') || 'detached'} @ ${git('rev-parse', '--short=12', 'HEAD')}${git('status', '--porcelain') ? ' · modified' : ''}`;
  } catch { return 'Unstamped static copy'; }
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('Read-only study server'); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/build-stamp.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`document.getElementById('build-stamp').textContent = ${JSON.stringify(stamp())};`);
      return;
    }
    const path = await realpath(resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); res.end('Outside the study'); return; }
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': `${types[extname(path)] ?? 'application/octet-stream'}${['.html', '.css', '.js', '.mjs', '.md', '.txt'].includes(extname(path)) ? '; charset=utf-8' : ''}` });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found in this study'); }
});
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Voicebox interface study: http://127.0.0.1:${server.address().port}/`));
