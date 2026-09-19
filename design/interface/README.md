# Voicebox interface study

**An interactive design prototype: assets, sessions, admission and sideloads are simulated; no audio, model, files or tools are accessed.**

## Open it

From any directory, with Node 22 or later:

```sh
node /path/to/voicebox/design/interface/serve.mjs
```

Open **http://127.0.0.1:18088/**. An optional first argument changes the port; an occupied port is refused. The server binds only to loopback and serves only this study's directory. It supplies the actual `branch @ commit` build stamp and marks an uncommitted checkout as modified. A static copy explicitly says it is unstamped. No install, dependency, credential or live harness is needed.

## Try it

- **Watch things appear** creates three synthetic assets over about six seconds. **Stop speaking** changes the caption without stopping arrivals. **Pause work** stops arrivals; **Resume work** continues without making duplicate objects.
- Open an asset. In **Beside**, selecting another asset makes it the primary object; selecting it again opens its inspector. **Return** summarises the same work without replaying it.
- Review the little sorter. Try enabling or declining it; both are example UI outcomes, not real admission.
- Choose **fieldnotes@box**. **Here, together** shows two sessions, their activity, read revisions and seen-marks; **Waiting to land** shows a separately refusable merge alongside it. Try another shared event: the seen-mark advances but files do not land. Refuse the landing directly or review and accept it; its outcome stays on the main surface. Presence carries root-ownership details, not the only route to these two halves. This is a different sample project, not a copy or sync of the browser project.
- In **Settings → Extensions**, inspect a simulated third-party sideload. The browser-compatible sample can enter the example inventory only after an explicit decision. The shell-dependent sample cannot. Complete example source and requested-versus-grantable capabilities are visible. No catalogue or package loader is connected.
- Settings also explores undo kinds, appearance and a lost connection. Reconnecting never turns the simulated microphone back on. Browser-only mode never claims a Git worktree.
- **Type instead** accepts `make something` to play the study; other text is shown literally and kept only in this tab's example log.

Reload starts a fresh study. No browser storage or filesystem is written by the page. The examples do not prove OPFS durability, cross-device presence, identity, authority, package verification, sandboxing or real cancellation.

The three-asset sequence tests this small collection only; it is not evidence for six assets, an unbounded canvas or large-history performance.

## Verification

The browser check uses a local Chrome/Chromium and Node's built-in CDP WebSocket support. It starts its own loopback server and fresh browser profile, drives native pointer/keyboard input, records screenshots and exits nonzero on a failed assertion.

```sh
CHROME=/usr/bin/chromium node design/interface/verify.mjs /absolute/new/evidence-directory
```

The output directory must not already exist. The first two assertions are fail-fast positive controls: **an asset arrives and is visible**, and **a live session’s activity appears with its seen-mark**. They measure nonzero geometry, viewport intersection, computed visibility and occlusion at the visible intersection's centre. They run before absence-based UI/security assertions. Screenshot receipts retain the rectangles and visible text, rather than relying on DOM counts.

Three optional instrument controls deliberately break the page and must exit nonzero at a named positive, before any absence-based checks:

```sh
CHROME=/usr/bin/chromium node design/interface/verify.mjs /absolute/new/hidden-asset --hide-asset
CHROME=/usr/bin/chromium node design/interface/verify.mjs /absolute/new/offscreen-seen --offscreen-seen
CHROME=/usr/bin/chromium node design/interface/verify.mjs /absolute/new/blank-page --blank-page
```

These alter only the fresh browser's DOM, never source files. They are expected failures, not product defects. The phone capture is a full-page image; the live/landing band is scroll-reachable, not claimed to fit with every asset and voice control in the first viewport.

See [the interface proposal](../../docs/interface.md) for information architecture, alternative models and the exact source studies. The reviewed evidence receipt is linked there when available. No screenshots in this package establish a production runtime.
