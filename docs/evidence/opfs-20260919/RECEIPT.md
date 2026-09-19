# Receipt: does OPFS need a user gesture, and is persistence granted?

Date: 2026-09-19 · lane: ds-flash-2 · trigger: astra read `02-environment.md` as a consumer and
found a false promise: §1.8 told the interface to say *"Grant access to continue"* when a reopened
project needs a click for its handle. True of a **picked** directory (File System Access) and false
of **OPFS**, which is origin-private.

## Method
`loadtime.html`, served over `http://127.0.0.1`, calls `navigator.storage.getDirectory()` **at parse
time** — no click, no key, no devtools evaluation — then creates, writes and reads back a file, and
reports `navigator.userActivation` **as sampled at the moment of the call**. Running it in the
console instead would not have answered the question: an evaluation carries activation, and the
first attempt did exactly that (`isActive: true`), which is why the page does the work itself.

## Result
```
RESULT:{"getDirectory":"ok","readBack":"load-ok",
        "activationAtCall":{"isActive":false,"hasBeenActive":false}}
```
**OPFS needs no user gesture**, and the file survives a reload (it is read back from the same
origin-private directory on a later navigation).

And on durability, measured in the same origin:
```
persisted(): false        persist() -> false        estimate: usage 185 B, quota 10,737,418,425 B
```
**Persistence is a request the browser may decline**, which is why the durability state is required
rather than decorative — and why a peer project must be exportable.

## Consequences adopted
- §1.8's "Grant access to continue" applies **only** to a picked directory; a peer project has no
  permissions dance, and the document now says which is which.
- The project record stores the **OPFS-relative path** and re-resolves the handle at startup; no
  handle is persisted, and identity is **placement + location** because an OPFS path means nothing
  outside its origin.
- `durability.persisted` is recorded per open and shown.
