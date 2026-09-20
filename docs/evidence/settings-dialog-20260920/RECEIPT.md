# Settings are a real modal dialog

**Paul's defect, verbatim**: he *likes where the settings button is* — it stays exactly where it was —
but clicking it *"just pops over down"* and makes him scroll to it, and on a phone he expects **a modal
dialog box that is dismissible and cancelable, with the background frosted out**.

**The cause was structural, not cosmetic**: the panel was a `<div>` in the document flow, so opening it
displaced everything below it. On a phone it landed under the fold — you had to scroll to the thing you
had just opened.

Branch `e1m0/settings-dialog`. **136 checks green** (`npm test`, whole glob — the new suite is 8 of
them), tree clean after the run.

---

## 1. Read the platform first, then used it

The `modern-web-guidance` skill was consulted before writing anything (it is explicitly triggered by
"modals, dialogs, backdrop-filter, mobile viewport units"; guides retrieved:
`light-dismiss-a-dialog`, `platform-controls-dismiss-dialog`, `html`). What it changed:

| Guide says | What is in the code |
|---|---|
| **MANDATORY**: open modals with `showModal()` | `showModal()` — which is where modality, the top layer, focus trapping, background inertness and Esc-to-cancel all come from |
| **MANDATORY**: `closedby="any"` for declarative light dismiss | on the element — no listener, no state |
| **MANDATORY fallback** where `closedby` is unsupported (not in Safari yet) | the documented geometry check, guarded by `"closedBy" in HTMLDialogElement.prototype` — the click's target is the dialog **only** on the backdrop, and the coordinates separate the backdrop from the dialog's own padding |
| `<form method="dialog">` to dismiss without handlers | the close button is `type="submit"` inside one; the page has no close handler, only a `close` listener that keeps the trigger honest |
| `::backdrop` for the modal background | `background: color-mix(...)` + `backdrop-filter: blur(10px) saturate(120%)`, with an `@supports not (backdrop-filter: …)` branch that becomes a **solid scrim** — where there is no blur, the frosting would be a lie |
| `dvh`, not `vh`, for mobile | `max-height: 85vh` then `max-height: 85dvh`; the **form** scrolls inside the dialog with `overscroll-behavior: contain`; `env(safe-area-inset-bottom)` padding, and `viewport-fit=cover` on the meta viewport so the inset exists |

**The skill is four months out of date** (`2026_05_16-c5e78707` installed, `2026_09_04-7de96777`
published) and says so itself, loudly, on every invocation. Flagged rather than silently worked around.

## 2. What changed (a container, not a rewrite)

- `public/index.html`: the flow `<div role="dialog" aria-modal="false">` becomes
  `<dialog id="settings" closedby="any">` wrapping a `<form method="dialog">`. The old markup *claimed*
  dialog semantics with `aria-modal="false"` — an ARIA statement that it was not modal. The gear button
  is untouched: same element, same place, same icon, same `aria-haspopup`/`aria-expanded`/`aria-controls`.
- `public/fused.js`: the `hidden` toggle becomes `showModal()`, plus a `close` listener (every close
  path — submit, Esc, light dismiss, programmatic — arrives there) and the documented fallback.
- `public/style.css`: out-of-flow geometry, the frosted `::backdrop`, the solid fallback, and
  `html:has(dialog.settings[open]) { overflow: hidden }` — the scroll half of modality, declarative, with
  nothing to unlock.
- `tests/settings-dialog.test.mjs` (new, 8 checks) and three small driver helpers (`press`, `clickAt`,
  `wheel`, `emulateViewport`, `screenshot`) in `tests/lib/cdp.mjs`.

## 3. Driven, and judged by eye

| Check | What it asserts |
|---|---|
| it is a modal, over the page rather than in it | `dialog.matches(':modal')` is true, computed `position: fixed`, focus inside — **and the composer's `offsetTop` and the page's `scrollHeight` are unchanged**, which is the specific complaint (it used to push the page down) |
| the gear keeps its place | still inside `.voice-actions`, still carrying its gear icon, still visible |
| the backdrop is frosted | computed `::backdrop` carries `blur(10px) saturate(1.2)`; the `@supports not` branch is asserted as a **declaration** (solid background, no `backdrop-filter`) rather than by matching the rule text, whose *condition* contains the word `blur(` |
| Esc cancels, focus returns | a real `Escape` key press closes it and focus lands back on `#settings-open` |
| click outside dismisses | a real mouse click at (8, 8) — the backdrop, never the dialog — closes it and returns focus. The mechanism used is **printed**: `native closedby` here, the fallback elsewhere |
| focus is trapped | an element behind the modal **cannot take focus** (the property a person experiences), and 12 Tabs never land on another page element; passing through `body` is the browser's "focus went to the chrome", which is allowed |
| the page behind does not scroll | `html` is `overflow: hidden`, and a real **wheel gesture** moves the page by 0px — measured before/after, because earlier checks legitimately scrolled. After close, the wheel works again |
| it fits a phone | at 390×844 the dialog is fully inside the viewport, ≤86% of its height, no horizontal overflow, and a 200vh payload added to the form **scrolls inside it** (`scrollTop` moves, the dialog does not grow) with `overscroll-behavior: contain` |
| the rows still tell the truth | both device rows still carry their three facts (heading, picker, state) inside the dialog, and a seeded **absent** microphone — the "unplugged" case the rows exist for — is still named by the page's own render path |

**Judged by eye, independently** (gemini lane, images only, no code): the panel *"is rendered as a
floating, centered dialog card directly in the middle of the viewport… completely out of page flow"*;
the backdrop is *"visibly dimmed and frosted… underlying page elements are visible as soft, blurred
shapes through the frosted glass"*; on the phone it *"fits comfortably inside the screen with generous
margins on all four sides… zero clipping… the ✕ close button is clear and tappable"*; and *"zero
stylesheet or alignment glitches"*.

## 4. Two harness bugs this check found, and one assertion about `overflow`

Kept because they are the reusable part:

1. **`page.click` scrolls the element into view before clicking** (it must, to click at real
   coordinates), so a viewport rect measured "before" and "after" measures the harness, not the page.
   The no-push check uses **layout** position (`offsetTop`) instead.
2. **`document.activeElement?.id ?? tagName` returns `""`** for an element with an empty `id` — `??`
   does not fall back on an empty string, so the first version reported "escaped the dialog to ''".
3. **`overflow: hidden` on the root stops the *user*, not the script.** `window.scrollBy` still moves
   an `overflow: hidden` document (that is the documented difference from `overflow: clip`). So the
   scroll lock is asserted with a **real wheel gesture**, and the `html` overflow is asserted separately
   as the mechanism. A programmatic scroll while a modal is open is not a defect a person can hit.
