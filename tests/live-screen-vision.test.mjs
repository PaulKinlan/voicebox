// tests/live-screen-vision.test.mjs — Unit tests for RFC 6455 WebSocket fragmentation
// (screen-share video frames), Gemini Live vision & transcription defaults, and thought streaming.
//
//   node --test tests/live-screen-vision.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { wrapSocket } from "../lib/ws-server.mjs";
import { liveSystemInstruction } from "../lib/commands.mjs";
import { createGeminiProvider } from "../lib/live-providers/gemini.mjs";

/**
 * Build a masked client-to-server RFC 6455 WebSocket frame.
 */
function buildMaskedClientFrame({ fin = true, opcode = 0x1, payload = Buffer.alloc(0), maskKey = [0x37, 0xfa, 0x21, 0x3d] }) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = buf.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen += 2;
  else if (len >= 65536) headerLen += 8;

  const frame = Buffer.alloc(headerLen + 4 + len);
  frame[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);

  let offset = 2;
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }

  frame[offset] = maskKey[0];
  frame[offset + 1] = maskKey[1];
  frame[offset + 2] = maskKey[2];
  frame[offset + 3] = maskKey[3];
  offset += 4;

  for (let i = 0; i < len; i++) {
    frame[offset + i] = buf[i] ^ maskKey[i & 3];
  }
  return frame;
}

function createFakeDuplexSocket() {
  const emitter = new EventEmitter();
  emitter.written = [];
  emitter.ended = false;
  emitter.destroyed = false;
  emitter.write = (chunk) => {
    emitter.written.push(Buffer.from(chunk));
    return true;
  };
  emitter.end = () => {
    emitter.ended = true;
  };
  emitter.destroy = () => {
    emitter.destroyed = true;
  };
  return emitter;
}

test("ws-server: reassembles multi-fragment >120 KB text frames with interleaved Ping without closing 1003 (voicebox-beads-t6rd)", () => {
  const rawSocket = createFakeDuplexSocket();
  const ws = wrapSocket(rawSocket);

  const messages = [];
  const closes = [];
  ws.on("message", (msg) => messages.push(msg));
  ws.on("close", (code, reason) => closes.push({ code, reason }));

  // Construct a ~150 KB JSON message representing a base64-encoded 1024px screen-share JPEG frame
  const fakeJpegBase64 = Buffer.alloc(112_000, 0xab).toString("base64");
  const fullJson = JSON.stringify({
    type: "video",
    mimeType: "image/jpeg",
    data: fakeJpegBase64,
  });
  const fullBytes = Buffer.from(fullJson, "utf8");
  assert.ok(fullBytes.length > 140_000, `Expected >140 KB payload, got ${fullBytes.length}`);

  // Split into 5 fragments (~30 KB each):
  //   Fragment 0: fin=false, opcode=0x1 (text)
  //   Fragment 1: fin=false, opcode=0x0 (continuation)
  //   [Interleaved Ping control frame: fin=true, opcode=0x9]
  //   Fragment 2: fin=false, opcode=0x0 (continuation)
  //   Fragment 3: fin=false, opcode=0x0 (continuation)
  //   Fragment 4: fin=true,  opcode=0x0 (continuation)
  const chunkSize = 30_000;
  const chunks = [];
  for (let offset = 0; offset < fullBytes.length; offset += chunkSize) {
    chunks.push(fullBytes.subarray(offset, Math.min(offset + chunkSize, fullBytes.length)));
  }
  assert.ok(chunks.length >= 5);

  rawSocket.emit(
    "data",
    buildMaskedClientFrame({ fin: false, opcode: 0x1, payload: chunks[0] }),
  );
  rawSocket.emit(
    "data",
    buildMaskedClientFrame({ fin: false, opcode: 0x0, payload: chunks[1] }),
  );
  assert.equal(messages.length, 0, "Should not emit message before final fragment");
  assert.equal(closes.length, 0, "Should not close on non-final fragments");

  // Interleave an RFC 6455 §5.4 Ping control frame mid-fragmentation
  const pingPayload = Buffer.from("keepalive");
  rawSocket.emit(
    "data",
    buildMaskedClientFrame({ fin: true, opcode: 0x9, payload: pingPayload }),
  );
  assert.equal(rawSocket.written.length, 1, "Ping mid-fragmentation must be answered with Pong immediately");
  assert.equal(rawSocket.written[0][0], 0x8a, "Pong frame header must be FIN + 0xA");

  for (let i = 2; i < chunks.length - 1; i++) {
    rawSocket.emit(
      "data",
      buildMaskedClientFrame({ fin: false, opcode: 0x0, payload: chunks[i] }),
    );
  }
  assert.equal(messages.length, 0);

  // Send final continuation frame (fin=true, opcode=0x0)
  rawSocket.emit(
    "data",
    buildMaskedClientFrame({ fin: true, opcode: 0x0, payload: chunks.at(-1) }),
  );

  assert.equal(closes.length, 0, "Must not close socket on valid fragmented message");
  assert.equal(messages.length, 1, "Must emit exactly one reassembled message");
  assert.equal(typeof messages[0], "string");
  assert.equal(messages[0], fullJson);

  // Verify subsequent normal unfragmented frame still works cleanly on the same socket
  const followUp = JSON.stringify({ type: "text", text: "What is on my screen?" });
  rawSocket.emit(
    "data",
    buildMaskedClientFrame({ fin: true, opcode: 0x1, payload: followUp }),
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[1], followUp);
});

