#!/bin/bash
# The voicebox fence: bubblewrap, no root, no daemon. Source tree read-only,
# one writable home bound in from the host, everything else fresh. Network is
# SHARED — deliberately: this fence bounds filesystem and processes, NOT the
# network, and the boundary report says so.
#
# Usage: fence.sh <home> <port> [command...]
#   <home>   the sandbox's writable home (host path), created if absent
#   <port>   the loopback port the fenced server binds
#   command  what to run inside (default: the probe)
set -euo pipefail
SANDBOX_HOME="$1"
PORT="$2"
shift 2
mkdir -p "$SANDBOX_HOME/workspace"
# The tree the fence binds is THIS SCRIPT's repo, not the caller's cwd: a server that boots a fence
# may run from anywhere, and the probe and the source it mounts live beside this script.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# /lib64 is where the ELF loader lives, and its host path is NOT constant: Debian/Ubuntu map it to
# /usr/lib64 (loader name ld-linux-x86-64.so.2), Arch to /usr/lib, and aarch64 hosts to /usr/lib64
# with a different loader name entirely. So mirror the host's OWN /lib64 target when it resolves
# under /usr — the only tree this fence binds — and fall back to /usr/lib64, then /usr/lib, on hosts
# that are not merged-usr. Naming one architecture's loader file here is what broke this fence.
LIB64=usr/lib
if [ -L /lib64 ]; then
  _lib64_target="$(readlink -f /lib64 2>/dev/null || true)"
  case "$_lib64_target" in /usr/*) LIB64="${_lib64_target#/}" ;; esac
elif [ -d /usr/lib64 ]; then
  LIB64=usr/lib64
fi
exec /usr/bin/bwrap \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin \
  --symlink "$LIB64" /lib64 \
  --symlink usr/lib /lib \
  --ro-bind /etc /etc \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --tmpfs /run \
  --ro-bind-try /run/systemd/resolve/stub-resolv.conf /run/systemd/resolve/stub-resolv.conf \
  --tmpfs /var \
  --tmpfs /home \
  --bind "$SANDBOX_HOME" /home/voice \
  --ro-bind "$SELF" /srv/voicebox \
  --bind "$SANDBOX_HOME/workspace" /home/voice/workspace \
  --tmpfs /probes \
  --ro-bind "$SELF/tools/sandbox-probe.mjs" /probes/sandbox-probe.mjs \
  --clearenv \
  --setenv PATH /usr/bin \
  --setenv PORT "$PORT" \
  --setenv HOME /home/voice \
  --setenv VOICEBOX_BOOT_MARKER "${VOICEBOX_BOOT_MARKER:-}" \
  --setenv VOICEBOX_BEARER "${VOICEBOX_BEARER:-}" \
  --setenv SANDBOX_PROBE_PATHS /srv/voicebox:/home/voice/workspace \
  --chdir /home/voice \
  --unshare-pid --unshare-uts --die-with-parent --new-session \
  -- "$@"
