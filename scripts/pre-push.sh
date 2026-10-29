#!/usr/bin/env sh
# scripts/pre-push.sh — Voicebox pre-push gate (voicebox-beads-99l)
# Scoped by destination (voicebox-beads-uadl):
#   push to main/master  → docs-touched + unit + (gate-locked) live + acceptance
#   push to any branch   → docs-touched + unit only; live/acceptance run on the landing
# A push with no destination information keeps the full gate. Bounded timeouts throughout.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# ── REFUSE WHEN core.bare=true IS SET ON A WORKING TREE CHECKOUT (voicebox-beads-6p3y) ──
if [ "$(git config --bool core.bare 2>/dev/null || echo false)" = "true" ] && [ -e ".git" ]; then
  echo >&2 "[gate] pre-push REFUSED: git config core.bare=true is set on a working tree checkout ($REPO_ROOT)"
  echo >&2 "[gate]   restore with:  git config core.bare false"
  exit 1
fi

# ── REFUSE A NON-MAIN BRANCH PUSHING TO main (voicebox-beads-85w) ─────────────
# A worktree created with `git worktree add -b <branch> <dir> origin/main` has its
# UPSTREAM set to origin/main, so a BARE `git push` in it offers HEAD:main — and git's
# own remedy text suggests `git push origin HEAD:main` to a lane in a hurry. That is a
# loaded gun pointed at main, so the destination is checked FIRST: before the skip flag,
# before the lock, before any stage. A mis-aimed push must not wait three minutes for a
# suite whose verdict would be about a different refspec.
#
# Git hands a pre-push hook its refs on stdin, one line each:
#   <local ref> <local sha> <remote ref> <remote sha>
# Creating the branch without tracking avoids the whole class:
#   git worktree add --no-track -b <branch> <dir> origin/main
# or, on a branch that already tracks main:  git branch --unset-upstream
_current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")"
# The tracking hook (.githooks/pre-push) reads stdin for its own ref scan and exports what
# it read; a direct run (the tests) still has stdin. Either way, the check reads a FILE so
# the refusal exits THIS shell rather than a pipeline subshell.
_refs_file="$(mktemp)"
# `%s\n` (not `%s`): a destinations value whose final line is unterminated is skipped by `read`
# (its loop body never runs for an unterminated last line), and the gate would then behave as if
# the push had no destination. Terminating always is harmless — the extra blank line is ignored.
if [ -n "${VOICEBOX_PUSH_DESTINATIONS:-}" ]; then printf '%s\n' "${VOICEBOX_PUSH_DESTINATIONS}" > "$_refs_file"; else cat > "$_refs_file" 2>/dev/null || true; fi
_destination_is_main=0
_had_destination=0
_main_remote_sha=""
_ref_count=0
while read -r _local_ref _local_sha _remote_ref _remote_sha; do
  [ -z "$_local_ref" ] && continue
  _had_destination=1
  _ref_count=$(( _ref_count + 1 ))
  case "$_remote_ref" in
    refs/heads/main|refs/heads/master)
      _destination_is_main=1
      _main_remote_sha="$_remote_sha"
      if [ "$_current_branch" != "main" ] && [ "$_current_branch" != "master" ]; then
        echo >&2 "[gate] pre-push REFUSED: non-main branch attempting to push to main ref"
        echo >&2 "[gate]   checked-out branch: ${_current_branch:-(detached HEAD)}  local ref offered: ${_local_ref:-?}  destination: ${_remote_ref}"
        echo >&2 "[gate]   push your branch instead:  git push -u origin ${_current_branch:-<branch>}"
        echo >&2 "[gate]   (a worktree made with -b <branch> origin/main tracks main; use --no-track, or git branch --unset-upstream)"
        exit 1
      fi ;;
  esac
done < "$_refs_file"
rm -f "$_refs_file"

if [ "$VOICEBOX_SKIP_GATE" = "1" ]; then
  echo "[gate] pre-push: VOICEBOX_SKIP_GATE=1 set — skipping gate"
  exit 0
fi

