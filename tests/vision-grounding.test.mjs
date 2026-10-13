// tests/vision-grounding.test.mjs — Live Visual Grounding & Callout Pointer tests
// (voicebox-beads-gnf2)

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBoundingBox,
  normalizePointTarget,
  boxToCanvasRect,
  pointToCanvasPoint,
  parseGroundingCallouts,
  createVisionGroundingController,
} from "../public/vision-grounding.mjs";

test("normalizeBoundingBox converts 0..1000 Gemini integer coordinates to 0..1 floats", () => {
  const box = normalizeBoundingBox([120, 250, 480, 750]);
  assert.ok(box);
  assert.equal(box.kind, "box");
  assert.equal(box.ymin, 0.12);
  assert.equal(box.xmin, 0.25);
  assert.equal(box.ymax, 0.48);
  assert.equal(box.xmax, 0.75);
  assert.equal(box.label, "");
});

test("normalizeBoundingBox handles 0..1 floating coordinates and objects with labels", () => {
  const box = normalizeBoundingBox({
    box_2d: [0.1, 0.2, 0.4, 0.8],
    label: "Submit Button",
  });
  assert.ok(box);
  assert.equal(box.ymin, 0.1);
  assert.equal(box.xmin, 0.2);
  assert.equal(box.ymax, 0.4);
  assert.equal(box.xmax, 0.8);
  assert.equal(box.label, "Submit Button");
});

test("normalizeBoundingBox handles inverted or out-of-range bounds gracefully", () => {
  const box = normalizeBoundingBox([900, 800, 200, 300]);
  assert.ok(box);
  assert.equal(box.ymin, 0.2);
  assert.equal(box.ymax, 0.9);
  assert.equal(box.xmin, 0.3);
  assert.equal(box.xmax, 0.8);

  assert.equal(normalizeBoundingBox(null), null);
  assert.equal(normalizeBoundingBox("invalid"), null);
  assert.equal(normalizeBoundingBox([NaN, 1, 2, 3]), null);
});

test("normalizePointTarget converts point coordinates to 0..1 range", () => {
  const pt1 = normalizePointTarget([500, 250]);
  assert.ok(pt1);
  assert.equal(pt1.kind, "point");
  assert.equal(pt1.y, 0.5);
  assert.equal(pt1.x, 0.25);

  const pt2 = normalizePointTarget({ x: 0.75, y: 0.25, label: "Anchor Link" });
  assert.ok(pt2);
  assert.equal(pt2.x, 0.75);
  assert.equal(pt2.y, 0.25);
  assert.equal(pt2.label, "Anchor Link");
});

test("boxToCanvasRect and pointToCanvasPoint map normalized coordinates to canvas pixel space", () => {
  const box = { ymin: 0.1, xmin: 0.2, ymax: 0.5, xmax: 0.6, label: "Card" };
  const rect = boxToCanvasRect(box, 640, 480);
  assert.equal(rect.x, 128); // 0.2 * 640
  assert.equal(rect.y, 48);  // 0.1 * 480
  assert.equal(rect.width, 256); // 0.4 * 640
  assert.equal(rect.height, 192); // 0.4 * 480
  assert.equal(rect.label, "Card");

  const pt = { x: 0.5, y: 0.5, label: "Center" };
  const canvasPt = pointToCanvasPoint(pt, 640, 480);
  assert.equal(canvasPt.x, 320);
  assert.equal(canvasPt.y, 240);
  assert.equal(canvasPt.label, "Center");
});

test("parseGroundingCallouts parses JSON strings, arrays, and embedded coordinates", () => {
  const jsonStr = '[{"box_2d": [100, 200, 300, 400], "label": "Search Box"}]';
  const parsed = parseGroundingCallouts(jsonStr);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].label, "Search Box");
  assert.equal(parsed[0].ymin, 0.1);

  const rawText = "Look at the object at [150, 200, 450, 600]";
  const fromText = parseGroundingCallouts(rawText);
  assert.equal(fromText.length, 1);
  assert.equal(fromText[0].ymin, 0.15);
  assert.equal(fromText[0].xmin, 0.2);

  assert.deepEqual(parseGroundingCallouts(""), []);
  assert.deepEqual(parseGroundingCallouts(null), []);
});

test("createVisionGroundingController manages callout lifecycle and canvas drawing", () => {
  const drawn = [];
  const mockCanvas = {
    width: 640,
    height: 480,
    getContext: () => ({
      clearRect: (...args) => drawn.push(["clearRect", ...args]),
      fillRect: (...args) => drawn.push(["fillRect", ...args]),
      strokeRect: (...args) => drawn.push(["strokeRect", ...args]),
      beginPath: () => drawn.push(["beginPath"]),
      arc: (...args) => drawn.push(["arc", ...args]),
      stroke: () => drawn.push(["stroke"]),
      fill: () => drawn.push(["fill"]),
      measureText: (txt) => ({ width: txt.length * 6 }),
      fillText: (txt, x, y) => drawn.push(["fillText", txt, x, y]),
      roundRect: (...args) => drawn.push(["roundRect", ...args]),
    }),
  };

  const controller = createVisionGroundingController({
    canvas: mockCanvas,
    defaultDurationMs: 0,
  });

  const count = controller.renderCallouts([
    { box_2d: [100, 200, 300, 400], label: "Primary Button" },
    { point: [240, 320], label: "Click Target" },
  ]);

  assert.equal(count, 2);
  const active = controller.getCallouts();
  assert.equal(active.length, 2);
  assert.equal(active[0].kind, "box");
  assert.equal(active[1].kind, "point");

  assert.ok(drawn.some((d) => d[0] === "fillRect"));
  assert.ok(drawn.some((d) => d[0] === "strokeRect"));
  assert.ok(drawn.some((d) => d[0] === "arc"));

  controller.clearCallouts();
  assert.equal(controller.getCallouts().length, 0);
});
