# Receipt: does a File System Access handle walk follow a symlink out of a picked folder?

**Status: OPEN — this has not been run.** It cannot be run headlessly: `showDirectoryPicker()` requires
a real user gesture, and a synthetic click is not one. So it is an experiment a person runs once, and
`index.html` beside this file is the instrument.

## Why it matters
The browser placement's strongest security property is not that containment is *enforced* but that an
escape cannot be **expressed**: handles are relative, `..` does not resolve, and OPFS has **no
symlinks** — so §3.2a's containment row is structural rather than implemented. **That property belongs
to OPFS, not to browsers.** A directory the user picked is a **real folder**, a real folder can contain
a symlink, and the guarantee is simply not there. Until this is run, the picked-handle shape is
**designed rather than proven**.

## Method
`index.html` (read-only: it writes nothing, sends nothing, makes no network calls) over
`http://127.0.0.1`. The fixture is a folder containing `inside/real.txt` and `outside-link -> /etc`.

## What each outcome means — and what it does NOT

**Scope, because a reviewer was right that the first version of this conclusion was broader than the
experiment.** The instrument measures, on one browser and one folder: a **directory** symlink read, a
**file** symlink read, and (opt-in) **a write through the link**. A negative result on those probes does
**not** establish containment, and does not cover other handle operations. Every probe reports its own
verdict, and `INCONCLUSIVE` is one of them.

- **The directory link FOLLOWS** (it resolves as a directory and lists the target's entries): a picked
  root needs a **resolve pass before each run**, exactly as the E2 substrate did when its `--allow-read`
  proved lexical (see `../substrate-20260919/RECEIPT.md`). §3.2a's row must then read "structural for
  OPFS, enforced for picked folders".
- **The directory link does not follow**: that is evidence **for that probe**. The claim that a picked
  root keeps §3.2a's structural property needs the **file** and **write** probes too, because a symlink
  to an outside file and a write through a followed link are different questions with different answers
  — and the write path is the one N20's reuse actually depends on.
- **Any INCONCLUSIVE line** (permission, security/gesture, unsupported, or an unclassified error): the
  question is **unanswered**, not answered negatively. The first version of this instrument collapsed
  every exception to "not followed", which turned a permission denial into a negative result; the
  cause classifier now separates them, and the picker's catch-all no longer reports an unsupported API
  or a cancelled dialog as a synthetic-gesture failure.
- **The picker fails**: read the classifier's line. `AbortError` is a cancellation, `NotAllowedError` is
  a refused gesture, and *"not a function"* is an unsupported browser — three different facts that used
  to arrive as one.

## Result
_(empty — fill this in when it is run, including the browser and version._
