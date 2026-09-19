#!/usr/bin/env node
// Dependency-free browser acceptance for the UI simulation, not the real agent.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('.', import.meta.url));
if (!process.argv[2]) throw new Error('Supply a NEW evidence directory.');
const out = resolve(process.argv[2]);
await mkdir(out); // Deliberately refuses to overwrite a prior run.
const profile = await mkdtemp(join(tmpdir(), 'voicebox-study-'));
const checks = [];
const captures = [];
const errors = [];
const requests = [];
let browser, server, cdp;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const revision = git('rev-parse', 'HEAD');
const sourceStatus = git('status', '--porcelain');
const check = (name, value) => { checks.push({ name, passed: !!value }); assert.ok(value, name); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function lineFrom(stream, regex) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => { stream.off('data', data); reject(new Error(`Startup deadline: ${text}`)); }, 10000);
    function data(chunk) {
      text += chunk;
      const match = text.match(regex);
      if (match) { clearTimeout(timer); stream.off('data', data); resolve(match[1]); }
    }
    stream.on('data', data);
  });
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.session = null;
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) { const p = this.pending.get(m.id); if (!p) return; clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
      else if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
    };
  }
  call(method, params = {}, session = this.session) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP deadline: ${method}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
  }
}
async function evaluate(expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function until(expression, limit = 10000) {
  const start = Date.now();
  while (Date.now() - start < limit) { if (await evaluate(expression)) return; await delay(50); }
  throw new Error(`Condition not reached: ${expression}`);
}
async function click(selector) {
  const q = JSON.stringify(selector);
  const point = await evaluate(`(() => { const e = document.querySelector(${q}); if (!e || e.disabled) throw new Error('Missing/disabled target: ' + ${q}); e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}); const b=e.getBoundingClientRect(); const x=b.left+b.width/2,y=b.top+b.height/2; const hit=document.elementFromPoint(x,y); if (!(e===hit || e.contains(hit))) throw new Error('Unreachable: '+${q}); return {x,y}; })()`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function key(key, code = key) {
  const v = ({ Escape: 27, Enter: 13, Tab: 9, End: 35, Home: 36, ArrowDown: 40 })[key];
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: v });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: v });
}
async function viewport(width, height) {
  await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}
