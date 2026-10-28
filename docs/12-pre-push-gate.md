# Testing Lanes & Pre-Push Gate

Voicebox enforces a multi-stage verification gate on `git push` via `.githooks/pre-push` and `scripts/pre-push.sh`. Tests are automatically classified into fast concurrent unit tests and isolated live integration tests by `scripts/test-lanes.mjs`.

---

## 1. Branch vs. `main` Push Policy

- **Candidate Branch Naming & Pushes (`git push origin fleet/<bead-id>`)**:
  - Candidate branches are standardized on strict 1:1 naming with their bead issue: `fleet/<bead-id>` (`voicebox-beads-83ge`). Ad-hoc branch variants (such as `-v2`, `-clean`) are prohibited to prevent remote branch accumulation.
  - Candidate branch pushes run only the STATIC documentation stages — `node scripts/docs-touched.mjs` and `node scripts/single-owner.mjs` — and the fast `unit` test lane (`npm run test:unit`), then exit immediately. `node scripts/docs-check.mjs` is deliberately **not** one of them (`voicebox-beads-8c0t`): it boots a scratch server and probes it, measured 36-46s wall at load ~5 on this box, and that boot is its whole cost. Its answer — do the generated blocks and hand-written claims still describe a live server — is produced on the merged union the merger gates and again on the landing, where it runs with the rest of the landing gate. A push with **no** destination information keeps the full gate, docs-check included, because an unseen destination might be a landing. This keeps worktree branch pushes fast and lock-free. No manifest is sealed here: a receipt is for a landing.
- **Landing on `main` & Remote Branch Auto-Prune**:
  - Pushing to `main` from a non-`main` branch is refused immediately (`[gate] pre-push REFUSED: non-main branch attempting to push to main ref`). Always create worktrees with `--no-track` (`git worktree add --no-track -b <branch> <dir> origin/main`) so worktree branches do not track `origin/main`.
  - Pushing from `main` to `origin/main` runs the full verification pipeline (or fast-paths docs-only `*.md` changes through `docs-check` and `single-owner`), caching both the verified `HEAD^{tree}` SHA and normalized `sourceTree` SHA in `.git/voicebox-gate-passed-tree`, and seals `~/.fleet/checks/<tree>.full.manifest.json` as its last stage (`voicebox-beads-wiby`, `voicebox-beads-83ge`).
  - **sourceTree Caching Fast-Path**: When a subsequent push to `origin/main` matches the cached `sourceTree` and the git diff against the passed tree contains strictly documentation files (`README.md` or `docs/**.md`), the gate runs fast static checks (`docs-touched`, `docs-check`, `single-owner`) and bypasses redundant unit, live, and acceptance re-runs (`voicebox-beads-83ge`). Any modification to `.js`, `.mjs`, `.css`, or `.html` files invalidates `sourceTree` and triggers the full test suite.
  - **Remote Branch Auto-Pruning**: Immediately upon landing a candidate branch to `main`, the merger workflow executes `git push origin --delete fleet/<bead-id>` to remove the landed remote branch and eliminate origin clutter.

---

## 2. Gate Stages & Timeouts

| Stage | Command | Execution Mode | Default Timeout |
|---|---|---|---|
| **Docs Touched** | `node scripts/docs-touched.mjs` | Static `git diff` check (every push) | Immediate |
| **Docs Check** | `node scripts/docs-check.mjs` | Boots a scratch server and probes it — **landings only** (`voicebox-beads-8c0t`); measured 36-46s at load ~5 | `VOICEBOX_GATE_DOCS_SECS` (must outlast the boot) |
| **Single Owner** | `node scripts/single-owner.mjs` | Static scan of the tree (every push) | Immediate |
| **Unit Suite** | `node scripts/gate-tier.mjs --tier unit` | Unit lane, **one process per file** | `180s` |
| **Live Suite** | `node scripts/gate-tier.mjs --tier live` | Server lane (`--test-concurrency=4`) then the Browser CDP shard runner (4 workers, one file each) — one process per file | `400s` |
| **Acceptance** | `npm run accept` | End-to-end headless Chromium verification (`page-acceptance.mjs`) | `45s` |
| **Full Manifest** | `node scripts/gate-manifest.mjs aggregate --gate full --tier-dir <scratch>` | Folds the three tier records into `<tree>.full.manifest.json` | `60s` |

Each test tier runs its lane **file by file**, through `scripts/gate-tier.mjs`, and writes one TIER RECORD
into the scratch directory the gate owns for the run. That is the same shape the fast gate
(`scripts/test-changed.mjs --gate`) and the browser shard runner already use, so a file's record means the
same thing in either gate — and it is what gives each file its own exit code, test counts, duration and
bound. The worker counts are the concurrency the gate already ran at (`availableParallelism() - 1` for the
unit lane, 4 for the server lane, 4 shards for the browser tier), so per-file dispatch is not a speed
claim: measured on this tree, the unit tier is 18s either way and the server tier 38s — and the browser tier's width is now **two** shards, for the reason the table below the tier-worker bullet records. A file that wedges
is killed at its own budget and recorded `timeout` — one file's failure, not the whole tier's.
On a non-passing file, the tier log and its retained tier record keep up to three failing TAP sections
(including indented nested subtests, before their outer suite summary)
(at most 20 lines of 240 characters each), including the test name and assertion even when later tests
would push them past the old last-40-lines tail. If no TAP failure exists, the last 12 bounded lines
identify a crash or timeout. The additive `failure_evidence.version: 2` field also carries through to
a manually folded manifest; passing files have no evidence field or extra log output. Evidence never
changes the file status or the fail-closed verdict. Since `voicebox-beads-a8a2` the same record also names
the arm that failed as a FIELD (`failure_evidence.test`, the leaf subtest, `null` when a crash or a kill
named nothing — the log line then carries `arm="…"` and a failure that cannot be named says so out loud
rather than reading like one that was), and the UNIT tier now records `loadavg_1m {start, end}` per file,
because every file in that tier is its own child process and the box around it is therefore attributable —
the gap that left three unit-tier failures on 2026-10-15 needing a re-run to identify. Same rule as the
browser tier's windows: a reading or an honest null, and never a reason to retry, widen a bound or soften
a verdict.

A stage that refuses prints where its records were kept and how to fold them:

```
[gate] pre-push: the unit tier's records are kept at /tmp/voicebox-gate-tiers.XXXXXX — fold them with:
[gate]   node scripts/gate-manifest.mjs aggregate --gate full --tree <tree> --tier-dir /tmp/voicebox-gate-tiers.XXXXXX
```

**The manifest is the LAST stage, and a red TIER seals none.** A receipt is for a gate that finished: if a
tier stage, acceptance or the fold itself refuses, pre-push stops there and no `<tree>.full.manifest.json`
carrying a `pass` is written for a reader to quote. The tier records are kept on the red path (above) so the
same fold can still be run by hand. (One case is not "no artifact at all": when the FOLD is the stage that
refuses — a changed source with no mapped test, a `--changed-base` that names no commit — the artifact that
records those problems is written, says `refused`, and the push is still refused. Only a run that reconciles
and dispatches every file with a green terminal status is ever labelled `pass`.)

**The artifact also says what the BOX was doing (voicebox-beads-zjpm.6).** A manifest carries a `host` block —
`cpus`, `available_parallelism`, and `loadavg_1m: {before, max, after}` with the moment it was read — and the
browser tier keeps a `loadavg_1m: {start, end}` window on every file it dispatched, so a red file's record
and the shard runner's failure block both say whether the file ran on an idle box or a saturated one. That
closes a hole this file already documents twice by hand: the same browser file measures 12.2s at four-way idle
and 39.1s in a loaded gate, and before this the artifact held only the 39.1s, so "flaky file" and "box at
loadavg 27" were the same record and telling them apart meant re-running the suite. Two limits are recorded
rather than papered over: `os.loadavg()[0]` is the **1-minute** average and LAGS a burst by roughly half a
minute, so `max` is the highest of the readings taken (never a claim about the whole run) and a platform that
reports no load average records `null`, which is not a zero. It is **attribution, not a waiver**: nothing
retries, isolates, lengthens a bound or lowers the shard width on the strength of a high reading, and a loaded
box is still a red gate.

