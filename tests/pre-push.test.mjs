// Drive the tracked hook via real pushes from a fresh worktree to a local bare repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const timeout = execFileSync('which', ['timeout'], { encoding: 'utf8' }).trim();
// Git exports its repository context inside hooks. Never let it redirect a
// disposable fixture's init/config/add/commit into the repository being pushed.
const cleanEnv = { ...process.env };
for (const key of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n')) delete cleanEnv[key];

test('pre-push names the stage and cause, streams output, and refuses real failing tests', { timeout: 60000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'voicebox-pre-push-'));
  const repo = path.join(dir, 'repo');
  const work = path.join(dir, 'work');
  const remote = path.join(dir, 'remote.git');
  const bin = path.join(dir, 'bin');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: cleanEnv });
  try {
    mkdirSync(repo); mkdirSync(bin);
    git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Gate fixture');
    git('config', 'core.hooksPath', '.githooks');
    for (const file of ['.githooks/pre-push', 'scripts/pre-push.sh']) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(repo, file));
    }
    chmodSync(path.join(repo, '.githooks/pre-push'), 0o755);
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test case.cjs', accept: 'node acceptance.cjs' } }));
    writeFileSync(path.join(repo, 'case.cjs'), `
const {test} = require('node:test');
const assert = require('node:assert/strict');
console.log('TEST OUTPUT BEFORE TERMINATION');
console.error('TEST STDERR BEFORE TERMINATION');
test('deliberate arithmetic assertion', async () => {
  if (process.env.GATE_CASE === 'test-timeout') await new Promise(r => setTimeout(r, 30000));
  assert.equal(2 + 2, process.env.GATE_CASE === 'test-failure' ? 5 : 4);
});
`);
    writeFileSync(path.join(repo, 'acceptance.cjs'), `
console.log('ACCEPTANCE OUTPUT BEFORE TERMINATION');
console.error('ACCEPTANCE STDERR BEFORE TERMINATION');
if (process.env.GATE_CASE === 'accept-timeout') setTimeout(() => {}, 30000);
if (process.env.GATE_CASE === 'accept-failure') { console.error('fetch failed (ECONNREFUSED): fixture front'); process.exitCode = 1; }
`);
    // Accelerate only the timeout being tested; execute the real GNU timeout.
    writeFileSync(path.join(bin, 'timeout'), `#!/bin/sh
case "$GATE_CASE:$3" in
  test-timeout:180s|accept-timeout:45s) shift 3; exec '${timeout}' --verbose --kill-after=1s 2s "$@" ;;
esac
exec '${timeout}' "$@"
`);
    chmodSync(path.join(bin, 'timeout'), 0o755);
    git('add', '.'); git('commit', '-qm', 'fixture'); git('init', '--bare', '-q', remote);
    git('worktree', 'add', '-qb', 'candidate', work);
    for (const scenario of ['test-timeout', 'test-failure', 'accept-timeout', 'accept-failure', 'success']) {
      const result = spawnSync('git', ['push', remote, 'HEAD:refs/heads/candidate'], {
        cwd: work, encoding: 'utf8', timeout: 15000,
        env: { ...cleanEnv, NODE_TEST_CONTEXT: undefined, PATH: `${bin}:${process.env.PATH}`, BD_GIT_HOOK: '1',
          VOICEBOX_SKIP_GATE: '', VOICEBOX_SKIP_ACCEPT: '', GATE_CASE: scenario },
      });
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      assert.match(output, /TEST OUTPUT BEFORE TERMINATION/);
      assert.match(output, /TEST STDERR BEFORE TERMINATION/);
      if (scenario === 'success') {
        assert.equal(result.status, 0, output);
        assert.match(output, /ALL GATES GREEN/);
        continue;
      }
      assert.notEqual(result.status, 0, output);
      const stage = scenario.startsWith('test') ? 'tests' : 'acceptance';
      const cause = scenario.endsWith('timeout') ? 'TIMED OUT' : 'FAILED';
      assert.match(output, new RegExp(`REFUSED: ${stage} .* — ${cause}`));
      if (scenario.endsWith('timeout')) {
        const timeoutMatch = output.match(/TIMED OUT — budget (\d+)s, elapsed (\d+)s \(exit 124\)/);
        assert.ok(timeoutMatch, `timeout refusal must state both budget and elapsed time: ${output}`);
        const budget = Number(timeoutMatch[1]);
        const elapsed = Number(timeoutMatch[2]);
        const expectedBudget = scenario.startsWith('test') ? 180 : 45;
        assert.equal(budget, expectedBudget, `budget must match configured value: ${budget} vs ${expectedBudget}`);
        assert.notEqual(elapsed, budget, `elapsed (${elapsed}s) must not echo the budget claim (${budget}s)`);
        assert.ok(elapsed >= 1 && elapsed <= 10, `elapsed (${elapsed}s) must reflect actual measured execution time (~2s)`);
        const expectedVar = scenario.startsWith('test') ? 'VOICEBOX_GATE_TESTS_SECS' : 'VOICEBOX_GATE_ACCEPT_SECS';
        assert.match(output, new RegExp(`re-run when the box is quieter, or raise the budget with ${expectedVar}=<n>`));
      }
      if (cause === 'FAILED') assert.doesNotMatch(output, /TIMED OUT/);
      if (stage === 'tests') assert.doesNotMatch(output, /ACCEPTANCE OUTPUT/);
      else {
        assert.match(output, /ACCEPTANCE OUTPUT BEFORE TERMINATION/);
        assert.match(output, /ACCEPTANCE STDERR BEFORE TERMINATION/);
      }
      if (scenario === 'test-failure') assert.match(output, /deliberate arithmetic assertion/);
      if (scenario === 'accept-failure') assert.match(output, /fetch failed \(ECONNREFUSED\)/);
      assert.equal(spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/candidate'], { env: cleanEnv }).status, 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance names the network cause when a responding front drops mid-run', { timeout: 30000 }, async () => {
  const front = createServer((req, res) => {
    if (req.url === '/api/root') res.end('{}');
    else if (req.url === '/api/files') res.end('{"files":[]}');
    else if (req.url === '/') res.end('<html></html>');
    else req.socket.destroy(); // Probe succeeded; the actual page fetch fails.
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${front.address().port}`;
  const child = spawn(process.execPath, ['tools/page-acceptance.mjs'], {
    cwd: root, env: { ...cleanEnv, VOICEBOX_UI_URL: url, VOICEBOX_API_URL: url, VOICEBOX_TREE: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject); child.on('close', resolve);
    });
    assert.equal(code, 1, output);
    assert.match(output, /run completed without crashing — fetch failed \(UND_ERR_SOCKET\)/);
  } finally {
    child.kill(); front.closeAllConnections(); await new Promise(resolve => front.close(resolve));
  }
});

test('pre-push timeout refusal respects custom budget and reports measured elapsed time', { timeout: 30000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'voicebox-pre-push-budget-'));
  const repo = path.join(dir, 'repo');
  try {
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, env: cleanEnv });
    copyFileSync(path.join(root, 'scripts/pre-push.sh'), path.join(repo, 'pre-push.sh'));
    chmodSync(path.join(repo, 'pre-push.sh'), 0o755);
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "setTimeout(()=>{}, 30000)"' } }));

    const result = spawnSync(path.join(repo, 'pre-push.sh'), [], {
      cwd: repo, encoding: 'utf8', timeout: 15000,
      env: {
        ...cleanEnv,
        VOICEBOX_GATE_TESTS_SECS: '2',
        VOICEBOX_SKIP_ACCEPT: '1',
      },
    });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /running npm test \(max 2s\)\.\.\./);
    const match = output.match(/REFUSED: tests \(npm test\) — TIMED OUT — budget (\d+)s, elapsed (\d+)s \(exit 124\); suite completion is unknown, not a test verdict — re-run when the box is quieter, or raise the budget with VOICEBOX_GATE_TESTS_SECS=<n>\./);
    assert.ok(match, `refusal must match format with budget and elapsed: ${output}`);
    const budget = Number(match[1]);
    const elapsed = Number(match[2]);
    assert.equal(budget, 2, 'configured budget must be 2s');
    assert.ok(elapsed >= 1 && elapsed <= 5, `elapsed must be measured execution time: ${elapsed}s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
