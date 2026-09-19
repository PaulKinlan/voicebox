# Picked roots, and what the platform actually does — measured

E1-M0 (the browser environment's existence proof) plus **N20** (persistent directory handles) plus
the **three-root explorer** (bead `voicebox-beads-7cd`). Built on `main@309e43c`, branch
`e1m0/browser-environment`.

Every claim below was driven, not read: **27 acceptance checks** in `npm run test:e1m0`, in a real
headless Chromium, over the page the browser actually loads. Where a check could not be driven, it
says so and says why — that is the point of this file.

**Correction, after review.** An earlier version of this receipt said the spec's §8 had "eight
(nine)" checks. The spec at the base commit — `309e43c`, whose diff from this branch is empty, so
it is unmodified and therefore authoritative — has **ten**: 8a and 8b share the eighth slot. The
brief's "eight" was the miscount and this receipt repeated a second one; the document is right.
The table below is the mapping a reader should quote.

---

## 1. What was measured about picked directories, and by what method

A script cannot open a native picker, so the handle comes from the platform's other real path:
**drop a folder on the page** and take it from `DataTransferItem.getAsFileSystemHandle()`. Driven
through CDP `Input.dispatchDragEvent` (`tests/lib/cdp.mjs`). The folder is a real one on disk under
`/tmp`; the files the checks read are the files `node` wrote.

| What was tried, on a dropped real folder | Result |
|---|---|
| `queryPermission({mode:"read"})` | `granted` |
| `queryPermission({mode:"readwrite"})` | `prompt` |
| `getFileHandle("real.txt")` then `.getFile()` | **works** (6 bytes read) |
| `getDirectoryHandle(".audit", {create:true})` | **blocks** — never resolves, no error |
| `getFileHandle("new.txt", {create:true})` | `SecurityError: User activation is required to request permissions.` |
| `createWritable()` on an existing file | `SecurityError: User activation is required to request permissions.` |
| `requestPermission({mode:"readwrite"})` with `Runtime.evaluate {userGesture:true}` | **blocks** — the prompt has no UI in headless |
| after `Page.reload`: `getHandle` from IndexedDB, then `queryPermission` | the handle is **there** (same folder name) with `readwrite: prompt`; a read then fails `NotAllowedError` until a gesture restores it |

**Three consequences, and each one changed the build:**

1. **A write in the `prompt` state must be refused before it is attempted.** One of the four calls
   blocks forever rather than throwing, so "try it and catch the error" is not a strategy — the
   host checks the permission state first and answers `needs-gesture` in words. That is the same
   rule the project already applies to a guard that cannot do its job: say so rather than doing a
   weaker version of it.
2. **A read-only picked root cannot hold its own audit file.** `mkdir .audit` is the call that
   blocks. So the log for such a root goes to origin-private storage
   (`v1/audit-fallback/<instance>-<root-hash>.jsonl`) and — this is the part that matters — the
   **record and the page say so** instead of the host pretending. A silent fallback would be a log
   that exists, is incomplete, and looks complete.
3. **The reload does not restore access by itself.** The *handle* persists (N20's actual
   requirement: "a reload must not ask the user to find their folder again" — it does not), but the
   *permission* regresses to `prompt` and comes back only with a gesture, which is exactly the
   OPFS-vs-picked difference N20 names. So the check asserts the honest state machine: handle
   recovered from IndexedDB, no picker, no gesture, state queried and displayed, and any act
   refused by name.

## 2. The scope limit, stated plainly

**Headless Chromium cannot grant write permission on a real folder.** There is no CDP permission
type for it (`Browser.setPermission` rejects `fileSystemAccess`, `fileSystemWrite` and every
variant — the full enum is in the transcript above), and the request itself blocks without a UI.

So:

- **Driven on a real folder**: adoption by drop, the record's root kind, listing, reading real
  bytes, the containment refusal with its rule id, the audit fallback, the permission state
  machine, the handle-gone and root-unreachable failures, and the handle's survival across a
  reload with no re-pick and no gesture.
- **Not driven on a real folder**: writing into it, because the grant cannot exist in this profile.
  The handle-kind **write** path is instead driven through a handle with implicit permission — the
  origin's own directory handle — so the code path (resolve under a virtual root → decide → run the
  Wasm tool → write → observe → audit) is exercised for the handle root kind. `N20.6` in
  `tests/n20-picked-root.test.mjs` is that check, and its name says which handle it uses.

