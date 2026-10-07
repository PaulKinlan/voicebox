# Factory delta report fixtures

These are **not** hand-written samples. Each file is the output of the factory's own delta
renderer, so the parser in `scripts/factory-triage.mjs` is measured against the real format rather
than against a test author's idea of it:

```
lib/findings.py:_render_delta_report(target_name, findings, stats, fixed_items, *, step_summary=False, ...)
```

One file per station, named `<target>-<agent>-delta.md` exactly as the file sink writes it. The
findings inside are synthetic and carry only obviously fake values (`CANARY-fixture-…`); the
credential **shapes** the masking recognises are built at runtime inside
`tests/factory-triage.test.mjs`, so no realistic-looking token is committed here.

## Regenerating

From a checkout of the factory (this box: `/home/exedev/agents`) at commit
`d07cc9079e84b94e53cf28644362dcee573a3c68`, call the renderer with synthetic findings and write the
result into this directory, one file per station. The reduced fixture
(`voicebox-vuln-discovery-delta.md`) is the same renderer with `step_summary=True`; it exists
because that form carries no `Fingerprint:` line and names the rule in the heading, which the
parser must handle without inventing an identity.

Why regenerate at all: if the factory changes the report format, these fixtures should be replaced
by new renderer output rather than by edits that make the tests agree with the change.
