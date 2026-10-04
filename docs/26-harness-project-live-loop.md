# 26 — Bidirectional Agent Harness & Project Live Loop (`voicebox-beads-vv7i` / `voicebox-beads-b9oz`)

## 1. Root-Cause Analysis (`voicebox-beads-vv7i`)

Investigation of Voicebox's task delegation pipeline across ACP adapters (`lib/pi-acp.mjs`, `lib/claude-acp.mjs`) and CLI executors (`lib/cli-harness-executor.mjs` for `antigravity`, `codex`, `gemini`, and `opencode`) identified three structural gaps that prevented delegated agent harnesses from operating in a tight, live loop with the active project workspace:

1. **Context-blind task prompts**: When a user delegated a task from a voice turn or operator room, the executor forwarded the raw task string (`input.task`) without workspace manifest context (`AGENTS.md` / `README.md` instructions, active sub-directory scope, or current top-level project files). CLI and ACP agents had to spend extra turns discovering basic workspace layout or missed repository-specific constraints altogether.
2. **Unobserved workspace mutations**: While executors spawned child processes with `cwd` set to the admitted project root (`root.path`), neither `lib/cli-harness-executor.mjs` nor `runAcpTask` in `lib/pi-acp.mjs` inspected the project directory before and after execution. File creations, edits, and deletions made by the agent harness on disk were invisible to the task result and room status stream.
3. **One-way output return**: Completed delegations returned only a truncated stdout snippet (`summary`) without structured workspace diff metadata (`createdFiles`, `modifiedFiles`, `deletedFiles`, `changedFiles`) or optional persisted analysis artifacts in the workspace.

## 2. Live Project Loop Architecture (`voicebox-beads-b9oz`)

`lib/harness-project-loop.mjs` closes the loop between every admitted agent harness and the active project workspace with zero external dependencies and deterministic, bounded I/O:

```mermaid
sequenceDiagram
    participant Room as Voicebox Room / Task Runner
    participant Loop as lib/harness-project-loop.mjs
    participant Exec as ACP or CLI Executor
    participant FS as Project Workspace (root.path)

    Room->>Loop: snapshotProjectWorkspace(root.path)
    Loop->>FS: Walk workspace files (size, mtimeMs, FNV-1a hash) & read instructions
    Loop-->>Exec: Pre-run snapshot + optional buildProjectAwareTaskPrompt()
    Exec->>FS: Spawn harness in cwd = root.path (pi, claude, codex, gemini, antigravity, opencode)
    Room->>Loop: integrateHarnessOutput(root.path, { beforeSnapshot, output })
    Loop->>FS: Re-snapshot workspace & compute diffProjectSnapshots(before, after)
    Loop-->>Room: { summary, changedFiles, createdFiles, modifiedFiles, deletedFiles }
```

### Core Capabilities in `lib/harness-project-loop.mjs`

- **`snapshotProjectWorkspace(rootInput, { maxFiles })`**: Captures a fast, bounded inventory of project files (ignoring `.git`, `node_modules`, `.beads`, `.audit`, and build caches) with file size, `mtimeMs`, and a lightweight 32-bit FNV-1a content hash for files up to 64 KB so sub-millisecond edits are reliably detected. Also extracts a bounded snippet of project instructions from `AGENTS.md`, `AGENT.md`, or `README.md`.
- **`buildProjectAwareTaskPrompt({ task, rootPath, subDir, includeProjectContext })`**: Enriches a delegated task prompt with the active project root, optional sub-directory scope, top-level file listing, and project instructions snippet so any CLI or ACP harness starts with immediate project context.
- **`diffProjectSnapshots(beforeSnapshot, afterSnapshot)`**: Computes deterministic `createdFiles`, `modifiedFiles`, `deletedFiles`, and combined `changedFiles` lists relative to the workspace root.
- **`integrateHarnessOutput(rootInput, options)`**: Runs immediately after a harness turn finishes, diffs the live workspace against `beforeSnapshot`, extracts a concise analysis summary combining harness output with workspace file mutations, and optionally writes a markdown analysis report into the workspace (`saveReport: true`).
- **`runWithProjectLoop(executor, options)`**: Wraps any `{ check, run }` executor so callers receive a normalized `{ ok, status, output, summary, changedFiles, createdFiles, modifiedFiles, deletedFiles, projectIntegration }` payload across both ACP and CLI harnesses.

## 3. Executor Integration (`lib/cli-harness-executor.mjs`, `lib/pi-acp.mjs`, `lib/claude-acp.mjs`)

- **CLI Harnesses (`lib/cli-harness-executor.mjs`)**: Every `run()` invocation snapshots `cwd` prior to spawning `antigravity`, `codex`, `gemini`, or `opencode`, supports `enrichProjectContext: true`, computes post-run workspace diffs via `integrateHarnessOutput`, emits `onProjectIntegration(projectIntegration)`, and returns `changedFiles`, `createdFiles`, `modifiedFiles`, `deletedFiles`, and `projectIntegration` on the result object.
- **ACP Harnesses (`lib/pi-acp.mjs` & `lib/claude-acp.mjs`)**: `runAcpTask` snapshots `cwd` before the ACP session runs, optionally enriches the prompt when `enrichProjectContext` is enabled, computes `integrateHarnessOutput` on completion, reports workspace file mutations through `report`, invokes `onProjectIntegration`, and returns the full integration object when `returnProjectIntegration: true` (while preserving raw string return by default for existing callers).

## 4. Verification

Scoped unit verification lives in `tests/multi-harness-execution.test.mjs` and runs in the concurrent unit lane without launching a browser or live server:

```bash
node --test tests/multi-harness-execution.test.mjs
```
