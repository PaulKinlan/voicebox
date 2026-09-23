# An open studio, with a voice in it

Interface exploration by Astra, 2026-09-19. This is a proposal and an interactive study, not a working agent. [The brief](00-brief.md), especially N10–N13, takes precedence over the older open questions. This study also incorporates the coordinator's N17 extensions and N19 shared-log/landing requirements of 2026-09-19.

**Recommendation:** keep isocan's voice surface and let made things occupy the space around it. A canvas is useful for a page, a note, a dataset, an image or a newly made tool. Putting every command on it would bury those things. Commands, intermediate errors and execution history belong in Logs; a concrete plan comes forward when it needs a decision.

[Run the study](../design/interface/README.md). Its three views test different attention models with the same synthetic work. None is a production-stack decision.

## What carries over from isocan

Source inspected at `5e7f7bbcaabe0c15a1e7a171e938eabf07782f54` in `PaulKinlan/isocan`:

| Source | Keep | Change for long-lived work |
|---|---|---|
| `packages/voice-agent/voice.html`, `src/voice.css` | Dominant microphone, fine orbit, Inter, restrained blue/green, short caption. Logs and Settings are one action away. | Make room for actual outputs rather than expanding the transcript. The microphone keeps its identity when the user concentrates on an artefact. |
| `src/main.ts`, `Activity`, `stateWords()` | Listening, speaking, muted and disconnected are different visible states. Mic state is not inferred from session existence. | Add an independent work state. “Stop speaking”, “Mute mic” and “Pause work” must not be synonyms. A stop requested from a disconnected client remains unconfirmed. |
| `src/main.ts`, `fadeCaptionLater()`, `renderTranscript()` | The current caption is a reading aid; the record lives elsewhere. | Keep decision text until it is resolved. A return summary survives longer than an utterance and links to the actual changed objects. |
| `voice.html`, `.voice-confirm` | A reachable, non-blocking permission tray, with explicit decisions. | Show originating instance, project, execution root, exact effect and undo limit. Answering somebody else's request must not look like changing the local session. |
| `src/voice.ts`, `audioSocket(brokerOnly)` | Reconnecting the page need not restart microphone capture. | Reconcile work and pending decisions before resuming. Never silently turn the mic back on or replay a side-effecting turn. |

The prototype adapts the palette, type, mic geometry and separation of record from conversation; it does not import isocan's application store, live sockets, credentials or canvas engine. Light/dark both follow the same language. The default follows the device; the screenshots show the explicit theme they used.

## Three interaction models

These differ in what retains attention and what happens when an artefact arrives, not merely in layout colour.

### Studio — objects stay where you left them

The microphone sits below an open field of made things. A small page appears, then a note, then a tool needed to organise it. Arrivals settle into reserved positions; they do not scroll the user, steal focus or announce each streamed token. Opening an object reveals its content and provenance. The running conversation remains available underneath.

Best for exploring and making several related things. This is the closest answer to “assets getting created in front of you”. It needs a real object model: stable ID, revision, type, title, preview and origin, rather than a screenshot of the latest model message. A revision updates an existing object; it does not spawn another tile. A failed build leaves the last valid revision in place and identifies the failed attempt.

Cost: a spatial field gets unwieldy. The proposal uses a bounded, auto-arranged collection before introducing infinite pan/zoom. Phone layout is an ordered shelf with an explicit open action, not a tiny scaled-down desktop canvas. A list view remains the keyboard/screen-reader reading order.

### Beside — one object is the work surface

Open one artefact at a time, with the other outputs in a small selectable shelf. Voice lives alongside rather than competing with the object. New objects join the shelf but never replace what the user is reading. On a phone the object sits above the voice controls.

Best for editing or testing one thing while continuing the conversation. It could be used in an ordinary split browser window while Paul works elsewhere; this proposal does **not** promise an always-on-top desktop overlay, cross-site injection or a microphone that survives mobile suspension.

Cost: weaker sense of accumulation. An “added while you were away” count is needed, and looking at another object is a deliberate act. The study's shelf changes the primary object; Studio's open action instead inspects an object without reorganising the field.

### Return — a catch-up, not a live dashboard

