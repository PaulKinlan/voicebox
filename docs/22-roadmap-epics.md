# Roadmap & Unimplemented Epics

This document catalogues the major architectural capabilities designed in the foundational Voicebox briefs and interface studies (`docs/archive/00-brief.md`, `docs/archive/02-environment.md`, and `docs/archive/interface.md`) that remain unimplemented in the current runtime, along with new multi-harness and platform epics identified during architecture review.

Each epic below is tracked in Beads (`bd`) as an `epic` issue and scoped with clear module boundaries and verification criteria.

---

## Summary of Roadmap Epics

| Epic | Title | Origin / Design Reference | Target Layer | Priority |
|---|---|---|---|---|
| **Epic 1** | **Multi-Participant Shared Voice Rooms & Live Presence ("Here, Together")** | `docs/archive/00-brief.md` (N19), `docs/archive/interface.md` | `core/shared-log.ts`, `lib/channel.mjs`, `public/fused.js` | `P2` |
| **Epic 2** | **Visual Branch & Worktree Landing Inspector ("Waiting to Land")** | `docs/archive/00-brief.md` (N19), `docs/archive/interface.md` | `server.mjs`, `lib/git-env.mjs`, `public/fused.js` | `P1` |
| **Epic 3** | **Local Offline Speech-to-Text & TTS Fallback (Whisper / Piper)** | `docs/archive/00-brief.md`, `docs/07-architecture.md` | `lib/live-session.mjs`, `public/live-voice.js` | `P2` |
| **Epic 4** | **Multi-Harness Result Comparison & Automated Diff Synthesis** | Multi-harness architecture (`lib/tasks.mjs`) | `lib/tasks.mjs`, `public/apps/agent-monitor.html` | `P1` |
| **Epic 5** | **Native OS Companion / Global Hotkey & System Tray Bridge** | `docs/archive/00-brief.md` ("stay in the conversation while doing something else") | `public/pip-mic.mjs`, host companion bridge | `P3` |
| **Epic 6** | **Wasm Execution Cell Concurrency Semaphore & WASI Preview2 Capability Grants** | `docs/20-webassembly-tools.md`, `docs/archive/02-environment.md` | `lib/wasm-shelf.mjs`, `lib/wasm-worker.mjs` | `P2` |

---

## Epic 1 — Multi-Participant Shared Voice Rooms & Live Presence ("Here, Together")

### Context & Gap
In `docs/archive/00-brief.md` (N19) and `docs/archive/interface.md`, Voicebox specifies a **"Here, together"** presence model built on `shared log + per-root work that still merges`. While `core/shared-log.ts` defines the append-only shared log data structure (`appendEntry`, `markSeen`, `peerPresence`), the live room UI (`public/fused.js`) and WebSocket `/channel` (`lib/channel.mjs`) currently operate as a single-operator session without visible multi-peer presence indicators, read-revision markers (`seen` marks), or coordinated turn-taking across multiple connected browser tabs or paired operator sessions.

### Scope & Deliverables
1. **Live Peer Presence over `/channel`**:
   - Wire `core/shared-log.ts` into `server.mjs` and `/channel` so every connected browser tab, paired environment, and active coding harness session broadcasts its presence, current activity, and `seen` cursor in real time.
2. **"Here, Together" Presence Bar in the Room Stage**:
   - Surface a compact, non-intrusive presence pill in `public/index.html` and `public/fused.js` showing active peer sessions, which files/revisions each peer has read, and who currently holds the microphone.
3. **Coordinated Multi-Tab Audio & Turn Locking**:
   - Prevent duplicate microphone capture across multiple open tabs on the same host and display clear `"last seen"` states when a peer disconnects.

---

## Epic 2 — Visual Branch & Worktree Landing Inspector ("Waiting to Land")

### Context & Gap
`docs/archive/interface.md` specifies a first-class **"Waiting to land"** workflow where changes produced in an isolated git branch or worktree by a delegated coding harness appear as an explicit, refusable landing proposal (`source root → destination root`, changed files, conflict pre-check, and recovery boundary) with **"Review merge"**, **"Merge these changes"**, and **"Keep separate"** actions. Currently, delegated tasks run in the workspace root or worktree, but the room UI lacks an in-app branch diff inspector and one-click landing/refusal flow.

### Scope & Deliverables
1. **Per-Task Isolated Worktree Option**:
   - Extend `lib/tasks.mjs` and `lib/git-env.mjs` so delegated coding tasks can optionally execute in an isolated git worktree (`git worktree add --no-track -b task/<id>`) without dirtying the operator's active working tree.