**A browser file can also say WHICH CONDITION it failed under (voicebox-beads-zjpm.5.2).** A record may carry a
`conditions` array — one arm per condition, named from a closed set: `standalone` (the file alone), `heavy_slot`
(the file while the heavy-job queue's slot is held, with the `holder` NAMED), and `shard_concurrency` (the file
inside the shard pool at its real width). Each arm carries its own `status`, `secs`, `loadavg_1m` window,
`worker_count`, the `command` that ran it, and optionally its `counts`; a `skipped` or `unknown` arm must say
WHY, and an `unknown` one is not asked for a duration it never had. All three arms are required — a two-arm
check is refused by name, because two points are not a comparison. The sealer then derives a
`condition_verdict` from the arms: `pattern` (`standalone_only_fails`, `concurrency_only_fails`,
`heavy_slot_only_fails`, `all_agree`, `mixed`, or `incomplete`), `disagreement`, and `agrees_with_shard`. Two
rules make it evidence rather than commentary: an arm that was skipped or could not be measured makes the
whole answer `incomplete` with both other fields **null** (a comparison missing one side must never read as
agreement), and a runner may not STATE that verdict — anything stated is checked against the arms and refused
by name when it differs, so a `disagreement: false` beside an unmeasured arm cannot be printed. `verdictOf`
never reads any of it: the arms DESCRIBE a shape, the file's own terminal status still decides the verdict, and
a high reading or a disagreeing arm is never a reason to retry, isolate, widen a bound or lower the shard
width.

**And a failing file must NAME the arm that failed (voicebox-beads-a8a2).** The tier records now carry
`failure_evidence.test` — the leaf subtest that failed — and a `failed` record whose v2 evidence does not name
it is refused by name, because a failure nobody can name costs exactly one re-run, which is the cost the
evidence field exists to remove. The requirement is deliberately narrow, and each narrowing is asserted: it is
version-gated on the evidence's own `version` so pre-a8a2 records still audit as the shape they declared; it
applies only to `failed`; and it is never demanded for `timeout` or `unknown`, where a crash or a kill has no
arm to name and its bounded tail is the name.

**Targeted execution of those three conditions (voicebox-beads-zjpm.5.2)** is not a triple run of the
248-file landing gate. A red per-file tier record carries `condition_request: "pending"`, NOT
measurements; optional `conditions` are absent until the detached diagnosis actually runs. The tier
prints a named command such as
`node scripts/suite-conditions.mjs --tier unit --file tests/name.test.mjs --dir <scratch> --tier-record <scratch>/unit.json`.
Run it **after the original heavy slot releases**: `heavy_slot` means the suite runs directly OUTSIDE the
heavy queue while a separate controlled holder produces measured contention — never a self-held lock or a
suite that queued behind `fleet-heavy`. The other arms run standalone and at the existing tier worker
width/isolation, each exactly once with start/end load readings. An unavailable holder is `unknown`, never
passed. The retained tier update is atomic and cannot change the original status, counts or gate verdict.
Ops owns the short nightly named-list schedule; fleet tooling owns the automatic post-slot invocation.
Until that outer hook lands, a red tier remains honestly pending and prints the completion command.
Invoke it DIRECTLY (not wrapped in `fleet-gate`: every fleet-gate job runs through fleet-heavy, which
grants `FLEET_HEAVY_HELD=1`, and a parent that holds the heavy slot can only record `heavy_slot` as
incomplete — the script prints a named warning and stays unknown, voicebox-beads-hibh):
`node scripts/suite-conditions.mjs --tier unit --file tests/name.test.mjs --dir <scratch> --tier-record <scratch>/unit.json`.
The CLI caps itself at four named files and `max(120s, files × (3 × the file's arm bound + 40s))` —
120s for ordinary files, 220s while diagnosing `tests/browser-shard-runner.test.mjs` (voicebox-beads-eoy1) —
and cleans up holder and child test processes on signals, so a direct detached run cannot wedge.

**And a DIRTY worktree seals no landing receipt.** The tiers run over the working tree while the receipt is
keyed by the committed tree, so on a push that lands, `scripts/pre-push.sh` passes `--tree-dirty` to the fold
and a dirty run is refused by name (`working tree was DIRTY`), with the refusal recorded on the artifact it
declines to seal. The `fast` gate runs over uncommitted work by design and only *records* the fact
(`tree_dirty: true`) — commit before you push a landing, or the receipt will not exist.

The stage commands come from the repository when it has a tier runner, and fall back to `npm run test:unit`
/ `npm run test:live` when it does not (the disposable repositories `tests/pre-push.test.mjs` drives supply
their own scripts, like every other pluggable stage in this file).

### Budget Overrides
Each bound can be raised or tightened per run without editing the gate:
- The **unit** bound resolves in order — `VOICEBOX_GATE_UNIT_SECS`, then the legacy `VOICEBOX_GATE_TESTS_SECS`, then the table's default. The primary variable wins when both are set.
- The **live** and **acceptance** bounds are their own variables: `VOICEBOX_GATE_LIVE_SECS`, `VOICEBOX_GATE_ACCEPT_SECS`.
- The **docs** stage bound is `VOICEBOX_GATE_DOCS_SECS` (default 120s, shared by docs-touched, docs-check and single-owner). It must outlast the scratch server's readiness wait (`VOICEBOX_DOCS_CHECK_READY_MS`, default 30000ms) and the subsequent HTTP probes; raising only the readiness wait cannot prevent a stage timeout.
- The **manifest** bound is `VOICEBOX_GATE_MANIFEST_SECS`, and the per-file budget the tier runner gives a
  test file is derived per tier from measured headroom (`TIER_FILE_MS`: unit 120s, server 300s, browser 240s; default 240s),
  overridable by `VOICEBOX_GATE_FILE_SECS` or `--file-secs`. Sitting under the unit stage bound (180s) ensures a wedged unit
  file is recorded timeout by name without aborting the lane (voicebox-beads-ak9h). Longest-first unit queue ordering via
  `buildQueue` (`scripts/gate-tier.mjs`) dispatches heavy suites (`test-changed`, `transient-state`) first, preventing
  worker tail starvation under contention (voicebox-beads-hfa8).

A refusal names the variable to raise, so the remedy is copy-pasteable. `tests/pre-push.test.mjs` pins the resolution, the legacy fallback and its precedence (voicebox-beads-03po), so removing a link is a failing test rather than a silent compat break.

### Automatic Test Lane Classification (`scripts/test-lanes.mjs`)

A harness-path signal requires an **edge** that consumes the path — an import/require, a write, a direct,
variable-bound, or aliased spawn/exec (voicebox-beads-nr56, voicebox-beads-41mb; requiring an argument dependency
so an unrelated spawn does not promote data fixtures, voicebox-beads-oktn), or a constructed path
(`path.join`/`fileURLToPath`/`new URL`) — because a test that merely *holds* a harness path as data is not
driving anything (voicebox-beads-l79v). Matching a quoted path anywhere in the text filed pure unit tests in
the serial browser lane and hid them from the unit fast gate; that gap is pinned by a fixture test. The lane
roster is checked as a complete, disjoint partition rather than pinning global counts that change whenever
another branch adds a test. Critical boundary files retain explicit membership assertions.

