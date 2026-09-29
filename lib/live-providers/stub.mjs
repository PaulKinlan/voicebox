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

/**
 * Scale one PCM16 base64 frame by `gain` — the stub's echo attenuation (voicebox-beads-ldxa).
 * Dependency-free and pure, and it clamps: a scaled sample must stay a valid PCM16 value rather than wrap
 * into noise. See sendAudio's comment for why the echo is attenuated at all.
 */
function echoThroughGain(pcm16Base64, gain) {
  const bytes = Buffer.from(pcm16Base64, "base64");
  const out = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const scaled = Math.round(bytes.readInt16LE(i) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i);
  }
  return out.toString("base64");
}

export function createStubProvider({ emit, log, readyAfterMs = 300, echoGain = 0.3 } = {}) {
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
      // Echo it back, so "audio flows after ready" is observable without a vendor — THROUGH THE ECHO GAIN.
      // A vendor's audio is not a bit-exact copy of the person's microphone, and a full-amplitude loopback
      // is exactly the pathological echo the page's barge-in guard must refuse (voicebox-beads-ldxa). The
      // gain models the realistic attenuation, so a test can drive a real session and still see a person
      // interrupt it. `received` above is untouched: what reached the "vendor" is the input, not the echo.
      emit({ type: "output-audio", pcm16: echoThroughGain(pcm16Base64, echoGain), rate: 24000 });
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
