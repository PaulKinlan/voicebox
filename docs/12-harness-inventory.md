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
The optional tool metadata below describes declarations only; it does not select an
agent, change its configuration, or introduce an execution registry.

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
Pi/pi-acp rows expose the production adapter's admission precheck. The server selects
that task executor when started with `VOICEBOX_HARNESS=pi` (or `pi-acp`); the inventory
precheck alone does not establish that selection or successful model execution.
Other CLI rows say `adapter-not-configured`, even when tool metadata is supplied.
Inventory cards display the refusal's explanation, with its diagnostic identifier kept in
`data-delegation-refusal`, not repeated as visible text.

A person explicitly starts the checks. The server shares one timestamped snapshot for
60 seconds to avoid spawning more probes per reader. If the connection fails the page
marks any previous rows stale. The endpoint accepts no command/path overrides.

## Host-declared tool catalogues

ACP initialization declares protocol capabilities, not agent tool definitions. This
inventory neither invents an ACP `tools/list` method nor starts a session to ask a model
what tools it has. Voicebox currently supplies an empty MCP-server list to its ACP
client; this page does not inspect private extensions or discover MCP configuration.

To publish a tool catalogue, the server operator sets `VOICEBOX_HARNESS_TOOLS` to an
**absolute path to a dedicated JSON file**. Its contents are readable by anyone who can
reach the existing inventory endpoint. Use display metadata only, never credentials,
private configuration, command arguments, or tool results. No file is read by default.
Do not point this setting at a harness's private settings or authentication file.

Example format (illustrative declarations, **not discovered defaults**):

```json
{
  "pi": {
    "source": "Operator-maintained list, checked against our Pi setup",
    "scope": "Declared coding tools; extensions and per-session permissions not inspected",
    "tools": [
      { "name": "read", "description": "Read files in the harness's environment." },
      { "name": "bash", "description": "Run shell commands under that harness's configuration." }
    ]
  },
  "claude": {
    "source": "Operator-maintained list for our Claude configuration",
    "scope": "Declared file-reading tool only; not a complete live-session inventory",
    "tools": [
      { "name": "Read", "description": "Read a file, subject to the harness's permissions." }
    ]
  }
}
```

```sh
VOICEBOX_HARNESS_TOOLS=/absolute/path/harness-tools.json node server.mjs
VOICEBOX_HARNESS_TOOLS=/absolute/path/harness-tools.json node tools/list-harnesses.mjs --json
```

Keys are the inventory IDs: `pi`, `claude`, `codex`, `gemini`, `opencode`, `aider`,
`pi-acp`. Pi and its adapter are separate rows; metadata is not copied between them.
Each entry requires nonblank `source` (at most 512 characters), `scope` (1024), and a
`tools` array (at most 128 entries). Each tool requires a unique `name` (1–128 ASCII
letters, digits, underscores, dots, colons or hyphens) and a nonblank `description`
(at most 4096 characters). Display text may contain tabs/newlines, but not other control
characters. Other fields are ignored, not sent to the page.

`lib/harness-tools.mjs` accepts a regular file up to 256 KiB (one extra byte detects
an oversized read). It refuses a symlink at the file path's final component,
non-regular files and relative paths; parent directories are host configuration. Invalid JSON or entries invalidate the whole
catalogue rather than silently showing a partial list; install/version facts still load.
No raw parser error, file path or file contents appear in the refusal.

Each `GET /api/harnesses` row includes `toolCatalogue`:

- `status: "declared"`, `source`, `scope`, `tools`: operator-supplied display metadata.
  An empty array means **the host declared an empty list**, not that no tools exist.
- `status: "unknown"`, `why`: no entry, no file, or an invalid/unavailable file. There is
  no `tools: []` field to confuse unknown with a successful empty enumeration.

`public/harnesses.js` renders native disclosures and literal text, never HTML from the
catalogue. Source, scope and the declaration warning stay next to the names/descriptions.
A catalogue can be declared for an absent or broken CLI; its install state and delegation
refusal remain visible. Metadata never enables a tool or grants access.

The file is read with the same 60-second cached snapshot as version checks. Correcting a
file therefore takes effect after cache expiry or server restart, not immediately on each
click. A failed request marks all previously displayed facts, including tool metadata,
stale. This implementation does not automatically export active session tools; the host
must keep its declarations current.

## Placement and limits

Each harness keeps its own security and configuration; discovery does not wrap it in a
Voicebox sandbox. A browser cannot spawn a local program. Reaching CLIs on the browser's
machine requires a local server/helper bridge, **not implemented here**. A browser-native
harness does not require that bridge, but this machine inventory does not discover it.
Remote inventory aggregation, configured-agent selection and invoking a task remain separate.

## Checks

```sh
node --test tests/harness-tools.test.mjs tests/harness-inventory.test.mjs
```

The checks cover metadata limits, non-regular files, duplicate tool names,
invalid/empty/missing catalogues, field projection and both CLI output formats. A real desktop/mobile Chromium page against an owned
server opens tool disclosures with keyboard and pointer input, reads names/descriptions,
checks source/scope, literal hostile text, unchanged delegation refusals, cache reuse and
lost-connection staleness. Restarting with malformed metadata shows an explicit unknown
state without losing installation facts. Temporary executable fixtures accept version
checks only; they never contact a model. Set `VOICEBOX_HARNESS_EVIDENCE` to an output
directory when running the browser tests to save screenshots. These fixtures prove the
catalogue mechanism, not real harness tool execution or session permissions.