**Changing the classifier means sweeping its CONSUMERS, not just its own tests** (voicebox-beads-3766). The unit
fast gate cannot see this class: a classifier regression that empties a lane leaves tests whose fixture builds its
own repository — `tests/pre-push.test.mjs` asserts all three tiers reach the one union — failing in a lane the fast
gate never runs, so it passes while the regression is real. When `scripts/test-lanes.mjs` changes, run:
`tests/pre-push.test.mjs`, `tests/gate-manifest.test.mjs`, `tests/gate-tier.test.mjs`, `tests/test-shards.test.mjs`
and `tests/browser-shard-runner.test.mjs`. A fixture that wants a file in a serial lane must express a real edge
(a constructed path is enough, e.g. `path.join('lib', 'server.mjs')`); an import is NOT always usable, because some
fixtures really execute the files they write in a disposable repo that has no `lib/`, and an import there fails
`ERR_MODULE_NOT_FOUND` rather than classifying.
`scripts/test-lanes.mjs` lexes every `tests/*.test.mjs` file (ignoring comments and fixture string writes) to classify it into the appropriate lane. A test may declare its expected lane in a leading line comment, such as `// @lane unit`, `// @lane server`, or `// @lane browser` (before executable code). The declaration does **not** override classifier signals: `node scripts/test-lanes.mjs --check` refuses a mismatch and names the file, declared lane, actual lane and launch signal. A newly added file need not update a shared integer count; its own declaration can pin a critical boundary. The lanes are:
- **`unit` lane**: Pure logic, state machine, and worker tests (including `tests/wasm-shelf.test.mjs` and `tests/docs-drift.test.mjs`) that do not spawn `server.mjs`, `createServer`, `task-fixture.mjs`, or headless Chromium.
- **`live` lane**:
  - **Server sub-lane (`--lane server`)**: Spawns `server.mjs` or HTTP servers without launching a browser; runs with `--test-concurrency=4`.
  - **Browser sub-lane (`--lane browser`)**: Launches headless Chromium over CDP. `tools/browser-shard-runner.mjs` takes its queue from the classifier and dispatches up to `TIER_WORKERS.browser` files concurrently (the width has one owner in `scripts/test-shards.mjs`). Each file retains an isolated Node process and ephemeral-port server. For literal default-option `launch()` calls that do not drive native directory drops, a worker keeps one warm browser process while each test file gets its own disposable CDP `BrowserContext` (storage and secondary tabs remain scoped to it). A file requesting custom process flags, a profile, non-default window dimensions, or real directory drag/drop uses a dedicated browser, and the runner tears down its idle warm browser before that file; standalone `node --test` calls are unchanged. The directory-drop exclusion is semantic, not a test skip: a warm off-the-record context can retain a read grant after reload where a standalone Chromium reports `needs-gesture`, so `n20-picked-root.test.mjs` and similar native picked-folder checks must assert the original platform result on a dedicated browser. `tests/browser-shard-runner.test.mjs` drives that picked-folder file through the default runner, requiring all six checks to pass with no warm browser started (about 3s in that browser-lane guard). A failed file poisons that worker's warm browser, which is reaped before the next file. `--cold-browsers` disables reuse for a same-tree A/B measurement or emergency rollback without disabling test coverage. Repeated `--only tests/a.test.mjs --only tests/b.test.mjs --workers 1` runs a focused pair through one worker. The historic four-worker isolated-browser landing measured 284.3s serial → 127.8s on its then-current 63-file roster (249 tests / 247 pass / 0 fail / 2 skipped); these are *historical* numbers, not evidence for the later warm-context change.

### The Browser Tier's Work Queue (`scripts/test-shards.mjs`)
The nested `tests/browser-shard-runner.test.mjs` fixture has a different owner from the production browser tier: its test process starts a runner which owns separately detached Chromium and per-file test groups. Its 240s fixture deadline now sends the runner group `SIGTERM` and allows a 5s cleanup window before `SIGKILL` fallback, rather than immediately killing only the runner PID and orphaning both groups. Even a runner that exits zero after the deadline cannot turn that timed-out fixture green. A browser-free negative control uses two detached groups and a temporary profile to pin the signal path quickly. A separate browser-gated control in `tests/browser-shard-runner.test.mjs` starts one real warm Chromium, holds only its nested ACP file process through an opt-in preload, expires the fixture once runner, browser and file groups are distinct, and asserts a terminal `fast-gate: unknown`/FAILED verdict plus removal of all three groups and the actual warm profile. This costs one additional Chromium startup in the browser tier; the production runner's own per-file bound and markers are unchanged.

The shard runner does not expand a shell glob for its file list: it builds a queue from `classify()` and refuses it unless it covers the browser lane exactly once (`assertExactCoverage`), so a queue that drops, repeats or invents a file fails loudly before a single browser opens rather than looking like a faster gate. The queue is ordered longest-first — only the run's TAIL needs help, because work-stealing fixes everything before it — and no file's cost is predicted, so adding a roster entry cannot make the ordering wrong. `tests/test-shards.test.mjs` holds both claims as executable assertions: every browser-lane file runs exactly once, and the fast gate's file set (`npm run test:unit`) is a subset of the full gate's.

### The Isolated Files (`ISOLATED` in `scripts/test-shards.mjs`)
Every browser file has its own Node process and ephemeral-port server; shared warm processes are scoped to one worker and each file's storage lives in a disposable CDP context. Specialized files still own their browser process. The worker width comes from `TIER_WORKERS.browser`. Two files are independent of the others but not of the box, and both run **alone, after the parallel queue**, with every assertion and exactly once.

**`tests/ldxa-barge-in-browser.test.mjs`** drives the real audio path through Chromium's fake-audio device, which the file's own comments record as lagging under CPU load (+76ms idle, +366ms at 4-core load). It was isolated because with four workers it failed `tests/ldxa-barge-in-browser.test.mjs:168` ("playback must be flushed, not left playing", `true !== false`) twice in nine concurrent runs of the whole tier while passing every focused control — alone, alone through the runner, and beside three other browser files at four-way concurrency. The same assertion with the same profile was already recorded as environmental in voicebox-beads-y82w. voicebox-beads-9c3r reproduced the timing deterministically: the synthetic socket scheduled echoes before the page's interrupt but delivered a queued echo after the client's synchronous flush, restarting playback. The fixture now checks whether it is paused when an echo is **delivered**, not only when it is scheduled; its browser regression deliberately defers one echo until after the flush, proving that playback stays off without weakening the existing assertion.

**A bashism in a `#!/usr/bin/env sh` gate is a parse error, not a style finding, so the file pins the shell.** `scripts/pre-push.sh` runs under dash (`/bin/sh -> dash` here), where `_x=()` and `${_x[@]}` are syntax errors: the hook then dies with exit 2 before any stage runs, and every push fails with no stage output — which reads as a red gate rather than a gate that never parsed. Measured while the full-manifest stage was written: adding one bash array made all nine fixtures in this file fail at once with `2 !== 0`, and only `sh -n scripts/pre-push.sh` named the line. `tests/pre-push.test.mjs` therefore checks the shebang, scans the comment-stripped code for arrays, `${x[@]}`, `PIPESTATUS`, `set -o pipefail` and `[[ ]]`, and runs `/bin/sh -n` (the same guard `tests/landing-preflight.test.mjs` holds for `scripts/landing-preflight.sh`).

**`tests/pre-push.test.mjs`** measures wall-clock budget enforcement, so the box is part of its subject. Its fixture accelerates each stage's budget through a `timeout` shim and asserts that the stage's output appeared BEFORE the budget killed it ("LIVE OUTPUT BEFORE TERMINATION"), then that the refusal reports the measured elapsed time rather than the configured budget. The chain it must outlast is `timeout → npm → sh → node`, and on a contended box that chain's startup is longer than the budget: measured 2026-10-12 on this VM, time-to-marker was 0.25s idle, 1.76–3.41s at loadavg 6 (32 CPU burners on 8 vCPU) and 5.2–6.3s at 8× oversubscription, while the shim's budget was 2s and the suite's own elapsed assertion accepts at most 10s — so no budget value was both large enough for a contended box and small enough for that assertion. At four workers the file failed the psfw union full gate (`tests/pre-push.test.mjs:227`, marker absent, slowest file 62.6s) and passed the xzrr union gate on identical blobs. It is also the tier's slowest file (67.3s under four workers versus 32.6s alone), so contention was costing it twice. It now runs alone, and its shim budget is 5s — a measured margin over the same chain rather than a coin flip (voicebox-beads-0nt3).


Isolation remains a **scheduling** mitigation rather than the repair: the file still runs exactly once with every assertion, and `tests/test-shards.test.mjs` proves the two phases partition the queue and every name in `ISOLATED` is still a real browser-lane file (a renamed test would otherwise rejoin the parallel run silently).

