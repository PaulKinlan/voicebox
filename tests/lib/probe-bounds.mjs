// tests/lib/probe-bounds.mjs — the bounds a test-changed CLI probe runs under, and the diagnostic that names the
// bound that actually fired.
//
import assert from "node:assert/strict";

// ONE definition because tests/test-changed.test.mjs was split into tests/test-changed-cli.test.mjs (answer-only
// probes) and tests/test-changed-gate.test.mjs (the gate's own accounting and its two real dispatches)
// (voicebox-beads-afsx). The split moved the probes, not the lesson behind their bounds: a probe that times out
// must say which number killed it, so the bound is a parameter here rather than a constant each file re-declares.
//
// A CLI probe starts a fresh Node process and imports the whole selector roster: 8.3-14s measured on this
// 8-vCPU fleet VM under load, against the 8000ms bound these probes used to carry — so the bound fired on a
// slow HOST and the assertions reported it as "the CLI spawned something", which is a different claim
// (voicebox-beads-8ckj). What a probe must catch is a CLI that never returns, so the bound is generous,
// named, and used by EVERY probe; the marker/manifest assertions stay the behavioural test.
export const CLI_PROBE_BOUND_MS = 60_000;

// The batched answer-only probe pays ONE roster derivation (~25s measured under load) for ~17 invocations run
// in-process, so one Node startup is not its unit of cost and the single-answer bound is not its budget
// (voicebox-beads-afsx). Still a hang detector: it catches a CLI that never returns, not a slow host.
export const BATCHED_PROBE_BOUND_MS = 120_000;

// The gate-mode probes dispatch a real test file through the selector, so they carry their own, larger bound:
// that work is the gate's, not a CLI answer's, and the tier's own per-file timeout is what bounds it there.
export const GATE_PROBE_BOUND_MS = 300_000;

/**
 * A bound that fired is a slow host, not a behaviour; say which one it was — the one the probe actually ran
 * under (voicebox-beads-03w5). This used to name `CLI_PROBE_BOUND_MS` unconditionally, so the gate-mode probe,
 * which runs with the much larger `GATE_PROBE_BOUND_MS`, reported a timeout "against a 60000ms bound" when the
 * bound that killed it was 300000ms — a diagnostic that sends the reader to the wrong number.
 */
export function assertProbeTerminated(result, what, boundMs = CLI_PROBE_BOUND_MS) {
  const ran = typeof result.elapsedMs === "number" ? ` after ${result.elapsedMs}ms` : "";
  assert.equal(
    result.error,
    undefined,
    `${what} must terminate normally: it ${result.error ? `ended with ${result.error.code ?? result.error.message}${ran} against a ${boundMs}ms bound — that is the HOST, not the CLI` : "returned"}`,
  );
}
