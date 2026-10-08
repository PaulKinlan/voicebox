# voicebox-beads-42ir — the environments page said a browser-stored root is read-only for turns

**Status:** fixed in `fleet/roboticon-v4v5` (`99cd0fa`), which is the branch the V4/V5 work lands from.
**Date:** 2026-10-08. **Found while:** implementing `voicebox-beads-um5r` (explain what setup does, why,
and the order), because an explanation cannot be true while the page says the opposite of what the code
does.

## The claim that was wrong

The page and its report lines said, in four places:

- `browser/ui/ui.ts` — *"the loop cannot write here yet — this project is in this browser's own storage,
  so only this page can act on it: the page lists and reads its files"*
- `browser/ui/ui.ts` — *"a picked folder or this origin's storage is readable and writable only by the
  page **until page-side writes land (voicebox-beads-2cf)**"* — and `voicebox-beads-2cf` no longer exists
  in the live database, so the sentence pointed at history that cannot be read
- `browser/ui/ui.ts` header fact — *"this page only — turns cannot write into this kind yet"*
- `public/environment.html` — *"A folder you pick in the browser stays read-only for turns for now"*, and
  the destination labels *"turns cannot write here yet"* / *"read-only for turns"*

## What the code actually does

A turn's file act against a page-owned root (browser storage or a picked folder) is **routed to the page
that owns the root, and the page performs it**. `core/dispatch.ts` is the router, `browser/acts.ts` is the
page-side executor (*"the environment page ANSWERS routed acts"*), and a declaration answers
`actsVia: "page"`. `browser/acts.ts`'s own header quotes Paul, 2026-09-20: *"page should be able to write."*
What differs by destination is **who performs the act and what it needs** — not whether a turn can write.

## Proof (real browser, on pristine `main` a816486, before any copy was touched)

`fleet-gate 42ir-proof -- node --test --test-concurrency=1 tests/page-writes.test.mjs tests/one-root.test.mjs`
— **exit 0**, 8 pass / 0 fail / 1 skipped (the live leg needs `GEMINI_API_KEY`; unrelated to this claim).
Log: `/tmp/roboticon-42ir-proof.log`.

| Check | What it proves |
|---|---|
| ✔ *an OPFS project: the turn writes through the page, reads back byte-for-byte, and the page is the audit's writer* | a **turn** writes into browser storage and the bytes read back — the claim is false |
| ✔ *a picked folder is declared the same way, and the loop's acts ROUTE to the page that owns it* | a picked folder is routed the same way, and its write is refused `needs-gesture` with the remedy named until the click |
| ✔ *the page closing answers page-closed or no-page — the absence family, never silence* | the limit that IS real: with no page connected the act is refused by name |
| ✔ *a root the connected page does not own is refused BY NAME — no-project or root-not-mine, never a hang* | routing never becomes a hang |
| ✔ *when the declared root vanishes, the page says so by name — with the remedy* | a vanished root is named, not silent |

Corroboration from another lane, independent of this repo's suite: miniapps' `dnwa` test
(`tests/environment-integrated-ui.test.mjs`) asserts a turn wrote `opfs-note.txt` into browser storage and
reads back `hello-from-opfs`.

## The fix

Copy only — **no behaviour change**, because the routing already worked.

The page, the guide, the destination labels and the report lines now say who performs the act. The limits
are kept deliberately, because they are the useful part:

- **browser storage** — performed by this page, so the page has to be **open and answering**; with nothing
  connected the act is refused, named `no-page`. No path, no host token.
- **a folder you pick** — the same routing, and it writes only after **"Restore write access"**; until then
  the act is refused, named `needs-gesture`.
- **a folder on this machine** — the one the **server** writes itself (path + host token), works with no
  page open, and the files are on disk where your own editor sees them.

## Tests corrected, with negative controls

The assertions that pinned the old sentences were not deleted but **corrected**, and they now also assert
that the disproved wording cannot come back:

- `tests/one-root.test.mjs` — no longer demands `/the loop cannot write here/` or `/voicebox-beads-2cf/`;
  asserts the accurate sentence, plus `doesNotMatch` on `cannot write here yet|read-only for turns|page-side writes land|voicebox-beads-2cf`.
- `tests/create-project-dialog.test.mjs` — asserts the corrected destination labels and the preserved
  limits, plus `doesNotMatch` on the disproved phrases.

## Honest limits of this evidence

- The live spoken leg of `tests/page-writes.test.mjs` **skipped** (no `GEMINI_API_KEY` in this environment),
  so the proof here is the HTTP/turn route with a real browser and real OPFS, not a model-driven turn.
- The picked-folder grant is proven by the routed-refusal check (`needs-gesture` naming the remedy), not by
  driving a human click through the file picker.
- This is the page's copy. The **main UI's** copy (`public/fused.js`, dnwa) already said "turns and edits
  save here", which is the correct one; the two surfaces agreed only after this fix.
