#!/usr/bin/env sh
# scripts/pre-push.sh — Voicebox pre-push gate (voicebox-beads-99l)
# Scoped by destination (voicebox-beads-uadl):
#   push to main/master  → docs-touched + unit + (gate-locked) live + acceptance
#   push to any branch   → docs-touched + unit only; live/acceptance run on the landing
# A push with no destination information keeps the full gate. Bounded timeouts throughout.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# ── CHECK REPO INTEGRITY (voicebox-beads-6p3y) ───────────────────────────────
# If core.bare=true was mistakenly set on a working tree, all work-tree ops fail.
_bare="$(git config core.bare 2>/dev/null || echo "false")"
if [ "$_bare" = "true" ]; then
  echo >&2 "[gate] pre-push WARNING: core.bare=true detected in repo $REPO_ROOT — auto-healing to core.bare=false"
  git config core.bare false
  git config --unset core.worktree 2>/dev/null || true
fi

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
if [ -n "${VOICEBOX_PUSH_DESTINATIONS:-}" ]; then printf '%s' "$VOICEBOX_PUSH_DESTINATIONS" > "$_refs_file"; else cat > "$_refs_file" 2>/dev/null || true; fi
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
  exit 1
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
#   live  — launches Chromium over CDP or a server process: ONE FILE AT A TIME
#
# Both lanes swap out at the same file list `npm test` uses (scripts/test-lanes.mjs
# classifies every tests/*.mjs, and --check fails if a file is in neither lane).
# Measured: unit 15s concurrent (175 tests), live 186s serial (182 tests), at load
# 19.5. The budgets are headroom over those measurements, not a guess.
_unit_secs="${VOICEBOX_GATE_UNIT_SECS:-${VOICEBOX_GATE_TESTS_SECS:-90}}"
_live_secs="${VOICEBOX_GATE_LIVE_SECS:-400}"
_accept_secs="${VOICEBOX_GATE_ACCEPT_SECS:-45}"
_docs_secs="${VOICEBOX_GATE_DOCS_SECS:-30}"

# The documents' HAND-WRITTEN half (voicebox-beads-ths): a change that moves a file a document
# describes, with no document in it, is refused here — `Docs-checked:` in the commit message is the
# recorded way past. It runs FIRST because it costs one `git diff`: a gate that makes you wait three
# minutes to be told you forgot a sentence is a gate people learn to skip.
run_stage docs-touched "$_docs_secs" node scripts/docs-touched.mjs

# ── TREE-SHA RECEIPT CHECK (voicebox-beads-07b9) ──────────────────────────────
# When the full gate has already succeeded on the exact same tree (e.g. after a commit
# message amendment or re-tag without content changes), re-running the 6-minute
# unit/live/acceptance suite is redundant. If the working tree is clean and the recorded
# tree SHA matches HEAD^{tree}, skip re-running the test stages.
_git_dir="$(git rev-parse --git-dir 2>/dev/null || echo ".git")"
_receipt_file="$_git_dir/voicebox-gate-passed-tree"
_current_tree="$(git rev-parse HEAD^{tree} 2>/dev/null || true)"
_is_clean=0
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  _is_clean=1
fi

if [ "$_is_clean" = "1" ] && [ -f "$_receipt_file" ]; then
  _passed_tree="$(cat "$_receipt_file" 2>/dev/null || true)"
  if [ -n "$_passed_tree" ] && [ "$_passed_tree" = "$_current_tree" ]; then
    echo "[gate] pre-push: verified tree-SHA receipt matches ($_current_tree) on clean tree — skipping unit/live/acceptance stages"
    echo "[gate] pre-push: ALL GATES GREEN (tree-receipt)"
    exit 0
  fi
fi

if [ -f scripts/docs-check.mjs ]; then
  run_stage docs-check "$_docs_secs" node scripts/docs-check.mjs
fi
if [ -f scripts/single-owner.mjs ]; then
  run_stage single-owner "$_docs_secs" node scripts/single-owner.mjs
fi

node scripts/test-lanes.mjs --check
run_stage unit "$_unit_secs" npm run test:unit

# ── SCOPE: the lock and the long stages protect LANDINGS (voicebox-beads-uadl) ──
# A feature-branch push is a candidate announcement: the unit lane (fast, lock-free) is
# the verdict a lane needs, and live/acceptance run when the branch LANDS to main. Without
# this split, five lanes pushing candidates serialized behind one flock — measured waits of
# 398s, 543s, 857s and 1058s for locks before the live stage even started. A push with NO
# destination information (direct script runs, exotic transports) keeps the FULL gate: an
# unseen destination might be a landing, and the conservative answer is the old behaviour.
if [ "$_had_destination" = "1" ] && [ "$_destination_is_main" != "1" ]; then
  echo "[gate] pre-push: feature-branch push — unit lane is the gate; live/acceptance run on the landing to main"
  echo "[gate] pre-push: ALL GATES GREEN (unit)"
  exit 0
fi

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
    exec 9>&- 2>/dev/null || true
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
        run_stage doc-truth "$_unit_secs" node --test $_doc_truth_files
        release_gate_lock
      fi
      echo "[gate] pre-push: docs-only push to main — docs, unit, and doc-truth passed; skipping live/acceptance stages"
      echo "[gate] pre-push: ALL GATES GREEN (docs-only)"
      exit 0
    fi
  fi
fi

acquire_gate_lock
run_stage live "$_live_secs" npm run test:live

if [ "$VOICEBOX_SKIP_ACCEPT" != "1" ]; then
  run_stage acceptance "$_accept_secs" npm run accept
fi
release_gate_lock

# ── RECORD VERIFIED TREE RECEIPT (voicebox-beads-07b9) ────────────────────────
# Record tree SHA when all stages pass on a clean working tree
if [ "$_is_clean" = "1" ] && [ -n "$_current_tree" ] && [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  echo "$_current_tree" > "$_receipt_file" 2>/dev/null || true
fi

echo "[gate] pre-push: ALL GATES GREEN"
