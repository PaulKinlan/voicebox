# Harness inventory drive — 2026-09-21

Candidate: `feat/harness-discovery`, based on `984aad9`. Evidence describes only this
inventory slice; no model task or paid API was called. Independent review pending.

Real Chromium, owned ephemeral server, clean temporary browser profile:

1. Open voice page; click Harnesses.
2. Verify initial state is unchecked; screenshot `before.png`.
3. Click Check installed harnesses; await seven rows.
4. Compare every rendered name/state to `/api/harnesses`; assert Pi 0.85.1 and
   pi-acp metadata 0.0.33, and Pi's visible `absent-capability` refusal.
5. Capture `after.png`; emulate 390 × 844 mobile, assert no horizontal overflow;
   capture `mobile.png`.

Observed real versions: Pi 0.85.1, Claude Code 2.1.265, Codex CLI 0.153.4,
Gemini CLI 0.60.0, OpenCode 1.18.31. Aider not found in searched PATH.
Pi ACP metadata 0.0.33 exists; runnability is explicitly **unknown**, not measured by
this inventory. `observed.json` contains the exact response and timestamp.
This is version-command evidence, not proof of task completion or ACP compatibility.

Runnable regression: `node --test tests/harness-inventory.test.mjs` — 3/3 pass.
It additionally drives failed exit, non-executable file, unrecognized version,
deadline, missing command, invalid package identity, stale display after server
loss, and cache reuse. No failed case is hidden from the list.

Mutation, on this candidate's uncommitted implementation over base `984aad9`:

```python
p = Path('lib/harness-inventory.mjs')
s = p.read_text()
a = 'if (!match) return { ...row, why:'
b = 'if (!match) return { ...row, state: "present", why:'
assert s.count(a) == 1
p.write_text(s.replace(a, b))
```

Then `node --test tests/harness-inventory.test.mjs`: exit 1, 3 tests, **2 failed**,
1 passed (`mutant.log`). Both API and browser assertions reject a lying "present"
state for unrecognized output. Restore original file; same command: exit 0,
3/3 (`focused.log`). The mutation was not committed.

Not delivered: bridge, configured agents/default policy, voice catalogue tools,
fleet routing, real model tasks, sandbox changes, remote-machine discovery.
The authored gfg bead remains open for the configuration-dependent scope.