async function screenshot(name) {
  await evaluate('document.fonts.ready');
  await evaluate('window.scrollTo(0,0)');
  const metrics = await cdp.call('Page.getLayoutMetrics');
  const content = metrics.cssContentSize;
  const image = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: content.width, height: content.height, scale: 1 } });
  await writeFile(join(out, name), Buffer.from(image.data, 'base64'));
  captures.push({ file: name, viewport: await evaluate('({width:innerWidth,height:innerHeight})'), fullPage: true });
}
async function selectValue(selector, position) { await click(selector); await key(position); await key('Enter'); }
async function finishChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const finished = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
  if (!finished && child.exitCode === null) { child.kill('SIGKILL'); await exited; }
}
try {
  server = spawn(process.execPath, [join(root, 'serve.mjs'), '0'], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await lineFrom(server.stdout, /(http:\/\/127\.0\.0\.1:\d+\/)/);
  check('server works from an unrelated cwd', (await fetch(url)).status === 200);
  check('malformed URL is a bounded 404', (await fetch(url + '%ZZ')).status === 404);
  check('server still serves after malformed URL', (await fetch(url)).status === 200);
  const chrome = process.env.CHROME || '/usr/bin/chromium';
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await lineFrom(browser.stderr, /DevTools listening on (ws:\/\/[^\s]+)/);
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  cdp = new CDP(ws);
  const version = await cdp.call('Browser.getVersion');
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
  cdp.session = (await cdp.call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await cdp.call('Page.enable'); await cdp.call('Runtime.enable'); await cdp.call('Network.enable');
  await viewport(1440, 900);
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.call('Page.navigate', { url });
  await until(`document.getElementById('build-stamp')?.textContent.includes(${JSON.stringify(revision.slice(0,12))}) && document.getElementById('extension-inventory')?.textContent.length > 0`);
  check('honest study label present', await evaluate(`document.getElementById('demo-note').textContent.includes('no audio or real work')`));
  check('default project is browser-only', await evaluate(`document.getElementById('project-name').textContent === 'fieldnotes@this-browser'`));
  await screenshot('desktop-studio.png');
  await click('nav [data-view="beside"]');
  await click('[data-open="note"]');
  check('Beside changes the primary object, not merely its colours', await evaluate(`document.querySelector('.object.selected').dataset.artifact === 'note' && !document.querySelector('dialog[open]')`));
  await screenshot('desktop-beside.png');
  await click('nav [data-view="return"]');
  check('Return keeps all assets without replay', await evaluate(`document.querySelector('.return-intro').hidden === false && document.querySelectorAll('[data-artifact]:not([hidden])').length === 3`));
  await screenshot('desktop-return.png');
  await click('nav [data-view="studio"]');
  await click('#play');
  check('creation starts with an empty asset field', await evaluate(`document.querySelectorAll('[data-artifact]:not([hidden])').length === 0`));
  await screenshot('creation-empty.png');
  await until(`document.querySelectorAll('[data-artifact]:not([hidden])').length === 1`);
  await click('#pause');
  await delay(2100);
  check('Pause holds the exact asset count past the next scheduled arrival', await evaluate(`document.querySelectorAll('[data-artifact]:not([hidden])').length === 1 && document.getElementById('pause').textContent === 'Resume work'`));
  await screenshot('creation-paused.png');
  await click('#pause');
  await click('#interrupt');
  await until(`document.querySelectorAll('[data-artifact]:not([hidden])').length === 2`);
  await click('[data-open="page"]');
  const focus = await evaluate('document.activeElement.outerHTML');
  await until(`document.querySelectorAll('[data-artifact]:not([hidden])').length === 3`);
  check('interrupting speech does not cancel work', await evaluate(`document.getElementById('interrupt').disabled && document.body.dataset.work === 'ready'`));
  check('an arriving asset does not steal inspection focus', await evaluate('document.activeElement.outerHTML') === focus);
  await key('Escape');
  check('native Escape closes the inspector', await evaluate(`!document.querySelector('dialog[open]')`));
  check('dialog restores focus to its invoking object', await evaluate(`document.activeElement.matches('[data-open="page"]')`));
  check('resuming creates exactly three unique objects', await evaluate(`document.querySelectorAll('[data-artifact]').length === 3`));
  await screenshot('creation-complete.png');
  await click('#decision-review');
  await screenshot('tool-review.png');
  await click('#deny');
  check('denial remains readable and grants no example admission', await evaluate(`document.getElementById('review-result').textContent.startsWith('Not enabled') && document.getElementById('allow').disabled && document.getElementById('tool-state').textContent === 'Made · not enabled'`));
  await key('Escape');
  await click('#project-open'); await click('[data-project="machine"]');
  await click('#people-open');
  check('machine project names two sessions and queued writes', await evaluate(`document.getElementById('people-count').textContent === '2 sessions' && document.getElementById('machine-people').textContent.includes('waits behind')`));
  await screenshot('machine-presence.png');
  await click('#people-review');
  check('remote request identifies its originating project and root', await evaluate(`document.getElementById('request-origin').textContent.includes('Chat session · fieldnotes@box · root sorter')`));
  await click('#answered-elsewhere');
  check('another instance answering makes the stale response unpressable', await evaluate(`document.getElementById('allow').disabled && document.getElementById('deny').disabled && document.getElementById('review-result').textContent.includes('Already answered')`));
  await key('Escape');
  await click('#play'); await until(`document.body.dataset.work === 'ready'`);
  await click('#decision-review'); await click('#allow');
  check('positive explicit decision enables only the sample state', await evaluate(`document.getElementById('tool-state').textContent === 'Enabled here · sample' && document.getElementById('allow').disabled`));
  await key('Escape');
  await click('#people-open'); await click('#merge-open'); await click('#keep-separate');
  check('refusing the merge keeps both roots', await evaluate(`document.getElementById('merge-result').textContent.includes('Neither root was deleted') && document.getElementById('merge-accept').disabled`));
  await screenshot('merge-refused.png'); await key('Escape');
  await click('#play'); await until(`document.body.dataset.work === 'ready'`);
  await click('#people-open'); await click('#merge-open'); await click('#merge-accept');
  check('merge requires its own explicit decision', await evaluate(`document.getElementById('merge-result').textContent === 'Merged in the study. No files changed.'`));
  await key('Escape');
  await click('#project-open'); await click('[data-project="browser"]');
  check('switching environments did not copy the machine admission', await evaluate(`document.getElementById('tool-state').textContent === 'Made · not enabled'`));
  await click('#settings-open');
  check('browser example does not offer Git undo', await evaluate(`document.querySelector('#undo-kind option[value="worktree"]').disabled && document.querySelector('#undo-kind option[value="git-branch"]').disabled`));
  await selectValue('#undo-kind', 'End');
  check('no undo is visible and withholds unprompted writes', await evaluate(`document.getElementById('play').disabled && document.getElementById('work-status').textContent.includes('No automatic undo')`));
  await selectValue('#undo-kind', 'Home');
  await click('#extensions-open');
  await selectValue('#package-example', 'End');
  check('shell-dependent package cannot be installed', await evaluate(`document.getElementById('install-example').disabled && document.getElementById('package-enforced').textContent.includes('Not grantable')`));
  check('source identity follows the selected package', await evaluate(`document.getElementById('package-origin').textContent.startsWith('build-helper 1.0')`));
  await screenshot('extension-unavailable.png');
  await click('#reject-example');
  check('declining a sideload leaves inventory empty', await evaluate(`document.getElementById('extension-inventory').textContent.startsWith('No third-party')`));
  await selectValue('#package-example', 'Home');
  await click('#extensions-dialog summary');
  check('complete illustrative source is inspectable as text', await evaluate(`document.getElementById('package-source').textContent.includes('(module') && document.getElementById('package-source').textContent.includes('call $write))')`));
  await screenshot('extension-review.png');
  await click('#install-example');
  check('explicit compatible sideload enters the example inventory', await evaluate(`document.getElementById('extension-inventory').textContent.includes('publisher unverified') && document.getElementById('extension-result').textContent.includes('No files changed') && document.getElementById('install-example').disabled`));
  check('installed package cannot later be labelled not installed by decline', await evaluate(`document.getElementById('reject-example').disabled`));
  await key('Escape');
  await click('#type-open'); await click('#utterance');
  const payload = '<img src=x onerror="document.title=\'INJECTED\'">';
  await cdp.call('Input.insertText', { text: payload });
  await click('#text-form button[type="submit"]');
  await click('#logs-open');
  check('typed outside text reaches the log literally', await evaluate(`document.getElementById('event-log').textContent.includes(${JSON.stringify(payload)})`));
  check('typed markup does not become DOM or execute', await evaluate(`!document.querySelector('#event-log img') && document.title === 'Voicebox — interface study'`));
  await key('Escape');
  await click('#settings-open'); await click('#disconnect');
  check('disconnect exposes unconfirmed state with mic off', await evaluate(`document.getElementById('voice-state').textContent === 'Disconnected · mic off' && document.getElementById('decision-review').disabled`));
  await click('#mic');
  check('reconnect does not restart the microphone', await evaluate(`document.getElementById('mic').getAttribute('aria-pressed') === 'false' && document.getElementById('voice-state').textContent === 'Mic off · still here'`));
  await click('#play'); await until(`document.body.dataset.work === 'ready'`);
  await viewport(390, 844); await screenshot('mobile-studio.png');
  check('phone has no horizontal page overflow', await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  check('phone asset content remains inside its preview', await evaluate(`[...document.querySelectorAll('.artifact-open > div')].every(e => [...e.children].every(c => c.getBoundingClientRect().bottom <= e.getBoundingClientRect().bottom))`));
  await click('#decision-review'); await click('#deny'); await key('Escape');
  check('phone decision can be reached and answered natively', await evaluate(`document.getElementById('tool-state').textContent === 'Made · not enabled'`));
  await viewport(844, 390); await click('#settings-open');
  await click('#extensions-open'); await click('#extensions-dialog [data-close]');
  check('short-landscape inspector close is reachable', await evaluate(`!document.querySelector('dialog[open]')`));
  await screenshot('landscape-studio.png');
  check('landscape has no horizontal page overflow', await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  check('short landscape keeps the microphone in the first viewport', await evaluate(`(() => {const r=document.getElementById('mic').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;})()`));
  await key('Tab');
  check('native Tab reaches a visible interactive control', await evaluate(`document.activeElement.matches('button,a,input,select,textarea') && document.activeElement.getBoundingClientRect().height > 0`));
  await viewport(1440, 900); await click('#settings-open'); await click('input[name="theme"][value="light"]'); await key('Escape');
  await screenshot('desktop-light.png');
  check('explicit light appearance overrides system dark', await evaluate(`getComputedStyle(document.documentElement).colorScheme === 'light'`));
  check('no uncaught browser exception', errors.length === 0);
  check('no off-origin page requests', requests.every((r) => r.startsWith(url) || r === 'about:blank'));
  await writeFile(join(out, 'browser.json'), JSON.stringify(version, null, 2));
} catch (error) {
  process.exitCode = 1;
  errors.push({ acceptanceFailure: error.stack });
  console.error(error.stack);
} finally {
  if (cdp) { try { await cdp.call('Browser.close', {}, null); } catch {} cdp.ws.close(); }
  await finishChild(browser); await finishChild(server);
  await rm(profile, { recursive: true, force: true });
  await writeFile(join(out, 'receipt.json'), JSON.stringify({ revision, sourceStatus, checks, captures, errors, requests, teardown: { browserPid: browser?.pid, browserExit: browser?.exitCode, browserSignal: browser?.signalCode, serverPid: server?.pid, serverExit: server?.exitCode, serverSignal: server?.signalCode, profileRemoved: true }, scope: 'Synthetic UI transitions and native interaction only; no audio, OPFS, real admission, host authority, multi-instance transport or package execution.' }, null, 2));
  console.log(`${checks.filter((c) => c.passed).length}/${checks.length} checks; evidence: ${out}`);
}