**A reload failure is evidence, not a timeout to waive.** The mini-app classification check in `tests/ux-bubble-stage.test.mjs` keeps its 20s file-list and 30s tray content waits in the parallel queue. On the passing path, the test first waits for the reload's actual CDP `/api/files` response within the original 20s budget, refusing failed/non-200, wrong-root, refused or wrong-file answers promptly; only a good response gets the remaining budget for the two exact named rows to render. The same readiness predicate must reject a missing-file mutant. `VOICEBOX_RTSR_DIAG_CONTROL=1` also drives that impossible name through a short bounded wait and asserts the failure capture includes the real API response, DOM rows and screenshot (opt-in, not on every full gate). The 75s outer test bound only accommodates the original 20s Files + 30s tray waits and diagnostic teardown; it does not extend either inner readiness window. With `VOICEBOX_TEST_EVIDENCE_DIR` set, the test saves browser screenshots before the save and after the reload. A failed wait records CDP `/api/files`, `/api/root` and `/api/mini-apps` request outcomes and response facts (when available), the browser's Files pane state and exception messages, and a screenshot path. A response with two files but no rows calls for a UI-render investigation; a refused listing, pending fetch or missing request calls for a different one. The 2026-10-13 union gate printed only `last value false`, so it cannot by itself justify calling the failure a load race or hiding the test in the isolated phase (voicebox-beads-rtsr).

**A turn's own record beats a report's current value.** `tests/tasks-browser.test.mjs` failed a union gate with `timed out waiting for unrelated native text form turn completed; last value false` (voicebox-beads-18lh), and the deadline was measured first because the obvious theory was one too small for the four-way queue: four copies with six CPU burners beside them (loadavg 7.05 on 8 vCPU, against the 8.5 that gate recorded) settled the turn in 564-776ms — about 20x inside the 15s default — so the deadline was not the defect and was not raised as if it were. What was wrong is what the arm looked at. It accepted only one of the report's two terminal values (`tone === "good"`), so the room's own refusal — which it writes as `tone === "bad"` WITH a sentence in `#turn-report` — was indistinguishable from a turn that never finished; a good report also LINGERS for `REPORT_FADE_DELAY_MS` (8s), so a report left by an earlier turn could satisfy the wait with no new turn at all; and nothing asserted that the click had reached the page. The arm now reads the form's own state before and after the click (the submit handler clears `#utterance` synchronously in the click's own task, so text still there means the real-mouse click never landed), waits for a NEW `#session-log` entry as well as a settled report, and on failure prints the page's state, the page's own `/live` frames and a screenshot. Driven: with `/api/turn` answering 503 the failure quotes `the turn did not reach the server: closed box: the turn route is refusing`; with a stale good report planted and no turn sent, the old predicate is satisfied and the new one is not; with `#send` disabled after the typing, the click is named instead of timing out.

---

## 3. Cross-Worktree Gate Locking & Exit Diagnostics

Before entering the `live` and `acceptance` stages on `main`, `scripts/pre-push.sh` acquires a host-wide file lock (`VOICEBOX_GATE_LOCK`, default `/tmp/voicebox-gate.lock`) and writes holder metadata to `VOICEBOX_GATE_HOLDER` (`/tmp/voicebox-gate.holder.json`). Concurrent landings wait for the lock rather than competing for Chromium instances (configurable via `VOICEBOX_GATE_LOCK_WAIT_SECS` or `VOICEBOX_GATE_LOCK_DISABLE=1`). `tests/pre-push.test.mjs` verifies serialization through event-driven observable synchronization (holding until the runner enters waiting, then releasing) and asserts negative controls for timeout refusal and free-lock acquisition.

**Releasing the lock must not silence the gate.** The close of the lock descriptor is guarded by a fd-2
redirect that has to stay **grouped** — `{ exec 9>&-; } 2>/dev/null` — because `exec 9>&- 2>/dev/null` has no
command word, and POSIX then makes *both* redirections permanent: fd 2 went to `/dev/null` for every line
printed after the release. The manifest stage is the only stage that runs after it, so a full gate refused
for a dirty worktree or an unreconciled roster exited 1 with a clean stderr and no reason a reader could act
on (measured: `sh -c 'exec 9>&- 2>/dev/null; echo x >&2'` prints nothing). `tests/pre-push.test.mjs` asserts
the manifest-stage refusal is readable, naming both the aggregator's line and the gate's own.

Each stage is bounded by GNU `timeout` with a 5-second kill grace period:
- **Exit `124` (`TIMED OUT`)**: Reports the stage name, command, and budget without mislabeling an unfinished run as a test assertion failure.
- **Exit `137` (`KILLED`)**: Reports that the process received `SIGKILL`.
- **Non-zero Exit (`FAILED`)**: Preserves full stdout/stderr and underlying network error codes (such as `ECONNREFUSED` or `UND_ERR_SOCKET`).

---

## 4. Landing Preflight — `scripts/landing-preflight.sh`

The gate answers *is this tree good*. A second question is asked in the minute right after it, before
the push, and until now every answer was hand-built on the spot: **would this push actually move the
branch I am landing, to the commit I just gated?** `scripts/landing-preflight.sh` answers that, once,
with an exit code (voicebox-beads-vto3).

It runs a `git push --dry-run` **at the real target ref** (`HEAD:refs/heads/main` on the real remote)
and reads the output as one of four verdicts. The order is the mechanism, not typography — a refusal
line also carries a sha, so a loosely-matched "success" pattern can be satisfied by a rejection:

| Verdict | Exit | Read from | Answer |
|---|---|---|---|
| `REFUSED` | 3 | output contains the literal `[rejected]` (tested **first**) | do not push: fetch, re-merge, **re-gate** the merged tree |
| `NO-OP` | 2 | output contains `Everything up-to-date` | do not push: this is a true statement about a ref that is not the landing |
| `OK` | 0 | a parsed row whose **both ends** are the landing — `<sha>..<sha>  HEAD -> main` — and whose new-side sha is a prefix of `git rev-parse HEAD` | push |
| `UNKNOWN` | 4 | anything else, **including a dry run whose command itself failed** | do not push |

**Both ends of the row are asserted, and that is the whole check.** A row names two refs: the thing
being pushed, and the ref it would land on. The first draft of this script matched only the left side,
and the cross-family review caught it: a dry run aimed at `wrong` printed `OK … origin/main would
move` — this tool committing the error it exists to prevent.

The way to assert a destination is **not** to paste it into a regular expression. That was the second
fail-open, found by probing the fix for the first: with `$LOCAL_REF` and `$TARGET` interpolated into
one ERE, `--target 'main|wrong'` turned the destination test into an *alternation* and answered OK for
a row landing on `wrong` — measured, same tree, same bytes. So the row is **parsed and compared
literally**: a fixed structural pattern with no substitution in it finds the candidate, the fields
(`old..new`, source, `->`, destination) are cut out, and each is compared with `[ … = … ]`. A flag can
only narrow the question, never widen it. `git rev-parse` gets the same treatment: it ECHOES an
unresolvable argument and exits 0 on git 2.43 (`git rev-parse 'HE.*D'` → `HE.*D`), so the precondition
peels with `--verify "$LOCAL_REF^{commit}"` and rejects anything that is not a hex sha. And a
`refs/heads/` prefix is normalised once, at the top, so the flag, the refspec and the comparison
cannot end up asking about different namespaces.

Two more answers, asserted rather than assumed, because both produce a false green if skipped:
`PRECONDITION` (5) refuses to ask anything when the worktree is dirty or when `HEAD` already equals
`<remote>/<target>` — an uncommitted merge leaves `HEAD` on the default branch, and then the dry run
happily reports `Everything up-to-date` about a landing that never happened. `IDENTITY-MISMATCH` (6)
fires when the row git would act on names a sha that is not `HEAD` here: the gated tree and the
offered tree are different trees.

**`HEAD` is the gated tree, and nothing moves that tie — including `--local-ref`.** That was the third
fail-open, found by the third-family reviewer and measured before it was fixed: the identity sha had
been derived from `--local-ref`, so with `HEAD` at one commit and a second branch at a later one,

    scripts/landing-preflight.sh --local-ref other
    OK  origin/main would move to 6ed23ce — the tree standing here (6ed23ce…)   exit 0

while the tree standing here was `4afd4d5`. The sentence was internally consistent and the verdict was
wrong: the gate ran on HEAD, so an offer that is not HEAD is not the gated tree, whatever the row says.
`HEAD_SHA` now comes from `HEAD` — `--verify`d and peeled, full stop; the offer is a separate sha, named
on the output line when it differs, and `--local-ref` can only change what is pushed, never what counts.

