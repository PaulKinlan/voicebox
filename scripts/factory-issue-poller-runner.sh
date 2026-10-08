#!/usr/bin/env bash
# scripts/factory-issue-poller-runner.sh — bounded runner for Voicebox local issue poller (voicebox-beads-xacp)
set -uo pipefail

# Ensure environment is loaded
[ -f "$HOME/.fleet/env" ] && source "$HOME/.fleet/env"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Target execution directory: default to repository root containing this runner, or override via VOICEBOX_TARGET_DIR
TARGET_DIR="${VOICEBOX_TARGET_DIR:-$ROOT_DIR}"
POLLER_SCRIPT="$SCRIPT_DIR/factory-issue-poller.mjs"

REPORTS_DIR="${VOICEBOX_FACTORY_PRIVATE_DIR:-$HOME/.voicebox/factory-reports}"
LOG_FILE="$REPORTS_DIR/poller.log"

mkdir -p "$REPORTS_DIR"

# Lock file to prevent overlapping runs
LOCK_FILE="$REPORTS_DIR/poller.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[$(date -u +%FT%TZ)] [poller-runner] Another instance of factory-issue-poller is already running. Exiting." >> "$LOG_FILE"
  exit 0
fi

echo "[$(date -u +%FT%TZ)] [poller-runner] Starting issue poller in $TARGET_DIR" >> "$LOG_FILE"

# Run under fleet-heavy if available on VM, else standard bounded timeout
RUN_ARGS=(--repo "${VOICEBOX_FACTORY_REPO:-PaulKinlan/voicebox}" --private-dir "$REPORTS_DIR")
if [ $# -gt 0 ]; then
  RUN_ARGS+=("$@")
fi

if command -v fleet-heavy >/dev/null 2>&1; then
  (cd "$TARGET_DIR" && fleet-heavy timeout -k 30 600 node "$POLLER_SCRIPT" "${RUN_ARGS[@]}" >> "$LOG_FILE" 2>&1)
else
  (cd "$TARGET_DIR" && timeout -k 30 600 node "$POLLER_SCRIPT" "${RUN_ARGS[@]}" >> "$LOG_FILE" 2>&1)
fi
rc=$?

echo "[$(date -u +%FT%TZ)] [poller-runner] Issue poller finished with exit code $rc" >> "$LOG_FILE"
exit $rc
