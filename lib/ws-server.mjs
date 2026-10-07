// lib/ws-server.mjs — a minimal WebSocket SERVER, zero dependencies.
// The bridge shape voicebox needs: an HTTP Upgrade to RFC 6455 frames.
// Text and binary frames (including RFC 6455 multi-frame fragmentation for
// >64 KB screen-share/camera JPEG payloads up to 4 MB); interleaved ping/pong; close.

import { createHash, randomBytes } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 4 * (1 << 20); // 4 MB safety bound per reassembled message

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

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let frame;
    while ((frame = readFrame(buffer))) {
      buffer = buffer.subarray(frame.consumed);
      // Control frames (0x8 close, 0x9 ping, 0xA pong) may be interleaved between fragments (RFC 6455 §5.4).
      if (frame.opcode >= 0x8) {
        if (!frame.fin) { api.close(1002, "fragmented control frame"); return; }
        if (frame.opcode === 0x8) { api.close(); emitClose(); return; }
        if (frame.opcode === 0x9) { socket.write(encodeFrame(0xA, frame.payload)); continue; } // ping → pong
        if (frame.opcode === 0xA) continue; // unsolicited pong
        api.close(1003, "unsupported opcode");
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
        api.close(1003, "unsupported opcode");
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

/** Parse one frame from the front of buf, or null if incomplete. */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const mask = masked ? buf.subarray(offset, offset + 4) : null;
  const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { fin, opcode, payload, consumed: offset + maskLen + len };
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
