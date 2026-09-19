// lib/live-session.mjs — the live-session seam: one vendor-agnostic session per connected page.
//
// The shape: page WS ⇄ THIS file (the host: the gate, the normalization, the lifecycle)
//                          ⇄ a provider (lib/live-providers/*) ⇄ a vendor that speaks its own protocol.
//
// WHY THE SEAM IS HERE AND NOT AT THE FRAME LEVEL. Gemini and OpenAI Realtime differ in session setup,
// event names and audio encodings; a seam drawn at "a websocket that takes these frames" would make the
// second provider a rewrite. So a provider supplies a SESSION (start / sendAudio / sendText / interrupt /
// close) and raises a fixed EVENT SET — and exactly one of those events is terminal for every cause, so a
// provider cannot invent a state the host does not understand.
//
// WHAT THE HOST GUARANTEES, because a gate implemented per provider is the drift this seam prevents:
//
//  1. THE READINESS GATE (isocan, 2026-09-12: 192 of 208 audio frames went up before `setupComplete` and
//     were silently dropped — the symptom read as a broken model or a broken mic). Audio received before
//     the provider says `ready` is NOT forwarded; it is counted and logged, never silently sent and never
//     silently dropped without a number. This lives in the WRAPPER below, so it applies to every provider.
//
//  2. THE TRUTHFUL STATE MACHINE. One terminal event, `closed`, for every cause — including a provider
//     that fails during its own handshake. `ready` never survives a close, so "disconnected" cannot read
//     as "listening".
//
//  3. NO HAND-ROLLED RESAMPLER. The page captures at 16 kHz and plays back at 24 kHz by creating
//     AudioContexts AT those rates (public/audio-client.js:19-20); the browser resamples. This layer
//     relays PCM16 unchanged, and carries the rate ON THE EVENT so a provider whose rates differ declares
//     them instead of requiring a second resampler.

import { createGeminiProvider } from "./live-providers/gemini.mjs";

const providers = {};

/**
 * Register a live provider. Mirrors the turn path (lib/resolver.mjs:14) on purpose: two seams of the same
 * shape are one idea, and a reader who has met one has met the other.
 *
 * @param {string} name
 * @param {(opts: { model?: string, emit: (event: object) => void, log: (line: string) => void }) => {
 *   start(): void | Promise<void>, sendAudio(pcm16: string): void, sendText?(text: string): void,
 *   interrupt?(): void, close(): void }} createProvider
 */
export function registerLiveProvider(name, createProvider) {
  providers[name] = createProvider;
}

/** The providers registered right now — so a document can be CHECKED against the code. */
export function availableLiveProviders() {
  return Object.keys(providers).sort();
}

/** Gemini Live, registered here so the default is a provider like any other. */
registerLiveProvider("gemini", createGeminiProvider);

/** The event set a provider may raise. Anything else is ignored, not guessed at. */
const EVENTS = new Set([
  "transport-open", // the vendor socket is up; nothing may be sent yet (see the gate)
  "ready",          // the provider's own handshake completed — the ONLY thing that opens the gate
  "output-audio",   // { pcm16, rate }
  "output-text",    // { text, kind }
  "interrupt",      // the vendor reported barge-in
  "turn-complete",
  "error",          // { message } — reported, not fatal
  "closed",         // { code, reason } — terminal, and the only terminal event
]);

/**
 * Create a live session. The provider is chosen by `provider`, else `LIVE_PROVIDER`, else "gemini".
 * Everything the page sees is the same object shape as before the seam.
 */
export function createLiveSession({ onAudioOut, onText, onState, log = console.error, provider, model } = {}) {
  const name = provider ?? process.env.LIVE_PROVIDER ?? "gemini";
  const create = providers[name];
  if (!create) {
    throw new Error(
      `no live provider registered for '${name}' — registered: ${availableLiveProviders().join(", ")}`,
    );
  }

  const state = {
    ready: false,       // the readiness gate: the provider said ready
    gatedFrames: 0,     // audio frames received BEFORE the gate opened (isocan's number)
    closed: false,
    provider: name,
  };

  // ── the host: the gate, the normalization, the lifecycle ──────────────────────────────────────────
  const emit = (event) => {
    if (!EVENTS.has(event.type)) {
      // An unknown event is a provider bug, and it costs an event — not the conversation.
      log(`[live-session] ignoring unknown provider event '${event.type}' from '${name}'`);
      return;
    }
    if (event.type === "ready") {
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

  const inner = create({ model, emit, log });
  // The provider's own handshake starts here, after the host has wired the gate ahead of it. A provider
  // may do this in its constructor (Gemini dials on construction) — start() is optional and idempotent.
  inner.start?.();

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
    /** A text turn from the page, if the provider accepts one. */
    sendText(text) {
      if (state.closed || !state.ready) return;
      inner.sendText?.(text);
    },
    /** Operator barge-in. */
    interrupt() {
      if (state.closed) return;
      inner.interrupt?.();
    },
    close() {
      if (state.closed) return;
      state.closed = true;
      state.ready = false;
      try { inner.close(); } catch { /* already gone */ }
    },
    get ready() { return state.ready; },
    get gatedFrames() { return state.gatedFrames; },
    get provider() { return state.provider; },
  };
}

/** The model id the default provider uses, re-exported for the docs check and the server's log line. */
export { GEMINI_LIVE_MODEL as LIVE_MODEL } from "./live-providers/gemini.mjs";