_node_timeout() {
  if [ "$1" = "--help" ]; then echo "--verbose --kill-after"; return 0; fi
  node -e '
    const { spawn } = require("node:child_process");
    const args = process.argv.slice(1);
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
      if (verbose) process.stderr.write(`timeout: sending signal TERM to command ${JSON.stringify(args[0])}\n`);
      sigGroup("SIGTERM");
      killTimer = setTimeout(() => { killed = true; sigGroup("SIGKILL"); }, killAfterMs);
    }, durMs);
    child.on("exit", (code, sig) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (killed) process.exit(137);
      if (timedOut) process.exit(124);
      process.exit(code ?? (sig ? 128 : 0));
    });
  ' -- "$@"
}

# Inherit stdout/stderr: output must stream even when the stage is terminated.
run_stage() {
  _stage="$1"
  _secs="$2"
  shift 2
  _timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then
    _timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    _timeout_bin="gtimeout"
  else
    _timeout_bin="_node_timeout"
  fi

  _timeout_flags="--kill-after=5s"
  if [ "$_timeout_bin" = "_node_timeout" ] || "$_timeout_bin" --help 2>&1 | grep -q -- '--verbose'; then
    _timeout_flags="--verbose $_timeout_flags"
  fi

  echo "[gate] pre-push: $_stage — running $* (max ${_secs}s)..."
  _start=$(date +%s)
  if "$_timeout_bin" $_timeout_flags "${_secs}s" "$@"; then
    return 0
  else
    _status=$?
  fi
  _elapsed=$(( $(date +%s) - _start ))

  case "$_stage" in
    unit) _var="VOICEBOX_GATE_UNIT_SECS" ;;
    live) _var="VOICEBOX_GATE_LIVE_SECS" ;;
    acceptance) _var="VOICEBOX_GATE_ACCEPT_SECS" ;;
    *) _var="" ;;
  esac
  _remedy=""
  if [ -n "$_var" ]; then
    _remedy=" — re-run when the box is quieter, or raise the budget with ${_var}=<n>"
  fi

  case "$_status" in
    124) _cause="TIMED OUT — budget ${_secs}s, elapsed ${_elapsed}s (exit 124); suite completion is unknown, not a test verdict${_remedy}" ;;
    137) _cause="KILLED — budget ${_secs}s, elapsed ${_elapsed}s (exit 137; timeout escalation or external SIGKILL); completion is unknown${_remedy}" ;;
    *) _cause="FAILED (exit $_status); see the command's output above" ;;
  esac
  echo >&2 "[gate] pre-push REFUSED: $_stage ($*) — $_cause."
  # RETURN, not exit: `set -e` still aborts a bare call site, so every stage that refuses on its own
  # behaves exactly as it did when this was `exit 1`. The difference is for a caller that must say
  # something BEFORE it refuses — the full gate's tier stages, which leave tier records behind and name
  # where they are (voicebox-beads-wiby) — and a function that exits cannot be asked a question after.
  return 1
}

