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
  echo "[gate] pre-push: $_stage — running $* (max ${_secs}s)..."
  if timeout --verbose --kill-after=5s "${_secs}s" "$@"; then
    return 0
  else
    _status=$?
  fi
  case "$_status" in
    124) _cause="TIMED OUT after ${_secs}s (exit 124); suite completion is unknown, not a test verdict" ;;
    137) _cause="KILLED (exit 137; timeout escalation or external SIGKILL); completion is unknown" ;;
    *) _cause="FAILED (exit $_status); see the command's output above" ;;
  esac
  echo >&2 "[gate] pre-push REFUSED: $_stage ($*) — $_cause."
  exit 1
}

# Three loaded full-suite runs took 73.47–74.57s; keep the full suite with headroom.
run_stage tests 180 npm test

if [ "$VOICEBOX_SKIP_ACCEPT" != "1" ]; then
  run_stage acceptance 45 npm run accept
fi

echo "[gate] pre-push: ALL GATES GREEN"
