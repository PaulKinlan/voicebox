// public/relay-body.mjs — the ONE body policy for the mini-app fetch relay (voicebox-beads-182c).
//
// THE DEFECT. Both halves of the relay carried the body with a string-type test:
//   frame:  body: init && typeof init.body === "string" ? init.body : undefined
//   bridge: body: typeof data.body === "string" ? data.body.slice(...) : undefined
// So every non-string body became `undefined` and the relayed request went out BODYLESS — a state-changing
// POST whose payload simply vanished, with no error and no warning. `new URLSearchParams(...)`, `FormData`,
// `Blob` and `ArrayBuffer` are all ordinary things to pass to fetch, and each of them made the app send a
// different request than the one it wrote.
//
// THE POLICY. Serialise what serialises deterministically, carry what structured-clone can carry, and REJECT
// the rest out loud — a mini-app must never silently make a different request than it asked for.
//   · string                      → carried as-is (byte-capped)
//   · URLSearchParams             → serialised to its form encoding, plus the form content-type
//   · Blob / File                 → carried whole (structured clone), byte-capped by `.size`
//   · ArrayBuffer / ArrayBufferView → carried whole (structured clone), byte-capped by `.byteLength`
//   · FormData                    → SERIALISED to an entries envelope for the port (a FormData cannot be
//                                   structured-cloned across a MessagePort — measured DataCloneError in
//                                   Chrome, voicebox-beads-ctmt — but strings and Blobs inside it CAN),
//                                   byte-capped by summing its parts, and rebuilt into a real FormData by
//                                   the receiving copy of this same function, so the browser still chooses
//                                   the multipart boundary and content-type
//   · ReadableStream              → refused: a stream cannot be cloned across the port
// Every refusal names the body it saw and what to do instead.
//
// WHY THE BODY IS ES5-SHAPED AND CLOSURE-FREE. The frame's SDK is injected as source text and embeds this exact
// function with `String(relayBody)` (see public/mini-app-bridge.js), so the frame and the bridge share one
// implementation and cannot drift. That only works while the body reads nothing outside its own arguments —
// which is also why the byte limit is a parameter rather than a module constant.

/**
 * @param {unknown} body   the body a mini-app passed to fetch
 * @param {{ maxBytes: number }} limits  the caller's own bound (the frame and the bridge each bound their side)
 * @returns {{ ok: true, body?: any, contentType?: string } | { ok: false, error: string }}
 */
export function relayBody(body, limits) {
  var maxBytes = (limits && typeof limits.maxBytes === "number" && limits.maxBytes > 0) ? limits.maxBytes : 0;
  if (!maxBytes) return { ok: false, error: "the relay was given no byte bound" };
  if (body === undefined || body === null) return { ok: true };
  var tag = Object.prototype.toString.call(body);

  if (typeof body === "string") {
    if (body.length > maxBytes) return { ok: false, error: "a " + body.length + " character body exceeds the relay's " + maxBytes + " byte bound" };
    return { ok: true, body: body };
  }
  if (tag === "[object URLSearchParams]") {
    var encoded = body.toString();
    if (encoded.length > maxBytes) return { ok: false, error: "a " + encoded.length + " character encoded body exceeds the relay's " + maxBytes + " byte bound" };
    // The form encoding IS the content-type this body implies; fetch would set the same one natively.
    return { ok: true, body: encoded, contentType: "application/x-www-form-urlencoded;charset=UTF-8" };
  }
  if (tag === "[object Blob]" || tag === "[object File]") {
    if (typeof body.size !== "number") return { ok: false, error: "a Blob body without a measurable size cannot be bounded" };
    if (body.size > maxBytes) return { ok: false, error: "a " + body.size + " byte body exceeds the relay's " + maxBytes + " byte bound" };
    return { ok: true, body: body };
  }
  if (tag === "[object ArrayBuffer]" || ArrayBuffer.isView(body)) {
    var bytes = typeof body.byteLength === "number" ? body.byteLength : 0;
    if (bytes > maxBytes) return { ok: false, error: "a " + bytes + " byte body exceeds the relay's " + maxBytes + " byte bound" };
    return { ok: true, body: body };
  }
  if (tag === "[object FormData]") {
    var total = 0;
    var entries = [];
    body.forEach(function (value, key) {
      // FormData values are only ever string or Blob; both structured-clone across the port.
      if (typeof value === "string") total += value.length;
      else if (value && typeof value.size === "number") total += value.size;
      entries.push([String(key), value]);
    });
    if (total > maxBytes) return { ok: false, error: "a form body of about " + total + " bytes exceeds the relay's " + maxBytes + " byte bound" };
    // The ENVELOPE crosses the port, not the FormData (voicebox-beads-ctmt): postMessage(structured clone)
    // throws DataCloneError on a FormData in Chrome, so the frame's whole request died AFTER this function
    // had accepted it. The entries list clones cleanly; the bridge-side copy of this function rebuilds the
    // real FormData from it below.
    return { ok: true, body: { voiceboxRelayFormData: entries } };
  }
  // The bridge half of the FormData path: an entries envelope ARRIVING from the port is rebuilt into the
  // real FormData here, so fetch sets the multipart boundary and content-type itself. Only the relay ever
  // mints this shape (plain-object bodies are refused below), and a frame that hand-writes it gains nothing
  // it could not send as a real FormData anyway.
  if (tag === "[object Object]" && body && Array.isArray(body.voiceboxRelayFormData)) {
    var rebuilt = new FormData();
    var rebuiltTotal = 0;
    var parts = body.voiceboxRelayFormData;
    for (var i = 0; i < parts.length; i++) {
      var entry = parts[i];
      if (!entry || entry.length !== 2) return { ok: false, error: "a malformed form envelope cannot be relayed" };
      var part = entry[1];
      if (typeof part === "string") rebuiltTotal += part.length;
      else if (part && typeof part.size === "number") rebuiltTotal += part.size;
      else return { ok: false, error: "a form envelope entry must be a string or a Blob" };
      rebuilt.append(String(entry[0]), part);
    }
    if (rebuiltTotal > maxBytes) return { ok: false, error: "a form body of about " + rebuiltTotal + " bytes exceeds the relay's " + maxBytes + " byte bound" };
    return { ok: true, body: rebuilt };
  }
  if (tag === "[object ReadableStream]") {
    return { ok: false, error: "a streaming body cannot cross the relay: read it into a Blob or ArrayBuffer first" };
  }
  return { ok: false, error: "the relay cannot carry a " + tag.slice(8, -1) + " body: send a string, URLSearchParams, FormData, Blob or ArrayBuffer" };
}