# ── TWO TEST LANES, because the suite's own concurrency caused the flakes ────
# Measured 2026-09-23 (voicebox-beads-6qu): the whole suite run SERIALLY passes
# at load average 36 — higher than during any refusal — while the default
# (concurrent-files) run failed extension-approval-ui twice inside the suite and
# environment-probe once, each passing alone. So the interference is between
# test FILES, not the box, and the fix is to keep the files that own a browser
# or a server out of the concurrent pass.
#
#   unit  — no browser, no server of its own: normal concurrency, fast
#   live  — launches Chromium over CDP or a server process, split by WHAT it owns:
#           the server tier (4 files at a time, no browser) and the browser tier (the
#           shard runner: 4 files at a time, each still its own process, server and
#           browser — see tools/browser-shard-runner.mjs, voicebox-beads-hhkg).
#
# THE BROWSER TIER IS NO LONGER ONE FILE AT A TIME (voicebox-beads-hhkg, 2026-10-11).
# It was, because a raw --test-concurrency put an unknown set of browser files in flight
# together; measured on this tree, 63 files ran 284.3s serially and 395.5s in the box's
# own last full-gate log under load, against this stage's 400s bound — the stage could be
# killed for finishing rather than for failing. Four workers with work-stealing run the
# SAME 63 files the SAME count of tests (249 tests / 247 pass / 0 fail / 2 skipped,
# identical to the serial lane) in ~128s. Per-file isolation is unchanged: each file still
# gets its own process, its own ephemeral-port server and its own browser. A shared
# long-lived server or browser is NOT available to these fixtures — 44 of the 63 files
# hand startServer() their own instance/workspace/extensions environment and 10 need
# browser-level flags (fakeMedia, a prepared profile) — and the parallelism, not instance
# reuse, is where the time was: per-file launch overhead measures ~0.6s of a ~4.5s file.
#
# Both lanes swap out at the same file list `npm test` uses (scripts/test-lanes.mjs
# classifies every tests/*.mjs, and --check fails if a file is in neither lane), and the
# browser tier's queue is asserted to cover the browser lane exactly once before it runs
# (scripts/test-shards.mjs, --check). The budgets are headroom over those measurements,
# not a guess.
#
# UNIT BUDGET RE-SIZED FOR THE STARVED BOX (voicebox-beads-lq8s). 90s turned out
# to sit INSIDE the unit suite's own run-to-run swing on this 2-vCPU VM: four
# runs of `npm run test:unit` on one branch, minutes apart, measured duration_ms
# 71084 and 78510 (both green) against 88686 and 88966 (both killed at the 90s
# bound, exit 124 — the gate's own correct label is "completion is unknown, not a
# test verdict"). A bound that converts a FINISHED suite into an unknown costs a
# lane a model turn and a queue slot to learn nothing, so the default is 180s:
# about 2x the worst measured run, outside the swing, and headroom for a suite
# that is still growing (515 -> 538 tests across those same measurements). This
# is a bound for the starved box, not the quiet one. VOICEBOX_GATE_UNIT_SECS (or
# the legacy VOICEBOX_GATE_TESTS_SECS) still overrides it — that is the remedy
# the refusal message names.
_unit_secs="${VOICEBOX_GATE_UNIT_SECS:-${VOICEBOX_GATE_TESTS_SECS:-900}}"
# THE LIVE BOUND WAS 400s, WHICH IS BELOW THE MEASURED COST OF THE TIER IT BOUNDS
# (voicebox-beads-i9k0). The browser tier is 94 files / ~2246s of file time, i.e. ~1123s
# of wall clock at two shards on an otherwise quiet VM, and 2400s was not enough on
# 2026-10-28 when the box ran 3-5x slower - that gate was killed at the stage bound with
# completion UNKNOWN. 3600s is a starved-box bound over the measured cost; the per-file
# bound (scripts/test-shards.mjs TIER_FILE_MS.browser) still names a wedged file, so the
# stage bound only decides how long a slow tier is allowed to finish.
_live_secs="${VOICEBOX_GATE_LIVE_SECS:-3600}"
_accept_secs="${VOICEBOX_GATE_ACCEPT_SECS:-45}"
_docs_secs="${VOICEBOX_GATE_DOCS_SECS:-30}"
# The manifest stage reads what the three tier records already say (JSON + one `git diff`), so it costs
# seconds; the bound is there because a stage without one is a stage that can hang the landing.
_manifest_secs="${VOICEBOX_GATE_MANIFEST_SECS:-60}"

# The documents' HAND-WRITTEN half (voicebox-beads-ths): a change that moves a file a document
# describes, with no document in it, is refused here — `Docs-checked:` in the commit message is the
# recorded way past. It runs FIRST because it costs one `git diff`: a gate that makes you wait three
# minutes to be told you forgot a sentence is a gate people learn to skip.
run_stage docs-touched "$_docs_secs" node scripts/docs-touched.mjs

_compute_source_tree() {
  _tree="$1"
  [ -z "$_tree" ] && return 0
  _st_lines="$(git ls-tree "$_tree" 2>/dev/null | grep -v -E "(	README\.md$|	docs$)" || true)"
  if [ -n "$_st_lines" ]; then
    printf '%s\n' "$_st_lines" | git mktree 2>/dev/null || true
  else
    printf '' | git mktree 2>/dev/null || true
  fi
}

# ── GATE LOCK (voicebox-beads-6qu) ──────────────────────────────────────────
# Serializes live browser test runs across concurrent lanes on this loaded box.
# Unit tests run without the lock; the live, acceptance, and doc-truth stages
# acquire the lock so multiple lanes pushing at once wait their turn instead of
# launching concurrent Chromium instances that starve each other.
_gate_lock_held=0
_lock_file="${VOICEBOX_GATE_LOCK:-/tmp/voicebox-gate.lock}"
_holder_file="${VOICEBOX_GATE_HOLDER:-/tmp/voicebox-gate.holder.json}"