A browser whose grant *is* available (a person clicking "Allow") takes the same path with
`queryPermission → granted`; nothing in the code branches on "test" versus "real".

## 3. Where the build follows the spec, and where it had to say something

The acceptance criteria are `docs/04-e1-m0-build-spec.md` §8 — **ten** entries — and every one is a
test:

| §8 | Check | Where it is driven |
|---|---|---|
| 1 | Reopen after a reload, no gesture | `e1m0-browser.test.mjs` — create through the page's own form, `Page.reload`, read back, `userActivation.isActive === false` |
| 2 | Tier table both ways, both audited | `e1m0-browser.test.mjs` (+ the pure decision in `e1m0-core.test.mjs`) |
| 3 | Refusals named, allowed case in the same test | both files |
| 4 | `..` as a NAME refused, sibling accepted | both files |
| 5 | Import boundary: the asset module links, a `fetch`-importing module does not | `e1m0-browser.test.mjs` — the platform's own words, and the host's import surface asserted as exactly `{writeFile, note}` |
| 6 | Nothing renders as markup | `e1m0-browser.test.mjs` — DOM assertions on the real gallery |
| 7 | Bad input does not kill the host | `e1m0-browser.test.mjs` — schema, huge body, unknown kind, trapping module, unknown message |
| **8a** | **Root injection**: with a second storage adapter, every root-injection check above still passes | `e1m0-browser.test.mjs` — the whole list re-driven on a **handle** root (tier table both ways + audit rows, `..` vs sibling, bad input, the world agreeing the bytes exist) |
| **8b** | **Picked-root permission**, driven by a **person**, recorded here including whether a gesture was required | see §1's last row and the note below: measured (a gesture **is** required after a reload; the handle needs no re-pick), but no human has yet clicked Allow in this build |
| 9 | `core/` imports nothing outside itself (static, incl. type-only) | `e1m0-core.test.mjs` — comments stripped first, so the check does not read its own prose as code |
| 10 | Two roots write; merged by `(instance, seq)`; no claimed global order | `e1m0-browser.test.mjs` (two roots, two files, distinct sequence numbers) + `e1m0-core.test.mjs` (the merge ignores `at`) |

**8a exercised a real property.** The second adapter is not a mock: it is a `FileSystemDirectoryHandle`
root — the same shape a picked folder has — driven through a handle with implicit permission because
headless Chrome cannot grant write on a real folder. What it proves is what N18 asks for: *one core,
two roots*, the same tier table, resolver, audit and tool run for both.

**8b is the check a machine cannot finish.** `showDirectoryPicker()` opens a native dialog and
`requestPermission()` blocks with no UI, so the person's click is the one act this build cannot
perform. What is recorded instead, measured on a real folder adopted by drop:
`queryPermission({mode:"read"})` = `granted` → a read succeeds with no gesture; after `Page.reload`
the handle comes back from IndexedDB (**no re-pick**) and `queryPermission` = `prompt`, so a
gesture **is** required before anything is read or written. The missing half — a person clicking
Allow and then watching a write land in their own folder — is stated as missing rather than implied.

Places where the build had to decide something the spec left open — each is a hole the spec asked to
be told about (§7):