test("ws-server: refuses protocol violations with 1002 and oversized fragmented messages with 1009", () => {
  // 1. Unexpected continuation frame (opcode 0x0 with no initial fragment) -> 1002
  {
    const rawSocket = createFakeDuplexSocket();
    wrapSocket(rawSocket);
    rawSocket.emit(
      "data",
      buildMaskedClientFrame({ fin: true, opcode: 0x0, payload: "orphan" }),
    );
    assert.equal(rawSocket.ended, true);
    const closeFrame = rawSocket.written.at(-1);
    assert.equal(closeFrame[0], 0x88);
    assert.equal(closeFrame.readUInt16BE(2), 1002);
  }

  // 2. New data frame (opcode 0x1) while a fragmented message is already in progress -> 1002
  {
    const rawSocket = createFakeDuplexSocket();
    wrapSocket(rawSocket);
    rawSocket.emit(
      "data",
      buildMaskedClientFrame({ fin: false, opcode: 0x1, payload: "part-1" }),
    );
    rawSocket.emit(
      "data",
      buildMaskedClientFrame({ fin: true, opcode: 0x1, payload: "illegal-new-data-frame" }),
    );
    assert.equal(rawSocket.ended, true);
    const closeFrame = rawSocket.written.at(-1);
    assert.equal(closeFrame[0], 0x88);
    assert.equal(closeFrame.readUInt16BE(2), 1002);
  }

  // 3. Fragmented message exceeding 4 MB total -> 1009
  {
    const rawSocket = createFakeDuplexSocket();
    wrapSocket(rawSocket);
    const twoMbChunk = Buffer.alloc(2 * (1 << 20) + 1024, 0x61);
    rawSocket.emit(
      "data",
      buildMaskedClientFrame({ fin: false, opcode: 0x2, payload: twoMbChunk }),
    );
    rawSocket.emit(
      "data",
      buildMaskedClientFrame({ fin: true, opcode: 0x0, payload: twoMbChunk }),
    );
    assert.equal(rawSocket.ended, true);
    const closeFrame = rawSocket.written.at(-1);
    assert.equal(closeFrame[0], 0x88);
    assert.equal(closeFrame.readUInt16BE(2), 1009);
  }
});

test("liveSystemInstruction: explicitly tells the live model it CAN see live camera and shared screen frames (voicebox-beads-4ba9)", () => {
  const sys = liveSystemInstruction();
  assert.match(sys, /You CAN see the user's live camera or shared screen/i);
  assert.match(sys, /realtimeInput\.video/);
  assert.match(sys, /never claim you cannot view shared screens or camera feeds/i);
});

test("createGeminiProvider: enables inputAudioTranscription, TURN_INCLUDES_ALL_INPUT, slidingWindow compression, and includeThoughts by default, and emits kind='thought' for thought parts (voicebox-beads-4ba9, voicebox-beads-vg0g)", () => {
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "unit-test-gemini-key";
  try {
    const events = [];
    const sent = [];
    let onEvent = null;

    const transport = {
      connect(_url, handlers) {
        onEvent = handlers.onEvent;
        return true;
      },
      send(kind, data) {
        sent.push({ kind, payload: JSON.parse(data) });
        return true;
      },
      close() {},
    };

    createGeminiProvider({
      emit: (e) => events.push(e),
      log: () => {},
      transport,
    });

    onEvent({ kind: "open" });
    assert.equal(sent.length, 1);
    const setup = sent[0].payload.setup;

    // 1. Default setup config for screen-share / camera vision & spoken turns (voicebox-beads-4ba9)
    assert.deepEqual(
      setup.inputAudioTranscription,
      {},
      "inputAudioTranscription must be enabled by default so user speech is transcribed",
    );
    assert.deepEqual(setup.outputAudioTranscription, {});
    assert.equal(
      setup.realtimeInputConfig?.turnCoverage,
      "TURN_INCLUDES_ALL_INPUT",
      "realtimeInputConfig.turnCoverage must default to TURN_INCLUDES_ALL_INPUT so screen-share video frames are included in turns",
    );
    assert.deepEqual(
      setup.contextWindowCompression,
      { slidingWindow: {} },
      "contextWindowCompression must default to { slidingWindow: {} } so audio+video sessions do not terminate at 2m",
    );

    // 2. Default thinkingConfig.includeThoughts is true (voicebox-beads-vg0g)
    assert.equal(
      setup.generationConfig?.thinkingConfig?.includeThoughts,
      true,
      "thinkingConfig.includeThoughts must default to true so reasoning summaries stream to the client",
    );

    // 3. Thought parts vs spoken/model text parts in serverContent.modelTurn.parts
    onEvent({ kind: "message", data: JSON.stringify({ setupComplete: {} }) });
    onEvent({
      kind: "message",
      data: JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [
              { thought: true, text: "Inspecting the shared screen window layout..." },
              { text: "I can see your browser window showing the Voicebox room." },
            ],
          },
        },
      }),
    });

    const textEvents = events.filter((e) => e.type === "output-text");
    assert.deepEqual(textEvents, [
      {
        type: "output-text",
        kind: "thought",
        text: "Inspecting the shared screen window layout...",
      },
      {
        type: "output-text",
        kind: "model",
        text: "I can see your browser window showing the Voicebox room.",
      },
    ]);
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});
