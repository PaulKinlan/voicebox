# One root, three kinds — the seam that stops the loop inventing one

**The gap (Paul, 2026-09-20, quoting the README back).** *"The workspace is a flat directory — no
project scaffolding, no shell. (The environment page below is where projects exist; the skeleton loop
above still writes loose files into `workspace/`.)"* He is right that it is structural rather than
cosmetic: **"projects exist" on one page while the loop scatters files on another is a demo standing
beside the product.** Two things meant "where the files are", each with its own path-building, and
neither could see the other.

**What is built.** The root became data both sides read (`core/root.ts`), with one containment entry
and a named refusal for the case where the acting placement cannot reach the root at all.

Branch `e1m0/one-root`. **47 checks green** (`npm run test:e1m0`, +9 for this), the repository's
existing 11 unchanged (`npm test`).

---

## 1. The seam, named

```ts
// core/root.ts
type RootDescriptor =
  | { kind: "opfs";    path: string }              // this origin's private storage
  | { kind: "handle";  id: string; label?: string } // a folder the user picked
  | { kind: "machine"; path: string };              // a folder a machine process can name

resolveInRoot(root, candidate)   // the ONE containment entry — delegates to core/paths.ts, which
                                 // refuses `..` at any depth and never normalises
reachableFrom(root, peer)        // may this placement act here? refuses "root-not-reachable-from-here"
descriptorOf(record)             // the project record → the descriptor, so a record can say its kind
```

`ROOT_FACTS` holds the per-kind facts as **data**, because they are what a placement must be able to
answer before it acts: where the files are, `whoCanSee`, which peers can **act**, the containment
mechanism, whether a gesture is needed, and whether the files outlive the tab.

| kind | acts come from | why |
|---|---|---|
| `opfs` | the **page** | a machine process has no path to origin storage and never will |
| `handle` | the **page** | a handle deliberately exposes no path, so nothing else can address it |
| `machine` | the **machine** | the page has no handle for it and no path of its own |

## 2. What each side does now

**The loop (`server.mjs`).** The active root is state (`GET`/`POST /api/root`). Every path goes
through `resolveInRoot` — so the lexical containment is the *same implementation* as everywhere else —
followed by the machine placement's realpath pass, because a lexical check follows a symlink out (the
design already recorded that defect). `write`, `read`, `list`, `GET /api/file`, `GET /api/files` and
`GET /api/audit` all follow the active root; nothing writes to a folder nobody declared.

**The loop is also a participant in the log**, not a stranger writing into someone's project: it keeps
its own file in the root's `.audit/` (one file per (root, writer), which is what "one file per root"
has always meant) and **its refusals are entries too** — a log of successes cannot answer *"what did
it try"*.

**The page.** It declares its root to the loop on open and on adopt (`POST /api/root`) — whichever
kind it is, so the loop learns it and learns *by name* when it cannot act there. The header states the
root kind and **who acts on it**, and the explorer's machine panel now shows the active root rather
than a folder of its own; when the active root belongs to the page, that panel refuses by name instead
of listing some other folder under a machine heading.

## 3. Driven, not described

| Check | What it drives |
|---|---|
| `root-seam.test.mjs` (7) | the default root is a machine root and its facts say `reachableFrom: ["machine"]`; a loop write lands inside it **and is logged** with `observed` bytes read from the world; declaring another machine root **moves the loop** and the old root gains nothing; `../escape.txt` refused at any depth **and** through a symlink out (the realpath pass), with no file outside; declaring an `opfs`/`handle` root → this process reports `reachableFromThisProcess: false`, the write and the listing both refuse with `root-not-reachable-from-here` and a why naming **the page**; bad declarations answer `path-missing` / `not-a-directory` / `unknown-root-kind` / `bad-request` and leave the active root alone |
| `one-root.test.mjs` (2, browser) | the page declares a machine root **through its own form** → the loop writes there → the page shows the file in the machine panel and refuses its **own** act with `root-not-reachable-from-here` (why names the machine) → the loop's `..` attempt is refused by the shared rule; a **picked folder** declared the same way → the loop refuses by name naming the page, and the page's write lands in the folder, with the user's own file still listed beside it, and containment refusing `..` |

**One honest limit, named:** the page cannot *write* into a real picked folder in a headless test —
a dropped folder answers `prompt` for write and the grant needs a click no script can make (measured,
in the picked-root receipt). So the page's write half is driven through a **handle root with implicit
permission** (same kind, same code path, same refusal from the loop), and the real folder is driven
for declaration, reading, listing, refusal and containment. Nothing branches on test versus real.

## 4. What the shape change broke, and what that taught

Three existing readers needed changing, and each one is a small lesson:

1. **The loop's refusal message changed** from *"path escapes the workspace"* to *"path escapes the
   active project root"* with `refused: "outside-root"` and the mechanism's own `why`. A hard-coded
   word becomes a lie the first time somebody declares a different folder. The repository's test was
   updated to assert the **rule id** and the mechanism's words, which is stronger than the substring
   it replaced.
2. **The explorer's machine panel had to learn to refuse.** With the listing following the active
   root, a picked-root project makes the machine panel answer `root-not-reachable-from-here` — the
   bead-7cd rule (never show a listing that cannot say what it is) arriving from a direction nobody
   had built for.
3. **Kind before reachability.** A view asked for the picked panel of a *machine-root* project must
   answer `not-a-project` ("this project's root is a folder on the machine"), not a permission
   failure — answering the second when the first is true sends the reader hunting for a permission
   problem that does not exist.

## 5. Independent vision check, and the lie it found

A vision review of the page (gemini lane, image only, no code) found the mechanism visibly working —
and **one genuine untruth**: the header showed `durability: held until the browser decides otherwise
(persisted() is false)` for a **machine root**. That is an OPFS leftover answering a question the
browser has no business asking about somebody's folder — precisely the "a record that cannot represent
a case cannot support a claim about it" failure N20 names, arriving this time in the *presentation*.

All three findings (the durability lie, a label/value collision, and a subtitle omitting the third
root kind) were fixed and the same reviewer re-read the image: **"NONE FOUND… every visible section is
coherent"**. A DOM assertion would never have caught the first one — the DOM contained exactly what
the string said; it was the *claim* that was wrong.