release_gate_lock() {
  if [ "$_gate_lock_held" = "1" ]; then
    rm -f "$_holder_file" 2>/dev/null || true
    # THE `2>/dev/null` MUST BE GROUPED, OR IT SILENCES THE REST OF THE GATE. `exec 9>&- 2>/dev/null`
    # has no command word, so POSIX makes BOTH redirections permanent for the shell — the second one
    # sends fd 2 to /dev/null for every line printed after the lock is released. That is the manifest
    # stage's whole diagnostic (measured: `sh -c 'exec 9>&- 2>/dev/null; echo x >&2'` prints nothing),
    # so a full gate refused for a dirty tree or an unreconciled roster exited 1 with a clean stderr and
    # no reason a reader could act on. Grouped, the fd-2 redirect is restored when the group ends and
    # only the (intended) close of fd 9 survives. Measured on this fix: the same run prints
    # `gate-manifest: REFUSED — … working tree was DIRTY …` and the gate's own `REFUSED: manifest` line.
    { exec 9>&-; } 2>/dev/null || true
    _gate_lock_held=0
  fi
}
trap release_gate_lock EXIT INT TERM

acquire_gate_lock() {
  if [ "$VOICEBOX_GATE_LOCK_DISABLE" = "1" ]; then
    return 0
  fi

  if ! command -v flock >/dev/null 2>&1; then
    echo >&2 "[gate] pre-push: flock command not found; running live stage without lock"
    return 0
  fi

  exec 9>"$_lock_file"

  _t0=$(date +%s)
  if ! flock -n 9; then
    _holder_info=""
    if [ -f "$_holder_file" ]; then
      _holder_pid=$(grep -o '"pid":[0-9]*' "$_holder_file" 2>/dev/null | cut -d: -f2 || true)
      if [ -n "$_holder_pid" ]; then
        if kill -0 "$_holder_pid" 2>/dev/null; then
          _holder_info="held by PID $_holder_pid"
        else
          _holder_info="held by PID $_holder_pid (NOT RUNNING — stale sidecar)"
        fi
      fi
    fi
    if [ -z "$_holder_info" ]; then
      _holder_info="held by another gate process"
    fi

    echo "[gate] pre-push: Waiting for gate lock $_holder_info [$_lock_file]..."
    _lock_wait_secs="${VOICEBOX_GATE_LOCK_WAIT_SECS:-600}"
    if ! flock -w "$_lock_wait_secs" 9; then
      echo >&2 "[gate] pre-push REFUSED: timed out waiting for gate lock after ${_lock_wait_secs}s ($_holder_info)."
      exit 1
    fi
    _waited=$(( $(date +%s) - _t0 ))
    echo "[gate] pre-push: Acquired gate lock (waited ${_waited}s)."
  fi

  _curr_branch=$(git branch --show-current 2>/dev/null || echo "unknown")
  echo "{\"pid\":$$,\"branch\":\"$_curr_branch\",\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$_holder_file" 2>/dev/null || true
  _gate_lock_held=1
}

# ── TREE-SHA AND SOURCE-TREE RECEIPT CHECK (voicebox-beads-07b9, voicebox-beads-83ge) ──
# When the full gate has already succeeded on the exact same tree (e.g. after a commit
# message amendment or re-tag without content changes), re-running the 6-minute
# unit/live/acceptance suite is redundant. If the working tree is clean and the recorded
# tree SHA matches HEAD^{tree}, skip re-running the test stages.
# Furthermore, if sourceTree matches and the diff against the passed tree contains only
# documentation files (*.md under docs/ or README.md), run fast static doc checks and skip
# unit/live/acceptance stages.
_git_dir="$(git rev-parse --git-dir 2>/dev/null || echo ".git")"
_receipt_file="$_git_dir/voicebox-gate-passed-tree"
_current_tree="$(git rev-parse HEAD^{tree} 2>/dev/null || true)"
_current_source_tree="$(_compute_source_tree "$_current_tree")"
_is_clean=0
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  _is_clean=1
fi

