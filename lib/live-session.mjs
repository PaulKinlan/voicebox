// lib/live-session.mjs — the live-session seam: one vendor-agnostic session per connected page.
//
// The shape: page WS ⇄ THIS file (the host: the gate, the transport, the lifecycle)
//                          ⇄ a provider (lib/live-providers/*) ⇄ a vendor that speaks its own protocol.
//
// WHY THE SEAM IS HERE AND NOT AT THE FRAME LEVEL. Gemini and OpenAI Realtime differ in session setup,
// event names and audio encodings; a seam drawn at "a websocket that takes these frames" would make the
// second provider a rewrite. So a provider supplies a SESSION (start / sendAudio / sendText / interrupt /
// close) and raises a fixed EVENT SET — and exactly one of those events is terminal for every cause.
//
// WHAT THE HOST GUARANTEES, in mechanisms rather than conventions:
//
//  1. THE READINESS GATE (isocan, 2026-09-12: 192 of 208 audio frames went up before `setupComplete` and
//     were silently dropped). Audio before the provider says `ready` is NOT forwarded; it is counted and
//     logged, never silently sent. And since the REVISE at 71c8187 it is enforced on BOTH sides of the
//     seam: the page's frames by `sendAudio` below, and the PROVIDER'S audio by the transport it is handed
//     (§ Transport). A provider no longer has to remember the gate — it cannot get past it.
//
//  2. THE TRANSPORT IS AN INTERFACE, NOT AN AMBIENT CAPABILITY. A provider is given something to send
//     through, rather than being free to dial out. This is "tools get interfaces, not authority" applied
//     one layer over. It is NOT a sandbox: a provider is in-process code and could still call the ambient
//     `WebSocket` itself. What it means, precisely: the normal path is mediated, and the mediated path is
//     the one the gate and the audit can see.
//
//  3. ONE TERMINAL EVENT FOR EVERY CAUSE. Including a provider whose handshake rejects — that path used to
//     leave the session believing it was alive (found by astra in review, voicebox-beads-xin). A late
//     `ready` after a terminal event is refused.
//
//  4. NO HAND-ROLLED RESAMPLER. The page captures at 16 kHz and plays back at 24 kHz by creating
//     AudioContexts AT those rates (public/audio-client.js:19-20); the browser resamples. This layer relays
//     PCM16 unchanged and carries the rate ON THE EVENT, so a provider whose rates differ declares them.

import { createGeminiProvider } from "./live-providers/gemini.mjs";

// A null-prototype map: `constructor`, `toString` and `__proto__` are not providers. Astra's review found
// that a plain object let the first two past the unknown-provider refusal and made `__proto__` throw an
// unnamed TypeError — the refusal has to hold for every key, or it is a spelling check rather than a gate.
const providers = Object.create(null);

/**
 * Register a live provider. Mirrors the turn path (lib/resolver.mjs:14) on purpose: two seams of the same
 * shape are one idea, and a reader who has met one has met the other.
 *
 * @param {string} name
 * @param {(opts: { model?: string, emit: (event: object) => void, log: (line: string) => void,
 *                 transport: Transport }) => Provider} createProvider
 */
export function registerLiveProvider(name, createProvider) {
  if (typeof name !== "string" || name === "") {
    throw new Error("registerLiveProvider: the name must be a non-empty string");
  }
  if (typeof createProvider !== "function") {
    throw new Error(`registerLiveProvider('${name}'): the factory must be a function`);
  }
  providers[name] = createProvider;
}

/** The providers registered right now — so a document can be CHECKED against the code. */
export function availableLiveProviders() {
  return Object.keys(providers).sort();
}

/** Gemini Live, registered here so the default is a provider like any other. */
registerLiveProvider("gemini", createGeminiProvider);

/** The event set a provider may raise. Anything else costs an event, not the conversation. */
const EVENTS = new Set([
  "transport-open", // the vendor socket is up; nothing may be sent yet (see the gate)
  "ready",          // the provider's own handshake completed — the ONLY thing that opens the gate
  "output-audio",   // { pcm16, rate }
  "output-text",    // { text, kind }
  "interrupt",
  "turn-complete",
  "error",          // { message } — reported, not fatal
  "closed",         // { code, reason } — terminal, and the only terminal event
]);

/**
 * The transport a provider is given. `connect` is the only way it reaches a vendor, and `send` is the only
 * way anything leaves — which is where the gate applies to the provider's own audio.
 */
