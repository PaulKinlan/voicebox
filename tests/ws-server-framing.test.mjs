// tests/ws-server-framing.test.mjs — voicebox-beads-r93n (TM-VB-WS-001/002).
//
//   node --test tests/ws-server-framing.test.mjs
//
// The server used to read a frame's declared length and then BUFFER until that many bytes arrived, checking
// MAX_MESSAGE_BYTES only afterwards — so a peer could declare a terabyte, send nothing, and make the process
// accumulate whatever came. It also accepted frames RFC 6455 forbids (unmasked, RSV bits set, oversized control
// frames, reserved opcodes, non-minimal lengths). Each case below is a header a peer can send in ten bytes, driven
// at the socket the server actually wraps: the assertion is what the server does NEXT, before any payload exists.
//
// THIS FILE IS IN THE UNIT LANE ON PURPOSE, and that is why it drives a fake duplex rather than a listening socket:
// the fast gate is the landing contract, so the framing DECISIONS have to run there (a security fix whose tests never
// run in the fast gate is a fix nobody gates). a listening server is classified as a server signal by
// scripts/test-lanes.mjs, and @lane may not override that signal — so the one arm that needs a REAL stream lives in
// tests/live-screen-vision.test.mjs beside the other ws-server socket tests, where the server lane runs it.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { wrapSocket } from "../lib/ws-server.mjs";

/** A duplex socket stand-in: `data` in, writes and end recorded. Same shape as tests/live-screen-vision.test.mjs. */
function fakeSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.ended = false;
  socket.destroyed = false;
  socket.write = (chunk) => { socket.written.push(Buffer.from(chunk)); return true; };
  socket.end = () => { socket.ended = true; };
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

/** The close code a server wrote last, or null if it has not closed. */
function closeCode(socket) {
  const frame = socket.written.at(-1);
  if (!frame || frame[0] !== 0x88) return null;
  return frame.readUInt16BE(2);
}

/**
 * A client frame with control over every field, including a DECLARED length that differs from the payload sent —
 * which is the whole defect: the server must decide from the header, not from what arrives.
 */
function clientFrame({ fin = true, opcode = 0x1, payload = Buffer.alloc(0), rsv = 0, mask = true, declareLen = null, lengthBytes = null }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = declareLen ?? body.length;
  let marker = len;
  let lengthTail = Buffer.alloc(0);
  if (lengthBytes === 2 || (lengthBytes === null && len >= 126 && len < 65536)) {
    marker = 126;
    lengthTail = Buffer.alloc(2);
    lengthTail.writeUInt16BE(len, 0);
  } else if (lengthBytes === 8 || (lengthBytes === null && len >= 65536)) {
    marker = 127;
    lengthTail = Buffer.alloc(8);
    lengthTail.writeBigUInt64BE(BigInt(len), 0);
  } else if (lengthBytes !== null && lengthBytes !== 0) {
    throw new Error(`unsupported lengthBytes ${lengthBytes}`);
  }
  const key = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const header = [Buffer.from([(fin ? 0x80 : 0) | rsv | opcode, (mask ? 0x80 : 0) | marker]), lengthTail];
  if (!mask) return Buffer.concat([...header, body]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4];
  return Buffer.concat([...header, key, masked]);
}

test("a declared length past the message bound is refused from the HEADER, with no payload sent (voicebox-beads-r93n)", () => {
  const socket = fakeSocket();
  wrapSocket(socket);
  // Ten bytes: FIN + binary, masked, length marker 127 declaring 1 TiB. Not one payload byte follows.
  socket.emit("data", clientFrame({ opcode: 0x2, declareLen: 2 ** 40, lengthBytes: 8 }));
  assert.equal(socket.ended, true, "the server must close rather than wait for a terabyte it must not buffer");
  assert.equal(closeCode(socket), 1009, "and it must say message-too-big");
});

test("a continuation that would push the message past the bound is refused from the HEADER (voicebox-beads-r93n)", () => {
  const socket = fakeSocket();
  wrapSocket(socket);
  // A legal 3 MB first fragment, then a continuation header declaring another 3 MB — refused before its payload.
  socket.emit("data", clientFrame({ fin: false, opcode: 0x2, payload: Buffer.alloc(3 * (1 << 20), 0x61) }));
  assert.equal(socket.ended, false, "the first fragment is inside the bound and must be accepted");
  socket.emit("data", clientFrame({ fin: true, opcode: 0x0, declareLen: 3 * (1 << 20), lengthBytes: 8 }));
  assert.equal(socket.ended, true, "3 MB + 3 MB exceeds the 4 MB message bound");
  assert.equal(closeCode(socket), 1009);
});

