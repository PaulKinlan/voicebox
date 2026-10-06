// Drive the tracked hook via real pushes from a fresh worktree to a local bare repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowserBinary } from './lib/cdp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const timeout = (() => {
  for (const cmd of ['timeout', 'gtimeout']) {
    try { return execFileSync('which', [cmd], { encoding: 'utf8' }).trim(); } catch {}
  }
  const shimDir = mkdtempSync(path.join(tmpdir(), 'voicebox-timeout-shim-'));
  const shim = path.join(shimDir, 'timeout-real');
  writeFileSync(shim, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("--verbose --kill-after"); process.exit(0); }
let killAfterMs = 5000, verbose = false;
while (args[0] && args[0].startsWith("--")) {
  const f = args.shift();
  if (f === "--verbose") verbose = true;
  else if (f.startsWith("--kill-after=")) killAfterMs = parseFloat(f.slice(13)) * 1000;
}
const durMs = parseFloat(args.shift()) * 1000;
const child = spawn(args[0], args.slice(1), { stdio: "inherit", detached: true });
let timedOut = false, killed = false, killTimer = null;
const sigGroup = (sig) => { try { process.kill(-child.pid, sig); } catch {} try { child.kill(sig); } catch {} };
const timer = setTimeout(() => {
  timedOut = true;
  if (verbose) process.stderr.write("timeout: sending signal TERM to command\\n");
  sigGroup("SIGTERM");
  killTimer = setTimeout(() => { killed = true; sigGroup("SIGKILL"); }, killAfterMs);
}, durMs);
child.on("exit", (code, sig) => {
  clearTimeout(timer); clearTimeout(killTimer);
  if (killed) process.exit(137);
  if (timedOut) process.exit(124);
  process.exit(code ?? (sig ? 128 : 0));
});
`);
  chmodSync(shim, 0o755);
  return shim;
})();
// Git exports its repository context inside hooks. Never let it redirect a
// disposable fixture's init/config/add/commit into the repository being pushed.
const cleanEnv = { ...process.env };
for (const key of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n')) delete cleanEnv[key];
// The fixture's timeout shim accelerates the DEFAULT budgets, keyed by stage+duration
// (unit-timeout:180s, live-timeout:400s, accept-timeout:45s) — the duration is how it targets the
// ONE stage under test, since GATE_CASE stays set for the whole push. The unit default is ALSO
// asserted by value from the gate's own `(max 180s)` line in the branch-push case
// (voicebox-beads-lq8s: 90s sat inside the suite's measured swing, so it is 180s now), which is
// what names the number when it changes. A parent gate
// run with a raised VOICEBOX_GATE_*_SECS (the refusal's own documented escape) would otherwise
// leak in, miss the shim's match, and let the "timeout" scenario finish — the instrument
// measuring itself under someone else's budget (voicebox-beads-67b). Strip them: the fixture
// always exercises the defaults it is written against.
for (const key of ['VOICEBOX_GATE_UNIT_SECS', 'VOICEBOX_GATE_LIVE_SECS', 'VOICEBOX_GATE_ACCEPT_SECS', 'VOICEBOX_PUSH_DESTINATIONS']) delete cleanEnv[key];
const hasFlock = (() => { try { execFileSync('which', ['flock'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('pre-push names the stage and cause, streams output, and refuses real failing tests', { timeout: 60000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'voicebox-pre-push-'));
  const repo = path.join(dir, 'repo');
  const work = path.join(dir, 'work');
  const remote = path.join(dir, 'remote.git');
  const bin = path.join(dir, 'bin');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: cleanEnv });
  try {
    mkdirSync(repo); mkdirSync(bin);
    git('init', '-q', '-b', 'trunk'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Gate fixture');
    git('config', 'core.hooksPath', '.githooks');
    // Every file the gate RUNS, not just the gate script: a stage whose command is missing makes the
    // gate refuse at that stage (correctly — a check that cannot run is not a check that passed), and
    // the fixture would then never reach the stage the case is actually about.
    for (const file of ['.githooks/pre-push', 'scripts/pre-push.sh', 'scripts/test-lanes.mjs', 'scripts/docs-touched.mjs', 'lib/git-env.mjs']) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(repo, file));
    }
    chmodSync(path.join(repo, '.githooks/pre-push'), 0o755);
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'node --test case.cjs', 'test:live': 'node --test --test-concurrency=1 live-case.cjs', accept: 'node acceptance.cjs' } }));
    writeFileSync(path.join(repo, 'case.cjs'), `
const {test} = require('node:test');
const assert = require('node:assert/strict');
console.log('TEST OUTPUT BEFORE TERMINATION');
console.error('TEST STDERR BEFORE TERMINATION');
test('deliberate arithmetic assertion', async () => {
  if (process.env.GATE_CASE === 'unit-timeout') await new Promise(r => setTimeout(r, 30000));
  assert.equal(2 + 2, process.env.GATE_CASE === 'unit-failure' ? 5 : 4);
});
`);
    writeFileSync(path.join(repo, 'live-case.cjs'), `
