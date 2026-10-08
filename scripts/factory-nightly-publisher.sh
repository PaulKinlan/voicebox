#!/usr/bin/env bash
# scripts/factory-nightly-publisher.sh — bounded runner for nightly factory publisher (voicebox-beads-xacp)
set -uo pipefail

[ -f "$HOME/.fleet/env" ] && source "$HOME/.fleet/env"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REPORTS_DIR="${VOICEBOX_FACTORY_PRIVATE_DIR:-$HOME/.voicebox/factory-reports}"
LOG_FILE="$REPORTS_DIR/nightly-publisher.log"
LOCK_FILE="$REPORTS_DIR/nightly-publisher.lock"

mkdir -p "$REPORTS_DIR"

TARGET_NAME="$(basename "$ROOT_DIR")"
TARGET_LOCK="$REPORTS_DIR/${TARGET_NAME}.lock"

exec 201>"$LOCK_FILE"
if ! flock -n 201; then
  echo "[$(date -u +%FT%TZ)] [nightly-publisher] Another publisher instance is already running. Exiting." >> "$LOG_FILE"
  exit 0
fi

# Acquire per-target exclusive lock while publishing findings
exec 200>"$TARGET_LOCK"
flock -x 200

echo "[$(date -u +%FT%TZ)] [nightly-publisher] Starting nightly findings publisher in $ROOT_DIR" >> "$LOG_FILE"

cd "$ROOT_DIR"
node "$SCRIPT_DIR/factory-nightly-publisher.mjs" "$@" 2>&1 | tee -a "$LOG_FILE"
rc=${PIPESTATUS[0]}

echo "[$(date -u +%FT%TZ)] [nightly-publisher] Nightly findings publisher finished with exit code $rc" >> "$LOG_FILE"
exit $rc
