# 3lwx — CDP process-cleanup gate red: the leader PID was read, not the process

**Bead:** `voicebox-beads-3lwx` (P2, `gate-reliability`; blocks `voicebox-beads-sodf`)
**Branch:** `fleet/roboticon-3lwx` (test-only fix, from `origin/main` `d2a2db6`)
**The red gate preserved:** `51d69725e840ecb00fe5d2048cbc8fcf9c308bde.json` — `FAIL`, band `miniapps`,
sha `f517537`, rc 1, 474s, log `/home/exedev/.fleet/checks/51d6972….log`. Its verdict is unchanged and
this work does not reuse it.

## The failure, twice

| Run (VM-local check log) | Tree | Duration | Failed assertions |
|---|---|---|---|
| `4fef5a07…` 06:55Z | `c4fad25` (miniapps) | 719s | `tests/cdp-process-cleanup.test.mjs:89` — leader PID after `page.close()` |
| `51d6972…` 11:53Z | `f517537` (miniapps) | 474s | `:89` **and** `:200` — leader PID after SIGTERM |

Always the **leader-PID** assertion; the group-empty and profile-process assertions never run because
that one fails first. `tests/cdp-process-cleanup.test.mjs` and `tests/lib/cdp.mjs` are byte-identical
in the roboticon and miniapps worktrees, so this is shared code, not the miniapps branch. Isolated
runs of the file are 3/3 green. At 11:53 the box was running **two full gates at once** (load ≈ 4.8 on
2 CPUs, `/tmp` on ext4 — disk, not tmpfs).

## The mechanism

`process.kill(pid, 0)` answers *"does this PID exist"*, not *"is this process still running"*. It
answers YES for a process that has already terminated and is only awaiting collection — a zombie,
state `Z` — and YES for an unrelated process that has since been given the same PID. The old wait
asked that question 20 times, 50 ms apart, and called a yes a survivor. So a teardown that was slow,
or already dead but not yet collected, was reported as a **leaked browser**.

## The controlled experiment (`old-helper-repro.mjs` → `old-helper-repro.log`)

The old helpers verbatim from `d2a2db6`, the new witness beside them, and what was independently true
of each process. No browser and no load: the question is how a PID is read, and three processes
isolate it. Run with `node docs/evidence/3lwx-cdp-cleanup-20261008/old-helper-repro.mjs`.

| Condition | Truth | old check | new witness |
|---|---|---|---|
| A real zombie, its only collector SIGSTOPed before the child was killed | terminated (`Zs sleep`, `kill(pid,0)` → `true`) | **SURVIVOR** (false leak report) | terminated |
| A teardown the kernel collects at **1800 ms** | terminated, absent from `/proc` afterwards | **SURVIVOR after 1037 ms** (false leak report) | terminated after 1845 ms |
| A process that is really still running | running (`Ss sleep`) | SURVIVOR | **SURVIVOR** — the leak check is not blanked |

Row 1 is a *real* zombie, not a constructed one: the reaper is stopped (`T`) **before** the child is
killed, so libuv cannot collect it and the slot stays occupied with state `Z`. Row 2 reproduces the
reported failure without load — the old bound decided it at ~1 s.

## The fix (test-only, `tests/cdp-process-cleanup.test.mjs`)

- **The witness is `/proc`.** `procSnapshot(pid)` reads state and `starttime` (field 22 — the
  process's own clock ticks since boot, an identity a reused PID cannot match; `comm` is
  parenthesised so the fields are read after the last `)`).
- **`pidTerminated(pid, identity)`** is true when the slot is free, when the holder is a zombie, or
  when the start time differs from the one taken before the kill. False only while a *live* process
  still holds the identity we killed.
- **The group and profile checks ignore zombie rows** — a zombie is an uncollected exit, not a
  running descendant. A live sibling in the same group is still counted.
- **The bound is load-tolerant** (100 × 100 ms) rather than one second, and it is the *secondary*
  half: the primary fix is state/identity, and a genuinely running process still fails, now with a
  failure message that names the state (`STILL RUNNING (state R)` vs `a ZOMBIE`) and the pid's own
  `ps` row. This is not a timeout bump standing in for a mechanism — rows 1–3 above are the proof.
- Where `/proc` does not exist (macOS) the helpers fall back to the old question and say so; the
  zombie case skips itself rather than pretending.

**The three browser tests are unchanged in what they claim**: the leader we launched has terminated,
its process group holds no running process, and no Chrome helper survives for the profile.

## The file, after (6 tests, all green)

```
✔ cdp-process-cleanup: normal page.close() terminates browser process group and leaves zero descendants
✔ cdp-process-cleanup: negative throw-control — unhandled runner crash reaps browser without orphan helpers
✔ cdp-process-cleanup: signal termination — SIGTERM reaps browser process group without leaking processes
✔ cdp-process-cleanup: a terminated process awaiting collection is not a survivor — and its group is empty (voicebox-beads-3lwx)
✔ cdp-process-cleanup: a teardown that outlasts one second is not read as a leak (voicebox-beads-3lwx)
✔ cdp-process-cleanup: a process that is really still running is still reported as a survivor (voicebox-beads-3lwx)
```

The last three need no browser and are ~2.5 s together; they pin the distinction the fix rests on, so
the reading of a PID cannot drift back.

## Review fixes (before the gate)

An independent cross-family review (`antigravity/gemini-3.1-pro`) returned **FAIL** on two points, both
fixed in the commit that follows `bf61af2`:

- **A failed read could be read as a terminated process.** `procSnapshot`'s bare `catch` returned
  `null` for *any* error, so an `EMFILE`/`EACCES` read of a LIVE leaked browser would have said
  "terminated" — a silent pass for the exact thing this file exists to catch, under exactly the load
  that produced the original red. Only `ENOENT`/`ENOTDIR` now means "absent"; anything else throws and
  fails the test loudly.
- **Test 1 could orphan its own child on the failure path.** `sleepPid` was scoped inside the `try`, so
  an assertion that failed before the kill left a detached `sleep 600` running for ten minutes. It is
  now declared outside and killed in the `finally`, along with the runner.

Its other answers were positive: the starttime index and the zombie regex are correct and confined to
`ps`'s `STAT` column, the bound is justified by the reproduction rather than standing in for one, the
change is test-only and weakens no claim of the three browser tests, and this receipt overclaims
nothing beyond `old-helper-repro.log` and the gate `.json` files.

## The combined-tree gate

The fix was fixed on `origin/main`; the gate ran on the **combined tree** — this fix merged with
`fleet/miniapps-sodf` @ `f517537` (the exact tree that went red), assembled locally in the roboticon
worktree and **not pushed**, so nothing of the miniapps branch can be landed by accident.

<!-- GATE-ROW -->

## Residual risks

- A process that stays *running* (not zombie) longer than the 10 s bound still fails — that is the
  intended leak verdict, and the failure message now names the elapsed time and state so a real leak
  is distinguishable from a slow teardown at a glance.
- The precision comes from `/proc`, so it is exact on Linux and degraded (old semantics) elsewhere.
- A PID reused after the original was collected cannot be confused with it (start-time identity), but
  the check compares start times only when an identity was captured; the browser tests assert it was.
