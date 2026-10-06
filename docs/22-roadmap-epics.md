# Roadmap Epics & Landed Architecture

This document catalogues the six major architectural epics designed in the foundational Voicebox briefs and interface studies (`docs/archive/00-brief.md`, `docs/archive/02-environment.md`, and `docs/archive/interface.md`) and describes their implementation across the Voicebox runtime.

Each epic is tracked in Beads (`bd`) as an `epic` issue with clear module boundaries and verification criteria.

---

## Summary of Roadmap Epics

| Epic | Bead | Title | Origin / Design Reference | Implementation Modules | Priority |
|---|---|---|---|---|---|
| **Epic 1** | `voicebox-beads-jagv` | **Multi-Participant Shared Voice Rooms & Live Presence ("Here, Together")** | `docs/archive/00-brief.md`, `docs/archive/interface.md` | `lib/room-presence.mjs`, `server.mjs`, `core/shared-log.ts`, `lib/channel.mjs`, `public/fused.js` | `P2` |
| **Epic 2** | `voicebox-beads-2pfb` | **Visual Branch & Worktree Landing Inspector ("Waiting to Land")** | `docs/archive/00-brief.md`, `docs/archive/interface.md` | **lib/branch-landing.mjs**, **public/apps/landing-inspector.html**, `server.mjs`, `lib/git-env.mjs` | `P1` |
| **Epic 3** | `voicebox-beads-1r99` | **Local Offline Speech-to-Text & TTS Fallback (Whisper / Piper)** | `docs/archive/00-brief.md`, `docs/07-architecture.md` | **lib/offline-speech.mjs**, **public/offline-speech-client.mjs**, `lib/live-session.mjs`, `public/live-voice.js` | `P2` |
| **Epic 4** | `voicebox-beads-80bd` | **Multi-Harness Result Comparison & Automated Diff Synthesis** | Multi-harness architecture (`lib/tasks.mjs`) | **lib/harness-comparison.mjs**, `public/apps/agent-monitor.html`, `lib/tasks.mjs` | `P1` |
| **Epic 5** | `voicebox-beads-kpp6` | **Native OS Companion / Global Hotkey & System Tray Bridge** | `docs/archive/00-brief.md` ("stay in the conversation while doing something else") | **lib/os-companion.mjs**, **scripts/voicebox-companion.mjs**, `public/pip-mic.mjs` | `P3` |
| **Epic 6** | `voicebox-beads-3l0w` | **Wasm Execution Cell Concurrency Semaphore & WASI Preview2 Capability Grants** | `docs/20-webassembly-tools.md`, `docs/archive/02-environment.md` | `lib/wasm-shelf.mjs`, `lib/wasm-worker.mjs`, `core/extensions.ts` | `P2` |

---

## Epic 1 — Multi-Participant Shared Voice Rooms & Live Presence ("Here, Together") (`voicebox-beads-jagv`)

### Context & Architecture
In `docs/archive/00-brief.md` and `docs/archive/interface.md`, Voicebox specifies a **"Here, together"** presence model built on `shared log + per-root work that still merges`. Alongside `core/shared-log.ts` (`appendEntry`, `markSeen`, `peerPresence`), `lib/room-presence.mjs` provides `createRoomPresenceCoordinator` and `DEFAULT_PRESENCE_TTL_MS` (`45000` ms) to coordinate live multi-participant room state, floor control, and shared captions across connected browser tabs, paired environments, and coding harnesses.

### Landed Implementation (`lib/room-presence.mjs`, `server.mjs`, `tests/room-presence.test.mjs`)
1. **Live Peer Presence Coordinator (`lib/room-presence.mjs`)**:
   - Tracks active participants (`joinParticipant`, `heartbeatParticipant`, `leaveParticipant`) with automatic TTL expiry pruning (`DEFAULT_PRESENCE_TTL_MS`).
   - Enforces collaborative turn-taking floor locks (`requestFloor` / `releaseFloor`) with `floor-busy` refusals when another active participant holds the microphone and automatic floor release on participant leave or TTL expiry.
   - Maintains a bounded ring buffer of shared captions and spoken turns (`recordSharedCaption`, `sharedCaptions`).
2. **Host Presence Endpoints & WebSocket Broadcast (`server.mjs`)**:
   - `GET /api/presence` returns the live pruned room snapshot (`count`, `floorHolderId`, `activeSpeaker`, `participants`, `sharedCaptions`).
   - `POST /api/presence` dispatches `join`, `heartbeat`, `leave`, `requestFloor`, `releaseFloor`, and `recordSharedCaption` actions, broadcasts `{ type: "presence", ...snapshot }` over `/channel`, and returns HTTP `409` on floor contention (`floor-busy`).

---

## Epic 2 — Visual Branch & Worktree Landing Inspector ("Waiting to Land") (`voicebox-beads-2pfb`)

### Context & Architecture
`docs/archive/interface.md` specifies a first-class **"Waiting to land"** workflow where changes produced in an isolated git branch or worktree by a delegated coding harness appear as an explicit, refusable landing proposal (`source root → destination root`, changed files, conflict pre-check, and recovery boundary) with **"Review merge"**, **"Merge these changes"**, and **"Keep separate"** actions.

