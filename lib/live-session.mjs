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

import { createGeminiProvider, GEMINI_REQUIRED_INPUT_RATE } from "./live-providers/gemini.mjs";
import { createOpenAIProvider, OPENAI_REQUIRED_INPUT_RATE } from "./live-providers/openai.mjs";

// A null-prototype map: `constructor`, `toString` and `__proto__` are not providers. Astra's review found
// that a plain object let the first two past the unknown-provider refusal and made `__proto__` throw an
// unnamed TypeError — the refusal has to hold for every key, or it is a spelling check rather than a gate.
const providers = Object.create(null);

// WHETHER THIS RUNTIME'S WebSocket CARRIES CONNECTION HEADERS IS PROBED, NOT INFERRED.
//
// This file used to answer the question with `typeof Deno !== "undefined"` — a check on the RUNTIME, read as a
// check on a CAPABILITY. astra drove the unmodified global on Node v24.21.0 against an owned loopback upgrade
// server and the server RECEIVED the Authorization header, along with Origin and Cookie, plus real frames: so
// the old check refused OpenAI authentication for a reason that was not true on the machine the fleet runs.
// The correction is the same shape as the rest of this seam: the DIAL is the feature test (below), and the
// refusal names what was probed and quotes the constructor's own error.

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
/**
 * WHAT INPUT RATE THIS PROVIDER'S PROTOCOL REQUIRES — asked of the provider, so the page can be told what to
 * capture at. The number is declared next to the protocol that needs it, not in the shared path: Gemini takes
 * 16 kHz, OpenAI takes 24 kHz, and the host's job is to hand the right one to the microphone.
 */
const REQUIRED_INPUT_RATES = Object.create(null);
REQUIRED_INPUT_RATES.gemini = GEMINI_REQUIRED_INPUT_RATE;
REQUIRED_INPUT_RATES.openai = OPENAI_REQUIRED_INPUT_RATE;

/**
 * WHICH PROVIDER THIS PROCESS WILL USE — the same resolution `createLiveSession` performs, so a caller can
 * ask about it (its required input rate, say) without duplicating the rule and drifting from it.
 */
export function resolvedLiveProviderName(explicit) {
  // THE ONE RULE, used by createLiveSession and by anyone asking the same question. (I first wrote this
  // function from memory and invented a constant that does not exist — the fix is to READ the rule and
  // factor it, not to restate it.)
  // The live transport's fallback, and NOT the turn resolver (`VOICEBOX_RESOLVER`, server.mjs): one
  // picks which live provider carries the audio, the other which brain answers POST /api/turn. The old
  // name `LIVE_PROVIDER` is still honoured so an existing shell keeps working; the new one says which
  // half of the system it belongs to.
  return explicit ?? process.env.VOICEBOX_LIVE_PROVIDER ?? process.env.LIVE_PROVIDER ?? "gemini";
}

export function inputRateRequiredBy(provider) {
  const rate = REQUIRED_INPUT_RATES[provider];
  if (!Number.isFinite(rate)) {
    throw new Error(
      `inputRateRequiredBy('${provider}'): this provider has not declared the input rate its protocol ` +
        `requires. Declaring it is what lets the page capture at the right rate instead of being told one ` +
        `rate and sending another (journal-6g0).`,
    );
  }
  return rate;
}

export function availableLiveProviders() {
  return Object.keys(providers).sort();
}

/** Gemini Live, registered here so the default is a provider like any other. */
registerLiveProvider("gemini", createGeminiProvider);

/**
 * OpenAI Realtime — THE SECOND PROVIDER, and the reason the seam exists. Writing it is what found the one
 * place the facade pinched: it needs an `Authorization` header, the facade passed only a URL, and Node's
 * global `WebSocket` accepts no headers. `connect` takes `{ headers }` now, and the transport below FAILS
 * LOUDLY when headers are requested and the runtime cannot carry them — because a provider that quietly
 * connected unauthenticated would produce a mystery 401 three layers from the cause.
 */
registerLiveProvider("openai", createOpenAIProvider);

/** The event set a provider may raise. Anything else costs an event, not the conversation. */
const EVENTS = new Set([
  "transport-open", // the vendor socket is up; nothing may be sent yet (see the gate)
  "ready",          // the provider's own handshake completed — the ONLY thing that opens the gate
  "output-audio",   // { pcm16, rate }
  "output-text",    // { text, kind }
  "tool-call",      // { calls: [{ id, name, args }] } — the model asking for a verb (lib/commands.mjs)
  "interrupt",
  "turn-complete",
  "error",          // { message } — reported, not fatal
  "closed",         // { code, reason } — terminal, and the only terminal event
]);