`--check` is the same trap in mode form: it asserts preconditions and **asks the remote nothing**, so its
exit 0 is not a clearance to push. It now prints that on its own answer line, because an "OK" a caller
could read as a verdict should say in the same breath that it is not one.

The sha length is **read from the row**, never hardcoded: git's abbreviation follows repository size
and `core.abbrev`, so 7 is a guess that breaks quietly on a big repo. The two refusal wordings this
repo has actually printed — `(non-fast-forward)` when the pushed tip is an ancestor, `(fetch first)`
when the tips have diverged and the object is not held locally — are matched by the `[rejected]`
marker alone, because the reason after it is git's prose and may change.

It is a plain script, not a hook: `.githooks/pre-push` and `scripts/pre-push.sh` stay unaware of it,
and a `--push-cmd` stub plus `--rehearse` lets every branch be driven without contacting a remote.
**Argument handling is a verdict-safety surface, not ergonomics.** A flag that is missing its value is
a usage error (exit 1), never a verdict code — and three ways of being missing were measured:

  * a bare value-flag (`--target` at the end of a line) used to die inside dash's `shift 2` with exit
    **2**, which is this script's own `NO-OP` code, so a mistyped command line answered "nothing to do"
    about a question it had not been asked;
  * a flag that **eats the next flag** — `--check --target --remote` — used to print
    `PRECONDITION-OK … target=origin/--remote` and **exit 0**, and the plain `--target --remote` form
    went on to build the refspec `HEAD:refs/heads/--remote` and ask the real remote about a namespace
    that cannot exist. A dash-leading value is therefore refused, naming the case;
  * and so is an **empty** one: `--check --target=` printed the same green `PRECONDITION-OK` with no
    target at all, because the tip compare it should have failed was against a ref that cannot exist
    either.

**The rule is a refname, not "non-empty".** That distinction was the reviewer's finding on the round
after the empty-value guard: `--target=refs/heads/` is non-empty, so it passed, and then became EMPTY by
stripping the prefix — `--check` printed `PRECONDITION-OK … target=origin/` and exited 0. The script now
asks git, rather than hand-rolling a test: `git check-ref-format "refs/heads/$TARGET"`, which on this
also refuses `//`, `..`, `.`, a name containing a space, `mai.*` and `ma[n]in`, and accepts `main`,
`min`, `main|wrong`, `feat/x` and `-x`. Anything refused is a usage error (exit 1) with the name echoed
back. One layer out, the same reasoning: `--remote=nosuchremote` used to spend a transport call to learn
`fatal: … does not appear to be a git repository` and answer UNKNOWN — correct but unreadable, and an
unconfigured remote is a fact about *this checkout*, so it is now `PRECONDITION` (5), naming the remote
and listing the configured ones.

Every value flag also accepts `--flag=<value>` — the escape hatch that keeps a genuinely odd value
(e.g. a filename starting with `-`) expressible, without letting the space-separated form swallow a
flag.
POSIX `sh` throughout (the `DASH, NOT BASH` case in `tests/landing-preflight.test.mjs` keeps it that
way, and the trap it had to fix was a real one: dash reads a `printf` format starting with a dash as
an option and dies with `Illegal option --`, which turned a `REFUSED` verdict into exit 2 until the
literals went through `printf '%s\n'`), and `tests/landing-preflight.test.mjs` drives the real refusals, the real update row
at four abbreviation lengths and a real forced-update row against a scratch repository with its own
local bare remote — so the classifier is proven against git's bytes, not against a transcription of
them.

```bash
scripts/landing-preflight.sh              # ask once, before pushing at main
scripts/landing-preflight.sh --rehearse    # every verdict, push stubbed, no remote touched
node --test tests/landing-preflight.test.mjs
```

---

## 5. Acceptance Read Idempotence Check

During `npm run accept`, the acceptance harness verifies that read endpoints are strictly idempotent:
1. Declares an isolated workspace root and seeds a known file before loading the browser page.
2. Issues three sequential `GET` requests to `/api/root` and `/api/files`, verifying that all responses match and report the exact file byte count.
3. Stat-checks the workspace directory afterward to verify that file contents, permissions, and nanosecond `mtime`/`ctime` timestamps were not mutated by read requests.

### Verification Suites
```bash
node --test tests/pre-push.test.mjs tests/test-changed.test.mjs tests/served-vs-disk.test.mjs tests/cdp-process-cleanup.test.mjs tests/transient-state.test.mjs
```

When verifying environment currency against the measured tree, `tools/page-acceptance.mjs` extracts static and query-bearing module and worker references (`new Worker(...)`, `new Worker(new URL(..., import.meta.url))`), naming any unwalkable dynamic templates in both clean and stale reports (`tools/served-vs-disk.mjs`, `tests/served-vs-disk.test.mjs`). Browser processes driven by `tests/lib/cdp.mjs` and `tools/page-acceptance.mjs` run in isolated process groups (`detached: true`) with `--no-sandbox --no-zygote --disable-crash-reporter`. `--no-zygote` prevents Linux zygote/PID-namespace init stubs from dropping signals and surviving as unkillable zombies. Synchronous `process.on("exit")`, `SIGTERM`/`SIGINT`/`SIGHUP`, and `finally` handlers ensure all processes in the browser's process group are reaped on normal close, abandon, signal termination, or unexpected test runner crashes, while monitoring crashpad handlers exit when the browser connection closes (`tests/cdp-process-cleanup.test.mjs`). The verifier that answers "did it really go?" is `/proc/<pid>/stat` rather than `kill(pid, 0)` — a zombie still holds a PID slot — and it fails CLOSED on purpose: only `ENOENT`/`ENOTDIR` mean "there is no such process", while any other errno (`EMFILE` under load, `EACCES` where `/proc` hides another user's processes) is rethrown, because reading a failed read as "gone" would turn it into a silent pass for a leaked browser (`voicebox-beads-3lwx`). That rethrow carries the `ps` table in its message, so an unexpected errno still says what the file saw instead of silencing the witness from inside the message it was meant to build (`voicebox-beads-fwed`); if `ps` itself cannot be run or fails, the message names why the witness is unavailable rather than presenting a misleading empty table (`voicebox-beads-kud3`).

Servers get the same treatment, which they did not always have: `tests/lib/server.mjs` reaped its detached children on `process.on("exit")` alone, and Node never emits that event for a signal, so a suite that was timed out or interrupted left its servers behind — one of them was only collected by the VM reaper after 122 minutes. It now registers `SIGTERM`, `SIGINT` and `SIGHUP` alongside `exit`, all four going through the one group-kill reaper, and a browser a test body spawns itself is registered with `trackBrowserProcessGroup` (`tests/lib/cdp.mjs`) so the same handlers cover it (`voicebox-beads-selv`). A subsequent ownership check (`voicebox-beads-o71l`) found that a failed or delayed kill could remove a still-live child from the reaper's set; only the child's confirmed `exit` event now releases ownership, and a timed-out stop retains its scratch directory until exit. A subprocess-only negative control simulates failed kills and checks the exit fallback without sweeping unrelated PIDs. This fixes the ownership gap; the cause of the originally observed green-tier orphan is still unknown. `tools/page-acceptance.mjs` already had both signal paths.

A test-name filter matching zero cases in `tests/voicebox.test.mjs` can run `test.after` before its asynchronous `test.before` finishes spawning a server. The suite publishes the `startServer()` promise before awaiting it and the after hook awaits/stops that exact child, including the zero-match path; a rejected start is already reaped by the helper. `tests/voicebox-hook-lifecycle.test.mjs` drives a disposable, bounded zero-match subprocess and checks the spawned server's exact PID/start time is gone afterward (`voicebox-beads-4thb`).

The phantom-turns browser case in `tests/voicebox.test.mjs` waits for its navigated document's own `load` **and verifies the actual text-form submit listener** before asserting zero POSTs on page load. That negative check stays: a page with seeded files must not send a turn by itself. Its positive control fails closed when the form/input is absent, the submit throws or the app does not cancel the synthetic event; it then waits, with a hard bound, for one matching CDP `/api/turn` request ID through response completion and one test-owned proxy ingress, rather than sleeping a fixed second. Blocking `fused.js` in the same browser is a negative control: the form still exists, but no listener intercepts it and no extra POST reaches the host. An opt-in `VOICEBOX_TEST_PHANTOM_THROTTLE=1` focused run throttles only that browser (4× CPU, 250ms RTT, 64KB/s) before navigation, reproducing the measured early-submit race without changing product code (`voicebox-beads-c8cq`). The old full-gate failure's cause is still unknown; this pins an observed test hazard, not an attribution of that failure.