| Spec / design | What was built | Why |
|---|---|---|
| §6: `run(argsJson)` | `run(args_ptr, args_len)` over a **binary argument record** `[pathPtr, pathLen, bodyPtr, bodyLen]`, documented in `tools/create-asset.wat` | Parsing JSON inside Wasm is a JSON parser in WAT, which is not the 30-line module §6 promises. The host validates the schema, resolves the path and makes the tier decision; the module hands the bytes back through `writeFile`, which re-resolves and refuses anything but the path the host decided on. The enforcement is unchanged — it moved to where it belongs |
| §3: `outside-root` matches `insideRoot("v1/projects/atlas", …)` | rules take a `RuleContext { root }`, and `decide(act, root)` | The row that decides containment was a **constant**: a second project's writes were "outside the root" by construction. A rule that cannot see the root cannot decide about it |
| §4: `seq` per-instance | maintained per-instance **across roots** (`resumeFromEveryRoot`) | Resuming from one root restarts at 1 in the next, and the merged read then has two entries numbered 1 — an ambiguous order in exactly the place the log must answer "in what order" |
| §4: one audit entry per act | a tier-2 act writes **two**: the ask (`confirm`, `refused`, observed) and the answer | "Asked and not yet performed" is a real state, and a log that only records answers cannot answer "what was it about to do, and was it allowed" |
| §6: audit at `<root>/.audit/` | unchanged for OPFS; **origin-side fallback** for a picked root the page may read but not write, with `auditLocation` on the record and in the header | Measured: creating `.audit` in a `prompt` folder blocks. An act that cannot be recorded is still recorded — somewhere it can be — and the fact is visible |
| §2: `root` is a string; `durability` a boolean | main's tagged unions (`RootRef`, `Durability` with `permission`) are kept | `core/project.ts` on main was already corrected for N20 ("a record that cannot represent a case cannot support a claim about it"); the spec predates that fix, and `docs/README.md` §2 says the design wins and the disagreement is a finding |
| §1 layout (`core/`, `browser/`, `tools/`) | `core/schema.ts` added | Schema validation is pure, placement-independent, and needed by any host — the alternative was re-implementing it per placement, which is the N18 drift the spec's own check 8 exists to prevent |
| §7: not designed yet | untouched | spoken confirmations, eviction policy, the complete rule set, E2–E4, and the interface beyond the safety constraints are all still holes. Nothing here interprets them |
| — | `undoKind: written-file-list` is **recorded and shown**, but replaying the list is not built | M0's checks do not ask for a replay, and a half-built undo that silently does nothing is worse than a list that honestly says what it is |

## 4. Two structural details worth naming

- **The host serves its own sources.** `server.mjs` serves `core/`, `browser/` and `tools/` with
  Node's `stripTypeScriptTypes`, so the browser runs the same files the tests run and there is no
  build step and no second copy to drift from (N18, one level up). It is the local dev server; the
  route is an allowlist of four directory names and refuses everything else.
- **`data-e1m0="ready"`** on `<html>` is the page's own signal that the host API is installed — the
  checks wait on it rather than on a timer.

## 5. The explorer's three roots (bead `voicebox-beads-7cd`)

| View | Root | Authority shown | Gesture |
|---|---|---|---|
| origin storage | `v1/` — this origin's OPFS tree | "nothing outside this origin — not even the user's own editor" | never |
| the picked folder | `picked:<name>` — the user's real folder | "anything on this machine, and the user in their own editor" | may need one, and says so |
| the server | `workspace/` on the machine running the server | "anything on that machine"; the only one that survives the tab closing | never |

- **It says which root it is showing**, from the record, in the panel header — and the OPFS view is
  the origin tree rather than the open project's root, because for a picked project those are the
  same directory, and two panels showing one directory under two headings is precisely the "cannot
  tell what you are looking at" failure this view exists to prevent.
