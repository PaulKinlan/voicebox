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

## 4. Verification (`tests/system-commands.test.mjs`)

Run the scoped test suite in `tests/system-commands.test.mjs`:

```sh
node --test tests/system-commands.test.mjs
```
