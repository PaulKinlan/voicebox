# N10 admission claim — driven from the browser — 2026-09-20

Branch `prove/n10-admission` off `main@4340185`. Server: `node server.mjs`, port 8812,
scratch state dirs (`VOICEBOX_WORKSPACE`/`VOICEBOX_EXTENSIONS_DIR` in /tmp). Every act below
was driven from page JS in Chrome against the served page (screenshot: `drive-page.png`,
rendered live into the page during the drive); host acts were driven from the shell.

## THE VERDICT, plainly

**The host owns the directory. The host does NOT own the trigger.**

- The DIRECTORY half holds: the page has no filesystem reach; its proposals land as pending
  data; a file dropped into the extension directory does not load on its own; and every
  page-supplied escape path is refused by name at execution (`../`, deep `a/b/../../../`, and a
  symlink pointing outside the root — `outside-root`, the shared containment shape).
- The TRIGGER half does not hold against the page: `POST /api/extensions/admit {confirm:true}`
  is an unauthenticated same-origin route. **The page admitted its own proposal in two fetches
  and then ran it** (drive 5). Against the model and the filesystem the claim is true; against
  the page it is not — which is exactly the contrast N10's claim draws ("rather than the page
  being able to admit code to itself").

## Second finding (worse than it looks, found mid-drive)

**Set membership is directory-defined, not admission-defined.** A valid descriptor dropped
into the extension directory by a shell act did NOT load on its own (drive 2: running set
empty, tool `unknown-tool`) — but when the host later admitted pageclock, `loadRegistry()`
walked the whole directory and **swept the never-admitted file into the running set**
(drive 3: running set `["pageclock-tool","sneak"]`; `sneak_tool` executes). The reload was
host-triggered; the LOAD of `sneak` was not. An auditor comparing admissions to the running
set cannot tell who admitted `sneak` or when, because nobody did. Fix shape: an admission
ledger — the registry loads only descriptors whose admission is recorded, not everything the
directory contains.

## The drives

1. **Page proposes, cannot run** — `POST /api/turn "create a tool called pageclock…"` →
   `pending`; `"run the tool pageclock"` → `{ok:false, refused:"not-admitted", why:"'pageclock'
   is a pending proposal — the host has not admitted it"}`. Named, in the existing vocabulary.
2. **A file in the directory is not a load** — `sneak.json` written into the extension dir by
   a shell act (valid, gate-passing descriptor). Page inventory: running set `[]`.
   `run the tool sneak_tool` → `{refused:"unknown-tool"}`. No reload happened that the host
   did not trigger. (But see the second finding: the NEXT host-triggered reload swept it in.)
3. **The host admits; the extension genuinely runs** — shell `POST /api/extensions/admit
   {id:"pageclock-tool",confirm:true}` → `admitted`; from the page,
   `"run the tool pageclock"` → `{ok:true, content:"Sun Sep 20 2026 15:38:44 GMT+0100 …"}`
   rendered on the page. No other endpoint serves this; without the admission the call refuses.
4. **Escapes refused by the shared containment** — an admitted `read-file` tool with
   `path:"../extensions/sneak.json"` → `{refused:"outside-root", why:"…escapes the project
   root — the scope the tool was admitted under"}`; `a/b/../../../extensions/sneak.json` →
   same; a symlink (`workspace/link-out` → outside) → same. Note honestly: the GATE admits
   escaping-path descriptors (paths are not gate-checked); the named refusal happens at
   EXECUTION, by the runtime containment — enforcement, not declaration, is what makes the
   bound true.
5. **The page admits code to itself** — from page JS:
   `POST /api/extensions/proposals {descriptor: pagetool}` → pending; then
   `POST /api/extensions/admit {id:"pagetool", confirm:true, decision:"admit"}` →
   `{decision:"admitted"}`; `"run the tool pagetool"` → `{ok:true, content:"…GMT+0100…"}`.
   No refusal exists at this door, named or otherwise — nothing stops it.

Blast radius of the page-driven admission, stated precisely: the closed primitive set with
gate-passing bounds of the page's choosing — root-scoped file reads/writes and budgeted
same-host-allowlisted server-side fetches. Not arbitrary code (descriptors are data; there is
no evaluate path), but it IS server-side capability the page alone cannot otherwise obtain
(its own fetch is ambient but cannot make the SERVER fetch).

## Fix shape (named, not landed — it touches astra's UI flow)

The design already holds the mechanism: docs/02 §1.5's host-generated token (mode 0600,
passed on the upgrade). `admit`/`deny` should require the host token; the page keeps
discover/propose/plan/sideload-stage. File bead: `voicebox-beads-8v0`.

---

## RE-DRIVE on the fix (52bcec5) — the acceptance — 2026-09-20

Fresh scratch state, server on the fixed code, the SAME two fetches from page JS:

1. `POST /api/extensions/proposals {pagetool2}` → `pending` (the page's door, still open).
2. `POST /api/extensions/admit {confirm:true}` **without the host token** →
   **`403 {ok:false, refused:"host-token-required", why:"admission is the host's act — this
   route requires the host token (x-voicebox-host-token); the page cannot hold it"}`**.
3. `"run the tool pagetool2_tool"` → `not-admitted` (named, still).
4. The host, reading the 0600 token file, admits WITH `x-voicebox-host-token` → `admitted`;
   from the page the tool runs (`"Sun Sep 20 2026 15:51:39 GMT+0100"`).
5. The ledger: a fresh `sweep3.json` dropped into the directory (no admission), then the host
   admits another tool (reload fires) → running set `[pagetool2, reloadbait2]` — sweep3 is
   **not** live, refuses `unknown-tool`, and the inventory shows
   `{id:"sweep3", state:"present-not-admitted", note:"…visible, never live"}`.

The re-drive was rendered live on the served page and screenshot-verified in session (the
transcript above is the page's own rendered log element; the first drive's screenshot is
`drive-page.png`). Whole gate `npm test` 138/138; `git status --porcelain` empty.

---

## The token-read chain: found, closed, re-driven (2026-09-20, bdb17bb)

The reviewer's dotfile probe, driven one step further on merged main: `POST /api/root` accepts
the HOST's own extensions directory as the active root (unauthenticated route), and then
`GET /api/file?name=.host-token` returned **the host token itself** — the m2i gate circumvented
end to end (declare → read token → admit). The write verb could overwrite the token with a
known value just as well.

**Closed**: the read and write verbs and `/api/file` refuse dotfiles by name
(`dotfile-refused`), matching the listing routes' existing filter — one rule: what the listing
hides, the loop refuses. Containment keeps its own, stronger refusal for `..` and traversal
(the dotfile check runs after containment, on the resolved basename).

**Re-driven on the fix** (screenshot-verified in session; the rendered log is the transcript):
declare the host dir as root (succeeds — that route's question is filed separately as
`voicebox-beads-3uy`) → listing `[]` with no dotfile names → `/api/file?name=.host-token` →
`dotfile-refused` → read verb → `dotfile-refused` → write verb → `dotfile-refused`.
**Chain verdict: SHUT — every path to the token refuses by name.**
