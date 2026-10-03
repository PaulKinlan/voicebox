# Installed Harness Inventory

Voicebox can inspect the host machine for installed coding agent CLIs and display their availability, version status, active delegation state, and operator-declared tool catalogues.

---

## 1. Inspecting & Activating Harnesses

- **In the Browser UI**: Click **Harnesses** in the top bar (`public/harnesses.js`). From this dialog you can inspect installed coding agents and switch the active delegation harness (`GET` / `PUT /api/harnesses/active`).
- **Over HTTP**: `GET /api/harnesses`
- **From the Terminal**:
  ```bash
  node tools/list-harnesses.mjs
  node tools/list-harnesses.mjs --json
  ```

---

## 2. How Harnesses Are Probed

The inventory checks a fixed list of known coding agent CLIs across absolute directories in `PATH` (ignoring empty or relative `PATH` entries so a project directory cannot shadow a binary):
- **Pi** (`pi`, or `VOICEBOX_ACP_PI` when set) and **Pi ACP** (`.pi/agent/npm/node_modules/pi-acp`, or `VOICEBOX_ACP_ADAPTER`)
- **Claude Code** (`claude`, or `VOICEBOX_CLAUDE_CLI`)
- **Codex CLI** (`codex`)
- **Gemini CLI** (`gemini`)
- **OpenCode** (`opencode`)
- **Aider** (`aider`)

Each binary is probed with `--version` using `execFile` (no shell interpolation), a 3-second process-group timeout, and an 8,192-byte output cap. Raw filesystem paths and environment variables are never exposed to the browser, and results are cached for 60 seconds.

### Inventory Status Values

| Status | Meaning |
|---|---|
| `present` | Binary executed `--version` within bounds and returned a recognized version string. |
| `unrunnable` | Binary or configured path exists on disk but failed to execute, timed out, or exited non-zero. |
| `unknown` | Version output was unrecognized or only package metadata was readable. |
| `absent` | Not found in any absolute `PATH` directory. |

---

## 3. Host-Declared Tool Catalogues (`VOICEBOX_HARNESS_TOOLS`)

Because ACP `initialize` negotiates protocol capabilities rather than enumerating internal CLI tools, operators can optionally publish a descriptive JSON catalogue of tools for each harness by setting `VOICEBOX_HARNESS_TOOLS` to an absolute file path (`lib/harness-tools.mjs`):

```bash
VOICEBOX_HARNESS_TOOLS=/absolute/path/harness-tools.json node server.mjs
VOICEBOX_HARNESS_TOOLS=/absolute/path/harness-tools.json node tools/list-harnesses.mjs --json
```

### Example Catalogue Format
```json
{
  "pi": {
    "source": "Operator-maintained list for local Pi installation",
    "scope": "Built-in coding tools",
    "tools": [
      { "name": "read", "description": "Read files in the workspace." },
      { "name": "bash", "description": "Execute shell commands under the harness configuration." }
    ]
  },
  "claude": {
    "source": "Operator-maintained list for Claude Code",
    "scope": "File and search tools",
    "tools": [
      { "name": "Read", "description": "Read a workspace file." }
    ]
  }
}
```

### Validation & Security Rules (`lib/harness-tools.mjs`)
- Accepts only regular files up to 256 KiB at an absolute path (rejects relative paths and symlinks at the final path component).
- Allowed top-level keys: `pi`, `claude`, `codex`, `gemini`, `opencode`, `aider`, `pi-acp`.
- Requires non-blank `source` (≤ 512 chars), `scope` (≤ 1,024 chars), and `tools` array (≤ 128 tools, each with a unique 1–128 char alphanumeric/`_`/`.`/`:`/`-` `name` and ≤ 4,096 char `description`).
- Each `GET /api/harnesses` entry reports `toolCatalogue` with either `status: "declared"` (`source`, `scope`, `tools`) or `status: "unknown"` (`why`). `public/harnesses.js` renders all catalogue strings as literal text nodes, never HTML.

### Verification Suites
```bash
node --test tests/harness-tools.test.mjs tests/harness-inventory.test.mjs
```