Lead with the last acknowledged work checkpoint: “A page and a note are ready. The sorter still needs a decision.” Show links to those objects and the unanswered decision, with a large microphone for continuing. Full command history remains optional. The study switches to this view without restarting the creation sequence.

Best when returning from a walk, another project or a disconnected browser. It answers what changed, what did not finish and what needs the user. It is not an auto-narrated feed: default quiet, spoken catch-up on request.

Cost: less immediate than seeing things arrive. It is a useful return state for Studio, but should not replace Studio as the default. A chronological timeline is a good secondary record; a terminal is a good detail view for one command. Neither carries a made page or a newly useful tool as well as the artefact itself.

## Information architecture

The top level is deliberately short:

- **Project + environment:** a single selector with placement-bearing identity. `fieldnotes@this-browser` and `fieldnotes@box` are different projects, even if their display names match.
- **Made things:** the primary collection. Pages, notes and tools are examples, not a closed type taxonomy. A tool has content, revision and provenance like other artefacts, plus an admission state.
- **Conversation:** current caption, microphone, interruption and work pause. Typed interaction is an alternative input, not a permanent chat column.
- **Here, together + waiting to land:** the machine project's live activity, read revisions and seen-marks share the main surface with a separately refusable landing. Root ownership and queued-write details remain behind the quiet presence count. Browser-only mode explicitly has no remote collaborators.
- **Logs:** utterances and process events linked to artefacts and turns. Arrival order is not asserted to be a cross-machine total order.
- **Settings:** theme, environment reach, storage durability, recovery/undo kind and capability facts. A brief storage/undo line remains visible without opening Settings.

### The object model underneath the picture

An artefact is what someone can return to: `{id, revision, kind, title, project, root, producer, turn, preview, state}`. A plan is an intended effect, an event is something that happened, and an artefact is an output. They link to one another, but are not interchangeable. “Made”, “validated”, “admitted” and “published” are separate facts; a pretty preview establishes none of the latter three.

A newly authored tool appears as **Made · not enabled**. Its review names requested reads, writes, network and execution. Admission is the environment's answer, not the model's optimistic description. Changing the tool or its plan invalidates the old answer. A shell-dependent tool in the browser says **Needs a machine environment**; it does not offer a doomed Run button or silently send files elsewhere.

### Decisions without a wall of metadata

A short inline request says the effect and the originating instance. “Review” opens the exact plan, with named root, paths, effects, permitted input method and undo boundary. Reject is always available. Outside clicks or Escape close the inspector without granting anything. The last decision remains readable as answered/expired; a second instance answering first disables the stale action. Silence is never consent.

A merge is its own proposal: source root → destination root, changed paths, conflict result and the recovery available after it. **Keep separate** refuses without deleting either root. **Merge these changes** is a separate explicit choice, not a side effect of closing the review. In browser-only mode this machine/worktree example is absent.

### Shared now, landed by decision (N19)

Paul chose **shared log + per-root work that still merges**, so the machine surface has two visible halves. They flank the voice control in desktop Studio and Return; Beside puts them below the selected object, and the phone keeps them side by side in a scroll-reachable band. The user does not have to open Presence to discover either half.

**Here, together** shows two synthetic sessions with different harnesses, each owning a root. The current activity includes both what the session read (`note r1`) and what it had seen from its peer (`seen Voice #2`). These are different facts: a read revision identifies source material, while the seen-mark identifies shared-log knowledge. “Try another shared event” appends an entry, advances that session's seen-mark and leaves the landing untouched. Logs exposes the earlier entries; it does not replace them with the latest state. This is a local demonstration of the shape, not a claim that two real harnesses exchanged messages.

**Waiting to land** names the source and destination, the proposed file and the recovery kind. **Review merge** shows the exact proposed effect; **Keep separate** refuses without deleting either root or stopping shared activity. Accepting changes this main-surface status to **Landed in walk** and appends a landing entry. The merge is a user-visible event, not background reconciliation. Admission of the tool remains a separate decision from landing its file.

This adds live knowledge to the asset-led surface, not a status dashboard. Activity is two compact current entries rather than a permanent transcript. A disconnected view says **last seen** and disables decisions; it does not keep claiming live presence. No network, conflict resolution, append-only storage guarantee or cross-instance delivery is implemented here.