The XSS assertion in `tests/voicebox.test.mjs` checks the CSP on the **served** `GET /` response (header and parsed meta), not a grep over raw HTML comments. It fails closed on absent or malformed `script-src`, checks inline script and handler permissions across simultaneously enforced policies, and pins both the prose-only comment that must pass and a genuinely permissive reordered policy that must fail (`voicebox-beads-8tk2`). The application CSP is unchanged.

**The transient-state shape is guarded by a static scanner (`voicebox-beads-zjpm.5.3`).** `npm run transient:check` (`scripts/transient-state.mjs`, tested by `tests/transient-state.test.mjs`) scans browser-lane tests for fixed delays immediately preceding assertions on page state — the defect shape that produced intermittent flakes across `jeye`, `y1db`, and `18lh`. Candidates must be cleared by a named clause (`ABSENCE`, `IN-PAGE`, `NO-ASYNC`, or `DELAYED-READ` for a page read immediately asserted on the following statement) or the scan fails closed (exit code 1) naming the file and line. A loop alone is not a `POLL` clearance: a real poll re-checks the observable after sleeping, before the assertion, so it does not match the immediate-delay shape. Optional `--list` reports exact status assertions (single-/double-quoted strings or counts) without a preceding executable wait on the same observable **in the same test and a block that encloses the assertion** (a braceless conditional wait, commented-out wait, or wait named only in a test title does not clear it; an executable direct or static string-form callback on that observable does; dynamic/concatenated callbacks are not resolved statically), with an inline/public page-writer location where found or `writer: unknown` for review. A sleep at a loop's end followed by a one-shot page assertion outside the loop is still a candidate. `NO-ASYNC` inspects the assertion's compared operands, not its optional failure message. The list does not determine the gate verdict.

One case in `tests/pre-push.test.mjs` — the one that asserts a dropped front is named as a network
cause — drives `tools/page-acceptance.mjs` end to end and therefore needs a REAL browser. Without one
it SKIPS BY NAME with that reason rather than failing: the browser lane always provides a browser, and
a standalone run without one is a named precondition, not a verdict on the network naming it asserts
(voicebox-beads-80vw).

Which browser that is comes from ONE place: `lib/browser-binaries.mjs` (`browserCandidates()` /
`findBrowserBinary()` — `VOICEBOX_CHROME` first, then the system paths, read at call time). The test
driver, `tools/page-acceptance.mjs` and the phantom-turns case in `tests/voicebox.test.mjs` all ask
it and pass the resolved path down; `tests/browser-binaries-owner.test.mjs` fails if a second
candidate list (two or more browser-path literals in one file) or a second `VOICEBOX_CHROME` READ
reappears — scanned across `.mjs`/`.js`/`.cjs`/`.mts`/`.cts`/`.ts` under the repository, excluding
`node_modules`, `.git`, `docs/` (prose), `.beads/` (task state), `workspace/` (a root the product
writes) and the guard file itself (its own patterns and fixtures contain the strings it hunts for,
bounded by a scanned-count assertion). That includes `tests/`, which the standing
`scripts/single-owner.mjs` check deliberately does not scan — one of the three copies lived there,
which is why nothing else could see it. A message that merely NAMES the variable is documentation,
not a read (the same call `single-owner.mjs` makes for comments); `public/verify.mjs` is a named
exemption for its own `CHROME` variable and single literal, and the guard speaks if it grows a list
or reads `VOICEBOX_CHROME` (voicebox-beads-phs9).

---

## 5. The Scoped Fast Gate and its Coverage Record (`--gate`)

`scripts/test-changed.mjs --gate` is the repository's own fast tier: the same changed-path selection the
inner-loop runner uses, with the three differences that make its verdict quotable (voicebox-beads-zjpm.3,
ADR voicebox-beads-zjpm.1).

```
node scripts/test-changed.mjs --gate                 # the fast gate for the branch's changed paths
node scripts/test-changed.mjs --gate --dry-run       # select and record, dispatch nothing
node scripts/test-changed.mjs --help                 # show accepted options, no git/test/manifest action
node scripts/gate-manifest.mjs verify <artifact>     # reconcile an artifact without re-running anything
```

It is the command a lane should point `CHECK_FAST_CMD` at. It is deliberately **not** a second
orchestrator for the full suite: `--gate-kind full` exists so the same accounting can be applied to a
merger's union, and a full gate may not omit a classified file at all.

- **Fail-closed invocation (voicebox-beads-hqst).** The CLI accepts `--dry-run`, `--json`, `--gate`, `--allow-unmapped`, `--base <ref>`, `--gate-kind <fast|full>`, `--manifest-dir <path>`, `--help`/`-h`, positional changed paths and `--` to end option parsing. An unknown flag (including `--flag=value`) or an option missing its value is refused with exit 2 before git selection, test dispatch or manifest creation. `--gate-kind` and `--manifest-dir` require `--gate`; gate mode does not accept developer-only `--json`. `--help` prints usage and exits 0 without those actions, even if a test path is supplied; unknown/malformed flags still refuse alongside help. Module imports may still read the test roster, so this guarantees no action, not instant startup. `tests/test-changed.test.mjs` drives negative invocations under a disposable no-child-process preload and asserts that no manifest is created.
- **Strict scope.** `--allow-unmapped` is a developer escape and the gate refuses it outright (exit 2): a
  gate that may be told to ignore a path it cannot map has no scope, and its PASS is a statement about
  nothing. A mapped test file that is in **no** lane is refused by name rather than quietly run in the
  unit lane, which is what the old `else matchedUnit.push(file)` fallback did.
- **Per-file dispatch.** Each selected file runs in its own process with its own exit code, TAP counts,
  duration and bound, so "PASS" can be attributed to a file. The `ISOLATED` files (`tests/pre-push.test.mjs`,
  `tests/ldxa-barge-in-browser.test.mjs`) run alone, after the parallel queue.
