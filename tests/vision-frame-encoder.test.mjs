import test from "node:test";
import assert from "node:assert/strict";
import { createBoundedSeenSet, encodeVisionFrame } from "../public/vision-frame-encoder.mjs";

test("createBoundedSeenSet maintains a bounded FIFO Set and evicts oldest items", () => {
  const set = createBoundedSeenSet(3);
  assert.equal(set.size, 0);

  set.add("id1");
  set.add("id2");
  set.add("id3");
  assert.equal(set.size, 3);
  assert.equal(set.has("id1"), true);
  assert.equal(set.has("id2"), true);
  assert.equal(set.has("id3"), true);

  // Adding existing item does not evict
  set.add("id2");
  assert.equal(set.size, 3);
  assert.equal(set.has("id1"), true);

  // Adding 4th item evicts oldest ('id1')
  set.add("id4");
  assert.equal(set.size, 3);
  assert.equal(set.has("id1"), false, "id1 should be evicted");
  assert.equal(set.has("id2"), true);
  assert.equal(set.has("id3"), true);
  assert.equal(set.has("id4"), true);

  // Adding 5th item evicts 'id2'
  set.add("id5");
  assert.equal(set.size, 3);
  assert.equal(set.has("id2"), false, "id2 should be evicted");
  assert.equal(set.has("id3"), true);
  assert.equal(set.has("id4"), true);
  assert.equal(set.has("id5"), true);

  // Delete works
  set.delete("id4");
  assert.equal(set.size, 2);
  assert.equal(set.has("id4"), false);

  // Clear works
  set.clear();
  assert.equal(set.size, 0);
  assert.equal(set.has("id3"), false);
});

test("encodeVisionFrame uses OffscreenCanvas when available", async () => {
  let drawn = false;
  let converted = false;

  const mockBlob = {
    async arrayBuffer() {
      return Buffer.from("mock-jpeg-bytes");
    },
  };

  class MockOffscreenCanvas {
    constructor(w, h) {
      this.width = w;
      this.height = h;
    }
    getContext(type) {
      return {
        drawImage(video, x, y, w, h) {
          drawn = true;
        },
      };
    }
    async convertToBlob(options) {
      converted = true;
      return mockBlob;
    }
  }

  const prev = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = MockOffscreenCanvas;
  try {
    const video = {};
    const res = await encodeVisionFrame(video, 640, 480, 0.78, null);
    assert.equal(drawn, true, "drawImage called");
    assert.equal(converted, true, "convertToBlob called");
    assert.equal(res.width, 640);
    assert.equal(res.height, 480);
    assert.equal(res.base64, Buffer.from("mock-jpeg-bytes").toString("base64"));
  } finally {
    if (prev) {
      globalThis.OffscreenCanvas = prev;
    } else {
      delete globalThis.OffscreenCanvas;
    }
  }
});

test("encodeVisionFrame falls back to DOM canvas when OffscreenCanvas is absent", async () => {
  const prev = globalThis.OffscreenCanvas;
  delete globalThis.OffscreenCanvas;

  try {
    let fallbackDrawn = false;
    const fallbackCanvas = {
      width: 0,
      height: 0,
      getContext(type) {
        return {
          drawImage(video, x, y, w, h) {
            fallbackDrawn = true;
          },
        };
      },
      toDataURL(mime, quality) {
        return "data:image/jpeg;base64,ZmFsbGJhY2stanBlZw==";
      },
    };

    const video = {};
    const res = await encodeVisionFrame(video, 320, 240, 0.78, fallbackCanvas);
    assert.equal(fallbackDrawn, true);
    assert.equal(res.width, 320);
    assert.equal(res.height, 240);
    assert.equal(res.base64, "ZmFsbGJhY2stanBlZw==");
  } finally {
    if (prev) globalThis.OffscreenCanvas = prev;
  }
});
