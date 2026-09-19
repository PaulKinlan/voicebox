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

## What each outcome means
- **The walk follows the link** (the link resolves as a directory and lists the target's entries):
  containment for a picked folder needs a **resolve pass before each run**, exactly as the E2 substrate
  needed one when its `--allow-read` proved lexical (see `../substrate-20260919/RECEIPT.md`). §3.2a's
  row must then read "structured for OPFS, enforced for picked folders".
- **The walk does not follow** (`getDirectoryHandle` throws, or the link appears as a plain file):
  §3.2a's structural claim **transfers**, and this receipt closes with that as its result.
- **The picker fails**: the gesture was synthetic. Run it by hand.

## Result
_(empty — fill this in when it is run, including the browser and version._