const {test} = require('node:test');
console.log('LIVE OUTPUT BEFORE TERMINATION');
if (process.env.GATE_CASE === 'live-timeout') setTimeout(() => {}, 30000);
test('live lane case', () => {});
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
  unit-timeout:180s|live-timeout:400s|accept-timeout:45s) shift 3; exec '${timeout}' --verbose --kill-after=1s 2s "$@" ;;
esac
exec '${timeout}' "$@"
`);
    chmodSync(path.join(bin, 'timeout'), 0o755);
    git('add', '.'); git('commit', '-qm', 'fixture'); git('init', '--bare', '-q', remote);
    git('worktree', 'add', '-qb', 'candidate', work);
    // FEATURE-BRANCH DESTINATION (voicebox-beads-uadl): the unit lane is the whole gate.
    // The live/acceptance stages and the gate lock are for LANDINGS; a candidate push must
    // not queue behind the flock (measured: lanes waited 398s-1058s for locks). Scenarios
    // that matter here: success is green with NO live/acceptance/lock activity, and a unit
    // failure/time-out still refuses with the same named shape as ever.
    for (const scenario of ['unit-timeout', 'unit-failure', 'success']) {
      const result = spawnSync('git', ['push', remote, 'HEAD:refs/heads/candidate'], {
        cwd: work, encoding: 'utf8', timeout: 60000,
        env: { ...cleanEnv, NODE_TEST_CONTEXT: undefined, PATH: `${bin}:${process.env.PATH}`, BD_GIT_HOOK: '1',
          VOICEBOX_SKIP_GATE: '', VOICEBOX_SKIP_ACCEPT: '', GATE_CASE: scenario,
          VOICEBOX_GATE_LOCK: path.join(dir, 'fixture-gate.lock'),
          VOICEBOX_GATE_HOLDER: path.join(dir, 'fixture-gate.holder.json') },
      });
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      assert.match(output, /TEST OUTPUT BEFORE TERMINATION/);
      assert.match(output, /TEST STDERR BEFORE TERMINATION/);
      assert.doesNotMatch(output, /LIVE OUTPUT BEFORE TERMINATION/, 'the live lane must not run for a feature-branch push');
      assert.doesNotMatch(output, /ACCEPTANCE OUTPUT/, 'acceptance must not run for a feature-branch push');
      assert.doesNotMatch(output, /Acquired gate lock|Waiting for gate lock/, 'a feature-branch push must not queue on the gate lock');
      if (scenario === 'success') {
        assert.equal(result.status, 0, output);
        assert.match(output, /ALL GATES GREEN \(unit\)/);
        assert.match(output, /feature-branch push — unit lane is the gate/, 'the fast path names itself on the way out');
        assert.equal(existsSync(path.join(dir, 'fixture-gate.lock')), false, 'the gate lock file must never be created by a feature-branch push');
        continue;
      }
      assert.notEqual(result.status, 0, output);
      const cause = scenario.endsWith('timeout') ? 'TIMED OUT' : 'FAILED';
      assert.match(output, new RegExp(`REFUSED: unit .* — ${cause}`));
      // The unit budget is a SIZED FACT, asserted from the gate's own announcement and from the
      // refusal (voicebox-beads-lq8s): 90s sat inside the suite's measured run-to-run swing on this
      // box (duration_ms 71084/78510 green against 88686/88966 killed at 90s), so it is 180s.
      if (scenario.startsWith('unit')) {
        assert.match(output, /pre-push: unit — running npm run test:unit \(max 180s\)/, 'the branch-push unit budget must be 180s — sized outside the suite swing on a starved box (voicebox-beads-lq8s)');
      }
      if (scenario === 'unit-timeout') {
        const m = output.match(/TIMED OUT — budget (\d+)s, elapsed (\d+)s \(exit 124\)/);
        assert.ok(m, `the unit refusal must state budget and elapsed time: ${output}`);
        assert.equal(Number(m[1]), 180, 'the unit refusal must name the same budget the stage announced');
      }
      if (scenario === 'unit-failure') assert.match(output, /deliberate arithmetic assertion/);
      assert.equal(spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/candidate'], { env: cleanEnv }).status, 1);
    }

    /**
     * A push AIMED AT main from a branch is refused BY NAME, before any stage runs
     * (`voicebox-beads-85w`). This is the real hazard, driven with a real `git push`:
     * a worktree made with `git worktree add -b <branch> <dir> origin/main` tracks
     * main, so a bare `git push` offers HEAD:main and git's own remedy line suggests
     * `git push origin HEAD:main` — the worst available outcome, offered as help.
     */
    const aimed = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
      cwd: work, encoding: 'utf8', timeout: 15000,
      env: { ...cleanEnv, NODE_TEST_CONTEXT: undefined, PATH: `${bin}:${process.env.PATH}`, BD_GIT_HOOK: '1', GATE_CASE: 'success' },
    });
    assert.notEqual(aimed.status, 0, 'a branch pushing to main must be refused');
    const aimedOut = aimed.stdout + aimed.stderr;
    assert.match(aimedOut, /\[gate\] pre-push REFUSED: non-main branch attempting to push to main ref/);
    assert.match(aimedOut, /push your branch instead/, 'the refusal names the remedy');
    assert.doesNotMatch(aimedOut, /\[gate\] pre-push: (unit|live|tests)|npm test/, 'the destination is checked BEFORE any stage runs — a mis-aimed push must not wait for a suite');
    assert.equal(
      spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/main'], { env: cleanEnv }).status, 1,
      'main was not created on the remote',
    );

    /**
     * MAIN DESTINATION (voicebox-beads-uadl): a landing runs the FULL gate — unit, the
     * gate-locked live lane, and acceptance. The push comes FROM a main checkout (the 85w
     * refusal above is what stops a branch aiming at main), and the timeout/failure
     * scenarios live here because these are the stages a feature push no longer runs.
     */
    execFileSync('git', ['checkout', '-qb', 'main'], { cwd: work, stdio: 'pipe', env: cleanEnv });
    for (const scenario of ['live-timeout', 'accept-timeout', 'accept-failure', 'success']) {
      const result = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
        cwd: work, encoding: 'utf8', timeout: 60000,
        env: { ...cleanEnv, NODE_TEST_CONTEXT: undefined, PATH: `${bin}:${process.env.PATH}`, BD_GIT_HOOK: '1',
          VOICEBOX_SKIP_GATE: '', VOICEBOX_SKIP_ACCEPT: '', GATE_CASE: scenario,
          VOICEBOX_GATE_LOCK: path.join(dir, 'fixture-gate.lock'),
          VOICEBOX_GATE_HOLDER: path.join(dir, 'fixture-gate.holder.json') },
      });
      assert.ifError(result.error);
      const output = result.stdout + result.stderr;
      const stage = scenario.startsWith('live') ? 'live' : 'acceptance';
      const budgets = { live: 400, acceptance: 45 };
      const remedyVars = { live: 'VOICEBOX_GATE_LIVE_SECS', acceptance: 'VOICEBOX_GATE_ACCEPT_SECS' };
      const cause = scenario.endsWith('timeout') ? 'TIMED OUT' : 'FAILED';
      // An UNCONTENDED lock acquires silently (the wait announcement is the contended branch);
      // the lock file's existence (or acquire_gate_lock's no-flock fallback on macOS) is the evidence the landing entered the gate lock path.
      if (hasFlock) {
        assert.equal(existsSync(path.join(dir, 'fixture-gate.lock')), true, 'a landing to main takes the gate lock');
      } else {
        assert.match(output, /flock command not found; running live stage without lock/, 'a landing to main enters acquire_gate_lock');
      }
      assert.match(output, /LIVE OUTPUT BEFORE TERMINATION/);
      if (scenario === 'success') {
        assert.equal(result.status, 0, output);
        assert.match(output, /ALL GATES GREEN/);
        assert.match(output, /ACCEPTANCE OUTPUT BEFORE TERMINATION/);
        assert.match(output, /ACCEPTANCE STDERR BEFORE TERMINATION/);
        continue;
      }
      assert.notEqual(result.status, 0, output);
      assert.match(output, new RegExp(`REFUSED: ${stage} .* — ${cause}`));
      if (scenario.endsWith('timeout')) {
        const timeoutMatch = output.match(/TIMED OUT — budget (\d+)s, elapsed (\d+)s \(exit 124\)/);
        assert.ok(timeoutMatch, `timeout refusal must state both budget and elapsed time: ${output}`);
        const budget = Number(timeoutMatch[1]);
        const elapsed = Number(timeoutMatch[2]);
        assert.equal(budget, budgets[stage], `budget must match configured value: ${budget} vs ${budgets[stage]}`);
        assert.notEqual(elapsed, budget, `elapsed (${elapsed}s) must not echo the budget claim (${budget}s)`);
        assert.ok(elapsed >= 1 && elapsed <= 10, `elapsed (${elapsed}s) must reflect actual measured execution time (~2s)`);
        assert.match(output, new RegExp(`re-run when the box is quieter, or raise the budget with ${remedyVars[stage]}=<n>`));
      }
      if (cause === 'FAILED') assert.doesNotMatch(output, /TIMED OUT/);
      if (stage === 'acceptance') {
        assert.match(output, /ACCEPTANCE OUTPUT BEFORE TERMINATION/);
        assert.match(output, /ACCEPTANCE STDERR BEFORE TERMINATION/);
        if (scenario === 'accept-failure') assert.match(output, /fetch failed \(ECONNREFUSED\)/);
      }
    }
    assert.equal(
      spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/main'], { env: cleanEnv }).status, 0,
      'the landing to main succeeded and main exists on the remote',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acceptance names the network cause when a responding front drops mid-run', { timeout: 30000 }, async (t) => {
  // NAMED PRECONDITION, not a flake (voicebox-beads-80vw). This case drives tools/page-acceptance.mjs,
  // which launches a REAL browser (VOICEBOX_CHROME, else a system chromium). With none present the
  // tool dies at 'spawn /usr/bin/chromium ENOENT' BEFORE the network path this case asserts — which
  // is exactly how it read: red standalone on a box without VOICEBOX_CHROME, green in the browser
  // lane, which always sets it. The lane still exercises the assertion; a standalone run without a
  // browser says WHY by name instead of failing as though the network naming were broken.
  const browser = findBrowserBinary();
  if (!browser) {
    console.log('SKIP BY NAME: no browser binary (set VOICEBOX_CHROME) — this case needs a real browser to reach the network path it asserts');
    t.skip('no browser binary — set VOICEBOX_CHROME; the acceptance tool cannot reach the network path this case asserts');
    return;
  }
  const front = createServer((req, res) => {
    if (req.url === '/api/root') res.end('{}');
    else if (req.url === '/api/files') res.end('{"files":[]}');
    else if (req.url === '/') res.end('<html></html>');
    else req.socket.destroy(); // Probe succeeded; the actual page fetch fails.
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${front.address().port}`;
  const child = spawn(process.execPath, ['tools/page-acceptance.mjs'], {
    // The VERIFIED binary is handed to the tool explicitly: this case's precondition and the tool's
    // own discovery list live in different files, and passing the answer through means they cannot
    // diverge into 'the test skipped while the tool could run' (or vice versa).
    cwd: root, env: { ...cleanEnv, VOICEBOX_CHROME: browser, VOICEBOX_UI_URL: url, VOICEBOX_API_URL: url, VOICEBOX_TREE: root },
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
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    copyFileSync(path.join(root, 'scripts/pre-push.sh'), path.join(repo, 'pre-push.sh'));
    // The gate calls the classifier before its stages, so a fixture that runs
    // the gate needs the classifier present (it tolerates having no tests/).
    copyFileSync(path.join(root, 'scripts/test-lanes.mjs'), path.join(repo, 'scripts/test-lanes.mjs'));
    chmodSync(path.join(repo, 'pre-push.sh'), 0o755);
    // The docs stage runs before the test lanes; it needs its script here too. In this scratch repo
    // there is no `origin/main`, so it reports SKIPPED BY NAME and exits 0 — which is the designed
    // answer for "the base is unknown", and lets this case get to the timeout it is about.
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    mkdirSync(path.join(repo, 'lib'), { recursive: true });
    copyFileSync(path.join(root, 'scripts/docs-touched.mjs'), path.join(repo, 'scripts/docs-touched.mjs'));
    copyFileSync(path.join(root, 'lib/git-env.mjs'), path.join(repo, 'lib/git-env.mjs'));
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'node -e "setTimeout(()=>{}, 30000)"' } }));

    const result = spawnSync(path.join(repo, 'pre-push.sh'), [], {
      cwd: repo, encoding: 'utf8', timeout: 15000,
      env: {
        ...cleanEnv,
        VOICEBOX_GATE_UNIT_SECS: '2',
        VOICEBOX_SKIP_ACCEPT: '1',
        VOICEBOX_GATE_LOCK: path.join(dir, 'fixture-gate.lock'),
        VOICEBOX_GATE_HOLDER: path.join(dir, 'fixture-gate.holder.json'),
      },
    });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /running npm run test:unit \(max 2s\)\.\.\./);
    const match = output.match(/REFUSED: unit \(npm run test:unit\) — TIMED OUT — budget (\d+)s, elapsed (\d+)s \(exit 124\); suite completion is unknown, not a test verdict — re-run when the box is quieter, or raise the budget with VOICEBOX_GATE_UNIT_SECS=<n>\./);
    assert.ok(match, `refusal must match format with budget and elapsed: ${output}`);
    const budget = Number(match[1]);
    const elapsed = Number(match[2]);
    assert.equal(budget, 2, 'configured budget must be 2s');
    assert.ok(elapsed >= 1 && elapsed <= 5, `elapsed must be measured execution time: ${elapsed}s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a suite run inside a hook cannot move the repository it runs in (observer-based)', { timeout: 120000 }, () => {
  // WHY THIS EXISTS, and why it is HERE rather than inside the suite it watches.
  //
  // `tests/docs-touched.test.mjs` builds scratch git repositories. Git exports GIT_DIR, GIT_INDEX_FILE
  // and friends into the children of its hooks, so without a guard those fixtures commit into the
  // repository being pushed — driven on 2026-09-23, when a push moved a branch onto a commit called
  // "change the described file".
  //
  // THE REVIEW FINDING (voicebox-astra-66ef): stripping the guard left that suite at 8 pass / 0 fail
  // WHILE THE HEAD MOVED, because every case asserted on the gate's OUTPUT — which is identical
  // whether the fixture's commits landed in a scratch directory or in somebody's history. So the suite
  // could not fail on its own defect, and no committed regression protected the guard.
  //
  // A test inside that file can assert the invariant, but only an OBSERVER can assert the consequence:
  // this one owns a standalone repository, runs the suite inside it with a hook child's exact
  // environment, and compares HEAD before and after from outside. The environment points at the
  // FIXTURE's git dir, never the source checkout, so the failure mode being reproduced can only ever
  // damage a directory this test created and deletes.
  const dir = mkdtempSync(path.join(tmpdir(), 'voicebox-hook-observer-'));
  const repo = path.join(dir, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanEnv }).trim();
  try {
    mkdirSync(repo);
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    mkdirSync(path.join(repo, 'tests'), { recursive: true });
    copyFileSync(path.join(root, 'scripts/docs-touched.mjs'), path.join(repo, 'scripts/docs-touched.mjs'));
    mkdirSync(path.join(repo, 'lib'), { recursive: true });
    copyFileSync(path.join(root, 'lib/git-env.mjs'), path.join(repo, 'lib/git-env.mjs'));
    copyFileSync(path.join(root, 'tests/docs-touched.test.mjs'), path.join(repo, 'tests/docs-touched.test.mjs'));
    writeFileSync(path.join(repo, 'README.md'), '# Observer fixture\n\nIt describes `scripts/docs-touched.mjs`.\n');
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Observer', '-c', 'user.email=observer@example.invalid', 'add', '-A');
    git('-c', 'user.name=Observer', '-c', 'user.email=observer@example.invalid', 'commit', '-qm', 'observer base');

    const before = git('rev-parse', 'HEAD');
    const commitsBefore = git('rev-list', '--count', 'HEAD');

    // A hook child's environment, pointed at THIS fixture: exactly what git hands the suite when it
    // runs from pre-push, and the reason an unguarded `git init` elsewhere is silently ignored.
    const gitDir = git('rev-parse', '--absolute-git-dir');
    const result = spawnSync(process.execPath, ['--test', 'tests/docs-touched.test.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 90000,
      // NODE_TEST_CONTEXT must go, or node sees a recursive `--test` run and SKIPS THE FILE — which
      // would leave this observer watching a suite that never ran, and passing. (The same key is
      // cleared by the hook case above; found here by the assertion that the run must have happened.)
      env: { ...cleanEnv, NODE_TEST_CONTEXT: undefined, GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(gitDir, 'index'), GIT_PREFIX: '' },
    });

    const after = git('rev-parse', 'HEAD');
    const commitsAfter = git('rev-list', '--count', 'HEAD');
    const said = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const tail = said.slice(-2000);

    // ── THE VIOLATION FIRST, because it is unconditional and it is the most specific fact available:
    // the observed suite may pass or fail for its own reasons, but it may never move the history of the
    // repository it runs in. Ordering matters and I got it wrong once: with the execution witness first,
    // stripping the guard made this test fail with "the child exited 1" — true, but a far weaker
    // diagnosis than "it moved HEAD from X to Y", and it would have said the same thing for a dozen
    // unrelated causes.
    assert.equal(
      after,
      before,
      'the suite moved the HEAD of the repository it was running in — the fixtures inherited this ' +
        `repository's GIT_DIR instead of using their own (${before} -> ${after}).\n${tail}`,
    );
    assert.equal(commitsAfter, commitsBefore, `no commit may be added to the observing repository\n${tail}`);
    assert.equal(git('status', '--porcelain'), '', `and the observing worktree must be left clean\n${tail}`);

    // ── AND THEN THE EXECUTION WITNESS, because "HEAD did not move" is vacuous if nothing ran.
    // This is the THIRD layer of one tautology, and a reviewer found each one:
    //   1. the suite asserted the gate's output, which is the same whether fixtures wrote here or there;
    //   2. this observer inherited NODE_TEST_CONTEXT, so node skipped the file and it watched nothing;
    //   3. `/tests \d+/` matched even when the file ABORTED BEFORE ANY TEST RAN — node prints
    //      `tests 1 / pass 0 / fail 1` for a file-level throw, so the witness accepted a child that
    //      never reached a fixture (reviewer calibration, 2026-09-23: a prepended `throw` left this
    //      observer green).
    // So: the child must have STARTED, not been KILLED, EXITED 0, and a NAMED case must have PASSED.
    assert.equal(result.error, undefined, `the child could not be started at all: ${result.error?.message}`);
    assert.equal(result.signal, null, `the child was killed by ${result.signal} rather than finishing:\n${tail}`);
    assert.equal(result.status, 0, `the observed suite must run to a clean finish, or this observer is watching a child that never reached a fixture (exit ${result.status}):\n${tail}`);
    assert.match(said, /^ℹ fail 0$/m, `the observed suite reported failures, so no fixture outcome here is trustworthy:\n${tail}`);
    // A NAMED case, not a count: node prints `tests 1 / pass 0 / fail 1` for a file that dies on line 1,
    // so a count is satisfied by a suite that never reached a fixture at all.
    assert.match(
      said,
      /✔ the fixture acts on ITS OWN repository/,
      `the specific case that proves fixture isolation did not run — this observer would otherwise pass while observing no fixture:\n${tail}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('gate lock serializes concurrent pre-push runs and announces waiting holder (voicebox-beads-6qu)', { timeout: 30000, skip: !hasFlock && 'flock not installed on macOS' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'voicebox-gate-lock-'));
  const repo = path.join(dir, 'repo');
  const lockFile = path.join(dir, 'gate.lock');
  const holderFile = path.join(dir, 'gate.holder.json');

  try {
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, env: cleanEnv });
    mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    copyFileSync(path.join(root, 'scripts/pre-push.sh'), path.join(repo, 'pre-push.sh'));
    copyFileSync(path.join(root, 'scripts/test-lanes.mjs'), path.join(repo, 'scripts/test-lanes.mjs'));
    copyFileSync(path.join(root, 'scripts/docs-touched.mjs'), path.join(repo, 'scripts/docs-touched.mjs'));
    mkdirSync(path.join(repo, 'lib'), { recursive: true });
    copyFileSync(path.join(root, 'lib/git-env.mjs'), path.join(repo, 'lib/git-env.mjs'));
    chmodSync(path.join(repo, 'pre-push.sh'), 0o755);

    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      scripts: {
        'test:unit': 'echo "unit passed"',
        'test:live': 'echo "live passed"',
        accept: 'echo "accept passed"',
      },
    }));

    // Start a background holder process that holds the lock for 1.5 seconds
    const holder = spawn('sh', [
      '-c',
      `exec 9>"${lockFile}"; flock 9; echo '{"pid":'$$',"branch":"holder-branch"}' > "${holderFile}"; echo READY; sleep 1.5`,
    ], { stdio: ['ignore', 'pipe', 'inherit'] });

    await new Promise((resolve) => {
      holder.stdout.on('data', (d) => {
        if (d.toString().includes('READY')) resolve();
      });
    });

    // Run pre-push.sh pointing at this lockfile: it should wait, announce holder PID, then succeed
    const start = Date.now();
    const result = spawnSync(path.join(repo, 'pre-push.sh'), [], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...cleanEnv,
        VOICEBOX_GATE_LOCK: lockFile,
        VOICEBOX_GATE_HOLDER: holderFile,
        VOICEBOX_SKIP_ACCEPT: '1',
      },
    });

    const elapsed = Date.now() - start;
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, /Waiting for gate lock held by PID \d+/);
    assert.match(output, /Acquired gate lock/);
    assert.match(output, /ALL GATES GREEN/);
    assert.ok(elapsed >= 1000, `must have waited for the lock: elapsed ${elapsed}ms`);

    // Lock holder file must be cleaned up on release
    assert.equal(existsSync(holderFile), false, 'holder file must be deleted after release');

    await new Promise((resolve) => holder.on('close', resolve));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-push fast-paths docs-only pushes to main without running live or acceptance (voicebox-beads-07b9)', { timeout: 60000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'voicebox-pre-push-docs-fastpath-'));
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: cleanEnv });

  try {
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Gate fixture');
    git('config', 'core.hooksPath', '.githooks');

    for (const file of ['.githooks/pre-push', 'scripts/pre-push.sh', 'scripts/test-lanes.mjs', 'scripts/docs-touched.mjs', 'lib/git-env.mjs']) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(repo, file));
    }
    chmodSync(path.join(repo, '.githooks/pre-push'), 0o755);

    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      scripts: {
        'test:unit': 'echo "UNIT PASS"',
        'test:live': 'echo "LIVE PASS"',
        accept: 'echo "ACCEPT PASS"',
      },
    }));
    writeFileSync(path.join(repo, 'README.md'), '# Initial README\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    git('init', '--bare', '-q', remote);

    const lockFile = path.join(dir, 'fixture-gate.lock');
    const holderFile = path.join(dir, 'fixture-gate.holder.json');
    const receiptFile = path.join(repo, '.git', 'voicebox-gate-passed-tree');

    // Add a doc-truth test file so we verify doc-truth runs lock-free on the fast path
    mkdirSync(path.join(repo, 'tests'), { recursive: true });
    writeFileSync(path.join(repo, 'tests', 'voicebox.test.mjs'), 'import test from "node:test"; test("doc truth prose check", () => { console.log("DOC TRUTH RAN"); });\n');

    // Initial push to main sets up the remote branch (runs full gate)
    const initPush = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: {
        ...cleanEnv,
        PATH: process.env.PATH,
        BD_GIT_HOOK: '1',
        VOICEBOX_GATE_LOCK: lockFile,
        VOICEBOX_GATE_HOLDER: holderFile,
        VOICEBOX_SKIP_ACCEPT: '1',
      },
    });
    assert.equal(initPush.status, 0, initPush.stdout + initPush.stderr);
    assert.match(initPush.stdout + initPush.stderr, /ALL GATES GREEN/);

    // Now make a docs-only change (*.md only)
    rmSync(lockFile, { force: true });
    rmSync(holderFile, { force: true });
    rmSync(receiptFile, { force: true });
    writeFileSync(path.join(repo, 'README.md'), '# Updated README with docs only\n');
    mkdirSync(path.join(repo, 'docs'), { recursive: true });
    writeFileSync(path.join(repo, 'docs', 'guide.md'), '# Guide\n');
    git('add', 'README.md', 'docs/guide.md');
    git('commit', '-qm', 'docs: update guide and readme');

    const docsPush = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: {
        ...cleanEnv,
        NODE_TEST_CONTEXT: undefined,
        PATH: process.env.PATH,
        BD_GIT_HOOK: '1',
        VOICEBOX_GATE_LOCK: lockFile,
        VOICEBOX_GATE_HOLDER: holderFile,
        VOICEBOX_SKIP_ACCEPT: '1',
      },
    });

    const docsOutput = docsPush.stdout + docsPush.stderr;
    assert.equal(docsPush.status, 0, docsOutput);
    assert.match(docsOutput, /docs-only push to main — docs, unit, and doc-truth passed; skipping live\/acceptance stages/);
    assert.match(docsOutput, /ALL GATES GREEN \(docs-only\)/);
    assert.match(docsOutput, /DOC TRUTH RAN/, 'doc-truth live checks must run on docs-only fast path');
    assert.doesNotMatch(docsOutput, /LIVE PASS/, 'full live suite must not run for docs-only push to main');
    assert.doesNotMatch(docsOutput, /ACCEPT PASS/, 'acceptance must not run for docs-only push to main');
    assert.equal(existsSync(holderFile), false, 'gate lock holder file must be released after docs-only doc-truth');
    assert.equal(existsSync(receiptFile), false, 'docs-only push must not mint tree receipt since live/acceptance did not run');

    // Multi-ref push: pushing main + a branch must NOT take docs-only fast path even if only *.md changed
    writeFileSync(path.join(repo, 'README.md'), '# Multi-ref README update\n');
    git('add', 'README.md');
    git('commit', '-qm', 'docs: multi-ref update');

    const multiPush = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main', 'HEAD:refs/heads/candidate'], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: {
        ...cleanEnv,
        PATH: process.env.PATH,
        BD_GIT_HOOK: '1',
        VOICEBOX_GATE_LOCK: lockFile,
        VOICEBOX_GATE_HOLDER: holderFile,
        VOICEBOX_SKIP_ACCEPT: '1',
      },
    });
    const multiOut = multiPush.stdout + multiPush.stderr;
    assert.equal(multiPush.status, 0, multiOut);
    assert.doesNotMatch(multiOut, /ALL GATES GREEN \(docs-only\)/, 'multi-ref push must not take docs-only fast path');
    assert.match(multiOut, /LIVE PASS/, 'multi-ref push must run full live stage');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-push re-uses verified tree-SHA receipt on identical tree and invalidates on change or dirt (voicebox-beads-07b9)', { timeout: 60000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'voicebox-pre-push-receipt-'));
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: cleanEnv });

  try {
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Gate fixture');
    git('config', 'core.hooksPath', '.githooks');

    for (const file of ['.githooks/pre-push', 'scripts/pre-push.sh', 'scripts/test-lanes.mjs', 'scripts/docs-touched.mjs', 'lib/git-env.mjs']) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(repo, file));
    }
    chmodSync(path.join(repo, '.githooks/pre-push'), 0o755);

    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      scripts: {
        'test:unit': 'echo "UNIT RAN"',
        'test:live': 'echo "LIVE RAN"',
        accept: 'echo "ACCEPT RAN"',
      },
    }));
    git('add', '.');
    git('commit', '-qm', 'initial codebase');
    git('init', '--bare', '-q', remote);

    const receiptFile = path.join(repo, '.git', 'voicebox-gate-passed-tree');

    const lockFile = path.join(dir, 'fixture-gate.lock');
    const holderFile = path.join(dir, 'fixture-gate.holder.json');

    // 1. Initial push to main: runs full gate and creates receipt
    const push1 = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: {
        ...cleanEnv,
        PATH: process.env.PATH,
        BD_GIT_HOOK: '1',
        VOICEBOX_GATE_LOCK: lockFile,
        VOICEBOX_GATE_HOLDER: holderFile,
        VOICEBOX_SKIP_ACCEPT: '1',
      },
    });
    assert.equal(push1.status, 0, push1.stdout + push1.stderr);
    assert.match(push1.stdout + push1.stderr, /UNIT RAN/);
    assert.match(push1.stdout + push1.stderr, /LIVE RAN/);
    assert.match(push1.stdout + push1.stderr, /ALL GATES GREEN/);
    assert.equal(existsSync(receiptFile), true, 'receipt file must exist after full gate on clean tree');
    const tree1 = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8', env: cleanEnv }).trim();
    assert.equal(execFileSync('cat', [receiptFile], { encoding: 'utf8' }).trim(), tree1);

    // 2. Amend commit message without changing files (tree SHA remains identical)
    git('commit', '--amend', '-qm', 'initial codebase (amended message)');
    const tree2 = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8', env: cleanEnv }).trim();
    assert.equal(tree2, tree1, 'amended commit has identical tree SHA');

    // Push with force: must match tree receipt and skip unit/live/acceptance
    const push2 = spawnSync('git', ['push', '--force', remote, 'HEAD:refs/heads/main'], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: {
        ...cleanEnv,
        PATH: process.env.PATH,
        BD_GIT_HOOK: '1',
        VOICEBOX_GATE_LOCK: lockFile,
        VOICEBOX_GATE_HOLDER: holderFile,
        VOICEBOX_SKIP_ACCEPT: '1',
      },
    });
    const out2 = push2.stdout + push2.stderr;
    assert.equal(push2.status, 0, out2);
    assert.match(out2, /verified tree-SHA receipt matches \([0-9a-f]+\) on clean tree — skipping unit\/live\/acceptance stages/);
    assert.match(out2, /ALL GATES GREEN \(tree-receipt\)/);
    assert.doesNotMatch(out2, /UNIT RAN/, 'unit must be skipped on tree-receipt match');
    assert.doesNotMatch(out2, /LIVE RAN/, 'live must be skipped on tree-receipt match');

    // 3. Invalidation when working tree is dirty
    // Make an empty commit (same tree SHA, but new commit so git push invokes the hook)
    git('commit', '--allow-empty', '-qm', 'empty commit with dirty tree');
    writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted changes');
    const pushDirty = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: {
        ...cleanEnv,
        PATH: process.env.PATH,
        BD_GIT_HOOK: '1',
        VOICEBOX_GATE_LOCK: lockFile,
        VOICEBOX_GATE_HOLDER: holderFile,
        VOICEBOX_SKIP_ACCEPT: '1',
      },
    });
    const outDirty = pushDirty.stdout + pushDirty.stderr;
    assert.equal(pushDirty.status, 0, outDirty);
    assert.match(outDirty, /UNIT RAN/, 'dirty working tree invalidates receipt and runs tests');
    rmSync(path.join(repo, 'dirty.txt'));

    // 4. Invalidation when tree SHA changes (code modified and committed)
    writeFileSync(path.join(repo, 'code.js'), 'console.log("new code");');
    git('add', 'code.js');
    git('commit', '-qm', 'feat: add code');
    const tree3 = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8', env: cleanEnv }).trim();
    assert.notEqual(tree3, tree1, 'new code commit produces different tree SHA');

    const push3 = spawnSync('git', ['push', remote, 'HEAD:refs/heads/main'], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: {
        ...cleanEnv,
        PATH: process.env.PATH,
        BD_GIT_HOOK: '1',
        VOICEBOX_GATE_LOCK: lockFile,
        VOICEBOX_GATE_HOLDER: holderFile,
        VOICEBOX_SKIP_ACCEPT: '1',
      },
    });
    const out3 = push3.stdout + push3.stderr;
    assert.equal(push3.status, 0, out3);
    assert.match(out3, /LIVE RAN/, 'tree SHA change invalidates receipt and runs full gate');
    assert.equal(execFileSync('cat', [receiptFile], { encoding: 'utf8' }).trim(), tree3, 'receipt updated to new tree SHA');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