/**
 * The transport a provider is given: A FACADE, NOT A SOCKET.
 *
 * The first version of this handed back the raw `WebSocket` from `connect()`, and astra's re-review showed
 * what that cost: a provider using ONLY the interface it was handed could call `returned.send(audio)` and
 * reach the vendor with `refused.audioBeforeReady === 0` — while the "one constructor in the tree" grep
 * stayed green, because the socket was reached through the object the host had just handed over. A guard
 * that is documented but walkable is worse than no guard, because the interface implies it holds.
 *
 * So: `connect()` returns nothing a provider can send with, and events arrive as DATA — `{ kind, data }`,
 * never the raw event, so `event.target` is not reachable either. A provider can still open its own socket;
 * that is the honest residual, and it lives in the interface comment rather than in a test title.
 *
 *   AND A SECOND ONE, WHICH IS THE SAME ADMISSION ONE STEP IN: the host trusts the provider's account of
 *   itself. `send("audio", …)` is refused before `ready`, but a provider that reports `ready` early, or
 *   that calls its own audio "handshake", is BELIEVED — the guard checks the kind it is told and the state
 *   the provider set. That is not a hole the seam can close: an in-process provider's honesty is not
 *   checkable from inside the process. The boundary the host owns is enforced; the provider's account of
 *   itself is trusted, and both halves of that sentence belong to whoever reads this interface next.
 */