- **The failure modes are named and distinct**: `needs-gesture` (the state a real folder is in),
  `handle-gone` (this browser holds no handle for it), `root-unreachable` (the folder is gone,
  renamed or unmounted — with the platform's own words attached), plus `not-found` for a directory
  that is not there and `not-a-project` for a view with nothing behind it. Never "internal error".
- **One bounded listing per render**: one message, one directory iteration, no reads. `listChildren`
  stops at the limit and reports `truncated`; the host counts its own messages and reads, and check
  `7cd.4` asserts `messages +1, reads +0` for a 300-file directory showing 200.

## 6. What was verified, and by what evidence

- **`npm run test:e1m0`** — 27 checks, all driven, all green: 7 core/CLI (check 9 static; the tier
  table both ways; `..` as a name; schema by name; the audit merge; the committed `.wasm` against its
  `.wat`), 9 in the browser (checks 1–7, 9 and 8a), 7 for N20, 4 for the explorer.
- **The fourth permission state is pinned.** `denied` was distinct by inspection and untested until
  review said so: it is now driven with a **real platform answer** — a Chromium profile with File
  System Access blocked for the origin, which makes `queryPermission` answer `denied` exactly as a
  person's "Block" does (`tests/n20-permission-denied.test.mjs`). No object is constructed to fake
  the branch; the host branches on the platform's answer and nothing else.
- **An empty project and an absent project are distinguishable** — asserted as a pair in one test
  (`7cd.2`): a view with nothing behind it refuses by name (`not-a-project`), while a genuinely
  empty picked folder succeeds with **zero** entries and `truncated: false`. A change that collapsed
  the two would now fail.
- **`npm test`** — the repository's existing 11 checks still pass, including "page load with files
  produces zero POST /api/turn calls": the new page adds no turns.
- **Independent vision review** (gemini lane, on `/tmp/e1m0-opfs.png` and `/tmp/e1m0-picked.png`,
  with no code in front of it): confirmed the header, the three panels, the gallery and the
  transcript render; that the picked project's header reads "root kind: a picked folder —
  'field-notes'", "recovery: the handle is persisted in IndexedDB, so a reload does not re-pick;
  permission is prompt, and restoring it takes a click"; that the folder panel lists the real files
  with sizes; and that a "Restore write access" button appears.
- **The DOM checks are assertions, not impressions**: `<img src=x onerror=alert(1)>` as an asset
  name produces zero `[onerror]` elements, zero script elements in the gallery, the literal name as
  a text node, and one `img` — the SVG, through a `blob:` URL.

## 7. Traps this build hit, kept because they are the useful part

1. **The OPFS adapter ignored its own root.** Every project's files landed at the origin's top
   level; everything still passed, because the *virtual* paths agreed. It surfaced only when the
   registry and a project shared a listing. A storage adapter that walks from the wrong directory is
   invisible until two roots disagree — which is the same shape as the drift N18 exists to prevent.
2. **A closure does not survive stringification.** A test helper that closed over a variable looked
   like a page bug for three runs; `page.waitFor(fn, { args })` exists because the failure mode
   ("timed out; last value false") carries no error in it.
3. **A measurement that measures itself is wrong.** The first bounded-listing check counted the
   counter-read as work. Counting is now excluded from the count.
4. **An empty list is not an empty folder.** `listChildren` swallowed "cannot open this directory"
   into `[]`, so the explorer showed an empty panel for a directory that does not exist. Strict
   listing exists for the directories a person asked for.

## 8. The new checks, mutation-tested (red for the right reason)

A check that fails because a module will not load is not evidence about the guard. Each new check
was run against a throwaway worktree carrying one deliberate defect, and in every case the failure
is the assertion, with the wrong behaviour visible in the message:

| Mutation | Expected | Observed |
|---|---|---|
| `reachable()`'s `denied` branch answers like a missing gesture | `n20-permission-denied` red | red — *expected permission-denied, saw `{"code":"needs-gesture","why":"'blocked-folder' needs a click to restore access"}`* |
| a project with no picked root answers like an empty one | `explorer 7cd.2` red | red — on the pair, with the refusal assertion failing first |
| both root kinds share one virtual root | `e1m0-browser 8a` red | red — and **only** 8a: checks 1–7 and 9 stay green, which is the point of 8a existing |

The last row is the useful one: collapsing the two roots into one path is invisible to every check
that only ever touches the OPFS root, which is exactly what "the same checks pass on a second
adapter" is there to catch.