2. **Landing Proposal & Pre-Flight Diff API**:
   - Add host endpoints to inspect pending worktree branches, compute file-by-file diffs and merge-conflict status against the active workspace branch, and execute either a clean merge or a non-destructive `"keep separate"` dismissal.
3. **In-Room "Waiting to Land" Inspector UI**:
   - Render pending worktree landings in `public/fused.js` and the Agent Progress Tracker mini-app (`public/apps/agent-monitor.html`) with syntax-highlighted diffs and voice-triggerable `"review merge"`, `"merge changes"`, and `"keep separate"` commands.

---

## Epic 3 — Local Offline Speech-to-Text & TTS Fallback (Whisper / Piper)

### Context & Gap
When cloud voice provider credentials (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are unconfigured or the machine is offline, `/live` enters `standby` mode and falls back to browser `webkitSpeechRecognition` (`SpeechRecognition`), which is unavailable or cloud-dependent in many browsers (such as Firefox, Linux Chromium, or offline environments).

### Scope & Deliverables
1. **Local Whisper / WebGPU / ONNX Speech-to-Text Provider**:
   - Add a local zero-cloud STT/TTS provider option under `lib/live-providers/` (or browser WebGPU/Wasm worker) capable of transcribing 16 kHz PCM microphone audio on-device and synthesizing spoken replies locally.
2. **Automatic Offline Fallback**:
   - Seamlessly transition between cloud realtime models and local on-device speech recognition/synthesis when network connectivity drops or when the user selects `"Local Offline Voice"` in Settings.

---

## Epic 4 — Multi-Harness Result Comparison & Automated Diff Synthesis

### Context & Gap
Voicebox now supports delegating the same prompt simultaneously across multiple coding harnesses (`POST /api/tasks/delegate` with `harnesses: ["pi", "claude", "antigravity"]` or `harness: "all"`). However, once parallel harnesses finish, the operator must inspect each task's output individually rather than comparing their generated diffs and test results side-by-side.

### Scope & Deliverables
1. **Grouped Multi-Harness Run Comparison**:
   - Group fan-out task runs by batch ID in `lib/tasks.mjs` and `public/apps/agent-monitor.html`.
2. **Side-by-Side Output & Diff Matrix**:
   - Display a comparison view in the Agent Progress Tracker mini-app showing execution time, exit status, files modified, and unified diffs for each harness side-by-side, with a one-click **"Apply Winner"** action.

---

## Epic 5 — Native OS Companion / Global Hotkey & System Tray Bridge

### Context & Gap
In `docs/archive/00-brief.md`, a core operator goal is *"an agent that stays in the conversation while I do something else."* While the Document Picture-in-Picture microphone (`public/pip-mic.mjs`) keeps a floating mic window visible on desktop Chromium, browsers cannot register OS-wide global keyboard shortcuts (such as global push-to-talk when another application has focus) or read active OS window context without a lightweight native companion.

### Scope & Deliverables
1. **Lightweight Loopback OS Tray / Hotkey Helper**:
   - Provide an optional lightweight local helper script/binary that registers an OS-wide push-to-talk / mute shortcut and forwards hotkey events to `server.mjs` over `/channel`.
2. **Voice Feedback & Notification Bridge**:
   - Surface non-intrusive native OS notifications when a background delegated coding task completes or requests approval while the browser window is minimized.

---

## Epic 6 — Wasm Execution Cell Concurrency Semaphore & WASI Preview2 Capability Grants

### Context & Gap
As documented in `docs/20-webassembly-tools.md`, `lib/wasm-shelf.mjs` currently spawns an isolated `worker_threads` Worker (`lib/wasm-worker.mjs`) per `callWasmTool` invocation with memory ceilings and a 5-second hard timeout, using minimal zero-syscall `buffer-abi/1` and `buffer-abi/diff` ABIs. Under high parallel tool fan-out, worker creation is unbounded, and tools that need fine-grained read-only virtual filesystem access cannot use standard WASI Preview2 descriptors.

### Scope & Deliverables
1. **Bounded Worker Concurrency Semaphore**:
   - Add a configurable concurrency semaphore (`VOICEBOX_WASM_MAX_CONCURRENCY`, default `4`) and bounded queue in `lib/wasm-shelf.mjs` so bursts of concurrent Wasm tool calls cannot exhaust host threads or memory.
2. **Capability-Scoped WASI Preview2 Virtual Preopens**:
   - Support optional read-only virtual directory preopens in `lib/wasm-worker.mjs` gated by the extension's admitted capability descriptor (`core/extensions.ts`).
