#!/usr/bin/env sh
# scripts/pre-push.sh — Voicebox pre-push gate (voicebox-beads-99l)
# Runs full unit/integration test glob + page acceptance harness before push.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

echo "[gate] pre-push: running npm test..."
if ! npm test; then
  echo >&2 "[gate] pre-push REFUSED: npm test failed. Fix failing tests before pushing."
  exit 1
fi

echo "[gate] pre-push: running npm run accept..."
if ! npm run accept; then
  echo >&2 "[gate] pre-push REFUSED: npm run accept failed. Fix acceptance failures before pushing."
  exit 1
fi

echo "[gate] pre-push: ALL GATES GREEN"