# Receipts cache landings to main: candidate branch pushes and mixed-ref pushes run unit tests directly (voicebox-beads-83ge).
_allow_receipt_bypass=0
if [ "$_had_destination" = "0" ]; then
  _allow_receipt_bypass=1
elif [ "$_destination_is_main" = "1" ] && [ "$_ref_count" -le 1 ]; then
  _allow_receipt_bypass=1
fi

if [ "$_allow_receipt_bypass" = "1" ]; then
  if [ "$_is_clean" = "1" ] && [ -f "$_receipt_file" ]; then
    _passed_tree="$(head -n 1 "$_receipt_file" 2>/dev/null || true)"
    _passed_source_tree="$(sed -n '2p' "$_receipt_file" 2>/dev/null || true)"
    if [ -n "$_passed_tree" ] && [ "$_passed_tree" = "$_current_tree" ]; then
      echo "[gate] pre-push: verified tree-SHA receipt matches ($_current_tree) on clean tree — skipping unit/live/acceptance stages"
      echo "[gate] pre-push: ALL GATES GREEN (tree-receipt)"
      exit 0
    fi
    # Source-tree receipt fast-path is strictly for known single-ref landings to main.
    # Pushes without destination (or candidate/mixed pushes) take the conservative path.
    if [ "$_had_destination" = "1" ] && [ "$_destination_is_main" = "1" ] && [ "$_ref_count" -le 1 ]; then
      if [ -n "$_current_source_tree" ] && [ -n "$_passed_source_tree" ] && [ "$_passed_source_tree" = "$_current_source_tree" ] && [ -n "$_passed_tree" ] && git cat-file -e "$_passed_tree^{tree}" 2>/dev/null; then
        if _diff_out="$(git diff --name-only "$_passed_tree" "$_current_tree" 2>/dev/null)"; then
          _non_doc_diff="$(printf '%s\n' "$_diff_out" | grep -v -E "(^README\.md$|^docs/.*\.md$)" | grep -v '^$' || true)"
          if [ -z "$_non_doc_diff" ]; then
            if [ -f scripts/docs-touched.mjs ]; then
              run_stage docs-touched "$_docs_secs" node scripts/docs-touched.mjs
            fi
            if [ -f scripts/docs-check.mjs ]; then
              run_stage docs-check "$_docs_secs" node scripts/docs-check.mjs
            fi
            if [ -f scripts/single-owner.mjs ]; then
              run_stage single-owner "$_docs_secs" node scripts/single-owner.mjs
            fi
            _doc_truth_files=""
            for _f in tests/voicebox.test.mjs tests/changelog-links.test.mjs tests/rendered-plain-language.test.mjs; do
              if [ -f "$_f" ]; then
                _doc_truth_files="$_doc_truth_files $_f"
              fi
            done
            if [ -n "$_doc_truth_files" ]; then
              acquire_gate_lock
              run_stage doc-truth "$_unit_secs" env -u NODE_TEST_CONTEXT node --test $_doc_truth_files
              release_gate_lock
            fi
            echo "[gate] pre-push: verified sourceTree receipt matches ($_current_source_tree) with docs-only diff against $_passed_tree — skipping unit/live/acceptance stages"
            echo "[gate] pre-push: ALL GATES GREEN (source-tree-receipt)"
            exit 0
          fi
        fi
      fi
    fi
  fi
fi

if [ -f scripts/docs-check.mjs ]; then
  run_stage docs-check "$_docs_secs" node scripts/docs-check.mjs
fi
if [ -f scripts/single-owner.mjs ]; then
  run_stage single-owner "$_docs_secs" node scripts/single-owner.mjs
fi

node scripts/test-lanes.mjs --check

# ── THE FULL GATE'S COVERAGE RECEIPT (voicebox-beads-zjpm.3, voicebox-beads-wiby) ────────────────
# The fast gate records what it measured; the FULL gate did not, so a landing's only evidence was a log
# line. The tiers now run per file through scripts/gate-tier.mjs (the same shape the fast gate and the
# browser shard runner already use, so a file's record means the same thing in either gate), each writes
# ONE tier record, and the last stage folds them into <tree>.full.manifest.json with the ONE aggregator.
#
# THE FALLBACK IS THE FIXTURES' PATH: tests/pre-push.test.mjs drives this file inside a disposable repo
# whose package.json supplies test:unit/test:live, and this gate has always kept its stages pluggable
# (docs-touched, docs-check and single-owner are conditional for the same reason). A repository with no
# tier runner keeps the old wiring exactly.
_use_tiers=0
_tier_dir=""
if [ -f scripts/gate-tier.mjs ] && [ -f scripts/gate-manifest.mjs ] && [ -d tests ]; then
  _use_tiers=1
  _tier_dir="$(mktemp -d "${TMPDIR:-/tmp}/voicebox-gate-tiers.XXXXXX")"
  export VOICEBOX_GATE_TIER_DIR="$_tier_dir"
