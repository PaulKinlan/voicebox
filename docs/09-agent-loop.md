# The Agent Loop

This document traces how a user turn flows through Voicebox from initial speech or text input to action resolution, workspace execution, UI updates, and audit logging.

---

## 1. Starting a Turn

A turn can start from two entry points, both converging on the same server-side action executor:

1. **Text Composer & Dictation (`POST /api/turn`)**:
   - Submitting text from the stage composer (`#text-form`), browser `SpeechRecognition` dictation, or the Picture-in-Picture widget sends `{ transcript }` (or a schema-validated `{ action: { verb, ... } }` from `COMMAND_VERBS`) to `POST /api/turn`.
   - `POST /api/turn` is stateless: it resolves the transcript, executes the resulting action in the active workspace root, records the audit trail, and returns `{ transcript, action, result }`:
     ```json
     {
       "transcript": "create a file called hello.txt with hi",
       "action": { "verb": "write", "name": "hello.txt", "content": "hi" },
       "result": { "ok": true, "action": "wrote hello.txt (2 bytes)", "file": "hello.txt", "root": { "kind": "machine", "path": "..." } }
     }
     ```
2. **Live Voice Session (`/live`)**:
   - `public/live-voice.js` streams full-duplex PCM audio over `/live` (`lib/live-session.mjs`) to Gemini Live (`models/gemini-3.8-live`) or OpenAI Realtime (`gpt-realtime`).
   - When the model invokes a tool (`toolCall`), the server maps the tool call via `commandToAction()` (`lib/commands.mjs`) directly into the shared `execute(action)` pipeline, returns the structured result to the model, and emits a `{ type: "tool" }` event to update the browser UI in real time.

---

## 2. Turn Resolution (`lib/resolver.mjs`)

For text turns on `POST /api/turn`, `resolveTurn(transcript, provider)` in `lib/resolver.mjs` converts natural language into a structured action:

```js
{ verb, name, content? }   // Resolved action to execute
{ unresolved: "reason" }   // Explicit explanation when no action matches
```

- **Registered Resolvers**:
  - **`script`**: Deterministic, zero-key pattern resolver supporting `write`, `read`, `list`, `delete`, `edit`, `diff`, `grep`, `make-tool`, and `tool`.
  - **`gemini` / `openai` / `claude`**: LLM-backed turn resolvers using the corresponding provider API key (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) configured via environment variables or the UI Settings dialog (`GET` / `PUT /api/keys`).
- **Clean Separation**: `server.mjs` never parses natural language directly; swapping or adding a turn resolver via `registerResolver(name, fn)` requires no changes to the executor or browser client.

---

## 3. Action Execution (`execute(action)` in `server.mjs`)

All resolved actions and live voice tool calls execute through `execute(action)`:
- **Workspace File Operations (`list`, `read`, `write`, `delete`, `edit`, `diff`, `grep`)**: Verified against the active workspace root (`core/root.ts`) before touching the filesystem or routing to a browser-owned root (`opfs` or `handle`). Path traversal (`../`) and dotfile access are refused by name (`outside-root`, `dotfile-refused`).
- **Extension Proposals (`make-tool` / `propose_extension`)**: Writes a pending JSON descriptor under `proposals/<id>.json` without loading or executing code.
- **Extension Admission**: Performed exclusively via host-authorized endpoints (`POST /api/extensions/admit` with `x-voicebox-host-token` or `POST /api/extensions/approve` with a single-use code from `tools/approval-code.mjs`).
- **Extension & WASM Invocation (`tool` / `call_extension`)**: Executes admitted extensions (`lib/extensions.mjs`) or digest-pinned WebAssembly shelf tools (`lib/wasm-shelf.mjs`) within their declared host bounds.

---

## 4. Audit Logging (`<root>/.audit/<writer>.jsonl`)

Every action and refusal inside an active workspace root is recorded to an append-only JSONL log in `<root>/.audit/` (`core/shared-log.ts`, readable via `GET /api/audit`):
- **Attempt-First Recording**: A mutating operation (such as `write`) records **two** linked entries:
  1. An `attempt` entry (`decision: "attempt"`, `result: "pending"`) before execution begins.
  2. An outcome entry (`decision: "allow"`, `result: "ok"`, `attempt: <seq>`) referencing the attempt's sequence number after the write completes and is verified on disk.
- **Pre-Flight Refusals**: Requests rejected before execution (such as `outside-root`) record a single `refuse` entry naming the violated rule.
- **Serialized appends (page side)**: the browser writer's OPFS appends run on a per-file promise chain in `browser/storage.ts` — concurrent acts used to capture the same file size and overwrite each other's lines (measured: 39 of 40 concurrent lines lost, voicebox-beads-2g7p), so "append-only" now includes "appends to one file never interleave" **within a realm**. Across realms the guarantee is the writer file itself: every realm carries its own instance identity (`browser/ui/ui.ts` claims the sessionStorage tab lineage under a Web Lock — Baseline since 2022, and the app already requires OPFS and module workers; a duplicated or `window.open`'d tab inherits the lineage but finds the lock held and takes a suffixed name, while a reloaded tab re-claims its dead predecessor's name — passed in the worker URL, voicebox-beads-826z). Without Web Locks the identity degrades to a per-realm nonce: unique up to the nonce space (4 hex), at a file per boot. Two tabs write two files the reader merges — before this, two tabs shared the `phone` file and a measured burst lost 19 of 46 lines.

---

## 5. Failure Modes & Refusal Handling

| Condition | Server Behavior |
|---|---|
| No workspace root declared | Returns `refused: "root-not-declared"`, `logged: null` (`declared: false` on `GET /api/health`). |
| Workspace directory removed mid-session | Returns `refused: "root-unreachable"`, distinct from an undeclared root. |
| Path escapes active workspace (`../`) | Refused pre-flight with `refused: "outside-root"` and recorded in `.audit/`. |
| Transcript matches no known command | Returns `action: null` with the resolver's `unresolved` message. |
| Extension tool exceeds bounds or host list | Returns structured refusal (`host-not-allowed`, `budget-exhausted`) via `lib/channel.mjs`. |
| Extension proposed by model | Saved as `state: "pending"` under `proposals/`; cannot be called until admitted by the host. |

---

## 6. Quick Verification

You can inspect and verify the turn loop at any time against a running server:
1. Check active resolver and root status: `GET /api/health`
2. Run sample turns via `POST /api/turn`:
   - `{"transcript": "list files"}` → `{"verb": "list"}`
   - `{"transcript": "create a file called hello.txt with hi"}` → `{"verb": "write"}`
   - `{"transcript": "book me a flight to Lisbon"}` → `action: null` (`unresolved`)
3. Inspect the recorded audit entries: `GET /api/audit`
