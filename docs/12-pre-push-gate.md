# Testing Lanes & Pre-Push Gate

Voicebox enforces a multi-stage verification gate on `git push` via `.githooks/pre-push` and `scripts/pre-push.sh`. Tests are automatically classified into fast concurrent unit tests and isolated live integration tests by `scripts/test-lanes.mjs`.

---

## 1. Branch vs. `main` Push Policy

- **Candidate Branch Pushes (`git push origin <branch>`)**:
  Runs only `node scripts/docs-touched.mjs` and the fast `unit` test lane (`npm run test:unit`), then exits immediately. This keeps worktree branch pushes fast and lock-free.
- **Landing on `main`**:
  - Pushing to `main` from a non-`main` branch is refused immediately (`[gate] pre-push REFUSED: non-main branch attempting to push to main ref`). Always create worktrees with `--no-track` (`git worktree add --no-track -b <branch> <dir> origin/main`) so worktree branches do not track `origin/main`.
  - Pushing from `main` to `origin/main` runs the full verification pipeline (or fast-paths docs-only `*.md` changes through `docs-check` and `single-owner`), caching the verified `HEAD^{tree}` SHA in `.git/voicebox-gate-passed-tree`.

---

## 2. Gate Stages & Timeouts

| Stage | Command | Execution Mode | Default Timeout |
|---|---|---|---|
| **Docs Touched** | `node scripts/docs-touched.mjs` | Static `git diff` check | Immediate |
| **Unit Suite** | `npm run test:unit` | Concurrent across files | `180s` |
| **Live Suite** | `npm run test:live` | Server lane (`--test-concurrency=4`) + Browser CDP lane (`--test-concurrency=1`) | `400s` |
| **Acceptance** | `npm run accept` | End-to-end headless Chromium verification (`page-acceptance.mjs`) | `45s` |

### Automatic Test Lane Classification (`scripts/test-lanes.mjs`)
`scripts/test-lanes.mjs` lexes every `tests/*.test.mjs` file (ignoring comments and fixture string writes) to classify it into the appropriate lane:
- **`unit` lane**: Pure logic, state machine, and worker tests (including `tests/wasm-shelf.test.mjs` and `tests/docs-drift.test.mjs`) that do not spawn `server.mjs`, `createServer`, `task-fixture.mjs`, or headless Chromium.
- **`live` lane**:
  - **Server sub-lane (`--lane server`)**: Spawns `server.mjs` or HTTP servers without launching a browser; runs with `--test-concurrency=4`.
  - **Browser sub-lane (`--lane browser`)**: Launches headless Chromium over CDP; runs serially (`--test-concurrency=1`) to prevent browser CPU contention.

---

## 3. Cross-Worktree Gate Locking & Exit Diagnostics

Before entering the `live` and `acceptance` stages on `main`, `scripts/pre-push.sh` acquires a host-wide file lock (`VOICEBOX_GATE_LOCK`, default `/tmp/voicebox-gate.lock`) and writes holder metadata to `VOICEBOX_GATE_HOLDER` (`/tmp/voicebox-gate.holder.json`). Concurrent landings wait for the lock rather than competing for Chromium instances (configurable via `VOICEBOX_GATE_LOCK_WAIT_SECS` or `VOICEBOX_GATE_LOCK_DISABLE=1`).

Each stage is bounded by GNU `timeout` with a 5-second kill grace period:
- **Exit `124` (`TIMED OUT`)**: Reports the stage name, command, and budget without mislabeling an unfinished run as a test assertion failure.
- **Exit `137` (`KILLED`)**: Reports that the process received `SIGKILL`.
- **Non-zero Exit (`FAILED`)**: Preserves full stdout/stderr and underlying network error codes (such as `ECONNREFUSED` or `UND_ERR_SOCKET`).

---

## 4. Acceptance Read Idempotence Check

During `npm run accept`, the acceptance harness verifies that read endpoints are strictly idempotent:
1. Declares an isolated workspace root and seeds a known file before loading the browser page.
2. Issues three sequential `GET` requests to `/api/root` and `/api/files`, verifying that all responses match and report the exact file byte count.
3. Stat-checks the workspace directory afterward to verify that file contents, permissions, and nanosecond `mtime`/`ctime` timestamps were not mutated by read requests.

### Verification Suites
```bash
node --test tests/pre-push.test.mjs tests/test-changed.test.mjs
```

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