function makeTransport(getReady, log) {
  let socket = null;
  let closed = false;
  const refused = { audioBeforeReady: 0, afterClose: 0 };
  let handlers = {};
  const deliver = (event) => {
    try { handlers.onEvent?.(event); } catch (err) { log(`[live-session] the provider's event handler threw: ${err?.message ?? err}`); }
  };
  return {
    refused,
    /** Connect to a vendor. Returns a BOOLEAN, never the socket: there is nothing here to send with. */
    connect(url, next = {}) {
      if (closed || socket) return false;
      handlers = next;
      // `headers` was added when the SECOND provider arrived (OpenAI Realtime authenticates with
      // `Authorization: Bearer …`; Gemini's key rides in the query string, which is why one provider hid this).
      // The dial below IS the feature test — a runtime that will not carry headers throws here, at the cause,
      // with the constructor's own words. WHAT IT CANNOT DETECT, stated rather than implied: a runtime that
      // accepts the option and then forgets it. That failure is the provider's handshake timing out, and it is
      // the same limit this seam already names — the provider's account of itself is trusted.
      try {
        socket = new WebSocket(url, next.headers ? { headers: next.headers } : undefined); // the ONE construction site for a vendor socket
      } catch (e) {
        // THE REFUSAL MUST BE TRUE. This catch is unconditional — the constructor throws for a malformed URL or
        // a bad protocol as well as for options it will not accept — so it may only claim headers were the
        // problem when headers were actually requested. An earlier version said "this provider asked for
        // connection headers" for a header-free invalid URL: a misleading reason, which is the one thing a
        // refusal must never be.
        const wanted = next.headers && Object.keys(next.headers).length > 0;
        throw new Error(
          wanted
            ? `live transport: this provider asked for connection headers, and the real dial with those ` +
                `headers attached was REFUSED by this runtime — the probe is the dial itself, not a guess ` +
                `about the runtime. WebSocket constructor said: ${e?.message ?? String(e)}`
            : `live transport: the dial was refused by this runtime and this provider requested no connection ` +
                `headers, so the cause is the URL or the runtime itself. WebSocket constructor said: ` +
                `${e?.message ?? String(e)}`,
        );
      }
      socket.onopen = () => deliver({ kind: "open" });
      socket.onmessage = (e) => deliver({ kind: "message", data: e?.data });
      socket.onclose = (e) => { closed = true; deliver({ kind: "close", code: e?.code, reason: e?.reason }); };
      socket.onerror = (e) => deliver({ kind: "error", message: e?.message ?? "upstream websocket error" });
      return true;
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
export function createLiveSession({ onAudioOut, onText, onState, onToolCall, onDebug, log = console.error, provider, model, tools, systemInstruction, instruction, voice } = {}) {
  const debug = (event) => { try { onDebug?.(event); } catch { /* diagnostics cannot break a session */ } };
  const name = resolvedLiveProviderName(provider);
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
      // "Exactly one terminal event for every cause" cuts BOTH ways: never zero, and never two.
      if (state.closed) return;
      terminate(event.code, event.reason);
      return;
    }
    if (event.type === "tool-call") {
      for (const call of event.calls ?? []) {
        debug({ type: "tool.request", callId: call.id, name: call.name, args: call.args });
        if (state.closed || !state.ready) debug({ type: "tool.dropped", callId: call.id, name: call.name,
          severity: "error", reason: state.closed ? "session-closed" : "session-not-ready", delivery: "not-sent" });
      }
    }
    if (state.closed) return;
    if (event.type === "output-audio") {
      onAudioOut?.(Buffer.from(event.pcm16, "base64"), event.rate ? `audio/pcm;rate=${event.rate}` : "audio/pcm");
      return;
    }
    if (event.type === "output-text") { onText?.(event.text, event.kind ?? "model"); return; }
    // The model asked for a verb. The host routes the call to the callback and
    // does NOT answer it itself — the answer is sendToolResponse below, after
    // the caller's executor has run. An unanswered tool call leaves the model
    // waiting, so the callback's contract is: always answer, even a refusal.
    // The model asked for a verb. THE GATE APPLIES HERE TOO: a tool call routed before
    // ready would have its SIDE EFFECT and then sendToolResponse would refuse — the act
    // happened and the model never heard (astra's live-tools review, 2026-09-20). An act
    // the session cannot answer is an act the session must not start, so an early
    // tool-call is refused with a named log, not routed.
    if (event.type === "tool-call") {
      if (!state.ready) {
        log(`[live-session] a tool-call arrived before ready — NOT routed (an act that cannot be answered must not start; ${event.calls?.length ?? 0} call(s) dropped by name)`);
        return;
      }
      onToolCall?.(event.calls);
      return;
    }
    if (event.type === "error") { onState?.("error", { ...event, provider: name }); return; }
    onState?.(event.type, { provider: name });
  };

  const transport = makeTransport(() => state.ready, log);

  /**
   * The single place a terminal state is entered: mark it, close the transport, notify ONCE.
   *
   * A FUNCTION DECLARATION, deliberately: it is hoisted, so it exists before `create()` runs. As a `const`
   * it did not, and a provider emitting `closed` from its FACTORY threw "Cannot access 'terminate' before
   * initialization" — the parent produced exactly one 1008 event, the new cut none and an exception. The
   * ordering that matters is "a terminal can always be reported", not "the happy path never gets here first".
   */
  function terminate(code, reason) {
    if (state.closed) return;
    state.closed = true;
    state.ready = false;
    transport.close();
    onState?.("upstream-closed", { code, reason, provider: name });
  }

  let inner;
  let innerClosed = false;
  try {
    inner = create({ model, emit, log, transport, tools, systemInstruction, instruction, voice });
  } catch (err) {
    // Every path that acquires a transport and does not return a session must close it.
    transport.close();
    log(`[live-session] provider '${name}' threw while being created: ${err?.message ?? err}`);
    throw err;
  }


  // The provider's handshake may reject. That is a cause, and every cause gets a terminal event — and,
  // since the re-review, it also CLOSES THE TRANSPORT: the first version marked the state closed while
  // leaving the socket open, so a control send still succeeded after the terminal state.
  try {
    Promise.resolve(inner.start?.()).catch((err) => {
      log(`[live-session] provider '${name}' failed to start: ${err?.message ?? err}`);
      terminate(1011, `provider failed to start: ${err?.message ?? err}`);
    });
  } catch (err) {
    terminate(1011, `provider threw on start: ${err?.message ?? err}`);
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
      debug({ type: "text.request", text, route: state.closed || !state.ready ? "dropped" : "provider", severity: state.closed || !state.ready ? "error" : "info" });
      if (state.closed || !state.ready) return;
      inner.sendText?.(text);
    },
    interrupt() {
      if (state.closed) return;
      inner.interrupt?.();
    },
    /**
     * Answer the model's tool call after the executor has run. Same gate as
     * text: the session must be open and ready. Returns false rather than
     * throwing when the answer cannot be sent — the caller logs that fact.
     */
    sendToolResponse(responses) {
      const refused = (reason) => {
        for (const response of responses) debug({ type: "tool.delivery", callId: response.id, name: response.name,
          delivery: "not-sent", severity: "error", reason });
        return false;
      };
      if (state.closed || !state.ready) return refused(state.closed ? "session-closed" : "session-not-ready");
      if (typeof inner.sendToolResponse !== "function") {
        log(`[live-session] provider '${name}' cannot answer a tool call — a model left waiting reads as a hang`);
        return refused("provider-cannot-answer-tool-call");
      }
      try { return inner.sendToolResponse(responses); }
      catch (error) {
        for (const response of responses) debug({ type: "tool.delivery", callId: response.id, name: response.name,
          delivery: "unknown", severity: "error", error: error?.message ?? String(error) });
        log(`[live-session] tool response send threw: ${error?.message ?? error}`);
        return false;
      }
    },
    /** Idempotent: calling it twice is safe, and it never returns early without tidying up. */
    close() {
      try { if (!innerClosed) { innerClosed = true; inner.close(); } } catch (err) {
        // A provider whose close() throws is still a cause, and it still gets its terminal event.
        log(`[live-session] provider '${name}' threw on close: ${err?.message ?? err}`);
        terminate(1011, `provider threw on close: ${err?.message ?? err}`);
        return;
      }
      terminate(1000, "closed by the host");
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