- **The tier's own concurrency and queue.** Each tier runs at `TIER_WORKERS` — the one owner in
  `scripts/test-shards.mjs`, the same counts the full gate dispatches at (`availableParallelism() - 1` for
  unit, 4 for the server lane, 3 for the browser tier's shards), overridable for a loaded box with
  `VOICEBOX_FAST_WORKERS`. The parallel pool is ordered by `buildQueue` from that same module, i.e. the
  queue the browser tier already runs from, heaviest-first. Both are scheduling facts and neither changes
  the scope: nothing is dropped, reordered INTO omission, or narrowed — a file the changed-path map selects
  is dispatched exactly once. This was a measured defect, not a preference (`voicebox-beads-buy8`): the gate
  hard-coded **2** files in flight, a number no tier runs at, so a change to `public/fused.js` — whose
  dependency closure is 159 of the 224 classified files — was killed at the fleet's 180s fast bound twice
  (exit 124, STALE) where the tier's own concurrency costs **190s** on the same tree, and taking the pool's
  order from `buildQueue` takes the modeled tier-serial total from 207.4s to 181.7s (longest-first ideal:
  179.2s). The fleet speed standard's R2 budget for the median fast gate is **≤60s** and this does not
  reach it: a UI-monolith change pays a browser-heavy closure, and the structural route is the
  `public/fused.js` decomposition (`voicebox-beads-mvxl` / `uei2`), not a narrower map.

- **Route-scoped change detection (`lib/routes/*.mjs`, voicebox-beads-ybwq).** When a commit modifies exclusively
  route leaf modules in `lib/routes/*.mjs` without touching `server.mjs` or shared lib infrastructure,
  `scripts/test-changed.mjs` avoids transitively expanding `server.mjs` to all 150+ importers. It dispatches the
  route's direct unit and seam tests plus a bounded server smoke test (`server-lifecycle.test.mjs`), recording
  bypassed transitive server importers explicitly in `manifest.route_scoping` and labeling omitted entries with their
  route-scoped reason. In-memory route testing with `tests/lib/route-harness.mjs` (`invokeRoute`) allows route unit
  tests to execute in <5ms without socket overhead.

- **WHY THE BROWSER TIER IS THREE SHARDS, MEASURED (`voicebox-beads-q4j6`, `voicebox-beads-q4j6.1`).** The browser
  tier's width is a correctness fact before it is a speed one. Two full-gate unions at four shards were red on **different**
  sets of files; reducing to two shards eliminated flakes but cost 750.1s browser-tier wall time. Width 3 provides full stability
  with a 4.07x browser-tier wall time throughput speedup.

  | union (tree)            | browser shards | browser tier                     | browser wall | whole gate | verdict |
  |-------------------------|----------------|----------------------------------|--------------|------------|---------|
  | `4c1441b` (merger batch3) | 4            | 89 files, **8 failed**           | —            | 1095s      | RED     |
  | `c47991b` (batch3, later) | 4            | 89 files, **3 failed (different)** | —          | 670s       | RED     |
  | `e22f9ed` (tree `aef9e6e1`) | 2          | 89 recorded, **0 not passed**    | 750.1s       | 984s       | GREEN   |
  | `1c158b6` (q4j6.1 candidate) | 3        | 92 recorded, **0 not passed**    | **184.2s**   | tier only  | **GREEN** |

  Every file that failed under four shards passes **standalone** (7/7 in 48s at the first red union; all
  eight pass standalone at `4c1441b`), and neither red union carries product changes against a green main —
  so four shards was not measuring the product, and it was not oversubscription outside the tier either
  (every other lane was held off browser and burner work for `c47991b`). A red whose failing set changes run
  to run cannot be attributed to a file by any reader, and nothing may retry, isolate or widen a bound to
  cover it. Two shards bought a reliable gate, but cost 750.1s on the browser tier.
  Empirical measurement of width 3 (`voicebox-beads-q4j6.1`) verified all 92 browser test files pass
  cleanly with zero timeouts, reducing browser-tier wall time to **184.2s** (a 4.07x browser-tier speedup saving
  565.9s / ~9.4 minutes of browser-tier wall time across all 92 browser test files).
  The validation run on candidate `1c158b6` validates clean (92 recorded, 0 not passed, wall 184.2s).
  The width has ONE owner (`TIER_WORKERS.browser` in `scripts/test-shards.mjs`) and the runner carries no
  default of its own, because the gate spawns it with no `--workers` — a second default there would be the
  real width while the gate logged the owner's.

  **What three shards means for the FAST path, said out loud.** The fast gate dispatches its own browser lane at
  `TIER_WORKERS.browser` too, so widening from two to three workers improves fast-gate turnaround as well: on the 159-file
  `public/fused.js` closure (`voicebox-beads-buy8`), three workers reduces browser lane dispatch from ~273s at two
  workers closer to the 180s fast bound (though `VOICEBOX_FAST_WORKERS=4` remains available as an override on loaded
  boxes). Small closures pay seconds either way. This is disclosed rather than papered over with a second width in
  the runner — the structural answer for that closure remains the `public/fused.js` decomposition (`mvxl` / `uei2`).
- **A lost child is not a pass.** A file that produced no TAP summary is `unknown` — never `passed` — and
  the gate refuses on it. Per-file results wait for the child's `close` (including drained output pipes)
  before parsing counts: `exit` may arrive before the final TAP footer, so reading there invents a missing
  summary. A child still silent after `close` remains `unknown` (`voicebox-beads-9xvq`).

### The blind spot for shared test infra, and its budget (`voicebox-beads-55wl`)

`tests/lib/*.mjs` is shared by most of the suite and imported mostly from the browser tier, so the fast gate
proves almost nothing about an edit to it. Measured with the gate's own mapper: `tests/lib/cdp.mjs` is reachable
from 89 files of which **1** is in the unit lane, and `tests/lib/server.mjs` from 171 of which **24** — 14% of the
harness every server test uses. The gate therefore said "tree is sound" about a change it could not see, and lanes
hand-ran a browser subset on trust rather than ship unverified (two did, in one session).

`scripts/infra-affected.mjs` closes the **selection** half: for a change touching one of those helpers it picks a
**bounded, deterministic** subset of the affected browser tests — the helper's own name-prefixed tests first, then
by name, at most `INFRA_CAP` (**4**) — and reports the tier's whole blast radius alongside an `affectedUnrun.browser`
record naming what it deliberately left. The cap is a constant, not a parameter, so a branch under test cannot
enlarge the subset that verifies it. A change that does not touch shared infra returns `applies: false` and costs
nothing, so no implementer is taxed for this.

**Budget.** The fast path is `CHECK_FAST_CMD` under a 180s bound, and the unit lane it runs today measures ~22s, so
this class has roughly **150s** of headroom. The selector itself costs the fast gate **0.6s** (7 tests, 614ms,
measured), and getting it there was the work: the obvious version imported `scripts/test-changed.mjs` (**4.3s** at
import, because it builds the test inventory) and each `mapToTests` call costs ~**2.3s** with no cache, which added
13s to a 22s lane. The **subset run's own wall time is measured from the runner that executes it**; the cap exists
so that it stays inside this bound rather than being discovered to exceed it in the queue.

**Precondition, not a preference: the accounting travels with the run - and the mechanism already exists.**
Verified against gate-recover's `fleet/zjpm6-host-context`: `scripts/gate-manifest.mjs`'s `SELECTION` already
includes `not-selected`, and `recordFile` **refuses** an omitted file with no reason, so recording each skipped
affected file as `not-selected` with a reason is both the honest accounting and a manifest-level enforcement of it.
The **skipped files** need no new field. The **aggregate record** does: a per-tier entry naming the subset and its counts is additive, i.e. a manifest **v3** bump inside the same combined change (`v2` is spent on the host block), with `affected_not_run` deriving from the file records' own `selection`/`dispatch` and a disagreeing count refused by name. What *does* need building is the **count at the
reader**: `verdictOf` returns `pass` when every *dispatched* file passed, and an omitted file is never dispatched,
so five green out of sixty affected reconciles and reads `pass` unless the reader's own line prints what was left.
A verdict that cannot see an omission is the silence-reads-as-completeness trap with extra steps, so the subset
mode does not run until that line exists.

### The coverage contract for a page-loaded module (`voicebox-beads-buy8`)

`.fleet/coverage-contract.json` declares, per source path, the suites that exercise it. It exists because
**the fleet's independent coverage oracle cannot see a module the page loads**: `~/fleet/remote/check-coverage.py`
(`find_candidate_tests_for_file`) looks for a candidate suite by import/require/subprocess reference or by
filename stem, and `public/fused.js` — the UI monolith, loaded by `public/index.html` as
`<script type="module" src="fused.js">` — is neither imported nor named after any suite. The oracle therefore
found zero candidates for it and published `coverage: PARTIAL, unmapped: ["public/fused.js"]` on a run whose
own manifest recorded **159 dispatched, 0 unmapped** (`voicebox-beads-zjpm.3`).

The contract is the mechanism the oracle already supports for exactly this case (fleet-`1n0z` mode b); no
fleet tooling change is involved. Its rule is the reason it is trustworthy: **every suite it names must be
dispatched, or the record is PARTIAL again** — a suite that has stopped covering the file is named, not
ignored. The witnesses here are the suites the changed-path map dispatches for `public/fused.js` that drive
it directly: the browser suites that serve the real page (which loads the module) plus
`tests/served-vs-disk.test.mjs`, which asserts the served copy of every module reference matches disk.

Measured 2026-10-14 against the real fast-gate log for tree `7a5e9157` (`fast-gate` markers for 159 suites):

| contract | oracle verdict |
|---|---|
| as committed | `coverage: KNOWN`, `unmapped: []`, `omitted: []` |
| removed | `coverage: PARTIAL`, `unmapped: ["public/fused.js"]` — the reported defect |
| one witness replaced by a suite that never ran | `coverage: PARTIAL`, `unmapped: ["public/fused.js"]`, `omitted: ["tests/a-suite-that-never-ran.test.mjs"]` |

### The artifact

`~/.fleet/checks/<tree>.<fast|full>.manifest.json` (override with `--manifest-dir` or
`VOICEBOX_GATE_ARTIFACT_DIR`), written atomically and keyed by the **tree SHA** it describes, the gate
kind, and a **roster hash** over the classifier's `(file, tier, why)` output. `tree_dirty` records that
the artifact was produced over uncommitted bytes, so a dirty run cannot be quoted as if it were clean — and
on a **full** (landing) gate it is a refusal rather than a note: only the `fast` gate marks a dirty run and
continues, because that is the gate you run on work you have not committed yet.

Every classified file is accounted for exactly once: dispatched (with its terminal status, counts,
duration and timeout) or **omitted by name with a reason** (`fast-only: not selected by the changed-path
map`).

**Every record also states WHY it was selected, and the aggregator never supplies that reason:** `changed`
(the test file itself changed), `dependency` (a changed source maps to it), `full-roster` (the whole roster was
the scope) or `not-selected` (the changed-path map did not pick it — the honest value for the files a fast gate
omits). A record with no selection reason is a refusal, not a default. It used to fall through
`entry.selection ?? "changed"`, which was the one value a fast gate could least often support: measured on this
branch, a gate over 9 changed paths recorded all 223 classified files as directly changed, contradicting the
manifest's own `changed` list (voicebox-beads-zjpm.3).

`scripts/gate-manifest.mjs` reconciles the artifact and refuses, naming each problem, on:

| refusal | what it catches |
|---|---|
| duplicate / unclassified / missing path | a file recorded twice, recorded but not in the roster, or neither dispatched nor omitted |
| malformed tier / status / marker | a tier that disagrees with the classifier, a non-terminal status, a missing counts block |
| lost child | dispatched with no duration — the exit was lost, which is not a verdict |
| zero-test result | a **passing** run that reported zero tests: an empty run demonstrates nothing |
| contradictory counts | a passing record whose own counts carry failures |
| omission without a reason | an unexplained gap in scope |
| full-gate omission | any omitted file in a `--gate-kind full` run |
| unmapped source | a changed source file that maps to no test |

### The artifact's verdict

`verdict` is one of `pass` (every dispatched file finished green), `fail`, `refused` (an unmapped changed
source or an unclassified mapped test), `empty` (nothing was dispatched — a run that measured nothing,
which is **never** called a pass) or `dry-run`. The reconciled `summary` carries `classified`, `recorded`,
`dispatched`, `omitted`, `skipped`, `passed`, `failed`, `timeout`, `unknown`, `unmapped` and `problems`, so
"0 dispatched" is visible in the artifact itself rather than only in the log's absence of a green line.

`verdictOf(manifest)` is the **one** answer to "what does this manifest mean" — `refused` when it does not
reconcile, `fail` when any dispatched file is not `passed` (timeout and unknown included), `empty` when
nothing was dispatched, else `pass`. It is exported for every orchestrator that folds records, so the
"an unfinished file is not a pass" half cannot be re-derived differently by a second caller.

### The markers the hub reads

Every dispatched file prints, at line start, a marker from the vocabulary `fleet-check`'s coverage
extractor matches:

```
fast-gate: passed:  tests/<file>      # or failed:, or unknown: with the reason
fast-gate: unmapped: <changed file>   # a changed path the gate could not map
fast-gate: unknown: <reason>          # emitted whenever the run is incomplete
```

**Only TERMINAL markers are published, and `running:` deliberately is not.** The hub's extractor unions
every marker it matches — `running` included — into the set of suites it believes ran, so a `running:`
line for a file that was later killed is read as *coverage*, and a killed process cannot retract it.
Measured on a real stopped run (19 selected files, stopped part-way): the extractor answered
`coverage: KNOWN, indeterminate: false` and listed the file that had only ever been printed as running.
Progress is therefore a plain log line (`[test:changed] running tests/<file>`); a file appears in the
marker vocabulary only once it has a terminal status, and an unfinished dispatch is a gap the hub reports
as uncovered rather than as a suite that ran.

`tools/browser-shard-runner.mjs` emits the same per-file markers for the full gate's browser tier, and
with `VOICEBOX_GATE_TIER_RECORD=<path>` writes a **tier record** (what that tier dispatched) which the one
aggregator folds in with `recordTier`. A tier never writes a manifest of its own: a partial manifest that
happens to reconcile is a wide claim from a narrow run. Because `running:` is also read as evidence that a
file executed, `unknown:` is emitted together with any incomplete run — that is what makes the hub report
the run's coverage as `UNKNOWN` (fail-closed) instead of counting a killed file as covered.

### The live tier's phases, and the union receipt

`tools/browser-shard-runner.mjs` can be invoked once for the whole browser lane, or PHASED so a supervisor
runs the parallel queue beside the server pool and the isolated files afterwards on an otherwise idle box:

```
node tools/browser-shard-runner.mjs                    # whole lane: parallel queue, then ISOLATED alone
node tools/browser-shard-runner.mjs --parallel-only    # just the parallel slice
node tools/browser-shard-runner.mjs --isolated-only    # just the ISOLATED slice, one at a time
```

Each invocation asserts its own slice covers exactly once, and `splitQueue` (scripts/test-shards.mjs) owns
the partition, so the two slices together are the lane — held by `tests/test-shards.test.mjs`. The two flags
are mutually exclusive, and the per-file terminal markers and count lines are unchanged. With
`VOICEBOX_GATE_TIER_RECORD=<path>` a PHASED run writes `<path>.parallel.json` / `<path>.isolated.json`, so a
second invocation can never overwrite the first's record.

Because the tiers are separate processes, no single runner can assert the gate's scope: the receipt is the
FOLD, and `scripts/gate-manifest.mjs aggregate` is its one implementation.

```
node scripts/gate-manifest.mjs aggregate --gate full --tree <tree-sha> --out <dir> \
  --record <tier-a.json> --record <tier-b.json> ...

# what scripts/pre-push.sh runs: the records the three tiers wrote, and the changed set to check against
node scripts/gate-manifest.mjs aggregate --gate full --tree <tree-sha> --tier-dir <scratch> \
  --changed-base origin/main
```

It builds the roster from the classifier, folds every tier record, refuses (non-zero, with the file named) a
file no tier recorded, a file two tiers both recorded, a path no tier knows, and any omission in a full
gate — and writes one manifest with the verdict. A deliberately narrower gate passes `--omitted-reason` so
its unselected files are accounted for by name rather than left missing.

`--tier-dir <scratch>` is the form the full gate uses: it reads `<scratch>/unit.json`, `<scratch>/server.json`
and `<scratch>/browser.json` — one record per tier, in the directory `scripts/pre-push.sh` owns for that run,
named by `tierRecordPath` so the writer and the reader cannot disagree. A tier that wrote NOTHING is refused
by name (`the browser tier wrote no record at …`), because a missing process and a tier whose every file
failed are different facts and the reader of a red landing needs the first one. The artifact records that
refusal ON DISK, not only on stdout: a run the fold refuses is rewritten as `reconciled: false`,
`verdict: refused` — an earlier version left the `pass` it had written before the caller's own problems were
known, which is a receipt contradicting the gate that produced it. `--changed-base <ref>` records the changed
set (`<ref>...HEAD`), records the ref itself as `base`, and refuses a changed source file that maps to no
test, asked of the mapping's owner through its own `--json` CLI; that refusal is the same one the fast gate
makes, over the union being landed. **The base must name a commit**: the mapping's `--json` developer path
answers a base it cannot resolve with an empty change set and exit 0 (git's `ambiguous argument` goes to
stderr), so the fold resolves the ref first and refuses when it does not — unknown scope is not empty scope.
The whole check is off when no base is named, so an aggregate over JSON records behaves as it always did.

The wiring is held by tests rather than by this paragraph: `tests/gate-tier.test.mjs` drives the tier runner
and the fold (including a dropped file, a duplicate, a zero-test pass, a missing tier record and a failed
file, each refused by name), and `tests/pre-push.test.mjs` drives the real gate in a disposable repository and
asserts that a green run seals ONE `<tree>.full.manifest.json` accounting for all three lanes while a red tier
seals none.

### Acceptance is per phase

`npm run accept` prints a verdict per phase. When the shared front could not be witnessed, phase A is
reported `UNKNOWN` for the shared front and the run ends `ALL CLEAR (PHASE B ONLY)` with the statement
that the shared front was **not** verified: green code tests and an approved phase-B-only posture may
coexist, but no reader (or gate log) may quote that run as having measured the served front.
