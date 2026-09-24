#!/usr/bin/env sh
# scripts/pre-push.sh — Voicebox pre-push gate (voicebox-beads-99l)
# Runs full unit/integration test glob + page acceptance harness before push with bounded timeouts.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

if [ "$VOICEBOX_SKIP_GATE" = "1" ]; then
  echo "[gate] pre-push: VOICEBOX_SKIP_GATE=1 set — skipping gate"
  exit 0
fi

# Inherit stdout/stderr: output must stream even when the stage is terminated.
run_stage() {
  _stage="$1"
  _secs="$2"
  shift 2
  if ! command -v timeout >/dev/null 2>&1; then
    echo >&2 "[gate] pre-push REFUSED: $_stage — timeout command missing; install GNU coreutils."
    exit 1
  fi

  _timeout_flags="--kill-after=5s"
  if timeout --help 2>&1 | grep -q -- '--verbose'; then
    _timeout_flags="--verbose $_timeout_flags"
  fi

  echo "[gate] pre-push: $_stage — running $* (max ${_secs}s)..."
  _start=$(date +%s)
  if timeout $_timeout_flags "${_secs}s" "$@"; then
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

node scripts/test-lanes.mjs --check
run_stage unit "$_unit_secs" npm run test:unit

# ── GATE LOCK (voicebox-beads-6qu) ──────────────────────────────────────────
# Serializes live browser test runs across concurrent lanes on this loaded box.
# Unit tests run without the lock; the live and acceptance stages acquire the
# lock so multiple lanes pushing at once wait their turn instead of launching
# concurrent Chromium instances that starve each other.
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
    if ! timeout "${_lock_wait_secs}s" flock 9; then
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

acquire_gate_lock
run_stage live "$_live_secs" npm run test:live

if [ "$VOICEBOX_SKIP_ACCEPT" != "1" ]; then
  run_stage acceptance "$_accept_secs" npm run accept
fi
release_gate_lock

echo "[gate] pre-push: ALL GATES GREEN"