fi

# A tier stage that refuses says WHERE its records are and how to fold them: a red run is exactly the run
# a reader wants an artifact for, and it does not get the sealed manifest (that is a receipt for a gate
# that finished). The records are kept, not deleted, so the same fold can be run by hand.
run_tier_stage() {
  _stage="$1"
  _secs="$2"
  shift 2
  if run_stage "$_stage" "$_secs" "$@"; then return 0; fi
  if [ -n "$_tier_dir" ]; then
    echo >&2 "[gate] pre-push: the $_stage tier's records are kept at $_tier_dir — fold them with:"
    echo >&2 "[gate]   node scripts/gate-manifest.mjs aggregate --gate full --tree $_current_tree --tier-dir $_tier_dir"
  fi
  exit 1
}

if [ "$_use_tiers" = "1" ]; then
  run_tier_stage unit "$_unit_secs" node scripts/gate-tier.mjs --tier unit --dir "$_tier_dir"
else
  run_stage unit "$_unit_secs" npm run test:unit
fi

# ── SCOPE: the lock and the long stages protect LANDINGS (voicebox-beads-uadl) ──
# A feature-branch push is a candidate announcement: the unit lane (fast, lock-free) is
# the verdict a lane needs, and live/acceptance run when the branch LANDS to main. Without
# this split, five lanes pushing candidates serialized behind one flock — measured waits of
# 398s, 543s, 857s and 1058s for locks before the live stage even started. A push with NO
# destination information (direct script runs, exotic transports) keeps the FULL gate: an
# unseen destination might be a landing, and the conservative answer is the old behaviour.
if [ "$_had_destination" = "1" ] && [ "$_destination_is_main" != "1" ]; then
  echo "[gate] pre-push: feature-branch push — unit lane is the gate; live/acceptance run on the landing to main"
  # The unit tier recorded what it measured, but no full manifest is sealed for a candidate push (that is a
  # landing receipt), so the scratch directory is not evidence worth keeping.
  [ -n "$_tier_dir" ] && rm -rf "$_tier_dir"
  echo "[gate] pre-push: ALL GATES GREEN (unit)"
  exit 0
fi

# ── DOCS-ONLY FAST PATH (voicebox-beads-07b9) ──────────────────────────────────
# A push to main where only markdown documentation files (*.md) changed against the main remote ref.
# Docs-touched, docs-check, single-owner, unit, and the doc-truth live tests verify the docs.
# Must be a single-ref push so multi-ref pushes never skip full checks. Does NOT mint the tree
# receipt since full live/acceptance did not run.
_remote_base="origin/main"
if ! git rev-parse --verify "origin/main^{commit}" >/dev/null 2>&1; then
  if git rev-parse --verify "origin/master^{commit}" >/dev/null 2>&1; then
    _remote_base="origin/master"
  else
    _remote_base=""
  fi
fi

_diff_base=""
if [ -n "$_main_remote_sha" ] && [ "$_main_remote_sha" != "0000000000000000000000000000000000000000" ] && git rev-parse --verify "$_main_remote_sha^{commit}" >/dev/null 2>&1; then
  _diff_base="$_main_remote_sha"
elif [ -n "$_remote_base" ]; then
  _diff_base="$_remote_base"
fi

