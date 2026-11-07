// tests/lib/poll.mjs — ONE machine-speed deadline for the suites that wait on a RECORDED state.
//
// THIS MODULE IMPORTS NOTHING, ON PURPOSE (voicebox-beads-u32a). The shared task fixture lives in
// `tests/lib/task-fixture.mjs`, which imports `./server.mjs` — and `scripts/test-lanes.mjs` classifies a test file by
// what it imports, so importing THAT would move each of the four task suites from the unit lane into the live lane
// and out of `npm run test:unit` entirely. Measured: the change did exactly that, and `test-shards` caught it
// ("tasks-cancel.test.mjs is listed as isolated but is in neither the browser nor the unit lane"). A leaf module has
// no lane consequences.
//
// WHY A LONGER DEADLINE (voicebox-beads-i9k0, voicebox-beads-u32a). These suites wait for an audit record: the
// assertion is about what the record says, never about how long the executor took, so the deadline only bounds how
// long a genuinely broken run waits — and every second it is too short buys a false red. Measured on one gate:
// `task-redaction`'s partial-secret arm reported "condition did not occur" inside a 4s window whose FINAL read
// already showed state:"failed" with the redacted partial; the arm spent 15s in that window because a status read
// itself costs seconds on a loaded box. Running longer asserts exactly the same thing.
//
// Overridable for a slower box: `VOICEBOX_TASK_POLL_MS=60000 npm run test:unit`.
export const TASK_POLL_MS = Number(process.env.VOICEBOX_TASK_POLL_MS ?? 30_000);

export async function until(read, predicate, timeoutMs = TASK_POLL_MS) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition did not occur within ${timeoutMs}ms: ${JSON.stringify(read())}`);
}
