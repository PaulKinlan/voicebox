// tests/click-diagnostic.test.mjs — what a lost click is allowed to say (voicebox-beads-joxy).
//
//   node --test tests/click-diagnostic.test.mjs
//
// Unit-tier and pure, because the case that motivated it cannot be produced on demand: gate-recover's 18lh
// reproduction lost a click to DISPLACEMENT — the target still present, still enabled, page state untouched, the
// event dispatched and simply not taken — while a REMOVED target also produces no click event. Two faults, one
// symptom, different fixes. These assertions pin the distinction and, more importantly, pin the ABSENCE of any
// guess about the cause: the first draft claimed "the pointer was not over anything clickable" for both, which is
// the same conflation the diagnostic exists to remove, one level down.
import test from "node:test";
import assert from "node:assert/strict";
import { describeClick } from "./lib/click-diagnostic.mjs";

const at = { x: 140, y: 88 };
const present = { hadIntended: true, present: true, enabled: true, interactive: true, now: { x: 140, y: 88 } };
const gone = { hadIntended: true, present: false, enabled: false, interactive: false, now: null };

test("no event + target still present, enabled and interactive IS displacement, and says so", () => {
  const line = describeClick({ selector: "#send", at, events: [], target: present });
  assert.match(line, /0 click events reached the document/, "the count is stated, not implied");
  assert.match(line, /still present, still enabled and at \(140, 88\)/, `where the target is: ${line}`);
  assert.match(line, /did not take effect \(displacement, not removal\)/, `the mechanism is named: ${line}`);
});

test("no event + target gone is removal, and does NOT claim displacement", () => {
  const line = describeClick({ selector: "#send", at, events: [], target: gone });
  assert.match(line, /0 click events reached the document/);
  assert.match(line, /no longer in it/, `the target's absence is stated: ${line}`);
  assert.match(line, /a target that vanishes dispatches nothing/, "with the reason a click needs a shared target");
  assert.doesNotMatch(line, /displacement/, `removal is not displacement: ${line}`);
});

test("no event + target in the document but not interactive is its own third answer", () => {
  const line = describeClick({ selector: "#send", at, events: [], target: { ...present, interactive: false } });
  assert.match(line, /not interactive \(hidden, disabled or zero-sized\)/, line);
  assert.doesNotMatch(line, /displacement|no longer in it/, `and it is neither of the other two: ${line}`);
});

test("NOTHING guesses the cause: no wording may say the pointer was over nothing clickable", () => {
  for (const target of [present, gone, { ...present, interactive: false }]) {
    const line = describeClick({ selector: "#send", at, events: [], target });
    assert.doesNotMatch(line, /clickable/, `the cause must not be guessed: ${line}`);
  }
});

test("an event that reached the target says so, and an event that reached another element names it", () => {
  const delivered = describeClick({
    selector: "#send",
    at,
    events: [{ received: "button#send", text: "Send", toIntended: true }],
    target: present,
  });
  assert.match(delivered, /did reach the target \(received by button#send, "Send"\)/, delivered);

  const elsewhere = describeClick({
    selector: "#send",
    at,
    events: [{ received: "div#wrap", text: "wrap", toIntended: false }],
    target: { ...present, now: { x: 12, y: 34 } },
  });
  assert.match(elsewhere, /was received by div#wrap, "wrap" instead of the target/, elsewhere);
  assert.match(elsewhere, /the target is now at \(12, 34\)/, `and where the target went: ${elsewhere}`);
  assert.doesNotMatch(elsewhere, /but is hidden/, "it is still interactive, so that clause must not appear");
});

test("more than one event is reported as a count, so a double dispatch cannot pass as one", () => {
  const line = describeClick({
    selector: "#send",
    at,
    events: [
      { received: "div#wrap", text: "", toIntended: false },
      { received: "button#send", text: "Send", toIntended: true },
    ],
    target: present,
  });
  assert.match(line, /\(2 click events reached the document\)/, line);
});

test("a target that is still there but no longer interactive is called out in the event case too", () => {
  const line = describeClick({
    selector: "#send",
    at,
    events: [{ received: "button#send", text: "Send", toIntended: true }],
    target: { ...present, interactive: false },
  });
  assert.match(line, /the target is now at \(140, 88\) but is hidden or no longer interactive/, line);
});