test("an UNMASKED client frame is a protocol error, not a message (voicebox-beads-r93n)", () => {
  const socket = fakeSocket();
  const messages = [];
  const ws = wrapSocket(socket);
  ws.on("message", (m) => messages.push(m));
  socket.emit("data", clientFrame({ mask: false, payload: "unmasked hello" }));
  assert.deepEqual(messages, [], "an unmasked frame must never reach the message listeners");
  assert.equal(closeCode(socket), 1002, "RFC 6455 §5.1: a client frame MUST be masked");
});

test("RSV bits are refused — this server negotiates no extension (voicebox-beads-r93n)", () => {
  for (const rsv of [0x10, 0x20, 0x40]) {
    const socket = fakeSocket();
    wrapSocket(socket);
    socket.emit("data", clientFrame({ rsv, payload: "reserved" }));
    assert.equal(closeCode(socket), 1002, `RSV bit 0x${rsv.toString(16)} must be a protocol error (§5.2)`);
  }
});

test("a control frame over 125 bytes, and a fragmented one, are protocol errors (voicebox-beads-r93n)", () => {
  const oversizedPing = fakeSocket();
  wrapSocket(oversizedPing);
  oversizedPing.emit("data", clientFrame({ opcode: 0x9, payload: Buffer.alloc(126, 0x70) }));
  assert.equal(closeCode(oversizedPing), 1002, "§5.5: control frames carry at most 125 bytes");

  const fragmentedPing = fakeSocket();
  wrapSocket(fragmentedPing);
  fragmentedPing.emit("data", clientFrame({ fin: false, opcode: 0x9, payload: "p" }));
  assert.equal(closeCode(fragmentedPing), 1002, "§5.5: control frames are never fragmented");
});

test("reserved opcodes are protocol errors (voicebox-beads-r93n)", () => {
  for (const opcode of [0x3, 0x7, 0xb, 0xf]) {
    const socket = fakeSocket();
    wrapSocket(socket);
    socket.emit("data", clientFrame({ opcode, payload: "x" }));
    assert.equal(closeCode(socket), 1002, `opcode 0x${opcode.toString(16)} is reserved (§5.2)`);
  }
});

test("a NON-MINIMAL length encoding is a protocol error (voicebox-beads-r93n)", () => {
  const shortAs16 = fakeSocket();
  wrapSocket(shortAs16);
  shortAs16.emit("data", clientFrame({ payload: "hi", declareLen: 2, lengthBytes: 2 }));
  assert.equal(closeCode(shortAs16), 1002, "a 2-byte length must use the 7-bit form (§5.2)");

  const shortAs64 = fakeSocket();
  wrapSocket(shortAs64);
  shortAs64.emit("data", clientFrame({ payload: "hi", declareLen: 2, lengthBytes: 8 }));
  assert.equal(closeCode(shortAs64), 1002, "an 8-byte length must only appear for lengths past 65535");
});

test("the door still opens: a legal masked text frame is delivered, and a masked two-part message reassembles (voicebox-beads-r93n)", () => {
  // The positive control. Every case above asserts a refusal, and a server that refused everything would pass them
  // all — so this proves the same harness can carry a message through.
  const socket = fakeSocket();
  const messages = [];
  const ws = wrapSocket(socket);
  ws.on("message", (m) => messages.push(m));

  socket.emit("data", clientFrame({ payload: "one shot" }));
  assert.deepEqual(messages, ["one shot"], "a legal masked text frame reaches the message listeners");

  const whole = Buffer.from("two-part message", "utf8");
  socket.emit("data", clientFrame({ fin: false, opcode: 0x1, payload: whole.subarray(0, 4) }));
  socket.emit("data", clientFrame({ fin: true, opcode: 0x0, payload: whole.subarray(4) }));
  assert.deepEqual(messages, ["one shot", "two-part message"], "and a fragmented message reassembles");
  assert.equal(socket.ended, false, "nothing about a legal message closes the socket");
});

test("a legal 4 MB message is still inside the bound — the limit refuses claims, not real payloads (voicebox-beads-r93n)", () => {
  const socket = fakeSocket();
  const messages = [];
  const ws = wrapSocket(socket);
  ws.on("message", (m) => messages.push(m));
  const exactly = Buffer.alloc(4 * (1 << 20), 0x62); // exactly MAX_MESSAGE_BYTES: allowed, not one byte over
  socket.emit("data", clientFrame({ opcode: 0x2, payload: exactly }));
  assert.equal(socket.ended, false, "a message at the bound must be accepted, or the bound is a lie about its size");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].length, exactly.length);
});
