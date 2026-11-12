// lib/ws-server.mjs — a minimal WebSocket SERVER, zero dependencies.
// The bridge shape voicebox needs: an HTTP Upgrade to RFC 6455 frames.
// Text and binary frames (including RFC 6455 multi-frame fragmentation for
// >64 KB screen-share/camera JPEG payloads up to 4 MB); interleaved ping/pong; close.

import { createHash, randomBytes } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 4 * (1 << 20); // 4 MB safety bound per reassembled message
// RFC 6455 framing constants this server enforces (voicebox-beads-r93n, TM-VB-WS-001/002). Named rather than
// inlined because each one is a rule a peer can violate and a reader has to be able to find.
const MAX_CONTROL_PAYLOAD = 125; // §5.5: control frames carry at most 125 bytes and are never fragmented
const CLOSE_PROTOCOL_ERROR = 1002; // §7.4.1: a frame that breaks the protocol
const CLOSE_TOO_BIG = 1009; // §7.4.1: "message too big"

export function acceptKey(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** Handle an HTTP Upgrade request. Returns a socket-like facade or null. */
export function upgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") return null;
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setNoDelay?.(true);
  return wrapSocket(socket);
}

export const upgradeToWebSocket = upgrade;

export function wrapSocket(socket) {
  let buffer = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragChunks = [];
  let fragBytes = 0;
  const listeners = { message: [], close: [], error: [] };
  let closed = false;
  const emitClose = () => {
    if (closed) return;
    closed = true;
    for (const fn of listeners.close) fn();
  };
  const api = {
    on(ev, fn) { listeners[ev]?.push(fn); return api; },
    send(data) {
      const isString = typeof data === "string";
      const payload = isString ? Buffer.from(data, "utf8") : data;
      socket.write(encodeFrame(isString ? 0x1 : 0x2, payload));
    },
    close(code = 1000, reason = "") {
      try { socket.write(encodeFrame(0x8, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason)]))); } catch { /* gone */ }
      socket.end();
    },
  };

  // A FRAME IS JUDGED BY ITS HEADER, BEFORE ITS PAYLOAD IS BUFFERED (voicebox-beads-r93n, TM-VB-WS-001).
  // The bound used to be checked after a whole frame had been accumulated, so a peer could declare a 1 TiB frame,
  // send nothing, and make this process buffer whatever came until memory ran out — pre-auth, since nothing here has
  // authenticated anything yet. readFrameHeader() answers from the first 2-10 bytes; readFrameBody() is only called
  // once the header is known to be legal AND inside the budget. `pending` holds the header across chunks so a
  // half-arrived frame is not re-parsed (or re-judged) from the front of the buffer.
  let pending = null;
  const refuse = ({ code, reason }) => { api.close(code, reason); return true; };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!pending) {
        const parsed = readFrameHeader(buffer);
        if (!parsed) break; // an incomplete header: wait for more bytes, nothing has been buffered on trust
        if (parsed.refuse) { refuse(parsed.refuse); return; }
        // THE BOUND, ENFORCED FROM THE DECLARED LENGTH: a single frame cannot exceed the message bound, and a
        // continuation cannot push the reassembled message past it. Either answer is available before one byte of
        // that payload arrives, which is the point.
        if (parsed.opcode !== 0x0 && parsed.len > MAX_MESSAGE_BYTES) { refuse({ code: CLOSE_TOO_BIG, reason: "message too large" }); return; }
        if (parsed.opcode === 0x0 && fragBytes + parsed.len > MAX_MESSAGE_BYTES) { refuse({ code: CLOSE_TOO_BIG, reason: "message too large" }); return; }
        pending = parsed;
      }
      const frame = readFrameBody(buffer, pending);
      if (!frame) break; // header legal and affordable: now the payload may arrive
      buffer = buffer.subarray(frame.consumed);
      pending = null;
      // Control frames (0x8 close, 0x9 ping, 0xA pong) may be interleaved between fragments (RFC 6455 §5.4).
      if (frame.opcode >= 0x8) {
        if (frame.opcode === 0x8) { api.close(); emitClose(); return; }
        if (frame.opcode === 0x9) { socket.write(encodeFrame(0xA, frame.payload)); continue; } // ping → pong
        if (frame.opcode === 0xA) continue; // unsolicited pong
        refuse({ code: CLOSE_PROTOCOL_ERROR, reason: "reserved opcode" });
        return;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (fragOpcode !== 0) { api.close(1002, "unexpected new fragment"); return; }
        if (frame.payload.length > MAX_MESSAGE_BYTES) { api.close(1009, "message too large"); return; }
        if (frame.fin) {
          if (frame.opcode === 0x1) for (const fn of listeners.message) fn(frame.payload.toString("utf8"));
          else for (const fn of listeners.message) fn(frame.payload);
        } else {
          fragOpcode = frame.opcode;
          fragChunks = [frame.payload];
          fragBytes = frame.payload.length;
        }
      } else if (frame.opcode === 0x0) {
        if (fragOpcode === 0) { api.close(1002, "unexpected continuation"); return; }
        fragBytes += frame.payload.length;
        if (fragBytes > MAX_MESSAGE_BYTES) { api.close(1009, "message too large"); return; }
        fragChunks.push(frame.payload);
        if (frame.fin) {
          const full = Buffer.concat(fragChunks, fragBytes);
          const op = fragOpcode;
          fragOpcode = 0;
          fragChunks = [];
          fragBytes = 0;
          if (op === 0x1) for (const fn of listeners.message) fn(full.toString("utf8"));
          else if (op === 0x2) for (const fn of listeners.message) fn(full);
        }
      } else {
        // Unreachable through readFrameHeader (a reserved opcode is refused there), kept as the belt-braces arm.
        api.close(CLOSE_PROTOCOL_ERROR, "reserved opcode");
        return;
      }
    }
  });
  socket.on("end", () => {
    socket.destroy();
    emitClose();
  });
  socket.on("close", emitClose);
  socket.on("error", (e) => { for (const fn of listeners.error) fn(e); });
  return api;
}

