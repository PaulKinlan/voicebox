// lib/live-providers/stub.mjs — a provider that is deliberately NOT Gemini, for falsifying the seam.
//
// WHAT IT IS FOR. The claim under test is "a provider can be swapped, and the host's guarantees still
// hold". This provider has **no readiness gate of its own**: it opens, waits, and only then says `ready`.
// If audio is held and counted across that window, the gate is demonstrably HOST-SIDE — because there is
// nothing here to do the holding. That is the whole experiment, and it needs no API key and no network.
//
// It also models its vendor honestly, which produces two facts the design note got too simple:
//
//  * A MALFORMED FRAME IS THE PROVIDER'S BUSINESS. This provider parses frames from its own upstream; the
//    bad one below is dropped here, not by the host. The host's cousin rule is for unknown EVENTS. So the
//    "one malformed frame costs a frame" property SPLITS across the seam, and a second provider has to
//    implement its half. Named here rather than assumed away.
//
//  * READY IS THE PROVIDER'S TO EARN. Nothing else opens the gate; the host will not guess.
//
// Deterministic and dependency-free: no socket, no key, no timers that need the network.

export function createStubProvider({ emit, log, readyAfterMs = 300 } = {}) {
  let closed = false;
  let timer = null;
  const frames = [];

  // A frame that will not parse, dropped by the same rule the real provider uses — see the note above.
  const inbound = [
    "{ this is not json",
    '{"event":"stub.ready"}',
  ];

  const parse = (raw) => {
    try { return JSON.parse(raw); } catch { return null; }
  };

  const start = () => {
    emit({ type: "transport-open" });
    for (const raw of inbound) {
      const msg = parse(raw);
      if (!msg) { log("[live-provider:stub] dropped one unparseable frame (and kept going)"); continue; }
      if (msg.event === "stub.ready" && !closed) {
        // The gate window: everything the host forwards before this line must have been held.
        timer = setTimeout(() => {
          if (closed) return;
          emit({ type: "ready" });
        }, readyAfterMs);
        if (timer?.unref) timer.unref(); // never keep a test process alive
      }
    }
  };


  return {
    start,
    sendAudio(pcm16Base64) {
      if (closed) return;
      frames.push(pcm16Base64);
      // Echo it back, so "audio flows after ready" is observable without a vendor.
      emit({ type: "output-audio", pcm16: pcm16Base64, rate: 24000 });
    },
    sendText(text) {
      if (closed) return;
      emit({ type: "output-text", text: `stub: ${text}`, kind: "model" });
    },
    interrupt() {
      if (closed) return;
      emit({ type: "interrupt" });
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      emit({ type: "closed", code: 1000, reason: "stub closed by the host" });
    },
    /** For the test: what actually reached the "vendor". */
    get received() { return [...frames]; },
  };
}