if [ "$_ref_count" -le 1 ] && [ -n "$_diff_base" ]; then
  _changed_files=$(git diff --name-only "$_diff_base...HEAD" 2>/dev/null || true)
  if [ -n "$_changed_files" ]; then
    _non_docs=$(printf '%s\n' "$_changed_files" | grep -v '\.md$' || true)
    if [ -z "$_non_docs" ]; then
      # Run the doc-truth live checks on the fast path under the gate lock
      # (voicebox.test.mjs, changelog-links.test.mjs, rendered-plain-language.test.mjs all drive Chromium):
      _doc_truth_files=""
      for _f in tests/voicebox.test.mjs tests/changelog-links.test.mjs tests/rendered-plain-language.test.mjs; do
        if [ -f "$_f" ]; then
          _doc_truth_files="$_doc_truth_files $_f"
        fi
      done
      if [ -n "$_doc_truth_files" ]; then
        acquire_gate_lock
        run_stage doc-truth "$_unit_secs" env -u NODE_TEST_CONTEXT node --test $_doc_truth_files
        release_gate_lock
      fi
      echo "[gate] pre-push: docs-only push to main — docs, unit, and doc-truth passed; skipping live/acceptance stages"
      [ -n "$_tier_dir" ] && rm -rf "$_tier_dir"
      echo "[gate] pre-push: ALL GATES GREEN (docs-only)"
      exit 0
    fi
  fi
fi

acquire_gate_lock
if [ "$_use_tiers" = "1" ]; then
  run_tier_stage live "$_live_secs" node scripts/gate-tier.mjs --tier live --dir "$_tier_dir"
else
  run_stage live "$_live_secs" npm run test:live
fi

if [ "$VOICEBOX_SKIP_ACCEPT" != "1" ]; then
  run_stage acceptance "$_accept_secs" npm run accept
fi
release_gate_lock

# ── THE FULL MANIFEST, AND IT IS THE LAST STAGE ON PURPOSE (voicebox-beads-wiby) ─────────────────
# Sealed last, so its existence means every stage above ran on this tree: the docs checks, both test
# tiers and acceptance. It reconciles all three tier records against the classifier's roster and REFUSES
# when a file is missing, duplicated, unclassified, not terminal, zero-test or a changed source with no
# mapped test — the same refusals the fast gate's artifact makes, over the union the merger is landing.
if [ "$_use_tiers" = "1" ]; then
  # Is the tree dirty AT SEAL TIME? The tiers ran over the WORKING TREE; the receipt is keyed by the
  # COMMITTED tree, so a dirty run is refused by the aggregate rather than sealed as a claim about bytes
  # nobody measured (voicebox-beads-wiby). Same test the verified-tree receipt below uses, so the two
  # cannot disagree about what "clean" meant on this run.
  #
  # AND THE FLAG IS A PLAIN STRING, NOT AN ARRAY: this file is `#!/usr/bin/env sh` (dash), where `_a=()`
  # and `${_a[@]}` are syntax errors — the script then dies at PARSE time, before any stage runs, so every
  # push fails with exit 2 and no stage output at all (measured: `sh -n scripts/pre-push.sh` → line 428
  # "Syntax error: \"(\" unexpected"). A gate that cannot be parsed is not a gate that passed.
  _dirty_flag=""
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then _dirty_flag="--tree-dirty"; fi
  run_stage manifest "$_manifest_secs" node scripts/gate-manifest.mjs aggregate --gate full \
    --tree "$_current_tree" \
    --sha "$(git rev-parse --short HEAD 2>/dev/null || true)" \
    --tier-dir "$_tier_dir" \
    --changed-base origin/main ${_dirty_flag:+"$_dirty_flag"}
  # The manifest carries every per-file record, so the scratch tier records are no longer needed. They are
  # removed only here, on a gate that finished: a red gate keeps them (run_tier_stage printed where).
  rm -rf "$_tier_dir"
fi

# ── RECORD VERIFIED TREE RECEIPT (voicebox-beads-07b9, voicebox-beads-83ge) ──
# Record tree SHA and sourceTree SHA when all stages pass on a clean working tree
if [ "$_is_clean" = "1" ] && [ -n "$_current_tree" ] && [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  [ -z "$_current_source_tree" ] && _current_source_tree="$(_compute_source_tree "$_current_tree")"
  if [ -n "$_current_source_tree" ]; then
    printf '%s\n%s\n' "$_current_tree" "$_current_source_tree" > "$_receipt_file" 2>/dev/null || true
  else
    echo "$_current_tree" > "$_receipt_file" 2>/dev/null || true
  fi
fi

echo "[gate] pre-push: ALL GATES GREEN"
