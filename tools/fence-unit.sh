#!/bin/bash
# The L1.5 composition (voicebox-beads-8ny): a transient systemd --user unit whose Exec is the
# bwrap fence. The unit adds the KERNEL lockdown the fence alone does not have — seccomp filter
# (Seccomp: 2), an empty capability set (CapEff: 0), a private /tmp, and the whole host tree
# read-only (ProtectSystem=strict) with the ONE sandbox home as the writable exception — and the
# fence then bounds files and processes inside that. No root, no daemon, nothing installed:
# systemd-run makes the unit transient; --collect drops it when the Exec exits.
#
# The seccomp filter is a DENYLIST, named honestly: the fence needs mount/pivot_root/userns, so the
# filter blocks only the groups a build environment never legitimately calls (kernel modules,
# raw I/O, reboot, swap, keyrings, debugging, CPU emulation, obsolete syscalls). It is mode 2
# (filter), and the probe inside reports Seccomp: 2 — measured, not claimed.
#
# Usage: fence-unit.sh <home> <port> <unit-name> [command...]
#   <home>       the sandbox's writable home (host path), created if absent
#   <port>       the loopback port the fenced server binds
#   <unit-name>  the transient unit's name (systemd-safe; the caller namespaces it)
#   command      what the fence runs inside (default: the environment server)
set -euo pipefail
SANDBOX_HOME="$1"
PORT="$2"
UNIT="$3"
shift 3
mkdir -p "$SANDBOX_HOME/workspace"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -eq 0 ]; then
  set -- /usr/bin/node /srv/voicebox/tools/env-serve.mjs
fi
exec /usr/bin/systemd-run --user --collect \
  --unit="$UNIT" \
  --property=ProtectSystem=strict \
  --property=ReadWritePaths="$SANDBOX_HOME" \
  --property=PrivateTmp=yes \
  --property=NoNewPrivileges=yes \
  --property=CapabilityBoundingSet= \
  --property='SystemCallFilter=~@obsolete @debug @cpu-emulation @keyring @module @raw-io @reboot @swap' \
  -- "$SELF/fence.sh" "$SANDBOX_HOME" "$PORT" "$@"