### Undo is a named mechanism

| `undoKind` | Compact wording | Necessary limit |
|---|---|---|
| `git-branch` | Branch recovery | Named branch/base; not untracked files or external effects. |
| `worktree` | Separate worktree | Discarding that root does not undo already merged work, deployment or egress. |
| `written-file-list` | Recorded file changes | Restore captured old bytes and prior absence. Merely remembering filenames is not recovery. |
| `none` | No automatic undo | Say this before acting; narrow unprompted work to inherently reversible operations. |

The study describes these mechanisms but never performs an undo. A product must expose the actual recorded recovery data, not infer recoverability from the enum.

### Browser storage is not a promise of permanence

A browser peer says **Only in this browser · may be cleared** unless actual storage protection is reported. “Protected from automatic cleanup” still does not mean a backup: profile deletion and clearing site data remain destructive. A quota failure keeps the prior readable object and offers a concrete recovery path; it must not say Saved.

OPFS is origin-private and reopened without a file-picker permission dance. User-picked external directories are a different capability and may need reauthorisation. Device-local projects do not acquire remote presence just because a second browser has a project with the same name. Export, transfer or synchronisation needs an explicit operation and egress decision. The prototype's storage sentences are labelled example state; it does not call `persist()`, claim a quota or implement OPFS.

## Behaviour worth testing before connecting a model

1. Play the synthetic creation: a page, note and tool arrive. Interrupt the caption and the objects continue to arrive. Pause work instead and subsequent arrivals stop; Resume continues without duplicating objects.
2. Open an object while something else arrives: reading position and keyboard focus remain stable. Beside keeps the selected object when a new one appears.
3. Answer a tool request: it changes from not enabled to enabled only after the explicit answer. Rejection is visible. Browser-incompatible capability stays unavailable.
4. Switch to the machine sample: the project identity, live activity, seen-marks and recovery change together. A new shared event leaves the landing pending and preserves earlier entries. Review a request originating from the chat instance, and separately accept or refuse its proposed merge. Both live knowledge and the landing must remain visible without opening Presence.
5. Return after changing views: existing objects remain; there is no fictitious replay of their creation. Reconnect restores the work summary but leaves the simulated microphone off.
6. Drive keyboard and pointer at desktop, phone and short landscape sizes. A confirmation must remain reachable and never hide the only way to interrupt voice.

## Extensions: discover, inspect, then decide (N17)

Extensions live behind Settings, not in the asset field's primary chrome. Tools created during the conversation can still arrive as assets. The study adds a flat extension inspector with three jobs:

- **Inventory:** installed version, origin, publisher verification state and destination environment. An authored tool proposal is not silently counted as an installed third-party extension.
- **Discovery:** explicitly no catalogue connected in this study. Publisher identity, curation and the source of catalogue entries are open decisions, not a fictitious marketplace.
- **Sideload preview:** choose one of two labelled example packages, read its complete illustrative source and compare requested capabilities with what the example environment can grant. The shell-dependent package cannot be installed, even after switching to the machine sample: the study has no contained execution environment. The browser-compatible sample requires an explicit decision before it enters the example inventory. Declining leaves inventory unchanged.

A real sideload is a privileged host decision, bound to verified package bytes, version, destination project/environment and exact granted capabilities. Changing any of those invalidates the answer. A display name, author claim, pasted URL or model-generated descriptor cannot provide that binding. The host owns installation and reload; previewing source grants nothing. The prototype does not upload, fetch, verify, install or execute a package. It tests whether the distinction is visible and whether both refusal and acceptance have coherent UI outcomes.

## Boundaries and next iteration

The environment design was consumed at `4fac59c5c777f3ca75e0403a8038a68a91f68162`, with the coordinator's later correction that OPFS reopens without a permission gesture. Its inherited machine-only statements are not carried into this design. The prototype has no model, actual microphone capture, host transport, tool execution, sandbox, remote instances, filesystem or durability guarantee. It only demonstrates their proposed presentation and transitions.

The unresolved question to show Paul is concrete: **when a page and a useful tool appear during the conversation, does he want both to remain around the mic, or one large object with the others within reach?** Studio and Beside make that choice testable. Return is the proposed answer for coming back, not a third competing product.