/**
 * Parse a frame's HEADER from the front of `buf` (voicebox-beads-r93n). Returns:
 *   null                      — not enough bytes yet for the header;
 *   { refuse: {code, reason} } — the header alone proves this frame can never be accepted, so the caller closes
 *                                WITHOUT waiting for a payload it must not buffer;
 *   a header                  — {fin, opcode, len, maskOffset, payloadOffset, consumed} for readFrameBody().
 *
 * Every rule here is RFC 6455 and every one of them is answerable from the first 2-10 bytes:
 *   §5.2  RSV1-3 MUST be 0 (this server negotiates no extension);
 *   §5.1  every client-to-server frame MUST be masked;
 *   §5.5  control frames are not fragmented and carry at most 125 bytes;
 *   §5.2  opcodes 0x3-0x7 and 0xB-0xF are reserved, i.e. a protocol error rather than a data type we can refuse.
 * A length that is not minimally encoded (§5.2) is refused too: accepting it is how a parser and a peer end up
 * disagreeing about where a frame starts.
 */
function readFrameHeader(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const rsv = buf[0] & 0x70;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  const marker = buf[1] & 0x7f;
  if (rsv !== 0) return { refuse: { code: CLOSE_PROTOCOL_ERROR, reason: "reserved bits set" } };
  if (!masked) return { refuse: { code: CLOSE_PROTOCOL_ERROR, reason: "client frames must be masked" } };
  if (opcode >= 0x8) {
    if (!fin) return { refuse: { code: CLOSE_PROTOCOL_ERROR, reason: "fragmented control frame" } };
    if (marker > MAX_CONTROL_PAYLOAD) return { refuse: { code: CLOSE_PROTOCOL_ERROR, reason: "control frame payload exceeds 125 bytes" } };
  } else if (opcode >= 0x3) {
    return { refuse: { code: CLOSE_PROTOCOL_ERROR, reason: "reserved opcode" } };
  }
  let len = marker;
  let offset = 2;
  if (marker === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
    if (len < 126) return { refuse: { code: CLOSE_PROTOCOL_ERROR, reason: "non-minimal length encoding" } };
  } else if (marker === 127) {
    if (buf.length < 10) return null;
    const declared = buf.readBigUInt64BE(2);
    // Refuse on the DECLARED length, before the payload exists: this is the arm that stops a 1 TiB claim from
    // being buffered, and it is why the size decision cannot live in the body reader.
    if (declared > BigInt(MAX_MESSAGE_BYTES)) return { refuse: { code: CLOSE_TOO_BIG, reason: "message too large" } };
    len = Number(declared);
    offset = 10;
    if (len < 65536) return { refuse: { code: CLOSE_PROTOCOL_ERROR, reason: "non-minimal length encoding" } };
  }
  // The mask key sits between the length and the payload; `consumed` is where the next frame starts.
  const maskOffset = offset;
  const payloadOffset = offset + 4;
  return { fin, opcode, len, maskOffset, payloadOffset, consumed: payloadOffset + len };
}

/** Read the payload of a header readFrameHeader() accepted, unmasking it. Null until the whole frame has arrived. */
function readFrameBody(buf, header) {
  if (buf.length < header.consumed) return null;
  const mask = buf.subarray(header.maskOffset, header.payloadOffset);
  const payload = Buffer.from(buf.subarray(header.payloadOffset, header.consumed));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { fin: header.fin, opcode: header.opcode, payload, consumed: header.consumed };
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

/** A cryptographically random token, for anything that needs one. */
export function token(bytes = 16) { return randomBytes(bytes).toString("hex"); }
