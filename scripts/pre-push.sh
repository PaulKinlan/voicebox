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

# Bounded command runner: NEVER block or hang indefinitely
run_bounded() {
  _secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=5s "${_secs}s" "$@"
  else
    "$@"
  fi
}

echo "[gate] pre-push: running npm test (max 60s)..."
if ! run_bounded 60 npm test; then
  echo >&2 "[gate] pre-push REFUSED: npm test failed or timed out."
  exit 1
fi

if [ "$VOICEBOX_SKIP_ACCEPT" != "1" ]; then
  echo "[gate] pre-push: running npm run accept (max 45s)..."
  if ! run_bounded 45 npm run accept; then
    echo >&2 "[gate] pre-push REFUSED: npm run accept failed or timed out."
    exit 1
  fi
fi

echo "[gate] pre-push: ALL GATES GREEN"
