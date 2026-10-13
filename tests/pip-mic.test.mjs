// tests/pip-mic.test.mjs — Unit tests for Document PiP mic companion
// (voicebox-beads-pcyo)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPip } from "../public/pip-mic.mjs";
import { identifiersInRenderedText } from "../tools/rendered-plain-language.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function createMockPipWindow() {
  const elements = [];
  const adoptedStyleSheets = [];

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = "";
      this.className = "";
      this.type = "";
      this.hidden = false;
      this.attributes = new Map();
      this.children = [];
      this.textContent = "";
      this.style = {};
      this.dataset = {};
      this.srcObject = null;
      this.play = async () => {};
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    append(...nodes) {
      for (const node of nodes) {
        if (typeof node === "string") {
          this.textContent += node;
        } else if (node) {
          this.children.push(node);
        }
      }
    }

    addEventListener() {}
    removeEventListener() {}
  }

  const doc = {
    title: "",
    head: {
      querySelector: () => null,
      querySelectorAll: () => [],
      prepend: () => {},
      append: () => {},
    },
    body: new MockElement("body"),
    adoptedStyleSheets,
    createElement: (tag) => new MockElement(tag),
    createElementNS: (_ns, tag) => new MockElement(tag),
    createTextNode: (text) => text,
    importNode: (node) => node,
  };

  const pip = {
    document: doc,
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    CSSStyleSheet: class {
      constructor() {
        this.cssText = "";
      }
      replaceSync(text) {
        this.cssText = text;
      }
    },
  };

  return pip;
}

test("buildPip creates PiP window UI with companion thumbnail and task chip", () => {
  const pip = createMockPipWindow();
  const mockControls = {
    mic: { click: () => {} },
    interrupt: { click: () => {} },
    sessionLog: { textContent: "Previous turn" },
  };

  const ui = buildPip(pip, mockControls);

  assert.ok(ui.micButton);
  assert.ok(ui.stateText);
  assert.ok(ui.presenceDot);
  assert.ok(ui.videoThumb);
  assert.ok(ui.taskChip);
  assert.ok(ui.taskText);
  assert.ok(ui.companionController);

  assert.equal(ui.videoThumb.id, "pip-vision-thumbnail");
  assert.equal(ui.videoThumb.hidden, true);

  assert.equal(ui.taskChip.id, "pip-task-chip");
  assert.equal(ui.taskChip.hidden, true);

  // Adopted stylesheet contains companion rules
  const ownSheet = pip.document.adoptedStyleSheets[pip.document.adoptedStyleSheets.length - 1];
  assert.ok(ownSheet);
  assert.match(ownSheet.cssText, /\.pip-companion/);
  assert.match(ownSheet.cssText, /#pip-vision-thumbnail/);
  assert.match(ownSheet.cssText, /\.pip-task-chip/);
});

test("companionController toggles video thumbnail and task status", () => {
  const pip = createMockPipWindow();
  const ui = buildPip(pip, {});
  const { companionController } = ui;

  // Test vision stream sync
  const fakeStream = { id: "stream-1", getTracks: () => [] };
  companionController.setVisionStream(fakeStream);
  assert.equal(ui.videoThumb.hidden, false);
  assert.equal(ui.videoThumb.srcObject, fakeStream);

  companionController.setVisionStream(null);
  assert.equal(ui.videoThumb.hidden, true);
  assert.equal(ui.videoThumb.srcObject, null);

  // Test task status sync
  companionController.setTaskStatus({
    active: true,
    task: "Refactor database queries",
    harness: "claude",
  });
  assert.equal(ui.taskChip.hidden, false);
  assert.match(ui.taskText.textContent, /Refactor database queries/);
  assert.match(ui.taskText.textContent, /\[claude\]/);

  companionController.setTaskStatus({ active: false });
  assert.equal(ui.taskChip.hidden, true);
});

test("public/pip-mic.mjs passes plain-language scan with zero hits", () => {
  const code = fs.readFileSync(path.join(here, "../public/pip-mic.mjs"), "utf8");
  const hits = identifiersInRenderedText(code);
  assert.deepEqual(hits, [], `Expected 0 plain-language hits in public/pip-mic.mjs, got: ${JSON.stringify(hits)}`);
});
