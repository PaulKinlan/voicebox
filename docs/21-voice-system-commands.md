# Voice System Commands & Catalogue

Voicebox provides deterministic, zero-latency system voice commands for clipboard operations, room navigation, appearance switching, and audio/session controls alongside its generative live model and tool execution paths.

## 1. Command Catalogue (`lib/system-commands.mjs`)

The canonical command catalogue and parser live in `lib/system-commands.mjs`.

- `SYSTEM_COMMAND_CATALOGUE`: Exports the structured catalogue of voice commands with `category`, `command`, `phrases`, and `description`.
- `parseSystemCommand(rawText)`: Deterministically parses natural-language voice transcripts into structured `{ verb: "system", command, target, text, file, mode }` actions.

### Supported System Commands

| Command | Category | Example Phrases | Action Payload |
|---|---|---|---|
| `copy` | `clipboard` | `"copy"`, `"copy that"`, `"copy to clipboard"`, `"copy <text> to clipboard"`, `"copy the file"`, `"copy last reply"` | `{ verb: "system", command: "copy", target: "selection" \| "file" \| "reply" \| "literal", text }` |
| `paste` | `clipboard` | `"paste"`, `"paste that"`, `"paste from clipboard"`, `"paste into <file>"`, `"paste from clipboard into <file>"` | `{ verb: "system", command: "paste", target: "active" \| "file", file }` |
| `open_panel` | `navigation` | `"open files"`, `"open history"`, `"open settings"`, `"open harnesses"`, `"open activity log"`, `"open agent tracker"`, `"close panel"` | `{ verb: "system", command: "open_panel", target: "files" \| "history" \| "settings" \| "harnesses" \| "activity" \| "agent-tracker" \| "close" }` |
| `switch_theme` | `appearance` | `"dark mode"`, `"light mode"`, `"system theme"`, `"switch to dark mode"`, `"switch to light mode"` | `{ verb: "system", command: "switch_theme", mode: "dark" \| "light" \| "system" }` |
| `stop_speaking` | `audio_session` | `"stop speaking"`, `"quiet"`, `"mute"`, `"unmute"` | `{ verb: "system", command: "stop_speaking", mode: "interrupt" \| "mute" \| "unmute" }` |
| `clear_activity` | `audio_session` | `"clear activity log"`, `"clear work log"` | `{ verb: "system", command: "clear_activity" }` |
| `show_waiting_branches` | `branch_landing` | `"show waiting branches"`, `"inspect candidate branches"`, `"review merge"`, `"branches waiting to land"` | `{ verb: "system", command: "show_waiting_branches" }` |
| `land_branch` | `branch_landing` | `"merge branch"`, `"land branch"`, `"merge into workspace"` | `{ verb: "system", command: "land_branch" }` |
| `keep_branch_separate` | `branch_landing` | `"keep branch separate"`, `"keep separate"` | `{ verb: "system", command: "keep_branch_separate" }` |
| `compare_harnesses` | `harness_comparison` | `"compare harnesses"`, `"harness comparison"`, `"compare agents"`, `"harness tracker"` | `{ verb: "system", command: "compare_harnesses" }` |

## 2. Turn Resolution (`lib/resolver.mjs`)

In `lib/resolver.mjs`:
- `KNOWN_VERBS` includes `"system"`.
- Both `script(transcript)` and `resolveTurn(transcript, provider)` evaluate `parseSystemCommand(transcript)` when a turn is not a file or tool command, returning a deterministic `{ verb: "system", ... }` action.

## 3. Execution & Broadcast (`server.mjs`)

When `execute(action)` in `server.mjs` receives `action.verb === "system"`:
1. It constructs `systemCommand = { command, target, text, file, mode }`.
2. It broadcasts `{ type: "system_command", ...systemCommand }` over `/channel` to connected room clients.
3. For `clear_activity`, it clears `workActivityLog`; for other system commands, it appends a `"system"` entry to the work activity log.
4. `POST /api/turn` returns `systemCommand` and `say` both inside `result` and at the top level of the JSON response.

## 4. Browser Consumption (`public/fused.js`)

`executeBrowserSystemCommand(cmd)` in `public/fused.js` is the only consumer of these commands. It reads the SAME field names the catalogue emits. That agreement is the part of this contract nothing asserted until voicebox-beads-ucak: the parser, the server broadcast and the turn response all carried `target` and `mode` while the client guarded on `panel` and `theme`, so every navigation and appearance command silently did nothing — for as long as it existed — while both sides' tests stayed green against themselves.

| `command` | field read | value | browser action |
|---|---|---|---|
| `switch_theme` | `mode` | `dark` \| `light` \| `system` | `applyTheme(mode, { persist: true })` — sets `data-theme` / `data-theme-mode` and stores the choice |
| `open_panel` | `target` | `files` \| `history` \| `activity` \| `deck` | `sqehSetState(target)` — moves the deck |
| `open_panel` | `target` | `settings` | opens the Settings dialog |
| `open_panel` | `target` | `harnesses` | opens Harnesses |
| `open_panel` | `target` | `agent-tracker` | mounts the built-in Agent Progress Tracker mini-app |
| `open_panel` | `target` | `close` | closes any open modal sheet, then `sqehSetState("deck")` — back to the deck, closing open windows |
| `copy`, `paste` | `text` | | clipboard, as before |
| `stop_speaking` | `mode` | `interrupt` \| `mute` \| `unmute` | cancels speech synthesis, triggers interrupt (`#interrupt`) or toggles microphone (`#mic`) |
| `show_waiting_branches` | — | — | mounts the candidate branch landing inspector mini-app (`/apps/landing-inspector.html`) |
| `land_branch` | — | — | lands (merges) the one waiting candidate branch into the workspace, for real in `lib/branch-landing.mjs` (`executeBranchIntent`); says when none wait, and opens the inspector to choose when several do |
| `keep_branch_separate` | — | — | marks the one waiting candidate branch to remain separate without merging; same none/ambiguous honesty as `land_branch` |
| `compare_harnesses` | — | — | opens the Agent Progress Tracker comparison mini-app |
| `clear_activity` | — | — | server-side only — `server.mjs` clears the work activity log |

The client also accepts `extensions`, `environments` and `changelog` targets, which the catalogue does not currently emit. They are kept deliberately: the page's `window` `"message"` listener also accepts a `system_command` from outside the page, so the consumer is a superset of the in-page producer by design, and removing them would narrow a documented external entry point.

Verification for this half of the contract is a BROWSER drive, not a parser assertion: `tests/system-command-browser.test.mjs` types each command into the composer, waits for the turn to land in `#session-log` (so the drive cannot pass vacuously), then asserts the observable UI.

## 5. Verification (`tests/system-commands.test.mjs`)

Run the scoped test suite in `tests/system-commands.test.mjs`:

```sh
node --test tests/system-commands.test.mjs
```