function makeTransport(getReady, log) {
  let socket = null;
  let closed = false;
  const refused = { audioBeforeReady: 0, afterClose: 0 };
  return {
    refused,
    connect(url, { onOpen, onMessage, onClose, onError } = {}) {
      if (closed) return null;
      socket = new WebSocket(url); // the ONE construction site for a vendor socket
      socket.onopen = () => onOpen?.();
      socket.onmessage = (e) => onMessage?.(e);
      socket.onclose = (e) => { closed = true; onClose?.(e); };
      socket.onerror = (e) => onError?.(e);
      return socket;
    },
    /**
     * kind: "handshake" | "audio" | "text" | "control".
     * AUDIO BEFORE READY IS REFUSED HERE — the gate, enforced for the provider and not merely documented.
     */
    send(kind, payload) {
      if (closed || !socket) { refused.afterClose += 1; return false; }
      if (kind === "audio" && !getReady()) {
        refused.audioBeforeReady += 1;
        log(`[live-session] refused ${kind} from the provider before ready — the gate applies to both sides`);
        return false;
      }
      socket.send(payload);
      return true;
    },
    close() { closed = true; try { socket?.close(); } catch { /* already gone */ } },
    get connected() { return Boolean(socket) && !closed; },
  };
}

/**
 * Create a live session. The provider is chosen by `provider`, else `LIVE_PROVIDER`, else "gemini".
 * Everything the page sees is the same object shape as before the seam.
 */
export function createLiveSession({ onAudioOut, onText, onState, log = console.error, provider, model } = {}) {
  const name = provider ?? process.env.LIVE_PROVIDER ?? "gemini";
  if (!Object.hasOwn(providers, name)) {
    throw new Error(
      `no live provider registered for '${String(name)}' — registered: ${availableLiveProviders().join(", ")}`,
    );
  }

  const create = providers[name];

  const state = {
    ready: false,       // the readiness gate: the provider said ready
    gatedFrames: 0,     // audio frames received BEFORE the gate opened (isocan's number)
    closed: false,
    provider: name,
  };

  const emit = (event) => {
    // A null or non-object event costs an event, not the conversation (astra's finding 4).
    if (!event || typeof event !== "object") {
      log(`[live-session] ignoring a malformed provider event from '${name}': ${String(event)}`);
      return;
    }
    if (!EVENTS.has(event.type)) {
      log(`[live-session] ignoring unknown provider event '${event.type}' from '${name}'`);
      return;
    }
    if (event.type === "ready") {
      // A late ready after a terminal event is REFUSED, or a dead session reads as alive.
      if (state.ready || state.closed) return;
      state.ready = true;
      onState?.("ready", { gatedFrames: state.gatedFrames, provider: name });
      if (state.gatedFrames > 0) {
        log(
          `[live-session] readiness gate held ${state.gatedFrames} frame(s) before ready — not forwarded ` +
            `(that is the gate working, isocan 2026-09-12)`,
        );
      }
      return;
    }
    if (event.type === "closed") {
      state.closed = true;
      state.ready = false; // the truthful state machine: ready never survives a close
      onState?.("upstream-closed", { code: event.code, reason: event.reason, provider: name });
      return;
    }
    if (state.closed) return;
    if (event.type === "output-audio") {
      onAudioOut?.(Buffer.from(event.pcm16, "base64"), event.rate ? `audio/pcm;rate=${event.rate}` : "audio/pcm");
      return;
    }
    if (event.type === "output-text") { onText?.(event.text, event.kind ?? "model"); return; }
    if (event.type === "error") { onState?.("error", { ...event, provider: name }); return; }
    onState?.(event.type, { provider: name });
  };

  const transport = makeTransport(() => state.ready, log);
  const inner = create({ model, emit, log, transport });

  // The provider's handshake may reject. That is a cause, and every cause gets a terminal event —
  // otherwise the host believes a session is alive (astra's finding 2, voicebox-beads-xin).
  try {
    Promise.resolve(inner.start?.()).catch((err) => {
      if (state.closed) return;
      log(`[live-session] provider '${name}' failed to start: ${err?.message ?? err}`);
      emit({ type: "closed", code: 1011, reason: `provider failed to start: ${err?.message ?? err}` });
    });
  } catch (err) {
    emit({ type: "closed", code: 1011, reason: `provider threw on start: ${err?.message ?? err}` });
  }

  return {
    /** A PCM16 frame from the page. THE GATE APPLIES HERE, for every provider. */
    sendAudio(pcm16Base64) {
      if (state.closed) return;
      if (!state.ready) {
        state.gatedFrames += 1; // counted, logged at gate-open — never silently sent
        return;
      }
      inner.sendAudio(pcm16Base64);
    },
    sendText(text) {
      if (state.closed || !state.ready) return;
      inner.sendText?.(text);
    },
    interrupt() {
      if (state.closed) return;
      inner.interrupt?.();
    },
    close() {
      if (state.closed) return;
      state.closed = true;
      state.ready = false;
      try { inner.close(); } catch { /* already gone */ }
      transport.close();
    },
    get ready() { return state.ready; },
    get gatedFrames() { return state.gatedFrames; },
    get provider() { return state.provider; },
    /** For the receipt: what the transport refused, so "the gate is host-side" is a number, not a claim. */
    get refusedByTransport() { return { ...transport.refused }; },
  };
}

/** The model id the default provider uses, re-exported for the docs check and the server's log line. */
export { GEMINI_LIVE_MODEL as LIVE_MODEL } from "./live-providers/gemini.mjs";
