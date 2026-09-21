# Installed harness inventory

Open **Harnesses** from the voice page, then **Check installed harnesses**. The same
read-only inventory is available at `GET /api/harnesses` or in the host shell:

```sh
node tools/list-harnesses.mjs
node tools/list-harnesses.mjs --json
```

This is a **partial D3**: installed programs on this Voicebox server's machine, not named
configured agents, a default-selection policy, a voice tool, or fleet/session addressing.
`voicebox-beads-gfg` stays open for those catalogue/configuration-dependent pieces;
`voicebox-beads-8fv.2` owns configuration and `voicebox-beads-8fv.3` owns fleet addressing.
No alternative configuration registry is introduced.

## What is measured

The fixed known-name list is Pi, Claude Code, Codex CLI, Gemini CLI, OpenCode and Aider.
Absolute PATH directories are checked in order; the first found command is checked, even
if broken. Empty/relative PATH entries are ignored so a project cannot supply a command
through the current directory. This is a POSIX host probe, not an exhaustive disk scan.
`VOICEBOX_ACP_PI`, when set, supplies Pi's explicit absolute path; a broken value does
not fall back to another Pi. Version checks use only `--version`, no shell interpolation,
three seconds per process group and 8192 total output bytes. Raw output and host
installation paths are not returned. No prompt, model request or credential inspection
is performed. Host PATH/configuration is trusted; version text is not binary attestation.

Pi ACP package metadata is read from Pi's standard extension installation beneath the
host home (`.pi/agent/npm/node_modules/pi-acp`), or `VOICEBOX_ACP_ADAPTER` when set.
That existing diagnostic variable names a package directory, not a model-provided command.
Metadata proves only a package record exists. Inventory does not launch ACP, inspect
sessions or infer authentication from files. Use the separate credential-free diagnostic
in [the ACP document](11-acp-adapter.md) for actual protocol/version checks.

- **present:** recognized version response only; no task-readiness claim.
- **unrunnable:** a command/configured path exists but cannot execute its version check,
  exits unsuccessfully, exceeds the time/output bound, or has broken permissions.
- **unknown:** identity could not be recognized, inspection failed, or only adapter metadata
  was read; the reason is visible, not silently counted as available.
- **absent:** not found in the checked locations. This does not mean absent everywhere.

Known-purpose descriptions are separate from observed permissions. Project access,
model access, cost, reliability and ACP support for ordinary CLIs remain unmeasured.
Pi/pi-acp rows expose the actual production executor's `absent-capability` refusal.
The stock server has no task executor. Other CLI rows say `adapter-not-configured`.
The obsolete broker restriction is **a remaining code gap**, not a new policy decision.

A person explicitly starts the checks. The server shares one timestamped snapshot for
60 seconds to avoid spawning more probes per reader. If the connection fails the page
marks any previous rows stale. The endpoint accepts no command/path overrides.

## Placement and limits

Each harness keeps its own security and configuration; discovery does not wrap it in a
Voicebox sandbox. A browser cannot spawn a local program. Reaching CLIs on the browser's
machine requires a local server/helper bridge, **not implemented here**. A browser-native
harness does not require that bridge, but this machine inventory does not discover it.
Remote inventory aggregation, configured-agent selection and invoking a task remain separate.

## Checks

```sh
node --test tests/harness-inventory.test.mjs
```

The check drives a real mobile Chromium page against an owned ephemeral server, clicks
inventory, verifies present/broken/unknown rows, checks cache reuse and lost-connection
staleness. Temporary executable fixtures never contact a model. Live host results and
screenshots are recorded separately in the implementation evidence; fixture results are
not claimed as proof of real harness execution.