### Landed Implementation (**lib/branch-landing.mjs**, **public/apps/landing-inspector.html**, `server.mjs`, `lib/git-env.mjs`)
1. **Worktree & Branch Landing Engine (**lib/branch-landing.mjs**)**:
   - Discovers candidate worktree/task branches, computes ahead/behind counts, file-level diff stats, and dry-run merge conflict detection against the active workspace branch.
2. **Landing Proposal & Merge API (`server.mjs`)**:
   - Exposes host endpoints to list pending candidate branches, inspect unified diffs and conflict pre-checks, and execute either a clean fast-forward/merge or a non-destructive `"keep separate"` dismissal.
3. **"Waiting to Land" Inspector UI (**public/apps/landing-inspector.html**)**:
   - Launchable on demand to render pending worktree landings with syntax-highlighted diffs and one-click or voice-triggered review, merge, and keep-separate controls.

---

## Epic 3 — Local Offline Speech-to-Text & TTS Fallback (Whisper / Piper) (`voicebox-beads-1r99`)

### Context & Architecture
When cloud voice provider credentials (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are unconfigured or the machine is offline, `/live` enters `standby` mode and falls back to local on-device speech recognition and synthesis so the room remains conversational without cloud connectivity.

### Landed Implementation (**lib/offline-speech.mjs**, **public/offline-speech-client.mjs**, `lib/live-session.mjs`, `public/live-voice.js`)
1. **Local Whisper / Piper Speech Engine (**lib/offline-speech.mjs**)**:
   - Probes local Whisper (`whisper-cli` / `whisper-cpp`) and Piper (`piper`) or OS TTS (`say` / `espeak-ng`) binaries, transcribes 16 kHz PCM audio locally, and synthesizes spoken responses with zero cloud dependencies.
2. **Client Offline Voice Fallback (**public/offline-speech-client.mjs**, `public/live-voice.js`)**:
   - Transitions seamlessly between cloud realtime models and local offline STT/TTS when network connectivity drops or when local offline voice mode is selected.

---

## Epic 4 — Multi-Harness Result Comparison & Automated Diff Synthesis (`voicebox-beads-80bd`)

### Context & Architecture
Voicebox supports delegating the same prompt simultaneously across multiple coding harnesses (`POST /api/tasks/delegate` with `agents: ["pi", "claude", "antigravity"]`). Once parallel harnesses finish, the operator can compare their generated diffs, modified files, and execution metrics side-by-side.

### Landed Implementation (**lib/harness-comparison.mjs**, `public/apps/agent-monitor.html`, `lib/tasks.mjs`)
1. **Multi-Harness Comparison Engine (**lib/harness-comparison.mjs**)**:
   - Groups fan-out task runs, computes file overlap matrices, execution duration rankings, status summaries, and synthesized diff comparisons across participating harnesses.
2. **Side-by-Side Comparison Matrix (`public/apps/agent-monitor.html`)**:
   - Displays parallel harness runs side-by-side in the Agent Progress Tracker mini-app with execution time, exit status, files modified, and unified diff inspection.

---

## Epic 5 — Native OS Companion / Global Hotkey & System Tray Bridge (`voicebox-beads-kpp6`)

### Context & Architecture
In `docs/archive/00-brief.md`, a core operator goal is *"an agent that stays in the conversation while I do something else."* Alongside the Document Picture-in-Picture microphone (`public/pip-mic.mjs`), the Native OS Companion bridge lets external global hotkeys and system tray helpers drive push-to-talk, mute, and desktop notifications over loopback.

### Landed Implementation (**lib/os-companion.mjs**, **scripts/voicebox-companion.mjs**, `public/pip-mic.mjs`)
1. **OS Companion Coordinator (**lib/os-companion.mjs**)**:
   - Manages companion registration, global hotkey dispatch (`push-to-talk`, `toggle-mute`, `stop-speaking`, `quick-note`), and desktop notification queuing.
2. **Loopback Companion CLI Bridge (**scripts/voicebox-companion.mjs**)**:
   - Lightweight local companion script that pairs with `server.mjs`, forwards global shortcut events into the active room, and surfaces native OS notifications when background tasks complete.

---

## Epic 6 — Wasm Execution Cell Concurrency Semaphore & WASI Preview2 Capability Grants (`voicebox-beads-3l0w`)

### Context & Architecture
As documented in `docs/20-webassembly-tools.md`, `lib/wasm-shelf.mjs` spawns isolated `worker_threads` Workers (`lib/wasm-worker.mjs`) per `callWasmTool` invocation with memory ceilings and hard timeouts. To protect host resources under parallel tool fan-out and support capability-scoped virtual preopens, the Wasm shelf enforces a bounded concurrency semaphore and WASI Preview2 capability grants.

### Landed Implementation (`lib/wasm-shelf.mjs`, `lib/wasm-worker.mjs`, `core/extensions.ts`)
1. **Bounded Worker Concurrency Semaphore (`lib/wasm-shelf.mjs`)**:
   - Enforces a configurable concurrency semaphore (`VOICEBOX_WASM_MAX_CONCURRENCY`, default `4`) and bounded wait queue so bursts of concurrent Wasm tool calls never exhaust host threads or memory.
2. **Capability-Scoped WASI Preview2 Virtual Preopens (`lib/wasm-shelf.mjs`, `lib/wasm-worker.mjs`, `core/extensions.ts`)**:
   - Validates and mounts capability-scoped read-only virtual directory preopens gated by the extension's admitted capability descriptor.
