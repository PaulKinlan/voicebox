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

node scripts/test-lanes.mjs --check
run_stage unit "$_unit_secs" npm run test:unit
run_stage live "$_live_secs" npm run test:live

if [ "$VOICEBOX_SKIP_ACCEPT" != "1" ]; then
  run_stage acceptance "$_accept_secs" npm run accept
fi

echo "[gate] pre-push: ALL GATES GREEN"
