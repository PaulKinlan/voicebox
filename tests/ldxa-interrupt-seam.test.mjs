// tests/ldxa-interrupt-seam.test.mjs — what `{type:"interrupt"}` on /live relies on (voicebox-beads-ldxa).
//
// server.mjs answers a client interrupt frame with `session.interrupt()`. That line is one call, and what
// it MEANS is the session seam: the request reaches the provider, and the provider's own interrupt event
// comes back through `onState("interrupt")` — which is what /live forwards to the page, and what makes an
// interruption audible rather than merely stopping generation upstream. The key-free stub is the provider
// here, so this costs no vendor and no key. The page half of the same round trip is driven in a real
// browser by tests/ldxa-barge-in-browser.test.mjs.
//
//   node --test tests/ldxa-interrupt-seam.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createLiveSession, registerLiveProvider } from "../lib/live-session.mjs";
import { createStubProvider } from "../lib/live-providers/stub.mjs";

registerLiveProvider("ldxa-stub", (opts) => createStubProvider({ ...opts, readyAfterMs: 10 }));

async function until(check, label, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await check();
    if (r) return r;
    await sleep(10);
  }
  assert.fail(`no ${label} within ${ms}ms`);
}

test("interrupt reaches the provider and its own event returns as a state the page can act on", async () => {
  const states = [];
  const session = createLiveSession({
    provider: "ldxa-stub",
    onState: (name, meta) => states.push({ name, ...meta }),
    onAudioOut: () => {},
    log: () => {},
  });

  await until(() => states.some((s) => s.name === "ready"), "the provider's own ready");
  session.interrupt();
  const interrupt = await until(() => states.find((s) => s.name === "interrupt"), "the provider's interrupt event");

  assert.equal(interrupt.provider, "ldxa-stub", "the event must say which provider interrupted");
  assert.equal(states.some((s) => s.name === "closed"), false, "an interrupt is not a terminal event");
});

test("interrupt before the provider is ready is dropped by the session, never sent to a half-open provider", async () => {
  const states = [];
  const session = createLiveSession({
    provider: "ldxa-stub",
    onState: (name, meta) => states.push({ name, ...meta }),
    onAudioOut: () => {},
    log: () => {},
  });
  session.interrupt(); // before ready: the session's gate is the same one audio goes through
  await until(() => states.some((s) => s.name === "ready"), "the provider's own ready");
  await sleep(20);
  assert.equal(
    states.some((s) => s.name === "interrupt" && s.duringGate === true),
    false,
    "no interrupt may arrive from the provider before it was ready",
  );
  session.interrupt();
  await until(() => states.some((s) => s.name === "interrupt"), "the post-ready interrupt to be answered");
});
