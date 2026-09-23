# Pre-push gate: budgets and refusal causes

The tracked hook runs the test suite in **two lanes**, then `npm run accept`:

| stage | what it runs | concurrency | default budget |
| --- | --- | --- | --- |
| `unit` | `npm run test:unit` — every `tests/*.test.mjs` that launches no browser and no server of its own | files in parallel | 90s |
| `live` | `npm run test:live` — tests that launch Chromium over CDP or a server process | **one file at a time** | 400s |
| `acceptance` | `npm run accept` | — | 45s |

Each stage inherits stdout and stderr: partial output remains visible when it
times out. GNU coreutils `timeout` is required; its absence is a named refusal,
not an unbounded run. The lanes are derived from each file's code by
`scripts/test-lanes.mjs` (comments stripped; every file lands in exactly one
lane), so a new test cannot escape them the way it could escape a hand-kept
list, and `npm test` still runs the whole suite for humans and CI.

## Why two lanes — 2026-09-23 (`voicebox-beads-6qu`)

The single full-suite stage refused good branches, and the cause was measured
rather than guessed:

- `extension-approval-ui.test.mjs` failed **inside** the suite twice at ~20.5s
  (`timed out waiting for host code requested`), and `environment-probe.test.mjs`
  once — **each passing alone** (3/3 and 1/1), and each passing when the suite
  ran serially.
- That serial run passed **357 tests, 354 pass, 0 fail, 3 skipped at load
  average 36.31** — higher than during any refusal. So the interference is
  between test FILES (node runs them concurrently), not the machine.
- Lane costs, measured at load 19.5: `unit` **15s concurrent** (175 tests),
  `live` **186s serial** (182 tests). The budgets above are headroom over those
  numbers, not estimates; changing concurrency without raising the budget would
  convert a flake into a timeout, which is why both moved together.

A timeout reports the stage, command, budget and exit 124, and says completion
is unknown rather than claiming tests failed. An ordinary nonzero exit reports
FAILED with the stage and exit code; the test or harness output above gives the
specific cause. Exit 137 is reported as KILLED: it can be timeout escalation or
an external SIGKILL, so it is not labelled a proven test failure. GNU timeout's
signal diagnostics also remain visible. Acceptance fetch exceptions retain
their underlying network error code (for example ECONNREFUSED or UND_ERR_SOCKET).

The old hook-wide 120-second timer is removed: it could terminate the gate
before the stage printed its diagnosis. The two stage timers remain bounded,
with up to five seconds of kill grace each. The existing Beads hook runs
separately before these stages. Existing explicit skip flags are unchanged.

## Private read idempotence

Phase B declares an owned root and seeds a nonempty file before navigating the
private page, so page polling does not compete with the measurement. It makes
three sequential GETs each to `/api/root` and `/api/files`. Every response must
succeed, identify the declared project/root and include the known file with its
correct byte count; all three response pairs must agree. Zero requests, empty
responses and identical refusals cannot pass.

The directory must still contain exactly the seeded file, with its original
bytes, mode, nanosecond mtime and ctime. This catches hidden file creation and
same-byte rewrites even when API responses remain identical. Access time is not
compared: a legitimate read may update it. The seed is removed before the later
page/turn checks. This measures the declared state and this flat private fixture,
not every internal server field or side effects outside its root. Phase A does
not compare shared-server state across a window another lane can write to.

## Measurement — 2026-09-21, worker-gzm

Baseline revision: 984aad95f16d1fbe42d37efeea23125ff50b396d. Node 24.21.0,
32 logical CPUs. Three full-suite runs shared CPUs 0–3 with four owned busy-loop
processes pinned to the same CPUs. This is **controlled contention**, not an
estimate of an idle run or a measurement of the whole fleet's p95. Other lanes
were not pinned or stopped.

| Run | Wall time | Tests | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 74.570s | 305 | 303 | 0 | 2 |
| 2 | 73.599s | 305 | 303 | 0 | 2 |
| 3 | 73.469s | 305 | 303 | 0 | 2 |

Median 73.599s; observed maximum 74.570s. All exceeded 60s while passing.
180s allows over twice this observed maximum; it is headroom, not a guarantee
against arbitrary overload. **No fast subset was introduced**: these runs fit
a modest full-suite budget, so they do not justify dropping pre-push coverage
or adding a second full-suite signal.

A diagnostic copy of the new gate with *only* the unit budget restored to 60s
was driven against the real full suite under the same contention. At 60.026s
it exited 1 and printed `REFUSED: tests (npm test) — TIMED OUT after 60s (exit 124)`
alongside the suite's partial stdout/stderr. Termination cancelled an unfinished
test; that is not relabelled as a completed failing suite.

Raw baseline logs, JSON timings and the old-budget drive are retained outside
the source tree at /home/paulkinlan/cap-evidence/voicebox-gzm/.

## Regression drives

`node --test tests/pre-push.test.mjs` makes real pushes from a fresh linked
worktree to a disposable local bare repository. It checks both stage timeouts,
a genuinely failing arithmetic test, an acceptance refusal and a successful
push. A fixture wrapper accelerates only the selected timeout to two seconds;
it still runs GNU timeout and the actual tracked hook. Failed pushes leave no
remote ref. Both output streams survive timeout and retain the original cause.
Fixture subprocesses clear Git's repository-local environment variables so a
real pre-push hook cannot redirect fixture writes into the pushed repository.
This was caught by the first actual push, repaired, and rechecked with explicit
GIT_DIR/GIT_WORK_TREE inheritance; direct gate execution alone did not expose it.
A second check runs the real Chromium acceptance harness against an ephemeral
HTTP front which answers the probes, then drops the page fetch; the failure
must include UND_ERR_SOCKET, not just “fetch failed”.
